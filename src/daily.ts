// 7D and 30D volume of the largest pools, as the edition's page shows it.
//
// The collector publishes data/daily.json (shared/daily-volume.ts): for each of
// the largest pools, the sum of its USD volume over the last 7 and 30 COMPLETE UTC
// days up to the file's `through` day, with the time GeckoTerminal's answer was
// true. The page loads it only when a visitor picks 7D or 30D, and shows its
// figures through one "lens": a pool's figure, and the sum of the figures of a
// set of pools. Nothing here is estimated. A pool the file does not list has no
// figure (unavailable, never zero); a sum over pools is "at least" because only
// the largest pools are listed; a pool younger than the window says so.
//
// 1H, 6H and 24H are untouched: they keep the five-minute rule of the snapshot.
// A completed day has its own dating: the day the figures run to, and the time
// each answer was read.
import type { Pool } from "../shared/types";
import {
  DAILY_SOURCE_ID,
  DAILY_SPANS,
  dailyPageProblem,
  parseDayLabel,
  dayStartMs,
  validateDailyShape,
} from "../shared/daily-volume.ts";
import type { DailyFile, DailySpan } from "../shared/daily-volume.ts";
import { fullTimeLabel, utcDate, utcDayMonth } from "./edition.ts";
import { money } from "./model.ts";

export type { DailyFile, DailySpan };
export { DAILY_SOURCE_ID, DAILY_SPANS };

/** The views that show a span. Others show the plain windows only. */
export const DAILY_VIEWS: readonly string[] = ["overview", "watchlist", "chains"];
export const dailyView = (view: string): boolean => DAILY_VIEWS.includes(view);

/** Whether a snapshot offers 7D and 30D: it names the daily file as a live source. */
export function offersDaily(
  snapshot: { sources: readonly { id: string; status: string }[] } | null,
): boolean {
  return !!snapshot?.sources.some(
    (source) => source.id === DAILY_SOURCE_ID && source.status === "live",
  );
}

export type DailyRead =
  | { ok: true; file: DailyFile }
  | { ok: false; reason: string };

/** The file as the page accepts it: the shared shape, and an end day that is not
 * older than one day behind the snapshot shown nor further ahead than a later
 * run's file can be. A file of another run is accepted: its figures carry their
 * own dates. */
export function parseDaily(value: unknown, snapshotGeneratedAt: string): DailyRead {
  const shape = validateDailyShape(value);
  if (!shape.ok) return shape;
  const shown = Date.parse(snapshotGeneratedAt);
  if (!Number.isFinite(shown))
    return { ok: false, reason: "the snapshot has no time" };
  const problem = dailyPageProblem(shape.file, shown);
  return problem ? { ok: false, reason: problem } : { ok: true, file: shape.file };
}

/* ── The lens ────────────────────────────────────────────────────────────── */

export interface PoolDaily {
  usd: number;
  /** The UTC days the pool was live, when younger than the span; else null. */
  days: number | null;
  /** When the answer behind the figure was true. */
  at: string;
}

export interface DailySum {
  /** Null when no pool in the set has a figure: a dash, never a zero. */
  usd: number | null;
  /** Pools of the set that have a figure, and pools in the set. */
  covered: number;
  of: number;
  /** The days of the longest of them when EVERY covered pool is younger than the
   * span ("since launch"); null otherwise. */
  youngDays: number | null;
  /** The newest reading behind the sum. */
  at: string | null;
}

export interface DailyLens {
  /** Identity for caches: a new file or span is a new lens. */
  readonly id: number;
  readonly span: DailySpan;
  /** 7 or 30. */
  readonly width: number;
  /** The last complete UTC day the figures cover, YYYY-MM-DD. */
  readonly through: string;
  readonly throughMs: number;
  pool(pool: Pick<Pool, "id" | "chain" | "address">): PoolDaily | null;
  sum(pools: readonly Pick<Pool, "id" | "chain" | "address">[]): DailySum;
}

let lensCount = 0;

export function createDailyLens(file: DailyFile, span: DailySpan): DailyLens {
  const width = DAILY_SPANS[span];
  const figures = new Map<string, PoolDaily>();
  for (const row of file.pools) {
    const days = span === "d7" ? row.n7 : row.n30;
    figures.set(row.id, {
      usd: span === "d7" ? row.v7 : row.v30,
      days: days ?? null,
      at: row.at,
    });
  }
  const lookup = (pool: Pick<Pool, "id" | "chain" | "address">) =>
    figures.get(`${pool.chain}:${String(pool.address).toLowerCase()}`) ??
    figures.get(String(pool.id).toLowerCase()) ??
    null;
  const through = parseDayLabel(file.through) as number;
  return {
    id: ++lensCount,
    span,
    width,
    through: file.through,
    throughMs: dayStartMs(through),
    pool: lookup,
    sum(pools) {
      let usd: number | null = null;
      let covered = 0;
      let young = 0;
      let longest = 0;
      let at: string | null = null;
      for (const pool of pools) {
        const figure = lookup(pool);
        if (!figure) continue;
        covered++;
        usd = (usd ?? 0) + figure.usd;
        if (figure.days !== null) {
          young++;
          longest = Math.max(longest, figure.days);
        }
        if (at === null || figure.at > at) at = figure.at;
      }
      return {
        usd,
        covered,
        of: pools.length,
        youngDays: covered > 0 && young === covered ? longest : null,
        at,
      };
    },
  };
}

/* ── Words ───────────────────────────────────────────────────────────────── */

export const spanLabel = (span: DailySpan): string =>
  span === "d7" ? "7D" : "30D";
export const dailyButtonTitle = (span: DailySpan): string =>
  `Last ${DAILY_SPANS[span]} full days (UTC), largest pools only`;
export const dailyColumnLabel = (span: DailySpan): string =>
  `${spanLabel(span)} VOLUME`;
export const dailyCardLabel = (span: DailySpan): string =>
  `${spanLabel(span)} tracked volume`;
export const dailyTileLabel = (span: DailySpan): string =>
  `Tracked hook volume · ${spanLabel(span)}`;
export const dailyNetworksLabel = (span: DailySpan): string =>
  `Tracked ${spanLabel(span)} volume`;
export const dailyColumnHelp = (span: DailySpan): string =>
  `Volume over the last ${DAILY_SPANS[span]} full days (UTC), counted for the largest pools only. A dash means this pool is not covered.`;
export const DAILY_NOT_COVERED =
  "Not covered: only the largest pools have 7D and 30D volume.";
/** The Networks chart while a span is shown: a network either has a figure from
 * the largest pools or it does not. "Measured" is the 24H word and says more than
 * is true here: the same pools are measured for 24H. */
export const dailyChartCount = (
  span: DailySpan,
  covered: string,
  of: string,
): string => `${covered} of ${of} with ${spanLabel(span)} volume`;
export const dailyChartNone = (span: DailySpan): string =>
  `no ${spanLabel(span)} volume`;
export const DAILY_ERROR = "Could not load 7D and 30D volume.";
export const DAILY_UNAVAILABLE = "No 7D or 30D volume in this snapshot.";
export const DAILY_SCOPE_NOTE = "Daily volume: largest pools only";

/** "11 Nov": the last complete day the figures cover. */
export const dailyThrough = (lens: Pick<DailyLens, "throughMs">): string =>
  utcDayMonth(lens.throughMs);
/** The line beside the switch while a span is shown: real text, not a tooltip. */
export const dailyCaption = (lens: Pick<DailyLens, "throughMs">): string =>
  `Full UTC days through ${dailyThrough(lens)}. Largest pools only.`;

export const youngText = (days: number): string =>
  `since launch · ${days} ${days === 1 ? "day" : "days"}`;
export const youngTitle = (width: number): string =>
  `Pools younger than ${width} days count from their launch day.`;

export const dailyLoadingText = (span: DailySpan): string =>
  `Loading ${spanLabel(span)} volume`;
export const dailyReadyText = (lens: DailyLens): string =>
  `Showing ${spanLabel(lens.span)} volume through ${dailyThrough(lens)}`;

const FROM_ANOTHER_PROVIDER =
  "The 24H figure can come from another provider.";

/** The tooltip of a total over several pools. */
export function dailySumTitle(sum: DailySum, lens: DailyLens): string {
  const amount = sum.usd === null ? null : money(sum.usd);
  if (amount === null) return DAILY_NOT_COVERED;
  return [
    `At least ${amount}: the last ${lens.width} full days (UTC) through ${dailyThrough(lens)} in the ${sum.covered} of ${sum.of} measured ${sum.of === 1 ? "pool" : "pools"} that have daily data.`,
    "Pools outside the largest are not included.",
    sum.youngDays !== null ? youngTitle(lens.width) : null,
    sum.at ? `Read from GeckoTerminal on ${fullTimeLabel(sum.at)}.` : null,
    FROM_ANOTHER_PROVIDER,
  ]
    .filter(Boolean)
    .join(" ");
}

/** The tooltip of one pool's figure. */
export function dailyPoolTitle(figure: PoolDaily, lens: DailyLens): string {
  return [
    `Full UTC days through ${utcDate(lens.throughMs)}.`,
    figure.days !== null ? youngTitle(lens.width) : null,
    `Read from GeckoTerminal on ${fullTimeLabel(figure.at)}.`,
    FROM_ANOTHER_PROVIDER,
  ]
    .filter(Boolean)
    .join(" ");
}

/** What the drawer says under the headline figure. */
export const dailyDrawerNote = (span: DailySpan, sum: DailySum): string =>
  `${spanLabel(span)} covers the largest pools only: ${sum.covered} of ${sum.of} measured ${sum.of === 1 ? "pool" : "pools"} here.`;

/** The note under the Discover tile. */
export const dailyTileNote = (lens: DailyLens, sum: DailySum): string =>
  `${sum.covered.toLocaleString("en-US")} of ${sum.of.toLocaleString("en-US")} ${sum.of === 1 ? "pool" : "pools"} covered, through ${dailyThrough(lens)}`;

/** A sum's figure as text, marked "at least": "≥$1.23M", or a dash. */
export function dailySumText(sum: DailySum): string {
  return sum.usd === null ? "—" : `≥${money(sum.usd)}`;
}
/** The same, spoken. */
export function dailySumSpoken(sum: DailySum): string {
  return sum.usd === null ? DAILY_NOT_COVERED : `at least ${money(sum.usd)}`;
}

/* ── Export ──────────────────────────────────────────────────────────────── */

/** Under the download buttons while a span is shown: the JSON is the whole
 * snapshot, which has no 7D or 30D figures, so say where they are. */
export const dailyExportNote = (span: DailySpan): string =>
  `The ${spanLabel(span)} figures are in the CSV. The JSON does not include them.`;

/** The CSV header of the volume column in a span. */
export const dailyCsvHeader = (lens: DailyLens): string =>
  `Observed ${spanLabel(lens.span)} volume USD (at least; full UTC days through ${lens.through}; largest pools only)`;
