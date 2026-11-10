import type { RadarProject, WindowKey } from "../../shared/types";
import { isMarketFreshness } from "../../shared/market-freshness";
import { STATIC_EDITION } from "../edition";
import { count, inlineTime } from "../model";
import { tooltipTime } from "../MarketProvenance";

/** The tooltip under a directory row's measurement line. In the edition nothing
 * expires while a snapshot is read: the amount was counted as current when the
 * snapshot was taken, so no expiry time is stated. */
export function metricProofTitle(
  current: boolean,
  clock: string,
  expiresAt: string | null,
  edition: boolean = STATIC_EDITION,
): string {
  if (!current)
    return `Last observed at ${tooltipTime(clock, edition)}. The current amount is unavailable; an old measurement is not a zero.`;
  return edition
    ? `Oldest contributing measurement: ${tooltipTime(clock, edition)}. Counted as current at the snapshot time. Complete pool provenance opens with project details.`
    : `Oldest contributing measurement: ${tooltipTime(clock, edition)}. Amount expires at ${tooltipTime(expiresAt!, edition)}. Complete pool provenance opens with project details.`;
}

/** Directory rows carry original aggregate clocks but defer the complete pool
 * membership. Show that exact proof instead of inventing an empty pool list. */
export function ProjectMetricProof({
  project,
  metric,
  now,
}: {
  project: RadarProject;
  metric: WindowKey | "liquidity";
  now: number;
}) {
  const proof = project.metrics.freshness;
  if (!isMarketFreshness(proof)) return null;
  const row = metric === "liquidity" ? proof.liquidity : proof.volume[metric];
  const amount =
    metric === "liquidity"
      ? project.metrics.liquidityUsd
      : project.metrics.volumeUsd[metric];
  const current =
    amount !== null &&
    row.expiresAt !== null &&
    Date.parse(row.expiresAt) > now;
  const clock = current ? row.oldestAt : row.latestObservedAt;
  if (!clock) return null;
  return (
    <span
      className="metric-measurement compact"
      title={metricProofTitle(current, clock, row.expiresAt)}
    >
      <span>
        {current
          ? `${count(row.currentPools)} ${row.currentPools === 1 ? "pool" : "pools"} · `
          : "Last measured · "}
      </span>
      <time dateTime={clock}>{inlineTime(clock)}</time>
    </span>
  );
}
