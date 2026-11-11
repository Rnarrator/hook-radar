import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { isAnalyticsOverviewEnvelope } from "../shared/analytics-overview.ts";
import { isMarketCoverage } from "../shared/market-coverage.ts";
import { CHAINS_URL, FRONTIER_URL, REGISTRY_URL } from "../server/model.mjs";
import { MARKET_CHAINS } from "../server/market-chains.mjs";
import * as config from "../collector/config.mjs";
import { marketCoverageFor } from "../collector/assemble.mjs";
import { discoverPools, discoveryChains } from "../collector/discover.mjs";
import { historyPointFor, roundCents } from "../collector/history.mjs";
import { createHttpClient } from "../collector/http.mjs";
import { planBurst, runBurst } from "../collector/measure.mjs";
import { hasMarketValue } from "../collector/providers/market-rows.mjs";
import { assessQuality } from "../collector/quality.mjs";
import { loadRegistry, slimHooklist } from "../collector/registry.mjs";
import {
  main,
  ROOT,
  runCollector,
  startedDirectly,
} from "../collector/run.mjs";
import { historyJson, poolsJson } from "../collector/state.mjs";
import {
  address,
  blockNetwork,
  dexRow,
  FakeClock,
  fakeFetch,
  statePool,
} from "../collector/testing.mjs";

blockNetwork();

// What the collector does about the faults the final review found: a quality
// gate that counts answers, a gate that notices a thin sample, a time limit on
// discovery, a registry answer that is hollow, a row without a figure, sums
// recorded to the cent. Every test runs on a fake clock and a fake fetch; none
// reaches a provider.

const T0 = Date.parse("2026-10-28T12:00:00.000Z");
const dexHost = "https://api.dexscreener.com";
const base = MARKET_CHAINS.find((chain) => chain.chain === "base");
const ethereum = MARKET_CHAINS.find((chain) => chain.chain === "ethereum");

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
const BUNNI_BASE = address(9001);
const BUNNI_ETH = address(9003);
const REGISTRY = [
  hookRow(BUNNI_BASE, "base", 8453, "BunniHook"),
  hookRow(BUNNI_ETH, "ethereum", 1, "BunniHook"),
];
const CHAIN_DATA = { ethereum: { chainId: 1 }, base: { chainId: 8453 } };

const basePools = (count, from = 1) =>
  Array.from({ length: count }, (_, i) =>
    statePool(from + i, {
      chain: "base",
      hookAddress: BUNNI_BASE.toLowerCase(),
    }),
  );
const ethereumPools = (count, from = 5000) =>
  Array.from({ length: count }, (_, i) =>
    statePool(from + i, {
      chain: "ethereum",
      hookAddress: BUNNI_ETH.toLowerCase(),
    }),
  );

const geckoRow = (chain, pool, overrides = {}) => ({
  id: `${chain.gecko}_${pool.id}`,
  type: "pool",
  attributes: {
    address: pool.id,
    name: "GGG / HHH 0.3%",
    pool_created_at: "2026-09-01T00:00:00Z",
    reserve_in_usd: "1000.5",
    volume_usd: { h1: "10", h6: "60", h24: "240" },
    base_token_balance: "1",
    quote_token_balance: "1",
    base_token_price_usd: "500",
    quote_token_price_usd: "500.5",
    base_token_liquidity_usd: "500",
    quote_token_liquidity_usd: "500.5",
  },
  relationships: {
    dex: { data: { id: chain.dex } },
    base_token: { data: { id: `${chain.gecko}_${pool.tokens[0]}` } },
    quote_token: { data: { id: `${chain.gecko}_${pool.tokens[1]}` } },
  },
  ...overrides,
});
// A GeckoTerminal row that says nothing: the recorded one in the fixtures has
// a reserve of "0.0" (unverified) and every volume null.
const emptyGeckoRow = (chain, pool) =>
  geckoRow(chain, pool, {
    attributes: {
      address: pool.id,
      name: "EMPTY",
      reserve_in_usd: "0.0",
      volume_usd: { h1: null, h6: null, h24: null },
    },
  });

const scratch = [];
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "edition-w3-"));
  scratch.push(dir);
  return dir;
}
test.after(() =>
  Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true }))),
);

/** One collection run over fake providers. `dex(call, n, clock)` and
 * `gecko(call, n, clock)` answer the market requests; `other` answers the rest
 * (the indexer). The state is `pools` plus an optional history. */
async function collect({
  pools,
  dex = () => null,
  row = (pool) => dexRow(pool),
  gecko = () => ({ body: { data: [] } }),
  other = () => ({ body: { Pool: [] } }),
  history = [],
  registry = REGISTRY,
  frontier = [],
  run = {},
  clock = new FakeClock(T0),
} = {}) {
  const dir = await directory();
  const answerDex = (call, n) => {
    const hit = /pairs\/([a-z]+)\/(.+)$/.exec(call.url);
    const special = dex(call, n, hit?.[1], clock);
    if (special) return special;
    const wanted = new Set(hit[2].split(","));
    const rows = pools.filter((pool) => wanted.has(pool.id)).map(row);
    return { body: { pairs: rows.length ? rows : null } };
  };
  const fetchImpl = fakeFetch(clock, (call, n) => {
    if (call.url === REGISTRY_URL) return { body: registry };
    if (call.url === CHAINS_URL) return { body: CHAIN_DATA };
    if (call.url === FRONTIER_URL) return { body: frontier };
    if (call.url.startsWith(dexHost)) return answerDex(call, n);
    if (call.url.includes("api.geckoterminal.com"))
      return gecko(call, n, clock);
    return other(call, n, clock);
  });
  await mkdir(join(dir, "state"), { recursive: true });
  await writeFile(join(dir, "state", "pools.json"), poolsJson(null, pools));
  if (history.length)
    await writeFile(join(dir, "state", "history.json"), historyJson(history));
  const result = await runCollector({
    stateDir: join(dir, "state"),
    outDir: join(dir, "data"),
    stateOutDir: join(dir, "state-out"),
    minCurrent: 20,
    fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
    maxDiscovery: 0,
    env: { GITHUB_REPOSITORY: "owner/hook-radar" },
    ...run,
  });
  return { result, fetchImpl, clock, dir };
}

const dexCalls = (fetchImpl) =>
  fetchImpl.calls.filter((call) => call.url.startsWith(dexHost));
const idsOf = (call) => call.url.split("/").at(-1).split(",");

// ---- R-1: a row without a figure is not a measurement ---------------------------

test("a row counts as a measurement only when it carries a figure, and a measured zero is one", () => {
  const pool = (liquidityUsd, h1, h6, h24) => ({
    liquidityUsd,
    volumeUsd: { h1, h6, h24 },
  });
  assert.equal(hasMarketValue(pool(null, null, null, null)), false);
  assert.equal(hasMarketValue({ liquidityUsd: null }), false);
  assert.equal(hasMarketValue(pool(0, null, null, null)), true);
  assert.equal(hasMarketValue(pool(null, 0, null, null)), true);
  assert.equal(hasMarketValue(pool(null, null, null, 0)), true);
  assert.equal(hasMarketValue(pool(12.5, null, null, null)), true);
  assert.equal(hasMarketValue(pool(null, null, 3, null)), true);
});

test("a DEX Screener row with no figure is checked, missing and not in the snapshot; a measured zero stays", async () => {
  const pools = basePools(40);
  const [silent, zero] = pools;
  const { result } = await collect({
    pools,
    row: (pool) =>
      pool === silent
        ? dexRow(pool, { volume: {}, liquidity: {} })
        : pool === zero
          ? dexRow(pool, {
              volume: { h1: 0, h6: 0, h24: 0 },
              liquidity: { usd: 0 },
            })
          : dexRow(pool),
    // The fallback is asked about the pool DEX Screener left unresolved and
    // answers it with a row that says nothing either.
    gecko: (call) => ({
      body: { data: [emptyGeckoRow(base, silent)] },
    }),
  });
  assert.equal(result.ok, true, result.quality.failures.join("; "));
  const { snapshot, status } = result;
  assert.equal(snapshot.pools.length, 39);
  assert.equal(
    snapshot.pools.some((pool) => pool.address === silent.id),
    false,
    "the pool that came back without a figure is not published",
  );
  const kept = snapshot.pools.find((pool) => pool.address === zero.id);
  assert.deepEqual(kept.volumeUsd, { h1: 0, h6: 0, h24: 0 });
  assert.equal(kept.liquidityUsd, 0, "a measured zero is a measurement");
  // Every count agrees with the pools the snapshot carries.
  assert.equal(status.counts.measuredPools, 39);
  assert.equal(status.counts.trackedPools, 39);
  assert.equal(status.counts.checkedPools, 40, "answered once, not twice");
  assert.equal(status.counts.fallbackMeasured, 0);
  const row = snapshot.marketCoverage.networks.find((n) => n.chain === "base");
  assert.equal(row.attemptedPools, 40);
  assert.equal(row.checkedPools, 40);
  assert.equal(row.measuredPools, 39);
  assert.equal(row.missingPools, 1);
  assert.equal(isMarketCoverage(snapshot.marketCoverage), true);
  assert.match(
    snapshot.sources.find((source) => source.id === "dexscreener").note,
    / 39 pools returned a matching Uniswap v4 row with a liquidity or volume figure;/,
  );
});

test("a GeckoTerminal fallback row with no figure is checked and not measured; the counts equal the pools published", async () => {
  // DEX Screener does not index Ethereum, so every pool comes from the fallback.
  // The 30 pools are one batch: the plan is requested in full (100%).
  const pools = ethereumPools(30);
  const silent = pools[7];
  const { result } = await collect({
    pools,
    dex: () => ({ status: 400, body: "bad request" }),
    gecko: (call) => {
      const ids = call.url.split("/multi/")[1].split("?")[0].split(",");
      return {
        body: {
          data: pools
            .filter((pool) => ids.includes(pool.id))
            .map((pool) =>
              pool === silent
                ? emptyGeckoRow(ethereum, pool)
                : geckoRow(ethereum, pool),
            ),
        },
      };
    },
  });
  assert.equal(result.ok, true, result.quality.failures.join("; "));
  const { snapshot, status } = result;
  assert.equal(snapshot.pools.length, 29);
  assert.equal(status.counts.measuredPools, snapshot.pools.length);
  assert.equal(status.counts.trackedPools, snapshot.pools.length);
  assert.equal(status.counts.fallbackMeasured, snapshot.pools.length);
  const row = snapshot.marketCoverage.networks.find(
    (n) => n.chain === "ethereum",
  );
  assert.equal(row.checkedPools, 30, "the fallback answered for all 30");
  assert.equal(row.measuredPools, 29);
  assert.equal(row.missingPools, 1);
  assert.equal(row.pendingPools, 0);
  assert.equal(isMarketCoverage(snapshot.marketCoverage), true);
});

// ---- R-2: the rows say which network DEX Screener does not index -----------------

test("a coverage row names a network DEX Screener answered HTTP 400 for, and no other row has the key", async () => {
  const burst = {
    networks: [
      {
        chain: "base",
        chainId: 8453,
        requested: 30,
        checked: 30,
        measured: 30,
      },
      {
        chain: "zora",
        chainId: 7777777,
        requested: 5,
        checked: 0,
        measured: 0,
      },
    ],
    unsupportedNetworks: ["zora"],
  };
  const statePools = [
    ...Array.from({ length: 30 }, () => ({ chain: "base" })),
    ...Array.from({ length: 5 }, () => ({ chain: "zora" })),
  ];
  const coverage = marketCoverageFor({
    burst,
    statePools,
    census: null,
    measuredByChain: new Map([["base", 30]]),
    chainIds: new Map([
      ["base", 8453],
      ["zora", 7777777],
    ]),
  });
  const zora = coverage.networks.find((row) => row.chain === "zora");
  assert.equal(zora.unsupported, true);
  assert.equal(zora.status, "unavailable");
  assert.equal(zora.attemptedPools, 5, "what was attempted is not changed");
  assert.equal(
    Object.hasOwn(
      coverage.networks.find((r) => r.chain === "base"),
      "unsupported",
    ),
    false,
    "the key is absent, not false",
  );
  assert.equal(isMarketCoverage(coverage), true);
  assert.equal(isMarketCoverage(JSON.parse(JSON.stringify(coverage))), true);
  // A burst from before the field existed has no list.
  const bare = marketCoverageFor({
    burst: { networks: burst.networks },
    statePools,
    census: null,
    measuredByChain: new Map([["base", 30]]),
    chainIds: new Map([["base", 8453]]),
  });
  assert.ok(bare.networks.every((row) => !Object.hasOwn(row, "unsupported")));
});

test("a published snapshot flags the unindexed network and still passes the client validator", async () => {
  const pools = [...basePools(300), ...ethereumPools(40)];
  const { result } = await collect({
    pools,
    dex: (call, n, slug) =>
      slug === "ethereum" ? { status: 400, body: "bad request" } : null,
  });
  assert.equal(result.ok, true, result.quality.failures.join("; "));
  const rows = result.snapshot.marketCoverage.networks;
  const eth = rows.find((row) => row.chain === "ethereum");
  assert.equal(eth.unsupported, true);
  assert.deepEqual(result.status.counts.unsupportedNetworks, ["ethereum"]);
  assert.ok(
    rows
      .filter((row) => row.chain !== "ethereum")
      .every((row) => !Object.hasOwn(row, "unsupported")),
  );
});

// ---- C1: the gate counts pools answered -----------------------------------------

test("the gate refuses a run in which half of the batches were asked and not answered", async () => {
  // Every second batch fails with HTTP 503, so five failures never come in a
  // row and the provider is never stopped: all 600 pools are requested.
  const pools = basePools(600);
  const { result, dir } = await collect({
    pools,
    dex: (call, n) => (n % 2 === 0 ? { status: 503, body: "busy" } : null),
  });
  assert.equal(result.quality.checks.requestedPools, 600);
  assert.equal(result.quality.checks.checkedPools, 300);
  assert.equal(result.ok, false);
  assert.match(
    result.quality.failures.join(" "),
    /Only 300 of 600 requested pools were answered \(50%\); at least 80% are required\./,
  );
  assert.equal(result.published, false);
  assert.equal(existsSync(join(dir, "data")), false, "nothing is written");
  assert.equal(existsSync(join(dir, "state-out")), false);
});

test("the answered share is judged at 80%, and the failure names the stopped providers and the unindexed networks", () => {
  const ok = {
    currentPools: 900,
    currentVolumePools: 900,
    plannedPools: 1000,
    requestedPools: 1000,
    checkedPools: 800,
    snapshotValid: true,
    overviewsValid: true,
  };
  assert.equal(assessQuality(ok).ok, true);
  assert.equal(assessQuality({ ...ok, checkedPools: 799 }).ok, false);
  assert.equal(assessQuality({ ...ok, checkedPools: 799 }).checks.share, 1);
  assert.equal(
    assessQuality({ ...ok, checkedPools: 799 }).checks.answeredShare,
    0.799,
  );
  // Left out, it is not assumed: a caller that does not say how many pools were
  // answered is refused.
  const { checkedPools: _left, ...silent } = ok;
  assert.equal(assessQuality(silent).ok, false);
  const refused = assessQuality({
    ...ok,
    checkedPools: 100,
    stoppedProviders: ["dexscreener (forbidden (HTTP 403))"],
    unsupportedNetworks: ["robinhood", "zora"],
  });
  const text = refused.failures.join(" ");
  assert.match(text, /Only 100 of 1000 requested pools were answered/);
  assert.match(
    text,
    /Stopped for this run: dexscreener \(forbidden \(HTTP 403\)\)/,
  );
  assert.match(
    text,
    /Networks DEX Screener answered HTTP 400 for: robinhood, zora\./,
  );
});

test("an unindexed network leaves only its first batch among the pools requested, far inside the allowance", async () => {
  // The real plan: 8,000 pools, X Layer (11) and Zora (5) unindexed.
  const pools = [...basePools(8000 - 16), ...ethereumPools(16, 50000)];
  const burstClock = new FakeClock(T0);
  const fetchImpl = fakeFetch(burstClock, (call) => {
    const hit = /pairs\/([a-z]+)\/(.+)$/.exec(call.url);
    if (hit[1] === "ethereum") return { status: 400, body: "bad" };
    const wanted = new Set(hit[2].split(","));
    return {
      body: {
        pairs: pools.filter((p) => wanted.has(p.id)).map((p) => dexRow(p)),
      },
    };
  });
  const client = createHttpClient({
    fetchImpl,
    now: burstClock.now,
    sleep: burstClock.sleep,
  });
  const burst = await runBurst({
    client,
    plan: planBurst(pools),
    now: burstClock.now,
    fallbackRequests: 0,
  });
  assert.deepEqual(burst.unsupportedNetworks, ["ethereum"]);
  assert.equal(burst.requestedPools, 7984 + 16);
  assert.equal(burst.checkedPools, 7984);
  assert.equal(burst.answeredPools, 7984);
  assert.ok(burst.checkedPools / burst.requestedPools > 0.99);
});

// ---- C1: the pools answered are counted among the pools requested -------------------

/** A GeckoTerminal answer for the ids of a /pools/multi/ request. */
const geckoAnswers = (chain, pools) => (call) => {
  const ids = call.url.split("/multi/")[1].split("?")[0].split(",");
  return {
    body: {
      data: pools
        .filter((pool) => ids.includes(pool.id))
        .map((pool) => geckoRow(chain, pool)),
    },
  };
};
const burstOver = async (pools, { dex, gecko, ...options }) => {
  const clock = new FakeClock(T0);
  const fetchImpl = fakeFetch(clock, (call, n) =>
    call.url.startsWith(dexHost) ? dex(call, n, clock) : gecko(call, n, clock),
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
    ...options,
  });
  return { burst, fetchImpl, clock };
};
const dexAnswers =
  (pools, { unindexed = [] } = {}) =>
  (call) => {
    const hit = /pairs\/([a-z]+)\/(.+)$/.exec(call.url);
    if (unindexed.includes(hit[1])) return { status: 400, body: "bad request" };
    const wanted = new Set(hit[2].split(","));
    return {
      body: {
        pairs: pools.filter((p) => wanted.has(p.id)).map((p) => dexRow(p)),
      },
    };
  };

test("a fallback answer for a pool DEX Screener was never asked about does not count as answered, so answered cannot exceed requested", async () => {
  // 400 Base pools, DEX Screener answers them. Ethereum (100 pools) is not
  // indexed: only its first batch of 30 is requested. The fallback then answers
  // 90 Ethereum pools, 60 of which were never requested.
  const pools = [...basePools(400), ...ethereumPools(100)];
  const { burst } = await burstOver(pools, {
    dex: dexAnswers(pools, { unindexed: ["ethereum"] }),
    gecko: geckoAnswers(ethereum, pools),
    fallbackRequests: 3,
  });
  assert.deepEqual(burst.unsupportedNetworks, ["ethereum"]);
  assert.equal(burst.requestedPools, 430);
  const row = (slug) => burst.networks.find((n) => n.chain === slug);
  assert.equal(row("ethereum").requested, 30);
  assert.equal(
    row("ethereum").checked,
    90,
    "the coverage row still counts every pool a provider answered for",
  );
  assert.equal(burst.checkedPools, 490);
  assert.equal(burst.answeredPools, 430, "30 Ethereum pools were requested");
  assert.ok(burst.answeredPools <= burst.requestedPools);
});

test("a run judges and prints the answered count among the requested pools, and the status keeps both counts", async () => {
  const pools = [...basePools(400), ...ethereumPools(100)];
  const { result } = await collect({
    pools,
    dex: dexAnswers(pools, { unindexed: ["ethereum"] }),
    gecko: geckoAnswers(ethereum, pools),
  });
  assert.equal(result.ok, true, result.quality.failures.join("; "));
  const { checks } = result.quality;
  assert.equal(checks.requestedPools, 430);
  assert.equal(checks.checkedPools, 430, "the PASS line reads 430 answered");
  assert.equal(checks.answeredShare, 1);
  assert.ok(checks.checkedPools <= checks.requestedPools);
  const { counts } = result.status;
  assert.equal(counts.requestedPools, 430);
  assert.equal(counts.answeredPools, 430);
  // The fallback is six requests of 30: it answers all 100 Ethereum pools, 70
  // of them never requested from DEX Screener.
  assert.equal(counts.checkedPools, 500, "every pool a provider answered for");
  const coverage = result.snapshot.marketCoverage.networks.find(
    (n) => n.chain === "ethereum",
  );
  assert.equal(coverage.checkedPools, 100, "the coverage row keeps its count");
  // The flag and a live row go together when GeckoTerminal answered: a page
  // reads the flag only for a row nothing answered for.
  assert.equal(coverage.status, "live");
  assert.equal(coverage.unsupported, true);
});

test("pools that were planned and not requested cannot make up for pools that went unanswered", async () => {
  // The first batch fails and takes longer than the burst's budget: 30 of 300
  // pools are requested and none answered. The fallback then answers the first
  // 90 unresolved pools, 60 of them never requested.
  const pools = basePools(300);
  const { burst } = await burstOver(pools, {
    dex: (call, n, clock) => {
      clock.advance(10000);
      return { status: 503, body: "busy" };
    },
    gecko: geckoAnswers(base, pools),
    budgetMs: 6000,
    fallbackRequests: 3,
  });
  assert.equal(burst.requestedPools, 30);
  assert.equal(burst.checkedPools, 90);
  assert.equal(burst.answeredPools, 30, "the 30 requested pools, rescued");
  const gate = assessQuality({
    currentPools: 90,
    currentVolumePools: 90,
    plannedPools: 300,
    requestedPools: burst.requestedPools,
    checkedPools: burst.answeredPools,
    snapshotValid: true,
    overviewsValid: true,
    minCurrent: 20,
  });
  assert.equal(gate.checks.answeredShare, 1);
  // 30 of 300 planned pools were requested: the first rule refuses it.
  assert.equal(gate.ok, false);
  assert.match(gate.failures.join(" "), /Only 30 of 300 planned pools/);
});

test("a requested pool a provider failed on and the other answered counts as answered", async () => {
  // DEX Screener fails every third batch (6 of 20): 420 pools answered by it.
  // The fallback answers 90 of the 180 pools it left, all of them requested.
  const pools = basePools(600);
  const failEveryThird = (answers) => {
    let sent = 0;
    return (call) =>
      ++sent % 3 === 0 ? { status: 503, body: "busy" } : answers(call);
  };
  const { burst } = await burstOver(pools, {
    dex: failEveryThird(dexAnswers(pools)),
    gecko: geckoAnswers(base, pools),
    fallbackRequests: 3,
  });
  assert.equal(burst.requestedPools, 600);
  assert.equal(burst.answeredPools, 510, "420 from DEX Screener, 90 rescued");
  assert.equal(burst.checkedPools, 510);
  // Without the fallback the same run stands at 70% and is refused.
  const { burst: bare } = await burstOver(pools, {
    dex: failEveryThird(dexAnswers(pools)),
    gecko: geckoAnswers(base, pools),
    fallbackRequests: 0,
  });
  assert.equal(bare.answeredPools, 420);
  const run = ({ answeredPools, requestedPools }) =>
    assessQuality({
      currentPools: 500,
      currentVolumePools: 500,
      plannedPools: 600,
      requestedPools,
      checkedPools: answeredPools,
      snapshotValid: true,
      overviewsValid: true,
      minCurrent: 20,
    });
  assert.equal(run(burst).ok, true);
  assert.equal(run(bare).ok, false);
  assert.match(
    run(bare).failures.join(" "),
    /Only 420 of 600 requested pools were answered \(70%\)/,
  );
});

test("the gate cannot count more pools answered than requested, whatever the caller passes", () => {
  const ok = {
    currentPools: 900,
    currentVolumePools: 900,
    plannedPools: 1000,
    requestedPools: 1000,
    snapshotValid: true,
    overviewsValid: true,
  };
  const inflated = assessQuality({ ...ok, checkedPools: 1400 });
  assert.equal(inflated.checks.checkedPools, 1000);
  assert.equal(inflated.checks.answeredShare, 1);
  assert.equal(inflated.ok, true);
  // The count is not a way past the rule: 700 answered stays refused.
  assert.equal(assessQuality({ ...ok, checkedPools: 700 }).ok, false);
  // A refusal prints a count that cannot exceed the requested one either.
  const thin = assessQuality({
    ...ok,
    requestedPools: 430,
    plannedPools: 500,
    currentPools: 100,
    currentVolumePools: 100,
    checkedPools: 490,
    minCurrent: 1000,
  });
  assert.equal(thin.ok, false);
  assert.equal(thin.checks.checkedPools, 430);
});

// ---- C2: breadth-first batches, the volume floor, the previous point ---------------

test("the batches go one network at a time in turn, so a time cut thins every network", async () => {
  const pools = [
    ...basePools(150),
    ...ethereumPools(90),
    ...Array.from({ length: 60 }, (_, i) =>
      statePool(7000 + i, { chain: "arbitrum" }),
    ),
  ];
  const clock = new FakeClock(T0);
  const fetchImpl = fakeFetch(clock, (call) => {
    clock.advance(1500);
    return { body: { pairs: null } };
  });
  const client = createHttpClient({
    fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
  });
  const plan = planBurst(pools);
  assert.deepEqual(
    plan.networks.map(({ chain }) => chain.chain),
    ["base", "ethereum", "arbitrum"],
  );
  // Four batches fit in the budget: 0, 1.5, 3 and 4.5 s.
  const burst = await runBurst({
    client,
    plan,
    now: clock.now,
    budgetMs: 6000,
    fallbackRequests: 0,
  });
  const slugs = dexCalls(fetchImpl).map(
    (call) => /pairs\/([a-z]+)\//.exec(call.url)[1],
  );
  assert.deepEqual(slugs, ["base", "ethereum", "arbitrum", "base"]);
  const row = (slug) => burst.networks.find((n) => n.chain === slug);
  assert.deepEqual(
    [
      row("base").requested,
      row("ethereum").requested,
      row("arbitrum").requested,
    ],
    [60, 30, 30],
    "every network was reached; the batches are the same 30 ids as ever",
  );
  // The ids of a batch do not depend on the order the batches go in.
  const byId = (network) =>
    plan.networks
      .find(({ chain }) => chain.chain === network)
      .pools.map((p) => p.id);
  assert.deepEqual(idsOf(dexCalls(fetchImpl)[0]), byId("base").slice(0, 30));
  assert.deepEqual(idsOf(dexCalls(fetchImpl)[3]), byId("base").slice(30, 60));
});

test("a network whose batches keep failing is left after five, while the others are served", async () => {
  const pools = [...basePools(300), ...ethereumPools(200)];
  const clock = new FakeClock(T0);
  const fetchImpl = fakeFetch(clock, (call) => {
    const hit = /pairs\/([a-z]+)\/(.+)$/.exec(call.url);
    if (hit[1] === "ethereum") return { status: 500, body: "broken" };
    const wanted = new Set(hit[2].split(","));
    return {
      body: {
        pairs: pools.filter((p) => wanted.has(p.id)).map((p) => dexRow(p)),
      },
    };
  });
  const client = createHttpClient({
    fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
  });
  const burst = await runBurst({
    client,
    plan: planBurst(pools),
    now: clock.now,
    fallbackRequests: 0,
  });
  const ethereumCalls = dexCalls(fetchImpl).filter((call) =>
    call.url.includes("/ethereum/"),
  );
  assert.equal(ethereumCalls.length, config.MAX_CONSECUTIVE_FAILURES);
  assert.equal(client.isStopped("dexscreener"), false, "base kept answering");
  const row = (slug) => burst.networks.find((n) => n.chain === slug);
  assert.equal(row("base").checked, 300, "every Base batch was sent");
  assert.equal(row("ethereum").failedBatches, config.MAX_CONSECUTIVE_FAILURES);
  assert.equal(row("ethereum").requested, 150);
});

test("the floor counts the pools that carry a current 24h volume, not every current pool", async () => {
  // 60 pools answer with a liquidity figure and no volume but one.
  const pools = basePools(60);
  const { result } = await collect({
    pools,
    row: (pool) =>
      dexRow(pool, {
        volume: pool === pools[0] ? { h1: 1, h6: 2, h24: 3 } : undefined,
      }),
  });
  assert.equal(result.quality.checks.currentPools, 60);
  assert.equal(result.quality.checks.currentVolumePools, 1);
  assert.equal(result.ok, false);
  assert.match(
    result.quality.failures.join(" "),
    /Only 1 pools carry a current 24h volume; at least 20 are required\./,
  );
  assert.equal(
    assessQuality({
      currentPools: 500,
      currentVolumePools: 499,
      plannedPools: 10,
      requestedPools: 10,
      checkedPools: 10,
      snapshotValid: true,
      overviewsValid: true,
    }).ok,
    false,
  );
  assert.equal(
    assessQuality({
      currentPools: 500,
      currentVolumePools: 500,
      plannedPools: 10,
      requestedPools: 10,
      checkedPools: 10,
      snapshotValid: true,
      overviewsValid: true,
    }).ok,
    true,
    "a measured zero is a volume, so it is counted by the proof it comes from",
  );
});

test("a run whose volume pools fell below 60% of the previous point's is refused, with both numbers in the reason", async () => {
  const pools = basePools(60);
  const previous = {
    timestamp: T0 - 3 * 3600 * 1000,
    value: 1234567.89,
    pools: 200,
  };
  const { result, dir } = await collect({ pools, history: [previous] });
  assert.equal(result.ok, false);
  const text = result.quality.failures.join(" ");
  assert.match(
    text,
    /Only 60 pools carry a current 24h volume, 30% of the 200 behind the previous snapshot/,
  );
  assert.match(text, /at least 60% are required/);
  assert.equal(result.quality.checks.previousPools, 200);
  assert.equal(result.published, false);
  assert.equal(existsSync(join(dir, "data")), false);
  // Enough pools: published, and the point is appended after the previous one.
  const enough = await collect({
    pools,
    history: [{ ...previous, pools: 100 }],
  });
  assert.equal(
    enough.result.ok,
    true,
    enough.result.quality.failures.join("; "),
  );
  assert.equal(enough.result.historyPoints.length, 2);
});

test("the previous point is only compared when it is recent and well formed", () => {
  const run = (previousPoint, generatedAtMs = T0) =>
    assessQuality({
      currentPools: 600,
      currentVolumePools: 600,
      plannedPools: 10,
      requestedPools: 10,
      checkedPools: 10,
      snapshotValid: true,
      overviewsValid: true,
      previousPoint,
      generatedAtMs,
    });
  const recent = (pools) => ({ timestamp: T0 - 6 * 3600000, value: 1, pools });
  assert.equal(run(recent(1000)).ok, true, "600 is exactly 60%");
  assert.equal(run(recent(1001)).ok, false);
  assert.match(
    run(recent(1001)).failures.join(" "),
    /Only 600 pools carry a current 24h volume, 60% of the 1001 behind the previous/,
  );
  assert.equal(run(null).ok, true, "no previous point");
  assert.equal(run(recent(0)).ok, true, "pools is not positive");
  assert.equal(run(recent(-5)).ok, true);
  assert.equal(run(recent(Number.NaN)).ok, true);
  assert.equal(run(recent("1000")).ok, true, "pools is not a number");
  assert.equal(
    run({ timestamp: T0 - 24 * 3600000, value: 1, pools: 5000 }).ok,
    false,
  );
  assert.equal(
    run({ timestamp: T0 - 24 * 3600000 - 1, value: 1, pools: 5000 }).ok,
    true,
    "a point more than a day old is not compared, so a smaller sample cannot lock the site out",
  );
  assert.equal(run(recent(5000), null).ok, true, "no clock, no comparison");
  assert.equal(run(recent(5000), Number.NaN).ok, true);
});

// ---- C3: the cause is named -------------------------------------------------------

test("a refusal caused by an unindexed network names it", async () => {
  // The big network is not indexed: 100 of 160 pools are never requested.
  const pools = [...ethereumPools(100), ...basePools(60)];
  const { result } = await collect({
    pools,
    dex: (call, n, slug) =>
      slug === "ethereum" ? { status: 400, body: "bad request" } : null,
  });
  assert.equal(result.ok, false);
  assert.match(
    result.quality.failures.join(" "),
    /Only 90 of 160 planned pools were requested \(56%\); at least 80% are required\. Networks DEX Screener answered HTTP 400 for: ethereum\./,
  );
});

test("a refused run prints what explains it, since it writes no status.json", async () => {
  const out = [];
  const { log, error } = console;
  console.log = (...parts) => out.push(parts.join(" "));
  console.error = (...parts) => out.push(parts.join(" "));
  let code;
  try {
    // The recording is small: the gate refuses it at 5,000 current pools.
    code = await main(["--offline", "--no-publish", "--min-current", "5000"]);
  } finally {
    console.log = log;
    console.error = error;
  }
  assert.equal(code, 1);
  const text = out.join("\n");
  assert.match(text, /^REFUSED · /m);
  assert.match(text, /planned pools requested, \d+ answered/);
  assert.match(text, /requests \{"total":\d+/);
  assert.match(text, /DEX Screener answered HTTP 400 for \[\]/);
  assert.match(text, /rate-limit waits \{\}/);
});

// ---- C4: a hollow registry answer does not replace the saved copy ------------------

const registryFixture = (rows, tail = []) => [
  ...Array.from({ length: rows }, (_, i) =>
    hookRow(address(20000 + i), "base", 8453, `Hook ${i}`),
  ),
  ...tail,
];
const frontierChain = (id, hook) => ({
  id,
  contracts: { univ4: { hook } },
});

async function registryRun({ saved, live }) {
  const clock = new FakeClock(T0);
  const fetchImpl = fakeFetch(clock, (call) => {
    if (call.url === REGISTRY_URL) return { body: live.registry };
    if (call.url === CHAINS_URL) return { body: live.chains };
    return { body: live.frontier };
  });
  const client = createHttpClient({
    fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
  });
  return loadRegistry({ client, saved });
}

const savedCopy = () => {
  const at = "2026-10-27T00:00:00.000Z";
  return {
    schemaVersion: 1,
    sources: {
      registry: {
        url: REGISTRY_URL,
        fetchedAt: at,
        data: slimHooklist(registryFixture(20)),
      },
      chains: { url: CHAINS_URL, fetchedAt: at, data: CHAIN_DATA },
      frontier: {
        url: FRONTIER_URL,
        fetchedAt: at,
        data: [
          frontierChain(8453, address(30001)),
          frontierChain(1, address(30002)),
          frontierChain(10, address(30003)),
        ],
      },
    },
  };
};
const noteOf = (loaded, id) => loaded.sources.find((s) => s.id === id);

test("Frontier answering an empty list keeps the saved copy, which stays in the state", async () => {
  const saved = savedCopy();
  const loaded = await registryRun({
    saved,
    live: { registry: registryFixture(20), chains: CHAIN_DATA, frontier: [] },
  });
  assert.equal(loaded.data.frontier.length, 3, "the saved rows are used");
  assert.equal(noteOf(loaded, "frontier-chains").status, "cached");
  assert.equal(
    noteOf(loaded, "frontier-chains").updatedAt,
    saved.sources.frontier.fetchedAt,
  );
  assert.match(
    noteOf(loaded, "frontier-chains").note,
    /answer had too few rows: 0 against 3 in the saved copy/,
  );
  assert.deepEqual(loaded.fetched.frontier, saved.sources.frontier);
  assert.equal(
    loaded.changed,
    false,
    "nothing to rewrite in state/registry.json",
  );
});

test("a registry answer of fewer than half the saved rows is not used; half or more is", async () => {
  const saved = savedCopy();
  const tiny = await registryRun({
    saved,
    live: {
      registry: registryFixture(9),
      chains: CHAIN_DATA,
      frontier: saved.sources.frontier.data,
    },
  });
  assert.equal(noteOf(tiny, "registry").status, "cached");
  assert.equal(tiny.data.registry.length, 20);
  assert.deepEqual(tiny.fetched.registry, saved.sources.registry);
  const half = await registryRun({
    saved,
    live: {
      registry: registryFixture(10),
      chains: CHAIN_DATA,
      frontier: saved.sources.frontier.data.slice(0, 2),
    },
  });
  assert.equal(noteOf(half, "registry").status, "live");
  assert.equal(half.data.registry.length, 10);
  assert.equal(noteOf(half, "frontier-chains").status, "live");
  assert.equal(half.changed, true);
  // A chain registry cut to a handful is judged the same way.
  const wide = savedCopy();
  wide.sources.chains.data = Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [`chain-${i}`, { chainId: 100 + i }]),
  );
  const fewChains = await registryRun({
    saved: wide,
    live: { registry: registryFixture(20), chains: CHAIN_DATA, frontier: [] },
  });
  assert.equal(noteOf(fewChains, "chains").status, "cached");
  assert.equal(Object.keys(fewChains.data.chains).length, 12);
});

test("with no saved copy the answer is used however small, and an empty Frontier list over an empty copy is live", async () => {
  const first = await registryRun({
    saved: null,
    live: { registry: registryFixture(2), chains: CHAIN_DATA, frontier: [] },
  });
  assert.equal(noteOf(first, "registry").status, "live");
  assert.equal(noteOf(first, "frontier-chains").status, "live");
  const emptyCopy = savedCopy();
  emptyCopy.sources.frontier.data = [];
  const again = await registryRun({
    saved: emptyCopy,
    live: { registry: registryFixture(20), chains: CHAIN_DATA, frontier: [] },
  });
  assert.equal(noteOf(again, "frontier-chains").status, "live");
});

// ---- C5: discovery has a time limit ------------------------------------------------

const slowIndexer = (clock) =>
  fakeFetch(clock, (call) => {
    if (call.url.startsWith("https://www.v4.xyz/api/pools?"))
      return { body: { Pool: [] }, headers: { "retry-after": "110" } };
    if (call.url.startsWith("https://api.geckoterminal.com"))
      return { body: { data: [] } };
    return { body: { Pool: [] } };
  });

test("an indexer that answers every list with Retry-After: 110 cannot stretch discovery past its limit", async () => {
  const clock = new FakeClock(T0);
  const fetchImpl = slowIndexer(clock);
  const client = createHttpClient({
    fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
  });
  const chains = discoveryChains();
  assert.equal(chains.length, 20);
  const found = await discoverPools({
    client,
    known: new Set(),
    hookless: new Set(),
    page: 1,
    now: clock.now,
    notAfter: T0 + config.DISCOVERY_BUDGET_MS,
    chains,
    geckoChains: [],
  });
  const lists = fetchImpl.calls.filter((call) =>
    call.url.includes("/api/pools?"),
  );
  // Starts at 0, 110, ... 880 s; the one at 990 s is too late.
  assert.equal(lists.length, 9);
  assert.ok(lists.every((call) => call.at - T0 <= config.DISCOVERY_BUDGET_MS));
  assert.ok(clock.now() - T0 <= config.DISCOVERY_BUDGET_MS + 20000);
  assert.equal(found.stats.cutShort, true);
  assert.equal(found.stats.indexerLists, 9);
  assert.equal(
    found.stats.indexerListFailures,
    0,
    "not a failure of the indexer",
  );
  assert.equal(found.stats.resolvesTried, 0);
  // Without the limit the same indexer takes 20 x 110 s.
  const slow = new FakeClock(T0);
  const unlimited = await discoverPools({
    client: createHttpClient({
      fetchImpl: slowIndexer(slow),
      now: slow.now,
      sleep: slow.sleep,
    }),
    known: new Set(),
    hookless: new Set(),
    page: 1,
    now: slow.now,
    chains,
    geckoChains: [],
  });
  assert.equal(unlimited.stats.indexerLists, 20);
  assert.ok(slow.now() - T0 >= 19 * 110000);
  assert.equal(unlimited.stats.cutShort, false);
});

test("a run gives discovery its own limit and says when it ended early", async () => {
  const { result, clock } = await collect({
    pools: basePools(600),
    other: () => ({ body: { Pool: [] }, headers: { "retry-after": "110" } }),
    run: { maxDiscovery: Infinity },
  });
  assert.equal(result.ok, true, result.quality.failures.join("; "));
  const { counts } = result.status;
  assert.equal(counts.discovery.cutShort, true);
  assert.ok(
    counts.requests.v4xyz <= 10,
    `${counts.requests.v4xyz} indexer requests`,
  );
  // Discovery would have taken 35 minutes at 110 s a list (the run without a
  // limit, below), and the job is stopped at 45.
  assert.ok(clock.now() - T0 < 25 * 60 * 1000);
  // The same run without the limit: the figure COLLECTOR-NOTES.md gives.
  const open = await collect({
    pools: basePools(600),
    other: () => ({ body: { Pool: [] }, headers: { "retry-after": "110" } }),
    run: { maxDiscovery: Infinity, discoveryBudgetMs: Infinity },
  });
  assert.equal(open.result.status.counts.discovery.cutShort, false);
  assert.equal(Math.round((open.clock.now() - T0) / 1000), 2099);
});

// ---- R-5: sums are recorded to the cent -------------------------------------------

test("a recorded sum is rounded to the cent; nothing else is", () => {
  assert.equal(roundCents(339226102.0600004), 339226102.06);
  assert.equal(roundCents(44372005.32000001), 44372005.32);
  assert.equal(roundCents(325350329.9184996), 325350329.92);
  assert.equal(roundCents(0.1 + 0.2), 0.3);
  assert.equal(roundCents(0), 0);
  assert.equal(roundCents(1234.5), 1234.5);
  assert.equal(roundCents(null), null);
  assert.equal(roundCents(undefined), undefined);
  assert.ok(Number.isNaN(roundCents(Number.NaN)));
  assert.equal(roundCents(Infinity), Infinity);
  // A figure above zero never becomes a measured zero.
  assert.equal(roundCents(0.004), 0.004);
  assert.equal(roundCents(roundCents(339226102.0600004)), 339226102.06);
  const point = historyPointFor({
    volumeUsd: { h24: 339226102.0600004 },
    freshness: {
      volume: {
        h24: { currentPools: 2209, oldestAt: "2026-10-28T15:59:33.000Z" },
      },
    },
  });
  assert.equal(point.value, 339226102.06);
  assert.equal(point.pools, 2209);
});

test("the summary and the history point carry the same rounded sum, the pools keep their own figures, and the overview stays exact", async () => {
  // Two pools of 0.1 and 0.2: their float sum is 0.30000000000000004 in either
  // order.
  const pools = basePools(2);
  const figure = (pool) => (pool === pools[0] ? 0.1 : 0.2);
  const { result } = await collect({
    pools,
    row: (pool) =>
      dexRow(pool, {
        volume: { h1: figure(pool), h6: figure(pool), h24: figure(pool) },
        liquidity: { usd: figure(pool) },
      }),
    run: { minCurrent: 2 },
  });
  assert.equal(result.ok, true, result.quality.failures.join("; "));
  const { snapshot } = result;
  const exact = snapshot.pools.reduce(
    (sum, pool) => sum + pool.volumeUsd.h24,
    0,
  );
  assert.equal(
    exact,
    0.30000000000000004,
    "the unrounded sum has float residue",
  );
  assert.equal(snapshot.summary.volumeUsd.h24, 0.3);
  assert.equal(snapshot.summary.volumeUsd.h1, 0.3);
  assert.equal(snapshot.summary.volumeUsd.h6, 0.3);
  assert.equal(snapshot.summary.liquidityUsd, 0.3);
  const point = result.historyPoints.at(-1);
  assert.equal(point.value, snapshot.summary.volumeUsd.h24);
  assert.equal(snapshot.history.at(-1).value, snapshot.summary.volumeUsd.h24);
  // A pool's own figures are what the provider gave.
  assert.deepEqual(
    snapshot.pools.map((pool) => pool.volumeUsd.h24).sort(),
    [0.1, 0.2],
  );
  assert.deepEqual(
    snapshot.pools.map((pool) => pool.liquidityUsd).sort(),
    [0.1, 0.2],
  );
  // The overview is derived by its own validator from the per-pool rows, to the
  // last digit: a total rounded by hand is refused, which is why only the
  // summary and the history are rounded.
  const file = result.overviews.find((f) => f.name === "overview-all-h24.json");
  const envelope = JSON.parse(file.text);
  const query = { chain: "all", window: "h24" };
  assert.equal(isAnalyticsOverviewEnvelope(envelope, query), true);
  assert.equal(envelope.totals.volumeUsd, exact);
  const rounded = structuredClone(envelope);
  rounded.totals.volumeUsd = roundCents(rounded.totals.volumeUsd);
  assert.equal(isAnalyticsOverviewEnvelope(rounded, query), false);
});

// ---- WF-4: a start through a link or a junction is a start ------------------------

test("startedDirectly compares real paths and refuses a different file", () => {
  const run = join(ROOT, "collector", "run.mjs");
  const url = new URL("../collector/run.mjs", import.meta.url).href;
  assert.equal(startedDirectly(url, run), true);
  assert.equal(
    startedDirectly(url, join(ROOT, "collector", "history.mjs")),
    false,
  );
  assert.equal(startedDirectly(url, undefined), false);
  assert.equal(startedDirectly(url, ""), false);
  // join() would tidy the ".." away, so the path is written out.
  assert.equal(
    startedDirectly(
      url,
      `${join(ROOT, "collector")}${sep}..${sep}collector${sep}run.mjs`,
    ),
    true,
  );
  // A path that does not exist is compared as written, and is not this file.
  assert.equal(
    startedDirectly(url, join(ROOT, "no", "such", "run.mjs")),
    false,
  );
});

test("the collector started through a directory junction or symbolic link runs, and prints what it found", async (t) => {
  const dir = await directory();
  const link = join(dir, "linked-collector");
  try {
    symlinkSync(join(ROOT, "collector"), link, "junction");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS", "UNKNOWN"].includes(error?.code))
      return t.skip("links cannot be made here");
    throw error;
  }
  const direct = spawnSync(
    process.execPath,
    [join(ROOT, "collector", "run.mjs"), "--offline", "--no-publish"],
    { cwd: ROOT, encoding: "utf8" },
  );
  const linked = spawnSync(
    process.execPath,
    [join(link, "run.mjs"), "--offline", "--no-publish"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(direct.status, 0, direct.stderr);
  assert.match(direct.stdout, /^PASS · /);
  assert.equal(linked.status, 0, linked.stderr);
  assert.match(linked.stdout, /^PASS · /, "it must not exit 0 in silence");
  assert.equal(
    linked.stdout.replace(/generatedAt.*$/m, ""),
    direct.stdout.replace(/generatedAt.*$/m, ""),
  );
});

// ---- D11 / WF-7 / D13 / D14: what the notes say ------------------------------------

const text = (...parts) =>
  readFileSync(join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");
// The notes are docs/edition/ in the source repository and docs/ in the folder
// the assembler makes; the same words are checked in either.
const doc = (name) =>
  text(
    ...(existsSync(join(ROOT, "docs", "edition", name))
      ? ["docs", "edition", name]
      : ["docs", name]),
  );

test("the collector's notes name no file that the edition folder does not hold", () => {
  const notes = doc("COLLECTOR-NOTES.md");
  const how = doc("HOW-IT-WORKS.md");
  for (const [name, body] of [
    ["COLLECTOR-NOTES.md", notes],
    ["HOW-IT-WORKS.md", how],
    [
      "config.mjs",
      text("collector", "config.mjs").split("\n").slice(0, 4).join("\n"),
    ],
    ["http.mjs", text("collector", "http.mjs")],
  ])
    for (const missing of [
      "STATIC-EDITION-DESIGN",
      "server/store.mjs",
      "server/market-enricher.mjs",
      "work/offline-data",
    ])
      assert.equal(body.includes(missing), false, `${name} names ${missing}`);
  const contract = text("tests", "collector-contract.test.mjs");
  assert.equal(contract.includes("docs/STATIC-EDITION-DESIGN.md"), false);
});

test("the notes describe the gate, the size and the real runs as they are", () => {
  // Line breaks in the notes are not part of what they say.
  const notes = doc("COLLECTOR-NOTES.md").replace(/\s+/g, " ");
  const how = doc("HOW-IT-WORKS.md").replace(/\s+/g, " ");
  assert.match(notes, /about 10 MB \(about 1 MB gzipped\)/);
  assert.equal(notes.includes("about 21 MB (1.9 MB gzipped)"), false);
  assert.equal(notes.includes("A real run was not made in this task"), false);
  assert.match(notes, /no run has yet been made from GitHub-hosted runner/i);
  assert.match(notes, /were answered/);
  assert.equal(
    how.includes(
      "Every measurement in a snapshot is therefore within five minutes",
    ),
    false,
  );
  assert.match(how, /at least 90% of those priced/);
  assert.match(how, /a green run can still have had one provider stop/i);
  assert.match(how, /if no run is skipped/i);
  assert.equal(how.includes("npm run collect"), false);
  assert.match(how, /npm run build:static/);
  assert.match(notes, /npm run collect/);
  // The claims the review found untrue.
  assert.equal(how.includes("The run log and the"), false);
  assert.ok(
    how.includes(
      "`data/status.json` says which providers answered and which did not",
    ),
  );
  // The dialog that used to list them is switched off at the owner's choice,
  // and the document says so rather than pointing to it.
  assert.equal(
    how.includes(
      "The Data & sources dialog and `data/status.json` say which providers answered",
    ),
    false,
  );
  assert.match(how, /switched off at the owner's choice/);
  assert.match(how, /or fewer than 80% of the requested pools answered/);
  assert.equal(
    how.includes(
      "fails a run only when it leaves fewer than 80% of the planned pools requested",
    ),
    false,
  );
  assert.match(notes, /2,099 s, 35 minutes/);
  assert.equal(notes.includes("2,321"), false);
  assert.match(notes, /Minimum number of pools with a current 24h volume/);
  assert.equal(notes.includes("Minimum current pools"), false);
  assert.match(notes, /`counts.answeredPools`/);
  assert.match(
    text("collector", "run.mjs"),
    /minimum pools with a current 24h volume for the quality gate/,
  );
});

test("HOW-IT-WORKS states the live app's network-wide history as the rule it is, not as an absence", () => {
  // The live server appends a network-wide point whenever every pool behind the
  // total is current, so "no network-wide history" is only what the data showed
  // on the days it was looked at. The notes state the rule; the table must too.
  const row = doc("HOW-IT-WORKS.md")
    .split("\n")
    .find((line) => /^\|\s*Per-project history/.test(line));
  assert.ok(row, "the history row is in the table of differences");
  const [live, edition] = row
    .split("|")
    .slice(1, 3)
    .map((cell) => cell.trim().replace(/\s+/g, " "));
  assert.equal(/no network-wide history/i.test(live), false, live);
  assert.match(live, /^Per-project history recorded by the server;/);
  assert.match(
    live,
    /a network-wide point only when every pool behind it is current/,
  );
  assert.match(edition, /^One network-wide point per successful run/);
  assert.match(edition, /no per-project history/);
  // COLLECTOR-NOTES gives the same rule.
  assert.match(
    doc("COLLECTOR-NOTES.md").replace(/\s+/g, " "),
    /The live app records a point only when every pool contributing to the total is current/,
  );
});

test("the numbers added for the gate are pinned", () => {
  assert.equal(config.DISCOVERY_BUDGET_MS, 900000);
  assert.equal(config.MIN_VOLUME_POOLS_OF_PREVIOUS, 0.6);
  assert.equal(config.PREVIOUS_POINT_MAX_AGE_MS, 86400000);
  // Discovery, the burst that follows and the wait for the last request still
  // end well inside the job's 45 minutes.
  assert.ok(
    config.DISCOVERY_BUDGET_MS +
      config.BURST_DEADLINE_MS +
      config.REQUEST_TIMEOUT_MS <
      30 * 60 * 1000,
  );
  // And it is longer than the full-size discovery of the real run (10 minutes).
  assert.ok(config.DISCOVERY_BUDGET_MS >= 12 * 60 * 1000);
});
