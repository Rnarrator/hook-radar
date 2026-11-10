/** Shapes the two composition ribbons ("by network", "by use case") shown
 * under the Analytics readouts. Pure: it only re-orders and groups the values
 * the contributor bars already use, against the same stated total, so a ribbon
 * can never show a share a bar does not. A part that is not measured is left
 * out, never drawn as zero, and any part of the total that no row accounts for
 * is returned as an explicit unassigned remainder instead of being stretched
 * over the others. */
import { metricShare, metricValue } from "./analytics-focus.ts";
import type { AnalyticsMetric, MetricFields } from "./analytics-focus.ts";

export interface CompositionInput {
  totals: MetricFields;
  networks: readonly (MetricFields & { chain: string; name: string })[];
  categories: Record<
    AnalyticsMetric,
    | readonly { category: string; value: number | null }[]
    | null
  >;
}

export interface RibbonPart {
  id: string;
  label: string;
  value: number;
  /** Fraction of the stated total (0 to 1). */
  share: number;
  /** The grouped tail ("N other networks") or the unassigned remainder:
   * shown, but not a selectable entity. */
  tail: boolean;
  /** True for the part no row accounts for. */
  remainder: boolean;
}

export interface Composition {
  total: number;
  networks: RibbonPart[];
  categories: RibbonPart[];
}

/** Largest parts shown on the network ribbon before the rest are grouped. */
export const NETWORK_RIBBON_PARTS = 5;
/** A remainder smaller than this fraction of the total is rounding noise. */
const REMAINDER_FLOOR = 0.005;

function finish(
  parts: { id: string; label: string; value: number }[],
  total: number,
  tailLabel: (count: number) => string,
  limit: number,
): RibbonPart[] {
  const sorted = parts
    .filter((part) => Number.isFinite(part.value) && part.value > 0)
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  if (sorted.length < 2) return [];
  const head = sorted.slice(0, limit);
  const rest = sorted.slice(limit);
  const out: RibbonPart[] = head.map((part) => ({
    ...part,
    share: Math.min(1, part.value / total),
    tail: false,
    remainder: false,
  }));
  if (rest.length) {
    const value = rest.reduce((sum, part) => sum + part.value, 0);
    out.push({
      id: "ribbon-tail",
      label: tailLabel(rest.length),
      value,
      share: Math.min(1, value / total),
      tail: true,
      remainder: false,
    });
  }
  const accounted = out.reduce((sum, part) => sum + part.value, 0);
  const remainder = total - accounted;
  if (remainder / total > REMAINDER_FLOOR)
    out.push({
      id: "ribbon-remainder",
      label: "Not assigned",
      value: remainder,
      share: remainder / total,
      tail: true,
      remainder: true,
    });
  return out;
}

/** The ribbons for a metric, or null when there is no positive stated total. */
export function compositionParts(
  input: CompositionInput,
  metric: AnalyticsMetric,
): Composition | null {
  const total = metricValue(input.totals, metric);
  if (metricShare(total, total) === null || total === null) return null;
  const networks = finish(
    input.networks.flatMap((network) => {
      const value = metricValue(network, metric);
      return value === null
        ? []
        : [{ id: network.chain, label: network.name, value }];
    }),
    total,
    (count) => `${count} other ${count === 1 ? "network" : "networks"}`,
    NETWORK_RIBBON_PARTS,
  );
  const categories = finish(
    (input.categories[metric] ?? []).flatMap((slice) =>
      slice.value === null
        ? []
        : [{ id: slice.category, label: slice.category, value: slice.value }],
    ),
    total,
    (count) => `${count} other`,
    Number.POSITIVE_INFINITY,
  );
  if (!networks.length && !categories.length) return null;
  return { total, networks, categories };
}
