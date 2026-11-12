import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAINS_URL, FRONTIER_URL, REGISTRY_URL } from "../server/model.mjs";
import * as config from "../collector/config.mjs";
import { lanePlanNote, marketCoverageFor } from "../collector/assemble.mjs";
import { createHttpClient, ProviderError } from "../collector/http.mjs";
import {
  fallbackSplit,
  isGeckoCarried,
  planFallback,
} from "../collector/fallback.mjs";
import {
  decidePlanMode,
  isProviderAnswer,
  laneOf,
  measurementChains,
  planBurst,
  planLanes,
  runBurst,
} from "../collector/measure.mjs";
import { runCollector } from "../collector/run.mjs";
import { dryRun, formatReport } from "../collector/tools/plan-dry-run.mjs";
import { historyJson, isCursors, poolsJson, readState } from "../collector/state.mjs";
import {
  address,
  blockNetwork,
  dexRow,
  FakeClock,
  fakeFetch,
  statePool,
} from "../collector/testing.mjs";

blockNetwork();

// The GeckoTerminal fallback of a run: which pools it asks about, what it counts,
// and how it fails. Everything runs on made-up pools and a fake provider; nothing
// reaches a provider and nothing is written.

const H = 3600000;
const DAY = 24 * H;
const T0 = Date.parse("2026-11-12T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const hashId = (n, salt = "gt") =>
  `0x${createHash("sha256").update(`${salt}:${n}`).digest("hex")}`;
const keyOf = (pool) => `${pool.chain}:${pool.id}`;
const chainOf = (slug) => measurementChains().find((c) => c.chain === slug);

/** A pool a provider measured `lastAgo` before `at`. */
const answered = (n, { chain = "base", lastAgo, at, salt, ...rest } = {}) =>
  statePool(n, {
    id: hashId(n, salt),
    chain,
    firstSeen: iso(at - lastAgo - 30 * DAY),
    lastSeen: iso(at - lastAgo),
    ...rest,
  });
/** A pool added `firstAgo` before `at` that never answered. */
const silent = (n, { chain = "base", firstAgo, at, salt, ...rest } = {}) =>
  statePool(n, {
    id: hashId(n, salt),
    chain,
    firstSeen: iso(at - firstAgo),
    lastSeen: iso(at - firstAgo),
    ...rest,
  });

/** A GeckoTerminal row for a pool, shaped like the provider's. */
const geckoRow = (pool, overrides = {}) => {
  const chain = chainOf(pool.chain);
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
    ...overrides,
  };
};

const idsOf = (url) => /pools\/multi\/([^?]+)/.exec(url)[1].split(",");
const gtSlugOf = (url) => /networks\/([^/]+)\/pools\/multi/.exec(url)[1];

/** A paced client over a fake provider. `dex(call)` and `gecko(call, pools)`
 * answer; both default to "nothing found". */
function world(pools, { dex, gecko } = {}) {
  const clock = new FakeClock(T0);
  const byId = new Map(pools.map((pool) => [pool.id, pool]));
  let geckoCalls = 0;
  const fetchImpl = fakeFetch(clock, (call) => {
    if (call.url.includes("dexscreener.com"))
      return dex ? dex(call, byId) : { body: { pairs: null } };
    const wanted = idsOf(call.url).map((id) => byId.get(id));
    return gecko ? gecko(call, wanted, ++geckoCalls) : { body: { data: [] } };
  });
  const client = createHttpClient({
    fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
    userAgent: "Test/1 (+https://github.com/example/repo)",
  });
  return { clock, fetchImpl, client };
}

/* ── A network DEX Screener was not asked about ──────────────────────────── */

test("GeckoTerminal answers for a network that is not in the DEX Screener plan are counted: the network has a row, the pools are measured, the gate's numbers do not move", async () => {
  const at = T0 - 3 * H;
  // Base answers (HOT, asked every run). Ethereum has only pools that never
  // answered and were first seen long ago (COLD): the plan asks about each only
  // once in twelve hours, and not in this run.
  const base = Array.from({ length: 5 }, (_, i) =>
    answered(i + 1, { chain: "base", lastAgo: H, at, salt: "absent" }),
  );
  const ethereum = Array.from({ length: 10 }, (_, i) =>
    silent(100 + i, { chain: "ethereum", firstAgo: 20 * DAY, at, salt: "absent" }),
  );
  const pools = [...base, ...ethereum];
  const plan = planLanes(pools, { nowMs: T0, updatedAtMs: T0 - 2 * 60000 });
  assert.deepEqual(
    plan.networks.map((n) => n.chain.chain),
    ["base"],
    "ethereum is not in the plan: its pools are not due",
  );
  const { client, fetchImpl, clock } = world(pools, {
    dex: (call, byId) => ({
      body: { pairs: idsOf0(call.url).map((id) => dexRow(byId.get(id))) },
    }),
    gecko: (call, wanted) => ({ body: { data: wanted.map((pool) => geckoRow(pool)) } }),
  });
  const burst = await runBurst({
    client,
    plan,
    now: clock.now,
    known: pools,
    fallbackRequests: 1,
  });

  const gecko = fetchImpl.calls.filter((c) => c.url.includes("geckoterminal.com"));
  assert.equal(gecko.length, 1);
  assert.equal(gtSlugOf(gecko[0].url), "eth", "the request went to Ethereum");
  assert.deepEqual(
    new Set(idsOf(gecko[0].url)),
    new Set(ethereum.map((pool) => pool.id)),
  );
  // The pools are measured and counted.
  for (const pool of ethereum) {
    assert.equal(burst.measured.get(keyOf(pool))?.metricProvider, "geckoterminal");
    assert.equal(burst.answeredKeys.has(keyOf(pool)), true);
  }
  assert.equal(burst.fallback.measured, 10);
  assert.deepEqual(burst.telemetry.geckoterminal.measuredByNetwork, { ethereum: 10 });
  assert.deepEqual(burst.telemetry.geckoterminal.errors, { total: 0, last: null });
  // The network has the row of a network that was asked about, though DEX Screener
  // was not asked about any of its pools: what GeckoTerminal answered is counted in
  // it. `requested` stays what DEX Screener was asked.
  const row = burst.networks.find((n) => n.chain === "ethereum");
  assert.deepEqual(
    [row.planned, row.requested, row.checked, row.measured, row.failedBatches],
    [0, 0, 10, 10, 0],
  );
  // What the quality gate judges is DEX Screener's alone: the five base pools.
  assert.equal(burst.requestedPools, 5);
  assert.equal(burst.answeredPools, 5);
  assert.equal(burst.requestedKeys.size, 5);
  assert.equal(burst.checkedPools, 15, "the coverage rows count every answer");
  // The coverage row says Ethereum answered (and, as before, that DEX Screener was
  // not asked about its pools: attemptedPools is DEX Screener's).
  const coverage = marketCoverageFor({
    burst,
    statePools: pools,
    census: null,
    measuredByChain: new Map([
      ["base", 5],
      ["ethereum", 10],
    ]),
    chainIds: new Map([
      ["base", 8453],
      ["ethereum", 1],
    ]),
  });
  const eth = coverage.networks.find((n) => n.chain === "ethereum");
  assert.deepEqual(
    [eth.attemptedPools, eth.checkedPools, eth.measuredPools, eth.status],
    [0, 10, 10, "live"],
  );
});

const idsOf0 = (url) => url.split("/").at(-1).split(",");

test("a network GeckoTerminal was asked about and did not answer still has its statistics row, with nothing checked", async () => {
  const at = T0 - 3 * H;
  const ethereum = Array.from({ length: 4 }, (_, i) =>
    silent(200 + i, { chain: "ethereum", firstAgo: 20 * DAY, at, salt: "down" }),
  );
  const base = [answered(1, { lastAgo: H, at, salt: "down" })];
  const pools = [...base, ...ethereum];
  const plan = planLanes(pools, { nowMs: T0, updatedAtMs: T0 - 2 * 60000 });
  const { client, clock } = world(pools, {
    dex: (call, byId) => ({
      body: { pairs: idsOf0(call.url).map((id) => dexRow(byId.get(id))) },
    }),
    gecko: () => ({ status: 503 }),
  });
  const burst = await runBurst({
    client,
    plan,
    now: clock.now,
    known: pools,
    fallbackRequests: 1,
  });
  const row = burst.networks.find((n) => n.chain === "ethereum");
  assert.deepEqual(
    [row.requested, row.checked, row.measured],
    [0, 0, 0],
    "asked of GeckoTerminal, not answered",
  );
  assert.deepEqual(burst.telemetry.geckoterminal.failures, {
    total: 1,
    byReason: { "http-503": 1 },
  });
  assert.equal(burst.requestedPools, 1, "the gate's number is DEX Screener's");
});

test("the full plan's fallback takes the plan's own pools only, whatever the run knows", async () => {
  const planned = Array.from({ length: 3 }, (_, i) =>
    statePool(300 + i, { chain: "base", id: hashId(300 + i, "full") }),
  );
  const elsewhere = Array.from({ length: 3 }, (_, i) =>
    statePool(400 + i, { chain: "ethereum", id: hashId(400 + i, "full") }),
  );
  const plan = planBurst(planned);
  const { client, fetchImpl, clock } = world([...planned, ...elsewhere]);
  await runBurst({
    client,
    plan,
    now: clock.now,
    known: [...planned, ...elsewhere],
    fallbackRequests: 3,
  });
  const asked = fetchImpl.calls
    .filter((c) => c.url.includes("geckoterminal.com"))
    .flatMap((c) => idsOf(c.url));
  assert.deepEqual(
    asked.sort(),
    planned.map((pool) => pool.id).sort(),
    "ethereum's pools are not in the full plan",
  );
});

/* ── What is an error and what is a provider's answer ─────────────────────── */

/** A client whose GeckoTerminal requests fail as `fail(n)` says (n counts from 1).
 * DEX Screener answers every batch with nothing found. */
function failingClient(fail) {
  let n = 0;
  return {
    calls: [],
    isStopped: () => false,
    requestsLeft: () => 399,
    async getJson(provider, url) {
      if (provider === "dexscreener")
        return { data: { pairs: null }, observedAt: T0 };
      this.calls.push(url);
      throw fail(++n);
    },
  };
}

test("an error that is not a provider's answer is counted in status and the fallback goes on; a provider's failure is counted by its reason", async () => {
  const at = T0 - 3 * H;
  const pools = [
    ...Array.from({ length: 31 }, (_, i) =>
      answered(i + 1, { chain: "base", lastAgo: H, at, salt: "err" }),
    ),
    ...Array.from({ length: 31 }, (_, i) =>
      answered(50 + i, { chain: "ethereum", lastAgo: H, at, salt: "err" }),
    ),
  ];
  const plan = planLanes(pools, { nowMs: T0, updatedAtMs: at });
  // Not a provider's answer: a TypeError has no `code`. It must be visible, not
  // swallowed, and it must not stop the request after it or fail the burst.
  const defect = failingClient((n) =>
    n === 1
      ? new TypeError("Cannot read properties of undefined (reading 'x')")
      : new ProviderError("timeout", "slow"),
  );
  const clock = new FakeClock(T0);
  const burst = await runBurst({
    client: defect,
    plan,
    now: clock.now,
    known: pools,
    fallbackRequests: 3,
  });
  assert.equal(defect.calls.length, 3, "the requests after the defect were made");
  assert.equal(burst.telemetry.geckoterminal.errors.total, 1);
  assert.match(
    burst.telemetry.geckoterminal.errors.last,
    /^Cannot read properties of undefined/,
  );
  assert.deepEqual(burst.telemetry.geckoterminal.failures, {
    total: 2,
    byReason: { timeout: 2 },
  });
  assert.equal(burst.fallback.measured, 0);
  assert.equal(burst.fallback.requests, 3, "all three counted as requests sent");

  // A request that was never sent (the budget or a stopped provider) is neither.
  for (const code of ["budget", "stopped"]) {
    const unsent = failingClient(() => Object.assign(new Error("no"), { code }));
    const result = await runBurst({
      client: unsent,
      plan,
      now: new FakeClock(T0).now,
      known: pools,
      fallbackRequests: 3,
    });
    assert.equal(result.fallback.requests, 0, code);
    assert.equal(result.fallback.ids, 0, code);
    assert.equal(result.telemetry.geckoterminal.errors.total, 0, code);
    assert.equal(result.telemetry.geckoterminal.failures.total, 0, code);
    assert.equal(unsent.calls.length, 1, "and the burst stops asking");
  }
});

test("a provider's answer is told from a defect by what was thrown, not by having a string code: a Node system error is a defect, the client's ProviderError and the classifier's shape error are answers", async () => {
  // The rule itself.
  const code = (c) => Object.assign(new Error("x"), { code: c });
  assert.equal(isProviderAnswer(new ProviderError("timeout", "slow")), true);
  assert.equal(isProviderAnswer(new ProviderError("whatever-code", "x")), true, "any ProviderError");
  assert.equal(isProviderAnswer(code("shape")), true, "an answer of an unexpected shape");
  assert.equal(isProviderAnswer(code("ambiguous")), true, "an answer that names a pool twice");
  for (const defect of [
    code("ECONNRESET"),
    code("ERR_INVALID_URL"),
    code("timeout"), // a plain Error that only has the word: the client's own errors are ProviderErrors
    code("http"),
    new TypeError("x"),
    { code: "shape" }, // not an Error at all
    null,
    undefined,
    "shape",
  ])
    assert.equal(isProviderAnswer(defect), false, String(defect?.code ?? defect));

  // In a burst: the same requests, three kinds of failure.
  const at = T0 - 3 * H;
  const pools = [
    ...Array.from({ length: 31 }, (_, i) =>
      answered(i + 1, { chain: "base", lastAgo: H, at, salt: "split" }),
    ),
    ...Array.from({ length: 31 }, (_, i) =>
      answered(50 + i, { chain: "ethereum", lastAgo: H, at, salt: "split" }),
    ),
  ];
  const plan = planLanes(pools, { nowMs: T0, updatedAtMs: at });
  const failures = [
    code("ECONNRESET"), // a defect: counted in errors, not in failures
    new ProviderError("http", "HTTP 503", { status: 503 }),
    new ProviderError("network", "fetch failed"),
  ];
  const client = failingClient((n) => failures[n - 1]);
  const burst = await runBurst({
    client,
    plan,
    now: new FakeClock(T0).now,
    known: pools,
    fallbackRequests: 3,
  });
  assert.equal(burst.telemetry.geckoterminal.errors.total, 1);
  assert.match(burst.telemetry.geckoterminal.errors.last, /^x$/);
  assert.deepEqual(burst.telemetry.geckoterminal.failures, {
    total: 2,
    byReason: { "http-503": 1, network: 1 },
  });
  assert.equal(client.calls.length, 3, "the requests after the defect were made");

  // A real answer of the wrong shape goes through the classifier, which throws a
  // plain Error that carries the code `shape`: it is the provider's answer.
  const w = world(pools, { gecko: () => ({ body: { data: "not a list" } }) });
  const shaped = await runBurst({
    client: w.client,
    plan,
    now: w.clock.now,
    known: pools,
    fallbackRequests: 1,
  });
  assert.deepEqual(shaped.telemetry.geckoterminal.failures, {
    total: 1,
    byReason: { shape: 1 },
  });
  assert.deepEqual(shaped.telemetry.geckoterminal.errors, { total: 0, last: null });
});

test("the fallback's start rule counts a rate-limit cooldown: a wait that would end after 200 seconds stops GeckoTerminal, a shorter one is taken", async () => {
  const at = T0 - 3 * H;
  const pools = Array.from({ length: 70 }, (_, i) =>
    answered(i + 1, { chain: "base", lastAgo: H, at, salt: "late" }),
  );
  const plan = planLanes(pools, { nowMs: T0, updatedAtMs: at });
  const run = async (seconds) => {
    // The DEX Screener phase ends at 170 s: the first fallback request starts
    // then and is refused with a 429 that names a wait. The repeat goes out when
    // the wait is over and the lane's gap, doubled to 24 s, has passed.
    let first = true;
    const w = world(pools, {
      dex: () => {
        if (first) {
          first = false;
          w.clock.advance(170000);
        }
        return { body: { pairs: null } };
      },
      gecko: (call, wanted, n) =>
        n === 1
          ? { status: 429, headers: { "retry-after": String(seconds) }, body: "slow" }
          : { body: { data: wanted.map((pool) => geckoRow(pool)) } },
    });
    const burst = await runBurst({
      client: w.client,
      plan,
      now: w.clock.now,
      known: pools,
      fallbackRequests: 6,
    });
    return { burst, ...w };
  };
  // A wait of 5 s: the repeat starts at 194 s (170 s and the doubled gap), before
  // the rule: taken, and the same request is sent again.
  const taken = await run(5);
  assert.equal(
    taken.fetchImpl.calls.filter((c) => c.url.includes("/pools/multi/")).length,
    2,
    "the refused request and its repeat",
  );
  assert.equal(taken.burst.fallback.requests, 1, "one request of the burst");
  assert.equal(taken.client.isStopped("geckoterminal"), false);
  // A wait of 40 s would end at 210 s, after the rule: the provider is stopped and
  // nothing more is sent.
  const refused = await run(40);
  assert.equal(
    refused.fetchImpl.calls.filter((c) => c.url.includes("/pools/multi/")).length,
    1,
  );
  assert.equal(refused.client.isStopped("geckoterminal"), true);
  assert.match(
    refused.client.stats().geckoterminal.stopped.reason,
    /time allowed for this phase/,
  );
  assert.equal(refused.burst.telemetry.geckoterminal.failures.byReason["rate-limited"], 1);
});

/* ── The tiers and the rotation (collector/fallback.mjs) ─────────────────── */

const SIZE = config.GT_FALLBACK_BATCH_SIZE;
const cand = (pool) => ({ chain: chainOf(pool.chain), pool });
const placeOf = (pool) => Number.parseInt(pool.id.slice(-12), 16);
/** `count` pools on `chain` of one kind. `carried`: priced by GeckoTerminal last
 * time and answered an hour ago; `answered`: answered 10 days ago (no `via`);
 * `never`: never answered. */
function pack(kind, chain, count, from, at = T0) {
  return Array.from({ length: count }, (_, i) => {
    const n = from + i;
    const opts = { chain, at, salt: "tiers" };
    if (kind === "carried")
      return answered(n, { ...opts, lastAgo: H, via: "geckoterminal" });
    if (kind === "answered") return answered(n, { ...opts, lastAgo: 10 * DAY });
    return silent(n, { ...opts, firstAgo: 20 * DAY });
  });
}
const planOf = (pools, options = {}) =>
  planFallback({
    candidates: pools.map(cand),
    limit: 6,
    anchorMs: T0,
    nowMs: T0,
    ...options,
  });
const shape = (batches) =>
  batches.map((b) => [b.chain.chain, b.kind, b.pools.length]);

test("the constants of the fallback, and how its requests are divided: a third are the rotation's", () => {
  assert.equal(config.GT_FALLBACK_MAX_REQUESTS, 6, "the load is unchanged");
  assert.equal(config.FALLBACK_TIER0_MAX_REQUESTS, 8);
  assert.equal(config.FALLBACK_SWEEP_RESERVE_DIVISOR, 3);
  assert.equal(config.FALLBACK_SWEEP_OVERDUE_MS, DAY);
  const split = (limit) => {
    const { tier0, sweepReserve } = fallbackSplit(limit);
    return [tier0, sweepReserve];
  };
  assert.deepEqual(split(6), [4, 2], "six requests: four for tier 0, two reserved");
  assert.deepEqual(split(12), [8, 4], "twelve: eight and four");
  assert.deepEqual(split(20), [8, 6], "tier 0 never takes more than eight");
  assert.deepEqual(split(3), [2, 1]);
  assert.deepEqual(split(2), [2, 0]);
  assert.deepEqual(split(1), [1, 0]);
  assert.deepEqual(split(0), [0, 0]);
  assert.deepEqual(split(-4), [0, 0]);
  assert.deepEqual(split(Number.NaN), [0, 0]);
});

test("tier 0 comes first: the pools GeckoTerminal priced last time that answered in 72 hours, then the pools of a network DEX Screener does not index; the rotation has the rest", () => {
  const robinhood = pack("carried", "robinhood", 40, 1);
  const zora = pack("never", "zora", 5, 100);
  const base = [
    ...pack("answered", "base", 100, 200),
    ...pack("never", "base", 100, 400),
  ];
  const planned = planOf([...base, ...zora, ...robinhood], { unindexed: ["zora"] });
  // Robinhood's 40 are a full batch and a batch of 10 that the rotation fills up
  // from its own pools (Robinhood has 40 carried pools and no others, so there is
  // nothing to fill it with); Zora's 5 follow; the rotation has the rest.
  assert.deepEqual(shape(planned.batches), [
    ["robinhood", "tier0", 30],
    ["robinhood", "tier0", 10],
    ["zora", "tier0", 5],
    ["base", "sweep", 30],
    ["base", "sweep", 30],
    ["base", "sweep", 30],
  ]);
  assert.deepEqual(planned.available, { carried: 40, unindexed: 5, sweep: 200 });
  assert.deepEqual(planned.batches[2].tiers, Array(5).fill("unindexed"));
  assert.equal(planned.batches[0].bookmark, null, "tier 0 pools only: no bookmark");
  // Without a network DEX Screener answered 400 for, Zora's pools are the rotation's.
  const quiet = planOf([...base, ...zora, ...robinhood]);
  assert.equal(quiet.available.unindexed, 0);
  assert.ok(quiet.batches.every((b) => b.chain.chain !== "zora" || b.kind === "sweep"));
});

test("a tier 0 request with room is filled up from its network's rotation", () => {
  const carried = pack("carried", "robinhood", 40, 1);
  const others = [
    ...pack("answered", "robinhood", 30, 100),
    ...pack("never", "robinhood", 30, 200),
  ];
  const [full, partial] = planOf([...carried, ...others], { limit: 3 }).batches;
  assert.equal(full.pools.length, SIZE);
  assert.deepEqual(
    partial.tiers,
    [...Array(10).fill("carried"), ...Array(20).fill("sweep")],
    "the 10 carried pools left, then 20 of the rotation",
  );
  assert.equal(partial.kind, "tier0");
  assert.equal(partial.bookmark.at, Math.floor(T0 / H), "it moved the network's bookmark");
  // Half of what fills it from each kind.
  const carriedIds = new Set(carried.map((p) => p.id));
  const filled = partial.pools.filter((p) => !carriedIds.has(p.id));
  assert.equal(filled.filter((p) => p.lastSeen > p.firstSeen).length, 10);
});

test("what carried means: priced by GeckoTerminal last time, answered since, and inside 72 hours; and nothing else is", () => {
  const at = T0;
  const carried = answered(1, { lastAgo: 2 * H, at, via: "geckoterminal", salt: "c" });
  const old = answered(2, { lastAgo: 80 * H, at, via: "geckoterminal", salt: "c" });
  // First seen a day ago, inside the 72 hours: only "answered since it was first
  // seen" can keep it out (a pool whose state says GeckoTerminal because a hint put
  // it there, and that no provider has priced).
  const neverAnswered = silent(3, { firstAgo: DAY, at, via: "geckoterminal", salt: "c" });
  const longSilent = silent(6, { firstAgo: 5 * DAY, at, via: "geckoterminal", salt: "c" });
  const dexScreener = answered(4, { lastAgo: 2 * H, at, salt: "c" });
  assert.equal(isGeckoCarried(carried, at), true);
  assert.equal(isGeckoCarried(old, at), false, "answered 80 hours ago");
  assert.equal(isGeckoCarried(neverAnswered, at), false, "its state says GeckoTerminal, but it never answered");
  assert.equal(isGeckoCarried(longSilent, at), false, "never answered, first seen 5 days ago");
  assert.equal(isGeckoCarried(dexScreener, at), false, "priced by DEX Screener");
  // 71 hours 59 minutes is inside, 72 hours is not.
  const edge = (age) => answered(5, { lastAgo: age, at, via: "geckoterminal", salt: "c" });
  assert.equal(isGeckoCarried(edge(72 * H - 60000), at), true);
  assert.equal(isGeckoCarried(edge(72 * H), at), false);
  const planned = planOf([carried, old, neverAnswered, dexScreener]);
  assert.deepEqual(planned.available, { carried: 1, unindexed: 0, sweep: 3 });
  assert.equal(planned.batches[0].tiers[0], "carried");
});

test("tier 0 is capped (four requests at six, eight at twelve) and the pools it has no room for join the rotation", () => {
  // 300 carried pools on Robinhood need ten requests.
  const robinhood = pack("carried", "robinhood", 300, 1);
  const six = planOf(robinhood);
  assert.equal(six.batches.length, 6);
  assert.deepEqual(
    six.batches.map((b) => b.kind),
    ["tier0", "tier0", "tier0", "tier0", "sweep", "sweep"],
    "four requests for tier 0, the reserved two for the rotation",
  );
  assert.equal(six.available.carried, 300);
  // The pools tier 0 had no room for are the rotation's: they are not lost.
  assert.equal(six.available.sweep, 300 - 4 * SIZE);
  const twelve = planOf(pack("carried", "robinhood", 500, 1), { limit: 12 });
  assert.deepEqual(
    twelve.batches.map((b) => b.kind),
    [...Array(8).fill("tier0"), ...Array(4).fill("sweep")],
  );
  // The pools tier 0 takes are the most recently answered.
  const recent = pack("carried", "robinhood", 30, 1000).map((pool) => ({
    ...pool,
    lastSeen: iso(T0 - 30 * 60000),
  }));
  const mixed = planOf([...robinhood, ...recent], { limit: 3 });
  assert.deepEqual(
    new Set(mixed.batches[0].pools.map((pool) => pool.id)),
    new Set(recent.map((pool) => pool.id)),
    "the newest answers are asked first",
  );
  // Below three requests nothing is reserved: they are all tier 0's.
  assert.deepEqual(planOf(robinhood, { limit: 3 }).batches.map((b) => b.kind), ["tier0", "tier0", "sweep"]);
  assert.deepEqual(planOf(robinhood, { limit: 2 }).batches.map((b) => b.kind), ["tier0", "tier0"]);
  assert.deepEqual(planOf(robinhood, { limit: 0 }).batches, []);
});

test("tier 0 opens its requests by the size of a network's block: with more networks than requests the biggest block is never the one left out, whatever the pools' times", () => {
  // The state a rotation that works leads to: pools GeckoTerminal priced on many
  // networks. Robinhood's 76 carried pools need three requests; seven networks,
  // 145 pools in all, have four tier 0 requests (six, a third reserved) between them.
  const sizes = { robinhood: 76, bnb: 22, optimism: 16, polygon: 11, arbitrum: 8, monad: 5, xlayer: 7 };
  const world145 = (seed) => {
    let s = seed;
    const random = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
    let n = 1;
    return Object.entries(sizes).flatMap(([chain, count]) =>
      Array.from({ length: count }, () =>
        answered(n++, {
          chain,
          // Robinhood is restamped once a day, the small networks were found in the
          // last hours: the times are different on purpose, and random.
          lastAgo: Math.floor((chain === "robinhood" ? 24 : 6) * random() * H) + 60000,
          at: T0,
          via: "geckoterminal",
          salt: "block" + seed,
        }),
      ),
    );
  };
  const carriedAsked = (batches, chain) =>
    batches
      .filter((b) => !chain || b.chain.chain === chain)
      .flatMap((b) => b.tiers)
      .filter((tier) => tier === "carried").length;
  for (let seed = 1; seed <= 50; seed++) {
    const { batches, available } = planOf(world145(seed));
    assert.equal(available.carried, 145);
    assert.equal(
      carriedAsked(batches, "robinhood"),
      76,
      "seed " + seed + ": the biggest block is asked whole, in every draw",
    );
    // Robinhood 30 + 30 + 16, then BNB's 22: four requests, 98 pools.
    assert.deepEqual(
      batches.filter((b) => b.kind === "tier0").map((b) => [b.chain.chain, b.pools.length]),
      [["robinhood", 30], ["robinhood", 30], ["robinhood", 16], ["bnb", 22]],
      "seed " + seed,
    );
    assert.equal(carriedAsked(batches), 98, "seed " + seed);
  }
  // The order does not depend on which pool answered last: the same sizes, the
  // times reversed, give the same networks; inside a network the newest come first.
  const first = world145(7);
  const flipped = first.map((pool) => ({
    ...pool,
    lastSeen: iso(T0 - (25 * H - (T0 - Date.parse(pool.lastSeen)))),
  }));
  assert.deepEqual(
    planOf(first).batches.map((b) => b.chain.chain),
    planOf(flipped).batches.map((b) => b.chain.chain),
  );
  const rh = planOf(first).batches[0].pools;
  assert.ok(
    rh.every((pool, i) => i === 0 || Date.parse(rh[i - 1].lastSeen) >= Date.parse(pool.lastSeen)),
    "the newest answers of a network are asked first",
  );
  // A tie in size goes to the slug, so the same pools always give the same requests.
  const tie = ["monad", "bnb", "celo"].flatMap((chain, i) => pack("carried", chain, 10, 100 * (i + 1)));
  assert.deepEqual(
    planOf(tie, { limit: 2 }).batches.map((b) => b.chain.chain),
    ["bnb", "celo"],
  );
  // The pools of a network DEX Screener answered 400 for are ordered the same way,
  // after the carried ones: the larger network first.
  const unindexed = [
    ...pack("never", "zora", 4, 1),
    ...pack("never", "tempo", 9, 100),
    ...pack("carried", "base", 5, 300),
  ];
  assert.deepEqual(
    planOf(unindexed, { unindexed: ["zora", "tempo"], limit: 3 }).batches.map((b) => [b.chain.chain, b.kind]),
    [["base", "tier0"], ["tempo", "tier0"], ["zora", "sweep"]],
    "carried first; of the unindexed, the network with more pools; two requests for tier 0 at three",
  );
  const wide = planOf(unindexed, { unindexed: ["zora", "tempo"], limit: 6 }).batches
    .filter((b) => b.kind === "tier0")
    .map((b) => b.chain.chain);
  assert.deepEqual(wide, ["base", "tempo", "zora"]);
});

test("a rotation request is half pools that answered before and half that never did", () => {
  const answeredBefore = pack("answered", "base", 100, 1);
  const never = pack("never", "base", 100, 500);
  const [batch] = planOf([...answeredBefore, ...never], { limit: 1 }).batches;
  assert.equal(batch.kind, "sweep");
  assert.equal(batch.pools.length, SIZE);
  const answeredIds = new Set(answeredBefore.map((p) => p.id));
  assert.equal(batch.pools.filter((p) => answeredIds.has(p.id)).length, 15);
  // A kind that has fewer than its half leaves the rest to the other.
  const few = planOf([...pack("answered", "base", 4, 1), ...never], { limit: 1 }).batches[0];
  assert.equal(few.pools.filter((p) => p.lastSeen > p.firstSeen).length, 4);
  assert.equal(few.pools.length, SIZE);
  assert.equal(planOf(never, { limit: 1 }).batches[0].pools.length, SIZE);
  assert.equal(planOf(answeredBefore, { limit: 1 }).batches[0].pools.length, SIZE);
  // A network with fewer pools than a batch holds is asked in one request, whole.
  const small = planOf(pack("never", "celo", 7, 900), { limit: 1 }).batches[0];
  assert.equal(small.pools.length, 7);
  assert.equal(new Set(small.pools.map((p) => p.id)).size, 7, "none twice");
});

/** Runs the rotation of one network over and over, the bookmark written back after
 * each request, and returns the pools in the order they were asked. */
function sweepOver(pools, requests) {
  let bookmarks = {};
  const order = [];
  for (let i = 0; i < requests; i++) {
    const { batches } = planFallback({
      candidates: pools.map(cand),
      limit: 1,
      anchorMs: T0,
      nowMs: T0 + i * H,
      bookmarks,
    });
    for (const batch of batches) {
      order.push(...batch.pools.map((pool) => pool.id));
      bookmarks = { ...bookmarks, [batch.chain.chain]: batch.bookmark };
    }
  }
  return order;
}

test("the rotation goes round: every pool is asked once before any is asked twice, and the bookmark is where it resumes", () => {
  const answeredBefore = pack("answered", "base", 45, 1);
  const never = pack("never", "base", 45, 500);
  const pools = [...answeredBefore, ...never];
  // 45 pools of each kind, 15 of each kind in a request: three requests are a round.
  const round = sweepOver(pools, 3);
  assert.equal(new Set(round).size, 90, "three requests ask about all 90, once");
  const twice = sweepOver(pools, 6);
  assert.deepEqual(twice.slice(0, 90), round);
  assert.deepEqual(twice.slice(90), round, "the second round is the first again");
  // It resumes after the pool it stopped at: the bookmark is that pool's place.
  const first = planOf(pools, { limit: 1 }).batches[0];
  const sorted = [...never].sort((a, b) => placeOf(a) - placeOf(b));
  assert.equal(first.bookmark.p, placeOf(sorted[14]));
  // The bookmark holds two places and an hour, in the shape the header allows.
  assert.deepEqual(Object.keys(first.bookmark).sort(), ["at", "p", "q"]);
  assert.equal(isCursors({ gt: { base: first.bookmark } }), true);
  // A pool added after the bookmark was written is reached in its turn; one that was
  // measured meanwhile (no longer a candidate) is simply not there.
  const added = silent(9999, { chain: "base", firstAgo: DAY, at: T0, salt: "tiers" });
  const later = planFallback({
    candidates: [...pools.slice(1), added].map(cand),
    limit: 1,
    anchorMs: T0,
    nowMs: T0 + H,
    bookmarks: { base: first.bookmark },
  }).batches[0];
  assert.equal(later.pools.length, SIZE);
  assert.ok(!later.pools.some((pool) => first.pools.some((p) => p.id === pool.id)));
  // A bookmark that is not a number is ignored: the rotation starts over.
  const bad = planFallback({
    candidates: pools.map(cand),
    limit: 1,
    anchorMs: T0,
    nowMs: T0,
    bookmarks: { base: { p: "x", q: -1, at: Number.NaN } },
  }).batches[0];
  assert.deepEqual(bad.pools.map((p) => p.id), first.pools.map((p) => p.id));
});

test("which network the next request goes to: the longest overdue first (a network never visited is the longest), then by the hours since the visit times the requests its pools need", () => {
  const nowHour = Math.floor(T0 / H);
  const make = (chain, count, from) => pack("never", chain, count, from);
  const pools = [
    ...make("base", 300, 1), // needs 10 requests
    ...make("ethereum", 60, 400), // needs 2
    ...make("arc", 20, 800), // needs 1
    ...make("ink", 20, 900), // needs 1
  ];
  const slugs = (bookmarks, limit) =>
    planFallback({
      candidates: pools.map(cand),
      limit,
      anchorMs: T0,
      nowMs: T0,
      bookmarks,
    }).batches.map((b) => b.chain.chain);
  const visited = (hoursAgo) => ({ at: nowHour - hoursAgo, p: 1, q: 1 });
  // None has been visited: all are the longest overdue; the larger first, then the slug.
  assert.deepEqual(slugs({}, 4), ["base", "ethereum", "arc", "ink"]);
  // Everything visited under a day ago: by hours x requests needed. Base 5 h x 10 =
  // 50, Ethereum 20 h x 2 = 40, Arc 22 h x 1 = 22, Ink 3 h x 1 = 3.
  assert.deepEqual(
    slugs({ base: visited(5), ethereum: visited(20), arc: visited(22), ink: visited(3) }, 4),
    ["base", "ethereum", "arc", "ink"],
  );
  // A small network a day overdue goes before a large one visited a few hours ago,
  // although its product is the smaller.
  assert.deepEqual(
    slugs({ base: visited(23), ethereum: visited(5), arc: visited(24), ink: visited(2) }, 2),
    ["arc", "base"],
    "24 hours is overdue; 23 is not",
  );
  // The longest overdue first.
  assert.deepEqual(
    slugs({ base: visited(30), ethereum: visited(50), arc: visited(40), ink: visited(26) }, 3),
    ["ethereum", "arc", "base"],
  );
  // A network served in this run counts as visited now: two networks that are
  // equally due get one request each, not two for one.
  assert.equal(new Set(slugs({ base: visited(30), ethereum: visited(30) }, 2)).size, 2);
  // Only when no other network has pools does one get a second request, and they
  // are different pools.
  const alone = planFallback({
    candidates: make("base", 300, 1).map(cand),
    limit: 3,
    anchorMs: T0,
    nowMs: T0,
  });
  assert.deepEqual(alone.batches.map((b) => b.chain.chain), ["base", "base", "base"]);
  const ids = alone.batches.flatMap((b) => b.pools.map((p) => p.id));
  assert.equal(new Set(ids).size, ids.length);
});

test("the same state gives the same requests, whatever the order the pools come in", () => {
  const pools = [
    ...pack("carried", "robinhood", 45, 1),
    ...pack("answered", "base", 80, 100),
    ...pack("never", "base", 80, 300),
    ...pack("never", "ethereum", 50, 500),
    ...pack("never", "zora", 6, 700),
  ];
  const bookmarks = { base: { p: 123456789, q: 987654321, at: 4000 } };
  const ask = (list) =>
    JSON.stringify(
      planFallback({
        candidates: list.map(cand),
        limit: 6,
        anchorMs: T0,
        nowMs: T0,
        unindexed: ["zora"],
        bookmarks,
      }).batches.map((b) => [b.chain.chain, b.kind, b.pools.map((p) => p.id), b.bookmark]),
    );
  const reference = ask(pools);
  assert.equal(ask([...pools].sort((a, b) => placeOf(b) - placeOf(a))), reference);
  assert.equal(ask([...pools].reverse()), reference);
});

test("every network with pools is visited within a day when the runs are hourly, and the larger ones are visited more often", () => {
  const sizes = {
    robinhood: 800,
    base: 500,
    ethereum: 300,
    arc: 60,
    ink: 40,
    unichain: 30,
    bnb: 25,
    optimism: 20,
    polygon: 15,
    monad: 12,
    arbitrum: 10,
    celo: 2,
  };
  let from = 1;
  const pools = Object.entries(sizes).flatMap(([chain, count], index) => {
    const made = pack(index % 2 ? "answered" : "never", chain, count, from);
    from += count;
    return made;
  });
  let bookmarks = {};
  const visits = new Map();
  const count = new Map();
  const worstGap = new Map();
  const runs = 24 * 10;
  for (let r = 0; r < runs; r++) {
    const now = T0 + r * H;
    const { batches } = planFallback({
      candidates: pools.map(cand),
      limit: 6,
      anchorMs: now,
      nowMs: now,
      bookmarks,
    });
    for (const batch of batches) {
      if (!batch.bookmark) continue;
      const slug = batch.chain.chain;
      const before = visits.get(slug);
      if (before !== undefined)
        worstGap.set(slug, Math.max(worstGap.get(slug) ?? 0, (now - before) / H));
      visits.set(slug, now);
      count.set(slug, (count.get(slug) ?? 0) + 1);
      bookmarks = { ...bookmarks, [slug]: batch.bookmark };
    }
  }
  for (const slug of Object.keys(sizes)) {
    assert.ok(visits.has(slug), slug + " was visited");
    assert.ok((worstGap.get(slug) ?? 0) <= 24, slug + " waited " + worstGap.get(slug) + " h");
  }
  // Requests beyond the daily visit follow the size of the network.
  assert.ok(count.get("robinhood") > count.get("arc"));
  assert.ok(count.get("base") > count.get("unichain"));
  assert.ok(count.get("arc") >= count.get("celo"));
});

test("the rotation's work is the bookmark's: a request that failed moves none, and later requests for the same network do not skip it", async () => {
  const at = T0 - 3 * H;
  const ethereum = Array.from({ length: 100 }, (_, i) =>
    silent(100 + i, { chain: "ethereum", firstAgo: 20 * DAY, at, salt: "bm" }),
  );
  const base = [answered(1, { lastAgo: H, at, salt: "bm" })];
  const pools = [...base, ...ethereum];
  const lanes = planLanes(pools, { nowMs: T0, updatedAtMs: T0 - 2 * 60000 });
  const run = async (fail) => {
    const w = world(pools, {
      dex: (call, byId) => ({
        body: { pairs: idsOf0(call.url).map((id) => dexRow(byId.get(id))) },
      }),
      gecko: (call, wanted, n) =>
        fail.has(n)
          ? { status: 503 }
          : { body: { data: wanted.map((pool) => geckoRow(pool)) } },
    });
    return runBurst({
      client: w.client,
      plan: lanes,
      now: w.clock.now,
      known: pools,
      fallbackRequests: 3,
    });
  };
  // Three requests to Ethereum, all answered: the bookmark is that of the last.
  const ok = await run(new Set());
  const okMoved = ok.fallback.bookmarks.ethereum;
  assert.equal(okMoved.at, Math.floor(T0 / H));
  assert.deepEqual(ok.telemetry.geckoterminal.fallback.bookmarksMoved, ["ethereum"]);
  // The first request failed: the bookmarks of the later ones assume it was
  // answered, so none is written and the pools of the first are asked again.
  const first = await run(new Set([1]));
  assert.equal(first.fallback.bookmarks.ethereum, undefined);
  assert.deepEqual(first.telemetry.geckoterminal.fallback.bookmarksMoved, []);
  // The last failed: the bookmark is that of the one before it.
  const last = await run(new Set([3]));
  assert.notDeepEqual(last.fallback.bookmarks.ethereum, okMoved);
  assert.ok(last.fallback.bookmarks.ethereum.p !== undefined);
  // None answered: nothing moves.
  assert.deepEqual((await run(new Set([1, 2, 3]))).fallback.bookmarks, {});
});

/* ── A run ───────────────────────────────────────────────────────────────── */

const HOOK_ROW = {
  hook: {
    address: address(9990),
    chainId: 8453,
    chain: "base",
    name: "SomeHook",
    description: "A test deployment",
    verifiedSource: true,
  },
  properties: { dynamicFee: false, upgradeable: false },
};
const hook = HOOK_ROW.hook.address.toLowerCase();

/** One run of the collector over a scratch state, DEX Screener pricing the pools
 * in `live` and GeckoTerminal answering for every pool it is asked about. */
async function collectOnce({ dir, pools, saved, now, live, historyPools = 60, cursors = {} }) {
  const state = join(dir, "state");
  await mkdir(state, { recursive: true });
  const clock = new FakeClock(now);
  const byId = new Map(pools.map((pool) => [pool.id, pool]));
  const fetchImpl = fakeFetch(clock, (call) => {
    const url = call.url;
    if (url === REGISTRY_URL) return { body: [HOOK_ROW] };
    if (url === CHAINS_URL)
      return { body: { base: { chainId: 8453 }, ethereum: { chainId: 1 } } };
    if (url === FRONTIER_URL) return { body: [] };
    if (url.startsWith("https://api.dexscreener.com/latest/dex/pairs/")) {
      const rows = idsOf0(url)
        .filter((id) => live.has(id) && byId.has(id))
        .map((id) => dexRow(byId.get(id)));
      return { body: { pairs: rows.length ? rows : null } };
    }
    if (url.includes("/pools/multi/"))
      return {
        body: {
          data: idsOf(url)
            .filter((id) => byId.has(id))
            .map((id) => geckoRow(byId.get(id))),
        },
      };
    return { status: 404, body: {} };
  });
  await writeFile(join(state, "pools.json"), poolsJson(iso(saved), pools, cursors));
  await writeFile(
    join(state, "history.json"),
    historyJson([{ timestamp: saved, value: 1000, pools: historyPools }]),
  );
  const result = await runCollector({
    stateDir: state,
    outDir: join(dir, "data"),
    stateOutDir: join(dir, "next"),
    minCurrent: 20,
    maxDiscovery: 0,
    fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
    env: { GITHUB_REPOSITORY: "owner/hook-radar" },
  });
  return { result, fetchImpl, next: join(dir, "next") };
}

test("a run writes the rotation's bookmarks into the header of pools.json, and the pools GeckoTerminal priced are carried by the next run, not asked of DEX Screener every run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "collector-gt-"));
  try {
    const saved = T0 - 3 * H;
    const mk = (n, spec) => ({ ...spec, hookAddress: hook, id: hashId(n, "e2e") });
    const hot = Array.from({ length: 60 }, (_, i) =>
      mk(i + 1, answered(i + 1, { chain: "base", lastAgo: (i % 20) * H, at: saved })),
    );
    const baseCold = Array.from({ length: 60 }, (_, i) =>
      mk(100 + i, silent(100 + i, { chain: "base", firstAgo: 20 * DAY, at: saved })),
    );
    const ethereum = Array.from({ length: 90 }, (_, i) =>
      mk(300 + i, silent(300 + i, { chain: "ethereum", firstAgo: 20 * DAY, at: saved })),
    );
    const pools = [...hot, ...baseCold, ...ethereum];
    const live = new Set(hot.map((pool) => pool.id));

    // Run 1: DEX Screener prices the 60 HOT pools; GeckoTerminal is asked about the
    // 150 pools that never answered, in the rotation (nothing is carried yet).
    const one = await collectOnce({ dir, pools, saved, now: T0, live });
    assert.equal(one.result.ok, true, one.result.quality.failures.join("; "));
    const first = one.result.status.counts.geckoterminal;
    assert.equal(first.fallback.mode, "tiers");
    assert.deepEqual(first.fallback.requests, { tier0: 0, sweep: 5, ordered: 0 });
    assert.deepEqual(first.fallback.idsAsked, { carried: 0, unindexed: 0, sweep: 150, ordered: 0 });
    assert.deepEqual(first.fallback.measured, { carried: 0, unindexed: 0, sweep: 150, ordered: 0 });
    assert.equal(first.measured, 150, "pools measured in this snapshot");
    assert.deepEqual(first.fallback.pricedLastTime, { known: 0, measuredNow: 0 });
    assert.deepEqual(first.fallback.bookmarksMoved, ["base", "ethereum"]);
    assert.equal(one.result.status.counts.cursors.families, 1);
    assert.equal(one.result.status.counts.cursors.refused, null);
    // The header of the saved pools.json carries the bookmarks.
    const afterOne = await readState(one.next);
    assert.deepEqual(Object.keys(afterOne.cursors), ["gt"]);
    assert.deepEqual(Object.keys(afterOne.cursors.gt).sort(), ["base", "ethereum"]);
    for (const row of Object.values(afterOne.cursors.gt))
      assert.equal(row.at, Math.floor(T0 / H));
    // The pools GeckoTerminal priced are remembered as such, and stamped answered.
    const priced = afterOne.pools.filter((pool) => pool.via === "geckoterminal");
    assert.equal(priced.length, 150);
    assert.ok(priced.every((pool) => pool.lastSeen > pool.firstSeen));
    assert.equal(
      one.fetchImpl.calls.filter((c) => c.url.includes("/pools/multi/")).length,
      5,
    );

    // Run 2, an hour later, from the state run 1 saved.
    const saved2 = Date.parse(one.result.snapshot.generatedAt);
    const dir2 = await mkdtemp(join(tmpdir(), "collector-gt-"));
    try {
      const two = await collectOnce({
        dir: dir2,
        pools: afterOne.pools,
        cursors: afterOne.cursors,
        saved: saved2,
        now: T0 + H,
        live,
        historyPools: one.result.status.counts.currentPools,
      });
      assert.equal(two.result.ok, true, two.result.quality.failures.join("; "));
      const counts = two.result.status.counts;
      const gt = counts.geckoterminal;
      // Now the 150 pools are carried: tier 0 takes its four requests (120 pools),
      // the rotation the two that are reserved.
      assert.deepEqual(gt.fallback.split, { tier0: 4, sweepReserve: 2 });
      assert.equal(gt.fallback.requests.tier0, 4);
      // The 30 carried pools tier 0 had no room for are the rotation's, in one request
      // per network they sit on; the two reserved requests are not all needed.
      assert.equal(gt.fallback.idsAsked.sweep, 30);
      assert.ok(gt.fallback.requests.sweep >= 1 && gt.fallback.requests.sweep <= 2);
      assert.equal(gt.fallback.idsAsked.carried, 120);
      assert.equal(gt.fallback.available.carried, 150);
      assert.equal(gt.fallback.measured.carried, 120, "pools measured in this snapshot");
      assert.deepEqual(gt.fallback.pricedLastTime.known, 150);
      assert.ok(gt.fallback.pricedLastTime.measuredNow >= 120);
      // They are not HOT: DEX Screener asks about them on the 3-hour wheel.
      assert.equal(counts.lanes.hot.known, 60);
      assert.equal(counts.lanes.warm.known, 150);
      assert.equal(counts.plan.geckoCarried, 150);
      assert.ok(counts.lanes.warm.scheduled < 150);
      // The DEX Screener note says so, in the page's words.
      const note = two.result.status.sources.find((s) => s.id === "dexscreener").note;
      assert.match(
        note,
        /The 150 pools GeckoTerminal priced that answered in the last 72 hours are asked about here every 3 hours, and GeckoTerminal is asked about the ones not priced here first in each run, as many as its requests allow\./,
      );
      const noteOne = one.result.status.sources.find((s) => s.id === "dexscreener").note;
      assert.doesNotMatch(noteOne, /GeckoTerminal priced/);
    } finally {
      await rm(dir2, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ── The lanes and the pools GeckoTerminal carries ───────────────────────── */

test("a pool GeckoTerminal priced last time that answered in 72 hours is not HOT: it is on DEX Screener's 3-hour wheel, and GeckoTerminal's tier 0 asks about it first in each run", () => {
  const at = T0 - 3 * H;
  const viaGecko = answered(1, { lastAgo: 2 * H, at, via: "geckoterminal", salt: "lane" });
  const viaDex = { ...viaGecko, via: undefined };
  delete viaDex.via;
  const never = silent(2, { firstAgo: 5 * H, at, via: "geckoterminal", salt: "lane" });
  const stale = answered(3, { lastAgo: 80 * H, at, via: "geckoterminal", salt: "lane" });
  assert.equal(laneOf(viaGecko, T0), "warm");
  assert.equal(laneOf(viaDex, T0), "hot", "the same pool priced by DEX Screener");
  assert.equal(laneOf(never, T0), "new", "its state says GeckoTerminal, but it never answered");
  assert.equal(laneOf(stale, T0), "warm", "answered 80 hours ago: WARM by its age");
  // It is asked of DEX Screener only when the wheel brings it due, not in every run.
  const pools = Array.from({ length: 40 }, (_, i) =>
    answered(10 + i, { lastAgo: 2 * H, at, via: "geckoterminal", salt: "wheel" }),
  );
  const short = planLanes(pools, { nowMs: T0, updatedAtMs: T0 - 20 * 60000 });
  assert.equal(short.lanes.hot.known, 0);
  assert.equal(short.lanes.warm.known, 40);
  assert.ok(short.lanes.warm.scheduled < 40, "only the pools due on the wheel");
  const long = planLanes(pools, { nowMs: T0, updatedAtMs: T0 - 3 * H });
  assert.equal(long.lanes.warm.scheduled, 40, "a window of a period asks them all");
});

test("the safeguard counts the pools GeckoTerminal carries with HOT and NEW: they are asked about in every run too", () => {
  const at = T0 - 3 * H;
  const carried = Array.from({ length: 100 }, (_, i) =>
    answered(i + 1, { lastAgo: 2 * H, at, via: "geckoterminal", salt: "floor" }),
  );
  const previousPoint = { timestamp: at, value: 1, pools: 100 };
  const lanes = decidePlanMode({ pools: carried, nowMs: T0, updatedAtMs: at, previousPoint });
  assert.equal(lanes.mode, "lanes", "100 carried pools are 100 pools asked in every run");
  assert.equal(lanes.hotAndNew, 0);
  assert.equal(lanes.geckoCarried, 100);
  // The earlier meaning is unchanged: the same pools, priced by DEX Screener, are HOT.
  const hot = carried.map(({ via: _via, ...pool }) => pool);
  const same = decidePlanMode({ pools: hot, nowMs: T0, updatedAtMs: at, previousPoint });
  assert.equal(same.hotAndNew, 100);
  assert.equal(same.geckoCarried, 0);
  // Too few of them is still too few: 100 against a floor of 0.9 x 200.
  const below = decidePlanMode({
    pools: carried,
    nowMs: T0,
    updatedAtMs: at,
    previousPoint: { ...previousPoint, pools: 200 },
  });
  assert.equal(below.mode, "full");
  assert.equal(below.code, "below-floor");
  assert.match(below.detail, /would ask about 100 pools that answered or are new, fewer than 180/);
});

test("the DEX Screener note mentions the pools GeckoTerminal carries when there are some, and says nothing otherwise", () => {
  const base = { asked: 100, known: 200, ceilingBound: false, maxBatches: 220 };
  assert.doesNotMatch(lanePlanNote({ ...base, geckoCarried: 0 }), /GeckoTerminal/);
  assert.doesNotMatch(lanePlanNote(base), /GeckoTerminal/, "a caller that does not say");
  const note = lanePlanNote({ ...base, geckoCarried: 1234 });
  assert.match(
    note,
    /every 12 hours\)\. The 1,234 pools GeckoTerminal priced that answered in the last 72 hours are asked about here every 3 hours, and GeckoTerminal is asked about the ones not priced here first in each run, as many as its requests allow\. A pool that was not asked is unchecked/,
  );
});

test("the dry run says how many pools GeckoTerminal carries, and the run's status says so too", () => {
  const at = T0 - 3 * H;
  const pools = [
    ...Array.from({ length: 30 }, (_, i) =>
      answered(i + 1, { lastAgo: 2 * H, at, via: "geckoterminal", salt: "dry" }),
    ),
    ...Array.from({ length: 30 }, (_, i) =>
      answered(100 + i, { lastAgo: 2 * H, at, salt: "dry" }),
    ),
  ];
  const state = {
    updatedAt: iso(at),
    pools,
    priority: null,
    history: [{ timestamp: at, value: 1, pools: 60 }],
  };
  const report = dryRun(state, 1);
  assert.equal(report.mode, "lanes");
  assert.equal(report.geckoCarried, 30);
  assert.equal(report.hotAndNew, 30);
  assert.equal(report.lanes.warm.known, 30);
  const text = formatReport(report).join("\n");
  assert.match(text, /30 of the WARM pools were priced by GeckoTerminal and answered in the last 72 h/);
  // A state with none says nothing about it.
  const none = dryRun({ ...state, pools: pools.slice(30) }, 1);
  assert.doesNotMatch(formatReport(none).join("\n"), /priced by GeckoTerminal/);
});
