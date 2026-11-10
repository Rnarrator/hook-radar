import type { AnalyticsPool } from "./analytics.ts";
import { numericAxis, thinTicks } from "./charts/scales.ts";
import type { NumericAxis } from "./charts/scales.ts";

export type PoolSort = "volume" | "reserves" | "name";
export type PoolScale = "log" | "linear";
export const POOL_SCATTER_LIMIT = 80;
export const POOL_PAGE_SIZE = 10;

export function analyticsPoolKey(row: AnalyticsPool): string {
  return `${row.pool.chain}:${row.pool.address.toLowerCase()}`;
}

/** Use only the analytics model's freshness-checked values. Raw pool values
 * can be stale or unverified and must never enter these charts or rankings. */
export function poolMeasurement(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 ? value : null;
}

function compareNumber(a: number | null, b: number | null, ascending: boolean) {
  const left = poolMeasurement(a);
  const right = poolMeasurement(b);
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return (left < right ? -1 : 1) * (ascending ? 1 : -1);
}

export function sortAnalyticsPools(
  rows: readonly AnalyticsPool[],
  sort: PoolSort = "volume",
  ascending = false,
  query = "",
  names: ReadonlyMap<string, string> = new Map(),
): AnalyticsPool[] {
  const normalized = query.trim().toLocaleLowerCase();
  return rows
    .filter(
      (row) =>
        !normalized ||
        [
          row.pool.name,
          row.pool.address,
          row.pool.hookAddress || "",
          row.pool.chain,
          names.get(row.pool.chain) || "",
          row.project?.name || "",
          ...row.pool.tokens,
        ].some((value) => value.toLocaleLowerCase().includes(normalized)),
    )
    .slice()
    .sort((a, b) => {
      const primary =
        sort === "name"
          ? a.pool.name.localeCompare(b.pool.name) * (ascending ? 1 : -1)
          : compareNumber(
              sort === "volume" ? a.volumeUsd : a.liquidityUsd,
              sort === "volume" ? b.volumeUsd : b.liquidityUsd,
              ascending,
            );
      return primary || analyticsPoolKey(a).localeCompare(analyticsPoolKey(b));
    });
}

export function poolScatterCohort(rows: readonly AnalyticsPool[]) {
  let unavailable = 0;
  let zero = 0;
  const eligible = rows.filter((row) => {
    const volume = poolMeasurement(row.volumeUsd);
    const reserves = poolMeasurement(row.liquidityUsd);
    if (volume === null || reserves === null) {
      unavailable++;
      return false;
    }
    if (volume === 0 || reserves === 0) {
      zero++;
      return false;
    }
    return true;
  });
  return {
    rows: sortAnalyticsPools(eligible).slice(0, POOL_SCATTER_LIMIT),
    eligible: eligible.length,
    unavailable,
    zero,
  };
}

/** Pool scatter axes use the chart kit's data-fitted axis: tick labels are
 * real decimal values positioned with the exact transform of the points, so
 * rounding a label never moves an observation. */
export function poolChartAxis(
  values: readonly number[],
  scale: PoolScale,
): NumericAxis | null {
  return numericAxis(values, scale);
}

/** Keep endpoint labels and suppress only labels that would collide. The plot
 * domain, tick positions and underlying observations remain unchanged. */
export function poolChartLabelTicks(
  ticks: readonly { value: number; fraction: number }[],
  pixelSpan: number,
  minimumGap = 70,
) {
  return thinTicks(ticks, pixelSpan, minimumGap);
}
