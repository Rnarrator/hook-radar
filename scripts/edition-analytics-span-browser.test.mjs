// 7D and 30D on the Analytics page, in a real browser. Point it at an edition
// build (VITE_STATIC_EDITION=1) with RADAR_TEST_DIST; it serves that build next
// to the deterministic TEST data in tests/fixtures/static-data/data, with the
// snapshot given the source row that says the daily file exists, a data/daily.json
// and the overview files built from the same snapshot by
// tests/fixtures/static-data/daily-variant.mjs, through
// scripts/static-edition-server.mjs (every /api path is a 404, every request is
// recorded). No production data, no network, no service.
//
//   RADAR_TEST_DIST=work/aspan-candidate/dist \
//     node --test scripts/edition-analytics-span-browser.test.mjs
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { startStaticEditionServer } from "./static-edition-server.mjs";
import { GENERATED_AT } from "../tests/fixtures/static-data/generate.mjs";
import { analyticsSpanVariant } from "../tests/fixtures/static-data/daily-variant.mjs";

const DIST = resolve(process.env.RADAR_TEST_DIST || "dist");
const DATA = resolve("tests/fixtures/static-data/data");
const generated = Date.parse(GENERATED_AT);
const MINUTE = 60_000;
const DESKTOP = { width: 1440, height: 1000 };
const PHONE = { width: 390, height: 844 };

const html = readFileSync(resolve(DIST, "index.html"), "utf8");
const entry =
  html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/)?.[1] ?? "";
const MOUNT =
  process.env.RADAR_TEST_MOUNT ||
  (entry.startsWith("./") ? "/" : entry.replace(/assets\/[^/]+$/, "") || "/");

const CAPTION = "Full UTC days through 27 Oct. Largest pools only.";
const NOT_COVERED =
  "Not covered: only the largest pools have 7D and 30D volume.";

let browser;
let variant;
let noEthereum;
before(async () => {
  variant = await analyticsSpanVariant();
  noEthereum = await analyticsSpanVariant({
    omit: (pool) => pool.chain === "ethereum",
  });
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

/** A page on the edition. `offered` false serves the plain fixture (no source
 * row for the daily file anywhere); `file` is the daily file's answer (an object,
 * a string, or null for a 404). */
async function site(
  t,
  { size = DESKTOP, offered = true, source = variant, file, timezoneId } = {},
) {
  const server = await startStaticEditionServer({
    distDir: DIST,
    dataDir: DATA,
    mount: MOUNT,
  });
  if (offered) {
    server.setData("snapshot.json", JSON.stringify(source.snapshot));
    for (const [name, envelope] of Object.entries(source.overviews))
      server.setData(name, JSON.stringify(envelope));
    server.setData("daily.json", file === undefined ? source.daily : file);
  }
  const context = await browser.newContext({
    viewport: size,
    reducedMotion: "reduce",
    acceptDownloads: true,
    ...(timezoneId ? { timezoneId } : {}),
  });
  await context.clock.setFixedTime(generated + 2 * MINUTE);
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
  const requested = (pattern) =>
    server.requests.filter((row) => pattern.test(row.path));
  return {
    page,
    server,
    errors,
    size,
    dailyRequests: () => requested(/\/data\/daily\.json$/),
    snapshotRequests: () => requested(/\/data\/snapshot\.json$/),
    overviewRequests: () =>
      requested(/\/data\/overview-[a-z0-9-]+\.json$/).map((row) =>
        row.path.replace(/^.*\/data\//, ""),
      ),
    goto: (query = "") => page.goto(`${server.url}${query}`),
    verify({ allow404 = false, allow = /^$/ } = {}) {
      assert.deepEqual(
        errors.filter(
          (text) =>
            !(allow404 && /Failed to load resource.*404/.test(text)) &&
            !allow.test(text),
        ),
        [],
        "console and page errors",
      );
      assert.deepEqual(server.apiRequests(), [], "requests to /api");
    },
  };
}

const SWITCH = ".title-controls .window-switch";
const ready = async (page) => {
  await expect(page.getByTestId("analytics-volume")).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId("analytics-volume")).not.toHaveText("…");
};
const switchLabels = (page) => page.locator(`${SWITCH} button`).allInnerTexts();
const pressed = (page) =>
  page.locator(`${SWITCH} button[aria-pressed="true"]`).allInnerTexts();
const pick = async (page, key) => {
  await page.locator(`${SWITCH} button[data-span="${key}"]`).click();
  await expect(page.getByTestId("daily-caption")).toHaveAttribute("data-shown", "true", {
    timeout: 15000,
  });
};
const tileText = (page, id) => page.getByTestId(id).innerText();
const scopeLine = (page) => page.locator(".analytics-scope-line").innerText();
const search = (page) => new URL(page.url()).search;
/** The focus bar's parts (their text has no spaces between inline boxes). */
const focusBar = (page) => ({
  bar: page.locator(".analytics-focus-bar"),
  kind: page.locator(".analytics-focus-kind"),
  chip: page.locator(".analytics-focus-chip"),
  detail: page.locator(".analytics-focus-detail"),
});

/** The boxes that must not move when a control is pressed: the window switch,
 * Share view, the line beside the switch, the scope line, the command bar, the
 * four tiles with their label, figure and caption, and the top of the first block
 * under them. A caption is as wide and as tall as its words (the tile around it
 * keeps its height), so only where it starts is compared; the scope line and the
 * command bar's caption also keep their height. */
const places = (page) =>
  page.evaluate(() => {
    const round = (n) => Math.round(n * 2) / 2;
    const box = (el, mode = true) => {
      const r = el.getBoundingClientRect();
      return mode === "origin"
        ? [r.x, r.y].map(round)
        : mode
          ? [r.x, r.y, r.width, r.height].map(round)
          : [r.x, r.y, r.height].map(round);
    };
    const out = {};
    const take = (name, selector, mode = true) =>
      document.querySelectorAll(selector).forEach((el, i) => {
        out[`${name}[${i}]`] = box(el, mode);
      });
    take("switch", ".title-controls .window-switch button");
    take("share", ".title-controls .share-button");
    take("caption-line", '[data-testid="daily-caption"]');
    take("scope-line", ".analytics-scope-line", false);
    take("scope-badge", ".analytics-coverage-badge");
    take("metric-switch", ".analytics-metric-switch button");
    take("network", ".analytics-network-select");
    take("command-caption", ".analytics-scope-caption", false);
    take("actions", ".analytics-toolbar-actions button");
    take("sections", ".analytics-sections a");
    take("tile", ".analytics-metric");
    take("tile-label", ".analytics-metric-label");
    take("tile-figure", ".analytics-metric > strong");
    take("tile-caption", ".analytics-metric-caption", "origin");
    take("rank-link", ".analytics-metric-switch-link");
    take("focus-bar", ".analytics-focus-bar", false);
    const composition = document.querySelector('[data-testid="analytics-composition"]');
    if (composition) out.composition = [round(composition.getBoundingClientRect().y)];
    return out;
  });

/** Where a pair of snapshots of `places` differ, as text. */
const moved = (a, b) =>
  Object.keys({ ...a, ...b })
    .filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]))
    .map((key) => `${key}: ${JSON.stringify(a[key])} -> ${JSON.stringify(b[key])}`);

/* ── The page as it was ──────────────────────────────────────────────────── */

test("the default Analytics page: five buttons, 24H pressed, no request for the daily file or the snapshot", async (t) => {
  const s = await site(t);
  await s.goto("?view=analytics");
  await ready(s.page);
  assert.deepEqual(await switchLabels(s.page), ["1H", "6H", "24H", "7D", "30D"]);
  assert.deepEqual(await pressed(s.page), ["24H"]);
  assert.equal(await s.page.locator(`${SWITCH} button[data-span]`).count(), 2);
  assert.equal(s.dailyRequests().length, 0, "no request for the daily file");
  assert.equal(s.snapshotRequests().length, 0, "no snapshot on the light page");
  assert.deepEqual(s.overviewRequests(), ["overview-all-h24.json"]);
  await expect(s.page.getByTestId("daily-caption")).toBeHidden();
  await expect(s.page.getByTestId("daily-caption")).toHaveText("");
  assert.match(await tileText(s.page, "analytics-volume"), /^\$4\.0K$/);
  await expect(s.page.locator(".analytics-metric").first()).toContainText("Trading volume · 24H");
  await expect(s.page.getByText("Pools with trading · 24H")).toBeVisible();
  assert.match(await scopeLine(s.page), /Hook pools Radar can price · All networks · 24H window · measured within 5 minutes of the snapshot/);
  // The History panel has its own range switch; the span does not touch it.
  const range = s.page.locator(".analytics-history .window-switch button, #analytics-history .window-switch button");
  assert.deepEqual(await range.allInnerTexts(), ["24 hours", "7 days", "30 days", "All history"]);
  assert.equal(await s.page.locator(".window-switch").count(), 2, "the masthead's and the history's");
  s.verify();
});

test("7D then 30D then 24H: one request for the daily file, none for the snapshot or another overview, the address follows, and 24H comes back as it was", async (t) => {
  const s = await site(t);
  await s.goto("?view=analytics");
  await ready(s.page);
  const original = {
    scope: await scopeLine(s.page),
    tile: await s.page.locator(".analytics-metric").first().innerText(),
    reserves: await tileText(s.page, "analytics-liquidity"),
    trading: await tileText(s.page, "analytics-active-pools"),
    command: await s.page.locator(".analytics-scope-caption").innerText(),
    method: await s.page.locator(".analytics-method summary").innerText(),
  };
  await pick(s.page, "d7");
  assert.equal(s.dailyRequests().length, 1);
  assert.equal(s.snapshotRequests().length, 0);
  assert.deepEqual(s.overviewRequests(), ["overview-all-h24.json"], "no overview is asked for again");
  assert.deepEqual(await pressed(s.page), ["7D"]);
  assert.equal(search(s.page), "?view=analytics&window=d7");
  await expect(s.page.getByTestId("daily-caption")).toHaveText(CAPTION);
  await expect(s.page.getByTestId("daily-status")).toHaveText("Showing 7D volume through 27 Oct");
  const tile = s.page.locator(".analytics-metric").first();
  await expect(tile).toContainText("Trading volume · 7D");
  assert.equal(await tileText(s.page, "analytics-volume"), "≥$27.6K");
  await expect(tile).toContainText("7 of 8 pools · through 27 Oct");
  assert.match(
    (await s.page.getByTestId("analytics-volume").getAttribute("title")) ?? "",
    /^At least \$27,650\.00\. The last 7 full days \(UTC\) through 27 Oct, largest pools only\. 1 of the 7 pools is younger than 7 days and counts from the launch day\./,
  );
  assert.equal(
    await s.page.getByTestId("analytics-volume").getAttribute("aria-hidden"),
    "true",
    "the figure with its mark is hidden from the accessibility tree",
  );
  assert.match(await tile.locator(".sr-only").innerText(), /^at least \$27\.6 thousand, 7D through 27 Oct$/);
  assert.equal(
    await scopeLine(s.page),
    "Partial coverage · Not total Uniswap volume\nLargest hook pools only · All networks · 7D through 27 Oct · 7 pools hold 99.9% of tracked 24H volume",
  );
  assert.equal(await s.page.locator(".analytics-scope-caption").innerText(), "7D window · USD");
  assert.equal(await s.page.locator(".analytics-method summary").innerText().then((x) => x.split("\n")[0]), "As of the snapshot · 7D through 27 Oct");
  // The tooltip above cannot be opened with a finger: the exact figure and the
  // facts behind it are in the collapsed Data notes as well, and only under a span.
  const detail = s.page.getByTestId("analytics-span-detail");
  await expect(detail).toBeHidden();
  await s.page.locator(".analytics-method summary").click();
  await expect(detail).toBeVisible();
  assert.match(
    await detail.innerText(),
    /^The 7D total is at least \$27,650\.00\. 1 of the 7 pools is younger than 7 days and counts from the launch day\. Read from GeckoTerminal 28 Oct 2026, 00:10 UTC to 28 Oct 2026, 00:16 UTC\. The 24H figure can come from another provider\.$/,
  );
  await s.page.locator(".analytics-method summary").click();
  await expect(detail).toBeHidden();
  // Reserves and pools with trading are the snapshot's 24H measurements.
  assert.equal(await tileText(s.page, "analytics-liquidity"), original.reserves);
  assert.equal(await tileText(s.page, "analytics-active-pools"), original.trading);
  // 30D reads the same file.
  await pick(s.page, "d30");
  assert.equal(s.dailyRequests().length, 1, "7D and 30D are one request");
  assert.equal(search(s.page), "?view=analytics&window=d30");
  assert.equal(await tileText(s.page, "analytics-volume"), "≥$120.8K");
  await expect(s.page.getByTestId("daily-status")).toHaveText("Showing 30D volume through 27 Oct");
  assert.equal(await s.page.locator(".analytics-scope-caption").innerText(), "30D window · USD");
  // 24H again: every word is the one it started with.
  await s.page.locator(SWITCH).getByRole("button", { name: "24H" }).click();
  await expect(s.page.getByTestId("daily-caption")).toBeHidden();
  assert.equal(search(s.page), "?view=analytics");
  assert.equal(await scopeLine(s.page), original.scope);
  assert.equal(await s.page.locator(".analytics-metric").first().innerText(), original.tile);
  assert.equal(await s.page.locator(".analytics-scope-caption").innerText(), original.command);
  assert.equal(await s.page.locator(".analytics-method summary").innerText(), original.method);
  assert.equal(await s.page.getByTestId("analytics-span-detail").count(), 0, "no span, no exact 7D figure in the notes");
  assert.equal(s.dailyRequests().length, 1);
  assert.deepEqual(s.overviewRequests(), ["overview-all-h24.json"]);
  s.verify();
});

/* ── Nothing moves ───────────────────────────────────────────────────────── */

const SIZES = [
  { width: 1440, height: 1000 },
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1100, height: 800 },
  { width: 1024, height: 800 },
  { width: 768, height: 900 },
  { width: 390, height: 844 },
  { width: 360, height: 800 },
  { width: 320, height: 700 },
];

test("pressing 7D, 30D or 24H moves nothing: the switch, the controls, the scope line, the tiles and the block under them keep their place at every width", async (t) => {
  for (const size of SIZES) {
    const where = `${size.width}x${size.height}`;
    const s = await site(t, { size });
    await s.goto("?view=analytics");
    await ready(s.page);
    const before = await places(s.page);
    assert.ok(before["switch[4]"] && before["tile[3]"] && before.composition, `${where}: the parts are there`);
    for (const key of ["d7", "d30"]) {
      await pick(s.page, key);
      assert.deepEqual(moved(before, await places(s.page)), [], `${where}: ${key} moved something`);
    }
    // Keyboard: the same, with focus on the pressed button.
    await s.page.locator(`${SWITCH} button[data-span="d7"]`).focus();
    await s.page.keyboard.press("Enter");
    await expect(s.page.getByTestId("daily-status")).toHaveText("Showing 7D volume through 27 Oct");
    assert.deepEqual(moved(before, await places(s.page)), [], `${where}: Enter on 7D moved something`);
    await s.page.locator(SWITCH).getByRole("button", { name: "24H" }).click();
    await expect(s.page.getByTestId("daily-caption")).toBeHidden();
    assert.deepEqual(moved(before, await places(s.page)), [], `${where}: 24H moved something`);
    const { scrollWidth, clientWidth } = await s.page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    assert.ok(scrollWidth <= clientWidth, `${where}: no sideways scroll`);
    s.verify();
  }
});

test("with a focus set, pressing a span moves nothing either: the focus bar keeps its place and its height", async (t) => {
  for (const size of [DESKTOP, { width: 1024, height: 800 }, PHONE, { width: 320, height: 700 }]) {
    const where = `${size.width}`;
    const s = await site(t, { size });
    await s.goto("?view=analytics");
    await ready(s.page);
    await s.page.getByRole("button", { name: /^Composition bar, Base/ }).click();
    await expect(s.page.locator(".analytics-focus-bar")).toBeVisible();
    // (Choosing a bar scrolled the page to it: the positions are read from the top.)
    await s.page.evaluate(() => window.scrollTo(0, 0));
    const before = await places(s.page);
    assert.ok(before["focus-bar[0]"], `${where}: the focus bar is there`);
    for (const key of ["d7", "d30"]) {
      await pick(s.page, key);
      assert.deepEqual(moved(before, await places(s.page)), [], `${where}: ${key} with a focus moved something`);
    }
    await s.page.locator(SWITCH).getByRole("button", { name: "24H" }).click();
    await expect(s.page.getByTestId("daily-caption")).toBeHidden();
    assert.deepEqual(moved(before, await places(s.page)), [], `${where}: 24H with a focus moved something`);
    s.verify();
  }
});

/** The blocks whose height follows a span's own words and legends (the ribbons,
 * the Data notes' summary line), the tiles above them and the History panel
 * below them, each as where it starts and how tall it is. */
const blocks = (page) =>
  page.evaluate(() => {
    const round = (n) => Math.round(n * 2) / 2;
    const at = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { y: round(r.y + window.scrollY), height: round(r.height) };
    };
    return {
      tiles: at(".analytics-metrics"),
      ribbons: at('[data-testid="analytics-composition"]'),
      notes: at(".analytics-method > summary"),
      history: at("#analytics-history"),
    };
  });

// A span lists fewer networks and use cases, and the same words read at another
// length ("As of the snapshot · 7D through 27 Oct"), so a legend wraps onto one
// line less or a summary fits on one line. The block keeps the height of the
// tallest state shown, so the History panel and everything below stay put. These
// widths are ones where the test data's 24H ribbons are taller than the span's
// (400 to 480), where the Data notes' line wrapped (520 to 560), or where the
// empty status line used to be pushed onto a row of its own (960).
const HELD_WIDTHS = [1440, 1100, 1024, 960, 768, 560, 520, 480, 440, 400, 390, 320];

test("pressing a span never makes the ribbons, the Data notes line or the panel below shorter, and at these widths moves none of them", async (t) => {
  for (const width of [...HELD_WIDTHS, 360]) {
    const where = `${width}`;
    const s = await site(t, { size: { width, height: 900 } });
    await s.goto("?view=analytics");
    await ready(s.page);
    const before = await blocks(s.page);
    assert.ok(before.ribbons && before.notes && before.history && before.tiles, `${where}: the blocks are there`);
    for (const key of ["d7", "d30", "24h"]) {
      if (key === "24h") {
        await s.page.locator(SWITCH).getByRole("button", { name: "24H" }).click();
        await expect(s.page.getByTestId("daily-caption")).toBeHidden();
      } else await pick(s.page, key);
      const after = await blocks(s.page);
      // Nothing above them ever moves.
      assert.deepEqual(after.tiles, before.tiles, `${where}: ${key} moved the tiles`);
      // Never shorter than the 24H block, so nothing below is pulled up.
      assert.ok(after.ribbons.height >= before.ribbons.height - 0.5, `${where}: ${key} made the ribbons shorter, ${before.ribbons.height} -> ${after.ribbons.height}`);
      assert.ok(after.notes.height >= before.notes.height - 0.5, `${where}: ${key} made the notes line shorter`);
      assert.ok(after.history.y >= before.history.y - 0.5, `${where}: ${key} pulled the History panel up, ${before.history.y} -> ${after.history.y}`);
      // At these widths no span reads longer than 24H, so nothing moves at all.
      // (At 360 the test data's 7D legend names Ethereum at 2.9%, 14px wider than
      // 4%, and wraps one line more: a block can grow when a span's own figures
      // are wider, and then keeps that height.)
      if (HELD_WIDTHS.includes(width))
        assert.deepEqual(after, before, `${where}: ${key} moved something`);
    }
    s.verify();
  }
});

test("a window that is resized after a span was chosen is not left with the old height: the block is its own height at the new width", async (t) => {
  // At 480 the 24H ribbons are taller than the 7D ones, so 7D holds the 24H height.
  const narrow = await site(t, { size: { width: 480, height: 900 } });
  await narrow.goto("?view=analytics");
  await ready(narrow.page);
  const at480 = await blocks(narrow.page);
  await pick(narrow.page, "d7");
  assert.deepEqual(await blocks(narrow.page), at480, "held at 480");
  const natural7 = await narrow.page.getByTestId("analytics-composition").evaluate((el) => {
    // (A reduced-motion visitor's 0.01 ms transition would answer with the old value.)
    const held = el.style.minHeight;
    el.style.transition = "none";
    el.style.minHeight = "0px";
    const height = el.getBoundingClientRect().height;
    el.style.minHeight = held;
    el.style.transition = "";
    return height;
  });
  assert.ok(natural7 < at480.ribbons.height - 5, `the 7D ribbons are shorter by themselves, ${natural7} against ${at480.ribbons.height}`);
  // The same page, widened: what a page that was opened wide shows for 7D.
  const wide = await site(t, { size: { width: 1440, height: 900 } });
  await wide.goto("?view=analytics&window=d7");
  await ready(wide.page);
  await expect(wide.page.getByTestId("daily-caption")).toHaveAttribute("data-shown", "true", { timeout: 15000 });
  const reference = await blocks(wide.page);
  await narrow.page.setViewportSize({ width: 1440, height: 900 });
  // The ribbons, and the Data notes line that starts where they end: nothing is
  // left over from 480.
  await expect
    .poll(
      async () => {
        const { ribbons, notes } = await blocks(narrow.page);
        return { ribbons, notes };
      },
      { timeout: 10000 },
    )
    .toEqual({ ribbons: reference.ribbons, notes: reference.notes });
  // And narrowed again: 24H is its own height at 480, as it was.
  await narrow.page.setViewportSize({ width: 480, height: 900 });
  await narrow.page.locator(SWITCH).getByRole("button", { name: "24H" }).click();
  await expect(narrow.page.getByTestId("daily-caption")).toBeHidden();
  await expect
    .poll(async () => (await blocks(narrow.page)).ribbons.height, { timeout: 10000 })
    .toBe(at480.ribbons.height);
  narrow.verify();
  wide.verify();
});

test("the sizes of the default page are the sizes of a page that has no span at all", async (t) => {
  // The edition without the daily file is the plain page. The controls above the
  // scope line differ (two buttons and a reserved line), so positions from the
  // scope line down are compared relative to it, and sizes as they are.
  for (const size of [DESKTOP, { width: 768, height: 900 }, PHONE, { width: 320, height: 700 }]) {
    const where = `${size.width}`;
    const sizes = async (s) => {
      await s.goto("?view=analytics");
      await ready(s.page);
      return s.page.evaluate(() => {
        const r = (el) => el.getBoundingClientRect();
        const top = r(document.querySelector(".analytics-scope-line")).y;
        const read = (selector, name) =>
          [...document.querySelectorAll(selector)].map((el, i) => {
            const b = r(el);
            return [`${name}[${i}]`, [b.width, b.height, b.y - top].map((n) => Math.round(n * 2) / 2)];
          });
        return Object.fromEntries([
          ...read(".analytics-scope-line", "scope"),
          ...read(".analytics-metric", "tile"),
          ...read(".analytics-metric > strong", "figure"),
          ...read(".analytics-metric-label", "label"),
          ...read(".analytics-metric-caption", "caption").map(([k, [, h, y]]) => [k, [h, y]]),
          ...read(".analytics-composition-row", "ribbon"),
        ]);
      });
    };
    const plain = await sizes(await site(t, { size, offered: false }));
    const offered = await sizes(await site(t, { size }));
    // The labels of the plain fixture's overview are the 24H ones too; the page
    // under the span feature is the same size, tile by tile. (The fixtures differ
    // in data, so only the shapes that do not depend on it are compared.)
    for (const key of Object.keys(plain).filter((k) => /^(scope|label|figure)\[/.test(k)))
      assert.deepEqual(offered[key], plain[key], `${where}: ${key}`);
  }
});

test("while the file loads nothing moves either: the tile reads an ellipsis, the ribbons and the bars keep their height, then the figures arrive in the same places", async (t) => {
  for (const size of [DESKTOP, PHONE, { width: 320, height: 700 }]) {
    const where = `${size.width}`;
    const s = await site(t, { size });
    let release;
    const held = new Promise((resolve) => (release = resolve));
    await s.page.route("**/data/daily.json*", async (route) => {
      await held;
      await route.continue();
    });
    await s.goto("?view=analytics");
    await ready(s.page);
    const before = await places(s.page);
    const heightBefore = await s.page.locator(".analytics-contributors-grid").evaluate((el) => el.getBoundingClientRect().height);
    await s.page.locator(`${SWITCH} button[data-span="d7"]`).click();
    await expect(s.page.getByTestId("analytics-volume")).toHaveText("…");
    await expect(s.page.getByTestId("daily-status")).toHaveText("Loading 7D volume");
    await expect(s.page.locator(".analytics-metric").first()).toContainText("Loading 7D volume");
    assert.doesNotMatch(await s.page.locator(".analytics-metrics").innerText(), /\$4\.0K/, "no 24H figure under the 7D label");
    assert.equal(
      await s.page.locator('[data-testid="analytics-composition"]').innerText(),
      "Loading 7D volume",
    );
    // The bars hold their height while they load.
    const during = await s.page.locator(".analytics-contributors-grid").evaluate((el) => el.getBoundingClientRect().height);
    assert.ok(Math.abs(during - heightBefore) <= 0.5, `${where}: the bars held ${heightBefore}, now ${during}`);
    assert.deepEqual(
      moved(before, await places(s.page)).filter((line) => !/^(tile-caption|composition)/.test(line)),
      [],
      `${where}: loading moved something`,
    );
    release();
    await expect(s.page.getByTestId("analytics-volume")).toHaveText("≥$27.6K");
    assert.deepEqual(moved(before, await places(s.page)), [], `${where}: the figures moved something when they arrived`);
    // The held height is let go: the bars are their own height again.
    const after = await s.page.locator(".analytics-contributors-grid").evaluate((el) => el.style.minHeight);
    assert.equal(after, "");
    s.verify();
  }
});

/* ── Metrics, focus, networks ────────────────────────────────────────────── */

test("the reserves and pools-with-trading metrics keep their 24H words and numbers while a span is chosen; volume comes back as 7D", async (t) => {
  const s = await site(t);
  await s.goto("?view=analytics");
  await ready(s.page);
  const metric = (name) => s.page.locator(".analytics-metric-switch").getByRole("button", { name, exact: true });
  const grid = () => s.page.locator(".analytics-contributors-grid").innerText();
  await metric("Reserves").click();
  const reserves24 = await grid();
  const ribbons24 = await s.page.getByTestId("analytics-composition").innerText();
  await pick(s.page, "d7");
  assert.equal(await grid(), reserves24, "reserves: the bars are the 24H page's");
  assert.equal(await s.page.getByTestId("analytics-composition").innerText(), ribbons24);
  assert.equal(await s.page.locator(".analytics-scope-caption").innerText(), "24H window · USD");
  await metric("Pools with trading").click();
  assert.match(await grid(), /Pools with trading by network/);
  assert.doesNotMatch(await grid(), /7D|≥|largest pools/);
  assert.equal(await s.page.locator(".analytics-scope-caption").innerText(), "24H window · USD");
  await metric("Volume").click();
  assert.match(await grid(), /7D volume by network/);
  assert.match(await grid(), /≥\$26\.6K/);
  assert.equal(await s.page.locator(".analytics-scope-caption").innerText(), "7D window · USD");
  assert.equal(s.dailyRequests().length, 1);
  s.verify();
});

test("every amount in the tile, the ribbons, the bars and the focus bar is marked at least; a use case with no covered pool is a dash", async (t) => {
  const s = await site(t, { size: { width: 1440, height: 1200 } });
  await s.goto("?view=analytics&window=d7");
  await ready(s.page);
  await expect(s.page.getByTestId("analytics-volume")).toHaveText("≥$27.6K");
  const scan = async (where) => {
    let text = await s.page.evaluate(() => {
      const parts = [];
      const scope = (el) => {
        if (!el) return;
        parts.push(el.outerHTML.replace(/<svg[\s\S]*?<\/svg>/g, ""));
      };
      scope(document.querySelector('[data-testid="analytics-volume"]')?.parentElement);
      scope(document.querySelector('[data-testid="analytics-composition"]'));
      scope(document.querySelector(".analytics-contributors-grid"));
      scope(document.querySelector(".analytics-focus-bar"));
      return parts.join("\n");
    });
    // The tile sets its sign in the data face (a span around the character only).
    text = text.replace(/<span class="analytics-bound-sign">≥<\/span>/g, "≥");
    for (const match of text.matchAll(/\$\d/g)) {
      const around = text.slice(Math.max(0, match.index - 10), match.index);
      assert.match(around, /(≥|at least |At least )$/, `${where}: a bare amount near ${text.slice(match.index - 30, match.index + 15)}`);
    }
  };
  await scan("7D");
  // The accessible table of the bars says it too.
  await s.page.getByText("View as table").first().click();
  await expect(s.page.getByRole("columnheader", { name: "USD, at least" }).first()).toBeVisible();
  await expect(s.page.getByRole("columnheader", { name: "Share of covered 7D volume" }).first()).toBeVisible();
  await expect(s.page.getByRole("columnheader", { name: "Covered pools" }).first()).toBeVisible();
  await expect(s.page.getByRole("cell", { name: "≥$26,600.00" })).toBeVisible();
  // Focus a network: every bar, the readout and the focus bar change, with marks.
  const focus = focusBar(s.page);
  await s.page.getByRole("button", { name: /^Composition bar, Base/ }).click();
  await expect(focus.kind).toHaveText("Focus · Network");
  await expect(focus.chip).toContainText("Base");
  await expect(focus.detail).toHaveText("≥$26.6K of ≥$27.6K covered 7D volume · 96.2%");
  await scan("focus on Base");
  await pick(s.page, "d30");
  await expect(focus.chip).toContainText("Base", { timeout: 5000 });
  await expect(focus.detail).toContainText("covered 30D volume");
  await scan("focus on Base, 30D");
  await s.page.keyboard.press("Escape");
  await expect(s.page.locator(".analytics-focus-bar")).toHaveCount(0);
  // A use case none of whose pools is covered (Oracles has one measured pool).
  await s.page.getByRole("button", { name: /^Oracles: Not available/ }).click();
  await expect(focus.detail).toHaveText("No 30D volume: none of its pools is among the largest");
  await expect(s.page.locator(".contrib-detail")).toContainText("No 30D volume: none of its pools is among the largest");
  assert.doesNotMatch(await s.page.locator(".contrib-categories").innerText(), /Oracles[^\n]*\n?[^\n]*≥\$0/);
  await scan("focus on Oracles");
  s.verify();
});

test("the focus stays across a span change and does not move the bar; a focus on a network with no covered pool says so, never zero", async (t) => {
  const s = await site(t, { source: noEthereum });
  await s.goto("?view=analytics");
  await ready(s.page);
  const focus = focusBar(s.page);
  await s.page.getByRole("button", { name: /^Composition bar, Ethereum/ }).click();
  await expect(focus.kind).toHaveText("Focus · Network");
  await expect(focus.chip).toContainText("Ethereum");
  const bar = await focus.bar.boundingBox();
  await pick(s.page, "d7");
  await expect(focus.chip).toContainText("Ethereum");
  await expect(focus.detail).toHaveText("No 7D volume: none of its pools is among the largest");
  const after = await focus.bar.boundingBox();
  assert.equal(after.y, bar.y, "the focus bar keeps its place");
  // The network has no bar under the span: omitted, not shown as zero.
  assert.equal(await s.page.getByRole("button", { name: /^Ethereum: / }).count(), 0);
  assert.match(await s.page.locator(".contrib-networks").innerText(), /3 networks? with 7D volume|2 networks? with 7D volume/);
  assert.doesNotMatch(await s.page.locator(".contrib-networks").innerText(), /Ethereum/);
  s.verify();
});

test("choosing another network keeps the span, asks for no second daily file, and a network with no covered pool shows a dash and no ribbon", async (t) => {
  const s = await site(t, { source: noEthereum });
  await s.goto("?view=analytics&window=d7");
  await ready(s.page);
  assert.equal(s.dailyRequests().length, 1);
  const select = s.page.locator(".analytics-network-select select");
  await select.selectOption("base");
  await expect(s.page.getByTestId("analytics-volume")).toHaveText("≥$26.6K");
  await expect(s.page.getByTestId("analytics-volume")).toBeVisible();
  assert.deepEqual(await switchLabels(s.page), ["1H", "6H", "24H", "7D", "30D"], "the buttons stay");
  assert.deepEqual(await pressed(s.page), ["7D"]);
  assert.equal(search(s.page), "?view=analytics&analytics_chain=base&window=d7");
  assert.equal(s.dailyRequests().length, 1, "no second request for the daily file");
  assert.ok(s.overviewRequests().includes("overview-base-h24.json"));
  assert.equal(
    await scopeLine(s.page),
    "Partial coverage · Not total Uniswap volume\nLargest hook pools only · Base · 7D through 27 Oct · 4 pools hold 100% of tracked 24H volume",
  );
  // A network with volume and no covered pool.
  await select.selectOption("ethereum");
  await expect(s.page.getByTestId("analytics-volume")).toHaveText("—");
  await expect(s.page.locator(".analytics-metric").first()).toContainText("No pool here has 7D data");
  assert.match(await scopeLine(s.page), /Largest hook pools only · Ethereum · 7D through 27 Oct · No pool here has 7D data$/);
  assert.equal(await s.page.locator('[data-testid="analytics-composition"] .chart-ribbon').count(), 0, "no ribbon without a figure");
  await expect(s.page.locator(".contrib-networks")).toContainText("No 7D volume for Ethereum");
  await expect(s.page.locator(".contrib-networks")).toContainText("None of its pools is among the largest, so there is no 7D figure. Missing values are never shown as zero.");
  assert.doesNotMatch(await s.page.locator(".analytics-metrics").innerText().then((x) => x.split("\n").slice(0, 8).join("\n")), /\$0\b/);
  assert.deepEqual(await switchLabels(s.page), ["1H", "6H", "24H", "7D", "30D"]);
  assert.equal(s.dailyRequests().length, 1);
  // From 1H the press moves to the 24H file and nothing more.
  await select.selectOption("all");
  await s.page.locator(SWITCH).getByRole("button", { name: "1H" }).click();
  await expect(s.page.getByTestId("daily-caption")).toBeHidden();
  const before = s.overviewRequests().filter((n) => n === "overview-all-h24.json").length;
  await pick(s.page, "d30");
  await expect(s.page.getByTestId("analytics-volume")).toHaveText("≥$117.7K");
  assert.equal(
    s.overviewRequests().filter((n) => n === "overview-all-h24.json").length,
    before + 1,
    "from 1H the overview moves to the 24H window",
  );
  assert.equal(s.dailyRequests().length, 1);
  s.verify();
});

/* ── Address, Back, Forward, reload ──────────────────────────────────────── */

test("the address keeps the span: a reload, Back and Forward; Discover and Analytics share it; Compare drops it", async (t) => {
  const s = await site(t);
  await s.goto("?view=analytics&window=d30&analytics_chain=base");
  await ready(s.page);
  assert.deepEqual(await pressed(s.page), ["30D"]);
  assert.equal(await tileText(s.page, "analytics-volume"), "≥$117.4K");
  await s.page.reload();
  await ready(s.page);
  assert.deepEqual(await pressed(s.page), ["30D"]);
  assert.equal(search(s.page), "?view=analytics&analytics_chain=base&window=d30");
  // Pushing a network and going Back.
  await s.page.locator(".analytics-network-select select").selectOption("all");
  await expect(s.page.getByTestId("analytics-volume")).toHaveText("≥$120.8K");
  assert.equal(search(s.page), "?view=analytics&window=d30");
  await s.page.goBack();
  await ready(s.page);
  assert.equal(search(s.page), "?view=analytics&analytics_chain=base&window=d30");
  assert.deepEqual(await pressed(s.page), ["30D"]);
  assert.equal(await s.page.locator(".analytics-network-select select").inputValue(), "base");
  await s.page.goForward();
  await expect(s.page.getByTestId("analytics-volume")).toHaveText("≥$120.8K");
  assert.deepEqual(await pressed(s.page), ["30D"]);
  // The span is shared with Discover, and is dropped on a page that has none.
  await s.page.goto(`${s.server.url}?window=d7`);
  await expect(s.page.getByTestId("snapshot-line")).toBeVisible({ timeout: 30000 });
  await s.page.getByTestId("view-analytics").click();
  await ready(s.page);
  assert.deepEqual(await pressed(s.page), ["7D"]);
  assert.equal(await tileText(s.page, "analytics-volume"), "≥$27.6K");
  assert.equal(search(s.page), "?view=analytics&window=d7");
  assert.equal(s.dailyRequests().length >= 1, true);
  await s.page.goBack();
  await expect(s.page.getByTestId("snapshot-line")).toBeVisible({ timeout: 30000 });
  assert.deepEqual(await pressed(s.page), ["7D"], "Back to Discover keeps the span");
  await s.page.goForward();
  await ready(s.page);
  assert.deepEqual(await pressed(s.page), ["7D"]);
  await s.goto("?view=compare&window=d7");
  await expect.poll(() => search(s.page)).not.toContain("window=");
  s.verify();
});

test("from Discover to Analytics the file is not asked for again, and no snapshot is fetched twice", async (t) => {
  const s = await site(t);
  await s.goto("?window=d7");
  await expect(s.page.getByTestId("snapshot-line")).toBeVisible({ timeout: 30000 });
  await expect(s.page.getByTestId("daily-caption")).toHaveText(CAPTION);
  assert.equal(s.dailyRequests().length, 1);
  await s.page.getByTestId("view-analytics").click();
  await ready(s.page);
  assert.equal(await tileText(s.page, "analytics-volume"), "≥$27.6K");
  assert.equal(s.dailyRequests().length, 1, "the file is read once for the run");
  assert.equal(s.snapshotRequests().length, 1);
  s.verify();
});

test("a link with a span on a page whose snapshot names no daily file drops it, shows no buttons and asks for nothing", async (t) => {
  const s = await site(t, { offered: false });
  await s.goto("?view=analytics&window=d7");
  await ready(s.page);
  assert.deepEqual(await switchLabels(s.page), ["1H", "6H", "24H"]);
  assert.deepEqual(await pressed(s.page), ["24H"]);
  assert.equal(await s.page.locator("[data-span]").count(), 0);
  assert.equal(await s.page.getByTestId("daily-caption").count(), 0);
  await expect.poll(() => search(s.page)).toBe("?view=analytics");
  assert.equal(s.dailyRequests().length, 0);
  assert.match(await scopeLine(s.page), /Hook pools Radar can price · All networks · 24H window/);
  s.verify();
});

test("a link whose first overview was never published keeps its span in the address; All networks then brings it", async (t) => {
  const s = await site(t);
  await s.goto("?view=analytics&window=d7&analytics_chain=nowhere");
  await expect(s.page.getByRole("heading", { name: /isn.t published|no analytics|not published/i }).first()).toBeVisible({ timeout: 30000 }).catch(() => {});
  await expect(s.page.getByRole("button", { name: "All networks" })).toBeVisible({ timeout: 30000 });
  assert.match(search(s.page), /window=d7/, "the span is still in the address");
  assert.equal(s.dailyRequests().length, 0, "nothing is offered until a file has been read");
  await s.page.getByRole("button", { name: "All networks" }).click();
  await ready(s.page);
  assert.deepEqual(await pressed(s.page), ["7D"]);
  assert.equal(await tileText(s.page, "analytics-volume"), "≥$27.6K");
  assert.equal(s.dailyRequests().length, 1);
  s.verify({ allow404: true });
});

/* ── Failures ────────────────────────────────────────────────────────────── */

test("a file that is missing, not valid or too old removes the buttons, says so, and shows the 24H page", async (t) => {
  const cases = {
    "a missing file": null,
    "text that is not JSON": "<html>not the file</html>",
    "a file for another day": () => ({ ...variant.daily, through: "2026-10-20" }),
    "a file of another shape": () => ({ ...variant.daily, pools: [{ id: "x" }] }),
    "a file with no pool in it": () => ({ ...variant.daily, pools: [] }),
  };
  for (const [label, make] of Object.entries(cases)) {
    const s = await site(t, { file: typeof make === "function" ? make() : make });
    await s.goto("?view=analytics&window=d7");
    await ready(s.page);
    await expect(s.page.getByTestId("daily-caption")).toHaveText("No 7D or 30D volume in this snapshot.");
    assert.deepEqual(await switchLabels(s.page), ["1H", "6H", "24H"], label);
    assert.deepEqual(await pressed(s.page), ["24H"], label);
    await expect.poll(() => search(s.page), label).toBe("?view=analytics");
    assert.equal(await tileText(s.page, "analytics-volume"), "$4.0K", label);
    assert.match(await scopeLine(s.page), /24H window/, label);
    assert.equal(s.dailyRequests().length, 1, `${label}: asked once and not again`);
    s.verify({ allow404: make === null });
  }
});

test("a failed request: a dash and 'Not loaded', one line where the ribbons and bars were, Try again brings the figures, and the other metrics still work", async (t) => {
  const s = await site(t);
  let failing = true;
  await s.page.route("**/data/daily.json*", async (route) =>
    failing ? route.fulfill({ status: 503, body: "busy" }) : route.continue(),
  );
  await s.goto("?view=analytics&window=d7");
  await ready(s.page);
  const caption = s.page.getByTestId("daily-caption");
  await expect(caption).toContainText("Could not load 7D and 30D volume.");
  await expect(s.page.getByTestId("daily-status")).toHaveText("Could not load 7D and 30D volume.");
  assert.deepEqual(await switchLabels(s.page), ["1H", "6H", "24H", "7D", "30D"]);
  assert.equal(await tileText(s.page, "analytics-volume"), "—");
  await expect(s.page.locator(".analytics-metric").first()).toContainText("Not loaded");
  assert.equal(await s.page.getByTestId("analytics-composition").innerText(), "Could not load 7D volume.");
  await expect(s.page.locator(".analytics-contributors-grid")).toHaveText("Could not load 7D volume.");
  assert.doesNotMatch(await s.page.locator(".analytics-metrics").innerText(), /\$4\.0K/);
  await s.page.locator(".analytics-metric-switch").getByRole("button", { name: "Reserves", exact: true }).click();
  await expect(s.page.locator(".contrib-networks")).toContainText("Reserves by network");
  await s.page.locator(".analytics-metric-switch").getByRole("button", { name: "Volume", exact: true }).click();
  failing = false;
  await caption.getByRole("button", { name: "Try again" }).click();
  await expect(s.page.getByTestId("analytics-volume")).toHaveText("≥$27.6K");
  await expect(caption).toHaveText(CAPTION);
  assert.deepEqual(s.errors.filter((text) => !/503/.test(text)), []);
});

test("a failure that arrives after a press moves no control either, and Try again brings the figures into the same places", async (t) => {
  for (const size of [DESKTOP, { width: 1440, height: 900 }, { width: 1024, height: 800 }, PHONE, { width: 320, height: 700 }]) {
    const where = `${size.width}x${size.height}`;
    const s = await site(t, { size });
    let failing = true;
    await s.page.route("**/data/daily.json*", async (route) =>
      failing ? route.fulfill({ status: 503, body: "busy" }) : route.continue(),
    );
    await s.goto("?view=analytics");
    await ready(s.page);
    const before = await places(s.page);
    await s.page.locator(`${SWITCH} button[data-span="d7"]`).click();
    await expect(s.page.getByTestId("daily-caption")).toContainText("Could not load 7D and 30D volume.");
    assert.deepEqual(moved(before, await places(s.page)), [], `${where}: the failure moved something`);
    failing = false;
    await s.page.getByTestId("daily-caption").getByRole("button", { name: "Try again" }).click();
    await expect(s.page.getByTestId("analytics-volume")).toHaveText("≥$27.6K");
    assert.deepEqual(moved(before, await places(s.page)), [], `${where}: Try again moved something`);
    assert.deepEqual(s.errors.filter((text) => !/503/.test(text)), []);
  }
});

test("a file of another run is accepted; a daily pool this snapshot has no measurement for is counted and left out, and said in the tooltip", async (t) => {
  const file = structuredClone(variant.daily);
  file.snapshotGeneratedAt = new Date(generated - 60 * MINUTE).toISOString();
  file.pools.push({
    id: `ethereum:0x${"9".padStart(64, "0")}`,
    v7: 9,
    v30: 9,
    at: "2026-10-28T00:20:00.000Z",
  });
  file.pools.sort((a, b) => (a.id < b.id ? -1 : 1));
  const s = await site(t, { file });
  await s.goto("?view=analytics&window=d7");
  await ready(s.page);
  assert.equal(await tileText(s.page, "analytics-volume"), "≥$27.6K", "the extra pool adds nothing");
  assert.match(
    (await s.page.getByTestId("analytics-volume").getAttribute("title")) ?? "",
    /1 more pool with daily data is not in this snapshot's current measurements and is left out\./,
  );
  await expect(s.page.locator(".analytics-metric").first()).toContainText("7 of 8 pools");
  s.verify();
});

/* ── The full analytics ──────────────────────────────────────────────────── */

test("Open full analytics with a span: the tile, the ranked hooks, a 7D column with its sort, a dash for an uncovered pool, a young pool, and the project drawer agrees", async (t) => {
  const s = await site(t, { size: { width: 1440, height: 1100 } });
  await s.goto("?view=analytics&window=d7");
  await ready(s.page);
  await s.page.getByRole("button", { name: /Explore pools/ }).first().click();
  await expect(s.page.locator("#analytics-pools")).toBeVisible({ timeout: 60000 });
  assert.equal(s.dailyRequests().length, 1, "the file is not read again");
  assert.equal(s.snapshotRequests().length, 1);
  await expect(s.page.getByTestId("analytics-volume")).toHaveText("≥$27.6K");
  assert.deepEqual(await pressed(s.page), ["7D"]);
  assert.equal(search(s.page), "?view=analytics&window=d7");
  // The ranked hooks: a project's figure is the sum of its covered pools.
  const hooks = s.page.locator("#analytics-hooks");
  await expect(hooks).toContainText("Tracked 7D hook-pool volume, largest pools only");
  const alpha = hooks.locator("li", { hasText: "Alpha Markets" });
  await expect(alpha.locator(".analytics-project-value strong")).toHaveText("≥$25.0K");
  await expect(alpha).toContainText("3 of 3 pools covered");
  const delta = hooks.locator("li", { hasText: "Delta Oracle" });
  await expect(delta.locator(".analytics-project-value strong")).toHaveText("—");
  const values = await hooks.locator(".analytics-project-value strong").allInnerTexts();
  assert.ok(values.every((text) => /^(≥\$|—$)/.test(text)), `every ranked figure is a lower bound or a dash: ${values}`);
  const dashAt = values.indexOf("—");
  assert.ok(dashAt === -1 || values.slice(dashAt).every((text) => text === "—"), "a dash sorts last");
  // The pool table: a 7D column next to the 24H one, sorted by it.
  const table = s.page.locator(".analytics-pool-table");
  await table.scrollIntoViewIfNeeded();
  await expect(table.locator("thead")).toContainText("7D volume");
  await expect(table.locator("thead")).toContainText("Tracked 24H volume");
  await expect(table.locator('thead th[aria-sort="descending"]')).toContainText("7D volume");
  const rows = table.locator("tbody tr");
  await expect(rows.first()).toContainText("ETH / ALPHA");
  await expect(rows.first().locator('td[data-label="7D volume"]')).toContainText("$20.0K");
  await expect(rows.first().locator('td[data-label="7D volume"]')).toContainText("through 27 Oct");
  assert.doesNotMatch(await rows.first().locator('td[data-label="7D volume"]').innerText(), /≥/, "a pool's figure is exact for its days");
  // A real zero is a zero; an uncovered pool is a dash with its reason.
  const zero = table.locator("tbody tr", { hasText: "WBTC / ALPHA" });
  await expect(zero.locator('td[data-label="7D volume"]')).toContainText("$0");
  const uncovered = table.locator("tbody tr", { hasText: "ETH / DELTA" });
  await expect(uncovered.locator('td[data-label="7D volume"] .daily-figure')).toHaveAttribute("title", NOT_COVERED);
  await expect(uncovered.locator('td[data-label="7D volume"]')).not.toContainText("$");
  // A young pool whose 24H volume is more than its 7D says why: one day of data.
  const young = table.locator("tbody tr", { hasText: "ETH / FRONT" });
  await expect(young.locator('td[data-label="7D volume"]')).toContainText("since launch · 1 day");
  await expect(young.locator('td[data-label="7D volume"]')).toContainText("$250.00");
  await expect(young).toContainText("$300.00");
  // Sorting by the column flips; uncovered pools stay last either way.
  await table.getByRole("button", { name: "Sort pools by 7d volume" }).click();
  await expect(table.locator('thead th[aria-sort="ascending"]')).toContainText("7D volume");
  const ascending = await table.locator('tbody td[data-label="7D volume"]').allInnerTexts();
  assert.ok(ascending.at(-1).startsWith("—") || /\$/.test(ascending.at(-1)));
  await table.getByRole("button", { name: "Sort pools by 7d volume" }).click();
  // The scatter, the readouts and the evidence say 24H.
  await expect(s.page.locator("#analytics-pools")).toContainText("Tracked 24H volume");
  await expect(s.page.locator(".analytics-evidence")).toContainText("24H totals use only pools measured within five minutes of the snapshot; 7D and 30D add up completed days.");
  // The project drawer shows the same 7D figure as the table and the ranking.
  await alpha.getByRole("button", { name: "Open Alpha Markets project" }).click();
  const drawer = s.page.locator(".project-detail");
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText("≥$25.0K");
  await s.page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  assert.deepEqual(await pressed(s.page), ["7D"], "the span survives closing the drawer");
  assert.equal(await tileText(s.page, "analytics-volume"), "≥$27.6K");
  s.verify();
});

test("the full analytics: the CSV carries the span in five columns; without a span the header is as before; the share dialog names the five windows", async (t) => {
  const s = await site(t);
  await s.goto("?view=analytics&window=d7");
  await ready(s.page);
  await s.page.getByRole("button", { name: /Explore pools/ }).first().click();
  await expect(s.page.locator("#analytics-pools")).toBeVisible({ timeout: 60000 });
  const exportButton = s.page.getByRole("button", { name: "Export analytics CSV" });
  await expect(exportButton).toHaveAttribute("title", /and the 7D figures of the largest pools$/);
  const [download] = await Promise.all([s.page.waitForEvent("download"), exportButton.click()]);
  assert.match(download.suggestedFilename(), /^hook-radar-analytics-all-h24-d7-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = readFileSync(await download.path(), "utf8").replace(/^﻿/, "");
  const lines = csv.split("\r\n").filter(Boolean).map((line) => line.slice(1, -1).split('","'));
  const head = lines[0];
  assert.deepEqual(head.slice(-5), ["span_window", "span_through", "span_volume_usd", "span_basis", "span_covered_pools"]);
  const cell = (row, name) => row[head.indexOf(name)];
  const summary = lines.find((row) => row[0] === "summary");
  assert.deepEqual(
    ["span_window", "span_through", "span_volume_usd", "span_basis", "span_covered_pools"].map((name) => cell(summary, name)),
    ["7D", "2026-10-27", "27650", "at_least", "7"],
  );
  const pools = lines.filter((row) => row[0] === "pool");
  assert.equal(pools.filter((row) => cell(row, "span_basis") === "exact").length, 7);
  assert.ok(pools.filter((row) => cell(row, "span_basis") === "").every((row) => cell(row, "span_volume_usd") === ""));
  // Without a span: the header is the edition's own, with nothing added.
  await s.page.locator(SWITCH).getByRole("button", { name: "24H" }).click();
  const [plainDownload] = await Promise.all([s.page.waitForEvent("download"), exportButton.click()]);
  assert.match(plainDownload.suggestedFilename(), /^hook-radar-analytics-all-h24-\d{4}-\d{2}-\d{2}\.csv$/);
  const plain = readFileSync(await plainDownload.path(), "utf8");
  assert.doesNotMatch(plain.split("\r\n")[0], /span_/);
  assert.equal(
    plain.replace(/^﻿/, "").split("\r\n")[0].split('","').length,
    head.length - 5,
  );
  await expect(exportButton).toHaveAttribute("title", "Export current market measurements and network inventory (original measurement clocks)");
  // The share dialog.
  await s.page.getByTestId("share-button").click();
  await expect(s.page.locator(".modal-body .intro-copy")).toHaveText(
    "Share the selected network, volume window (1H, 6H, 24H, 7D or 30D) and history range. Export the measured dataset from the analytics view.",
  );
  s.verify();
});

test("the full analytics while the file loads: ellipses where the figures will be, then the figures; the 24H panels never wear the 7D label", async (t) => {
  const s = await site(t, { size: { width: 1440, height: 1100 } });
  await s.goto("?view=analytics");
  await ready(s.page);
  await s.page.getByRole("button", { name: /Explore pools/ }).first().click();
  await expect(s.page.locator("#analytics-pools")).toBeVisible({ timeout: 60000 });
  let release;
  const held = new Promise((resolve) => (release = resolve));
  await s.page.route("**/data/daily.json*", async (route) => {
    await held;
    await route.continue();
  });
  await s.page.locator(`${SWITCH} button[data-span="d7"]`).click();
  await expect(s.page.getByTestId("analytics-volume")).toHaveText("…");
  await expect(s.page.getByTestId("daily-status")).toHaveText("Loading 7D volume");
  const table = s.page.locator(".analytics-pool-table");
  await expect(table.locator('tbody td[data-label="7D volume"] .daily-pending').first()).toBeVisible();
  // The ranking is the 24H one and says so while the figures load.
  await expect(s.page.locator("#analytics-hooks")).toContainText("Tracked 24H hook-pool volume");
  release();
  await expect(s.page.getByTestId("analytics-volume")).toHaveText("≥$27.6K");
  await expect(s.page.locator("#analytics-hooks")).toContainText("Tracked 7D hook-pool volume, largest pools only");
  s.verify();
});

/* ── Keyboard, targets, accessibility ────────────────────────────────────── */

test("keyboard: Tab reaches 7D, Enter and Space choose, focus stays on the button and shows", async (t) => {
  const s = await site(t);
  await s.goto("?view=analytics");
  await ready(s.page);
  const seven = s.page.locator(`${SWITCH} button[data-span="d7"]`);
  await seven.focus();
  await s.page.keyboard.press("Enter");
  await expect(seven).toHaveAttribute("aria-pressed", "true");
  assert.equal(await s.page.evaluate(() => document.activeElement?.getAttribute("data-span")), "d7");
  await s.page.keyboard.press("Tab");
  assert.equal(await s.page.evaluate(() => document.activeElement?.getAttribute("data-span")), "d30");
  await s.page.keyboard.press("Space");
  await expect(s.page.locator(`${SWITCH} button[data-span="d30"]`)).toHaveAttribute("aria-pressed", "true");
  assert.equal(await s.page.evaluate(() => document.activeElement?.getAttribute("data-span")), "d30", "focus stays");
  const outline = await s.page.locator(`${SWITCH} button[data-span="d30"]`).evaluate((el) => {
    el.blur();
    el.focus({ focusVisible: true });
    const style = getComputedStyle(el);
    return `${style.outlineStyle} ${style.outlineWidth}`;
  });
  assert.doesNotMatch(outline, /^none/, "a visible focus ring");
  // The metric switch and the ribbons are keyboard controls too, under a span.
  await s.page.locator('[data-testid="analytics-composition"] button').first().focus();
  await s.page.keyboard.press("Enter");
  await expect(s.page.locator(".analytics-focus-bar")).toBeVisible();
  await s.page.keyboard.press("Escape");
  await expect(s.page.locator(".analytics-focus-bar")).toHaveCount(0);
  s.verify();
});

for (const size of [DESKTOP, PHONE])
  test(`with a span chosen the Analytics page passes the accessibility rules, ${size.width} px wide, light and full`, async (t) => {
    const s = await site(t, { size });
    await s.goto("?view=analytics&window=d7");
    await ready(s.page);
    await expect(s.page.getByTestId("daily-caption")).toBeVisible();
    const scan = async (where) => {
      const result = await new AxeBuilder({ page: s.page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      assert.deepEqual(
        result.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`),
        [],
        `${where} at ${size.width}px`,
      );
    };
    await scan("Analytics, light");
    await s.page.getByRole("button", { name: /Explore pools/ }).first().click();
    await expect(s.page.locator("#analytics-pools")).toBeVisible({ timeout: 60000 });
    await scan("Analytics, full");
    // Targets: the switch's buttons are 44 px on a phone, every control at least 24.
    const small = await s.page.evaluate((phone) => {
      const bad = [];
      // The controls beside and above the figures: the window switch, Share view,
      // Try again, the metric switch and the command bar's buttons. (The ribbons
      // grow their hit area with a pseudo-element, and a select sits inside its
      // label: both are the design system's own and unchanged.)
      for (const el of document.querySelectorAll(
        ".title-controls button, .analytics-commandbar button",
      )) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (el.closest(".sr-only") || el.classList.contains("sr-only")) continue;
        const floor = phone && el.closest(".title-controls .window-switch") ? 44 : 24;
        if (r.height < floor - 0.5 || (floor === 44 && r.width < floor - 0.5))
          bad.push(`${el.tagName.toLowerCase()} "${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 30)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
      return bad;
    }, size.width <= 480);
    assert.deepEqual(small, [], `touch targets at ${size.width}px`);
    s.verify();
  });

test("the narrowest phone: nothing is wider than the screen, with and without a span", async (t) => {
  for (const query of ["?view=analytics", "?view=analytics&window=d7", "?view=analytics&window=d30&analytics_chain=base"]) {
    const s = await site(t, { size: { width: 320, height: 700 } });
    await s.goto(query);
    await ready(s.page);
    const { scrollWidth, clientWidth } = await s.page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    assert.ok(scrollWidth <= clientWidth, `${query}: ${scrollWidth} > ${clientWidth}`);
    const boxes = await s.page.locator(`${SWITCH} button`).evaluateAll((buttons) =>
      buttons.map((b) => b.getBoundingClientRect()).map((r) => ({ top: Math.round(r.top), right: Math.round(r.right), width: r.width })),
    );
    assert.equal(new Set(boxes.map((box) => box.top)).size, 1, `${query}: one row of buttons`);
    assert.ok(boxes.every((box) => box.right <= 320 && box.width >= 44));
    s.verify();
  }
});

/* ── It agrees with the Networks page ────────────────────────────────────── */

test("the Analytics figures are the figures the Networks page shows: the total, and each network", async (t) => {
  const s = await site(t);
  await s.goto("?view=chains&window=d7");
  await expect(s.page.getByText("Tracked 7D hook-pool volume · largest pools only")).toBeVisible({ timeout: 30000 });
  const text = await s.page.locator("main").innerText();
  assert.match(text, /TRACKED 7D VOLUME\s*\n\s*≥\$27\.6K/i, "the Networks page's total");
  // Base, Ethereum, Robinhood: the bars of the comparison.
  const bars = Object.fromEntries(
    [...text.matchAll(/\n(Base|Ethereum|Robinhood)\n(≥\$[\d.,]+[KMB]?)\n/g)].map((m) => [m[1], m[2]]),
  );
  assert.deepEqual(bars, { Base: "≥$26.6K", Ethereum: "≥$800.00", Robinhood: "≥$250.00" });
  // The same figures on the Analytics page, scope by scope.
  await s.goto("?view=analytics&window=d7");
  await ready(s.page);
  assert.equal(await tileText(s.page, "analytics-volume"), "≥$27.6K");
  for (const [slug, name] of [["base", "Base"], ["ethereum", "Ethereum"], ["robinhood", "Robinhood"]]) {
    await s.page.locator(".analytics-network-select select").selectOption(slug);
    await expect(s.page.getByTestId("analytics-volume")).toHaveText(bars[name]);
  }
  s.verify();
});
