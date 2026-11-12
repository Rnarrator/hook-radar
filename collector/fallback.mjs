import {
  FALLBACK_SWEEP_OVERDUE_MS,
  FALLBACK_SWEEP_RESERVE_DIVISOR,
  FALLBACK_TIER0_MAX_REQUESTS,
  GT_FALLBACK_BATCH_SIZE,
  LANE_HOT_MAX_AGE_MS,
} from "./config.mjs";
import { poolKey } from "./state.mjs";

// The GeckoTerminal fallback of the lane plan: which pools it asks about and in
// what order. A request is one network and at most GT_FALLBACK_BATCH_SIZE pools.
//
// The fallback used to ask about the same pools in every run (the first ones of
// the largest network, in plan order), so the pools GeckoTerminal priced in an
// earlier run were not asked again unless they came first, and most networks were
// never reached. It now has two parts:
//
//   tier 0  the pools whose last measurement came from GeckoTerminal and that
//           answered in the last 72 hours ("carried"), and the pools of a network
//           DEX Screener answered HTTP 400 for in this run ("unindexed"), in
//           every run. They are the pools that stay in the snapshot only if
//           GeckoTerminal is asked about them again. They take at most
//           FALLBACK_TIER0_MAX_REQUESTS requests and at most what is left after
//           the sweep's reserve (a third of the requests). The carried pools come
//           before the unindexed ones; within each kind the network with the most
//           pools comes first (a tie goes to the slug) and, inside a network, the
//           most recently answered pool first, so the requests are full and the
//           largest block is the one never left out when there are more networks
//           than requests. The pools tier 0 has no room for join the sweep.
//   sweep   a rotation over every other pool of every network, so that over
//           time every pool is asked about and every network is visited. A network
//           keeps two bookmarks in the header of pools.json (`cursors.gt`): where its
//           sweep stopped among the pools that answered before (`q`) and among the
//           pools that never answered (`p`), and when it was last visited (`at`, in
//           hours). A request takes the next pools after the bookmarks, half from
//           each kind, going round when the end is reached.
//
// A pool DEX Screener measured in this run is never asked about; a request that
// fails moves no bookmark.

/** The place of a pool in a sweep: the last 48 bits of its id as a whole number.
 * Pool ids are hashes, so the places of a set of pools are even; the low bits are
 * used so that a made-up id with leading zeros still has a place of its own. */
export function sweepPlace(id) {
  const place = Number.parseInt(String(id).slice(-12), 16);
  return Number.isFinite(place) ? place : 0;
}

const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const bySweepOrder = (a, b) =>
  sweepPlace(a.id) - sweepPlace(b.id) || compareText(a.id, b.id);
const newestFirst = (a, b) =>
  Date.parse(b.pool.lastSeen) - Date.parse(a.pool.lastSeen) ||
  compareText(a.pool.id, b.pool.id);

/** `items` (`{ chain, pool }`) in the order tier 0 takes them: the network with the
 * most of them first (a tie goes to the slug, so the same pools always give the same
 * order), and inside a network the most recently answered first. A network's pools are
 * together, so every request but the last of a network is full and a request is not
 * spent on a few pools while a larger block waits. */
function byNetworkBlock(items) {
  const sizes = new Map();
  for (const { chain } of items)
    sizes.set(chain.chain, (sizes.get(chain.chain) ?? 0) + 1);
  return [...items].sort(
    (a, b) =>
      sizes.get(b.chain.chain) - sizes.get(a.chain.chain) ||
      compareText(a.chain.chain, b.chain.chain) ||
      newestFirst(a, b),
  );
}

const HOUR_MS = 3600000;
// A network the sweep has never visited is as overdue as a network can be.
const NEVER_VISITED_HOURS = 1e9;

/** Whether a pool's last measurement came from GeckoTerminal (`via`) and it
 * answered in the 72 hours before `anchorMs`. DEX Screener has not priced such a
 * pool lately, so GeckoTerminal is asked about it in every run (tier 0) and DEX
 * Screener on its slower wheel. */
export function isGeckoCarried(pool, anchorMs) {
  if (pool.via !== "geckoterminal") return false;
  const lastSeen = Date.parse(pool.lastSeen);
  return (
    lastSeen > Date.parse(pool.firstSeen) &&
    anchorMs - lastSeen < LANE_HOT_MAX_AGE_MS
  );
}

/** How many of the fallback's requests tier 0 may take. A third of them (rounded
 * down) are the sweep's, so the rotation reaches the other networks even when
 * tier 0 is large; tier 0 never takes more than FALLBACK_TIER0_MAX_REQUESTS. The
 * sweep also gets whatever tier 0 does not use. */
export function fallbackSplit(limit) {
  const total = Number.isSafeInteger(limit) && limit > 0 ? limit : 0;
  const sweepReserve = Math.floor(total / FALLBACK_SWEEP_RESERVE_DIVISOR);
  return {
    total,
    tier0: Math.min(FALLBACK_TIER0_MAX_REQUESTS, total - sweepReserve),
    sweepReserve,
  };
}

/** Up to `limit` batches of at most GT_FALLBACK_BATCH_SIZE pools, one network per
 * batch, from `ordered` (`{ chain, pool }`, best first). A pool is only taken when
 * it fits one of the `limit` requests: a network that has no open batch when the
 * limit is reached gets none, so no request is spent on a few low-ranked pools
 * while higher-ranked ones wait. */
export function packBatches(ordered, limit) {
  const buffers = new Map();
  const batches = [];
  for (const { chain, pool } of ordered) {
    if (!buffers.has(chain.chain)) {
      if (batches.length + buffers.size >= limit) continue;
      buffers.set(chain.chain, { chain, pools: [] });
    }
    const buffer = buffers.get(chain.chain);
    buffer.pools.push(pool);
    if (buffer.pools.length === GT_FALLBACK_BATCH_SIZE) {
      batches.push(buffer);
      buffers.delete(chain.chain);
    }
  }
  return [...batches, ...buffers.values()];
}

const cursorNumber = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

/** One network's sweep: the pools of the network not taken by tier 0, in two
 * lists (answered before, never answered), each in sweep order, and the
 * bookmarks read from the header. */
function newSweep(chain, pools, bookmark) {
  const answeredBefore = [];
  const neverAnswered = [];
  for (const pool of pools)
    (Date.parse(pool.lastSeen) > Date.parse(pool.firstSeen)
      ? answeredBefore
      : neverAnswered
    ).push(pool);
  answeredBefore.sort(bySweepOrder);
  neverAnswered.sort(bySweepOrder);
  return {
    chain,
    answered: answeredBefore,
    never: neverAnswered,
    q: cursorNumber(bookmark?.q),
    p: cursorNumber(bookmark?.p),
    at: cursorNumber(bookmark?.at),
    visited: false,
  };
}

/** The next `count` pools of `list` (in sweep order) after the place `after`, going
 * round to the start when the end is reached; each pool at most once. */
function takeAfter(list, after, count) {
  if (count <= 0 || list.length === 0) return { taken: [], last: after };
  let start = 0;
  if (after !== undefined) {
    start = list.findIndex((pool) => sweepPlace(pool.id) > after);
    if (start === -1) start = 0;
  }
  const taken = [];
  for (let i = 0; i < Math.min(count, list.length); i++)
    taken.push(list[(start + i) % list.length]);
  return { taken, last: sweepPlace(taken.at(-1).id) };
}

/** Takes up to `count` pools from a network's sweep, half from the pools that
 * answered before and half from those that never did (what one kind cannot fill
 * the other does), moves the sweep's bookmarks and removes the pools from its
 * lists. Returns the pools and the bookmarks as they will be written. */
function takeSweep(sweep, count, nowHour) {
  const answeredQuota = Math.ceil(count / 2);
  const neverQuota = count - answeredQuota;
  const answeredOwn = Math.min(sweep.answered.length, answeredQuota);
  const neverOwn = Math.min(sweep.never.length, neverQuota);
  // A kind that has fewer pools than its half leaves the rest to the other.
  const answered = takeAfter(
    sweep.answered,
    sweep.q,
    answeredOwn +
      Math.min(sweep.answered.length - answeredOwn, neverQuota - neverOwn),
  );
  const never = takeAfter(
    sweep.never,
    sweep.p,
    neverOwn +
      Math.min(sweep.never.length - neverOwn, answeredQuota - answeredOwn),
  );
  const taken = new Set([...answered.taken, ...never.taken]);
  sweep.answered = sweep.answered.filter((pool) => !taken.has(pool));
  sweep.never = sweep.never.filter((pool) => !taken.has(pool));
  sweep.q = answered.last;
  sweep.p = never.last;
  sweep.at = nowHour;
  sweep.visited = true;
  return {
    pools: [...answered.taken, ...never.taken],
    bookmark: {
      ...(sweep.p === undefined ? {} : { p: sweep.p }),
      ...(sweep.q === undefined ? {} : { q: sweep.q }),
      at: nowHour,
    },
  };
}

/** The network the next sweep request goes to: first the networks the sweep has not
 * visited for FALLBACK_SWEEP_OVERDUE_MS (a network never visited counts as the
 * longest), the longest unvisited first, so that every network with pools is
 * reached once a day when there are requests enough; then, by the product of the
 * hours since the visit and the requests its pools need (so a larger network is
 * visited more often, in proportion to its size). A network already served in this
 * run counts as visited now. Ties go to the larger network and then to the slug,
 * so the same state always gives the same answer. */
function chooseSweep(sweeps, nowHour) {
  let best = null;
  for (const sweep of sweeps) {
    const remaining = sweep.answered.length + sweep.never.length;
    if (remaining === 0) continue;
    const hours = sweep.visited
      ? 0
      : sweep.at === undefined
        ? NEVER_VISITED_HOURS
        : Math.max(0, nowHour - sweep.at);
    const entry = {
      sweep,
      overdue: !sweep.visited && hours * HOUR_MS >= FALLBACK_SWEEP_OVERDUE_MS,
      hours,
      need: Math.ceil(remaining / GT_FALLBACK_BATCH_SIZE),
    };
    if (!best || sweepBefore(entry, best)) best = entry;
  }
  return best?.sweep ?? null;
}

function sweepBefore(a, b) {
  if (a.overdue !== b.overdue) return a.overdue;
  if (a.overdue && a.hours !== b.hours) return a.hours > b.hours;
  const weight = a.hours * a.need - b.hours * b.need;
  if (!a.overdue && weight !== 0) return weight > 0;
  if (a.need !== b.need) return a.need > b.need;
  return a.sweep.chain.chain < b.sweep.chain.chain;
}

/** The GeckoTerminal requests of one run, in the order they are sent.
 *
 * `candidates` are the pools no provider measured in this run, as
 * `{ chain, pool }` for every network GeckoTerminal serves, whether or not DEX
 * Screener was asked about the pool in this run. `limit` is the most requests the
 * fallback may send, `anchorMs` the moment the lanes were judged at (a pool is
 * carried when it answered in the 72 hours before it) and `nowMs` the time of the
 * run. `unindexed` are the networks DEX Screener answered HTTP 400 for in this
 * run. `bookmarks` is `cursors.gt` of the header of pools.json.
 *
 * Returns `{ batches, split, available }`. Each batch is
 * `{ chain, pools, kind, tiers, bookmark }`: `kind` is `tier0` or `sweep`, `tiers`
 * says for each pool `carried`, `unindexed` or `sweep`, and `bookmark` (null when
 * the batch holds no sweep pool) is what the network's bookmark becomes when the
 * request has been answered (the caller applies it only in order and only for
 * answered requests). A tier 0 batch with room left is filled up from the sweep of
 * its network: a request costs the same however many pools it holds.
 * `available` counts the pools there were for each tier before the limit cut.
 *
 * Nothing here reads the clock or a provider: the same inputs give the same
 * batches. */
export function planFallback({
  candidates,
  limit,
  anchorMs,
  nowMs,
  unindexed = [],
  bookmarks = {},
}) {
  const split = fallbackSplit(limit);
  const nowHour = Math.floor(nowMs / HOUR_MS);
  const indexless = new Set(unindexed);
  const carriedItems = [];
  const unindexedItems = [];
  const rest = [];
  for (const item of candidates) {
    if (isGeckoCarried(item.pool, anchorMs)) carriedItems.push(item);
    else if (indexless.has(item.chain.chain)) unindexedItems.push(item);
    else rest.push(item);
  }
  // Tier 0 opens a request for a network the first time it meets one, and no
  // request once the limit is reached, so the order decides which networks are asked.
  // The largest block of a kind goes first: with many networks the biggest block of
  // carried pools is the one that must not be left out.
  const carried = byNetworkBlock(carriedItems);
  const unindexedPools = byNetworkBlock(unindexedItems);
  const carriedKeys = new Set(
    carried.map(({ chain, pool }) => poolKey(chain.chain, pool.id)),
  );
  const first = packBatches([...carried, ...unindexedPools], split.tier0);
  const placed = new Set(
    first.flatMap(({ chain, pools }) =>
      pools.map((pool) => poolKey(chain.chain, pool.id)),
    ),
  );

  // What is left, with the pools tier 0 had no room for, is the sweep's.
  const byChain = new Map();
  let sweepPools = 0;
  for (const item of [...carried, ...unindexedPools, ...rest]) {
    const key = poolKey(item.chain.chain, item.pool.id);
    if (placed.has(key)) continue;
    if (!byChain.has(item.chain.chain))
      byChain.set(item.chain.chain, { chain: item.chain, pools: [] });
    byChain.get(item.chain.chain).pools.push(item.pool);
    sweepPools++;
  }
  const sweeps = new Map(
    [...byChain].map(([slug, { chain, pools }]) => [
      slug,
      newSweep(chain, pools, bookmarks?.[slug]),
    ]),
  );

  const batches = first.map(({ chain, pools }) => {
    const batch = {
      chain,
      pools: [...pools],
      kind: "tier0",
      tiers: pools.map((pool) =>
        carriedKeys.has(poolKey(chain.chain, pool.id)) ? "carried" : "unindexed",
      ),
      bookmark: null,
    };
    const sweep = sweeps.get(chain.chain);
    if (sweep && batch.pools.length < GT_FALLBACK_BATCH_SIZE) {
      const filled = takeSweep(
        sweep,
        GT_FALLBACK_BATCH_SIZE - batch.pools.length,
        nowHour,
      );
      if (filled.pools.length) {
        batch.pools.push(...filled.pools);
        batch.tiers.push(...filled.pools.map(() => "sweep"));
        batch.bookmark = filled.bookmark;
      }
    }
    return batch;
  });
  while (batches.length < split.total) {
    const sweep = chooseSweep([...sweeps.values()], nowHour);
    if (!sweep) break;
    const taken = takeSweep(sweep, GT_FALLBACK_BATCH_SIZE, nowHour);
    batches.push({
      chain: sweep.chain,
      pools: taken.pools,
      kind: "sweep",
      tiers: taken.pools.map(() => "sweep"),
      bookmark: taken.bookmark,
    });
  }
  return {
    batches,
    split,
    available: {
      carried: carried.length,
      unindexed: unindexedPools.length,
      sweep: sweepPools,
    },
  };
}

/** The header's `cursors` with the bookmarks `updates` (`{ slug: bookmark }`)
 * written into the `gt` family. Nothing else in the header is touched. */
export function withGeckoBookmarks(cursors, updates) {
  if (!updates || !Object.keys(updates).length) return cursors;
  return { ...cursors, gt: { ...(cursors?.gt ?? {}), ...updates } };
}
