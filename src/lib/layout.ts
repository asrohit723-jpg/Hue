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
export const PAGE_MAX = 1240;

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
export const HEADER_H = 56;

/**
 * The outer container style for a screen. `padding` stays per-screen because
 * the design specifies it per screen (24px 28px, 28px 32px, 22px 32px …).
 */
/**
 * ONE page padding, everywhere.
 *
 * The argument is kept so no call site had to change, but it is no longer read:
 * eight screens passed five different values ('22px 32px 40px', '24px 28px',
 * '28px 32px 40px' and two more), so the same page furniture sat at a different
 * inset depending on which screen you were on. There is nothing to choose
 * between them — they are all the design's, from different moments.
 *
 * The bottom is deliberately deep: the last row of a long table needs somewhere
 * to end that is not the window edge.
 */
export function page(_padding?: string): React.CSSProperties {
  return {
    padding: '32px 32px 96px',
    maxWidth: PAGE_MAX,
    marginLeft: 'auto',
    marginRight: 'auto',
  };
}
