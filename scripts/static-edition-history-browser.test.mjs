// The recorded-history chart of the Auto Snapshot edition in a real browser:
// a point is saved once per collection run (every 3 hours), so runs three hours
// apart must be drawn as one line, two or more missing runs as a gap, and an exported file
// must carry the real export time next to the snapshot's own time. It builds
// nothing: point it at an edition build (VITE_STATIC_EDITION=1) with
// RADAR_TEST_DIST and it serves that build next to deterministic TEST data
// through scripts/static-edition-server.mjs (every /api path answers 404 and is
// recorded). The history file is replaced by test series; nothing is written to
// any data folder and no production service is touched.
//
//   RADAR_TEST_DIST=dist/test-build \
//     node --test scripts/static-edition-history-browser.test.mjs
//
// RADAR_TEST_DATA names another published-data folder to read the snapshot and
// overview files from (default: tests/fixtures/static-data/data).
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { startStaticEditionServer } from "./static-edition-server.mjs";

const DIST = resolve(process.env.RADAR_TEST_DIST || "dist");
const DATA = resolve(
  process.env.RADAR_TEST_DATA || "tests/fixtures/static-data/data",
);
const snapshotFile = JSON.parse(
  readFileSync(resolve(DATA, "snapshot.json"), "utf8"),
);
const generatedAt = snapshotFile.generatedAt;
const generated = Date.parse(generatedAt);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const DESKTOP = { width: 1440, height: 1000 };
const PHONE = { width: 390, height: 844 };

// The newest run ended just before the snapshot; earlier runs lie at the given
// number of hours before it.
const LAST = generated - 3 * MINUTE;
const series = (hoursBefore) => ({
  schemaVersion: 1,
  points: hoursBefore
    .map((hours, index) => ({
      timestamp: LAST - hours * HOUR,
      value: 3000 + index * 125,
      pools: 10,
    }))
    .sort((a, b) => a.timestamp - b.timestamp),
});
// Twelve runs, 3 hours apart: the edition's own cadence.
const EVERY_3H = series(Array.from({ length: 12 }, (_, index) => index * 3));
// Four runs, then nothing for 9 hours (two consecutive runs missing, which is
// what it takes to draw a gap), then six runs.
const WITH_HOLE = series([33, 30, 27, 24, 15, 12, 9, 6, 3, 0]);

let browser;
before(async () => {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_BIN
      ? { executablePath: process.env.CHROME_BIN }
      : process.platform === "win32"
        ? { channel: "chrome" }
        : {}),
  });
});
after(async () => {
  await browser?.close();
});

/** A page on the edition with the visitor's clock fixed, and watchers that turn
 * every console error, page error and service request into a failure. */
async function site(
  t,
  { size = DESKTOP, visitorNow = generated + 2 * MINUTE, history } = {},
) {
  const server = await startStaticEditionServer({
    distDir: DIST,
    dataDir: DATA,
    mount: "/",
  });
  if (history) {
    // The series is the test's own: a snapshot carries a copy of the history
    // it was built with, which the page falls back to when the file is empty.
    server.setData("history.json", history);
    server.setData("snapshot.json", { ...snapshotFile, history: [] });
  }
  const context = await browser.newContext({
    viewport: size,
    reducedMotion: "reduce",
    acceptDownloads: true,
  });
  await context.clock.setFixedTime(visitorNow);
  const page = await context.newPage();
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  t.after(async () => {
    await context.close();
    await server.close();
  });
  return {
    page,
    server,
    goto: (query = "") => page.goto(`${server.url}${query}`),
    verify() {
      assert.deepEqual(errors, [], "console and page errors");
      assert.deepEqual(
        server.apiRequests().map((row) => `${row.method} ${row.path}`),
        [],
        "requests to /api",
      );
    },
  };
}

const noSideways = (page, where) =>
  page
    .evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    .then((fits) => assert.ok(fits, `${where}: the page scrolls sideways`));

/** Ecosystem insights, History: on a phone the panel is folded behind a toggle. */
async function openHistoryTab(page) {
  // The panel is in the page from the start; on a phone it is folded away.
  await expect(page.locator("#monitor-history-tab")).toHaveCount(1, {
    timeout: 30000,
  });
  const toggle = page.locator(".mobile-monitor-toggle");
  if (await toggle.isVisible()) await toggle.click();
  await page.getByRole("tab", { name: "History" }).click();
}

for (const [name, size] of [
  ["1440 px", DESKTOP],
  ["390 px", PHONE],
]) {
  test(`Analytics draws runs three hours apart as one line with no gap, at ${name}`, async (t) => {
    const s = await site(t, { size, history: EVERY_3H });
    await s.goto("?view=analytics");
    const panel = s.page.locator("#analytics-history");
    await expect(panel).toContainText("12 of 12 observations", {
      timeout: 30000,
    });
    await expect(panel.locator("svg path.chart-line")).toHaveCount(1);
    await expect(panel.locator("svg path.chart-area")).toHaveCount(1);
    await expect(panel.locator(".chart-gap-band")).toHaveCount(0);
    await expect(panel.locator(".history-legend-gap")).toHaveCount(0);
    assert.doesNotMatch(await panel.innerText(), /\bgaps? over\b/);
    await noSideways(s.page, name);
    s.verify();
  });

  test(`Analytics marks one missing stretch as a single gap over 7h, at ${name}`, async (t) => {
    const s = await site(t, { size, history: WITH_HOLE });
    await s.goto("?view=analytics");
    const panel = s.page.locator("#analytics-history");
    await expect(panel).toContainText("10 of 10 observations", {
      timeout: 30000,
    });
    // Two stretches of runs, each a line, with the hole between them.
    await expect(panel.locator("svg path.chart-line")).toHaveCount(2);
    await expect(panel.locator(".chart-gap-band")).toHaveCount(1);
    await expect(panel.locator(".history-legend")).toContainText(
      "1 gap over 7h",
    );
    assert.doesNotMatch(await panel.innerText(), /over 1h/);
    await noSideways(s.page, name);
    s.verify();
  });

  test(`Discover's History tab draws the same runs as one line, and a hole as a gap over 7 hours, at ${name}`, async (t) => {
    for (const [history, gaps] of [
      [EVERY_3H, 0],
      [WITH_HOLE, 1],
    ]) {
      const s = await site(t, { size, history });
      await s.goto();
      await openHistoryTab(s.page);
      const chart = s.page.locator(".observations-chart");
      await expect(chart).toBeVisible({ timeout: 30000 });
      await expect(chart.locator(".observation-gap")).toHaveCount(gaps);
      await expect(chart.locator("path.observation-series")).toHaveCount(
        gaps + 1,
      );
      if (gaps) {
        await expect(chart.locator(".observation-gap-note")).toHaveText(
          "Shaded spans have no recorded observations for over 7 hours.",
        );
      } else {
        await expect(chart.locator(".observation-gap-note")).toHaveCount(0);
      }
      assert.doesNotMatch(await chart.innerText(), /one hour|over 1h/);
      // The two time labels under the plot never run into each other.
      const [first, last] = await chart
        .locator("svg > text.svg-text")
        .evaluateAll((labels) =>
          labels.map((label) => {
            const box = label.getBoundingClientRect();
            return { left: box.left, right: box.right };
          }),
        );
      assert.ok(
        first.right < last.left,
        `${name}: the axis labels overlap (${first.right} against ${last.left})`,
      );
      await noSideways(s.page, name);
      s.verify();
    }
  });
}

test("Discover's History tab says what is recorded without waiting for live data", async (t) => {
  const cases = [
    [
      series([0]),
      "Not enough history yet",
      "One volume observation is saved. The chart appears once two are saved.",
    ],
    [
      { schemaVersion: 1, points: [] },
      "No volume history yet",
      "No volume observation is saved yet. The chart appears once two are saved.",
    ],
  ];
  for (const [history, title, text] of cases) {
    const s = await site(t, { history });
    await s.goto();
    await openHistoryTab(s.page);
    const empty = s.page.locator("#monitor-content .monitor-empty");
    await expect(empty).toBeVisible({ timeout: 30000 });
    await expect(empty.locator("strong")).toHaveText(title);
    await expect(empty.locator("p")).toHaveText(text);
    const shown = await empty.innerText();
    assert.doesNotMatch(
      shown,
      /fresh market data|Only fresh|Waiting|new market data/i,
    );
    // The page also states the snapshot's own run, so the empty state must not
    // claim that no run exists: a run that measured no pool volume saves no
    // observation.
    assert.doesNotMatch(shown, /collection run|runs? (is|are) recorded/i);
    await expect(s.page.locator("body")).toContainText(/Snapshot taken/);
    s.verify();
  }
});

test("the history CSV is stamped with the real export time and names the snapshot's time", async (t) => {
  // The visitor opens an old snapshot two days later.
  const visitorNow = generated + 2 * DAY;
  const s = await site(t, { visitorNow, history: EVERY_3H });
  await s.goto("?view=analytics");
  const panel = s.page.locator("#analytics-history");
  await expect(panel).toContainText("12 of 12 observations", {
    timeout: 30000,
  });
  const [download] = await Promise.all([
    s.page.waitForEvent("download"),
    panel.getByRole("button", { name: "History CSV" }).click(),
  ]);
  const exportDate = new Date(visitorNow).toISOString().slice(0, 10);
  const snapshotDate = generatedAt.slice(0, 10);
  assert.notEqual(
    exportDate,
    snapshotDate,
    "the two dates differ in this test",
  );
  assert.equal(
    download.suggestedFilename(),
    `hook-radar-recorded-24h-volume-d7-${exportDate}.csv`,
    "the file name carries the export date",
  );
  const csv = readFileSync(await download.path(), "utf8");
  const lines = csv.replace(/^﻿/, "").trimEnd().split("\r\n");
  const cells = (line) => line.slice(1, -1).split('","');
  assert.deepEqual(cells(lines[0]), [
    "observed_at_utc",
    "original_timestamp",
    "recorded_volume_usd_h24_rolling",
    // The history file says how many pools stood behind each value.
    "pools_measured",
    "metric",
    "scope",
    "range",
    "exported_at",
    "snapshot_at",
  ]);
  assert.equal(lines.length - 1, EVERY_3H.points.length);
  for (const [index, line] of lines.slice(1).entries()) {
    const row = cells(line);
    assert.equal(row.length, 9);
    const point = EVERY_3H.points[index];
    // Every stored observation is exactly as recorded.
    assert.equal(row[0], new Date(point.timestamp).toISOString());
    assert.equal(row[1], String(point.timestamp));
    assert.equal(row[2], String(point.value));
    assert.equal(row[3], String(point.pools));
    // exported_at is when the file was made; snapshot_at is the snapshot's time.
    assert.equal(row[7], new Date(visitorNow).toISOString());
    assert.equal(row[8], new Date(generatedAt).toISOString());
  }
  s.verify();
});
