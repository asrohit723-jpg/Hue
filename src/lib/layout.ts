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
 * The outer container style for a screen. `padding` stays per-screen because
 * the design specifies it per screen (24px 28px, 28px 32px, 22px 32px …).
 */
export function page(padding: string): React.CSSProperties {
  return { padding, maxWidth: PAGE_MAX, marginLeft: 'auto', marginRight: 'auto' };
}
