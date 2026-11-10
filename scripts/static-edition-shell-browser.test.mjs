// The Auto Snapshot edition's app shell in a real browser: saved projects the
// snapshot does not carry, links that name projects it lacks, the time each page
// is judged at, files from two runs, an unknown network, and what a failed or
// stalled load says. The helpers they rest on are in
// tests/edition-app-shell.test.mjs.
//
// Like the other static-edition browser checks it builds nothing: point it at an
// edition build (VITE_STATIC_EDITION=1) with RADAR_TEST_DIST. By default the data
// is the deterministic TEST data in tests/fixtures/static-data/data;
// RADAR_TEST_DATA names another data folder (the real collector output, say) and
// every expectation is then derived from that folder's own files, so the same
// checks run on either. The server (scripts/static-edition-server.mjs) answers
// every /api path with 404 and records every request. No production data, no
// network, no service.
//
//   RADAR_TEST_DIST=dist/test-build \
//     node --test scripts/static-edition-shell-browser.test.mjs
//   RADAR_TEST_DIST=<build> RADAR_TEST_DATA=<real data folder> \
//     node --test scripts/static-edition-shell-browser.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import test, { after, before } from "node:test";
import { chromium, expect } from "@playwright/test";
import { startStaticEditionServer } from "./static-edition-server.mjs";
import { fullTimeLabel } from "../src/edition.ts";
import {
  NOT_PUBLISHED_TITLE,
  PUBLISHING_NOTE,
  SAVED_NONE_IN_SNAPSHOT,
  snapshotFailureMessage,
} from "../src/edition-shell.ts";

const DIST = resolve(process.env.RADAR_TEST_DIST || "dist");
const DATA = resolve(
  process.env.RADAR_TEST_DATA || "tests/fixtures/static-data/data",
);
const builtPage = readFileSync(resolve(DIST, "index.html"), "utf8");
if (!/<html[^>]*\sdata-edition="snapshot"/.test(builtPage))
  throw new Error(
    `${DIST} is not an edition build: its index.html has no data-edition="snapshot" on the root element. Build with VITE_STATIC_EDITION=1 and name it in RADAR_TEST_DIST.`,
  );

const DESKTOP = { width: 1440, height: 1000 };
const PHONE = { width: 390, height: 844 };
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SAVED = "hook-radar-watchlist-v1";
const NAMES = "hook-radar-watchlist-names-v1";

const read = (name) => readFileSync(resolve(DATA, name), "utf8");
const snapshotText = read("snapshot.json");
const snapshot = JSON.parse(snapshotText);
const generated = Date.parse(snapshot.generatedAt);
const IDENTIFIER = /^[a-z0-9][a-z0-9-]{0,99}$/;
// Projects a visitor can save and compare: hooks of their own with an id a link
// can carry.
const carried = snapshot.projects.filter(
  (project) =>
    project.entityType !== "platform" &&
    project.deployments.length > 0 &&
    IDENTIFIER.test(project.id),
);
const [first, second] = carried;
const GONE = "gone-project";
const GONE_TOO = "also-gone";
assert(first && second, "the data has two projects a visitor can save");
assert(!snapshot.projects.some((p) => p.id === GONE || p.id === GONE_TOO));

/** Every ISO time inside a JSON text moved by `ms`: another run of the same data. */
const shiftTimes = (text, ms) =>
  text.replace(
    /"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)"/g,
    (_, time) => `"${new Date(Date.parse(time) + ms).toISOString()}"`,
  );
const generatedOf = (text) => JSON.parse(text).generatedAt;
const overviewAt = (text) => JSON.parse(text).publication.generatedAt;

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

/** The build served next to the data. `data` replaces named data files (null:
 * not found); `saved` and `names` seed the browser's storage; `clock` is
 * "fixed" (the visitor's clock stands still at `at`) or "install" (it runs and
 * the test moves it); `allow` names console errors a test expects. */
async function site(
  t,
  {
    size = DESKTOP,
    data = {},
    saved = null,
    names = null,
    clock = "fixed",
    at = generated + 2 * MINUTE,
    allow = () => false,
    origin = null,
  } = {},
) {
  const server = await startStaticEditionServer({
    distDir: DIST,
    dataDir: DATA,
    mount: "/",
  });
  for (const [name, body] of Object.entries(data)) server.setData(name, body);
  const base = origin ? await origin(server) : server;
  const context = await browser.newContext({
    viewport: size,
    reducedMotion: "reduce",
    ...(size.width < 600 ? { hasTouch: true, isMobile: true } : {}),
  });
  if (clock === "fixed") await context.clock.setFixedTime(at);
  else await context.clock.install({ time: at });
  // Seeded before the page starts, once: a reload keeps what the page wrote.
  const seed = [];
  if (saved) seed.push([SAVED, JSON.stringify(saved)]);
  if (names) seed.push([NAMES, JSON.stringify(names)]);
  if (seed.length)
    await context.addInitScript((entries) => {
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      for (const [key, value] of entries) localStorage.setItem(key, value);
    }, seed);
  const page = await context.newPage();
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !allow(message))
      errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  t.after(async () => {
    await context.close();
    await base.close?.();
    await server.close();
  });
  const stored = (key) =>
    page.evaluate((k) => JSON.parse(localStorage.getItem(k) || "null"), key);
  return {
    page,
    context,
    server,
    url: base.url ?? server.url,
    stored,
    errors,
    ready: async () => {
      await expect(page.getByTestId("snapshot-line")).toBeVisible({
        timeout: 60000,
      });
      await page.waitForTimeout(400);
    },
    goto: (query = "") => page.goto(`${base.url ?? server.url}${query}`),
    asks: (name) =>
      server.requests.filter((row) => row.path.endsWith(`/data/${name}`)),
    /** The page asked no service and threw nothing. */
    verify() {
      assert.deepEqual(errors, [], "console and page errors");
      assert.deepEqual(server.apiRequests(), [], "requests to /api");
    },
  };
}

const main = (page) => page.getByRole("main");
// The stats band is collapsed by default, so read its text, not what is shown.
const stats = (page) =>
  page.locator("#ecosystem-stats").evaluate((el) => el.textContent || "");
const activeText = (page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    return el ? (el.textContent || "").trim().replace(/\s+/g, " ") : "";
  });
const noSideScroll = (page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth <=
      document.documentElement.clientWidth + 1,
  );
const BANNED = /data service|cooling down|saved data is verified/i;

/* ── Saved projects ────────────────────────────────────────────────────── */

for (const [sizeName, size] of Object.entries({
  desktop: DESKTOP,
  phone: PHONE,
}))
  test(`[${sizeName}] a saved project the snapshot does not carry stays saved after a reload, a drawer, Back and every click but Forget`, async (t) => {
    const s = await site(t, { size, saved: [first.id, GONE] });
    await s.goto("?view=watchlist");
    await s.ready();
    const notice = s.page.locator(".orphan-notice");
    await expect(notice).toContainText(
      "1 saved project is not in this snapshot. It stays saved and will show again when a snapshot includes it.",
    );
    // It names the entry, and offers no bulk removal.
    await expect(notice).toContainText(GONE);
    await expect(
      s.page.getByRole("button", { name: `Forget ${GONE}` }),
    ).toBeVisible();
    await expect(
      s.page.getByRole("button", { name: /Remove unavailable/ }),
    ).toHaveCount(0);
    await expect(main(s.page)).not.toContainText(
      /unavailable in the current registry/,
    );
    assert.deepEqual(await s.stored(SAVED), [first.id, GONE]);
    if (sizeName === "phone") assert(await noSideScroll(s.page), "side scroll");

    // A reload.
    await s.page.reload();
    await s.ready();
    await expect(notice).toContainText(GONE);
    assert.deepEqual(await s.stored(SAVED), [first.id, GONE]);

    // A drawer, closed; Discover and back with the browser's Back and Forward.
    await s.page.goto(`${s.url}?view=watchlist&project=${first.id}`);
    await s.ready();
    await expect(s.page.getByRole("dialog")).toContainText(first.name, {
      timeout: 30000,
    });
    await s.page.keyboard.press("Escape");
    assert.deepEqual(await s.stored(SAVED), [first.id, GONE]);
    await s.page.getByTestId("view-overview").click();
    await expect(
      main(s.page).getByRole("heading", { name: "Browse hooks" }),
    ).toBeVisible();
    await s.page.goBack();
    await expect(notice).toContainText(GONE);
    await s.page.goForward();
    await s.page.goBack();
    await expect(notice).toContainText(GONE);
    assert.deepEqual(await s.stored(SAVED), [first.id, GONE]);

    // The visitor's own un-star of the other project leaves the unknown one.
    await s.page.getByTestId(`watch-${first.id}`).first().click();
    await expect.poll(() => s.stored(SAVED)).toEqual([GONE]);
    await expect(notice).toContainText(GONE);
    // Its notice and its empty state both say so and neither deletes anything.
    await expect(
      s.page.getByRole("heading", {
        name: "Saved projects are not in this snapshot",
      }),
    ).toBeVisible();
    assert.deepEqual(await s.stored(SAVED), [GONE]);

    // Only Forget removes it, and focus stays on the page.
    await s.page.getByRole("button", { name: `Forget ${GONE}` }).click();
    await expect.poll(() => s.stored(SAVED)).toEqual([]);
    await expect(
      s.page.getByRole("heading", { name: "Your watchlist is empty" }),
    ).toBeVisible();
    assert.equal(await activeText(s.page), "Explore projects");
    s.verify();
  });

test("every saved project outside the snapshot: the page says why, Browse projects goes to Discover and nothing is deleted", async (t) => {
  const s = await site(t, { saved: [GONE, GONE_TOO] });
  await s.goto("?view=watchlist");
  await s.ready();
  const notice = s.page.locator(".orphan-notice");
  await expect(notice).toContainText(
    "2 saved projects are not in this snapshot. They stay saved and will show again when a snapshot includes them.",
  );
  await expect(notice).toContainText(GONE);
  await expect(notice).toContainText(GONE_TOO);
  await expect(
    s.page.getByRole("heading", {
      name: "Saved projects are not in this snapshot",
    }),
  ).toBeVisible();
  await expect(main(s.page)).toContainText(SAVED_NONE_IN_SNAPSHOT);
  // The button that used to do nothing is gone; the way on is to browse.
  await expect(
    s.page.getByRole("button", { name: "Clear filters" }),
  ).toHaveCount(0);
  await expect(
    s.page.getByRole("button", { name: /Remove unavailable/ }),
  ).toHaveCount(0);
  const browse = s.page.getByRole("button", { name: "Browse projects" });
  await expect(browse).toBeVisible();
  await browse.click();
  await expect(
    main(s.page).getByRole("heading", { name: "Browse hooks" }),
  ).toBeVisible();
  expect(new URL(s.page.url()).searchParams.get("view")).toBeNull();
  assert.deepEqual(await s.stored(SAVED), [GONE, GONE_TOO]);
  await s.page.goBack();
  await expect(notice).toContainText(GONE);

  // One at a time: the list's heading takes focus while entries are left, the
  // empty state's button when the last one goes.
  await s.page.getByRole("button", { name: `Forget ${GONE}` }).click();
  await expect.poll(() => s.stored(SAVED)).toEqual([GONE_TOO]);
  await expect(notice).toContainText(
    "1 saved project is not in this snapshot.",
  );
  assert.equal(await activeText(s.page), "Saved projects");
  await s.page.getByRole("button", { name: `Forget ${GONE_TOO}` }).click();
  await expect.poll(() => s.stored(SAVED)).toEqual([]);
  await expect(
    s.page.getByRole("heading", { name: "Your watchlist is empty" }),
  ).toBeVisible();
  assert.equal(await activeText(s.page), "Explore projects");
  s.verify();
});

test("a project saved in one snapshot and missing from the next keeps its id and its name", async (t) => {
  // The realistic case: a hook is carried because one of its pools was measured;
  // the next run does not measure it and the snapshot no longer holds it.
  const s = await site(t, { saved: [first.id] });
  await s.goto("?view=watchlist");
  await s.ready();
  await expect(s.page.locator(".orphan-notice")).toHaveCount(0);
  await expect.poll(() => s.stored(NAMES)).toEqual({ [first.id]: first.name });
  // A later snapshot without it.
  const later = {
    ...snapshot,
    projects: snapshot.projects.filter((project) => project.id !== first.id),
    pools: snapshot.pools.filter((pool) => pool.projectId !== first.id),
  };
  s.server.setData("snapshot.json", JSON.stringify(later));
  await s.page.reload();
  await s.ready();
  const notice = s.page.locator(".orphan-notice");
  await expect(notice).toContainText(
    "1 saved project is not in this snapshot. It stays saved",
  );
  await expect(notice).toContainText(first.name);
  await expect(notice).toContainText(first.id);
  await expect(
    s.page.getByRole("button", { name: `Forget ${first.name}` }),
  ).toBeVisible();
  assert.deepEqual(await s.stored(SAVED), [first.id]);
  assert.deepEqual(await s.stored(NAMES), { [first.id]: first.name });
  // The export says how many saved entries it leaves out.
  await s.page.getByTestId("share-button").click();
  await expect(s.page.getByRole("dialog")).toContainText(
    "1 saved project is not in this snapshot, so it is not in these files.",
  );
  // And the JSON file carries the count and the ids.
  const [json] = await Promise.all([
    s.page.waitForEvent("download"),
    s.page.getByRole("button", { name: "Download JSON" }).click(),
  ]);
  const exported = JSON.parse(readFileSync(await json.path(), "utf8"));
  assert.deepEqual(exported.exportedView.savedNotInSnapshot, {
    count: 1,
    ids: [first.id],
  });
  assert.equal(exported.exportedView.view, "watchlist");
  s.verify();
});

test("starring writes the name beside the id and un-starring takes both away", async (t) => {
  const s = await site(t);
  await s.goto(`?view=overview&project=${second.id}`);
  await s.ready();
  const dialog = s.page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 30000 });
  await dialog.getByRole("button", { name: "Watch project" }).click();
  await expect.poll(() => s.stored(SAVED)).toEqual([second.id]);
  await expect
    .poll(() => s.stored(NAMES))
    .toEqual({ [second.id]: second.name });
  await dialog.getByRole("button", { name: "Watching" }).click();
  await expect.poll(() => s.stored(SAVED)).toEqual([]);
  await expect.poll(() => s.stored(NAMES)).toEqual({});
  s.verify();
});

/* ── Compare ───────────────────────────────────────────────────────────── */

test("a compare link with an id the snapshot lacks keeps it in the address, and the badge counts the carried ones", async (t) => {
  const s = await site(t);
  await s.goto(`?view=compare&compare=${first.id},${GONE},${second.id}`);
  await expect(s.page.getByTestId("hook-comparison")).toBeVisible({
    timeout: 60000,
  });
  await s.page.waitForTimeout(600);
  const ids = () => new URL(s.page.url()).searchParams.get("compare");
  assert.equal(ids(), `${first.id},${GONE},${second.id}`);
  await expect(
    s.page.getByTestId("view-compare").locator(".nav-count"),
  ).toHaveText("2");
  // Away and back, and a reload: the address still names it.
  await s.page.getByTestId("view-overview").click();
  await expect(s.page.locator(".compare-tray")).toContainText("2 selected");
  await s.page.goBack();
  await expect(s.page.getByTestId("hook-comparison")).toBeVisible();
  assert.equal(ids(), `${first.id},${GONE},${second.id}`);
  await s.page.reload();
  await expect(s.page.getByTestId("hook-comparison")).toBeVisible({
    timeout: 60000,
  });
  assert.equal(ids(), `${first.id},${GONE},${second.id}`);
  s.verify();
});

test("adding a fourth project to a link that names one the snapshot lacks drops that id from Compare's notice as well as the address", async (t) => {
  if (carried.length < 4)
    return t.skip("the data has fewer than four projects");
  const [one, two, three] = carried;
  const s = await site(t);
  await s.goto(`?view=compare&compare=${one.id},${two.id},${three.id},${GONE}`);
  await expect(s.page.getByTestId("hook-comparison")).toBeVisible({
    timeout: 60000,
  });
  await expect(s.page.locator(".comparison-not-carried")).toContainText(GONE);
  await s.page.getByTestId("view-overview").click();
  // Any card that is not selected yet (the three selected ones say "Remove").
  const add = s.page
    .getByRole("button", { name: /^Add .+ to comparison$/ })
    .first();
  await expect(add).toBeVisible({ timeout: 30000 });
  await add.click();
  await expect(s.page.locator(".compare-tray")).toContainText("4 selected");
  const ids = () =>
    (new URL(s.page.url()).searchParams.get("compare") || "").split(",");
  assert.equal(ids().length, 4);
  assert(
    !ids().includes(GONE),
    "the address dropped the id the snapshot lacks",
  );
  // The page says what the address says: nothing is named that the link no longer has.
  await s.page.getByTestId("view-compare").click();
  await expect(s.page.getByTestId("hook-comparison")).toBeVisible({
    timeout: 30000,
  });
  await expect(s.page.locator(".comparison-not-carried")).toHaveCount(0);
  await expect(main(s.page)).not.toContainText(GONE);
  s.verify();
});

/* ── The time a page is judged at ──────────────────────────────────────── */

test("an overview from a later run next to an older snapshot never expires the snapshot's figures; the wait is named once, after three tries", async (t) => {
  // An edge still holds the old snapshot while the overview is already new:
  // the server keeps answering snapshot.json with run A, whatever the address.
  const later = shiftTimes(read("overview-all-h24.json"), 3 * HOUR);
  const s = await site(t);
  await s.goto("");
  await s.ready();
  const before = await stats(s.page);
  assert.doesNotMatch(before, /Measurements expired/);
  assert.doesNotMatch(before, /Tracked hook volume · 24H\s*[—-]/);
  const line = fullTimeLabel(snapshot.generatedAt);
  await expect(s.page.getByTestId("snapshot-line")).toContainText(line);

  s.server.setData("overview-all-h24.json", later);
  await s.page.getByTestId("view-analytics").click();
  // The overview is shown at its own time, not as expired.
  await expect(s.page.getByTestId("snapshot-line")).toContainText(
    fullTimeLabel(overviewAt(later)),
    { timeout: 30000 },
  );
  // The older file is asked for again up to three times, under the newer run's
  // address, then the page says so once and stops.
  await expect(s.page.getByText(PUBLISHING_NOTE)).toHaveCount(1, {
    timeout: 30000,
  });
  assert.equal(
    s.asks("snapshot.json").length,
    4,
    "the snapshot: once, then three tries",
  );
  for (const row of s.asks("snapshot.json").slice(1))
    assert.equal(row.query, `?v=${encodeURIComponent(overviewAt(later))}`);
  await s.page.waitForTimeout(5000);
  assert.equal(s.asks("snapshot.json").length, 4, "no loop");
  await expect(s.page.getByText(PUBLISHING_NOTE)).toHaveCount(1);
  assert.doesNotMatch(await main(s.page).innerText(), /Measurements expired/);

  // Back on Discover, the snapshot is still judged at its own time.
  await s.page.getByTestId("view-overview").click();
  await expect(s.page.locator("#ecosystem-stats")).toBeAttached();
  const after = await stats(s.page);
  assert.equal(after, before, "the figures did not change");
  assert.doesNotMatch(after, /Measurements expired/);
  await expect(s.page.getByTestId("snapshot-line")).toContainText(line);
  await expect(s.page.getByText(PUBLISHING_NOTE)).toHaveCount(1);
  s.verify();
});

test("a stale overview next to a newer snapshot is asked for again under the snapshot's run, then named once", async (t) => {
  // The deploy landed between the two requests: the snapshot is run B, the
  // overview (still served by an edge) run A.
  const newer = shiftTimes(snapshotText, 3 * HOUR);
  const s = await site(t, { data: { "snapshot.json": newer } });
  await s.goto("?view=analytics");
  await s.ready();
  await s.page.getByTestId("view-overview").click();
  await expect(s.page.locator("#ecosystem-stats")).toBeAttached({
    timeout: 60000,
  });
  const before = await stats(s.page);
  await s.page.getByTestId("view-analytics").click();
  await expect(s.page.getByText(PUBLISHING_NOTE)).toHaveCount(1, {
    timeout: 30000,
  });
  // Opening Analytics asks for its file once (as it always does); the three
  // tries that follow carry the snapshot's run in the address.
  const overviewAsks = s.asks("overview-all-h24.json");
  const retried = overviewAsks.filter((row) => row.query !== "");
  assert.equal(retried.length, 3, "three more tries, no more");
  for (const row of retried)
    assert.equal(row.query, `?v=${encodeURIComponent(generatedOf(newer))}`);
  const count = overviewAsks.length;
  await s.page.waitForTimeout(4500);
  assert.equal(s.asks("overview-all-h24.json").length, count, "no loop");
  await s.page.getByTestId("view-overview").click();
  assert.equal(await stats(s.page), before);
  s.verify();
});

// The status check replaced the silent re-download of the whole snapshot on
// return to the tab: a small no-store read of data/status.json every half hour
// (and when the visitor comes back after that long), and a calm "newer snapshot"
// line with a Reload button. The data on screen is never swapped silently.
test("a status file that names an older run, the same run or nothing readable offers nothing, and the snapshot is not requested again", async (t) => {
  const s = await site(t, { clock: "install" });
  await s.goto("");
  await s.ready();
  const line = fullTimeLabel(snapshot.generatedAt);
  const before = await stats(s.page);
  for (const status of [
    shiftTimes(read("status.json"), -3 * HOUR),
    read("status.json"),
    "not json at all",
  ]) {
    s.server.setData("status.json", status);
    const asked = s.asks("status.json").length;
    await s.page.clock.fastForward(31 * MINUTE);
    await expect.poll(() => s.asks("status.json").length).toBe(asked + 1);
    await s.page.waitForTimeout(300);
    await expect(s.page.getByTestId("snapshot-line")).toContainText(line);
    await expect(s.page.getByTestId("snapshot-reload")).toHaveCount(0);
  }
  assert.equal(
    s.asks("snapshot.json").length,
    1,
    "the file is not asked again",
  );
  assert.equal(await stats(s.page), before);
  await expect(s.page.locator(".error-notice")).toHaveCount(0);
  s.verify();
});

test("a newer run is offered with a Reload button after half an hour, and nothing on screen changes until it is pressed", async (t) => {
  const s = await site(t, { clock: "install" });
  await s.goto("");
  await s.ready();
  const before = await stats(s.page);
  const line = fullTimeLabel(snapshot.generatedAt);
  const newer = shiftTimes(snapshotText, 3 * HOUR);
  s.server.setData("snapshot.json", newer);
  s.server.setData("status.json", shiftTimes(read("status.json"), 3 * HOUR));
  // Under half an hour nothing is asked.
  await s.page.clock.fastForward(20 * MINUTE);
  await s.page.waitForTimeout(300);
  assert.equal(s.asks("status.json").length, 0);
  await s.page.clock.fastForward(11 * MINUTE);
  const reload = s.page.getByTestId("snapshot-reload");
  await expect(reload).toBeVisible({ timeout: 30000 });
  await expect(s.page.getByTestId("snapshot-line")).toContainText(
    `A newer snapshot is available (taken ${fullTimeLabel(generatedOf(newer))}).`,
  );
  await expect(s.page.getByTestId("snapshot-line")).toContainText(line);
  // Only the small status file was read, without any cache; the 10 MB snapshot
  // was not, and the figures are those of the snapshot the page loaded.
  assert.equal(s.asks("snapshot.json").length, 1);
  assert.equal(await stats(s.page), before);
  // Pressing Reload shows the newer run.
  await reload.click();
  await expect(s.page.getByTestId("snapshot-line")).toContainText(
    `Snapshot taken ${fullTimeLabel(generatedOf(newer))}`,
    { timeout: 30000 },
  );
  await expect(s.page.getByTestId("snapshot-reload")).toHaveCount(0);
  s.verify();
});

test("a visitor who comes back after half an hour is checked at once, by the small status file only", async (t) => {
  const s = await site(t, { clock: "install" });
  await s.goto("");
  await s.ready();
  s.server.setData("status.json", shiftTimes(read("status.json"), 3 * HOUR));
  // The device's clock jumps (the laptop slept) without a timer firing.
  await s.page.clock.setSystemTime(generated + 2 * MINUTE + 45 * MINUTE);
  await s.page.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
  });
  await expect(s.page.getByTestId("snapshot-reload")).toBeVisible({
    timeout: 30000,
  });
  // One request, though two events fired.
  assert.equal(s.asks("status.json").length, 1);
  assert.equal(s.asks("snapshot.json").length, 1);
  s.verify();
});

test("the lightweight Analytics page offers a newer overview the same way, and never downloads the snapshot", async (t) => {
  const s = await site(t, { clock: "install" });
  await s.goto("?view=analytics");
  await s.ready();
  assert.equal(s.asks("overview-all-h24.json").length, 1);
  const newer = shiftTimes(read("overview-all-h24.json"), 3 * HOUR);
  s.server.setData("overview-all-h24.json", newer);
  s.server.setData("status.json", shiftTimes(read("status.json"), 3 * HOUR));
  await s.page.clock.fastForward(31 * MINUTE);
  await expect(s.page.getByTestId("snapshot-reload")).toBeVisible({
    timeout: 30000,
  });
  await expect(s.page.getByTestId("snapshot-line")).toContainText(
    `A newer snapshot is available (taken ${fullTimeLabel(overviewAt(newer))}).`,
  );
  assert.equal(s.asks("overview-all-h24.json").length, 1, "not asked again");
  assert.equal(s.asks("snapshot.json").length, 0);
  await s.page.getByTestId("snapshot-reload").click();
  await expect(s.page.getByTestId("snapshot-line")).toContainText(
    fullTimeLabel(overviewAt(newer)),
    { timeout: 30000 },
  );
  s.verify();
});

test("the guide, the one view that loads no data, never asks for a newer snapshot", async (t) => {
  const s = await site(t, { clock: "install" });
  await s.goto("?view=learn");
  await expect(
    s.page.getByRole("heading", { name: "Understand v4 hooks" }),
  ).toBeVisible({ timeout: 30000 });
  await s.page.clock.fastForward(95 * MINUTE);
  await s.page.waitForTimeout(400);
  assert.equal(s.asks("status.json").length, 0);
  assert.equal(s.asks("snapshot.json").length, 0);
  s.verify();
});

for (const [name, offset] of [
  ["two days earlier", -2 * DAY],
  ["two days later", 2 * DAY],
])
  test(`a visitor's clock ${name} than the snapshot still renders every figure`, async (t) => {
    // What every page says at an ordinary clock is what it must say at this one.
    // ("Measurements expired" is a true statement about a pool measured more
    // than five minutes before the snapshot, so it is counted, not banned.)
    const expired = (text) =>
      (text.match(/Measurements expired/g) || []).length;
    const reference = {};
    const normal = await site(t);
    for (const query of [
      "",
      "?view=analytics",
      "?view=chains",
      "?view=watchlist",
    ]) {
      await normal.goto(query);
      await normal.ready();
      reference[query] = expired(await main(normal.page).innerText());
    }
    await normal.goto("");
    await normal.ready();
    const referenceStats = await stats(normal.page);

    const s = await site(t, { at: generated + offset });
    await s.goto("");
    await s.ready();
    assert.equal(
      await stats(s.page),
      referenceStats,
      "the same figures as at any other time",
    );
    await expect(s.page.locator(".error-notice")).toHaveCount(0);
    for (const query of Object.keys(reference)) {
      await s.goto(query);
      await s.ready();
      const text = await main(s.page).innerText();
      assert.doesNotMatch(
        text,
        /couldn.t be read|snapshot could not be/,
        query,
      );
      assert.equal(
        expired(text),
        reference[query],
        `${query || "/"}: the same measurements are expired`,
      );
    }
    s.verify();
  });

/* ── An unknown network ────────────────────────────────────────────────── */

test("an analytics link naming a network the snapshot has no file for says so, offers All networks and no Retry, and asks once", async (t) => {
  const s = await site(t, {
    allow: (message) =>
      /overview-atlantis-h24\.json/.test(message.location().url),
  });
  await s.goto("?view=analytics&analytics_chain=atlantis");
  await expect(main(s.page)).toContainText(NOT_PUBLISHED_TITLE, {
    timeout: 30000,
  });
  const allNetworks = s.page.getByRole("button", { name: "All networks" });
  await expect(allNetworks).toBeVisible();
  await expect(
    s.page.getByRole("button", { name: /retry|try again/i }),
  ).toHaveCount(0);
  await expect(s.page.locator(".error-notice")).toHaveCount(0);
  await s.page.waitForTimeout(1500);
  assert.equal(s.asks("overview-atlantis-h24.json").length, 1);
  // To all networks, and Back to the link: the page already knows the file is missing.
  await allNetworks.click();
  await expect(s.page.getByTestId("snapshot-line")).toBeVisible({
    timeout: 30000,
  });
  expect(new URL(s.page.url()).searchParams.get("analytics_chain")).toBeNull();
  await s.page.goBack();
  await expect(main(s.page)).toContainText(NOT_PUBLISHED_TITLE);
  await expect(
    s.page.getByRole("button", { name: /retry|try again/i }),
  ).toHaveCount(0);
  await s.page.waitForTimeout(800);
  assert.equal(
    s.asks("overview-atlantis-h24.json").length,
    1,
    "no second request for the missing file",
  );
  s.verify();
});

test("All networks on the unpublished-network page hands keyboard focus to the page heading, not the document", async (t) => {
  const s = await site(t, {
    allow: (message) =>
      /overview-atlantis-h24.json/.test(message.location().url),
  });
  await s.goto("?view=analytics&analytics_chain=atlantis");
  await expect(main(s.page)).toContainText(NOT_PUBLISHED_TITLE, {
    timeout: 30000,
  });
  const allNetworks = s.page.getByRole("button", { name: "All networks" });
  await allNetworks.focus();
  await s.page.keyboard.press("Enter");
  await expect(s.page.getByTestId("snapshot-line")).toBeVisible({
    timeout: 30000,
  });
  const focused = await s.page.evaluate(() => {
    const el = document.activeElement;
    return {
      tag: el?.tagName,
      inHeading: el === document.querySelector("main h1"),
    };
  });
  assert.equal(focused.tag, "H1", "focus fell to " + focused.tag);
  assert(focused.inHeading, "focus is on the page heading");
  s.verify();
});

test("All networks on an Analytics page whose own file cannot be read also keeps focus on the page", async (t) => {
  const chain = snapshot.chains.find((c) => {
    try {
      read(`overview-${c.slug}-h24.json`);
      return true;
    } catch {
      return false;
    }
  });
  if (!chain) return t.skip("no per-network overview file in the data");
  const file = `overview-${chain.slug}-h24.json`;
  const s = await site(t, { data: { [file]: "<html></html>" } });
  await s.goto(`?view=analytics&analytics_chain=${chain.slug}`);
  await expect(s.page.locator(".error-notice")).toContainText(
    "Analytics could not be read.",
    { timeout: 60000 },
  );
  await s.page.getByRole("button", { name: "All networks" }).focus();
  await s.page.keyboard.press("Enter");
  await expect(s.page.getByTestId("snapshot-line")).toBeVisible({
    timeout: 30000,
  });
  assert.equal(
    await s.page.evaluate(() => document.activeElement?.tagName),
    "H1",
  );
  s.verify();
});

test("[phone] the unknown network's page fits the screen", async (t) => {
  const s = await site(t, {
    size: PHONE,
    allow: (message) =>
      /overview-atlantis-h24\.json/.test(message.location().url),
  });
  await s.goto("?view=analytics&analytics_chain=atlantis");
  await expect(main(s.page)).toContainText(NOT_PUBLISHED_TITLE, {
    timeout: 30000,
  });
  assert(await noSideScroll(s.page), "side scroll");
  s.verify();
});

test("a network with a file still opens its analytics", async (t) => {
  const s = await site(t);
  const chain = snapshot.chains.find((c) => {
    try {
      read(`overview-${c.slug}-h24.json`);
      return true;
    } catch {
      return false;
    }
  });
  assert(chain, "the data has a per-network overview");
  await s.goto(`?view=analytics&analytics_chain=${chain.slug}`);
  await s.ready();
  await expect(main(s.page)).not.toContainText(NOT_PUBLISHED_TITLE);
  s.verify();
});

/* ── Failure copy ──────────────────────────────────────────────────────── */

const retryButtons = (page) =>
  page.getByRole("button", { name: /^(Retry|Try again)/ });

for (const [name, setup, failure] of [
  [
    "a missing file (404)",
    { "snapshot.json": null },
    { kind: "status", status: 404 },
  ],
  [
    "an unreadable file",
    { "snapshot.json": "<html><body>Maintenance</body></html>" },
    { kind: "unreadable" },
  ],
  [
    "a file cut short",
    {
      "snapshot.json": snapshotText.slice(
        0,
        Math.floor(snapshotText.length / 2),
      ),
    },
    { kind: "unreadable" },
  ],
])
  test(`${name}: plain words, one Retry, and it recovers when the file is back`, async (t) => {
    const s = await site(t, { data: setup });
    await s.goto("");
    const notice = s.page.locator(".error-notice");
    await expect(notice).toContainText(snapshotFailureMessage(failure), {
      timeout: 60000,
    });
    const text = await main(s.page).innerText();
    assert.doesNotMatch(text, BANNED);
    await expect(retryButtons(s.page)).toHaveCount(1);
    await expect(notice.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(main(s.page)).toContainText("We couldn’t load the radar");
    await expect(main(s.page)).toContainText(
      "This page tries again by itself.",
    );
    s.server.setData("snapshot.json", snapshotText);
    await notice.getByRole("button", { name: "Retry" }).click();
    await s.ready();
    await expect(s.page.locator(".error-notice")).toHaveCount(0);
    assert.deepEqual(s.server.apiRequests(), []);
  });

for (const status of [429, 500, 503])
  test(`a ${status} from the host: no service, no refresh, no verified saved data`, async (t) => {
    const s = await site(t, { allow: (m) => /status of/.test(m.text()) });
    await s.page.route("**/data/snapshot.json", (route) =>
      route.fulfill({ status, contentType: "text/plain", body: "no" }),
    );
    await s.goto("");
    await expect(s.page.locator(".error-notice")).toContainText(
      snapshotFailureMessage({ kind: "status", status }),
      { timeout: 60000 },
    );
    assert.doesNotMatch(await s.page.locator("body").innerText(), BANNED);
    await expect(retryButtons(s.page)).toHaveCount(1);
  });

test("analytics that cannot be read says so without blaming the connection, and Retry stays", async (t) => {
  const s = await site(t, {
    data: { "overview-all-h24.json": "<html></html>" },
  });
  await s.goto("?view=analytics");
  const notice = s.page.locator(".error-notice");
  await expect(notice).toContainText("Analytics could not be read.", {
    timeout: 60000,
  });
  assert.doesNotMatch(await notice.innerText(), BANNED);
  await expect(
    notice.getByRole("button", { name: "Retry analytics" }),
  ).toBeVisible();
  s.server.setData("overview-all-h24.json", read("overview-all-h24.json"));
  await notice.getByRole("button", { name: "Retry analytics" }).click();
  await s.ready();
  s.verify();
});

test("an analytics overview with no file (404 on the all-networks file) keeps a Retry that can pass", async (t) => {
  const s = await site(t, {
    data: { "overview-all-h24.json": null },
    allow: (m) => /overview-all-h24\.json/.test(m.location().url),
  });
  await s.goto("?view=analytics");
  const notice = s.page.locator(".error-notice");
  await expect(notice).toContainText(
    "Analytics could not load. The site may be updating; try again in a few minutes.",
    { timeout: 60000 },
  );
  await expect(
    notice.getByRole("button", { name: "Retry analytics" }),
  ).toBeVisible();
  assert.doesNotMatch(await main(s.page).innerText(), BANNED);
});

/* ── A load that never finishes, and one that is only slow ─────────────── */

test("the page stops trying by itself after five more attempts, then leaves the manual button", async (t) => {
  const s = await site(t, {
    clock: "install",
    data: { "snapshot.json": null },
    allow: (m) => /404/.test(m.text()),
  });
  await s.goto("");
  await expect(s.page.locator(".error-notice")).toBeVisible({ timeout: 30000 });
  for (let step = 0; step < 14; step++) {
    await s.page.clock.runFor(31_000);
    await s.page.waitForTimeout(150);
  }
  assert.equal(
    s.asks("snapshot.json").length,
    6,
    "the first load and five tries",
  );
  await expect(main(s.page)).toContainText(
    "This page has stopped trying by itself",
  );
  await expect(retryButtons(s.page)).toHaveCount(1);
  for (let step = 0; step < 4; step++) {
    await s.page.clock.runFor(120_000);
    await s.page.waitForTimeout(100);
  }
  assert.equal(s.asks("snapshot.json").length, 6, "nothing more by itself");
  // A tab that comes back to the foreground does not start it again either.
  await s.page.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("online"));
  });
  await s.page.waitForTimeout(300);
  assert.equal(s.asks("snapshot.json").length, 6);
  // The visitor's own Retry still works, and loads the file once it is back.
  s.server.setData("snapshot.json", snapshotText);
  await s.page
    .locator(".error-notice")
    .getByRole("button", { name: "Retry" })
    .click();
  await s.ready();
  assert.equal(s.asks("snapshot.json").length, 7);
});

test("a download that has stopped is given up after thirty silent seconds, not ninety", async (t) => {
  const s = await site(t, { clock: "install" });
  await s.page.route("**/data/snapshot.json", () => {
    // Never answered: the connection is open and silent.
  });
  await s.goto("");
  await expect(s.page.locator(".loading-screen")).toBeVisible({
    timeout: 30000,
  });
  await s.page.clock.runFor(25_000);
  await s.page.waitForTimeout(200);
  await expect(s.page.locator(".error-notice")).toHaveCount(0);
  await s.page.clock.runFor(6_000);
  await expect(s.page.locator(".error-notice")).toContainText(
    snapshotFailureMessage({ kind: "stalled" }),
    { timeout: 15000 },
  );
  assert.doesNotMatch(await s.page.locator("body").innerText(), BANNED);
});

test("a slow download that keeps arriving is never cut off, however long it takes", async (t) => {
  // The host drips the snapshot in forty pieces. The page's clock is moved ten
  // seconds between pieces: more than five minutes in all, far past the old 90 s
  // cap, and never thirty seconds without bytes.
  const pieces = 40;
  const body = Buffer.from(snapshotText);
  const proxy = async (server) => {
    const http = createServer(async (req, res) => {
      const target = `${server.origin}${req.url}`;
      if (req.url.split("?")[0].endsWith("/data/snapshot.json")) {
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": body.length,
          "Cache-Control": "no-cache",
        });
        const size = Math.ceil(body.length / pieces);
        for (let at = 0; at < body.length; at += size) {
          res.write(body.subarray(at, at + size));
          await new Promise((done) => setTimeout(done, 150));
        }
        return res.end();
      }
      const upstream = await fetch(target);
      res.writeHead(upstream.status, {
        "Content-Type": upstream.headers.get("content-type") || "text/plain",
        "Cache-Control": "no-cache",
      });
      res.end(Buffer.from(await upstream.arrayBuffer()));
    });
    await new Promise((done) => http.listen(0, "127.0.0.1", done));
    return {
      url: `http://127.0.0.1:${http.address().port}/`,
      close: () =>
        new Promise((done) => {
          http.close(() => done());
          http.closeAllConnections();
        }),
    };
  };
  const s = await site(t, { clock: "install", origin: proxy });
  await s.goto("");
  let moved = 0;
  const shown = s.page.getByTestId("snapshot-line");
  while (!(await shown.isVisible()) && moved < 600_000) {
    await s.page.clock.runFor(10_000);
    moved += 10_000;
    await s.page.waitForTimeout(100);
    if (await s.page.locator(".error-notice").count())
      assert.fail(
        `the download was cut off after ${moved / 1000} s without a 30 s silence`,
      );
  }
  await expect(shown).toBeVisible({ timeout: 30000 });
  assert(
    moved > 90_000,
    `the page's clock moved ${moved / 1000} s, past the old 90 s cap`,
  );
  await expect(s.page.locator(".error-notice")).toHaveCount(0);
});

/* ── Phone ─────────────────────────────────────────────────────────────── */

test("[phone] the failure screen and the saved-project notice fit the screen", async (t) => {
  const failing = await site(t, {
    size: PHONE,
    data: { "snapshot.json": null },
    allow: (m) => /404/.test(m.text()),
  });
  await failing.goto("");
  await expect(failing.page.locator(".error-notice")).toBeVisible({
    timeout: 60000,
  });
  assert(await noSideScroll(failing.page), "side scroll on the failure screen");
  const box = await failing.page
    .locator(".error-notice")
    .getByRole("button", { name: "Retry" })
    .boundingBox();
  assert(box.height >= 44, `Retry is ${box.height}px high on a phone`);

  const saved = await site(t, {
    size: PHONE,
    saved: [first.id, GONE, GONE_TOO],
  });
  await saved.goto("?view=watchlist");
  await saved.ready();
  await expect(saved.page.locator(".orphan-notice")).toContainText(
    "2 saved projects are not in this snapshot.",
  );
  assert(await noSideScroll(saved.page), "side scroll on the watchlist");
  saved.verify();
});
