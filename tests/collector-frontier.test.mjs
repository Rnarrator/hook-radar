import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAINS_URL, FRONTIER_URL, REGISTRY_URL } from "../server/model.mjs";
import {
  collectFrontierMetrics,
  getFrontierMarketObservation,
} from "../server/providers.mjs";
import { isSnapshot } from "../src/model.ts";
import { marketMeasurementState } from "../shared/market-freshness.ts";
import {
  FRONTIER_MAX_REQUESTS,
  MAX_BYTES,
  PROVIDERS,
  resolveGaps,
} from "../collector/config.mjs";
import {
  FRONTIER_COVERAGE_SENTENCE,
  FRONTIER_PROVIDER_NAME,
  frontierSources,
} from "../collector/assemble.mjs";
import { createHttpClient } from "../collector/http.mjs";
import {
  collectFrontier,
  frontierFetchJson,
  frontierPools,
  newerMeasurement,
  overlayFrontier,
} from "../collector/providers/frontier.mjs";
import { FIXTURES, requestReserve, runCollector } from "../collector/run.mjs";
import { poolsJson } from "../collector/state.mjs";
import {
  blockNetwork,
  dexRow,
  FakeClock,
  fakeFetch,
  statePool,
} from "../collector/testing.mjs";

blockNetwork();

const fixture = (name) =>
  JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
const FRONTIER_CHAINS = fixture("frontier-1.json");
const COINS = fixture("frontier-2.json");
const STATS = fixture("frontier-3.json");
const INDEX = fixture("goldsky-1.json");
const COINS_URL = "https://api.frontier.fun/coinsPage?limit=100";
const STATS_URL = "https://api.frontier.fun/coinsStats";
const INDEX_URL = FRONTIER_CHAINS[0].subgraphs.ammV4.url;
const ZERO = "0x0000000000000000000000000000000000000000";
const LEGACY_HOOK = "0xb31780aad49d3cc7dd6e03e9e462606f0a5a30cc";
// The replay fixtures hold the times of the recorded run of 27 October 2026.
const START = Date.parse("2026-10-27T21:11:12.000Z");
const ETH_USD = STATS.data.ethPriceUsd;

const coin = (symbol) => COINS.data.find((row) => row.symbol === symbol);
const hookRow = {
  hook: {
    address: "0x1111111111111111111111111111111111111111",
    chainId: 8453,
    chain: "base",
    name: "SomeHook",
    description: "A test deployment",
    verifiedSource: true,
  },
  properties: { dynamicFee: false, upgradeable: false },
};

/** A state pool for a listed coin, as the census seed would hold it. */
function sleuthState(overrides = {}) {
  const row = coin("SLEUTH");
  return statePool(1, {
    id: row.lp,
    chain: "robinhood",
    hookAddress: LEGACY_HOOK,
    tokens: [ZERO, row.token.toLowerCase()],
    name: "SLEUTH / ETH",
    ...overrides,
  });
}

/** Fake providers: the registry documents, Frontier's three answers and DEX
 * Screener for the Robinhood pools the state holds. `frontier` can replace any
 * answer; `dexAge` makes DEX Screener's answer that many seconds old. */
function world({
  frontier = {},
  dexAge = null,
  statePools = [],
  dex = {},
} = {}) {
  const answer = (call) => {
    const url = call.url;
    if (url === REGISTRY_URL) return { body: [hookRow] };
    if (url === CHAINS_URL)
      return {
        body: { base: { chainId: 8453 }, robinhood: { chainId: 4663 } },
      };
    if (url === FRONTIER_URL) return { body: FRONTIER_CHAINS };
    if (url === COINS_URL) return frontier.coins ?? { body: COINS };
    if (url === STATS_URL) return frontier.stats ?? { body: STATS };
    if (url === INDEX_URL) return frontier.index ?? { body: INDEX };
    if (
      url.startsWith("https://api.dexscreener.com/latest/dex/pairs/robinhood/")
    ) {
      const ids = url.split("/").pop().split(",");
      const rows = statePools
        .filter((pool) => ids.includes(pool.id))
        .map((pool) =>
          dexRow(pool, {
            chainId: "robinhood",
            volume: { h1: 1, h6: 2, h24: 3 },
            liquidity: { usd: 1000 },
            ...dex,
          }),
        );
      return {
        body: { pairs: rows.length ? rows : null },
        headers: dexAge ? { age: String(dexAge) } : {},
      };
    }
    return { status: 404, body: {} };
  };
  return answer;
}

async function collect(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "collector-frontier-"));
  const clock = new FakeClock(START);
  const statePools = options.statePools ?? [sleuthState()];
  const answer = world({ ...options, statePools });
  // `dexTakesMs`: each DEX Screener answer arrives that long after it was asked
  // for, so the measurement burst runs long.
  const fetchImpl = fakeFetch(
    clock,
    options.dexTakesMs
      ? (call, count) => {
          if (call.url.startsWith("https://api.dexscreener.com/"))
            clock.advance(options.dexTakesMs);
          return answer(call, count);
        }
      : answer,
  );
  await mkdir(join(dir, "state"), { recursive: true });
  await writeFile(
    join(dir, "state", "pools.json"),
    poolsJson(null, statePools),
  );
  const result = await runCollector({
    stateDir: join(dir, "state"),
    outDir: join(dir, "data"),
    stateOutDir: join(dir, "state"),
    minCurrent: options.minCurrent ?? 5,
    maxDiscovery: 0,
    fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
    env: { GITHUB_REPOSITORY: "owner/hook-radar" },
  });
  return {
    dir,
    result,
    fetchImpl,
    clock,
    done: () => rm(dir, { recursive: true, force: true }),
  };
}

const frontierPoolsOf = (snapshot) =>
  snapshot.pools.filter((pool) => pool.metricProvider === "frontier");

/* ── The client: one POST kind, host-locked ─────────────────────────────── */

test("the client sends a body as a JSON POST to a host it is locked to, and a request with no body stays a GET", async () => {
  const clock = new FakeClock(START);
  const fetchImpl = fakeFetch(clock, () => ({ body: { ok: true } }));
  const client = createHttpClient({
    fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
    userAgent: "Test/1 (+https://github.com/example/repo)",
  });
  await client.getJson("goldsky", INDEX_URL, { body: '{"query":"{ _meta }"}' });
  await client.getJson("frontier", STATS_URL);
  const [post, get] = fetchImpl.calls;
  assert.equal(post.method, "POST");
  assert.equal(post.body, '{"query":"{ _meta }"}');
  assert.equal(post.headers["content-type"], "application/json");
  assert.equal(
    post.headers["user-agent"],
    "Test/1 (+https://github.com/example/repo)",
  );
  assert.equal(get.method, "GET");
  assert.equal(get.body, undefined);
  assert.equal(get.headers["content-type"], undefined);
  // The host lock holds for a POST, and an oversized or empty body is never sent.
  for (const [lane, url, body] of [
    ["frontier", INDEX_URL, "{}"],
    ["goldsky", STATS_URL, "{}"],
    ["goldsky", INDEX_URL, ""],
    ["goldsky", INDEX_URL, "x".repeat(65 * 1024)],
  ])
    await assert.rejects(client.getJson(lane, url, { body }), {
      name: "ProviderError",
    });
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(client.stats().goldsky.requests, 1);
});

test("Goldsky is a provider with the same one-second gap as the other Frontier host, and no cooldown", () => {
  assert.equal(PROVIDERS.goldsky.host, "api.goldsky.com");
  assert.equal(resolveGaps({}).goldsky, 1000);
  assert.equal(resolveGaps({}).frontier, 1000);
  assert.equal(PROVIDERS.frontier.host, "api.frontier.fun");
  assert.ok(MAX_BYTES.frontierIndex <= 1024 * 1024);
  assert.ok(MAX_BYTES.frontierMarkets <= 2 * 1024 * 1024);
});

test("the request reserve pays for the three Frontier requests", () => {
  assert.equal(FRONTIER_MAX_REQUESTS, 3);
  assert.ok(requestReserve(8500) >= 284 + 3 + FRONTIER_MAX_REQUESTS);
});

/* ── The adapter and the live code ──────────────────────────────────────── */

function paced(answer = world()) {
  const clock = new FakeClock(START);
  const fetchImpl = fakeFetch(clock, answer);
  const client = createHttpClient({
    fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
    userAgent: "Test/1 (+https://github.com/example/repo)",
  });
  return { clock, fetchImpl, client };
}

test("the live Frontier code runs unchanged over the paced client: three requests, in order, one of them the index query", async () => {
  const { clock, fetchImpl, client } = paced();
  const step = await collectFrontier({
    client,
    frontierChains: FRONTIER_CHAINS,
    now: clock.now,
  });
  assert.equal(step.failure, null);
  assert.equal(fetchImpl.calls.length, FRONTIER_MAX_REQUESTS);
  assert.deepEqual(
    fetchImpl.calls.map((call) => `${call.method} ${call.url}`).sort(),
    [`GET ${COINS_URL}`, `GET ${STATS_URL}`, `POST ${INDEX_URL}`].sort(),
  );
  // Never a per-coin configuration lookup, whatever the index says.
  assert.ok(fetchImpl.calls.every((call) => !call.url.includes("/extensions")));
  const query = JSON.parse(
    fetchImpl.calls.find((c) => c.method === "POST").body,
  );
  for (const row of COINS.data.filter((c) => c.isLPd))
    assert.ok(query.query.includes(row.lp.toLowerCase()));
  assert.deepEqual(step.requests, {
    "frontier-coins": 1,
    "frontier-stats": 1,
    "frontier-amm-index": 1,
  });
  // Frontier's two lanes are paced at one second each.
  const frontierCalls = fetchImpl.calls.filter((c) =>
    c.url.includes("frontier.fun"),
  );
  assert.ok(frontierCalls[1].at - frontierCalls[0].at >= 1000);
  assert.equal(step.pools.length, 10);
  assert.deepEqual(
    step.sources.map((source) => source.id),
    ["frontier-coins", "frontier-stats", "frontier-amm-index"],
  );
});

test("the figures are the live code's own: the pools the collector keeps equal the producer's rows field for field, and are priced at the current ETH/USD", async () => {
  const { clock, client } = paced();
  const logged = [];
  const adapter = frontierFetchJson(client);
  const recording = async (id, url, options) => {
    const result = await adapter.fetchJson(id, url, options);
    logged.push([id, result]);
    return result;
  };
  const now = clock.now();
  const live = await collectFrontierMetrics({
    fetchJson: recording,
    frontierChains: FRONTIER_CHAINS,
    now,
  });
  // The same answers through the unchanged live function a second time.
  const replay = await collectFrontierMetrics({
    fetchJson: async (id) => logged.find(([key]) => key === id)[1],
    frontierChains: FRONTIER_CHAINS,
    now,
  });
  assert.deepEqual(
    live.pools.map((row) => ({ ...row })),
    replay.pools.map((row) => ({ ...row })),
  );
  const kept = frontierPools(live.pools).pools;
  assert.equal(kept.length, live.pools.length);
  for (const { pool } of kept) {
    const row = live.pools.find((r) => r.id === pool.id);
    const proof = getFrontierMarketObservation(row);
    assert.equal(pool.liquidityUsd, row.liquidityUsd);
    assert.deepEqual(pool.volumeUsd, { ...row.volumeUsd });
    assert.equal(pool.metricUpdatedAt, row.metricUpdatedAt);
    assert.equal(pool.metricStatus, row.metricStatus);
    assert.equal(pool.source, row.source);
    assert.equal(pool.url, row.url);
    assert.equal(pool.metricProvider, "frontier");
    assert.deepEqual(pool.tokens, [ZERO, proof.tokens[1]]);
    assert.deepEqual(
      pool.metricProvenance,
      JSON.parse(JSON.stringify(proof.provenance)),
    );
  }
  // 24h volume of FOREVER: 100 + 30 + 6.3 ETH of swaps at the statistics' price.
  const forever = kept.find(({ pool }) => pool.name === "FOREVER / ETH").pool;
  assert.ok(Math.abs(forever.volumeUsd.h24 - 136.3 * ETH_USD) < 1e-6);
  assert.ok(Math.abs(forever.volumeUsd.h1 - 100 * ETH_USD) < 1e-6);
  assert.ok(Math.abs(forever.volumeUsd.h6 - 130 * ETH_USD) < 1e-6);
  // A pool with no swap in a window the index has reached measures zero.
  const hotdog = kept.find(({ pool }) => pool.name === "HOTDOG / ETH").pool;
  assert.deepEqual(hotdog.volumeUsd, { h1: 0, h6: 0, h24: 0 });
});

test("a row without the live producer's proof is never used", () => {
  const forged = {
    id: `robinhood:${coin("FOREVER").lp}`,
    chain: "robinhood",
    chainId: 4663,
    address: coin("FOREVER").lp,
    hookAddress: LEGACY_HOOK,
    tokens: [ZERO, coin("FOREVER").token],
    metricProvider: "frontier",
    metricUpdatedAt: new Date(START).toISOString(),
    metricStatus: "live",
    liquidityUsd: 1e9,
    volumeUsd: { h1: 1e9, h6: 1e9, h24: 1e9 },
  };
  assert.deepEqual(frontierPools([forged]).pools, []);
});

test("a pool the state knows keeps its name and creation time, and cannot be moved to another hook or other currencies", async () => {
  const { clock, client } = paced();
  const step = await collectFrontier({
    client,
    frontierChains: FRONTIER_CHAINS,
    now: clock.now,
  });
  const rows = [...step.pools].map(({ pool }) => pool);
  assert.equal(rows.length, 10);
  const metrics = await collectFrontierMetrics({
    fetchJson: frontierFetchJson(paced().client).fetchJson,
    frontierChains: FRONTIER_CHAINS,
    now: clock.now(),
  });
  const key = `robinhood:${coin("SLEUTH").lp}`;
  const known = new Map([
    [
      key,
      sleuthState({
        name: "Renamed by the census / ETH",
        createdAt: "2026-08-27T15:17:26.000Z",
      }),
    ],
  ]);
  const same = frontierPools(metrics.pools, known);
  const sleuth = same.pools.find((p) => p.key === key).pool;
  assert.equal(sleuth.name, "Renamed by the census / ETH");
  assert.equal(sleuth.createdAt, "2026-08-27T15:17:26.000Z");
  for (const wrong of [
    sleuthState({ hookAddress: "0x2222222222222222222222222222222222222222" }),
    sleuthState({
      tokens: [ZERO, "0x3333333333333333333333333333333333333333"],
    }),
  ]) {
    const moved = frontierPools(metrics.pools, new Map([[key, wrong]]));
    assert.deepEqual(moved.skipped, [key]);
    assert.equal(
      moved.pools.find((p) => p.key === key),
      undefined,
    );
    assert.equal(moved.pools.length, 9);
  }
});

test("a second provider's row of the same pool: the newer measurement wins whole, an equal time only when the status differs", () => {
  const at = (iso, status = "live", extra = {}) => ({
    metricUpdatedAt: iso,
    metricStatus: status,
    ...extra,
  });
  assert.equal(
    newerMeasurement(
      at("2026-10-27T21:00:00.000Z"),
      at("2026-10-27T21:00:01.000Z"),
    ),
    true,
  );
  assert.equal(
    newerMeasurement(
      at("2026-10-27T21:00:01.000Z"),
      at("2026-10-27T21:00:00.000Z"),
    ),
    false,
  );
  assert.equal(
    newerMeasurement(
      at("2026-10-27T21:00:00.000Z"),
      at("2026-10-27T21:00:00.000Z"),
    ),
    false,
  );
  assert.equal(
    newerMeasurement(
      at("2026-10-27T21:00:00.000Z", "cached"),
      at("2026-10-27T21:00:00.000Z"),
    ),
    true,
  );
  assert.equal(
    newerMeasurement(at("not a time"), at("2026-10-27T21:00:00.000Z")),
    true,
  );
  assert.equal(
    newerMeasurement(at("2026-10-27T21:00:00.000Z"), at(undefined)),
    false,
  );

  const old = { name: "dex", ...at("2026-10-27T21:00:00.000Z") };
  const fresher = { name: "dex", ...at("2026-10-27T21:09:00.000Z") };
  const incoming = (key, iso) => ({
    key,
    pool: { name: "frontier", ...at(iso) },
  });
  const measured = new Map([
    ["robinhood:0xa", old],
    ["robinhood:0xb", fresher],
  ]);
  const overlay = overlayFrontier(measured, [
    incoming("robinhood:0xa", "2026-10-27T21:05:00.000Z"),
    incoming("robinhood:0xb", "2026-10-27T21:05:00.000Z"),
    incoming("robinhood:0xc", "2026-10-27T21:05:00.000Z"),
  ]);
  assert.deepEqual([overlay.added, overlay.replaced, overlay.kept], [1, 1, 1]);
  assert.equal(overlay.measured.get("robinhood:0xa").name, "frontier");
  assert.equal(overlay.measured.get("robinhood:0xb").name, "dex");
  assert.equal(overlay.measured.get("robinhood:0xc").name, "frontier");
  // The burst's own map is never changed.
  assert.equal(measured.get("robinhood:0xa").name, "dex");
  assert.equal(measured.size, 2);
});

/* ── A whole run ────────────────────────────────────────────────────────── */

test("a run publishes Frontier's own figures for its pools, labelled per pool, with the sources named and counted", async () => {
  const run = await collect({ dexAge: 120 });
  try {
    const { result, fetchImpl } = run;
    assert.equal(result.ok, true, result.quality.failures.join("; "));
    const { snapshot, status } = result;
    assert.equal(isSnapshot(snapshot), true);
    const at = Date.parse(snapshot.generatedAt);
    assert.equal(at, Date.parse(status.burstEndedAt));
    assert.ok(
      snapshot.pools.every(
        (pool) => marketMeasurementState(pool, at) === "current",
      ),
    );
    // Ten pools, every one attributed to Frontier by its exact hook.
    const frontier = frontierPoolsOf(snapshot);
    assert.equal(frontier.length, 10);
    assert.ok(frontier.every((pool) => pool.projectId === "frontier"));
    assert.ok(
      frontier.every(
        (pool) =>
          pool.source ===
          "Frontier AMM index/configuration; USD estimates at current ETH/USD",
      ),
    );
    assert.ok(frontier.every((pool) => pool.liquidityStatus === undefined));
    assert.ok(frontier.every((pool) => pool.metricProvenance.length >= 2));
    // The pool the state knew, measured by DEX Screener 120 s earlier, is Frontier's now.
    const sleuth = snapshot.pools.find((pool) => pool.name === "SLEUTH / ETH");
    assert.equal(sleuth.metricProvider, "frontier");
    assert.equal(sleuth.hookAddress, LEGACY_HOOK);
    // The project row follows the pools: exactly their sums.
    const project = snapshot.projects.find((p) => p.id === "frontier");
    assert.equal(project.metrics.poolCount, 10);
    const sum = (pick) => frontier.reduce((s, pool) => s + pick(pool), 0);
    assert.ok(
      Math.abs(project.metrics.volumeUsd.h24 - sum((p) => p.volumeUsd.h24)) <
        1e-6,
    );
    assert.ok(
      Math.abs(project.metrics.liquidityUsd - sum((p) => p.liquidityUsd)) <
        1e-6,
    );
    // The coverage text says where the figures came from, in the live app's words.
    assert.match(
      snapshot.coverage.description,
      /from Frontier’s public AMM index\./,
    );
    assert.ok(
      snapshot.coverage.description.endsWith(FRONTIER_COVERAGE_SENTENCE),
    );
    // The sources: the live app's rows, with the real request counts.
    const named = Object.fromEntries(
      snapshot.sources
        .filter((s) => s.id.startsWith("frontier"))
        .map((s) => [s.id, s]),
    );
    assert.deepEqual(Object.keys(named).sort(), [
      "frontier-amm-index",
      "frontier-chains",
      "frontier-coins",
      "frontier-stats",
    ]);
    assert.match(
      named["frontier-coins"].note,
      /Only isLPd=true markets are included/,
    );
    assert.match(
      named["frontier-coins"].note,
      /10 pooled coin markets listed; Frontier's figures are used for 10 pools/,
    );
    assert.match(
      named["frontier-stats"].note,
      /Curve volume is never counted as v4 volume/,
    );
    assert.match(named["frontier-amm-index"].note, /excludes hook-held assets/);
    assert.equal(named["frontier-amm-index"].url, INDEX_URL);
    const bySource = Object.fromEntries(
      status.sources
        .filter((s) => s.id.startsWith("frontier"))
        .map((s) => [s.id, s.requests]),
    );
    assert.deepEqual(bySource, {
      "frontier-chains": 1,
      "frontier-coins": 1,
      "frontier-stats": 1,
      "frontier-amm-index": 1,
    });
    assert.equal(status.counts.requests.frontier, 3);
    assert.equal(status.counts.requests.goldsky, 1);
    assert.equal(status.counts.requests.total, fetchImpl.calls.length);
    assert.deepEqual(status.counts.frontier, {
      coinMarketsListed: 10,
      poolsSupplied: 10,
      poolsAdded: 9,
      poolsReplacingOlderRow: 1,
      poolsKeptFromOtherProvider: 0,
      poolsLeftOutOnMismatch: 0,
      failure: null,
    });
    assert.equal(status.counts.measuredPools, 10);
    assert.ok(status.counts.requests.total < 400);
  } finally {
    await run.done();
  }
});

test("the snapshot's time is taken after Frontier's step, so no row is newer than the snapshot it is in", async () => {
  const run = await collect({ dexAge: 120 });
  try {
    const { result, fetchImpl } = run;
    assert.equal(result.ok, true, result.quality.failures.join("; "));
    const generatedAt = Date.parse(result.snapshot.generatedAt);
    const dexCalls = fetchImpl.calls.filter((call) =>
      call.url.startsWith("https://api.dexscreener.com/"),
    );
    const readCalls = fetchImpl.calls.filter(
      (call) =>
        call.url === COINS_URL ||
        call.url === STATS_URL ||
        call.url === INDEX_URL,
    );
    assert.equal(dexCalls.length > 0, true);
    assert.equal(readCalls.length, 3);
    const lastDex = Math.max(...dexCalls.map((call) => call.at));
    const lastRead = Math.max(...readCalls.map((call) => call.at));
    // Frontier is read after the burst, and the second Frontier request waits
    // for the one-second gap, so the step ends well after the burst did.
    assert.ok(readCalls.every((call) => call.at >= lastDex));
    assert.ok(lastRead > lastDex);
    // The snapshot is not older than the last thing the run asked for.
    assert.ok(
      generatedAt >= lastRead,
      "the snapshot time precedes Frontier's step",
    );
    const rows = frontierPoolsOf(result.snapshot);
    assert.equal(rows.length, 10);
    for (const row of rows)
      assert.ok(
        Date.parse(row.metricUpdatedAt) <= generatedAt,
        `${row.name} was measured after the snapshot's own time`,
      );
    // The burst's end time in the status is the snapshot's time, too.
    assert.equal(Date.parse(result.status.burstEndedAt), generatedAt);
  } finally {
    await run.done();
  }
});

test("when the measurement burst ran long, Frontier is not read: no request, one source that says why, and the DEX Screener rows stay", async () => {
  // The only DEX Screener answer comes 250 seconds after it was asked for, past
  // the 240 seconds after which Frontier's step is left out to keep the five-minute window.
  const run = await collect({
    dexAge: null,
    dexTakesMs: 250000,
    minCurrent: 1,
  });
  try {
    const { result, fetchImpl } = run;
    assert.equal(result.ok, true, result.quality.failures.join("; "));
    // Nothing of Frontier's step was asked for: only the configuration read at the start.
    for (const url of [COINS_URL, STATS_URL, INDEX_URL])
      assert.equal(
        fetchImpl.calls.filter((call) => call.url === url).length,
        0,
        url,
      );
    assert.equal(
      fetchImpl.calls.filter((call) => call.url === FRONTIER_URL).length,
      1,
    );
    assert.equal(result.status.counts.requests.frontier, 1);
    assert.equal(result.status.counts.requests.goldsky, 0);
    assert.equal(frontierPoolsOf(result.snapshot).length, 0);
    assert.match(result.status.counts.frontier.failure, /ran too long/);
    assert.equal(result.status.counts.frontier.poolsSupplied, 0);
    // The DEX Screener row of the pool Frontier lists stays, measured.
    const sleuth = result.snapshot.pools.find(
      (pool) => pool.address === coin("SLEUTH").lp,
    );
    assert.equal(sleuth.metricProvider, "dexscreener");
    assert.deepEqual(sleuth.volumeUsd, { h1: 1, h6: 2, h24: 3 });
    // One source row says it, and nothing claims a Frontier measurement.
    const rows = result.snapshot.sources.filter((s) =>
      s.id.startsWith("frontier"),
    );
    const coins = rows.find((s) => s.id === "frontier-coins");
    assert.equal(coins.status, "unavailable");
    assert.equal(coins.updatedAt, null);
    assert.match(coins.note, /burst ran too long/);
    assert.equal(
      rows.some((s) => s.status === "live" && s.id !== "frontier-chains"),
      false,
    );
    assert.doesNotMatch(result.snapshot.coverage.description, /Frontier/);
  } finally {
    await run.done();
  }
});

test("when DEX Screener measured a pool more recently, its row stays and Frontier's is not laid over it", async () => {
  const run = await collect({ dexAge: null });
  try {
    const { result } = run;
    assert.equal(result.ok, true, result.quality.failures.join("; "));
    const sleuth = result.snapshot.pools.find(
      (pool) => pool.address === coin("SLEUTH").lp,
    );
    assert.equal(sleuth.metricProvider, "dexscreener");
    assert.equal(sleuth.source, "DEX Screener");
    assert.deepEqual(sleuth.volumeUsd, { h1: 1, h6: 2, h24: 3 });
    assert.equal(frontierPoolsOf(result.snapshot).length, 9);
    assert.equal(result.status.counts.frontier.poolsKeptFromOtherProvider, 1);
  } finally {
    await run.done();
  }
});

test("a pool Frontier measured is remembered by the state exactly like any measured pool, and its DEX Screener hint is kept", async () => {
  const run = await collect({
    dexAge: 120,
    statePools: [sleuthState({ via: "geckoterminal" })],
  });
  try {
    const state = JSON.parse(
      await readFile(join(run.dir, "state", "pools.json"), "utf8"),
    );
    const sleuth = state.pools.find((pool) => pool.id === coin("SLEUTH").lp);
    assert.equal(sleuth.via, "geckoterminal");
    assert.equal(state.pools.length, 1);
  } finally {
    await run.done();
  }
});

/* ── Failure never fails the run ────────────────────────────────────────── */

test("when the index does not answer, the run still passes: no per-coin lookups, the other providers' rows stay, and the source says why", async () => {
  const run = await collect({
    frontier: { index: { status: 503, body: {} } },
    dexAge: 120,
    minCurrent: 1,
  });
  try {
    const { result, fetchImpl } = run;
    assert.equal(result.ok, true, result.quality.failures.join("; "));
    assert.equal(frontierPoolsOf(result.snapshot).length, 0);
    const sleuth = result.snapshot.pools.find(
      (pool) => pool.address === coin("SLEUTH").lp,
    );
    assert.equal(sleuth.metricProvider, "dexscreener");
    assert.ok(
      fetchImpl.calls.every((call) => !call.url.includes("/extensions")),
    );
    const index = result.snapshot.sources.find(
      (s) => s.id === "frontier-amm-index",
    );
    assert.equal(index.status, "unavailable");
    assert.equal(index.updatedAt, null);
    assert.match(index.note, /HTTP 503/);
    const attribution = result.snapshot.sources.find(
      (s) => s.id === "frontier-market-attribution",
    );
    assert.equal(attribution.status, "unavailable");
    assert.match(
      attribution.note,
      /does not request Frontier's per-coin configuration/,
    );
    assert.doesNotMatch(result.snapshot.coverage.description, /Frontier/);
    // Three requests on the two hosts plus the configuration read at the start.
    assert.equal(result.status.counts.requests.frontier, 3);
    assert.equal(result.status.counts.requests.goldsky, 1);
    assert.equal(result.status.counts.frontier.poolsSupplied, 0);
  } finally {
    await run.done();
  }
});

test("when the coin listing is refused, the run passes, the index is not asked and Frontier is named unavailable", async () => {
  for (const status of [429, 403, 500]) {
    const run = await collect({
      frontier: { coins: { status, body: {} } },
      minCurrent: 1,
    });
    try {
      const { result, fetchImpl } = run;
      assert.equal(
        result.ok,
        true,
        `${status}: ${result.quality.failures.join("; ")}`,
      );
      assert.equal(frontierPoolsOf(result.snapshot).length, 0);
      assert.ok(fetchImpl.calls.every((call) => call.url !== INDEX_URL));
      const coins = result.snapshot.sources.find(
        (s) => s.id === "frontier-coins",
      );
      assert.equal(coins.status, "unavailable");
      assert.match(
        coins.note,
        new RegExp(`HTTP ${status}|answered HTTP ${status}`),
      );
      assert.equal(result.status.counts.requests.goldsky, 0);
    } finally {
      await run.done();
    }
  }
});

test("a coin listing or statistics answer of the wrong shape, or an index with errors, leaves no Frontier pool and no failed run", async () => {
  for (const frontier of [
    { coins: { body: { nothing: true } } },
    { stats: { body: { data: { ethPriceUsd: 0 } } } },
    { index: { body: { errors: [{ message: "x" }], data: null } } },
    {
      index: {
        body: {
          data: { _meta: { hasIndexingErrors: true }, pools: [], swaps: [] },
        },
      },
    },
  ]) {
    const run = await collect({ frontier, minCurrent: 1 });
    try {
      assert.equal(run.result.ok, true, run.result.quality.failures.join("; "));
      assert.equal(frontierPoolsOf(run.result.snapshot).length, 0);
    } finally {
      await run.done();
    }
  }
});

test("a step that throws is reported as one unavailable source and cannot take the run down", async () => {
  const { client } = paced();
  const step = await collectFrontier({
    client,
    frontierChains: FRONTIER_CHAINS,
    now: () => {
      throw new Error("the clock broke");
    },
  });
  assert.equal(step.failure, "the clock broke");
  assert.deepEqual(step.pools, []);
  const sources = frontierSources({ ...step, listed: 0 }, new Map());
  assert.equal(sources.length, 1);
  assert.equal(sources[0].id, "frontier-coins");
  assert.equal(sources[0].status, "unavailable");
  assert.equal(sources[0].updatedAt, null);
  assert.match(sources[0].note, /the clock broke/);
  assert.match(sources[0].note, /none is estimated/);
});

test("with no Frontier chain in the configuration nothing is requested and nothing is named", async () => {
  const { client, fetchImpl, clock } = paced();
  for (const chains of [[], undefined]) {
    const step = await collectFrontier({
      client,
      frontierChains: chains,
      now: clock.now,
    });
    assert.deepEqual(step.pools, []);
    assert.deepEqual(frontierSources(step, new Map()), []);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

/* ── The wording is the live app's ──────────────────────────────────────── */

// The live app's store is not part of the edition's folder: the comparison runs
// where it is present and is skipped where it is not, like the other tests that
// compare the collector with the live app.
const liveStore = new URL("../server/store.mjs", import.meta.url);
test(
  "the coverage wording for Frontier is the live app's own",
  { skip: existsSync(liveStore) ? false : "the live app's store is not here" },
  () => {
    const store = readFileSync(liveStore, "utf8");
    assert.ok(store.includes(FRONTIER_PROVIDER_NAME));
    assert.ok(store.includes(FRONTIER_COVERAGE_SENTENCE.trim()));
  },
);
