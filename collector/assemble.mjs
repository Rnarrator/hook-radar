import {
  applyMetrics,
  attributePools,
  createDirectory,
  REGISTRY_URL,
} from "../server/model.mjs";
import { ENVIO_MARKET_SOURCE } from "../server/market-envio.mjs";
import {
  ADDITIONAL_MARKET_CHAINS,
  MARKET_CHAINS,
} from "../server/market-chains.mjs";
import {
  aggregateCurrentMarkets,
  marketMeasurementState,
} from "../shared/market-freshness.ts";
import { isSnapshot } from "../src/model.ts";
import {
  DYNAMIC_FEE_FLAG,
  LANE_HOT_MAX_AGE_MS,
  LANE_NEW_MAX_AGE_MS,
  LANE_PERIOD_MS,
  LANE_WARM_MAX_AGE_MS,
} from "./config.mjs";
import {
  appendHistoryPoint,
  historyPointFor,
  roundCents,
  seriesOf,
} from "./history.mjs";

const INDEXER_HOOK_DESCRIPTION =
  "Hook address reported by the v4.xyz indexer for pools Hook Radar measured. Project identity and contract source have not been verified.";
const PM_DISCOVERY_DESCRIPTION =
  "Discovered from a PoolManager initialization event. Project identity and contract source have not been verified.";

const utc = (ms) =>
  new Date(ms)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, " UTC");

const hookKey = (chainId, address) => `${chainId}:${address.toLowerCase()}`;

/** Hooks whose identity rests on the v4.xyz indexer alone: every state pool that
 * uses them was added by discovery rather than seeded from the verified census. */
export function indexerOnlyHooks(statePools, chainIds) {
  const verified = new Set();
  const indexed = new Set();
  for (const pool of statePools) {
    const chainId = chainIds.get(pool.chain);
    if (!chainId) continue;
    (pool.source === "v4.xyz" ? indexed : verified).add(
      hookKey(chainId, pool.hookAddress),
    );
  }
  return new Set([...indexed].filter((key) => !verified.has(key)));
}

/** What the state knows about each hook's LP fee: true when a dynamic-fee pool of
 * the hook is known (the live app's census at the seed, or the indexer's pool
 * name), false when the census checked the hook and found none. A hook with no
 * entry is unknown. */
export function hookFeeEvidence(statePools, chainIds) {
  const evidence = new Map();
  for (const pool of statePools) {
    const chainId = chainIds.get(pool.chain);
    if (!chainId || typeof pool.dynamicFee !== "boolean") continue;
    const key = hookKey(chainId, pool.hookAddress);
    evidence.set(key, evidence.get(key) === true || pool.dynamicFee);
  }
  return evidence;
}

const UNKNOWN_FEE_NOTE =
  " Whether it sets LP fees dynamically has not been established, so it is not tagged as dynamic.";

/** The directory tags a hook "dynamic fees" only on evidence. For a discovered
 * hook with none, the page says so instead of showing a plain "no". */
function describeUnknownFees(projects, evidence) {
  for (const project of projects)
    for (const deployment of project.deployments)
      if (
        (deployment.discovery === "onchain" ||
          deployment.discovery === "published") &&
        !evidence.has(hookKey(deployment.chainId, deployment.address))
      )
        deployment.description += UNKNOWN_FEE_NOTE;
}

/** A hook the directory names from the first-party list rather than from a pool
 * carries no fee flag of its own. When the state holds a dynamic-fee pool of it
 * (one that was not measured, so the directory was never given it), the hook is
 * tagged on that evidence, as it would be had the pool been measured. */
function tagDynamicFees(projects, evidence) {
  for (const project of projects)
    for (const deployment of project.deployments)
      if (
        deployment.discovery === "published" &&
        !deployment.properties.dynamicFee &&
        evidence.get(hookKey(deployment.chainId, deployment.address)) === true
      )
        deployment.properties = { ...deployment.properties, dynamicFee: true };
}

function describeIndexerHooks(projects, indexerOnly) {
  for (const project of projects) {
    let patched = 0;
    for (const deployment of project.deployments) {
      if (
        deployment.discovery !== "onchain" ||
        !indexerOnly.has(hookKey(deployment.chainId, deployment.address))
      )
        continue;
      deployment.description = INDEXER_HOOK_DESCRIPTION;
      deployment.sourceUrl = ENVIO_MARKET_SOURCE;
      patched++;
    }
    if (patched && patched === project.deployments.length) {
      if (project.description === PM_DISCOVERY_DESCRIPTION)
        project.description = INDEXER_HOOK_DESCRIPTION;
      project.sourceUrl = ENVIO_MARKET_SOURCE;
    }
  }
}

/** Every chain the page names needs a working explorer link (isSnapshot). */
function repairChains(chains, extra) {
  const known = new Map(extra.map((chain) => [chain.chainId, chain]));
  return chains
    .map((chain) => ({
      ...chain,
      explorer:
        chain.explorer ||
        known.get(chain.id)?.explorerUrl ||
        `https://chainlist.org/chain/${chain.id}`,
    }))
    .filter(
      (chain) =>
        /^[a-z0-9][a-z0-9-]{0,99}$/.test(chain.slug) && chain.name.trim(),
    );
}

/** One row per network that has hook pools, from what this run asked and what a
 * provider answered. `checkedPools` counts pools a provider answered for in this
 * snapshot, even with nothing usable; `attemptedPools` counts pools asked about in
 * this snapshot. With the lane plan a run asks about the pools that answer and
 * the new pools every time and about the others in turn, so a pool that was not
 * due is unchecked in this snapshot (`pendingPools`), and the counts say what
 * this snapshot asked, not how much of the network has ever been asked. A network
 * the run never asked about still appears (nothing attempted, nothing checked),
 * so the totals are the census's and not those of the networks that happened to
 * be requested.
 *
 * A network DEX Screener answered HTTP 400 for (it does not index it) carries
 * `unsupported: true`, so the page can say that instead of "did not respond".
 * The key is absent for every other network. The flag says what DEX Screener
 * answered: GeckoTerminal may still have answered for pools of the network, and
 * the row is then `live` with `checkedPools` above 0 and keeps the flag. A page
 * reads it only for a row with `checkedPools` 0 (or status `unavailable`). */
export function marketCoverageFor({
  burst,
  statePools,
  census,
  measuredByChain,
  chainIds = new Map(),
}) {
  const unsupported = new Set(burst.unsupportedNetworks ?? []);
  const stateByChain = new Map();
  for (const pool of statePools)
    stateByChain.set(pool.chain, (stateByChain.get(pool.chain) || 0) + 1);
  const censusByChain = new Map(
    (census?.inventory?.networks || []).map((network) => [
      network.chain,
      network.hookPoolCount,
    ]),
  );
  const rowFor = (chain, chainId, { requested, checked }) => {
    const measured = measuredByChain.get(chain) || 0;
    const inventoryPools = Math.max(
      censusByChain.get(chain) || 0,
      stateByChain.get(chain) || 0,
      measured,
    );
    const checkedPools = Math.min(inventoryPools, Math.max(checked, measured));
    return {
      chain,
      chainId,
      inventoryPools,
      checkedPools,
      measuredPools: measured,
      pendingPools: Math.max(0, inventoryPools - checkedPools),
      missingPools: Math.max(0, checkedPools - measured),
      attemptedPools: Math.min(requested, inventoryPools),
      // A source that answered is "live" even when it had no usable data for
      // the pools asked; "unavailable" is a network that got no answer at all.
      status: checkedPools > 0 ? "live" : "unavailable",
      ...(unsupported.has(chain) ? { unsupported: true } : {}),
    };
  };
  const networks = burst.networks
    .filter((network) => network.requested > 0 || network.measured > 0)
    .map((network) => rowFor(network.chain, network.chainId, network));
  const listed = new Set(networks.map((row) => row.chain));
  const listedIds = new Set(networks.map((row) => row.chainId));
  const idle = [...new Set([...censusByChain.keys(), ...stateByChain.keys()])]
    .filter((chain) => !listed.has(chain) && chainIds.has(chain))
    .map((chain) =>
      rowFor(chain, chainIds.get(chain), { requested: 0, checked: 0 }),
    )
    .filter((row) => row.inventoryPools > 0 && !listedIds.has(row.chainId))
    .sort(
      (a, b) =>
        b.inventoryPools - a.inventoryPools || a.chain.localeCompare(b.chain),
    );
  return { networks: [...networks, ...idle], cacheWarning: null };
}

// The live app's own words for the pools Frontier measures (server/store.mjs,
// marketCoverageNote). A test keeps the two in step.
export const FRONTIER_PROVIDER_NAME = "Frontier’s public AMM index";
export const FRONTIER_COVERAGE_SENTENCE =
  " Frontier estimates use native ETH AMM swaps and core reserves at the observed ETH/USD price; bonding-curve trades and separately held hook assets are excluded.";

function coverageNote(pools) {
  const names = [];
  if (pools.some((pool) => /DEX Screener/i.test(pool.source)))
    names.push("DEX Screener");
  if (pools.some((pool) => /GeckoTerminal/i.test(pool.source)))
    names.push("GeckoTerminal");
  if (pools.some((pool) => /Frontier/i.test(pool.source)))
    names.push(FRONTIER_PROVIDER_NAME);
  return (
    `Observed market data covers ${pools.length.toLocaleString("en-US")} pools across ${new Set(pools.map((pool) => pool.chain)).size} networks${names.length ? ` from ${names.join(", ")}` : ""}. Dollar totals use available observations, not ecosystem totals. Unpriced pools remain browsable; missing values are unavailable, never zero.` +
    (names.includes(FRONTIER_PROVIDER_NAME) ? FRONTIER_COVERAGE_SENTENCE : "")
  );
}

const FRONTIER_DOCS = "https://docs.frontier.fun";

/** The source rows of Frontier's step: the live app's own (the pooled coin
 * markets, the ETH/USD conversion, the AMM index and, when the index lacks a
 * coin, the attribution), each with what this snapshot took from Frontier. A
 * step that failed outright is one unavailable row, so the snapshot still says
 * Frontier was asked. Nothing is named when the step had nothing to ask. */
export function frontierSources(frontier, measured) {
  if (!frontier) return [];
  const supplied = [...measured.values()].filter(
    (pool) => pool.metricProvider === "frontier",
  ).length;
  const plural = (n, word) =>
    `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
  if (frontier.failure)
    return [
      {
        id: "frontier-coins",
        name: "Frontier · pooled coin markets",
        url: FRONTIER_DOCS,
        status: "unavailable",
        updatedAt: null,
        note: `Frontier's own market figures could not be read in this run (${frontier.failure}). The pools of its hooks keep the figures other providers returned; none is estimated.`,
      },
    ];
  return (frontier.sources ?? []).map((source) => {
    if (source.id === "frontier-coins")
      return {
        ...source,
        note: `${source.note} ${plural(frontier.listed ?? 0, "pooled coin market")} listed; Frontier's figures are used for ${plural(supplied, "pool")} of this snapshot (a pool that another provider measured more recently keeps that measurement).`,
      };
    if (source.id === "frontier-market-attribution")
      return {
        ...source,
        note: `${source.note} The edition does not request Frontier's per-coin configuration, so a coin the AMM index does not list is not priced from Frontier.`,
      };
    return source;
  });
}

const hoursOf = (ms) => ms / (60 * 60 * 1000);

/** What the lane plan asked DEX Screener about, as a sentence for the source note
 * (null when the run used the full plan, which asked about every pool it held).
 * The periods are the config's own. */
export function lanePlanNote(lanePlan) {
  if (!lanePlan) return "";
  const number = (n) => n.toLocaleString("en-US");
  // When the plan reached its ceiling the periods below are not what happened to
  // every pool: the pools the ceiling cut wait for their next turn. The pools that
  // answer and the new pools are never cut and discovery adds new ones after the
  // plan is checked, so a run can send more batches than the limit; it says so.
  const sent =
    Number.isSafeInteger(lanePlan.batches) && lanePlan.batches > lanePlan.maxBatches
      ? ` and sent ${number(lanePlan.batches)}, because the pools that answer and the new pools are never left out`
      : "";
  const ceiling = lanePlan.ceilingBound
    ? ` This plan reached its limit of ${number(lanePlan.maxBatches)} batches a run${sent}, so some of the pools that were due were left for their next turn.`
    : "";
  // The pools GeckoTerminal priced last time are asked about on the 3-hour wheel
  // here. GeckoTerminal is asked about the ones not priced here first in each run,
  // as far as its requests reach (its fallback has a few requests of 30 pools, and
  // a request holds the pools of one network), so the sentence does not say that
  // all of them are asked every time.
  const gecko =
    lanePlan.geckoCarried > 0
      ? ` The ${number(lanePlan.geckoCarried)} pools GeckoTerminal priced that answered in the last ${hoursOf(LANE_HOT_MAX_AGE_MS)} hours are asked about here every ${hoursOf(LANE_PERIOD_MS.warm)} hours, and GeckoTerminal is asked about the ones not priced here first in each run, as many as its requests allow.`
      : "";
  return ` This snapshot asked about ${number(lanePlan.asked)} of the ${number(lanePlan.known)} pools the collector knows: the pools that answered in the last ${hoursOf(LANE_HOT_MAX_AGE_MS)} hours and the pools first seen in the last ${hoursOf(LANE_NEW_MAX_AGE_MS)} hours every time, the others in turn (answered ${hoursOf(LANE_HOT_MAX_AGE_MS)} hours to ${hoursOf(LANE_WARM_MAX_AGE_MS) / 24} days ago: every ${hoursOf(LANE_PERIOD_MS.warm)} hours; answered longer ago: every ${hoursOf(LANE_PERIOD_MS.cool)} hours; never answered: every ${hoursOf(LANE_PERIOD_MS.cold)} hours).${gecko}${ceiling} A pool that was not asked is unchecked in this snapshot, not zero.`;
}

/** The sentence about DEX Screener batches that failed and were asked again (see
 * runBurst): how many failed, how many recovered on the second try and where the
 * ones that did not are. Empty when no batch failed, so a clean run says nothing of
 * it. `retry` is telemetry.dexscreener.retry of the burst; `names` maps a network
 * slug to the name the page shows. */
export function retryNote(retry, names = new Map()) {
  if (!retry || !(retry.failedFirstPass > 0)) return "";
  const failed = retry.failedFirstPass;
  const still =
    retry.stillFailed > 0
      ? ` Still failed: ${retry.networks.stillFailed
          .map((slug) => names.get(slug) ?? slug)
          .sort()
          .join(", ")}.`
      : "";
  return ` ${failed} batch${failed === 1 ? "" : "es"} failed, ${retry.recovered} recovered on a second try.${still}`;
}

/** The sources the snapshot names: every provider actually used, with its real
 * request count and the times of its first and last request. A request the
 * collector sent again after a rate-limit answer is one of the requests counted,
 * and the wait is stated. `unsupportedNetworks` are the slugs of networks DEX
 * Screener does not index; `chains` gives them the names the page shows.
 * `stats` are the requests of the measurement phase: the daily-volume step that
 * follows reads GeckoTerminal as well, and is a source of its own (`daily`).
 * `lanePlan` (`{ asked, known }`, or null for the full plan) adds what the lane
 * plan asked DEX Screener about to its note. */
export function providerSources({
  stats,
  measured,
  discovery,
  census,
  registrySources,
  unsupportedNetworks = [],
  chains = [],
  frontier = null,
  daily = null,
  lanePlan = null,
  dexRetry = null,
}) {
  const latest = (provider) => {
    const times = [...measured.values()]
      .filter((pool) => pool.metricProvider === provider)
      .map((pool) => pool.metricUpdatedAt)
      .sort();
    return times.at(-1) ?? null;
  };
  const span = (row) =>
    row.requests
      ? `${row.requests} request${row.requests === 1 ? "" : "s"} between ${utc(row.firstRequestAt)} and ${utc(row.lastRequestAt)}`
      : "no requests";
  const statusOf = (ok) => (ok ? "live" : "unavailable");
  const stopNote = (row) =>
    row.stopped ? ` Stopped for this run: ${row.stopped.reason}.` : "";
  const waitNote = (row) =>
    row.rateLimitWaits
      ? ` Waited ${Math.round(row.rateLimitWaitedMs / 1000)} s after a rate-limit answer (${row.rateLimitWaits} time${row.rateLimitWaits === 1 ? "" : "s"}).`
      : "";
  const names = new Map(chains.map((chain) => [chain.slug, chain.name]));
  const unindexedNote = unsupportedNetworks.length
    ? ` Does not index: ${unsupportedNetworks
        .map((slug) => names.get(slug) ?? slug)
        .sort()
        .join(", ")}.`
    : "";
  const sources = [...registrySources];
  const ds = stats.dexscreener;
  if (ds.requests) {
    const count = [...measured.values()].filter(
      (pool) => pool.metricProvider === "dexscreener",
    ).length;
    sources.push({
      id: "dexscreener",
      name: "DEX Screener",
      url: "https://dexscreener.com",
      status: statusOf(count > 0),
      updatedAt: latest("dexscreener"),
      note: `Exact-pool lookups in batches of up to 30: ${span(ds)}. ${count.toLocaleString("en-US")} pools returned a matching Uniswap v4 row with a liquidity or volume figure; pools it did not return, or returned without one, are unresolved, not zero.${lanePlanNote(lanePlan)}${retryNote(dexRetry, names)}${unindexedNote}${waitNote(ds)}${stopNote(ds)}`,
    });
  }
  const gt = stats.geckoterminal;
  if (gt.requests) {
    const count = [...measured.values()].filter(
      (pool) => pool.metricProvider === "geckoterminal",
    ).length;
    sources.push({
      id: "geckoterminal",
      name: "GeckoTerminal",
      url: "https://www.geckoterminal.com",
      status: statusOf(gt.succeeded > 0),
      updatedAt:
        latest("geckoterminal") ??
        (gt.lastRequestAt ? new Date(gt.lastRequestAt).toISOString() : null),
      note: `Top-pool pages for discovery (pages read: ${discovery.geckoPages}${discovery.page === null ? "; this run did not look for new pools" : ""}) and a small exact-pool fallback (pools measured: ${count}): ${span(gt)}. Data provided by GeckoTerminal.${waitNote(gt)}${stopNote(gt)}`,
    });
  }
  const v4 = stats.v4xyz;
  if (v4.requests)
    sources.push({
      id: "v4xyz",
      name: "v4.xyz indexer",
      url: "https://www.v4.xyz",
      status: statusOf(v4.succeeded > 0),
      updatedAt: v4.lastRequestAt
        ? new Date(v4.lastRequestAt).toISOString()
        : null,
      note: `Pool identity only (which hook, which two currencies) for newly discovered pools: ${span(v4)}. Network lists read: ${discovery.indexerLists}, hooked pools listed: ${discovery.indexerListed}, exact lookups: ${discovery.resolvesTried}. It supplies no amounts. The LP fee printed at the end of a pool name is read only to recognise hooks that set fees dynamically.${waitNote(v4)}${stopNote(v4)}`,
    });
  sources.push(...frontierSources(frontier, measured));
  // The row that tells the page the 7D and 30D file exists (see daily.mjs).
  if (daily) sources.push(daily);
  if (census)
    sources.push({
      id: "census",
      name: "Pool census",
      url: "https://developers.uniswap.org/docs/protocols/v4/deployments",
      status: "cached",
      updatedAt: census.inventory.generatedAt,
      note: `Hook Radar's index of PoolManager events, exported ${utc(Date.parse(census.exportedAt))}. Shown as it stood on ${utc(Date.parse(census.inventory.generatedAt))}; this edition does not refresh it. For hooks outside the Uniswap hooklist, whether a hook sets LP fees dynamically comes from this index at that date.`,
    });
  return sources;
}

/** The census as the page receives it. A network carries the directory's name, so
 * it has one name on every page, and no endpoint URL: the census records the
 * address of the data service it read each network from, some of which embed an
 * access key, and nothing in the edition uses them. Counts, block numbers and
 * times stay exactly as the census exported them. */
export function publishedInventory(inventory, chains) {
  const names = new Map(chains.map((chain) => [chain.slug, chain.name]));
  return {
    ...inventory,
    networks: inventory.networks.map(
      ({ sourceUrl: _endpoint, ...network }) => ({
        ...network,
        name: names.get(network.chain) ?? network.name,
      }),
    ),
  };
}

/** Build the RadarSnapshot for one run. `generatedAt` is the moment the
 * measurement burst ended; freshness is evaluated at that time. `sources` is the
 * list the snapshot names, or a function that makes it from the snapshot's
 * chains (so a source note can name a network as the page does). */
export function assembleSnapshot({
  directoryInputs,
  statePools,
  measured,
  burst,
  census,
  history,
  sources,
  generatedAtMs,
}) {
  const extraChains = [...MARKET_CHAINS, ...ADDITIONAL_MARKET_CHAINS];
  const chainIds = new Map(
    extraChains.map((chain) => [chain.chain, chain.chainId]),
  );
  const chainData = { ...directoryInputs.chains };
  for (const network of census?.inventory?.networks || [])
    if (!chainData[network.chain])
      chainData[network.chain] = { chainId: network.chainId };
  const measuredPools = [...measured.values()];
  for (const pool of measuredPools)
    if (!chainData[pool.chain])
      chainData[pool.chain] = { chainId: pool.chainId };
  for (const [slug, row] of Object.entries(chainData))
    chainIds.set(slug, row.chainId);

  // The directory reads a pool's hook, id, chain and fee only. A dynamic-fee flag
  // is passed for the hooks the state has evidence for; the pools published in
  // the snapshot are the measured ones and carry no fee. Only the measured pools
  // reach it, so it is also asked for every hook the first-party list names: the
  // live directory has each of them through the census, which this edition does
  // not carry pool by pool.
  const feeEvidence = hookFeeEvidence(statePools, chainIds);
  const directory = createDirectory(
    directoryInputs.registry,
    chainData,
    directoryInputs.frontier,
    measuredPools.map((pool) => ({
      chainId: pool.chainId,
      address: pool.address,
      hookAddress: pool.hookAddress,
      ...(feeEvidence.get(hookKey(pool.chainId, pool.hookAddress)) === true
        ? { fee: DYNAMIC_FEE_FLAG }
        : {}),
    })),
    {
      includePlatforms: true,
      strictFamilyNames: true,
      includeOfficialHooks: true,
    },
  );
  tagDynamicFees(directory.projects, feeEvidence);
  const pools = attributePools(measuredPools, directory.projects).sort(
    (a, b) =>
      a.chain === b.chain
        ? a.address < b.address
          ? -1
          : 1
        : a.chain < b.chain
          ? -1
          : 1,
  );
  describeIndexerHooks(
    directory.projects,
    indexerOnlyHooks(statePools, chainIds),
  );
  describeUnknownFees(directory.projects, feeEvidence);
  const note = coverageNote(pools);
  applyMetrics(directory.projects, pools, note, generatedAtMs);

  // Registry-named projects, platforms and any project with a measured pool.
  const referenced = new Set(pools.map((pool) => pool.projectId));
  const projects = directory.projects.filter(
    (project) =>
      project.entityType === "platform" ||
      referenced.has(project.id) ||
      project.deployments.some(
        (deployment) => deployment.discovery !== "onchain",
      ),
  );

  // The totals are recorded to the cent: summing many provider figures leaves
  // float residue that nobody measured. The pools keep their own figures as
  // given, and the history point below is made from this same summary, so the
  // two agree.
  const aggregate = aggregateCurrentMarkets(pools, generatedAtMs);
  const summary = {
    indexedProjects: projects.length,
    indexedDeployments: projects.reduce(
      (sum, project) => sum + project.deployments.length,
      0,
    ),
    trackedPools: pools.length,
    ...aggregate,
    liquidityUsd: roundCents(aggregate.liquidityUsd),
    volumeUsd: {
      h1: roundCents(aggregate.volumeUsd.h1),
      h6: roundCents(aggregate.volumeUsd.h6),
      h24: roundCents(aggregate.volumeUsd.h24),
    },
  };
  const point = historyPointFor(summary);
  const points = appendHistoryPoint(history, point);

  const measuredByChain = new Map();
  for (const pool of pools)
    measuredByChain.set(pool.chain, (measuredByChain.get(pool.chain) || 0) + 1);
  const registryDeployments = projects.reduce(
    (sum, project) =>
      sum +
      project.deployments.filter(
        (deployment) => deployment.sourceUrl === REGISTRY_URL,
      ).length,
    0,
  );
  const snapshotChains = repairChains(directory.chains, extraChains);
  const snapshot = {
    schemaVersion: 1,
    generatedAt: new Date(generatedAtMs).toISOString(),
    status: "partial",
    chains: snapshotChains,
    projects,
    ...(census
      ? { inventory: publishedInventory(census.inventory, snapshotChains) }
      : {}),
    marketCoverage: marketCoverageFor({
      burst,
      statePools,
      census,
      measuredByChain,
      chainIds,
    }),
    pools,
    events: [],
    sources: typeof sources === "function" ? sources(snapshotChains) : sources,
    history: seriesOf(points),
    summary,
    coverage: {
      title: pools.length
        ? "Measured pool sample · incomplete ecosystem coverage"
        : "Registry inventory · market coverage unavailable",
      description: note,
      measuredChains: [...measuredByChain.keys()],
      registryDeployments,
      attributedPools: pools.length,
      totalObservedPools: Math.max(pools.length, measuredPools.length),
    },
  };
  return {
    snapshot,
    historyPoints: points,
    point: point && points.at(-1) === point ? point : null,
  };
}

/** Pools whose measurement is current at the snapshot time. */
export function currentPoolCount(snapshot) {
  const at = Date.parse(snapshot.generatedAt);
  return snapshot.pools.filter(
    (pool) => marketMeasurementState(pool, at) === "current",
  ).length;
}

export const validSnapshot = (snapshot) => isSnapshot(snapshot);
