import { useEffect, useMemo, useRef, useState } from "react";
import type { RadarSnapshot } from "../shared/types";
import { directorySearch, isDirectoryPage } from "./directory";
import { STATIC_EDITION } from "./edition";
import {
  WATCH_CHANGES_KEY,
  decodeWatchChanges,
  emptyWatchChanges,
  mergeWatchChanges,
  observeWatchChanges,
  readMark,
  trackedBaselines,
  watchRecheckDelay,
} from "./watch-changes";

function read() {
  try {
    return decodeWatchChanges(localStorage.getItem(WATCH_CHANGES_KEY));
  } catch {
    return emptyWatchChanges();
  }
}
export function useWatchChanges(
  snapshot: RadarSnapshot | null,
  watched: string[],
  enabled: boolean,
) {
  const [state, setState] = useState(read);
  const [storageAvailable, setStorageAvailable] = useState(true);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const stateRef = useRef(state);
  const snapshotRef = useRef(snapshot);
  const resetEpoch = useRef(0);
  stateRef.current = state;
  snapshotRef.current = snapshot;
  const watchedKey = watched.join(",");
  // The edition has no timer to notice a newer snapshot: the comparison runs
  // again when the page loads one (a different generatedAt) or the saved
  // projects change. Constant on the live page, so its effect is unchanged.
  const snapshotKey = STATIC_EDITION ? (snapshot?.generatedAt ?? "") : "";
  const carried = useMemo(
    () =>
      STATIC_EDITION && snapshot
        ? new Set(snapshot.projects.map((project) => project.id))
        : null,
    [snapshot],
  );
  function persist(next: typeof state) {
    stateRef.current = next;
    setState(next);
    try {
      localStorage.setItem(WATCH_CHANGES_KEY, JSON.stringify(next));
      setStorageAvailable(true);
    } catch {
      setStorageAvailable(false);
    }
  }
  useEffect(() => {
    const listener = (event: StorageEvent) => {
      if (event.key !== WATCH_CHANGES_KEY && event.key !== null) return;
      if (event.newValue === null) resetEpoch.current++;
      const next =
        event.newValue === null
          ? emptyWatchChanges()
          : mergeWatchChanges(
              stateRef.current,
              decodeWatchChanges(event.newValue),
            );
      stateRef.current = next;
      setState(next);
    };
    window.addEventListener("storage", listener);
    return () => window.removeEventListener("storage", listener);
  }, []);
  useEffect(() => {
    const snapshot = snapshotRef.current;
    const wanted = new Set(watched);
    const previous = stateRef.current;
    if (
      previous.baselines.some((b) => !wanted.has(b.id)) ||
      previous.changes.some((c) => !wanted.has(c.projectId))
    )
      persist({
        ...previous,
        baselines: previous.baselines.filter((b) => wanted.has(b.id)),
        changes: previous.changes.filter((c) => wanted.has(c.projectId)),
      });
    if (!snapshot || !enabled || !watched.length) {
      setChecking(false);
      return;
    }
    const controller = new AbortController();
    let disposed = false;
    let nextCheck: ReturnType<typeof setTimeout> | undefined;
    const deadline = setTimeout(
      () =>
        controller.abort(
          new DOMException("Update checks took too long", "TimeoutError"),
        ),
      60000,
    );
    // Comparing with a file already in memory is not a wait worth announcing.
    if (!STATIC_EDITION) setChecking(true);
    setError("");
    void (async () => {
      try {
        const wanted = new Set(watched);
        const projects = snapshot.projects.filter((project) =>
          wanted.has(project.id),
        );
        const loaded = new Set(projects.map((project) => project.id));
        // Without a directory service (the static edition) a watched project
        // outside the snapshot is simply not observed.
        const missing = STATIC_EDITION
          ? []
          : watched.filter((id) => !loaded.has(id));
        const record = async (rows: typeof projects) => {
          const epoch = resetEpoch.current;
          const next = await observeWatchChanges(
            stateRef.current,
            rows,
            watched,
            snapshot.generatedAt,
          );
          if (controller.signal.aborted || epoch !== resetEpoch.current) return;
          const merged = mergeWatchChanges(
            mergeWatchChanges(read(), stateRef.current),
            next,
          );
          persist({
            ...merged,
            baselines: merged.baselines.filter((b) => wanted.has(b.id)),
            changes: merged.changes.filter((c) => wanted.has(c.projectId)),
          });
        };
        await record(projects);
        // Only unloaded watched identities need a request. Each bounded batch is
        // unfiltered, so changing a directory network cannot manufacture changes.
        for (let offset = 0; offset < missing.length; offset += 50) {
          const params = directorySearch(
            {
              search: "",
              chain: "all",
              category: "all",
              property: "all",
              market: "all",
            },
            { key: "name", direction: "asc" },
            "h24",
            missing.slice(offset, offset + 50),
          );
          params.set("saved", "1");
          params.set("limit", "50");
          const query = params.toString();
          const response = await fetch(
            query.length > 6000 ? "/api/directory" : `/api/directory?${query}`,
            {
              signal: controller.signal,
              ...(query.length > 6000
                ? {
                    method: "POST",
                    headers: {
                      "Content-Type":
                        "application/x-www-form-urlencoded;charset=UTF-8",
                    },
                    body: query,
                  }
                : {}),
            },
          );
          if (!response.ok)
            throw Error(
              response.status === 429
                ? "Update checks are busy. Retry shortly."
                : "Some watched projects could not be checked. Retry to continue.",
            );
          const result: unknown = await response.json();
          if (!isDirectoryPage(result, snapshot))
            throw Error("The update check returned an unsupported response.");
          await record(
            result.projects.filter((project) => wanted.has(project.id)),
          );
        }
      } catch (cause) {
        if (!disposed && !controller.signal.aborted)
          setError(
            cause instanceof Error &&
              !["TypeError", "SyntaxError"].includes(cause.name)
              ? cause.message
              : "Some watched projects could not be checked. Your earlier updates are preserved.",
          );
        else if (!disposed && controller.signal.reason?.name === "TimeoutError")
          setError("Update checks took too long. Retry to continue.");
      } finally {
        clearTimeout(deadline);
        if (!disposed) {
          setChecking(false);
          const delay = watchRecheckDelay();
          if (delay !== null)
            nextCheck = setTimeout(() => setRetry((value) => value + 1), delay);
        }
      }
    })();
    return () => {
      disposed = true;
      clearTimeout(deadline);
      clearTimeout(nextCheck);
      controller.abort();
    };
  }, [watchedKey, enabled, retry, snapshotKey]);
  const ids = new Set(watched);
  const changes = state.changes.filter((change) => ids.has(change.projectId));
  const baselines = trackedBaselines(state.baselines, ids, carried);
  return {
    changes,
    baselines,
    checking,
    error,
    storageAvailable,
    unread: changes.filter(
      (change) =>
        !state.readAt ||
        Date.parse(change.observedAt) > Date.parse(state.readAt),
    ).length,
    markRead: () =>
      persist({
        ...stateRef.current,
        readAt: readMark(stateRef.current.changes),
      }),
    retry: () => setRetry((value) => value + 1),
  };
}
