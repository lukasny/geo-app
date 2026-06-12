import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { planKeyFromSubscriptionName } from "../services/billing.server";
import type { PlanKey } from "../services/billing.server";
import prisma from "../db.server";

// Fires when a subscription is created, updated, activated, cancelled, or expired.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`[GEO Rise] ${topic} webhook for ${shop}`);

  // 2025-07 payload shape: admin_graphql_api_id, name, status, created_at,
  // updated_at, currency, capped_amount, price, interval, plan_handle.
  // Note: there is NO trial_days field in this payload, so trialEndsAt is
  // never written here - syncSubscriptionFromShopify derives it via GraphQL
  // (trialDays + createdAt) when the merchant returns from billing approval.
  const body = payload as {
    app_subscription: {
      admin_graphql_api_id: string | null;
      name: string;
      status: string; // ACTIVE | CANCELLED | DECLINED | EXPIRED | FROZEN | PENDING
    };
  };

  const eventSubId = body?.app_subscription?.admin_graphql_api_id ?? null;
  const subscriptionName = body?.app_subscription?.name;
  const status = body?.app_subscription?.status;

  const store = await prisma.store.findUnique({
    where: { shopifyDomain: shop },
    select: { id: true, plan: true },
  });

  if (!store) return new Response();

  const storedSub = await prisma.subscription.findUnique({
    where: { storeId: store.id },
    select: { shopifySubscriptionId: true, plan: true },
  });
  const isStoredLiveSubscription =
    !!eventSubId &&
    !!storedSub?.shopifySubscriptionId &&
    storedSub.shopifySubscriptionId === eventSubId;

  if (status === "ACTIVE") {
    // Resolve the plan: prefer the planKey we already persisted for this
    // exact subscription id (ids are stable; display names can be reworded),
    // then fall back to the name match. NEVER fall back to FREE for an
    // ACTIVE subscription - Shopify is still charging the merchant.
    const planKey: PlanKey | null =
      storedSub && isStoredLiveSubscription
        ? (storedSub.plan as PlanKey)
        : planKeyFromSubscriptionName(subscriptionName);

    if (!planKey) {
      console.error(
        `[GEO Rise] app_subscriptions/update: ACTIVE subscription "${subscriptionName}" (${eventSubId}) for ${shop} matches no plan definition and no stored subscription id. Keeping current plan "${store.plan}". Likely PLAN_DEFINITIONS name drift - investigate immediately.`
      );
      // Still record that this is the live, active subscription so future
      // events for it (CANCELLED/FROZEN) match by id; keep the plan as-is.
      await prisma.subscription.upsert({
        where: { storeId: store.id },
        update: { shopifySubscriptionId: eventSubId, status: "ACTIVE" },
        create: {
          storeId: store.id,
          shopifySubscriptionId: eventSubId,
          plan: store.plan,
          status: "ACTIVE",
        },
      });
      return new Response();
    }

    await prisma.store.update({
      where: { id: store.id },
      data: { plan: planKey },
    });

    await prisma.subscription.upsert({
      where: { storeId: store.id },
      update: { shopifySubscriptionId: eventSubId, plan: planKey, status: "ACTIVE" },
      create: {
        storeId: store.id,
        shopifySubscriptionId: eventSubId,
        plan: planKey,
        status: "ACTIVE",
      },
    });
  } else if (["CANCELLED", "EXPIRED", "DECLINED"].includes(status)) {
    // Plan switches use Shopify's STANDARD replacement behavior: approving a
    // new subscription immediately cancels the old one, and that cancellation
    // fires this webhook too - with no delivery-order guarantee relative to
    // the ACTIVE event for the new subscription. Abandoned PENDING checkouts
    // likewise expire. Only downgrade when the event is for the subscription
    // we know to be the live one; otherwise a routine plan switch would
    // downgrade a paying merchant to FREE and wipe their tracking schedules.
    if (!isStoredLiveSubscription) {
      console.log(
        `[GEO Rise] Ignoring ${status} for subscription ${eventSubId} on ${shop}: not the stored live subscription (${storedSub?.shopifySubscriptionId ?? "none"}). Likely a replaced or abandoned subscription.`
      );
      return new Response();
    }

    await prisma.store.update({
      where: { id: store.id },
      data: { plan: "FREE" },
    });

    // Convert any scheduled tracking prompts back to MANUAL - FREE doesn't
    // include automatic scheduling. Without this, the scheduler tick would
    // keep firing the merchant's old prompts and we'd pay Claude API for it
    // indefinitely. The scheduler tick also filters `store.plan != "FREE"`
    // as belt-and-suspenders in case this webhook is ever missed.
    await prisma.trackingPrompt.updateMany({
      where: { storeId: store.id, schedule: { not: "MANUAL" } },
      data: { schedule: "MANUAL", nextRunAt: null },
    });

    await prisma.subscription.update({
      where: { storeId: store.id },
      data: { plan: "FREE", status: "CANCELLED" },
    });
  } else if (status === "FROZEN") {
    // Shopify froze the subscription (shop paused or payment collection
    // failed). Freezing is temporary: unfreezing emits another ACTIVE event,
    // which the branch above restores. Record the status without rewriting
    // store.plan and without touching tracking schedules so the resume is
    // lossless. Gating scheduled work (tracking scheduler, insight emails)
    // on Subscription.status !== "FROZEN" is a follow-up - today those only
    // check store.plan.
    if (isStoredLiveSubscription) {
      await prisma.subscription.update({
        where: { storeId: store.id },
        data: { status: "FROZEN" },
      });
    } else {
      console.log(
        `[GEO Rise] Ignoring FROZEN for subscription ${eventSubId} on ${shop}: not the stored live subscription.`
      );
    }
  }

  return new Response();
};
