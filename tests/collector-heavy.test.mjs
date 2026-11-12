import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAINS_URL, FRONTIER_URL, REGISTRY_URL } from "../server/model.mjs";
import { METRIC_CHAINS } from "../server/market-chains.mjs";
import { isSnapshot } from "../src/model.ts";
import { dayNumber } from "../shared/daily-volume.ts";
import { DS_NETWORKS } from "../collector/providers/dexscreener.mjs";
import { planNotices, runCollector } from "../collector/run.mjs";
import { historyJson, poolsJson, readState } from "../collector/state.mjs";
import {
  address,
  blockNetwork,
  dexRow,
  FakeClock,
  fakeFetch,
  statePool,
} from "../collector/testing.mjs";

blockNetwork();

// The heaviest run the hourly job makes, end to end: the lane plan (the state has a
// saved time and a history point, so it applies, unlike the state of
// collector-fullsize, which has none and takes the full plan), discovery on all 20
// networks, DEX Screener batches that fail and are asked again, the tiered
// GeckoTerminal fallback and the 7D and 30D step, on fake providers and a fake
// clock. Each of those has tests of its own with discovery switched off; this file
// is the only place that runs them together, where they share one budget of 399
// requests and one burst of five minutes. Nothing is published and no provider is
// contacted.
//
// The state is shaped like the real one of 12 November 2026: 8,000 pools on the
// seed's 14 networks, 5,950 that answered recently (HOT), 300 new, 300 in WARM,
// 1,000 in COOL, the rest in COLD, and 45 pools only GeckoTerminal prices
// (Robinhood, X Layer, Zora), saved 70 minutes before the run.

const SEED_MIX = {
  robinhood: 4355,
  base: 2283,
  ethereum: 1015,
  arc: 213,
  ink: 49,
  bnb: 22,
  optimism: 16,
  polygon: 11,
  unichain: 11,
  arbitrum: 8,
  avalanche: 6,
  monad: 5,
  xlayer: 5,
  soneium: 1,
};
const HOUR = 3600e3;
const DAY = 24 * HOUR;
const START = Date.parse("2026-11-12T12:07:00.000Z");
const SAVED = START - 70 * 60e3;
const iso = (ms) => new Date(ms).toISOString();
const chainOf = new Map(METRIC_CHAINS.map((chain) => [chain.chain, chain]));
const geckoOf = new Map(METRIC_CHAINS.map((chain) => [chain.gecko, chain]));
const byChainId = new Map(METRIC_CHAINS.map((chain) => [chain.chainId, chain]));
const dsToChain = new Map(
  Object.entries(DS_NETWORKS).map(([slug, ds]) => [ds, slug]),
);
const FIXED_NAME = "AAA / BBB - 0.3%";

function buildWorld() {
  const pools = [];
  let seed = 1;
  for (const [chain, count] of Object.entries(SEED_MIX))
    for (let i = 0; i < count; i++, seed++)
      pools.push(
        statePool(seed, {
          chain,
          hookAddress: address(20000 + (seed % 300)).toLowerCase(),
          tokens: [address(100000 + seed * 2), address(100001 + seed * 2)],
        }),
      );
  // HOT: answered in the last 20 hours; NEW: first seen 10 hours ago by discovery;
  // WARM: last answered 4 days ago; COOL: 10 days ago; COLD: never answered.
  pools.forEach((pool, i) => {
    if (i < 5950) {
      pool.firstSeen = iso(SAVED - 30 * DAY);
      pool.lastSeen = iso(SAVED - (i % 20) * HOUR);
    } else if (i < 6250) {
      pool.firstSeen = iso(SAVED - 10 * HOUR);
      pool.lastSeen = pool.firstSeen;
      pool.source = "v4.xyz";
    } else if (i < 6550) {
      pool.firstSeen = iso(SAVED - 30 * DAY);
      pool.lastSeen = iso(SAVED - 4 * DAY);
    } else if (i < 7550) {
      pool.firstSeen = iso(SAVED - 40 * DAY);
      pool.lastSeen = iso(SAVED - 10 * DAY);
    } else {
      pool.firstSeen = iso(SAVED - 40 * DAY);
      pool.lastSeen = pool.firstSeen;
    }
  });
  // The real state has HOT pools outside Robinhood and Base: 199 on Ethereum and 87 on
  // Arc (12 November). Swap their lanes with HOT Robinhood pools, so the totals of
  // the lanes stay as they were and a network of that size can go down.
  const swap = (chain, count, from) => {
    const mine = pools.filter((pool) => pool.chain === chain).slice(0, count);
    const theirs = pools
      .filter((pool) => pool.chain === "robinhood")
      .slice(from, from + count);
    mine.forEach((pool, i) => {
      for (const field of ["firstSeen", "lastSeen"])
        [pool[field], theirs[i][field]] = [theirs[i][field], pool[field]];
    });
  };
  swap("ethereum", 199, 4156);
  swap("arc", 87, 4069);
  // Pools DEX Screener has no row for and GeckoTerminal priced last time.
  const gtOnly = [];
  for (const [chain, count] of [
    ["robinhood", 30],
    ["xlayer", 7],
    ["zora", 8],
  ])
    for (let i = 0; i < count; i++) {
      const pool = statePool(900000 + gtOnly.length, {
        chain,
        hookAddress: address(30000).toLowerCase(),
        tokens: [
          address(800000 + gtOnly.length * 2),
          address(800001 + gtOnly.length * 2),
        ],
        via: "geckoterminal",
        firstSeen: iso(SAVED - 30 * DAY),
        lastSeen: iso(SAVED - 2 * HOUR),
      });
      gtOnly.push(pool);
      pools.push(pool);
    }
  const everything = new Map(pools.map((p) => [`${p.chain}:${p.id}`, p]));
  // What the indexer and GeckoTerminal tell discovery, per network: 30 listed
  // pools (the indexer) and 20 candidates (GeckoTerminal's top-pools page).
  const listed = new Map();
  const candidates = new Map();
  METRIC_CHAINS.forEach((chain, c) => {
    const rows = [];
    for (let k = 0; k < 30; k++) {
      const pool = statePool(200000 + c * 100 + k, {
        chain: chain.chain,
        hookAddress: address(40000 + c * 10 + (k % 10)).toLowerCase(),
        tokens: [address(300000 + c * 100 + k), address(400000 + c * 100 + k)],
        source: "v4.xyz",
      });
      pool.fakeName = FIXED_NAME;
      rows.push(pool);
      everything.set(`${pool.chain}:${pool.id}`, pool);
    }
    listed.set(chain.chainId, rows);
    const page = [];
    for (let k = 0; k < 20; k++) {
      const pool = statePool(500000 + c * 100 + k, {
        chain: chain.chain,
        hookAddress: address(50000 + c).toLowerCase(),
        tokens: [address(600000 + c * 100 + k), address(700000 + c * 100 + k)],
        source: "v4.xyz",
      });
      pool.fakeName = FIXED_NAME;
      page.push(pool);
      everything.set(`${pool.chain}:${pool.id}`, pool);
    }
    candidates.set(chain.gecko, page);
  });
  const volume = new Map(pools.map((pool, i) => [pool.id, 900000 - i * 90]));
  return {
    pools,
    gtOnlyIds: new Set(gtOnly.map((pool) => pool.id)),
    everything,
    listed,
    candidates,
    volume,
  };
}

const indexerRow = (chain, pool) => ({
  id: `${chain.chainId}_${pool.id}`,
  chainId: String(chain.chainId),
  hooks: pool.hookAddress,
  token0: `${chain.chainId}_${pool.tokens[0]}`,
  token1: `${chain.chainId}_${pool.tokens[1]}`,
  name: pool.fakeName,
  totalValueLockedUSD: "100",
});

const geckoRow = (pool) => {
  const chain = chainOf.get(pool.chain);
  return {
    id: `${chain.gecko}_${pool.id}`,
    type: "pool",
    attributes: {
      address: pool.id,
      name: "AAA / BBB 0.3%",
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
  };
};

// A pool whose id says "dark" has no DEX Screener row at all (a measured absence).
const isDark = (pool, world) =>
  pool.source === "census" &&
  !pool.via &&
  Number(BigInt(pool.id) % 41n) === 0 &&
  !world.gtOnlyIds.has(pool.id);

/**
 * The providers. `dsLatency` is how long a DEX Screener answer takes on the fake
 * clock (the real job's pace was 0.76 s a batch on 31 October); `dsFail` is the
 * share of distinct DEX Screener batches (by their address) that answer HTTP 503
 * the first time and well the second; `dsDown` lists networks whose batches always do; `gecko` is how GeckoTerminal behaves: "ok",
 * a first answer of HTTP 429 with no wait named ("stopped") or one that says to wait 90
 * seconds ("cooldown90").
 */
function providers(world, { dsLatency, dsFail, dsDown, gecko }) {
  const failedOnce = new Set();
  let geckoCalls = 0;
  return (call, clock) => {
    const { url } = call;
    const host = new URL(url).hostname;
    clock.advance(
      host === "api.dexscreener.com"
        ? dsLatency
        : host === "api.geckoterminal.com"
          ? 800
          : 500,
    );
    if (url === REGISTRY_URL)
      return {
        body: [
          {
            hook: {
              address: address(9001),
              chain: "base",
              chainId: 8453,
              name: "ListedHook",
              description: "A hook in the hooklist.",
              verifiedSource: true,
            },
            properties: { dynamicFee: false },
          },
        ],
      };
    if (url === CHAINS_URL)
      return { body: { ethereum: { chainId: 1 }, base: { chainId: 8453 } } };
    if (url === FRONTIER_URL) return { body: [] };
    let match =
      /^https:\/\/api\.dexscreener\.com\/latest\/dex\/pairs\/([a-z]+)\/(.+)$/.exec(
        url,
      );
    if (match) {
      // A network DEX Screener answers nothing but HTTP 503 for, the whole run.
      if (dsDown.includes(dsToChain.get(match[1]))) return { status: 503, body: {} };
      const hash = [...url].reduce(
        (sum, ch) => (sum * 31 + ch.charCodeAt(0)) >>> 0,
        7,
      );
      if (hash % 100 < dsFail && !failedOnce.has(url)) {
        failedOnce.add(url);
        return { status: 503, body: {} };
      }
      const chain = dsToChain.get(match[1]);
      const rows = match[2]
        .split(",")
        .map((id) => world.everything.get(`${chain}:${id}`))
        .filter((pool) => pool && !isDark(pool, world) && !world.gtOnlyIds.has(pool.id))
        .map((pool, i) =>
          dexRow(pool, {
            volume: { h1: 10, h6: 60, h24: world.volume.get(pool.id) ?? 1000 + i },
            liquidity: { usd: 5000 + i },
          }),
        );
      return { body: { pairs: rows.length ? rows : null } };
    }
    if (host === "api.geckoterminal.com") {
      geckoCalls++;
      if (gecko === "stopped" && geckoCalls === 1)
        return { status: 429, body: {}, headers: {} };
      if (gecko === "cooldown90" && geckoCalls === 1)
        return { status: 429, body: {}, headers: { "retry-after": "90" } };
    }
    match =
      /^https:\/\/api\.geckoterminal\.com\/api\/v2\/networks\/([a-z0-9_-]+)\/dexes\//.exec(
        url,
      );
    if (match) {
      const chain = geckoOf.get(match[1]);
      return {
        body: {
          data: (world.candidates.get(match[1]) ?? []).map((pool) => ({
            id: `${chain.gecko}_${pool.id}`,
            type: "pool",
            attributes: { address: pool.id, name: "A / B" },
            relationships: { dex: { data: { id: chain.dex } } },
          })),
        },
      };
    }
    match = /\/networks\/([a-z0-9_-]+)\/pools\/multi\/([^?]+)/.exec(url);
    if (match) {
      const chain = geckoOf.get(match[1]);
      return {
        body: {
          data: match[2]
            .split(",")
            .map((id) => world.everything.get(`${chain.chain}:${id}`))
            .filter((pool) => pool && world.gtOnlyIds.has(pool.id))
            .map(geckoRow),
        },
      };
    }
    if (/\/ohlcv\/day\?/.test(url))
      return {
        body: {
          data: {
            id: "x",
            type: "ohlcv_request_response",
            attributes: {
              ohlcv_list: Array.from({ length: 33 }, (_, k) => [
                (dayNumber(clock.now()) - k) * 86400,
                1,
                1,
                1,
                1,
                100,
              ]),
            },
          },
        },
      };
    match = /^https:\/\/www\.v4\.xyz\/api\/pools\?chainId=(\d+)$/.exec(url);
    if (match) {
      const chain = byChainId.get(Number(match[1]));
      return {
        body: {
          Pool: (world.listed.get(chain.chainId) ?? []).map((pool) =>
            indexerRow(chain, pool),
          ),
        },
      };
    }
    match = /^https:\/\/www\.v4\.xyz\/api\/pool\/(\d+)_(0x[0-9a-f]{64})$/.exec(
      url,
    );
    if (match) {
      const chain = byChainId.get(Number(match[1]));
      const pool = world.everything.get(`${chain.chain}:${match[2]}`);
      return { body: { Pool: [indexerRow(chain, pool)] } };
    }
    return { status: 404, body: {} };
  };
}

/** One heavy run on a state that applies the lane plan. */
async function heavyRun(
  t,
  {
    dsLatency = 350,
    dsFail = 8,
    dsDown = [],
    gecko = "ok",
    env = {},
    historyPools = 4500,
    runOptions = {},
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "collector-heavy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const world = buildWorld();
  const stateDir = join(dir, "state");
  await mkdir(stateDir);
  await writeFile(join(stateDir, "pools.json"), poolsJson(iso(SAVED), world.pools));
  await writeFile(
    join(stateDir, "history.json"),
    historyJson([{ timestamp: SAVED, value: 1e8, pools: historyPools }]),
  );
  const clock = new FakeClock(START);
  const answer = providers(world, { dsLatency, dsFail, dsDown, gecko });
  const fetchImpl = fakeFetch(clock, (call) => answer(call, clock));
  const result = await runCollector({
    stateDir,
    outDir: join(dir, "data"),
    stateOutDir: stateDir,
    fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
    env: { GITHUB_REPOSITORY: "owner/hook-radar", ...env },
    ...runOptions,
  });
  return {
    t,
    dir,
    stateDir,
    world,
    clock,
    fetchImpl,
    calls: fetchImpl.calls,
    result,
  };
}

const hostOf = (call) => new URL(call.url).hostname;
const isDaily = (call) => call.url.includes("/ohlcv/day?");
const isFallback = (call) => call.url.includes("/pools/multi/");
const gapsOf = (calls, host) => {
  const times = calls
    .filter((call) => hostOf(call) === host)
    .map((call) => call.at)
    .sort((a, b) => a - b);
  return times.slice(1).map((time, i) => time - times[i]);
};

/** What must hold for a heavy run whatever happened in it. */
async function assertSound(run, { published = true, geckoStopped = false } = {}) {
  const { calls, result, world, dir } = run;
  assert.equal(result.ok, published, result.quality.failures.join("; "));
  assert.equal(result.published, published);
  const { status, snapshot } = result;
  assert.equal(isSnapshot(snapshot), true);
  const burstStart = Date.parse(status.burstStartedAt);
  const generatedAt = Date.parse(status.generatedAt);

  // The numbers of the run, in the test report.
  const seconds = (ms) => Math.round((ms - START) / 1000);
  run.t.diagnostic(
    `${result.status.counts.plan.mode} plan, ${result.status.counts.plannedPools} pools in ${result.status.counts.dexscreener.batches} batches; ${calls.length} requests (DEX Screener ${calls.filter((c) => hostOf(c) === "api.dexscreener.com").length}, GeckoTerminal ${calls.filter((c) => hostOf(c) === "api.geckoterminal.com").length}, v4.xyz ${calls.filter((c) => hostOf(c) === "www.v4.xyz").length}); burst ${seconds(burstStart)} s to snapshot ${seconds(generatedAt)} s; fallback ${calls.filter(isFallback).map((c) => seconds(c.at)).join(", ") || "none"}; daily ${calls.filter(isDaily).length}; end ${seconds(calls.at(-1).at)} s`,
  );

  // The 399 requests, counted by the paced client alone and told by every part of
  // the status the same way.
  assert.ok(calls.length <= 399, `${calls.length} requests`);
  const counts = status.counts;
  assert.equal(counts.requests.total, calls.length);
  const onHost = (host) => calls.filter((call) => hostOf(call) === host).length;
  assert.equal(counts.requests.dexscreener, onHost("api.dexscreener.com"));
  assert.equal(counts.requests.geckoterminal, onHost("api.geckoterminal.com"));
  assert.equal(counts.requests.v4xyz, onHost("www.v4.xyz"));
  let perProvider = 0;
  for (const [id, provider] of Object.entries(counts.providers)) {
    assert.equal(
      provider.requests,
      provider.succeeded + provider.failed,
      `${id}: requests = succeeded + failed`,
    );
    assert.equal(counts.requests[id], provider.requests, id);
    perProvider += provider.requests;
  }
  assert.equal(perProvider, counts.requests.total);
  assert.equal(
    status.sources.reduce((sum, source) => sum + (source.requests ?? 0), 0),
    calls.length,
    "the requests of the sources add up to the requests made",
  );
  const written = JSON.parse(
    await readFile(join(dir, "data", "status.json"), "utf8"),
  );
  assert.equal(written.counts.requests.total, calls.length);

  // Every 7D and 30D read comes after every other request, and after the moment
  // the snapshot's time was fixed: the step can never hold up what the page judges.
  const daily = calls.filter(isDaily);
  const others = calls.filter((call) => !isDaily(call));
  assert.equal(counts.daily.requested, daily.length);
  assert.ok(
    daily.every((call) => calls.indexOf(call) >= others.length),
    "every daily read comes after every other request",
  );
  assert.ok(
    daily.every((call) => call.at >= generatedAt),
    "no daily read starts before the snapshot time is fixed",
  );
  assert.ok(daily.length <= 20);
  assert.ok(daily.length <= 399 - others.length);

  // The fallback starts inside the first 200 seconds of the burst, and the burst,
  // up to the snapshot's time, is inside the page's five minutes.
  const fallback = calls.filter(isFallback);
  assert.equal(counts.fallbackRequests, fallback.length);
  assert.ok(fallback.length <= 6);
  for (const call of fallback)
    assert.ok(
      call.at - burstStart <= 200000,
      `a fallback request started ${(call.at - burstStart) / 1000} s into the burst`,
    );
  assert.ok(generatedAt - burstStart < 300000, `${generatedAt - burstStart} ms`);
  for (const pool of snapshot.pools)
    assert.ok(
      generatedAt - Date.parse(pool.metricUpdatedAt) < 300000,
      "a measured pool is older than five minutes at the snapshot time",
    );

  // The pacing of every provider, in the contract's numbers.
  const minimum = {
    "api.dexscreener.com": 400,
    "api.geckoterminal.com": 12000,
    "www.v4.xyz": 5000,
  };
  for (const [host, gap] of Object.entries(minimum)) {
    const gaps = gapsOf(calls, host);
    // A GeckoTerminal stopped by its first answer has made one request: no gap.
    if (!(geckoStopped && host === "api.geckoterminal.com"))
      assert.ok(gaps.length > 1, host);
    assert.ok(
      gaps.every((value) => value >= gap),
      `${host}: shortest gap ${Math.min(...gaps)} ms, needs ${gap}`,
    );
  }
  assert.ok(
    calls.every((call) =>
      call.headers["user-agent"].endsWith("(+https://github.com/owner/hook-radar)"),
    ),
  );

  // Every pool in the snapshot is one the run knows, with the figures its own
  // provider gave: DEX Screener's, or GeckoTerminal's for a pool only it prices.
  for (const pool of snapshot.pools) {
    const known = world.everything.get(`${pool.chain}:${pool.address}`);
    assert.ok(known, `${pool.id} is not a pool the world has`);
    if (pool.metricProvider === "geckoterminal") {
      assert.equal(world.gtOnlyIds.has(pool.address), true);
      assert.equal(pool.volumeUsd.h24, 240);
    } else {
      assert.equal(pool.metricProvider, "dexscreener");
      assert.equal(
        pool.volumeUsd.h24,
        world.volume.get(pool.address) ?? pool.volumeUsd.h24,
      );
    }
  }
  // A pool DEX Screener had no row for is not in the snapshot as a zero.
  const measured = new Set(snapshot.pools.map((p) => `${p.chain}:${p.address}`));
  const dark = world.pools.filter((pool) => isDark(pool, world));
  assert.ok(dark.length > 100);
  assert.ok(dark.every((pool) => !measured.has(`${pool.chain}:${pool.id}`)));
  return { status, snapshot, burstStart, generatedAt, daily, fallback, others };
}

test("the heaviest run with the lane plan: discovery, retries, the tiered fallback and the 7D/30D step share the 399 requests and the five minutes", async (t) => {
  const run = await heavyRun(t);
  const { status, fallback, daily, others, burstStart, generatedAt } =
    await assertSound(run);
  const { counts } = status;
  assert.equal(counts.plan.mode, "lanes", "the saved time and history point give the lane plan");
  assert.equal(counts.plan.reason, null);
  assert.equal(counts.plan.fellBack, false);

  // Discovery ran on all 20 networks, and nothing trimmed it.
  assert.equal(counts.discovery.geckoPages, 20);
  assert.equal(counts.discovery.indexerLists, 20);
  assert.equal(counts.discovery.resolvesTried, 40);
  assert.equal(counts.discovery.cutShort, false);
  assert.equal(counts.discovery.geckoPageFailures, 0);

  // Batches failed and some were asked again, inside the limit of 8; no network
  // was judged down.
  const { retry } = counts.dexscreener;
  assert.ok(retry.failedFirstPass > 8, `${retry.failedFirstPass} failed batches`);
  assert.equal(retry.retried, 8);
  assert.equal(retry.recovered, retry.retried);
  assert.equal(
    counts.requests.dexscreener,
    counts.dexscreener.batches + retry.retried,
  );
  assert.deepEqual(counts.downNetworks, []);
  assert.deepEqual(counts.plan.networkGuard.networks, []);

  // The plan is above its ceiling (discovery added NEW pools after the check that
  // sends a state back to the full plan), so the request count is the heavy one.
  assert.ok(counts.dexscreener.batches > 220, `${counts.dexscreener.batches} batches`);
  assert.ok(counts.dexscreener.batches <= 262, `${counts.dexscreener.batches} batches`);
  assert.equal(counts.plan.ceilingBound, true);
  const note = run.result.snapshot.sources.find((s) => s.id === "dexscreener").note;
  assert.ok(
    note.includes(
      `This plan reached its limit of 220 batches a run and sent ${counts.plan.batches},`,
    ),
    "the DEX Screener note says the plan sent more than its limit",
  );
  assert.ok(
    planNotices(counts, {}).some((line) =>
      line.includes(`batches and sent ${counts.plan.batches},`),
    ),
  );
  assert.ok(run.calls.length > 300, `${run.calls.length} requests`);
  assert.ok(run.calls.length <= 385);

  // The fallback was asked about what GeckoTerminal priced last time first (all 45
  // pools measured), and the 7D/30D step got its 20.
  assert.ok(fallback.length >= 3 && fallback.length <= 6, `${fallback.length}`);
  assert.equal(counts.geckoterminal.measuredByNetwork.xlayer, 7);
  assert.equal(counts.geckoterminal.measuredByNetwork.zora, 8);
  assert.equal(counts.geckoterminal.measuredByNetwork.robinhood, 30);
  assert.equal(daily.length, 20);
  assert.equal(counts.daily.read, 20);
  assert.ok(others.length + daily.length <= 399);

  // The time line: the burst runs after discovery, the fallback after the DEX
  // Screener batches, the step after the snapshot time.
  const lastDs = Math.max(
    ...run.calls
      .filter((call) => hostOf(call) === "api.dexscreener.com")
      .map((call) => call.at),
  );
  assert.ok(fallback.every((call) => call.at >= lastDs - 1000));
  assert.ok(generatedAt - burstStart < 225000 + 20000 + 36000 + 20000);

  // What the next run starts from: the saved time is this run's snapshot time and
  // the pools that answered moved their last-answer time to it.
  const state = await readState(run.stateDir);
  assert.equal(state.updatedAt, status.generatedAt);
});

test("the same run at DEX Screener's real pace (0.76 s a batch): the fallback still starts inside 200 s and the gates hold", async (t) => {
  const run = await heavyRun(t, { dsLatency: 760 });
  const { status, fallback, burstStart } = await assertSound(run);
  assert.equal(status.counts.plan.mode, "lanes");
  assert.ok(fallback.length >= 1);
  assert.ok(
    Math.max(...fallback.map((call) => call.at)) - burstStart <= 200000,
    "the last fallback request started inside the first 200 s",
  );
  // A slow DEX Screener leaves the fallback fewer requests, never more than 6, and
  // the measurement of the rest is unchanged: nothing was cut to make room.
  assert.ok(status.counts.geckoterminal.fallback.requests);
});

test("GeckoTerminal stopped by its first answer (HTTP 429, no wait named): the run still publishes from DEX Screener, with no fallback and no 7D/30D read", async (t) => {
  const run = await heavyRun(t, { gecko: "stopped" });
  const { status, fallback, daily } = await assertSound(run, {
    geckoStopped: true,
  });
  const { counts } = status;
  assert.equal(
    run.calls.filter((call) => hostOf(call) === "api.geckoterminal.com").length,
    1,
    "no other GeckoTerminal request follows the first 429",
  );
  assert.ok(counts.providers.geckoterminal.stopped);
  assert.equal(fallback.length, 0);
  assert.equal(daily.length, 0);
  assert.equal(counts.daily.requested, 0);
  assert.ok(counts.daily.stopped || counts.daily.skipped);
  // The pools only GeckoTerminal prices are absent, not zero, and the rest is
  // measured as usual.
  const measured = new Set(
    run.result.snapshot.pools.map((pool) => pool.address),
  );
  for (const id of run.world.gtOnlyIds) assert.equal(measured.has(id), false);
  assert.ok(run.result.snapshot.pools.length > 5000);
  assert.equal(counts.plan.mode, "lanes");
});

test("a 90 second GeckoTerminal cooldown inside discovery: one wait, one repeat, and the snapshot is still inside five minutes of its burst", async (t) => {
  const run = await heavyRun(t, { gecko: "cooldown90" });
  const { status, fallback, daily, burstStart, generatedAt } =
    await assertSound(run);
  const { counts } = status;
  assert.equal(counts.rateLimitWaits.geckoterminal.times, 1);
  assert.ok(counts.rateLimitWaits.geckoterminal.waitedMs >= 90000);
  assert.equal(counts.providers.geckoterminal.stopped, null);
  // The cooldown and its repeat are requests like the others: the total still
  // adds up (the discovery pages, the fallback, the daily reads and the repeat).
  assert.equal(
    counts.requests.geckoterminal,
    counts.discovery.geckoPages +
      counts.discovery.geckoPageFailures +
      counts.geckoterminal.requests +
      counts.daily.requested +
      counts.rateLimitWaits.geckoterminal.times,
  );
  assert.ok(fallback.length >= 1);
  assert.ok(daily.length >= 1);
  assert.ok(generatedAt - burstStart < 300000);
});

test("COLLECTOR_FULL_PLAN with discovery and the same failing batches: the larger plan is cut to the cap, the 7D/30D step takes what is left", async (t) => {
  const run = await heavyRun(t, { env: { COLLECTOR_FULL_PLAN: "true" } });
  const { status, daily, others } = await assertSound(run);
  assert.equal(status.counts.plan.mode, "full");
  assert.equal(status.counts.plan.reason, "forced");
  assert.equal(daily.length, Math.min(20, 399 - others.length));
  assert.ok(run.calls.length <= 399);
});

test("DEX Screener failing for all of Ethereum (199 HOT pools) in the heaviest run: the lane plan refuses, publishes nothing, spends no 7D/30D request and keeps the saved state", async (t) => {
  const run = await heavyRun(t, { dsDown: ["ethereum"] });
  const { result, calls, stateDir } = run;
  const { status } = result;
  // The gate alone would pass (the run asked about, and was answered for, more than
  // 80% of the pools it planned); the lane plan's guard on the pools that answer
  // is what refuses. A single network's outage costs the run, and the workflow
  // then waits 90 minutes before it collects again: see COLLECTOR-NOTES.
  assert.equal(result.ok, false);
  assert.equal(result.published, false);
  assert.ok(result.quality.checks.share >= 0.8, `${result.quality.checks.share}`);
  assert.ok(
    result.quality.failures.some((line) =>
      /DEX Screener did not answer for Ethereum/.test(line),
    ),
    result.quality.failures.join("; "),
  );
  assert.deepEqual(status.counts.downNetworks, ["ethereum"]);
  assert.deepEqual(
    status.counts.plan.networkGuard.networks.map(({ chain, refused }) => [chain, refused]),
    [["ethereum", true]],
  );
  // Nothing was written, no 7D/30D request was made for a run that will not be
  // published, and the saved state is the one the run started from.
  assert.equal(
    await readdir(join(run.dir, "data")).then(
      (names) => names.length,
      () => 0,
    ),
    0,
  );
  assert.equal(calls.filter(isDaily).length, 0);
  assert.equal(status.counts.daily.requested, 0);
  assert.match(status.counts.daily.skipped, /would not pass the quality gate/);
  assert.ok(calls.length <= 399);
  assert.equal(status.counts.requests.total, calls.length);
  assert.equal((await readState(stateDir)).updatedAt, iso(SAVED));
});
