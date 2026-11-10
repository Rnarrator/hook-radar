// Deterministic TEST data for the Auto Snapshot edition's published files.
// It stands in for what the collector writes under /data/ and is used only by
// the edition's tests: nothing here is real market data and none of it is ever
// published. The numbers are chosen so that a wrong freshness rule shows up:
// pools measured just inside and just outside the five-minute window, a
// measured zero, a missing measurement and a pool without a project.
//
//   node tests/fixtures/static-data/generate.mjs          rewrite the JSON files
//   import { buildStaticFixtures } from "./generate.mjs"   build them in memory
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeSnapshot, testProjects } from "../../fixtures.mjs";
import { refreshMarketSnapshot } from "../../../shared/market-freshness.ts";
import { analyticsOverviewAsync } from "../../../server/analytics-overview.mjs";

export const GENERATED_AT = "2026-10-28T14:05:00.000Z";
export const CENSUS_AT = "2026-10-27T20:11:09.000Z";
const generated = Date.parse(GENERATED_AT);
const at = (clock) => `2026-10-28T${clock}Z`;

const deployment = (source, id, address, chain, name) => ({
  ...structuredClone(source),
  id: `${chain}:${address}`,
  address,
  chain,
  chainId: { base: 8453, ethereum: 1, robinhood: 4663 }[chain],
  name,
  explorerUrl: `https://example.invalid/address/${address}`,
});

const project = (id, name, description, category, deployments) => ({
  id,
  name,
  description,
  category,
  website: null,
  docs: null,
  sourceUrl: "https://github.com/Uniswap/hooklist",
  deployments,
  chains: [...new Set(deployments.map((hook) => hook.chain))],
  metrics: {
    poolCount: null,
    liquidityUsd: null,
    volumeUsd: { h1: null, h6: null, h24: null },
    coverage: "unavailable",
    note: "Recomputed from the measured pools at the snapshot time.",
  },
  history: [],
});

const hook = testProjects[0].deployments[0];
const gammaBase = "0x55555555555555555555555555555555555510c0";
const gammaEth = "0x66666666666666666666666666666666666610c0";
const deltaEth = "0x77777777777777777777777777777777777710c0";

// A pool id is 32 bytes; each fixture pool gets its own, in creation order.
let created = 0;
const pool = (id, chain, name, projectId, hookAddress, row) => ({
  id: `${chain}:${id}`,
  chain,
  name,
  address: `0x${(++created).toString(16).padStart(64, "0")}`,
  hookAddress,
  projectId,
  url: `https://www.geckoterminal.com/${chain}/pools/${id}`,
  source: "DEX Screener",
  createdAt: "2026-10-01T00:00:00.000Z",
  tokens: name.split(" / "),
  metricStatus: "live",
  ...row,
});

function rawSnapshot() {
  const base = makeSnapshot();
  const projects = [
    ...structuredClone(testProjects),
    project("gamma", "Gamma Fee Guard", "Adjusts swap fees to volatility", "Fees", [
      deployment(hook, "g1", gammaBase, "base", "GammaBase"),
      deployment(hook, "g2", gammaEth, "ethereum", "GammaEthereum"),
    ]),
    project("delta", "Delta Oracle", "Publishes a pool price oracle", "Oracles", [
      deployment(hook, "d1", deltaEth, "ethereum", "DeltaOracle"),
    ]),
  ];
  const [alpha, , frontier] = testProjects;
  const alphaBase = alpha.deployments[0].address;
  const alphaEth = alpha.deployments[1].address;
  const betaBase = testProjects[1].deployments[0].address;
  const frontierHook = frontier.deployments[0].address;
  const pools = [
    pool("alpha1", "base", "ETH / ALPHA", "alpha", alphaBase, {
      liquidityUsd: 10000,
      volumeUsd: { h1: 100, h6: 600, h24: 2400 },
      metricUpdatedAt: at("14:04:10.000"),
    }),
    pool("alpha2", "base", "USDC / ALPHA", "alpha", alphaBase, {
      liquidityUsd: 5000,
      volumeUsd: { h1: 50, h6: 300, h24: 900 },
      metricUpdatedAt: at("14:02:30.000"),
    }),
    // A measured zero: current, and different from "no measurement".
    pool("alpha3", "ethereum", "WBTC / ALPHA", "alpha", alphaEth, {
      liquidityUsd: 20000,
      volumeUsd: { h1: 0, h6: 0, h24: 0 },
      metricUpdatedAt: at("14:03:00.000"),
    }),
    // Fifteen minutes old at the snapshot time: excluded, exactly as live.
    pool("alpha4", "base", "DAI / ALPHA", "alpha", alphaBase, {
      liquidityUsd: 900,
      volumeUsd: { h1: 900, h6: 900, h24: 900 },
      metricUpdatedAt: at("13:50:00.000"),
    }),
    // Reserves only: volume is unavailable, never zero.
    pool("beta1", "base", "ETH / BETA", "beta", betaBase, {
      liquidityUsd: 7000,
      volumeUsd: { h1: null, h6: null, h24: null },
      metricUpdatedAt: at("14:01:40.000"),
    }),
    // No measurement at all.
    pool("beta2", "base", "USDC / BETA", "beta", betaBase, {
      liquidityUsd: null,
      volumeUsd: { h1: null, h6: null, h24: null },
      metricUpdatedAt: null,
      metricStatus: "unavailable",
    }),
    // Seven and a half minutes old: excluded.
    pool("front1", "robinhood", "ETH / FRONT", "frontier", frontierHook, {
      liquidityUsd: 1000,
      volumeUsd: { h1: 20, h6: 100, h24: 300 },
      metricUpdatedAt: at("13:57:30.000"),
    }),
    pool("gamma1", "base", "ETH / GAMMA", "gamma", gammaBase, {
      liquidityUsd: 3000,
      volumeUsd: { h1: 10, h6: 60, h24: 240 },
      metricUpdatedAt: at("14:04:40.000"),
    }),
    // 5:15 old: just outside the window, excluded.
    pool("gamma2", "ethereum", "ETH / GAMMA2", "gamma", gammaEth, {
      liquidityUsd: 1500,
      volumeUsd: { h1: 5, h6: 30, h24: 120 },
      metricUpdatedAt: at("13:59:45.000"),
    }),
    // 4:55 old: just inside the window, counted.
    pool("gamma3", "ethereum", "USDC / GAMMA", "gamma", gammaEth, {
      liquidityUsd: 2200,
      volumeUsd: { h1: 8, h6: 40, h24: 160 },
      metricUpdatedAt: at("14:00:05.000"),
    }),
    pool("delta1", "ethereum", "ETH / DELTA", "delta", deltaEth, {
      liquidityUsd: 400,
      volumeUsd: { h1: 1, h6: 2, h24: 3 },
      metricUpdatedAt: at("14:04:55.000"),
    }),
    // A measured pool with no project.
    pool("loose1", "base", "ETH / LOOSE", null, null, {
      liquidityUsd: 100,
      volumeUsd: { h1: 7, h6: 14, h24: 28 },
      metricUpdatedAt: at("14:04:00.000"),
    }),
  ];
  return {
    ...base,
    generatedAt: GENERATED_AT,
    status: "partial",
    projects,
    pools,
    events: [
      {
        id: "fixture-event",
        type: "new-deployment",
        title: "Gamma deployment listed",
        description: "A Base deployment was added to the registry.",
        timestamp: "2026-10-27T09:00:00.000Z",
        projectId: "gamma",
        chain: "base",
        url: "https://github.com/Uniswap/hooklist",
      },
    ],
    sources: [
      {
        id: "registry",
        name: "Uniswap hooklist",
        url: "https://github.com/Uniswap/hooklist",
        status: "live",
        updatedAt: at("13:41:20.000"),
        note: "Hook registry, 1 request, fetched at the start of the run.",
      },
      {
        id: "dexscreener",
        name: "DEX Screener",
        url: "https://dexscreener.com/",
        status: "live",
        updatedAt: at("14:04:58.000"),
        note: "Pool measurements in one burst: 4 requests, 12 pools returned, 0 rate limits.",
      },
      {
        id: "geckoterminal",
        name: "GeckoTerminal",
        url: "https://www.geckoterminal.com/",
        status: "live",
        updatedAt: at("13:58:02.000"),
        note: "Pool discovery pages: 3 requests, 12 seconds apart.",
      },
      // The ids and wording follow what collector/assemble.mjs writes: the
      // indexer supplies pool identity only, and the census is Hook Radar's own
      // index of PoolManager events, exported once and never renewed.
      {
        id: "v4xyz",
        name: "v4.xyz indexer",
        url: "https://www.v4.xyz",
        status: "live",
        updatedAt: at("13:52:30.000"),
        note: "Pool identity only (which hook, which two currencies) for newly discovered pools: 5 requests between 13:50 UTC and 13:52 UTC. It supplies no amounts.",
      },
      {
        id: "census",
        name: "Pool census",
        url: "https://developers.uniswap.org/docs/protocols/v4/deployments",
        status: "cached",
        updatedAt: CENSUS_AT,
        note: "Hook Radar's index of PoolManager events, exported 27 Oct 2026, 20:11 UTC. Shown as it stood on 27 Oct 2026, 20:11 UTC; this edition does not refresh it.",
      },
    ],
    history: [],
    summary: {
      indexedProjects: projects.length,
      indexedDeployments: projects.reduce(
        (total, item) => total + item.deployments.length,
        0,
      ),
      trackedPools: pools.length,
      liquidityUsd: null,
      volumeUsd: { h1: null, h6: null, h24: null },
    },
    coverage: {
      title: "Measured pool sample",
      description:
        "Hook pools measured in one burst; a sample, not an ecosystem total.",
      measuredChains: ["base", "ethereum", "robinhood"],
      registryDeployments: projects.reduce(
        (total, item) => total + item.deployments.length,
        0,
      ),
      attributedPools: pools.filter((item) => item.projectId).length,
      totalObservedPools: pools.length,
    },
    inventory: {
      generatedAt: CENSUS_AT,
      running: false,
      poolCount: 480,
      hookPoolCount: 93,
      hookCount: 31,
      networks: [
        ["base", 8453, "Base", 300, 61, 17],
        ["ethereum", 1, "Ethereum", 150, 28, 11],
        ["robinhood", 4663, "Robinhood", 30, 4, 3],
      ].map(([chain, chainId, name, poolCount, hookPoolCount, hookCount]) => ({
        chain,
        chainId,
        name,
        manager: `0x${String(chainId).padStart(40, "1")}`,
        dataset: null,
        startBlock: 0,
        scannedToBlock: 1000,
        targetBlock: 1000,
        status: "complete",
        poolCount,
        hookPoolCount,
        hookCount,
        updatedAt: CENSUS_AT,
        headCheckedAt: "2026-10-27T20:10:30.000Z",
        lastError: null,
        finality: "finalized",
      })),
    },
    // What collector/assemble.mjs writes for the burst: pools asked about per
    // network against the census count, and how many answered.
    marketCoverage: {
      networks: [
        ["base", 8453, 61, 7, 6],
        ["ethereum", 1, 28, 4, 4],
        ["robinhood", 4663, 4, 1, 1],
      ].map(([chain, chainId, inventoryPools, checkedPools, measuredPools]) => ({
        chain,
        chainId,
        inventoryPools,
        checkedPools,
        measuredPools,
        pendingPools: inventoryPools - checkedPools,
        missingPools: checkedPools - measuredPools,
        attemptedPools: checkedPools,
        status: "live",
      })),
      cacheWarning: null,
    },
  };
}

export async function buildStaticFixtures() {
  const snapshot = refreshMarketSnapshot(rawSnapshot(), generated);
  const files = { "snapshot.json": snapshot };
  const windows = ["h1", "h6", "h24"];
  for (const window of windows)
    files[`overview-all-${window}.json`] = await overview(snapshot, "all", window);
  for (const chain of snapshot.chains.map((item) => item.slug))
    files[`overview-${chain}-h24.json`] = await overview(snapshot, chain, "h24");
  const hour = 3_600_000;
  files["history.json"] = {
    schemaVersion: 1,
    points: [4, 3, 2, 1, 0].map((back, index) => ({
      timestamp: generated - back * 3 * hour,
      value: [3100, 3300, 3250, 3600, 3731][index],
      pools: 12 - index,
    })),
  };
  files["status.json"] = {
    generatedAt: GENERATED_AT,
    collectionStartedAt: at("13:41:12.000"),
    burstStartedAt: at("14:01:20.000"),
    burstEndedAt: GENERATED_AT,
    counts: { requests: 8 },
    sources: [],
    collectorVersion: "fixture",
    previousGeneratedAt: at("11:04:41.000"),
  };
  return files;
}

async function overview(snapshot, chain, window) {
  const envelope = await analyticsOverviewAsync(
    snapshot,
    { chain, window },
    { now: generated, contributions: true },
  );
  // The publication id is random per process; a fixed one keeps the files stable.
  envelope.publication.id = "fixture-publication";
  return envelope;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = dirname(fileURLToPath(import.meta.url));
  const files = await buildStaticFixtures();
  mkdirSync(join(out, "data"), { recursive: true });
  for (const [name, value] of Object.entries(files))
    writeFileSync(join(out, "data", name), `${JSON.stringify(value, null, 1)}\n`);
  console.log(`wrote ${Object.keys(files).length} files to ${join(out, "data")}`);
}
