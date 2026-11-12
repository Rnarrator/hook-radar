import {
  collectFrontierMetrics,
  getFrontierMarketObservation,
} from "../../server/providers.mjs";
import { MAX_BYTES } from "../config.mjs";
import { hasMarketValue } from "./market-rows.mjs";

// Frontier's own market figures for the pools of its hooks, read the way the
// live Hook Radar reads them: server/providers.mjs (collectFrontierMetrics) is
// imported and run unchanged. It needs one function that fetches JSON, and this
// file gives it one that goes through the collector's paced client: three
// requests (the coin listing, the ETH/USD statistics and one query to the public
// AMM index Frontier's own configuration names), host-locked, with the
// collector's gaps and size limits. Nothing here changes what a figure means:
// the pools, the amounts, the labels and the evidence come from that code.

/** The collector lane, size limit and request kind of each source id the live
 * code asks for. Any other id (the per-coin configuration lookups of its
 * fallback) is answered "unavailable" without a request. */
const SOURCES = Object.freeze({
  "frontier-coins": { lane: "frontier", maxBytes: MAX_BYTES.frontierMarkets },
  "frontier-stats": { lane: "frontier", maxBytes: MAX_BYTES.frontierMarkets },
  "frontier-amm-index": {
    lane: "goldsky",
    maxBytes: MAX_BYTES.frontierIndex,
  },
});

const NOT_REQUESTED =
  "Not requested: the edition reads Frontier's pool-to-hook addresses from the AMM index only, to keep its requests few.";

// The client's error codes that mean the request was never sent.
const NOT_SENT = new Set(["budget", "stopped", "url", "body", "provider"]);

const failureNote = (error) =>
  String(error?.message || "Source request failed").slice(0, 160);

/** The `fetchJson` the live collector expects, over the paced client. It never
 * rejects: a failed, refused, oversized or invalid answer is `unavailable` with
 * no data and no time, exactly like the live store's. `requests` counts the
 * requests sent for each source id. `listing` says what the coin listing itself
 * reported when it answered: `rows` (how many coin rows it held, before any is
 * filtered out) and `total` (the `total` field of the listing, which is Frontier's
 * own count and can be larger than the rows read). Both are null until the
 * listing has answered with those fields: null is not zero. */
export function frontierFetchJson(client) {
  const requests = {};
  const listing = { rows: null, total: null };
  const fetchJson = async (id, url, options = {}) => {
    const source = SOURCES[id];
    if (!source)
      return {
        data: null,
        url,
        updatedAt: null,
        status: "unavailable",
        note: NOT_REQUESTED,
      };
    try {
      const result = await client.getJson(source.lane, url, {
        maxBytes: source.maxBytes,
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.method === "POST" ? { body: options.body } : {}),
      });
      requests[id] = (requests[id] ?? 0) + 1;
      if (id === "frontier-coins") {
        const rows = result.data?.data;
        const total = result.data?.total;
        listing.rows = Array.isArray(rows) ? rows.length : null;
        listing.total =
          Number.isSafeInteger(total) && total >= 0 ? total : null;
      }
      const data = options.validate
        ? options.validate(result.data)
        : result.data;
      return {
        data,
        url,
        updatedAt: new Date(result.observedAt).toISOString(),
        status: "live",
        note: "Fetched successfully from the published source.",
      };
    } catch (error) {
      // A request the client refused before sending (a spent budget, a stopped
      // lane, a malformed one) is not a request; every other failure is one.
      if (!NOT_SENT.has(error?.code) && !(id in requests))
        requests[id] = (requests[id] ?? 0) + 1;
      return {
        data: null,
        url,
        updatedAt: null,
        status: "unavailable",
        note: failureNote(error),
      };
    }
  };
  return { fetchJson, requests, listing };
}

const sameTokens = (a, b) =>
  Array.isArray(a) &&
  a.length === b.length &&
  a.every((token, index) => token.toLowerCase() === b[index].toLowerCase());

/** The pool rows Frontier supplied, in the shape of the collector's measured
 * pools. Only a row the live producer itself vouched for is used (its private
 * evidence handoff), and a pool the state already knows keeps its structure
 * (name, creation time) and must agree on the hook and the two currencies:
 * Frontier cannot move a known pool to another hook. */
export function frontierPools(rows, known = new Map()) {
  const pools = [];
  const skipped = [];
  for (const row of rows) {
    const proof = getFrontierMarketObservation(row);
    if (!proof) continue;
    const key = `${proof.chain}:${proof.address}`;
    const state = known.get(key);
    if (
      state &&
      (state.hookAddress.toLowerCase() !== proof.hookAddress.toLowerCase() ||
        !sameTokens(state.tokens, proof.tokens))
    ) {
      skipped.push(key);
      continue;
    }
    const pool = {
      id: proof.id,
      chain: proof.chain,
      chainId: proof.chainId,
      address: proof.address,
      hookAddress: proof.hookAddress.toLowerCase(),
      projectId: null,
      name: state?.name || row.name,
      url: proof.url,
      source: proof.source,
      liquidityUsd: proof.liquidityUsd,
      volumeUsd: { ...proof.volumeUsd },
      createdAt: state?.createdAt ?? row.createdAt ?? null,
      tokens: [...proof.tokens],
      metricUpdatedAt: proof.metricUpdatedAt,
      metricStatus: proof.metricStatus,
      metricProvider: "frontier",
      metricProvenance: proof.provenance.map((entry) => ({ ...entry })),
    };
    // A row with no figure at all is an answer, not a measurement.
    if (hasMarketValue(pool)) pools.push({ key, pool });
  }
  return { pools, skipped };
}

/** The live rule for a second provider's row of the same pool: the newer
 * measurement replaces the older whole, never merged with it. */
export function newerMeasurement(previous, incoming) {
  const before = Date.parse(previous.metricUpdatedAt || "");
  const next = Date.parse(incoming.metricUpdatedAt || "");
  return (
    Number.isFinite(next) &&
    (!Number.isFinite(before) ||
      next > before ||
      (next === before && incoming.metricStatus !== previous.metricStatus))
  );
}

/** Frontier's rows laid over the measurements the burst made. Returns a new map
 * and how many rows were added, replaced an older provider row or were left
 * out because the other provider's row is newer. */
export function overlayFrontier(measured, pools) {
  const merged = new Map(measured);
  const count = { added: 0, replaced: 0, kept: 0 };
  for (const { key, pool } of pools) {
    const old = merged.get(key);
    if (!old) {
      merged.set(key, pool);
      count.added++;
    } else if (newerMeasurement(old, pool)) {
      merged.set(key, pool);
      count.replaced++;
    } else count.kept++;
  }
  return { measured: merged, ...count };
}

const emptyStep = () => ({
  pools: [],
  skipped: [],
  sources: [],
  requests: {},
  pricedCoins: 0,
  // What the coin listing reported (see frontierFetchJson): null when it did not
  // answer, which is not zero.
  listing: { rows: null, total: null },
  failure: null,
});

/** The step when it was left out: no request, no pool, and the reason. */
export const skippedFrontier = (reason) => ({
  ...emptyStep(),
  failure: reason,
});

/** The per-network rows the coverage table is made from, with the pools Frontier
 * was asked about and answered for that DEX Screener was not asked about: they
 * were requested and answered like any other pool, so a network they sit on is
 * never shown as "not asked" while it carries their measurements. The totals the
 * quality gate judges (pools requested, pools answered) are the burst's own and
 * are not changed. */
export function withFrontierNetworks(networks, pools, requestedKeys, chainIds) {
  const rows = networks.map((row) => ({ ...row }));
  for (const { key, pool } of pools) {
    if (requestedKeys.has(key)) continue;
    let row = rows.find((candidate) => candidate.chain === pool.chain);
    if (!row) {
      row = {
        chain: pool.chain,
        chainId: chainIds.get(pool.chain) ?? pool.chainId,
        planned: 0,
        requested: 0,
        checked: 0,
        measured: 0,
        failedBatches: 0,
      };
      rows.push(row);
    }
    row.requested++;
    row.checked++;
    row.measured++;
  }
  return rows;
}

/** One Frontier step: the three requests, the pools and the sources the live
 * code reports. It never throws. When Frontier's configuration names no
 * Robinhood chain (or the state has none) nothing is requested. */
export async function collectFrontier({
  client,
  frontierChains,
  known = new Map(),
  now,
}) {
  const empty = emptyStep();
  try {
    const { fetchJson, requests, listing } = frontierFetchJson(client);
    const metrics = await collectFrontierMetrics({
      fetchJson,
      frontierChains: frontierChains ?? [],
      now: now(),
    });
    return {
      ...empty,
      ...frontierPools(metrics.pools, known),
      sources: metrics.sources,
      requests,
      pricedCoins: metrics.totalObservedPools,
      listing: { ...listing },
    };
  } catch (error) {
    // The live code does not throw on a failed source; anything that does is a
    // defect or a change in it, and must not take the run down.
    return { ...empty, failure: failureNote(error) };
  }
}
