/** One coordinated colour system for every chart.
 *
 * - Use cases (categorical identity) map to the `--cat-*` design tokens, so a
 *   use case is the same colour on every screen.
 * - A single-series chart (e.g. ranked networks) uses one neutral series
 *   colour for every bar: colour follows the entity, never its rank, and the
 *   eight accent tokens are already reserved for use cases.
 * - Selection is the signal colour; everything unselected dims (CSS).
 *
 * Values are CSS colour expressions (custom properties), safe for SVG `fill`
 * and `stroke` and for inline `background`. */

const USE_CASE_TOKENS: Record<string, string> = {
  Launches: "var(--cat-launches)",
  Liquidity: "var(--cat-liquidity)",
  Fees: "var(--cat-fees)",
  MEV: "var(--cat-mev)",
  Orders: "var(--cat-orders)",
  Oracles: "var(--cat-oracles)",
  Access: "var(--cat-access)",
  Other: "var(--cat-other)",
};

/** Pools that are not linked to a loaded project. Deliberately a recessive
 * neutral, distinct from the "Other" use case. */
export const UNATTRIBUTED_COLOR = "var(--chart-unattributed)";

/** The neutral series colour for single-series charts. */
export const SERIES_COLOR = "var(--chart-series)";

/** Selected / focused emphasis. */
export const SELECTED_COLOR = "var(--signal)";

/** Use-case colour token; anything unknown (including "Unattributed") is the
 * unattributed neutral rather than a generated hue. */
export function useCaseColor(category: string | null | undefined): string {
  return (category && USE_CASE_TOKENS[category]) || UNATTRIBUTED_COLOR;
}

/** Evidence quality states, used by stacked evidence bars and legends. */
export const EVIDENCE_COLORS = {
  current: "var(--lagoon)",
  older: "var(--brass)",
  unverified: "var(--danger)",
  missing: "var(--chart-missing)",
} as const;
