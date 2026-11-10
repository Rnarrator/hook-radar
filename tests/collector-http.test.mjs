import test from "node:test";
import assert from "node:assert/strict";
import {
  DS_GAP_MS,
  GT_GAP_MS,
  MAX_CONSECUTIVE_FAILURES,
  resolveGaps,
  userAgent,
  V4_GAP_MS,
} from "../collector/config.mjs";
import {
  createHttpClient,
  observationTime,
  ProviderError,
  retryAfterMs,
} from "../collector/http.mjs";
import { blockNetwork, FakeClock, fakeFetch } from "../collector/testing.mjs";

blockNetwork();

const DS = "https://api.dexscreener.com/latest/dex/pairs/base/";
const GT = "https://api.geckoterminal.com/api/v2/networks/base/dexes";
const V4 = "https://www.v4.xyz/api/pools?chainId=8453";

function harness(answer, options = {}) {
  const clock = new FakeClock();
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
const rejects = (promise, code) =>
  assert.rejects(
    promise,
    (error) => error instanceof ProviderError && error.code === code,
  );

test("observation time is the response Date minus its Age, never the time we looked", () => {
  const received = Date.parse("2026-10-28T12:00:10.400Z");
  const date = "Wed, 28 Oct 2026 12:00:10 GMT";
  // Fresh response: the Date second is the moment it was true.
  assert.equal(
    observationTime({ receivedAt: received, date, age: null }),
    Date.parse("2026-10-28T12:00:10.000Z"),
  );
  // A cached copy: Age says how long ago it was generated.
  assert.equal(
    observationTime({ receivedAt: received, date, age: "120" }),
    received - 120000,
  );
  // A small Age never makes it newer than the Date allows.
  assert.equal(
    observationTime({ receivedAt: received, date, age: "0" }),
    Date.parse("2026-10-28T12:00:10.000Z"),
  );
  // No headers at all: the moment of receipt, as the live collector does.
  assert.equal(observationTime({ receivedAt: received }), received);
  // A Date older than receipt (slow transfer) counts from the Date.
  assert.equal(
    observationTime({
      receivedAt: received,
      date: "Wed, 28 Oct 2026 12:00:00 GMT",
      age: null,
    }),
    Date.parse("2026-10-28T12:00:00.000Z"),
  );
});

test("observation time rejects an impossible Date or Age instead of guessing", () => {
  const received = Date.parse("2026-10-28T12:00:10.000Z");
  assert.throws(
    () => observationTime({ receivedAt: received, date: null, age: "-3" }),
    (error) => error.code === "age",
  );
  assert.throws(
    () => observationTime({ receivedAt: received, date: null, age: "1.5" }),
    (error) => error.code === "age",
  );
  assert.throws(
    () =>
      observationTime({
        receivedAt: received,
        date: "Wed, 28 Oct 2026 12:05:10 GMT",
        age: null,
      }),
    (error) => error.code === "clock",
  );
  assert.throws(
    () =>
      observationTime({ receivedAt: received, date: "not a date", age: null }),
    (error) => error.code === "clock",
  );
  assert.throws(
    () => observationTime({ receivedAt: 1000, date: null, age: "5" }),
    (error) => error.code === "clock",
  );
});

test("Retry-After parses seconds and HTTP dates", () => {
  const now = Date.parse("2026-10-28T12:00:00.000Z");
  assert.equal(retryAfterMs("7", now), 7000);
  assert.equal(retryAfterMs("Wed, 28 Oct 2026 12:00:30 GMT", now), 30000);
  assert.equal(retryAfterMs("Wed, 28 Oct 2026 11:00:00 GMT", now), 0);
  assert.equal(retryAfterMs("soon", now), null);
  assert.equal(retryAfterMs(null, now), null);
});

test("gap overrides can raise the contract gaps and never lower them", () => {
  assert.deepEqual(
    { ...resolveGaps({}) },
    {
      dexscreener: DS_GAP_MS,
      geckoterminal: GT_GAP_MS,
      v4xyz: V4_GAP_MS,
      registry: 1000,
      frontier: 1000,
    },
  );
  const raised = resolveGaps({
    COLLECTOR_DS_GAP_MS: "900",
    COLLECTOR_GT_GAP_MS: "20000",
    COLLECTOR_V4_GAP_MS: "7000",
  });
  assert.equal(raised.dexscreener, 900);
  assert.equal(raised.geckoterminal, 20000);
  assert.equal(raised.v4xyz, 7000);
  const lowered = resolveGaps({
    COLLECTOR_DS_GAP_MS: "1",
    COLLECTOR_GT_GAP_MS: "0",
    COLLECTOR_V4_GAP_MS: "-5",
  });
  assert.equal(lowered.dexscreener, DS_GAP_MS);
  assert.equal(lowered.geckoterminal, GT_GAP_MS);
  assert.equal(lowered.v4xyz, V4_GAP_MS);
  const junk = resolveGaps({
    COLLECTOR_DS_GAP_MS: "fast",
    COLLECTOR_GT_GAP_MS: "",
  });
  assert.equal(junk.dexscreener, DS_GAP_MS);
  assert.equal(junk.geckoterminal, GT_GAP_MS);
});

test("the User-Agent names the project and its repository, truthfully", () => {
  assert.match(
    userAgent({ GITHUB_REPOSITORY: "someone/hook-radar" }),
    /^HookRadarAutoSnapshot\/\S+ \(\+https:\/\/github\.com\/someone\/hook-radar\)$/,
  );
  for (const bad of [
    undefined,
    "",
    "no-slash",
    "a/b/c",
    "x/y z",
    "../etc/passwd",
  ])
    assert.match(
      userAgent({ GITHUB_REPOSITORY: bad }),
      /\(local run; no repository configured\)/,
    );
});

test("every request carries the configured User-Agent and asks for JSON", async () => {
  const { client, fetchImpl } = harness(() => ({ body: { ok: true } }));
  await client.getJson("dexscreener", `${DS}0xabc`);
  const { headers } = fetchImpl.calls[0];
  assert.equal(
    headers["user-agent"],
    "Test/1 (+https://github.com/example/repo)",
  );
  assert.equal(headers.accept, "application/json");
});

test("requests to one provider are spaced by its gap, others are independent", async () => {
  const { client, fetchImpl, clock } = harness(() => ({ body: {} }));
  for (let i = 0; i < 4; i++) await client.getJson("dexscreener", `${DS}${i}`);
  for (let i = 0; i < 3; i++)
    await client.getJson("geckoterminal", `${GT}?page=${i}`);
  for (let i = 0; i < 3; i++) await client.getJson("v4xyz", `${V4}&i=${i}`);
  const starts = (prefix) =>
    fetchImpl.calls
      .filter((call) => call.url.startsWith(prefix))
      .map((call) => call.at);
  const gaps = (times) =>
    times.slice(1).map((time, index) => time - times[index]);
  assert.ok(
    gaps(starts("https://api.dexscreener.com")).every((g) => g >= DS_GAP_MS),
  );
  assert.ok(
    gaps(starts("https://api.geckoterminal.com")).every((g) => g >= GT_GAP_MS),
  );
  assert.ok(gaps(starts("https://www.v4.xyz")).every((g) => g >= V4_GAP_MS));
  // The first request of a provider does not wait for a gap that never began.
  assert.equal(
    starts("https://api.dexscreener.com")[0],
    Date.parse("2026-10-28T12:00:00.000Z"),
  );
  assert.ok(clock.sleeps.length > 0);
});

test("concurrent callers of one provider are queued, never overlapped", async () => {
  let active = 0;
  let peak = 0;
  const { client } = harness(async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return { body: {} };
  });
  await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      client.getJson("dexscreener", `${DS}${i}`),
    ),
  );
  assert.equal(peak, 1);
});

// A 429 that names no wait, and every 403, stop the provider at once. (A 429
// that does name a wait earns one cooldown: tests/collector-resilience.test.mjs.)
for (const [status, headers, code] of [
  [429, {}, "rate-limited"],
  [403, { "retry-after": "30" }, "forbidden"],
]) {
  test(`HTTP ${status} stops that provider for the rest of the run, with no retry`, async () => {
    const { client, fetchImpl } = harness((call) =>
      call.url.startsWith("https://api.dexscreener.com")
        ? { status, headers, body: { error: "slow down" } }
        : { body: { ok: 1 } },
    );
    await rejects(client.getJson("dexscreener", `${DS}1`), code);
    const sent = fetchImpl.calls.length;
    await rejects(client.getJson("dexscreener", `${DS}2`), "stopped");
    await rejects(client.getJson("dexscreener", `${DS}3`), "stopped");
    assert.equal(fetchImpl.calls.length, sent, "no further request was made");
    assert.equal(client.isStopped("dexscreener"), true);
    const stats = client.stats().dexscreener;
    assert.equal(stats.requests, 1);
    assert.equal(stats.stopped.status, status);
    assert.equal(stats.retryAfterMs, headers["retry-after"] ? 30000 : null);
    // Another provider is untouched.
    const other = await client.getJson("geckoterminal", `${GT}?page=1`);
    assert.deepEqual(other.data, { ok: 1 });
    assert.equal(client.isStopped("geckoterminal"), false);
  });
}

test("Retry-After on a server error delays the next request to that provider", async () => {
  let first = true;
  const { client, fetchImpl } = harness(() => {
    if (first) {
      first = false;
      return { status: 503, headers: { "retry-after": "45" } };
    }
    return { body: {} };
  });
  await rejects(client.getJson("v4xyz", V4), "http");
  const failedAt = fetchImpl.calls[0].at;
  await client.getJson("v4xyz", `${V4}&again=1`);
  assert.ok(fetchImpl.calls[1].at - failedAt >= 45000);
  assert.equal(client.isStopped("v4xyz"), false);
});

test("a Retry-After longer than a run may wait stops the provider", async () => {
  const { client } = harness(() => ({
    status: 503,
    headers: { "retry-after": "86400" },
  }));
  await rejects(client.getJson("v4xyz", V4), "http");
  await rejects(client.getJson("v4xyz", `${V4}&x=1`), "stopped");
});

test(`${MAX_CONSECUTIVE_FAILURES} failures in a row stop a provider; a success resets the count`, async () => {
  let fail = true;
  const { client } = harness(() => (fail ? { status: 500 } : { body: {} }));
  for (let i = 0; i < MAX_CONSECUTIVE_FAILURES - 1; i++)
    await rejects(client.getJson("v4xyz", `${V4}&i=${i}`), "http");
  fail = false;
  await client.getJson("v4xyz", `${V4}&ok=1`);
  fail = true;
  for (let i = 0; i < MAX_CONSECUTIVE_FAILURES - 1; i++)
    await rejects(client.getJson("v4xyz", `${V4}&j=${i}`), "http");
  assert.equal(client.isStopped("v4xyz"), false);
  await rejects(client.getJson("v4xyz", `${V4}&last=1`), "http");
  assert.equal(client.isStopped("v4xyz"), true);
  await rejects(client.getJson("v4xyz", `${V4}&after=1`), "stopped");
});

test("the observation time of a result comes from Date and Age", async () => {
  const { client, clock } = harness((call) => ({
    body: { ok: true },
    headers: {
      date: new Date(clock.now() - 2000).toUTCString(),
      age: "90",
    },
  }));
  const result = await client.getJson("dexscreener", `${DS}1`);
  assert.equal(result.observedAt, result.receivedAt - 90000);
  assert.equal(result.age, "90");
});

test("oversized responses are refused, by header and by streaming", async () => {
  const { client } = harness((call) =>
    call.url.endsWith("big")
      ? { body: "x".repeat(2000), headers: { "content-length": "2000" } }
      : { body: JSON.stringify({ pad: "y".repeat(2000) }) },
  );
  await rejects(
    client.getJson("dexscreener", `${DS}big`, { maxBytes: 1000 }),
    "size",
  );
  await rejects(
    client.getJson("dexscreener", `${DS}stream`, { maxBytes: 1000 }),
    "size",
  );
  assert.equal(
    (await client.getJson("dexscreener", `${DS}ok`, { maxBytes: 5000 })).bytes >
      2000,
    true,
  );
});

test("invalid JSON and numbers that underflow to zero are refused", async () => {
  const { client } = harness((call) => ({
    body: call.url.endsWith("bad") ? "<html>" : '{"volume": 1e-999}',
  }));
  await rejects(client.getJson("dexscreener", `${DS}bad`), "json");
  await rejects(client.getJson("dexscreener", `${DS}tiny`), "json");
});

test("a request that never answers times out", async () => {
  const clock = new FakeClock();
  const client = createHttpClient({
    fetchImpl: (url, { signal }) =>
      new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted"))),
      ),
    now: clock.now,
    sleep: clock.sleep,
    timeoutMs: 20,
  });
  await rejects(client.getJson("dexscreener", `${DS}1`), "timeout");
});

test("only the provider's own https host is ever requested", async () => {
  const { client, fetchImpl } = harness(() => ({ body: {} }));
  await rejects(
    client.getJson("dexscreener", "https://evil.example/latest"),
    "url",
  );
  await rejects(
    client.getJson("dexscreener", "http://api.dexscreener.com/latest"),
    "url",
  );
  await rejects(
    client.getJson("dexscreener", "https://api.geckoterminal.com/x"),
    "url",
  );
  await rejects(client.getJson("nobody", `${DS}1`), "provider");
  assert.equal(fetchImpl.calls.length, 0);
});

test("the run-wide and per-provider request budgets are hard limits", async () => {
  const { client, fetchImpl } = harness(() => ({ body: {} }), {
    maxRequests: 3,
    caps: { v4xyz: 1 },
  });
  await client.getJson("v4xyz", V4);
  await rejects(client.getJson("v4xyz", `${V4}&2=1`), "budget");
  await client.getJson("dexscreener", `${DS}1`);
  await client.getJson("dexscreener", `${DS}2`);
  await rejects(client.getJson("dexscreener", `${DS}3`), "budget");
  assert.equal(fetchImpl.calls.length, 3);
  assert.equal(client.requestsLeft(), 0);
});

test("redirects are not followed", async () => {
  const clock = new FakeClock();
  let options;
  const client = createHttpClient({
    fetchImpl: async (url, init) => {
      options = init;
      return new Response("{}", {
        status: 200,
        headers: { date: new Date(clock.now()).toUTCString() },
      });
    },
    now: clock.now,
    sleep: clock.sleep,
  });
  await client.getJson("dexscreener", `${DS}1`);
  assert.equal(options.redirect, "error");
});
