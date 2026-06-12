// Shared score pill. Replaces per-route copies of scoreColor/ScorePill so
// AI readiness scores look identical on every page that shows them.

export function scoreColor(score: number): string {
  if (score < 40) return "#E24B4A";
  if (score < 70) return "#EF9F27";
  return "#1D9E75";
}

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
