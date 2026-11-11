// How many history points the edition keeps: 2,016, which is 84 days at one run
// an hour. The number lives in four places that must agree or a run publishes
// nothing, or the page drops its history chart: the collector's cap and its state
// check (collector/config.mjs, collector/state.mjs), the page's reader of
// history.json (src/edition.ts), and the overview check that the collector and the
// page hand the number to (shared/analytics-overview.ts keeps 672 for everyone
// else, the live service included). These tests hold them together, run the real
// collector over histories of the old and the new length, and show the live
// default unchanged.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HISTORY_MAX_POINTS } from "../collector/config.mjs";
import { FIXTURES, runCollector } from "../collector/run.mjs";
import { isHistory, readState } from "../collector/state.mjs";
import { blockNetwork } from "../collector/testing.mjs";
import {
  ANALYTICS_OVERVIEW_HISTORY_POINTS,
  isAnalyticsOverviewEnvelope,
} from "../shared/analytics-overview.ts";
import { EDITION_HISTORY_MAX_POINTS, parseHistory } from "../src/edition.ts";

blockNetwork();

const HOUR = 3600000;
// The recorded run's own time: the fixture snapshot is taken at this moment.
const SNAPSHOT_AT = Date.parse("2026-10-27T21:11:13.200Z");

const points = (count, { endAt = SNAPSHOT_AT - HOUR, pools = 68 } = {}) =>
  Array.from({ length: count }, (_, index) => ({
    timestamp: endAt - (count - 1 - index) * HOUR,
    value: 1000000 + index * 17.25,
    pools: index === count - 1 ? pools : 1200,
  }));
const file = (list) => ({ schemaVersion: 1, points: list });

test("the page's cap and the collector's are the same number, and it is 84 days of hourly runs", () => {
  assert.equal(EDITION_HISTORY_MAX_POINTS, HISTORY_MAX_POINTS);
  assert.equal(HISTORY_MAX_POINTS, 84 * 24);
  assert.equal(HISTORY_MAX_POINTS, 2016);
  // The live default of the shared check is what it always was.
  assert.equal(ANALYTICS_OVERVIEW_HISTORY_POINTS, 672);
});

test("history.json of 2,016 points passes the collector's check and the page's reader; 2,017 fails both", () => {
  for (const count of [0, 1, 8, 672, 673, 2015, 2016]) {
    assert.equal(isHistory(file(points(count))), true, `${count} (collector)`);
    const read = parseHistory(file(points(count)));
    assert.ok(read, `${count} (page)`);
    assert.equal(read.length, count);
  }
  for (const count of [2017, 2100, 5000]) {
    assert.equal(isHistory(file(points(count))), false, `${count} (collector)`);
    assert.equal(parseHistory(file(points(count))), null, `${count} (page)`);
  }
  // Nothing else about the check moved: unordered or malformed points still fail.
  const shuffled = points(5).reverse();
  assert.equal(isHistory(file(shuffled)), false);
  assert.equal(parseHistory(file([{ timestamp: 1, value: -1 }])), null);
  assert.equal(parseHistory({ schemaVersion: 2, points: [] }), null);
});

// ---- the real collector over histories of different lengths -----------------

async function run(count) {
  const dir = await mkdtemp(join(tmpdir(), "edition-history-cap-"));
  try {
    const stateIn = join(dir, "state-in");
    await cp(join(FIXTURES, "state"), stateIn, { recursive: true });
    await writeFile(
      join(stateIn, "history.json"),
      `${JSON.stringify(file(points(count)))}\n`,
    );
    const out = join(dir, "out");
    let result;
    try {
      result = await runCollector({
        stateDir: stateIn,
        outDir: out,
        stateOutDir: join(out, "state"),
        publish: true,
        offline: true,
        minCurrent: 20,
      });
    } catch (error) {
      return { error };
    }
    const json = async (name) =>
      JSON.parse(await readFile(join(out, name), "utf8"));
    return {
      result,
      history: result.published ? await json("history.json") : null,
      overview: result.published ? await json("overview-all-h24.json") : null,
      overviewH1: result.published ? await json("overview-all-h1.json") : null,
      snapshot: result.published ? await json("snapshot.json") : null,
      state: result.published ? await json("state/history.json") : null,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a history written under the old cap is still read and extended by one point", async () => {
  for (const count of [0, 8, 672]) {
    const { result, history, overview, snapshot, state } = await run(count);
    assert.equal(result.ok, true, `${count}: ${result.quality.failures}`);
    assert.equal(result.published, true);
    // The earlier points stay, the run's own point is added at the end.
    assert.equal(history.points.length, count + 1, `${count} points`);
    assert.deepEqual(state.points, history.points);
    assert.equal(overview.history.points.length, count + 1);
    assert.equal(snapshot.history.length, count + 1);
    assert.ok(
      history.points.every(
        (point, index) =>
          index === 0 || point.timestamp > history.points[index - 1].timestamp,
      ),
      "strictly increasing, newest last",
    );
    // Every file the page reads passes the check it will apply.
    assert.equal(
      isAnalyticsOverviewEnvelope(
        overview,
        { chain: "all", window: "h24" },
        {
          maxHistoryPoints: EDITION_HISTORY_MAX_POINTS,
        },
      ),
      true,
    );
    assert.equal(parseHistory(history)?.length, count + 1);
  }
});

test("at the cap the oldest point goes and the newest is kept: 2,015 points become 2,016, 2,016 stay 2,016", async () => {
  const full = points(2016);
  const grown = await run(2015);
  assert.equal(grown.result.ok, true, `${grown.result.quality.failures}`);
  assert.equal(grown.history.points.length, 2016);
  assert.equal(
    grown.history.points[0].timestamp,
    points(2015)[0].timestamp,
    "nothing was cut",
  );

  const kept = await run(2016);
  assert.equal(kept.result.ok, true, `${kept.result.quality.failures}`);
  assert.equal(kept.history.points.length, 2016);
  // The oldest of the 2,016 stored points is dropped; the second oldest leads.
  assert.equal(kept.history.points[0].timestamp, full[1].timestamp);
  assert.equal(kept.state.points.length, 2016);
  assert.equal(kept.snapshot.history.length, 2016);
  assert.equal(kept.overview.history.points.length, 2016);
  assert.equal(kept.overviewH1.history.points.length, 2016);
  // A full-length history passes the collector's state check, the page's reader and
  // the overview check as the collector and the page apply them.
  assert.equal(isHistory(kept.state), true);
  assert.equal(parseHistory(kept.history)?.length, 2016);
  for (const [envelope, window] of [
    [kept.overview, "h24"],
    [kept.overviewH1, "h1"],
  ])
    assert.equal(
      isAnalyticsOverviewEnvelope(
        envelope,
        { chain: "all", window },
        {
          maxHistoryPoints: EDITION_HISTORY_MAX_POINTS,
        },
      ),
      true,
      window,
    );
});

test("a stored history above the cap is refused exactly as before: nothing is published", async () => {
  const { error, result } = await run(2017);
  assert.match(
    String(error?.message ?? ""),
    /history\.json has an unexpected shape/,
    "the state file is rejected before anything is collected",
  );
  assert.equal(result, undefined);
  // And readState says the same in isolation.
  const dir = await mkdtemp(join(tmpdir(), "edition-history-cap-state-"));
  try {
    await cp(join(FIXTURES, "state"), dir, { recursive: true });
    await writeFile(
      join(dir, "history.json"),
      JSON.stringify(file(points(2017))),
    );
    await assert.rejects(
      readState(dir),
      /history\.json has an unexpected shape/,
    );
    await writeFile(
      join(dir, "history.json"),
      JSON.stringify(file(points(2016))),
    );
    assert.equal((await readState(dir)).history.length, 2016);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- the shared overview check keeps its live default -----------------------

test("the overview check: 672 points for everyone by default, more only when the caller says so", async () => {
  const { overview } = await run(0);
  const query = { chain: "all", window: "h24" };
  const base = overview.history.points;
  assert.equal(base.length, 1);
  const older = (count) =>
    Array.from({ length: count }, (_, index) => ({
      timestamp: base[0].timestamp - (count - index) * HOUR,
      value: 1000 + index,
    }));
  const withPoints = (count) => ({
    ...overview,
    history: { ...overview.history, points: [...older(count - 1), ...base] },
  });
  // Live default: 672 passes, 673 does not, with no third argument or with an
  // empty one, and for anything that is not a whole number of at least one.
  assert.equal(isAnalyticsOverviewEnvelope(withPoints(672), query), true);
  assert.equal(isAnalyticsOverviewEnvelope(withPoints(673), query), false);
  assert.equal(isAnalyticsOverviewEnvelope(withPoints(673), query, {}), false);
  assert.equal(
    isAnalyticsOverviewEnvelope(withPoints(673), query, undefined),
    false,
  );
  for (const bad of [
    0,
    -1,
    1.5,
    Number.NaN,
    Infinity,
    "2016",
    null,
    undefined,
    {},
  ])
    assert.equal(
      isAnalyticsOverviewEnvelope(withPoints(673), query, {
        maxHistoryPoints: bad,
      }),
      false,
      `a cap of ${String(bad)} is not a cap`,
    );
  // The edition's number: 2,016 passes, 2,017 does not.
  const edition = { maxHistoryPoints: EDITION_HISTORY_MAX_POINTS };
  assert.equal(
    isAnalyticsOverviewEnvelope(withPoints(672), query, edition),
    true,
  );
  assert.equal(
    isAnalyticsOverviewEnvelope(withPoints(2016), query, edition),
    true,
  );
  assert.equal(
    isAnalyticsOverviewEnvelope(withPoints(2017), query, edition),
    false,
  );
  // A smaller number is honoured too (it is a cap, not a floor).
  assert.equal(
    isAnalyticsOverviewEnvelope(withPoints(10), query, { maxHistoryPoints: 9 }),
    false,
  );
});

test("the live service's overview module is called as before: only the edition's collector passes a cap", async () => {
  const read = async (path) =>
    (await readFile(new URL(`../${path}`, import.meta.url), "utf8")).replace(
      /\r\n/g,
      "\n",
    );
  // The live HTTP layer never mentions a cap (the edition's folder does not carry
  // that file, so there is nothing to look at there). The path is built from a
  // variable, not written out inside the URL: the folder builder reads a written
  // out file URL as a dependency and would carry the live server (twelve files)
  // into the public folder.
  const liveHttp = "server/http.mjs";
  if (existsSync(new URL(`../${liveHttp}`, import.meta.url)))
    assert.doesNotMatch(await read(liveHttp), /maxHistoryPoints/);
  // The collector and the page pass the edition's number, and only they.
  assert.match(
    await read("collector/overview.mjs"),
    /maxHistoryPoints: HISTORY_MAX_POINTS/,
  );
  const hook = await read("src/useAnalyticsOverview.ts");
  assert.match(
    hook,
    /STATIC_EDITION\s*\?\s*\{ maxHistoryPoints: EDITION_HISTORY_MAX_POINTS \}\s*:\s*undefined/,
  );
});
