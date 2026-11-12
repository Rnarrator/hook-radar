import { evaluationNow } from "./edition.ts";
import type {
  MarketFreshness,
  Point,
  Pool,
  PoolIndexNetwork,
  RadarProject,
  RadarSnapshot,
  WindowKey,
} from "../shared/types";
import {
  aggregateCurrentMarkets,
  marketMeasurementState,
  marketObservationTime,
  observedMetricValue,
} from "../shared/market-freshness.ts";
import { networkCaughtUp, networkHeadFresh } from "../shared/indexing.ts";
import { csvCell } from "./model.ts";

export type AnalyticsHistoryRange = "d1" | "d7" | "d30" | "all";

/** An exact USD figure in cents. An amount from a cent up is rounded to two
 * decimals, which drops the float residue of a sum of cent amounts
 * (339226102.0600004); a positive amount below a cent, a measured zero and a
 * value that is not a number are returned as they are. */
export function roundExactUsd(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) < 0.01) return value;
  return Number(value.toFixed(2));
}

/** The messages with which the collector (server/pool-census.mjs) records that
 * the head check itself failed. The status "error" is also set for a scan
 * request that failed, a deadline, a rate limit and a checkpoint that could not
 * be saved, none of which says anything about the head. */
const HEAD_CHECK_ERRORS = [
  "Census source head is behind the canonical deployment or saved checkpoint",
  "Census source returned an invalid finalized head",
  "Census head contradicts the saved checkpoint hash",
];

/** The census says it was the head check that failed, by the error it recorded. */
export function inventoryHeadCheckFailed(
  inventory: Pick<PoolIndexNetwork, "status" | "lastError"> | null | undefined,
): boolean {
  if (inventory?.status !== "error" || typeof inventory.lastError !== "string")
    return false;
  const message = inventory.lastError.trim();
  return HEAD_CHECK_ERRORS.some((known) => message.startsWith(known));
}

export interface AnalyticsTotals {
  /** Current measurements from this observed sample, never ecosystem totals. */
  volumeUsd: number | null;
  liquidityUsd: number | null;
  samplePools: number;
  volumePools: number;
  liquidityPools: number;
  activePools: number;
  attributedProjects: number;
  unattributedPools: number;
  unattributedVolumeUsd: number | null;
  unlistedProjects: number;
  /** Share of this current tracked volume held by the largest pool and by the
   * three largest, from the same current measurements. Present only when at
   * least ten pools contribute volume; otherwise a share says little. */
  concentration: { topPoolShare: number; topThreePoolShare: number } | null;
  freshness: MarketFreshness;
}

export interface AnalyticsNetwork extends AnalyticsTotals {
  chain: string;
  name: string;
  /** Fraction of current observed volume, not ecosystem market share. */
  volumeShare: number | null;
  inventory: PoolIndexNetwork | null;
  caughtUp: boolean;
  headFresh: boolean;
}

export interface AnalyticsProject extends AnalyticsTotals {
  project: RadarProject;
  volumeShare: number | null;
}

export interface AnalyticsPool {
  pool: Pool;
  project: RadarProject | null;
  volumeUsd: number | null;
  liquidityUsd: number | null;
  volumeShare: number | null;
}

export interface AnalyticsResult {
  chain: string;
  windowKey: WindowKey;
  asOf: string;
  snapshotAt: string;
  totals: AnalyticsTotals;
  networks: AnalyticsNetwork[];
  projects: AnalyticsProject[];
  pools: AnalyticsPool[];
  /** Deduplicated raw scoped evidence, including excluded old observations. */
  observedPools: Pool[];
  inventory: {
    networks: PoolIndexNetwork[];
    hookPoolCount: number | null;
    /** Network-specific hook contracts; not unique project families. */
    hookCount: number | null;
    caughtUpChains: number;
    freshChains: number;
  };
  /** Saved rolling 24h observations; not daily volume or a fixed cohort. */
  history: Point[];
  historyAvailable: boolean;
}

const share = (value: number | null, total: number | null) =>
  value !== null && total !== null && total > 0 ? value / total : null;
const descending = (a: number | null, b: number | null) =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : b - a;

/** Legacy saved points can use epoch seconds. Keep their original values while
 * using milliseconds for validation, dates and chart positions. */
export function analyticsPointTime(point: Point): number {
  return point.timestamp < 1e12 ? point.timestamp * 1000 : point.timestamp;
}

/** Keep every observation selectable, including identical clocks and amounts.
 * Distinct observations keep their identity when older rows leave the window;
 * indistinguishable repeats use their occurrence in the retained source order. */
export function analyticsHistoryKeys(points: readonly Point[]): string[] {
  const occurrences = new Map<string, number>();
  return points.map((point) => {
    const identity = `${analyticsPointTime(point)}:${point.value}`;
    const occurrence = occurrences.get(identity) || 0;
    occurrences.set(identity, occurrence + 1);
    return `${identity}:${occurrence}`;
  });
}

/** Filter real saved observations only. No interpolation, synthetic zeroes,
 * bucket sums or conversions of rolling observations into daily volume. */
export function analyticsHistory(
  points: readonly Point[],
  range: AnalyticsHistoryRange = "all",
  now = evaluationNow(),
): Point[] {
  if (!Number.isFinite(now)) return [];
  const duration = { d1: 86400000, d7: 7 * 86400000, d30: 30 * 86400000 };
  const start = range === "all" ? -Infinity : now - duration[range];
  return points
    .filter((point) => {
      if (
        !point ||
        !Number.isFinite(point.timestamp) ||
        !Number.isSafeInteger(point.timestamp) ||
        point.timestamp < 0 ||
        !Number.isFinite(point.value) ||
        point.value < 0
      )
        return false;
      const time = analyticsPointTime(point);
      return Number.isFinite(time) && time >= start && time <= now;
    })
    .slice()
    .sort((a, b) => analyticsPointTime(a) - analyticsPointTime(b));
}

function totalsFor(
  pools: readonly Pool[],
  projects: ReadonlyMap<string, RadarProject>,
  windowKey: WindowKey,
  now: number,
  current: ReadonlyMap<
    Pool,
    { volumeUsd: number | null; liquidityUsd: number | null }
  >,
): AnalyticsTotals {
  const aggregate = aggregateCurrentMarkets(pools, now);
  const attributed = new Set<string>();
  const unlisted = new Set<string>();
  let activePools = 0;
  let unattributedPools = 0;
  let unattributedVolume = 0;
  let unattributedVolumePools = 0;
  const volumes: number[] = [];
  for (const pool of pools) {
    const { volumeUsd: volume, liquidityUsd: liquidity } = current.get(pool)!;
    if (volume !== null && volume > 0) {
      activePools++;
      volumes.push(volume);
    }
    if (volume === null && liquidity === null) continue;
    if (pool.projectId && projects.has(pool.projectId)) {
      attributed.add(pool.projectId);
    } else {
      unattributedPools++;
      if (pool.projectId) unlisted.add(pool.projectId);
      if (volume !== null) {
        unattributedVolumePools++;
        unattributedVolume += volume;
      }
    }
  }
  return {
    volumeUsd: aggregate.volumeUsd[windowKey],
    liquidityUsd: aggregate.liquidityUsd,
    samplePools: pools.length,
    volumePools: aggregate.freshness.volume[windowKey].currentPools,
    liquidityPools: aggregate.freshness.liquidity.currentPools,
    activePools,
    attributedProjects: attributed.size,
    unattributedPools,
    unattributedVolumeUsd:
      unattributedVolumePools > 0 && Number.isFinite(unattributedVolume)
        ? unattributedVolume
        : null,
    unlistedProjects: unlisted.size,
    concentration: volumeConcentration(volumes, aggregate.volumeUsd[windowKey]),
    freshness: aggregate.freshness,
  };
}

/** How much of the tracked volume a few pools hold. Shown only when ten or
 * more pools contribute, so a thin network is not described as "concentrated". */
export function volumeConcentration(
  volumes: readonly number[],
  total: number | null,
): AnalyticsTotals["concentration"] {
  if (volumes.length < 10) return null;
  const sum = volumes.reduce((all, value) => all + value, 0);
  const whole = total !== null && Number.isFinite(total) && total > 0 ? total : sum;
  if (!Number.isFinite(whole) || whole <= 0) return null;
  const top = [...volumes].sort((a, b) => b - a);
  const share = (value: number) => Math.min(1, Math.max(0, value / whole));
  return {
    topPoolShare: share(top[0]),
    topThreePoolShare: share(top[0] + top[1] + top[2]),
  };
}

/** A duplicate canonical pool must never enter current totals twice. Prefer a
 * later valid observation; metadata-only timestamps cannot renew prices. */
function uniquePools(pools: readonly Pool[], now: number) {
  const unique = new Map<string, Pool>();
  for (const pool of pools) {
    const id = `${pool.chain}:${pool.address.toLowerCase()}`;
    const previous = unique.get(id);
    const time = previous ? (marketObservationTime(pool, now) ?? -Infinity) : 0;
    const previousTime = previous
      ? (marketObservationTime(previous, now) ?? -Infinity)
      : 0;
    const known = (row: Pool) =>
      row.metricStatus === "live" || row.metricStatus === "cached";
    if (
      !previous ||
      time > previousTime ||
      (time === previousTime && known(pool) && !known(previous))
    )
      unique.set(id, pool);
  }
  return [...unique.values()];
}

/** Build from exact pool observations, not the paginated project's aggregate
 * values. Canonical inventory remains separate from market measurements. */
function buildAnalyticsReport(
  snapshot: RadarSnapshot,
  {
    chain = "all",
    windowKey = "h24",
    now = evaluationNow(),
  }: { chain?: string; windowKey?: WindowKey; now?: number } = {},
  includeDetails = true,
): AnalyticsResult {
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime()))
    throw new RangeError("Choose a valid analytics time.");
  if (!["h1", "h6", "h24"].includes(windowKey))
    throw new RangeError("Choose a valid analytics window.");
  const pools = uniquePools(
    snapshot.pools.filter((pool) => chain === "all" || pool.chain === chain),
    now,
  );
  const byProject = new Map(
    snapshot.projects.map((project) => [project.id, project]),
  );
  const current = new Map<
    Pool,
    { volumeUsd: number | null; liquidityUsd: number | null }
  >();
  const currentProjects = new Set<string>();
  for (const pool of pools) {
    const eligible = marketMeasurementState(pool, now) === "current";
    const volumeUsd = eligible ? observedMetricValue(pool, windowKey) : null;
    const liquidityUsd = eligible
      ? observedMetricValue(pool, "liquidity")
      : null;
    current.set(pool, { volumeUsd, liquidityUsd });
    if (
      includeDetails &&
      (volumeUsd !== null || liquidityUsd !== null) &&
      pool.projectId &&
      byProject.has(pool.projectId)
    )
      currentProjects.add(pool.projectId);
  }
  const totals = totalsFor(pools, byProject, windowKey, now, current);
  const networkPools = new Map<string, Pool[]>();
  const projectPools = new Map<string, Pool[]>();
  const poolRows: AnalyticsPool[] = [];
  for (const pool of pools) {
    if (!networkPools.has(pool.chain)) networkPools.set(pool.chain, []);
    networkPools.get(pool.chain)!.push(pool);
    if (!includeDetails) continue;
    const project = (pool.projectId && byProject.get(pool.projectId)) || null;
    if (project && currentProjects.has(project.id)) {
      if (!projectPools.has(project.id)) projectPools.set(project.id, []);
      projectPools.get(project.id)!.push(pool);
    }
    const { volumeUsd, liquidityUsd } = current.get(pool)!;
    if (volumeUsd === null && liquidityUsd === null) continue;
    poolRows.push({
      pool,
      project,
      volumeUsd,
      liquidityUsd,
      volumeShare: share(volumeUsd, totals.volumeUsd),
    });
  }
  const inventoryNetworks = (snapshot.inventory?.networks || []).filter(
    (network) => chain === "all" || network.chain === chain,
  );
  const inventoryByChain = new Map(
    inventoryNetworks.map((network) => [network.chain, network]),
  );
  const names = new Map(
    snapshot.chains.map((network) => [network.slug, network.name]),
  );
  for (const network of inventoryNetworks)
    names.set(network.chain, network.name);
  const networkIds = new Set([
    ...snapshot.chains
      .filter((network) => chain === "all" || network.slug === chain)
      .map((network) => network.slug),
    ...networkPools.keys(),
    ...inventoryByChain.keys(),
  ]);
  const networks = [...networkIds]
    .map((slug) => {
      const metrics = totalsFor(
        networkPools.get(slug) || [],
        byProject,
        windowKey,
        now,
        current,
      );
      const inventory = inventoryByChain.get(slug) || null;
      return {
        ...metrics,
        chain: slug,
        name: names.get(slug) || slug,
        volumeShare: share(metrics.volumeUsd, totals.volumeUsd),
        inventory,
        caughtUp: inventory ? networkCaughtUp(inventory) : false,
        headFresh: inventory ? networkHeadFresh(inventory, now) : false,
      };
    })
    .sort(
      (a, b) =>
        descending(a.volumeUsd, b.volumeUsd) ||
        descending(a.liquidityUsd, b.liquidityUsd) ||
        a.name.localeCompare(b.name),
    );
  const projects = [...projectPools]
    .map(([id, rows]) => {
      const metrics = totalsFor(rows, byProject, windowKey, now, current);
      return {
        ...metrics,
        project: byProject.get(id)!,
        volumeShare: share(metrics.volumeUsd, totals.volumeUsd),
      };
    })
    .filter((project) => project.volumePools > 0 || project.liquidityPools > 0)
    .sort(
      (a, b) =>
        descending(a.volumeUsd, b.volumeUsd) ||
        descending(a.liquidityUsd, b.liquidityUsd) ||
        a.project.name.localeCompare(b.project.name) ||
        a.project.id.localeCompare(b.project.id),
    );
  poolRows.sort(
    (a, b) =>
      descending(a.volumeUsd, b.volumeUsd) ||
      descending(a.liquidityUsd, b.liquidityUsd) ||
      a.pool.id.localeCompare(b.pool.id),
  );
  return {
    chain,
    windowKey,
    asOf: new Date(now).toISOString(),
    snapshotAt: snapshot.generatedAt,
    totals,
    networks,
    projects,
    pools: poolRows,
    observedPools: pools,
    inventory: {
      networks: inventoryNetworks,
      hookPoolCount: inventoryNetworks.length
        ? inventoryNetworks.reduce(
            (sum, network) => sum + network.hookPoolCount,
            0,
          )
        : null,
      hookCount: inventoryNetworks.length
        ? inventoryNetworks.reduce((sum, network) => sum + network.hookCount, 0)
        : null,
      caughtUpChains: inventoryNetworks.filter(networkCaughtUp).length,
      freshChains: inventoryNetworks.filter((network) =>
        networkHeadFresh(network, now),
      ).length,
    },
    history:
      includeDetails && chain === "all"
        ? analyticsHistory(snapshot.history, "all", now)
        : [],
    historyAvailable: chain === "all",
  };
}

export function buildAnalytics(
  snapshot: RadarSnapshot,
  options: { chain?: string; windowKey?: WindowKey; now?: number } = {},
): AnalyticsResult {
  return buildAnalyticsReport(snapshot, options);
}

export type AnalyticsSummary = Pick<
  AnalyticsResult,
  "asOf" | "totals" | "networks" | "observedPools"
>;

/** Chain discovery needs exact network totals and raw pool evidence, but never
 * the all-project/pool leaderboards or historical chart. Keep its calculation
 * on the same deduplication and freshness rules without constructing that work. */
export function buildAnalyticsSummary(
  snapshot: RadarSnapshot,
  options: { chain?: string; windowKey?: WindowKey; now?: number } = {},
): AnalyticsSummary {
  const { asOf, totals, networks, observedPools } = buildAnalyticsReport(
    snapshot,
    options,
    false,
  );
  return { asOf, totals, networks, observedPools };
}

export interface AnalyticsCsvOptions {
  /** The Auto Snapshot edition. The indexed_* counts are a dated census export,
   * so every row that carries them also carries that date, and the live scan
   * flags (caught_up, head_fresh: judged against a clock that does not move)
   * give way to the facts they were read from, with whether the head check
   * passed at the census. Dollar amounts from a cent up are written in cents.
   * Default: the live export. */
  edition?: boolean;
  /** inventory.generatedAt: when the census behind the indexed_* columns was
   * made. Written as it was published. */
  censusAsOf?: string | null;
  /** Edition: 7D or 30D of the largest pools. Five more columns are written at
   * the end of every row (span_window, span_through, span_volume_usd,
   * span_basis, span_covered_pools); without it the header is exactly as before. */
  span?: AnalyticsCsvSpan;
}

/** What the span columns read: which span, the day it runs to, and the lens. A
 * pool's figure is exact for its complete days; a total over pools is "at_least"
 * (only the largest pools have one). No figure is a blank, never a zero. */
export interface AnalyticsCsvSpan {
  /** "7D" or "30D". */
  label: string;
  /** The last complete UTC day, YYYY-MM-DD. */
  through: string;
  lens: {
    pool(pool: Pick<Pool, "id" | "chain" | "address">): { usd: number } | null;
    sum(pools: readonly Pick<Pool, "id" | "chain" | "address">[]): {
      usd: number | null;
      covered: number;
    };
  };
}

/** A self-describing current-observation export. Missing values are blank;
 * spreadsheet formulas in protocol/token/network names are escaped. */
export function analyticsCsv(
  report: AnalyticsResult,
  options: AnalyticsCsvOptions = {},
): string {
  const edition = options.edition === true;
  const censusAsOf = options.censusAsOf ?? null;
  const headers = [
    "row_type",
    "scope",
    "window",
    "as_of",
    "snapshot_at",
    "id",
    "name",
    "network",
    "observed_volume_usd",
    "observed_liquidity_usd",
    "share_of_observed_volume",
    "sample_pools",
    "current_volume_pools",
    "current_liquidity_pools",
    "positive_volume_pools",
    "attributed_hook_families",
    "unattributed_current_pools",
    "unattributed_observed_volume_usd",
    "indexed_hook_pools",
    "indexed_hook_contracts",
    ...(edition
      ? [
          "census_as_of",
          "scanned_to_target",
          // The time of the last head check that passed: a failed check does
          // not set it, so the next column says how the census ended.
          "head_checked_at",
          "head_check_at_census",
        ]
      : ["caught_up", "head_fresh"]),
    "volume_oldest_observation_at",
    "volume_latest_observation_at",
    "liquidity_oldest_observation_at",
    "liquidity_latest_observation_at",
    ...(options.span
      ? [
          "span_window",
          "span_through",
          "span_volume_usd",
          "span_basis",
          "span_covered_pools",
        ]
      : []),
  ];
  const span = options.span ?? null;
  /** The span columns of a row over a set of pools (a total: at least) or over
   * one pool (exact). Blank where there is no figure. */
  const spanCells = (
    pools: readonly AnalyticsPool[],
    single = false,
  ): unknown[] => {
    if (!span) return [];
    if (single) {
      const figure = span.lens.pool(pools[0].pool);
      return [
        span.label,
        span.through,
        figure ? roundExactUsd(figure.usd) : null,
        figure ? "exact" : null,
        figure ? 1 : 0,
      ];
    }
    const sum = span.lens.sum(
      pools.filter((row) => row.volumeUsd !== null).map((row) => row.pool),
    );
    return [
      span.label,
      span.through,
      sum.usd === null ? null : roundExactUsd(sum.usd),
      sum.usd === null ? null : "at_least",
      sum.covered,
    ];
  };
  const common = [
    report.chain,
    report.windowKey,
    report.asOf,
    report.snapshotAt,
  ];
  const times = (totals: AnalyticsTotals) => [
    totals.freshness.volume[report.windowKey].oldestAt,
    totals.freshness.volume[report.windowKey].newestAt,
    totals.freshness.liquidity.oldestAt,
    totals.freshness.liquidity.newestAt,
  ];
  /** A sum of cent amounts carries float residue (44372005.32000001). The
   * edition writes an amount from a cent up in cents, as the page shows it; a
   * smaller one, a zero and a missing value are written as they are. */
  const usd = (value: number | null): number | null =>
    edition && value !== null ? roundExactUsd(value) : value;
  const metrics = (totals: AnalyticsTotals) => [
    totals.samplePools,
    totals.volumePools,
    totals.liquidityPools,
    totals.activePools,
    totals.attributedProjects,
    totals.unattributedPools,
    usd(totals.unattributedVolumeUsd),
  ];
  /** Whether the census head check passed, where the census says: failed when
   * it recorded a head-check error, passed when the scan finished with a head
   * check on record, and blank when the row cannot say. */
  const headCheck = (network: AnalyticsNetwork | null): string | null => {
    const inventory = network?.inventory;
    if (!inventory) return null;
    if (inventoryHeadCheckFailed(inventory)) return "failed";
    return inventory.status === "complete" && inventory.headCheckedAt
      ? "passed"
      : null;
  };
  /** indexed_hook_pools, indexed_hook_contracts and what follows them. Rows
   * without census counts leave all of it blank. */
  const census = (
    pools: number | null,
    contracts: number | null,
    network: AnalyticsNetwork | null,
  ): unknown[] =>
    edition
      ? [
          pools,
          contracts,
          pools === null && contracts === null ? null : censusAsOf,
          network?.inventory ? network.caughtUp : null,
          network?.inventory?.headCheckedAt ?? null,
          headCheck(network),
        ]
      : [
          pools,
          contracts,
          network?.inventory ? network.caughtUp : null,
          network?.inventory ? network.headFresh : null,
        ];
  const rows: unknown[][] = [
    [
      "summary",
      ...common,
      "",
      "Current observed sample",
      report.chain,
      usd(report.totals.volumeUsd),
      usd(report.totals.liquidityUsd),
      null,
      ...metrics(report.totals),
      ...census(
        report.inventory.hookPoolCount,
        report.inventory.hookCount,
        null,
      ),
      ...times(report.totals),
      ...spanCells(report.pools),
    ],
  ];
  for (const network of report.networks)
    rows.push([
      "network",
      ...common,
      network.chain,
      network.name,
      network.chain,
      usd(network.volumeUsd),
      usd(network.liquidityUsd),
      network.volumeShare,
      ...metrics(network),
      ...census(
        network.inventory?.hookPoolCount ?? null,
        network.inventory?.hookCount ?? null,
        network,
      ),
      ...times(network),
      ...spanCells(report.pools.filter((row) => row.pool.chain === network.chain)),
    ]);
  for (const project of report.projects)
    rows.push([
      "project",
      ...common,
      project.project.id,
      project.project.name,
      report.chain,
      usd(project.volumeUsd),
      usd(project.liquidityUsd),
      project.volumeShare,
      ...metrics(project),
      ...census(null, null, null),
      ...times(project),
      ...spanCells(
        report.pools.filter((row) => row.project?.id === project.project.id),
      ),
    ]);
  for (const pool of report.pools) {
    const observation = pool.pool.metricUpdatedAt ?? null;
    rows.push([
      "pool",
      ...common,
      pool.pool.id,
      pool.pool.name,
      pool.pool.chain,
      usd(pool.volumeUsd),
      usd(pool.liquidityUsd),
      pool.volumeShare,
      1,
      pool.volumeUsd === null ? 0 : 1,
      pool.liquidityUsd === null ? 0 : 1,
      pool.volumeUsd !== null && pool.volumeUsd > 0 ? 1 : 0,
      pool.project ? 1 : 0,
      pool.project ? 0 : 1,
      pool.project ? null : usd(pool.volumeUsd),
      ...census(null, null, null),
      pool.volumeUsd === null ? null : observation,
      pool.volumeUsd === null ? null : observation,
      pool.liquidityUsd === null ? null : observation,
      pool.liquidityUsd === null ? null : observation,
      ...spanCells([pool], true),
    ]);
  }
  return (
    "\uFEFF" +
    [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") +
    "\r\n"
  );
}
