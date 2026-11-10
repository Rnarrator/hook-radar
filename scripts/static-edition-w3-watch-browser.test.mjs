// The watchlist feed, the Compare tray and the not-carried notices of the Auto
// Snapshot edition, in a real browser (the fixes of the re-audit of 28 October
// 2026). It builds nothing: point it at an edition build (VITE_STATIC_EDITION=1)
// with RADAR_TEST_DIST. By default the data is the deterministic TEST data in
// tests/fixtures/static-data/data; RADAR_TEST_DATA names another data folder (the
// real collector output, say) and every expectation is then derived from that
// folder's own snapshot.json, so the same checks run on either. The server
// (scripts/static-edition-server.mjs) answers every /api path with 404 and
// records every request. No production data, no network, no service.
//
//   RADAR_TEST_DIST=<edition build> node --test scripts/static-edition-w3-watch-browser.test.mjs
//   RADAR_TEST_DIST=<build> RADAR_TEST_DATA=<real data folder> \
//     node --test scripts/static-edition-w3-watch-browser.test.mjs
//
// What it covers:
//  1. A page served over plain http has no crypto.subtle and no
//     crypto.randomUUID (an init script removes both from Crypto.prototype, as
//     such a browser reports them): the Watchlist feed still compares the saved
//     projects, shows the change and has no Retry that can never succeed, and a
//     saved filter can be created.
//  2. Mark read hands the keyboard focus to the panel's heading, by key and by
//     click, instead of dropping it to the page.
//  3. The phone tray never puts Clear over its label (414, 390 and 360 px), and
//     Forget and Remove are 44 px targets on a phone.
//  4. Compare's "Where these comparisons come from" describes what the
//     snapshot shows.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { startStaticEditionServer } from "./static-edition-server.mjs";
import { watchBaseline, WATCH_CHANGES_KEY } from "../src/watch-changes.ts";
import { SAVED_FILTERS_KEY } from "../src/discovery.ts";

const DIST = resolve(process.env.RADAR_TEST_DIST || "dist");
const DATA = resolve(
  process.env.RADAR_TEST_DATA || "tests/fixtures/static-data/data",
);
const SIZES = {
  desktop: { width: 1440, height: 1000 },
  phone: { width: 390, height: 844 },
};
const MINUTE = 60_000;
const WATCH_KEY = "hook-radar-watchlist-v1";
const IDENTIFIER = /^[a-z0-9][a-z0-9-]{0,99}$/;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const snapshot = JSON.parse(
  readFileSync(resolve(DATA, "snapshot.json"), "utf8"),
);
const generated = Date.parse(snapshot.generatedAt);
// Hooks a visitor can compare: not a platform, and an id a link can carry.
const comparable = snapshot.projects.filter(
  (project) => project.entityType !== "platform" && IDENTIFIER.test(project.id),
);
const withHooks = snapshot.projects.filter((row) => row.deployments.length > 0);
assert.ok(comparable.length >= 2, "the data holds two comparable projects");
assert.ok(withHooks.length >= 2, "the data holds two projects with hooks");

const html = readFileSync(resolve(DIST, "index.html"), "utf8");
const entry =
  html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/)?.[1] ?? "";
const MOUNT =
  process.env.RADAR_TEST_MOUNT ||
  (entry.startsWith("./") ? "/" : entry.replace(/assets\/[^/]+$/, "") || "/");

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

/** Two saved projects with a stored comparison point from the snapshot before
 * this one: the first had one hook fewer then (a change), the second did not
 * differ. The hashes are the ones crypto.subtle gives, so a page that hashes
 * another way must still agree with them. */
async function storedComparison() {
  const day = new Date(generated);
  const previous = Date.UTC(
    day.getUTCFullYear(),
    day.getUTCMonth(),
    day.getUTCDate() - 1,
    18,
    30,
  );
  const [a, b] = withHooks;
  const baselines = [];
  for (const row of [a, b]) {
    const old = await watchBaseline(
      row,
      new Date(previous).toISOString(),
      new Date(previous + MINUTE).toISOString(),
    );
    if (row === a) {
      old.hooks = "0".repeat(64);
      old.hookCount = Math.max(0, old.hookCount - 1);
    }
    baselines.push(old);
  }
  return {
    ids: [a.id, b.id],
    names: [a.name, b.name],
    state: JSON.stringify({ version: 1, baselines, changes: [], readAt: null }),
  };
}

/** A page of the edition with the visitor's clock fixed just after the
 * snapshot, the saved projects (and the stored comparison point) in place
 * before the page first runs, and watchers that turn every console error, page
 * error and service request into a failure. `plainHttp` removes what a browser
 * offers only on a secure origin. */
async function site(
  t,
  {
    size = SIZES.desktop,
    saved = null,
    state = null,
    plainHttp = false,
    path = "",
  } = {},
) {
  const server = await startStaticEditionServer({
    distDir: DIST,
    dataDir: DATA,
    mount: MOUNT,
  });
  const context = await browser.newContext({
    viewport: size,
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "UTC",
  });
  await context.clock.setFixedTime(generated + 2 * MINUTE);
  if (plainHttp)
    await context.addInitScript(() => {
      Object.defineProperty(Crypto.prototype, "subtle", {
        get: () => undefined,
        configurable: true,
      });
      Object.defineProperty(Crypto.prototype, "randomUUID", {
        value: undefined,
        writable: true,
        configurable: true,
      });
    });
  await context.addInitScript(
    ([watchKey, changesKey, ids, stored]) => {
      if (sessionStorage.getItem("test-seeded")) return;
      sessionStorage.setItem("test-seeded", "1");
      if (ids) localStorage.setItem(watchKey, JSON.stringify(ids));
      if (stored) localStorage.setItem(changesKey, stored);
    },
    [WATCH_KEY, WATCH_CHANGES_KEY, saved, state],
  );
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
  await page.goto(`${server.url}${path}`);
  return {
    page,
    server,
    errors,
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

const noSideScroll = (page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth <=
      document.documentElement.clientWidth + 1,
  );
const box = (locator) =>
  locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      left: r.left,
      right: r.right,
      top: r.top,
      bottom: r.bottom,
      height: r.height,
    };
  });
const overlap = (a, b) =>
  Math.min(a.right, b.right) > Math.max(a.left, b.left) + 0.5 &&
  Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top) + 0.5;

/* ── 1. Plain http: no crypto.subtle, no crypto.randomUUID ─────────────── */

for (const [name, size] of Object.entries(SIZES))
  test(`${name}: with no crypto.subtle the Watchlist feed compares the saved projects and shows no dead Retry`, async (t) => {
    const data = await storedComparison();
    const s = await site(t, {
      size,
      saved: data.ids,
      state: data.state,
      plainHttp: true,
      path: "?view=watchlist",
    });
    const panel = s.page.locator(".watch-updates");
    await expect(panel).toBeVisible({ timeout: 30000 });
    // The browser reports what a non-secure origin does.
    assert.deepEqual(
      await s.page.evaluate(() => [
        typeof crypto.subtle,
        typeof crypto.randomUUID,
      ]),
      ["undefined", "undefined"],
      "the page has neither crypto.subtle nor crypto.randomUUID",
    );
    await expect(panel.locator("footer")).toContainText(
      "2 of 2 saved projects tracked",
      { timeout: 30000 },
    );
    await expect(panel.locator("footer")).toContainText(
      "Compared with the snapshot taken",
    );
    // One change: the project whose hook list differed. The other project's
    // stored hashes were made with crypto.subtle, so a page that hashed to
    // anything else would have shown it as changed as well.
    const rows = panel.locator(".watch-change-list > li");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Hook list");
    await expect(rows.first()).toContainText(data.names[0]);
    const text = await panel.innerText();
    assert.doesNotMatch(
      text,
      /could not be checked|temporarily unavailable|took too long/i,
    );
    await expect(panel.locator(".watch-update-error")).toHaveCount(0);
    await expect(panel.getByRole("button", { name: /Retry/ })).toHaveCount(0);
    const stored = await s.page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)),
      WATCH_CHANGES_KEY,
    );
    assert.equal(stored.baselines.length, 2);
    for (const baseline of stored.baselines)
      for (const key of ["hooks", "properties", "metadata"])
        assert.match(baseline[key], /^[a-f0-9]{64}$/);
    assert.match(stored.changes[0].id, /^[a-f0-9]{64}$/);
    assert.equal(await noSideScroll(s.page), true, "no horizontal scroll");
    s.verify();
    if (process.env.RADAR_TEST_SHOTS)
      await s.page.screenshot({
        path: resolve(
          process.env.RADAR_TEST_SHOTS,
          `w3-plain-http-${name}.png`,
        ),
      });
  });

for (const [name, size] of Object.entries(SIZES))
  test(`${name}: with no crypto.randomUUID a saved filter can be created`, async (t) => {
    const s = await site(t, { size, plainHttp: true });
    const trigger = s.page.locator(".saved-filters-trigger");
    await expect(trigger).toBeVisible({ timeout: 30000 });
    assert.equal(
      await s.page.evaluate(() => typeof crypto.randomUUID),
      "undefined",
    );
    await trigger.click();
    const panel = s.page.getByRole("region", { name: "Saved filters" });
    await expect(panel).toBeVisible();
    await panel.getByPlaceholder("Name this view").fill("Plain http view");
    await panel.getByRole("button", { name: "Save filters" }).click();
    await expect(panel.locator(".saved-filter-error")).toHaveCount(0);
    await expect(panel.locator(".saved-filter-list li")).toHaveCount(1);
    await expect(panel.locator(".saved-filter-list li")).toContainText(
      "Plain http view",
    );
    const views = await s.page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)).views,
      SAVED_FILTERS_KEY,
    );
    assert.equal(views.length, 1);
    assert.match(views[0].id, UUID_V4);
    s.verify();
  });

/* ── 2. Mark read keeps the focus on the page ──────────────────────────── */

for (const [how, name] of [
  ["keyboard", "desktop"],
  ["click", "desktop"],
  ["click", "phone"],
])
  test(`${name}: Mark read by ${how} moves focus to the panel heading, not to the page`, async (t) => {
    const data = await storedComparison();
    const s = await site(t, {
      size: SIZES[name],
      saved: data.ids,
      state: data.state,
      path: "?view=watchlist",
    });
    const panel = s.page.locator(".watch-updates");
    const mark = panel.getByRole("button", { name: "Mark read" });
    await expect(mark).toBeVisible({ timeout: 30000 });
    await expect(panel.locator(".watch-unread")).toContainText("1 new");
    if (how === "keyboard") {
      await mark.focus();
      assert.equal(
        await s.page.evaluate(() =>
          document.activeElement?.textContent?.trim(),
        ),
        "Mark read",
        "the button holds the focus before",
      );
      await s.page.keyboard.press("Enter");
    } else await mark.click();
    await expect(panel.getByRole("button", { name: "Mark read" })).toHaveCount(
      0,
    );
    await expect(panel.locator(".watch-unread")).toHaveCount(0);
    const active = await s.page.evaluate(() => ({
      id: document.activeElement?.id ?? "",
      tag: document.activeElement?.tagName ?? "",
      inPanel: !!document.activeElement?.closest(".watch-updates"),
    }));
    assert.deepEqual(active, {
      id: "watch-updates-heading",
      tag: "H2",
      inPanel: true,
    });
    assert.equal(
      await s.page.evaluate(() =>
        document.getElementById("watch-updates-heading")?.textContent?.trim(),
      ),
      "What changed",
    );
    // Reading is stored: the next visit shows nothing new.
    const stored = await s.page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)),
      WATCH_CHANGES_KEY,
    );
    assert.ok(stored.readAt, "the read time is stored");
    assert.equal(await noSideScroll(s.page), true, "no horizontal scroll");
    s.verify();
    if (process.env.RADAR_TEST_SHOTS)
      await s.page.screenshot({
        path: resolve(
          process.env.RADAR_TEST_SHOTS,
          `w3-mark-read-${how}-${name}.png`,
        ),
      });
  });

/* ── 3. The phone tray and the notice buttons ──────────────────────────── */

async function addTwoToComparison(s) {
  for (let i = 0; i < 2; i++) {
    const add = s.page
      .getByRole("button", { name: /^Add .+ to comparison$/ })
      .first();
    await expect(add).toBeVisible({ timeout: 30000 });
    await add.scrollIntoViewIfNeeded();
    await add.click();
    await expect(s.page.locator(".compare-tray")).toContainText(
      `${i + 1} selected`,
    );
  }
}

for (const [width, height] of [
  [1440, 1000],
  [440, 932],
  [430, 932],
  [428, 926],
  [414, 896],
  [413, 896],
  [412, 915],
  [390, 844],
  [375, 812],
  [360, 740],
  [320, 640],
])
  test(`${width}px: the selection tray keeps its label clear of Clear and fits the screen`, async (t) => {
    const s = await site(t, { size: { width, height } });
    await addTwoToComparison(s);
    const tray = s.page.locator(".compare-tray");
    await expect(tray).toBeVisible();
    const label = tray.locator("strong");
    const clear = tray.getByRole("button", { name: "Clear" });
    const compare = tray.getByRole("button", { name: /Compare projects/ });
    assert.equal((await label.innerText()).trim(), "2 selected");
    const [l, c, p, t0] = await Promise.all([
      box(label),
      box(clear),
      box(compare),
      box(tray),
    ]);
    assert.equal(
      overlap(l, c),
      false,
      `the label ${JSON.stringify(l)} and Clear ${JSON.stringify(c)} overlap`,
    );
    assert.equal(
      overlap(l, p),
      false,
      "the label and Compare projects overlap",
    );
    assert.equal(overlap(c, p), false, "Clear and Compare projects overlap");
    // Everything lies inside the tray, and the tray inside the screen.
    for (const part of [l, c, p]) {
      assert.ok(
        part.left >= t0.left - 0.5 && part.right <= t0.right + 0.5,
        "inside the tray",
      );
      assert.ok(
        part.top >= t0.top - 0.5 && part.bottom <= t0.bottom + 0.5,
        "inside the tray",
      );
    }
    assert.ok(
      t0.left >= 0 && t0.right <= width,
      "the tray is inside the screen",
    );
    // The label is not cut off: its box is as wide as its text needs.
    assert.equal(
      await label.evaluate(
        (el) =>
          el.parentElement.scrollWidth <= el.parentElement.clientWidth + 1,
      ),
      true,
      "the label's box holds its text",
    );
    assert.equal(
      await compare.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      true,
      "Compare projects is not cut off",
    );
    // One row where it fits (413px and wider), two below that.
    if (width >= 413)
      assert.ok(
        Math.abs((l.top + l.bottom) / 2 - (c.top + c.bottom) / 2) < 12,
        "one row, as before",
      );
    else
      assert.ok(
        l.bottom <= c.top + 1,
        "the label has a row of its own above the buttons",
      );
    if (width <= 430)
      assert.ok(
        c.height >= 43.5 && p.height >= 43.5,
        "44px buttons on a phone",
      );
    assert.equal(await noSideScroll(s.page), true, "no horizontal scroll");
    s.verify();
    if (process.env.RADAR_TEST_SHOTS)
      await s.page.screenshot({
        path: resolve(process.env.RADAR_TEST_SHOTS, `w3-tray-${width}.png`),
      });
  });

test("the toast stays clear of the phone tray", async (t) => {
  const s = await site(t, { size: { width: 390, height: 844 } });
  await addTwoToComparison(s);
  // The tray is the fixed element over the page; the toast, which appears
  // above everything, has to start above its top edge.
  const toastBottom = await s.page.evaluate(() => {
    const toast = document.createElement("div");
    toast.className = "toast";
    document.body.append(toast);
    const bottom = getComputedStyle(toast).bottom;
    toast.remove();
    return parseFloat(bottom);
  });
  const tray = await box(s.page.locator(".compare-tray"));
  const trayTop = s.page.viewportSize().height - tray.top;
  assert.ok(
    toastBottom >= trayTop,
    `the toast starts ${toastBottom}px from the bottom, the tray reaches ${trayTop}px`,
  );
  s.verify();
});

test("phone: Forget in the watchlist notice is a 44px target; on a desktop it keeps its size", async (t) => {
  const carried = withHooks[0].id;
  for (const [name, size] of Object.entries(SIZES)) {
    const s = await site(t, {
      size,
      saved: [carried, "hook-0123456789abcdef0123"],
      path: "?view=watchlist",
    });
    const forget = s.page.getByRole("button", { name: /^Forget / });
    await expect(forget).toBeVisible({ timeout: 30000 });
    const b = await box(forget);
    if (name === "phone")
      assert.ok(b.height >= 43.5, `Forget is ${b.height}px high on a phone`);
    else assert.ok(b.height < 40, `Forget is ${b.height}px high on a desktop`);
    // Still a row of its own: the id, then its button, inside the notice.
    const notice = s.page.locator(".comparison-not-carried");
    const n = await box(notice);
    assert.ok(b.left >= n.left && b.right <= n.right, "inside the notice");
    assert.equal(
      await noSideScroll(s.page),
      true,
      `${name}: no horizontal scroll`,
    );
    s.verify();
    if (process.env.RADAR_TEST_SHOTS)
      await s.page.screenshot({
        path: resolve(process.env.RADAR_TEST_SHOTS, `w3-forget-${name}.png`),
      });
  }
});

test("phone: Remove in the Compare notice is a 44px target; on a desktop it keeps its size", async (t) => {
  const [first] = comparable;
  for (const [name, size] of Object.entries(SIZES)) {
    const s = await site(t, {
      size,
      path: `?view=compare&compare=${first.id},hook-0000000000000000zzzz`,
    });
    await expect(s.page.getByTestId("hook-comparison")).toBeVisible({
      timeout: 30000,
    });
    const remove = s.page.getByRole("button", {
      name: /^Remove hook-0000000000000000zzzz from this link/,
    });
    await expect(remove).toBeVisible();
    const b = await box(remove);
    if (name === "phone")
      assert.ok(b.height >= 43.5, `Remove is ${b.height}px high on a phone`);
    else assert.ok(b.height < 40, `Remove is ${b.height}px high on a desktop`);
    // The id and its button stay one row: on a phone the id's box is as tall
    // as the 44px button (tops level), on a desktop it is centred beside the
    // smaller one.
    const id = await box(s.page.locator(".comparison-not-carried li code"));
    const apart = Math.abs(id.top - b.top);
    if (name === "phone")
      assert.ok(apart < 1, `the id starts ${apart}px from its button's top`);
    else assert.ok(apart < 12, `the id is ${apart}px from its button's top`);
    assert.equal(
      await noSideScroll(s.page),
      true,
      `${name}: no horizontal scroll`,
    );
    s.verify();
    if (process.env.RADAR_TEST_SHOTS)
      await s.page.screenshot({
        path: resolve(process.env.RADAR_TEST_SHOTS, `w3-remove-${name}.png`),
      });
  }
});

/* ── 4. What Compare says about where its numbers come from ────────────── */

for (const [name, size] of Object.entries(SIZES))
  test(`${name}: Compare says its pool counts are the pools measured in this snapshot, with a UTC time`, async (t) => {
    const [a, b] = comparable;
    const s = await site(t, {
      size,
      path: `?view=compare&compare=${a.id},${b.id}`,
    });
    await expect(s.page.getByTestId("hook-comparison")).toBeVisible({
      timeout: 30000,
    });
    const note = s.page.locator(".comparison-methodology");
    await note.locator("summary").click();
    const text = (await note.innerText()).replace(/\s+/g, " ");
    assert.match(
      text,
      /Pool counts are the pools measured in this snapshot \(an observed sample, labelled as such\)\. Neither pool counts nor contract counts measure adoption\./,
    );
    assert.match(
      text,
      /Each cell shows its contributing pools, source and the UTC time of its oldest measurement\./,
    );
    assert.doesNotMatch(text, /initialization events|original measurement age/);
    // What the note says is what the cells show: a count labelled as a sample
    // and an absolute UTC time, never an age.
    const table = s.page.locator('[aria-label="Hook project comparison"]');
    const body = (await table.innerText()).replace(/\s+/g, " ");
    assert.match(body, /Observed sample/);
    assert.doesNotMatch(body, /\bago\b/);
    assert.equal(await noSideScroll(s.page), true, "no horizontal scroll");
    s.verify();
    if (process.env.RADAR_TEST_SHOTS)
      await s.page.screenshot({
        path: resolve(
          process.env.RADAR_TEST_SHOTS,
          `w3-methodology-${name}.png`,
        ),
        fullPage: true,
      });
  });
