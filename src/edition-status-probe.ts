/** The Auto Snapshot edition's cheap check for a newer snapshot: a few hundred
 * bytes of the published status file, never the 10 MB snapshot. The page that is
 * open keeps showing what it loaded; when the status file names a later run it
 * says so and offers "Reload" (SnapshotLine in components/EditionStatus.tsx).
 * Nothing is swapped in silently: on a phone connection that would be a surprise
 * download. */
import { useEffect, useRef, useState } from "react";
import { EDITION_RECHECK_MS, editionCatchUpDue, statusUrl } from "./edition.ts";

/** A snapshot view that stays open and visible is checked this often (30
 * minutes), and a tab that comes back to the foreground is checked when this
 * long has passed since the last check. */
export const EDITION_PROBE_MS = EDITION_RECHECK_MS;

/** When the published status file says the latest run finished (epoch ms), or
 * null when it cannot be read. The request skips every cache (`no-store`: a
 * stored copy would say nothing new) and a failure is silent: the answer is an
 * extra, and the snapshot on screen stands without it. */
export async function fetchPublishedAt(
  signal?: AbortSignal,
  url: string = statusUrl(),
): Promise<number | null> {
  try {
    const response = await fetch(url, { signal, cache: "no-store" });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const at =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as { generatedAt?: unknown }).generatedAt
        : undefined;
    const time = typeof at === "string" ? Date.parse(at) : NaN;
    return Number.isFinite(time) ? time : null;
  } catch {
    return null;
  }
}

const toMs = (value: number | string | null | undefined): number | null => {
  const time = typeof value === "string" ? Date.parse(value) : value;
  return typeof time === "number" && Number.isFinite(time) ? time : null;
};

/** Whether the published run is later than the one on screen. Only when both
 * times can be read: an unreadable answer is never "newer", and an equal or
 * earlier one (a host still serving the old status file) never is either. */
export function isNewer(
  published: number | string | null | undefined,
  shown: number | string | null | undefined,
): boolean {
  const latest = toMs(published);
  const held = toMs(shown);
  return latest !== null && held !== null && latest > held;
}

/** What the status file says about the run on screen. `newerAt` is the time of
 * a later published run (ISO text), or null. `checked` is whether the file has
 * been read at all: once it has, the page knows what the site holds, and a
 * snapshot that is old because the site itself is late is not helped by a
 * reload. An unreadable answer (null) is neither. */
export interface PublicationCheck {
  newerAt: string | null;
  checked: boolean;
}

export function publicationCheck(
  published: number | null,
  shown: number | string | null | undefined,
): PublicationCheck {
  return {
    newerAt:
      published !== null && isNewer(published, shown)
        ? new Date(published).toISOString()
        : null,
    checked: published !== null,
  };
}

/** Whether a tab that was last checked at `lastProbeAt` is due another check:
 * never checked, or left for more than EDITION_PROBE_MS. */
export function probeDue(lastProbeAt: number | null, now: number): boolean {
  return lastProbeAt === null || editionCatchUpDue(lastProbeAt, now);
}

/** While `active` (a snapshot view, or the Analytics overview, is open) and the
 * tab is visible: asks the status file every EDITION_PROBE_MS, and when the
 * visitor returns to the tab after that long. Never while hidden, never on the
 * guide (the caller passes `active` false), at most one request at a time.
 * Returns the time of a later published run and whether the status file has
 * been read yet (see PublicationCheck). `shownAt` is the publication time of the
 * file the page is drawn from. */
export function useNewerPublication(
  shownAt: string | null | undefined,
  active: boolean,
): PublicationCheck {
  const shown = toMs(shownAt);
  // The latest run the status file has named. It only moves forward: a host
  // that answers once with an older file does not take back an offer already made.
  const [published, setPublished] = useState<number | null>(null);
  const lastProbeAt = useRef<number | null>(null);
  useEffect(() => {
    if (!active || shown === null) return;
    const controller = new AbortController();
    let inFlight = false;
    // Loading the page was itself a check.
    lastProbeAt.current = Date.now();
    const probe = async () => {
      if (inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      lastProbeAt.current = Date.now();
      const answer = await fetchPublishedAt(controller.signal);
      inFlight = false;
      if (!controller.signal.aborted && answer !== null)
        setPublished((previous) =>
          previous === null ? answer : Math.max(previous, answer),
        );
    };
    const wake = () => {
      if (
        document.visibilityState === "visible" &&
        probeDue(lastProbeAt.current, Date.now())
      )
        void probe();
    };
    const timer = setInterval(() => void probe(), EDITION_PROBE_MS);
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
    };
  }, [active, shown]);
  return publicationCheck(published, shown);
}
