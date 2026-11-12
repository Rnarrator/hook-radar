#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COLLECTOR_VERSION,
  DAILY_LATEST_START_MS,
  DAILY_MAX_REQUESTS,
  DISCOVERY_BUDGET_MS,
  DS_BATCH_SIZE,
  FRONTIER_LATEST_START_MS,
  FRONTIER_MAX_REQUESTS,
  GT_FALLBACK_MAX_REQUESTS,
  LANE_DISCOVERED_RESERVE_BATCHES,
  LANE_PERIOD_MS,
  LAST_SEEN_GRANULARITY_MS,
  MAX_DISCOVERED_MEASURED,
  MAX_MEASURED_POOLS,
  MAX_RESOLVES_PER_RUN,
  MIN_CURRENT_POOLS,
  resolveDailyMaxRequests,
  resolveFullPlan,
  resolveGaps,
  resolveMaxDiscovery,
  resolveRateLimitCap,
  resolveRetryMaxBatches,
  STATE_MAX_POOLS,
  userAgent,
} from "./config.mjs";
import {
  assembleSnapshot,
  currentPoolCount,
  providerSources,
  validSnapshot,
} from "./assemble.mjs";
import {
  buildDailyDataset,
  collectDaily,
  currentMeasured,
  dailySource,
  emptyDailyReport,
  rankPools,
  selectDaily,
} from "./daily.mjs";
import { discoverPools, discoveryChains, discoveryStats } from "./discover.mjs";
import { historyPointFor } from "./history.mjs";
import { withGeckoBookmarks } from "./fallback.mjs";
import { createHttpClient } from "./http.mjs";
import { laneNetworkGuard, withLaneGuard } from "./lane-guard.mjs";
import {
  byPriority,
  decidePlanMode,
  decidePlanSafely,
  LANES,
  measurementChains,
  planMeasurement,
  planSafely,
  REQUESTED_FULL_PLAN_REASONS,
  runBurst,
} from "./measure.mjs";
import { createFixtureTransport } from "./offline.mjs";
import { buildOverviewFiles } from "./overview.mjs";
import {
  collectFrontier,
  overlayFrontier,
  skippedFrontier,
  withFrontierNetworks,
} from "./providers/frontier.mjs";
import { discoveryPage } from "./providers/geckoterminal.mjs";
import { assessQuality } from "./quality.mjs";
import { loadRegistry } from "./registry.mjs";
import {
  dailyJson,
  historyJson,
  nextCursors,
  poolKey,
  readState,
  writeFileAtomic,
  writeState,
} from "./state.mjs";
import {
  assertTraceAllowed,
  formatTrace,
  parseTraceList,
  traceReport,
} from "./trace.mjs";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const FIXTURES = join(ROOT, "collector", "fixtures");
const RUN_SLOT_MS = 3 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

/** The requests the burst, its fallback and the Frontier step can need for a
 * plan of `maxPools` pools. Batches are rounded up per network, so the plan can
 * need one more request for each network the providers price than maxPools / 30
 * alone. */
export function requestReserve(maxPools) {
  return (
    Math.ceil(maxPools / DS_BATCH_SIZE) +
    measurementChains().length +
    GT_FALLBACK_MAX_REQUESTS +
    FRONTIER_MAX_REQUESTS
  );
}

/** `requestReserve` for the lane plan: the batches of the plan made before
 * discovery (already rounded up per network), room for the pools discovery adds
 * to it, the fallback and Frontier's step. The plan that is sent after discovery
 * is cut at LANE_MAX_BATCHES where it can be, so this is an upper bound on what
 * the burst needs unless HOT and NEW alone exceed the ceiling. */
export function laneRequestReserve(plan) {
  return (
    plan.batches +
    LANE_DISCOVERED_RESERVE_BATCHES +
    GT_FALLBACK_MAX_REQUESTS +
    FRONTIER_MAX_REQUESTS
  );
}

/** The discovery the request budget still allows once the measurement burst,
 * its fallback and the registry fetches are reserved. */
export function fitDiscovery({ lists, resolves, allowance }) {
  let n = lists;
  let r = resolves;
  while (2 * n + r > allowance && (r > 0 || n > 0)) {
    if (r > 0) r--;
    else n--;
  }
  return { lists: Math.max(0, n), resolves: Math.max(0, r) };
}

/** The priority list as the run uses it: every key on it, and a state record
 * for each pool the state does not hold yet. Such a record is a seeded pool like
 * any other (its identity comes from the live app's census, which the list was
 * made from), first and last seen when the list was exported; the state keeps it
 * from the first run that follows. */
export function priorityPlan(priority, known) {
  const keys = new Set();
  const fresh = [];
  for (const row of priority?.pools ?? []) {
    const key = poolKey(row.chain, row.id);
    keys.add(key);
    if (known.has(key)) continue;
    fresh.push({
      id: row.id,
      chain: row.chain,
      hookAddress: row.hookAddress,
      tokens: [...row.tokens],
      name: row.name,
      createdAt: row.createdAt,
      source: "census",
      firstSeen: priority.exportedAt,
      lastSeen: priority.exportedAt,
    });
  }
  return { keys, fresh };
}

/** The pool records after a successful run: seen pools keep a quiet lastSeen,
 * discovered ones are added, and the oldest are dropped above the state cap.
 *
 * lastSeen is the last time a provider measured the pool, moved at most once a
 * day, so the committed state stays quiet. A pool whose lastSeen is still its
 * firstSeen has never been measured since it was added: its first measurement
 * stamps it at once, so a pool added and answered inside one day (a discovered
 * pool, for example) is told apart from one that has never answered. */
export function nextPools({ pools, found, measured, generatedAtMs }) {
  const stamp = iso(generatedAtMs);
  const merged = new Map();
  for (const pool of [...pools, ...found]) {
    const key = poolKey(pool.chain, pool.id);
    if (merged.has(key)) continue;
    const seen = measured.get(key);
    const stale =
      generatedAtMs - Date.parse(pool.lastSeen) >= LAST_SEEN_GRANULARITY_MS;
    // No recorded answer: its lastSeen is still its firstSeen (it was not
    // measured since it was added, or only before this rule, which stamps the
    // first answer at once).
    const unanswered = pool.lastSeen === pool.firstSeen;
    const { via: _via, ...rest } = pool;
    // Only DEX Screener and GeckoTerminal tell which of the two prices a pool;
    // a pool Frontier measured keeps what was known before.
    const via =
      seen && seen.metricProvider !== "frontier"
        ? seen.metricProvider
        : pool.via;
    merged.set(key, {
      ...rest,
      ...(via === "geckoterminal" ? { via } : {}),
      createdAt: pool.createdAt ?? seen?.createdAt ?? null,
      lastSeen: seen && (stale || unanswered) ? stamp : pool.lastSeen,
    });
  }
  return [...merged.values()].sort(byPriority).slice(0, STATE_MAX_POOLS);
}

/** What the paced client holds for each provider, as the status file states it
 * (times as UTC text; a provider that was not asked has no first or last
 * request). */
export const providerCounts = (stats) =>
  Object.fromEntries(
    Object.entries(stats).map(([id, row]) => [
      id,
      {
        requests: row.requests,
        succeeded: row.succeeded,
        failed: row.failed,
        lastStatus: row.lastStatus,
        firstRequestAt:
          row.firstRequestAt === null ? null : iso(row.firstRequestAt),
        lastRequestAt:
          row.lastRequestAt === null ? null : iso(row.lastRequestAt),
        stopped: row.stopped
          ? { ...row.stopped, at: iso(row.stopped.at) }
          : null,
      },
    ]),
  );

/** What the status file says about the plan: how the run chose it, what the
 * ceiling did, and for each lane how many pools were known, scheduled, asked,
 * answered (a provider answered for them; the same meaning as
 * counts.answeredPools) and measured (they carry a market value from a
 * provider). `lanes` is null for the full plan, which has no lanes.
 *
 * `fellBack` is true when the full plan was used although nothing asked for it:
 * the lane plan is the default, so that is the safeguard having fired (or a
 * state with nothing to start the lanes from), and the run reports it loudly.
 *
 * `guard` is the lane plan's network guard (quality.networkGuard): for each network
 * DEX Screener did not answer for, how many of its HOT and NEW pools were answered. */
export function planStatus({ plan, decision, burst, guard = null }) {
  const lanes = plan.mode === "lanes";
  const iso = (ms) => new Date(ms).toISOString();
  let laneRows = null;
  if (lanes) {
    laneRows = Object.fromEntries(
      LANES.map((lane) => [
        lane,
        {
          known: plan.lanes[lane].known,
          scheduled: plan.lanes[lane].scheduled,
          requested: 0,
          answered: 0,
          measured: 0,
        },
      ]),
    );
    for (const { chain, pools } of plan.networks)
      for (const pool of pools) {
        const key = poolKey(chain.chain, pool.id);
        const row = laneRows[plan.laneByKey.get(key)];
        if (burst.requestedKeys.has(key)) {
          row.requested++;
          if (burst.answeredKeys.has(key)) row.answered++;
        }
        if (burst.measured.has(key)) row.measured++;
      }
  }
  return {
    plan: {
      mode: plan.mode,
      reason: decision.code,
      detail: decision.detail,
      fellBack:
        decision.mode === "full" &&
        !REQUESTED_FULL_PLAN_REASONS.includes(decision.code),
      batches: plan.batches,
      maxBatches: lanes ? plan.maxBatches : null,
      ceilingBound: lanes ? plan.ceilingBound : null,
      trimmed: lanes ? { ...plan.trimmed } : null,
      newOverflow: lanes ? plan.newOverflow : null,
      hotAndNew: decision.hotAndNew ?? null,
      geckoCarried: decision.geckoCarried ?? null,
      floor: decision.floor ?? null,
      previousPools: decision.previousPools ?? null,
      periodsHours: lanes
        ? Object.fromEntries(
            Object.entries(LANE_PERIOD_MS).map(([lane, ms]) => [
              lane,
              ms / 3600000,
            ]),
          )
        : null,
      windowFrom: lanes ? iso(plan.window.fromMs) : null,
      windowTo: lanes ? iso(plan.window.toMs) : null,
      anchor: lanes ? iso(plan.window.anchorMs) : null,
      networkGuard: lanes ? guard : null,
    },
    lanes: laneRows,
  };
}

/** planStatus that cannot fail a run: the burst has been made and the gate has
 * judged it, so a status that cannot be described says so (`error`) and keeps the
 * numbers the plan itself holds, instead of throwing away a run that passed. */
export function planStatusSafely(input) {
  try {
    return planStatus(input);
  } catch (error) {
    const { plan, decision } = input;
    return {
      plan: {
        mode: plan.mode,
        reason: decision.code,
        detail: decision.detail,
        fellBack:
          decision.mode === "full" &&
          !REQUESTED_FULL_PLAN_REASONS.includes(decision.code),
        batches: plan.batches,
        error: String(error?.message ?? error)
          .replace(/\s+/g, " ")
          .slice(0, 160),
      },
      lanes: null,
    };
  }
}

function statusDocument({
  snapshot,
  collectionStartedAt,
  burst,
  quality,
  stats,
  discovery,
  state,
  offline,
  plan,
  planInfo,
  dropped,
  frontier,
  cursors,
  priority,
  daily,
}) {
  // The Frontier lane carries the configuration read at the start and the
  // market reads of the Frontier step; each source is credited its own.
  const frontierReads = frontier.requests;
  const requestsBy = {
    registry: stats.registry.requests,
    "frontier-chains":
      stats.frontier.requests -
      (frontierReads["frontier-coins"] ?? 0) -
      (frontierReads["frontier-stats"] ?? 0),
    "frontier-coins": frontierReads["frontier-coins"] ?? 0,
    "frontier-stats": frontierReads["frontier-stats"] ?? 0,
    "frontier-amm-index": frontierReads["frontier-amm-index"] ?? 0,
    dexscreener: stats.dexscreener.requests,
    // The daily-volume step reads GeckoTerminal too; its requests are a source
    // of their own, and "requests" below stays the lane's total.
    geckoterminal: stats.geckoterminal.requests - daily.requested,
    "geckoterminal-daily": daily.requested,
    v4xyz: stats.v4xyz.requests,
  };
  const total = Object.values(stats).reduce(
    (sum, row) => sum + row.requests,
    0,
  );
  return {
    generatedAt: snapshot.generatedAt,
    collectionStartedAt: iso(collectionStartedAt),
    burstStartedAt: iso(burst.startedAt),
    burstEndedAt: iso(burst.endedAt),
    counts: {
      statePools: state.pools.length,
      // The pools this run planned to ask DEX Screener about. With the lane plan
      // that is the pools asked in this snapshot (the others were not due); with
      // the full plan it is every known pool the plan could hold.
      plannedPools: plan.planned,
      plannedDiscoveredPools: plan.plannedDiscovered,
      // The pools of launchpad platforms' and named projects' exact hooks
      // (state/priority.json): how many are listed, how many the state did not
      // hold before this run, how many the plan took and how many were measured.
      priorityPools: priority,
      requestedPools: burst.requestedPools,
      answeredPools: burst.answeredPools,
      checkedPools: burst.checkedPools,
      measuredPools: burst.measured.size,
      trackedPools: snapshot.pools.length,
      currentPools: quality.checks.currentPools,
      // Pools the run would have asked about and left out because a cap was
      // reached: the pools the full plan cut, or the lane plan's batch ceiling
      // cut. Pools that were not due on their lane's wheel are not counted
      // here: they are deferredPools.
      droppedForCap: dropped,
      deferredPools: plan.deferred ?? 0,
      // How the plan was chosen, its ceiling, and the lanes (null: full plan).
      plan: planInfo.plan,
      lanes: planInfo.lanes,
      projects: snapshot.projects.length,
      deployments: snapshot.summary.indexedDeployments,
      networks: snapshot.coverage.measuredChains.length,
      discoveredPools: discovery.found.length,
      discoveredHookless: discovery.hookless.length,
      fallbackRequests: burst.fallback.requests,
      fallbackMeasured: burst.fallback.measured,
      frontier: {
        coinMarketsListed: frontier.listed,
        poolsSupplied: frontier.supplied,
        poolsAdded: frontier.added,
        poolsReplacingOlderRow: frontier.replaced,
        poolsKeptFromOtherProvider: frontier.kept,
        poolsLeftOutOnMismatch: frontier.skipped.length,
        // What the coin listing itself reported: the rows it held and its own
        // total, null when it did not answer (not zero).
        listingRows: frontier.listing.rows,
        listingTotal: frontier.listing.total,
        failure: frontier.failure,
      },
      // What each provider did in the measurement burst: DEX Screener's batches
      // (failed ones by reason), rows returned, rows rejected by reason, pools
      // asked and pools with a row; GeckoTerminal's exact-pool lookups (today the
      // fallback), failures, ids asked and pools measured per network. The names
      // are the providers' and stay so: a later kind of lookup adds to the same
      // object. The discovery pages are counts.discovery, and
      // counts.requests.geckoterminal is the client's total for both.
      dexscreener: burst.telemetry.dexscreener,
      geckoterminal: burst.telemetry.geckoterminal,
      // The paced client's own record of every provider.
      providers: providerCounts(stats),
      unsupportedNetworks: [...burst.unsupportedNetworks].sort(),
      // The networks DEX Screener did not answer for: five batches failed in a row
      // (the rest were not sent), or two or more failed and none was answered. A
      // run is refused for one only when the lane plan's guard says so
      // (counts.plan.networkGuard has the numbers).
      downNetworks: [...burst.downNetworks],
      rateLimitWaits: Object.fromEntries(
        Object.entries(stats)
          .filter(([, row]) => row.rateLimitWaits)
          .map(([id, row]) => [
            id,
            { times: row.rateLimitWaits, waitedMs: row.rateLimitWaitedMs },
          ]),
      ),
      requests: {
        total,
        ...Object.fromEntries(
          Object.entries(stats).map(([id, row]) => [id, row.requests]),
        ),
      },
      discovery: discovery.stats,
      // The bookmarks the header of pools.json carries: how many families, and
      // why a step's proposal was not used (null when none was refused).
      cursors: {
        families: Object.keys(cursors.cursors).length,
        refused: cursors.refused,
      },
      // The 7D and 30D step: what it selected, read and published, and why it
      // stopped or was left out. `requested` is part of requests.geckoterminal.
      daily,
    },
    sources: snapshot.sources.map((source) => ({
      ...source,
      ...(requestsBy[source.id] !== undefined
        ? { requests: requestsBy[source.id] }
        : {}),
    })),
    collectorVersion: COLLECTOR_VERSION,
    previousGeneratedAt: state.updatedAt,
    ...(offline ? { offline: true } : {}),
  };
}

/** One collection run. Returns the outcome; writes files only when it passed
 * the quality gate and `publish` is set. */
export async function runCollector({
  stateDir = join(ROOT, "state"),
  outDir = join(ROOT, "public", "data"),
  stateOutDir = stateDir,
  publish = true,
  offline = false,
  fixturesDir = FIXTURES,
  maxDiscovery = Infinity,
  // A cap on the plan's pools. Given, it selects the full plan (the cap belongs to
  // that plan); without it the plan is the lane plan, or the full plan at its
  // contract size when the lane plan is not used.
  maxPools = undefined,
  // Use the full plan: COLLECTOR_FULL_PLAN in the environment does the same.
  fullPlan = false,
  minCurrent = MIN_CURRENT_POOLS,
  discoveryBudgetMs = DISCOVERY_BUDGET_MS,
  discoveryPageOverride = null,
  trace = null,
  // How a step moves the bookmarks of the pools.json header: it gets a copy of
  // the cursors that were read, with the `gt` bookmarks the GeckoTerminal
  // fallback's rotation moved, and returns the cursors to keep. The fallback's own
  // move is always made; this is for a step a test adds.
  moveCursors = undefined,
  dailyMaxRequests = undefined,
  // The functions that choose and make the plan. They are decidePlanMode and
  // planMeasurement; a test gives ones that throw, to show that a planner that
  // fails costs the run its lanes (the full plan runs and says so) and never the
  // run itself.
  decidePlan = decidePlanMode,
  makePlan = planMeasurement,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  sleep,
  caps = {},
  log = () => {},
} = {}) {
  // A trace is for a person's own computer: it is refused before anything is
  // asked of a provider.
  const traceKeys = trace?.size || trace?.length ? new Set(trace) : null;
  if (traceKeys) assertTraceAllowed(env);
  let transport = null;
  if (offline) {
    transport = await createFixtureTransport(fixturesDir);
    fetchImpl = transport.fetchImpl;
    now = transport.now;
    sleep = transport.sleep;
    discoveryPageOverride ??= transport.manifest.discoveryPage ?? null;
  }
  const collectionStartedAt = now();
  const state = await readState(stateDir);
  const client = createHttpClient({
    fetchImpl,
    now,
    ...(sleep ? { sleep } : {}),
    userAgent: userAgent(env),
    gaps: resolveGaps(env),
    rateLimitCapMs: resolveRateLimitCap(env),
    caps,
    onEvent: (event) =>
      log(
        `${event.ok ? "ok  " : event.code === "cooldown" ? "WAIT" : "FAIL"} ${event.provider} ${event.status ?? event.code ?? ""}`,
      ),
  });

  log("Registry");
  const registry = await loadRegistry({ client, saved: state.registry });

  const chains = discoveryChains();
  const known = new Set(
    state.pools.map((pool) => poolKey(pool.chain, pool.id)),
  );
  const priority = priorityPlan(state.priority, known);
  for (const pool of priority.fresh) known.add(poolKey(pool.chain, pool.id));

  // Which plan the run uses is settled before discovery, on the pools the state
  // knows: the lane plan, unless the full plan was asked for or the lanes cannot
  // be trusted (see decidePlanMode). The request reserve follows from it.
  const updatedAtMs = state.updatedAt ? Date.parse(state.updatedAt) : NaN;
  const poolCap = maxPools ?? MAX_MEASURED_POOLS + MAX_DISCOVERED_MEASURED;
  // A planner that throws is the full plan with the reason planner-error (see
  // decidePlanSafely and planSafely); it never fails the run.
  let decision = decidePlanSafely(
    {
      pools: [...state.pools, ...priority.fresh],
      nowMs: collectionStartedAt,
      updatedAtMs,
      previousPoint: state.history.at(-1) ?? null,
      forced:
        maxPools !== undefined
          ? "max-pools"
          : fullPlan || resolveFullPlan(env)
            ? "forced"
            : null,
    },
    decidePlan,
  );
  let reserve = requestReserve(poolCap);
  if (decision.mode === "lanes") {
    const before = planSafely(
      [...state.pools, ...priority.fresh],
      { decision, nowMs: collectionStartedAt, updatedAtMs },
      makePlan,
    );
    decision = before.decision;
    if (before.plan.mode === "lanes") reserve = laneRequestReserve(before.plan);
  }
  log(
    `Plan: ${decision.mode}${decision.detail ? ` (${decision.detail})` : ""}`,
  );
  const wanted = Math.min(maxDiscovery, chains.length);
  const fit = fitDiscovery({
    lists: wanted,
    resolves: Math.min(
      MAX_RESOLVES_PER_RUN,
      maxDiscovery === Infinity ? MAX_RESOLVES_PER_RUN : maxDiscovery,
    ),
    allowance: client.requestsLeft() - reserve,
  });
  log(`Discovery: ${fit.lists} networks, up to ${fit.resolves} exact lookups`);
  const discovery = fit.lists
    ? await discoverPools({
        client,
        known,
        hookless: state.hookless,
        page:
          discoveryPageOverride ??
          discoveryPage(Math.floor(collectionStartedAt / RUN_SLOT_MS)),
        maxDiscovery: fit.lists,
        maxResolves: fit.resolves,
        now,
        notAfter: collectionStartedAt + discoveryBudgetMs,
        chains,
      })
    : {
        found: [],
        hookless: [],
        stats: discoveryStats(),
      };
  const pools = [...state.pools, ...priority.fresh, ...discovery.found];

  log(`Measurement burst over ${pools.length} known pools`);
  // The lane plan asks about the pools that matter for this snapshot and the
  // pools that fell due on their wheel. The full plan: seeded pools, the priority
  // list among them, fill the plan up to MAX_MEASURED_POOLS; discovery has the
  // rest, as before.
  const made = planSafely(
    pools,
    {
      decision,
      nowMs: now(),
      updatedAtMs,
      priorityKeys: priority.keys,
      full: {
        maxPools: poolCap,
        maxSeeded: Math.min(MAX_MEASURED_POOLS, poolCap),
      },
    },
    makePlan,
  );
  const plan = made.plan;
  decision = made.decision;
  if (plan.mode === "lanes")
    log(
      `Lanes: ${LANES.map((lane) => `${lane} ${plan.lanes[lane].scheduled}/${plan.lanes[lane].known}`).join(", ")}; ${plan.planned} pools in ${plan.batches} batches` +
        (plan.ceilingBound
          ? `; the ceiling of ${plan.maxBatches} batches cut ${plan.dropped} pools (warm ${plan.trimmed.warm}, cool ${plan.trimmed.cool}, cold ${plan.trimmed.cold})`
          : ""),
    );
  // `known` lets the lane plan's GeckoTerminal fallback consider every known pool,
  // not only the few the plan asked DEX Screener about.
  const dexBurst = await runBurst({
    client,
    plan,
    now,
    known: pools,
    bookmarks: state.cursors.gt ?? {},
    // How many failed batches may be asked again: the contract's, or fewer when
    // COLLECTOR_RETRY_MAX_BATCHES says so (0 switches the retry off).
    retryBatches: resolveRetryMaxBatches(env),
    trace: traceKeys,
    // An offline replay has no real time: its clock stands still while the lane's
    // gaps are counted up (the 20 discovery pages leave the GeckoTerminal lane 240 s
    // ahead of it), so the fallback's start rule cannot apply there and the burst's
    // own deadline decides, as it did before the rule.
    ...(offline ? { fallbackLatestStartMs: Infinity } : {}),
  });

  // Frontier's own figures for the pools of its hooks (three requests). The step
  // never fails the run: a source that does not answer is reported unavailable
  // and the DEX Screener rows of those pools stay. It runs after the burst, so
  // its rows are the newest of the run, and the snapshot time is taken after it.
  log("Frontier pool markets");
  const frontier =
    now() - dexBurst.startedAt > FRONTIER_LATEST_START_MS
      ? skippedFrontier(
          "the measurement burst ran too long to read Frontier inside the five-minute window",
        )
      : await collectFrontier({
          client,
          frontierChains: registry.data.frontier,
          known: new Map(
            pools.map((pool) => [poolKey(pool.chain, pool.id), pool]),
          ),
          now,
        });
  const overlay = overlayFrontier(dexBurst.measured, frontier.pools);
  // The measurements end with Frontier's: that is the snapshot's time.
  const generatedAtMs = Math.max(dexBurst.endedAt, now());
  const burst = {
    ...dexBurst,
    measured: overlay.measured,
    endedAt: generatedAtMs,
    networks: withFrontierNetworks(
      dexBurst.networks,
      frontier.pools,
      dexBurst.requestedKeys,
      new Map(measurementChains().map((chain) => [chain.chain, chain.chainId])),
    ),
  };
  const frontierCounts = {
    listed: frontier.pricedCoins,
    supplied: frontier.pools.length,
    added: overlay.added,
    replaced: overlay.replaced,
    kept: overlay.kept,
    skipped: frontier.skipped,
    failure: frontier.failure,
    requests: frontier.requests,
    listing: frontier.listing,
  };

  // 7D and 30D volume of the largest pools: GeckoTerminal's daily candles. The
  // step is the last of the collection, after the burst, its fallback and
  // Frontier, with the snapshot time already fixed above: it can delay no
  // measurement and move no time the page judges. It spends only what the 399
  // requests still allow, and a skipped or failed step is a note and the records
  // it had (see collector/daily.mjs).
  log("Daily volume");
  const statsBeforeDaily = client.stats();
  const dailyLimit = Math.max(
    0,
    Math.min(
      DAILY_MAX_REQUESTS,
      Number.isSafeInteger(dailyMaxRequests)
        ? dailyMaxRequests
        : resolveDailyMaxRequests(env),
    ),
  );
  // The lane plan's refusal of a network that did not answer (see
  // collector/lane-guard.mjs) needs only the burst, so it is known here and is
  // part of the early answer below as well as of the run's own verdict.
  const laneGuard = laneNetworkGuard({ plan, burst });
  // The quality gate runs after the snapshot is assembled, so what it can already
  // tell is asked first: a run that will be refused does not spend its requests.
  const current = currentMeasured(burst.measured, generatedAtMs);
  const wouldPass = laneGuard.ok && assessQuality({
    currentPools: current.pools,
    currentVolumePools: current.withVolume,
    observedPools: burst.measured.size,
    plannedPools: plan.planned,
    requestedPools: burst.requestedPools,
    checkedPools: burst.answeredPools,
    snapshotValid: true,
    overviewsValid: true,
    volumeMeasured: current.withVolume > 0,
    minCurrent,
    previousPoint: state.history.at(-1) ?? null,
    generatedAtMs,
  }).ok;
  const dailyReason =
    dailyLimit <= 0
      ? "switched off (COLLECTOR_DAILY_MAX_REQUESTS is 0)"
      : !publish
        ? "this run publishes nothing"
        : !wouldPass
          ? "this run would not pass the quality gate"
          : now() - collectionStartedAt > DAILY_LATEST_START_MS
            ? "the run was already over 30 minutes old"
            : client.isStopped("geckoterminal")
              ? "GeckoTerminal was stopped for this run"
              : client.requestsLeft() < 1
                ? "the run's request budget was spent"
                : null;
  let dailyRecords = state.daily.records;
  let dailyReport = {
    ...emptyDailyReport(),
    selected: dailyRecords.length,
    skipped: dailyReason,
  };
  if (!dailyReason) {
    const step = await collectDaily({
      client,
      records: selectDaily({
        previous: state.daily.records,
        ranked: rankPools(burst.measured, generatedAtMs),
        generatedAtMs,
      }),
      measured: burst.measured,
      now,
      maxRequests: dailyLimit,
      // An offline replay has no real time: its clock stands still while the
      // lane's gaps are counted up, so the step's time limit cannot apply.
      ...(offline ? { budgetMs: Infinity } : {}),
    });
    dailyRecords = step.records;
    dailyReport = step.report;
  }
  const dailyDataset = buildDailyDataset({
    records: dailyRecords,
    measured: burst.measured,
    generatedAtMs,
  });
  dailyReport = {
    ...dailyReport,
    through: dailyDataset.through,
    published: dailyDataset.pools,
    covered: dailyDataset.covered,
    readyShare:
      dailyDataset.readyShare === null
        ? null
        : Math.round(dailyDataset.readyShare * 1000) / 1000,
    note:
      [
        state.daily.note,
        dailyDataset.problem
          ? `The file was not published: ${dailyDataset.problem}.`
          : null,
      ]
        .filter(Boolean)
        .join(" ") || null,
  };
  // The daily records are written when the step changed them, and to replace a
  // file that could not be read; a quiet run leaves the committed file alone.
  const dailyChanged =
    dailyJson(null, dailyRecords) !== dailyJson(null, state.daily.records) ||
    state.daily.note !== null;

  const stats = client.stats();
  // The notes name a network as the page does, so they are made once the
  // snapshot's chains are known. They describe the measurement phase: the
  // requests of the daily-volume step are a source of their own.
  const sources = (chains) =>
    providerSources({
      stats: statsBeforeDaily,
      daily: dailySource(dailyDataset),
      measured: burst.measured,
      discovery: discovery.stats,
      census: state.census,
      registrySources: registry.sources,
      unsupportedNetworks: burst.unsupportedNetworks,
      frontier: { sources: frontier.sources, ...frontierCounts },
      // The DEX Screener batches that failed and were asked again, for the note.
      dexRetry: burst.telemetry.dexscreener.retry,
      chains,
      // What this snapshot asked DEX Screener about, in the lane plan's own
      // words (and whether the batch ceiling cut some of the pools that were due);
      // the full plan asked about every pool it could hold, as before.
      lanePlan:
        plan.mode === "lanes"
          ? {
              asked: burst.requestedPools,
              known: pools.length - plan.unsupported,
              ceilingBound: plan.ceilingBound,
              maxBatches: plan.maxBatches,
              // What the plan really sent: more than maxBatches when the pools that
              // answer and the new pools, which are never cut, need more.
              batches: plan.batches,
              // The pools GeckoTerminal priced last time that answered in the last
              // 72 hours: they are asked about on the 3-hour wheel here.
              geckoCarried: decision.geckoCarried ?? 0,
            }
          : null,
    });
  const { snapshot, historyPoints } = assembleSnapshot({
    directoryInputs: {
      registry: registry.data.registry,
      chains: registry.data.chains,
      frontier: registry.data.frontier,
    },
    statePools: pools,
    measured: burst.measured,
    burst,
    census: state.census,
    history: state.history,
    sources,
    generatedAtMs,
  });

  let overviews = [];
  let overviewsValid = true;
  try {
    overviews = await buildOverviewFiles(snapshot, generatedAtMs);
  } catch (error) {
    overviewsValid = false;
    log(`Overview failed: ${error.message}`);
  }
  const gate = assessQuality({
    currentPools: currentPoolCount(snapshot),
    currentVolumePools:
      snapshot.summary.freshness?.volume?.h24?.currentPools ?? 0,
    observedPools: snapshot.pools.length,
    plannedPools: plan.planned,
    requestedPools: burst.requestedPools,
    checkedPools: burst.answeredPools,
    snapshotValid: validSnapshot(snapshot),
    overviewsValid,
    volumeMeasured: historyPointFor(snapshot.summary) !== null,
    minCurrent,
    previousPoint: state.history.at(-1) ?? null,
    generatedAtMs,
    stoppedProviders: Object.entries(statsBeforeDaily)
      .filter(([, row]) => row.stopped)
      .map(([id, row]) => `${id} (${row.stopped.reason})`),
    unsupportedNetworks: [...burst.unsupportedNetworks].sort(),
  });
  // The gate's verdict is final; with the lane plan a network DEX Screener did not
  // answer for may add a refusal of its own (the gate itself is unchanged).
  const quality = withLaneGuard(gate, laneGuard, plan);
  // The bookmarks the header of pools.json will carry. They are settled here,
  // before anything is published: a step's proposal of the wrong shape is
  // reported in status.json and the header keeps what was read, so a bad
  // bookmark can cost a step its place and never a run that passed its gate.
  // The GeckoTerminal fallback's rotation moves its bookmarks (`gt`) for the
  // requests that were answered; a step a test passes may move more. A bookmark that
  // is wrong costs the step its place, never the run (see nextCursors).
  const cursors = nextCursors(state.cursors, (kept) => {
    const moved = withGeckoBookmarks(kept, burst.fallback.bookmarks);
    return moveCursors ? moveCursors(moved) : moved;
  });
  const status = statusDocument({
    snapshot,
    collectionStartedAt,
    burst,
    quality,
    stats,
    discovery,
    state,
    offline,
    plan,
    planInfo: planStatusSafely({
      plan,
      decision,
      burst,
      guard: quality.networkGuard,
    }),
    // The full plan drops what its cap leaves out; the lane plan drops only what
    // its batch ceiling cut (the pools that were not due are deferredPools).
    dropped:
      plan.mode === "lanes"
        ? plan.dropped
        : pools.length - plan.planned - plan.unsupported,
    frontier: frontierCounts,
    cursors,
    daily: dailyReport,
    priority: {
      listed: priority.keys.size,
      addedToState: priority.fresh.length,
      planned: plan.plannedProtected,
      measured: [...plan.protectedKeys].filter((key) => burst.measured.has(key))
        .length,
    },
  });
  const result = {
    ok: quality.ok,
    quality,
    snapshot,
    status,
    overviews,
    historyPoints,
    daily: dailyDataset,
    published: false,
    served: transport?.served,
    // What each pool named by --trace did in this run; null without --trace.
    trace: traceKeys
      ? traceReport({ keys: traceKeys, pools, plan, burst })
      : null,
  };
  if (!quality.ok) return result;

  if (publish) {
    await mkdir(outDir, { recursive: true });
    for (const file of overviews)
      await writeFileAtomic(join(outDir, file.name), file.text);
    await writeFileAtomic(
      join(outDir, "history.json"),
      historyJson(historyPoints),
    );
    // The 7D and 30D file: any old one goes first, and a new one is written only
    // when it validated and is not empty.
    await rm(join(outDir, "daily.json"), { force: true });
    if (dailyDataset.file)
      await writeFileAtomic(
        join(outDir, "daily.json"),
        `${JSON.stringify(dailyDataset.file)}\n`,
      );
    await writeFileAtomic(
      join(outDir, "status.json"),
      `${JSON.stringify(status, null, 2)}\n`,
    );
    await writeFileAtomic(
      join(outDir, "snapshot.json"),
      JSON.stringify(snapshot),
    );
    await writeState(stateOutDir, {
      updatedAt: snapshot.generatedAt,
      pools: nextPools({
        pools: state.pools,
        found: [...priority.fresh, ...discovery.found],
        measured: burst.measured,
        generatedAtMs,
      }),
      // The bookmarks as they were read, with those the fallback's rotation moved.
      cursors: cursors.cursors,
      hookless: new Set([...state.hookless, ...discovery.hookless]),
      history: historyPoints,
      registry: registry.changed || !state.registry ? registry.fetched : null,
      daily: dailyChanged ? dailyRecords : undefined,
    });
    result.published = true;
  }
  return result;
}

const USAGE = `Usage: node collector/run.mjs [options]
  --offline            replay recorded fixtures (collector/fixtures); no network call; requires --out
  --no-publish         collect and validate, write nothing to public/data or state
  --out <dir>          write the data files to <dir> and updated state to <dir>/state
  --state <dir>        read state from <dir> (default state/, or the fixture state with --offline)
  --max-discovery <n>  at most n networks for discovery (0 turns discovery off)
  --max-pools <n>      measure at most n pools (uses the full plan, which asks about every known pool)
  --full-plan          ask DEX Screener about every known pool, not the lane plan (COLLECTOR_FULL_PLAN=1 does the same)
  --min-current <n>    minimum pools with a current 24h volume for the quality gate (below ${MIN_CURRENT_POOLS} only with --offline)
  --trace <keys>       print what this run did with each named pool (chain:0x<64 hex>, comma separated):
                       not asked and why, answered with no market value, rejected and why, or measured.
                       Only on your own computer: it refuses to run under GitHub Actions
  --verbose            print every request outcome`;

export function parseArguments(argv, env = process.env) {
  const options = { publish: true };
  const number = (name, value, { min = 0 } = {}) => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < min)
      throw new Error(`${name} needs a whole number of at least ${min}.`);
    return parsed;
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${flag} needs a value.`);
      return next;
    };
    if (flag === "--offline") options.offline = true;
    else if (flag === "--no-publish") options.publish = false;
    else if (flag === "--verbose") options.verbose = true;
    else if (flag === "--trace") {
      assertTraceAllowed(env);
      options.trace = parseTraceList(value());
    } else if (flag === "--out") options.out = resolve(value());
    else if (flag === "--state") options.state = resolve(value());
    else if (flag === "--max-discovery")
      options.maxDiscovery = number(flag, value());
    else if (flag === "--full-plan") options.fullPlan = true;
    else if (flag === "--max-pools")
      options.maxPools = number(flag, value(), { min: 1 });
    else if (flag === "--min-current")
      options.minCurrent = number(flag, value(), { min: 1 });
    else if (flag === "--help" || flag === "-h") options.help = true;
    else throw new Error(`Unknown option ${flag}.`);
  }
  if (options.offline && !options.out && options.publish)
    throw new Error(
      "--offline writes nothing into public/data: pass --out <dir> (or --no-publish).",
    );
  if (
    options.minCurrent !== undefined &&
    options.minCurrent < MIN_CURRENT_POOLS &&
    !options.offline
  )
    throw new Error(
      `--min-current below ${MIN_CURRENT_POOLS} is only allowed with --offline.`,
    );
  return options;
}

/** The lines a run prints about its plan, after the result line: which plan ran
 * and the batches it asked for, a loud line when the full plan ran although
 * nothing asked for it (the lane plan's safeguard, or a state with nothing to
 * start the lanes from), and a line when the lane plan's batch ceiling cut pools.
 * Under GitHub Actions the last two are workflow annotations, which the run's
 * page shows above its log. */
export function planNotices(counts, env = process.env) {
  const actions = Boolean(env?.GITHUB_ACTIONS);
  const { plan } = counts;
  const lines = [
    `Plan: ${plan.mode}${plan.reason ? ` (${plan.reason})` : ""} · ${counts.plannedPools} pools planned in ${plan.batches} DEX Screener batches`,
  ];
  if (plan.fellBack)
    lines.push(
      `${actions ? "::warning title=Lane plan not used::" : "WARNING: "}This run asked DEX Screener about every known pool because ${plan.detail}. The lane plan is the default; look at counts.plan in status.json and at the saved state before the next run.`,
    );
  if (plan.ceilingBound)
    lines.push(
      `${actions ? "::notice title=Lane plan hit its batch ceiling::" : "NOTE: "}The lane plan reached its ceiling of ${plan.maxBatches} DEX Screener batches${
        counts.droppedForCap > 0 && plan.batches > plan.maxBatches
          ? ` and sent ${plan.batches}, because the pools that answer and the new pools are never cut`
          : ""
      }. ` +
        (counts.droppedForCap > 0
          ? `${counts.droppedForCap} pools that were due were left out (warm ${plan.trimmed.warm}, cool ${plan.trimmed.cool}, cold ${plan.trimmed.cold}); they are asked at their next turn on the wheel.`
          : "The pools that answer and the new pools alone need more than that, and they are never cut."),
    );
  return lines;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let options;
  try {
    options = parseArguments(argv, env);
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  // The Snapshot workflow sets COLLECTOR_MAX_DISCOVERY for the runs that only
  // measure the pools already known. --max-discovery on the command line wins.
  options.maxDiscovery ??= resolveMaxDiscovery(env);
  const outDir = options.out ?? join(ROOT, "public", "data");
  const stateDir =
    options.state ??
    (options.offline ? join(FIXTURES, "state") : join(ROOT, "state"));
  try {
    const result = await runCollector({
      stateDir,
      outDir,
      stateOutDir: options.out ? join(options.out, "state") : stateDir,
      publish: options.publish,
      offline: options.offline,
      maxDiscovery: options.maxDiscovery,
      maxPools: options.maxPools,
      fullPlan: options.fullPlan ?? false,
      minCurrent:
        options.minCurrent ?? (options.offline ? 20 : MIN_CURRENT_POOLS),
      trace: options.trace ?? null,
      env,
      log: options.verbose ? (line) => console.error(line) : () => {},
    });
    const { checks } = result.quality;
    console.log(
      `${result.ok ? "PASS" : "REFUSED"} · ${checks.currentPools} current pools · ${checks.requestedPools}/${checks.plannedPools} planned pools requested, ${checks.checkedPools} answered · generatedAt ${result.snapshot.generatedAt}${result.published ? ` · written to ${outDir}` : " · nothing written"}`,
    );
    for (const failure of result.quality.failures)
      console.error(`  - ${failure}`);
    if (result.trace)
      for (const line of formatTrace(result.trace)) console.log(line);
    // The notices describe the plan after the files are written: a run that was
    // published is never failed for not being able to say how.
    try {
      for (const line of planNotices(result.status.counts, env))
        console.log(line);
    } catch (error) {
      console.log(`Plan: could not be described (${error?.message ?? error})`);
    }
    if (!result.ok) {
      // A refused run writes no status.json, so what explains it is printed.
      const { requests, unsupportedNetworks, rateLimitWaits } =
        result.status.counts;
      console.error(
        `  requests ${JSON.stringify(requests)} · DEX Screener answered HTTP 400 for ${JSON.stringify(unsupportedNetworks)} · rate-limit waits ${JSON.stringify(rateLimitWaits)}`,
      );
    }
    return result.ok ? 0 : 1;
  } catch (error) {
    console.error(`Collector failed: ${error.message}`);
    return 1;
  }
}

/** Whether this file is the program that was started. Both sides are resolved to
 * their real path, so a start through a symbolic link or a directory junction is
 * the same file; a path that cannot be resolved is compared as it is written. */
export function startedDirectly(
  moduleUrl = import.meta.url,
  entry = process.argv[1],
) {
  if (!entry) return false;
  const real = (path) => {
    try {
      return realpathSync.native(path);
    } catch {
      return resolve(path);
    }
  };
  return real(fileURLToPath(moduleUrl)) === real(entry);
}

if (startedDirectly()) process.exitCode = await main();
