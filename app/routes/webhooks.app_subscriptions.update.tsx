import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { PLAN_DEFINITIONS } from "../services/billing.server";
import prisma from "../db.server";

// Fires when a subscription is created, updated, activated, cancelled, or expired.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`[GEO Rise] ${topic} webhook for ${shop}`);

  const body = payload as {
    app_subscription: {
      name: string;
      status: string; // ACTIVE | CANCELLED | DECLINED | EXPIRED | FROZEN | PENDING
      trial_days: number | null;
      created_at: string | null;
    };
  };

  const subscriptionName = body?.app_subscription?.name;
  const status = body?.app_subscription?.status;

  const store = await prisma.store.findUnique({
    where: { shopifyDomain: shop },
    select: { id: true },
  });

  if (!store) return new Response();

  if (status === "ACTIVE") {
    // Map Shopify plan name back to our PlanKey
    const planKey =
      subscriptionName === PLAN_DEFINITIONS.PRO.name
        ? "PRO"
        : subscriptionName === PLAN_DEFINITIONS.GROWTH.name
        ? "GROWTH"
        : subscriptionName === PLAN_DEFINITIONS.ENTERPRISE.name
        ? "ENTERPRISE"
        : "FREE";

    // Calculate trial end date from payload
    const trialDays = body?.app_subscription?.trial_days ?? 0;
    const createdAt = body?.app_subscription?.created_at;
    let trialEndsAt: Date | null = null;
    if (trialDays > 0 && createdAt) {
      trialEndsAt = new Date(createdAt);
      trialEndsAt.setDate(trialEndsAt.getDate() + trialDays);
    }

    await prisma.store.update({
      where: { id: store.id },
      data: { plan: planKey },
    });

    await prisma.subscription.upsert({
      where: { storeId: store.id },
      update: { plan: planKey, status: "ACTIVE", trialEndsAt },
      create: { storeId: store.id, plan: planKey, status: "ACTIVE", trialEndsAt },
    });
  } else if (["CANCELLED", "EXPIRED", "DECLINED"].includes(status)) {
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

  return new Response();
};
