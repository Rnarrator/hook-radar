// 7D and 30D volume of the largest pools, as the Auto Snapshot edition publishes
// it (data/daily.json) and reads it. One module for the collector, the data gate
// (scripts/check-edition-data.mjs) and the page, so the three cannot disagree
// about what a valid file is.
//
// A figure is the sum of the pool's USD volume over the last 7 (30) COMPLETE UTC
// days up to the file's `through` day. The day in progress is never counted, so a
// completed day never changes. Only the largest pools carry a figure; every other
// pool has none, which is unavailable and never zero.
//
// Only erasable TypeScript syntax here: Node 24 runs this file directly (type
// stripping) inside the collector and the gate.

export const DAY_MS = 86_400_000;

export type DailySpan = "d7" | "d30";
export const DAILY_SPAN_KEYS: readonly DailySpan[] = ["d7", "d30"];
/** How many complete UTC days each span covers. */
export const DAILY_SPANS: Readonly<Record<DailySpan, number>> = {
  d7: 7,
  d30: 30,
};

/** The id of the source row in snapshot.json that says the file exists. */
export const DAILY_SOURCE_ID = "geckoterminal-daily";
export const DAILY_SOURCE = "geckoterminal";
export const DAILY_FILE_NAME = "daily.json";
/** The file never lists more pools than this (the collector keeps at most 60). */
export const DAILY_FILE_MAX_POOLS = 200;
/** A reading may be stamped a little after the snapshot time: the step runs after
 * the snapshot time is fixed. */
export const DAILY_READ_SLACK_MS = 30 * 60 * 1000;
/** The page accepts a file whose end day is a little newer than its snapshot's
 * newest complete day (a file of the next run), never an older one than a day
 * behind it. */
export const DAILY_PAGE_NEWER_DAYS = 2;

export interface DailyPoolFigure {
  /** `chain:poolId`, as the snapshot's pools are keyed. */
  id: string;
  v7: number;
  v30: number;
  /** When GeckoTerminal's answer for this pool was true (its own time). */
  at: string;
  /** Present only for a pool younger than the span: the UTC days it was live. */
  n7?: number;
  n30?: number;
}

export interface DailyFile {
  schemaVersion: 1;
  snapshotGeneratedAt: string;
  /** The last complete UTC day the figures cover, `YYYY-MM-DD`. */
  through: string;
  source: typeof DAILY_SOURCE;
  pools: DailyPoolFigure[];
}

export const dayNumber = (ms: number): number => Math.floor(ms / DAY_MS);
export const dayStartMs = (day: number): number => day * DAY_MS;
/** The newest UTC day that was complete at `ms`. */
export const lastCompleteDay = (ms: number): number => dayNumber(ms) - 1;
export const dayLabel = (day: number): string =>
  new Date(day * DAY_MS).toISOString().slice(0, 10);

const DAY_LABEL = /^\d{4}-\d{2}-\d{2}$/;
/** A `YYYY-MM-DD` label as a day number, or null when it is not a real date. */
export function parseDayLabel(value: unknown): number | null {
  if (typeof value !== "string" || !DAY_LABEL.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(ms) || dayLabel(dayNumber(ms)) !== value) return null;
  return dayNumber(ms);
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const isIso = (value: unknown): value is string =>
  typeof value === "string" &&
  ISO.test(value) &&
  Number.isFinite(Date.parse(value));
const POOL_KEY = /^[a-z0-9][a-z0-9-]{0,49}:0x[0-9a-f]{64}$/;
const isMoney = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value < 1e13;
const isDays = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= max;

const FILE_KEYS = [
  "schemaVersion",
  "snapshotGeneratedAt",
  "through",
  "source",
  "pools",
];
const POOL_KEYS = ["id", "v7", "v30", "at", "n7", "n30"];

export type DailyShapeResult =
  | { ok: true; file: DailyFile }
  | { ok: false; reason: string };

/** The structure of the file, whatever run it belongs to: what the collector,
 * the gate and the page all require. */
export function validateDailyShape(value: unknown): DailyShapeResult {
  const bad = (reason: string): DailyShapeResult => ({ ok: false, reason });
  if (!value || typeof value !== "object" || Array.isArray(value))
    return bad("it is not a JSON object");
  const file = value as Record<string, unknown>;
  if (Object.keys(file).some((key) => !FILE_KEYS.includes(key)))
    return bad("it has a field that is not part of the file");
  if (file.schemaVersion !== 1) return bad("its schemaVersion is not 1");
  if (!isIso(file.snapshotGeneratedAt))
    return bad("snapshotGeneratedAt is not a time");
  if (parseDayLabel(file.through) === null)
    return bad("through is not a date");
  if (file.source !== DAILY_SOURCE) return bad("its source is not named");
  if (!Array.isArray(file.pools)) return bad("pools is not a list");
  // The collector never writes a file without a figure (it leaves the file out);
  // an empty one would offer 7D and 30D with a dash in every row.
  if (file.pools.length === 0) return bad("it lists no pools");
  if (file.pools.length > DAILY_FILE_MAX_POOLS)
    return bad(`it lists more than ${DAILY_FILE_MAX_POOLS} pools`);
  let previous = "";
  for (const [index, row] of file.pools.entries()) {
    const at = `pool ${index + 1}`;
    if (!row || typeof row !== "object" || Array.isArray(row))
      return bad(`${at} is not an object`);
    const pool = row as Record<string, unknown>;
    if (Object.keys(pool).some((key) => !POOL_KEYS.includes(key)))
      return bad(`${at} has a field that is not part of the file`);
    if (typeof pool.id !== "string" || !POOL_KEY.test(pool.id))
      return bad(`${at} has no valid id`);
    if (pool.id <= previous)
      return bad(`${at} is not in order, or its id is repeated`);
    previous = pool.id;
    if (!isMoney(pool.v7) || !isMoney(pool.v30))
      return bad(`${at} has a volume that is not a plain amount`);
    if (pool.v30 < pool.v7) return bad(`${at} has a 30D volume below its 7D`);
    if (!isIso(pool.at)) return bad(`${at} has no valid reading time`);
    if (pool.n7 !== undefined && !isDays(pool.n7, 6))
      return bad(`${at} has an invalid n7`);
    if (pool.n30 !== undefined && !isDays(pool.n30, 29))
      return bad(`${at} has an invalid n30`);
    if (
      pool.n7 !== undefined &&
      (pool.n30 === undefined || (pool.n30 as number) < (pool.n7 as number))
    )
      return bad(`${at} has an n7 that its n30 does not match`);
  }
  return { ok: true, file: file as unknown as DailyFile };
}

export interface DailySnapshotView {
  generatedAt: string;
  sources: readonly { id: string }[];
}

/** What the collector and the gate additionally require: the file belongs to
 * this snapshot's run. Returns the reason it does not, or null. */
export function dailyRunProblem(
  file: DailyFile,
  snapshot: DailySnapshotView,
): string | null {
  const generated = Date.parse(snapshot.generatedAt);
  if (!Number.isFinite(generated)) return "the snapshot has no valid time";
  if (file.snapshotGeneratedAt !== snapshot.generatedAt)
    return "it belongs to another run than snapshot.json";
  const newest = lastCompleteDay(generated);
  const through = parseDayLabel(file.through);
  if (through === null || (through !== newest && through !== newest - 1))
    return `its end day (${file.through}) is neither the last complete day of the snapshot nor the one before`;
  const ended = dayStartMs((through as number) + 1);
  for (const pool of file.pools) {
    const read = Date.parse(pool.at);
    if (read < ended)
      return `${pool.id} was read before ${file.through} had ended, so that day was not complete`;
    if (read > generated + DAILY_READ_SLACK_MS)
      return `${pool.id} was read long after the snapshot time`;
  }
  const rows = snapshot.sources.filter((source) => source.id === DAILY_SOURCE_ID);
  if (rows.length !== 1)
    return "snapshot.json does not name it as a source exactly once";
  return null;
}

/** What the page additionally requires, judged at the snapshot it shows: the end
 * day is not older than one day behind the snapshot's newest complete day, and
 * not further ahead than a file of a following run can be. The file of another
 * run is accepted: its figures carry their own dates. */
export function dailyPageProblem(
  file: DailyFile,
  snapshotGeneratedAt: number,
): string | null {
  const newest = lastCompleteDay(snapshotGeneratedAt);
  const through = parseDayLabel(file.through);
  if (through === null) return "its end day is not a date";
  if (through < newest - 1) return "its end day is too old for this snapshot";
  if (through > newest + DAILY_PAGE_NEWER_DAYS)
    return "its end day is later than this snapshot can account for";
  return null;
}
