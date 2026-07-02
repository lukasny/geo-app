import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import { redirect } from "@remix-run/node";
import prisma from "~/db.server";
import { PLAN_DEFINITIONS } from "~/services/billing.shared";
import type { PlanKey } from "~/services/billing.shared";
export { PLAN_DEFINITIONS, PLAN_LIMITS } from "~/services/billing.shared";
export type { PlanKey, PlanLimitKey } from "~/services/billing.shared";

// ─── Plan ordering (for upgrade/downgrade checks) ─────────────────────────────

const PLAN_ORDER: PlanKey[] = ["FREE", "GROWTH", "PRO", "ENTERPRISE"];

export function planRank(plan: PlanKey): number {
  return PLAN_ORDER.indexOf(plan);
}

/**
 * Maps a Shopify subscription display name back to our PlanKey, or null when
 * nothing matches. Subscription names are immutable snapshots taken at
 * creation time, so after any rewording of PLAN_DEFINITIONS names the
 * subscriptions of existing subscribers will no longer match - callers must
 * treat null as "unknown", never as FREE.
 */
export function planKeyFromSubscriptionName(
  name: string | null | undefined
): PlanKey | null {
  const entry = Object.entries(PLAN_DEFINITIONS).find(
    ([, def]) => def.name === name
  );
  return (entry?.[0] as PlanKey | undefined) ?? null;
}

// ─── createSubscription ───────────────────────────────────────────────────────

/**
 * Creates a Shopify app subscription and returns the confirmationUrl to
 * redirect the merchant to for approval.
 *
 * Plan switches: Shopify allows one active subscription per app per shop;
 * approving a new subscription automatically cancels the old one (with
 * prorated credit on downgrades), so switching plans is just another
 * create. Pass skipTrial for switches so existing subscribers don't get
 * a fresh free trial every time they change plans.
 */
export async function createSubscription(
  admin: AdminApiContext,
  planKey: Exclude<PlanKey, "FREE" | "ENTERPRISE">,
  shopDomain: string,
  options: { skipTrial?: boolean } = {}
): Promise<string> {
  const plan = PLAN_DEFINITIONS[planKey];
  // Return the merchant to an admin.shopify.com deep link, NOT a bare app URL.
  // After approval Shopify redirects TOP-LEVEL with only ?charge_id appended;
  // a raw ${SHOPIFY_APP_URL}/app/pricing hop has no shop/host, so
  // shopify-app-remix throws to /auth/login and the charge_id sync never runs.
  // The admin deep link re-embeds the app (Shopify supplies shop/host/id_token),
  // and the loader's charge_id sync + "Plan updated" toast fire as intended.
  const storeHandle = shopDomain.replace(".myshopify.com", "");
  const returnUrl = `https://admin.shopify.com/store/${storeHandle}/apps/${process.env.SHOPIFY_API_KEY}/app/pricing`;

  // Detect dev stores via shop.plan.partnerDevelopment. Dev stores must use
  // Shopify test billing (test: true) so no real payment method is required and
  // no real charge is made - even when the app itself is running on production
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
        trialDays: options.skipTrial ? 0 : plan.trialDays,
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

  // Intentionally no DB write here. The merchant has not approved anything
  // yet: overwriting the live Subscription row with the new plan and a
  // PENDING status would corrupt the billing mirror whenever checkout is
  // abandoned (an unapproved subscription silently expires after ~2 days and
  // nothing would ever correct the row). The charge_id sync on return
  // (syncSubscriptionFromShopify) and the ACTIVE webhook write the
  // authoritative state after approval.
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
  trialDays: number;
  createdAt: string | null;
  /**
   * Plan resolved from the subscription display name, or null when the name
   * matches no PLAN_DEFINITIONS entry. Callers must not treat null as FREE:
   * an ACTIVE subscription means Shopify is charging the merchant.
   */
  planKeyFromName: PlanKey | null;
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
          createdAt
        }
      }
    }`
  );

  const json = await response.json() as {
    data?: {
      currentAppInstallation?: {
        activeSubscriptions?: {
          id: string;
          name: string;
          status: string;
          trialDays: number | null;
          createdAt: string | null;
        }[];
      };
    };
  };

  const subs = json.data?.currentAppInstallation?.activeSubscriptions ?? [];
  if (subs.length === 0) return null;

  const sub = subs[0];

  return {
    id: sub.id,
    name: sub.name,
    status: sub.status,
    trialDays: sub.trialDays ?? 0,
    createdAt: sub.createdAt ?? null,
    planKeyFromName: planKeyFromSubscriptionName(sub.name),
  };
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

  const store = await prisma.store.findUnique({
    where: { shopifyDomain: shopDomain },
    select: {
      id: true,
      plan: true,
      subscription: { select: { shopifySubscriptionId: true, plan: true } },
    },
  });

  if (!store) return "FREE";

  if (!sub) {
    // Shopify reports no active subscription, so the merchant really is on
    // Free (declined/cancelled/never subscribed).
    await prisma.store.update({
      where: { id: store.id },
      data: { plan: "FREE" },
    });
    await prisma.subscription.upsert({
      where: { storeId: store.id },
      update: { shopifySubscriptionId: null, plan: "FREE", status: "CANCELLED" },
      create: { storeId: store.id, plan: "FREE", status: "CANCELLED" },
    });
    return "FREE";
  }

  // Resolve the plan: prefer the planKey we already persisted for this exact
  // subscription id (ids are stable; display names can be reworded), then
  // fall back to the name match. If neither resolves, KEEP the current plan
  // and log loudly - never silently downgrade a merchant whose subscription
  // Shopify reports as ACTIVE.
  let planKey: PlanKey | null =
    store.subscription?.shopifySubscriptionId &&
    store.subscription.shopifySubscriptionId === sub.id
      ? (store.subscription.plan as PlanKey)
      : sub.planKeyFromName;

  if (!planKey) {
    planKey = store.plan as PlanKey;
    console.error(
      `[GEO Rise] Billing sync: ACTIVE subscription "${sub.name}" (${sub.id}) for ${shopDomain} matches no plan definition and no stored subscription id. Keeping current plan "${planKey}". Likely PLAN_DEFINITIONS name drift - investigate immediately.`
    );
  }

  // The app_subscriptions/update webhook payload carries no trial fields, so
  // this GraphQL-backed sync is the one place trialEndsAt is computed.
  let trialEndsAt: Date | null = null;
  if (sub.trialDays > 0 && sub.createdAt) {
    trialEndsAt = new Date(sub.createdAt);
    trialEndsAt.setDate(trialEndsAt.getDate() + sub.trialDays);
  }

  await prisma.store.update({
    where: { id: store.id },
    data: { plan: planKey },
  });
  await prisma.subscription.upsert({
    where: { storeId: store.id },
    update: {
      shopifySubscriptionId: sub.id,
      plan: planKey,
      status: "ACTIVE",
      trialEndsAt,
    },
    create: {
      storeId: store.id,
      shopifySubscriptionId: sub.id,
      plan: planKey,
      status: "ACTIVE",
      trialEndsAt,
    },
  });

  return planKey;
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
