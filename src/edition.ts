/** The Auto Snapshot edition: the same interface served as plain static files.
 *
 * Everything that differs from the live service sits behind STATIC_EDITION,
 * which is true only in a build made with VITE_STATIC_EDITION=1. With the flag
 * unset each helper here is inert (the clock is the visitor's, no path is
 * touched), so the live build behaves exactly as before.
 *
 * Time rule of this edition: the five-minute qualification of a measurement was
 * applied when the snapshot was collected, so the page evaluates freshness at
 * the snapshot's own time (generatedAt), never at the visitor's clock. Ages that
 * the live page shows relative to now ("2m ago") are shown as UTC clock times. */
import type { Point, RadarSnapshot, WindowKey } from "../shared/types";

function readFlag(): boolean {
  try {
    return import.meta.env.VITE_STATIC_EDITION === "1";
  } catch {
    // Plain Node (the unit tests): there is no bundler environment.
    return false;
  }
}

function readBase(): string {
  try {
    return import.meta.env.BASE_URL || "/";
  } catch {
    return "/";
  }
}

export const STATIC_EDITION: boolean = readFlag();

/** The owner's switch for the "Data & sources" dialog and everything that
 * leads to it or credits the data providers on the edition's page: the header
 * status pill, the "Data details" and "View data coverage" buttons, the
 * Sources and Data sources buttons of Analytics and Networks, the footer
 * button, and the footer's provider credit and logo-notices paragraphs. False
 * hides all of them; setting it to true gives the dialog and every way into it
 * back, with the credits. The dialog's own code stays in place either way. The
 * live service always has the dialog (SOURCES_DIALOG), whatever this says. */
export const EDITION_SOURCES_DIALOG: boolean = false;

/** Whether a build has the Data & sources dialog and its entry points: the
 * live service always, the edition when its owner's switch is on. */
export const sourcesDialogOffered = (edition: boolean, ownerSwitch: boolean) =>
  !edition || ownerSwitch;

/** Whether a build's footer shows the provider credit and the logo notices:
 * only the edition has them, and only with the owner's switch on. */
export const footerCreditsShown = (edition: boolean, ownerSwitch: boolean) =>
  edition && ownerSwitch;

export const SOURCES_DIALOG: boolean = sourcesDialogOffered(
  STATIC_EDITION,
  EDITION_SOURCES_DIALOG,
);
export const FOOTER_CREDITS: boolean = footerCreditsShown(
  STATIC_EDITION,
  EDITION_SOURCES_DIALOG,
);

/** How the page describes its own update rhythm. */
export const REFRESH_NOTE = "refreshed every few hours";

/** Past this age the rhythm above is no longer something to claim. The
 * workflow collects about once an hour (a run is held back for 45 minutes after
 * a snapshot, and for 90 after a failed run), so four hours is several runs
 * missed in a row: GitHub starting none, or the collector refusing to publish. */
export const SNAPSHOT_STALE_AFTER_MS = 4 * 60 * 60_000;

/** A visitor clock this far behind a snapshot is a wrong clock, not a snapshot
 * from the future; closer than this it is ordinary drift ("just now"). */
export const CLOCK_BEHIND_TOLERANCE_MS = 5 * 60_000;

/* ── Paths ─────────────────────────────────────────────────────────────── */

/** The build's base with a trailing slash: "/" at a domain root, "/repo/" at a
 * project sub-path, "./" for a relative build. */
export function baseOf(base: string = readBase()): string {
  const value = base === "" ? "./" : base;
  return value.endsWith("/") ? value : `${value}/`;
}

/** A file of the published data folder, next to the page and never an absolute
 * path of the host. */
export function dataUrl(file: string, base?: string): string {
  return `${baseOf(base)}data/${file}`;
}

/** A file from the site's public folder (a protocol logo, say) under the base. */
export function publicAsset(path: string, base?: string): string {
  if (!STATIC_EDITION && base === undefined) return path;
  if (!/^\/(?!\/)/.test(path)) return path;
  const prefix = baseOf(base);
  // Already under the base (the build rewrites literals in source): leave it.
  if (prefix.startsWith("/") && path.startsWith(prefix)) return path;
  return `${prefix}${path.slice(1)}`;
}

export const snapshotUrl = (base?: string) => dataUrl("snapshot.json", base);
export const historyUrl = (base?: string) => dataUrl("history.json", base);
export const statusUrl = (base?: string) => dataUrl("status.json", base);

const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;

/** The overview file for a query, or null when the snapshot publishes none: all
 * networks come for every window, a single network for 24 hours. */
export function overviewFile(query: {
  chain: string;
  window: WindowKey | string;
}): string | null {
  if (!["h1", "h6", "h24"].includes(query.window)) return null;
  if (query.chain === "all") return `overview-all-${query.window}.json`;
  return SLUG.test(query.chain) && query.window === "h24"
    ? `overview-${query.chain}-h24.json`
    : null;
}

export function overviewUrl(
  query: { chain: string; window: WindowKey | string },
  base?: string,
): string | null {
  const file = overviewFile(query);
  return file === null ? null : dataUrl(file, base);
}

/** What the host's answer for an overview file means. A single network's file
 * is named from the link, so a link can ask for one that was never published:
 * a 404 there says the snapshot has no analytics for that network, and asking
 * again cannot change it. A 404 on the all-networks file is a deploy in
 * progress or a host problem, which can pass; so can everything else. */
export type OverviewAnswer = "not-published" | "busy" | "failed";

export function overviewAnswer(status: number, chain: string): OverviewAnswer {
  if (status === 404 && chain !== "all") return "not-published";
  return status === 429 ? "busy" : "failed";
}

/* ── The evaluation clock ──────────────────────────────────────────────── */

export interface EvaluationClock {
  /** Freeze at a snapshot's generatedAt (ISO text or epoch ms); null thaws. */
  freeze(generatedAt: string | number | null | undefined): void;
  /** The frozen time, or the visitor's clock when nothing is frozen. */
  now(): number;
  /** The frozen time, or null. */
  frozen(): number | null;
}

export function createEvaluationClock(enabled: boolean): EvaluationClock {
  let at: number | null = null;
  return {
    freeze(generatedAt) {
      if (!enabled) return;
      const time =
        typeof generatedAt === "number"
          ? generatedAt
          : typeof generatedAt === "string"
            ? Date.parse(generatedAt)
            : NaN;
      at = Number.isFinite(time) && time >= 0 ? time : null;
    },
    now: () => at ?? Date.now(),
    frozen: () => at,
  };
}

const clock = createEvaluationClock(STATIC_EDITION);

/** Use the snapshot's own time for freshness from now on (edition only). */
export const freezeEvaluationClock = clock.freeze;
/** The time at which freshness is evaluated: the visitor's clock on the live
 * site, the snapshot's generatedAt in this edition. */
export const evaluationNow = clock.now;

/** The publication a rendered view is drawn from, and so the time its
 * freshness is judged at: the overview file for the lightweight Analytics page,
 * the snapshot for every other page. The other file stands in only while the
 * first has not loaded. Two files from two runs (a deploy landing between the
 * requests, an edge still holding the old snapshot) are never judged at each
 * other's time. Null when neither has loaded. */
export function viewPublicationAt(files: {
  lite: boolean;
  snapshotAt?: string | null;
  overviewAt?: string | null;
}): string | null {
  const drawn = files.lite ? files.overviewAt : files.snapshotAt;
  const other = files.lite ? files.snapshotAt : files.overviewAt;
  if (toMs(drawn) !== null) return drawn ?? null;
  return toMs(other) !== null ? (other ?? null) : null;
}

/** Whether a file that just arrived was published before the one on screen: a
 * host, cache or edge answering with an older run. The page keeps what it
 * shows. A time that cannot be read is not "older"; the validators decide. */
export function isOlderPublication(
  incoming: string | number | null | undefined,
  shown: string | number | null | undefined,
): boolean {
  const arrived = toMs(incoming);
  const held = toMs(shown);
  return arrived !== null && held !== null && arrived < held;
}

/* ── Absolute times ────────────────────────────────────────────────────── */

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const two = (value: number) => String(value).padStart(2, "0");

function toMs(value: string | number | null | undefined): number | null {
  const time = typeof value === "number" ? value : Date.parse(value ?? "");
  return Number.isFinite(time) && Number.isFinite(new Date(time).getTime())
    ? time
    : null;
}

/** "14:03" */
export const utcClock = (ms: number) => {
  const d = new Date(ms);
  return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
};
/** "28 Oct 2026" */
export const utcDate = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

/** "28 Oct" */
export const utcDayMonth = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};

/** "28 Oct 2026, 14:05 UTC": the full form, for a heading or a tooltip. */
export function fullTimeLabel(
  value: string | number | null | undefined,
): string | null {
  const ms = toMs(value);
  return ms === null ? null : `${utcDate(ms)}, ${utcClock(ms)} UTC`;
}

/** "28 Oct, 14:05 UTC": the date without the year, for a chart's readout and
 * axis, where every label is one of a run of dates in the same year or two.
 * Always the date, unlike timeLabel(), so a label never stands for two days. */
export function shortTimeLabel(
  value: string | number | null | undefined,
): string | null {
  const ms = toMs(value);
  return ms === null ? null : `${utcDayMonth(ms)}, ${utcClock(ms)} UTC`;
}

/** The short form: "14:03 UTC" on the reference day (the snapshot's own day),
 * "27 Oct, 14:03 UTC" within its year, the year added beyond it. */
export function timeLabel(
  value: string | number | null | undefined,
  reference: number = evaluationNow(),
): string | null {
  const ms = toMs(value);
  if (ms === null) return null;
  const at = new Date(ms);
  const ref = new Date(reference);
  const sameDay =
    at.getUTCFullYear() === ref.getUTCFullYear() &&
    at.getUTCMonth() === ref.getUTCMonth() &&
    at.getUTCDate() === ref.getUTCDate();
  if (sameDay) return `${utcClock(ms)} UTC`;
  const day = `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`;
  return at.getUTCFullYear() === ref.getUTCFullYear()
    ? `${day}, ${utcClock(ms)} UTC`
    : `${day} ${at.getUTCFullYear()}, ${utcClock(ms)} UTC`;
}

/** A span in the page's plain units: "5 min", "3 h 12 min", "1 d 2 h". */
function ageSpan(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `${hours} h ${rest} min` : `${hours} h`;
  }
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} d ${hours % 24} h` : `${days} d`;
}

/** How long ago the snapshot was taken by the visitor's clock. Display only: it
 * never reaches a freshness decision. */
export function snapshotAge(generatedAt: string | number, visitorNow: number) {
  const taken = toMs(generatedAt);
  if (taken === null) return null;
  const minutes = Math.floor(Math.max(0, visitorNow - taken) / 60000);
  return minutes < 1 ? "just now" : `${ageSpan(minutes)} ago`;
}

/** What the visitor reads where the age would stand when their clock is set
 * earlier than the snapshot: no age can be given, and "just now" would be false. */
export const CLOCK_BEHIND_NOTE = "this device’s clock is behind";

export interface SnapshotStatusLine {
  /** "Snapshot taken 28 Oct 2026, 14:05 UTC" */
  taken: string;
  /** The update rhythm, or null once the snapshot is too old to claim it. */
  note: string | null;
  /** "1 h ago", "just now", or the clock note; "" when no age can be given. */
  age: string;
  /** Older than the rhythm explains: a newer snapshot should have been published. */
  stale: boolean;
  /** "By this device’s clock, this snapshot is 3 d old; newer data should have
   * been published." (stale only). The age is the visitor's clock against the
   * snapshot's time, and a page cannot tell a late snapshot from a clock set
   * ahead, so the sentence says whose clock it is. */
  staleText: string | null;
  /** "28 Oct 2026, 14:05 UTC": the time the figures are from. */
  takenAt: string;
}

/** The dated line that stands in for the live "Data status": when the snapshot
 * was taken, how often it is renewed and how old it is by the visitor's clock.
 * Past SNAPSHOT_STALE_AFTER_MS the rhythm is dropped and the line says plainly
 * that the snapshot is old; a visitor clock behind the snapshot gets no age. */
export function snapshotStatusLine(
  generatedAt: string | number,
  visitorNow: number,
): SnapshotStatusLine | null {
  const takenAt = fullTimeLabel(generatedAt);
  const takenMs = toMs(generatedAt);
  if (takenAt === null || takenMs === null) return null;
  const elapsed = visitorNow - takenMs;
  const taken = `Snapshot taken ${takenAt}`;
  if (elapsed < -CLOCK_BEHIND_TOLERANCE_MS)
    return {
      taken,
      note: REFRESH_NOTE,
      age: CLOCK_BEHIND_NOTE,
      stale: false,
      staleText: null,
      takenAt,
    };
  const stale = elapsed > SNAPSHOT_STALE_AFTER_MS;
  return {
    taken,
    note: stale ? null : REFRESH_NOTE,
    age: snapshotAge(generatedAt, visitorNow) ?? "",
    stale,
    staleText: stale
      ? `By this device’s clock, this snapshot is ${ageSpan(Math.floor(elapsed / 60000))} old; newer data should have been published.`
      : null,
    takenAt,
  };
}

/** Said after "newer data should have been published" until the status check
 * has answered: the page cannot tell a late snapshot from a tab that has been
 * open for a long time, and a reload settles it. Once the status file has been
 * read, a newer run is offered with a Reload button and "nothing newer" leaves
 * the sentence as it is, since the site itself is late. */
export const RELOAD_HINT = "Reload this page to check for a newer one.";

const DAY_MS = 86_400_000;

/** How many whole UTC days the census lies before the snapshot: the difference
 * of the two dates the page shows ("27 Oct 2026" and the snapshot's), so a
 * reader who subtracts them gets the same number. Both times come from the
 * published data, never from the visitor's clock. Null when either time is
 * missing or unreadable, and when the census is newer than the snapshot: an
 * age that cannot be right is not shown. */
export function censusAgeDays(
  censusAt: string | number | null | undefined,
  snapshotAt: string | number | null | undefined,
): number | null {
  const census = toMs(censusAt);
  const snapshot = toMs(snapshotAt);
  if (census === null || snapshot === null) return null;
  const days = Math.floor(snapshot / DAY_MS) - Math.floor(census / DAY_MS);
  return days >= 0 ? days : null;
}

/** "15 days before this snapshot"; the same date is "the same day as this
 * snapshot" and the day before it "the day before this snapshot". */
export function censusAgeText(days: number | null): string | null {
  if (days === null || !Number.isInteger(days) || days < 0) return null;
  if (days === 0) return "the same day as this snapshot";
  return days === 1
    ? "the day before this snapshot"
    : `${days} days before this snapshot`;
}

/** Census figures (hooks found, pools using a hook) come from an indexer export
 * whose own time travels with them: "census as of 27 Oct 2026". Given the
 * snapshot's time as well, the label says how old the census was when the
 * snapshot was taken: "census as of 27 Oct 2026, 15 days before this snapshot". */
export function censusLabel(
  inventory: { generatedAt: string } | null | undefined,
  snapshotAt?: string | number | null,
): string | null {
  const taken = inventory ? fullTimeLabel(inventory.generatedAt) : null;
  const day = inventory ? toMs(inventory.generatedAt) : null;
  if (taken === null || day === null) return null;
  const age = censusAgeText(
    censusAgeDays(inventory?.generatedAt, snapshotAt ?? null),
  );
  return `census as of ${utcDate(day)}${age ? `, ${age}` : ""}`;
}

/** "Census as of 27 Oct 2026": the capitalised form, for a caption of its own. */
export function censusHeading(
  inventory: { generatedAt: string } | null | undefined,
  snapshotAt?: string | number | null,
): string | null {
  const label = censusLabel(inventory, snapshotAt);
  return label === null ? null : label.charAt(0).toUpperCase() + label.slice(1);
}

/** What the census cannot say about hooks, beside every hook figure: the count
 * is the sum of each network's own, so an address used on two networks counts
 * twice, and it holds nothing the census did not see. ("Counted once per
 * network" was tried and dropped: it reads as "each hook is counted once".) */
export const CENSUS_HOOKS_SCOPE =
  "A hook used on two networks is counted on both; newer hooks are not included.";

/* ── Navigation ────────────────────────────────────────────────────────── */

/** Activity and Frontier's extension explorer need the live service. A link to
 * Activity lands on Discover; an extension selection in a link is ignored. */
export function editionNavigation<
  T extends {
    view: string;
    activityProject?: unknown;
    extensionSelection?: unknown;
  },
>(state: T, enabled: boolean = STATIC_EDITION): T {
  if (!enabled) return state;
  const withoutExtension =
    state.extensionSelection != null
      ? { ...state, extensionSelection: null }
      : state;
  if (withoutExtension.view !== "activity") return withoutExtension;
  return { ...withoutExtension, view: "overview", activityProject: null };
}

/** A page left open is asked for a newer snapshot this often while it is
 * visible, and when the visitor returns to the tab after this long. What is
 * asked is the small status file (edition-status-probe.ts); the snapshot on
 * screen is never swapped silently. */
export const EDITION_RECHECK_MS = 15 * 60_000;

export function editionCatchUpDue(
  lastLoadedAt: number | null,
  visitorNow: number,
): boolean {
  return (
    lastLoadedAt !== null && visitorNow - lastLoadedAt > EDITION_RECHECK_MS
  );
}

/** The pages the edition offers, in navigation order. The guide ("learn") comes
 * last here, after the Watchlist; the live service keeps it second. The one
 * order serves the header tabs, the phone's bottom tab bar and the Jump list. */
export function editionViews<T extends string>(
  views: readonly T[],
  enabled: boolean = STATIC_EDITION,
): T[] {
  if (!enabled) return [...views];
  const offered = views.filter((view) => view !== "activity");
  return [
    ...offered.filter((view) => view !== "learn"),
    ...offered.filter((view) => view === "learn"),
  ];
}

/* ── Recorded history ──────────────────────────────────────────────────── */

/** The most points history.json may hold (84 days of hourly runs). It is the
 * collector's own cap (HISTORY_MAX_POINTS in collector/config.mjs, which this
 * file cannot import); tests/edition-history-cap.test.mjs holds the two equal. */
export const EDITION_HISTORY_MAX_POINTS = 2016;

/** The points of /data/history.json ({ schemaVersion: 1, points }), or null when
 * the file is not that. Each point keeps its own timestamp and value. */
export function parseHistory(value: unknown): Point[] | null {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as { schemaVersion?: unknown }).schemaVersion !== 1
  )
    return null;
  const points = (value as { points?: unknown }).points;
  if (!Array.isArray(points) || points.length > EDITION_HISTORY_MAX_POINTS)
    return null;
  const out: Point[] = [];
  let last = -Infinity;
  for (const point of points) {
    if (!point || typeof point !== "object" || Array.isArray(point))
      return null;
    const { timestamp, value: amount } = point as Record<string, unknown>;
    if (
      typeof timestamp !== "number" ||
      !Number.isSafeInteger(timestamp) ||
      timestamp <= 0 ||
      typeof amount !== "number" ||
      !Number.isFinite(amount) ||
      amount < 0 ||
      timestamp < last
    )
      return null;
    last = timestamp;
    out.push({ timestamp, value: amount });
  }
  return out;
}

/** How many pools stood behind each recorded value, by the point's timestamp,
 * for the points of a history file that say. The collector writes the count; a
 * count that is not a whole number of at least zero is left out, never guessed.
 * A series made from a sample that grows or shrinks moves for that reason too,
 * so the page shows the count beside the value. It is kept apart from the
 * points: the overview envelope's own checks admit a timestamp and a value
 * only. */
export function parseHistoryPools(value: unknown): Map<number, number> {
  const found = new Map<number, number>();
  const points =
    value && typeof value === "object"
      ? (value as { points?: unknown }).points
      : null;
  if (!Array.isArray(points)) return found;
  for (const point of points) {
    if (!point || typeof point !== "object") continue;
    const { timestamp, pools } = point as Record<string, unknown>;
    if (
      typeof timestamp === "number" &&
      typeof pools === "number" &&
      Number.isSafeInteger(pools) &&
      pools >= 0
    )
      found.set(timestamp, pools);
  }
  return found;
}

let poolsBehind = new Map<number, number>();
/** The pools behind the recorded points of the history file the page loaded. */
export const recordedPools = {
  replace(map: Map<number, number>) {
    poolsBehind = map;
  },
  get: (timestamp: number): number | undefined => poolsBehind.get(timestamp),
};

const epoch = (timestamp: number) =>
  timestamp < 1e12 ? timestamp * 1000 : timestamp;

/** Recorded points no later than `asOf`: an overview never describes a time
 * after its own evaluation. */
export function historyUpTo(points: readonly Point[], asOf: string): Point[] {
  const limit = Date.parse(asOf);
  return Number.isFinite(limit)
    ? points.filter((point) => epoch(point.timestamp) <= limit)
    : [];
}

/* ── Snapshot preparation ──────────────────────────────────────────────── */

/** Hands the loaded snapshot to the interface. Per-project pool inventories
 * describe the live service's searchable pool index, which this edition does
 * not serve, so the drawer lists the snapshot's own measured pools instead.
 * The recorded history file is the source of the network-wide series. */
export function prepareEditionSnapshot(
  snapshot: RadarSnapshot,
  history: readonly Point[] | null,
): RadarSnapshot {
  const projects = snapshot.projects.some((project) => project.poolInventory)
    ? snapshot.projects.map(({ poolInventory: _drop, ...project }) => project)
    : snapshot.projects;
  // Directory mode would send the page to a service this edition does not have.
  const { directory: _directory, ...rest } = snapshot;
  return {
    ...rest,
    projects,
    history: history && history.length ? [...history] : snapshot.history,
  };
}

/** An overview envelope whose network-wide series is the recorded history. Only
 * the all-networks envelope carries a series; others are returned as they are. */
export function withRecordedHistory<
  T extends {
    asOf: string;
    history: { available: boolean; points: Point[] };
  },
>(envelope: T, points: readonly Point[] | null): T {
  if (!points || points.length === 0 || !envelope.history.available)
    return envelope;
  return {
    ...envelope,
    history: { available: true, points: historyUpTo(points, envelope.asOf) },
  };
}

/** The project whose deployments hold this exact chain and address, if any:
 * the edition's stand-in for the live directory's address search. */
export function findIndexedHook<
  P extends {
    id: string;
    name: string;
    category: string;
    deployments: readonly { chain: string; address: string }[];
  },
>(projects: readonly P[], chain: string, address: string): P | null {
  const wanted = address.toLowerCase();
  return (
    projects.find((project) =>
      project.deployments.some(
        (deployment) =>
          deployment.chain === chain &&
          deployment.address.toLowerCase() === wanted,
      ),
    ) ?? null
  );
}

/* ── Collection run ────────────────────────────────────────────────────── */

export interface RunTimes {
  /** The snapshot this run produced: the key that ties these times to a page. */
  generatedAt: string | null;
  collectionStartedAt: string | null;
  burstStartedAt: string | null;
  burstEndedAt: string | null;
  previousGeneratedAt: string | null;
}

const isoOrNull = (value: unknown): string | null =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : null;

/** The collection run's own times, from the published status file. Absent or
 * unreadable, it is simply not shown. */
export function parseRunTimes(value: unknown): RunTimes | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const times = {
    collectionStartedAt: isoOrNull(row.collectionStartedAt),
    burstStartedAt: isoOrNull(row.burstStartedAt),
    burstEndedAt: isoOrNull(row.burstEndedAt),
    previousGeneratedAt: isoOrNull(row.previousGeneratedAt),
  };
  // generatedAt only names the run; with no time of the run's own there is
  // nothing to show.
  return Object.values(times).some(Boolean)
    ? { generatedAt: isoOrNull(row.generatedAt), ...times }
    : null;
}

/** The run times to show beside a snapshot, or null. A status file from another
 * deploy (a tab that outlived one, a file a moment ahead of the snapshot)
 * describes other measurements, so it is shown only when it names the very
 * snapshot on the page. With no snapshot time to compare (`snapshotAt`
 * undefined) the run is shown as it is. */
export function runTimesFor(
  run: RunTimes | null,
  snapshotAt?: string | number | null,
): RunTimes | null {
  if (!run || snapshotAt === undefined) return run;
  const ran = toMs(run.generatedAt);
  const shown = toMs(snapshotAt);
  return ran !== null && shown !== null && ran === shown ? run : null;
}

/* ── What the snapshot's list holds ────────────────────────────────────── */

/** The snapshot lists the registry-named projects and the hooks that had a pool
 * measured in its run. The hooks the census counted are not all in it, so
 * Discover never says "every hook". */
export const LIST_HOLDS =
  "Registry-named projects and hooks with a measured pool in this snapshot";

/** A search or filter that finds nothing in the snapshot says what the snapshot
 * is: a hook outside it may exist. */
export const NO_MATCH_IN_SNAPSHOT =
  "Nothing in this snapshot matches. It carries registry-named projects and projects with a measured pool, so other hooks are not included.";

/** A link to a project the snapshot does not carry. No cause is named: it is
 * not the registry's removal or rename, only a project this run did not hold. */
export const PROJECT_NOT_CARRIED =
  "This snapshot does not carry this project. It holds registry-named projects and projects with at least one measured pool.";

/** The caption under Discover's "Recent trading" scope. The five-minute rule was
 * applied when the snapshot was collected, so it is read against the snapshot,
 * not against the visitor's clock. */
export function recentTradingCaption(windowLabel: string): string {
  return `Positive ${windowLabel} trading volume · pools measured within 5 minutes of the snapshot`;
}

/** The note under the Projects figure when no filter narrows the list. The
 * market and trading scopes include hooks no registry names, so they are not
 * "named projects". */
export function projectsFigureNote(market: string | undefined): string {
  if (market === "all") return LIST_HOLDS;
  return market === "observed" || market === "active"
    ? "Hooks and projects in this view"
    : "Named projects in this view";
}

/** The note under the Pools figure of the Discover strip. The strip's scope can
 * be narrower than the snapshot (named projects leave the unnamed hooks out),
 * so the figure says how many pools the whole snapshot measured. In the live
 * build, or when the figure is the whole snapshot, it is the note it always had. */
export function poolsFigureNote(
  scoped: number | null,
  snapshotPools: number,
  enabled: boolean = STATIC_EDITION,
): string {
  if (!enabled || scoped === null || scoped === snapshotPools)
    return "Pools measured in this snapshot";
  return `Pools measured in this view · ${snapshotPools.toLocaleString("en-US")} in the whole snapshot`;
}

/** The note under the Networks figure of the Discover strip: in a scope that is
 * not limited to measured pools the figure counts networks where the listed
 * projects have hooks, which is more than the networks with a measured pool, so
 * the edition adds how many networks the snapshot measured a pool on in this
 * view. */
export function networksFigureNote(
  options: {
    measuredScope: boolean;
    measuredNetworks: number;
  },
  enabled: boolean = STATIC_EDITION,
): string {
  if (options.measuredScope) return "Networks with measured pools in this view";
  if (!enabled) return "Networks in this view";
  return `Networks in this view · pools measured on ${options.measuredNetworks.toLocaleString("en-US")}`;
}

/** What follows the pool count under a leading hook in Analytics. The count is
 * the pools that carry a volume measurement in the window, a measured zero
 * included, so the edition calls them measured rather than "with volume", which
 * reads as pools that traded. */
export function poolsWithVolumeWords(enabled: boolean = STATIC_EDITION) {
  return enabled ? "measured" : "with volume";
}

/** Whether a network named in an address is one the page knows: a network the
 * snapshot lists, or one a project is deployed on. */
export function knownNetwork(
  slug: string,
  chains: readonly { slug: string }[],
  deployed: readonly string[] = [],
): boolean {
  return chains.some((chain) => chain.slug === slug) || deployed.includes(slug);
}

/** The networks the menu offers: those a project is deployed on, and the one the
 * address names when the snapshot lists it though no project is deployed there
 * (a listed network with no hook of its own yet). Without it the menu would read
 * "All networks" beside a chip and an empty list that name the network. */
export function networkMenu(
  deployed: readonly string[],
  chosen: string,
  chains: readonly { slug: string }[],
): string[] {
  return chosen !== "all" &&
    !deployed.includes(chosen) &&
    chains.some((chain) => chain.slug === chosen)
    ? [...deployed, chosen].sort()
    : [...deployed];
}

/** What a list says when a network that the snapshot knows has no measured pool
 * and the scope counts only measured pools. */
export function noPoolsOnNetwork(network: string): string {
  return `This snapshot measures no pools on ${network}.`;
}

/** What the rows of a list are called under the table and in an export note:
 * only the Projects scope is all named projects. The market and trading scopes
 * hold hooks that no registry names, so their rows are "entries" (as the heading
 * says "hook families"). */
export function listNoun(
  market: string | undefined,
  count: number | null,
): string {
  return market === "all" || market === "observed" || market === "active"
    ? count === 1
      ? "entry"
      : "entries"
    : count === 1
      ? "project"
      : "projects";
}

/** The caption of the use-case counts in Ecosystem insights. The counts are of
 * the snapshot's own list (it never holds every hook the census found), and of
 * the rows the page shows when a filter or a market scope narrows them. */
export function useCaseCaption(narrowed: boolean): string {
  return narrowed ? "matching this view" : "in this snapshot’s list";
}

/** What a list is called where its scope is named: beside the "About these
 * numbers" figures and in an export's scope column. */
export function listScopeLabel(
  view: string,
  market: string | undefined,
): string {
  if (view === "watchlist") return "Your watchlist";
  switch (market) {
    case "all":
      return "All hooks in this snapshot";
    case "observed":
      return "With market data";
    case "active":
      return "Recent trading";
    default:
      return "Named projects";
  }
}

/** Which data services the footer credits, from the sources the snapshot names.
 * A service is credited when the run's own source list names it and does not say
 * it supplied nothing ("unavailable"): the collector lists a provider it used,
 * and a doctored or partial file never credits one that did nothing. Null when
 * there is no list (a page that loads no snapshot): nothing is credited. */
export interface CreditedSources {
  dexscreener: boolean;
  geckoterminal: boolean;
  registry: boolean;
  v4xyz: boolean;
  frontier: boolean;
  /** Frontier's own market figures for the pools of its hooks (the coin
   * listing it read); the index it names is credited with it. */
  frontierMarkets: boolean;
  census: boolean;
}

export function creditedSources(
  sources: readonly { id?: unknown; status?: unknown }[] | null | undefined,
): CreditedSources | null {
  if (!Array.isArray(sources)) return null;
  const supplied = (...ids: string[]) =>
    sources.some(
      (source) =>
        typeof source?.id === "string" &&
        ids.includes(source.id) &&
        source.status !== "unavailable",
    );
  return {
    dexscreener: supplied("dexscreener"),
    geckoterminal: supplied("geckoterminal"),
    registry: supplied("registry"),
    v4xyz: supplied("v4xyz"),
    // The deployment configuration is listed as "frontier-chains".
    frontier: supplied("frontier-chains", "frontier"),
    frontierMarkets: supplied("frontier-coins"),
    census: supplied("census"),
  };
}

/** What a phone card says where it has no market figure. The snapshot measures a
 * sample of pools, so a project with none measured was not measured, which is
 * not the same as a provider that answered without a value (Compare makes the
 * same split). `network` names the network the list is cut to, when it is. */
export function unmeasuredCardNote(
  measuredPools: number,
  network?: string | null,
): string {
  if (measuredPools > 0) return "Not reported by the provider";
  return network
    ? `Not measured on ${network} in this snapshot`
    : "Not measured in this snapshot";
}

/** The pool count of a phone card whose project has no pool in the snapshot. */
export const NO_POOLS_MEASURED = "No pools measured";

/** The tab a project's drawer opens on when nothing asks for another. A hook
 * project the snapshot carries without one measured pool opens on its Hooks
 * tab: its Pools tab would only be empty. A platform listing and a project the
 * snapshot does not carry keep the Pools tab. */
export function openingDetailTab(
  project: { entityType?: string } | null | undefined,
  hasMeasuredPool: boolean,
): "deployments" | "pools" {
  return project && project.entityType !== "platform" && !hasMeasuredPool
    ? "deployments"
    : "pools";
}

/** "Filtered by search, category" for the filters that narrow a list besides the
 * network and the scope, or null when none does. */
export function filtersNote(filters: {
  search: string;
  category: string;
  property: string;
}): string | null {
  const names = [
    filters.search.trim() ? "search" : null,
    filters.category !== "all" ? "category" : null,
    filters.property !== "all" ? "hook feature" : null,
  ].filter((name): name is string => name !== null);
  return names.length ? `Filtered by ${names.join(", ")}` : null;
}

/** A Watchlist is cut by the Projects / All hooks / With market data / Recent
 * trading scope as any list is, and its scope label is "Your watchlist" either
 * way. A file made from a narrowed Watchlist names that cut, so a saved project
 * the snapshot carries but the scope left out is not read as missing. */
export function watchlistScopeNote(
  view: string,
  market: string | undefined,
): string | null {
  if (view !== "watchlist") return null;
  return market === "projects" || market === "observed" || market === "active"
    ? `Narrowed by scope: ${listScopeLabel("overview", market)}`
    : null;
}

/** What the Share and export dialog says about the files, in words a visitor
 * knows: the JSON file is the whole snapshot and says which projects the page
 * was showing. */
export const EXPORT_FILES_NOTE =
  "Blank metrics mean unavailable data. JSON is the whole snapshot, with its source freshness and the measured pools; it also lists which projects this view shows.";

/** The name of a downloaded file in the edition carries the UTC date of the
 * snapshot it was made from: "hook-radar-projects-2026-10-28.csv". A file kept
 * beside others then says which snapshot it is, which a visitor who downloads
 * twice a day would otherwise have to open to find out. The live name (and a
 * name for a snapshot with no readable time) is returned as it is. */
export function snapshotFileName(
  name: string,
  generatedAt: string | number | null | undefined,
  enabled: boolean = STATIC_EDITION,
): string {
  const ms = toMs(generatedAt);
  if (!enabled || ms === null) return name;
  const day = new Date(ms).toISOString().slice(0, 10);
  const dot = name.lastIndexOf(".");
  return dot > 0
    ? `${name.slice(0, dot)}-${day}${name.slice(dot)}`
    : `${name}-${day}`;
}

/** The scope an export states about its own rows. Plain ASCII: a spreadsheet
 * that opens the file without a byte-order mark must not garble it. */
export function exportScope(parts: {
  list: string;
  network: string;
  /** Anything else that narrows or qualifies the rows. */
  notes?: readonly (string | null | undefined | false)[];
}): string {
  return [
    "Partial coverage",
    "Not total Uniswap volume",
    parts.list,
    parts.network,
    ...(parts.notes ?? []),
  ]
    .filter((part): part is string => Boolean(part))
    .join("; ");
}

/* ── Files from two runs ───────────────────────────────────────────────── */

/** The snapshot and the overview are separate files. If a deploy lands between
 * the two requests they describe different runs, and judging one at the other's
 * time would drop its figures. The older one is asked for again. */
export function reconcileRuns(
  overviewAt: string | null | undefined,
  snapshotAt: string | null | undefined,
): "reload-snapshot" | "reload-overview" | null {
  const overview = Date.parse(overviewAt ?? "");
  const snapshot = Date.parse(snapshotAt ?? "");
  if (!Number.isFinite(overview) || !Number.isFinite(snapshot)) return null;
  if (overview > snapshot) return "reload-snapshot";
  if (overview < snapshot) return "reload-overview";
  return null;
}
