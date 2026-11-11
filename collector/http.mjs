import { parseJsonWithoutUnderflow } from "../server/source-json.mjs";
import {
  COOLDOWN_PROVIDERS,
  MAX_CONSECUTIVE_FAILURES,
  MAX_REQUEST_BODY_BYTES,
  MAX_REQUESTS_PER_RUN,
  MAX_RETRY_AFTER_MS,
  PROVIDERS,
  RATE_LIMIT_DEFAULT_WAIT_MS,
  RATE_LIMIT_WAIT_CAP_MS,
  REQUEST_TIMEOUT_MS,
  resolveGaps,
  userAgent as defaultUserAgent,
} from "./config.mjs";

export class ProviderError extends Error {
  constructor(code, message, fields = {}) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    Object.assign(this, fields);
  }
}

// An HTTP date: a day name, then a date, then a time of day ("Wed, 28 Oct 2026
// 12:00:23 GMT", or the older "Wednesday, 28-Oct-26 12:00:23 GMT"). Date.parse
// alone is too lenient: it reads "+5", "5." or "1 2" as a date long past, which
// would mean "wait 0 seconds" for a header that names no wait at all.
const HTTP_DATE = /^[A-Za-z]{3,9},?\s.*\d{1,2}:\d{2}:\d{2}/;

/** Retry-After as milliseconds, from delta-seconds (a fraction is allowed) or an
 * HTTP date. Anything else names no wait: null. */
export function retryAfterMs(value, receivedAt) {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  let ms;
  if (/^\d+(?:\.\d+)?$/.test(text)) ms = Number(text) * 1000;
  else if (HTTP_DATE.test(text)) ms = Date.parse(text) - receivedAt;
  else return null;
  return Number.isFinite(ms) ? Math.max(0, Math.ceil(ms)) : null;
}

/** The moment a response was true: its Date minus its Age, exactly as the live
 * collector derives it. Never the moment we looked. */
export function observationTime({ receivedAt, date = null, age = null }) {
  if (age !== null && !/^\d+$/.test(age))
    throw new ProviderError("age", "Source returned an invalid cache age.");
  const ageMs = age === null ? 0 : Number(age) * 1000;
  const origin = date === null ? null : Date.parse(date);
  if (
    !Number.isFinite(ageMs) ||
    ageMs < 0 ||
    (date !== null && (!Number.isFinite(origin) || origin > receivedAt + 60000))
  )
    throw new ProviderError("clock", "Source cache time is unavailable.");
  const observedAt =
    receivedAt -
    Math.max(ageMs, origin === null ? 0 : Math.max(0, receivedAt - origin));
  if (observedAt < 0 || !Number.isFinite(observedAt))
    throw new ProviderError(
      "clock",
      "Source cache time is outside the supported range.",
    );
  return observedAt;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readBounded(response, maxBytes, signal) {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes)
    throw new ProviderError("size", "Response exceeded its size limit.");
  const reader = response.body?.getReader();
  if (!reader) return { text: "", bytes: 0 };
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > maxBytes)
        throw new ProviderError("size", "Response exceeded its size limit.");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  return { text: Buffer.concat(chunks).toString("utf8"), bytes };
}

/** Cloudflare's rate-limit answer, which a provider behind it sends as the body
 * of an HTTP 429 (sometimes without a Retry-After header). */
const CLOUDFLARE_RATE_LIMIT = /error code:?\s*1015\b/i;
const RATE_LIMIT_BODY_BYTES = 4096;

/** Per-provider paced client. One request at a time per provider, a minimum gap
 * between request starts, a truthful User-Agent, and the only retry there is:
 * the first HTTP 429 that says how long to wait gives a market or identity
 * provider one cooldown per run (the wait, then the refused request once more,
 * with the provider's gap doubled). Any other refusal, a second 429 and every 403
 * stop the provider for the run. */
export function createHttpClient({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  sleep = defaultSleep,
  userAgent = defaultUserAgent(),
  gaps = resolveGaps(),
  maxRequests = MAX_REQUESTS_PER_RUN,
  caps = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
  rateLimitCapMs = RATE_LIMIT_WAIT_CAP_MS,
  onEvent = null,
} = {}) {
  const lanes = new Map(
    Object.keys(PROVIDERS).map((id) => [
      id,
      {
        gap: gaps[id],
        cap: Number.isSafeInteger(caps[id]) ? caps[id] : Infinity,
        nextAt: 0,
        tail: Promise.resolve(),
        failures: 0,
        stopped: null,
        requests: 0,
        succeeded: 0,
        failed: 0,
        bytes: 0,
        firstAt: null,
        lastAt: null,
        lastStatus: null,
        retryAfterMs: null,
        cooldowns: 0,
        waitedMs: 0,
      },
    ]),
  );
  let total = 0;

  const lane = (id) => {
    const found = lanes.get(id);
    if (!found) throw new ProviderError("provider", `Unknown provider ${id}`);
    return found;
  };
  const stop = (state, reason, fields = {}) => {
    state.stopped ??= { reason, at: now(), ...fields };
  };
  const emit = (event) => {
    try {
      onEvent?.(event);
    } catch {
      /* Logging can never change a request. */
    }
  };

  /** What a 429 or 403 means for the provider: the first 429 that says how long
   * to wait is a cooldown (returns when the refused request may start again, and
   * the doubled gap); everything else is a reason to stop. */
  async function answerRefusal(
    id,
    state,
    response,
    { retry, startedAt, notAfter, signal },
  ) {
    if (response.status === 403) {
      await response.body?.cancel().catch(() => {});
      return { reason: "forbidden (HTTP 403)" };
    }
    const reason = "rate limited (HTTP 429)";
    if (state.cooldowns > 0) {
      await response.body?.cancel().catch(() => {});
      return { reason: "rate limited again after waiting (HTTP 429)" };
    }
    if (!COOLDOWN_PROVIDERS.includes(id) || rateLimitCapMs <= 0) {
      await response.body?.cancel().catch(() => {});
      return { reason };
    }
    let waitMs = retry;
    if (waitMs === null) {
      // Cloudflare may name no wait in a header; its page then says why.
      let cloudflare = false;
      try {
        const body = await readBounded(response, RATE_LIMIT_BODY_BYTES, signal);
        cloudflare = CLOUDFLARE_RATE_LIMIT.test(body.text);
      } catch {
        /* An unreadable body names no wait. */
      }
      waitMs = cloudflare ? RATE_LIMIT_DEFAULT_WAIT_MS : null;
    } else await response.body?.cancel().catch(() => {});
    if (waitMs === null) return { reason };
    if (waitMs > rateLimitCapMs)
      return {
        reason: `${reason}; asked to wait ${Math.ceil(waitMs / 1000)} s, more than this run waits`,
      };
    const gap = state.gap * 2;
    const startAt = Math.max(state.nextAt, startedAt + gap, now() + waitMs);
    if (notAfter !== undefined && startAt > notAfter)
      return {
        reason: `${reason}; the wait would end after the time allowed for this phase`,
      };
    if (total >= maxRequests || state.requests >= state.cap)
      return {
        reason: `${reason}; the request budget has no room to try again`,
      };
    return { gap, startAt };
  }

  async function perform(id, state, url, options) {
    const {
      maxBytes,
      timeout,
      notAfter,
      tolerate = [],
      method,
      body: sent,
    } = options;
    if (state.stopped)
      throw new ProviderError(
        "stopped",
        `${PROVIDERS[id].name} is stopped for this run (${state.stopped.reason}).`,
      );
    if (total >= maxRequests || state.requests >= state.cap)
      throw new ProviderError(
        "budget",
        "The request budget of this run is spent.",
      );
    if (
      (method !== "GET" && method !== "POST") ||
      (method === "POST"
        ? typeof sent !== "string" ||
          !sent ||
          Buffer.byteLength(sent) > MAX_REQUEST_BODY_BYTES
        : sent !== undefined)
    )
      throw new ProviderError("body", "The request is not allowed.");
    let target;
    try {
      target = new URL(url);
    } catch {
      throw new ProviderError("url", "Invalid request URL.");
    }
    if (target.protocol !== "https:" || target.hostname !== PROVIDERS[id].host)
      throw new ProviderError(
        "url",
        "The URL does not belong to this provider.",
      );
    // The gap and any Retry-After decide when this request could start; past the
    // caller's limit it is not sent at all.
    if (notAfter !== undefined && Math.max(state.nextAt, now()) > notAfter)
      throw new ProviderError(
        "budget",
        "The request could not start before the time allowed for this phase.",
      );
    for (let turn = 0; turn < 3; turn++) {
      const wait = state.nextAt - now();
      if (wait <= 0) break;
      await sleep(wait);
    }
    const startedAt = now();
    state.nextAt = Math.max(startedAt, state.nextAt) + state.gap;
    state.requests++;
    total++;
    state.firstAt ??= startedAt;
    state.lastAt = startedAt;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let response;
    const failure = (error) => {
      state.failed++;
      state.failures++;
      if (state.failures >= MAX_CONSECUTIVE_FAILURES)
        stop(state, "too many consecutive failures");
      emit({
        provider: id,
        url,
        ok: false,
        code: error.code,
        status: error.status ?? null,
      });
      return error;
    };
    try {
      try {
        response = await fetchImpl(url, {
          method,
          ...(method === "POST" ? { body: sent } : {}),
          redirect: "error",
          signal: controller.signal,
          headers: {
            accept: "application/json",
            "user-agent": userAgent,
            ...(method === "POST"
              ? { "content-type": "application/json" }
              : {}),
          },
        });
      } catch (error) {
        throw failure(
          new ProviderError(
            controller.signal.aborted ? "timeout" : "network",
            controller.signal.aborted
              ? "The request timed out."
              : "The request could not be completed.",
          ),
        );
      }
      state.lastStatus = response.status;
      const retry = retryAfterMs(response.headers.get("retry-after"), now());
      if (retry !== null) state.retryAfterMs = retry;
      if (response.status === 429 || response.status === 403) {
        const refusal = await answerRefusal(id, state, response, {
          retry,
          startedAt,
          notAfter,
          signal: controller.signal,
        });
        state.failed++;
        if (refusal.startAt !== undefined) {
          // The one cooldown of this run: wait, slow down, ask once more. The
          // retry is a request of its own and is counted and limited as one.
          state.cooldowns++;
          state.gap = refusal.gap;
          state.nextAt = refusal.startAt;
          state.waitedMs += Math.max(0, refusal.startAt - now());
          emit({
            provider: id,
            url,
            ok: false,
            code: "cooldown",
            status: response.status,
          });
          clearTimeout(timer);
          return await perform(id, state, url, options);
        }
        stop(state, refusal.reason, {
          status: response.status,
          retryAfterMs: retry,
        });
        emit({
          provider: id,
          url,
          ok: false,
          code: "stopped",
          status: response.status,
        });
        throw new ProviderError(
          response.status === 429 ? "rate-limited" : "forbidden",
          `${PROVIDERS[id].name} answered HTTP ${response.status}; it is not used again in this run.`,
          { status: response.status, retryAfterMs: retry },
        );
      }
      if (retry !== null) {
        if (retry > MAX_RETRY_AFTER_MS)
          stop(state, "Retry-After is longer than this run may wait", {
            status: response.status,
            retryAfterMs: retry,
          });
        else state.nextAt = Math.max(state.nextAt, now() + retry);
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (tolerate.includes(response.status)) {
          // An answer about this request, not a sign that the provider is
          // failing: the caller sees an error, the breaker does not.
          state.failed++;
          emit({
            provider: id,
            url,
            ok: false,
            code: "http",
            status: response.status,
          });
          throw new ProviderError("http", `HTTP ${response.status}`, {
            status: response.status,
          });
        }
        throw failure(
          new ProviderError("http", `HTTP ${response.status}`, {
            status: response.status,
          }),
        );
      }
      let body;
      try {
        body = await readBounded(response, maxBytes, controller.signal);
      } catch (error) {
        throw failure(
          error instanceof ProviderError
            ? error
            : new ProviderError(
                controller.signal.aborted ? "timeout" : "network",
                "The response could not be read.",
              ),
        );
      }
      let data;
      try {
        data = parseJsonWithoutUnderflow(body.text);
      } catch {
        throw failure(
          new ProviderError("json", "The response was not valid JSON."),
        );
      }
      const receivedAt = now();
      let observedAt;
      try {
        observedAt = observationTime({
          receivedAt,
          date: response.headers.get("date"),
          age: response.headers.get("age"),
        });
      } catch (error) {
        throw failure(error);
      }
      state.failures = 0;
      state.succeeded++;
      state.bytes += body.bytes;
      emit({
        provider: id,
        url,
        ok: true,
        status: response.status,
        bytes: body.bytes,
      });
      return {
        provider: id,
        url,
        status: response.status,
        data,
        bytes: body.bytes,
        receivedAt,
        observedAt,
        date: response.headers.get("date"),
        age: response.headers.get("age"),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Fetch one JSON document. Rejects with a ProviderError; retries only after
   * the one rate-limit cooldown described above. The request is a GET; a `body`
   * (a JSON text of at most MAX_REQUEST_BODY_BYTES) makes it the one kind of
   * POST the edition sends, a query to the public index Frontier names.
   * `notAfter` (a clock time) refuses, with code "budget", a request that would
   * have to start later than that, a cooldown included.
   * `tolerate` lists HTTP statuses that are an answer about this request alone:
   * they reject with code "http" but do not count toward the consecutive-failure
   * limit. */
  async function getJson(
    id,
    url,
    {
      maxBytes = 1024 * 1024,
      timeoutMs: timeout = timeoutMs,
      notAfter,
      tolerate = [],
      body,
    } = {},
  ) {
    const state = lane(id);
    const method = body === undefined ? "GET" : "POST";
    const run = () =>
      perform(id, state, url, {
        maxBytes,
        timeout,
        notAfter,
        tolerate,
        method,
        body,
      });
    const result = state.tail.then(run, run);
    state.tail = result.then(
      () => {},
      () => {},
    );
    return await result;
  }

  return {
    getJson,
    isStopped: (id) => lane(id).stopped !== null,
    requestCount: () => total,
    requestsLeft: () => Math.max(0, maxRequests - total),
    stats() {
      return Object.fromEntries(
        [...lanes].map(([id, state]) => [
          id,
          {
            requests: state.requests,
            succeeded: state.succeeded,
            failed: state.failed,
            bytes: state.bytes,
            firstRequestAt: state.firstAt,
            lastRequestAt: state.lastAt,
            lastStatus: state.lastStatus,
            retryAfterMs: state.retryAfterMs,
            rateLimitWaits: state.cooldowns,
            rateLimitWaitedMs: state.waitedMs,
            gapMs: state.gap,
            stopped: state.stopped ? { ...state.stopped } : null,
          },
        ]),
      );
    },
  };
}
