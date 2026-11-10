/** What the Auto Snapshot edition's app shell decides without React: saved
 * projects the snapshot does not carry, the order of compared ids, how two
 * files from two runs are brought together, how a download is judged stalled
 * and what a failed load tells the visitor.
 *
 * Nothing here reads the flag: App.tsx and the analytics hook call these only
 * in the edition, so the live page keeps its own behaviour and wording. */
import { reconcileRuns, snapshotUrl } from "./edition.ts";

/* ── Saved projects ────────────────────────────────────────────────────── */

/** The watchlist key itself is written only when the visitor stars, un-stars or
 * forgets a project. Names live beside it, under a key of their own. */
export const SAVED_NAMES_KEY = "hook-radar-watchlist-names-v1";

const ID = /^[a-z0-9][a-z0-9-]{0,99}$/;
const NAME_MAX = 120;
const NAMES_MAX = 2000;

/** Saved project id -> the name it had when it was last seen in a snapshot. */
export type SavedNames = Readonly<Record<string, string>>;

/** The name map from its stored text. Anything unreadable is simply no names. */
export function parseSavedNames(text: string | null | undefined): SavedNames {
  try {
    const value: unknown = JSON.parse(text || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const names: Record<string, string> = {};
    for (const [id, name] of Object.entries(value)) {
      if (
        Object.keys(names).length < NAMES_MAX &&
        ID.test(id) &&
        typeof name === "string" &&
        name.trim() &&
        name.length <= NAME_MAX
      )
        names[id] = name;
    }
    return names;
  } catch {
    return {};
  }
}

/** The map with one saved project's name set, or dropped when `name` is null.
 * The same object comes back when nothing changed. */
export function withSavedName(
  names: SavedNames,
  id: string,
  name: string | null | undefined,
): SavedNames {
  const next = typeof name === "string" ? name.trim() : "";
  if (!next || next.length > NAME_MAX) {
    if (!(id in names)) return names;
    const { [id]: _drop, ...rest } = names;
    return rest;
  }
  return names[id] === next ? names : { ...names, [id]: next };
}

/** The names of the saved projects the snapshot carries, merged into the map,
 * so an entry that later drops out of a snapshot can still be called by its
 * name. Entries no longer saved are dropped. The same object comes back when
 * nothing changed. */
export function rememberSavedNames(
  names: SavedNames,
  saved: readonly string[],
  projects: readonly { id: string; name: string }[],
): SavedNames {
  const keep = new Set(saved);
  let next = names;
  for (const id of Object.keys(names))
    if (!keep.has(id)) next = withSavedName(next, id, null);
  const byId = new Map(projects.map((project) => [project.id, project.name]));
  for (const id of saved) {
    const name = byId.get(id);
    if (name !== undefined) next = withSavedName(next, id, name);
  }
  return next;
}

/** The saved ids this snapshot does not carry, in the order they were saved. */
export function savedNotInSnapshot(
  saved: readonly string[],
  carried: { has(id: string): boolean },
): string[] {
  return saved.filter((id) => !carried.has(id));
}

const plural = (count: number, one: string, many: string) =>
  count === 1 ? one : many;
const figure = (count: number) => count.toLocaleString("en-US");

/** What the Watchlist says about saved projects the snapshot does not carry. It
 * names no cause: the snapshot holds registry-named projects and projects with
 * a measured pool, and a saved one can be in one snapshot and not the next. */
export function savedNotInSnapshotNotice(count: number): string {
  return `${figure(count)} saved ${plural(count, "project is", "projects are")} not in this snapshot. ${plural(count, "It stays", "They stay")} saved and will show again when a snapshot includes ${plural(count, "it", "them")}.`;
}

/** The empty Watchlist whose every saved project is outside the snapshot. */
export const SAVED_NONE_IN_SNAPSHOT =
  "Nothing you saved is in this snapshot. It carries registry-named projects and projects with a measured pool, so a saved project can be missing from one snapshot and return in a later one.";

/** The line for the export dialog: the files hold only what the snapshot has. */
export function savedExportNote(count: number): string {
  return `${figure(count)} saved ${plural(count, "project is", "projects are")} not in this snapshot, so ${plural(count, "it is", "they are")} not in these files.`;
}

/** The most saved entries the notice lists; the rest are named once these are
 * forgotten. */
export const SAVED_LIST_MAX = 8;

/* ── Compared projects ─────────────────────────────────────────────────── */

/** The ids with the ones the snapshot carries first. The address keeps four
 * ids, so when a link names projects the snapshot lacks and more is added, it
 * is those that fall off the end, not the project that was just chosen. */
export function carriedFirst(
  ids: readonly string[],
  carried: { has(id: string): boolean },
): string[] {
  return [
    ...ids.filter((id) => carried.has(id)),
    ...ids.filter((id) => !carried.has(id)),
  ];
}

/* ── Files from two runs ───────────────────────────────────────────────── */

/** How often the older of two mismatched files is asked for again before the
 * page says a newer snapshot is still being published. */
export const RECONCILE_ATTEMPTS = 3;

export type ReconcileStep =
  "settled" | "reload-snapshot" | "reload-overview" | "late";

/** The next move for a snapshot and an overview file from the given runs,
 * after `used` attempts: nothing to do, ask for the older file again, or give
 * up and say so. */
export function reconcileStep(
  overviewAt: string | null | undefined,
  snapshotAt: string | null | undefined,
  used: number,
  attempts: number = RECONCILE_ATTEMPTS,
): ReconcileStep {
  const action = reconcileRuns(overviewAt, snapshotAt);
  if (action === null) return "settled";
  return used >= attempts ? "late" : action;
}

export const PUBLISHING_NOTE =
  "A newer snapshot is still being published; reload in a minute.";

/** A file's address with the run it should belong to. A host or edge that kept
 * the old file under the plain address answers a new address from the source. */
export function withRun(url: string, generatedAt: string): string {
  return `${url}?v=${encodeURIComponent(generatedAt)}`;
}

export const snapshotUrlFor = (generatedAt: string, base?: string) =>
  withRun(snapshotUrl(base), generatedAt);

/* ── A download that has stopped ───────────────────────────────────────── */

/** A download is given up when no bytes have arrived for this long, however
 * long the whole file takes: a big file on a slow link must be able to finish. */
export const STALL_MS = 30_000;

export interface StallGuard {
  /** Bytes arrived: the wait starts again. */
  touch(): void;
  /** The download is over, or no longer wanted. */
  stop(): void;
  /** The wait ran out and `onStall` was called. */
  stalled(): boolean;
}

export function createStallGuard(
  onStall: () => void,
  stallMs: number = STALL_MS,
): StallGuard {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  let fired = false;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      fired = true;
      onStall();
    }, stallMs);
  };
  arm();
  return {
    touch() {
      if (!done && !fired) arm();
    },
    stop() {
      done = true;
      clearTimeout(timer);
    },
    stalled: () => fired,
  };
}

/** The JSON body of a response, read piece by piece so each piece counts as
 * progress. A response without a readable stream is read whole. */
export async function readJsonBody(
  response: Response,
  onBytes?: () => void,
): Promise<unknown> {
  const stream = response.body;
  if (!stream) return response.json();
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      onBytes?.();
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return JSON.parse(text);
}

/* ── What a failed load says ───────────────────────────────────────────── */

/** After this many automatic attempts the page stops trying by itself and
 * leaves the manual button. */
export const RECONNECT_LIMIT = 5;

export type LoadFailure =
  | { kind: "status"; status: number }
  | { kind: "network" }
  | { kind: "unreadable" }
  | { kind: "stalled" };

/** The sentence for a snapshot that did not load. There is no service to name
 * and no refresh to cool down: a static host has files, and the files are
 * being replaced when a new snapshot is published. */
export function snapshotFailureMessage(failure: LoadFailure): string {
  switch (failure.kind) {
    case "status":
      return failure.status === 429
        ? "The snapshot could not be loaded. The host is busy; try again in a minute."
        : "The snapshot could not be loaded. The site may be updating; try again in a few minutes.";
    case "network":
      return "The snapshot could not be loaded. Check your connection and try again.";
    case "unreadable":
      return "The snapshot could not be read. The site may be updating; try again in a few minutes.";
    case "stalled":
      return "The snapshot stopped downloading. Check your connection and try again.";
  }
}

/** The same for an analytics overview file. */
export function overviewFailureMessage(failure: LoadFailure): string {
  switch (failure.kind) {
    case "status":
      return failure.status === 429
        ? "Analytics could not load. The host is busy; try again in a minute."
        : "Analytics could not load. The site may be updating; try again in a few minutes.";
    case "network":
      return "Analytics could not load. Check your connection and try again.";
    case "unreadable":
      return "Analytics could not be read. The site may be updating; try again in a few minutes.";
    case "stalled":
      return "Analytics stopped downloading. Check your connection and try again.";
  }
}

/** The failure a thrown value stands for. `stalled` is whether the stall guard
 * ended the download. A message the code threw itself is not a kind. */
export function failureOf(
  cause: unknown,
  stalled: boolean,
): LoadFailure | null {
  if (stalled) return { kind: "stalled" };
  if (cause instanceof TypeError) return { kind: "network" };
  if (cause instanceof SyntaxError) return { kind: "unreadable" };
  return null;
}

export const NOT_PUBLISHED_TITLE =
  "No analytics are published for this network in this snapshot";
