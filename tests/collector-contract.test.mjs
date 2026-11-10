import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
import { planBurst, runBurst } from "../collector/measure.mjs";
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
    GT_FALLBACK_MAX_REQUESTS: 3,
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
    HISTORY_MAX_POINTS: 672,
    HISTORY_MIN_SPACING_MS: 300000,
    LAST_SEEN_GRANULARITY_MS: 86400000,
    REQUEST_TIMEOUT_MS: 20000,
    MAX_RETRY_AFTER_MS: 120000,
    MAX_CONSECUTIVE_FAILURES: 5,
    DYNAMIC_FEE_FLAG: 8388608,
  };
  for (const [name, value] of Object.entries(pinned))
    assert.equal(config[name], value, name);
  assert.deepEqual(
    { ...config.resolveGaps({}) },
    {
      dexscreener: 400,
      geckoterminal: 12000,
      v4xyz: 5000,
      registry: 1000,
      frontier: 1000,
    },
  );
  // The seed plus the discovered allowance is what the request budget was
  // sized for: 8,500 pools are 284 batches, and 399 requests also pay for the
  // registry (3), up to 20 lists + 40 lookups + 20 pages, and the fallback (3).
  assert.ok(
    Math.ceil(8500 / config.DS_BATCH_SIZE) + 22 + 3 + 3 + 80 <=
      config.MAX_REQUESTS_PER_RUN,
  );
  // The page counts a measurement as current for five minutes; a burst that
  // starts its last request by the deadline and waits the longest a request
  // may take still ends inside that window.
  assert.equal(MARKET_MAX_AGE_MS, 300000);
  assert.ok(config.BURST_DEADLINE_MS + config.REQUEST_TIMEOUT_MS < 300000);
  assert.ok(config.BURST_BUDGET_MS < config.BURST_DEADLINE_MS);
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

test("no request of any kind starts after 270 seconds, and fallback requests are 12 seconds apart", async () => {
  // One slow DEX Screener answer ends the burst's first phase at 260 s: the
  // first fallback request may start, the second (12 s later) may not.
  const slow = harness((call) => {
    if (call.url.startsWith(DS)) slow.clock.advance(260000);
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
