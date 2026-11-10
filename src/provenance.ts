import { evaluationNow } from "./edition.ts";
import type { Pool, RadarProject, WindowKey } from "../shared/types";
import {
  aggregateCurrentMarkets,
  marketObservationTime,
  marketMeasurementState,
  observedMetricValue,
} from "../shared/market-freshness.ts";

export type MeasuredMetric = WindowKey | "liquidity";
export interface MeasurementProvenance {
  poolCount: number;
  oldestAt: string | null;
  cachedPoolCount: number;
  unknownTimestampCount: number;
  unknownStatusCount: number;
  observedPoolCount: number;
  stalePoolCount: number;
  latestObservedAt: string | null;
}

/** Use the observation time of the amounts, never the registry snapshot time. */
export function measurementProvenance(
  pools: Pool[],
  metric: MeasuredMetric,
  now = evaluationNow(),
): MeasurementProvenance {
  const observed = pools.filter(
    (pool) => observedMetricValue(pool, metric) !== null,
  );
  const contributors = observed.filter(
    (pool) => marketMeasurementState(pool, now) === "current",
  );
  const aggregate = aggregateCurrentMarkets(observed, now);
  const row =
    metric === "liquidity"
      ? aggregate.freshness.liquidity
      : aggregate.freshness.volume[metric];
  return {
    poolCount: contributors.length,
    oldestAt: row.oldestAt,
    cachedPoolCount: contributors.filter(
      (pool) => pool.metricStatus === "cached",
    ).length,
    unknownTimestampCount: observed.filter(
      (pool) => marketObservationTime(pool, now) === null,
    ).length,
    unknownStatusCount: observed.filter(
      (pool) => !["live", "cached"].includes(pool.metricStatus || ""),
    ).length,
    observedPoolCount: observed.length,
    stalePoolCount: row.stalePools,
    latestObservedAt: row.latestObservedAt,
  };
}

/** Separate generic contract deployments can legitimately have identical names. */
export function duplicateFamilyNames(projects: RadarProject[]) {
  const names = new Set<string>();
  const duplicates = new Set<string>();
  for (const project of projects) {
    const key = project.name.trim().toLowerCase();
    if (names.has(key)) duplicates.add(key);
    else names.add(key);
  }
  return duplicates;
}
