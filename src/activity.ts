import { ACTIVITY_FEE_BANDS, type ActivityReport } from "../shared/activity.ts";
import { csvCell } from "./model.ts";

const integer = (value: unknown) =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const record = (v: unknown): v is Record<string, unknown> =>
  Boolean(v && typeof v === "object" && !Array.isArray(v));
const text = (v: unknown, max = 300): v is string =>
  typeof v === "string" && v.length <= max;
const nullableText = (v: unknown, max = 300) => v === null || text(v, max);
const stamp = (v: unknown) => integer(v) && Number(v) <= 4102444800;
const nullableStamp = (v: unknown) => v === null || stamp(v);
const hash = (v: unknown) =>
  typeof v === "string" && /^0x[0-9a-f]{64}$/i.test(v);
const address = (v: unknown) =>
  typeof v === "string" && /^0x[0-9a-f]{40}$/i.test(v);
const chain = (v: unknown) =>
  typeof v === "string" && /^[a-z0-9-]{1,50}$/.test(v);
const link = (v: unknown) => {
  if (!text(v, 2000)) return false;
  try {
    const url = new URL(v);
    return (
      ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
};
const totals = (value: unknown) =>
  record(value) &&
  [
    "swaps",
    "transactions",
    "activePools",
    "liquidityChanges",
    "liquidityAdds",
    "liquidityRemoves",
    "liquidityPokes",
  ].every((key) => integer(value[key]));
const lpDetails = (value: Record<string, unknown>) => {
  const values = [
    value.liquidityAdds,
    value.liquidityRemoves,
    value.liquidityPokes,
  ];
  return (
    values.every((v) => v === undefined || v === null) ||
    (values.every(integer) &&
      values.reduce<number>((sum, n) => sum + Number(n), 0) ===
        value.liquidityChanges)
  );
};

/** Reject malformed analytics before rendering; absence is never measured zero. */
export function isActivityReport(value: unknown): value is ActivityReport {
  if (!record(value)) return false;
  const r = value as unknown as ActivityReport;
  if (
    r.schemaVersion !== 1 ||
    !text(r.projectId, 100) ||
    !/^[a-z0-9-]+$/.test(r.projectId) ||
    !text(r.projectName) ||
    !["h1", "h24", "d7"].includes(r.window) ||
    !["complete", "partial", "unavailable"].includes(r.status) ||
    !text(r.generatedAt, 40) ||
    !Number.isFinite(Date.parse(r.generatedAt)) ||
    !stamp(r.windowStart) ||
    !stamp(r.windowEnd) ||
    r.windowEnd < r.windowStart ||
    (r.comparisonScopeKey !== undefined &&
      (typeof r.comparisonScopeKey !== "string" ||
        !/^[a-f0-9]{64}$/.test(r.comparisonScopeKey))) ||
    (r.requestedEnd !== undefined &&
      r.requestedEnd !== null &&
      (!stamp(r.requestedEnd) || r.requestedEnd < r.windowEnd)) ||
    typeof r.cached !== "boolean" ||
    typeof r.stale !== "boolean" ||
    typeof r.refreshing !== "boolean" ||
    (r.totals !== null && !totals(r.totals)) ||
    !totals(r.observed) ||
    (r.status !== "complete" && r.totals !== null) ||
    (r.status === "complete" && r.totals === null) ||
    !nullableText(r.warning, 4000)
  )
    return false;
  if (
    !record(r.scope) ||
    !(r.scope.totalPools === null || integer(r.scope.totalPools)) ||
    !integer(r.scope.listedPools) ||
    !integer(r.scope.chains) ||
    r.scope.chains > 30 ||
    typeof r.scope.inventoryComplete !== "boolean" ||
    !(r.scope.poolId === null || hash(r.scope.poolId)) ||
    !(r.scope.hookAddress === null || address(r.scope.hookAddress))
  )
    return false;
  if (
    !Array.isArray(r.networks) ||
    r.networks.length > 30 ||
    !r.networks.every(
      (n) =>
        record(n) &&
        chain(n.chain) &&
        integer(n.chainId) &&
        n.chainId > 0 &&
        text(n.name) &&
        ["complete", "partial", "unavailable"].includes(n.status) &&
        ["confirmed", "finalized"].includes(n.finality) &&
        link(n.sourceUrl) &&
        [n.fromBlock, n.toBlock, n.scannedToBlock, n.pools].every(
          (v) => v === null || integer(v),
        ) &&
        nullableStamp(n.throughTimestamp) &&
        nullableStamp(n.headTimestamp) &&
        (n.headHash === null || hash(n.headHash)) &&
        ["selected-pools", "manager-events"].includes(n.mode) &&
        totals(n.observed) &&
        nullableText(n.note, 4000),
    )
  )
    return false;
  if (
    !Array.isArray(r.buckets) ||
    r.buckets.length > 200 ||
    !r.buckets.every(
      (b) =>
        record(b) &&
        stamp(b.timestamp) &&
        integer(b.swaps) &&
        integer(b.liquidityChanges) &&
        lpDetails(b) &&
        typeof b.complete === "boolean",
    )
  )
    return false;
  if (
    !Array.isArray(r.pools) ||
    r.pools.length > 1000 ||
    !r.pools.every(
      (p) =>
        record(p) &&
        chain(p.chain) &&
        integer(p.chainId) &&
        hash(p.poolId) &&
        address(p.hookAddress) &&
        nullableText(p.name) &&
        integer(p.swaps) &&
        integer(p.transactions) &&
        integer(p.liquidityChanges) &&
        lpDetails(p) &&
        nullableStamp(p.lastSwapAt) &&
        [p.minFeePips, p.maxFeePips].every(
          (fee) => fee === null || (integer(fee) && fee <= 1000000),
        ),
    )
  )
    return false;
  if (r.feeRates !== undefined && r.feeRates !== null) {
    const fees = r.feeRates;
    if (
      !record(fees) ||
      !integer(fees.swaps) ||
      fees.swaps !== r.observed.swaps ||
      !Array.isArray(fees.bands) ||
      fees.bands.length !== ACTIVITY_FEE_BANDS.length ||
      !fees.bands.every(
        (band, i) =>
          record(band) &&
          integer(band.swaps) &&
          ["id", "label", "minimumPips", "maximumPips"].every(
            (key) =>
              band[key as keyof typeof band] ===
              ACTIVITY_FEE_BANDS[i][
                key as keyof (typeof ACTIVITY_FEE_BANDS)[number]
              ],
          ),
      ) ||
      fees.bands.reduce((sum, band) => sum + band.swaps, 0) !== fees.swaps
    )
      return false;
    if (fees.swaps === 0) {
      if (
        fees.minimumPips !== null ||
        fees.maximumPips !== null ||
        fees.averagePips !== null
      )
        return false;
    } else if (
      !integer(fees.minimumPips) ||
      !integer(fees.maximumPips) ||
      Number(fees.minimumPips) > Number(fees.maximumPips) ||
      Number(fees.maximumPips) > 1000000 ||
      typeof fees.averagePips !== "number" ||
      !Number.isFinite(fees.averagePips) ||
      fees.averagePips < Number(fees.minimumPips) ||
      fees.averagePips > Number(fees.maximumPips)
    )
      return false;
  }
  if (
    !Array.isArray(r.latestSwaps) ||
    r.latestSwaps.length > 200 ||
    !r.latestSwaps.every(
      (s) =>
        record(s) &&
        text(s.id, 250) &&
        chain(s.chain) &&
        integer(s.chainId) &&
        hash(s.poolId) &&
        nullableText(s.poolName) &&
        address(s.hookAddress) &&
        hash(s.transactionHash) &&
        link(s.transactionUrl) &&
        integer(s.blockNumber) &&
        hash(s.blockHash) &&
        stamp(s.timestamp) &&
        integer(s.logIndex) &&
        address(s.sender) &&
        text(s.amount0, 41) &&
        /^-?\d+$/.test(s.amount0) &&
        text(s.amount1, 41) &&
        /^-?\d+$/.test(s.amount1) &&
        (s.currency0 === null || address(s.currency0)) &&
        (s.currency1 === null || address(s.currency1)) &&
        integer(s.feePips) &&
        s.feePips <= 1000000 &&
        Number.isSafeInteger(s.tick),
    )
  )
    return false;
  return (
    record(r.methodology) &&
    link(r.methodology.eventSource) &&
    Array.isArray(r.methodology.notes) &&
    r.methodology.notes.length <= 30 &&
    r.methodology.notes.every((note) => text(note, 4000)) &&
    r.methodology.usdVolume === null &&
    r.methodology.earnedFees === null &&
    r.methodology.uniqueTraders === null
  );
}

export function activityNumber(exact: number | null, observed: number): string {
  if (exact !== null) return exact.toLocaleString("en-US");
  return observed > 0 ? `≥ ${observed.toLocaleString("en-US")}` : "—";
}

export function activityCount(
  observed: number | null | undefined,
  complete: boolean,
  singular: string,
  plural = `${singular}s`,
): string {
  const value =
    observed == null
      ? "—"
      : activityNumber(complete ? observed : null, observed);
  return `${value} ${observed === 1 ? singular : plural}`;
}

export function activityPeak(
  reports: Pick<ActivityReport, "status" | "buckets">[],
  metric: "swaps" | "liquidityChanges",
): { observed: number; display: string } {
  const observed = Math.max(
    0,
    ...reports.flatMap((report) =>
      report.buckets.map((bucket) => bucket[metric]),
    ),
  );
  const complete =
    reports.length > 0 &&
    reports.every(
      (report) =>
        report.status === "complete" &&
        report.buckets.length > 0 &&
        report.buckets.every((bucket) => bucket.complete),
    );
  return {
    observed,
    display: activityNumber(complete ? observed : null, observed),
  };
}

/** Width of one chart interval: five minutes for the hour window, else one hour. */
export function activityIntervalSeconds(window: ActivityReport["window"]): number {
  return window === "h1" ? 300 : 3600;
}

/**
 * How much of each interval the report has actually proved.
 *
 * - `verified`: the service proved the interval complete (`bucket.complete`);
 *   its count is exact, including an exact zero.
 * - `partial`: at least one network's verified scan reached into the
 *   interval, or matching events were already counted; counts are lower
 *   bounds and a zero establishes nothing.
 * - `unscanned`: no network has a verified scan position inside the interval
 *   and nothing was counted; no count exists, which is not zero activity.
 *
 * Only the report's own fields are used, so this never claims more coverage
 * than the indexer published.
 */
export type ActivityBucketCoverage = "verified" | "partial" | "unscanned";
export function activityBucketCoverage(
  report: Pick<ActivityReport, "networks" | "buckets">,
): ActivityBucketCoverage[] {
  const reached = report.networks.map((network) =>
    network.fromBlock === null || network.scannedToBlock === null
      ? null
      : network.throughTimestamp,
  );
  return report.buckets.map((bucket) => {
    if (bucket.complete) return "verified";
    if (bucket.swaps > 0 || bucket.liquidityChanges > 0) return "partial";
    return reached.some((time) => time !== null && time > bucket.timestamp)
      ? "partial"
      : "unscanned";
  });
}

/** Group the digits of a signed raw integer without rounding or rescaling it. */
export function activityRawAmount(value: string): string {
  if (!/^-?\d+$/.test(value)) return value;
  const negative = value.startsWith("-");
  const digits = negative ? value.slice(1) : value;
  return `${negative ? "-" : ""}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

export function eventFee(pips: number): string {
  return `${(pips / 10000).toLocaleString("en-US", { maximumFractionDigits: 4 })}%`;
}

export function activityDate(seconds: number | null): string {
  return !stamp(seconds)
    ? "Unavailable"
    : new Date(Number(seconds) * 1000).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

export function comparableActivityPeriods(
  current: ActivityReport,
  previous: ActivityReport,
): boolean {
  const duration = { h1: 3600, h24: 86400, d7: 604800 }[current.window];
  const sources = (report: ActivityReport) =>
    report.networks
      .map((n) => `${n.chain}:${n.chainId}:${n.finality}:${n.sourceUrl}`)
      .sort()
      .join();
  return (
    typeof current.comparisonScopeKey === "string" &&
    current.comparisonScopeKey === previous.comparisonScopeKey &&
    current.status === "complete" &&
    previous.status === "complete" &&
    current.projectId === previous.projectId &&
    current.window === previous.window &&
    current.windowStart === previous.windowEnd &&
    current.windowEnd - current.windowStart === duration &&
    previous.windowEnd - previous.windowStart === duration &&
    current.scope.poolId === previous.scope.poolId &&
    current.scope.hookAddress === previous.scope.hookAddress &&
    current.scope.inventoryComplete &&
    previous.scope.inventoryComplete &&
    sources(current) === sources(previous) &&
    current.buckets.length === previous.buckets.length &&
    current.buckets.every(
      (b, i) =>
        b.complete &&
        previous.buckets[i].complete &&
        b.timestamp - previous.buckets[i].timestamp === duration,
    )
  );
}

export function activityChange(
  current: number,
  previous: number,
): { delta: number; percent: number | null; label: string } {
  const delta = current - previous;
  if (delta === 0)
    return { delta, percent: previous ? 0 : null, label: "No change" };
  if (previous === 0)
    return {
      delta,
      percent: null,
      label: `+${current.toLocaleString("en-US")} · from zero`,
    };
  const percent = (delta / previous) * 100;
  return {
    delta,
    percent,
    label: `${delta > 0 ? "+" : ""}${delta.toLocaleString("en-US")} (${percent > 0 ? "+" : ""}${percent.toLocaleString("en-US", { maximumFractionDigits: 1 })}%)`,
  };
}

export function activityCsv(
  report: ActivityReport,
  kind: "intervals" | "pools",
): string {
  const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
  const width = report.window === "h1" ? 300 : 3600;
  const header =
    kind === "intervals"
      ? [
          "interval_start_utc",
          "interval_end_utc",
          "swaps",
          "lp_adds",
          "lp_removes",
          "lp_pokes",
          "lp_updates",
          "coverage",
        ]
      : [
          "project",
          "window_start_utc",
          "window_end_utc",
          "chain",
          "pool_id",
          "pool_name",
          "hook_address",
          "swaps",
          "transactions",
          "lp_updates",
          "min_event_fee_pips",
          "max_event_fee_pips",
          "coverage",
        ];
  // An interval no verified scan reached has no count: its cells stay blank
  // (not zero), and counts in a partial interval are lower bounds, as on screen.
  const coverage = activityBucketCoverage(report);
  const rows =
    kind === "intervals"
      ? report.buckets.map((b, index) => {
          const state = coverage[index];
          const counted = state !== "unscanned";
          return [
            iso(b.timestamp),
            iso(Math.min(b.timestamp + width, report.windowEnd)),
            counted ? b.swaps : null,
            counted ? b.liquidityAdds : null,
            counted ? b.liquidityRemoves : null,
            counted ? b.liquidityPokes : null,
            counted ? b.liquidityChanges : null,
            state === "verified"
              ? "complete"
              : state === "partial"
                ? "partial lower bounds"
                : "not scanned",
          ];
        })
      : report.pools.map((p) => [
          report.projectName,
          iso(report.windowStart),
          iso(report.windowEnd),
          p.chain,
          p.poolId,
          p.name,
          p.hookAddress,
          p.swaps,
          p.transactions,
          p.liquidityChanges,
          p.minFeePips,
          p.maxFeePips,
          report.status === "complete"
            ? "complete; top50 pools by swaps"
            : "partial lower bounds; top50 observed pools",
        ]);
  return (
    "\uFEFF" +
    [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") +
    "\r\n"
  );
}
