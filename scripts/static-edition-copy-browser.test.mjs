// The Auto Snapshot edition's Discover wording, the page for a project the
// snapshot does not carry, the Data & sources dialog (also from the guide, which
// loads no snapshot), the project CSV and JSON downloads, a drawer's first tab and
// the drawer's failure state, in a real browser. The words themselves and the
// CSV's shape are checked without a browser in tests/edition-app-copy.test.mjs.
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
// The edition's page has no Data & sources dialog (its owner's choice,
// EDITION_SOURCES_DIALOG in src/edition.ts), so the tests of what the dialog
// says run on a second build of the same source with that switch on, made by
// scripts/edition-sources-build.mjs (RADAR_TEST_SOURCES_DIST names one).
//
//   RADAR_TEST_DIST=dist/test-build \
//     node --test scripts/static-edition-copy-browser.test.mjs
//   RADAR_TEST_DIST=<build> RADAR_TEST_DATA=<real data folder> \
//     node --test scripts/static-edition-copy-browser.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test, { after, before } from "node:test";
import { chromium, expect } from "@playwright/test";
import { startStaticEditionServer } from "./static-edition-server.mjs";
import {
  LIST_HOLDS,
  NO_MATCH_IN_SNAPSHOT,
  PROJECT_NOT_CARRIED,
  fullTimeLabel,
  recentTradingCaption,
} from "../src/edition.ts";
import { snapshotFailureMessage } from "../src/edition-shell.ts";
import { sourcesDialogDist } from "./edition-sources-build.mjs";

const DIST = resolve(process.env.RADAR_TEST_DIST || "dist");
// The edition hides the Data & sources dialog (its owner's choice); the tests
// of what the dialog says run on a build of the same source with the switch on.
const SOURCES_DIST = await sourcesDialogDist();
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

const read = (name) => readFileSync(resolve(DATA, name), "utf8");
const snapshotText = read("snapshot.json");
const snapshot = JSON.parse(snapshotText);
const generated = Date.parse(snapshot.generatedAt);
const IDENTIFIER = /^[a-z0-9][a-z0-9-]{0,99}$/;
const withPool = new Set(snapshot.pools.map((pool) => pool.projectId));
// Projects a visitor can open and save from the default list: registry-named
// hooks of their own with an id a link can carry.
const carried = snapshot.projects.filter(
  (project) =>
    project.entityType !== "platform" &&
    project.deployments.some(
      (deployment) => deployment.discovery !== "onchain",
    ) &&
    IDENTIFIER.test(project.id),
);
const measured = carried.find((project) => withPool.has(project.id));
assert(measured, "the data has a named project with a measured pool");
const measuredChain = snapshot.pools.find(
  (pool) => pool.projectId === measured.id,
).chain;
// A project the snapshot carries with no measured pool. The test data has none:
// then one project's pools are left out of the snapshot the page is given.
const naturallyBare = carried.find((project) => !withPool.has(project.id));
const bare = naturallyBare ?? carried.find((p) => p.id !== measured.id);
const bareSnapshotText = naturallyBare
  ? snapshotText
  : JSON.stringify({
      ...snapshot,
      pools: snapshot.pools.filter((pool) => pool.projectId !== bare.id),
    });
const GONE = "gone-project";
assert(!snapshot.projects.some((project) => project.id === GONE));

/** Every ISO time inside a JSON text moved by `ms`: another run of the same data. */
const shiftTimes = (text, ms) =>
  text.replace(
    /"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)"/g,
    (_, time) => `"${new Date(Date.parse(time) + ms).toISOString()}"`,
  );

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
 * not found); `saved` seeds the browser's watchlist; the visitor's clock stands
 * still at `at`; `allow` names console errors a test expects. */
async function site(
  t,
  {
    size = DESKTOP,
    data = {},
    saved = null,
    at = generated + 2 * MINUTE,
    allow = () => false,
    dist = DIST,
  } = {},
) {
  const server = await startStaticEditionServer({
    distDir: dist,
    dataDir: DATA,
    mount: "/",
  });
  for (const [name, body] of Object.entries(data)) server.setData(name, body);
  const context = await browser.newContext({
    viewport: size,
    reducedMotion: "reduce",
    acceptDownloads: true,
    ...(size.width < 600 ? { hasTouch: true, isMobile: true } : {}),
  });
  await context.clock.setFixedTime(at);
  if (saved)
    await context.addInitScript(
      ([key, value]) => {
        if (sessionStorage.getItem("seeded")) return;
        sessionStorage.setItem("seeded", "1");
        localStorage.setItem(key, value);
      },
      [SAVED, JSON.stringify(saved)],
    );
  const page = await context.newPage();
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !allow(message))
      errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  t.after(async () => {
    await context.close();
    await server.close();
  });
  return {
    page,
    server,
    ready: async () => {
      await expect(page.getByTestId("snapshot-line")).toBeVisible({
        timeout: 60000,
      });
      await page.waitForTimeout(400);
    },
    goto: (query = "") => page.goto(`${server.url}${query}`),
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
const flat = (text) => text.replace(/\s+/g, " ").trim();
// The stats band is collapsed by default, so read its text, not what is shown.
const stats = (page) =>
  page.locator("#ecosystem-stats").evaluate((el) => el.textContent || "");
const chip = (page) =>
  page.locator(".overview-scope").evaluate((el) => el.textContent || "");
const noSideScroll = (page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth <=
      document.documentElement.clientWidth + 1,
  );
const sourcesButton = (page) => page.getByTestId("sources-button");

/** The rows of a CSV text (quoted cells, "" for a quote, CRLF between rows). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i += 1;
    } else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

/** The file a download button writes. */
async function downloaded(page, button) {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    button.click(),
  ]);
  return {
    name: download.suggestedFilename(),
    text: readFileSync(await download.path(), "utf8"),
  };
}

/* ── Discover's words ──────────────────────────────────────────────────── */

for (const [sizeName, size] of Object.entries({
  desktop: DESKTOP,
  phone: PHONE,
}))
  test(`[${sizeName}] the All hooks scope says what the snapshot lists, not every hook`, async (t) => {
    const s = await site(t, { size });
    await s.goto("?market=all");
    await s.ready();
    await expect(s.page.locator(".index-scope-note")).toHaveText(LIST_HOLDS);
    const text = flat(await s.page.locator("body").innerText());
    assert.doesNotMatch(text, /Every discovered hook|unnamed contracts/);
    // The Directory entries figure and the scope chip say the same.
    const band = await stats(s.page);
    assert(band.includes("Directory entries"), band);
    assert(band.includes(LIST_HOLDS), band);
    assert.doesNotMatch(band, /Named projects and unnamed hooks/);
    assert.equal(
      flat(await chip(s.page)),
      "All hooks in this snapshot · All networks",
    );
    // The button keeps its name.
    await expect(
      s.page
        .getByRole("group", { name: "Directory coverage" })
        .getByRole("button", { name: "All hooks", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    if (sizeName === "phone") assert(await noSideScroll(s.page), "side scroll");
    s.verify();
  });

for (const [sizeName, size] of Object.entries({
  desktop: DESKTOP,
  phone: PHONE,
}))
  test(`[${sizeName}] market data and recent trading are not called named projects`, async (t) => {
    const s = await site(t, { size });
    // The default scope really is the named projects.
    await s.goto("");
    await s.ready();
    assert((await stats(s.page)).includes("Named projects in this view"));
    assert.equal(flat(await chip(s.page)), "Named projects · All networks");

    for (const [market, label] of [
      ["observed", "With market data"],
      ["active", "Recent trading"],
    ]) {
      await s.goto(`?market=${market}`);
      await s.ready();
      const band = await stats(s.page);
      assert(
        band.includes("Hooks and projects in this view"),
        `${market}: ${band}`,
      );
      assert.doesNotMatch(band, /Named projects/, market);
      assert.equal(flat(await chip(s.page)), `${label} · All networks`, market);
    }

    // Recent trading is read against the snapshot, not the visitor's clock.
    await expect(s.page.locator(".index-scope-note")).toHaveText(
      recentTradingCaption("24H"),
    );
    assert.doesNotMatch(
      flat(await s.page.locator(".index-scope-note").innerText()),
      /under 5m old/,
    );
    // The window follows the switch.
    await s.page
      .getByRole("group", { name: "Volume time window" })
      .getByRole("button", { name: "1H" })
      .click();
    await expect(s.page.locator(".index-scope-note")).toHaveText(
      recentTradingCaption("1H"),
    );
    if (sizeName === "phone") assert(await noSideScroll(s.page), "side scroll");
    s.verify();
  });

test("a search the snapshot cannot answer says it carries a sample, in every scope", async (t) => {
  const s = await site(t);
  for (const query of [
    "?q=zzzz-no-such-hook",
    "?q=zzzz-no-such-hook&market=all",
    // A well-formed address the snapshot has no project for.
    "?q=0xfa0e72d3ea2995cdcc84d7264261a5719a1f40cc",
  ]) {
    await s.goto(query);
    await s.ready();
    await expect(
      main(s.page).getByRole("heading", { name: "No matching projects" }),
    ).toBeVisible({ timeout: 30000 });
    await expect(main(s.page)).toContainText(NO_MATCH_IN_SNAPSHOT);
    assert.doesNotMatch(
      flat(await main(s.page).innerText()),
      /Try a different name, address, chain or category/,
      query,
    );
  }
  s.verify();
});

test("a watchlist narrowed to nothing is not a search of the snapshot and keeps the plain words", async (t) => {
  const s = await site(t, { saved: [measured.id] });
  await s.goto("?view=watchlist&q=zzzz-no-such-hook");
  await s.ready();
  await expect(
    main(s.page).getByRole("heading", { name: "No matching projects" }),
  ).toBeVisible({ timeout: 30000 });
  await expect(main(s.page)).toContainText(
    "Try a different name, address, chain or category.",
  );
  assert.doesNotMatch(
    flat(await main(s.page).innerText()),
    /Nothing in this snapshot matches/,
  );
  s.verify();
});

/* ── A project the snapshot does not carry ─────────────────────────────── */

for (const [sizeName, size] of Object.entries({
  desktop: DESKTOP,
  phone: PHONE,
}))
  test(`[${sizeName}] a link to a project the snapshot does not carry says so and names no cause`, async (t) => {
    const s = await site(t, { size });
    await s.goto("?project=not-a-project");
    const dialog = s.page.getByRole("dialog");
    await expect(dialog).toContainText("Project not in this snapshot", {
      timeout: 30000,
    });
    await expect(dialog).toContainText(PROJECT_NOT_CARRIED);
    const text = flat(await dialog.innerText());
    assert.doesNotMatch(text, /removed|renamed/);
    if (sizeName === "phone") assert(await noSideScroll(s.page), "side scroll");
    await s.page.getByRole("button", { name: "Back to radar" }).click();
    await expect(s.page.getByText("Project not in this snapshot")).toHaveCount(
      0,
    );
    s.verify();
  });

/* ── Data & sources ────────────────────────────────────────────────────── */

for (const [sizeName, size] of Object.entries({
  desktop: DESKTOP,
  phone: PHONE,
}))
  test(`[${sizeName}] with the dialog switched on, Data & sources opened from the guide loads the snapshot and shows its sources`, async (t) => {
    const s = await site(t, { size, dist: SOURCES_DIST });
    await s.goto("?view=learn");
    await expect(s.page.getByRole("heading", { level: 1 }).first()).toBeVisible(
      { timeout: 30000 },
    );
    await sourcesButton(s.page).click();
    const dialog = s.page.getByRole("dialog");
    for (const source of snapshot.sources)
      await expect(
        dialog.locator(".source-item", { hasText: source.name }),
      ).toBeVisible({ timeout: 60000 });
    await expect(dialog).toContainText(
      `snapshot taken ${fullTimeLabel(snapshot.generatedAt)}`,
    );
    assert.doesNotMatch(
      flat(await dialog.innerText()),
      /Source status becomes available/,
    );
    // The file is read once however long the dialog waited for it.
    assert(
      s.asks("snapshot.json").length <= 1,
      `snapshot.json was asked for ${s.asks("snapshot.json").length} times`,
    );
    if (sizeName === "phone") assert(await noSideScroll(s.page), "side scroll");
    // Closing it leaves the guide as it was, and the snapshot stays loaded.
    await s.page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(
      s.page.getByRole("heading", { level: 1 }).first(),
    ).toBeVisible();
    await sourcesButton(s.page).click();
    await expect(dialog.locator(".source-item").first()).toBeVisible();
    assert(s.asks("snapshot.json").length <= 1, "no second download");
    s.verify();
  });

test("with the dialog switched on, Data & sources opened from the guide when the snapshot cannot load says so and recovers", async (t) => {
  const s = await site(t, {
    data: { "snapshot.json": null },
    allow: (m) => /status of/.test(m.text()),
    dist: SOURCES_DIST,
  });
  await s.goto("?view=learn");
  await sourcesButton(s.page).click();
  const dialog = s.page.getByRole("dialog");
  await expect(dialog).toContainText(
    snapshotFailureMessage({ kind: "status", status: 404 }),
    { timeout: 60000 },
  );
  assert.doesNotMatch(
    flat(await dialog.innerText()),
    /Source status becomes available|data service|cooling down/,
  );
  s.server.setData("snapshot.json", snapshotText);
  await dialog.getByRole("button", { name: "Retry" }).click();
  await expect(
    dialog.locator(".source-item", { hasText: snapshot.sources[0].name }),
  ).toBeVisible({ timeout: 60000 });
});

test("with the dialog switched on, the sources intro of an old snapshot claims no refresh rhythm, and says what the run did only for its own snapshot", async (t) => {
  // The visitor opens a snapshot three days after it was taken.
  const old = await site(t, { at: generated + 3 * DAY, dist: SOURCES_DIST });
  await old.goto("");
  await old.ready();
  const banner = flat(await old.page.getByTestId("snapshot-line").innerText());
  assert.doesNotMatch(banner, /refreshed every few hours/);
  assert.match(banner, /3 d old/);
  await sourcesButton(old.page).click();
  const dialog = old.page.getByRole("dialog");
  const intro = dialog.locator(".intro-copy");
  await expect(intro).toContainText(
    `snapshot taken ${fullTimeLabel(snapshot.generatedAt)}`,
  );
  assert.doesNotMatch(
    flat(await intro.innerText()),
    /refreshed every few hours|refresh/i,
  );
  await expect(dialog.getByLabel("Collection run")).toBeVisible();

  // Three days older by its own time (the data is older, not the clock): its
  // intro is the same, and a status file from a later run is not shown beside it.
  const older = await site(t, {
    data: { "snapshot.json": shiftTimes(snapshotText, -3 * DAY) },
    dist: SOURCES_DIST,
  });
  await older.goto("");
  await older.ready();
  await sourcesButton(older.page).click();
  const olderDialog = older.page.getByRole("dialog");
  await expect(olderDialog.locator(".intro-copy")).toContainText(
    `snapshot taken ${fullTimeLabel(generated - 3 * DAY)}`,
  );
  assert.doesNotMatch(
    flat(await olderDialog.locator(".intro-copy").innerText()),
    /refreshed every few hours/,
  );
  await expect(olderDialog.locator(".source-item").first()).toBeVisible();
  await expect(olderDialog.getByLabel("Collection run")).toHaveCount(0);
  old.verify();
  older.verify();

  // A fresh snapshot keeps its age on the banner and still no rhythm in the intro.
  const fresh = await site(t, { dist: SOURCES_DIST });
  await fresh.goto("");
  await fresh.ready();
  await expect(fresh.page.getByTestId("snapshot-line")).toContainText(
    /\d+ min ago|just now/,
  );
  await sourcesButton(fresh.page).click();
  assert.doesNotMatch(
    flat(
      await fresh.page.getByRole("dialog").locator(".intro-copy").innerText(),
    ),
    /refreshed every few hours/,
  );
  fresh.verify();
});

test("with the dialog switched on, the Data notes do not say registry changes are detected", async (t) => {
  const s = await site(t, { dist: SOURCES_DIST });
  await s.goto("");
  await s.ready();
  await sourcesButton(s.page).click();
  const dialog = s.page.getByRole("dialog");
  const row = dialog.locator(".methodology-list > div", {
    hasText: "Registry updates",
  });
  await expect(row).toContainText(
    "This edition does not track registry changes.",
  );
  assert.doesNotMatch(
    flat(await row.innerText()),
    /detected|baseline|comparing/,
  );
  s.verify();
});

/* ── Exports ───────────────────────────────────────────────────────────── */

const shareDialog = async (page) => {
  await page.getByTestId("share-button").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Download CSV");
  return dialog;
};

test("the project CSV carries the snapshot's time and scope and no 'Current' figure", async (t) => {
  const s = await site(t);
  await s.goto("");
  await s.ready();
  const dialog = await shareDialog(s.page);
  const listed = Number(
    (await dialog.innerText())
      .match(/CSV contains ([\d,]+) /)[1]
      .replace(/,/g, ""),
  );
  const file = await downloaded(
    s.page,
    dialog.getByRole("button", { name: "Download CSV" }),
  );
  assert.equal(
    file.name,
    `hook-radar-projects-${snapshot.generatedAt.slice(0, 10)}.csv`,
  );
  const rows = parseCsv(file.text);
  const [header, ...body] = rows;
  assert.equal(body.length, listed, "every row of the view, across all pages");
  assert.deepEqual(header.slice(-2), ["Snapshot time (UTC)", "Scope"]);
  assert(header.includes("Observed 24H volume USD at snapshot"), header.join());
  assert(header.includes("Reported reserve valuation USD at snapshot"));
  assert(!header.some((name) => /^Current/.test(name)), header.join());
  const at = header.indexOf("Snapshot time (UTC)");
  const volume = header.indexOf("Observed 24H volume USD at snapshot");
  const coverage = header.indexOf("Metric coverage");
  const SCOPE =
    "Partial coverage; Not total Uniswap volume; Named projects; All networks";
  let unavailable = 0;
  for (const row of body) {
    assert.equal(row.length, header.length, row[0]);
    // The time is the snapshot's own, as published, on every row.
    assert.equal(row[at], snapshot.generatedAt, row[0]);
    assert.equal(row[at + 1], SCOPE, row[0]);
    // Unavailable stays blank; it is never turned into a zero.
    if (row[coverage] === "unavailable") {
      unavailable += 1;
      assert.equal(row[volume], "", `${row[0]} has no measurement`);
    }
  }
  // (The test data measures every project; the real data does not.)
  if (naturallyBare) assert(unavailable > 0, "unmeasured projects are listed");
  s.verify();
});

test("the CSV of a filtered watchlist says what it left out", async (t) => {
  const s = await site(t, { saved: [measured.id, GONE] });
  await s.goto("?view=watchlist");
  await s.ready();
  await s.page.getByLabel("Filter by chain").selectOption(measuredChain);
  const dialog = await shareDialog(s.page);
  await expect(dialog).toContainText(
    "1 saved project is not in this snapshot, so it is not in these files.",
  );
  const file = await downloaded(
    s.page,
    dialog.getByRole("button", { name: "Download CSV" }),
  );
  const [header, ...body] = parseCsv(file.text);
  const scope = body[0][header.indexOf("Scope")];
  assert.match(
    scope,
    /^Partial coverage; Not total Uniswap volume; Your watchlist; /,
  );
  assert.match(
    scope,
    /; 1 saved project is not in this snapshot, so it is not in these files\.$/,
  );
  // Nothing is added for a project the snapshot lacks: it is only named.
  assert(
    body.every((row) => row[0] === measured.id),
    "only the saved, carried project",
  );
  assert.equal(body.length, 1);
  // The saved entry the snapshot lacks is still saved.
  assert.deepEqual(
    await s.page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)),
      SAVED,
    ),
    [measured.id, GONE],
  );
  s.verify();
});

test("the CSV of a watchlist opened from a narrowed Discover says it was cut to that scope", async (t) => {
  // A saved project the snapshot carries but that has no measured pool: the
  // "With market data" scope leaves it out, and the file must say why.
  const s = await site(t, {
    data: { "snapshot.json": bareSnapshotText },
    saved: [measured.id, bare.id],
  });
  await s.goto("?market=observed");
  await s.ready();
  await s.page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: /Watchlist/ })
    .click();
  await expect(s.page).toHaveURL(/view=watchlist/);
  assert.equal(new URL(s.page.url()).searchParams.get("market"), "observed");
  await expect(s.page.locator("#project-index tbody tr")).toHaveCount(1);
  const dialog = await shareDialog(s.page);
  // The market-data scope holds hooks no registry names: its rows are "entries"
  // (as in the pager), not "projects".
  await expect(dialog).toContainText("CSV contains 1 entry in this view");
  const file = await downloaded(
    s.page,
    dialog.getByRole("button", { name: "Download CSV" }),
  );
  const [header, ...body] = parseCsv(file.text);
  assert.deepEqual(
    body.map((row) => row[0]),
    [measured.id],
    "the saved project with a pool; the one without is cut by the scope",
  );
  const scope = body[0][header.indexOf("Scope")];
  assert.equal(
    scope,
    "Partial coverage; Not total Uniswap volume; Your watchlist; All networks; Narrowed by scope: With market data",
  );
  // The whole Watchlist, from a link that sets no scope, says nothing of the kind.
  await s.page.goto(`${s.server.url}?view=watchlist`);
  await s.ready();
  const whole = await shareDialog(s.page);
  const all = await downloaded(
    s.page,
    whole.getByRole("button", { name: "Download CSV" }),
  );
  const [wholeHeader, ...wholeBody] = parseCsv(all.text);
  assert.deepEqual(
    wholeBody.map((row) => row[0]).sort(),
    [measured.id, bare.id].sort(),
  );
  assert.doesNotMatch(
    wholeBody[0][wholeHeader.indexOf("Scope")],
    /Narrowed by scope/,
  );
  s.verify();
});

test("the Share dialog describes the JSON file without naming a property of it", async (t) => {
  for (const size of [DESKTOP, PHONE]) {
    const s = await site(t, { size });
    await s.goto("");
    await s.ready();
    const dialog = await shareDialog(s.page);
    const notice = flat(await dialog.locator(".notice").innerText());
    assert.match(
      notice,
      /JSON is the whole snapshot, with its source freshness and the measured pools; it also lists which projects this view shows\.$/,
    );
    assert.doesNotMatch(notice, /exportedView/);
    s.verify();
  }
});

test("the CSV names the network and the filters it was cut by", async (t) => {
  const s = await site(t);
  await s.goto("?market=observed");
  await s.ready();
  await s.page.getByLabel("Filter by chain").selectOption(measuredChain);
  await s.page.getByTestId("search-input").fill(measured.name.slice(0, 4));
  await expect(s.page.locator("#project-index tbody tr").first()).toBeVisible();
  const dialog = await shareDialog(s.page);
  const file = await downloaded(
    s.page,
    dialog.getByRole("button", { name: "Download CSV" }),
  );
  const [header, ...body] = parseCsv(file.text);
  assert(body.length > 0);
  const scope = body[0][header.indexOf("Scope")];
  assert.match(scope, /; With market data; /);
  assert.match(scope, /; Filtered by search$/);
  assert(!/All networks/.test(scope), scope);
  s.verify();
});

test("the JSON button says it is the full snapshot, and the file is that snapshot", async (t) => {
  const s = await site(t, { saved: [measured.id] });
  await s.goto("?view=watchlist");
  await s.ready();
  const dialog = await shareDialog(s.page);
  const button = dialog.getByRole("button", { name: "Download JSON" });
  await expect(button).toHaveText("Download JSON (full snapshot)");
  const file = await downloaded(s.page, button);
  assert.equal(
    file.name,
    `hook-radar-snapshot-${snapshot.generatedAt.slice(0, 10)}.json`,
  );
  const json = JSON.parse(file.text);
  assert.equal(json.generatedAt, snapshot.generatedAt);
  assert.equal(json.projects.length, snapshot.projects.length);
  // The view is named inside it.
  assert.deepEqual(json.exportedView.projectIds, [measured.id]);
  s.verify();
});

/* ── A drawer ──────────────────────────────────────────────────────────── */

test("a project with no measured pool opens on its Hooks tab, and one with a pool on its Pools tab, with Back and reload", async (t) => {
  const s = await site(t, { data: { "snapshot.json": bareSnapshotText } });
  await s.goto(`?q=${encodeURIComponent(bare.name)}`);
  await s.ready();
  await s.page.getByTestId(`project-${bare.id}`).first().click();
  const drawer = s.page.locator(".project-detail");
  await expect(drawer).toBeVisible({ timeout: 30000 });
  await expect(drawer.getByRole("tab", { name: /^Hooks/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(drawer.locator(".deployment-list")).toBeVisible();
  assert.equal(new URL(s.page.url()).searchParams.get("tab"), "deployments");
  // The Pools tab is still there to open.
  await drawer.getByRole("tab", { name: /^Pools/ }).click();
  await expect(drawer.getByRole("tab", { name: /^Pools/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await drawer.getByRole("tab", { name: /^Hooks/ }).click();
  // A reload keeps what the address says; Back closes the drawer.
  await s.page.reload();
  await expect(
    s.page.locator(".project-detail").getByRole("tab", { name: /^Hooks/ }),
  ).toHaveAttribute("aria-selected", "true", { timeout: 30000 });
  await s.page.keyboard.press("Escape");
  await expect(s.page.locator(".project-detail")).toHaveCount(0);

  // A project that has a measured pool still opens on its pools.
  await s.goto(`?q=${encodeURIComponent(measured.name)}`);
  await s.ready();
  await s.page.getByTestId(`project-${measured.id}`).first().click();
  await expect(
    s.page.locator(".project-detail").getByRole("tab", { name: /^Pools/ }),
  ).toHaveAttribute("aria-selected", "true", { timeout: 30000 });
  assert.equal(new URL(s.page.url()).searchParams.get("tab"), null);
  s.verify();
});

test("a drawer opened while the snapshot cannot load offers one plain 'Try again' and recovers", async (t) => {
  const s = await site(t, {
    data: { "snapshot.json": null },
    allow: (m) => /status of/.test(m.text()),
  });
  await s.goto(`?project=${measured.id}`);
  const dialog = s.page.getByRole("dialog");
  await expect(dialog).toContainText(
    snapshotFailureMessage({ kind: "status", status: 404 }),
    { timeout: 60000 },
  );
  await expect(dialog.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: /Retry details/ }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Back to radar" }),
  ).toBeVisible();
  s.server.setData("snapshot.json", snapshotText);
  await dialog.getByRole("button", { name: "Try again" }).click();
  await expect(
    s.page.locator(".project-detail").getByRole("heading", {
      name: measured.name,
    }),
  ).toBeVisible({ timeout: 60000 });
});
