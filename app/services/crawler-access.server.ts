/**
 * robots.txt visibility checker + robots.txt.liquid snippet builder.
 *
 * The llms.txt "AI bot access" toggles only annotate the llms.txt file;
 * the thing crawlers actually obey is the storefront's robots.txt. This
 * module reads that file and reports, per known AI crawler, whether the
 * store currently blocks it at the root, and builds a copy-paste
 * robots.txt.liquid snippet that makes robots.txt match the toggles.
 */
import prisma from "~/db.server";
import { getFreshAccessToken } from "~/services/offline-admin.server";
import { AI_CRAWLER_PATTERNS } from "~/services/crawler-hits.server";

const ROBOTS_FETCH_TIMEOUT_MS = 5000;

// RFC 9309 section 2.4 requires parsers to handle at least 500 KiB of
// robots.txt; capping there keeps a misconfigured (or hostile) origin from
// ballooning memory while staying spec-compliant.
const MAX_ROBOTS_LENGTH = 512 * 1024;

/** Read at most `maxBytes` of a response body, streaming so a slow or huge
 *  origin can't buffer hundreds of MB into memory before we slice. The
 *  storefront origin is merchant-controlled (primaryDomain) and the fetch
 *  follows redirects, so the body is untrusted: the 5s AbortSignal bounds
 *  time, this bounds size. Returns the decoded text (UTF-8; robots.txt is
 *  ASCII in practice). */
async function readBoundedText(
  response: Response,
  maxBytes: number
): Promise<string> {
  // Fast path: trust a declared Content-Length that already exceeds the cap
  // and skip reading the body entirely.
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return "";
  }
  const reader = response.body?.getReader();
  if (!reader) {
    // No streamable body (not expected for a normal fetch 200); fall back.
    return (await response.text()).slice(0, maxBytes);
  }
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) text += decoder.decode(value, { stream: true });
    }
  } finally {
    // Stop the download as soon as we have enough (or hit the cap).
    await reader.cancel().catch(() => {});
  }
  return text.slice(0, maxBytes);
}

export type BotAccessStatus = "allowed" | "blocked" | "unknown";

export interface BotAccess {
  botName: string;
  status: BotAccessStatus;
}

export interface CrawlerAccessResult {
  /** True when we got a definitive read: a parseable robots.txt, or a
   *  404/410 (RFC 9309 2.3.1.3: an unavailable robots.txt means crawlers
   *  may access everything). False on timeout, network error, or other
   *  HTTP failures, in which case every bot is "unknown". */
  fetched: boolean;
  robotsUrl: string;
  bots: BotAccess[];
}

/** Canonical bot names come from the proxy's UA classification list so the
 *  checker, the hit log, and the snippet can never drift apart. */
const BOT_NAMES = AI_CRAWLER_PATTERNS.map((p) => p.botName);

// ─── Storefront base URL ─────────────────────────────────────────────────────

const PRIMARY_DOMAIN_QUERY = `#graphql
  query StorefrontPrimaryDomainUrl {
    shop {
      primaryDomain { url }
    }
  }
`;

/** Public storefront base URL (e.g. "https://acmeboards.com"). robots.txt
 *  lives on the primary domain, not the myshopify one, so resolve it via a
 *  raw GraphQL call with a freshly refreshed offline token (the app uses
 *  expiring offline tokens, so any persisted token copy goes stale; see
 *  offline-admin.server.ts). Falls back to the myshopify domain on any
 *  failure, which Shopify redirects to the primary domain anyway. */
async function resolveStorefrontBase(shopifyDomain: string): Promise<string> {
  const fallback = `https://${shopifyDomain}`;
  try {
    const accessToken = await getFreshAccessToken(shopifyDomain);
    const response = await fetch(
      `https://${shopifyDomain}/admin/api/2025-07/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query: PRIMARY_DOMAIN_QUERY }),
      }
    );
    if (!response.ok) return fallback;
    const json = (await response.json()) as {
      data?: { shop?: { primaryDomain?: { url?: string } } };
    };
    const url = json.data?.shop?.primaryDomain?.url?.trim();
    return url ? url.replace(/\/+$/, "") : fallback;
  } catch {
    return fallback;
  }
}

// ─── robots.txt parsing ───────────────────────────────────────────────────────

interface RobotsGroup {
  /** Lowercased product tokens from the group's User-agent lines. */
  agents: string[];
  /** Group contains an effective root block ("Disallow: /" or "/*"). */
  rootDisallow: boolean;
  /** Group contains an explicit root allow ("Allow: /" or "/*"). */
  rootAllow: boolean;
}

/**
 * Conservative RFC 9309 group parser. Only the facts the checker needs are
 * extracted: which UA tokens each group names, and whether the group
 * allows or disallows the root path. Per-path rules are out of scope by
 * design (spec: root-level allow/block only), so a group that merely
 * disallows /checkout reads as "allowed".
 */
function parseRobotsGroups(robotsTxt: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  // Consecutive User-agent lines extend the same group (RFC 9309 lets one
  // rule set name several agents); the first rule line closes the agent
  // list so a later User-agent line starts a fresh group.
  let collectingAgents = false;

  for (const rawLine of robotsTxt.split(/\r\n|\r|\n/)) {
    // Comments run from "#" to end of line.
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const directive = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (directive === "user-agent") {
      if (!current || !collectingAgents) {
        current = { agents: [], rootDisallow: false, rootAllow: false };
        groups.push(current);
        collectingAgents = true;
      }
      if (value) current.agents.push(value.toLowerCase());
      continue;
    }

    if (directive === "allow" || directive === "disallow") {
      collectingAgents = false;
      // Rules before any User-agent line belong to no group per RFC 9309.
      if (!current) continue;
      // "/" blocks everything; "/*" is its wildcard spelling and every
      // mainstream interpreter treats them identically. An empty Disallow
      // value means "allow all" and is deliberately NOT a root block.
      if (value !== "/" && value !== "/*") continue;
      if (directive === "disallow") current.rootDisallow = true;
      else current.rootAllow = true;
      continue;
    }
    // Sitemap, Crawl-delay, and unknown directives are ignored without
    // splitting the group (RFC 9309: ignore unrecognized lines).
  }

  return groups;
}

/** Effective root-level status for one bot. RFC 9309 section 2.2.1: a
 *  crawler obeys the group(s) whose product token matches it exactly
 *  (case-insensitive); the "*" group applies only when no exact match
 *  exists; several matching groups merge into one rule set. */
function statusFor(botName: string, groups: RobotsGroup[]): BotAccessStatus {
  const token = botName.toLowerCase();
  let matched = groups.filter((g) => g.agents.includes(token));
  if (matched.length === 0) {
    matched = groups.filter((g) => g.agents.includes("*"));
  }
  // No applicable group at all means no restrictions.
  if (matched.length === 0) return "allowed";

  const rootDisallow = matched.some((g) => g.rootDisallow);
  const rootAllow = matched.some((g) => g.rootAllow);
  // "Allow: /" and "Disallow: /" tie on path length; RFC 9309 resolves
  // ties to the least restrictive rule, so an explicit root Allow wins.
  return rootDisallow && !rootAllow ? "blocked" : "allowed";
}

// ─── Checker ──────────────────────────────────────────────────────────────────

export async function checkCrawlerAccess(
  storeId: string
): Promise<CrawlerAccessResult> {
  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { shopifyDomain: true },
  });
  if (!store) {
    throw new Error(`Store ${storeId} not found`);
  }

  const base = await resolveStorefrontBase(store.shopifyDomain);
  const robotsUrl = `${base}/robots.txt`;

  let body: string | null = null;
  let definitiveMiss = false;
  try {
    const response = await fetch(robotsUrl, {
      signal: AbortSignal.timeout(ROBOTS_FETCH_TIMEOUT_MS),
      headers: {
        "User-Agent": "GEO-Rise-Robots-Checker/1.0",
        Accept: "text/plain, */*",
      },
    });
    if (response.ok) {
      body = await readBoundedText(response, MAX_ROBOTS_LENGTH);
    } else if (response.status === 404 || response.status === 410) {
      // Definitive answer: no robots.txt means nothing is blocked.
      definitiveMiss = true;
    }
  } catch {
    // Timeout / DNS / TLS failures fall through to the "unknown" result;
    // guessing "blocked" here would send merchants chasing a phantom.
  }

  if (body === null && !definitiveMiss) {
    return {
      fetched: false,
      robotsUrl,
      bots: BOT_NAMES.map((botName) => ({
        botName,
        status: "unknown" as const,
      })),
    };
  }

  const groups = body === null ? [] : parseRobotsGroups(body);
  return {
    fetched: true,
    robotsUrl,
    bots: BOT_NAMES.map((botName) => ({
      botName,
      status: statusFor(botName, groups),
    })),
  };
}

// ─── robots.txt.liquid snippet ────────────────────────────────────────────────

/** The six LlmsFile bot toggles, by their Prisma column names so rows can
 *  be passed straight in. */
export interface BotToggles {
  allowChatGPT: boolean;
  allowClaude: boolean;
  allowGemini: boolean;
  allowPerplexity: boolean;
  allowDeepSeek: boolean;
  allowGrok: boolean;
}

/**
 * Toggle -> robots.txt product tokens, doc-verified 2026-06-12:
 * - ChatGPT: GPTBot, OAI-SearchBot, ChatGPT-User
 *   (developers.openai.com/api/docs/bots)
 * - Claude: ClaudeBot, Claude-User, Claude-SearchBot
 *   (support.claude.com article 8896518 lists all three)
 * - Gemini: Google-Extended, the robots.txt-only token controlling Gemini
 *   training and grounding (developers.google.com, common crawlers page).
 *   GoogleOther is generic R&D crawling, not Gemini, so it stays unmapped.
 * - Perplexity: PerplexityBot, Perplexity-User (docs.perplexity.ai/guides/bots)
 * - DeepSeek and Grok: NO documented crawler UA exists for either vendor
 *   (verified June 2026; both fetch with generic browser UAs), so there is
 *   nothing for robots.txt to target. Empty lists make the snippet say so
 *   honestly instead of inventing tokens.
 */
export const TOGGLE_CRAWLER_MAP: ReadonlyArray<{
  toggle: keyof BotToggles;
  label: string;
  userAgents: string[];
}> = [
  {
    toggle: "allowChatGPT",
    label: "ChatGPT",
    userAgents: ["GPTBot", "OAI-SearchBot", "ChatGPT-User"],
  },
  {
    toggle: "allowClaude",
    label: "Claude",
    userAgents: ["ClaudeBot", "Claude-User", "Claude-SearchBot"],
  },
  { toggle: "allowGemini", label: "Gemini", userAgents: ["Google-Extended"] },
  {
    toggle: "allowPerplexity",
    label: "Perplexity",
    userAgents: ["PerplexityBot", "Perplexity-User"],
  },
  { toggle: "allowDeepSeek", label: "DeepSeek", userAgents: [] },
  { toggle: "allowGrok", label: "Grok", userAgents: [] },
];

/**
 * Build a complete robots.txt.liquid template reflecting the merchant's
 * six AI bot toggles.
 *
 * Layout follows Shopify's documented customization pattern
 * (shopify.dev/docs/storefronts/themes/architecture/templates/robots-txt-liquid
 * and .../themes/seo/robots-txt): first render robots.default_groups via
 * Liquid so Shopify's regularly updated SEO defaults survive, then append
 * custom groups as plain text after the loop.
 *
 * Known trade-off, accepted by the spec: giving a bot its own exact-match
 * group means it no longer reads the "*" defaults (RFC 9309), so an
 * allowed bot's "Allow: /" group also lifts Shopify's default per-path
 * disallows (/cart, /checkout, ...) for that bot. Those paths are
 * auth-gated or noindex, so the simple, merchant-readable mapping wins.
 */
export function buildRobotsSnippet(toggles: BotToggles): string {
  const lines: string[] = [
    "{% for group in robots.default_groups %}",
    "  {{- group.user_agent -}}",
    "",
    "  {% for rule in group.rules %}",
    "    {{- rule -}}",
    "  {% endfor %}",
    "",
    "  {%- if group.sitemap != blank -%}",
    "    {{ group.sitemap }}",
    "  {%- endif -%}",
    "{% endfor %}",
    "",
    "# Added by GEO Rise: AI crawler access, mirroring your llms.txt settings.",
  ];

  const unaddressable: string[] = [];
  for (const { toggle, label, userAgents } of TOGGLE_CRAWLER_MAP) {
    if (userAgents.length === 0) {
      unaddressable.push(label);
      continue;
    }
    const allowed = toggles[toggle];
    lines.push("");
    lines.push(`# ${label}: ${allowed ? "allowed" : "blocked"}`);
    for (const ua of userAgents) {
      lines.push(`User-agent: ${ua}`);
    }
    lines.push(allowed ? "Allow: /" : "Disallow: /");
  }

  if (unaddressable.length > 0) {
    lines.push("");
    lines.push(
      `# ${unaddressable.join(" and ")} publish no crawler user agent,`,
      "# so robots.txt cannot target them."
    );
  }

  return lines.join("\n") + "\n";
}
