const aborted = (signal) =>
  signal?.reason ??
  new DOMException("Provider request was aborted", "AbortError");

// Internal request telemetry is carried through composed fetch wrappers, never
// sent as a header or left on the actual transport options.
export const PROVIDER_REQUEST_OBSERVER = Symbol("HookRadar provider observer");

function abortable(job, signal) {
  if (signal?.aborted) return Promise.reject(aborted(signal));
  if (!signal) return Promise.resolve(job);
  return new Promise((resolve, reject) => {
    const abort = () => reject(aborted(signal));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(job)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

function wait(ms, signal) {
  if (signal?.aborted) return Promise.reject(aborted(signal));
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(aborted(signal));
    };
    // Long Retry-After values are respected in bounded timer segments.
    const timer = setTimeout(
      () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      },
      Math.min(Math.max(0, ms), 60000),
    );
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function retryDelay(response, gap) {
  const value = response.headers.get("retry-after");
  const parsed =
    value && /^\d+(?:\.\d+)?$/.test(value.trim())
      ? Number(value) * 1000
      : value
        ? Date.parse(value) - Date.now()
        : NaN;
  return Math.max(gap, Number.isFinite(parsed) && parsed > 0 ? parsed : 60000);
}

/** Share one instance between refresh and enrichment owners. URLs are still
 * authored/validated by their SourceClients; this is not a request proxy. */
export function createProviderFetch({
  fetchImpl = fetch,
  geckoGapMs = 6500,
} = {}) {
  if (
    typeof fetchImpl !== "function" ||
    !Number.isFinite(geckoGapMs) ||
    geckoGapMs < 0
  )
    throw new Error(
      "Provider fetch requires a fetch function and nonnegative finite GeckoTerminal gap",
    );
  let tail = Promise.resolve(),
    nextStart = 0,
    backoffUntil = 0;
  let queuedRequests = 0,
    inFlightRequests = 0,
    transportStarts = 0,
    transportResponses = 0,
    lastTransportStartedAt = null,
    lastResponseAt = null,
    lastHttpStatus = null;
  const increment = (count) => Math.min(Number.MAX_SAFE_INTEGER, count + 1);
  const getProviderStatus = (provider = "geckoterminal") => {
    if (provider !== "geckoterminal") return null;
    const now = Date.now();
    return Object.freeze({
      minimumGapMs: geckoGapMs,
      nextPermitAt:
        Math.max(nextStart, backoffUntil) > now
          ? Math.max(nextStart, backoffUntil)
          : null,
      backoffUntil: backoffUntil > now ? backoffUntil : null,
      queuedRequests,
      inFlightRequests,
      transportStarts,
      transportResponses,
      lastTransportStartedAt,
      lastResponseAt,
      lastHttpStatus,
    });
  };
  async function providerFetch(input, options = {}) {
    let host;
    try {
      host = new URL(input instanceof Request ? input.url : input).hostname;
    } catch {
      return fetchImpl(input, options);
    }
    if (host !== "api.geckoterminal.com") return fetchImpl(input, options);
    const signal =
      options.signal ?? (input instanceof Request ? input.signal : undefined);
    if (signal?.aborted) throw aborted(signal);
    const observer = options[PROVIDER_REQUEST_OBSERVER];
    const { [PROVIDER_REQUEST_OBSERVER]: _observer, ...transportOptions } =
      options;
    const notify = (type, fields = {}) => {
      if (typeof observer !== "function") return;
      try {
        Promise.resolve(
          observer(
            Object.freeze({
              type,
              at: Date.now(),
              readyAt: Math.max(Date.now(), nextStart, backoffUntil),
              backoffUntil: backoffUntil > Date.now() ? backoffUntil : null,
              ...fields,
            }),
          ),
        ).catch(() => {});
      } catch {
        // Diagnostic consumers cannot change request pacing or outcomes.
      }
    };
    let queued = true;
    let dispatched = false;
    const releaseQueue = () => {
      if (!queued) return;
      queued = false;
      queuedRequests--;
    };
    queuedRequests++;
    notify("queued");
    const start = tail.then(async () => {
      while (Math.max(nextStart, backoffUntil) > Date.now())
        await wait(Math.max(nextStart, backoffUntil) - Date.now(), signal);
      if (signal?.aborted) throw aborted(signal);
      releaseQueue();
      dispatched = true;
      const startedAt = Date.now();
      lastTransportStartedAt = startedAt;
      transportStarts = increment(transportStarts);
      inFlightRequests++;
      nextStart = Date.now() + geckoGapMs;
      // Release the start queue once dispatched, rather than waiting for the
      // response. An uncooperative upstream cannot hold other owners forever.
      let flight;
      try {
        flight = Promise.resolve(fetchImpl(input, transportOptions));
      } catch (error) {
        inFlightRequests--;
        notify("dispatch", { at: startedAt });
        notify("failed");
        throw error;
      }
      flight.then(
        (response) => {
          inFlightRequests--;
          transportResponses = increment(transportResponses);
          lastResponseAt = Date.now();
          lastHttpStatus = response.status;
          // Provider-wide throttling belongs to the actual response, even when
          // its original reader has already timed out or disconnected.
          if (response.status === 429)
            backoffUntil = Math.max(
              backoffUntil,
              Date.now() + retryDelay(response, geckoGapMs),
            );
          notify("response", { httpStatus: response.status });
          if (signal?.aborted)
            void Promise.resolve()
              .then(() => response.body?.cancel())
              .catch(() => {});
        },
        () => {
          inFlightRequests--;
          notify("failed");
        },
      );
      notify("dispatch", { at: startedAt });
      return { flight };
    });
    tail = start.then(
      () => undefined,
      () => undefined,
    );
    try {
      const { flight } = await abortable(start, signal);
      return await abortable(flight, signal);
    } catch (error) {
      releaseQueue();
      if (signal?.aborted)
        notify(
          dispatched ? "cancelled-after-dispatch" : "cancelled-before-dispatch",
        );
      throw error;
    }
  }
  Object.defineProperty(providerFetch, "getProviderStatus", {
    value: getProviderStatus,
  });
  return providerFetch;
}
