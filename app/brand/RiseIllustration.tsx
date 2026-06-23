// GEO Rise empty-state illustration. The same rising-to-node language as the
// Mark (a faint chevron, a solid chevron, a cyan node), scaled into a small
// scene with a soft mist backdrop. Bespoke brand SVG, not a Polaris control.
// Decorative: the accompanying heading carries the meaning, so it is
// aria-hidden and never the sole signal of state.

import { brand } from "~/brand/tokens";

export function RiseIllustration({ size = 96 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 96 96"
      role="img"
      aria-hidden="true"
      focusable="false"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx={48} cy={48} r={44} fill={brand.mist} />
      <path
        d="M30 64 L48 50 L66 64"
        fill="none"
        stroke={brand.indigo[600]}
        strokeWidth={7}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.3}
      />
      <path
        d="M28 55 L48 39 L68 55"
        fill="none"
        stroke={brand.indigo[600]}
        strokeWidth={8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={48} cy={27} r={6.5} fill={brand.cyan[500]} />
    </svg>
  );
}
