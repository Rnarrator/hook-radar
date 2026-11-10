import { useEffect, useRef, useState } from "react";
import {
  DISCOVERY_MAX_BYTES,
  type DiscoveryEnvelope,
} from "../shared/discovery";
import {
  discoveryQueryFromParams,
  isDiscoveryEnvelope,
} from "./discovery-validation";
import { takeEarlyDiscovery } from "./early-discovery";
import { safeStartupProgress } from "../shared/startup-progress";
import type { RadarStartupProgress } from "../shared/types";

export type DiscoveryReadiness =
  | { status: "idle" }
  | { status: "loading"; key: string }
  | { status: "ready"; key: string; data: DiscoveryEnvelope }
  | { status: "recovering"; key: string; progress: RadarStartupProgress | null }
  | { status: "error"; key: string; message: string };

async function readEnvelope(response: Response): Promise<unknown> {
  if (
    !response.body ||
    Number(response.headers.get("content-length")) > DISCOVERY_MAX_BYTES
  )
    throw new Error("The hook directory response is too large or incomplete.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > DISCOVERY_MAX_BYTES)
        throw new Error("The hook directory response is too large.");
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

type DiscoveryLoad =
  | { kind: "ready"; value: DiscoveryEnvelope }
  | { kind: "recovering"; progress: RadarStartupProgress | null };

/** One bounded discovery request for a query. Throws a person-readable Error
 * for anything but a validated envelope or the service's "starting" reply. */
async function loadDiscovery(
  query: string,
  signal: AbortSignal,
): Promise<DiscoveryLoad> {
  const body = query.length > 6000;
  const url = body ? "/api/discovery" : `/api/discovery?${query}`;
  // The plain Discover page was already asked for while the bundle downloaded.
  const early = body ? null : await takeEarlyDiscovery(url);
  if (signal.aborted) throw new DOMException("aborted", "AbortError");
  const response =
    early ??
    (await fetch(url, {
      signal,
      ...(body
        ? {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            },
            body: query,
          }
        : {}),
    }));
  if (!response.ok && response.status !== 503)
    throw new Error(
      response.status === 429
        ? "Too many searches. Try again shortly."
        : "The hook directory could not load. Please retry.",
    );
  const value: unknown = await readEnvelope(response);
  if (signal.aborted) throw new DOMException("aborted", "AbortError");
  if (
    response.status === 503 &&
    value &&
    typeof value === "object" &&
    "code" in value &&
    value.code === "RADAR_STARTING"
  )
    return {
      kind: "recovering",
      progress: safeStartupProgress(
        "startupProgress" in value ? value.startupProgress : null,
      ),
    };
  if (!response.ok)
    throw new Error(
      response.status === 429
        ? "Too many searches. Try again shortly."
        : "The hook directory could not load. Please retry.",
    );
  const expected = discoveryQueryFromParams(new URLSearchParams(query));
  if (!expected || !isDiscoveryEnvelope(value, expected))
    throw new Error("The hook directory returned an unsupported response.");
  return { kind: "ready", value };
}

const failureMessage = (cause: unknown, aborted: boolean) =>
  aborted
    ? "The hook directory took too long. Please retry."
    : cause instanceof Error &&
        !["TypeError", "SyntaxError"].includes(cause.name)
      ? cause.message
      : "The hook directory could not load. Check your connection and retry.";

/** Consecutive quiet refreshes that may fail before the failure is shown. */
const QUIET_FAILURES_BEFORE_NOTICE = 2;

/** A directory publication never stands in for the analytics snapshot.
 * Abandoned queries cannot publish data, errors or readiness into a later view.
 *
 * `refreshKey` asks for the same query again without leaving the ready state:
 * the page keeps the rows it has (each ages by its own clock and expires on its
 * own) and swaps in the new publication when it arrives. A refresh that fails
 * is retried by the next one; only after repeated failures does the failure
 * surface, so a brief hiccup does not put a notice on a page that still reads
 * correctly. A surfaced failure is retried the same way and clears itself when
 * a refresh succeeds. */
export function useDiscoveryBootstrap({
  enabled,
  query,
  retry,
  recoveryRevision,
  refreshKey = 0,
}: {
  enabled: boolean;
  query: string;
  retry: number;
  recoveryRevision: number;
  refreshKey?: number;
}): DiscoveryReadiness {
  const [state, setState] = useState<DiscoveryReadiness>({ status: "idle" });
  const latest = useRef({ enabled, query, state });
  latest.current = { enabled, query, state };
  const quiet = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let disposed = false;
    // A refresh still on its way belongs to the query being left.
    quiet.current?.abort();
    // Coming back to a query that is already on screen (a drawer was closed, the
    // service finished starting) keeps its rows while they are fetched again.
    const { state: held } = latest.current;
    const keep = held.status === "ready" && held.key === query;
    if (!keep) setState({ status: "loading", key: query });
    const timeout = setTimeout(() => controller.abort(), 30000);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const loaded = await loadDiscovery(query, controller.signal);
          if (disposed || controller.signal.aborted) return;
          setState(
            loaded.kind === "recovering"
              ? { status: "recovering", key: query, progress: loaded.progress }
              : { status: "ready", key: query, data: loaded.value },
          );
        } catch (cause) {
          // A kept page is retried by the next refresh rather than replaced by
          // an error; the repeated-failure notice below still applies.
          if (!disposed && !keep)
            setState({
              status: "error",
              key: query,
              message: failureMessage(cause, controller.signal.aborted),
            });
        } finally {
          clearTimeout(timeout);
        }
      })();
    }, 180);
    return () => {
      disposed = true;
      clearTimeout(timeout);
      clearTimeout(timer);
      controller.abort();
    };
  }, [enabled, query, retry, recoveryRevision]);
  const handled = useRef(refreshKey);
  const quietFailures = useRef(0);
  useEffect(() => {
    if (handled.current === refreshKey) return;
    handled.current = refreshKey;
    const { enabled: on, query: key, state: current } = latest.current;
    // A ready page is refreshed quietly, and so is one whose failure was
    // reported: the service coming back clears it without a click. Every other
    // state is already being loaded or waiting for the service to start.
    if (
      !on ||
      (current.status !== "ready" && current.status !== "error") ||
      current.key !== key
    )
      return;
    quiet.current?.abort();
    const controller = new AbortController();
    quiet.current = controller;
    const timeout = setTimeout(() => controller.abort(), 30000);
    void (async () => {
      try {
        const loaded = await loadDiscovery(key, controller.signal);
        if (controller.signal.aborted) return;
        const now = latest.current;
        if (!now.enabled || now.query !== key) return;
        quietFailures.current = 0;
        setState(
          loaded.kind === "recovering"
            ? { status: "recovering", key, progress: loaded.progress }
            : { status: "ready", key, data: loaded.value },
        );
      } catch (cause) {
        const now = latest.current;
        if (!now.enabled || now.query !== key) return;
        quietFailures.current += 1;
        if (
          current.status === "ready" &&
          quietFailures.current >= QUIET_FAILURES_BEFORE_NOTICE
        )
          setState({
            status: "error",
            key,
            message: failureMessage(cause, controller.signal.aborted),
          });
      } finally {
        clearTimeout(timeout);
      }
    })();
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [refreshKey]);
  return state;
}
