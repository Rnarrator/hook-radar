import { METRIC_CHAINS } from "../server/market-chains.mjs";
import { MAX_RESOLVES_PER_RUN } from "./config.mjs";
import {
  GT_MAX_BYTES,
  marketDiscoveryUrl,
  validateMarketDiscovery,
} from "./providers/geckoterminal.mjs";
import {
  dynamicFeeEvidence,
  poolDetailUrl,
  poolListUrl,
  V4_DETAIL_MAX_BYTES,
  V4_LIST_MAX_BYTES,
  validateEnvioPools,
  validateIndexerPoolIdentity,
} from "./providers/v4xyz.mjs";
import { failureReason } from "./measure.mjs";
import { poolKey } from "./state.mjs";

export const discoveryStats = (page = null, resolveBudget = 0) => ({
  page,
  geckoPages: 0,
  geckoCandidates: 0,
  geckoPageFailures: 0,
  // Why those pages failed, as short words (`http-503`, `timeout`, `shape`, ...:
  // see failureReason in measure.mjs), each with its count.
  geckoPageFailureReasons: {},
  indexerLists: 0,
  indexerListed: 0,
  indexerListFailures: 0,
  resolveBudget,
  resolvesTried: 0,
  resolvedHooked: 0,
  resolvedHookless: 0,
  unresolved: 0,
  cutShort: false,
});

/** The networks discovery looks at: the ones with a verified v4 manager and a
 * GeckoTerminal v4 DEX, in the project's own order. */
export const discoveryChains = () => [...METRIC_CHAINS];

/** Slow, polite discovery of pools we do not know yet.
 *
 * GeckoTerminal's top-pools page (one per network, the page rotates each run)
 * names candidate pool ids. The v4.xyz indexer lists hooked pools per network
 * and resolves an exact candidate to its hook. Neither feeds a measurement: a
 * discovered pool is only added to state; the measurement burst prices it.
 *
 * `notAfter` is a clock time: no request starts later than it, a wait for the
 * provider's gap or a Retry-After included. What is left undone is read again by
 * the next run, and `stats.cutShort` says discovery ended that way. */
export async function discoverPools({
  client,
  known,
  hookless,
  page,
  maxDiscovery = Infinity,
  maxResolves = MAX_RESOLVES_PER_RUN,
  now,
  notAfter,
  chains = discoveryChains(),
  geckoChains = chains,
}) {
  const stamp = () => new Date(now()).toISOString();
  const scope = chains.slice(0, Math.max(0, maxDiscovery));
  const geckoScope = geckoChains.slice(0, Math.max(0, maxDiscovery));
  const found = [];
  const foundHookless = [];
  const stats = discoveryStats(page, Math.max(0, maxResolves));
  const seen = new Set([...known, ...hookless]);
  let resolveLeft = stats.resolveBudget;

  // A request refused for lack of time (or of requests) is not a failure of the
  // provider or of the network it was for: nothing was sent, and the rest is
  // left for the next run.
  const outOfTime = (error) => {
    if (error?.code !== "budget") return false;
    stats.cutShort = true;
    return true;
  };

  const add = (chain, identity, source) => {
    const key = poolKey(chain.chain, identity.address);
    if (seen.has(key)) return false;
    seen.add(key);
    const at = stamp();
    found.push({
      id: identity.address,
      chain: chain.chain,
      hookAddress: identity.hookAddress,
      tokens: identity.tokens,
      name: identity.name,
      createdAt: null,
      source,
      ...(dynamicFeeEvidence(identity.name) ? { dynamicFee: true } : {}),
      firstSeen: at,
      lastSeen: at,
    });
    return true;
  };

  async function listIndexer() {
    for (const chain of scope) {
      if (client.isStopped("v4xyz")) return;
      try {
        const result = await client.getJson("v4xyz", poolListUrl(chain), {
          maxBytes: V4_LIST_MAX_BYTES,
          notAfter,
        });
        const { pools } = validateEnvioPools(result.data, chain);
        stats.indexerLists++;
        stats.indexerListed += pools.length;
        for (const pool of pools) add(chain, pool, "v4.xyz");
      } catch (error) {
        if (outOfTime(error)) return;
        // One network's list failing leaves its pools to the next run.
        stats.indexerListFailures++;
      }
    }
  }

  async function resolve(chain, id) {
    const key = poolKey(chain.chain, id);
    if (resolveLeft <= 0 || seen.has(key) || client.isStopped("v4xyz")) return;
    resolveLeft--;
    stats.resolvesTried++;
    try {
      const result = await client.getJson("v4xyz", poolDetailUrl(chain, id), {
        maxBytes: V4_DETAIL_MAX_BYTES,
        notAfter,
      });
      const identity = validateIndexerPoolIdentity(result.data, chain, id);
      if (!identity.hooked) {
        seen.add(key);
        foundHookless.push(key);
        stats.resolvedHookless++;
      } else if (add(chain, identity, "v4.xyz")) stats.resolvedHooked++;
    } catch (error) {
      if (outOfTime(error)) {
        stats.resolvesTried--;
        return;
      }
      stats.unresolved++;
    }
  }

  const resolving = [];
  // Every network is entitled to an equal share of the lookups. The pages are
  // read one network at a time, so a network is served as its page arrives and
  // cannot use up what the later ones are owed. The remainder of an uneven split
  // goes to a different set of networks each run, and a share a network does not
  // use is handed out afterwards, one lookup per network in turn.
  const networks = Math.max(1, geckoScope.length);
  const share = Math.floor(stats.resolveBudget / networks);
  const extra = stats.resolveBudget % networks;
  const rotation = Number.isSafeInteger(page) ? page : 0;
  const entitled = (index) =>
    share + ((index + rotation) % networks < extra ? 1 : 0);
  const waiting = [];
  async function listGecko() {
    for (const [index, chain] of geckoScope.entries()) {
      if (client.isStopped("geckoterminal")) break;
      let queued = 0;
      const later = [];
      try {
        const result = await client.getJson(
          "geckoterminal",
          marketDiscoveryUrl(chain, stats.page),
          { maxBytes: GT_MAX_BYTES, notAfter },
        );
        let data;
        try {
          ({ data } = validateMarketDiscovery(result.data, chain));
        } catch (invalid) {
          // The page arrived and is not a page of pools: the answer's own code
          // (the client's failures carry theirs).
          throw Object.assign(invalid, { code: "shape" });
        }
        stats.geckoPages++;
        for (const row of data) {
          const id = row.attributes.address.toLowerCase();
          if (seen.has(poolKey(chain.chain, id))) continue;
          stats.geckoCandidates++;
          if (queued < entitled(index)) {
            queued++;
            resolving.push(resolve(chain, id));
          } else later.push({ chain, id });
        }
      } catch (error) {
        if (outOfTime(error)) break;
        // A failed page is read again when the rotation comes round.
        stats.geckoPageFailures++;
        const reason = failureReason(error);
        stats.geckoPageFailureReasons[reason] =
          (stats.geckoPageFailureReasons[reason] ?? 0) + 1;
      }
      waiting.push(later);
    }
    while (resolveLeft > 0 && waiting.some((rows) => rows.length)) {
      for (const rows of waiting) {
        const next = rows.shift();
        if (next && resolveLeft > 0)
          resolving.push(resolve(next.chain, next.id));
      }
    }
  }

  await Promise.all([listIndexer(), listGecko()]);
  await Promise.all(resolving);
  stats.geckoPageFailureReasons = Object.fromEntries(
    Object.entries(stats.geckoPageFailureReasons).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    ),
  );
  return { found, hookless: foundHookless, stats };
}
