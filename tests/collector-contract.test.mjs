import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHAINS_URL,
  createDirectory,
  FRONTIER_URL,
  REGISTRY_URL,
} from "../server/model.mjs";
import { MARKET_MAX_AGE_MS } from "../shared/market-freshness.ts";
import * as config from "../collector/config.mjs";
import { createHttpClient, ProviderError } from "../collector/http.mjs";
import {
  decidePlanMode,
  planBurst,
  planLanes,
  planMeasurement,
  runBurst,
} from "../collector/measure.mjs";
import { requestReserve } from "../collector/run.mjs";
import {
  loadRegistry,
  REGISTRY_SOURCES,
  slimHooklist,
} from "../collector/registry.mjs";
import { readState, writeState } from "../collector/state.mjs";
import {
  blockNetwork,
  address,
  FakeClock,
  fakeFetch,
  statePool,
} from "../collector/testing.mjs";

blockNetwork();

// The numbers of the edition's design (the live project's design contract, which
// is not part of this repository), written out. The other collector tests
// import these constants, so only this file notices a constant that was changed
// to make a test pass or a run faster.

const DS = "https://api.dexscreener.com/latest/dex/pairs/base/";
const GT = "https://api.geckoterminal.com/api/v2/networks/base/pools/multi/";
const T0 = Date.parse("2026-10-28T12:00:00.000Z");

const rejects = (promise, code) =>
  assert.rejects(
    promise,
    (error) => error instanceof ProviderError && error.code === code,
  );

function harness(answer, options = {}) {
  const clock = new FakeClock(T0);
  const fetchImpl = fakeFetch(clock, answer);
  const client = createHttpClient({
    fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
    userAgent: "Test/1 (+https://github.com/example/repo)",
    ...options,
  });
  return { clock, fetchImpl, client };
}

test("the contract numbers are the ones the design states", () => {
  const pinned = {
    DS_GAP_MS: 400,
    GT_GAP_MS: 12000,
    V4_GAP_MS: 5000,
    REGISTRY_GAP_MS: 1000,
    DS_BATCH_SIZE: 30,
    GT_FALLBACK_BATCH_SIZE: 30,
    GT_FALLBACK_MAX_REQUESTS: 6,
    // The lane plan's GeckoTerminal fallback: the load stays six requests; tier 0 takes
    // at most eight, a third of the requests are the rotation's, a network not visited
    // for a day is served first, and no request starts after 200 s.
    FALLBACK_TIER0_MAX_REQUESTS: 8,
    FALLBACK_SWEEP_RESERVE_DIVISOR: 3,
    FALLBACK_SWEEP_OVERDUE_MS: 86400000,
    FALLBACK_LATEST_START_MS: 200000,
    // A DEX Screener batch that failed is asked again once: at most eight a run, none
    // starting after 150 s (collector-retry has the rest).
    RETRY_MAX_BATCHES: 8,
    RETRY_BURST_LIMIT_MS: 150000,
    MAX_PRIORITY_POOLS: 1500,
    GT_DISCOVERY_PAGE_CYCLE: 5,
    MAX_MEASURED_POOLS: 8000,
    MAX_DISCOVERED_MEASURED: 500,
    MAX_RESOLVES_PER_RUN: 40,
    STATE_MAX_POOLS: 12000,
    MAX_REQUESTS_PER_RUN: 399,
    BURST_BUDGET_MS: 225000,
    BURST_DEADLINE_MS: 270000,
    MIN_CURRENT_POOLS: 500,
    MIN_REQUESTED_SHARE: 0.8,
    MIN_CURRENT_SHARE: 0.9,
    MIN_VOLUME_POOLS_OF_PREVIOUS: 0.6,
    PREVIOUS_POINT_MAX_AGE_MS: 86400000,
    DISCOVERY_BUDGET_MS: 900000,
    HISTORY_MAX_POINTS: 2016,
    HISTORY_MIN_SPACING_MS: 300000,
    LAST_SEEN_GRANULARITY_MS: 86400000,
    REQUEST_TIMEOUT_MS: 20000,
    MAX_RETRY_AFTER_MS: 120000,
    MAX_CONSECUTIVE_FAILURES: 5,
    DYNAMIC_FEE_FLAG: 8388608,
    FRONTIER_MAX_REQUESTS: 3,
    FRONTIER_LATEST_START_MS: 240000,
    // The lane plan (collector/config.mjs): the thresholds of the lanes, the
    // wheels' overlap, the batch ceiling and the safeguard.
    LANE_HOT_MAX_AGE_MS: 72 * 3600000,
    LANE_NEW_MAX_AGE_MS: 72 * 3600000,
    LANE_NEW_MAX_POOLS: 600,
    LANE_WARM_MAX_AGE_MS: 7 * 86400000,
    LANE_ANCHOR_MAX_AHEAD_MS: 86400000,
    LANE_WINDOW_OVERLAP_MS: 360000,
    LANE_MAX_BATCHES: 220,
    LANE_MIN_SHARE_OF_PREVIOUS: 0.9,
    LANE_DISCOVERED_RESERVE_BATCHES: 10,
    LANE_GUARD_MIN_HOT_POOLS: 50,
    DAILY_JOIN_RANK: 40,
    DAILY_KEEP_RANK: 60,
    DAILY_RANK_GRACE_MS: 259200000,
    DAILY_MAX_REQUESTS: 20,
    DAILY_BUDGET_MS: 240000,
    DAILY_LATEST_START_MS: 1800000,
    DAILY_CANDLES: 33,
    DAILY_STORED_DAYS: 35,
    DAILY_READY_SHARE: 0.9,
    DAILY_MAX_UNREADABLE: 2,
  };
  for (const [name, value] of Object.entries(pinned))
    assert.equal(config[name], value, name);
  assert.deepEqual(
    { ...config.LANE_PERIOD_MS },
    { warm: 3 * 3600000, cool: 6 * 3600000, cold: 12 * 3600000 },
  );
  // The lane plan stays inside the request budget: the registry (3), discovery at
  // full size (20 lists, 20 pages, 40 lookups), the plan at its ceiling and the
  // room for the pools discovery adds to it, the fallback, the Frontier step and
  // the 7D and 30D step that follows them (20 GeckoTerminal requests).
  assert.ok(
    3 +
      80 +
      config.LANE_MAX_BATCHES +
      config.LANE_DISCOVERED_RESERVE_BATCHES +
      config.GT_FALLBACK_MAX_REQUESTS +
      config.FRONTIER_MAX_REQUESTS +
      config.DAILY_MAX_REQUESTS <=
      config.MAX_REQUESTS_PER_RUN,
  );
  assert.equal(
    3 +
      80 +
      config.LANE_MAX_BATCHES +
      config.LANE_DISCOVERED_RESERVE_BATCHES +
      config.GT_FALLBACK_MAX_REQUESTS +
      config.FRONTIER_MAX_REQUESTS +
      config.DAILY_MAX_REQUESTS,
    342,
    "the worst case of a lane plan, daily step included",
  );
  // The retries of failed DEX Screener batches (at most eight) are taken from what
  // is left, and the worst case with all of them is still inside the limit.
  assert.ok(342 + config.RETRY_MAX_BATCHES <= config.MAX_REQUESTS_PER_RUN);
  // The last retry starts by 150 s and may take 20 s: it ends before the fallback's
  // last start (200 s) and before Frontier's (240 s).
  assert.ok(
    config.RETRY_BURST_LIMIT_MS + config.REQUEST_TIMEOUT_MS <
      config.FALLBACK_LATEST_START_MS,
  );
  assert.deepEqual(
    { ...config.resolveGaps({}) },
    {
      dexscreener: 400,
      geckoterminal: 12000,
      v4xyz: 5000,
      registry: 1000,
      frontier: 1000,
      goldsky: 1000,
    },
  );
  // The seed plus the discovered allowance is what the request budget was
  // sized for: 8,500 pools are 284 batches, and 399 requests also pay for the
  // registry (3), up to 20 lists + 40 lookups + 20 pages, the fallback (3) and
  // the Frontier step (3).
  assert.ok(
    Math.ceil(8500 / config.DS_BATCH_SIZE) +
      22 +
      3 +
      config.GT_FALLBACK_MAX_REQUESTS +
      config.FRONTIER_MAX_REQUESTS +
      80 <=
      config.MAX_REQUESTS_PER_RUN,
  );
  // The page counts a measurement as current for five minutes; a burst that
  // starts its last request by the deadline and waits the longest a request
  // may take still ends inside that window.
  assert.equal(MARKET_MAX_AGE_MS, 300000);
  assert.ok(config.BURST_DEADLINE_MS + config.REQUEST_TIMEOUT_MS < 300000);
  // The Frontier step follows the burst: it starts by its own limit and takes
  // at most 10 s + 1 s + 10 s for its two reads and 15 s for the index query.
  assert.ok(
    config.FRONTIER_LATEST_START_MS + 10000 + 1000 + 10000 + 15000 < 300000,
  );
  assert.ok(config.BURST_BUDGET_MS < config.BURST_DEADLINE_MS);
  // The daily-volume step is the last of a run: it asks GeckoTerminal for one
  // answer per pool at the lane's gap, so its 20 requests start inside its own
  // 240 s, and it may begin only while the run is under 30 minutes old: with the
  // longest discovery, the burst deadline and Frontier before it, the whole run
  // is far inside the job's 45 minutes.
  assert.deepEqual([...config.DAILY_CHECKPOINT_HOURS], [0, 4]);
  assert.equal(config.MAX_BYTES.geckoDaily, 64 * 1024);
  assert.ok((config.DAILY_MAX_REQUESTS - 1) * config.GT_GAP_MS < config.DAILY_BUDGET_MS);
  assert.ok(config.DAILY_JOIN_RANK <= config.DAILY_KEEP_RANK);
  assert.ok(
    config.DISCOVERY_BUDGET_MS +
      config.BURST_DEADLINE_MS +
      36000 +
      config.DAILY_BUDGET_MS +
      config.REQUEST_TIMEOUT_MS <
      45 * 60 * 1000,
  );
  // 33 candles are the 30 complete days of the longest window, the day in
  // progress and two days of slack; 35 stored days cover them.
  assert.ok(config.DAILY_CANDLES >= 30 + 1 + 2);
  assert.ok(config.DAILY_STORED_DAYS >= config.DAILY_CANDLES);
});

test("the accept option is the only header a caller can change, and only to JSON of a dated version", async () => {
  const seen = [];
  const answer = (call) => {
    seen.push(call.headers);
    return { body: {} };
  };
  const { client, fetchImpl } = harness(answer);
  await client.getJson("geckoterminal", GT + "0x1");
  assert.equal(seen[0].accept, "application/json", "the default is unchanged");
  await client.getJson("geckoterminal", GT + "0x2", {
    accept: "application/json;version=20230302",
  });
  assert.equal(seen[1].accept, "application/json;version=20230302");
  assert.equal(seen[1]["user-agent"], "Test/1 (+https://github.com/example/repo)");
  const before = fetchImpl.calls.length;
  for (const bad of [
    "text/html",
    "*/*",
    "application/json;version=2023",
    "application/json;q=0.9",
    "application/json, text/html",
    "application/json;version=20230302;x=1",
    "application/jsonx",
    "",
    42,
    null,
  ])
    await rejects(
      client.getJson("geckoterminal", GT + "0x3", { accept: bad }),
      "accept",
    );
  assert.equal(fetchImpl.calls.length, before, "nothing was sent");
  assert.equal(client.requestCount(), before);
});

test("five failures in a row stop a provider, four do not", async () => {
  const { client } = harness(() => ({ status: 500 }));
  for (let i = 0; i < 4; i++)
    await rejects(client.getJson("v4xyz", `https://www.v4.xyz/a?${i}`), "http");
  assert.equal(client.isStopped("v4xyz"), false);
  await rejects(client.getJson("v4xyz", "https://www.v4.xyz/a?5"), "http");
  assert.equal(client.isStopped("v4xyz"), true);
  await rejects(client.getJson("v4xyz", "https://www.v4.xyz/a?6"), "stopped");
});

test("a run sends 399 requests at most", async () => {
  const { client, fetchImpl } = harness(() => ({ body: {} }));
  for (let i = 0; i < 399; i++)
    await client.getJson("dexscreener", `${DS}${i}`);
  assert.equal(client.requestsLeft(), 0);
  await rejects(client.getJson("dexscreener", `${DS}one-more`), "budget");
  await rejects(client.getJson("geckoterminal", `${GT}x`), "budget");
  assert.equal(fetchImpl.calls.length, 399);
});

test("a request that could only start after notAfter is not sent, and costs nothing", async () => {
  const { client, fetchImpl } = harness(() => ({ body: {} }));
  await client.getJson("dexscreener", `${DS}1`);
  // The gap alone (400 ms) puts the next start at T0 + 400.
  await rejects(
    client.getJson("dexscreener", `${DS}2`, { notAfter: T0 + 399 }),
    "budget",
  );
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(client.stats().dexscreener.requests, 1);
  assert.equal(client.requestsLeft(), 398);
  await client.getJson("dexscreener", `${DS}2`, { notAfter: T0 + 400 });
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(fetchImpl.calls[1].at, T0 + 400);
  // Another provider has its own gap and is not held back by this one.
  await client.getJson("geckoterminal", `${GT}1`, { notAfter: T0 + 400 });
});

test("a Retry-After beyond notAfter ends a phase instead of stretching it", async () => {
  const { client, fetchImpl } = harness((call, n) =>
    n === 1 ? { status: 503, headers: { "retry-after": "60" } } : { body: {} },
  );
  await rejects(client.getJson("dexscreener", `${DS}1`), "http");
  await rejects(
    client.getJson("dexscreener", `${DS}2`, { notAfter: T0 + 59000 }),
    "budget",
  );
  assert.equal(fetchImpl.calls.length, 1);
  await client.getJson("dexscreener", `${DS}2`, { notAfter: T0 + 61000 });
  assert.ok(fetchImpl.calls[1].at - fetchImpl.calls[0].at >= 60000);
});

const basePool = (seed) => statePool(seed, { chain: "base" });
const manyPools = (count) =>
  Array.from({ length: count }, (_, i) => basePool(i + 1));

test("no DEX Screener batch starts after 225 seconds", async () => {
  const { client, fetchImpl, clock } = harness((call) => {
    if (call.url.startsWith(DS)) clock.advance(1500);
    return { body: { pairs: null } };
  });
  const burst = await runBurst({
    client,
    plan: planBurst(manyPools(8100)),
    now: clock.now,
    fallbackRequests: 0,
  });
  const calls = fetchImpl.calls.filter((call) => call.url.startsWith(DS));
  assert.equal(calls.length, 150, "225 s at 1.5 s a request");
  assert.ok(calls.every((call) => call.at - T0 < 225000));
  assert.equal(burst.requestedPools, 150 * 30);
  assert.ok(burst.endedAt - burst.startedAt < 227000);
});

test("a late Retry-After ends the burst; it does not push requests past the budget", async () => {
  const { client, fetchImpl, clock } = harness((call, n) => {
    if (!call.url.startsWith(DS)) return { body: { data: [] } };
    clock.advance(800);
    return n === 250
      ? { status: 503, headers: { "retry-after": "120" } }
      : { body: { pairs: null } };
  });
  const burst = await runBurst({
    client,
    plan: planBurst(manyPools(8100)),
    now: clock.now,
    fallbackRequests: 0,
  });
  const calls = fetchImpl.calls.filter((call) => call.url.startsWith(DS));
  assert.equal(calls.length, 250, "the request after the 503 is never sent");
  assert.ok(calls.every((call) => call.at - T0 < 225000));
  assert.equal(burst.networks[0].failedBatches, 1);
  assert.equal(burst.requestedPools, 250 * 30);
  // Everything measured is well inside the five minutes the page allows.
  assert.ok(burst.endedAt - burst.startedAt < 300000 - 20000);
});

test("no fallback request starts after 200 seconds, no request of any kind after 270, and fallback requests are 12 seconds apart", async () => {
  // One slow DEX Screener answer ends the burst's first phase at 190 s: the
  // first fallback request may start, the second (12 s later, at 202 s) may not.
  const slow = harness((call) => {
    if (call.url.startsWith(DS) && slow.clock.now() === T0)
      slow.clock.advance(190000);
    return { body: call.url.startsWith(DS) ? { pairs: null } : { data: [] } };
  });
  const late = await runBurst({
    client: slow.client,
    plan: planBurst(manyPools(90)),
    now: slow.clock.now,
  });
  const gecko = slow.fetchImpl.calls.filter((call) => call.url.startsWith(GT));
  assert.equal(gecko.length, 1);
  assert.equal(late.fallback.requests, 1);
  assert.equal(late.fallback.ids, 30);
  assert.ok(gecko[0].at - T0 < config.FALLBACK_LATEST_START_MS);

  // A phase that ends at 260 s leaves no room for any: before the 200 s rule the
  // first would have started, up to the burst's own deadline of 270 s.
  const slower = harness((call) => {
    if (call.url.startsWith(DS) && slower.clock.now() === T0)
      slower.clock.advance(260000);
    return { body: call.url.startsWith(DS) ? { pairs: null } : { data: [] } };
  });
  const later = await runBurst({
    client: slower.client,
    plan: planBurst(manyPools(90)),
    now: slower.clock.now,
  });
  assert.equal(
    slower.fetchImpl.calls.filter((call) => call.url.startsWith(GT)).length,
    0,
  );
  assert.equal(later.fallback.requests, 0);
  assert.equal(config.FALLBACK_LATEST_START_MS, 200000);
  // The last fallback request starts by 200 s and may take 20 s: it ends before
  // the Frontier step may start (240 s), so the fallback cannot push Frontier out.
  assert.ok(
    config.FALLBACK_LATEST_START_MS + config.REQUEST_TIMEOUT_MS <=
      config.FRONTIER_LATEST_START_MS,
  );

  const quick = harness((call) => ({
    body: call.url.startsWith(DS) ? { pairs: null } : { data: [] },
  }));
  const normal = await runBurst({
    client: quick.client,
    plan: planBurst(manyPools(90)),
    now: quick.clock.now,
  });
  const times = quick.fetchImpl.calls
    .filter((call) => call.url.startsWith(GT))
    .map((call) => call.at);
  assert.equal(times.length, 3);
  assert.equal(normal.fallback.requests, 3);
  for (let i = 1; i < times.length; i++)
    assert.ok(times[i] - times[i - 1] >= 12000);
});

// The registry: fetched once per run, with the last good copy as a fallback.

const hookRow = (name, extra = {}) => ({
  hook: {
    address: address(8001),
    chain: "arbitrum",
    chainId: 42161,
    name,
    description: `${name} test deployment`,
    deployer: address(8002),
    verifiedSource: true,
    auditUrl: "https://example.com/audit.pdf",
    ...extra,
  },
  flags: { beforeSwap: true, afterSwap: false },
  properties: {
    dynamicFee: true,
    upgradeable: true,
    requiresCustomSwapData: true,
    vanillaSwap: true,
    swapAccess: "none",
    note: "not kept",
  },
});
const CHAIN_DOC = { arbitrum: { chainId: 42161 } };
const FRONTIER_DOC = [];

function registryWorld(overrides = {}) {
  const answer = (call) => {
    const reply = overrides[call.url];
    if (reply) return typeof reply === "function" ? reply() : reply;
    if (call.url === REGISTRY_URL) return { body: [hookRow("GlueHook")] };
    if (call.url === CHAINS_URL) return { body: CHAIN_DOC };
    if (call.url === FRONTIER_URL) return { body: FRONTIER_DOC };
    return { status: 404, body: {} };
  };
  return harness(answer);
}

test("the saved hooklist keeps what the directory is built from and nothing it recomputes", () => {
  const [slim] = slimHooklist([hookRow("GlueHook")]);
  assert.deepEqual(slim.hook, {
    address: address(8001),
    chain: "arbitrum",
    chainId: 42161,
    name: "GlueHook",
    description: "GlueHook test deployment",
    verifiedSource: true,
    auditUrl: "https://example.com/audit.pdf",
  });
  assert.deepEqual(slim.properties, {
    dynamicFee: true,
    upgradeable: true,
    requiresCustomSwapData: true,
    vanillaSwap: true,
    swapAccess: "none",
  });
  assert.equal("flags" in slim, false);
  // A directory built from the saved copy equals one built from the original.
  const build = (rows) =>
    createDirectory(rows, { arbitrum: { chainId: 42161 } }, [], [])
      .projects.flatMap((project) => project.deployments)
      .map((deployment) => ({
        address: deployment.address,
        verifiedSource: deployment.verifiedSource,
        auditUrl: deployment.auditUrl,
        properties: deployment.properties,
        name: deployment.name,
      }));
  const full = [hookRow("GlueHook")];
  assert.deepEqual(build(slimHooklist(full)), build(full));
  assert.equal(build(slimHooklist(full))[0].verifiedSource, true);
  assert.equal(
    build(slimHooklist(full))[0].auditUrl,
    "https://example.com/audit.pdf",
  );
  // A row without properties stays without them.
  assert.equal(
    "properties" in slimHooklist([{ hook: hookRow("X").hook }])[0],
    false,
  );
});

test("a live registry is reported live with its own observation time", async () => {
  const { client, clock } = registryWorld();
  const first = await loadRegistry({ client, saved: null });
  assert.deepEqual(
    first.sources.map((source) => [source.id, source.status]),
    [
      ["registry", "live"],
      ["chains", "live"],
      ["frontier-chains", "live"],
    ],
  );
  // The two hooklist-host requests are one second apart (the registry gap).
  assert.equal(first.sources[0].updatedAt, new Date(T0).toISOString());
  assert.equal(first.sources[1].updatedAt, new Date(T0 + 1000).toISOString());
  assert.equal(clock.now(), T0 + 1000);
  assert.equal(first.changed, true);
  assert.equal(first.data.registry[0].hook.verifiedSource, true);
  // Fetched again and unchanged: nothing needs rewriting.
  const again = await loadRegistry({
    client: registryWorld().client,
    saved: { schemaVersion: 1, sources: first.fetched },
  });
  assert.equal(again.changed, false);
});

test("when a fetch fails the saved copy is used and keeps its original fetch time", async () => {
  const saved = { schemaVersion: 1, sources: {} };
  const original = "2026-10-20T08:00:00.000Z";
  saved.sources = {
    registry: {
      url: REGISTRY_URL,
      fetchedAt: original,
      data: slimHooklist([hookRow("SavedHook")]),
    },
    chains: { url: CHAINS_URL, fetchedAt: original, data: CHAIN_DOC },
    frontier: { url: FRONTIER_URL, fetchedAt: original, data: [] },
  };
  const { client } = registryWorld({
    [REGISTRY_URL]: { status: 503 },
    [CHAINS_URL]: { body: { not: "chains" } },
    [FRONTIER_URL]: { status: 500 },
  });
  const result = await loadRegistry({ client, saved });
  assert.deepEqual(
    result.sources.map((source) => [
      source.id,
      source.status,
      source.updatedAt,
    ]),
    [
      ["registry", "cached", original],
      ["chains", "cached", original],
      ["frontier-chains", "cached", original],
    ],
  );
  assert.match(result.sources[0].note, /request failed \(http\)/);
  assert.match(result.sources[1].note, /request failed \(invalid\)/);
  assert.equal(result.data.registry[0].hook.name, "SavedHook");
  // The copy is carried over untouched, so the state file keeps the old time.
  assert.equal(result.fetched.registry, saved.sources.registry);
  assert.equal(result.changed, false);
});

test("without a saved copy a missing hooklist or chain registry stops the run; Frontier's is optional", async () => {
  await assert.rejects(
    loadRegistry({
      client: registryWorld({ [REGISTRY_URL]: { status: 500 } }).client,
      saved: null,
    }),
    /Uniswap hook registry is unavailable and no saved copy exists/,
  );
  await assert.rejects(
    loadRegistry({
      client: registryWorld({ [CHAINS_URL]: { status: 500 } }).client,
      saved: null,
    }),
    /Uniswap chain registry is unavailable and no saved copy exists/,
  );
  const result = await loadRegistry({
    client: registryWorld({ [FRONTIER_URL]: { status: 500 } }).client,
    saved: null,
  });
  const frontier = result.sources.find(
    (source) => source.id === "frontier-chains",
  );
  assert.equal(frontier.status, "unavailable");
  assert.equal(frontier.updatedAt, null);
  assert.deepEqual(result.data.frontier, []);
  assert.deepEqual(
    REGISTRY_SOURCES.map((source) => [source.key, source.required]),
    [
      ["registry", true],
      ["chains", true],
      ["frontier", false],
    ],
  );
});

test("the registry copy survives a round trip through the state files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "collector-registry-"));
  try {
    const live = await loadRegistry({
      client: registryWorld().client,
      saved: null,
    });
    await writeState(dir, {
      updatedAt: "2026-10-28T12:00:00.000Z",
      pools: [statePool(1)],
      hookless: new Set(),
      history: [],
      registry: live.fetched,
    });
    const state = await readState(dir);
    assert.deepEqual(state.registry.sources, live.fetched);
    const offline = await loadRegistry({
      client: registryWorld({
        [REGISTRY_URL]: { status: 500 },
        [CHAINS_URL]: { status: 500 },
        [FRONTIER_URL]: { status: 500 },
      }).client,
      saved: state.registry,
    });
    assert.ok(offline.sources.every((source) => source.status === "cached"));
    assert.equal(offline.sources[0].updatedAt, live.sources[0].updatedAt);
    assert.deepEqual(offline.data.registry, live.data.registry);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a test cannot reach a provider: the process's fetch refuses", async () => {
  await assert.rejects(
    fetch("https://api.dexscreener.com/latest/dex/pairs/base/0x0"),
    /tried to reach the network/,
  );
});

// The environment switches. The contract is that none of them can make the
// collector faster or larger than the design allows: they slow it down, shrink it
// or return it to a size the contract already allowed. A switch that did more
// would let a repository variable (or a stray environment setting on a
// computer) take a run past a provider's limit.

const SWITCHES = [
  "COLLECTOR_DAILY_MAX_REQUESTS", // the 7D and 30D step's requests: can only be lowered (0 switches it off)
  "COLLECTOR_DS_GAP_MS", // a gap between requests: can only be raised
  "COLLECTOR_FULL_PLAN", // the earlier plan: the larger plan, at the contract's size
  "COLLECTOR_GT_GAP_MS", // a gap between requests: can only be raised
  "COLLECTOR_MAX_DISCOVERY", // discovery: can only be lowered
  "COLLECTOR_RETRY_AFTER_CAP_MS", // the longest wait: can only be shortened
  "COLLECTOR_RETRY_MAX_BATCHES", // the batches asked again: can only be lowered (0 switches the retry off)
  "COLLECTOR_V4_GAP_MS", // a gap between requests: can only be raised
];

test("the collector reads exactly these environment switches, and the workflows pass only those", async () => {
  const root = new URL("../", import.meta.url);
  const files = [];
  for (const dir of ["collector/", "collector/tools/"])
    for (const name of await readdir(new URL(dir, root)))
      if (name.endsWith(".mjs")) files.push(`${dir}${name}`);
  files.push(
    ".github/workflows/snapshot.yml",
    ".github/workflows/deploy-ftp.yml",
  );
  const switches = new Set();
  const others = new Set();
  for (const file of files) {
    const text = await readFile(new URL(file, root), "utf8");
    for (const [, name] of text.matchAll(/\benv\??\.([A-Z][A-Z0-9_]+)/g))
      (name.startsWith("COLLECTOR_") ? switches : others).add(name);
    for (const [, name] of text.matchAll(/^\s+(COLLECTOR_[A-Z0-9_]+):/gm))
      switches.add(name);
  }
  assert.deepEqual([...switches].sort(), SWITCHES);
  // Nothing else is read from the environment but the repository's name (the
  // User-Agent) and the marker GitHub sets (which only makes the trace refuse).
  assert.deepEqual([...others].sort(), ["GITHUB_ACTIONS", "GITHUB_REPOSITORY"]);
});

test("the contract text says what an environment switch may do, and COLLECTOR_FULL_PLAN is the allowed return to the earlier plan", async () => {
  const text = (
    await readFile(new URL("../collector/config.mjs", import.meta.url), "utf8")
  ).replace(/\r\n/g, "\n");
  const head = text.slice(0, text.indexOf("export const COLLECTOR_VERSION"));
  const flat = head.replace(/\n\/\/ ?/g, " ");
  assert.match(
    flat,
    /Environment overrides may only make the collector slower or smaller, or return it to a size the contract already allowed: COLLECTOR_FULL_PLAN restores the earlier plan that asks about every known pool in every run\./,
  );
  assert.match(flat, /same 399-request ceiling, the same gaps and the same quality gates/);
  assert.match(
    flat,
    /No override may raise a limit, shorten a gap, weaken a gate or lengthen the burst\./,
  );
  assert.doesNotMatch(flat, /never faster or larger/);
});

test("no switch can raise a limit, shorten a gap or weaken a gate", () => {
  // The gaps: any value gives the contract gap or a longer one.
  const values = [
    undefined,
    "",
    " ",
    "0",
    "-5",
    "1",
    "399",
    "400",
    "401",
    "12000",
    "99999999",
    "abc",
    "NaN",
    "Infinity",
    "-Infinity",
    "1e9",
    "0x10",
    "399.5",
  ];
  for (const value of values) {
    const gaps = config.resolveGaps({
      COLLECTOR_DS_GAP_MS: value,
      COLLECTOR_GT_GAP_MS: value,
      COLLECTOR_V4_GAP_MS: value,
    });
    assert.ok(gaps.dexscreener >= config.DS_GAP_MS, String(value));
    assert.ok(gaps.geckoterminal >= config.GT_GAP_MS, String(value));
    assert.ok(gaps.v4xyz >= config.V4_GAP_MS, String(value));
    assert.equal(gaps.registry, config.REGISTRY_GAP_MS);
    assert.equal(gaps.frontier, config.REGISTRY_GAP_MS);
    assert.equal(gaps.goldsky, config.REGISTRY_GAP_MS);
    // The longest rate-limit wait: any value gives the contract's or a shorter one.
    const cap = config.resolveRateLimitCap({
      COLLECTOR_RETRY_AFTER_CAP_MS: value,
    });
    assert.ok(cap >= 0 && cap <= config.RATE_LIMIT_WAIT_CAP_MS, String(value));
    // Discovery: no value asks for more than "no limit".
    const limit = config.resolveMaxDiscovery({
      COLLECTOR_MAX_DISCOVERY: value,
    });
    assert.ok(
      limit === undefined || (Number.isSafeInteger(limit) && limit >= 0),
      String(value),
    );
    // The 7D and 30D step: no value gives more than the contract's 20 requests.
    const daily = config.resolveDailyMaxRequests({
      COLLECTOR_DAILY_MAX_REQUESTS: value,
    });
    assert.ok(
      Number.isSafeInteger(daily) &&
        daily >= 0 &&
        daily <= config.DAILY_MAX_REQUESTS,
      String(value),
    );
    // The retry of a failed DEX Screener batch: no value gives more than the
    // contract's 8 batches a run.
    const retries = config.resolveRetryMaxBatches({
      COLLECTOR_RETRY_MAX_BATCHES: value,
    });
    assert.ok(
      Number.isSafeInteger(retries) &&
        retries >= 0 &&
        retries <= config.RETRY_MAX_BATCHES,
      String(value),
    );
    // The full plan: a boolean.
    assert.equal(
      typeof config.resolveFullPlan({ COLLECTOR_FULL_PLAN: value }),
      "boolean",
    );
  }
  assert.equal(config.RETRY_MAX_BATCHES, 8);
  for (const [value, expected] of [
    ["0", 0],
    ["3", 3],
    [" 8 ", 8],
    ["9", 8],
    ["999999", 8],
    ["1000000", 8],
    ["-1", 8],
    ["2.5", 8],
    ["x", 8],
    ["", 8],
    [undefined, 8],
  ])
    assert.equal(
      config.resolveRetryMaxBatches({ COLLECTOR_RETRY_MAX_BATCHES: value }),
      expected,
      String(value),
    );
  assert.equal(config.resolveRetryMaxBatches({}), 8);
  for (const [value, expected] of [
    ["0", 0],
    ["5", 5],
    ["20", 20],
    ["21", 20],
    ["999999", 20],
    ["1000000", 20],
    ["-1", 20],
    ["x", 20],
    [undefined, 20],
  ])
    assert.equal(
      config.resolveDailyMaxRequests({ COLLECTOR_DAILY_MAX_REQUESTS: value }),
      expected,
      String(value),
    );
  assert.equal(
    config.resolveGaps({ COLLECTOR_DS_GAP_MS: "750" }).dexscreener,
    750,
  );
  assert.equal(
    config.resolveRateLimitCap({ COLLECTOR_RETRY_AFTER_CAP_MS: "1000" }),
    1000,
  );
  assert.equal(
    config.resolveRateLimitCap({ COLLECTOR_RETRY_AFTER_CAP_MS: "0" }),
    0,
  );
  assert.equal(
    config.resolveRateLimitCap({ COLLECTOR_RETRY_AFTER_CAP_MS: "999999" }),
    90000,
  );
  // Only the four plain words turn the full plan on.
  for (const on of ["1", "true", "TRUE", " yes ", "On"])
    assert.equal(config.resolveFullPlan({ COLLECTOR_FULL_PLAN: on }), true, on);
  for (const off of [
    undefined,
    "",
    "0",
    "false",
    "no",
    "off",
    "enable",
    "2",
    "true!",
  ])
    assert.equal(
      config.resolveFullPlan({ COLLECTOR_FULL_PLAN: off }),
      false,
      String(off),
    );
});

test("COLLECTOR_FULL_PLAN returns the run to the size the contract allowed and no larger; without it the plan is smaller", () => {
  const pool = (n, extra) => ({
    id: `0x${n.toString(16).padStart(8, "0")}${"0".repeat(56)}`,
    chain: "base",
    hookAddress: address(1),
    tokens: [address(2), address(3)],
    name: "A / B",
    createdAt: null,
    source: "census",
    ...extra,
  });
  const at = Date.parse("2026-11-12T00:00:00.000Z");
  const iso = (ms) => new Date(ms).toISOString();
  const world = Array.from({ length: 9000 }, (_, n) =>
    n < 1500
      ? pool(n, {
          firstSeen: iso(at - 9e9),
          lastSeen: iso(at - (n % 20) * 3600000),
        })
      : pool(n, { firstSeen: iso(at - 9e9), lastSeen: iso(at - 9e9) }),
  );
  const decide = (forced) =>
    decidePlanMode({
      pools: world,
      nowMs: at + 3600000,
      updatedAtMs: at,
      previousPoint: { pools: 1200 },
      forced,
    });
  const lanes = planMeasurement(world, {
    decision: decide(null),
    nowMs: at + 3600000,
    updatedAtMs: at,
  });
  const full = planMeasurement(world, {
    decision: decide("forced"),
    nowMs: at + 3600000,
    updatedAtMs: at,
    full: {
      maxPools: config.MAX_MEASURED_POOLS + config.MAX_DISCOVERED_MEASURED,
      maxSeeded: config.MAX_MEASURED_POOLS,
    },
  });
  assert.equal(lanes.mode, "lanes");
  assert.equal(full.mode, "full");
  // The full plan is the contract's: at most 8,500 pools, sized for 399 requests.
  assert.ok(
    full.planned <= config.MAX_MEASURED_POOLS + config.MAX_DISCOVERED_MEASURED,
  );
  assert.ok(
    requestReserve(
      config.MAX_MEASURED_POOLS + config.MAX_DISCOVERED_MEASURED,
    ) +
      3 +
      80 <=
      config.MAX_REQUESTS_PER_RUN,
  );
  // The lane plan is never larger than it, and never above its ceiling (HOT and
  // NEW are 1,500 pools here, well below it).
  assert.ok(lanes.batches <= full.batches);
  assert.ok(lanes.batches <= config.LANE_MAX_BATCHES);
  assert.ok(lanes.planned <= full.planned);
  // Whatever the gap, the lane plan's ceiling holds unless HOT and NEW alone
  // exceed it.
  for (const gap of [1, 6, 24, 240])
    assert.ok(
      planLanes(world, { nowMs: at + gap * 3600000, updatedAtMs: at }).batches <=
        config.LANE_MAX_BATCHES,
      `gap ${gap} h`,
    );
});
