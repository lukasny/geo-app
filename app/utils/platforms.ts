// Shared AI platform display names. Replaces four near-identical maps that
// previously lived in route files and had drifted ("Google AI" vs
// "Google AI Overview"). Safe to import from anywhere: pure data.

export type AiPlatformKey =
  | "CLAUDE"
  | "CHATGPT"
  | "PERPLEXITY"
  | "GEMINI"
  | "GROK"
  | "GOOGLE_AI_OVERVIEW";

export const PLATFORM_LABELS: Record<AiPlatformKey, string> = {
  CLAUDE: "Claude",
  CHATGPT: "ChatGPT",
  PERPLEXITY: "Perplexity",
  GEMINI: "Gemini",
  GROK: "Grok",
  GOOGLE_AI_OVERVIEW: "Google AI Overview",
};

/** Display name for a platform value, falling back to the raw value for
 *  anything not in the map (future enum additions keep rendering). */
export function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform as AiPlatformKey] ?? platform;
}
