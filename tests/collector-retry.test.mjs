import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAINS_URL, FRONTIER_URL, REGISTRY_URL } from "../server/model.mjs";
import { providerSources, retryNote } from "../collector/assemble.mjs";
import * as config from "../collector/config.mjs";
import { createHttpClient } from "../collector/http.mjs";
import {
  planBurst,
  planLanes,
  retryableFailure,
  runBurst,
} from "../collector/measure.mjs";
import { runCollector } from "../collector/run.mjs";
import { historyJson, poolsJson } from "../collector/state.mjs";
import {
  address,
  blockNetwork,
  dexRow,
  FakeClock,
  statePool,
} from "../collector/testing.mjs";

blockNetwork();

// A DEX Screener batch that failed is asked again once. Everything runs on made-up
// pools and a scripted provider: nothing reaches a provider and nothing is written
// outside a scratch folder.

const H = 3600000;
const DAY = 24 * H;
const T0 = Date.parse("2026-11-12T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const hashId = (n, salt = "retry") =>
  `0x${createHash("sha256").update(`${salt}:${n}`).digest("hex")}`;
const poolsOf = (chain, count, from, salt) =>
  Array.from({ length: count }, (_, i) =>
    statePool(from + i, { chain, id: hashId(from + i, salt ?? chain) }),
  );
const idsOf = (url) => url.split("/").at(-1).split(",");
const networkOf = (url) => url.split("/").at(-2);

/** A fetch that answers from `handler(call, n)`: a reply (`status`, `body`,
 * `headers`), `{ network: true }` (the connection fails) or `{ hang: true }` (it
 * never answers, so the client's own timeout ends it). Records the calls. */
function scriptedFetch(clock, handler) {
  const calls = [];
  const impl = async (url, options = {}) => {
    const call = { url: String(url), at: clock.now() };
    calls.push(call);
    const reply = await handler(call, calls.length);
    if (reply.network) throw new TypeError("fetch failed");
    if (reply.hang)
      return new Promise((_, reject) =>
        options.signal.addEventListener("abort", () =>
          reject(new Error("aborted")),
        ),
      );
    const body =
      reply.body === undefined
        ? "{}"
        : typeof reply.body === "string"
          ? reply.body
          : JSON.stringify(reply.body);
    return new Response(body, {
      status: reply.status ?? 200,
      headers: {
        "content-type": "application/json",
        date: new Date(clock.now()).toUTCString(),
        ...(reply.headers ?? {}),
      },
    });
  };
  impl.calls = calls;
  return impl;
}

/** A burst over `pools` with a DEX Screener that prices every pool it is asked
 * about, except where `script({ network, n, all, ids, call })` says otherwise
 * (n counts the network's requests from 1, all every DEX Screener request). */
async function burstOver(pools, script = () => null, options = {}) {
  const byId = new Map(pools.map((pool) => [pool.id, pool]));
  const counts = new Map();
  let all = 0;
  const clock = new FakeClock(T0);
  const fetchImpl = scriptedFetch(clock, (call) => {
    if (!call.url.includes("dexscreener.com")) return { body: { data: [] } };
    const network = networkOf(call.url);
    const n = (counts.get(network) ?? 0) + 1;
    counts.set(network, n);
    all++;
    const ids = idsOf(call.url);
    return (
      script({ network, n, all, ids, call, clock, byId }) ?? {
        body: { pairs: ids.map((id) => dexRow(byId.get(id))) },
      }
    );
  });
  const { timeoutMs, maxRequests, plan = planBurst(pools), ...rest } = options;
  const client = createHttpClient({
    fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
    userAgent: "Test/1 (+https://github.com/example/repo)",
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(maxRequests ? { maxRequests } : {}),
  });
  const burst = await runBurst({
    client,
    plan,
    now: clock.now,
    fallbackRequests: 0,
    ...rest,
  });
  const dex = fetchImpl.calls.filter((c) => c.url.includes("dexscreener.com"));
  return { burst, client, fetchImpl, clock, dex, plan };
}

/* ── What is retried ─────────────────────────────────────────────────────── */

test("a retryable failure is a network error, a timeout, an answer that is not JSON or not of the right shape, an HTTP 5xx or a 408; nothing else is", () => {
  const code = (c, extra = {}) => ({ code: c, ...extra });
  for (const error of [
    code("network"),
    code("timeout"),
    code("json"),
    code("shape"),
    code("http", { status: 500 }),
    code("http", { status: 502 }),
    code("http", { status: 503 }),
    code("http", { status: 599 }),
    code("http", { status: 408 }),
  ])
    assert.equal(retryableFailure(error), true, JSON.stringify(error));
  for (const error of [
    // The client owns the cooldown after a 429, and a 403 stops the provider.
    code("rate-limited", { status: 429 }),
    code("forbidden", { status: 403 }),
    code("http", { status: 429 }),
    code("http", { status: 403 }),
    // The first answer of a network that DEX Screener does not index, and every
    // other 4xx.
    code("http", { status: 400 }),
    code("http", { status: 404 }),
    code("http", { status: 410 }),
    code("http", { status: 600 }),
    code("http"),
    // Answers that will not change, and requests that were never sent.
    code("size"),
    code("ambiguous"),
    code("age"),
    code("clock"),
    code("accept"),
    code("url"),
    code("budget"),
    code("stopped"),
    // A defect has no code.
    new TypeError("x"),
    null,
    undefined,
  ])
    assert.equal(retryableFailure(error), false, JSON.stringify(error));
});

test("the numbers of the retry: eight a run, none after 150 seconds, and the worst case stays inside every limit", () => {
  assert.equal(config.RETRY_MAX_BATCHES, 8);
  assert.equal(config.RETRY_BURST_LIMIT_MS, 150000);
  // The last retry starts before 150 s and may take the 20 s a request may take: it
  // ends before the fallback's last start (200 s) and Frontier's (240 s).
  assert.ok(
    config.RETRY_BURST_LIMIT_MS + config.REQUEST_TIMEOUT_MS <
      config.FALLBACK_LATEST_START_MS,
  );
  assert.ok(config.RETRY_BURST_LIMIT_MS < config.BURST_BUDGET_MS);
  // The worst case of a lane plan (registry 3, discovery 80, the plan's ceiling and
  // the room for what discovery adds, the fallback, Frontier, the 7D and 30D step) is
  // 342; eight retries take it to 350, under the 399-request limit.
  const worst =
    3 +
    80 +
    config.LANE_MAX_BATCHES +
    config.LANE_DISCOVERED_RESERVE_BATCHES +
    config.GT_FALLBACK_MAX_REQUESTS +
    config.FRONTIER_MAX_REQUESTS +
    config.DAILY_MAX_REQUESTS;
  assert.equal(worst, 342);
  assert.ok(worst + config.RETRY_MAX_BATCHES <= config.MAX_REQUESTS_PER_RUN);
});

/* ── A failed batch is asked again once ──────────────────────────────────── */

test("a batch that failed with an HTTP 500 is asked again once and recovers: every pool is answered, and the pools are counted once", async () => {
  const pools = poolsOf("base", 90, 1000);
  const { burst, client, dex } = await burstOver(pools, ({ n }) =>
    n === 2 ? { status: 500 } : null,
  );
  assert.equal(dex.length, 4, "three batches and the repeat of the second");
  assert.equal(dex[3].url, dex[1].url, "the same request");
  assert.equal(burst.measured.size, 90, "the repeat measured the 30 pools");
  // The pools are counted once, as asked and as answered.
  assert.equal(burst.requestedPools, 90);
  assert.equal(burst.requestedKeys.size, 90);
  assert.equal(burst.answeredPools, 90);
  assert.equal(burst.checkedPools, 90);
  assert.equal(burst.networks[0].requested, 90);
  assert.equal(burst.networks[0].checked, 90);
  assert.equal(burst.networks[0].measured, 90);
  // The batches are the batches asked; the repeat is a request of the client.
  assert.equal(burst.dexRequests, 3);
  assert.equal(burst.telemetry.dexscreener.batches, 3);
  assert.equal(burst.telemetry.dexscreener.poolsAsked, 90);
  assert.equal(client.stats().dexscreener.requests, 4);
  assert.equal(client.requestCount(), 4);
  // The first failure is still counted where it was: it failed when it was asked.
  assert.equal(burst.networks[0].failedBatches, 1);
  assert.deepEqual(burst.telemetry.dexscreener.failedBatches, {
    total: 1,
    byReason: { "http-500": 1 },
  });
  assert.deepEqual(burst.telemetry.dexscreener.retry, {
    maxBatches: 8,
    burstLimitMs: 150000,
    failedFirstPass: 1,
    retried: 1,
    recovered: 1,
    stillFailed: 0,
    notRetried: {},
    networks: { recovered: ["base"], stillFailed: [] },
    stillFailedBatches: [],
    error: null,
  });
});

test("every kind of retryable failure recovers on the second try", async () => {
  const kinds = {
    "http-500": () => ({ status: 500 }),
    "http-502": () => ({ status: 502 }),
    "http-503": () => ({ status: 503 }),
    "http-408": () => ({ status: 408 }),
    network: () => ({ network: true }),
    timeout: () => ({ hang: true }),
    json: () => ({ body: "<html>bad gateway</html>" }),
    shape: () => ({ body: { pairs: "nope" } }),
  };
  for (const [reason, fail] of Object.entries(kinds)) {
    const pools = poolsOf("base", 60, 1000);
    const { burst, dex } = await burstOver(
      pools,
      ({ n }) => (n === 1 ? fail() : null),
      { timeoutMs: 15 },
    );
    assert.equal(dex.length, 3, reason + ": two batches and one repeat");
    assert.equal(burst.measured.size, 60, reason);
    assert.deepEqual(burst.telemetry.dexscreener.failedBatches.byReason, { [reason]: 1 }, reason);
    const { retry } = burst.telemetry.dexscreener;
    assert.deepEqual(
      [retry.failedFirstPass, retry.retried, retry.recovered, retry.stillFailed],
      [1, 1, 1, 0],
      reason,
    );
  }
});

test("a batch that fails again is still failed: its pools are unanswered, the failure is recorded in status, and it is not asked a third time", async () => {
  const pools = poolsOf("base", 90, 1000);
  const { burst, dex } = await burstOver(pools, ({ n }) =>
    n === 2 || n === 4 ? { status: 503 } : null,
  );
  assert.equal(dex.length, 4, "asked once and once again");
  assert.equal(burst.measured.size, 60);
  assert.equal(burst.requestedPools, 90);
  assert.equal(burst.answeredPools, 60, "the unanswered batch is not counted as answered");
  assert.equal(burst.checkedPools, 60);
  const { retry, failedBatches } = burst.telemetry.dexscreener;
  assert.equal(failedBatches.total, 1, "the first-pass failures: the repeat is not another");
  assert.deepEqual(
    [retry.failedFirstPass, retry.retried, retry.recovered, retry.stillFailed],
    [1, 1, 0, 1],
  );
  assert.deepEqual(retry.networks, { recovered: [], stillFailed: ["base"] });
  assert.deepEqual(retry.stillFailedBatches, [
    { chain: "base", pools: 30, reason: "http-503", retried: true },
  ]);
});

test("a batch that failed in a different way the second time reports the second reason", async () => {
  const pools = poolsOf("base", 30, 1000);
  const { burst } = await burstOver(pools, ({ n }) =>
    n === 1 ? { status: 500 } : { network: true },
  );
  assert.deepEqual(burst.telemetry.dexscreener.failedBatches.byReason, {
    "http-500": 1,
  });
  assert.equal(burst.telemetry.dexscreener.retry.stillFailedBatches[0].reason, "network");
});

/* ── What is never asked again ───────────────────────────────────────────── */

test("a 429, a 403, an HTTP 400 and the other failures that would not change are not asked again", async () => {
  // The first 429 that says how long to wait is the client's own cooldown (one
  // repeat after the wait); a second one stops the provider. A 403 stops it at
  // once. Neither is asked a third time by the burst.
  const limited = (seconds) => ({
    status: 429,
    headers: { "retry-after": String(seconds) },
    body: "slow down",
  });
  const pools = poolsOf("base", 90, 1000);
  const rate = await burstOver(pools, ({ all }) => (all >= 2 ? limited(3) : null));
  assert.equal(rate.client.isStopped("dexscreener"), true);
  assert.equal(rate.dex.length, 3, "one batch, the refused one, its cooldown repeat; no more");
  assert.equal(rate.burst.telemetry.dexscreener.retry.retried, 0);
  assert.equal(rate.burst.telemetry.dexscreener.retry.stillFailed, 1);
  assert.deepEqual(rate.burst.telemetry.dexscreener.retry.notRetried, { "not-retryable": 1 });

  const forbidden = await burstOver(pools, ({ all }) => (all === 2 ? { status: 403 } : null));
  assert.equal(forbidden.client.isStopped("dexscreener"), true);
  assert.equal(forbidden.dex.length, 2);
  assert.equal(forbidden.burst.telemetry.dexscreener.retry.retried, 0);

  // An HTTP 400 as the first answer of a network: it is not indexed. Not asked again.
  const unindexed = await burstOver(pools, () => ({ status: 400, body: "bad" }));
  assert.deepEqual(unindexed.burst.unsupportedNetworks, ["base"]);
  assert.equal(unindexed.dex.length, 1, "the other batches are not sent and the first is not repeated");
  assert.equal(unindexed.burst.telemetry.dexscreener.retry.retried, 0);

  // A 400 after the network has answered is an ordinary failed batch, and not a
  // retryable one; a 404 is not either.
  for (const status of [400, 404]) {
    const later = await burstOver(pools, ({ n }) => (n === 2 ? { status } : null));
    assert.equal(later.dex.length, 3, "HTTP " + status);
    assert.equal(later.burst.measured.size, 60);
    assert.equal(later.burst.telemetry.dexscreener.retry.retried, 0);
    assert.deepEqual(later.burst.telemetry.dexscreener.retry.notRetried, {
      "not-retryable": 1,
    });
  }

  // An answer that names a pool twice would be the same again.
  const ambiguous = await burstOver(poolsOf("base", 30, 5000), ({ ids, byId }) => ({
    body: { pairs: [dexRow(byId.get(ids[0])), dexRow(byId.get(ids[0]))] },
  }));
  assert.equal(ambiguous.dex.length, 1);
  assert.deepEqual(ambiguous.burst.telemetry.dexscreener.failedBatches.byReason, { ambiguous: 1 });
  assert.equal(ambiguous.burst.telemetry.dexscreener.retry.retried, 0);
  assert.deepEqual(ambiguous.burst.telemetry.dexscreener.retry.notRetried, { "not-retryable": 1 });
});

test("a network DEX Screener does not index is not a batch that failed: it is in neither the retry's counts nor its sentence, and it still counts as a failed batch where it happened", async () => {
  const names = new Map([
    ["base", "Base"],
    ["tempo", "Tempo"],
    ["xlayer", "X Layer"],
  ]);
  const pools = [
    ...poolsOf("base", 90, 1000),
    ...poolsOf("tempo", 30, 5000),
    ...poolsOf("xlayer", 60, 8000),
  ];
  const notIndexed = ({ network }) =>
    network === "tempo" || network === "xlayer" ? { status: 400, body: "bad" } : null;

  // Only the 400 networks fail: nothing failed that could be asked again.
  const only = await burstOver(pools, notIndexed);
  assert.deepEqual([...only.burst.unsupportedNetworks].sort(), ["tempo", "xlayer"]);
  assert.equal(only.dex.length, 3 + 1 + 1, "Base's three batches, one for each unindexed network, no repeat");
  const none = only.burst.telemetry.dexscreener;
  assert.deepEqual(
    [none.retry.failedFirstPass, none.retry.retried, none.retry.recovered, none.retry.stillFailed],
    [0, 0, 0, 0],
  );
  assert.deepEqual(none.retry.notRetried, {});
  assert.deepEqual(none.retry.networks, { recovered: [], stillFailed: [] });
  assert.deepEqual(none.retry.stillFailedBatches, []);
  assert.equal(none.retry.error, null);
  assert.equal(retryNote(none.retry, names), "", "no sentence about batches that failed");
  // Where it happened it is still a failed batch, with its reason, as before.
  assert.deepEqual(none.failedBatches, { total: 2, byReason: { "http-400": 2 } });
  assert.equal(only.burst.networks.find((n) => n.chain === "tempo").failedBatches, 1);
  // And the DEX Screener source says which networks it does not index, and nothing of failed batches.
  const only400Note = providerSources({
    stats: {
      dexscreener: { requests: only.dex.length, firstRequestAt: T0, lastRequestAt: T0, stopped: null },
      geckoterminal: { requests: 0 },
      v4xyz: { requests: 0 },
    },
    measured: new Map(),
    discovery: {},
    census: null,
    registrySources: [],
    chains: [...names].map(([slug, name]) => ({ slug, name })),
    unsupportedNetworks: only.burst.unsupportedNetworks,
    dexRetry: none.retry,
  }).find((source) => source.id === "dexscreener").note;
  assert.match(only400Note, /Does not index: Tempo, X Layer\./);
  assert.doesNotMatch(only400Note, /failed|second try/);

  // A real failure beside them: one batch of Base fails and recovers. Only that
  // one is in the sentence; the two networks that are not indexed are not.
  const mixed = await burstOver(pools, (call) =>
    notIndexed(call) ?? (call.network === "base" && call.n === 2 ? { status: 500 } : null),
  );
  const retry = mixed.burst.telemetry.dexscreener.retry;
  assert.deepEqual(
    [retry.failedFirstPass, retry.retried, retry.recovered, retry.stillFailed],
    [1, 1, 1, 0],
  );
  assert.deepEqual(retry.networks, { recovered: ["base"], stillFailed: [] });
  assert.deepEqual(retry.notRetried, {});
  assert.equal(retryNote(retry, names), " 1 batch failed, 1 recovered on a second try.");
  assert.deepEqual(mixed.burst.telemetry.dexscreener.failedBatches, {
    total: 3,
    byReason: { "http-400": 2, "http-500": 1 },
  });
  assert.deepEqual([...mixed.burst.unsupportedNetworks].sort(), ["tempo", "xlayer"]);

  // And one that fails again: the sentence names that network and not the two that
  // are not indexed.
  const stuck = await burstOver(pools, (call) =>
    notIndexed(call) ??
    (call.network === "base" && (call.n === 2 || call.n === 4) ? { status: 503 } : null),
  );
  const again = stuck.burst.telemetry.dexscreener.retry;
  assert.deepEqual(
    [again.failedFirstPass, again.retried, again.recovered, again.stillFailed],
    [1, 1, 0, 1],
  );
  assert.equal(
    retryNote(again, names),
    " 1 batch failed, 0 recovered on a second try. Still failed: Base.",
  );
  // A 400 after the network had answered is a batch that failed, and not retryable:
  // that one is counted, as it always was.
  const later = await burstOver(pools, (call) =>
    notIndexed(call) ?? (call.network === "base" && call.n === 2 ? { status: 400 } : null),
  );
  const afterAnswer = later.burst.telemetry.dexscreener.retry;
  assert.deepEqual(
    [afterAnswer.failedFirstPass, afterAnswer.retried, afterAnswer.stillFailed],
    [1, 0, 1],
  );
  assert.deepEqual(afterAnswer.notRetried, { "not-retryable": 1 });
  assert.equal(
    retryNote(afterAnswer, names),
    " 1 batch failed, 0 recovered on a second try. Still failed: Base.",
  );
});

test("at most eight batches are asked again in a run, the others are left and say why", async () => {
  // Twelve batches fail among 25; a success between each keeps the provider going.
  const pools = poolsOf("base", 25 * 30, 1000);
  const { burst, dex } = await burstOver(pools, ({ n }) =>
    n <= 24 && n % 2 === 1 ? { status: 500 } : null,
  );
  assert.equal(dex.length, 25 + 8, "25 batches and eight repeats");
  const { retry } = burst.telemetry.dexscreener;
  assert.deepEqual(
    [retry.failedFirstPass, retry.retried, retry.recovered, retry.stillFailed],
    [12, 8, 8, 4],
  );
  assert.deepEqual(retry.notRetried, { limit: 4 });
  assert.equal(retry.stillFailedBatches.length, 4);
  assert.ok(retry.stillFailedBatches.every((b) => b.retried === false));
  assert.equal(burst.measured.size, 25 * 30 - 4 * 30);
  // The cap is a parameter, so a test and the contract see the same number.
  const none = await burstOver(poolsOf("base", 90, 1000), ({ n }) => (n === 1 ? { status: 500 } : null), {
    retryBatches: 0,
  });
  assert.equal(none.dex.length, 3, "no retries when the limit is 0");
  assert.equal(none.burst.telemetry.dexscreener.retry.retried, 0);
  assert.deepEqual(none.burst.telemetry.dexscreener.retry.notRetried, { limit: 1 });
});

test("the batches of the pools that answer are asked again first: HOT before the others, then in the order they failed", async () => {
  const at = T0 - 3 * H;
  const answered = (chain, count, from) =>
    Array.from({ length: count }, (_, i) =>
      statePool(from + i, {
        chain,
        id: hashId(from + i, "lane" + chain),
        firstSeen: iso(at - 30 * DAY),
        lastSeen: iso(at - H),
      }),
    );
  const cold = (chain, count, from) =>
    Array.from({ length: count }, (_, i) =>
      statePool(from + i, {
        chain,
        id: hashId(from + i, "lane" + chain),
        firstSeen: iso(at - 20 * DAY),
        lastSeen: iso(at - 20 * DAY),
      }),
    );
  // Ethereum has 60 COLD pools and Base 30 HOT ones; the larger network goes first
  // in a round, so Ethereum's batch fails before Base's.
  const pools = [...cold("ethereum", 60, 100), ...answered("base", 30, 500)];
  const plan = planLanes(pools, { nowMs: T0, updatedAtMs: T0 - 24 * H });
  assert.equal(plan.lanes.cold.scheduled, 60, "a day-long window asks the whole lane");
  assert.deepEqual(plan.networks.map((n) => n.chain.chain), ["ethereum", "base"]);
  const { dex, burst } = await burstOver(
    pools,
    ({ network, n }) => (n === 1 ? { status: 500 } : null),
    { plan, retryBatches: 1 },
  );
  // One retry: the HOT batch (Base), not the COLD one that failed first.
  const repeated = dex.slice(-1)[0];
  assert.equal(networkOf(repeated.url), "base");
  assert.equal(burst.telemetry.dexscreener.retry.retried, 1);
  assert.deepEqual(burst.telemetry.dexscreener.retry.networks, {
    recovered: ["base"],
    stillFailed: ["ethereum"],
  });
  assert.equal(burst.telemetry.dexscreener.retry.notRetried.limit, 1);
});

/* ── The limits it keeps ─────────────────────────────────────────────────── */

test("a retry is a request of the 399: it is not sent when the run has no requests left beyond the fallback's and Frontier's", async () => {
  const pools = poolsOf("base", 90, 1000);
  // Three batches and the reserve (6 + 3) leave nothing for a retry at 12 requests,
  // and one at 13.
  const tight = await burstOver(pools, ({ n }) => (n === 1 ? { status: 500 } : null), {
    maxRequests: 12,
    fallbackRequests: 6,
  });
  assert.equal(tight.dex.length, 3);
  assert.equal(tight.burst.telemetry.dexscreener.retry.retried, 0);
  assert.deepEqual(tight.burst.telemetry.dexscreener.retry.notRetried, { requests: 1 });
  const room = await burstOver(pools, ({ n }) => (n === 1 ? { status: 500 } : null), {
    maxRequests: 13,
    fallbackRequests: 6,
  });
  assert.equal(room.dex.length, 4);
  assert.equal(room.burst.telemetry.dexscreener.retry.recovered, 1);
  // With the client's own hard stop the burst can never go past the limit.
  assert.ok(room.client.requestCount() <= 13);
});

test("no retry starts after 150 seconds into the burst, and a wait that would end after it is refused", async () => {
  const pools = poolsOf("base", 90, 1000);
  // The first batch fails at 151 s: the burst is too late for a retry.
  const late = await burstOver(pools, ({ n, clock }) => {
    if (n !== 1) return null;
    clock.advance(151000);
    return { status: 500 };
  });
  assert.equal(late.dex.length, 3);
  assert.equal(late.burst.telemetry.dexscreener.retry.retried, 0);
  assert.deepEqual(late.burst.telemetry.dexscreener.retry.notRetried, { time: 1 });
  // At 149 s it is not too late.
  const early = await burstOver(pools, ({ n, clock }) => {
    if (n !== 1) return null;
    clock.advance(100000);
    return { status: 500 };
  });
  assert.equal(early.dex.length, 4);
  // The last batch fails at 100 s with a 503 that asks for a 100 s wait: the repeat
  // could only start at 200 s, after the retry limit. The client does not send it,
  // and it is not a request.
  const waiting = await burstOver(pools, ({ n, clock }) => {
    if (n !== 3) return null;
    clock.advance(100000);
    return { status: 503, headers: { "retry-after": "100" } };
  });
  assert.equal(waiting.dex.length, 3, "the repeat is not sent");
  assert.equal(waiting.burst.telemetry.dexscreener.retry.retried, 0);
  assert.equal(waiting.burst.telemetry.dexscreener.retry.stillFailed, 1);
  assert.deepEqual(waiting.burst.telemetry.dexscreener.retry.notRetried, { "not-sent": 1 });
  assert.equal(waiting.client.stats().dexscreener.requests, 3);
  // The retry does not move the oldest measurement: the burst ended inside the time
  // the five-minute rule allows.
  assert.ok(waiting.burst.endedAt - waiting.burst.startedAt < 300000 - 20000);
});

test("when DEX Screener has been stopped no retry is made", async () => {
  // Five failures in a row stop the provider: the failed batches are not asked again.
  const pools = poolsOf("base", 6 * 30, 1000);
  const { burst, dex, client } = await burstOver(pools, () => ({ status: 500 }));
  assert.equal(client.isStopped("dexscreener"), true);
  assert.equal(dex.length, 5);
  assert.equal(burst.telemetry.dexscreener.retry.retried, 0);
  assert.deepEqual(burst.telemetry.dexscreener.retry.notRetried, { stopped: 5 });
  assert.equal(burst.telemetry.dexscreener.retry.stillFailed, 5);
});

test("a retry does not change a network's standing: a network that only had a failed batch recovered is not down, and a network that is down stays down", async () => {
  const base = poolsOf("base", 60, 1000);
  const eth = poolsOf("ethereum", 60, 3000);
  // Ethereum's first batch fails and is repeated; Base is answered.
  const once = await burstOver([...base, ...eth], ({ network, n }) =>
    network === "ethereum" && n === 1 ? { status: 500 } : null,
  );
  assert.deepEqual(once.burst.downNetworks, []);
  assert.equal(once.burst.measured.size, 120);
  // Five batches of Base fail in a row (the rest are not sent); a retry that answers
  // one of them does not make the network answer: it stays on the list.
  const bigBase = poolsOf("base", 8 * 30, 7000);
  const down = await burstOver([...bigBase, ...eth], ({ network, n }) =>
    network === "base" && n <= 5 ? { status: 500 } : null,
  );
  assert.deepEqual(down.burst.downNetworks, ["base"]);
  assert.equal(down.burst.telemetry.dexscreener.retry.recovered, 5);
  assert.equal(down.burst.measured.size, 5 * 30 + 60);
});

test("a traced pool whose batch was recovered shows the answer of the second try", async () => {
  const pools = poolsOf("base", 30, 1000);
  const key = `base:${pools[0].id}`;
  const { burst } = await burstOver(pools, ({ n }) => (n === 1 ? { status: 500 } : null), {
    trace: new Set([key]),
  });
  assert.equal(burst.trace.get(key).dexscreener.outcome, "value");
});

/* ── What a run says about it ────────────────────────────────────────────── */

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

async function runOnce(answer, extraEnv = {}) {
  const dir = await mkdtemp(join(tmpdir(), "collector-retry-"));
  try {
    const saved = T0 - 3 * H;
    const pools = Array.from({ length: 270 }, (_, i) =>
      statePool(i + 1, {
        id: hashId(i + 1, "run"),
        chain: "base",
        hookAddress: HOOK_ROW.hook.address.toLowerCase(),
        firstSeen: iso(saved - 30 * DAY),
        lastSeen: iso(saved - (i % 20) * H),
      }),
    );
    const byId = new Map(pools.map((pool) => [pool.id, pool]));
    const state = join(dir, "state");
    await mkdir(state, { recursive: true });
    await writeFile(join(state, "pools.json"), poolsJson(iso(saved), pools));
    await writeFile(
      join(state, "history.json"),
      historyJson([{ timestamp: saved, value: 1000, pools: 250 }]),
    );
    const clock = new FakeClock(T0);
    let batch = 0;
    const fetchImpl = scriptedFetch(clock, (call) => {
      const url = call.url;
      if (url === REGISTRY_URL) return { body: [HOOK_ROW] };
      if (url === CHAINS_URL) return { body: { base: { chainId: 8453 } } };
      if (url === FRONTIER_URL) return { body: [] };
      if (url.startsWith("https://api.dexscreener.com/latest/dex/pairs/")) {
        batch++;
        const special = answer(batch);
        if (special) return special;
        return {
          body: { pairs: idsOf(url).map((id) => dexRow(byId.get(id))) },
        };
      }
      return { status: 404, body: {} };
    });
    const result = await runCollector({
      stateDir: state,
      outDir: join(dir, "data"),
      stateOutDir: join(dir, "next"),
      minCurrent: 20,
      maxDiscovery: 0,
      fetchImpl,
      now: clock.now,
      sleep: clock.sleep,
      env: { GITHUB_REPOSITORY: "owner/hook-radar", ...extraEnv },
    });
    return { result, fetchImpl };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a run publishes what failed and what recovered, in status and in the DEX Screener note, and a clean run says nothing of it", async () => {
  const clean = await runOnce(() => null);
  assert.equal(clean.result.ok, true, clean.result.quality.failures.join("; "));
  const cleanRetry = clean.result.status.counts.dexscreener.retry;
  assert.deepEqual(
    [cleanRetry.failedFirstPass, cleanRetry.retried, cleanRetry.recovered, cleanRetry.stillFailed],
    [0, 0, 0, 0],
  );
  const note = (run) =>
    run.result.status.sources.find((s) => s.id === "dexscreener").note;
  assert.doesNotMatch(note(clean), /failed/);

  // One batch fails and recovers.
  const recovered = await runOnce((n) => (n === 2 ? { status: 502 } : null));
  assert.equal(recovered.result.ok, true, recovered.result.quality.failures.join("; "));
  const retry = recovered.result.status.counts.dexscreener.retry;
  assert.deepEqual(
    [retry.failedFirstPass, retry.retried, retry.recovered, retry.stillFailed],
    [1, 1, 1, 0],
  );
  assert.deepEqual(retry.networks, { recovered: ["base"], stillFailed: [] });
  assert.match(note(recovered), /1 batch failed, 1 recovered on a second try\./);
  assert.doesNotMatch(note(recovered), /still failed/);
  // The requests are in the client's count: three batches (plus the repeat).
  const requests = recovered.result.status.counts.requests;
  assert.equal(requests.dexscreener, recovered.result.status.counts.dexscreener.batches + 1);
  assert.equal(recovered.result.status.counts.requestedPools, recovered.result.status.counts.answeredPools);

  // One batch fails twice (the ninth request is the repeat of the second batch): the
  // run still passes the unchanged gates and says so.
  const failed = await runOnce((n) => (n === 2 || n === 10 ? { status: 502 } : null));
  assert.equal(failed.result.ok, true, failed.result.quality.failures.join("; "));
  assert.match(note(failed), /1 batch failed, 0 recovered on a second try\. Still failed: Base\./);
  const stuck = failed.result.status.counts.dexscreener.retry;
  assert.equal(stuck.stillFailed, 1);
  assert.equal(stuck.stillFailedBatches[0].chain, "base");
});

test("COLLECTOR_RETRY_MAX_BATCHES can lower the retry and switch it off, and never raises it: the run reads it and says what limit it used", async () => {
  const fail = (n) => (n === 2 ? { status: 502 } : null);
  const used = async (value) => {
    const run = await runOnce(fail, value === undefined ? {} : { COLLECTOR_RETRY_MAX_BATCHES: value });
    assert.equal(run.result.ok, true, run.result.quality.failures.join("; "));
    return run.result.status.counts.dexscreener.retry;
  };
  const normal = await used(undefined);
  assert.deepEqual([normal.maxBatches, normal.retried, normal.recovered], [8, 1, 1]);
  // Never more than the contract's eight.
  for (const value of ["8", "9", "500", "", "x", "-1"]) {
    const retry = await used(value);
    assert.equal(retry.maxBatches, 8, String(value));
    assert.equal(retry.recovered, 1, String(value));
  }
  const one = await used("1");
  assert.deepEqual([one.maxBatches, one.retried, one.recovered], [1, 1, 1]);
  // 0 switches the retry off: the batch that failed is left, and the run says so.
  const off = await runOnce(fail, { COLLECTOR_RETRY_MAX_BATCHES: "0" });
  assert.equal(off.result.ok, true, off.result.quality.failures.join("; "));
  const retry = off.result.status.counts.dexscreener.retry;
  assert.deepEqual(
    [retry.maxBatches, retry.failedFirstPass, retry.retried, retry.recovered, retry.stillFailed],
    [0, 1, 0, 0, 1],
  );
  assert.deepEqual(retry.notRetried, { limit: 1 });
  assert.equal(
    off.fetchImpl.calls.filter((c) => c.url.includes("dexscreener.com")).length,
    off.result.status.counts.dexscreener.batches,
    "no request beyond the plan's own batches",
  );
  const note = off.result.status.sources.find((s) => s.id === "dexscreener").note;
  assert.match(note, /1 batch failed, 0 recovered on a second try\. Still failed: Base\./);
});

test("the DEX Screener note names the batches that failed, in the words of the page", () => {
  const stats = (requests) => ({
    dexscreener: { requests, firstRequestAt: T0, lastRequestAt: T0, stopped: null },
    geckoterminal: { requests: 0 },
    v4xyz: { requests: 0 },
  });
  const make = (retry) =>
    providerSources({
      stats: stats(4),
      measured: new Map(),
      discovery: {},
      census: null,
      registrySources: [],
      chains: [{ slug: "base", name: "Base" }, { slug: "ethereum", name: "Ethereum" }],
      dexRetry: retry,
    }).find((source) => source.id === "dexscreener").note;
  const none = { failedFirstPass: 0, recovered: 0, stillFailed: 0, networks: { recovered: [], stillFailed: [] } };
  assert.doesNotMatch(make(none), /failed/);
  assert.doesNotMatch(make(null), /failed/);
  assert.match(make({ ...none, failedFirstPass: 3, recovered: 3 }), /3 batches failed, 3 recovered on a second try\./);
  assert.match(
    make({ ...none, failedFirstPass: 2, recovered: 1, stillFailed: 1, networks: { recovered: ["base"], stillFailed: ["ethereum", "base"] } }),
    /2 batches failed, 1 recovered on a second try\. Still failed: Base, Ethereum\./,
  );
});

test("a defect in the retry step is counted and the burst goes on", async () => {
  // A client whose count of requests left cannot be read: the retry step throws.
  const pools = poolsOf("base", 60, 1000);
  const byId = new Map(pools.map((pool) => [pool.id, pool]));
  let sent = 0;
  const client = {
    isStopped: () => false,
    requestsLeft() {
      throw new TypeError("requestsLeft is broken");
    },
    async getJson(provider, url) {
      if (provider !== "dexscreener") throw Object.assign(new Error("x"), { code: "stopped" });
      if (++sent === 1) throw Object.assign(new Error("HTTP 500"), { code: "http", status: 500 });
      return {
        data: { pairs: idsOf(url).map((id) => dexRow(byId.get(id))) },
        observedAt: T0,
      };
    },
  };
  const clock = new FakeClock(T0);
  const burst = await runBurst({
    client,
    plan: planBurst(pools),
    now: clock.now,
    fallbackRequests: 0,
  });
  const { retry } = burst.telemetry.dexscreener;
  assert.equal(retry.error, "requestsLeft is broken");
  assert.equal(retry.retried, 0);
  assert.equal(retry.failedFirstPass, 1);
  assert.equal(retry.stillFailed, 1);
  assert.equal(burst.measured.size, 30, "the batch that answered is kept");
  assert.equal(burst.requestedPools, 60);
});
