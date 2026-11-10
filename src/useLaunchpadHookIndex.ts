import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { LaunchpadRecord } from "../shared/launchpad-registry.ts";
import { editionDirectory } from "./edition-data";
import { STATIC_EDITION, findIndexedHook } from "./edition";

export type HookIndexStatus =
  "loading" | "indexed" | "not-indexed" | "unavailable";

export interface HookIndexEntry {
  status: HookIndexStatus;
  /** The directory project holding this exact chain + address, if any. */
  project: {
    id: string;
    name: string;
    category: string;
    deploymentCount: number;
  } | null;
}

export const hookKey = (chain: string, address: string) =>
  `${chain}:${address.toLowerCase()}`;

const LOADING: HookIndexEntry = { status: "loading", project: null };
const UNAVAILABLE: HookIndexEntry = { status: "unavailable", project: null };
// An indexed contract stays indexed, so that resolution is kept for the
// session. "Not indexed" is only true as of the lookup: the directory can find
// the hook later, so that answer is re-checked after a few minutes.
const NOT_INDEXED_TTL_MS = 5 * 60 * 1000;
const settled = new Map<string, { entry: HookIndexEntry; at: number }>();
const current = (key: string) => {
  const hit = settled.get(key);
  if (!hit) return undefined;
  return hit.entry.status === "not-indexed" &&
    Date.now() - hit.at > NOT_INDEXED_TTL_MS
    ? undefined
    : hit.entry;
};

async function lookup(
  chain: string,
  address: string,
  signal: AbortSignal,
): Promise<HookIndexEntry> {
  try {
    const response = await fetch(
      `/api/discovery?search=${encodeURIComponent(address)}&limit=5`,
      { signal, headers: { accept: "application/json" } },
    );
    if (!response.ok) return UNAVAILABLE;
    const body: unknown = await response.json();
    const projects = (body as { page?: { projects?: unknown } })?.page
      ?.projects;
    if (!Array.isArray(projects)) return UNAVAILABLE;
    // Exact chain and address only: never a name or a prefix match.
    const match = projects.find(
      (project) =>
        Array.isArray(project?.deployments) &&
        project.deployments.some(
          (deployment: { chain?: unknown; address?: unknown }) =>
            deployment.chain === chain &&
            typeof deployment.address === "string" &&
            deployment.address.toLowerCase() === address.toLowerCase(),
        ),
    );
    return match
      ? {
          status: "indexed",
          project: {
            id: String(match.id),
            name: String(match.name),
            category: String(match.category),
            deploymentCount: match.deployments.length,
          },
        }
      : { status: "not-indexed", project: null };
  } catch {
    return UNAVAILABLE;
  }
}

/** Hooks shown per launch path before "Show all": a platform can publish dozens
 * of per-market hooks, and each shown hook costs one directory lookup. */
export const HOOK_PREVIEW = 8;

/** Looks up each hook a launchpad shows in the live directory, one bounded
 * request at a time. A failed lookup is "unavailable", never "not indexed".
 * `expanded` holds the path ids whose full hook list is open. */
export function useLaunchpadHookIndex(
  record: LaunchpadRecord | null,
  expanded: ReadonlySet<string> = new Set(),
): ReadonlyMap<string, HookIndexEntry> {
  // A build-time constant, so one of the two is used for the life of the page.
  return STATIC_EDITION
    ? useSnapshotHookIndex(record, expanded)
    : useServiceHookIndex(record, expanded);
}

/** The static edition has no directory service: an exact chain and address is
 * looked up among the loaded snapshot's own deployments. A hook it does not
 * hold is "not indexed" here only in the sense of "not in this snapshot", which
 * the page does not claim anything about. */
function useSnapshotHookIndex(
  record: LaunchpadRecord | null,
  expanded: ReadonlySet<string>,
): ReadonlyMap<string, HookIndexEntry> {
  const version = useSyncExternalStore(
    editionDirectory.subscribe,
    editionDirectory.version,
  );
  return useMemo(() => {
    void version;
    const projects = editionDirectory.projects();
    const entries = new Map<string, HookIndexEntry>();
    for (const path of record?.paths ?? [])
      for (const hook of expanded.has(path.id)
        ? path.hooks
        : path.hooks.slice(0, HOOK_PREVIEW)) {
        const match = findIndexedHook(projects, path.chain, hook.address);
        entries.set(
          hookKey(path.chain, hook.address),
          match
            ? {
                status: "indexed",
                project: {
                  id: match.id,
                  name: match.name,
                  category: match.category,
                  deploymentCount: match.deployments.length,
                },
              }
            : { status: "not-indexed", project: null },
        );
      }
    return entries;
  }, [record, expanded, version]);
}

function useServiceHookIndex(
  record: LaunchpadRecord | null,
  expanded: ReadonlySet<string>,
): ReadonlyMap<string, HookIndexEntry> {
  const hooks = useMemo(
    () =>
      record
        ? [
            ...new Map(
              record.paths.flatMap((path) =>
                (expanded.has(path.id)
                  ? path.hooks
                  : path.hooks.slice(0, HOOK_PREVIEW)
                ).map(
                  (hook) =>
                    [
                      hookKey(path.chain, hook.address),
                      { chain: path.chain, address: hook.address },
                    ] as const,
                ),
              ),
            ).values(),
          ]
        : [],
    [record, expanded],
  );
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    (async () => {
      for (const hook of hooks) {
        const key = hookKey(hook.chain, hook.address);
        if (current(key)) continue;
        const entry = await lookup(hook.chain, hook.address, controller.signal);
        if (cancelled) return;
        // Do not cache transient failures: a retry may succeed.
        if (entry.status !== "unavailable")
          settled.set(key, { entry, at: Date.now() });
        else settled.set(key + ":failed", { entry, at: Date.now() });
        setVersion((value) => value + 1);
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [hooks]);
  return useMemo(() => {
    void version;
    return new Map(
      hooks.map((hook) => {
        const key = hookKey(hook.chain, hook.address);
        return [
          key,
          current(key) ??
            settled.get(key + ":failed")?.entry ??
            settled.get(key)?.entry ??
            LOADING,
        ] as const;
      }),
    );
  }, [hooks, version]);
}
