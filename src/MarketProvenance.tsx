import type { Pool, RadarProject, WindowKey } from "../shared/types";
import { count, inlineTime, shortAddress, windows } from "./model";
import { STATIC_EDITION, fullTimeLabel } from "./edition";
import { measurementProvenance } from "./provenance";
import type { MeasuredMetric, MeasurementProvenance } from "./provenance";

/** A measurement time inside a tooltip. The edition states every time in UTC and
 * says so ("28 Oct 2026, 00:10 UTC"), as the visible labels beside it do; the
 * live page keeps the visitor's own locale. */
export function tooltipTime(
  value: string,
  edition: boolean = STATIC_EDITION,
): string {
  if (!edition) return new Date(value).toLocaleString();
  return fullTimeLabel(value) ?? value;
}

/** The tooltip that explains a measurement line: its oldest contributing time
 * and what counts as current. */
export function measurementTitle(
  provenance: MeasurementProvenance,
  metric: MeasuredMetric,
  edition: boolean = STATIC_EDITION,
): string {
  const {
    oldestAt,
    cachedPoolCount,
    unknownTimestampCount,
    unknownStatusCount,
    stalePoolCount,
  } = provenance;
  const exact = oldestAt ? tooltipTime(oldestAt, edition) : null;
  // The edition writes its counts as the visible labels do ("1,592"); the live
  // tooltip keeps the plain number.
  const num = (value: number) => (edition ? count(value) : String(value));
  return [
    exact
      ? `Oldest current pool measurement: ${exact}.`
      : "No current measurements are available.",
    // STATIC_EDITION: the five-minute rule was applied when the snapshot was
    // collected, not at the visitor's clock.
    `${num(provenance.poolCount)} current ${provenance.poolCount === 1 ? "pool" : "pools"}. Only observations younger than five minutes${edition ? " when the snapshot was taken" : ""} contribute to current totals; source clocks allow one minute of skew. Rolling windows retain their original observation endpoints.`,
    stalePoolCount
      ? `${num(stalePoolCount)} older ${stalePoolCount === 1 ? "observation is" : "observations are"} excluded from current totals and rankings.`
      : "",
    cachedPoolCount
      ? `${num(cachedPoolCount)} cached; these amounts retain their original measurement time.`
      : "",
    unknownTimestampCount && oldestAt
      ? `${num(unknownTimestampCount)} measurement ${unknownTimestampCount === 1 ? "timestamp" : "timestamps"} unavailable; freshness is incomplete.`
      : "",
    unknownStatusCount
      ? `${num(unknownStatusCount)} ${unknownStatusCount === 1 ? "pool has" : "pools have"} unknown freshness status.`
      : "",
    metric === "liquidity"
      ? "Provider reserve valuations can include one-sided token inventory priced at the last trade. They do not measure executable depth or protocol TVL."
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function MetricMeasurement({
  pools,
  metric,
  compact = false,
  awaitingTotal = false,
}: {
  pools: Pool[];
  metric: MeasuredMetric;
  compact?: boolean;
  /** The figure above is absent (its total expired) while these pools still hold
   * current measurements: say it is being recalculated rather than repeat a
   * pool count that sits oddly under a dash. */
  awaitingTotal?: boolean;
}) {
  const provenance = measurementProvenance(pools, metric);
  if (!provenance.observedPoolCount) return null;
  const {
    oldestAt,
    cachedPoolCount,
    unknownTimestampCount,
    unknownStatusCount,
    stalePoolCount,
    latestObservedAt,
  } = provenance;
  return (
    <span
      className={`metric-measurement ${compact ? "compact" : ""} ${cachedPoolCount ? "has-cached" : ""}`}
      title={measurementTitle(provenance, metric)}
    >
      {oldestAt && awaitingTotal ? (
        <>
          <span>
            {compact ? "Refreshing · " : "Refreshing total · measured "}
          </span>
          <time dateTime={oldestAt}>{inlineTime(oldestAt)}</time>
        </>
      ) : oldestAt ? (
        <>
          <span>
            {compact
              ? `${count(provenance.poolCount)} ${provenance.poolCount === 1 ? "pool" : "pools"} · `
              : `${count(provenance.poolCount)} current ${provenance.poolCount === 1 ? "pool" : "pools"} · updated `}
          </span>
          <time dateTime={oldestAt}>{inlineTime(oldestAt)}</time>
        </>
      ) : (
        <>
          <span>
            {stalePoolCount ? "Measurements expired" : "Freshness unavailable"}
            {latestObservedAt ? " · last measured " : ""}
          </span>
          {latestObservedAt && (
            <time dateTime={latestObservedAt}>
              {inlineTime(latestObservedAt)}
            </time>
          )}
        </>
      )}
      {cachedPoolCount > 0 && (
        <span className="measurement-state">
          {compact
            ? cachedPoolCount === provenance.poolCount
              ? "cached"
              : `${count(cachedPoolCount)} cached`
            : `${count(cachedPoolCount)} cached`}
        </span>
      )}
      {stalePoolCount > 0 && (
        <span className="measurement-state">
          {count(stalePoolCount)} older excluded
        </span>
      )}
      {(unknownTimestampCount > 0 || unknownStatusCount > 0) && (
        <span className="measurement-state">unknown freshness excluded</span>
      )}
    </span>
  );
}

export function MarketProvenanceStrip({
  pools,
  windowKey,
}: {
  pools: Pool[];
  windowKey: WindowKey;
}) {
  const volume = measurementProvenance(pools, windowKey);
  const liquidity = measurementProvenance(pools, "liquidity");
  if (!volume.observedPoolCount && !liquidity.observedPoolCount) return null;
  const sameMeasurements =
    volume.observedPoolCount > 0 &&
    JSON.stringify(volume) === JSON.stringify(liquidity);
  return (
    <div
      className="market-provenance"
      aria-label="Market measurement freshness"
    >
      <span className="provenance-caption">MARKET DATA</span>
      {sameMeasurements ? (
        <span className="provenance-metric">
          <strong>{windows[windowKey]} volume + reserves</strong>
          <MetricMeasurement pools={pools} metric={windowKey} />
        </span>
      ) : (
        <>
          {volume.observedPoolCount > 0 && (
            <span className="provenance-metric">
              <strong>{windows[windowKey]} volume</strong>
              <MetricMeasurement pools={pools} metric={windowKey} />
            </span>
          )}
          {liquidity.observedPoolCount > 0 && (
            <span className="provenance-metric">
              <strong>Reserves</strong>
              <MetricMeasurement pools={pools} metric="liquidity" />
            </span>
          )}
        </>
      )}
    </div>
  );
}

export function FamilyFingerprint({ project }: { project: RadarProject }) {
  const deployment = project.deployments[0];
  if (!deployment) return null;
  return (
    <span
      className="family-fingerprint"
      title={`Separate directory family: ${deployment.address} on ${deployment.chain}`}
    >
      <code>{shortAddress(deployment.address)}</code>
      <span> / {deployment.chain}</span>
    </span>
  );
}
