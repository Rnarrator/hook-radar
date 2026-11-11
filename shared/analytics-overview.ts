import type {
  MarketFreshness,
  MetricFreshness,
  Point,
  PoolIndexCoverage,
  PoolIndexNetwork,
  RadarSnapshot,
  SourceStatus,
  WindowKey,
} from "./types";
import { isMarketFreshness, MARKET_CLOCK_SKEW_MS } from "./market-freshness.ts";
import { validateAnalyticsContributions } from "./analytics-contributions.ts";
import type { AnalyticsContributions } from "./analytics-contributions.ts";
export { analyticsOverviewAt } from "./analytics-contributions.ts";

export const ANALYTICS_OVERVIEW_MAX_BYTES = 2 * 1024 * 1024;
/** The most recorded points an overview carries: what the live service keeps.
 * A caller that keeps a longer history (the static edition) says so with
 * `maxHistoryPoints`; nobody else is affected. */
export const ANALYTICS_OVERVIEW_HISTORY_POINTS = 672;
export const ANALYTICS_OVERVIEW_PROFILE = Object.freeze({
  profile: "analytics-overview" as const,
  version: 1 as const,
  detail: "deferred" as const,
});
export interface AnalyticsOverviewQuery {
  chain: string;
  window: WindowKey;
}
export interface OverviewTotals {
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
  freshness: MarketFreshness;
}
export interface OverviewNetwork extends OverviewTotals {
  chain: string;
  name: string;
  volumeShare: number | null;
  inventory: PoolIndexNetwork | null;
  caughtUp: boolean;
  headFresh: boolean;
}
export interface OverviewCategory {
  category: string;
  value: number | null;
  share: number | null;
  measuredPools: number;
  color: string;
  freshness: MetricFreshness;
}
/** Complete aggregates over the published observation sample. Canonical indexed
 * pools are a separate denominator; detail is deferred, never fabricated. */
export interface AnalyticsOverviewEnvelope {
  schemaVersion: 1;
  presentation: typeof ANALYTICS_OVERVIEW_PROFILE;
  ready: true;
  publication: {
    id: string;
    generatedAt: string;
    status: RadarSnapshot["status"];
  };
  request: AnalyticsOverviewQuery;
  asOf: string;
  networks: { slug: string; name: string }[];
  sources: SourceStatus[];
  inventory: PoolIndexCoverage | null;
  totals: OverviewTotals;
  networkTotals: OverviewNetwork[];
  categories: { volume: OverviewCategory[]; reserves: OverviewCategory[] };
  history: { available: boolean; points: Point[] };
  contributions?: AnalyticsContributions;
}

const object = (v: unknown): v is Record<string, unknown> =>
  !!v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(v));
const text = (v: unknown, limit = 4000): v is string =>
  typeof v === "string" && v.length <= limit;
const slug = (v: unknown): v is string =>
  text(v, 100) && /^[a-z0-9][a-z0-9-]{0,99}$/.test(v);
const count = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const amount = (v: unknown): v is number | null =>
  v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0);
const date = (v: unknown): v is string =>
  text(v, 30) &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  Date.parse(v) >= 0 &&
  new Date(v).toISOString() === v;
const maybeDate = (v: unknown) => v === null || date(v);
const keys = (v: Record<string, unknown>, expected: string[]) =>
  Object.keys(v).length === expected.length &&
  expected.every((k) => Object.hasOwn(v, k));
const categoryNames = [
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

/** Reject unsafe object graphs before inspecting fields. HTTP callers also cap
 * raw response bytes; this bounds decoded validation work and rejects accessors. */
function safeTree(root: unknown) {
  const todo: [unknown, number][] = [[root, 0]];
  const seen = new Set<object>();
  let nodes = 0,
    characters = 0;
  while (todo.length) {
    const [v, depth] = todo.pop()!;
    if (++nodes > 100000 || depth > 18) return false;
    if (typeof v === "string") {
      characters += v.length;
      if (v.length > 16000 || characters > ANALYTICS_OVERVIEW_MAX_BYTES)
        return false;
    } else if (typeof v === "number") {
      if (!Number.isFinite(v)) return false;
    } else if (v !== null && typeof v !== "boolean") {
      if (!Array.isArray(v) && !object(v)) return false;
      if (seen.has(v as object)) return false;
      // Shared server references are valid; only an ancestor cycle is unsafe.
      seen.add(v as object);
      if (Array.isArray(v) && v.length > 10000) return false;
      for (const key of Reflect.ownKeys(v as object)) {
        if (key === "length" && Array.isArray(v)) continue;
        if (
          typeof key !== "string" ||
          ["__proto__", "prototype", "constructor"].includes(key)
        )
          return false;
        const descriptor = Object.getOwnPropertyDescriptor(v, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
          return false;
        todo.push([descriptor.value, depth + 1]);
      }
      seen.delete(v as object);
    }
  }
  return true;
}

export function isAnalyticsOverviewQuery(
  v: unknown,
): v is AnalyticsOverviewQuery {
  return (
    object(v) &&
    keys(v, ["chain", "window"]) &&
    slug(v.chain) &&
    ["h1", "h6", "h24"].includes(v.window as string)
  );
}
export function analyticsOverviewQueryFromParams(
  params: URLSearchParams,
): AnalyticsOverviewQuery | null {
  if (!(params instanceof URLSearchParams)) return null;
  for (const key of params.keys())
    if (!["chain", "window"].includes(key) || params.getAll(key).length !== 1)
      return null;
  const value = {
    chain: params.get("chain") ?? "all",
    window: params.get("window") ?? "h24",
  };
  return isAnalyticsOverviewQuery(value) ? value : null;
}
export const analyticsOverviewQueryKey = (query: AnalyticsOverviewQuery) =>
  JSON.stringify([query.chain, query.window]);

function networkInventory(v: unknown): v is PoolIndexNetwork {
  return (
    object(v) &&
    slug(v.chain) &&
    text(v.name, 200) &&
    count(v.chainId) &&
    v.chainId > 0 &&
    text(v.manager, 42) &&
    /^0x[0-9a-f]{40}$/i.test(v.manager) &&
    count(v.startBlock) &&
    Number.isSafeInteger(v.scannedToBlock) &&
    Number(v.scannedToBlock) >= -1 &&
    (v.targetBlock === null || count(v.targetBlock)) &&
    ["queued", "scanning", "complete", "unavailable", "error"].includes(
      v.status as string,
    ) &&
    [v.poolCount, v.hookPoolCount, v.hookCount].every(count) &&
    Number(v.hookPoolCount) <= Number(v.poolCount) &&
    (v.dataset === null || text(v.dataset)) &&
    maybeDate(v.updatedAt) &&
    (v.headCheckedAt === undefined || maybeDate(v.headCheckedAt)) &&
    (v.lastError === null || text(v.lastError)) &&
    (v.cacheWarning === undefined ||
      v.cacheWarning === null ||
      text(v.cacheWarning)) &&
    (v.finality === undefined ||
      ["finalized", "confirmed"].includes(v.finality as string))
  );
}
function inventory(v: unknown): v is PoolIndexCoverage {
  return (
    object(v) &&
    date(v.generatedAt) &&
    typeof v.running === "boolean" &&
    [v.poolCount, v.hookPoolCount, v.hookCount].every(count) &&
    Array.isArray(v.networks) &&
    v.networks.length <= 100 &&
    v.networks.every(networkInventory) &&
    new Set(v.networks.map((n) => n.chain)).size === v.networks.length
  );
}
function totals(v: unknown, window: WindowKey): v is OverviewTotals {
  if (
    !object(v) ||
    ![v.volumeUsd, v.liquidityUsd, v.unattributedVolumeUsd].every(amount) ||
    ![
      v.samplePools,
      v.volumePools,
      v.liquidityPools,
      v.activePools,
      v.attributedProjects,
      v.unattributedPools,
      v.unlistedProjects,
    ].every(count) ||
    !isMarketFreshness(v.freshness)
  )
    return false;
  const row = v as unknown as OverviewTotals;
  return (
    row.volumePools === row.freshness.volume[window].currentPools &&
    row.liquidityPools === row.freshness.liquidity.currentPools &&
    [row.freshness.liquidity, ...Object.values(row.freshness.volume)].every(
      (proof) => proof.observedPools <= row.samplePools,
    ) &&
    row.activePools <= row.volumePools &&
    row.volumePools <= row.samplePools &&
    row.liquidityPools <= row.samplePools &&
    row.attributedProjects <= row.samplePools &&
    row.unattributedPools <= row.samplePools &&
    row.unlistedProjects <= row.unattributedPools &&
    (row.volumePools !== 0 || row.volumeUsd === null) &&
    (row.liquidityPools !== 0 || row.liquidityUsd === null)
  );
}

export function isAnalyticsOverviewEnvelope(
  value: unknown,
  expected?: AnalyticsOverviewQuery,
  options: { maxHistoryPoints?: number } = {},
): value is AnalyticsOverviewEnvelope {
  // Anything but a whole number of at least one is the default, never a way to
  // switch the check off.
  const maxHistoryPoints =
    Number.isSafeInteger(options.maxHistoryPoints) &&
    (options.maxHistoryPoints as number) >= 1
      ? (options.maxHistoryPoints as number)
      : ANALYTICS_OVERVIEW_HISTORY_POINTS;
  try {
    if (
      !safeTree(value) ||
      !object(value) ||
      !keys(value, [
        "schemaVersion",
        "presentation",
        "ready",
        "publication",
        "request",
        "asOf",
        "networks",
        "sources",
        "inventory",
        "totals",
        "networkTotals",
        "categories",
        "history",
        ...(Object.hasOwn(value, "contributions") ? ["contributions"] : []),
      ]) ||
      value.schemaVersion !== 1 ||
      value.ready !== true ||
      !object(value.presentation) ||
      !keys(value.presentation, ["profile", "version", "detail"]) ||
      value.presentation.profile !== "analytics-overview" ||
      value.presentation.version !== 1 ||
      value.presentation.detail !== "deferred" ||
      !isAnalyticsOverviewQuery(value.request) ||
      (expected &&
        analyticsOverviewQueryKey(value.request) !==
          analyticsOverviewQueryKey(expected)) ||
      !object(value.publication) ||
      !keys(value.publication, ["id", "generatedAt", "status"]) ||
      !text(value.publication.id, 100) ||
      !value.publication.id ||
      !date(value.publication.generatedAt) ||
      !["live", "partial", "cached", "offline"].includes(
        value.publication.status as string,
      ) ||
      !date(value.asOf) ||
      !Array.isArray(value.networks) ||
      value.networks.length > 100 ||
      !value.networks.every(
        (n) =>
          object(n) &&
          keys(n, ["slug", "name"]) &&
          slug(n.slug) &&
          text(n.name, 200),
      ) ||
      new Set(value.networks.map((n) => n.slug)).size !==
        value.networks.length ||
      (value.request.chain !== "all" &&
        !value.networks.some(
          (n) => n.slug === (value.request as AnalyticsOverviewQuery).chain,
        )) ||
      !Array.isArray(value.sources) ||
      value.sources.length > 1000 ||
      !value.sources.every(
        (s) =>
          object(s) &&
          text(s.id, 200) &&
          text(s.name, 400) &&
          text(s.url) &&
          text(s.note, 16000) &&
          maybeDate(s.updatedAt) &&
          ["live", "cached", "unavailable"].includes(s.status as string),
      ) ||
      !(value.inventory === null || inventory(value.inventory)) ||
      !totals(value.totals, value.request.window) ||
      !Array.isArray(value.networkTotals) ||
      value.networkTotals.length > 100 ||
      !value.networkTotals.every(
        (n) =>
          object(n) &&
          slug(n.chain) &&
          text(n.name, 200) &&
          amount(n.volumeShare) &&
          (n.inventory === null || networkInventory(n.inventory)) &&
          typeof n.caughtUp === "boolean" &&
          typeof n.headFresh === "boolean" &&
          totals(n, (value.request as AnalyticsOverviewQuery).window),
      ) ||
      new Set(value.networkTotals.map((n) => n.chain)).size !==
        value.networkTotals.length ||
      !object(value.categories) ||
      !keys(value.categories, ["volume", "reserves"]) ||
      !object(value.history) ||
      !keys(value.history, ["available", "points"]) ||
      value.history.available !== (value.request.chain === "all") ||
      !Array.isArray(value.history.points) ||
      value.history.points.length > maxHistoryPoints ||
      (!value.history.available && value.history.points.length > 0) ||
      !value.history.points.every(
        (p) =>
          object(p) &&
          keys(p, ["timestamp", "value"]) &&
          count(p.timestamp) &&
          amount(p.value) &&
          p.value !== null &&
          (p.timestamp < 1e12 ? p.timestamp * 1000 : p.timestamp) <=
            Date.parse(value.asOf as string),
      )
    )
      return false;
    const dto = value as unknown as AnalyticsOverviewEnvelope;
    const at = Date.parse(dto.asOf);
    const validAt = (proof: MetricFreshness) =>
      proof.currentPools === 0 ||
      (!!proof.expiresAt &&
        Date.parse(proof.expiresAt) > at &&
        !!proof.newestAt &&
        Date.parse(proof.newestAt) <= at + MARKET_CLOCK_SKEW_MS);
    const validTotalsAt = (row: OverviewTotals) =>
      [row.freshness.liquidity, ...Object.values(row.freshness.volume)].every(
        validAt,
      );
    if (!validTotalsAt(dto.totals) || !dto.networkTotals.every(validTotalsAt))
      return false;
    const wanted =
      dto.request.chain === "all"
        ? dto.networks.map((n) => n.slug)
        : [dto.request.chain];
    if (
      dto.networkTotals.length !== wanted.length ||
      dto.networkTotals.some((n) => !wanted.includes(n.chain))
    )
      return false;
    if (
      dto.networkTotals.some(
        (n) => n.inventory !== null && n.inventory.chain !== n.chain,
      )
    )
      return false;
    for (const field of [
      "samplePools",
      "volumePools",
      "liquidityPools",
      "activePools",
      "unattributedPools",
    ] as const)
      if (
        dto.networkTotals.reduce((sum, row) => sum + row[field], 0) !==
        dto.totals[field]
      )
        return false;
    const metricProof = (proof: MetricFreshness) =>
      isMarketFreshness({
        maxAgeMs: 300000,
        expiresAt: proof.expiresAt,
        liquidity: proof,
        volume: { h1: proof, h6: proof, h24: proof },
      });
    // Different partitions add the same finite operands in different orders.
    // Tolerance covers rounding only; absent/overflowing sums remain unknown.
    const equalSum = (a: number, b: number) =>
      a === b || Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 1e-11;
    const partition = (
      rows: { value: number | null; measuredPools: number }[],
      total: number | null,
    ) => {
      if (rows.some((r) => r.measuredPools > 0 && r.value === null))
        return total === null;
      const measured = rows.filter((r) => r.measuredPools > 0);
      const sum = measured.reduce((sum, r) => sum + r.value!, 0);
      return measured.length === 0 || !Number.isFinite(sum)
        ? total === null
        : total !== null && equalSum(sum, total);
    };
    const validShare = (
      value: number | null,
      total: number | null,
      share: number | null,
    ) => {
      const quotient =
        value !== null && total !== null && total > 0 ? value / total : null;
      return (
        share ===
        (quotient !== null && Number.isFinite(quotient) ? quotient : null)
      );
    };
    for (const [valueField, countField] of [
      ["volumeUsd", "volumePools"],
      ["liquidityUsd", "liquidityPools"],
    ] as const)
      if (
        !partition(
          dto.networkTotals.map((n) => ({
            value: n[valueField],
            measuredPools: n[countField],
          })),
          dto.totals[valueField],
        )
      )
        return false;
    if (
      dto.networkTotals.some(
        (n) => !validShare(n.volumeUsd, dto.totals.volumeUsd, n.volumeShare),
      )
    )
      return false;
    const names = (rows: OverviewCategory[]) =>
      rows
        .map((r) => r.category)
        .sort()
        .join("|");
    if (
      !Array.isArray(dto.categories.volume) ||
      !Array.isArray(dto.categories.reserves) ||
      names(dto.categories.volume) !== names(dto.categories.reserves)
    )
      return false;
    for (const metric of ["volume", "reserves"] as const) {
      const rows = dto.categories[metric];
      if (
        !Array.isArray(rows) ||
        rows.length > categoryNames.length ||
        new Set(rows.map((r) => r.category)).size !== rows.length ||
        !rows.every(
          (r) =>
            object(r) &&
            keys(r, [
              "category",
              "value",
              "share",
              "measuredPools",
              "color",
              "freshness",
            ]) &&
            categoryNames.includes(r.category) &&
            amount(r.value) &&
            amount(r.share) &&
            count(r.measuredPools) &&
            /^#[0-9a-f]{6}$/i.test(r.color) &&
            metricProof(r.freshness) &&
            validAt(r.freshness) &&
            r.measuredPools === r.freshness.currentPools &&
            (r.measuredPools > 0 || r.value === null),
        )
      )
        return false;
      const poolCount =
        metric === "volume"
          ? dto.totals.volumePools
          : dto.totals.liquidityPools;
      if (rows.reduce((sum, r) => sum + r.measuredPools, 0) !== poolCount)
        return false;
      const total =
        metric === "volume" ? dto.totals.volumeUsd : dto.totals.liquidityUsd;
      if (
        !partition(rows, total) ||
        rows.some((r) => !validShare(r.value, total, r.share))
      )
        return false;
    }
    return validateAnalyticsContributions(dto);
  } catch {
    return false;
  }
}

/** An aggregate is indivisible: after its first contributor expires, do not
 * invent the value of the remaining subset. A new response re-evaluates it. */
export function overviewMetricCurrent(
  proof: MetricFreshness,
  now: number,
): boolean {
  return (
    Number.isFinite(now) &&
    !!proof.expiresAt &&
    Date.parse(proof.expiresAt) > now &&
    !!proof.newestAt &&
    Date.parse(proof.newestAt) <= now + MARKET_CLOCK_SKEW_MS
  );
}
export function analyticsOverviewExpiresAt(
  envelope: AnalyticsOverviewEnvelope,
  now = Date.parse(envelope.asOf),
): number | null {
  if (envelope.contributions) {
    const field =
      envelope.request.window === "h1"
        ? 4
        : envelope.request.window === "h6"
          ? 5
          : 6;
    let expiry = Infinity;
    for (const row of envelope.contributions.rows) {
      if (row[field] === null && row[7] === null) continue;
      const deadline = Date.parse(row[3]) + 300000;
      if (deadline > now) expiry = Math.min(expiry, deadline);
    }
    return Number.isFinite(expiry) ? expiry : null;
  }
  const clocks = [
    envelope.totals.freshness.liquidity,
    envelope.totals.freshness.volume[envelope.request.window],
  ].map((p) => (p.expiresAt === null ? Infinity : Date.parse(p.expiresAt)));
  const time = Math.min(...clocks);
  return Number.isFinite(time) ? time : null;
}
