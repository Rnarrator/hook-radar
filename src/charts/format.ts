/** Chart kit formatters. Pure, locale-pinned (en-US) and UTC-explicit so a
 * value reads the same in every browser, test and export. Missing values are
 * always "—" or "Not available"; a measured zero is always rendered as zero. */

import { STATIC_EDITION, timeLabel } from "../edition.ts";

const LOCALE = "en-US";

/** Compact USD for readouts, bar labels and tables. Identical rules to
 * `money()` in model.ts (verified by tests/charts-format.test.mjs). */
export function formatMoneyCompact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value === 0) return "$0";
  if (value < 0.01) return "<$0.01";
  // Round first, then pick the unit, so 999,950 reads "$1.00M", not "$1000.0K".
  if (value >= 1e9 || Number((value / 1e6).toFixed(2)) >= 1000)
    return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6 || Number((value / 1e3).toFixed(1)) >= 1000)
    return `$${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3 || Number(value.toFixed(2)) >= 1000)
    return `$${(value / 1e3).toFixed(1)}K`;
  return `$${value.toFixed(2)}`;
}

/** Exact USD for inspection (tooltips, titles, aria labels): cents for normal
 * amounts, significant digits for tiny positives, exponent for extremes. */
export function formatMoneyExact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "Not available";
  if ((value > 0 && value < 0.000001) || value >= 1e15)
    return `$${value.toExponential()}`;
  if (value > 0 && value < 0.01)
    return value.toLocaleString(LOCALE, {
      style: "currency",
      currency: "USD",
      maximumSignificantDigits: 8,
    });
  return value.toLocaleString(LOCALE, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

/** Every recorded digit (up to IEEE-754 precision) for stored observations. The
 * Auto Snapshot edition shows an amount from a cent up in cents (the same figure
 * as the bars beside it) and a smaller positive one to 15 significant digits,
 * which no binary-float residue reaches. */
export function formatMoneyFull(value: number): string {
  if (!Number.isFinite(value)) return "Not available";
  if (STATIC_EDITION)
    return Math.abs(value) >= 0.01
      ? value.toLocaleString(LOCALE, {
          style: "currency",
          currency: "USD",
          maximumFractionDigits: 2,
        })
      : value.toLocaleString(LOCALE, {
          style: "currency",
          currency: "USD",
          maximumSignificantDigits: 15,
        });
  return value.toLocaleString(LOCALE, {
    style: "currency",
    currency: "USD",
    maximumSignificantDigits: 17,
  });
}

/** Axis tick labels: compact from $1K, distinct labels for sub-cent ticks
 * (never "<$0.01", which would collapse different positions). */
export function formatMoneyAxis(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value === 0) return "$0";
  if (value < 0.0001 || value >= 1e15) return `$${value.toExponential(2)}`;
  return value.toLocaleString(LOCALE, {
    style: "currency",
    currency: "USD",
    maximumSignificantDigits: 3,
    ...(value >= 1000 ? { notation: "compact" as const } : {}),
  });
}

export function formatCount(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value)
    ? "—"
    : value.toLocaleString(LOCALE);
}

export function formatCountCompact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (Math.abs(value) < 1000) return value.toLocaleString(LOCALE);
  return value.toLocaleString(LOCALE, {
    notation: "compact",
    maximumFractionDigits: 1,
  });
}

/** Shares are fractions (0.4 → "40%"). Positive values below 0.1% never
 * round down to a misleading "0%". */
export function formatPercent(share: number | null | undefined): string {
  if (share == null || !Number.isFinite(share)) return "—";
  if (share > 0 && share < 0.001) return "<0.1%";
  // A share below 100% never rounds up to a claim of "100%".
  if (share < 1 && Number((share * 100).toFixed(1)) >= 100) return "99.9%";
  return `${(share * 100).toLocaleString(LOCALE, { maximumFractionDigits: 1 })}%`;
}

const utcDay = new Intl.DateTimeFormat(LOCALE, {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
});
const utcDate = new Intl.DateTimeFormat(LOCALE, {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "numeric",
});
const utcClock = new Intl.DateTimeFormat(LOCALE, {
  timeZone: "UTC",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const utcClockSeconds = new Intl.DateTimeFormat(LOCALE, {
  timeZone: "UTC",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
const utcClockMillis = new Intl.DateTimeFormat(LOCALE, {
  timeZone: "UTC",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  hourCycle: "h23",
});

const valid = (ms: number) =>
  Number.isFinite(ms) && Number.isFinite(new Date(ms).getTime());

/** "Oct 23, 2026 · 10:04:27 UTC". Milliseconds appear only when recorded. */
export function formatUtc(
  ms: number,
  { seconds = true }: { seconds?: boolean } = {},
): string {
  if (!valid(ms)) return "Time unavailable";
  const clock = ms % 1000 ? utcClockMillis : seconds ? utcClockSeconds : utcClock;
  return `${utcDate.format(ms)} · ${clock.format(ms)} UTC`;
}

/** Short clock for captions: "10:04:27 UTC". */
export function formatUtcClock(ms: number): string {
  return valid(ms) ? `${utcClockSeconds.format(ms)} UTC` : "Time unavailable";
}

/** Axis tick label pair for a time axis spanning `spanMs`. */
export function formatUtcTick(
  ms: number,
  spanMs: number,
): { primary: string; secondary: string | null } {
  if (!valid(ms)) return { primary: "—", secondary: null };
  if (spanMs < 2 * 86400000)
    return {
      primary: (spanMs < 300000 ? utcClockSeconds : utcClock).format(ms),
      secondary: utcDay.format(ms),
    };
  return { primary: utcDay.format(ms), secondary: null };
}

/** Elapsed time without rounding a stale clock into a fresh-sounding one:
 * "42s", "4m 58s", "3h 12m", "2d 4h". */
export function formatAge(ms: number): string {
  if (!Number.isFinite(ms)) return "unknown";
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** ISO string → epoch ms, or null when the clock is missing or invalid. */
export function parseClock(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/** How long ago a measurement was taken: "3m 12s ago". The Auto Snapshot edition
 * judges freshness at the snapshot's own time, so it names the clock instead
 * ("at 14:03 UTC") rather than an age that only the visitor's clock could make. */
export function formatSince(time: number, now: number): string {
  if (STATIC_EDITION) {
    const label = timeLabel(time);
    if (label) return `at ${label}`;
  }
  return `${formatAge(now - time)} ago`;
}

/** "oldest 3m 12s old", or in the Auto Snapshot edition "oldest at 14:03 UTC". */
export function formatOldest(time: number, now: number): string {
  return STATIC_EDITION
    ? `oldest ${formatSince(time, now)}`
    : `oldest ${formatAge(now - time)} old`;
}
