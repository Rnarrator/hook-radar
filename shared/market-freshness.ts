import type {
  MarketFreshness,
  MetricFreshness,
  Pool,
  ProjectMetrics,
  RadarProject,
  RadarSnapshot,
  WindowKey,
} from "./types";

/** The providers are refreshed on a five-minute cadence. A rolling observation
 * may contribute only until that age; refreshing metadata never renews it. */
export const MARKET_MAX_AGE_MS = 5 * 60 * 1000;
export const MARKET_CLOCK_SKEW_MS = 60 * 1000;
export type MarketMetric = WindowKey | "liquidity";
export type MarketMeasurementState = "current" | "stale" | "unknown";
const metrics = ["liquidity", "h1", "h6", "h24"] as const;

export function isMarketFreshness(value: unknown): value is MarketFreshness {
  if (!value || typeof value !== "object") return false;
  const row = value as MarketFreshness;
  const date = (time: unknown) => freshnessDateTime(time) !== null;
  const optionalDate = (time: unknown) => time === null || date(time);
  const measurement = (item: MetricFreshness | undefined) =>
    !!item &&
    [
      item.observedPools,
      item.currentPools,
      item.stalePools,
      item.unknownPools,
    ].every((number) => Number.isSafeInteger(number) && number >= 0) &&
    item.currentPools + item.stalePools + item.unknownPools ===
      item.observedPools &&
    [item.oldestAt, item.newestAt, item.latestObservedAt, item.expiresAt].every(
      optionalDate,
    ) &&
    (item.currentPools === 0
      ? item.oldestAt === null &&
        item.newestAt === null &&
        item.expiresAt === null
      : date(item.oldestAt) &&
        date(item.newestAt) &&
        date(item.latestObservedAt) &&
        date(item.expiresAt) &&
        freshnessDateTime(item.oldestAt)! <=
          freshnessDateTime(item.newestAt)! &&
        freshnessDateTime(item.newestAt)! <=
          freshnessDateTime(item.latestObservedAt)! &&
        freshnessDateTime(item.expiresAt)! ===
          freshnessDateTime(item.oldestAt)! + MARKET_MAX_AGE_MS);
  const valid =
    row.maxAgeMs === MARKET_MAX_AGE_MS &&
    optionalDate(row.expiresAt) &&
    measurement(row.liquidity) &&
    !!row.volume &&
    (["h1", "h6", "h24"] as const).every((metric) =>
      measurement(row.volume[metric]),
    );
  if (!valid) return false;
  const expiries = [row.liquidity, row.volume.h1, row.volume.h6, row.volume.h24]
    .map((item) => item.expiresAt)
    .filter((time): time is string => time !== null)
    .sort();
  return row.expiresAt === (expiries[0] || null);
}

const metricProofKeys = [
  "observedPools",
  "currentPools",
  "stalePools",
  "unknownPools",
  "oldestAt",
  "newestAt",
  "latestObservedAt",
  "expiresAt",
] as const;
const volumeProofKeys = ["h1", "h6", "h24"] as const;
const freshnessProofKeys = [
  "maxAgeMs",
  "expiresAt",
  "liquidity",
  "volume",
] as const;
type ProofComparison = (supplied: unknown, expected: unknown) => boolean;

function sameProofRecord(
  supplied: unknown,
  expected: unknown,
  keys: readonly string[],
  nested?: Readonly<Record<string, ProofComparison>>,
): boolean {
  if (!supplied || typeof supplied !== "object") return false;
  const prototype = Object.getPrototypeOf(supplied);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const ownKeys = Reflect.ownKeys(supplied);
  if (ownKeys.length !== keys.length) return false;
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    if (ownKeys[index] !== key) return false;
    const descriptor = Object.getOwnPropertyDescriptor(supplied, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
      return false;
    const value = (expected as Record<string, unknown>)[key];
    if (nested?.[key]) {
      if (!nested[key](descriptor.value, value)) return false;
    } else if (descriptor.value !== value) return false;
  }
  return true;
}

const sameMetricProof: ProofComparison = (supplied, expected) =>
  sameProofRecord(supplied, expected, metricProofKeys);
const metricProofComparisons = {
  h1: sameMetricProof,
  h6: sameMetricProof,
  h24: sameMetricProof,
};
const sameVolumeProof: ProofComparison = (supplied, expected) =>
  sameProofRecord(supplied, expected, volumeProofKeys, metricProofComparisons);
const freshnessProofComparisons = {
  liquidity: sameMetricProof,
  volume: sameVolumeProof,
};

/** The expected proof was just derived from every loaded observation. Exact
 * own data fields establish the same valid proof without validating it again
 * and serializing both trees. Unknown fields, accessors and unusual objects
 * take the normal replacement path; partial aggregates still need validation. */
function sameComputedFreshness(supplied: unknown, expected: MarketFreshness) {
  return sameProofRecord(
    supplied,
    expected,
    freshnessProofKeys,
    freshnessProofComparisons,
  );
}

// Pool rows are reused across freshness, analytics and provenance views. Cache
// only validation of the supplied clock; age and future skew remain per-read.
// Checking the raw input also keeps mutable callers from reusing an old clock.
interface ObservationClock {
  value: unknown;
  time: number | null;
  iso: string | null;
  expiryIso: string | null;
}
const observationClocks = new WeakMap<object, ObservationClock>();
// Each publication recreates pool objects, but many pools share the same source
// clock. Reuse only strictly validated strings across those objects. The fixed
// bound prevents retained clocks from growing with the lifetime of the client.
const validatedClocks = new Map<string, ObservationClock>();
const VALIDATED_CLOCK_LIMIT = 8192;

function rememberClock(clock: ObservationClock) {
  if (validatedClocks.size >= VALIDATED_CLOCK_LIMIT)
    validatedClocks.delete(validatedClocks.keys().next().value!);
  validatedClocks.set(clock.value as string, clock);
}

// Proofs require millisecond-canonical dates. Their structure and arithmetic are
// revalidated on every read; only immutable string parsing is shared with pools.
function freshnessDateTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const known = validatedClocks.get(value);
  if (known?.iso === value) return known.time;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value)
    return null;
  rememberClock({
    value,
    time,
    iso: value,
    expiryIso: new Date(time + MARKET_MAX_AGE_MS).toISOString(),
  });
  return time;
}

export function marketObservationTime(
  pool: Pick<Pool, "metricUpdatedAt">,
  now = Date.now(),
) {
  if (!pool || typeof pool !== "object") return null;
  const value = pool.metricUpdatedAt;
  const previous = observationClocks.get(pool);
  let parsed = previous;
  if (!parsed || parsed.value !== value) {
    parsed = typeof value === "string" ? validatedClocks.get(value) : undefined;
  }
  if (!parsed || parsed.value !== value) {
    let time: number | null = null;
    let iso: string | null = null;
    let expiryIso: string | null = null;
    if (
      typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    ) {
      const candidate = Date.parse(value);
      const canonical = value.replace(
        /(?:\.(\d{1,3}))?Z$/,
        (_, fraction: string | undefined) =>
          `.${(fraction || "").padEnd(3, "0")}Z`,
      );
      if (
        Number.isFinite(candidate) &&
        candidate >= 0 &&
        new Date(candidate).toISOString() === canonical
      ) {
        time = candidate;
        iso = canonical;
        expiryIso = new Date(candidate + MARKET_MAX_AGE_MS).toISOString();
      }
    }
    parsed = { value, time, iso, expiryIso };
    if (time !== null && typeof value === "string") rememberClock(parsed);
  }
  if (parsed !== previous) observationClocks.set(pool, parsed);
  const time = parsed.time;
  return time !== null && time >= 0 && time <= now + MARKET_CLOCK_SKEW_MS
    ? time
    : null;
}

export function marketMeasurementState(
  pool: Pick<Pool, "metricUpdatedAt" | "metricStatus">,
  now = Date.now(),
): MarketMeasurementState {
  const time = marketObservationTime(pool, now);
  if (time === null || !["live", "cached"].includes(pool.metricStatus || ""))
    return "unknown";
  return now - time < MARKET_MAX_AGE_MS ? "current" : "stale";
}

export function observedMetricValue(
  pool: Pick<Pool, "liquidityUsd" | "volumeUsd">,
  metric: MarketMetric,
): number | null {
  const value =
    metric === "liquidity" ? pool.liquidityUsd : pool.volumeUsd?.[metric];
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

export function currentMetricValue(
  pool: Pool,
  metric: MarketMetric,
  now = Date.now(),
): number | null {
  return marketMeasurementState(pool, now) === "current"
    ? observedMetricValue(pool, metric)
    : null;
}

function emptyMetric(): MetricFreshness {
  return {
    observedPools: 0,
    currentPools: 0,
    stalePools: 0,
    unknownPools: 0,
    oldestAt: null,
    newestAt: null,
    latestObservedAt: null,
    expiresAt: null,
  };
}

/** Raw observations are preserved in pools. Only age-checked, exact-pool amounts
 * enter current totals; a real measured zero remains zero. Window endpoints can
 * stay within the five-minute age budget, with a one-minute source-clock
 * tolerance, rather than mixing days of data. */
function complete<T>(steps: Generator<void, T>): T {
  while (true) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

type MarketAggregate = {
  liquidityUsd: number | null;
  volumeUsd: Record<WindowKey, number | null>;
  freshness: MarketFreshness;
};

/** Server callers yield bounded work without exposing a partial total. Pure
 * callers and the browser use the synchronous wrapper over these same steps. */
export function* aggregateCurrentMarketsSteps(
  pools: readonly Pool[],
  now = Date.now(),
): Generator<void, MarketAggregate> {
  const rows = Object.fromEntries(
    metrics.map((metric) => [metric, emptyMetric()]),
  ) as Record<MarketMetric, MetricFreshness>;
  const sums: Record<MarketMetric, number> = {
    liquidity: 0,
    h1: 0,
    h6: 0,
    h24: 0,
  };
  let nextExpiry = Infinity;
  let work = 0;
  for (const pool of pools) {
    if (++work % 256 === 0) yield;
    const time = marketObservationTime(pool, now);
    const state =
      time === null || !["live", "cached"].includes(pool.metricStatus || "")
        ? "unknown"
        : now - time < MARKET_MAX_AGE_MS
          ? "current"
          : "stale";
    const volume = pool.volumeUsd;
    const clock = time === null ? null : observationClocks.get(pool);
    const iso = clock?.iso ?? null;
    const expiryIso = clock?.expiryIso ?? null;
    for (const metric of metrics) {
      const value =
        metric === "liquidity" ? pool.liquidityUsd : volume?.[metric];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
        continue;
      const row = rows[metric];
      row.observedPools++;
      if (iso !== null) {
        if (!row.latestObservedAt || iso > row.latestObservedAt)
          row.latestObservedAt = iso;
      }
      if (state !== "current" || time === null) {
        if (state === "stale") row.stalePools++;
        else row.unknownPools++;
        continue;
      }
      row.currentPools++;
      sums[metric] += value;
      if (iso === null || expiryIso === null) continue;
      if (!row.oldestAt || iso < row.oldestAt) row.oldestAt = iso;
      if (!row.newestAt || iso > row.newestAt) row.newestAt = iso;
      const expiry = time + MARKET_MAX_AGE_MS;
      if (!row.expiresAt || expiryIso < row.expiresAt)
        row.expiresAt = expiryIso;
      nextExpiry = Math.min(nextExpiry, expiry);
    }
  }
  const total = (metric: MarketMetric) =>
    rows[metric].currentPools > 0 && Number.isFinite(sums[metric])
      ? sums[metric]
      : null;
  const freshness: MarketFreshness = {
    maxAgeMs: MARKET_MAX_AGE_MS,
    expiresAt: Number.isFinite(nextExpiry)
      ? new Date(nextExpiry).toISOString()
      : null,
    liquidity: rows.liquidity,
    volume: { h1: rows.h1, h6: rows.h6, h24: rows.h24 },
  };
  return {
    liquidityUsd: total("liquidity"),
    volumeUsd: { h1: total("h1"), h6: total("h6"), h24: total("h24") },
    freshness,
  };
}

export function aggregateCurrentMarkets(
  pools: readonly Pool[],
  now = Date.now(),
) {
  return complete(aggregateCurrentMarketsSteps(pools, now));
}

export function* currentProjectMetricsSteps(
  project: RadarProject,
  pools: readonly Pool[],
  now = Date.now(),
): Generator<void, ProjectMetrics> {
  return {
    ...project.metrics,
    ...(yield* aggregateCurrentMarketsSteps(pools, now)),
    poolCount: pools.length || null,
    coverage: pools.length ? "partial" : "unavailable",
  };
}

export function currentProjectMetrics(
  project: RadarProject,
  pools: readonly Pool[],
  now = Date.now(),
): ProjectMetrics {
  return complete(currentProjectMetricsSteps(project, pools, now));
}

/** A remote directory row may contain only an aggregate. Drop the whole metric
 * at its earliest contributing expiry until a complete observation sample or
 * a newer server aggregate arrives. This never invents a subset total. */
export function expireProjectMetrics(
  project: RadarProject,
  now = Date.now(),
): RadarProject {
  const prior = isMarketFreshness(project.metrics.freshness)
    ? project.metrics.freshness
    : undefined;
  const stillCurrent = (row: MetricFreshness | undefined) =>
    !!row?.expiresAt &&
    Date.parse(row.expiresAt) > now &&
    !!row.newestAt &&
    Date.parse(row.newestAt) <= now + MARKET_CLOCK_SKEW_MS;
  const liquidityUsd = stillCurrent(prior?.liquidity)
    ? project.metrics.liquidityUsd
    : null;
  const volumeUsd = {
    h1: stillCurrent(prior?.volume.h1) ? project.metrics.volumeUsd.h1 : null,
    h6: stillCurrent(prior?.volume.h6) ? project.metrics.volumeUsd.h6 : null,
    h24: stillCurrent(prior?.volume.h24) ? project.metrics.volumeUsd.h24 : null,
  };
  if (
    liquidityUsd === project.metrics.liquidityUsd &&
    metrics
      .slice(1)
      .every(
        (metric) =>
          volumeUsd[metric as WindowKey] ===
          project.metrics.volumeUsd[metric as WindowKey],
      )
  )
    return project;
  return {
    ...project,
    metrics: { ...project.metrics, liquidityUsd, volumeUsd },
  };
}

const refreshed = new WeakMap<
  RadarSnapshot,
  { next: number; at: number; value: RadarSnapshot }
>();
type FreshnessBody = {
  next: number;
  at: number;
  projects: RadarProject[];
  aggregate: ReturnType<typeof aggregateCurrentMarkets>;
  byProject: Map<string, Pool[]>;
  projectStates: Map<
    RadarProject,
    { at: number; next: number; value: RadarProject }
  >;
};
// Metadata-only publications retain these immutable arrays. Reuse only their
// derived amounts, within the exact expiry/skew interval; current generation
// metadata and structural summary counts always come from the caller's frame.
const freshnessBodies = new WeakMap<
  RadarProject[],
  WeakMap<Pool[], FreshnessBody>
>();

function rememberFreshnessBody(
  projects: RadarProject[],
  pools: Pool[],
  body: FreshnessBody,
) {
  let byPools = freshnessBodies.get(projects);
  if (!byPools) {
    byPools = new WeakMap();
    freshnessBodies.set(projects, byPools);
  }
  byPools.set(pools, body);
}

/** Also used by the browser's minute clock. No source timestamp, generatedAt,
 * history, census count or raw amount is changed by time passing. The normal
 * lean payload retains all market observations. If an independently hydrated
 * row lacks its full sample, expire its published total conservatively instead
 * of replacing a full aggregate with the loaded subset. */
export function* refreshMarketSnapshotSteps(
  snapshot: RadarSnapshot,
  now = Date.now(),
): Generator<void, RadarSnapshot> {
  const saved = refreshed.get(snapshot);
  if (saved && now >= saved.at && now < saved.next) return saved.value;
  const body = freshnessBodies.get(snapshot.projects)?.get(snapshot.pools);
  if (body && now >= body.at && now < body.next) {
    const value = {
      ...snapshot,
      projects: body.projects,
      summary: { ...snapshot.summary, ...body.aggregate },
    };
    const completed = { at: body.at, next: body.next, value };
    refreshed.set(snapshot, completed);
    refreshed.set(value, completed);
    return value;
  }
  const byProject = body?.byProject || new Map<string, Pool[]>();
  const projectStates: FreshnessBody["projectStates"] = new Map();
  const futureByProject = new Map<string, number>();
  let nextObservationChange = Infinity;
  let work = 0;
  for (const pool of snapshot.pools) {
    if (++work % 256 === 0) yield;
    // A clock correction can temporarily put a real observation beyond the
    // accepted skew. Reconsider it when its original timestamp becomes valid.
    const suppliedTime = marketObservationTime(pool, Infinity);
    if (suppliedTime !== null && suppliedTime > now + MARKET_CLOCK_SKEW_MS) {
      const resumesAt = suppliedTime - MARKET_CLOCK_SKEW_MS;
      nextObservationChange = Math.min(nextObservationChange, resumesAt);
      if (pool.projectId)
        futureByProject.set(
          pool.projectId,
          Math.min(futureByProject.get(pool.projectId) ?? Infinity, resumesAt),
        );
    }
    if (!pool.projectId || body) continue;
    const rows = byProject.get(pool.projectId) || [];
    rows.push(pool);
    byProject.set(pool.projectId, rows);
  }
  const aggregate = yield* aggregateCurrentMarketsSteps(snapshot.pools, now);
  // Most published frames already contain the exact current amounts. Retain
  // their immutable catalog until a row actually changes; building a second
  // full census array for every unchanged price publication creates avoidable
  // allocation pressure on both server requests and browser minute ticks.
  let projects = snapshot.projects;
  let nextProjectExpiry = Infinity;
  for (
    let projectIndex = 0;
    projectIndex < snapshot.projects.length;
    projectIndex++
  ) {
    const project = snapshot.projects[projectIndex];
    if (++work % 512 === 0) yield;
    const supplied = project.metrics;
    // Most census families have never supplied an observation. They have no
    // clock to age or resume, so retain the exact row without allocating a
    // per-family cache record on every price publication. Partial proofs and
    // every loaded sample still follow the full exact-time path below.
    if (
      !byProject.has(project.id) &&
      supplied.freshness === undefined &&
      supplied.liquidityUsd === null &&
      supplied.volumeUsd.h1 === null &&
      supplied.volumeUsd.h6 === null &&
      supplied.volumeUsd.h24 === null
    ) {
      if (projects !== snapshot.projects) projects.push(project);
      continue;
    }
    const prior = body?.projectStates.get(project);
    const reusable = prior && now >= prior.at && now < prior.next;
    const nextProject = reusable
      ? prior.value
      : yield* refreshProjectSteps(project);
    if (nextProject !== project && projects === snapshot.projects) {
      projects = [];
      // A late expiry can affect the last row of a very large census. Keep
      // this first copy cooperative rather than blocking for a whole slice.
      for (let index = 0; index < projectIndex; index++) {
        projects.push(snapshot.projects[index]);
        if (++work % 512 === 0) yield;
      }
    }
    if (projects !== snapshot.projects) projects.push(nextProject);
    const freshness = nextProject.metrics.freshness;
    const expiry = reusable
      ? prior.next
      : Math.min(
          ...metrics.map((metric) => {
            const row =
              metric === "liquidity"
                ? freshness?.liquidity
                : freshness?.volume?.[metric];
            const at = Date.parse(row?.expiresAt || "");
            return at > now ? at : Infinity;
          }),
        );
    if (expiry > now) nextProjectExpiry = Math.min(nextProjectExpiry, expiry);
    // One pool's expiry must not rebuild every unrelated project's aggregates.
    // This cache shares the existing immutable input-array contract and keeps
    // each project's own expiry/future-skew boundary, including clock rollback.
    const state = reusable
      ? prior
      : {
          at: now,
          next: Math.min(
            expiry > now ? expiry : Infinity,
            futureByProject.get(project.id) ?? Infinity,
          ),
          value: nextProject,
        };
    projectStates.set(project, state);
    projectStates.set(nextProject, state);
    nextObservationChange = Math.min(nextObservationChange, state.next);
  }
  function* refreshProjectSteps(
    project: RadarProject,
  ): Generator<void, RadarProject> {
    const pools = byProject.get(project.id) || [];
    if (
      project.metrics.poolCount !== null &&
      pools.length < project.metrics.poolCount
    ) {
      const freshness = project.metrics.freshness;
      if (isMarketFreshness(freshness)) {
        // A partial row can retain an original aggregate whose source clock
        // temporarily exceeds the allowed skew. Revisit that original frame
        // when its proof becomes current, just as we do for raw pool rows.
        // Already-derived null totals remain unknown: this cannot recreate
        // omitted observations or renew an expired aggregate.
        for (const metric of metrics) {
          if (observedMetricValue(project.metrics, metric) === null) continue;
          const row =
            metric === "liquidity"
              ? freshness.liquidity
              : freshness.volume[metric];
          const resumesAt =
            Date.parse(row.newestAt || "") - MARKET_CLOCK_SKEW_MS;
          if (resumesAt > now && resumesAt < Date.parse(row.expiresAt || "")) {
            nextObservationChange = Math.min(nextObservationChange, resumesAt);
            futureByProject.set(
              project.id,
              Math.min(futureByProject.get(project.id) ?? Infinity, resumesAt),
            );
          }
        }
      }
      return expireProjectMetrics(project, now);
    }
    if (
      !pools.length &&
      project.metrics.liquidityUsd === null &&
      (["h1", "h6", "h24"] as const).every(
        (metric) => project.metrics.volumeUsd[metric] === null,
      )
    )
      return project;
    const next = yield* currentProjectMetricsSteps(project, pools, now);
    const before = project.metrics;
    if (
      before.poolCount === next.poolCount &&
      before.liquidityUsd === next.liquidityUsd &&
      (["h1", "h6", "h24"] as const).every(
        (metric) => before.volumeUsd[metric] === next.volumeUsd[metric],
      ) &&
      sameComputedFreshness(before.freshness, next.freshness!)
    )
      return project;
    return { ...project, metrics: next };
  }
  const value = {
    ...snapshot,
    projects,
    summary: { ...snapshot.summary, ...aggregate },
  };
  // Past partial-row boundaries cannot force every reader to rebuild a frame.
  const next = Math.min(
    nextProjectExpiry,
    nextObservationChange,
    aggregate.freshness.expiresAt
      ? Date.parse(aggregate.freshness.expiresAt)
      : Infinity,
  );
  const published = refreshed.get(snapshot);
  if (published && now >= published.at && now < published.next)
    return published.value;
  if (
    published &&
    published.value.projects.length === projects.length &&
    JSON.stringify(published.value.summary) === JSON.stringify(value.summary)
  ) {
    // A synchronous reader may finish first at a slightly later clock. Reuse
    // its complete frame only after exact output equality, including every
    // expiry/skew proof, rather than assuming that time did not cross a boundary.
    let same = true;
    for (let index = 0; index < projects.length; index++) {
      if (++work % 512 === 0) yield;
      const prior = published.value.projects[index];
      const project = projects[index];
      if (
        prior !== project &&
        JSON.stringify(prior.metrics) !== JSON.stringify(project.metrics)
      ) {
        same = false;
        break;
      }
    }
    if (same) return published.value;
  }
  refreshed.set(snapshot, { at: now, next, value });
  refreshed.set(value, { at: now, next, value });
  const completedBody = {
    at: now,
    next,
    projects: value.projects,
    aggregate,
    byProject,
    projectStates,
  };
  rememberFreshnessBody(snapshot.projects, snapshot.pools, completedBody);
  rememberFreshnessBody(value.projects, snapshot.pools, completedBody);
  return value;
}

export function refreshMarketSnapshot(
  snapshot: RadarSnapshot,
  now = Date.now(),
): RadarSnapshot {
  return complete(refreshMarketSnapshotSteps(snapshot, now));
}
