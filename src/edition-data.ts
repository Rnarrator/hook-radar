/** Reads for the Auto Snapshot edition's published files. */
import type { Point, RadarProject } from "../shared/types";
import { historyUrl, parseHistory } from "./edition.ts";

/** The snapshot request the page's head script starts before the application
 * loads (editionPreload in vite.config.ts). */
export interface EarlySnapshot {
  url: string;
  /** Cancels the request, as the page's own stall guard cancels one. */
  abort: () => void;
  promise: Promise<Response>;
}

type EarlyHolder = { __hookRadarSnapshot?: EarlySnapshot };

/** The early request, once, for the first plain request of `url`; the holder is
 * emptied either way, so every retry or later request makes its own. Null when
 * the page started none (Learn, Analytics) or it names another address. The
 * request is cancelled with `signal`, so a download that stalls is ended. */
export function takeEarlySnapshot(
  url: string,
  signal: AbortSignal,
  holder: EarlyHolder = window as unknown as EarlyHolder,
): Promise<Response> | null {
  const early = holder.__hookRadarSnapshot;
  delete holder.__hookRadarSnapshot;
  if (
    !early ||
    early.url !== url ||
    typeof early.abort !== "function" ||
    typeof early.promise?.then !== "function"
  )
    return null;
  if (signal.aborted) early.abort();
  else signal.addEventListener("abort", () => early.abort(), { once: true });
  return early.promise;
}

/** The recorded network-wide series, or null when the file is absent or is not
 * a history file. A missing history is an empty panel, never an error. */
export async function loadRecordedHistory(
  signal?: AbortSignal,
): Promise<Point[] | null> {
  try {
    const response = await fetch(historyUrl(), { signal, cache: "no-cache" });
    if (!response.ok) return null;
    return parseHistory(await response.json());
  } catch {
    return null;
  }
}

type DirectoryProject = Pick<
  RadarProject,
  "id" | "name" | "category" | "deployments"
>;
let directory: readonly DirectoryProject[] = [];
let directoryVersion = 0;
const directoryListeners = new Set<() => void>();

/** The loaded snapshot's projects, for lookups that the live page makes of its
 * service (a hook address, a project name). Whoever loads a snapshot sets it. */
export const editionDirectory = {
  set(projects: readonly DirectoryProject[]) {
    directory = projects;
    directoryVersion++;
    for (const listener of directoryListeners) listener();
  },
  projects: () => directory,
  version: () => directoryVersion,
  subscribe(listener: () => void) {
    directoryListeners.add(listener);
    return () => {
      directoryListeners.delete(listener);
    };
  },
};
