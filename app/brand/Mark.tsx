// GEO Rise mark, inline. Drop into app/brand/Mark.tsx.
// No asset file needed: the SVG is the component. Two rising chevrons to a node.
// tone: "color" (indigo mark, cyan node), "ink" (all ink), "white" (all white, for dark).

type MarkTone = "color" | "ink" | "white";

const TONES: Record<MarkTone, { stroke: string; node: string }> = {
  color: { stroke: "#4F46E5", node: "#06B6D4" },
  ink: { stroke: "#15123A", node: "#15123A" },
  white: { stroke: "#FFFFFF", node: "#FFFFFF" },
};

export function Mark({
  size = 28,
  tone = "color",
  title = "GEO Rise",
}: {
  size?: number;
  tone?: MarkTone;
  title?: string;
}) {
  const c = TONES[tone];
  return (
    <svg
      width={size}
      height={size}
      viewBox="16.25 13 67.5 67.25"
      role="img"
      aria-label={title}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M29 71 L50 55 L71 71"
        fill="none"
        stroke={c.stroke}
        strokeWidth={10.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.3}
      />
      <path
        d="M26 60 L50 41 L74 60"
        fill="none"
        stroke={c.stroke}
        strokeWidth={11.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={50} cy={25} r={8} fill={c.node} />
    </svg>
  );
}
