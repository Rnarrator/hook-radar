/** How often the browser asks the service for new data, and which request it
 * uses, derived from the freshness window instead of a fixed habit.
 *
 * A pool measurement is current for five minutes. What the page shows is aged
 * by the browser's own clock, so a value can never be stale for longer than it
 * is current; asking more often than needed only moves bytes. Asking at a third
 * of the window keeps what a visitor sees at most a third of the window behind
 * the service. The full snapshot (about 155 MB uncompressed, several MB on the
 * wire) is the expensive request, so it is repeated only while something on the
 * screen is built from pool-level data. The Discover list, map and watchlist
 * are built from the small discovery page instead. */
import { MARKET_MAX_AGE_MS } from "../shared/market-freshness.ts";

/** Repeat interval for data that is shown as live measurements. */
export const LIVE_REFRESH_MS = Math.floor(MARKET_MAX_AGE_MS / 3);
/** Repeat interval for data compared between published records, not measured:
 * hook lists, declarations and pool inventory change over hours, not minutes. */
export const SLOW_REFRESH_MS = MARKET_MAX_AGE_MS * 2;
/** A snapshot younger than this is not fetched again just because a view that
 * needs one was opened or the tab came back to the foreground. */
export const CATCH_UP_MS = 60_000;

/** What the current screen needs from the full snapshot. */
export type SnapshotNeed = "none" | "slow" | "live";

export interface SnapshotNeedInput {
  view: string;
  /** A project drawer or the Data & sources panel is open: both read
   * pool-level data from the snapshot. */
  detailOpen: boolean;
  /** Discover, the map and the watchlist are showing their discovery-page layout. */
  discoveryShell: boolean;
  /** Number of saved hooks. */
  savedCount: number;
}

const DISCOVERY_VIEWS = new Set(["overview", "map", "watchlist"]);

export function snapshotNeed({
  view,
  detailOpen,
  discoveryShell,
  savedCount,
}: SnapshotNeedInput): SnapshotNeed {
  if (view === "learn" && !detailOpen) return "none";
  // A drawer, the full overview and every non-discovery view show pool-level
  // measurements built from the snapshot.
  if (detailOpen || !DISCOVERY_VIEWS.has(view) || !discoveryShell)
    return "live";
  // The watchlist's "what changed" panel compares published records.
  if (view === "watchlist" && savedCount > 0) return "slow";
  return "none";
}

/** `failed`: the last request for the snapshot failed. A screen that needs
 * none still tries again now and then, so the failure does not outlive the
 * outage; a heavy retry is not made more often than the slow pace. */
export function refreshInterval(
  need: SnapshotNeed,
  failed = false,
): number | null {
  return need === "live"
    ? LIVE_REFRESH_MS
    : need === "slow" || failed
      ? SLOW_REFRESH_MS
      : null;
}

/** Should a snapshot held since `lastAt` be fetched again right now? Used when
 * a view that needs one opens or the tab returns to the foreground. */
export function catchUpDue(
  lastAt: number | null,
  now: number,
  need: SnapshotNeed,
): boolean {
  if (need === "none" || lastAt === null) return false;
  const limit = need === "slow" ? SLOW_REFRESH_MS : CATCH_UP_MS;
  return now - lastAt > limit;
}
