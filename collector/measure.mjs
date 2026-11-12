import {
  ADDITIONAL_MARKET_CHAINS,
  MARKET_CHAINS,
} from "../server/market-chains.mjs";
import {
  BURST_BUDGET_MS,
  BURST_DEADLINE_MS,
  DS_BATCH_SIZE,
  FALLBACK_LATEST_START_MS,
  FRONTIER_MAX_REQUESTS,
  GT_FALLBACK_MAX_REQUESTS,
  LANE_ANCHOR_MAX_AHEAD_MS,
  LANE_HOT_MAX_AGE_MS,
  LANE_MAX_BATCHES,
  LANE_MIN_SHARE_OF_PREVIOUS,
  LANE_NEW_MAX_AGE_MS,
  LANE_NEW_MAX_POOLS,
  LANE_PERIOD_MS,
  LANE_WARM_MAX_AGE_MS,
  LANE_WINDOW_OVERLAP_MS,
  MAX_CONSECUTIVE_FAILURES,
  MAX_DISCOVERED_MEASURED,
  MAX_MEASURED_POOLS,
  MAX_PRIORITY_POOLS,
  RETRY_BURST_LIMIT_MS,
  RETRY_MAX_BATCHES,
} from "./config.mjs";
import {
  classifyDexScreenerPairs,
  DS_MAX_BYTES,
  DS_NETWORKS,
  dexScreenerUrl,
  normalizeDexScreenerPool,
  ROW_REJECTION_REASONS,
} from "./providers/dexscreener.mjs";
import {
  classifyGeckoPools,
  geckoMultiUrl,
  GT_MAX_BYTES,
  normalizeGeckoPool,
} from "./providers/geckoterminal.mjs";
import { hasMarketValue } from "./providers/market-rows.mjs";
import { ProviderError } from "./http.mjs";
import { isGeckoCarried, packBatches, planFallback } from "./fallback.mjs";
import { poolKey } from "./state.mjs";

/** Networks DEX Screener prices: a verified v4 manager and a DEX Screener id. */
export const measurementChains = () =>
  [...MARKET_CHAINS, ...ADDITIONAL_MARKET_CHAINS].filter(
    (chain) => chain.manager && DS_NETWORKS[chain.chain],
  );

/** Pools most recently seen first, then by id, so the cut is stable. */
export const byPriority = (a, b) =>
  a.lastSeen === b.lastSeen
    ? a.firstSeen === b.firstSeen
      ? a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0
      : a.firstSeen < b.firstSeen
        ? 1
        : -1
    : a.lastSeen < b.lastSeen
      ? 1
      : -1;

/** A pool that discovery added, as opposed to one the live app's census seeded. */
export const isDiscovered = (pool) => pool.source !== "census";

/** Which pools the burst asks about, grouped per network (largest first): the
 * full plan, every known pool in every run, cut by recency when it is too large.
 * It is the plan a run uses when COLLECTOR_FULL_PLAN is set or the lane plan
 * (planLanes, below) is not trusted; see decidePlanMode.
 *
 * `maxPools` is the whole plan. Seeded pools come first, at most `maxSeeded`
 * of them; pools found by discovery use what is left of the plan, at most
 * `maxDiscovered`, so a new pool can never push a seeded one out of the burst.
 * Within a group the most recently seen come first, then the id, so the same
 * pool set always yields the same requests.
 *
 * `protectedKeys` (chain:id keys of the priority list) are the pools of the
 * exact published hooks of launchpad platforms and named projects. They are
 * planned before every other pool, whatever their age, up to
 * MAX_PRIORITY_POOLS, and count against `maxSeeded`: they take the places of the
 * seeded pools that have gone longest without an answer, so the plan is no
 * larger than it was and costs no more requests. */
export function planBurst(
  pools,
  {
    maxPools = MAX_MEASURED_POOLS + MAX_DISCOVERED_MEASURED,
    maxDiscovered = MAX_DISCOVERED_MEASURED,
    maxSeeded = maxPools,
    protectedKeys = new Set(),
    chains = measurementChains(),
  } = {},
) {
  const bySlug = new Map(chains.map((chain) => [chain.chain, chain]));
  const eligible = pools.filter((pool) => bySlug.has(pool.chain));
  const keyOf = (pool) => poolKey(pool.chain, pool.id);
  const guarded = eligible
    .filter((pool) => protectedKeys.has(keyOf(pool)))
    .sort(byPriority)
    .slice(0, Math.min(MAX_PRIORITY_POOLS, maxSeeded, maxPools));
  const guardedKeys = new Set(guarded.map(keyOf));
  const seeded = [
    ...guarded,
    ...eligible
      .filter((pool) => !isDiscovered(pool) && !guardedKeys.has(keyOf(pool)))
      .sort(byPriority)
      .slice(0, Math.max(0, Math.min(maxSeeded, maxPools) - guarded.length)),
  ];
  const discovered = eligible
    .filter((pool) => isDiscovered(pool) && !guardedKeys.has(keyOf(pool)))
    .sort(byPriority)
    .slice(0, Math.max(0, Math.min(maxDiscovered, maxPools - seeded.length)));
  const selected = [...seeded, ...discovered];
  const grouped = new Map();
  for (const pool of selected) {
    if (!grouped.has(pool.chain)) grouped.set(pool.chain, []);
    grouped.get(pool.chain).push(pool);
  }
  // The cut above favours recent pools; batches are then composed by id so the
  // same pool set always yields the same requests.
  const networks = [...grouped]
    .map(([slug, rows]) => ({
      chain: bySlug.get(slug),
      pools: rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    }))
    .sort(
      (a, b) =>
        b.pools.length - a.pools.length ||
        a.chain.chain.localeCompare(b.chain.chain),
    );
  return {
    networks,
    planned: selected.length,
    plannedDiscovered: discovered.length,
    // The priority-list pools in the plan, as chain:id keys.
    protectedKeys: guardedKeys,
    plannedProtected: guarded.length,
    unsupported: pools.length - eligible.length,
    batches: networks.reduce(
      (sum, { pools: rows }) => sum + Math.ceil(rows.length / DS_BATCH_SIZE),
      0,
    ),
  };
}

/* ── The lane plan ─────────────────────────────────────────────────────────
 * planBurst above is the full plan: every known pool, in every run, cut by
 * recency when it is too large. planLanes asks about the pools that matter for
 * this snapshot every run and about the rest in rotation. The thresholds, the
 * periods and the ceiling are in config.mjs; the reasoning is there too. */

/** The lanes, in the order a network's batches are made: the pools that answer
 * come first, so a batch is full of them and a batch that fails does not take a
 * pool that answers with a pool that never has. */
export const LANES = Object.freeze(["hot", "new", "warm", "cool", "cold"]);
const WHEEL_LANES = Object.freeze(["warm", "cool", "cold"]);

const compareId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** A pool's place on a wheel, 0 up to (not including) 1: the first 32 bits of its
 * id as a fraction. Pool ids are hashes, so the phases of a set of pools are
 * even. An id that is not hexadecimal sits at 0. */
export function poolPhase(id) {
  const bits = Number.parseInt(String(id).slice(2, 10), 16);
  return Number.isFinite(bits) ? bits / 2 ** 32 : 0;
}

/** Whether the pool falls due on a wheel of `periodMs` in the window
 * (fromMs, toMs]: its due times are (k + phase) x period for every whole k. A
 * window as long as the period holds one of them for every pool. */
export function dueOnWheel(id, periodMs, fromMs, toMs) {
  if (toMs - fromMs >= periodMs) return true;
  const offset = poolPhase(id) * periodMs;
  return (
    Math.floor((toMs - offset) / periodMs) >
    Math.floor((fromMs - offset) / periodMs)
  );
}

/** The first time after `fromMs` the pool falls due on a wheel of `periodMs`. */
export function nextDue(id, periodMs, fromMs) {
  const offset = poolPhase(id) * periodMs;
  return (Math.floor((fromMs - offset) / periodMs) + 1) * periodMs + offset;
}

/** The lane a pool belongs to at `anchorMs`, before the cap on NEW is applied.
 * A pool has answered when its lastSeen is later than its firstSeen (the first
 * answer stamps it; see nextPools in run.mjs). A pool GeckoTerminal priced last
 * time that answered in the last 72 hours is not HOT: GeckoTerminal is asked about
 * it in every run (tier 0 of the fallback), and DEX Screener, which has not priced
 * it, is asked on the 3-hour wheel of WARM. */
export function laneOf(pool, anchorMs) {
  const lastSeen = Date.parse(pool.lastSeen);
  const firstSeen = Date.parse(pool.firstSeen);
  if (lastSeen > firstSeen) {
    const age = anchorMs - lastSeen;
    if (age < LANE_HOT_MAX_AGE_MS)
      return isGeckoCarried(pool, anchorMs) ? "warm" : "hot";
    return age < LANE_WARM_MAX_AGE_MS ? "warm" : "cool";
  }
  return anchorMs - firstSeen < LANE_NEW_MAX_AGE_MS ? "new" : "cold";
}

/** The moment the lanes are judged at: the run's time, but no later than a day
 * after the last saved time (see config.mjs). */
export const laneAnchor = (nowMs, updatedAtMs) =>
  Math.min(nowMs, updatedAtMs + LANE_ANCHOR_MAX_AHEAD_MS);

/** The pools of `pools` in their five lanes at `anchorMs`. NEW holds at most
 * LANE_NEW_MAX_POOLS, the newest first; the others wait in COLD, and
 * `newOverflow` says how many. */
export function classifyLanes(pools, anchorMs) {
  const lanes = { hot: [], new: [], warm: [], cool: [], cold: [] };
  const fresh = [];
  for (const pool of pools) {
    const lane = laneOf(pool, anchorMs);
    (lane === "new" ? fresh : lanes[lane]).push(pool);
  }
  fresh.sort(
    (a, b) =>
      Date.parse(b.firstSeen) - Date.parse(a.firstSeen) || compareId(a, b),
  );
  lanes.new = fresh.slice(0, LANE_NEW_MAX_POOLS);
  lanes.cold.push(...fresh.slice(LANE_NEW_MAX_POOLS));
  return { lanes, newOverflow: Math.max(0, fresh.length - LANE_NEW_MAX_POOLS) };
}

const countByChain = (lists) => {
  const counts = new Map();
  for (const list of lists)
    for (const pool of list)
      counts.set(pool.chain, (counts.get(pool.chain) ?? 0) + 1);
  return counts;
};
/** DEX Screener batches for pools counted per network: rounded up per network,
 * as the burst sends them. */
const batchesOf = (counts) =>
  [...counts.values()].reduce(
    (sum, count) => sum + Math.ceil(count / DS_BATCH_SIZE),
    0,
  );
const poolsOf = (counts) => [...counts.values()].reduce((a, b) => a + b, 0);

/** Which pools the burst asks about, as the lane plan.
 *
 * `updatedAtMs` is the saved time of the last good run and `nowMs` the time of
 * this plan. HOT and NEW are asked in every run. WARM, COOL and COLD are wheels:
 * the pools that fell due in (updatedAtMs - overlap, nowMs] are asked, and a
 * window as long as a lane's period asks the whole lane. When the plan would
 * need more than `maxBatches` batches (or more than `maxPools` pools) COLD is
 * cut, then COOL, then WARM, the pools that fell due most recently first; HOT and
 * NEW are never cut, so the plan can only exceed the ceiling if they alone do
 * (`ceilingBound` says both). `priorityKeys` is counted, never used to choose.
 *
 * Within a network the batches are made lane by lane (HOT first), each lane in
 * id order, so the same state and times always yield the same requests.
 *
 * The result has planBurst's fields (`networks`, `planned`, `plannedDiscovered`,
 * `protectedKeys`, `plannedProtected`, `unsupported`, `batches`) and:
 * - `mode`: "lanes";
 * - `lanes`: `{ known, scheduled }` per lane (known: eligible pools in it;
 *   scheduled: asked in this run);
 * - `deferred`: wheel pools not asked because they were not due;
 * - `dropped`: pools due and cut by the ceiling (`trimmed` has them per lane,
 *   `trimmedKeys` as chain:id keys);
 * - `laneByKey`: every eligible pool's lane, by chain:id key;
 * - `window`: `{ fromMs, toMs, anchorMs }`. */
export function planLanes(
  pools,
  {
    nowMs,
    updatedAtMs,
    maxBatches = LANE_MAX_BATCHES,
    maxPools = Infinity,
    priorityKeys = new Set(),
    chains = measurementChains(),
  },
) {
  const bySlug = new Map(chains.map((chain) => [chain.chain, chain]));
  const eligible = pools.filter((pool) => bySlug.has(pool.chain));
  const anchorMs = laneAnchor(nowMs, updatedAtMs);
  const fromMs = updatedAtMs - LANE_WINDOW_OVERLAP_MS;
  const { lanes: known, newOverflow } = classifyLanes(eligible, anchorMs);
  const scheduled = { hot: [...known.hot], new: [...known.new] };
  const due = {};
  for (const lane of WHEEL_LANES) {
    scheduled[lane] = known[lane].filter((pool) =>
      dueOnWheel(pool.id, LANE_PERIOD_MS[lane], fromMs, nowMs),
    );
    due[lane] = scheduled[lane].length;
  }

  const counts = () => countByChain(LANES.map((lane) => scheduled[lane]));
  const fits = (map) => batchesOf(map) <= maxBatches && poolsOf(map) <= maxPools;
  const trimmed = { warm: 0, cool: 0, cold: 0 };
  const trimmedKeys = new Set();
  if (!fits(counts())) {
    for (const lane of ["cold", "cool", "warm"]) {
      if (fits(counts())) break;
      // The pools that fell due longest ago are kept: they have waited most.
      const period = LANE_PERIOD_MS[lane];
      const keep = scheduled[lane]
        .map((pool) => ({ pool, at: nextDue(pool.id, period, fromMs) }))
        .sort((a, b) => a.at - b.at || compareId(a.pool, b.pool))
        .map(({ pool }) => pool);
      const rest = countByChain(
        LANES.filter((other) => other !== lane).map((other) => scheduled[other]),
      );
      // The most pools of this lane that still fit: adding a pool never lowers
      // the batches, so the largest fitting prefix is found by bisection.
      let low = 0;
      let high = keep.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        const trial = new Map(rest);
        for (const pool of keep.slice(0, middle))
          trial.set(pool.chain, (trial.get(pool.chain) ?? 0) + 1);
        if (fits(trial)) low = middle;
        else high = middle - 1;
      }
      trimmed[lane] = keep.length - low;
      for (const pool of keep.slice(low))
        trimmedKeys.add(poolKey(pool.chain, pool.id));
      scheduled[lane] = keep.slice(0, low);
    }
  }
  const final = counts();
  const ceilingBound =
    trimmed.warm + trimmed.cool + trimmed.cold > 0 || !fits(final);

  const grouped = new Map();
  for (const lane of LANES)
    for (const pool of [...scheduled[lane]].sort(compareId)) {
      if (!grouped.has(pool.chain)) grouped.set(pool.chain, []);
      grouped.get(pool.chain).push(pool);
    }
  const networks = [...grouped]
    .map(([slug, rows]) => ({ chain: bySlug.get(slug), pools: rows }))
    .sort(
      (a, b) =>
        b.pools.length - a.pools.length ||
        a.chain.chain.localeCompare(b.chain.chain),
    );
  const selected = networks.flatMap(({ pools: rows }) => rows);
  const keyOf = (pool) => poolKey(pool.chain, pool.id);
  const listed = selected.filter((pool) => priorityKeys.has(keyOf(pool)));
  const laneByKey = new Map();
  for (const lane of LANES)
    for (const pool of known[lane]) laneByKey.set(keyOf(pool), lane);
  return {
    mode: "lanes",
    networks,
    planned: selected.length,
    plannedDiscovered: selected.filter(isDiscovered).length,
    // The priority-list pools in the plan. They are counted for the status
    // file; the lane plan does not rank them (see runBurst).
    protectedKeys: new Set(listed.map(keyOf)),
    plannedProtected: listed.length,
    unsupported: pools.length - eligible.length,
    batches: batchesOf(final),
    lanes: Object.fromEntries(
      LANES.map((lane) => [
        lane,
        { known: known[lane].length, scheduled: scheduled[lane].length },
      ]),
    ),
    deferred: WHEEL_LANES.reduce(
      (sum, lane) => sum + known[lane].length - due[lane],
      0,
    ),
    dropped: trimmed.warm + trimmed.cool + trimmed.cold,
    trimmed,
    trimmedKeys,
    newOverflow,
    ceilingBound,
    maxBatches,
    laneByKey,
    window: { fromMs, toMs: nowMs, anchorMs },
  };
}

/** The DEX Screener batches each lane adds to a lane plan. The batches of a
 * network are made lane by lane, so a lane's share is the batches its pools add
 * after the lanes before it (a batch that holds the end of one lane and the start
 * of the next is counted once, to the lane that opened it). The shares add up to
 * `plan.batches`. */
export function laneBatches(plan) {
  const shares = Object.fromEntries(LANES.map((lane) => [lane, 0]));
  for (const { chain, pools } of plan.networks) {
    const inLane = Object.fromEntries(LANES.map((lane) => [lane, 0]));
    for (const pool of pools)
      inLane[plan.laneByKey.get(poolKey(chain.chain, pool.id))]++;
    let counted = 0;
    let batches = 0;
    for (const lane of LANES) {
      counted += inLane[lane];
      const total = Math.ceil(counted / DS_BATCH_SIZE);
      shares[lane] += total - batches;
      batches = total;
    }
  }
  return shares;
}

// Why a run uses the full plan although the lane plan is the default.
const FULL_PLAN_REASONS = Object.freeze({
  forced:
    "the plan that asks about every known pool was requested (COLLECTOR_FULL_PLAN or --full-plan)",
  "max-pools":
    "--max-pools was given, and that cap belongs to the plan that asks about every known pool",
  "no-saved-time":
    "the state holds no saved time of an earlier run, so the lanes have nothing to start from",
  "saved-time-in-future":
    "the saved time of the last run is later than the time of this run",
  "no-history":
    "the state holds no earlier history point to size the sample against",
  "planner-error": "the lane planner failed",
});

/** The reasons that were asked for, as opposed to the safeguard having fired. */
export const REQUESTED_FULL_PLAN_REASONS = Object.freeze([
  "forced",
  "max-pools",
]);

/** Which plan a run uses: `{ mode: "lanes" }` or `{ mode: "full", code, detail }`
 * with the reason. The lane plan is the default; the full plan is used when it was
 * asked for (`forced`: "forced" or "max-pools"), when the state cannot start the
 * lanes (no saved time of an earlier run, or one in the future, or no history
 * point to compare with), or when the lanes would ask about too few pools: HOT
 * and NEW together must hold at least LANE_MIN_SHARE_OF_PREVIOUS of the pools
 * with a current 24h volume behind the previous history point. Every pool that
 * answered in the last good run is HOT or NEW, so the lanes lose no measurement
 * that the full plan would have made; a plan that holds fewer pools than that
 * means the state or the lanes are wrong, and the full plan is the safe answer
 * (the run says so loudly in status.json: `counts.plan`). It is also used when
 * HOT and NEW alone need more than LANE_MAX_BATCHES batches: they are never cut,
 * so the lane plan would pass its own ceiling and the run's request budget, and
 * the full plan (which is cut to its contract size) is the bounded answer. */
export function decidePlanMode({
  pools,
  nowMs,
  updatedAtMs,
  previousPoint = null,
  forced = null,
  chains = measurementChains(),
}) {
  const full = (code, extra = {}) => ({
    mode: "full",
    code,
    detail: FULL_PLAN_REASONS[code] ?? null,
    ...extra,
  });
  if (forced) return full(forced);
  if (!Number.isFinite(updatedAtMs)) return full("no-saved-time");
  if (updatedAtMs > nowMs) return full("saved-time-in-future");
  const previousPools = previousPoint?.pools;
  if (!Number.isSafeInteger(previousPools) || previousPools <= 0)
    return full("no-history");
  const slugs = new Set(chains.map((chain) => chain.chain));
  const anchorMs = laneAnchor(nowMs, updatedAtMs);
  const { lanes } = classifyLanes(
    pools.filter((pool) => slugs.has(pool.chain)),
    anchorMs,
  );
  const hotAndNew = lanes.hot.length + lanes.new.length;
  // The pools GeckoTerminal priced last time and that answered in the last 72 hours
  // are asked about in every run too (by GeckoTerminal, and by DEX Screener on its
  // 3-hour wheel: they sit in WARM), so they count with HOT and NEW.
  const geckoCarried = lanes.warm.filter((pool) =>
    isGeckoCarried(pool, anchorMs),
  ).length;
  // (The small subtraction keeps 0.9 x 60 at 54, not 55, in floating point.)
  const floor = Math.ceil(LANE_MIN_SHARE_OF_PREVIOUS * previousPools - 1e-9);
  const numbers = { hotAndNew, geckoCarried, floor, previousPools };
  if (hotAndNew + geckoCarried < floor)
    return {
      mode: "full",
      code: "below-floor",
      detail: `the lanes would ask about ${hotAndNew + geckoCarried} pools that answered or are new, fewer than ${floor}, which is ${Math.round(LANE_MIN_SHARE_OF_PREVIOUS * 100)}% of the ${previousPools} pools with a current 24h volume behind the previous history point`,
      ...numbers,
    };
  // HOT and NEW are never cut, so a state that holds more of them than the ceiling
  // allows would send the plan past the ceiling and its request reserve past the
  // 399-request budget (it takes about 6,600 of them to pass 220 batches).
  const batches = batchesOf(countByChain([lanes.hot, lanes.new]));
  if (batches > LANE_MAX_BATCHES)
    return {
      mode: "full",
      code: "above-ceiling",
      detail: `the pools that answered or are new alone need ${batches} DEX Screener batches, more than the lane plan's ceiling of ${LANE_MAX_BATCHES}, and they are never cut`,
      ...numbers,
      batches,
    };
  return { mode: "lanes", code: null, detail: null, ...numbers };
}

/** The decision when the planner itself failed: the full plan, which is the
 * contract's own size, with the reason. Only the short message of `error` is
 * kept. */
export function plannerFailure(error) {
  const message = String(error?.message ?? error)
    .replace(/\s+/g, " ")
    .slice(0, 160);
  return {
    mode: "full",
    code: "planner-error",
    detail: `${FULL_PLAN_REASONS["planner-error"]} (${message})`,
  };
}

/** decidePlanMode that cannot fail a run: an exception is the full plan with the
 * reason `planner-error` and a loud report, not a failed collect step. `decide`
 * is decidePlanMode; a test gives it one that throws. */
export function decidePlanSafely(input, decide = decidePlanMode) {
  try {
    return decide(input);
  } catch (error) {
    return plannerFailure(error);
  }
}

/** The plan for a run: the lane plan, or the full plan (planBurst) when
 * `decision` (from decidePlanMode) says so. `full` holds planBurst's options. */
export function planMeasurement(
  pools,
  { decision, nowMs, updatedAtMs, maxBatches, priorityKeys = new Set(), full = {} },
) {
  if (decision.mode === "full")
    return {
      ...planBurst(pools, { protectedKeys: priorityKeys, ...full }),
      mode: "full",
    };
  return planLanes(pools, {
    nowMs,
    updatedAtMs,
    priorityKeys,
    ...(maxBatches === undefined ? {} : { maxBatches }),
  });
}

/** planMeasurement that cannot fail a run: when the lane plan throws, the full
 * plan is made instead and the decision becomes `planner-error` (the run reports
 * it loudly, like any fall back). Returns `{ plan, decision }`. A full plan that
 * throws is not caught: there is nothing safer to fall back to. `make` is
 * planMeasurement; a test gives it one that throws. */
export function planSafely(pools, options, make = planMeasurement) {
  try {
    return { plan: make(pools, options), decision: options.decision };
  } catch (error) {
    if (options.decision.mode !== "lanes") throw error;
    const decision = plannerFailure(error);
    return { plan: make(pools, { ...options, decision }), decision };
  }
}

// What DEX Screener answers for a network slug it does not index.
const DS_UNINDEXED_STATUS = 400;

const emptyNetwork = (chain, planned) => ({
  chain: chain.chain,
  chainId: chain.chainId,
  planned,
  requested: 0,
  checked: 0,
  measured: 0,
  failedBatches: 0,
});

/** Why a request failed, as one short word for the status file: `http-500` for
 * an HTTP status, otherwise the client's own code (`timeout`, `network`, `size`,
 * `json`, `rate-limited`, `forbidden`, ...) or the answer's (`shape`,
 * `ambiguous`). Anything else is `other`. */
export function failureReason(error) {
  const code = error?.code;
  if (code === "http")
    return Number.isSafeInteger(error.status) ? `http-${error.status}` : "http";
  return typeof code === "string" && /^[a-z][a-z-]{0,30}$/.test(code)
    ? code
    : "other";
}

// The codes of an answer the classifiers (providers/*.mjs) cannot use: a batch of an
// unexpected shape, or one that names a pool twice. They throw a plain Error that
// carries the code, so the answer's failures are named here rather than by "has a
// string code" (a Node system error, such as ECONNRESET or ERR_INVALID_URL, has a
// string code too and is a defect in the collector, not an answer).
const ANSWER_FAILURE_CODES = new Set(["shape", "ambiguous"]);

/** Whether an error thrown while a request was sent and its answer read is the
 * provider's answer and not a defect in the collector: a request that failed (the
 * client's ProviderError, whatever its code) or an answer the classifiers could not
 * use (`shape`, `ambiguous`). Anything else (a TypeError, a Node system error) is a
 * defect: it is counted where a person reading status.json can see it. */
export function isProviderAnswer(error) {
  return (
    error instanceof ProviderError ||
    (error instanceof Error && ANSWER_FAILURE_CODES.has(error.code))
  );
}

/** Whether a failed DEX Screener batch is worth asking again: the failure may be
 * gone a moment later. A network error, a timeout, an answer that is not JSON or not
 * of the shape of an answer, an HTTP 5xx or a 408. Not a 429 (the client has its own
 * cooldown, once a run) or a 403 (it stops the provider), not a 400 or any other 4xx
 * (a network DEX Screener does not index answers 400 as its first answer; the others
 * say the request is wrong), not an answer that is too large or names a pool twice
 * (it would be the same again), and not an error that has no code, which is a defect
 * and not an answer. */
export function retryableFailure(error) {
  const code = error?.code;
  if (code === "network" || code === "timeout" || code === "json" || code === "shape")
    return true;
  if (code !== "http") return false;
  const status = error.status;
  return (
    Number.isSafeInteger(status) &&
    ((status >= 500 && status <= 599) || status === 408)
  );
}

const sortedCounts = (counts) =>
  Object.fromEntries(
    Object.keys(counts)
      .sort()
      .map((reason) => [reason, counts[reason]]),
  );
const sumOf = (counts) => Object.values(counts).reduce((a, b) => a + b, 0);

/** All measurements, in one burst: DEX Screener exact-id batches, then at most
 * a few GeckoTerminal batches for pools DEX Screener did not return.
 *
 * The batches go breadth-first: one batch for each network in turn (the largest
 * first), then the next batch for each, and so on. A burst that runs out of time
 * or is stopped therefore thins every network a little instead of dropping the
 * ones at the end of the list. Which pools make up a batch does not depend on
 * the order. A network whose batches fail MAX_CONSECUTIVE_FAILURES times in a
 * row is left for the next run, so an endpoint that is broken for one network is
 * not asked again and again while the others succeed.
 *
 * DEX Screener answers HTTP 400 for a network it does not index. When that is
 * the first answer for a network, its other batches are not sent and the network
 * is reported in `unsupportedNetworks`; the 400 does not count toward the
 * provider's consecutive-failure limit. Its pools stay unresolved, so the
 * GeckoTerminal fallback considers them like any other unresolved pool.
 *
 * A row a provider answers with no liquidity and no volume at all (every figure
 * null) is an answer, not a measurement: the pool counts as checked and is not
 * measured, so every count agrees with the pools the snapshot carries.
 *
 * `telemetry` in the result counts what the providers did, for the status file:
 * DEX Screener's batches, failed batches by reason, rows returned and rejected
 * (and why), the pools asked and those with a row; GeckoTerminal's fallback
 * requests, failures, ids asked and pools measured per network. Counting changes
 * nothing a run asks or keeps.
 *
 * The fallback considers the pools no provider measured. With the full plan those
 * are the plan's own pools, in the earlier order (fallbackBatches). With the lane
 * plan, which asks DEX Screener about few pools in a run, `known` (every pool the
 * run knows, as the state, the priority list and discovery hold them) widens the
 * choice to every known pool of a network GeckoTerminal serves, whether or not DEX
 * Screener was asked about it in this run, and the order is planFallback's
 * (collector/fallback.mjs): tier 0 (the pools GeckoTerminal priced last time that
 * answered in the last 72 hours, and the pools of a network DEX Screener answered
 * HTTP 400 for in this run) in every run, then a rotation over the other pools of
 * every network. `bookmarks` is the header's `cursors.gt`, where each network's
 * rotation stopped; `fallback.bookmarks` in the result has the bookmarks that
 * moved, for the caller to write back (a request that failed moves none). A network
 * the plan did not include gets its statistics row when GeckoTerminal is asked
 * about it, so what GeckoTerminal answers there is counted. The fallback is
 * never taken from a pool DEX Screener measured, starts no request later than
 * `fallbackLatestStartMs` after the burst began, and never fails the run: an error
 * that is not a provider's answer (a defect in the collector) is counted in
 * `telemetry.geckoterminal.errors` and the next request goes on.
 *
 * A DEX Screener batch that failed with a retryable error (retryableFailure) is
 * asked again once, after the first pass over the plan and before the fallback:
 * the batches of the pools that answer first (the lane plan's HOT before the
 * others), then in the order they failed, at most `retryBatches` of them, none
 * starting later than `retryLatestStartMs` after the burst began, and only while
 * the paced client has requests left beyond what the fallback and Frontier's step
 * need (a retry is one of the 399). A retried batch's pools are counted once as
 * requested (when the batch was first asked), a batch that answers is counted as an
 * answer, and one that fails again stays unanswered. `telemetry.dexscreener.retry`
 * says what failed, what recovered and what was left, and why. A network's first
 * answer of HTTP 400 is not such a failure: it is the network not being indexed
 * (`unsupportedNetworks`), so it is not on the retry's list, not in its counts and
 * not in the note about it (it stays in `failedBatches`, where it was counted). The
 * step never fails the burst: a defect in it is counted there and the burst goes on.
 *
 * `trace` (a Set of chain:id keys, for a run on a person's own computer) makes
 * the result's `trace` hold, for each of those pools, what each provider did
 * with it: nothing is asked or kept because of it. */
export async function runBurst({
  client,
  plan,
  now,
  budgetMs = BURST_BUDGET_MS,
  deadlineMs = BURST_DEADLINE_MS,
  fallbackRequests = GT_FALLBACK_MAX_REQUESTS,
  fallbackLatestStartMs = FALLBACK_LATEST_START_MS,
  retryBatches = RETRY_MAX_BATCHES,
  retryLatestStartMs = RETRY_BURST_LIMIT_MS,
  known = null,
  bookmarks = {},
  trace = null,
}) {
  const startedAt = now();
  const measured = new Map();
  const networks = new Map();
  const answered = new Set();
  // The pools DEX Screener was actually asked about. `answered` can hold more:
  // the fallback also answers pools that were planned and never requested.
  const requestedKeys = new Set();
  const unsupportedNetworks = [];
  let dexRequests = 0;
  // What the providers did, counted for the status file (see above).
  const dexCounts = {
    failedByReason: {},
    rejectedByReason: Object.fromEntries(
      ROW_REJECTION_REASONS.map((reason) => [reason, 0]),
    ),
    rowsReturned: 0,
    rowsWithoutValue: 0,
    poolsWithRow: 0,
  };
  const geckoCounts = {
    failedByReason: {},
    measuredByNetwork: {},
  };
  // Per traced pool, what each provider did: { dexscreener, geckoterminal }, each
  // { outcome: "value" | "no-value" | "no-row" | "rejected" | "failed", reason }.
  const traced = trace?.size ? new Map() : null;
  const note = (provider, key, entry) => {
    if (!traced || !trace.has(key)) return;
    traced.set(key, { ...traced.get(key), [provider]: entry });
  };
  // The pools of a batch no usable row came back for: a row was rejected (and
  // why), or the provider returned none.
  const noteUnused = (provider, chain, ids, rowIds, rejected) => {
    const reasons = new Map(
      rejected.filter(({ id }) => id).map(({ id, reason }) => [id, reason]),
    );
    for (const id of ids)
      if (!rowIds.has(id))
        note(
          provider,
          poolKey(chain.chain, id),
          reasons.has(id)
            ? { outcome: "rejected", reason: reasons.get(id) }
            : { outcome: "no-row" },
        );
  };
  const lanes = plan.networks.map(({ chain, pools }) => {
    const stats = emptyNetwork(chain, pools.length);
    networks.set(chain.chain, stats);
    return {
      chain,
      pools,
      stats,
      structural: new Map(pools.map((pool) => [pool.id, pool])),
      next: 0,
      // A 400 after the network has answered is not evidence that it is
      // unindexed.
      answered: false,
      failedInARow: 0,
      // Set when MAX_CONSECUTIVE_FAILURES batches in a row failed and the rest of
      // the network's batches were never sent: the network is down. That is not
      // a network DEX Screener does not index (a 400 as its first answer), and
      // not a burst that ran out of time.
      stopped: false,
      done: pools.length === 0,
    };
  });
  /** One DEX Screener batch: `ids` (at most DS_BATCH_SIZE pool ids of the lane's
   * network) asked in one request, the rows it returns accepted and measured, and
   * every count it moves. It is the whole of what a batch does, so a caller that
   * asks a batch again goes through here and changes the counts the same way.
   *
   * `retry` is a batch asked a second time (see retryPass): its pools are already
   * counted as asked, and its first failure is already counted as a failed batch and
   * as a step toward the network being down, so none of that is counted again (a
   * retry is not a batch of the plan: `dexRequests` stays the batches). What an
   * answer moves (the pools answered, the rows, the measurements) is counted as for
   * any batch, because the first try moved none of it. A retry may not start later
   * than the retry's own limit.
   *
   * Resolves `{ sent, error, unindexed }`. `sent` is false when the batch was never
   * sent (the provider is stopped, or the request could not start inside the burst's
   * time): it is then not a request and not a failed batch, and the provider
   * cannot start another request in time either, so the phase is over. Otherwise
   * `error` is null for an answered batch and the failure for one that failed.
   * `unindexed` is true for the one failure that is the network's own answer: an
   * HTTP 400 as the first answer the network ever gave, which says DEX Screener does
   * not index it. It is counted as a failed batch where it happened, as it always
   * was, and recorded in `unsupportedNetworks`; it is not a batch that failed and
   * could be asked again, so the caller does not put it on the retry's list. */
  async function askBatch(lane, ids, { retry = false } = {}) {
    const { chain, stats, structural } = lane;
    if (!retry) {
      stats.requested += ids.length;
      for (const id of ids) requestedKeys.add(poolKey(chain.chain, id));
      dexRequests++;
    }
    try {
      const result = await client.getJson(
        "dexscreener",
        dexScreenerUrl(chain, ids),
        {
          maxBytes: DS_MAX_BYTES,
          notAfter:
            startedAt +
            (retry ? Math.min(budgetMs, retryLatestStartMs) : budgetMs),
          tolerate: lane.answered ? [] : [DS_UNINDEXED_STATUS],
        },
      );
      lane.answered = true;
      const {
        accepted: rows,
        rejected,
        returned,
      } = classifyDexScreenerPairs(result.data, chain, ids, structural);
      lane.failedInARow = 0;
      stats.checked += ids.length;
      for (const id of ids) answered.add(poolKey(chain.chain, id));
      dexCounts.rowsReturned += returned;
      for (const { reason } of rejected) dexCounts.rejectedByReason[reason]++;
      dexCounts.poolsWithRow += rows.length;
      const rowIds = new Set();
      for (const row of rows) {
        const id = row.pairAddress.toLowerCase();
        rowIds.add(id);
        const pool = normalizeDexScreenerPool(
          row,
          chain,
          structural.get(id),
          result.observedAt,
        );
        // Answered with nothing usable: unresolved, left to the fallback.
        if (!hasMarketValue(pool)) {
          dexCounts.rowsWithoutValue++;
          note("dexscreener", poolKey(chain.chain, id), {
            outcome: "no-value",
          });
          continue;
        }
        measured.set(poolKey(chain.chain, id), pool);
        stats.measured++;
        note("dexscreener", poolKey(chain.chain, id), { outcome: "value" });
      }
      if (traced) noteUnused("dexscreener", chain, ids, rowIds, rejected);
      return { sent: true, error: null };
    } catch (error) {
      if (error?.code === "budget" || error?.code === "stopped") {
        // Never sent: not a request, not a failed batch.
        if (!retry) {
          stats.requested -= ids.length;
          for (const id of ids) requestedKeys.delete(poolKey(chain.chain, id));
          dexRequests--;
        }
        return { sent: false, error };
      }
      if (retry) {
        // A batch that failed again keeps the failure it was counted with. An HTTP
        // 400 is still the network's answer when it is the first it ever gave.
        if (error?.status === DS_UNINDEXED_STATUS && !lane.answered) {
          if (!unsupportedNetworks.includes(chain.chain))
            unsupportedNetworks.push(chain.chain);
          lane.done = true;
        }
        return { sent: true, error };
      }
      const reason = failureReason(error);
      dexCounts.failedByReason[reason] =
        (dexCounts.failedByReason[reason] ?? 0) + 1;
      for (const id of ids)
        note("dexscreener", poolKey(chain.chain, id), {
          outcome: "failed",
          reason,
        });
      stats.failedBatches++;
      if (error?.status === DS_UNINDEXED_STATUS && !lane.answered) {
        unsupportedNetworks.push(chain.chain);
        lane.done = true;
        return { sent: true, error, unindexed: true };
      }
      if (++lane.failedInARow >= MAX_CONSECUTIVE_FAILURES) {
        lane.done = true;
        lane.stopped = true;
      }
      return { sent: true, error, unindexed: false };
    }
  }

  // The batches that failed when they were first asked, in the order they failed,
  // and what the second try of them did (see retryPass).
  const failedFirstPass = [];
  const retryState = {
    retried: 0,
    recovered: 0,
    outcomes: new Map(),
    recoveredNetworks: new Set(),
    notRetried: {},
    defect: null,
  };
  const skipRetry = (reason, count) => {
    if (count > 0)
      retryState.notRetried[reason] =
        (retryState.notRetried[reason] ?? 0) + count;
  };

  let ended = false;
  while (!ended && lanes.some((lane) => !lane.done)) {
    for (const lane of lanes) {
      if (lane.done) continue;
      if (client.isStopped("dexscreener") || now() - startedAt >= budgetMs) {
        ended = true;
        break;
      }
      const ids = lane.pools
        .slice(lane.next, lane.next + DS_BATCH_SIZE)
        .map((pool) => pool.id);
      lane.next += DS_BATCH_SIZE;
      if (lane.next >= lane.pools.length) lane.done = true;
      const { sent, error, unindexed } = await askBatch(lane, ids);
      if (!sent) {
        ended = true;
        break;
      }
      // A network DEX Screener does not index is not a batch that failed and
      // could be asked again: it is in `unsupportedNetworks`, and the retry's
      // counts and the note about it say nothing of it.
      if (error && !unindexed) failedFirstPass.push({ lane, ids, error });
    }
  }

  /** The second try of the batches that failed with a retryable error, made once
   * the first pass is over.
   *
   * Which: the batches of the pools that answer come first (the lane plan's HOT,
   * NEW, WARM, COOL and COLD in that order, by the lane of the batch's first pool,
   * which the lane-major batches make the best lane in it), then in the order they
   * failed; the full plan has no lanes, so it is the order they failed. At most
   * `retryBatches`; none once the burst is `retryLatestStartMs` old or the provider
   * is stopped; and only while the paced client has requests left beyond what the
   * fallback and Frontier's step need. A batch that was never sent ends the pass
   * (the provider cannot start another request in time either). What happened is
   * kept in `retryState` and reported in `telemetry.dexscreener.retry`. */
  async function retryPass() {
    const laneRank = ({ lane, ids }) => {
      const found = plan.laneByKey?.get(poolKey(lane.chain.chain, ids[0]));
      const rank = found ? LANES.indexOf(found) : -1;
      return rank < 0 ? LANES.length : rank;
    };
    const candidates = failedFirstPass
      .map((failure, order) => ({ failure, order, rank: laneRank(failure) }))
      .filter(({ failure }) => retryableFailure(failure.error))
      .sort((a, b) => a.rank - b.rank || a.order - b.order);
    skipRetry("not-retryable", failedFirstPass.length - candidates.length);
    // What the rest of the run still needs: the fallback's requests and Frontier's.
    const reserve = fallbackRequests + FRONTIER_MAX_REQUESTS;
    for (const [index, { failure }] of candidates.entries()) {
      const left = candidates.length - index;
      let stop = null;
      if (retryState.retried >= retryBatches) stop = "limit";
      else if (client.isStopped("dexscreener")) stop = "stopped";
      else if (now() - startedAt >= retryLatestStartMs) stop = "time";
      else if (client.requestsLeft() - reserve <= 0) stop = "requests";
      if (stop) return skipRetry(stop, left);
      const { sent, error } = await askBatch(failure.lane, failure.ids, {
        retry: true,
      });
      if (!sent) return skipRetry("not-sent", left);
      retryState.retried++;
      retryState.outcomes.set(failure, error);
      if (!error) {
        retryState.recovered++;
        retryState.recoveredNetworks.add(failure.lane.chain.chain);
      }
    }
  }
  // A defect in the retry step is counted and never fails the burst.
  try {
    await retryPass();
  } catch (error) {
    retryState.defect = String(error?.message ?? error)
      .replace(/\s+/g, " ")
      .slice(0, 160);
  }
  // The batches still unanswered: asked again and failed, or not asked again, with
  // the reason of the last failure.
  const stillFailed = failedFirstPass
    .filter(
      (failure) =>
        !retryState.outcomes.has(failure) ||
        retryState.outcomes.get(failure) !== null,
    )
    .map((failure) => ({
      chain: failure.lane.chain.chain,
      pools: failure.ids.length,
      reason: failureReason(retryState.outcomes.get(failure) ?? failure.error),
      retried: retryState.outcomes.has(failure),
    }));

  const fallback = { requests: 0, measured: 0, ids: 0 };
  // Errors that are not a provider's answer: counted instead of swallowed (below).
  const geckoErrors = { total: 0, last: null };
  const noteDefect = (error) => {
    geckoErrors.total++;
    geckoErrors.last = String(error?.message ?? error)
      .replace(/\s+/g, " ")
      .slice(0, 160);
  };
  const chainBySlug = new Map(
    measurementChains().map((chain) => [chain.chain, chain]),
  );
  for (const { chain } of plan.networks) chainBySlug.set(chain.chain, chain);
  // The pools the fallback may take: with the lane plan every known pool of a
  // network GeckoTerminal serves (the plan asked DEX Screener about few of them),
  // with the full plan the plan's own pools, as before. The plan's pools come
  // first, in the plan's order.
  const plannedPools = plan.networks.flatMap(({ chain, pools }) =>
    pools.map((pool) => ({ chain, pool })),
  );
  const candidatePools =
    plan.mode === "lanes" && known
      ? [
          ...plannedPools,
          ...known.flatMap((pool) => {
            const chain = chainBySlug.get(pool.chain);
            return chain ? [{ chain, pool }] : [];
          }),
        ]
      : plannedPools;
  const seenCandidates = new Set();
  const considered = candidatePools.filter(({ chain, pool }) => {
    const key = poolKey(chain.chain, pool.id);
    if (!chain.gecko || seenCandidates.has(key)) return false;
    seenCandidates.add(key);
    return true;
  });
  // The pools GeckoTerminal priced last time (their state says so): how many of
  // them carry a measurement in this snapshot is counted at the end, so a pool that
  // is priced in one run and not in the next shows in status.json.
  const pricedByGecko = considered.filter(
    ({ pool }) => pool.via === "geckoterminal",
  );
  const unresolved = considered.filter(
    ({ chain, pool }) => !measured.has(poolKey(chain.chain, pool.id)),
  );
  // The lane plan has the tiered fallback (collector/fallback.mjs): the pools
  // GeckoTerminal priced last time and the pools of a network DEX Screener does not
  // index first, then a rotation over the rest, with its bookmarks kept in the
  // header of pools.json. The full plan keeps the earlier order: the priority list
  // first, then the pools GeckoTerminal measured last time, then the plan's order.
  // A planner that throws is a defect: it is counted and the earlier order is used.
  let tiered = null;
  if (plan.mode === "lanes") {
    try {
      tiered = planFallback({
        candidates: unresolved,
        limit: fallbackRequests,
        anchorMs: plan.window?.anchorMs ?? now(),
        nowMs: now(),
        unindexed: unsupportedNetworks,
        bookmarks,
      });
    } catch (error) {
      noteDefect(error);
    }
  }
  const fallbackPlan = tiered
    ? tiered.batches
    : fallbackBatches(unresolved, fallbackRequests, {
        protectedKeys: plan.mode === "lanes" ? new Set() : plan.protectedKeys,
      });
  // A network GeckoTerminal is asked about has a statistics row, whether or not
  // DEX Screener was asked about it in this run (as the Frontier step does for the
  // networks it supplies), so what GeckoTerminal answers for it is counted. The
  // row's `requested` stays what DEX Screener was asked: it is what the coverage
  // rows call attempted, and the quality gate judges it.
  for (const { chain } of fallbackPlan)
    if (!networks.has(chain.chain))
      networks.set(chain.chain, emptyNetwork(chain, 0));
  // What the requests did, by kind of request and by the tier each pool was taken
  // for (`carried`, `unindexed`, `sweep`; `ordered` for the earlier order).
  const TIERS = ["carried", "unindexed", "sweep", "ordered"];
  const tierCounts = (value) => Object.fromEntries(TIERS.map((t) => [t, value]));
  const byKind = { tier0: 0, sweep: 0, ordered: 0 };
  const idsByTier = tierCounts(0);
  const measuredByTier = tierCounts(0);
  const geckoNetworks = {};
  const tierOf = new Map();
  // A network's bookmark moves only for a request that was answered, and only
  // while every earlier request that moved it was answered: the bookmark of a
  // later request is worked out on the assumption that the earlier one was.
  const bookmarkUpdates = {};
  const blocked = new Set();
  const fallbackStartBy = Math.min(deadlineMs, fallbackLatestStartMs);
  for (const batch of fallbackPlan) {
    const { chain } = batch;
    if (client.isStopped("geckoterminal") || now() - startedAt >= fallbackStartBy)
      break;
    const ids = batch.pools.map((pool) => pool.id);
    const structural = new Map(batch.pools.map((pool) => [pool.id, pool]));
    const kind = batch.kind ?? "ordered";
    const tiers = batch.tiers ?? batch.pools.map(() => "ordered");
    batch.pools.forEach((pool, index) =>
      tierOf.set(poolKey(chain.chain, pool.id), tiers[index]),
    );
    fallback.requests++;
    fallback.ids += ids.length;
    byKind[kind]++;
    for (const tier of tiers) idsByTier[tier]++;
    const network = (geckoNetworks[chain.chain] ??= {
      requests: 0,
      ids: 0,
      measured: 0,
    });
    network.requests++;
    network.ids += ids.length;
    try {
      const result = await client.getJson(
        "geckoterminal",
        geckoMultiUrl(chain, ids),
        {
          maxBytes: GT_MAX_BYTES,
          notAfter: startedAt + fallbackStartBy,
        },
      );
      const { accepted, rejected } = classifyGeckoPools(
        result.data,
        chain,
        ids,
        structural,
      );
      const rowIds = new Set();
      for (const row of accepted) {
        const id = row.attributes.address.toLowerCase();
        const key = poolKey(chain.chain, id);
        rowIds.add(id);
        if (measured.has(key)) continue;
        const pool = normalizeGeckoPool(
          row,
          chain,
          structural.get(id),
          result.observedAt,
        );
        const stats = networks.get(chain.chain);
        // A pool a provider answered for is checked once, whichever provider
        // answered first.
        if (!answered.has(key)) {
          answered.add(key);
          stats.checked++;
        }
        // Answered with nothing usable: checked, never measured.
        if (!hasMarketValue(pool)) {
          note("geckoterminal", key, { outcome: "no-value" });
          continue;
        }
        measured.set(key, pool);
        stats.measured++;
        fallback.measured++;
        measuredByTier[tierOf.get(key) ?? "ordered"]++;
        network.measured++;
        geckoCounts.measuredByNetwork[chain.chain] =
          (geckoCounts.measuredByNetwork[chain.chain] ?? 0) + 1;
        note("geckoterminal", key, { outcome: "value" });
      }
      if (traced) noteUnused("geckoterminal", chain, ids, rowIds, rejected);
      if (batch.bookmark && !blocked.has(chain.chain))
        bookmarkUpdates[chain.chain] = batch.bookmark;
    } catch (error) {
      if (batch.bookmark) blocked.add(chain.chain);
      if (error?.code === "budget" || error?.code === "stopped") {
        // Never sent: not a request.
        fallback.requests--;
        fallback.ids -= ids.length;
        byKind[kind]--;
        for (const tier of tiers) idsByTier[tier]--;
        network.requests--;
        network.ids -= ids.length;
        break;
      }
      // Those pools stay unresolved: unknown, never zero.
      const reason = failureReason(error);
      if (isProviderAnswer(error)) {
        // A provider's answer, or the collector's reading of it (a request that
        // failed, an answer of the wrong shape): counted by its reason.
        geckoCounts.failedByReason[reason] =
          (geckoCounts.failedByReason[reason] ?? 0) + 1;
      } else {
        // Not a provider's answer: a defect in the collector (a pool or a chain
        // that is not what the code expects). It is counted where a test or a
        // person reading status.json can see it, never swallowed, and it never
        // fails the run (the fallback only adds measurements).
        noteDefect(error);
      }
      for (const id of ids)
        note("geckoterminal", poolKey(chain.chain, id), {
          outcome: "failed",
          reason,
        });
    }
  }
  fallback.bookmarks = bookmarkUpdates;
  return {
    startedAt,
    endedAt: now(),
    measured,
    networks: [...networks.values()],
    requestedPools: [...networks.values()].reduce((s, n) => s + n.requested, 0),
    // Every pool a provider answered for, requested from DEX Screener or not:
    // what the coverage rows count.
    checkedPools: [...networks.values()].reduce((s, n) => s + n.checked, 0),
    // Of the pools DEX Screener was asked about, those either provider answered
    // for. Never larger than requestedPools: what the quality gate judges.
    answeredPools: [...answered].filter((key) => requestedKeys.has(key)).length,
    dexRequests,
    // The pools DEX Screener was asked about, as chain:id keys.
    requestedKeys,
    // Every pool a provider answered for, as chain:id keys (asked of DEX Screener
    // or not): what checkedPools counts.
    answeredKeys: answered,
    unsupportedNetworks,
    // The networks DEX Screener did not answer for: their batches failed
    // MAX_CONSECUTIVE_FAILURES times in a row (the rest were not sent), or at
    // least two failed and none was ever answered. A network with one failed
    // batch, or a failure among answers, is not on it; nor is a network DEX
    // Screener does not index (above). As slugs, sorted.
    downNetworks: lanes
      .filter(
        (lane) =>
          !unsupportedNetworks.includes(lane.chain.chain) &&
          (lane.stopped || (!lane.answered && lane.stats.failedBatches >= 2)),
      )
      .map((lane) => lane.chain.chain)
      .sort(),
    fallback,
    telemetry: {
      dexscreener: {
        batches: dexRequests,
        failedBatches: {
          total: sumOf(dexCounts.failedByReason),
          byReason: sortedCounts(dexCounts.failedByReason),
        },
        rowsReturned: dexCounts.rowsReturned,
        rowsWithoutValue: dexCounts.rowsWithoutValue,
        rowsRejected: {
          total: sumOf(dexCounts.rejectedByReason),
          byReason: { ...dexCounts.rejectedByReason },
        },
        poolsAsked: requestedKeys.size,
        poolsWithRow: dexCounts.poolsWithRow,
        // The batches that failed when they were first asked (failedBatches above
        // counts them where they failed, and also counts a network's first answer of
        // HTTP 400, which says the network is not indexed and is not a batch that
        // failed: it is left out here) and what was done about it: `retried` were
        // asked again, `recovered` answered the second time, `stillFailed` are the
        // batches unanswered at the end (asked again and failed, or not asked again),
        // `notRetried` says why the others were not asked again (`not-retryable`: a
        // failure that would not change; `limit`, `time`, `requests`, `stopped`,
        // `not-sent`), `networks` where, and `stillFailedBatches` (at most 25) names
        // each unanswered batch with its pools and its last reason.
        retry: {
          maxBatches: retryBatches,
          burstLimitMs: retryLatestStartMs,
          failedFirstPass: failedFirstPass.length,
          retried: retryState.retried,
          recovered: retryState.recovered,
          stillFailed: stillFailed.length,
          notRetried: sortedCounts(retryState.notRetried),
          networks: {
            recovered: [...retryState.recoveredNetworks].sort(),
            stillFailed: [...new Set(stillFailed.map((b) => b.chain))].sort(),
          },
          stillFailedBatches: stillFailed.slice(0, 25),
          // A defect in the retry step (null when there was none): counted here and
          // nowhere else, and the burst went on.
          error: retryState.defect,
        },
      },
      geckoterminal: {
        requests: fallback.requests,
        failures: {
          total: sumOf(geckoCounts.failedByReason),
          byReason: sortedCounts(geckoCounts.failedByReason),
        },
        idsAsked: fallback.ids,
        measured: fallback.measured,
        measuredByNetwork: sortedCounts(geckoCounts.measuredByNetwork),
        // Errors that were not a provider's answer: a defect in the collector. The
        // fallback goes on and the run is not failed, so a defect shows here and
        // nowhere else (null when there was none).
        errors: { total: geckoErrors.total, last: geckoErrors.last },
        // The fallback in this run: which order it used (`tiers`: the lane plan's, or
        // `ordered`: the earlier order of the full plan), its request limit and how
        // the limit was divided (tier 0 at most `tier0` requests, the rotation at
        // least `sweepReserve`), the pools there were for each tier before the limit
        // cut, and what the requests did: requests by kind, pools asked and pools
        // measured by the tier they were taken for, and per network. Pools measured
        // here are pools measured in this snapshot, not pools found since the edition
        // began. `pricedLastTime` is how many pools GeckoTerminal priced when they
        // were last measured and how many of them carry a measurement in this
        // snapshot, from either provider: the pools that are priced in one run and not
        // in the next are the difference.
        fallback: {
          mode: tiered ? "tiers" : "ordered",
          limit: fallbackRequests,
          split: tiered
            ? {
                tier0: tiered.split.tier0,
                sweepReserve: tiered.split.sweepReserve,
              }
            : null,
          available: tiered ? { ...tiered.available } : null,
          requests: { ...byKind },
          idsAsked: { ...idsByTier },
          measured: { ...measuredByTier },
          networks: Object.fromEntries(
            Object.keys(geckoNetworks)
              .sort()
              .filter((slug) => geckoNetworks[slug].requests > 0)
              .map((slug) => [slug, { ...geckoNetworks[slug] }]),
          ),
          pricedLastTime: {
            known: pricedByGecko.length,
            measuredNow: pricedByGecko.filter(({ chain, pool }) =>
              measured.has(poolKey(chain.chain, pool.id)),
            ).length,
          },
          bookmarksMoved: Object.keys(bookmarkUpdates).sort(),
        },
      },
    },
    // What each provider did with each traced pool (null: no pool was traced).
    trace: traced,
  };
}

/** Up to `limit` batches of at most 30 unresolved ids, one network per batch.
 *
 * The order of preference: pools of the priority list that GeckoTerminal
 * measured last time, the rest of the priority list, other pools GeckoTerminal
 * measured last time (the ones DEX Screener is known not to cover), then the
 * plan's order (the sort is stable). A pool is only taken when it fits one of
 * the `limit` requests: a network that has no open batch when the limit is
 * reached gets none, so no request is spent on a few low-ranked pools while
 * higher-ranked ones wait. */
export function fallbackBatches(
  unresolved,
  limit = GT_FALLBACK_MAX_REQUESTS,
  { protectedKeys = new Set() } = {},
) {
  const rank = ({ chain, pool }) =>
    (protectedKeys.has(poolKey(chain.chain, pool.id)) ? 0 : 2) +
    (pool.via === "geckoterminal" ? 0 : 1);
  const ordered = [...unresolved].sort((a, b) => rank(a) - rank(b));
  return packBatches(ordered, limit);
}
