// The leftovers of the Auto Snapshot edition that show on screen, in a real
// browser: the pool explorer's empty states, the date in the analytics CSV file
// name, the Data notes sentence about the pool count, the 24px touch hit area of
// the composition-bar segments, and the not-carried notice in Compare. The
// checks that need no browser (wording of both flavours, stylesheet text,
// packaging) are in tests/edition-leftovers.test.mjs.
//
// Like scripts/static-edition-browser.test.mjs it builds nothing: point it at
// an edition build (VITE_STATIC_EDITION=1) with RADAR_TEST_DIST. It serves that
// build next to deterministic TEST data (tests/fixtures/static-data/data, or the
// folder RADAR_TEST_DATA names, such as a real snapshot) through
// scripts/static-edition-server.mjs, which answers every /api path with 404 and
// records every request. No production data, no network, no service.
//
//   RADAR_TEST_DIST=<edition build> node --test scripts/static-edition-leftovers-browser.test.mjs
//
// It lives here, not under tests/, because `npm test` runs every tests/*.test.mjs
// with RADAR_TEST_DIST pointing at the live build when someone is testing the
// live interface, and an edition-only check cannot pass against that.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test, { after, before } from "node:test";
import { chromium, expect } from "@playwright/test";
import { startStaticEditionServer } from "./static-edition-server.mjs";

const DIST = resolve(process.env.RADAR_TEST_DIST || "dist");
const DATA = resolve(
  process.env.RADAR_TEST_DATA || "tests/fixtures/static-data/data",
);

// A live build never reaches the end of a wait for the edition's own page:
// say so at once instead of after thirty seconds per test.
const builtPage = readFileSync(resolve(DIST, "index.html"), "utf8");
if (!/<html[^>]*\sdata-edition="snapshot"/.test(builtPage))
  throw new Error(
    `${DIST} is not an edition build: its index.html has no data-edition="snapshot" on the root element. Build with VITE_STATIC_EDITION=1 and name it in RADAR_TEST_DIST.`,
  );

// A desktop; a narrow window with a mouse (a fine pointer: the bar is 14px
// high); and a phone with a finger (a coarse pointer: the bar is 22px high).
const DESKTOP = { width: 1440, height: 1000 };
const NARROW = { width: 390, height: 844 };
const PHONE = { width: 390, height: 844, touch: true };

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

const snapshot = () =>
  JSON.parse(readFileSync(resolve(DATA, "snapshot.json"), "utf8"));

/** The build served next to the data. `data` replaces named data files. */
async function site(
  t,
  { size = DESKTOP, data = {}, now = null, motion = "reduce" } = {},
) {
  const server = await startStaticEditionServer({
    distDir: DIST,
    dataDir: DATA,
    mount: "/",
  });
  for (const [name, body] of Object.entries(data)) server.setData(name, body);
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    reducedMotion: motion,
    acceptDownloads: true,
    ...(size.touch ? { hasTouch: true, isMobile: true } : {}),
  });
  const page = await context.newPage();
  // The visitor's own clock, set apart from the snapshot's.
  if (now) await page.clock.setFixedTime(new Date(now));
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  t.after(async () => {
    await context.close();
    await server.close();
  });
  const ready = async () => {
    await expect(page.getByTestId("snapshot-line")).toBeVisible({
      timeout: 30000,
    });
    await page.waitForTimeout(600);
  };
  return {
    page,
    server,
    ready,
    goto: (query = "") => page.goto(`${server.url}${query}`),
    /** The page asked no service and threw nothing. */
    verify() {
      assert.deepEqual(errors, [], "page errors");
      assert.deepEqual(server.apiRequests(), [], "requests to /api");
    },
  };
}

/** The analytics page, opened to the pool explorer and the CSV export. */
async function openWorkspace(s, query = "?view=analytics") {
  await s.goto(query);
  await s.ready();
  await s.page
    .getByRole("button", { name: /Open projects, hooks and pools/ })
    .click();
  await expect(s.page.locator(".analytics-pool-explorer")).toBeVisible({
    timeout: 30000,
  });
  await s.page.waitForTimeout(600);
}

/* ── Pool explorer ────────────────────────────────────────────────────── */

for (const [name, size] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
])
  test(`[${name}] a snapshot with no measured pool says so in the snapshot's words`, async (t) => {
    const s = await site(t, {
      size,
      data: { "snapshot.json": { ...snapshot(), pools: [] } },
    });
    await openWorkspace(s);
    const explorer = s.page.locator(".analytics-pool-explorer");
    const text = await explorer.innerText();
    for (const phrase of [
      "No matching measurements in this snapshot",
      "Select a pool from the measurements in this snapshot.",
      "No current pool measurements",
      "No pool in this scope has a current volume or reserve measurement in this snapshot.",
    ])
      assert.ok(text.includes(phrase), `the page lacks "${phrase}"`);
    assert.doesNotMatch(text, /\byet\b|become available|appear here when/i);
    if (size.touch)
      assert.ok(
        (await s.page.evaluate(() => document.documentElement.scrollWidth)) <=
          size.width,
        "no sideways scroll",
      );
    s.verify();
  });

test("with measured pools the explorer shows a selected pool and none of the empty wording", async (t) => {
  const s = await site(t);
  await openWorkspace(s);
  const explorer = s.page.locator(".analytics-pool-explorer");
  await expect(explorer.locator(".pool-chart-detail")).toContainText(
    "Measured (original clock)",
  );
  const text = await explorer.innerText();
  assert.doesNotMatch(text, /No matching measurements/);
  assert.doesNotMatch(text, /Select a pool from the measurements/);
  s.verify();
});

/* ── CSV file name ────────────────────────────────────────────────────── */

test("the analytics CSV file is dated the day it is exported, and still names the snapshot's own time", async (t) => {
  const generatedAt = snapshot().generatedAt;
  // A visitor 40 days after the snapshot: the two dates cannot be confused.
  const today = new Date(Date.parse(generatedAt) + 40 * 86400000);
  const day = today.toISOString().slice(0, 10);
  assert.notEqual(day, generatedAt.slice(0, 10));
  const s = await site(t, { now: today.toISOString() });
  await openWorkspace(s);
  const [download] = await Promise.all([
    s.page.waitForEvent("download", { timeout: 15000 }),
    s.page.getByRole("button", { name: "Export analytics CSV" }).click(),
  ]);
  assert.equal(
    download.suggestedFilename(),
    `hook-radar-analytics-all-h24-${day}.csv`,
  );
  const csv = readFileSync(await download.path(), "utf8");
  // The snapshot's own time is in the file, as it was measured.
  assert.ok(
    csv.includes(new Date(Date.parse(generatedAt)).toISOString()),
    "the file names the time of the snapshot",
  );
  assert.ok(!csv.includes(today.toISOString().slice(0, 16)));
  s.verify();
});

/* ── Data notes ───────────────────────────────────────────────────────── */

for (const [name, size] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
])
  test(`[${name}] the Networks Data notes explain the pool count in the snapshot's terms`, async (t) => {
    const s = await site(t, { size });
    await s.goto("?view=chains");
    await s.ready();
    const notes = s.page.locator("#chains-method");
    await notes.locator("summary").click();
    const text = (await notes.innerText()).replace(/\s+/g, " ");
    assert.ok(
      text.includes(
        "A ≥ pool count is a known lower bound. In the project lists the count is the pools measured in this snapshot.",
      ),
      text,
    );
    s.verify();
  });

/* ── Composition bar ──────────────────────────────────────────────────── */

/** The first segment of the first composition bar, its painted height, and
 * whether the point `dy` pixels from its top edge (negative: above) belongs to
 * it (its own box or its extended hit area). */
async function ribbonProbe(s, offsets) {
  const bar = s.page.getByTestId("analytics-composition");
  await bar.scrollIntoViewIfNeeded();
  await s.page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          !animation.effect?.target?.classList?.contains("chart-ribbon-bar") ||
          animation.playState === "finished",
      ),
  );
  await s.page.waitForTimeout(300);
  return s.page.evaluate((list) => {
    const segment = document.querySelector("button.chart-ribbon-segment");
    const rect = segment.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    return {
      height: rect.height,
      clip: getComputedStyle(segment.closest(".chart-ribbon-bar")).clipPath,
      pseudo: getComputedStyle(segment, "::after").content,
      hits: list.map((dy) => ({
        dy,
        hit:
          document.elementFromPoint(
            x,
            dy < 0 ? rect.top + dy : rect.top + rect.height + dy,
          ) === segment,
      })),
    };
  }, offsets);
}

const hitAt = (probe, dy) => probe.hits.find((row) => row.dy === dy).hit;

// Both ways a visitor can have the page: with reduced motion (the bar is drawn
// at once) and with motion allowed (the bar is revealed over 900ms, and the
// reveal's last keyframe, a clip-path, would otherwise stay on it and clip the
// hit area away). The reveal is done before each probe.
const MOTIONS = [
  ["reduced motion", "reduce"],
  ["motion allowed", "no-preference"],
];

for (const [mode, motion] of MOTIONS) {
  test(`[desktop, ${mode}] the bar's segments keep their own size: no extra hit area`, async (t) => {
    const s = await site(t, { size: DESKTOP, motion });
    await s.goto("?view=analytics");
    await s.ready();
    const probe = await ribbonProbe(s, [-4, 4]);
    assert.equal(probe.height, 14, "the painted bar is 14px high");
    assert.equal(probe.pseudo, "none", "no pseudo-element on a desktop");
    assert.equal(hitAt(probe, -4), false);
    assert.equal(hitAt(probe, 4), false);
    s.verify();
  });

  test(`[narrow window, ${mode}] the bar stays 14px high and its segments can be hit 5px beyond it, 24px in all`, async (t) => {
    const s = await site(t, { size: NARROW, motion });
    await s.goto("?view=analytics");
    await s.ready();
    const probe = await ribbonProbe(s, [-4.5, 4.5, -7, 7]);
    assert.equal(probe.height, 14, "the painted bar is unchanged");
    assert.equal(
      probe.clip,
      "none",
      "no clip stays on the bar after its reveal",
    );
    assert.equal(probe.pseudo, '""');
    assert.equal(hitAt(probe, -4.5), true, "above the bar, inside the 24px");
    assert.equal(hitAt(probe, 4.5), true, "below the bar, inside the 24px");
    assert.equal(hitAt(probe, -7), false, "the hit area stops at 24px");
    assert.equal(hitAt(probe, 7), false, "the hit area stops at 24px");
    // A press just above the painted bar selects the segment.
    const segment = s.page.locator("button.chart-ribbon-segment").first();
    const box = await segment.boundingBox();
    await s.page.mouse.click(box.x + box.width / 2, box.y - 4);
    await expect(segment).toHaveAttribute("aria-pressed", "true");
    s.verify();
  });

  test(`[phone, ${mode}] on touch the 22px bar is hit over 24px, and a tap just outside it selects the segment`, async (t) => {
    const s = await site(t, { size: PHONE, motion });
    await s.goto("?view=analytics");
    await s.ready();
    const probe = await ribbonProbe(s, [-0.5, 0.5, -3, 3]);
    assert.equal(
      probe.height,
      22,
      "the painted bar is unchanged (touch height)",
    );
    assert.equal(
      probe.clip,
      "none",
      "no clip stays on the bar after its reveal",
    );
    assert.equal(probe.pseudo, '""');
    assert.equal(hitAt(probe, -0.5), true);
    assert.equal(hitAt(probe, 0.5), true);
    assert.equal(hitAt(probe, -3), false, "the hit area stops at 24px");
    assert.equal(hitAt(probe, 3), false, "the hit area stops at 24px");
    const segment = s.page.locator("button.chart-ribbon-segment").first();
    const box = await segment.boundingBox();
    await s.page.touchscreen.tap(box.x + box.width / 2, box.y - 0.5);
    await expect(segment).toHaveAttribute("aria-pressed", "true");
    s.verify();
  });
}

/* ── Compare: the not-carried notice ──────────────────────────────────── */

for (const [name, size] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
])
  test(`[${name}] the not-carried notice's stylesheet puts each id in a row with its Remove button and wraps a long id`, async (t) => {
    // The page drops an id the snapshot lacks before Compare can name it, so
    // the notice's own markup (HookComparison.tsx) is put in place and the built
    // stylesheet is read on it.
    const s = await site(t, { size });
    await s.goto("?view=compare");
    await s.ready();
    await expect(s.page.locator(".comparison-workspace")).toBeVisible();
    await s.page.evaluate(() => {
      const host = document.querySelector(".comparison-workspace");
      const notice = document.createElement("div");
      notice.className = "notice comparison-not-carried";
      notice.setAttribute("role", "status");
      notice.innerHTML =
        "<svg width='16' height='16'></svg><div><p>This link names 2 projects this snapshot does not carry (it carries registry-named projects and projects with at least one measured pool):</p><ul>" +
        "<li><code>ghost-project-one</code> <button type='button'>Remove</button></li>" +
        `<li><code>${"a-ghost-project-with-a-long-id-".repeat(3)}0123456789</code> <button type='button'>Remove</button></li></ul></div>`;
      host.parentElement.insertBefore(notice, host);
    });
    const answer = await s.page.evaluate(() => {
      const notice = document.querySelector(".comparison-not-carried");
      const rect = (el) => el.getBoundingClientRect();
      const lines = [...notice.querySelectorAll("li")].map((li) => ({
        listStyle: getComputedStyle(li.parentElement).listStyleType,
        padding: getComputedStyle(li.parentElement).paddingLeft,
        buttonMargin: getComputedStyle(li.querySelector("button")).marginLeft,
        wraps: getComputedStyle(li).flexWrap,
        contained: rect(li).right <= rect(notice).right + 0.5,
        sameRow:
          Math.abs(
            rect(li.querySelector("button")).top -
              rect(li.querySelector("code")).top,
          ) < 12,
      }));
      return {
        lines,
        align: getComputedStyle(notice).alignItems,
        iconAtTop:
          Math.abs(
            rect(notice.querySelector("svg")).top -
              rect(notice.querySelector("p")).top,
          ) < 6,
        sideScroll: document.documentElement.scrollWidth > innerWidth,
      };
    });
    assert.equal(answer.align, "flex-start");
    assert.ok(answer.iconAtTop, "the icon sits beside the first line");
    assert.equal(answer.sideScroll, false, "no sideways scroll");
    for (const line of answer.lines) {
      assert.equal(line.listStyle, "none");
      assert.equal(line.padding, "0px");
      assert.equal(line.buttonMargin, "0px");
      assert.equal(line.wraps, "wrap");
      assert.ok(line.contained, "an id stays inside the notice");
    }
    // The short id has its button beside it; a long one may wrap the button.
    assert.ok(
      answer.lines[0].sameRow,
      "the short id and its button share a row",
    );
    s.verify();
  });
