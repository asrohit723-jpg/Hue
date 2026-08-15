/**
 * The Vigil mark: one disc, three bands of the palette.
 *
 * Chosen over the alternatives for one reason — it has to read at 28px in the
 * header AND as the only mark on a 64px collapsed rail. Concentric arcs muddy
 * at that size and stacked bars read as a chart rather than an identity. A
 * split disc keeps its shape at any size and is unmistakably about colour,
 * which is what the name is.
 *
 * Colours are the app's own tokens, hard-coded here because an SVG cannot read
 * a CSS variable through a `fill` on some renderers and a logo that loses its
 * colour is worse than one that repeats three hex values.
 *   --brand-indigo #3C229D · --blue-500 #0059D6 · --success-500 #29A01E
 */
export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label="Vigil"
      style={{ display: 'block', flex: `0 0 ${size}px` }}
    >
      {/* The disc clips the bands, so the edge stays a true circle at any size
          rather than three rectangles approximating one. */}
      <defs>
        <clipPath id="hue-disc">
          <circle cx="16" cy="16" r="14" />
        </clipPath>
      </defs>
      <g clipPath="url(#hue-disc)">
        <rect x="2" y="2" width="9.33" height="28" fill="#3C229D" />
        <rect x="11.33" y="2" width="9.33" height="28" fill="#0059D6" />
        <rect x="20.66" y="2" width="11.34" height="28" fill="#29A01E" />
      </g>
    </svg>
  );
}
