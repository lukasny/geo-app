// GEO Rise brand tokens. Client-safe, imports nothing server-side.
// Source of truth for the app's OWN surfaces only: SVG and canvas data-viz
// (the GEO score ring, the revenue chart), custom illustrations, and bespoke
// markup. Do NOT use these to recolor Polaris components, and do NOT override
// Polaris --p-* tokens. Status badges stay on Polaris Badge tones.

export const brand = {
  indigo: {
    50: "#EEF0FE",
    100: "#E0E2FD",
    200: "#C4C8FB",
    300: "#A5ABF8",
    400: "#818AF2",
    500: "#6366F1",
    600: "#4F46E5", // primary
    700: "#4338CA", // safe for links and small text on white
    800: "#372FA3",
    900: "#2A2575",
  },
  cyan: {
    400: "#22D3EE",
    500: "#06B6D4", // signal, the node, live data; accent only, not small text on light
    600: "#0891B2",
    700: "#0E7490",
  },
  ink: "#15123A",
  mist: "#F4F5FB",
  paper: "#FFFFFF",
  neutral: {
    50: "#F8F8FC",
    100: "#F1F1F8",
    200: "#E8E8F2", // borders
    300: "#CBCAD9",
    400: "#9A99B0",
    500: "#6B6A86", // muted text
    600: "#56536F", // secondary text
    700: "#3A3756",
    900: "#1E1B33",
  },
  gradient: ["#6366F1", "#4338CA"] as const, // app icon, hero accents
} as const;

// Semantic colors for the app's own visuals only. For Polaris components,
// use the Polaris Badge tones instead of these.
export const semantic = {
  success: "#0E9F6E", // cited, good
  warning: "#D97706", // attention
  critical: "#E11D48", // not cited, issue
  info: "#4F46E5", // reuse indigo
} as const;

// Fixed AI platform colors for data-viz only (revenue chart, tracking visuals).
// Keyed to the AiPlatform enum values. Never used as brand color.
export const platformColors: Record<string, string> = {
  CHATGPT: "#10A37F",
  CLAUDE: "#C96442",
  PERPLEXITY: "#20B8CD",
  GEMINI: "#4285F4",
  GROK: "#1F2937",
  GOOGLE_AI_OVERVIEW: "#5E97F6",
};

// GEO score band color, for the score ring accent and label only.
// Reconcile thresholds with any existing band logic rather than duplicating it.
export function scoreColor(score: number): string {
  if (score >= 70) return semantic.success;
  if (score >= 40) return semantic.warning;
  return semantic.critical;
}

// Type roles. In-app body and UI type is Polaris's own; use these only on
// custom marketing-style surfaces inside the app if any exist. All three
// faces are SIL Open Font License, free for commercial use.
export const type = {
  display: '"Space Grotesk", -apple-system, "Segoe UI", Roboto, Arial, sans-serif',
  ui: '"Inter", -apple-system, "Segoe UI", Roboto, Arial, sans-serif',
  mono: '"IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, monospace',
  displayTracking: "-0.02em",
} as const;
