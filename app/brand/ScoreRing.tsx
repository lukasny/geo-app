// GEO score ring. The app's own data-viz surface (inline SVG), so it draws on
// the brand tokens directly: a neutral track, an indigo progress arc, and a
// cyan node sitting at the current value's position on the arc. This is NOT a
// Polaris component and must not be used to recolor one.
//
// The numeric score is always rendered and an aria-label spells it out, so the
// state never depends on color alone.

import { useEffect, useState } from "react";
import { brand, scoreColor } from "~/brand/tokens";

interface ScoreRingProps {
  /** 0 to 100. Clamped before drawing. */
  score: number;
  /** When true, count up from 0 to score over ~1.2s ease-out on mount.
   *  Respects prefers-reduced-motion (renders the final score immediately). */
  animate?: boolean;
}

const SIZE = 160;
const CENTER = SIZE / 2;
const RADIUS = 60;
const STROKE = 14;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const COUNT_UP_MS = 1200;

function clampScore(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

export function ScoreRing({ score, animate = false }: ScoreRingProps) {
  const target = clampScore(score);

  // `displayScore` is what we actually paint. Without animation it tracks the
  // target directly (the arc still eases via CSS transition). With animation
  // it counts up from 0, unless the user prefers reduced motion.
  const [displayScore, setDisplayScore] = useState(animate ? 0 : target);

  useEffect(() => {
    if (!animate) {
      setDisplayScore(target);
      return;
    }

    const prefersReducedMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (prefersReducedMotion) {
      setDisplayScore(target);
      return;
    }

    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / COUNT_UP_MS);
      const eased = 1 - (1 - t) * (1 - t); // ease-out quadratic
      setDisplayScore(Math.round(target * eased));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [animate, target]);

  const offset = CIRCUMFERENCE - (displayScore / 100) * CIRCUMFERENCE;
  const numberColor = scoreColor(displayScore);

  // Position of the cyan node at the tip of the progress arc. The arc starts at
  // 12 o'clock (rotated -90deg) and sweeps clockwise, so the angle for the
  // current value is measured from the top.
  const angle = (displayScore / 100) * 2 * Math.PI - Math.PI / 2;
  const nodeX = CENTER + RADIUS * Math.cos(angle);
  const nodeY = CENTER + RADIUS * Math.sin(angle);

  return (
    <svg
      width={SIZE}
      height={SIZE}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      role="img"
      aria-label={`GEO score: ${displayScore} out of 100`}
      style={{ display: "block", margin: "0 auto" }}
    >
      {/* Neutral track */}
      <circle
        cx={CENTER}
        cy={CENTER}
        r={RADIUS}
        fill="none"
        stroke={brand.neutral[200]}
        strokeWidth={STROKE}
      />
      {/* Indigo progress arc */}
      <circle
        cx={CENTER}
        cy={CENTER}
        r={RADIUS}
        fill="none"
        stroke={brand.indigo[600]}
        strokeWidth={STROKE}
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform={`rotate(-90 ${CENTER} ${CENTER})`}
        // While counting up, the rAF loop drives the arc frame by frame, so a
        // CSS transition would make the arc lag behind the cyan node. Only
        // ease on a static prop change.
        style={animate ? undefined : { transition: "stroke-dashoffset 0.6s ease" }}
      />
      {/* Cyan node at the current value's position */}
      <circle cx={nodeX} cy={nodeY} r={STROKE / 2 + 2} fill={brand.cyan[500]} />
      {/* Centered score number, colored by band */}
      <text
        x={CENTER}
        y={CENTER - 8}
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize="30"
        fontWeight="700"
        fill={numberColor}
      >
        {displayScore}
      </text>
      <text
        x={CENTER}
        y={CENTER + 15}
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize="12"
        fill={brand.neutral[500]}
      >
        / 100
      </text>
    </svg>
  );
}
