import { money } from "../model";
import {
  DAILY_NOT_COVERED,
  dailyPoolTitle,
  dailySumTitle,
  dailyThrough,
  youngText,
  youngTitle,
} from "../daily";
import type { DailySum, PoolDaily } from "../daily";
import { useDailyView } from "../daily-view";
import "./daily.css";

export const NO_SUM: DailySum = {
  usd: null,
  covered: 0,
  of: 0,
  youngDays: null,
  at: null,
};

/** One 7D or 30D figure, as every screen writes it.
 *
 * A total over several pools is "at least" (`≥`): only the largest pools have
 * daily volume. A single pool's figure is exact for its complete days and has no
 * mark. A pool or set with no figure is a dash that says why, never a zero. A
 * line under the figure says the day it runs to, or that the pool is younger
 * than the span. While the file loads the figure is an ellipsis, and a failure
 * is a dash. */
export function DailyAmount({
  sum,
  pool,
  title,
  compact = false,
}: {
  /** A total over a set of pools. */
  sum?: DailySum;
  /** One pool's figure, or null when the pool is not covered. */
  pool?: PoolDaily | null;
  title?: string;
  compact?: boolean;
}) {
  const { lens, phase } = useDailyView();
  if (phase === "off") return null;
  if (phase === "loading")
    return (
      <span className="daily-figure daily-pending" aria-busy="true">
        <span aria-hidden="true">…</span>
        <span className="sr-only">Loading</span>
      </span>
    );
  if (phase === "error")
    return (
      <span className="daily-figure daily-none">
        <span aria-hidden="true">—</span>
        <span className="sr-only">Not loaded</span>
      </span>
    );
  // Ready: the lens is there. (Loading and failure are answered above.)
  if (!lens) return null;
  const single = pool !== undefined;
  const usd = single ? (pool?.usd ?? null) : (sum?.usd ?? null);
  if (usd === null)
    return (
      <span className="daily-figure daily-none" title={DAILY_NOT_COVERED}>
        <span aria-hidden="true">—</span>
        <span className="sr-only">{DAILY_NOT_COVERED}</span>
      </span>
    );
  const mark = single ? "" : "≥";
  const young = single ? (pool?.days ?? null) : (sum?.youngDays ?? null);
  const tip =
    title ??
    (single && pool
      ? dailyPoolTitle(pool, lens)
      : sum
        ? dailySumTitle(sum, lens)
        : undefined);
  return (
    <span className="daily-figure" title={tip}>
      <span className="daily-value" aria-hidden="true">
        {mark}
        {money(usd)}
      </span>
      <span className="sr-only">
        {single ? "" : "at least "}
        {money(usd)}
        {young !== null ? `, ${youngText(young)}` : `, through ${dailyThrough(lens)}`}
      </span>
      {!compact && (
        <small
          className="daily-through"
          title={young !== null ? youngTitle(lens.width) : undefined}
          aria-hidden="true"
        >
          {young !== null ? youngText(young) : `through ${dailyThrough(lens)}`}
        </small>
      )}
    </span>
  );
}
