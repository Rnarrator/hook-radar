import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import {
  EDITION_HISTORY_GAP_MS,
  historyChartSegments,
  historyCsv,
  historyExportTimes,
  historyGapLabel,
  historyGapMs,
  historyGapWords,
} from "../src/history-chart.ts";

const HOUR = 3600000;
const start = Date.parse("2026-10-27T00:14:00Z");
const run = (index, hours = 3, value = 100 + index) => ({
  timestamp: start + index * hours * HOUR,
  value,
});
const every3h = (count) =>
  Array.from({ length: count }, (_, index) => run(index));

// The cadence of the scheduled collection job. The path is built, not written
// as an import, so the edition folder's import check keeps its own boundary.
const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const workflow = read(".github/workflows/snapshot.yml");
const cadenceHours = Number(
  workflow.match(/cron:\s*["']\d+ \*\/(\d+) \* \* \*["']/)?.[1],
);

test("the edition's gap threshold follows the collection cadence of the workflow", () => {
  assert.equal(cadenceHours, 3);
  assert.equal(EDITION_HISTORY_GAP_MS, 7 * HOUR);
  // A normal interval is never a gap, even when a run starts late; a gap needs
  // two or more consecutive runs missing (a single missed run, about 6 hours,
  // is still joined).
  assert.ok(EDITION_HISTORY_GAP_MS > cadenceHours * HOUR * 2);
  assert.ok(EDITION_HISTORY_GAP_MS < cadenceHours * HOUR * 3);
});

test("in the edition 12 runs three hours apart are one line with no gap", () => {
  const points = every3h(12);
  const result = historyChartSegments(points, historyGapMs(true));
  assert.deepEqual(result.gaps, []);
  assert.deepEqual(result.segments, [points.map((_, index) => index)]);
});

test("in the edition a nine hour hole is exactly one gap and nothing is bridged", () => {
  // Runs at 0, 3, 6 and 9 hours, then nothing until 18 and runs from there on.
  const hours = [0, 3, 6, 9, 18, 21, 24];
  const points = hours.map((h) => ({ timestamp: start + h * HOUR, value: 5 }));
  assert.deepEqual(historyChartSegments(points, historyGapMs(true)), {
    segments: [
      [0, 1, 2, 3],
      [4, 5, 6],
    ],
    gaps: [{ from: 3, to: 4 }],
  });
});

test("in the edition one missed run (a 6 hour interval) is joined and two missed runs (9 hours) are a gap", () => {
  const edition = historyGapMs(true);
  // Runs at 0, 3 and 6 hours, the 9 hour run missing, the next at 12 hours.
  const oneMissed = [0, 3, 6, 12].map((h) => ({
    timestamp: start + h * HOUR,
    value: 5,
  }));
  assert.deepEqual(historyChartSegments(oneMissed, edition), {
    segments: [[0, 1, 2, 3]],
    gaps: [],
  });
  // The 9 and 12 hour runs missing, the next at 15 hours: a 9 hour interval.
  const twoMissed = [0, 3, 6, 15].map((h) => ({
    timestamp: start + h * HOUR,
    value: 5,
  }));
  assert.deepEqual(historyChartSegments(twoMissed, edition), {
    segments: [[0, 1, 2], [3]],
    gaps: [{ from: 2, to: 3 }],
  });
});

test("the edition threshold is exact: seven hours is one line, one millisecond more is a gap", () => {
  const exactly = [
    { timestamp: start, value: 1 },
    { timestamp: start + 7 * HOUR, value: 2 },
  ];
  assert.deepEqual(historyChartSegments(exactly, EDITION_HISTORY_GAP_MS), {
    segments: [[0, 1]],
    gaps: [],
  });
  const over = [
    exactly[0],
    { ...exactly[1], timestamp: exactly[1].timestamp + 1 },
  ];
  assert.deepEqual(historyChartSegments(over, EDITION_HISTORY_GAP_MS), {
    segments: [[0], [1]],
    gaps: [{ from: 0, to: 1 }],
  });
});

test("without the edition the default stays one hour: 3 h spacing still gives a gap every interval", () => {
  // These tests run in plain Node, where the edition flag is off.
  assert.equal(historyGapMs(), 3600000);
  assert.equal(historyGapMs(false), 3600000);
  const points = every3h(12);
  const result = historyChartSegments(points);
  assert.equal(result.gaps.length, 11);
  assert.equal(result.segments.length, 12);
  assert.deepEqual(result, historyChartSegments(points, 3600000));
  // An unusable threshold falls back to the same default.
  for (const bad of [Number.NaN, -1, Infinity])
    assert.deepEqual(historyChartSegments(points, bad), result);
});

test("the legend and help wording state the threshold that is applied", () => {
  assert.equal(historyGapLabel(), "over 1h");
  assert.equal(historyGapLabel(false), "over 1h");
  assert.equal(historyGapWords(), "one hour");
  assert.equal(historyGapWords(false), "one hour");
  assert.equal(historyGapLabel(true), "over 7h");
  assert.equal(historyGapWords(true), "7 hours");
  assert.equal(historyGapMs(true), EDITION_HISTORY_GAP_MS);
});

test("an edition export is stamped with the real clock and names the snapshot's time apart", () => {
  const snapshot = Date.parse("2026-10-28T00:14:11.461Z");
  const exportedLater = snapshot + 2 * 24 * HOUR + 9 * HOUR;
  assert.deepEqual(historyExportTimes(snapshot, true, exportedLater), {
    exportedAt: "2026-10-30T09:14:11.461Z",
    snapshotAt: "2026-10-28T00:14:11.461Z",
  });
  // Live, the page's clock is the visitor's: one time, no second column.
  assert.deepEqual(historyExportTimes(snapshot, false, exportedLater), {
    exportedAt: "2026-10-28T00:14:11.461Z",
  });
  // The default is the real Date.now() in the edition.
  const before = Date.now();
  const stamped = Date.parse(historyExportTimes(snapshot, true).exportedAt);
  assert.ok(stamped >= before && stamped <= Date.now());
});

test("history CSV adds a snapshot_at column only when the snapshot time is given", () => {
  const points = [
    { timestamp: 1760000000, value: 0 },
    { timestamp: 1760003600123, value: 1234567.891234567 },
  ];
  const options = { range: "d7", exportedAt: "2026-10-30T09:30:00.000Z" };
  const plain = historyCsv(points, options);
  const dated = historyCsv(points, {
    ...options,
    snapshotAt: "2026-10-28T00:14:11.461Z",
  });

  // Without the option: byte-identical to the CSV the live app writes today.
  const expectedPlain =
    "﻿" +
    [
      '"observed_at_utc","original_timestamp","recorded_volume_usd_h24_rolling","metric","scope","range","exported_at"',
      '"2025-10-09T08:53:20.000Z","1760000000","0","tracked hook-pool volume, rolling 24h (not total Uniswap volume)","all-networks","d7","2026-10-30T09:30:00.000Z"',
      '"2025-10-09T09:53:20.123Z","1760003600123","1234567.891234567","tracked hook-pool volume, rolling 24h (not total Uniswap volume)","all-networks","d7","2026-10-30T09:30:00.000Z"',
    ].join("\r\n") +
    "\r\n";
  assert.equal(plain, expectedPlain);
  assert.equal(
    historyCsv(points, { ...options, snapshotAt: undefined }),
    expectedPlain,
  );

  // With it: every existing column keeps its place, one is appended, and no
  // stored value or timestamp is touched.
  const lines = dated.replace(/^﻿/, "").trimEnd().split("\r\n");
  const plainLines = plain.replace(/^﻿/, "").trimEnd().split("\r\n");
  assert.equal(lines.length, plainLines.length);
  assert.match(lines[0], /,"exported_at","snapshot_at"$/);
  for (const [index, line] of lines.entries())
    assert.ok(
      line.startsWith(plainLines[index] + ","),
      `row ${index} keeps its columns`,
    );
  assert.match(
    lines[1],
    /"2026-10-30T09:30:00\.000Z","2026-10-28T00:14:11\.461Z"$/,
  );
  assert.match(lines[2], /"1760003600123","1234567\.891234567"/);
});

// The tests above run in plain Node, where the edition flag is off. This one
// bundles the module the way the two builds do and uses its defaults.
async function bundled(flag) {
  const out = await build({
    configFile: false,
    logLevel: "silent",
    define: { "import.meta.env.VITE_STATIC_EDITION": JSON.stringify(flag) },
    build: {
      write: false,
      minify: false,
      lib: {
        entry: fileURLToPath(
          new URL("../src/history-chart.ts", import.meta.url),
        ),
        formats: ["es"],
        fileName: "history-chart",
      },
    },
  });
  const code = (Array.isArray(out) ? out[0] : out).output[0].code;
  return import(
    `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
  );
}

test("built with the edition flag the defaults are the edition's; built without it they are today's", async () => {
  const points = every3h(12);
  const snapshot = Date.parse("2026-10-28T00:14:11.461Z");

  const edition = await bundled("1");
  assert.deepEqual(edition.historyChartSegments(points).gaps, []);
  assert.equal(edition.historyChartSegments(points).segments.length, 1);
  assert.equal(edition.historyGapLabel(), "over 7h");
  assert.equal(edition.historyGapWords(), "7 hours");
  assert.equal(edition.historyGapMs(), EDITION_HISTORY_GAP_MS);
  // An unusable threshold falls back to the edition's own default.
  assert.equal(edition.historyChartSegments(points, Number.NaN).gaps.length, 0);
  const times = edition.historyExportTimes(snapshot);
  assert.equal(times.snapshotAt, "2026-10-28T00:14:11.461Z");
  assert.ok(Math.abs(Date.parse(times.exportedAt) - Date.now()) < 5000);

  const live = await bundled("0");
  assert.equal(live.historyChartSegments(points).gaps.length, 11);
  assert.equal(live.historyGapLabel(), "over 1h");
  assert.equal(live.historyGapWords(), "one hour");
  assert.deepEqual(live.historyExportTimes(snapshot), {
    exportedAt: "2026-10-28T00:14:11.461Z",
  });
});
