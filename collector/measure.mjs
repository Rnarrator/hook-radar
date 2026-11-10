import {
  ADDITIONAL_MARKET_CHAINS,
  MARKET_CHAINS,
} from "../server/market-chains.mjs";
import {
  BURST_BUDGET_MS,
  BURST_DEADLINE_MS,
  DS_BATCH_SIZE,
  GT_FALLBACK_BATCH_SIZE,
  GT_FALLBACK_MAX_REQUESTS,
  MAX_CONSECUTIVE_FAILURES,
  MAX_DISCOVERED_MEASURED,
  MAX_MEASURED_POOLS,
} from "./config.mjs";
import {
  acceptDexScreenerPairs,
  DS_MAX_BYTES,
  DS_NETWORKS,
  dexScreenerUrl,
  normalizeDexScreenerPool,
} from "./providers/dexscreener.mjs";
import {
  acceptGeckoPools,
  geckoMultiUrl,
  GT_MAX_BYTES,
  normalizeGeckoPool,
} from "./providers/geckoterminal.mjs";
import { hasMarketValue } from "./providers/market-rows.mjs";
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

/** Which pools the burst asks about, grouped per network (largest first).
 *
 * `maxPools` is the whole plan. Seeded pools come first; pools found by
 * discovery use what is left of it, at most `maxDiscovered`, so a new pool can
 * never push a seeded one out of the burst. Within a group the most recently
 * seen come first, then the id, so the same pool set always yields the same
 * requests. */
export function planBurst(
  pools,
  {
    maxPools = MAX_MEASURED_POOLS + MAX_DISCOVERED_MEASURED,
    maxDiscovered = MAX_DISCOVERED_MEASURED,
    chains = measurementChains(),
  } = {},
) {
  const bySlug = new Map(chains.map((chain) => [chain.chain, chain]));
  const eligible = pools.filter((pool) => bySlug.has(pool.chain));
  const seeded = eligible
    .filter((pool) => !isDiscovered(pool))
    .sort(byPriority)
    .slice(0, maxPools);
  const discovered = eligible
    .filter(isDiscovered)
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
    unsupported: pools.length - eligible.length,
    batches: networks.reduce(
      (sum, { pools: rows }) => sum + Math.ceil(rows.length / DS_BATCH_SIZE),
      0,
    ),
  };
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
 * measured, so every count agrees with the pools the snapshot carries. */
export async function runBurst({
  client,
  plan,
  now,
  budgetMs = BURST_BUDGET_MS,
  deadlineMs = BURST_DEADLINE_MS,
  fallbackRequests = GT_FALLBACK_MAX_REQUESTS,
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
      done: pools.length === 0,
    };
  });
  let ended = false;
  while (!ended && lanes.some((lane) => !lane.done)) {
    for (const lane of lanes) {
      if (lane.done) continue;
      if (client.isStopped("dexscreener") || now() - startedAt >= budgetMs) {
        ended = true;
        break;
      }
      const { chain, stats, structural } = lane;
      const ids = lane.pools
        .slice(lane.next, lane.next + DS_BATCH_SIZE)
        .map((pool) => pool.id);
      lane.next += DS_BATCH_SIZE;
      if (lane.next >= lane.pools.length) lane.done = true;
      stats.requested += ids.length;
      for (const id of ids) requestedKeys.add(poolKey(chain.chain, id));
      dexRequests++;
      try {
        const result = await client.getJson(
          "dexscreener",
          dexScreenerUrl(chain, ids),
          {
            maxBytes: DS_MAX_BYTES,
            notAfter: startedAt + budgetMs,
            tolerate: lane.answered ? [] : [DS_UNINDEXED_STATUS],
          },
        );
        lane.answered = true;
        const rows = acceptDexScreenerPairs(
          result.data,
          chain,
          ids,
          structural,
        );
        lane.failedInARow = 0;
        stats.checked += ids.length;
        for (const id of ids) answered.add(poolKey(chain.chain, id));
        for (const row of rows) {
          const id = row.pairAddress.toLowerCase();
          const pool = normalizeDexScreenerPool(
            row,
            chain,
            structural.get(id),
            result.observedAt,
          );
          // Answered with nothing usable: unresolved, left to the fallback.
          if (!hasMarketValue(pool)) continue;
          measured.set(poolKey(chain.chain, id), pool);
          stats.measured++;
        }
      } catch (error) {
        if (error?.code === "budget" || error?.code === "stopped") {
          // Never sent: not a request, not a failed batch. The provider cannot
          // start another request in time either, so the phase ends.
          stats.requested -= ids.length;
          for (const id of ids) requestedKeys.delete(poolKey(chain.chain, id));
          dexRequests--;
          ended = true;
          break;
        }
        stats.failedBatches++;
        if (error?.status === DS_UNINDEXED_STATUS && !lane.answered) {
          unsupportedNetworks.push(chain.chain);
          lane.done = true;
        } else if (++lane.failedInARow >= MAX_CONSECUTIVE_FAILURES)
          lane.done = true;
      }
    }
  }

  const fallback = { requests: 0, measured: 0, ids: 0 };
  const unresolved = plan.networks.flatMap(({ chain, pools }) =>
    chain.gecko
      ? pools
          .filter((pool) => !measured.has(poolKey(chain.chain, pool.id)))
          .map((pool) => ({ chain, pool }))
      : [],
  );
  for (const batch of fallbackBatches(unresolved, fallbackRequests)) {
    if (client.isStopped("geckoterminal") || now() - startedAt >= deadlineMs)
      break;
    const { chain } = batch;
    const ids = batch.pools.map((pool) => pool.id);
    const structural = new Map(batch.pools.map((pool) => [pool.id, pool]));
    fallback.requests++;
    fallback.ids += ids.length;
    try {
      const result = await client.getJson(
        "geckoterminal",
        geckoMultiUrl(chain, ids),
        {
          maxBytes: GT_MAX_BYTES,
          notAfter: startedAt + deadlineMs,
        },
      );
      for (const row of acceptGeckoPools(result.data, chain, ids, structural)) {
        const id = row.attributes.address.toLowerCase();
        const key = poolKey(chain.chain, id);
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
        if (!hasMarketValue(pool)) continue;
        measured.set(key, pool);
        stats.measured++;
        fallback.measured++;
      }
    } catch (error) {
      if (error?.code === "budget" || error?.code === "stopped") {
        // Never sent: not a request.
        fallback.requests--;
        fallback.ids -= ids.length;
        break;
      }
      /* Those pools stay unresolved: unknown, never zero. */
    }
  }
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
    unsupportedNetworks,
    fallback,
  };
}

/** Up to `limit` batches of at most 30 unresolved ids, one network per batch. */
export function fallbackBatches(unresolved, limit = GT_FALLBACK_MAX_REQUESTS) {
  // Pools GeckoTerminal measured last time come first: they are the ones DEX
  // Screener is known not to cover. The sort is stable, so the rest keep the
  // plan's order.
  const ordered = [...unresolved].sort(
    (a, b) =>
      Number(b.pool.via === "geckoterminal") -
      Number(a.pool.via === "geckoterminal"),
  );
  const buffers = new Map();
  const batches = [];
  for (const { chain, pool } of ordered) {
    if (batches.length >= limit) break;
    if (!buffers.has(chain.chain))
      buffers.set(chain.chain, { chain, pools: [] });
    const buffer = buffers.get(chain.chain);
    buffer.pools.push(pool);
    if (buffer.pools.length === GT_FALLBACK_BATCH_SIZE) {
      batches.push(buffer);
      buffers.set(chain.chain, { chain, pools: [] });
    }
  }
  for (const buffer of buffers.values())
    if (batches.length < limit && buffer.pools.length) batches.push(buffer);
  return batches;
}
