/** Wording of the platform drawer and the Launchpads list that depends on what a
 * snapshot is. The Auto Snapshot edition measures a sample of pools once, so
 * "no pool" there means "none in that sample", never "none found in an index";
 * and every figure is dated by the snapshot, not by the visitor's clock.
 *
 * Each helper takes `enabled` (default STATIC_EDITION) and, when it is off,
 * returns exactly the live app's words, so both can be tested side by side. */
import { count } from "./model.ts";
import { STATIC_EDITION, fullTimeLabel, utcDate } from "./edition.ts";

/** What a platform with no pool among the measured pools says, everywhere. */
export const NOT_IN_SAMPLE =
  "None of its pools are in this snapshot’s measured sample";

/** The note under "Priced pools on its hooks". */
export function pricedPoolsNote(
  market: { pools: number; hooksWithPools: number; mappedHooks: number },
  enabled: boolean = STATIC_EDITION,
): string {
  if (market.pools > 0)
    return `On ${market.hooksWithPools} of its ${market.mappedHooks} published ${market.mappedHooks === 1 ? "hook" : "hooks"}`;
  return enabled ? NOT_IN_SAMPLE : "None found in the loaded data";
}

/** The note under "Tracked 24H volume". Pools that exist but carry no price
 * from the five minutes before the snapshot say so; a platform whose pools are
 * not in the sample at all never implies they were looked at and not priced. */
export function trackedVolumeNote(
  market: { pools: number; volumeUsd: number | null; volumePools: number },
  enabled: boolean = STATIC_EDITION,
): string {
  if (market.volumeUsd !== null)
    return `${count(market.volumePools)} ${market.volumePools === 1 ? "pool" : "pools"} priced ${enabled ? "within 5 minutes of the snapshot" : "in the last 5 minutes"}`;
  if (!enabled) return "No price under five minutes old";
  return market.pools === 0
    ? NOT_IN_SAMPLE
    : "No price within five minutes of the snapshot";
}

/** Why a platform with published hooks has no volume in the Launchpads list,
 * when none of those hooks has a priced pool (`hooks` is e.g. "5 published
 * hooks"). */
export function noPricedPoolNote(
  hooks: string,
  enabled: boolean = STATIC_EDITION,
): string {
  return enabled
    ? `None of the pools on its ${hooks} are in this snapshot’s measured sample.`
    : `No priced pool yet on its ${hooks} (unpriced, or not found in the index).`;
}

/** "Snapshot taken 28 Oct 2026, 00:14 UTC": the date of the figures beside it,
 * for a drawer that covers the page's own dated line. Null outside the edition
 * or when the time is unusable. */
export function snapshotTakenNote(
  generatedAt: string | number | null | undefined,
  enabled: boolean = STATIC_EDITION,
): string | null {
  if (!enabled) return null;
  const taken = fullTimeLabel(generatedAt);
  return taken === null ? null : `Snapshot taken ${taken}`;
}

/** The title of a reviewed finding that quotes what the live app's index showed
 * on the day it was written ("Radar shows 19 pools on the current hook"). Such a
 * count cannot be derived from the snapshot, so it is presented as a note of
 * that review day and nothing else. The finding's own words are never edited. */
export function reviewNotesHeading(
  note: string | null | undefined,
  reviewedAt: string | null | undefined,
  enabled: boolean = STATIC_EDITION,
): string | null {
  if (!enabled || !note || !/\bRadar\b/.test(note)) return null;
  const reviewed = Date.parse(reviewedAt ?? "");
  return Number.isFinite(reviewed)
    ? `Review notes as of ${utcDate(reviewed)}`
    : null;
}

/** What a reviewed note says about itself: it quotes what "Radar" showed on the
 * review day ("Radar lists only 1 pool for the hook"), which the snapshot's own
 * figures beside it cannot confirm. Such an unresolved item, unattributed item or
 * path label is read as "As reviewed on 24 Oct 2026:" followed by the finding's
 * own, unedited words. Null for any other text, outside the edition and when the
 * review day cannot be read. The product's own name ("Hook Radar") is not a
 * quotation of its index. */
export function reviewedNotePrefix(
  note: string | null | undefined,
  reviewedAt: string | null | undefined,
  enabled: boolean = STATIC_EDITION,
): string | null {
  if (!enabled || !note) return null;
  if (!/\bRadar\b/.test(note.replace(/\bHook Radar\b/g, ""))) return null;
  const reviewed = Date.parse(reviewedAt ?? "");
  return Number.isFinite(reviewed)
    ? `As reviewed on ${utcDate(reviewed)}:`
    : null;
}

/** Opens an address inside the page, as the app's own links do: the address is
 * pushed to the history and the app, which reads its state from the address on
 * every history change, is told. Used by a link that has to stay a real link for
 * a new tab or a copied address and yet must not reload a page that already
 * holds the snapshot. */
export function navigateInPage(
  href: string,
  target: Pick<Window, "history" | "dispatchEvent"> = window,
): void {
  target.history.pushState({ radar: true }, "", href);
  target.dispatchEvent(
    typeof PopStateEvent === "function"
      ? new PopStateEvent("popstate", { state: target.history.state })
      : new Event("popstate"),
  );
}

/** A click the page may take over: the primary button with no modifier. Any
 * other click on a link (new tab, new window, download) stays the browser's. */
export function isPlainLeftClick(event: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented?: boolean;
}): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

/** The mark in front of a USD figure that is the sum of the pools measured in
 * this snapshot while the pool count beside it is a lower bound: the project
 * may have more pools than the sample holds, so the sum is "at least". Nothing
 * is marked when no pool is measured (the figure is a dash) or when the count
 * is exact. Outside the edition no figure is marked. */
export function lowerBoundMark(
  poolCount: number | null,
  exact: boolean,
  value: number | null,
  enabled: boolean = STATIC_EDITION,
): "≥" | "" {
  return enabled && poolCount !== null && !exact && value !== null ? "≥" : "";
}

/** What Frontier's figures leave out, said beside them: the volume Frontier's
 * own site shows adds trades on a coin's bonding curve, which happen before a
 * pool exists and are never counted as Uniswap v4 volume here. */
export const FRONTIER_SCOPE_NOTE =
  "Counts trades in its Uniswap v4 pools only. Trades on a coin’s bonding curve, before it graduates to a pool, are not included, so Frontier’s own site shows more.";

/** Edition: the scope notes of a Launchpads row: Frontier's, and the one hook
 * that two rows publish. Empty outside the edition. */
export function rowScopeNotes(
  row: { project: { id: string }; sharedHookWith?: readonly string[] },
  enabled: boolean = STATIC_EDITION,
): string[] {
  if (!enabled) return [];
  const notes: string[] = [];
  if (row.project.id === "frontier") notes.push(FRONTIER_SCOPE_NOTE);
  const names = row.sharedHookWith ?? [];
  if (names.length) {
    const list =
      names.length === 1
        ? names[0]
        : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
    notes.push(
      `Shares a hook with ${list}: that hook’s pools count in each listed project’s row and are not added together.`,
    );
  }
  return notes;
}
