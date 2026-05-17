import prisma from "~/db.server";
import type { Severity, AuditCategory } from "@prisma/client";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ActionItem {
  /** Stable ID derived from category + title — usable as a React key and
   *  as the form value when the merchant clicks "Auto-fix this bucket". */
  id: string;
  /** What the merchant should do, e.g. "Add product descriptions". */
  title: string;
  /** Why it matters — copied from one representative AuditResult.recommendation
   *  (or description if recommendation is empty). */
  description: string;
  category: AuditCategory;
  /** Worst severity in the group — drives the badge color. */
  severity: Severity;
  /** Number of audit issues this bucket covers. Equals affectedProductCount
   *  for per-product issues. */
  count: number;
  /** Distinct products affected. May differ from `count` for issues that
   *  apply per-image (one product can have multiple alt-text issues). */
  affectedProductCount: number;
  autoFixable: boolean;
  /** Rough "click → done" estimate in seconds. Drives the "≈2 min" hint
   *  on each card. Auto-fix uses Claude (~3-5s per call) + Shopify writes. */
  estimatedTimeSeconds: number;
  /** Sum of severity weights, used for ranking. Not displayed. */
  impactPoints: number;
}

export interface ActionPlan {
  actions: ActionItem[];
  /** Total unfixed audit issues across all categories (not just the top N). */
  totalUnfixed: number;
  /** Has the merchant ever run an audit? When false, the page should show
   *  an empty state with a "Run audit" CTA instead of an empty top-N list. */
  hasAudit: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SEVERITY_WEIGHT: Record<Severity, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};

/** Rough Claude+Shopify round-trip time per fix in each category. Used only
 *  for the "≈ N seconds" hint on cards — not enforced. Tuned from
 *  observed timings on boda-brands. */
const SECONDS_PER_FIX: Record<string, number> = {
  CONTENT: 6, // vision call + descriptionHtml write + persistence verify
  IMAGES: 4, // vision call per image
  META: 3, // text-only, fetch + update + verify
  SCHEMA: 2,
  TECHNICAL: 2,
  ACCESSIBILITY: 4,
};

const MAX_ACTIONS = 7;

// ─── Public API ───────────────────────────────────────────────────────────────

/** Build a prioritized action plan for the given store. Groups unfixed audit
 *  issues by (category, title), ranks each group by `severityWeight × count`,
 *  and returns the top N as ActionItems for the UI to render. */
export async function getActionPlan(storeId: string): Promise<ActionPlan> {
  // Has this store ever had an audit produce any rows? Cheaper than
  // counting and helps the route show the right empty state.
  const [unfixedIssues, anyAuditResult] = await Promise.all([
    prisma.auditResult.findMany({
      where: { storeId, fixed: false },
    }),
    prisma.auditResult.findFirst({
      where: { storeId },
      select: { id: true },
    }),
  ]);

  const hasAudit = anyAuditResult !== null;

  // Group by (category, title) — same title = same fix recipe.
  type Group = {
    title: string;
    description: string;
    category: AuditCategory;
    worstSeverity: Severity;
    autoFixable: boolean;
    items: typeof unfixedIssues;
  };
  const groups = new Map<string, Group>();

  for (const issue of unfixedIssues) {
    const key = `${issue.category}::${issue.title}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        title: issue.title,
        description: issue.recommendation || issue.description,
        category: issue.category,
        worstSeverity: issue.severity,
        // A group is auto-fixable only if EVERY issue in it is — protects
        // against accidentally promising one-click fixes for the non-auto
        // subset.
        autoFixable: issue.autoFixable,
        items: [],
      };
      groups.set(key, g);
    } else {
      if (
        SEVERITY_WEIGHT[issue.severity] >
        SEVERITY_WEIGHT[g.worstSeverity]
      ) {
        g.worstSeverity = issue.severity;
      }
      if (!issue.autoFixable) g.autoFixable = false;
    }
    g.items.push(issue);
  }

  const actions: ActionItem[] = [...groups.entries()].map(([key, g]) => {
    const affectedProductIds = new Set<string>();
    for (const it of g.items) {
      if (it.productId) affectedProductIds.add(it.productId);
    }
    const impactPoints = g.items.reduce(
      (sum, it) => sum + SEVERITY_WEIGHT[it.severity],
      0
    );
    const perFix = SECONDS_PER_FIX[g.category] ?? 3;
    return {
      id: stableId(key),
      title: g.title,
      description: g.description,
      category: g.category,
      severity: g.worstSeverity,
      count: g.items.length,
      affectedProductCount: affectedProductIds.size,
      autoFixable: g.autoFixable,
      // Estimated total time: per-fix × count, with a floor of 5s so the
      // UI never says "≈0s" for a single quick fix.
      estimatedTimeSeconds: g.autoFixable
        ? Math.max(5, perFix * g.items.length)
        : 0,
      impactPoints,
    };
  });

  // Rank by total impact desc, take the top N.
  actions.sort((a, b) => b.impactPoints - a.impactPoints);

  return {
    actions: actions.slice(0, MAX_ACTIONS),
    totalUnfixed: unfixedIssues.length,
    hasAudit,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stableId(key: string): string {
  return key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}
