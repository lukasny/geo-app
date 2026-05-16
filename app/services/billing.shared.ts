// Shared billing constants — safe to import in both server and client code.
// Do NOT add server-only imports (prisma, shopify SDK, etc.) here.

export const PLAN_DEFINITIONS = {
  FREE:       { name: "Free",       price: 0,   trialDays: 0 },
  GROWTH:     { name: "Growth",     price: 39,  trialDays: 7 },
  PRO:        { name: "Pro",        price: 79,  trialDays: 7 },
  ENTERPRISE: { name: "Enterprise", price: 199, trialDays: 7 },
} as const;

export type PlanKey = keyof typeof PLAN_DEFINITIONS;

export const PLAN_LIMITS = {
  FREE: {
    maxProductsInLlmsTxt:   25,
    maxAuditProducts:        3,
    maxSimulations:          3,
    maxTrackingPrompts:      0,
    maxCompetitors:          0,
    aiTracking:              false,
    competitorMonitoring:    false,
    revenueAttribution:      false,
    contentEngine:           false,
    euComplianceModule:      false,
    multiMarketLlmsTxt:      false,
    bulkOptimization:        false,
    insightEmails:           false,
    shopifyFlowIntegration:  false,
    prioritySupport:         false,
  },
  GROWTH: {
    maxProductsInLlmsTxt:   Infinity,
    maxAuditProducts:       Infinity,
    maxSimulations:         Infinity,
    maxTrackingPrompts:     10,
    maxCompetitors:          3,
    aiTracking:              true,
    competitorMonitoring:    false,
    revenueAttribution:      false,
    contentEngine:           false,
    euComplianceModule:      false,
    multiMarketLlmsTxt:      true,
    bulkOptimization:        true,
    insightEmails:           true,
    shopifyFlowIntegration:  false,
    prioritySupport:         false,
  },
  PRO: {
    maxProductsInLlmsTxt:   Infinity,
    maxAuditProducts:       Infinity,
    maxSimulations:         Infinity,
    maxTrackingPrompts:     30,
    maxCompetitors:         10,
    aiTracking:              true,
    competitorMonitoring:    true,
    revenueAttribution:      true,
    contentEngine:           true,
    euComplianceModule:      true,
    multiMarketLlmsTxt:      true,
    bulkOptimization:        true,
    insightEmails:           true,
    shopifyFlowIntegration:  false,
    prioritySupport:         true,
  },
  ENTERPRISE: {
    maxProductsInLlmsTxt:   Infinity,
    maxAuditProducts:       Infinity,
    maxSimulations:         Infinity,
    maxTrackingPrompts:     50,
    maxCompetitors:         25,
    aiTracking:              true,
    competitorMonitoring:    true,
    revenueAttribution:      true,
    contentEngine:           true,
    euComplianceModule:      true,
    multiMarketLlmsTxt:      true,
    bulkOptimization:        true,
    insightEmails:           true,
    shopifyFlowIntegration:  true,
    prioritySupport:         true,
  },
} as const satisfies Record<PlanKey, Record<string, boolean | number>>;

export type PlanLimitKey = keyof (typeof PLAN_LIMITS)["FREE"];
