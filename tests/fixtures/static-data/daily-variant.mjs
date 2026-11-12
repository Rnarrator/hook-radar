// Deterministic TEST data for the edition's 7D and 30D volume: the fixture
// snapshot with the source row that says the daily file exists, and a
// data/daily.json for some of its pools. Test data only: none of these numbers
// is real or ever published. The shape is the collector's (shared/daily-volume.ts)
// and the file passes the same validator the data gate and the page use.
//
// The snapshot was taken on 28 October 2026 at 14:05 UTC, so its newest complete
// UTC day is 27 October. Coverage is chosen to show every state a screen has:
//
//   alpha     three of its four pools have figures; one of them is a real $0
//   gamma     two of its three pools have figures
//   frontier  its one pool is 3 days old: "since launch"
//   beta      measured nowhere: a dash, never a zero
//   delta     a measured pool without a figure: a dash
//   (loose1)  a pool with no project has a figure, and belongs to no row
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DAILY_SOURCE_ID,
  validateDailyShape,
} from "../../../shared/daily-volume.ts";
import { analyticsOverviewAsync } from "../../../server/analytics-overview.mjs";
import { GENERATED_AT } from "./generate.mjs";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "data");
export const FIXTURE_THROUGH = "2026-10-27";

// The figures, by the last hex digits of the fixture pool's address.
const FIGURES = {
  "001": { v7: 20000, v30: 90000 },
  "002": { v7: 5000, v30: 21000 },
  "003": { v7: 0, v30: 0 },
  "007": { v7: 450, v30: 450, n7: 3, n30: 3 },
  "008": { v7: 1500, v30: 6000 },
  "00a": { v7: 800, v30: 3200 },
  "00c": { v7: 100, v30: 400 },
};

export function dailyVariant({
  figures = FIGURES,
  patch = (pool) => pool,
  omit = () => false,
} = {}) {
  const snapshot = JSON.parse(
    readFileSync(join(DATA, "snapshot.json"), "utf8"),
  );
  snapshot.pools = snapshot.pools.map(patch);
  const pools = snapshot.pools
    .filter((pool) => figures[pool.address.slice(-3)] && !omit(pool))
    .map((pool, index) => ({
      id: `${pool.chain}:${pool.address.toLowerCase()}`,
      ...figures[pool.address.slice(-3)],
      // Each answer is read after 27 October ended, and before the snapshot.
      at: `2026-10-28T00:${String(10 + index).padStart(2, "0")}:00.000Z`,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const daily = {
    schemaVersion: 1,
    snapshotGeneratedAt: snapshot.generatedAt,
    through: FIXTURE_THROUGH,
    source: "geckoterminal",
    pools,
  };
  const shape = validateDailyShape(daily);
  if (!shape.ok) throw new Error(`The test daily file is invalid: ${shape.reason}`);
  const source = {
    id: DAILY_SOURCE_ID,
    name: "GeckoTerminal daily volume",
    url: "https://www.geckoterminal.com",
    status: "live",
    updatedAt: pools.map((pool) => pool.at).sort().at(-1),
    note: "Complete UTC days up to 27 Oct 2026 for 7 of the largest pools, read 28 Oct 00:10 to 28 Oct 00:16 UTC. Other pools are not covered; a pool with no daily data is unavailable, not zero.",
  };
  return {
    snapshot: { ...snapshot, sources: [...snapshot.sources, source] },
    daily,
    source,
  };
}

// ── The Analytics page ─────────────────────────────────────────────────────
//
// The Analytics page reads the overview files, not the snapshot: each carries a
// ledger of the measured pools (network, use case, the 24H volume). Its 7D and
// 30D figures are the daily figures joined to that ledger. This variant builds
// the overview files from the variant snapshot with the repository's own
// builder (so the ledger reconciles to the totals), and tunes the pools so that
// every state the page can show is there:
//
//   frontier   its one pool is made current (the plain fixture leaves it 7.5
//              minutes old, so no overview lists it) and is ONE day old, and its
//              24H volume (300) is more than its 7D (250): the 24H window
//              reaches into the day in progress, the 7D figure does not
//   loose1     a covered pool no project owns: the use case is Unattributed
//   gamma2     its 24H reading is stale: not in the ledger, not covered
//   delta      measured, no daily figure: its use case has no covered pool
//
// A file for another variant: `omit` leaves pools out of daily.json (for
// instance every Ethereum pool, so that Ethereum has volume and no figure).
const ANALYTICS_FIGURES = {
  ...FIGURES,
  "007": { v7: 250, v30: 250, n7: 1, n30: 1 },
};
const frontierCurrent = (pool) =>
  pool.address.endsWith("007")
    ? { ...pool, metricUpdatedAt: "2026-10-28T14:04:20.000Z" }
    : pool;

const OVERVIEWS = [
  ["all", "h1"],
  ["all", "h6"],
  ["all", "h24"],
  ["base", "h24"],
  ["ethereum", "h24"],
  ["robinhood", "h24"],
];

export async function analyticsSpanVariant(options = {}) {
  const variant = dailyVariant({
    figures: ANALYTICS_FIGURES,
    patch: frontierCurrent,
    ...options,
  });
  const overviews = {};
  for (const [chain, window] of OVERVIEWS) {
    const envelope = await analyticsOverviewAsync(
      variant.snapshot,
      { chain, window },
      { now: Date.parse(GENERATED_AT), contributions: true },
    );
    // The publication id is random per process; a fixed one keeps files stable.
    envelope.publication.id = "fixture-publication";
    overviews[`overview-${chain}-${window}.json`] = envelope;
  }
  return { ...variant, overviews };
}
