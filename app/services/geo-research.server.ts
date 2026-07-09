// Founder-facing weekly GEO research digest. Runs on the Render server (via the
// cron in scheduler.server.ts), NOT in Claude Code, so it fires every week with
// no app open and no one logged in. Each run does one Claude web-search pass on
// recent Generative Engine Optimization / AI-search developments, distills a
// single action verdict (should Lukas add functionality, update the app, or do
// nothing this week), and emails the digest to OPS_ALERT_EMAIL via the existing
// ops mailer. The verdict lands in both the email subject and its first line so
// it is readable at a glance without opening the mail.
//
// This is deliberately a LIGHT weekly pass (two AI calls), not the heavy
// deep-research skill harness. For a deep pull, run the deep-research skill on
// demand in an interactive Claude Code session.

import Anthropic from "@anthropic-ai/sdk";
import { withRetry } from "./ai-retry.server";
import { sendOpsMail } from "./ops-alerts.server";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

type Verdict = "ADD_FUNCTIONALITY" | "UPDATE_APP" | "NO_ACTION";

const VERDICT_LABEL: Record<Verdict, string> = {
  ADD_FUNCTIONALITY: "Add functionality",
  UPDATE_APP: "Update the app",
  NO_ACTION: "No action this week",
};

interface Classification {
  verdict: Verdict;
  headline: string;
}

// ─── Step 1: research (web search) ────────────────────────────────────────────

const RESEARCH_SYSTEM = `You are a research analyst for GEO Rise, a Shopify app for Generative Engine Optimization: helping merchants get their products discovered, cited, and recommended by AI search engines (ChatGPT, Google Gemini and Google AI Overviews, Perplexity, Bing/Copilot).

Report only what genuinely changed recently and is TACTICALLY ACTIONABLE for this app. Be skeptical and honest:
- Cite every substantive claim with a source URL from your web search. No source, no claim.
- Flag vendor marketing and unsourced assertions as such; never repeat them as established fact.
- NEVER claim that publishing an llms.txt file or JSON-LD schema directly causes AI citations. The current evidence base (Ahrefs, C-SEO Bench) treats these as hygiene and substrate, not proven citation levers; say so if a source overstates it.
- If nothing material changed, say exactly that. Do not pad with filler or restate old news.

Keep it concise and skimmable: short sections, plain language, no hype.`;

const RESEARCH_PROMPT = `Research what has changed in Generative Engine Optimization (GEO) and AI-search visibility in the LAST 7 DAYS, and secondarily over the last ~6 weeks, across ChatGPT, Google Gemini and Google AI Overviews, Perplexity, and Bing/Copilot.

Look for:
- New studies or data on what makes stores and products get cited or recommended by AI assistants.
- Ranking-signal findings (what correlates with being cited or surfaced).
- Platform, model, or API changes that affect AI shopping or search surfaces.

Prioritize findings that are actionable for a Shopify GEO app. Produce a concise, source-cited digest of genuinely new or material findings, grouped under short headings. If nothing material changed this week, say so plainly rather than padding.`;

interface ResearchResult {
  digest: string;
  sourceUrls: string[];
}

async function research(): Promise<ResearchResult> {
  const message = await withRetry(
    () =>
      anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        system: RESEARCH_SYSTEM,
        tools: [
          { type: "web_search_20260209", name: "web_search", max_uses: 5 },
        ],
        messages: [{ role: "user", content: RESEARCH_PROMPT }],
      }),
    "geoResearch:research"
  );

  let digest = "";
  const urls = new Set<string>();
  for (const block of message.content) {
    if (block.type === "text") {
      digest += block.text;
      // Only inline citations count as real sources; see the same reasoning
      // in tracking.server.ts (web_search_tool_result blocks carry every raw
      // result, cited or not).
      const citations = (
        block as unknown as { citations?: Array<{ url?: string }> }
      ).citations;
      if (citations) {
        for (const c of citations) {
          if (c.url) urls.add(c.url);
        }
      }
    }
  }
  return { digest: digest.trim(), sourceUrls: [...urls] };
}

// ─── Step 2: classify into an action verdict ──────────────────────────────────

function parseClassification(text: string): Classification | null {
  const cleaned = text.replace(/```json\s*|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1)) as {
      verdict?: string;
      headline?: string;
    };
    if (
      obj.verdict !== "ADD_FUNCTIONALITY" &&
      obj.verdict !== "UPDATE_APP" &&
      obj.verdict !== "NO_ACTION"
    ) {
      return null;
    }
    return {
      verdict: obj.verdict,
      headline: typeof obj.headline === "string" ? obj.headline.trim() : "",
    };
  } catch {
    return null;
  }
}

async function classify(digest: string): Promise<Classification | null> {
  const message = await withRetry(
    () =>
      anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 300,
        system:
          "You classify a GEO research digest into a single action verdict for the owner of the GEO Rise Shopify app. Respond with ONLY a JSON object: no prose, no code fence.",
        messages: [
          {
            role: "user",
            content:
              `Digest:\n"""\n${digest}\n"""\n\n` +
              `Decide the single most important action for the app owner based on this digest. Return JSON exactly: ` +
              `{"verdict": "ADD_FUNCTIONALITY" | "UPDATE_APP" | "NO_ACTION", "headline": "<=90 chars, plain language"}. ` +
              `ADD_FUNCTIONALITY: the digest points to a concrete NEW capability worth building. ` +
              `UPDATE_APP: existing features, prompts, or copy should change. ` +
              `NO_ACTION: nothing material changed or nothing is worth acting on this week. ` +
              `For NO_ACTION, the headline should briefly say why nothing is needed.`,
          },
        ],
      }),
    "geoResearch:classify"
  );

  const text = message.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("");
  return parseClassification(text);
}

// ─── Compose + send ───────────────────────────────────────────────────────────

const RULE = "=".repeat(52);

function composeBody(
  classification: Classification | null,
  digest: string,
  sourceUrls: string[]
): string {
  const label = classification
    ? VERDICT_LABEL[classification.verdict]
    : "Review needed";
  const headline =
    classification?.headline ||
    (classification ? "See digest below." : "Automatic classification failed; read the digest.");

  const firstLine = `VERDICT: ${label}. ${headline}`;

  const sources = sourceUrls.length
    ? `\n\nSources:\n${sourceUrls.map((u) => `- ${u}`).join("\n")}`
    : "";

  return (
    `${firstLine}\n\n` +
    `Your automated weekly GEO research digest, produced by GEO Rise on the server. ` +
    `It scans roughly the last 7 days of AI-search and GEO developments and flags whether the app likely needs changes.\n\n` +
    `${RULE}\n\n` +
    `${digest}${sources}\n\n` +
    `${RULE}\n` +
    `Note: this is a single web-search pass, not a deep audit. To act on anything above, open the geo-app repo in Claude Code and review docs/geo-evidence-2026-07.md before changing anything. This email never edits the app.`
  );
}

/** Run the weekly GEO research digest and email it to OPS_ALERT_EMAIL. Returns
 *  true only when the email was accepted by Resend. Safe to call manually; the
 *  scheduler additionally gates on OPS_ALERT_EMAIL, the AI kill switch, and an
 *  overlap guard. Never throws for the "not configured" cases; genuine AI or
 *  send failures propagate so the cron wrapper can log and captureError. */
export async function runGeoResearchDigest(): Promise<boolean> {
  if (!process.env.ANTHROPIC_API_KEY) return false;
  if (!process.env.OPS_ALERT_EMAIL) return false;

  const { digest, sourceUrls } = await research();
  const classification = await classify(digest).catch(() => null);

  const label = classification
    ? VERDICT_LABEL[classification.verdict]
    : "Review needed";
  const headline = classification?.headline || "See digest.";

  // Verdict in the subject so it is legible from the inbox list, trimmed to a
  // sane length so the classifier can never blow up the subject line.
  const subject = `GEO digest [${label}]: ${headline}`.slice(0, 180);
  const body = composeBody(classification, digest, sourceUrls);

  // countsTowardCap: false so this scheduled digest is never dropped by the
  // 5-per-day error-alert cap, matching the ops digest.
  return sendOpsMail(subject, body, { countsTowardCap: false });
}
