import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectPublishedData } from "../scripts/check-edition-data.mjs";
import { CHAINS_URL, FRONTIER_URL, REGISTRY_URL } from "../server/model.mjs";
import * as config from "../collector/config.mjs";
import { providerSources } from "../collector/assemble.mjs";
import {
  createHttpClient,
  ProviderError,
  retryAfterMs,
} from "../collector/http.mjs";
import { planBurst, runBurst } from "../collector/measure.mjs";
import { assessQuality } from "../collector/quality.mjs";
import { runCollector } from "../collector/run.mjs";
import { poolsJson } from "../collector/state.mjs";
import {
  address,
  blockNetwork,
  dexRow,
  FakeClock,
  fakeFetch,
  statePool,
} from "../collector/testing.mjs";

blockNetwork();

// How the collector behaves when a provider says "slow down" (HTTP 429) or does
// not index a network (HTTP 400). Every test runs on a fake clock and a fake
// fetch; none reaches a provider.

const DS = "https://api.dexscreener.com/latest/dex/pairs/base/";
const GT = "https://api.geckoterminal.com/api/v2/networks/base/dexes";
const V4 = "https://www.v4.xyz/api/pools?chainId=8453";
const RAW = "https://raw.githubusercontent.com/Uniswap/hooklist/main/list.json";
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

/** Answers call n with replies[n - 1]; anything after the list succeeds. */
const scripted =
  (replies, rest = { body: {} }) =>
  (call, n) =>
    replies[n - 1] ?? rest;

const limited = (seconds, extra = {}) => ({
  status: 429,
  headers: { "retry-after": String(seconds) },
  body: "slow down",
  ...extra,
});

test("the rate-limit numbers are the ones the design states", () => {
  const pinned = {
    RATE_LIMIT_WAIT_CAP_MS: 90000,
    RATE_LIMIT_DEFAULT_WAIT_MS: 30000,
    // Unchanged: other statuses with a Retry-After, and the breaker.
    MAX_RETRY_AFTER_MS: 120000,
    MAX_CONSECUTIVE_FAILURES: 5,
    MAX_REQUESTS_PER_RUN: 399,
    BURST_BUDGET_MS: 225000,
    BURST_DEADLINE_MS: 270000,
  };
  for (const [name, value] of Object.entries(pinned))
    assert.equal(config[name], value, name);
  assert.deepEqual(
    [...config.COOLDOWN_PROVIDERS],
    ["dexscreener", "geckoterminal", "v4xyz"],
  );
  // One cooldown at its longest fits the time a burst may start requests in.
  assert.ok(config.RATE_LIMIT_WAIT_CAP_MS < config.BURST_BUDGET_MS);
  assert.ok(config.RATE_LIMIT_DEFAULT_WAIT_MS <= config.RATE_LIMIT_WAIT_CAP_MS);
});

test("COLLECTOR_RETRY_AFTER_CAP_MS can shorten the longest wait and never lengthen it", () => {
  const cap = (value) =>
    config.resolveRateLimitCap({ COLLECTOR_RETRY_AFTER_CAP_MS: value });
  assert.equal(config.resolveRateLimitCap({}), 90000);
  assert.equal(cap("30000"), 30000);
  assert.equal(cap("0"), 0);
  assert.equal(cap("1500.7"), 1500);
  assert.equal(cap("89999"), 89999);
  for (const value of ["90000", "120000", "-5", "fast", "", "  ", "NaN"])
    assert.equal(cap(value), 90000, JSON.stringify(value));
});

// The client.

test("a 429 with Retry-After: 23 waits once, asks again once, and slows the provider down", async () => {
  const { client, fetchImpl, clock } = harness(
    scripted([limited(23)], { body: { ok: true } }),
  );
  const result = await client.getJson("dexscreener", `${DS}1`);
  assert.deepEqual(result.data, { ok: true });
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(fetchImpl.calls[1].url, fetchImpl.calls[0].url, "same request");
  assert.equal(fetchImpl.calls[1].at - fetchImpl.calls[0].at, 23000);
  assert.deepEqual(clock.sleeps, [23000]);
  const stats = client.stats().dexscreener;
  assert.equal(stats.requests, 2, "the retry is counted");
  assert.equal(stats.succeeded, 1);
  assert.equal(stats.failed, 1);
  assert.equal(stats.rateLimitWaits, 1);
  assert.equal(stats.rateLimitWaitedMs, 23000);
  assert.equal(stats.gapMs, 800, "the 400 ms gap doubled");
  assert.equal(stats.retryAfterMs, 23000);
  assert.equal(stats.stopped, null);
  assert.equal(client.requestCount(), 2);
  assert.equal(client.requestsLeft(), 397);
  // The doubled gap holds for the rest of the run.
  await client.getJson("dexscreener", `${DS}2`);
  await client.getJson("dexscreener", `${DS}3`);
  assert.equal(fetchImpl.calls[2].at - fetchImpl.calls[1].at, 800);
  assert.equal(fetchImpl.calls[3].at - fetchImpl.calls[2].at, 800);
  // Another provider keeps its own gap.
  assert.equal(client.stats().geckoterminal.gapMs, 12000);
});

test("the wait is counted from the moment the 429 arrived, not from the moment the request was sent", async () => {
  const { client, fetchImpl, clock } = harness((call, n) => {
    if (n !== 1) return { body: { ok: true } };
    clock.advance(2000); // a slow answer
    return limited(23);
  });
  await client.getJson("dexscreener", `${DS}1`);
  assert.equal(fetchImpl.calls[1].at - fetchImpl.calls[0].at, 2000 + 23000);
  assert.equal(client.stats().dexscreener.rateLimitWaitedMs, 23000);
});

test("the retry starts a whole doubled gap after the refused request when that is longer than Retry-After", async () => {
  const cases = [
    // provider, url, Retry-After, expected delay of the retry, doubled gap
    ["dexscreener", `${DS}1`, 0, 800, 800],
    ["dexscreener", `${DS}1`, 1, 1000, 800],
    ["geckoterminal", `${GT}?page=1`, 23, 24000, 24000],
    ["geckoterminal", `${GT}?page=1`, 25, 25000, 24000],
    ["v4xyz", V4, 7, 10000, 10000],
    ["v4xyz", V4, 11, 11000, 10000],
  ];
  for (const [provider, url, seconds, delay, gap] of cases) {
    const { client, fetchImpl } = harness(
      scripted([limited(seconds)], { body: { ok: true } }),
    );
    await client.getJson(provider, url);
    assert.equal(
      fetchImpl.calls[1].at - fetchImpl.calls[0].at,
      delay,
      `${provider} Retry-After ${seconds}`,
    );
    assert.equal(client.stats()[provider].gapMs, gap);
    assert.equal(client.stats()[provider].rateLimitWaitedMs, delay);
  }
});

test("Retry-After may be an HTTP date", async () => {
  const { client, fetchImpl } = harness(
    scripted(
      [
        {
          status: 429,
          headers: { "retry-after": new Date(T0 + 23000).toUTCString() },
        },
      ],
      { body: { ok: true } },
    ),
  );
  await client.getJson("dexscreener", `${DS}1`);
  assert.equal(fetchImpl.calls[1].at - fetchImpl.calls[0].at, 23000);
  // A date in the past asks for no wait beyond the gap.
  const past = harness(
    scripted(
      [
        {
          status: 429,
          headers: { "retry-after": new Date(T0 - 60000).toUTCString() },
        },
      ],
      { body: { ok: true } },
    ),
  );
  await past.client.getJson("dexscreener", `${DS}1`);
  assert.equal(past.fetchImpl.calls[1].at - past.fetchImpl.calls[0].at, 800);
});

test("Retry-After in seconds may carry a fraction, and part of a millisecond is waited as a whole one", async () => {
  for (const [seconds, delay] of [
    ["1.5", 1500],
    ["2.25", 2250],
    ["1.0005", 1001],
  ]) {
    const { client, fetchImpl } = harness(
      scripted([limited(seconds)], { body: { ok: true } }),
    );
    await client.getJson("dexscreener", `${DS}1`);
    assert.equal(
      fetchImpl.calls[1].at - fetchImpl.calls[0].at,
      delay,
      `Retry-After ${seconds}`,
    );
  }
  // Anything that is neither seconds nor a date names no wait. Several of these
  // are read as a date in the past by a lenient date parser, which would mean
  // "wait 0 seconds": they must not be.
  for (const seconds of [
    "soon",
    "1e3",
    "+5",
    "-5",
    "5.",
    ".5",
    "1,5",
    "1 2",
    "Oct 28",
  ]) {
    const { client, fetchImpl, clock } = harness(scripted([limited(seconds)]));
    await rejects(client.getJson("dexscreener", `${DS}1`), "rate-limited");
    assert.equal(fetchImpl.calls.length, 1, `Retry-After ${seconds}`);
    assert.deepEqual(clock.sleeps, [], `Retry-After ${seconds}`);
    assert.equal(client.stats().dexscreener.rateLimitWaits, 0);
    assert.equal(client.stats().dexscreener.retryAfterMs, null);
  }
});

test("retryAfterMs reads delta-seconds and HTTP dates, and nothing else", () => {
  assert.equal(retryAfterMs("23", T0), 23000);
  assert.equal(retryAfterMs(" 23 ", T0), 23000);
  assert.equal(retryAfterMs("0", T0), 0);
  assert.equal(retryAfterMs("1.5", T0), 1500);
  // The date forms HTTP allows: the preferred one and the old RFC 850 one.
  assert.equal(retryAfterMs("Wed, 28 Oct 2026 12:00:23 GMT", T0), 23000);
  assert.equal(retryAfterMs("Wednesday, 28-Oct-26 12:00:23 GMT", T0), 23000);
  // A date that has passed asks for no wait.
  assert.equal(retryAfterMs("Wed, 28 Oct 2026 11:59:00 GMT", T0), 0);
  for (const junk of [
    null,
    undefined,
    "",
    "  ",
    "soon",
    "1e3",
    "+5",
    "-5",
    "5.",
    ".5",
    "1,5",
    "1 2",
    "Oct 28",
    "Wed, 99 Oct 2026 12:00:23 GMT",
  ])
    assert.equal(retryAfterMs(junk, T0), null, JSON.stringify(junk));
});

test("a Cloudflare 1015 page with no Retry-After waits the default 30 seconds", async () => {
  for (const page of [
    "error code: 1015",
    "<html><title>Error 1015</title>Error code 1015 You are being rate limited</html>",
  ]) {
    const { client, fetchImpl } = harness(
      scripted([{ status: 429, body: page }], { body: { ok: true } }),
    );
    const result = await client.getJson("geckoterminal", `${GT}?page=1`);
    assert.deepEqual(result.data, { ok: true });
    assert.equal(fetchImpl.calls[1].at - fetchImpl.calls[0].at, 30000);
    assert.equal(client.stats().geckoterminal.rateLimitWaitedMs, 30000);
  }
  // The header, when there is one, names the wait.
  const both = harness(
    scripted([limited(23, { body: "error code: 1015" })], { body: {} }),
  );
  await both.client.getJson("geckoterminal", `${GT}?page=1`);
  assert.equal(both.fetchImpl.calls[1].at - both.fetchImpl.calls[0].at, 24000);
});

test("a 429 that names no wait stops the provider at once", async () => {
  const bodies = [
    "",
    "Too Many Requests",
    "error code: 1020",
    JSON.stringify({ error: "slow down" }),
    // Past the part of the page that is read.
    `${"x".repeat(5000)} error code: 1015`,
  ];
  for (const body of bodies) {
    const { client, fetchImpl, clock } = harness(
      scripted([{ status: 429, body }]),
    );
    await rejects(client.getJson("dexscreener", `${DS}1`), "rate-limited");
    assert.equal(fetchImpl.calls.length, 1);
    assert.deepEqual(clock.sleeps, []);
    const stats = client.stats().dexscreener;
    assert.equal(stats.stopped.reason, "rate limited (HTTP 429)");
    assert.equal(stats.rateLimitWaits, 0);
    await rejects(client.getJson("dexscreener", `${DS}2`), "stopped");
    assert.equal(fetchImpl.calls.length, 1);
  }
});

test("a second 429 from the same provider stops it for the run", async () => {
  const { client, fetchImpl } = harness(scripted([limited(23), limited(5)]));
  await rejects(client.getJson("dexscreener", `${DS}1`), "rate-limited");
  assert.equal(fetchImpl.calls.length, 2, "asked once more, and no more");
  const stats = client.stats().dexscreener;
  assert.equal(stats.requests, 2);
  assert.equal(stats.failed, 2);
  assert.equal(stats.rateLimitWaits, 1);
  assert.equal(stats.stopped.status, 429);
  assert.match(stats.stopped.reason, /^rate limited again after waiting/);
  assert.equal(client.isStopped("dexscreener"), true);
  await rejects(client.getJson("dexscreener", `${DS}2`), "stopped");
  assert.equal(fetchImpl.calls.length, 2);
});

test("there is one cooldown per run: a later 429 stops the provider even after a success", async () => {
  const { client, fetchImpl } = harness(
    scripted([limited(23), { body: { ok: 1 } }, limited(5)]),
  );
  await client.getJson("dexscreener", `${DS}1`);
  await rejects(client.getJson("dexscreener", `${DS}2`), "rate-limited");
  assert.equal(fetchImpl.calls.length, 3, "no second wait, no second retry");
  assert.equal(client.stats().dexscreener.rateLimitWaits, 1);
  assert.equal(client.isStopped("dexscreener"), true);
  // The cooldown belongs to the provider: another one has its own.
  const other = await client.getJson("v4xyz", V4);
  assert.deepEqual(other.data, {});
});

test("a Retry-After over the cap stops the provider without waiting", async () => {
  const { client, fetchImpl, clock } = harness(scripted([limited(400)]));
  await rejects(client.getJson("dexscreener", `${DS}1`), "rate-limited");
  assert.equal(fetchImpl.calls.length, 1);
  assert.deepEqual(clock.sleeps, []);
  const stats = client.stats().dexscreener;
  assert.match(stats.stopped.reason, /asked to wait 400 s/);
  assert.equal(stats.stopped.retryAfterMs, 400000);
  assert.equal(stats.rateLimitWaits, 0);
  await rejects(client.getJson("dexscreener", `${DS}2`), "stopped");
});

test("the cap itself is allowed and one second more is not", async () => {
  const at = harness(scripted([limited(90)], { body: { ok: true } }));
  await at.client.getJson("dexscreener", `${DS}1`);
  assert.equal(at.fetchImpl.calls[1].at - at.fetchImpl.calls[0].at, 90000);
  const over = harness(scripted([limited(91)], { body: { ok: true } }));
  await rejects(over.client.getJson("dexscreener", `${DS}1`), "rate-limited");
  assert.equal(over.fetchImpl.calls.length, 1);
  // A shorter cap (COLLECTOR_RETRY_AFTER_CAP_MS) applies the same way.
  const short = harness(scripted([limited(23)], { body: { ok: true } }), {
    rateLimitCapMs: 20000,
  });
  await rejects(short.client.getJson("dexscreener", `${DS}1`), "rate-limited");
  const exact = harness(scripted([limited(20)], { body: { ok: true } }), {
    rateLimitCapMs: 20000,
  });
  await exact.client.getJson("dexscreener", `${DS}1`);
  assert.equal(exact.fetchImpl.calls.length, 2);
  // A cap of nothing turns the cooldown off, whatever the wait asked for.
  for (const seconds of [0, 1]) {
    const none = harness(scripted([limited(seconds)], { body: { ok: true } }), {
      rateLimitCapMs: 0,
    });
    await rejects(none.client.getJson("dexscreener", `${DS}1`), "rate-limited");
    assert.equal(none.fetchImpl.calls.length, 1);
    assert.equal(
      none.client.stats().dexscreener.stopped.reason,
      "rate limited (HTTP 429)",
    );
  }
});

test("a wait that would end after notAfter stops the provider instead of stretching the phase", async () => {
  const late = harness(scripted([limited(23)], { body: { ok: true } }));
  await rejects(
    late.client.getJson("dexscreener", `${DS}1`, { notAfter: T0 + 22999 }),
    "rate-limited",
  );
  assert.equal(late.fetchImpl.calls.length, 1);
  assert.deepEqual(late.clock.sleeps, []);
  assert.match(
    late.client.stats().dexscreener.stopped.reason,
    /time allowed for this phase/,
  );
  assert.equal(late.client.isStopped("dexscreener"), true);
  // Starting exactly at the limit is allowed, as it is for any request.
  const exact = harness(scripted([limited(23)], { body: { ok: true } }));
  await exact.client.getJson("dexscreener", `${DS}1`, {
    notAfter: T0 + 23000,
  });
  assert.equal(exact.fetchImpl.calls.length, 2);
  // The doubled gap counts as much as the stated wait does.
  const gap = harness(scripted([limited(1)], { body: { ok: true } }));
  await rejects(
    gap.client.getJson("geckoterminal", `${GT}?page=1`, {
      notAfter: T0 + 23999,
    }),
    "rate-limited",
  );
  assert.equal(gap.fetchImpl.calls.length, 1);
  const gapOk = harness(scripted([limited(1)], { body: { ok: true } }));
  await gapOk.client.getJson("geckoterminal", `${GT}?page=1`, {
    notAfter: T0 + 24000,
  });
  assert.equal(gapOk.fetchImpl.calls.length, 2);
});

test("a wait that fits is not cut short when only the retry would start late", async () => {
  // The refused request had time to start; the clock after the answer decides.
  const { client, fetchImpl } = harness(
    scripted([limited(10)], { body: { ok: true } }),
  );
  const result = await client.getJson("dexscreener", `${DS}1`, {
    notAfter: T0 + 10000,
  });
  assert.deepEqual(result.data, { ok: true });
  assert.equal(fetchImpl.calls.length, 2);
});

test("a 403 stops the provider at once, whatever Retry-After says", async () => {
  const { client, fetchImpl, clock } = harness(
    scripted([
      { status: 403, headers: { "retry-after": "5" }, body: "forbidden" },
    ]),
  );
  await rejects(client.getJson("dexscreener", `${DS}1`), "forbidden");
  assert.equal(fetchImpl.calls.length, 1);
  assert.deepEqual(clock.sleeps, []);
  const stats = client.stats().dexscreener;
  assert.equal(stats.stopped.reason, "forbidden (HTTP 403)");
  assert.equal(stats.rateLimitWaits, 0);
  await rejects(client.getJson("dexscreener", `${DS}2`), "stopped");
});

test("the retry is a request: it spends the budget and cannot exceed it", async () => {
  // The 399th request may be a retry, and nothing is sent after it.
  const slow = harness((call, n) => (n === 398 ? limited(1) : { body: { n } }));
  for (let i = 0; i < 397; i++)
    await slow.client.getJson("dexscreener", `${DS}${i}`);
  const retried = await slow.client.getJson("dexscreener", `${DS}last`);
  assert.deepEqual(retried.data, { n: 399 });
  assert.equal(slow.fetchImpl.calls.length, 399);
  assert.equal(slow.client.requestsLeft(), 0);
  assert.equal(slow.client.stats().dexscreener.requests, 399);
  await rejects(slow.client.getJson("dexscreener", `${DS}more`), "budget");
  await rejects(slow.client.getJson("geckoterminal", `${GT}?page=1`), "budget");
  assert.equal(slow.fetchImpl.calls.length, 399);

  // A 429 on the last request of the budget has nothing left to retry with.
  const last = harness((call, n) => (n === 399 ? limited(1) : { body: {} }));
  for (let i = 0; i < 398; i++)
    await last.client.getJson("dexscreener", `${DS}${i}`);
  await rejects(last.client.getJson("dexscreener", `${DS}end`), "rate-limited");
  assert.equal(last.fetchImpl.calls.length, 399, "399 requests at most");
  assert.match(
    last.client.stats().dexscreener.stopped.reason,
    /no room to try again/,
  );
  assert.equal(last.client.stats().dexscreener.rateLimitWaits, 0);

  // So does a provider's own cap.
  const capped = harness(scripted([limited(1)]), { caps: { dexscreener: 1 } });
  await rejects(capped.client.getJson("dexscreener", `${DS}1`), "rate-limited");
  assert.equal(capped.fetchImpl.calls.length, 1);
  const roomy = harness(scripted([limited(1)]), { caps: { dexscreener: 2 } });
  await roomy.client.getJson("dexscreener", `${DS}1`);
  assert.equal(roomy.fetchImpl.calls.length, 2);
});

test("nothing but that 429 is ever retried", async () => {
  for (const status of [400, 401, 404, 408, 500, 502, 503, 504]) {
    const { client, fetchImpl, clock } = harness(
      scripted([{ status, headers: { "retry-after": "5" } }]),
    );
    await rejects(client.getJson("dexscreener", `${DS}1`), "http");
    assert.equal(fetchImpl.calls.length, 1, `HTTP ${status}`);
    assert.deepEqual(clock.sleeps, []);
    assert.equal(client.stats().dexscreener.rateLimitWaits, 0);
  }
  // A timeout and a dropped connection neither.
  const dropped = harness(() => {
    throw new Error("socket hang up");
  });
  await rejects(dropped.client.getJson("dexscreener", `${DS}1`), "network");
  assert.equal(dropped.fetchImpl.calls.length, 1);
});

test("the registry and Frontier fetches are not given a cooldown", async () => {
  for (const provider of ["registry", "frontier"]) {
    const host =
      provider === "registry" ? RAW : "https://api.frontier.fun/chains";
    const { client, fetchImpl } = harness(scripted([limited(5)]));
    await rejects(client.getJson(provider, host), "rate-limited");
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(
      client.stats()[provider].stopped.reason,
      "rate limited (HTTP 429)",
    );
  }
});

test("the 429 itself is not one of the five failures that stop a provider", async () => {
  // Four failures, then a 429 that is answered after the wait: the provider is
  // still in use, and the success clears the count.
  const recovered = harness(
    scripted([
      { status: 500 },
      { status: 500 },
      { status: 500 },
      { status: 500 },
      limited(5),
      { body: { ok: true } },
    ]),
  );
  for (let i = 0; i < 4; i++)
    await rejects(recovered.client.getJson("v4xyz", `${V4}&i=${i}`), "http");
  await recovered.client.getJson("v4xyz", `${V4}&again`);
  assert.equal(recovered.client.isStopped("v4xyz"), false);
  assert.equal(recovered.client.stats().v4xyz.failed, 5);
  // The retry is an ordinary request: if it fails, it is the fifth failure.
  const failing = harness(
    scripted([
      { status: 500 },
      { status: 500 },
      { status: 500 },
      { status: 500 },
      limited(5),
      { status: 500 },
    ]),
  );
  for (let i = 0; i < 4; i++)
    await rejects(failing.client.getJson("v4xyz", `${V4}&i=${i}`), "http");
  await rejects(failing.client.getJson("v4xyz", `${V4}&again`), "http");
  assert.equal(failing.client.isStopped("v4xyz"), true);
  assert.equal(
    failing.client.stats().v4xyz.stopped.reason,
    "too many consecutive failures",
  );
  // The 429 adds nothing to the count: three failures, the 429 and a failed
  // retry are four failures in a row, and the fifth is still to come.
  const three = harness(
    scripted([
      { status: 500 },
      { status: 500 },
      { status: 500 },
      limited(5),
      { status: 500 },
      { status: 500 },
    ]),
  );
  for (let i = 0; i < 3; i++)
    await rejects(three.client.getJson("v4xyz", `${V4}&i=${i}`), "http");
  await rejects(three.client.getJson("v4xyz", `${V4}&again`), "http");
  assert.equal(three.client.isStopped("v4xyz"), false, "four failures");
  assert.equal(
    three.client.stats().v4xyz.failed,
    5,
    "the 429 is still counted",
  );
  await rejects(three.client.getJson("v4xyz", `${V4}&last`), "http");
  assert.equal(three.client.isStopped("v4xyz"), true, "the fifth");
});

test("a status the caller tolerates is a failed request but not a step toward the breaker", async () => {
  const { client } = harness(() => ({ status: 400 }));
  for (let i = 0; i < 6; i++) {
    await assert.rejects(
      client.getJson("dexscreener", `${DS}${i}`, { tolerate: [400] }),
      (error) =>
        error instanceof ProviderError &&
        error.code === "http" &&
        error.status === 400,
    );
  }
  assert.equal(client.isStopped("dexscreener"), false);
  const stats = client.stats().dexscreener;
  assert.equal(stats.requests, 6);
  assert.equal(stats.failed, 6);
  assert.equal(stats.stopped, null);
  // Untolerated, the same answers stop the provider on the fifth.
  const plain = harness(() => ({ status: 400 }));
  for (let i = 0; i < 5; i++)
    await rejects(plain.client.getJson("dexscreener", `${DS}${i}`), "http");
  assert.equal(plain.client.isStopped("dexscreener"), true);
  // Tolerating one status says nothing about another.
  const other = harness(() => ({ status: 500 }));
  for (let i = 0; i < 5; i++)
    await rejects(
      other.client.getJson("dexscreener", `${DS}${i}`, { tolerate: [400] }),
      "http",
    );
  assert.equal(other.client.isStopped("dexscreener"), true);
  // A tolerated answer neither adds to the count nor clears it: three failures,
  // two tolerated answers and a fourth failure are four, not six and not one.
  const mixed = harness(
    scripted([
      { status: 500 },
      { status: 500 },
      { status: 500 },
      { status: 400 },
      { status: 400 },
      { status: 500 },
      { status: 500 },
    ]),
  );
  const another = (name) => mixed.client.getJson("dexscreener", `${DS}${name}`);
  const tolerated = (name) =>
    mixed.client.getJson("dexscreener", `${DS}${name}`, { tolerate: [400] });
  for (let i = 0; i < 3; i++) await rejects(another(i), "http");
  await rejects(tolerated("x"), "http");
  await rejects(tolerated("y"), "http");
  await rejects(another("z"), "http");
  assert.equal(mixed.client.isStopped("dexscreener"), false, "four failures");
  await rejects(another("last"), "http");
  assert.equal(mixed.client.isStopped("dexscreener"), true, "the fifth");
});

test("a cooldown is announced to the log as a wait, not a failure of the run", async () => {
  const events = [];
  const { client } = harness(scripted([limited(2)], { body: {} }), {
    onEvent: (event) => events.push(event),
  });
  await client.getJson("dexscreener", `${DS}1`);
  assert.deepEqual(
    events.map((event) => [event.ok, event.code ?? null, event.status]),
    [
      [false, "cooldown", 429],
      [true, null, 200],
    ],
  );
});

// The burst.

const pick = (url) => /pairs\/([a-z]+)\/(.+)$/.exec(url);
const manyPools = (chain, count, from) =>
  Array.from({ length: count }, (_, i) => statePool(from + i, { chain }));
const dexHost = "https://api.dexscreener.com";

/** DEX Screener rows for the requested ids of the pools it knows. */
function dexAnswer(pools, { refuse = {}, onBatch = () => null } = {}) {
  return (call, n) => {
    const hit = pick(call.url);
    if (!hit) return { body: { data: [] } };
    const [, slug, ids] = hit;
    const special = onBatch(call, n, slug);
    if (special) return special;
    if (refuse[slug]) return refuse[slug];
    const wanted = new Set(ids.split(","));
    const rows = pools
      .filter((pool) => wanted.has(pool.id))
      .map((pool) => dexRow(pool));
    return { body: { pairs: rows.length ? rows : null } };
  };
}

test("a 400 on a network's first batch skips its other batches and does not stop DEX Screener", async () => {
  // Seven networks DEX Screener does not index, one it does. Seven 400s in a row
  // would have stopped the provider on the fifth, before the last network.
  const unindexed = [
    "arbitrum",
    "avalanche",
    "celo",
    "ethereum",
    "optimism",
    "polygon",
    "unichain",
  ];
  const pools = unindexed.flatMap((chain, i) =>
    manyPools(chain, 65, 1000 * (i + 1)),
  );
  const good = manyPools("base", 40, 50000);
  const refuse = Object.fromEntries(
    unindexed.map((chain) => [chain, { status: 400, body: "bad request" }]),
  );
  const { client, fetchImpl, clock } = harness(
    dexAnswer([...pools, ...good], { refuse }),
  );
  const plan = planBurst([...pools, ...good]);
  assert.equal(plan.planned, 7 * 65 + 40);
  const burst = await runBurst({ client, plan, now: clock.now });
  const dexCalls = fetchImpl.calls.filter((call) =>
    call.url.startsWith(dexHost),
  );
  assert.equal(dexCalls.length, 7 + 2, "one batch for each unindexed network");
  assert.deepEqual(burst.unsupportedNetworks, unindexed);
  assert.equal(client.isStopped("dexscreener"), false);
  const stats = client.stats().dexscreener;
  assert.equal(stats.requests, 9);
  assert.equal(stats.failed, 7);
  assert.equal(stats.stopped, null);
  assert.equal(burst.measured.size, 40, "the network it indexes is measured");
  // Only the batch that was sent counts as requested; none of it as checked.
  assert.equal(burst.requestedPools, 7 * 30 + 40);
  assert.equal(burst.checkedPools, 40);
  const row = (slug) => burst.networks.find((n) => n.chain === slug);
  assert.deepEqual(
    [row("celo").requested, row("celo").checked, row("celo").failedBatches],
    [30, 0, 1],
  );
  assert.deepEqual(
    [row("base").requested, row("base").checked, row("base").failedBatches],
    [40, 40, 0],
  );
});

test("pools of a network DEX Screener does not index go to the GeckoTerminal fallback like any unresolved pool", async () => {
  const lost = manyPools("ethereum", 70, 1000);
  const good = manyPools("base", 30, 5000);
  const { client, fetchImpl, clock } = harness(
    dexAnswer([...lost, ...good], {
      refuse: { ethereum: { status: 400 } },
    }),
  );
  const burst = await runBurst({
    client,
    plan: planBurst([...lost, ...good]),
    now: clock.now,
  });
  assert.deepEqual(burst.unsupportedNetworks, ["ethereum"]);
  const gecko = fetchImpl.calls.filter((call) => call.url.includes("/multi/"));
  assert.equal(gecko.length, 3);
  assert.equal(burst.fallback.requests, 3);
  assert.equal(burst.fallback.ids, 70);
  const asked = new Set(
    gecko.flatMap((call) =>
      call.url.split("/multi/")[1].split("?")[0].split(","),
    ),
  );
  const ethereum = new Set(lost.map((pool) => pool.id));
  assert.equal(asked.size, 70);
  assert.ok([...asked].every((id) => ethereum.has(id)));
  assert.ok(gecko.every((call) => call.url.includes("/networks/eth/")));
});

test("only a 400 means the network is not indexed: other errors are failed batches", async () => {
  for (const status of [404, 500, 503]) {
    const pools = manyPools("base", 90, 1000);
    let batch = 0;
    const { client, fetchImpl, clock } = harness(
      dexAnswer(pools, {
        onBatch: () => (++batch === 1 ? { status } : null),
      }),
    );
    const burst = await runBurst({
      client,
      plan: planBurst(pools),
      now: clock.now,
      fallbackRequests: 0,
    });
    const dexCalls = fetchImpl.calls.filter((call) =>
      call.url.startsWith(dexHost),
    );
    assert.equal(dexCalls.length, 3, `HTTP ${status}: the other batches go on`);
    assert.deepEqual(burst.unsupportedNetworks, []);
    assert.equal(burst.networks[0].failedBatches, 1);
    assert.equal(burst.measured.size, 60);
    // It counted toward the breaker like any failure.
    assert.equal(client.stats().dexscreener.failed, 1);
  }
});

test("a 400 after the network has answered is an ordinary failed batch", async () => {
  const pools = manyPools("base", 90, 1000);
  let batch = 0;
  const { client, fetchImpl, clock } = harness(
    dexAnswer(pools, {
      onBatch: () => (++batch === 2 ? { status: 400 } : null),
    }),
  );
  const burst = await runBurst({
    client,
    plan: planBurst(pools),
    now: clock.now,
    fallbackRequests: 0,
  });
  const dexCalls = fetchImpl.calls.filter((call) =>
    call.url.startsWith(dexHost),
  );
  assert.equal(dexCalls.length, 3, "the third batch is still sent");
  assert.deepEqual(burst.unsupportedNetworks, []);
  assert.equal(burst.networks[0].failedBatches, 1);
  assert.equal(burst.measured.size, 60);
  // It counted toward the breaker, because it is not proof about the network.
  const quick = harness(
    dexAnswer(manyPools("base", 330, 1000), {
      onBatch: (call, n) => (n >= 2 && n <= 6 ? { status: 400 } : null),
    }),
  );
  await runBurst({
    client: quick.client,
    plan: planBurst(manyPools("base", 330, 1000)),
    now: quick.clock.now,
    fallbackRequests: 0,
  });
  assert.equal(quick.client.isStopped("dexscreener"), true);
});

test("a rate-limit cooldown inside the burst retries the same batch once and carries on", async () => {
  const pools = manyPools("base", 100, 1000);
  let dex = 0;
  const { client, fetchImpl, clock } = harness(
    dexAnswer(pools, {
      onBatch: () => (++dex === 2 ? limited(23) : null),
    }),
  );
  const burst = await runBurst({
    client,
    plan: planBurst(pools),
    now: clock.now,
    fallbackRequests: 0,
  });
  const dexCalls = fetchImpl.calls.filter((call) =>
    call.url.startsWith(dexHost),
  );
  assert.equal(dexCalls.length, 5, "four batches and one retry");
  assert.equal(dexCalls[2].url, dexCalls[1].url);
  assert.equal(dexCalls[2].at - dexCalls[1].at, 23000);
  assert.equal(burst.requestedPools, 100, "the retried batch is counted once");
  assert.equal(burst.checkedPools, 100);
  assert.equal(burst.measured.size, 100);
  assert.equal(burst.networks[0].failedBatches, 0);
  assert.equal(client.isStopped("dexscreener"), false);
  assert.equal(client.stats().dexscreener.requests, 5);
  // The batches after it keep to the doubled gap.
  assert.equal(dexCalls[3].at - dexCalls[2].at, 800);
});

test("the retry after a 429 is still tolerant of a 400: an unindexed network is skipped and the breaker is not touched", async () => {
  // The batches go one network at a time in turn, the largest network first.
  // The first batch of each of four networks fails (HTTP 500), which leaves
  // DEX Screener one failure short of the breaker; Ethereum comes next, as the
  // smallest. Its first batch is refused with a 429 and then answered with a
  // 400, which is "this network is not indexed". If the retry lost its
  // tolerance that 400 would be the fifth failure in a row and would stop the
  // provider.
  const others = ["arbitrum", "base", "optimism", "polygon"];
  const pools = others.flatMap((chain, i) =>
    manyPools(chain, 100, 1000 * (i + 1)),
  );
  const ethereum = manyPools("ethereum", 90, 9000);
  const seen = new Map();
  let ethereumAnswers = 0;
  const { client, fetchImpl, clock } = harness(
    dexAnswer([...pools, ...ethereum], {
      onBatch: (call, n, slug) => {
        if (slug === "ethereum")
          return ++ethereumAnswers === 1 ? limited(5) : { status: 400 };
        seen.set(slug, (seen.get(slug) ?? 0) + 1);
        return seen.get(slug) === 1 ? { status: 500 } : null;
      },
    }),
  );
  const plan = planBurst([...pools, ...ethereum]);
  assert.deepEqual(
    plan.networks.map(({ chain }) => chain.chain),
    [...others, "ethereum"],
    "Ethereum is the smallest, so it is reached after the four failures",
  );
  const burst = await runBurst({
    client,
    plan,
    now: clock.now,
    fallbackRequests: 0,
  });
  const dexCalls = fetchImpl.calls.filter((call) =>
    call.url.startsWith(dexHost),
  );
  const ethereumCalls = dexCalls.filter((call) =>
    /\/ethereum\//.test(call.url),
  );
  assert.equal(dexCalls[4].url, ethereumCalls[0].url, "the fifth batch sent");
  assert.equal(dexCalls.length, 4 * 4 + 2, "16 batches of four, 429 and retry");
  assert.equal(ethereumCalls.length, 2, "no further batch of that network");
  assert.equal(ethereumCalls[1].url, ethereumCalls[0].url, "the same request");
  assert.equal(ethereumCalls[1].at - ethereumCalls[0].at, 5000);
  assert.deepEqual(burst.unsupportedNetworks, ["ethereum"]);
  assert.equal(client.isStopped("dexscreener"), false);
  const stats = client.stats().dexscreener;
  assert.equal(stats.stopped, null);
  assert.equal(stats.rateLimitWaits, 1);
  assert.equal(stats.requests, 18);
  assert.equal(stats.failed, 4 + 1 + 1, "500s, the 429 and the tolerated 400");
  const row = (slug) => burst.networks.find((n) => n.chain === slug);
  for (const slug of others) assert.equal(row(slug).failedBatches, 1);
  assert.deepEqual(
    [row("ethereum").requested, row("ethereum").failedBatches],
    [30, 1],
  );
});

test("a second 429 ends the burst early and the quality gate refuses what is left", async () => {
  const pools = manyPools("base", 100, 1000);
  let dex = 0;
  const { client, fetchImpl, clock } = harness(
    dexAnswer(pools, {
      onBatch: () => (++dex >= 2 ? limited(23) : null),
    }),
  );
  const plan = planBurst(pools);
  const burst = await runBurst({
    client,
    plan,
    now: clock.now,
    fallbackRequests: 0,
  });
  const dexCalls = fetchImpl.calls.filter((call) =>
    call.url.startsWith(dexHost),
  );
  assert.equal(dexCalls.length, 3, "one batch, the refused one, its retry");
  assert.equal(burst.requestedPools, 60);
  assert.equal(burst.networks[0].failedBatches, 1);
  assert.equal(client.isStopped("dexscreener"), true);
  const stats = client.stats();
  const quality = assessQuality({
    currentPools: burst.measured.size,
    currentVolumePools: burst.measured.size,
    plannedPools: plan.planned,
    requestedPools: burst.requestedPools,
    checkedPools: burst.checkedPools,
    snapshotValid: true,
    overviewsValid: true,
    minCurrent: 1,
    stoppedProviders: Object.entries(stats)
      .filter(([, row]) => row.stopped)
      .map(([id, row]) => `${id} (${row.stopped.reason})`),
  });
  assert.equal(quality.ok, false);
  assert.match(quality.failures.join(" "), /60 of 100 planned pools/);
  assert.match(quality.failures.join(" "), /dexscreener \(rate limited again/);
});

test("a cooldown never takes the burst past its 225 seconds", async () => {
  // The refused batch is answered at 210 s. A wait that ends by 225 s is
  // taken; one that would end later ends the burst there.
  const run = async (seconds) => {
    const pools = manyPools("base", 90, 1000);
    let dex = 0;
    const world = harness(
      dexAnswer(pools, {
        onBatch: () => {
          if (++dex === 1) {
            world.clock.advance(210000);
            return null;
          }
          return dex === 2 ? limited(seconds) : null;
        },
      }),
    );
    const burst = await runBurst({
      client: world.client,
      plan: planBurst(pools),
      now: world.clock.now,
      fallbackRequests: 0,
    });
    return { burst, world };
  };
  const fits = await run(14);
  assert.equal(fits.burst.measured.size, 90, "waited, asked again, went on");
  assert.equal(fits.world.client.stats().dexscreener.rateLimitWaits, 1);
  assert.ok(fits.burst.endedAt - fits.burst.startedAt <= 225000);
  // Asking again exactly at 225 s is allowed; the next batch is then too late.
  const edge = await run(15);
  assert.equal(edge.burst.measured.size, 60);
  assert.equal(edge.world.client.stats().dexscreener.rateLimitWaits, 1);
  const tooLong = await run(16);
  assert.equal(tooLong.burst.measured.size, 30);
  assert.equal(tooLong.world.client.isStopped("dexscreener"), true);
  assert.equal(tooLong.world.client.stats().dexscreener.rateLimitWaits, 0);
  assert.match(
    tooLong.world.client.stats().dexscreener.stopped.reason,
    /time allowed for this phase/,
  );
});

// What a run publishes.

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

function world() {
  const pools = [
    ...Array.from({ length: 70 }, (_, i) =>
      statePool(1 + i, {
        chain: "base",
        hookAddress: BUNNI_BASE.toLowerCase(),
      }),
    ),
    ...Array.from({ length: 40 }, (_, i) =>
      statePool(100 + i, {
        chain: "ethereum",
        hookAddress: BUNNI_ETH.toLowerCase(),
      }),
    ),
  ];
  return pools;
}

async function collect({
  onBatch,
  env = {},
  pools = world(),
  log = () => {},
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), "collector-resilience-"));
  try {
    const clock = new FakeClock(T0);
    const dex = dexAnswer(pools, { onBatch });
    const fetchImpl = fakeFetch(clock, (call, n) => {
      if (call.url === REGISTRY_URL) return { body: REGISTRY };
      if (call.url === CHAINS_URL) return { body: CHAIN_DATA };
      if (call.url === FRONTIER_URL) return { body: [] };
      if (call.url.startsWith(dexHost)) return dex(call, n);
      return { body: { data: [] } };
    });
    await mkdir(join(dir, "state"), { recursive: true });
    await writeFile(join(dir, "state", "pools.json"), poolsJson(null, pools));
    const result = await runCollector({
      stateDir: join(dir, "state"),
      outDir: join(dir, "data"),
      minCurrent: 20,
      fetchImpl,
      now: clock.now,
      sleep: clock.sleep,
      env: { GITHUB_REPOSITORY: "owner/hook-radar", ...env },
      maxDiscovery: 0,
      // These tests count requests; the daily-volume step has its own tests.
      dailyMaxRequests: 0,
      log,
    });
    const published = result.published
      ? {
          problems: (await inspectPublishedData(join(dir, "data"))).problems,
          status: JSON.parse(
            await readFile(join(dir, "data", "status.json"), "utf8"),
          ),
        }
      : null;
    return { result, fetchImpl, clock, published };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const source = (result, id) =>
  result.snapshot.sources.find((entry) => entry.id === id);
const dexCallsOf = (fetchImpl) =>
  fetchImpl.calls.filter((call) => call.url.startsWith(dexHost));

test("a run that was never rate limited says nothing about waiting or unindexed networks", async () => {
  const { result, published } = await collect();
  assert.equal(result.ok, true, result.quality.failures.join("; "));
  const { counts } = result.status;
  assert.deepEqual(counts.unsupportedNetworks, []);
  assert.deepEqual(counts.rateLimitWaits, {});
  assert.equal(counts.requests.dexscreener, 5);
  assert.doesNotMatch(source(result, "dexscreener").note, /Waited|Does not/);
  assert.deepEqual(published.problems, []);
});

test("a run that waited once and then succeeded publishes, and says so", async () => {
  let dex = 0;
  const lines = [];
  const { result, fetchImpl, published } = await collect({
    onBatch: () => (++dex === 2 ? limited(23) : null),
    log: (line) => lines.push(line),
  });
  assert.ok(lines.includes("WAIT dexscreener 429"), lines.join(", "));
  assert.equal(lines.filter((line) => line.startsWith("FAIL")).length, 0);
  assert.equal(result.ok, true, result.quality.failures.join("; "));
  assert.equal(result.published, true);
  assert.equal(dexCallsOf(fetchImpl).length, 6, "five batches and one retry");
  const { counts } = published.status;
  assert.equal(counts.requests.dexscreener, 6, "the retry is counted");
  assert.equal(
    counts.requests.total,
    fetchImpl.calls.length,
    "every request that was sent is counted",
  );
  assert.equal(counts.requestedPools, 110);
  assert.equal(counts.checkedPools, 110);
  assert.equal(counts.measuredPools, 110);
  assert.deepEqual(counts.rateLimitWaits, {
    dexscreener: { times: 1, waitedMs: 23000 },
  });
  const note = source(result, "dexscreener").note;
  assert.match(note, /6 requests between/);
  assert.ok(
    note.includes(" Waited 23 s after a rate-limit answer (1 time)."),
    note,
  );
  assert.doesNotMatch(note, /Stopped for this run/);
  assert.equal(source(result, "dexscreener").status, "live");
  const stored = published.status.sources.find(
    (entry) => entry.id === "dexscreener",
  );
  assert.equal(stored.requests, 6);
  assert.equal(stored.note, note);
  // The snapshot and every overview file passed their validators (the gate), and
  // the folder passes the publishing check.
  assert.equal(result.quality.checks.currentPools, 110);
  assert.deepEqual(published.problems, []);
});

test("a run whose provider says slow down twice is refused and writes nothing", async () => {
  let dex = 0;
  const { result, fetchImpl, published } = await collect({
    onBatch: () => (++dex >= 2 ? limited(23) : null),
  });
  assert.equal(result.ok, false);
  assert.equal(result.published, false);
  assert.equal(published, null);
  assert.equal(dexCallsOf(fetchImpl).length, 3);
  assert.match(
    result.quality.failures.join(" "),
    /Only 60 of 110 planned pools were requested/,
  );
  assert.match(result.quality.failures.join(" "), /dexscreener/);
  const note = source(result, "dexscreener").note;
  assert.match(
    note,
    / Waited 23 s after a rate-limit answer \(1 time\)\. Stopped for this run: rate limited again after waiting \(HTTP 429\)\.$/,
  );
  assert.equal(result.status.counts.requests.dexscreener, 3);
});

test("a run whose provider asks for longer than the cap is refused without waiting", async () => {
  let dex = 0;
  const { result, clock, fetchImpl } = await collect({
    onBatch: () => (++dex === 2 ? limited(400) : null),
  });
  assert.equal(result.ok, false);
  assert.equal(dexCallsOf(fetchImpl).length, 2);
  assert.deepEqual(result.status.counts.rateLimitWaits, {});
  assert.match(
    source(result, "dexscreener").note,
    /Stopped for this run: rate limited \(HTTP 429\); asked to wait 400 s/,
  );
  assert.ok(clock.time - T0 < 60000, "the run did not sit out the wait");
});

test("COLLECTOR_RETRY_AFTER_CAP_MS shortens what a run will wait", async () => {
  let dex = 0;
  const shorter = await collect({
    onBatch: () => (++dex === 2 ? limited(23) : null),
    env: { COLLECTOR_RETRY_AFTER_CAP_MS: "10000" },
  });
  assert.equal(shorter.result.ok, false);
  assert.equal(dexCallsOf(shorter.fetchImpl).length, 2);
  dex = 0;
  const longer = await collect({
    onBatch: () => (++dex === 2 ? limited(23) : null),
    env: { COLLECTOR_RETRY_AFTER_CAP_MS: "900000" },
  });
  assert.equal(longer.result.ok, true, "a larger value cannot raise the cap");
  assert.equal(dexCallsOf(longer.fetchImpl).length, 6);
});

test("a network DEX Screener does not index is recorded, named in the note, and left to the fallback", async () => {
  // Its first batch is asked and not answered, so the network has to be small
  // next to the rest for the answered share of the gate (80%) to hold: 140
  // Base pools and the 40 of Ethereum, of which 30 are asked.
  const pools = [
    ...world(),
    ...Array.from({ length: 70 }, (_, i) =>
      statePool(200 + i, {
        chain: "base",
        hookAddress: BUNNI_BASE.toLowerCase(),
      }),
    ),
  ];
  const { result, fetchImpl, published } = await collect({
    pools,
    onBatch: (call, n, slug) =>
      slug === "ethereum" ? { status: 400, body: "bad request" } : null,
  });
  assert.equal(result.ok, true, result.quality.failures.join("; "));
  assert.deepEqual(published.status.counts.unsupportedNetworks, ["ethereum"]);
  assert.equal(dexCallsOf(fetchImpl).length, 6, "five base batches, one eth");
  const note = source(result, "dexscreener").note;
  assert.ok(note.includes(" Does not index: Ethereum."), note);
  assert.doesNotMatch(note, /Stopped for this run/);
  // The 40 Ethereum pools were unresolved, and the fallback tried them.
  assert.equal(published.status.counts.measuredPools, 140);
  assert.equal(published.status.counts.fallbackRequests, 2);
  const gecko = fetchImpl.calls.filter((call) => call.url.includes("/multi/"));
  assert.equal(gecko.length, 2);
  assert.ok(gecko.every((call) => call.url.includes("/networks/eth/")));
  assert.equal(published.status.counts.requests.dexscreener, 6);
  assert.equal(published.status.counts.requests.geckoterminal, 2);
  assert.deepEqual(published.problems, []);
  // The stored status carries the same note.
  assert.equal(
    published.status.sources.find((entry) => entry.id === "dexscreener").note,
    note,
  );
});

test("the networks DEX Screener does not index are listed in alphabetical order", async () => {
  // Ethereum has more pools than Base, so the burst meets it first.
  const pools = [
    ...Array.from({ length: 70 }, (_, i) =>
      statePool(1 + i, {
        chain: "ethereum",
        hookAddress: BUNNI_ETH.toLowerCase(),
      }),
    ),
    ...Array.from({ length: 40 }, (_, i) =>
      statePool(100 + i, {
        chain: "base",
        hookAddress: BUNNI_BASE.toLowerCase(),
      }),
    ),
  ];
  const { result } = await collect({
    pools,
    onBatch: () => ({ status: 400, body: "bad request" }),
  });
  assert.deepEqual(result.status.counts.unsupportedNetworks, [
    "base",
    "ethereum",
  ]);
  const note = source(result, "dexscreener").note;
  assert.ok(note.includes(" Does not index: Base, Ethereum."), note);
  // Nothing was measured by DEX Screener, one request each was enough to know.
  assert.equal(result.status.counts.requests.dexscreener, 2);
  assert.equal(result.ok, false, "the gate still wants 80% of the plan");
});

// The notes.

test("a source note states a wait and an unindexed network in plain words", () => {
  const lane = (extra = {}) => ({
    requests: 3,
    succeeded: 3,
    firstRequestAt: T0,
    lastRequestAt: T0 + 60000,
    stopped: null,
    ...extra,
  });
  const notes = (stats, extra = {}) =>
    Object.fromEntries(
      providerSources({
        stats: {
          dexscreener: lane(),
          geckoterminal: lane(),
          v4xyz: lane(),
          ...stats,
        },
        measured: new Map([
          [
            "a",
            {
              metricProvider: "dexscreener",
              metricUpdatedAt: "2026-10-28T12:00:30.000Z",
            },
          ],
        ]),
        discovery: {
          geckoPages: 1,
          indexerLists: 1,
          indexerListed: 1,
          resolvesTried: 1,
        },
        census: null,
        registrySources: [],
        ...extra,
      }).map((entry) => [entry.id, entry.note]),
    );
  const waited = notes({
    dexscreener: lane({ rateLimitWaits: 1, rateLimitWaitedMs: 23000 }),
    geckoterminal: lane({ rateLimitWaits: 1, rateLimitWaitedMs: 24400 }),
    v4xyz: lane({
      rateLimitWaits: 1,
      rateLimitWaitedMs: 10000,
      stopped: { reason: "rate limited again after waiting (HTTP 429)" },
    }),
  });
  assert.match(
    waited.dexscreener,
    /\. Waited 23 s after a rate-limit answer \(1 time\)\.$/,
  );
  assert.match(
    waited.geckoterminal,
    /Data provided by GeckoTerminal\. Waited 24 s after a rate-limit answer \(1 time\)\.$/,
  );
  assert.match(
    waited.v4xyz,
    / Waited 10 s after a rate-limit answer \(1 time\)\. Stopped for this run: rate limited again after waiting \(HTTP 429\)\.$/,
  );
  const plural = notes({
    dexscreener: lane({ rateLimitWaits: 2, rateLimitWaitedMs: 50000 }),
  });
  assert.match(
    plural.dexscreener,
    /Waited 50 s after a rate-limit answer \(2 times\)\./,
  );
  // A wait is said to the nearest second.
  for (const [ms, seconds] of [
    [23400, 23],
    [23600, 24],
    [800, 1],
  ])
    assert.match(
      notes({ dexscreener: lane({ rateLimitWaits: 1, rateLimitWaitedMs: ms }) })
        .dexscreener,
      new RegExp(` Waited ${seconds} s after a rate-limit answer`),
      `${ms} ms`,
    );
  // No wait, no sentence about one (a lane from before this field existed too).
  const quiet = notes({
    dexscreener: lane({ rateLimitWaits: 0, rateLimitWaitedMs: 0 }),
  });
  for (const note of Object.values(quiet)) assert.doesNotMatch(note, /Waited/);

  // The unindexed networks carry the names the page shows, sorted, with the slug
  // for one the page does not name.
  const unindexed = notes(
    {},
    {
      unsupportedNetworks: ["worldchain", "zzz-chain", "bnb"],
      chains: [
        { slug: "worldchain", name: "World Chain" },
        { slug: "bnb", name: "BNB Chain" },
      ],
    },
  );
  assert.match(
    unindexed.dexscreener,
    / pools it did not return, or returned without one, are unresolved, not zero\. Does not index: BNB Chain, World Chain, zzz-chain\.$/,
  );
  assert.doesNotMatch(unindexed.geckoterminal, /Does not index/);
  assert.doesNotMatch(unindexed.v4xyz, /Does not index/);
  const together = notes(
    { dexscreener: lane({ rateLimitWaits: 1, rateLimitWaitedMs: 23000 }) },
    {
      unsupportedNetworks: ["bnb"],
      chains: [{ slug: "bnb", name: "BNB Chain" }],
    },
  );
  assert.match(
    together.dexscreener,
    /not zero\. Does not index: BNB Chain\. Waited 23 s after a rate-limit answer \(1 time\)\.$/,
  );
  assert.doesNotMatch(notes({}).dexscreener, /Does not index/);
});

// Files that must keep a promise this behaviour would otherwise break.

const fileText = (path) =>
  readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("the fixture recorder keeps its promise never to retry: its client has the cooldown off", async () => {
  // A cap of 0 stops a provider at the first 429, as before (tested above). The
  // recorder is a script that reaches real providers when run, so it is read,
  // not run.
  const recorder = await fileText("collector/tools/record-fixtures.mjs");
  assert.match(recorder, /It never retries/);
  assert.match(
    recorder,
    /createHttpClient\(\{[^}]*\brateLimitCapMs:\s*0\b[^}]*\}\)/,
  );
});

test("long source notes wrap inside the Data & sources dialog in the edition, and the live dialog is untouched", async () => {
  const edition = await fileText("src/components/edition.css");
  const dialogs = await fileText("src/design/dialogs.css");
  // The unbreakable GitHub addresses in the notes made each row wider than a
  // phone, cutting off the new "Does not index" and "Waited" sentences. The fix
  // is scoped to the dialog that shows the edition's collection run.
  assert.match(
    edition,
    /\.modal-body:has\(\.edition-run\) \.source-item p\s*\{[^}]*overflow-wrap:\s*anywhere/,
  );
  const shared = /\.source-item p\s*\{([^}]*)\}/.exec(dialogs);
  assert.ok(shared, "the shared rule is still there");
  assert.doesNotMatch(shared[1], /overflow-wrap|word-break/);
});
