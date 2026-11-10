import { useEffect, useRef, useState } from "react";
import {
  ANALYTICS_OVERVIEW_MAX_BYTES,
  analyticsOverviewQueryKey,
  isAnalyticsOverviewEnvelope,
  type AnalyticsOverviewEnvelope,
  type AnalyticsOverviewQuery,
} from "../shared/analytics-overview";
import { loadRecordedHistory } from "./edition-data";
import {
  STATIC_EDITION,
  isOlderPublication,
  overviewAnswer,
  overviewUrl,
  withRecordedHistory,
} from "./edition";
import {
  createStallGuard,
  failureOf,
  overviewFailureMessage,
  withRun,
} from "./edition-shell";

/** Per-network overview files the host has said it does not have, for the life
 * of the page: asking again would only repeat the 404. */
const unpublished = new Set<string>();

export function useAnalyticsOverview(
  enabled: boolean,
  query: AnalyticsOverviewQuery,
  retry: number,
  /** Edition: the run the file should belong to, asked for under its own
   * address when a stale edge may be holding the old one. */
  run?: string | null,
) {
  const key = analyticsOverviewQueryKey(query);
  // Read when a request starts, not a reason to start one: a run is always
  // asked for together with a retry, and clearing it must not fetch again.
  const runRef = useRef(run);
  runRef.current = run;
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    key: string;
    data?: AnalyticsOverviewEnvelope;
    error?: string;
    loading: boolean;
    recovering?: boolean;
    /** Edition: the snapshot publishes no file for this network. */
    notPublished?: boolean;
  }>({ key: "", loading: false });
  useEffect(() => {
    // Published files change only when the next snapshot is deployed.
    if (!enabled || STATIC_EDITION) return;
    const refresh = () => {
      if (!document.hidden) setRevision((n) => n + 1);
    };
    const timer = setInterval(refresh, 30000);
    window.addEventListener("online", refresh);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", refresh);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [enabled]);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let disposed = false;
    // The live page gives a file 30 s in all; the edition gives up on a file
    // that stops arriving, so a slow link can still finish it.
    const stall = STATIC_EDITION
      ? createStallGuard(() => controller.abort())
      : null;
    const deadline = stall
      ? undefined
      : setTimeout(() => controller.abort(), 30000);
    setState((previous) => ({
      key,
      loading: true,
      ...(previous.key === key && previous.data ? { data: previous.data } : {}),
      // Edition: the failure stays on screen, with its Retry button, while the
      // retry runs; the button is not unmounted under keyboard focus.
      ...(STATIC_EDITION && previous.key === key && previous.error
        ? { error: previous.error }
        : {}),
    }));
    void (async () => {
      try {
        // The edition reads the file the collector published for this query
        // (with its contribution ledger); it asks the host to revalidate, not
        // to skip its cache.
        const staticUrl = STATIC_EDITION ? overviewUrl(query) : null;
        if (STATIC_EDITION && staticUrl === null)
          throw new Error(
            "This view is not published for that network and window.",
          );
        if (staticUrl !== null && unpublished.has(staticUrl)) {
          if (!disposed) setState({ key, loading: false, notPublished: true });
          return;
        }
        const response = await fetch(
          staticUrl !== null
            ? runRef.current
              ? withRun(staticUrl, runRef.current)
              : staticUrl
            : `/api/analytics/overview?${new URLSearchParams({ chain: query.chain, window: query.window })}`,
          STATIC_EDITION
            ? { signal: controller.signal, cache: "no-cache" }
            : {
                signal: controller.signal,
                cache: "no-store",
                headers: { "X-Radar-Analytics-Contributions": "1" },
              },
        );
        if (!response.ok) {
          if (STATIC_EDITION) {
            if (
              overviewAnswer(response.status, query.chain) === "not-published"
            ) {
              if (staticUrl !== null) unpublished.add(staticUrl);
              if (!disposed)
                setState({ key, loading: false, notPublished: true });
              return;
            }
            throw new Error(
              overviewFailureMessage({
                kind: "status",
                status: response.status,
              }),
            );
          }
          if (response.status === 503) {
            if (!disposed)
              setState({
                key,
                loading: false,
                recovering: true,
                error: "Analytics will open after saved data is verified.",
              });
            return;
          }
          throw new Error(
            response.status === 429
              ? "Too many requests. Try again shortly."
              : "Analytics could not load. Please retry.",
          );
        }
        if (
          !response.body ||
          Number(response.headers.get("content-length")) >
            ANALYTICS_OVERVIEW_MAX_BYTES
        )
          throw new Error("Analytics response exceeded its safe size.");
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        let value: unknown;
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            stall?.touch();
            size += part.value.byteLength;
            if (size > ANALYTICS_OVERVIEW_MAX_BYTES)
              throw new Error("Analytics response exceeded its safe size.");
            chunks.push(part.value);
          }
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          value = JSON.parse(new TextDecoder().decode(bytes));
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        if (!isAnalyticsOverviewEnvelope(value, query))
          throw new Error("Analytics returned an unsupported response.");
        const shown = STATIC_EDITION
          ? withRecordedHistory(
              value,
              await loadRecordedHistory(controller.signal),
            )
          : value;
        // The page judges this overview at its own publication time (App.tsx
        // sets the clock from it). A file older than the one on screen, from a
        // host or edge that kept the old run, does not replace it.
        if (!disposed)
          setState((previous) => ({
            key,
            loading: false,
            data:
              STATIC_EDITION &&
              previous.key === key &&
              previous.data &&
              isOlderPublication(
                shown.publication.generatedAt,
                previous.data.publication.generatedAt,
              )
                ? previous.data
                : shown,
          }));
      } catch (cause) {
        const failure = STATIC_EDITION
          ? failureOf(cause, stall?.stalled() ?? false)
          : null;
        if (!disposed)
          setState((previous) => ({
            key,
            loading: false,
            ...(previous.key === key ? { data: previous.data } : {}),
            error: failure
              ? overviewFailureMessage(failure)
              : controller.signal.aborted
                ? "Analytics took too long. Please retry."
                : cause instanceof Error &&
                    !["TypeError", "SyntaxError"].includes(cause.name)
                  ? cause.message
                  : "Analytics could not load. Check your connection and retry.",
          }));
      } finally {
        stall?.stop();
        clearTimeout(deadline);
      }
    })();
    return () => {
      disposed = true;
      stall?.stop();
      clearTimeout(deadline);
      controller.abort();
    };
  }, [enabled, key, retry, revision]);
  return state.key === key ? state : { key, loading: enabled };
}
