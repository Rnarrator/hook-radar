// 7D and 30D volume of the largest pools, in a real browser. Point it at an
// edition build (VITE_STATIC_EDITION=1) with RADAR_TEST_DIST; it serves that
// build next to the deterministic TEST data in tests/fixtures/static-data/data,
// with the snapshot given the source row that says the daily file exists and a
// data/daily.json built by tests/fixtures/static-data/daily-variant.mjs, through
// scripts/static-edition-server.mjs (every /api path is a 404, every request is
// recorded). No production data, no network, no service.
//
//   RADAR_TEST_DIST=work/daily-candidate/dist \
//     node --test scripts/edition-daily-browser.test.mjs
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { startStaticEditionServer } from "./static-edition-server.mjs";
import { GENERATED_AT } from "../tests/fixtures/static-data/generate.mjs";
import {
  analyticsSpanVariant,
  dailyVariant,
} from "../tests/fixtures/static-data/daily-variant.mjs";

const DIST = resolve(process.env.RADAR_TEST_DIST || "dist");
const DATA = resolve("tests/fixtures/static-data/data");
const generated = Date.parse(GENERATED_AT);
const MINUTE = 60_000;
const DESKTOP = { width: 1440, height: 1000 };
const PHONE = { width: 390, height: 844 };
const SMALL_PHONE = { width: 360, height: 800 };

const html = readFileSync(resolve(DIST, "index.html"), "utf8");
const entry =
  html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/)?.[1] ?? "";
const MOUNT =
  process.env.RADAR_TEST_MOUNT ||
  (entry.startsWith("./") ? "/" : entry.replace(/assets\/[^/]+$/, "") || "/");

const variant = dailyVariant();
const CAPTION = "Full UTC days through 27 Oct. Largest pools only.";
const NOT_COVERED =
  "Not covered: only the largest pools have 7D and 30D volume.";

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

/** A page on the edition. `daily` false serves the fixture as it is (no source
 * row); true serves the variant with its file; `daily` can also name the file's
 * answer: null (404) or a body. */
async function site(
  t,
  {
    size = DESKTOP,
    daily = true,
    source = variant,
    file = source.daily,
    timezoneId,
  } = {},
) {
  const server = await startStaticEditionServer({
    distDir: DIST,
    dataDir: DATA,
    mount: MOUNT,
  });
  if (daily) {
    server.setData("snapshot.json", JSON.stringify(source.snapshot));
    server.setData("daily.json", file);
    // A source with overview files (the Analytics page reads those).
    for (const [name, envelope] of Object.entries(source.overviews ?? {}))
      server.setData(name, JSON.stringify(envelope));
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
  const dailyRequests = () =>
    server.requests.filter((row) => /\/data\/daily\.json$/.test(row.path));
  return {
    page,
    server,
    errors,
    dailyRequests,
    goto: (query = "") => page.goto(`${server.url}${query}`),
    verify({ allow404 = false } = {}) {
      assert.deepEqual(
        errors.filter(
          (text) => !(allow404 && /Failed to load resource.*404/.test(text)),
        ),
        [],
        "console and page errors",
      );
      assert.deepEqual(server.apiRequests(), [], "requests to /api");
    },
  };
}

const ready = async (page, { phone = false } = {}) => {
  await expect(page.getByTestId("snapshot-line")).toBeVisible({
    timeout: 30000,
  });
  await expect(
    page.locator(phone ? ".mobile-projects article" : "tbody tr").first(),
  ).toBeVisible({ timeout: 30000 });
};
const switchLabels = (page) => page.locator(".window-switch button").allInnerTexts();
const pressed = (page) =>
  page.locator('.window-switch button[aria-pressed="true"]').allInnerTexts();
const row = (page, name) => page.locator("tbody tr", { hasText: name });
/** The volume cell of a table row: pools, volume, reserves are the numeric columns. */
const volumeCell = (page, name) => row(page, name).locator("td.numeric").nth(1);
const pickSpan = async (page, key) => {
  await page.locator(`.window-switch button[data-span="${key}"]`).click();
  await expect(page.getByTestId("daily-caption")).toBeVisible({ timeout: 15000 });
};

test("choosing 7D or 30D moves nothing: the switch and the page below keep their place at every width", async (t) => {
  // Wide and short windows hang the controls from the page's right edge; a line
  // that appeared under the switch once stretched them leftwards over the census
  // text and moved the switch. Now the line is always laid out.
  const sizes = [
    DESKTOP,
    { width: 1440, height: 900 },
    { width: 1280, height: 800 },
    { width: 1100, height: 800 },
    { width: 768, height: 900 },
    PHONE,
    SMALL_PHONE,
    { width: 320, height: 700 },
  ];
  for (const size of sizes) {
    const where = `${size.width}x${size.height}`;
    const s = await site(t, { size });
    await s.goto();
    await ready(s.page, { phone: size.width <= 832 });
    const places = () =>
      s.page.evaluate(() => {
        const box = (selector) => {
          const r = document.querySelector(selector)?.getBoundingClientRect();
          return r && [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 2) / 2);
        };
        return {
          switch: box(".masthead .window-switch"),
          controls: box(".masthead .title-controls"),
          strip: box(".coverage-strip"),
        };
      });
    const before = await places();
    assert.ok(before.switch && before.strip, `${where}: the switch and the status strip exist`);
    for (const key of ["d30", "d7"]) {
      await pickSpan(s.page, key);
      assert.deepEqual(await places(), before, `${where}: choosing ${key} moved something`);
    }
    await s.page.locator(".window-switch button", { hasText: "24H" }).click();
    await expect(s.page.getByTestId("daily-caption")).toBeHidden();
    assert.deepEqual(await places(), before, `${where}: going back to 24H moved something`);
    s.verify();
  }
});

test("without the source row there are no buttons, nothing is requested, a window=d7 link is dropped, and the list is as it was", async (t) => {
  const plain = await site(t, { daily: false });
  await plain.goto();
  await ready(plain.page);
  assert.deepEqual(await switchLabels(plain.page), ["1H", "6H", "24H"]);
  assert.deepEqual(await pressed(plain.page), ["24H"]);
  assert.equal(await plain.page.locator('[data-span]').count(), 0);
  assert.equal(await plain.page.getByTestId("daily-caption").count(), 0);
  assert.equal(await plain.page.getByTestId("daily-status").count(), 0);
  assert.equal(plain.dailyRequests().length, 0);
  const plainList = await plain.page.locator("#project-index").innerText();

  const link = await site(t, { daily: false });
  await link.goto("?window=d7");
  await ready(link.page);
  assert.deepEqual(await pressed(link.page), ["24H"]);
  await expect.poll(() => new URL(link.page.url()).search).toBe("");
  assert.equal(link.dailyRequests().length, 0);
  plain.verify();
  link.verify();

  // With the source row but no span chosen the list is the same words, and the
  // file is not asked for.
  const offered = await site(t);
  await offered.goto();
  await ready(offered.page);
  assert.deepEqual(await switchLabels(offered.page), ["1H", "6H", "24H", "7D", "30D"]);
  assert.deepEqual(await pressed(offered.page), ["24H"]);
  assert.equal(await offered.page.locator("#project-index").innerText(), plainList);
  assert.equal(offered.dailyRequests().length, 0, "the first load makes no request for the file");
  offered.verify();
});

test("7D: one request for the file, the figures with their marks, dashes, a real zero and the young tag; the address, a reload and Back keep it", async (t) => {
  const s = await site(t);
  await s.goto();
  await ready(s.page);
  assert.equal(s.dailyRequests().length, 0);
  await pickSpan(s.page, "d7");
  assert.equal(s.dailyRequests().length, 1);
  assert.deepEqual(await pressed(s.page), ["7D"]);
  await expect(s.page.getByTestId("daily-caption")).toHaveText(CAPTION);
  await expect(s.page.getByTestId("daily-status")).toHaveText(
    "Showing 7D volume through 27 Oct",
  );
  assert.equal(new URL(s.page.url()).search, "?window=d7");
  await expect(s.page.locator("thead th.numeric").nth(1)).toContainText("7D VOLUME");
  // Alpha: 20,000 + 5,000 + a measured zero of its three covered pools.
  await expect(volumeCell(s.page, "Alpha Markets")).toContainText("≥$25.0K");
  await expect(volumeCell(s.page, "Alpha Markets")).toContainText("through 27 Oct");
  await expect(volumeCell(s.page, "Alpha Markets").locator(".daily-figure")).toHaveAttribute(
    "title",
    /^At least \$25\.0K: the last 7 full days \(UTC\) through 27 Oct in the 3 of 4 measured pools that have daily data\./,
  );
  await expect(volumeCell(s.page, "Gamma Fee Guard")).toContainText("≥$2.3K");
  // Frontier's one pool is 3 days old.
  await expect(volumeCell(s.page, "Frontier")).toContainText("≥$450.00");
  await expect(volumeCell(s.page, "Frontier")).toContainText("since launch · 3 days");
  // No pool with a figure: a dash that says why, never a zero.
  for (const name of ["Beta Liquidity", "Delta Oracle"]) {
    const cell = volumeCell(s.page, name);
    await expect(cell.locator(".daily-figure")).toHaveAttribute("title", NOT_COVERED);
    await expect(cell.locator(".sr-only")).toHaveText(NOT_COVERED);
    assert.doesNotMatch(await cell.innerText(), /\$0/);
  }
  // The list is ranked by the figures it shows.
  const order = async () =>
    s.page.locator("tbody tr td:first-child + td, tbody tr .project-name").count().then(async () =>
      (await s.page.locator("tbody tr").allInnerTexts()).map((text) => text.trim().split("\n")[0].trim()),
    );
  const names = (await order()).map((text) => text.replace(/\s+/g, " "));
  assert.ok(names[0].includes("Alpha Markets"));
  assert.ok(names[1].includes("Gamma Fee Guard"));
  assert.ok(names[2].includes("Frontier"));
  // 30D reads the same file: no second request.
  await pickSpan(s.page, "d30");
  assert.equal(s.dailyRequests().length, 1);
  assert.equal(new URL(s.page.url()).search, "?window=d30");
  await expect(volumeCell(s.page, "Alpha Markets")).toContainText("≥$111.0K");
  await expect(s.page.locator("thead th.numeric").nth(1)).toContainText("30D VOLUME");
  await expect(s.page.getByTestId("daily-status")).toHaveText("Showing 30D volume through 27 Oct");
  // The plain windows come back, and the file is not read again.
  await s.page.locator('.window-switch button', { hasText: "24H" }).click();
  // The line stays laid out (so nothing moves) but is hidden and empty.
  await expect(s.page.getByTestId("daily-caption")).toBeHidden();
  await expect(s.page.getByTestId("daily-caption")).toHaveText("");
  assert.deepEqual(await pressed(s.page), ["24H"]);
  assert.equal(new URL(s.page.url()).search, "");
  await expect(s.page.locator("thead th.numeric").nth(1)).toContainText("24H VOLUME");
  await expect(volumeCell(s.page, "Alpha Markets")).not.toContainText("through");
  // Reload with the span in the address: the screen is reproduced.
  await s.goto("?window=d7");
  await ready(s.page);
  await expect(volumeCell(s.page, "Alpha Markets")).toContainText("≥$25.0K");
  assert.deepEqual(await pressed(s.page), ["7D"]);
  assert.equal(s.dailyRequests().length, 2, "the reload asked once more");
  s.verify();
});

test("Back and Forward keep the span across a drawer and across another page", async (t) => {
  const s = await site(t);
  await s.goto("?window=d7");
  await ready(s.page);
  await expect(volumeCell(s.page, "Alpha Markets")).toContainText("≥$25.0K");
  await s.page.getByRole("button", { name: "View Alpha Markets details" }).click();
  const drawer = s.page.locator(".project-detail");
  await expect(drawer).toBeVisible();
  await s.page.goBack();
  await expect(drawer).toHaveCount(0);
  assert.equal(new URL(s.page.url()).search, "?window=d7");
  await expect(volumeCell(s.page, "Alpha Markets")).toContainText("≥$25.0K");
  // Another page that shows spans, and back.
  await s.page.getByTestId("view-chains").click();
  await expect(s.page.getByTestId("daily-caption")).toBeVisible();
  assert.match(new URL(s.page.url()).search, /view=chains/);
  assert.match(new URL(s.page.url()).search, /window=d7/);
  await s.page.goBack();
  await ready(s.page);
  assert.deepEqual(await pressed(s.page), ["7D"]);
  assert.equal(s.dailyRequests().length, 1, "one file for the whole visit");
  s.verify();
});

test("sorting by volume ranks the figures shown, a project with none last in both directions", async (t) => {
  const s = await site(t);
  await s.goto("?window=d7");
  await ready(s.page);
  const nameOf = (text) => text.replace(/\s+/g, " ").trim();
  const ranked = async () =>
    (await s.page.locator("tbody tr").allInnerTexts()).map(
      (text) => ["Alpha Markets", "Gamma Fee Guard", "Frontier", "Beta Liquidity", "Delta Oracle"].find((n) => nameOf(text).includes(n)),
    );
  assert.deepEqual((await ranked()).slice(0, 3), ["Alpha Markets", "Gamma Fee Guard", "Frontier"]);
  // Ascending: the covered projects reverse, those with no figure stay last.
  await s.page.locator("thead th.numeric button", { hasText: "7D VOLUME" }).click();
  await expect.poll(() => new URL(s.page.url()).search).toContain("sort=volume%3Aasc");
  const ascending = await ranked();
  assert.deepEqual(ascending.slice(0, 3), ["Frontier", "Gamma Fee Guard", "Alpha Markets"]);
  assert.deepEqual([...ascending.slice(3)].sort(), ["Beta Liquidity", "Delta Oracle"]);
  s.verify();
});

test("the project drawer follows the span: its headline, a note on coverage, its pools by the figure, a real $0 beside a dash", async (t) => {
  const s = await site(t);
  await s.goto("?window=d7");
  await ready(s.page);
  await s.page.getByRole("button", { name: "View Alpha Markets details" }).click();
  const drawer = s.page.locator(".project-detail");
  await expect(drawer).toBeVisible();
  const stats = drawer.locator(".detail-stats");
  await expect(stats).toContainText("7D volume");
  await expect(stats).toContainText("≥$25.0K");
  await expect(stats).toContainText("7D covers the largest pools only: 3 of 4 measured pools here.");
  await expect(drawer.locator(".detail-scope")).toContainText("7D");
  await expect(drawer.locator(".pool-table-head")).toContainText("7D volume");
  // Pools: largest figure first, the pool without one last.
  const cards = drawer.locator(".pool-card");
  await expect(cards).toHaveCount(4);
  const first = (card) => card.locator(".pool-metric").first();
  await expect(first(cards.nth(0))).toContainText("$20.0K");
  await expect(first(cards.nth(1))).toContainText("$5.0K");
  await expect(first(cards.nth(2))).toContainText("$0");
  assert.doesNotMatch(await first(cards.nth(2)).innerText(), /—/);
  await expect(first(cards.nth(3)).locator(".daily-figure")).toHaveAttribute("title", NOT_COVERED);
  // A single pool's figure carries no "at least" mark.
  assert.doesNotMatch(await first(cards.nth(0)).innerText(), /≥/);
  // The 24H pieces of the drawer say 24H: nothing is relabelled.
  await s.page.goBack();
  await expect(drawer).toHaveCount(0);
  s.verify();
});

test("the Networks pages follow the span: the total, the networks, the chart and the rows, with a shared pool counted once per network", async (t) => {
  const s = await site(t);
  await s.goto("?view=chains&window=d7");
  await expect(s.page.getByTestId("daily-caption")).toHaveText(CAPTION, { timeout: 30000 });
  const summary = s.page.locator(".chains-summary");
  await expect(summary).toContainText("Tracked 7D volume");
  await expect(summary).toContainText("≥$27.9K");
  await expect(summary).toContainText("7 of 12 pools covered, through 27 Oct");
  await expect(s.page.locator(".chains-toolbar, .chains-workspace").first()).toContainText("7D window");
  const ledger = s.page.locator(".chains-network-row");
  const rowText = async (name) =>
    (await ledger.filter({ hasText: name }).innerText()).replace(/\s+/g, " ");
  assert.match(await rowText("Base"), /≥\$26\.6K/);
  assert.match(await rowText("Ethereum"), /≥\$800\.00/);
  assert.match(await rowText("Robinhood"), /≥\$450\.00 .*since launch · 3 days/);
  await expect(s.page.locator(".chain-chart-caption")).toContainText("Tracked 7D hook-pool volume · largest pools only");
  // The chart counts the networks that have a 7D figure; it does not say "measured".
  await expect(s.page.locator(".chain-chart-caption")).toContainText("3 of 3 with 7D volume");
  assert.doesNotMatch(await s.page.locator(".chain-chart-caption").innerText(), /measured/);
  // Project rows: figures where there are pools with them, a dash elsewhere.
  const rows = s.page.locator(".chains-protocol");
  await expect(rows.filter({ hasText: "Alpha Markets" })).toContainText("≥$25.0K");
  const betaVolume = rows
    .filter({ hasText: "Beta Liquidity" })
    .locator(".chains-protocol-metrics > div")
    .nth(2);
  await expect(betaVolume).toContainText("Tracked 7D volume");
  await expect(betaVolume).not.toContainText("≥");
  await expect(betaVolume.locator(".daily-figure")).toHaveAttribute("title", NOT_COVERED);
  // Launchpads: the same lens, on the platform rows.
  await s.page.goto(`${s.server.url}?view=chains&chain_role=launchpads&window=d7`);
  await expect(s.page.getByTestId("daily-caption")).toHaveText(CAPTION, { timeout: 30000 });
  await expect(s.page.locator(".chains-protocol").filter({ hasText: "Frontier" }).first()).toContainText("≥$450.00");
  assert.equal(s.dailyRequests().length, 2);
  s.verify();
});

test("the Networks chart says which networks have no 7D or 30D volume, and never calls them 'not measured' (their pools are measured for 24H)", async (t) => {
  const without = (prefix) => ({
    ...variant.daily,
    pools: variant.daily.pools.filter((pool) => !pool.id.startsWith(prefix)),
  });
  const s = await site(t, { file: without("robinhood:") });
  for (const [span, label] of [["d7", "7D"], ["d30", "30D"]]) {
    await s.goto(`?view=chains&window=${span}`);
    await expect(s.page.getByTestId("daily-caption")).toBeVisible({ timeout: 30000 });
    const caption = s.page.locator(".chain-chart-caption");
    await expect(caption).toContainText(`2 of 3 with ${label} volume`);
    assert.doesNotMatch(await caption.innerText(), /measured/);
    const chart = s.page.locator(".chain-chart-networks");
    const robinhood = chart.locator("li", { hasText: "Robinhood" });
    await expect(robinhood).toContainText(`no ${label} volume`);
    await expect(robinhood.locator("button")).toHaveAttribute("data-state", "unavailable");
    await expect(robinhood.locator("button")).toHaveAttribute("aria-label", new RegExp(`tracked ${label} hook-pool volume`));
    assert.doesNotMatch(await chart.innerText(), /not measured/);
    // The pools of the networks that do have a figure are listed as before.
    await expect(chart.locator("li", { hasText: "Base" })).toContainText("≥$");
  }
  // The 24H view of the same snapshot still calls it measured, as before.
  await s.goto("?view=chains");
  await expect(s.page.locator(".chain-chart-caption")).toContainText("of 3 measured", { timeout: 30000 });
  await expect(s.page.locator(".chain-chart-networks")).toContainText("not measured");
  s.verify();

  // A file none of whose pools is in the snapshot: no network has a figure.
  const nowhere = {
    ...variant.daily,
    pools: [{ id: `ethereum:0x${"f".repeat(64)}`, v7: 100, v30: 100, at: "2026-10-28T00:10:00.000Z" }],
  };
  const none = await site(t, { file: nowhere });
  await none.goto("?view=chains&window=d7");
  await expect(none.page.getByTestId("daily-caption")).toBeVisible({ timeout: 30000 });
  const empty = none.page.locator(".chain-chart-empty");
  await expect(empty).toContainText("No 7D volume");
  await expect(empty).toContainText("None of the 3 networks has a 7D figure for any of its largest pools");
  await expect(empty).toContainText("Unavailable is not zero.");
  await expect(none.page.locator(".chain-chart-networks")).toHaveCount(0);
  assert.doesNotMatch(await empty.innerText(), /current|measurement/);
  none.verify();
});

test("while the file loads the figures are ellipses, never the 24H figure under a 7D label", async (t) => {
  const s = await site(t);
  let release;
  const held = new Promise((resolveHeld) => (release = resolveHeld));
  await s.page.route("**/data/daily.json*", async (route) => {
    await held;
    await route.continue();
  });
  await s.goto("?window=d7");
  await ready(s.page);
  const cell = volumeCell(s.page, "Alpha Markets");
  await expect(cell.locator('.daily-figure[aria-busy="true"]')).toBeVisible();
  assert.doesNotMatch(await cell.innerText(), /\$2\.4K|\$25\.0K/);
  await expect(s.page.getByTestId("daily-status")).toHaveText("Loading 7D volume");
  await expect(s.page.locator("article.metric").filter({ hasText: "7D" })).toContainText("…");
  release();
  await expect(cell).toContainText("≥$25.0K");
  s.verify();
});

test("a failed request shows dashes and Try again, the buttons stay, and asking again brings the figures", async (t) => {
  const s = await site(t);
  let failing = true;
  await s.page.route("**/data/daily.json*", async (route) =>
    failing ? route.fulfill({ status: 503, body: "busy" }) : route.continue(),
  );
  await s.goto("?window=d7");
  await ready(s.page);
  const caption = s.page.getByTestId("daily-caption");
  await expect(caption).toContainText("Could not load 7D and 30D volume.");
  await expect(s.page.getByTestId("daily-status")).toHaveText("Could not load 7D and 30D volume.");
  assert.deepEqual(await switchLabels(s.page), ["1H", "6H", "24H", "7D", "30D"]);
  const cell = volumeCell(s.page, "Alpha Markets");
  await expect(cell).toContainText("—");
  assert.doesNotMatch(await cell.innerText(), /\$/);
  failing = false;
  await caption.getByRole("button", { name: "Try again" }).click();
  await expect(cell).toContainText("≥$25.0K");
  await expect(caption).toHaveText(CAPTION);
  // The browser reports a 503 as a console error; nothing else is one.
  assert.deepEqual(
    s.errors.filter((text) => !/503/.test(text)),
    [],
  );
});

test("a file that is missing, not valid or too old removes the buttons, says so, and shows the plain windows", async (t) => {
  const cases = {
    "a missing file": null,
    "text that is not JSON": "<html>not the file</html>",
    "a file for another day": { ...variant.daily, through: "2026-10-20" },
    "a file of another shape": { ...variant.daily, pools: [{ id: "x" }] },
    "a file with no pool in it": { ...variant.daily, pools: [] },
  };
  for (const [label, file] of Object.entries(cases)) {
    const s = await site(t, { file });
    await s.goto("?window=d7");
    await ready(s.page);
    await expect(s.page.getByTestId("daily-caption")).toHaveText("No 7D or 30D volume in this snapshot.");
    assert.deepEqual(await switchLabels(s.page), ["1H", "6H", "24H"], label);
    assert.deepEqual(await pressed(s.page), ["24H"], label);
    await expect.poll(() => new URL(s.page.url()).search, label).toBe("");
    await expect(s.page.locator("thead th.numeric").nth(1)).toContainText("24H VOLUME");
    assert.equal(s.dailyRequests().length, 1, `${label}: asked once and not again`);
    s.verify({ allow404: file === null });
  }
});

test("Analytics shows 7D and 30D and keeps the span; Compare and the map show the plain windows only, and a link to them drops it", async (t) => {
  // The Analytics page reads the overview files, which name the daily file too.
  const s = await site(t, { source: await analyticsSpanVariant() });
  await s.goto("?window=d7");
  await ready(s.page);
  await s.page.getByTestId("view-analytics").click();
  await expect(s.page.getByTestId("analytics-volume")).toBeVisible({ timeout: 30000 });
  assert.deepEqual(
    await s.page.locator(".title-controls .window-switch button").allInnerTexts(),
    ["1H", "6H", "24H", "7D", "30D"],
  );
  assert.deepEqual(
    await s.page.locator('.title-controls .window-switch button[aria-pressed="true"]').allInnerTexts(),
    ["7D"],
  );
  assert.match(new URL(s.page.url()).search, /window=d7/);
  await s.goto("?view=compare&window=d30");
  await expect.poll(() => new URL(s.page.url()).search).not.toContain("window=");
  await s.goto("?view=map&window=d7");
  await expect.poll(() => new URL(s.page.url()).search).not.toContain("window=d7");
  assert.equal(s.dailyRequests().length >= 1, true, "the file is asked for once per page load");
  s.verify();
});

test("the CSV and JSON of a list showing 7D say so; with the plain windows they are as before", async (t) => {
  const s = await site(t);
  await s.goto("?window=d7");
  await ready(s.page);
  await s.page.getByTestId("share-button").click();
  // The modal says where the span's figures are: the JSON is the full snapshot without them.
  await expect(s.page.locator(".modal-body .notice")).toContainText("The 7D figures are in the CSV. The JSON does not include them.");
  const [csvDownload] = await Promise.all([
    s.page.waitForEvent("download"),
    s.page.getByRole("button", { name: "Download CSV" }).click(),
  ]);
  const csv = readFileSync(await csvDownload.path(), "utf8");
  const lines = csv.split("\r\n").map((line) => line.slice(1, -1).split('","'));
  assert.equal(lines[0][7], "Observed 7D volume USD (at least; full UTC days through 2026-10-27; largest pools only)");
  const alpha = lines.find((cells) => cells[0] === "alpha");
  assert.equal(alpha[7], "25000");
  assert.equal(lines.find((cells) => cells[0] === "beta")[7], "");
  assert.match(alpha.at(-1), /Daily volume: largest pools only/);
  const [jsonDownload] = await Promise.all([
    s.page.waitForEvent("download"),
    s.page.getByRole("button", { name: "Download JSON" }).click(),
  ]);
  const exported = JSON.parse(readFileSync(await jsonDownload.path(), "utf8"));
  assert.deepEqual(exported.exportedView.dailySpan, {
    span: "d7",
    through: "2026-10-27",
    scope: "Daily volume: largest pools only",
  });
  assert.equal(exported.exportedView.projectIds[0], "alpha");
  // Back to the plain window: no trace of the span in either file.
  await s.page.keyboard.press("Escape");
  await s.page.locator('.window-switch button', { hasText: "24H" }).click();
  await s.page.getByTestId("share-button").click();
  await expect(s.page.locator(".modal-body .notice")).not.toContainText("figures are in the CSV");
  const [plainCsv] = await Promise.all([
    s.page.waitForEvent("download"),
    s.page.getByRole("button", { name: "Download CSV" }).click(),
  ]);
  const plain = readFileSync(await plainCsv.path(), "utf8");
  assert.match(plain.split("\r\n")[0], /"Observed 24H volume USD at snapshot"/);
  assert.doesNotMatch(plain, /Daily volume|at least/);
  const [plainJson] = await Promise.all([
    s.page.waitForEvent("download"),
    s.page.getByRole("button", { name: "Download JSON" }).click(),
  ]);
  const plainExported = JSON.parse(readFileSync(await plainJson.path(), "utf8"));
  assert.equal("dailySpan" in plainExported.exportedView, false);
  s.verify();
});

test("keyboard and screen reader: the buttons are in the tab order, Space and Enter choose, the pressed state and the status say what is shown", async (t) => {
  const s = await site(t);
  await s.goto();
  await ready(s.page);
  const seven = s.page.locator('.window-switch button[data-span="d7"]');
  await seven.focus();
  await s.page.keyboard.press("Space");
  await expect(s.page.getByTestId("daily-caption")).toBeVisible();
  await expect(seven).toHaveAttribute("aria-pressed", "true");
  assert.equal(await s.page.evaluate(() => document.activeElement?.getAttribute("data-span")), "d7", "focus stays on the button");
  assert.equal(await s.page.getByTestId("daily-status").getAttribute("role"), "status");
  const thirty = s.page.locator('.window-switch button[data-span="d30"]');
  await s.page.keyboard.press("Tab");
  assert.equal(await s.page.evaluate(() => document.activeElement?.getAttribute("data-span")), "d30");
  await s.page.keyboard.press("Enter");
  await expect(thirty).toHaveAttribute("aria-pressed", "true");
  await expect(seven).toHaveAttribute("aria-pressed", "false");
  await expect(s.page.getByTestId("daily-status")).toHaveText("Showing 30D volume through 27 Oct");
  // The focus ring is the design system's: a visible outline on the focused button.
  const outline = await thirty.evaluate((el) => {
    el.blur();
    el.focus({ focusVisible: true });
    const style = getComputedStyle(el);
    return `${style.outlineStyle} ${style.outlineWidth}`;
  });
  assert.doesNotMatch(outline, /^none/);
  // Titles name what a button shows.
  assert.equal(await seven.getAttribute("title"), "Last 7 full days (UTC), largest pools only");
  assert.equal(await thirty.getAttribute("title"), "Last 30 full days (UTC), largest pools only");
  s.verify();
});

for (const [label, size] of [["390", PHONE], ["360", SMALL_PHONE]])
  test(`a phone ${label} px wide: five short buttons share one row, the cards carry the span, and the page does not scroll sideways`, async (t) => {
    const s = await site(t, { size });
    await s.goto("?window=d7");
    await ready(s.page, { phone: true });
    const boxes = await s.page.locator(".window-switch button").evaluateAll((buttons) =>
      buttons.map((button) => {
        const box = button.getBoundingClientRect();
        return { top: Math.round(box.top), right: Math.round(box.right), left: Math.round(box.left), width: Math.round(box.width) };
      }),
    );
    assert.equal(boxes.length, 5);
    assert.equal(new Set(boxes.map((box) => box.top)).size, 1, "one row");
    assert.ok(boxes.every((box) => box.width >= 44), "each button is wide enough to press");
    assert.ok(boxes.at(-1).right <= size.width, "inside the viewport");
    const { scrollWidth, clientWidth } = await s.page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    assert.ok(scrollWidth <= clientWidth, `no sideways scroll (${scrollWidth} > ${clientWidth})`);
    await expect(s.page.getByTestId("daily-caption")).toHaveText(CAPTION);
    const card = s.page.locator(".mobile-projects article", { hasText: "Alpha Markets" });
    await expect(card).toContainText("7D tracked volume");
    await expect(card).toContainText("≥$25.0K");
    await expect(card).toContainText("through 27 Oct");
    const beta = s.page.locator(".mobile-projects article", { hasText: "Beta Liquidity" });
    await expect(beta.locator(".daily-figure")).toHaveAttribute("title", NOT_COVERED);
    // The cards are ranked like the table.
    const heads = await s.page.locator(".mobile-projects article h3, .mobile-projects article strong").first().innerText();
    assert.ok(heads.length > 0);
    s.verify();
  });

test("at 1440 px the switch, the caption and the controls sit as designed, and no console error appears", async (t) => {
  const s = await site(t);
  await s.goto("?window=d30");
  await ready(s.page);
  const switchBox = await s.page.locator(".window-switch").boundingBox();
  const captionBox = await s.page.getByTestId("daily-caption").boundingBox();
  assert.ok(switchBox && captionBox);
  assert.ok(captionBox.y >= switchBox.y + switchBox.height - 1, "the caption is under the switch, not over it");
  assert.ok(captionBox.x + captionBox.width <= 1440);
  const { scrollWidth, clientWidth } = await s.page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  assert.ok(scrollWidth <= clientWidth);
  s.verify();
});

test("with a span chosen the page passes the accessibility rules on Discover, Networks and the drawer, on a desktop and a phone", async (t) => {
  for (const size of [DESKTOP, PHONE]) {
    const s = await site(t, { size });
    await s.goto("?window=d7");
    await ready(s.page, { phone: size === PHONE });
    await expect(s.page.getByTestId("daily-caption")).toBeVisible();
    const scan = async (where) => {
      const result = await new AxeBuilder({ page: s.page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      assert.deepEqual(
        result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`),
        [],
        `${where} at ${size.width}px`,
      );
    };
    await scan("Discover");
    await (size === PHONE
      ? s.page
          .locator(".mobile-projects article", { hasText: "Alpha Markets" })
          .getByRole("button", { name: /Explore/ })
      : s.page.getByRole("button", { name: "View Alpha Markets details" })
    ).click();
    await expect(s.page.locator(".project-detail")).toBeVisible();
    await scan("the project drawer");
    await s.page.goBack();
    await s.goto("?view=chains&window=d7");
    await expect(s.page.getByTestId("daily-caption")).toBeVisible({ timeout: 30000 });
    await scan("Networks");
    s.verify();
  }
});

test("a launchpad listing opened with a span chosen raises no error and shows no 24H figure under a 7D label", async (t) => {
  const s = await site(t);
  await s.goto("?project=bankr&window=d7");
  const drawer = s.page.locator(".project-detail");
  await expect(drawer).toBeVisible({ timeout: 30000 });
  await expect(drawer).toContainText("Bankr");
  const text = await drawer.innerText();
  assert.doesNotMatch(text, /Tracked 7D volume[\s\S]{0,40}\$\d/, "no dollar figure is invented for a platform with no measured pools");
  await s.page.goBack().catch(() => {});
  s.verify();
});
