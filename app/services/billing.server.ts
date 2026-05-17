import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import { redirect } from "@remix-run/node";
import prisma from "~/db.server";
import { PLAN_DEFINITIONS, PLAN_LIMITS } from "~/services/billing.shared";
import type { PlanKey, PlanLimitKey } from "~/services/billing.shared";
export { PLAN_DEFINITIONS, PLAN_LIMITS } from "~/services/billing.shared";
export type { PlanKey, PlanLimitKey } from "~/services/billing.shared";

// ─── Plan ordering (for upgrade/downgrade checks) ─────────────────────────────

const PLAN_ORDER: PlanKey[] = ["FREE", "GROWTH", "PRO", "ENTERPRISE"];

export function planRank(plan: PlanKey): number {
  return PLAN_ORDER.indexOf(plan);
}

// ─── createSubscription ───────────────────────────────────────────────────────

/**
 * Creates a Shopify app subscription and returns the confirmationUrl to
 * redirect the merchant to for approval.
 */
export async function createSubscription(
  admin: AdminApiContext,
  planKey: Exclude<PlanKey, "FREE" | "ENTERPRISE">,
  shopDomain: string
): Promise<string> {
  const plan = PLAN_DEFINITIONS[planKey];
  const returnUrl = `${process.env.SHOPIFY_APP_URL}/app/pricing`;

  // Detect dev stores via shop.plan.partnerDevelopment. Dev stores must use
  // Shopify test billing (test: true) so no real payment method is required and
  // no real charge is made — even when the app itself is running on production
  // hosting (Render). Falling back to NODE_ENV is unreliable: NODE_ENV is
  // "production" on Render even for a dev-store merchant.
  const shopPlanResponse = await admin.graphql(
    `#graphql
    query ShopPlanForBilling {
      shop {
        plan {
          partnerDevelopment
          shopifyPlus
        }
      }
    }`
  );
  const shopPlanJson = (await shopPlanResponse.json()) as {
    data?: { shop?: { plan?: { partnerDevelopment?: boolean; shopifyPlus?: boolean } } };
  };
  const isDevStore = shopPlanJson.data?.shop?.plan?.partnerDevelopment === true;

  const response = await admin.graphql(
    `#graphql
    mutation AppSubscriptionCreate(
      $name: String!
      $lineItems: [AppSubscriptionLineItemInput!]!
      $returnUrl: URL!
      $trialDays: Int
      $test: Boolean
    ) {
      appSubscriptionCreate(
        name: $name
        lineItems: $lineItems
        returnUrl: $returnUrl
        trialDays: $trialDays
        test: $test
      ) {
        appSubscription {
          id
        }
        confirmationUrl
        userErrors {
          field
          message
        }
      }
    }`,
    {
      variables: {
        name: plan.name,
        returnUrl,
        trialDays: plan.trialDays,
        test: isDevStore,
        lineItems: [
          {
            plan: {
              appRecurringPricingDetails: {
                price: { amount: plan.price, currencyCode: "USD" },
                interval: "EVERY_30_DAYS",
              },
            },
          },
        ],
      },
    }
  );

  const json = await response.json() as {
    data?: {
      appSubscriptionCreate?: {
        appSubscription?: { id: string };
        confirmationUrl?: string;
        userErrors?: { field: string; message: string }[];
      };
    };
  };

  const result = json.data?.appSubscriptionCreate;

  if ((result?.userErrors?.length ?? 0) > 0) {
    throw new Error(result!.userErrors![0].message);
  }

  if (!result?.confirmationUrl) {
    throw new Error("No confirmation URL returned from Shopify.");
  }

  // Save pending subscription record
  const store = await prisma.store.findUnique({
    where: { shopifyDomain: shopDomain },
    select: { id: true },
  });

  if (store) {
    await prisma.subscription.upsert({
      where: { storeId: store.id },
      update: {
        shopifySubscriptionId: result.appSubscription?.id ?? null,
        plan: planKey,
        status: "PENDING",
      },
      create: {
        storeId: store.id,
        shopifySubscriptionId: result.appSubscription?.id ?? null,
        plan: planKey,
        status: "PENDING",
      },
    });
  }

  return result.confirmationUrl;
}

// ─── cancelSubscription ───────────────────────────────────────────────────────

export async function cancelSubscription(
  admin: AdminApiContext,
  subscriptionId: string,
  shopDomain: string
): Promise<void> {
  const response = await admin.graphql(
    `#graphql
    mutation AppSubscriptionCancel($id: ID!) {
      appSubscriptionCancel(id: $id) {
        appSubscription {
          id
          status
        }
        userErrors {
          field
          message
        }
      }
    }`,
    { variables: { id: subscriptionId } }
  );

  const json = await response.json() as {
    data?: {
      appSubscriptionCancel?: {
        userErrors?: { field: string; message: string }[];
      };
    };
  };

  const errors = json.data?.appSubscriptionCancel?.userErrors;
  if ((errors?.length ?? 0) > 0) {
    throw new Error(errors![0].message);
  }

  // Downgrade store in our DB
  const store = await prisma.store.findUnique({
    where: { shopifyDomain: shopDomain },
    select: { id: true },
  });

  if (store) {
    await prisma.store.update({
      where: { id: store.id },
      data: { plan: "FREE" },
    });
    await prisma.subscription.upsert({
      where: { storeId: store.id },
      update: { plan: "FREE", status: "CANCELLED" },
      create: { storeId: store.id, plan: "FREE", status: "CANCELLED" },
    });
  }
}

// ─── getActiveSubscription ────────────────────────────────────────────────────

interface ActiveSubscription {
  id: string;
  name: string;
  status: string;
  planKey: PlanKey;
}

export async function getActiveSubscription(
  admin: AdminApiContext
): Promise<ActiveSubscription | null> {
  const response = await admin.graphql(
    `#graphql
    query GetActiveSubscription {
      currentAppInstallation {
        activeSubscriptions {
          id
          name
          status
          trialDays
        }
      }
    }`
  );

  const json = await response.json() as {
    data?: {
      currentAppInstallation?: {
        activeSubscriptions?: { id: string; name: string; status: string; trialDays: number }[];
      };
    };
  };

  const subs = json.data?.currentAppInstallation?.activeSubscriptions ?? [];
  if (subs.length === 0) return null;

  const sub = subs[0];
  const planKey = (Object.entries(PLAN_DEFINITIONS).find(
    ([, def]) => def.name === sub.name
  )?.[0] ?? "FREE") as PlanKey;

  return { id: sub.id, name: sub.name, status: sub.status, planKey };
}

// ─── syncSubscriptionFromShopify ─────────────────────────────────────────────

/**
 * Fetches the active Shopify subscription and syncs it to our DB.
 * Call this when returning from Shopify billing approval.
 */
export async function syncSubscriptionFromShopify(
  admin: AdminApiContext,
  shopDomain: string
): Promise<PlanKey> {
  const sub = await getActiveSubscription(admin);
  const planKey: PlanKey = sub?.planKey ?? "FREE";

  const store = await prisma.store.findUnique({
    where: { shopifyDomain: shopDomain },
    select: { id: true },
  });

  if (store) {
    await prisma.store.update({
      where: { id: store.id },
      data: { plan: planKey },
    });
    await prisma.subscription.upsert({
      where: { storeId: store.id },
      update: {
        shopifySubscriptionId: sub?.id ?? null,
        plan: planKey,
        status: sub ? "ACTIVE" : "CANCELLED",
      },
      create: {
        storeId: store.id,
        shopifySubscriptionId: sub?.id ?? null,
        plan: planKey,
        status: sub ? "ACTIVE" : "CANCELLED",
      },
    });
  }

  return planKey;
}

// ─── checkAndEnforceLimits ────────────────────────────────────────────────────

export interface LimitCheckResult {
  allowed: boolean;
  limit: number | null;
  current: number | null;
  upgradeRequired: PlanKey | null;
}

export async function checkAndEnforceLimits(
  storeId: string,
  planKey: PlanKey,
  feature: PlanLimitKey
): Promise<LimitCheckResult> {
  const limits = PLAN_LIMITS[planKey];
  const limitValue = limits[feature];

  // Boolean feature
  if (typeof limitValue === "boolean") {
    if (limitValue) return { allowed: true, limit: null, current: null, upgradeRequired: null };

    // Find cheapest plan that unlocks this
    const upgradeRequired = (PLAN_ORDER.find((p) => {
      const v = PLAN_LIMITS[p][feature];
      return typeof v === "boolean" ? v : (v as number) > 0;
    }) ?? null) as PlanKey | null;

    return { allowed: false, limit: null, current: null, upgradeRequired };
  }

  // Numeric feature
  const limit = limitValue as number;
  if (limit === Infinity) return { allowed: true, limit: null, current: null, upgradeRequired: null };

  let current = 0;

  if (feature === "maxAuditProducts") {
    current = await prisma.product.count({
      where: { storeId, lastAuditedAt: { not: null } },
    });
  } else if (feature === "maxTrackingPrompts") {
    current = await prisma.trackingPrompt.count({ where: { storeId } });
  } else if (feature === "maxCompetitors") {
    current = await prisma.competitor.count({ where: { storeId } });
  } else if (feature === "maxProductsInLlmsTxt") {
    const llms = await prisma.llmsFile.findFirst({
      where: { storeId, marketCode: "default" },
      select: { productCount: true },
    });
    current = llms?.productCount ?? 0;
  }
  // maxSimulations — not tracked in DB yet; allow and return 0

  const allowed = current < limit;

  if (allowed) return { allowed: true, limit, current, upgradeRequired: null };

  const upgradeRequired = (PLAN_ORDER.find((p) => {
    const v = PLAN_LIMITS[p][feature];
    return v === Infinity || (typeof v === "number" && v > limit);
  }) ?? null) as PlanKey | null;

  return { allowed: false, limit, current, upgradeRequired };
}

// ─── ensurePlan ───────────────────────────────────────────────────────────────

/**
 * Returns a redirect Response if the store's plan is below the required tier.
 * Usage: const guard = ensurePlan(store.plan, "GROWTH"); if (guard) return guard;
 */
export function ensurePlan(
  storePlan: string,
  requiredPlan: PlanKey
): Response | null {
  const storeRank = planRank(storePlan as PlanKey);
  const requiredRank = planRank(requiredPlan);
  if (storeRank < requiredRank) {
    return redirect("/app/pricing");
  }
  return null;
}
