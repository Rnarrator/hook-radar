/** Client-only shaping for the Analytics investigation workflow: metric
 * selection, cross-filter ("focus") breakdowns and evidence partitions.
 *
 * Every number comes from the existing analytics modules: per-pool values are
 * the freshness-checked rows of `buildAnalytics` (workspace) or the accepted
 * contribution ledger re-evaluated by the shared `analyticsOverviewAt`
 * (overview). Nothing here reads raw pool amounts, interpolates, or converts
 * rolling observations into period totals. Each pool contributes once. */
import type { AnalyticsPool, AnalyticsTotals } from "./analytics.ts";
import type { AnalyticsOverviewEnvelope } from "../shared/analytics-overview.ts";
import { analyticsOverviewAt } from "../shared/analytics-contributions.ts";
import type { MetricFreshness, WindowKey } from "../shared/types.ts";

export type AnalyticsMetric = "volume" | "reserves" | "trading";
export type AnalyticsFocusKind = "network" | "category" | "project";
export interface AnalyticsFocus {
  kind: AnalyticsFocusKind;
  id: string;
}

export const ANALYTICS_METRICS: readonly AnalyticsMetric[] = [
  "volume",
  "reserves",
  "trading",
];

/** The fields every metric reads; network, project and total rows all have
 * them (null where a measurement is withheld). */
export interface MetricFields {
  volumeUsd: number | null;
  liquidityUsd: number | null;
  volumePools: number | null;
  liquidityPools: number | null;
  activePools: number | null;
}

/** Measured value of a row for a metric. "Pools with trading" is a count of
 * pools with positive current volume and is unavailable (null) — not zero —
 * when the row has no current volume measurement at all. */
export function metricValue(
  row: MetricFields,
  metric: AnalyticsMetric,
): number | null {
  if (metric === "volume") return row.volumeUsd;
  if (metric === "reserves") return row.liquidityUsd;
  return row.volumePools !== null && row.volumePools > 0
    ? row.activePools
    : null;
}

/** Current measurements behind a metric value (pools with that measurement). */
export function metricPools(
  row: MetricFields,
  metric: AnalyticsMetric,
): number | null {
  return metric === "reserves" ? row.liquidityPools : row.volumePools;
}

export function metricShare(
  value: number | null,
  total: number | null,
): number | null {
  if (
    value === null ||
    total === null ||
    !Number.isFinite(value) ||
    !Number.isFinite(total) ||
    value < 0 ||
    total <= 0
  )
    return null;
  const share = value / total;
  return Number.isFinite(share) ? share : null;
}

/** Plain-language metric names used by captions, headings and denominators.
 * With `span` (edition: 7D or 30D of the largest pools) the volume copy says
 * so: the figures are the daily volume of the largest pools only, and a share
 * is of the covered volume, never of the tracked total. The other metrics have
 * no span meaning and never change. */
export function metricCopy(
  metric: AnalyticsMetric,
  windowKey: WindowKey,
  span?: { label: string } | null,
) {
  const window = windowKey === "h1" ? "1H" : windowKey === "h6" ? "6H" : "24H";
  if (metric === "volume" && span)
    return {
      name: `${span.label} volume`,
      measure: `Tracked ${span.label} hook-pool volume, largest pools only`,
      denominator: `of covered ${span.label} volume`,
      unit: "USD",
      money: true,
    };
  if (metric === "volume")
    return {
      name: "Volume",
      measure: `Tracked ${window} hook-pool volume`,
      denominator: `of tracked ${window} volume`,
      unit: "USD",
      money: true,
    };
  if (metric === "reserves")
    return {
      name: "Reserves",
      measure: "Tracked pool reserves",
      denominator: "of tracked reserves",
      unit: "USD",
      money: true,
    };
  return {
    name: "Pools with trading",
    measure: `Pools with ${window} trading`,
    denominator: "of pools with trading",
    unit: "pools",
    money: false,
  };
}

export interface FocusSlice {
  /** Sum (USD) or count (trading); null when no pool in the slice has the
   * measurement. */
  value: number | null;
  /** Pools contributing a current measurement to the slice. */
  pools: number;
}

export interface FocusBreakdown {
  focus: AnalyticsFocus;
  metric: AnalyticsMetric;
  total: FocusSlice;
  networks: Map<string, FocusSlice>;
  categories: Map<string, FocusSlice>;
  /** Attributed projects only; unattributed pools stay in "Unattributed". */
  projects: Map<string, FocusSlice>;
}

export const UNATTRIBUTED = "Unattributed";

export function poolCategory(row: Pick<AnalyticsPool, "project">): string {
  return row.project?.category || UNATTRIBUTED;
}

export function matchesFocus(
  row: Pick<AnalyticsPool, "pool" | "project">,
  focus: AnalyticsFocus | null,
): boolean {
  if (!focus) return true;
  if (focus.kind === "network") return row.pool.chain === focus.id;
  if (focus.kind === "category") return poolCategory(row) === focus.id;
  return row.project?.id === focus.id;
}

type Accumulator = { sum: number; pools: number };

function contribution(
  row: Pick<AnalyticsPool, "volumeUsd" | "liquidityUsd">,
  metric: AnalyticsMetric,
): number | null {
  const value = metric === "reserves" ? row.liquidityUsd : row.volumeUsd;
  if (value === null || !Number.isFinite(value) || value < 0) return null;
  return metric === "trading" ? (value > 0 ? 1 : 0) : value;
}

function finish(group: Accumulator | undefined): FocusSlice {
  if (!group || group.pools === 0) return { value: null, pools: 0 };
  return {
    value: Number.isFinite(group.sum) ? group.sum : null,
    pools: group.pools,
  };
}

/** Cross-filter breakdown from the workspace's current pool rows. Values for
 * the unfocused dimension are the same per-pool operands that build the
 * scope totals, so a focused network's total equals its network row. */
export function workspaceFocusBreakdown(
  pools: readonly AnalyticsPool[],
  metric: AnalyticsMetric,
  focus: AnalyticsFocus,
): FocusBreakdown {
  const total: Accumulator = { sum: 0, pools: 0 };
  const networks = new Map<string, Accumulator>();
  const categories = new Map<string, Accumulator>();
  const projects = new Map<string, Accumulator>();
  const add = (map: Map<string, Accumulator>, key: string, value: number) => {
    let group = map.get(key);
    if (!group) map.set(key, (group = { sum: 0, pools: 0 }));
    group.sum += value;
    group.pools++;
  };
  for (const row of pools) {
    if (!matchesFocus(row, focus)) continue;
    const value = contribution(row, metric);
    if (value === null) continue;
    total.sum += value;
    total.pools++;
    add(networks, row.pool.chain, value);
    add(categories, poolCategory(row), value);
    if (row.project) add(projects, row.project.id, value);
  }
  const finishAll = (map: Map<string, Accumulator>) =>
    new Map([...map].map(([key, group]) => [key, finish(group)]));
  return {
    focus,
    metric,
    total: finish(total),
    networks: finishAll(networks),
    categories: finishAll(categories),
    projects: finishAll(projects),
  };
}

export interface MetricSlice {
  category: string;
  value: number | null;
  share: number | null;
  measuredPools: number;
}

/** "Pools with trading" by use case: pools with positive current volume per
 * category, over the scope's pools with trading. Pools without a current
 * volume measurement are not counted (unavailable is not zero). */
export function categoryTradingSlices(
  pools: readonly Pick<AnalyticsPool, "project" | "volumeUsd">[],
  activePools: number | null,
): MetricSlice[] {
  const groups = new Map<string, Accumulator>();
  for (const row of pools) {
    const value = contribution({ volumeUsd: row.volumeUsd, liquidityUsd: null }, "trading");
    const category = poolCategory(row);
    let group = groups.get(category);
    if (!group) groups.set(category, (group = { sum: 0, pools: 0 }));
    if (value === null) continue;
    group.sum += value;
    group.pools++;
  }
  return [...groups]
    .map(([category, group]) => {
      const slice = finish(group);
      return {
        category,
        value: slice.value,
        share: metricShare(slice.value, activePools),
        measuredPools: slice.pools,
      };
    })
    .sort(
      (a, b) =>
        (a.value === null ? 1 : 0) - (b.value === null ? 1 : 0) ||
        (b.value ?? 0) - (a.value ?? 0) ||
        a.category.localeCompare(b.category),
    );
}

type Contribution = NonNullable<
  AnalyticsOverviewEnvelope["contributions"]
>["rows"][number];

export function ledgerCategory(
  envelope: AnalyticsOverviewEnvelope,
  row: Contribution,
): string {
  return row[2] >= 0
    ? envelope.contributions!.projects[row[2]][2]
    : UNATTRIBUTED;
}

/** Re-evaluate a subset of the accepted contribution ledger with the shared
 * derivation (same expiry, attribution and summation rules as the screen's
 * totals). */
function deriveSubset(
  envelope: AnalyticsOverviewEnvelope,
  now: number,
  keep: (row: Contribution) => boolean,
) {
  const ledger = envelope.contributions!;
  return analyticsOverviewAt(
    { ...envelope, contributions: { ...ledger, rows: ledger.rows.filter(keep) } },
    now,
  );
}

function totalsSlice(
  totals: AnalyticsTotals | AnalyticsOverviewEnvelope["totals"],
  metric: AnalyticsMetric,
): FocusSlice {
  const value = metricValue(totals, metric);
  return { value, pools: value === null ? 0 : (metricPools(totals, metric) ?? 0) };
}

/** Cross-filter breakdown for the bounded overview. Requires the contribution
 * ledger (null for legacy aggregate-only responses, which cannot be split
 * without inventing values). Projects have no names in the overview, so only
 * network and use-case focus are supported. */
export function overviewFocusBreakdown(
  envelope: AnalyticsOverviewEnvelope,
  now: number,
  metric: AnalyticsMetric,
  focus: AnalyticsFocus,
): FocusBreakdown | null {
  if (!envelope.contributions || focus.kind === "project") return null;
  const inFocus = (row: Contribution) =>
    focus.kind === "network"
      ? row[0] === focus.id
      : ledgerCategory(envelope, row) === focus.id;
  const derived = deriveSubset(envelope, now, inFocus);
  const networks = new Map<string, FocusSlice>();
  for (const network of derived.networkTotals)
    networks.set(network.chain, totalsSlice(network, metric));
  const categories = new Map<string, FocusSlice>();
  if (metric === "trading") {
    const names = new Set(
      envelope.contributions.rows
        .filter(inFocus)
        .map((row) => ledgerCategory(envelope, row)),
    );
    for (const category of names) {
      const subset = deriveSubset(
        envelope,
        now,
        (row) => inFocus(row) && ledgerCategory(envelope, row) === category,
      );
      categories.set(category, totalsSlice(subset.totals, metric));
    }
  } else {
    for (const row of derived.categories[metric === "volume" ? "volume" : "reserves"])
      categories.set(row.category, {
        value: row.value,
        pools: row.measuredPools,
      });
  }
  return {
    focus,
    metric,
    total: totalsSlice(derived.totals, metric),
    networks,
    categories,
    projects: new Map(),
  };
}

/** "Pools with trading" by use case for the overview, from the same ledger
 * derivation. Null for legacy responses. */
export function overviewCategoryTrading(
  envelope: AnalyticsOverviewEnvelope,
  now: number,
): MetricSlice[] | null {
  if (!envelope.contributions) return null;
  const current = analyticsOverviewAt(envelope, now);
  const names = new Set(
    envelope.contributions.rows.map((row) => ledgerCategory(envelope, row)),
  );
  const slices: MetricSlice[] = [];
  for (const category of names) {
    const subset = deriveSubset(
      envelope,
      now,
      (row) => ledgerCategory(envelope, row) === category,
    );
    const value = metricValue(subset.totals, "trading");
    slices.push({
      category,
      value,
      share: metricShare(value, metricValue(current.totals, "trading")),
      measuredPools: subset.totals.volumePools,
    });
  }
  return slices.sort(
    (a, b) =>
      (a.value === null ? 1 : 0) - (b.value === null ? 1 : 0) ||
      (b.value ?? 0) - (a.value ?? 0) ||
      a.category.localeCompare(b.category),
  );
}

export interface EvidencePartition {
  /** Pools in the scope's market observation sample (the denominator). */
  sample: number;
  current: number;
  older: number;
  unverified: number;
  /** Sample pools without any value for this metric (not checked, no price). */
  missing: number;
}

/** Partition the observation sample by evidence quality for one metric.
 * Returns null when the counts do not reconcile (never papered over). */
export function evidencePartition(
  freshness: MetricFreshness,
  samplePools: number,
): EvidencePartition | null {
  const { observedPools, currentPools, stalePools, unknownPools } = freshness;
  const counts = [samplePools, observedPools, currentPools, stalePools, unknownPools];
  if (!counts.every((value) => Number.isSafeInteger(value) && value >= 0))
    return null;
  if (currentPools + stalePools + unknownPools !== observedPools) return null;
  if (observedPools > samplePools) return null;
  return {
    sample: samplePools,
    current: currentPools,
    older: stalePools,
    unverified: unknownPools,
    missing: samplePools - observedPools,
  };
}
