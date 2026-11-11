import type { Point } from "../shared/types";
import { analyticsPointTime } from "./analytics.ts";
import type { AnalyticsHistoryRange } from "./analytics.ts";
import { formatMoneyAxis } from "./charts/format.ts";
import { zeroBasedScale } from "./charts/scales.ts";
import { STATIC_EDITION } from "./edition.ts";

/** A zero-based scale for recorded USD amounts. No observations are changed.
 * Very large and subnormal inputs fall back to the measured maximum when the
 * next rounded bound cannot be represented by a finite JavaScript number. */
export function historyChartScale(points: readonly Point[]): {
  maximum: number;
  ticks: number[];
} {
  return zeroBasedScale(
    (function* () {
      for (const point of points) yield point.value;
    })(),
  );
}

/** Axis labels express actual tick positions, including sub-cent amounts.
 * Inequality labels such as "<$0.01" would collapse distinct positions. */
export function historyAxisMoney(value: number): string {
  return formatMoneyAxis(value);
}

const HOUR_MS = 3600000;

/** The live service saves a point whenever fresh data arrives, so more than an
 * hour without one is a hole. */
const LIVE_HISTORY_GAP_MS = HOUR_MS;

/** The Auto Snapshot edition saves one point per collection run, and the
 * workflow (.github/workflows/snapshot.yml) collects about once an hour: a
 * trigger collects only when the last snapshot is at least 45 minutes old. The
 * line joins two points up to three hours apart: a single missed run (an
 * interval of about 2 hours) is still joined, and a stretch is drawn as a gap
 * once more than three hours pass between two points, which two missed runs
 * in a row usually do. At the live service's 1 hour every interval would be a
 * gap and no line could ever be drawn. */
export const EDITION_HISTORY_GAP_MS = 3 * HOUR_MS;

/** The longest interval between two stored observations that is still drawn as
 * one line. */
export function historyGapMs(edition: boolean = STATIC_EDITION): number {
  return edition ? EDITION_HISTORY_GAP_MS : LIVE_HISTORY_GAP_MS;
}

const gapHours = (edition: boolean) => historyGapMs(edition) / HOUR_MS;

/** The threshold as the legend states it: "over 1h" live, "over 3h" here. */
export function historyGapLabel(edition: boolean = STATIC_EDITION): string {
  return `over ${gapHours(edition)}h`;
}

/** The same threshold in a sentence: "one hour" live, "3 hours" here. */
export function historyGapWords(edition: boolean = STATIC_EDITION): string {
  const hours = gapHours(edition);
  return hours === 1 ? "one hour" : `${hours} hours`;
}

/** Keep exact source indices so duplicate clocks/amounts remain selectable.
 * Gaps are separate intervals, never fabricated connecting measurements. */
export function historyChartSegments(
  points: readonly Point[],
  gapMs: number = historyGapMs(),
): { segments: number[][]; gaps: { from: number; to: number }[] } {
  const segments: number[][] = [];
  const gaps: { from: number; to: number }[] = [];
  const threshold =
    Number.isFinite(gapMs) && gapMs >= 0 ? gapMs : historyGapMs();
  for (let index = 0; index < points.length; index++) {
    if (
      index === 0 ||
      analyticsPointTime(points[index]) -
        analyticsPointTime(points[index - 1]) >
        threshold
    ) {
      if (index > 0) gaps.push({ from: index - 1, to: index });
      segments.push([index]);
    } else segments[segments.length - 1].push(index);
  }
  return { segments, gaps };
}

/** Nearest source observation in chronological history, with stable first-row
 * ties for duplicate clocks. Pointer inspection stays logarithmic as history
 * grows; keyboard navigation still visits every individual observation. */
export function historyNearestPoint(
  points: readonly Point[],
  timestamp: number,
): number {
  if (!points.length || !Number.isFinite(timestamp)) return -1;
  const lowerBound = (target: number) => {
    let low = 0;
    let high = points.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (analyticsPointTime(points[middle]) < target) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const next = lowerBound(timestamp);
  if (next === 0) return 0;
  const previousTime = analyticsPointTime(points[next - 1]);
  if (
    next === points.length ||
    timestamp - previousTime <= analyticsPointTime(points[next]) - timestamp
  )
    return lowerBound(previousTime);
  return next;
}

/** Difference between two recorded rolling observations. It describes how the
 * rolling 24h value moved between two measurement times — it is NOT volume
 * traded in between, and the tracked pool set may differ. */
export function historyObservationChange(
  points: readonly Point[],
  index: number,
): { delta: number; elapsedMs: number } | null {
  if (index <= 0 || index >= points.length) return null;
  const delta = points[index].value - points[index - 1].value;
  const elapsedMs =
    analyticsPointTime(points[index]) - analyticsPointTime(points[index - 1]);
  return Number.isFinite(delta) && Number.isFinite(elapsedMs)
    ? { delta, elapsedMs }
    : null;
}

const cell = (value: string | number) =>
  `"${String(value).replaceAll('"', '""')}"`;

/** The two times a history export carries. `exported_at` is when the file was
 * made. The edition evaluates its page at the snapshot's own time (`now`), so
 * there the file is stamped with the visitor's clock and the snapshot time is
 * named separately as `snapshot_at`. Live, `now` is the visitor's clock. */
export function historyExportTimes(
  now: number,
  edition: boolean = STATIC_EDITION,
  realNow: number = Date.now(),
): { exportedAt: string; snapshotAt?: string } {
  return edition
    ? {
        exportedAt: new Date(realNow).toISOString(),
        snapshotAt: new Date(now).toISOString(),
      }
    : { exportedAt: new Date(now).toISOString() };
}

/** The recorded observations exactly as shown: original timestamp units and
 * full-precision values, with scope, metric and range on every row. A
 * `snapshot_at` column follows only when the time of the snapshot is given. */
export function historyCsv(
  points: readonly Point[],
  {
    range,
    scope = "all-networks",
    exportedAt,
    snapshotAt,
    poolsAt,
  }: {
    range: AnalyticsHistoryRange;
    scope?: string;
    exportedAt: string;
    snapshotAt?: string;
    /** Edition: how many pools stood behind a point, when the history file says. */
    poolsAt?: (point: Point) => number | undefined;
  },
): string {
  const snapshotColumn = snapshotAt === undefined ? [] : [snapshotAt];
  // Edition: how many pools were measured behind each value, when it is known,
  // so a fall caused by a smaller sample is not read as a fall in volume.
  const withPools =
    poolsAt !== undefined &&
    points.some((point) => poolsAt(point) !== undefined);
  const rows = [
    [
      "observed_at_utc",
      "original_timestamp",
      "recorded_volume_usd_h24_rolling",
      ...(withPools ? ["pools_measured"] : []),
      "metric",
      "scope",
      "range",
      "exported_at",
      ...(snapshotAt === undefined ? [] : ["snapshot_at"]),
    ],
    ...points.map((point) => [
      new Date(analyticsPointTime(point)).toISOString(),
      point.timestamp,
      point.value,
      ...(withPools ? [poolsAt!(point) ?? ""] : []),
      "tracked hook-pool volume, rolling 24h (not total Uniswap volume)",
      scope,
      range,
      exportedAt,
      ...snapshotColumn,
    ]),
  ];
  return "﻿" + rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}
