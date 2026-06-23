// Shared score pill. Replaces per-route copies of scoreColor/ScorePill so
// AI readiness scores look identical on every page that shows them.

import { scoreColor } from "~/brand/tokens";

// Re-exported so existing consumers (app.audit.tsx) keep importing it from
// here, now backed by the brand-token thresholds instead of local hex.
export { scoreColor };

export function ScorePill({ score }: { score: number }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 10px",
        borderRadius: "12px",
        backgroundColor: scoreColor(score),
        color: "#fff",
        fontWeight: 600,
        fontSize: "13px",
        minWidth: "36px",
        textAlign: "center",
      }}
    >
      {score}
    </span>
  );
}
