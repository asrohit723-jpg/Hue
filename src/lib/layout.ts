/**
 * Shared page container.
 *
 * Every screen was authored against the design's 1440px preview, and each
 * carried its own max-width from that file (1040 to 1360). On a wider display
 * those caps left the content pinned to the left with a dead strip down the
 * right — the same gap on every screen, because they all inherited the same
 * assumption.
 *
 * One cap now, applied everywhere, and the column is centred so the space that
 * remains on a very wide monitor falls evenly on both sides instead of all on
 * one. The cap is kept rather than removed: a table stretched across 2500px is
 * no more readable than one squeezed into 900, and the design's internal
 * measurements — padding, gaps, component widths, the 76ch prose column — are
 * untouched by this. Only the outer container changes.
 */
export const PAGE_MAX = 1600;

/**
 * Header height, shared by the sidebar's brand block and the main top bar.
 *
 * The design gives these two different heights — 64px for the sidebar header,
 * 60px for the top bar — so their bottom borders sat 4px apart and never formed
 * one line across the window. One constant now, so they cannot drift again.
 *
 * 64 is the taller of the two and the one the brand lockup needs: two lines at
 * 17px and 14px leave only 2px of breathing room inside 60.
 */
export const HEADER_H = 64;

/**
 * The outer container style for a screen. `padding` stays per-screen because
 * the design specifies it per screen (24px 28px, 28px 32px, 22px 32px …).
 */
export function page(padding: string): React.CSSProperties {
  return { padding, maxWidth: PAGE_MAX, marginLeft: 'auto', marginRight: 'auto' };
}
