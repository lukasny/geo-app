import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { planKeyFromSubscriptionName } from "../services/billing.server";
import type { PlanKey } from "../services/billing.server";
import { PLAN_LIMITS } from "../services/billing.shared";
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

    // Ops trail: record the plan change for the founder digest. Only when
    // the plan actually moved - Shopify redelivers webhooks, and an ACTIVE
    // re-delivery for the same plan is not a change. Fire-and-forget: a
    // failed ops write must never fail the webhook 2xx.
    if (store.plan !== planKey) {
      void prisma.opsEvent
        .create({
          data: {
            type: "plan_change",
            shopDomain: shop,
            detail: `${store.plan} to ${planKey} (${status})`,
          },
        })
        .catch((err) =>
          console.error(
            `[GEO Rise] Failed to record plan_change OpsEvent for ${shop}:`,
            err
          )
        );
    }

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

    // A plan switch (including a Pro -> Growth downgrade) fires this ACTIVE
    // event. Prompt caps are only checked at creation time, so a downgrade
    // would leave over-cap prompts firing scheduled multi-platform checks
    // forever - an API-cost leak, and the advertised Growth 10-prompt cap
    // would go unenforced. Pause the excess: keep the OLDEST cap prompts
    // active and convert the newest-over-cap ones to a manual, deactivated
    // state (schedule MANUAL + nextRunAt null + isActive false) so the
    // scheduler tick (schedule != MANUAL, isActive, nextRunAt <= now) skips
    // them. Bounded update, safe to run inline before the 2xx.
    const cap = PLAN_LIMITS[planKey].maxTrackingPrompts;
    if (Number.isFinite(cap)) {
      const activeCount = await prisma.trackingPrompt.count({
        where: { storeId: store.id, isActive: true },
      });
      if (activeCount > cap) {
        // Keep the oldest `cap` active prompts; pause everything newer.
        const toKeep = await prisma.trackingPrompt.findMany({
          where: { storeId: store.id, isActive: true },
          orderBy: { createdAt: "asc" },
          take: cap,
          select: { id: true },
        });
        const keepIds = toKeep.map((p) => p.id);
        const paused = await prisma.trackingPrompt.updateMany({
          where: {
            storeId: store.id,
            isActive: true,
            id: { notIn: keepIds },
          },
          data: { isActive: false, schedule: "MANUAL", nextRunAt: null },
        });
        console.log(
          `[GEO Rise] Downgrade to ${planKey} on ${shop}: paused ${paused.count} tracking prompt(s) over the ${cap}-prompt cap.`
        );
      }
    }
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

    // Ops trail: same rules as the ACTIVE branch above - only on an actual
    // move, fire-and-forget, never blocks the 2xx.
    if (store.plan !== "FREE") {
      void prisma.opsEvent
        .create({
          data: {
            type: "plan_change",
            shopDomain: shop,
            detail: `${store.plan} to FREE (${status})`,
          },
        })
        .catch((err) =>
          console.error(
            `[GEO Rise] Failed to record plan_change OpsEvent for ${shop}:`,
            err
          )
        );
    }

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
