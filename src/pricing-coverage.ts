import { evaluationNow } from "./edition.ts";
import type { Pool } from "../shared/types";
import {
  marketMeasurementState,
  marketObservationTime,
  observedMetricValue,
} from "../shared/market-freshness.ts";

export interface PricingAvailability {
  current: number;
  older: number;
  unverified: number;
  lastMeasuredAt: string | null;
}

export interface NetworkPricingAvailability {
  volume: PricingAvailability;
  reserves: PricingAvailability;
}

const emptyAvailability = (): PricingAvailability => ({
  current: 0,
  older: 0,
  unverified: 0,
  lastMeasuredAt: null,
});
const availabilityMetrics = [
  ["volume", "h24"],
  ["reserves", "liquidity"],
] as const;

/** Keep missing USD values distinct from expired or unverifiable observations. */
export function pricingAvailabilityByNetwork(
  pools: readonly Pool[],
  now = evaluationNow(),
): Map<string, NetworkPricingAvailability> {
  const networks = new Map<string, NetworkPricingAvailability>();
  for (const pool of pools) {
    const state = marketMeasurementState(pool, now);
    const measuredAt =
      state !== "unknown" ? marketObservationTime(pool, now) : null;
    for (const [key, metricKey] of availabilityMetrics) {
      if (observedMetricValue(pool, metricKey) === null) continue;
      let network = networks.get(pool.chain);
      if (!network) {
        network = {
          volume: emptyAvailability(),
          reserves: emptyAvailability(),
        };
        networks.set(pool.chain, network);
      }
      const metric = network[key];
      metric[
        state === "current"
          ? "current"
          : state === "stale"
            ? "older"
            : "unverified"
      ]++;
      if (
        measuredAt !== null &&
        (!metric.lastMeasuredAt ||
          measuredAt > Date.parse(metric.lastMeasuredAt))
      ) {
        metric.lastMeasuredAt = new Date(measuredAt).toISOString();
      }
    }
  }
  return networks;
}
