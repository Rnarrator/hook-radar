import type {
  AnalyticsOverviewEnvelope,
  OverviewCategory,
  OverviewTotals,
} from "./analytics-overview.ts";
import type { MetricFreshness } from "./types";
import { MARKET_MAX_AGE_MS, MARKET_CLOCK_SKEW_MS } from "./market-freshness.ts";
import { networkHeadFresh } from "./indexing.ts";

/** A fixed accepted response cohort, not newly discovered or future-eligible
 * observations. Source clocks and numeric operands are retained verbatim. */
export type AnalyticsContribution = [
  chain: string,
  address: string,
  project: number,
  observedAt: string,
  h1: number | null,
  h6: number | null,
  h24: number | null,
  reserves: number | null,
  categoryRank: number,
];
export interface AnalyticsContributions {
  version: 1;
  scope: "initial-current-cohort";
  projects: [id: string, listed: boolean, category: string][];
  rows: AnalyticsContribution[];
}
const categories = [
  "Launches",
  "Liquidity",
  "Fees",
  "MEV",
  "Orders",
  "Oracles",
  "Access",
  "Other",
  "Unattributed",
];
const valueIndexes = [4, 5, 6, 7] as const;
type ValueIndex = (typeof valueIndexes)[number];
const selectedIndex = (dto: AnalyticsOverviewEnvelope): ValueIndex =>
  dto.request.window === "h1" ? 4 : dto.request.window === "h6" ? 5 : 6;
const amount = (v: unknown): v is number | null =>
  v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0);
const sum = (rows: readonly AnalyticsContribution[], field: ValueIndex) => {
  let value = 0,
    count = 0;
  for (const row of rows)
    if (row[field] !== null) {
      value += row[field];
      count++;
    }
  return count && Number.isFinite(value) ? value : null;
};
const share = (value: number | null, total: number | null) => {
  const result =
    value !== null && total !== null && total > 0 ? value / total : null;
  return result !== null && Number.isFinite(result) ? result : null;
};
const emptyProof = (): MetricFreshness => ({
  observedPools: 0,
  currentPools: 0,
  stalePools: 0,
  unknownPools: 0,
  oldestAt: null,
  newestAt: null,
  latestObservedAt: null,
  expiresAt: null,
});
function currentProof(
  rows: readonly AnalyticsContribution[],
  field: ValueIndex,
): MetricFreshness {
  const result = emptyProof();
  for (const row of rows) {
    if (row[field] === null) continue;
    const iso = new Date(Date.parse(row[3])).toISOString();
    result.currentPools++;
    if (result.oldestAt === null || iso < result.oldestAt)
      result.oldestAt = iso;
    if (result.newestAt === null || iso > result.newestAt)
      result.newestAt = iso;
  }
  result.observedPools = result.currentPools;
  result.latestObservedAt = result.newestAt;
  result.expiresAt =
    result.oldestAt === null
      ? null
      : new Date(Date.parse(result.oldestAt) + MARKET_MAX_AGE_MS).toISOString();
  return result;
}
function retainedProof(
  original: MetricFreshness,
  rows: readonly AnalyticsContribution[],
  field: ValueIndex,
) {
  const current = currentProof(rows, field);
  return {
    ...current,
    observedPools: original.observedPools,
    stalePools:
      original.stalePools + original.currentPools - current.currentPools,
    unknownPools: original.unknownPools,
    latestObservedAt: original.latestObservedAt,
  };
}
function deriveTotals(
  original: OverviewTotals,
  rows: readonly AnalyticsContribution[],
  dto: AnalyticsOverviewEnvelope,
): OverviewTotals {
  const field = selectedIndex(dto),
    projects = dto.contributions!.projects;
  const proof = {
    h1: retainedProof(original.freshness.volume.h1, rows, 4),
    h6: retainedProof(original.freshness.volume.h6, rows, 5),
    h24: retainedProof(original.freshness.volume.h24, rows, 6),
    liquidity: retainedProof(original.freshness.liquidity, rows, 7),
  };
  const attributed = new Set<number>(),
    unlisted = new Set<number>();
  let activePools = 0,
    unattributedPools = 0,
    unattributedVolume = 0,
    unattributedVolumePools = 0;
  for (const row of rows) {
    const volume = row[field],
      reserves = row[7];
    if (volume !== null && volume > 0) activePools++;
    if (volume === null && reserves === null) continue;
    if (row[2] >= 0 && projects[row[2]][1]) attributed.add(row[2]);
    else {
      unattributedPools++;
      if (row[2] >= 0) unlisted.add(row[2]);
      if (volume !== null) {
        unattributedVolumePools++;
        unattributedVolume += volume;
      }
    }
  }
  const deadlines = Object.values(proof)
    .map((p) => p.expiresAt)
    .filter((v): v is string => v !== null)
    .sort();
  return {
    ...original,
    volumeUsd: sum(rows, field),
    liquidityUsd: sum(rows, 7),
    volumePools: proof[dto.request.window].currentPools,
    liquidityPools: proof.liquidity.currentPools,
    activePools,
    attributedProjects: attributed.size,
    unattributedPools,
    unattributedVolumeUsd:
      unattributedVolumePools && Number.isFinite(unattributedVolume)
        ? unattributedVolume
        : null,
    unlistedProjects: unlisted.size,
    freshness: {
      maxAgeMs: MARKET_MAX_AGE_MS,
      expiresAt: deadlines[0] ?? null,
      liquidity: proof.liquidity,
      volume: { h1: proof.h1, h6: proof.h6, h24: proof.h24 },
    },
  };
}
function derive(
  dto: AnalyticsOverviewEnvelope,
  now: number,
): AnalyticsOverviewEnvelope {
  const ledger = dto.contributions!,
    field = selectedIndex(dto);
  // Never requalify a row that was excluded by the server's original accepted
  // cohort. Advancing time only removes operands; refresh admits new evidence.
  const rows = ledger.rows.filter(
    (row) =>
      Date.parse(row[3]) + MARKET_MAX_AGE_MS > now &&
      Date.parse(row[3]) <= now + MARKET_CLOCK_SKEW_MS,
  );
  const totals = deriveTotals(dto.totals, rows, dto);
  const byNetwork = new Map<string, AnalyticsContribution[]>();
  for (const row of rows) {
    if (!byNetwork.has(row[0])) byNetwork.set(row[0], []);
    byNetwork.get(row[0])!.push(row);
  }
  const networkTotals = dto.networkTotals.map((network) => {
    const next = deriveTotals(network, byNetwork.get(network.chain) ?? [], dto);
    return {
      ...network,
      ...next,
      volumeShare: share(next.volumeUsd, totals.volumeUsd),
      headFresh: network.inventory
        ? networkHeadFresh(network.inventory, now)
        : false,
    };
  });
  const descending = (a: number | null, b: number | null) =>
    a === b ? 0 : a === null ? 1 : b === null ? -1 : b - a;
  networkTotals.sort(
    (a, b) =>
      descending(a.volumeUsd, b.volumeUsd) ||
      descending(a.liquidityUsd, b.liquidityUsd) ||
      a.name.localeCompare(b.name),
  );
  const byCategory = new Map<string, AnalyticsContribution[]>();
  for (const row of rows
    .filter((row) => row[field] !== null || row[7] !== null)
    .sort((a, b) => a[8] - b[8])) {
    const category = row[2] >= 0 ? ledger.projects[row[2]][2] : "Unattributed";
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category)!.push(row);
  }
  const categoryRows = (metric: "volume" | "reserves"): OverviewCategory[] => {
    const index = metric === "volume" ? field : 7,
      total = metric === "volume" ? totals.volumeUsd : totals.liquidityUsd;
    const originals = new Map(
      dto.categories[metric].map((row) => [row.category, row]),
    );
    return [...byCategory]
      .map(([category, operands]) => {
        const value = sum(operands, index),
          freshness = currentProof(operands, index);
        return {
          category,
          value,
          share: share(value, total),
          measuredPools: freshness.currentPools,
          color: originals.get(category)!.color,
          freshness,
        };
      })
      .sort(
        (a, b) =>
          descending(a.value, b.value) || a.category.localeCompare(b.category),
      );
  };
  return {
    ...dto,
    totals,
    networkTotals,
    categories: {
      volume: categoryRows("volume"),
      reserves: categoryRows("reserves"),
    },
  };
}
/** Uses a validated original envelope. Legacy responses retain their original
 * indivisible-aggregate behavior. No publication/source timestamp is renewed. */
export function analyticsOverviewAt(
  dto: AnalyticsOverviewEnvelope,
  now: number,
): AnalyticsOverviewEnvelope {
  if (!dto.contributions) return dto;
  if (!Number.isFinite(now) || now < 0)
    throw new RangeError("Invalid analytics evaluation clock.");
  return derive(dto, Math.max(now, Date.parse(dto.asOf)));
}

/** Called after the bounded envelope's descriptor-only tree validation. Exact
 * reconciliation prevents omitted/duplicated operands or invented attribution. */
export function validateAnalyticsContributions(
  dto: AnalyticsOverviewEnvelope,
): boolean {
  const ledger = dto.contributions;
  if (ledger === undefined) return true;
  if (
    !ledger ||
    typeof ledger !== "object" ||
    Array.isArray(ledger) ||
    Object.keys(ledger).sort().join("|") !== "projects|rows|scope|version" ||
    ledger.version !== 1 ||
    ledger.scope !== "initial-current-cohort" ||
    !Array.isArray(ledger.projects) ||
    !Array.isArray(ledger.rows) ||
    ledger.rows.length > 10000 ||
    ledger.projects.length > 10000
  )
    return false;
  const ids = new Set<string>(),
    poolIds = new Set<string>(),
    used = new Set<number>(),
    ranks = new Set<number>();
  const at = Date.parse(dto.asOf),
    field = selectedIndex(dto),
    networks = new Set(dto.networkTotals.map((n) => n.chain));
  for (const project of ledger.projects) {
    if (
      !Array.isArray(project) ||
      project.length !== 3 ||
      typeof project[0] !== "string" ||
      !project[0] ||
      project[0].length > 200 ||
      ids.has(project[0]) ||
      typeof project[1] !== "boolean" ||
      !categories.includes(project[2]) ||
      (!project[1] && project[2] !== "Unattributed")
    )
      return false;
    ids.add(project[0]);
  }
  for (const row of ledger.rows) {
    if (
      !Array.isArray(row) ||
      row.length !== 9 ||
      !networks.has(row[0]) ||
      typeof row[1] !== "string" ||
      !/^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(row[1]) ||
      !Number.isInteger(row[2]) ||
      row[2] < -1 ||
      row[2] >= ledger.projects.length ||
      typeof row[3] !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(row[3]) ||
      !valueIndexes.every((i) => amount(row[i])) ||
      valueIndexes.every((i) => row[i] === null) ||
      !Number.isInteger(row[8])
    )
      return false;
    const time = Date.parse(row[3]),
      canonical = row[3].replace(
        /(?:\.(\d{1,3}))?Z$/,
        (_, fraction: string | undefined) =>
          `.${(fraction || "").padEnd(3, "0")}Z`,
      );
    if (
      !Number.isFinite(time) ||
      time < 0 ||
      new Date(time).toISOString() !== canonical ||
      time > at + MARKET_CLOCK_SKEW_MS ||
      time + MARKET_MAX_AGE_MS <= at
    )
      return false;
    const id = `${row[0]}:${row[1]}`;
    if (poolIds.has(id)) return false;
    poolIds.add(id);
    if (row[2] >= 0) used.add(row[2]);
    if (row[field] === null && row[7] === null) {
      if (row[8] !== -1) return false;
    } else {
      if (row[8] < 0 || ranks.has(row[8])) return false;
      ranks.add(row[8]);
    }
  }
  if (
    used.size !== ledger.projects.length ||
    [...ranks].some((rank) => rank >= ranks.size)
  )
    return false;
  const ordered = ledger.rows
    .filter((row) => row[8] >= 0)
    .sort((a, b) => a[8] - b[8]);
  const compare = (a: number | null, b: number | null) =>
    a === b ? 0 : a === null ? 1 : b === null ? -1 : b - a;
  for (let i = 1; i < ordered.length; i++)
    if (
      (compare(ordered[i - 1][field], ordered[i][field]) ||
        compare(ordered[i - 1][7], ordered[i][7])) > 0
    )
      return false;
  const actual = derive(dto, at);
  const equal = (a: unknown, b: unknown): boolean => {
    if (a === b) return true;
    if (
      !a ||
      !b ||
      typeof a !== "object" ||
      typeof b !== "object" ||
      Array.isArray(a) !== Array.isArray(b)
    )
      return false;
    const left = Object.keys(a),
      right = Object.keys(b);
    return (
      left.length === right.length &&
      left.every(
        (key) =>
          Object.hasOwn(b, key) &&
          equal(
            (a as Record<string, unknown>)[key],
            (b as Record<string, unknown>)[key],
          ),
      )
    );
  };
  return (
    equal(actual.totals, dto.totals) &&
    equal(actual.networkTotals, dto.networkTotals) &&
    equal(actual.categories, dto.categories)
  );
}
