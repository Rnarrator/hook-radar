import { useEffect, useState } from "react";
import { dataUrl, STATIC_EDITION } from "./edition.ts";
import { withRun } from "./edition-shell.ts";
import { parseDaily } from "./daily.ts";
import type { DailyFile } from "./daily.ts";

// Reads data/daily.json (7D and 30D volume of the largest pools) once a visitor
// has picked a span, never before: a visitor who stays on 1H, 6H and 24H makes
// no request for it. The file is asked for under the address of the snapshot on
// screen (the same cache-busting the overview files use), checked by the shared
// validator, and kept for the session, so 7D then 30D is one request.
//
//   idle         nothing asked for (no span, or no snapshot yet)
//   loading      the request is on its way
//   ready        the figures
//   error        the network or the host failed: asking again may work
//   unavailable  the file is not there, is not valid, or is too old for this
//                snapshot: asking again cannot change it, for this snapshot

export type DailyState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; file: DailyFile }
  | { status: "error" }
  | { status: "unavailable" };

/** A published file is about 10 KB; far more is not this file. */
export const DAILY_MAX_BYTES = 256 * 1024;

const files = new Map<string, DailyFile>();
const gone = new Set<string>();

/** Forget what this session knows (for tests that load several snapshots). */
export function resetDailyCache(): void {
  files.clear();
  gone.clear();
}

export function useDailyVolume({
  run,
  wanted,
  retry,
}: {
  /** The generatedAt of the snapshot on screen: the file is read for it. */
  run: string | null;
  wanted: boolean;
  /** Changes when the visitor presses Try again. */
  retry: number;
}): DailyState {
  const [state, setState] = useState<DailyState>({ status: "idle" });
  useEffect(() => {
    if (!STATIC_EDITION || !run) {
      setState({ status: "idle" });
      return;
    }
    if (gone.has(run)) {
      setState({ status: "unavailable" });
      return;
    }
    const known = files.get(run);
    if (!wanted) {
      setState({ status: "idle" });
      return;
    }
    if (known) {
      setState({ status: "ready", file: known });
      return;
    }
    const controller = new AbortController();
    setState({ status: "loading" });
    const unavailable = () => {
      gone.add(run);
      if (!controller.signal.aborted) setState({ status: "unavailable" });
    };
    void (async () => {
      try {
        const response = await fetch(withRun(dataUrl("daily.json"), run), {
          signal: controller.signal,
          cache: "no-cache",
        });
        if (response.status === 404) return unavailable();
        if (!response.ok) {
          if (!controller.signal.aborted) setState({ status: "error" });
          return;
        }
        const text = await response.text();
        if (text.length > DAILY_MAX_BYTES) return unavailable();
        let value: unknown;
        try {
          value = JSON.parse(text);
        } catch {
          return unavailable();
        }
        const read = parseDaily(value, run);
        if (!read.ok) return unavailable();
        files.set(run, read.file);
        if (!controller.signal.aborted)
          setState({ status: "ready", file: read.file });
      } catch {
        if (!controller.signal.aborted) setState({ status: "error" });
      }
    })();
    return () => controller.abort();
  }, [run, wanted, retry]);
  return state;
}
