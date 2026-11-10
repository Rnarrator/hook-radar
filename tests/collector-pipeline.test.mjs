import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { CHAINS_URL, FRONTIER_URL, REGISTRY_URL } from "../server/model.mjs";
import { isSnapshot } from "../src/model.ts";
import { isAnalyticsOverviewEnvelope } from "../shared/analytics-overview.ts";
import { marketMeasurementState } from "../shared/market-freshness.ts";
import { MARKET_CHAINS, METRIC_CHAINS } from "../server/market-chains.mjs";
import {
  HISTORY_MAX_POINTS,
  LAST_SEEN_GRANULARITY_MS,
  MAX_DISCOVERED_MEASURED,
  MAX_MEASURED_POOLS,
  MIN_CURRENT_POOLS,
  STATE_MAX_POOLS,
} from "../collector/config.mjs";
import { currentPoolCount, hookFeeEvidence } from "../collector/assemble.mjs";
import {
  buildSeed,
  fetchSnapshotText,
  MAX_ATTEMPTS,
} from "../collector/export-seed.mjs";
import { appendHistoryPoint, historyPointFor } from "../collector/history.mjs";
import {
  fallbackBatches,
  measurementChains,
  planBurst,
  runBurst,
} from "../collector/measure.mjs";
import { discoverPools } from "../collector/discover.mjs";
import { createHttpClient } from "../collector/http.mjs";
import { assessQuality } from "../collector/quality.mjs";
import {
  fitDiscovery,
  nextPools,
  requestReserve,
  parseArguments,
  runCollector,
} from "../collector/run.mjs";
import { historyJson, poolsJson, readState } from "../collector/state.mjs";
import {
  blockNetwork,
  address,
  dexRow,
  FakeClock,
  fakeFetch,
  poolId,
  statePool,
} from "../collector/testing.mjs";

blockNetwork();

const base = MARKET_CHAINS.find((chain) => chain.chain === "base");
const ethereum = MARKET_CHAINS.find((chain) => chain.chain === "ethereum");
const BUNNI_BASE = address(9001);
const CLANKER_BASE = address(9002);
const BUNNI_ETH = address(9003);
const ANON_CENSUS = address(9004);
const ANON_INDEXER = address(9005);

const hookRow = (hook, chain, chainId, name) => ({
  hook: {
    address: hook,
    chainId,
    chain,
    name,
    description: `${name} test deployment`,
    verifiedSource: true,
  },
  properties: { dynamicFee: true, upgradeable: false },
});
const REGISTRY = [
  hookRow(BUNNI_BASE, "base", 8453, "BunniHook"),
  hookRow(CLANKER_BASE, "base", 8453, "ClankerHook"),
  hookRow(BUNNI_ETH, "ethereum", 1, "BunniHook"),
  // A named deployment nobody has measured: still listed.
  hookRow(address(9006), "base", 8453, "AlphixHook"),
];
const CHAIN_DATA = { ethereum: { chainId: 1 }, base: { chainId: 8453 } };
const ZERO = "0x0000000000000000000000000000000000000000";
const CENSUS = {
  schemaVersion: 1,
  exportedAt: "2026-10-27T10:00:00.000Z",
  inventory: {
    generatedAt: "2026-10-27T09:59:00.000Z",
    running: false,
    poolCount: 5000,
    hookPoolCount: 400,
    hookCount: 30,
    networks: [
      ["ethereum", 1, "Ethereum", ethereum.manager],
      ["base", 8453, "Base", base.manager],
    ].map(([chain, chainId, name, manager]) => ({
      chain,
      chainId,
      name,
      manager,
      dataset: null,
      startBlock: 1,
      scannedToBlock: 500,
      targetBlock: 500,
      status: "complete",
      poolCount: 2500,
      hookPoolCount: 200,
      hookCount: 15,
      updatedAt: "2026-10-27T09:58:00.000Z",
      headCheckedAt: "2026-10-27T09:58:30.000Z",
      lastError: null,
    })),
  },
};

function worldPools() {
  const pools = [];
  let seed = 1;
  const add = (count, chain, hook, extra = {}) => {
    for (let i = 0; i < count; i++)
      pools.push(
        statePool(seed++, { chain, hookAddress: hook.toLowerCase(), ...extra }),
      );
  };
  add(40, "base", BUNNI_BASE);
  add(25, "base", CLANKER_BASE);
  add(15, "base", ANON_CENSUS);
  add(30, "ethereum", BUNNI_ETH);
  return pools;
}

/** The providers, as fakes: a registry, DEX Screener rows for known pools, a
 * GeckoTerminal page and an indexer that knows two new pools. */
function providers({
  clock,
  pools,
  dark = new Set(),
  ageOf = () => null,
  fresh,
  names = {},
  hooklessDetail = false,
}) {
  const newPool = statePool(900, {
    chain: "base",
    hookAddress: ANON_INDEXER.toLowerCase(),
    source: "v4.xyz",
  });
  const listed = statePool(901, {
    chain: "base",
    hookAddress: ANON_INDEXER.toLowerCase(),
    source: "v4.xyz",
  });
  const rowFor = (pool, index) =>
    dexRow(pool, {
      volume: { h1: 10 + index, h6: 60 + index, h24: 240 + index },
      liquidity: { usd: 1000 + index },
    });
  const answer = (call) => {
    const url = call.url;
    if (url === REGISTRY_URL) return { body: REGISTRY };
    if (url === CHAINS_URL) return { body: CHAIN_DATA };
    if (url === FRONTIER_URL) return { body: [] };
    if (url.startsWith("https://api.dexscreener.com/latest/dex/pairs/")) {
      const [, chain, ids] = /pairs\/([a-z]+)\/(.+)$/.exec(url);
      const wanted = ids.split(",");
      const everything = [...pools, newPool, listed];
      const rows = wanted
        .filter((id) => !dark.has(id))
        .map((id) =>
          everything.find((pool) => pool.id === id && pool.chain === chain),
        )
        .filter(Boolean)
        .map((pool, index) => {
          const row = rowFor(pool, index);
          if (pool.id === fresh?.zeroVolume)
            row.volume = { h1: 0, h6: 0, h24: 0 };
          if (pool.id === fresh?.noVolume) delete row.volume;
          return row;
        });
      const age = ageOf(wanted);
      return {
        body: { pairs: rows.length ? rows : null },
        headers: age ? { age: String(age) } : {},
      };
    }
    if (
      url.startsWith(
        "https://api.geckoterminal.com/api/v2/networks/base/dexes/",
      )
    ) {
      return {
        body: {
          data: [
            {
              id: `base_${newPool.id}`,
              type: "pool",
              attributes: { address: newPool.id, name: "N / M" },
              relationships: { dex: { data: { id: base.dex } } },
            },
          ],
        },
      };
    }
    if (url.startsWith("https://api.geckoterminal.com/api/v2/networks/")) {
      if (url.includes("/pools/multi/")) return { body: { data: [] } };
      return { body: { data: [] } };
    }
    if (url === "https://www.v4.xyz/api/pools?chainId=8453")
      return {
        body: {
          Pool: [
            {
              id: `8453_${listed.id}`,
              chainId: "8453",
              hooks: listed.hookAddress,
              token0: `8453_${listed.tokens[0]}`,
              token1: `8453_${listed.tokens[1]}`,
              name: names.list ?? "L / M",
              totalValueLockedUSD: "100",
            },
          ],
        },
      };
    if (url.startsWith("https://www.v4.xyz/api/pools?"))
      return { body: { Pool: [] } };
    if (url === `https://www.v4.xyz/api/pool/8453_${newPool.id}`)
      return {
        body: {
          Pool: [
            {
              id: `8453_${newPool.id}`,
              chainId: "8453",
              hooks: hooklessDetail ? ZERO : newPool.hookAddress,
              token0: `8453_${newPool.tokens[0]}`,
              token1: `8453_${newPool.tokens[1]}`,
              name: names.detail ?? "N / M",
            },
          ],
        },
      };
    return { status: 404, body: {} };
  };
  return { answer, newPool, listed };
}

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), "collector-pipeline-"));
  return { dir, done: () => rm(dir, { recursive: true, force: true }) };
}

async function seedState(dir, pools, extra = {}) {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(dir, "state"), { recursive: true });
  await writeFile(join(dir, "state", "pools.json"), poolsJson(null, pools));
  await writeFile(
    join(dir, "state", "census.json"),
    JSON.stringify(extra.census ?? CENSUS),
  );
  if (extra.history)
    await writeFile(
      join(dir, "state", "history.json"),
      historyJson(extra.history),
    );
  return join(dir, "state");
}

async function collect(options = {}) {
  const { dir, done } = await scratch();
  const clock = new FakeClock();
  const pools = options.pools ?? worldPools();
  const world = providers({
    clock,
    pools,
    dark: options.dark,
    ageOf: options.ageOf,
    fresh: options.fresh,
    names: options.names,
    hooklessDetail: options.hooklessDetail,
  });
  const fetchImpl = fakeFetch(clock, world.answer);
  const stateDir = await seedState(dir, pools, options);
  const result = await runCollector({
    stateDir,
    outDir: join(dir, "data"),
    stateOutDir: stateDir,
    minCurrent: options.minCurrent ?? 20,
    fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
    env: { GITHUB_REPOSITORY: "owner/hook-radar" },
    maxDiscovery: options.maxDiscovery,
    maxPools: options.maxPools,
    publish: options.publish ?? true,
  });
  return { dir, done, clock, fetchImpl, result, world, stateDir, pools };
}

test("a full run with fake providers publishes a valid snapshot, overviews, history and status", async () => {
  const run = await collect({ fresh: {} });
  try {
    const { result, dir, fetchImpl } = run;
    assert.equal(result.ok, true, result.quality.failures.join("; "));
    assert.equal(result.published, true);
    const snapshot = JSON.parse(
      await readFile(join(dir, "data", "snapshot.json"), "utf8"),
    );
    assert.equal(isSnapshot(snapshot), true);
    assert.equal(snapshot.status, "partial");
    assert.equal("directory" in snapshot, false);
    assert.equal(snapshot.schemaVersion, 1);
    // generatedAt is the end of the burst, and every measurement is current at it.
    const generatedAt = Date.parse(snapshot.generatedAt);
    assert.equal(generatedAt, Date.parse(result.status.burstEndedAt));
    assert.ok(snapshot.pools.length >= 110);
    assert.ok(
      snapshot.pools.every(
        (pool) => marketMeasurementState(pool, generatedAt) === "current",
      ),
    );
    assert.equal(currentPoolCount(snapshot), snapshot.pools.length);
    // Pools carry their own original observation time and source.
    for (const pool of snapshot.pools) {
      assert.equal(pool.source, "DEX Screener");
      assert.ok(Date.parse(pool.metricUpdatedAt) <= generatedAt);
      assert.ok(pool.projectId);
    }
    // The census keeps its original timestamps.
    assert.equal(snapshot.inventory.generatedAt, CENSUS.inventory.generatedAt);
    assert.equal(
      snapshot.inventory.networks[0].updatedAt,
      "2026-10-27T09:58:00.000Z",
    );
    assert.ok(
      snapshot.sources.some(
        (source) =>
          source.id === "census" &&
          source.status === "cached" &&
          source.updatedAt === CENSUS.inventory.generatedAt,
      ),
    );
    // Every provider used is named with its real request count.
    const ds = snapshot.sources.find((source) => source.id === "dexscreener");
    const dsRequests = fetchImpl.calls.filter((call) =>
      call.url.includes("dexscreener.com"),
    ).length;
    assert.match(ds.note, new RegExp(`${dsRequests} requests? between`));
    assert.ok(snapshot.sources.some((source) => source.id === "v4xyz"));
    assert.ok(snapshot.sources.some((source) => source.id === "geckoterminal"));
    // Registry-named projects appear even without a measurement; anonymous ones only with one.
    const names = snapshot.projects.map((project) => project.name);
    assert.ok(names.includes("Alphix"));
    assert.ok(names.includes("Bunni"));
    assert.ok(names.includes("Clanker"));
    // Overviews exist, validate and are evaluated at the snapshot's own time.
    const files = (await readdir(join(dir, "data"))).sort();
    for (const name of [
      "overview-all-h1.json",
      "overview-all-h6.json",
      "overview-all-h24.json",
      "overview-base-h24.json",
      "overview-ethereum-h24.json",
      "history.json",
      "status.json",
      "snapshot.json",
    ])
      assert.ok(files.includes(name), `${name} is written`);
    const overview = JSON.parse(
      await readFile(join(dir, "data", "overview-all-h24.json"), "utf8"),
    );
    assert.equal(
      isAnalyticsOverviewEnvelope(overview, { chain: "all", window: "h24" }),
      true,
    );
    assert.equal(overview.asOf, snapshot.generatedAt);
    assert.equal(overview.totals.volumeUsd, snapshot.summary.volumeUsd.h24);
    assert.ok(overview.contributions.rows.length > 0);
    // The status file follows the contract.
    const status = JSON.parse(
      await readFile(join(dir, "data", "status.json"), "utf8"),
    );
    assert.deepEqual(
      Object.keys(status).sort(),
      [
        "burstEndedAt",
        "burstStartedAt",
        "collectionStartedAt",
        "collectorVersion",
        "counts",
        "generatedAt",
        "previousGeneratedAt",
        "sources",
      ].sort(),
    );
    assert.equal(status.previousGeneratedAt, null);
    assert.equal(status.generatedAt, snapshot.generatedAt);
    assert.ok(status.counts.requests.total < 400);
    // History: one point, stamped with the oldest measurement behind it.
    const history = JSON.parse(
      await readFile(join(dir, "data", "history.json"), "utf8"),
    );
    assert.equal(history.points.length, 1);
    assert.equal(history.points[0].value, snapshot.summary.volumeUsd.h24);
    assert.equal(
      history.points[0].timestamp,
      Date.parse(snapshot.summary.freshness.volume.h24.oldestAt),
    );
    assert.deepEqual(snapshot.history, [
      {
        timestamp: history.points[0].timestamp,
        value: history.points[0].value,
      },
    ]);
  } finally {
    await run.done();
  }
});

test("discovery adds new hooked pools to state, labelled as indexer-sourced, and measures them", async () => {
  const run = await collect();
  try {
    const state = await readState(run.stateDir);
    const added = state.pools.filter((pool) => pool.source === "v4.xyz");
    assert.deepEqual(
      added.map((pool) => pool.id).sort(),
      [run.world.newPool.id, run.world.listed.id].sort(),
    );
    assert.equal(state.pools.length, run.pools.length + 2);
    const snapshot = run.result.snapshot;
    const measuredIds = new Set(snapshot.pools.map((pool) => pool.address));
    assert.ok(measuredIds.has(run.world.newPool.id));
    // Their hook is known only to the indexer, so the page says that and no more.
    const project = snapshot.projects.find(
      (candidate) =>
        candidate.id ===
        snapshot.pools.find((pool) => pool.address === run.world.newPool.id)
          .projectId,
    );
    assert.match(project.deployments[0].description, /v4\.xyz indexer/);
    assert.doesNotMatch(
      project.deployments[0].description,
      /PoolManager initialization/,
    );
    // A census-verified anonymous hook keeps the standard wording.
    const census = snapshot.projects.find((candidate) =>
      candidate.deployments.some(
        (d) => d.address === ANON_CENSUS.toLowerCase(),
      ),
    );
    assert.match(
      census.deployments[0].description,
      /PoolManager initialization/,
    );
    // Exactly the lookups discovery needs: lists, one GeckoTerminal page per network, one exact lookup.
    const v4 = run.fetchImpl.calls.filter((call) =>
      call.url.startsWith("https://www.v4.xyz"),
    );
    assert.equal(
      v4.filter((call) => call.url.includes("/api/pool/")).length,
      1,
    );
  } finally {
    await run.done();
  }
});

test("a pool a provider does not return is unresolved, never zero; a measured zero stays zero", async () => {
  const pools = worldPools();
  const dark = new Set([pools[0].id, pools[1].id]);
  const run = await collect({
    pools,
    dark,
    fresh: { zeroVolume: pools[2].id, noVolume: pools[3].id },
  });
  try {
    const snapshot = run.result.snapshot;
    const byId = new Map(snapshot.pools.map((pool) => [pool.address, pool]));
    assert.equal(byId.has(pools[0].id), false);
    assert.equal(byId.has(pools[1].id), false);
    assert.deepEqual(byId.get(pools[2].id).volumeUsd, { h1: 0, h6: 0, h24: 0 });
    assert.deepEqual(byId.get(pools[3].id).volumeUsd, {
      h1: null,
      h6: null,
      h24: null,
    });
    const coverage = snapshot.marketCoverage.networks.find(
      (network) => network.chain === "base",
    );
    assert.ok(coverage.missingPools >= 2);
    assert.ok(coverage.checkedPools >= coverage.measuredPools);
  } finally {
    await run.done();
  }
});

test("a stale observation is excluded from totals exactly as the live page excludes it", async () => {
  const pools = worldPools();
  const old = new Set(
    pools.filter((pool) => pool.chain === "ethereum").map((pool) => pool.id),
  );
  const run = await collect({
    pools,
    ageOf: (ids) => (ids.some((id) => old.has(id)) ? 600 : null),
  });
  try {
    const snapshot = run.result.snapshot;
    const generatedAt = Date.parse(snapshot.generatedAt);
    const stale = snapshot.pools.filter(
      (pool) => marketMeasurementState(pool, generatedAt) === "stale",
    );
    assert.equal(stale.length, 30);
    assert.ok(stale.every((pool) => pool.chain === "ethereum"));
    // Their original times are kept, not restamped, and they do not count.
    assert.ok(
      stale.every(
        (pool) => generatedAt - Date.parse(pool.metricUpdatedAt) >= 600000,
      ),
    );
    assert.equal(snapshot.summary.freshness.volume.h24.stalePools, 30);
    const currentSum = snapshot.pools
      .filter((pool) => pool.chain === "base")
      .reduce((sum, pool) => sum + pool.volumeUsd.h24, 0);
    assert.equal(snapshot.summary.volumeUsd.h24, currentSum);
    assert.equal(
      run.result.quality.checks.currentPools,
      snapshot.pools.length - 30,
    );
    // 82 of 112 pools are current (73%): too thin a snapshot to publish.
    assert.equal(run.result.ok, false);
    assert.equal(run.result.published, false);
    assert.match(
      run.result.quality.failures.join(" "),
      /Only 82 of 112 measured pools are current/,
    );
  } finally {
    await run.done();
  }
});

test("a few stale observations are left out of the totals and the snapshot still publishes", async () => {
  const pools = [
    ...worldPools(),
    ...[1, 2, 3, 4, 5].map((n) =>
      statePool(300 + n, {
        chain: "arbitrum",
        hookAddress: ANON_CENSUS.toLowerCase(),
      }),
    ),
  ];
  const old = new Set(
    pools.filter((pool) => pool.chain === "arbitrum").map((pool) => pool.id),
  );
  const run = await collect({
    pools,
    ageOf: (ids) => (ids.some((id) => old.has(id)) ? 600 : null),
  });
  try {
    const { result } = run;
    assert.equal(result.ok, true, result.quality.failures.join("; "));
    assert.equal(result.published, true);
    const { summary } = result.snapshot;
    assert.equal(summary.freshness.volume.h24.stalePools, 5);
    // 110 seeded pools, 5 on Arbitrum with an old copy, and the 2 discovered.
    assert.equal(result.quality.checks.currentPools, 112);
    assert.equal(result.quality.checks.observedPools, 117);
    assert.equal(result.snapshot.pools.length, 117);
  } finally {
    await run.done();
  }
});

test("a pool using a hook shared by several projects' lists is counted once", async () => {
  const shared = [...REGISTRY, hookRow(BUNNI_BASE, "base", 8453, "BunniHook")];
  const pools = worldPools().filter(
    (pool) => pool.hookAddress === BUNNI_BASE.toLowerCase(),
  );
  const { dir, done } = await scratch();
  try {
    const clock = new FakeClock();
    const world = providers({ clock, pools });
    const original = world.answer;
    const fetchImpl = fakeFetch(clock, (call, n) =>
      call.url === REGISTRY_URL ? { body: shared } : original(call, n),
    );
    const stateDir = await seedState(dir, pools);
    const result = await runCollector({
      stateDir,
      outDir: join(dir, "data"),
      minCurrent: 20,
      fetchImpl,
      now: clock.now,
      sleep: clock.sleep,
      maxDiscovery: 0,
    });
    assert.equal(result.ok, true, result.quality.failures.join("; "));
    const { snapshot } = result;
    assert.equal(snapshot.pools.length, pools.length);
    assert.equal(
      new Set(snapshot.pools.map((pool) => `${pool.chain}:${pool.address}`))
        .size,
      pools.length,
    );
    const counted = snapshot.projects.reduce(
      (sum, project) => sum + (project.metrics.poolCount ?? 0),
      0,
    );
    assert.equal(counted, snapshot.pools.length);
    assert.equal(snapshot.summary.trackedPools, pools.length);
  } finally {
    await done();
  }
});

test("a pool DEX Screener measured is never also taken from the GeckoTerminal fallback", async () => {
  const clock = new FakeClock();
  const pools = [1, 2, 3].map((seed) => statePool(seed));
  const geckoRow = (pool) => ({
    id: `base_${pool.id}`,
    type: "pool",
    attributes: {
      address: pool.id,
      name: "G",
      volume_usd: { h1: "9", h6: "9", h24: "9" },
      reserve_in_usd: "5",
    },
    relationships: { dex: { data: { id: base.dex } } },
  });
  const fetchImpl = fakeFetch(clock, (call) =>
    call.url.includes("dexscreener.com")
      ? { body: { pairs: [dexRow(pools[0])] } }
      : { body: { data: pools.map(geckoRow) } },
  );
  const client = createHttpClient({
    fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
  });
  const burst = await runBurst({
    client,
    plan: planBurst(pools),
    now: clock.now,
  });
  assert.equal(burst.measured.size, 3);
  const sources = [...burst.measured.values()]
    .map((pool) => pool.metricProvider)
    .sort();
  assert.deepEqual(sources, ["dexscreener", "geckoterminal", "geckoterminal"]);
  assert.equal(
    burst.measured.get(`base:${pools[0].id}`).metricProvider,
    "dexscreener",
  );
  assert.equal(burst.measured.get(`base:${pools[0].id}`).volumeUsd.h24, 1000);
  assert.equal(burst.fallback.requests, 1);
  assert.deepEqual(burst.fallback.ids, 2);
});

test("a DEX Screener 429 that comes again after the cooldown ends the burst and the quality gate refuses to publish", async () => {
  const { dir, done } = await scratch();
  try {
    const clock = new FakeClock();
    const pools = worldPools();
    const world = providers({ clock, pools });
    let dexCalls = 0;
    const fetchImpl = fakeFetch(clock, (call, n) => {
      if (call.url.includes("dexscreener.com") && ++dexCalls > 1)
        return { status: 429, headers: { "retry-after": "60" } };
      return world.answer(call, n);
    });
    const stateDir = await seedState(dir, pools);
    const result = await runCollector({
      stateDir,
      outDir: join(dir, "data"),
      minCurrent: 1,
      fetchImpl,
      now: clock.now,
      sleep: clock.sleep,
      maxDiscovery: 0,
    });
    assert.equal(result.ok, false);
    assert.equal(result.published, false);
    assert.match(
      result.quality.failures.join(" "),
      /planned pools were requested/,
    );
    assert.match(result.quality.failures.join(" "), /dexscreener/);
    assert.equal(
      fetchImpl.calls.filter((call) => call.url.includes("dexscreener.com"))
        .length,
      3,
      "one retry after the wait, no request after the second 429",
    );
    await assert.rejects(readFile(join(dir, "data", "snapshot.json")), {
      code: "ENOENT",
    });
    const state = await readState(stateDir);
    assert.equal(state.updatedAt, null, "state is untouched");
  } finally {
    await done();
  }
});

test("the quality gate refuses thin, throttled or invalid runs", () => {
  const ok = {
    currentPools: 800,
    currentVolumePools: 800,
    plannedPools: 1000,
    requestedPools: 1000,
    checkedPools: 1000,
    snapshotValid: true,
    overviewsValid: true,
  };
  assert.equal(assessQuality(ok).ok, true);
  // The floor counts the pools that carry a current 24h volume.
  assert.equal(
    assessQuality({
      ...ok,
      currentPools: MIN_CURRENT_POOLS - 1,
      currentVolumePools: MIN_CURRENT_POOLS - 1,
    }).ok,
    false,
  );
  assert.equal(
    assessQuality({
      ...ok,
      currentPools: MIN_CURRENT_POOLS,
      currentVolumePools: MIN_CURRENT_POOLS,
    }).ok,
    true,
  );
  assert.equal(assessQuality({ ...ok, requestedPools: 799 }).ok, false);
  assert.equal(assessQuality({ ...ok, requestedPools: 800 }).ok, true);
  // Of the pools that carry a measurement, nine in ten must be current.
  const thin = (current, observed) =>
    assessQuality({ ...ok, currentPools: current, observedPools: observed });
  assert.equal(thin(900, 1000).ok, true);
  assert.equal(thin(899, 1000).ok, false);
  assert.match(
    thin(749, 1000).failures.join(" "),
    /749 of 1000 measured pools are current/,
  );
  assert.equal(thin(600, 600).ok, true);
  assert.equal(assessQuality({ ...ok, snapshotValid: false }).ok, false);
  assert.equal(assessQuality({ ...ok, overviewsValid: false }).ok, false);
  assert.equal(assessQuality({ ...ok, volumeMeasured: false }).ok, false);
  assert.equal(
    assessQuality({ ...ok, plannedPools: 0, requestedPools: 0 }).ok,
    false,
  );
  const throttled = assessQuality({
    ...ok,
    requestedPools: 100,
    stoppedProviders: ["dexscreener (rate limited (HTTP 429))"],
  });
  assert.equal(throttled.ok, false);
  assert.match(throttled.failures.join(" "), /dexscreener/);
});

test("a run that fails the gate writes nothing, and a dry run writes nothing either", async () => {
  const failing = await collect({ minCurrent: 5000 });
  try {
    assert.equal(failing.result.ok, false);
    assert.equal(failing.result.published, false);
    assert.deepEqual(await readdir(failing.dir), ["state"]);
  } finally {
    await failing.done();
  }
  const dry = await collect({ publish: false });
  try {
    assert.equal(dry.result.ok, true);
    assert.equal(dry.result.published, false);
    assert.deepEqual(await readdir(dry.dir), ["state"]);
    assert.equal((await readState(dry.stateDir)).updatedAt, null);
  } finally {
    await dry.done();
  }
});

test("the request budget of a normal run stays under 400", async () => {
  const run = await collect({ maxPools: 8000 });
  try {
    assert.ok(run.fetchImpl.calls.length < 400);
    assert.ok(run.result.status.counts.requests.total < 400);
  } finally {
    await run.done();
  }
  // Even a full-size plan reserves its batches before discovery spends any:
  // 8,500 pools are 284 batches, plus one per network for rounding (22) and
  // the fallback (3), after the 3 registry requests - which leaves 87.
  assert.equal(requestReserve(8500), Math.ceil(8500 / 30) + 22 + 3);
  const allowance = 399 - 3 - requestReserve(8500);
  assert.equal(allowance, 87);
  // The reserve covers the worst spread of pools over networks: one pool more
  // than a whole batch on each of the 22 networks the providers price.
  const spread = measurementChains().flatMap((chain) =>
    Array.from({ length: 31 }, (_, i) =>
      statePool(1000 * chain.chainId + i, { chain: chain.chain }),
    ),
  );
  const worst = planBurst(spread, { maxPools: spread.length });
  assert.equal(worst.batches, 2 * 22);
  assert.ok(
    worst.batches + 3 <= requestReserve(spread.length),
    "a plan's batches and fallback fit the reserve",
  );
  assert.deepEqual(fitDiscovery({ lists: 20, resolves: 40, allowance }), {
    lists: 20,
    resolves: 40,
  });
  const tight = fitDiscovery({ lists: 20, resolves: 40, allowance: 60 });
  assert.ok(2 * tight.lists + tight.resolves <= 60);
  assert.equal(tight.lists, 20, "lookups are trimmed before network lists");
  assert.deepEqual(fitDiscovery({ lists: 21, resolves: 40, allowance: 1000 }), {
    lists: 21,
    resolves: 40,
  });
  assert.deepEqual(fitDiscovery({ lists: 21, resolves: 40, allowance: 0 }), {
    lists: 0,
    resolves: 0,
  });
});

test("state is validated on read and written atomically", async () => {
  const { dir, done } = await scratch();
  try {
    const pools = [1, 2, 3].map((seed) => statePool(seed));
    const stateDir = await seedState(dir, pools, { history: [] });
    const state = await readState(stateDir);
    assert.deepEqual(state.pools, pools);
    assert.equal(state.history.length, 0);
    assert.equal(state.census.exportedAt, CENSUS.exportedAt);
    await writeFile(
      join(stateDir, "pools.json"),
      poolsJson(null, [
        {
          ...pools[0],
          hookAddress: "0x0000000000000000000000000000000000000000",
        },
      ]),
    );
    await assert.rejects(readState(stateDir), /row 0/);
    await writeFile(
      join(stateDir, "pools.json"),
      poolsJson(null, [{ ...pools[0], tokens: [pools[0].tokens[0]] }]),
    );
    await assert.rejects(readState(stateDir), /row 0/);
    await writeFile(
      join(stateDir, "pools.json"),
      poolsJson(null, [pools[0], pools[0]]),
    );
    await assert.rejects(readState(stateDir), /duplicate/);
    await writeFile(join(stateDir, "pools.json"), "{");
    await assert.rejects(readState(stateDir), /not valid JSON/);
    await rm(join(stateDir, "pools.json"));
    await assert.rejects(readState(stateDir), /export-seed/);
  } finally {
    await done();
  }
});

test("history keeps the newest 672 points, strictly increasing and five minutes apart", () => {
  const start = Date.parse("2026-01-01T00:00:00.000Z");
  const point = (index) => ({
    timestamp: start + index * 3 * 3600000,
    value: index,
    pools: 600,
  });
  let points = [];
  for (let index = 0; index < 700; index++)
    points = appendHistoryPoint(points, point(index));
  assert.equal(points.length, HISTORY_MAX_POINTS);
  assert.equal(points[0].value, 700 - HISTORY_MAX_POINTS);
  assert.equal(points.at(-1).value, 699);
  assert.ok(
    points.every(
      (entry, index) =>
        index === 0 || entry.timestamp > points[index - 1].timestamp,
    ),
  );
  // A second run inside five minutes, or an older one, adds nothing.
  assert.equal(
    appendHistoryPoint(points, {
      ...point(699),
      timestamp: points.at(-1).timestamp + 299999,
    }),
    points,
  );
  assert.equal(
    appendHistoryPoint(points, {
      ...point(699),
      timestamp: points.at(-1).timestamp - 1,
    }),
    points,
  );
  assert.equal(appendHistoryPoint(points, null), points);
  assert.equal(
    appendHistoryPoint(points, {
      ...point(699),
      timestamp: points.at(-1).timestamp + 300000,
    }).length,
    HISTORY_MAX_POINTS,
  );
  // An over-long stored history is trimmed to the cap.
  const long = Array.from({ length: 800 }, (_, index) => point(index));
  assert.equal(appendHistoryPoint(long, null).length, HISTORY_MAX_POINTS);
});

test("a history point exists only when a pool had a current 24h volume", () => {
  const summary = (volume, current, oldestAt) => ({
    volumeUsd: { h1: null, h6: null, h24: volume },
    freshness: { volume: { h24: { currentPools: current, oldestAt } } },
  });
  assert.deepEqual(
    historyPointFor(summary(123.5, 7, "2026-10-28T12:00:01.000Z")),
    {
      timestamp: Date.parse("2026-10-28T12:00:01.000Z"),
      value: 123.5,
      pools: 7,
    },
  );
  assert.deepEqual(
    historyPointFor(summary(0, 3, "2026-10-28T12:00:01.000Z")).value,
    0,
  );
  assert.equal(historyPointFor(summary(null, 0, null)), null);
  assert.equal(historyPointFor(summary(10, 0, null)), null);
  assert.equal(
    historyPointFor({ volumeUsd: { h24: null }, freshness: undefined }),
    null,
  );
});

test("pool state keeps lastSeen quiet, adds discoveries and caps its size", () => {
  const day = LAST_SEEN_GRANULARITY_MS;
  const t0 = Date.parse("2026-10-28T12:00:00.000Z");
  const recent = statePool(1, {
    lastSeen: new Date(t0 - 3600000).toISOString(),
  });
  const old = statePool(2, { lastSeen: new Date(t0 - day - 1).toISOString() });
  const gone = statePool(3, { lastSeen: new Date(t0 - 3 * day).toISOString() });
  const found = statePool(4, {
    source: "v4.xyz",
    firstSeen: new Date(t0).toISOString(),
    lastSeen: new Date(t0).toISOString(),
  });
  const measured = new Map([
    [`base:${recent.id}`, { createdAt: "2026-01-01T00:00:00.000Z" }],
    [`base:${old.id}`, { createdAt: null }],
  ]);
  const next = nextPools({
    pools: [recent, old, gone],
    found: [found],
    measured,
    generatedAtMs: t0,
  });
  const by = Object.fromEntries(next.map((pool) => [pool.id, pool]));
  assert.equal(
    by[recent.id].lastSeen,
    recent.lastSeen,
    "seen within a day: unchanged",
  );
  assert.equal(
    by[recent.id].createdAt,
    "2026-01-01T00:00:00.000Z",
    "a known creation time fills a blank one",
  );
  assert.equal(by[old.id].lastSeen, new Date(t0).toISOString());
  assert.equal(by[gone.id].lastSeen, gone.lastSeen, "not seen: unchanged");
  assert.equal(by[found.id].source, "v4.xyz");
  const many = Array.from({ length: STATE_MAX_POOLS + 25 }, (_, index) =>
    statePool(10000 + index, {
      lastSeen: new Date(t0 - index * 1000).toISOString(),
    }),
  );
  const capped = nextPools({
    pools: many,
    found: [],
    measured: new Map(),
    generatedAtMs: t0,
  });
  assert.equal(capped.length, STATE_MAX_POOLS);
  assert.ok(
    !capped.some((pool) => pool.id === many.at(-1).id),
    "the least recently seen are dropped first",
  );
});

test("the plan cuts to the cap by recency and composes batches by id", () => {
  const pools = Array.from({ length: 90 }, (_, index) =>
    statePool(index + 1, {
      lastSeen: new Date(
        Date.parse("2026-10-01T00:00:00.000Z") + index * 1000,
      ).toISOString(),
    }),
  );
  const plan = planBurst(pools, { maxPools: 60 });
  assert.equal(plan.planned, 60);
  assert.equal(plan.batches, 2);
  const ids = plan.networks[0].pools.map((pool) => pool.id);
  assert.deepEqual(ids, [...ids].sort());
  const newest = new Set(pools.slice(30).map((pool) => pool.id));
  assert.ok(ids.every((id) => newest.has(id)));
  // A chain the providers do not price is counted, not requested.
  const odd = planBurst([
    ...pools.slice(0, 3),
    statePool(500, { chain: "nowhere" }),
  ]);
  assert.equal(odd.planned, 3);
  assert.equal(odd.unsupported, 1);
});

test("fallback batches take the highest-priority unresolved pools, one network per batch", () => {
  const rows = (chain, count, from) =>
    Array.from({ length: count }, (_, index) => ({
      chain,
      pool: statePool(from + index, { chain: chain.chain }),
    }));
  const unresolved = [...rows(base, 35, 1), ...rows(ethereum, 5, 100)];
  const batches = fallbackBatches(unresolved, 3);
  assert.deepEqual(
    batches.map((batch) => [batch.chain.chain, batch.pools.length]),
    [
      ["base", 30],
      ["base", 5],
      ["ethereum", 5],
    ],
  );
  assert.equal(fallbackBatches(unresolved, 1).length, 1);
  assert.equal(fallbackBatches([], 3).length, 0);
});

test("offline runs refuse to write into public/data, and the gate cannot be lowered online", () => {
  assert.throws(() => parseArguments(["--offline"]), /--out/);
  assert.doesNotThrow(() => parseArguments(["--offline", "--out", "x"]));
  assert.doesNotThrow(() => parseArguments(["--offline", "--no-publish"]));
  assert.throws(
    () => parseArguments(["--min-current", "10"]),
    /only allowed with --offline/,
  );
  assert.doesNotThrow(() =>
    parseArguments(["--min-current", "10", "--offline", "--out", "x"]),
  );
  assert.doesNotThrow(() =>
    parseArguments(["--min-current", String(MIN_CURRENT_POOLS)]),
  );
  assert.throws(() => parseArguments(["--max-discovery", "-1"]));
  assert.throws(() => parseArguments(["--max-pools", "0"]));
  assert.throws(() => parseArguments(["--bogus"]));
  assert.equal(parseArguments(["--max-discovery", "0"]).maxDiscovery, 0);
});

test("the seed keeps the hooked pools with the most 24h volume, then liquidity", async () => {
  const run = await collect({ publish: false });
  try {
    const live = JSON.parse(JSON.stringify(run.result.snapshot));
    // Make rank unambiguous and add the awkward rows the live app can contain.
    live.pools.forEach((pool, index) => {
      pool.volumeUsd.h24 = index % 7 === 0 ? null : (index * 37) % 101;
      pool.liquidityUsd = (index * 13) % 17;
    });
    const withoutTokens = {
      ...live.pools[0],
      address: poolId(7001),
      tokens: [live.pools[0].tokens[0]],
    };
    const notHooked = {
      ...live.pools[1],
      address: poolId(7002),
      hookAddress: null,
    };
    live.pools.push(withoutTokens, notHooked, { ...live.pools[2] });
    assert.equal(isSnapshot(live), true);
    const seed = buildSeed(live, {
      exportedAt: "2026-10-28T13:00:00.000Z",
      maxPools: 50,
    });
    assert.equal(seed.pools.length, 50);
    assert.deepEqual(seed.census.seed.skipped, {
      notHooked: 1,
      noTokens: 1,
      duplicate: 1,
      invalid: 0,
    });
    const rank = new Map(live.pools.map((pool) => [pool.address, pool]));
    const volumes = seed.pools.map((pool) => rank.get(pool.id).volumeUsd.h24);
    const known = volumes.filter((value) => value !== null);
    assert.deepEqual(
      known,
      [...known].sort((a, b) => b - a),
    );
    assert.ok(
      volumes.indexOf(null) === -1 ||
        volumes.slice(volumes.indexOf(null)).every((value) => value === null),
      "unknown volumes rank last",
    );
    for (const pool of seed.pools) {
      assert.equal(pool.source, "census");
      assert.equal(pool.firstSeen, "2026-10-28T13:00:00.000Z");
      assert.equal(pool.tokens.length, 2);
    }
    // The census is exported with its original timestamps plus the export time.
    assert.equal(seed.census.exportedAt, "2026-10-28T13:00:00.000Z");
    assert.equal(
      seed.census.inventory.generatedAt,
      CENSUS.inventory.generatedAt,
    );
    assert.deepEqual(seed.census.inventory.networks, CENSUS.inventory.networks);
    // A response that is not a snapshot, or has no census, seeds nothing.
    assert.throws(
      () =>
        buildSeed({ nope: true }, { exportedAt: "2026-10-28T13:00:00.000Z" }),
      /not a Hook Radar snapshot/,
    );
    const { inventory, ...noCensus } = live;
    assert.throws(
      () => buildSeed(noCensus, { exportedAt: "2026-10-28T13:00:00.000Z" }),
      /census/,
    );
  } finally {
    await run.done();
  }
});

test("the seed export makes at most three requests, and retries only server errors", async () => {
  const payload = JSON.stringify({ hello: "world" });
  const sleeps = [];
  const sleep = async (ms) => sleeps.push(ms);
  const seen = [];
  const ok = async (url, headers) => {
    seen.push({ url, headers });
    return {
      status: 200,
      headers: { "content-encoding": "gzip" },
      body: gzipSync(payload),
    };
  };
  const result = await fetchSnapshotText("http://127.0.0.1:4173", {
    get: ok,
    sleep,
  });
  assert.equal(result.text, payload);
  assert.equal(result.attempts, 1);
  assert.equal(seen[0].url, "http://127.0.0.1:4173/api/snapshot");
  assert.equal(seen[0].headers["accept-encoding"], "gzip");

  let calls = 0;
  const failing = async () => {
    calls++;
    return { status: 503, headers: {}, body: Buffer.alloc(0) };
  };
  await assert.rejects(
    fetchSnapshotText("http://127.0.0.1:4173", { get: failing, sleep }),
    /HTTP 503/,
  );
  assert.equal(calls, MAX_ATTEMPTS);
  assert.equal(MAX_ATTEMPTS, 3);

  calls = 0;
  const refused = async () => {
    calls++;
    return { status: 429, headers: {}, body: Buffer.alloc(0) };
  };
  await assert.rejects(
    fetchSnapshotText("http://127.0.0.1:4173", { get: refused, sleep }),
    /HTTP 429/,
  );
  assert.equal(calls, 1, "a 429 is never retried");

  calls = 0;
  const dropped = async () => {
    if (++calls < 3) throw new Error("socket hang up");
    return { status: 200, headers: {}, body: Buffer.from(payload) };
  };
  assert.equal(
    (await fetchSnapshotText("http://127.0.0.1:4173", { get: dropped, sleep }))
      .attempts,
    3,
  );
});

test("pools GeckoTerminal measured are remembered and tried first by the fallback", () => {
  const t0 = Date.parse("2026-10-28T12:00:00.000Z");
  const a = statePool(1);
  const b = statePool(2, { via: "geckoterminal" });
  const c = statePool(3, { via: "geckoterminal" });
  const d = statePool(4);
  const measured = new Map([
    [`base:${a.id}`, { metricProvider: "geckoterminal", createdAt: null }],
    [`base:${b.id}`, { metricProvider: "dexscreener", createdAt: null }],
  ]);
  const next = Object.fromEntries(
    nextPools({
      pools: [a, b, c, d],
      found: [],
      measured,
      generatedAtMs: t0,
    }).map((pool) => [pool.id, pool]),
  );
  assert.equal(
    next[a.id].via,
    "geckoterminal",
    "now measured by GeckoTerminal",
  );
  assert.equal("via" in next[b.id], false, "DEX Screener has it again");
  assert.equal(
    next[c.id].via,
    "geckoterminal",
    "not measured this time: the hint stays",
  );
  assert.equal("via" in next[d.id], false);
  const rows = (...pools) => pools.map((pool) => ({ chain: base, pool }));
  const batches = fallbackBatches(rows(a, b, c, d), 1);
  assert.deepEqual(
    batches[0].pools.map((pool) => pool.id),
    [b.id, c.id, a.id, d.id],
    "hinted pools first, the rest in plan order",
  );
});

test("a pool's via hint must be a known provider", async () => {
  const { dir, done } = await scratch();
  try {
    const stateDir = await seedState(dir, [
      statePool(1, { via: "geckoterminal" }),
    ]);
    assert.equal((await readState(stateDir)).pools[0].via, "geckoterminal");
    await writeFile(
      join(stateDir, "pools.json"),
      poolsJson(null, [statePool(1, { via: "elsewhere" })]),
    );
    await assert.rejects(readState(stateDir), /row 0/);
  } finally {
    await done();
  }
});

test("the seed export refuses a saved-response time that is not a past UTC time", async () => {
  const { main } = await import("../collector/export-seed.mjs");
  const quiet = async (argv) => {
    const { log, error } = console;
    console.log = console.error = () => {};
    try {
      return await main(argv);
    } finally {
      console.log = log;
      console.error = error;
    }
  };
  assert.equal(
    await quiet(["--exported-at", "2026-10-27T21:10:10.592Z"]),
    2,
    "only with --from-file",
  );
  assert.equal(
    await quiet(["--from-file", "x.json", "--exported-at", "yesterday"]),
    2,
  );
  assert.equal(
    await quiet([
      "--from-file",
      "x.json",
      "--exported-at",
      "2999-01-01T00:00:00.000Z",
    ]),
    2,
  );
  assert.equal(await quiet(["--max-pools", "0"]), 2);
  assert.equal(
    await quiet(["--url", "https://example.com"]),
    1,
    "a remote address needs --allow-remote",
  );
});

test("a pool the indexer says has no hook is remembered and never looked up again", async () => {
  const { dir, done } = await scratch();
  try {
    const pools = worldPools();
    const lookups = [];
    const stateDir = await seedState(dir, pools);
    const run = async (clock) => {
      const world = providers({ clock, pools, hooklessDetail: true });
      const fetchImpl = fakeFetch(clock, (call, n) => {
        if (call.url.includes("/api/pool/")) lookups.push(call.url);
        return world.answer(call, n);
      });
      const result = await runCollector({
        stateDir,
        outDir: join(dir, "data"),
        minCurrent: 20,
        fetchImpl,
        now: clock.now,
        sleep: clock.sleep,
      });
      return { result, world };
    };
    const first = await run(new FakeClock());
    assert.equal(
      first.result.ok,
      true,
      first.result.quality.failures.join("; "),
    );
    const key = `base:${first.world.newPool.id}`;
    assert.equal(lookups.length, 1);
    assert.equal(first.result.status.counts.discoveredHookless, 1);
    // It is in hookless.json, not in the pool list, and not measured.
    const text = await readFile(join(stateDir, "hookless.json"), "utf8");
    assert.deepEqual(JSON.parse(text).pools, [key]);
    const state = await readState(stateDir);
    assert.equal(state.hookless.has(key), true);
    assert.equal(
      state.pools.some((pool) => pool.id === first.world.newPool.id),
      false,
    );
    assert.equal(
      first.result.snapshot.pools.some(
        (pool) => pool.address === first.world.newPool.id,
      ),
      false,
    );
    // The next run reads the same GeckoTerminal page and does not ask again.
    const later = new FakeClock(Date.parse("2026-10-28T15:00:00.000Z"));
    const second = await run(later);
    assert.equal(
      second.result.ok,
      true,
      second.result.quality.failures.join("; "),
    );
    assert.equal(lookups.length, 1, "no exact lookup for it the second time");
    assert.equal(second.result.status.counts.discoveredHookless, 0);
    assert.deepEqual(
      JSON.parse(await readFile(join(stateDir, "hookless.json"), "utf8")).pools,
      [key],
    );
  } finally {
    await done();
  }
});

test("a hook is tagged dynamic-fee on evidence, and a hook with none says so instead of a plain no", async () => {
  const deploymentOf = (snapshot, hook) =>
    snapshot.projects
      .flatMap((project) => project.deployments)
      .find((deployment) => deployment.address === hook.toLowerCase());
  const unknownNote = /has not been established/;
  const withSeedFee = (value) =>
    worldPools().map((pool) =>
      pool.hookAddress === ANON_CENSUS.toLowerCase()
        ? { ...pool, ...(value === undefined ? {} : { dynamicFee: value }) }
        : pool,
    );

  // The seed knows its hook is dynamic; the indexer's names say nothing.
  const seeded = await collect({
    pools: withSeedFee(true),
    names: { detail: "N / M - 0.3%", list: "L / M - 0.3%" },
  });
  // The seed checked its hook and found it fixed; a listed pool is dynamic.
  const fixed = await collect({
    pools: withSeedFee(false),
    names: { detail: "N / M - 0.3%", list: "L / M - 838.8608%" },
  });
  // The seed has no evidence at all.
  const blank = await collect({ pools: withSeedFee(undefined) });
  try {
    for (const run of [seeded, fixed, blank])
      assert.equal(run.result.ok, true, run.result.quality.failures.join("; "));
    const a = seeded.result.snapshot;
    assert.equal(deploymentOf(a, ANON_CENSUS).properties.dynamicFee, true);
    assert.doesNotMatch(deploymentOf(a, ANON_CENSUS).description, unknownNote);
    // Fixed-fee names prove nothing about a hook nobody checked.
    assert.equal(deploymentOf(a, ANON_INDEXER).properties.dynamicFee, false);
    assert.match(deploymentOf(a, ANON_INDEXER).description, unknownNote);
    assert.match(deploymentOf(a, ANON_INDEXER).description, /v4\.xyz indexer/);

    const b = fixed.result.snapshot;
    assert.equal(deploymentOf(b, ANON_CENSUS).properties.dynamicFee, false);
    assert.doesNotMatch(deploymentOf(b, ANON_CENSUS).description, unknownNote);
    // One dynamic pool makes the hook dynamic, whatever its other pool says.
    assert.equal(deploymentOf(b, ANON_INDEXER).properties.dynamicFee, true);
    assert.doesNotMatch(deploymentOf(b, ANON_INDEXER).description, unknownNote);
    const stored = (await readState(fixed.stateDir)).pools.filter(
      (pool) => pool.source === "v4.xyz",
    );
    assert.deepEqual(
      Object.fromEntries(stored.map((pool) => [pool.id, pool.dynamicFee])),
      {
        [fixed.world.newPool.id]: undefined,
        [fixed.world.listed.id]: true,
      },
    );

    const c = blank.result.snapshot;
    assert.equal(deploymentOf(c, ANON_CENSUS).properties.dynamicFee, false);
    assert.match(deploymentOf(c, ANON_CENSUS).description, unknownNote);

    // A hook the hooklist names keeps the hooklist's own answer and wording.
    for (const snapshot of [a, b, c]) {
      const listed = deploymentOf(snapshot, BUNNI_BASE);
      assert.equal(listed.properties.dynamicFee, true);
      assert.doesNotMatch(listed.description, unknownNote);
    }
    // The pools themselves never carry a fee.
    assert.ok(
      a.pools.every((pool) => !("fee" in pool) && !("dynamicFee" in pool)),
    );
  } finally {
    await Promise.all([seeded.done(), fixed.done(), blank.done()]);
  }
});

test("the seed keeps the live app's dynamic-fee answer for hooks outside the hooklist", async () => {
  const run = await collect({ publish: false });
  try {
    const live = JSON.parse(JSON.stringify(run.result.snapshot));
    const kinds = new Map();
    for (const project of live.projects)
      for (const deployment of project.deployments) {
        kinds.set(deployment.address, deployment.discovery ?? "listed");
        if (deployment.address === ANON_CENSUS.toLowerCase())
          deployment.properties.dynamicFee = true;
      }
    assert.equal(kinds.get(ANON_CENSUS.toLowerCase()), "onchain");
    assert.equal(kinds.get(BUNNI_BASE.toLowerCase()), "listed");
    assert.equal(isSnapshot(live), true);
    const { pools: seeded } = buildSeed(live, {
      exportedAt: "2026-10-28T13:00:00.000Z",
    });
    const by = (hook) =>
      seeded.filter((pool) => pool.hookAddress === hook.toLowerCase());
    assert.ok(by(ANON_CENSUS).length > 0);
    assert.ok(by(ANON_CENSUS).every((pool) => pool.dynamicFee === true));
    assert.ok(by(ANON_INDEXER).length > 0);
    assert.ok(by(ANON_INDEXER).every((pool) => pool.dynamicFee === false));
    // The hooklist speaks for its own hooks: nothing is copied for them.
    assert.ok(by(BUNNI_BASE).length > 0);
    assert.ok(by(BUNNI_BASE).every((pool) => !("dynamicFee" in pool)));
    // What the seed writes is what the state reader accepts.
    const { dir, done } = await scratch();
    try {
      const stateDir = await seedState(dir, seeded);
      const byKey = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      assert.deepEqual(
        (await readState(stateDir)).pools.sort(byKey),
        [...seeded].sort(byKey),
      );
      await writeFile(
        join(stateDir, "pools.json"),
        poolsJson(null, [{ ...seeded[0], dynamicFee: "yes" }]),
      );
      await assert.rejects(readState(stateDir), /row 0/);
    } finally {
      await done();
    }
  } finally {
    await run.done();
  }
});

test("a pool found by discovery never takes a seeded pool's place in the plan", () => {
  const at = (seconds) =>
    new Date(
      Date.parse("2026-10-27T00:00:00.000Z") + seconds * 1000,
    ).toISOString();
  const seeded = Array.from({ length: 100 }, (_, i) =>
    statePool(i + 1, { lastSeen: at(0), firstSeen: at(0) }),
  );
  const found = Array.from({ length: 30 }, (_, i) =>
    statePool(500 + i, {
      source: "v4.xyz",
      firstSeen: at(86400),
      lastSeen: at(86400 + i),
    }),
  );
  const ids = (plan) =>
    new Set(plan.networks.flatMap((n) => n.pools.map((p) => p.id)));
  const seededIds = new Set(seeded.map((pool) => pool.id));
  const everything = [...found, ...seeded];

  // Room for all of them.
  assert.equal(
    planBurst(everything, { maxPools: 130, maxDiscovered: 30 }).planned,
    130,
  );
  // Seeded pools fill the plan; discovery gets what is left, newest first.
  const some = planBurst(everything, { maxPools: 110, maxDiscovered: 20 });
  assert.equal(some.planned, 110);
  assert.equal(some.plannedDiscovered, 10);
  assert.ok([...seededIds].every((id) => ids(some).has(id)));
  const newest = found.slice(-10).map((pool) => pool.id);
  assert.ok(newest.every((id) => ids(some).has(id)));
  // Discovery's allowance is its own limit.
  assert.equal(
    planBurst(everything, { maxPools: 130, maxDiscovered: 7 })
      .plannedDiscovered,
    7,
  );
  // No room left: not one seeded pool is displaced, however recent the new ones.
  const full = planBurst(everything, { maxPools: 100, maxDiscovered: 20 });
  assert.equal(full.plannedDiscovered, 0);
  assert.deepEqual(ids(full), seededIds);
  // Fewer places than seeded pools: only seeded pools, by the usual order.
  const fewer = planBurst(everything, { maxPools: 90 });
  assert.equal(fewer.plannedDiscovered, 0);
  assert.ok([...ids(fewer)].every((id) => seededIds.has(id)));

  // The default plan is the one the request budget was sized for: the 8,000
  // seeded pools plus up to 500 more, whatever the age of the new ones.
  const big = [
    ...Array.from({ length: MAX_MEASURED_POOLS }, (_, i) =>
      statePool(10000 + i, { lastSeen: at(0) }),
    ),
    ...Array.from({ length: 700 }, (_, i) =>
      statePool(30000 + i, { source: "v4.xyz", lastSeen: at(99999) }),
    ),
  ];
  const plan = planBurst(big);
  assert.equal(plan.planned, 8500);
  assert.equal(plan.planned, MAX_MEASURED_POOLS + MAX_DISCOVERED_MEASURED);
  assert.equal(plan.plannedDiscovered, 500);
  const planned = ids(plan);
  assert.ok(big.slice(0, 8000).every((pool) => planned.has(pool.id)));
});

// Discovery, with a client that answers from a table: GeckoTerminal pages name
// candidate pools, the indexer resolves each one.

function discoveryWorld({ failing = new Set(), counts = {} } = {}) {
  const chains = METRIC_CHAINS.slice(0, 4);
  const lookups = [];
  const candidate = (chain, k) => poolId(40000 + chain.chainId * 100 + k);
  const client = {
    isStopped: () => false,
    async getJson(provider, url) {
      if (provider === "geckoterminal") {
        const chain = chains.find((c) => url.includes(`/networks/${c.gecko}/`));
        if (failing.has(chain.chain)) throw new Error("page failed");
        const total = counts[chain.chain] ?? 20;
        return {
          data: {
            data: Array.from({ length: total }, (_, k) => ({
              id: `${chain.gecko}_${candidate(chain, k)}`,
              type: "pool",
              attributes: { address: candidate(chain, k), name: "A / B" },
              relationships: { dex: { data: { id: chain.dex } } },
            })),
          },
        };
      }
      if (url.includes("/api/pool/")) {
        const [, chainId, id] = /pool\/(\d+)_(0x[0-9a-f]{64})$/.exec(url);
        const chain = chains.find((c) => c.chainId === Number(chainId));
        lookups.push(chain.chain);
        return {
          data: {
            Pool: [
              {
                id: `${chainId}_${id}`,
                chainId,
                hooks: address(60000 + chain.chainId),
                token0: `${chainId}_${address(1)}`,
                token1: `${chainId}_${address(2)}`,
                name: "A / B - 0.3%",
              },
            ],
          },
        };
      }
      return { data: { Pool: [] } };
    },
  };
  const run = (page, maxResolves) =>
    discoverPools({
      client,
      known: new Set(),
      hookless: new Set(),
      page,
      maxResolves,
      now: () => Date.parse("2026-10-28T12:00:00.000Z"),
      chains,
    });
  const tally = () =>
    Object.fromEntries(
      chains.map((c) => [c.chain, lookups.filter((x) => x === c.chain).length]),
    );
  return { run, tally, lookups, chains };
}

test("exact lookups are shared equally between networks, whatever order their pages arrive in", async () => {
  const world = discoveryWorld();
  const found = await world.run(1, 8);
  assert.equal(found.stats.resolvesTried, 8);
  assert.deepEqual(Object.values(world.tally()), [2, 2, 2, 2]);
  assert.equal(found.found.length, 8);
});

test("the remainder of an uneven split goes to different networks from one run to the next", async () => {
  const seen = [];
  for (const page of [1, 2, 3, 4]) {
    const world = discoveryWorld();
    await world.run(page, 10);
    const counts = Object.values(world.tally());
    assert.equal(
      counts.reduce((a, b) => a + b, 0),
      10,
    );
    assert.ok(counts.every((n) => n === 2 || n === 3));
    seen.push(counts.map((n) => n - 2));
  }
  // Four runs, four different pairs; over the cycle every network got an extra
  // lookup equally often.
  assert.equal(new Set(seen.map((row) => row.join())).size, 4);
  assert.deepEqual(
    seen[0].map((_, i) => seen.reduce((sum, row) => sum + row[i], 0)),
    [2, 2, 2, 2],
  );
});

test("a share a network cannot use - no candidates, or a failed page - is handed on, one lookup per network in turn", async () => {
  const few = discoveryWorld({ counts: { ethereum: 1 } });
  const a = await few.run(1, 8);
  assert.equal(a.stats.resolvesTried, 8);
  assert.deepEqual(few.tally(), {
    ethereum: 1,
    base: 3,
    unichain: 2,
    arbitrum: 2,
  });

  const failed = discoveryWorld({ failing: new Set(["unichain"]) });
  const b = await failed.run(1, 8);
  assert.equal(b.stats.geckoPageFailures, 1);
  assert.equal(b.stats.resolvesTried, 8);
  assert.deepEqual(failed.tally(), {
    ethereum: 3,
    base: 3,
    unichain: 0,
    arbitrum: 2,
  });

  // Never more than the budget, and none when the budget is none.
  const none = discoveryWorld();
  assert.equal((await none.run(1, 0)).stats.resolvesTried, 0);
  assert.equal(none.lookups.length, 0);
});

test("hook fee evidence: any dynamic pool makes the hook dynamic, whatever order the pools come in", () => {
  const ids = new Map([
    ["base", 8453],
    ["ethereum", 1],
  ]);
  const pool = (chain, hook, dynamicFee) => ({
    chain,
    hookAddress: hook.toLowerCase(),
    ...(dynamicFee === undefined ? {} : { dynamicFee }),
  });
  const key = (chainId, hook) => `${chainId}:${hook.toLowerCase()}`;
  const a = address(7001);
  const b = address(7002);
  const c = address(7003);
  const d = address(7004);
  for (const order of [
    [pool("base", a, true), pool("base", a, false)],
    [pool("base", a, false), pool("base", a, true)],
  ])
    assert.equal(hookFeeEvidence(order, ids).get(key(8453, a)), true);
  const evidence = hookFeeEvidence(
    [
      pool("base", a, false),
      pool("base", a, false),
      pool("base", b),
      pool("ethereum", c, true),
      pool("base", c),
      pool("elsewhere", d, true),
      { ...pool("base", d), dynamicFee: "yes" },
    ],
    ids,
  );
  assert.equal(evidence.get(key(8453, a)), false, "checked, none dynamic");
  assert.equal(evidence.has(key(8453, b)), false, "no evidence is no entry");
  assert.equal(evidence.get(key(1, c)), true);
  assert.equal(evidence.has(key(8453, c)), false, "evidence is per network");
  assert.equal(
    evidence.has(key(8453, d)),
    false,
    "only a true or false counts",
  );
  assert.equal(evidence.size, 2);
});
