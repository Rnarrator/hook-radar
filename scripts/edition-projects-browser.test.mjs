// The Projects page of the Auto Snapshot edition in a real browser: the tab, the
// cards, the search and the filters, the address and Back, the drawer, 7D and
// 30D, the empty and error states, the keyboard, accessibility, the phone's
// dock, and that nothing moves when a control is pressed. Point it at an edition
// build (VITE_STATIC_EDITION=1) with RADAR_TEST_DIST:
//
//   RADAR_TEST_DIST=<build> node --test scripts/edition-projects-browser.test.mjs
//
// By default it serves the deterministic TEST data in tests/fixtures/static-data/
// data (the fixture lists Alpha Markets, Frontier and the reviewed launch
// platforms), with variants made inside the test where a case needs one.
// RADAR_TEST_DATA names another data folder (a collector run); the cases that
// are about the fixture's own projects are then skipped, and the page's count,
// its quality and its layout are read from that folder's snapshot instead.
// RADAR_TEST_LIVE_DIST names a build made without VITE_STATIC_EDITION, for the
// one check that the live page keeps its tab width and its tabs.
// RADAR_TEST_SHOTS names a folder for screenshots at the three sizes.
// Nothing here writes data; no request leaves the machine.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { startStaticEditionServer } from "./static-edition-server.mjs";
import { GENERATED_AT } from "../tests/fixtures/static-data/generate.mjs";
import { dailyVariant } from "../tests/fixtures/static-data/daily-variant.mjs";
import { money } from "../src/model.ts";

const DIST = resolve(process.env.RADAR_TEST_DIST || "dist");
const LIVE = process.env.RADAR_TEST_LIVE_DIST
  ? resolve(process.env.RADAR_TEST_LIVE_DIST)
  : null;
const OWN_DATA = Boolean(process.env.RADAR_TEST_DATA);
const DATA = resolve(
  process.env.RADAR_TEST_DATA || "tests/fixtures/static-data/data",
);
const SHOTS = process.env.RADAR_TEST_SHOTS
  ? resolve(process.env.RADAR_TEST_SHOTS)
  : null;
const generated = Date.parse(GENERATED_AT);
const MINUTE = 60_000;
const DESKTOP = { width: 1440, height: 1000 };
const SHORT = { width: 1280, height: 600 };
const PHONE = { width: 390, height: 844 };
const NARROW = { width: 320, height: 700 };
const SIZES = [DESKTOP, PHONE, NARROW];

const html = readFileSync(resolve(DIST, "index.html"), "utf8");
const entry =
  html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/)?.[1] ?? "";
const MOUNT = entry.startsWith("./")
  ? "/"
  : entry.replace(/assets\/[^/]+$/, "") || "/";

const fixtureOnly = OWN_DATA
  ? "the case is about the fixture's own projects (RADAR_TEST_DATA is set)"
  : false;

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

/** A page on the edition. `snapshot` replaces the snapshot file (an object);
 * `daily` serves the variant with its daily file, which gives the 7D and 30D
 * buttons. The visitor's clock is fixed two minutes after the snapshot. */
async function site(
  t,
  { size = DESKTOP, snapshot = null, daily = false, dist = DIST, mount } = {},
) {
  const server = await startStaticEditionServer({
    distDir: dist,
    dataDir: DATA,
    mount: mount ?? MOUNT,
  });
  const variant = daily ? dailyVariant() : null;
  if (variant) {
    server.setData("snapshot.json", JSON.stringify(variant.snapshot));
    server.setData("daily.json", variant.daily);
  } else if (snapshot) server.setData("snapshot.json", JSON.stringify(snapshot));
  const context = await browser.newContext({
    viewport: size,
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "UTC",
  });
  if (!OWN_DATA) await context.clock.setFixedTime(generated + 2 * MINUTE);
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
    errors,
    variant,
    goto: async (query = "?view=projects") => {
      await page.goto(`${server.url}${query}`);
      await expect(page.getByTestId("snapshot-line")).toBeVisible({
        timeout: 30000,
      });
    },
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

const ready = async (page) => {
  await expect(page.getByTestId("projects-card").first()).toBeVisible({
    timeout: 30000,
  });
  await page.waitForTimeout(300);
};
const open = async (s, query = "?view=projects") => {
  await s.goto(query);
  await ready(s.page);
};
const flat = (text) => text.replace(/\s+/g, " ").trim();
const cardIds = (page) =>
  page
    .locator('[data-testid="projects-card"]')
    .evaluateAll((cards) => cards.map((card) => card.dataset.projectId));
const card = (page, id) =>
  page.locator(`[data-testid="projects-card"][data-project-id="${id}"]`);
const metaText = async (page) =>
  flat(await page.getByTestId("projects-meta").innerText());
const search = (url) => new URL(url).searchParams;
const resultCount = async (page) => {
  const found = (await metaText(page)).match(/^(?:(\d+) of )?(\d+) /);
  return Number(found?.[1] ?? found?.[2]);
};

/* ── The tab ───────────────────────────────────────────────────────────── */

for (const size of [DESKTOP, PHONE])
  test(`[${size.width}] Projects is a tab between Analytics and Networks; opening it sets the address, the heading, the title and the current tab, and Back returns`, async (t) => {
    const s = await site(t, { size });
    await s.goto("");
    const nav = s.page.getByRole("navigation", { name: "Main navigation" });
    const names = (await nav.getByRole("button").allInnerTexts()).map(flat);
    assert.deepEqual(names.slice(0, 4), [
      "Discover",
      "Analytics",
      "Projects",
      "Networks",
    ]);
    assert.equal(names.length, 8);
    await s.page.getByTestId("view-projects").click();
    await ready(s.page);
    assert.equal(search(s.page.url()).get("view"), "projects");
    await expect(s.page.getByTestId("view-projects")).toHaveAttribute(
      "aria-current",
      "page",
    );
    const heading = s.page.getByRole("heading", { level: 1 });
    await expect(heading).toHaveText("Projects on v4");
    await expect(heading).toBeFocused();
    await expect(s.page).toHaveTitle("Uniswap v4 projects · Hook Radar");
    await s.page.goBack();
    await expect(s.page.getByTestId("view-overview")).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(s.page.getByTestId("projects-card")).toHaveCount(0);
    await s.page.goForward();
    await ready(s.page);
    s.verify();
  });

test("the footer of the page ends with the maker's line, and the sentence under the title says what the page is and where the rest is", async (t) => {
  const s = await site(t);
  await open(s);
  const line = s.page.locator("footer.footer .footer-byline");
  await expect(line).toHaveText("Built by @0x_narrator");
  const sentence = flat(await s.page.locator(".titlebar p").first().innerText());
  assert.match(
    sentence,
    /^Who is building with v4 hooks: what each project does, where it runs and how much it trades\. Hooks with no public project behind them are in Discover \(\d[\d,]* in this snapshot\)\.$/,
  );
  // The page has the closing way into Discover and a collapsed Data notes.
  await expect(s.page.getByTestId("projects-browse-hooks")).toBeVisible();
  const notes = s.page.locator("details.projects-method");
  await expect(notes).not.toHaveAttribute("open", "");
  await notes.locator("summary").click();
  await expect(notes).toContainText("A name alone never lists a project");
  s.verify();
});

/* ── The cards ─────────────────────────────────────────────────────────── */

for (const size of SIZES)
  test(`[${size.width}] every card has a logo or the neutral mark, a name, a description and its networks, and the count matches the line above the list`, async (t) => {
    const s = await site(t, { size });
    await open(s);
    const cards = s.page.getByTestId("projects-card");
    const total = await cards.count();
    assert.ok(total > 0);
    assert.equal(await resultCount(s.page), total);
    assert.match(
      await metaText(s.page),
      new RegExp(`^${total} projects on \\d+ networks · \\d+ with tracked pools$`),
    );
    const problems = await cards.evaluateAll((list) =>
      list.flatMap((element) => {
        const name = element.querySelector(".projects-card-name");
        const logo = element.querySelector(".protocol-logo");
        const found = [];
        if (!name?.textContent.trim()) found.push("a name");
        if (!logo) found.push("a logo");
        else if (
          !logo.querySelector("img") &&
          !logo.querySelector(".protocol-logo-fallback")
        )
          found.push("a mark");
        if (!element.querySelector(".projects-card-description")?.textContent.trim())
          found.push("a description");
        if (!element.querySelector(".projects-card-network-names")?.textContent.trim())
          found.push("a network");
        return found.map((what) => `${element.dataset.projectId}: no ${what}`);
      }),
    );
    assert.deepEqual(problems, []);
    // The logo's tooltip never calls the neutral mark official.
    const fallbacks = await s.page
      .locator(".projects-card .protocol-logo.unavailable")
      .evaluateAll((list) => list.map((element) => element.title));
    for (const title of fallbacks) {
      assert.match(title, /no verified protocol logo/);
      assert.doesNotMatch(title, /official/);
    }
    s.verify();
  });

test("the cards are in tracked-volume order with nothing measured last; ≥ marks a sum, a dash is not a zero, Frontier carries its scope note", { skip: fixtureOnly }, async (t) => {
  const s = await site(t);
  await open(s);
  const ids = await cardIds(s.page);
  assert.equal(ids[0], "alpha", "the only project with a volume is first");
  const alpha = flat(await card(s.page, "alpha").innerText());
  assert.match(alpha, new RegExp(`Tracked 24H volume ≥${money(3300).replace("$", "\\$")} `));
  assert.match(alpha, /Pools in snapshot ≥\d+/);
  assert.match(alpha, /Reported reserves ≥\$/);
  // Frontier has pools in the snapshot and no priced volume: ≥ pools, a dash.
  const frontier = flat(await card(s.page, "frontier").innerText());
  assert.match(frontier, /Tracked 24H volume — Pools in snapshot ≥1 Reported reserves —/);
  assert.match(frontier, /Counts trades in its Uniswap v4 pools only/);
  // A project with nothing measured says so and has no readout.
  const bags = card(s.page, "bags");
  await expect(bags).toContainText("Not measured in this snapshot");
  await expect(bags.locator("dl")).toHaveCount(0);
  // A card with a volume comes before every card without one; nothing is pinned.
  const hasVolume = await s.page.locator('[data-testid="projects-card"]').evaluateAll((list) =>
    list.map((element) => /^≥?\$\d/.test(element.querySelector(".projects-figures dd")?.textContent ?? "")),
  );
  assert.equal(hasVolume[0], true);
  assert.deepEqual(hasVolume, [...hasVolume].sort((a, b) => Number(b) - Number(a)), "a volume first");
  assert.ok(ids.indexOf("frontier") > 0, "Frontier is not placed first");
  s.verify();
});

test("a measured zero is shown as $0 and a dash stays a dash", { skip: fixtureOnly }, async (t) => {
  const snapshot = JSON.parse(readFileSync(resolve(DATA, "snapshot.json"), "utf8"));
  for (const pool of snapshot.pools)
    if (pool.projectId === "alpha")
      Object.assign(pool, { volumeUsd: { h1: 0, h6: 0, h24: 0 } });
  const s = await site(t, { snapshot });
  await open(s);
  const alpha = flat(await card(s.page, "alpha").innerText());
  assert.match(alpha, /Tracked 24H volume ≥\$0 /);
  const frontier = flat(await card(s.page, "frontier").innerText());
  assert.match(frontier, /Tracked 24H volume —/);
  s.verify();
});

test("a link of a card opens in a new window with no opener and names its project; a project with none has no link", { skip: fixtureOnly }, async (t) => {
  const s = await site(t);
  await open(s);
  const links = s.page.locator(".projects-card-links a");
  const total = await links.count();
  assert.ok(total > 0);
  const found = await links.evaluateAll((list) =>
    list.map((a) => ({
      href: a.href,
      target: a.target,
      rel: a.rel,
      name: a.textContent.replace(/\s+/g, " ").trim(),
    })),
  );
  for (const link of found) {
    assert.match(link.href, /^https:/);
    assert.equal(link.target, "_blank");
    assert.equal(link.rel, "noopener noreferrer");
    assert.match(link.name, /^(Website|Docs) of .+/);
  }
  // A project the snapshot gives no website or documentation has no link: the
  // card has exactly the links its project has.
  const snapshot = JSON.parse(readFileSync(resolve(DATA, "snapshot.json"), "utf8"));
  const own = snapshot.projects.filter((project) => project.entityType !== "platform");
  assert.ok(own.length > 0);
  for (const project of own) {
    const expected = [project.website, project.docs].filter(
      (link) => link && link.startsWith("https:"),
    ).length;
    if ((await card(s.page, project.id).count()) === 0) continue;
    assert.equal(await card(s.page, project.id).locator("a").count(), expected, project.id);
  }
  // A project that has no site and no documentation shows no link at all.
  const bare = snapshot.projects.find(
    (project) => project.entityType !== "platform" && !project.website && !project.docs,
  );
  if (bare && (await card(s.page, bare.id).count()))
    assert.equal(await card(s.page, bare.id).locator("a").count(), 0);
  s.verify();
});

/* ── Search, filters, order and the address ────────────────────────────── */

test("the search, the use case, the network and the order change the list and the address, and Back undoes a choice", async (t) => {
  const s = await site(t);
  await open(s);
  const everyone = await cardIds(s.page);
  const total = everyone.length;
  // A search narrows the list and is kept by replacement, not as a step.
  const history = await s.page.evaluate(() => history.length);
  await s.page.getByTestId("projects-search").fill("ba");
  await expect.poll(() => cardIds(s.page).then((ids) => ids.length)).toBeLessThan(total);
  assert.equal(search(s.page.url()).get("projects_q"), "ba");
  assert.equal(await s.page.evaluate(() => history.length), history);
  const narrowed = await cardIds(s.page);
  assert.ok(narrowed.length > 0);
  assert.match(await metaText(s.page), new RegExp(`^${narrowed.length} of ${total} projects`));
  await expect(s.page.getByTestId("projects-clear")).toBeVisible();
  // Use case.
  await s.page.getByTestId("projects-search").fill("");
  await expect.poll(() => cardIds(s.page).then((ids) => ids.length)).toBe(total);
  await s.page.getByTestId("projects-use").selectOption("launchpads");
  await expect.poll(() => search(s.page.url()).get("projects_use")).toBe("launchpads");
  const launchpads = await cardIds(s.page);
  assert.ok(launchpads.length > 0 && launchpads.length <= total);
  assert.match(await metaText(s.page), /· Launchpads$/);
  // Network: the figures are the network's own.
  await s.page.getByTestId("projects-network").selectOption("base");
  await expect.poll(() => search(s.page.url()).get("projects_network")).toBe("base");
  const onBase = await cardIds(s.page);
  assert.ok(onBase.length > 0);
  assert.match(await metaText(s.page), /· Launchpads · Base$/);
  // Order.
  await s.page.getByTestId("projects-sort").selectOption("name");
  await expect.poll(() => search(s.page.url()).get("projects_sort")).toBe("name");
  const named = await s.page
    .locator('[data-testid="projects-card"] .projects-card-name')
    .evaluateAll((list) => list.map((element) => element.textContent.trim()));
  const sorted = [...named].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(named, sorted, "Name A–Z");
  // Back undoes one choice at a time.
  await s.page.goBack();
  assert.equal(search(s.page.url()).get("projects_sort"), null);
  await expect(s.page.getByTestId("projects-sort")).toHaveValue("volume");
  await s.page.goBack();
  assert.equal(search(s.page.url()).get("projects_network"), null);
  await expect(s.page.getByTestId("projects-network")).toHaveValue("all");
  await s.page.goBack();
  await expect(s.page.getByTestId("projects-use")).toHaveValue("all");
  await expect.poll(() => cardIds(s.page).then((ids) => ids.length)).toBe(total);
  // Clear filters puts everything back in one step and moves focus to the search.
  await s.page.getByTestId("projects-network").selectOption("base");
  await s.page.getByTestId("projects-search").fill("a");
  await s.page.getByTestId("projects-clear").click();
  await expect(s.page.getByTestId("projects-search")).toHaveValue("");
  await expect(s.page.getByTestId("projects-search")).toBeFocused();
  await expect(s.page.getByTestId("projects-network")).toHaveValue("all");
  await expect(s.page.getByTestId("projects-clear")).toBeHidden();
  s.verify();
});

test("a link keeps the scope: reloading restores the search, the use case, the network and the order", async (t) => {
  const s = await site(t);
  await open(
    s,
    "?view=projects&projects_q=a&projects_use=launches&projects_network=base&projects_sort=name",
  );
  await expect(s.page.getByTestId("projects-search")).toHaveValue("a");
  await expect(s.page.getByTestId("projects-use")).toHaveValue("launches");
  await expect(s.page.getByTestId("projects-network")).toHaveValue("base");
  await expect(s.page.getByTestId("projects-sort")).toHaveValue("name");
  const before = await cardIds(s.page);
  await s.page.reload();
  await ready(s.page);
  assert.deepEqual(await cardIds(s.page), before);
  const query = search(s.page.url());
  for (const [key, value] of [
    ["view", "projects"],
    ["projects_q", "a"],
    ["projects_use", "launches"],
    ["projects_network", "base"],
    ["projects_sort", "name"],
  ])
    assert.equal(query.get(key), value, key);
  // Another page carries none of it.
  await s.page.getByTestId("view-chains").click();
  await expect(s.page.getByRole("heading", { level: 1 })).toHaveText(
    "Explore by network",
  );
  assert.doesNotMatch(s.page.url(), /projects_/);
  // And back on the tab it is as it was.
  await s.page.getByTestId("view-projects").click();
  await ready(s.page);
  await expect(s.page.getByTestId("projects-search")).toHaveValue("a");
  s.verify();
});

test("nothing that matches offers a way out and a way on to Discover; an unknown network is not found", async (t) => {
  const s = await site(t);
  await s.goto("?view=projects&projects_q=zzzzqq");
  await expect(s.page.getByRole("heading", { level: 2, name: "No project matches" })).toBeVisible();
  await expect(s.page.getByText("A hook with no named project behind it is in Discover.")).toBeVisible();
  await expect(s.page.getByTestId("projects-card")).toHaveCount(0);
  // The empty state keeps the toolbar and the line where they are.
  await expect(s.page.getByTestId("projects-search")).toBeVisible();
  await s.page.getByRole("button", { name: "Search Discover for “zzzzqq”" }).click();
  await expect(s.page.getByRole("heading", { level: 1 })).toHaveText("Uniswap v4 hooks");
  assert.equal(search(s.page.url()).get("q"), "zzzzqq");
  assert.equal(search(s.page.url()).get("view"), null);
  // Clear filters from the empty state.
  await s.goto("?view=projects&projects_q=zzzzqq");
  await expect(s.page.getByRole("heading", { level: 2, name: "No project matches" })).toBeVisible();
  await s.page.getByRole("button", { name: "Clear filters" }).first().click();
  await ready(s.page);
  // An unknown network in a link.
  await s.goto("?view=projects&projects_network=nowhere");
  await expect(s.page.getByRole("heading", { level: 2, name: "Network not found" })).toBeVisible();
  await s.page.getByRole("button", { name: "All networks" }).click();
  await ready(s.page);
  assert.equal(search(s.page.url()).get("projects_network"), null);
  s.verify();
});

test("the window switch keeps working: 1H and 6H change the figures' label and the address", async (t) => {
  const s = await site(t);
  await open(s);
  for (const [label, key] of [["1H", "h1"], ["6H", "h6"]]) {
    await s.page.locator(".window-switch button", { hasText: label }).click();
    assert.equal(search(s.page.url()).get("window"), key);
    await expect(s.page.locator(".projects-figures dt").first()).toHaveText(
      `Tracked ${label} volume`,
    );
  }
  await s.page.locator(".window-switch button", { hasText: "24H" }).click();
  assert.equal(search(s.page.url()).get("window"), null);
  s.verify();
});

/* ── 7D and 30D ────────────────────────────────────────────────────────── */

test("7D and 30D are on the page: the figure is at least, a young pool counts from its launch, nothing measured stays a dash", { skip: fixtureOnly }, async (t) => {
  const s = await site(t, { daily: true });
  await open(s);
  for (const [span, label, alphaUsd] of [
    ["d7", "7D", 25000],
    ["d30", "30D", 111000],
  ]) {
    await s.page.locator(`.window-switch button[data-span="${span}"]`).click();
    await expect(s.page.getByTestId("daily-caption")).toBeVisible({ timeout: 15000 });
    assert.equal(search(s.page.url()).get("window"), span);
    assert.equal(search(s.page.url()).get("view"), "projects");
    await expect(s.page.locator(".projects-figures dt").first()).toHaveText(
      `Tracked ${label} volume`,
    );
    await expect(card(s.page, "alpha").locator(".daily-value")).toHaveText(
      `≥${money(alphaUsd)}`,
    );
    // Frontier's one pool is three days old: its figure counts from launch.
    await expect(card(s.page, "frontier").locator(".projects-figures-note")).toHaveText(
      "since launch · 3 days",
    );
    // A card with no daily figure has a dash and no line.
    const bags = card(s.page, "bags");
    await expect(bags).toContainText("Not measured in this snapshot");
    await expect(s.page.getByTestId("daily-caption")).toContainText("Full UTC days through 27 Oct");
  }
  // The span survives a reload; the other windows leave it.
  await s.page.reload();
  await ready(s.page);
  await expect(s.page.locator(".window-switch button[data-span='d30']")).toHaveAttribute("aria-pressed", "true");
  await s.page.locator(".window-switch button", { hasText: "24H" }).click();
  assert.equal(search(s.page.url()).get("window"), null);
  await expect(card(s.page, "frontier").locator(".projects-figures-note")).toHaveText("");
  s.verify();
});

/* ── The drawer ────────────────────────────────────────────────────────── */

test("a card opens the project's drawer; Escape, Back and the close button return to the same list, and a reload reopens it", async (t) => {
  const s = await site(t);
  await open(s, "?view=projects&projects_sort=name");
  const ids = await cardIds(s.page);
  const id = OWN_DATA ? ids[0] : "alpha";
  const name = card(s.page, id).locator(".projects-card-name");
  await name.click();
  await expect(s.page.getByRole("dialog")).toBeVisible({ timeout: 15000 });
  assert.equal(search(s.page.url()).get("project"), id);
  assert.equal(search(s.page.url()).get("view"), "projects");
  assert.equal(search(s.page.url()).get("projects_sort"), "name");
  // Escape closes it, with Back-equivalent history, and the card has focus again.
  await s.page.keyboard.press("Escape");
  await expect(s.page.getByRole("dialog")).toHaveCount(0);
  assert.equal(search(s.page.url()).get("project"), null);
  await expect(name).toBeFocused();
  // Back closes it too, to the same filters.
  await name.click();
  await expect(s.page.getByRole("dialog")).toBeVisible();
  await s.page.goBack();
  await expect(s.page.getByRole("dialog")).toHaveCount(0);
  assert.equal(search(s.page.url()).get("projects_sort"), "name");
  assert.deepEqual(await cardIds(s.page), ids);
  // A reload on the drawer's address reopens it over the list.
  await name.click();
  await expect(s.page.getByRole("dialog")).toBeVisible();
  await s.page.reload();
  await expect(s.page.getByRole("dialog")).toBeVisible({ timeout: 30000 });
  assert.equal(search(s.page.url()).get("project"), id);
  await s.page.keyboard.press("Escape");
  await expect(s.page.getByRole("dialog")).toHaveCount(0);
  await expect(s.page.getByTestId("projects-card").first()).toBeVisible();
  s.verify();
});

test("the whole card is the target of its name: pressing its empty corner opens it, and the links above it still open theirs", { skip: fixtureOnly }, async (t) => {
  const s = await site(t);
  await open(s);
  const target = card(s.page, "alpha");
  const box = await target.boundingBox();
  await s.page.mouse.click(box.x + box.width - 12, box.y + box.height - 12);
  await expect(s.page.getByRole("dialog")).toBeVisible({ timeout: 15000 });
  assert.equal(search(s.page.url()).get("project"), "alpha");
  await s.page.keyboard.press("Escape");
  // A link is above the stretched name: the pointer lands on it, not on the name.
  const link = s.page.locator(".projects-card-links a").first();
  const where = await link.boundingBox();
  const topmost = await s.page.evaluate(
    ([x, y]) => document.elementFromPoint(x, y)?.closest("a")?.className ?? "",
    [where.x + where.width / 2, where.y + where.height / 2],
  );
  assert.match(topmost, /external/);
  s.verify();
});

/* ── Keyboard, focus and accessibility ─────────────────────────────────── */

test("the keyboard walks the search, the three selects, then each card's name and its links, and the card shows a ring", async (t) => {
  const s = await site(t);
  await open(s);
  const order = await s.page.evaluate(() =>
    [
      ...document.querySelectorAll(
        '[data-testid="projects-page"] :is(input, select, button, a[href])',
      ),
    ]
      .filter((element) => element.getClientRects().length > 0 && !element.closest("[aria-hidden='true']"))
      .map((element) =>
        element.matches("input")
          ? "search"
          : element.matches("select")
            ? element.dataset.testid
            : element.matches(".projects-card-name")
              ? `name:${element.closest("[data-project-id]").dataset.projectId}`
              : `link:${element.textContent.trim().split(" ")[0]}`,
      ),
  );
  assert.deepEqual(order.slice(0, 4), [
    "search",
    "projects-use",
    "projects-network",
    "projects-sort",
  ]);
  assert.match(order[4], /^name:/);
  await s.page.getByTestId("projects-search").focus();
  const walked = [];
  for (let i = 0; i < 12; i += 1) {
    await s.page.keyboard.press("Tab");
    walked.push(
      await s.page.evaluate(() => {
        const element = document.activeElement;
        return element.matches("select")
          ? element.dataset.testid
          : element.matches(".projects-card-name")
            ? `name:${element.closest("[data-project-id]").dataset.projectId}`
            : element.matches("a")
              ? `link:${element.textContent.trim().split(" ")[0]}`
              : element.tagName.toLowerCase();
      }),
    );
  }
  assert.deepEqual(walked, order.slice(1, 13));
  // A card that has the keyboard shows a ring on the card, not only on its name.
  await s.page.getByTestId("projects-sort").focus();
  await s.page.keyboard.press("Tab");
  const ring = await s.page.evaluate(() => {
    const style = getComputedStyle(document.activeElement.closest(".projects-card"));
    return [style.outlineStyle, style.outlineWidth];
  });
  assert.deepEqual(ring, ["solid", "2px"]);
  // Enter on the name opens the drawer.
  await s.page.keyboard.press("Enter");
  await expect(s.page.getByRole("dialog")).toBeVisible({ timeout: 15000 });
  await s.page.keyboard.press("Escape");
  s.verify();
});

for (const size of [DESKTOP, PHONE])
  test(`[${size.width}] no serious accessibility violation on the Projects page, and every control is a big enough target`, async (t) => {
    const s = await site(t, { size });
    await open(s);
    await s.page.waitForTimeout(500);
    const result = await new AxeBuilder({ page: s.page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    const serious = result.violations.filter((violation) =>
      ["serious", "critical"].includes(violation.impact),
    );
    assert.deepEqual(
      serious.map((v) => `${v.id}: ${v.nodes[0].target.join(" ")}`),
      [],
    );
    // Targets: 24px for every control, 44px high for the toolbar and the tabs
    // on a phone (the name's target is its whole card).
    const small = await s.page.evaluate(() => {
      const found = [];
      for (const element of document.querySelectorAll(
        '[data-testid="projects-page"] :is(input, select, button, a[href])',
      )) {
        if (element.closest("[aria-hidden='true']")) continue;
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        if (element.matches(".projects-card-name")) {
          const cardBox = element.closest(".projects-card").getBoundingClientRect();
          if (cardBox.height < 44 || cardBox.width < 44) found.push("name");
          continue;
        }
        if (rect.width < 24 || rect.height < 24)
          found.push(`${element.textContent.trim() || element.tagName}: ${rect.width}x${rect.height}`);
      }
      return found;
    });
    assert.deepEqual(small, []);
    const primary = await s.page.evaluate(() =>
      [
        ".projects-search",
        ".projects-toolbar .select-control",
        ...(innerWidth <= 960 ? [".topbar nav button"] : []),
      ].flatMap((selector) =>
        [...document.querySelectorAll(selector)].map((element) => {
          const rect = element.getBoundingClientRect();
          return rect.height < 44 || rect.width < 44
            ? `${selector}: ${rect.width}x${rect.height}`
            : null;
        }),
      ).filter(Boolean),
    );
    assert.deepEqual(primary, []);
    s.verify();
  });

/* ── Nothing moves ─────────────────────────────────────────────────────── */

const round = (n) => Math.round(n * 100) / 100;
/** Where the page's own controls and lines are (page coordinates), and the
 * height of every card by its project. */
const layout = (page) =>
  page.evaluate(() => {
    const box = (element) => {
      if (!element) return null;
      const r = element.getBoundingClientRect();
      return [r.x + scrollX, r.y + scrollY, r.width, r.height].map(
        (n) => Math.round(n * 100) / 100,
      );
    };
    const one = (selector) => box(document.querySelector(selector));
    // The cards of a row are stretched to end on one line, so a card's own
    // height is read with the rows left alone for a moment: what each card needs
    // for its content must not change with the order or the window.
    const grid = document.querySelector(".projects-grid");
    const stretch = grid?.style.alignItems ?? "";
    if (grid) grid.style.alignItems = "start";
    const cards = Object.fromEntries(
      [...document.querySelectorAll('[data-testid="projects-card"]')].map(
        (element) => [element.dataset.projectId, box(element)[3]],
      ),
    );
    if (grid) grid.style.alignItems = stretch;
    return {
      search: one(".projects-search"),
      use: one(".projects-use"),
      network: one(".projects-network"),
      sort: one(".projects-sort"),
      meta: one(".projects-meta p"),
      clear: one(".projects-meta button"),
      switch: one(".title-controls .window-switch"),
      share: one(".title-controls .share-button"),
      caption: one(".title-controls .daily-caption"),
      titlebar: one(".titlebar"),
      cards,
      overflow: document.documentElement.scrollWidth - innerWidth,
    };
  });
const FIXED = [
  "search",
  "use",
  "network",
  "sort",
  "meta",
  "clear",
  "switch",
  "share",
  "caption",
  "titlebar",
];
const assertFixed = (before, after, where) => {
  for (const key of FIXED)
    assert.deepEqual(after[key], before[key], `${where}: ${key} moved`);
  assert.ok(after.overflow <= 0, `${where}: the page is wider than the window`);
};

for (const size of SIZES)
  test(`[${size.width}] pressing a control moves no other control: the toolbar, the line, the title controls and every card's height stay put through search, filters, order, the window and Clear`, { skip: fixtureOnly }, async (t) => {
    const s = await site(t, { size, daily: true });
    await open(s);
    const start = await layout(s.page);
    assert.ok(start.overflow <= 0, "no sideways scroll at the start");
    // The window first: 24H -> 7D -> 30D -> 1H -> 6H -> 24H. Each card keeps its
    // own height, as layout() reads it (the order may change, and a row stretches its
    // cards to end together, but what a card needs for its content does not).
    for (const label of ["7D", "30D", "1H", "6H", "24H"]) {
      await s.page.locator(".window-switch button", { hasText: new RegExp(`^${label}$`) }).click();
      await s.page.waitForTimeout(300);
      if (label === "7D" || label === "30D")
        await expect(s.page.getByTestId("daily-caption")).toBeVisible({ timeout: 15000 });
      const now = await layout(s.page);
      assertFixed(start, now, `window ${label}`);
      assert.deepEqual(
        Object.keys(now.cards).sort(),
        Object.keys(start.cards).sort(),
        `window ${label}: the same cards`,
      );
      for (const [id, height] of Object.entries(start.cards))
        assert.equal(now.cards[id], height, `window ${label}: ${id} changed height`);
    }
    // Typing a query that still matches, then each select, then Clear.
    const steps = [
      ["type", async () => s.page.getByTestId("projects-search").fill("a")],
      ["use case", async () => s.page.getByTestId("projects-use").selectOption("launches")],
      ["network", async () => s.page.getByTestId("projects-network").selectOption("base")],
      ["sort", async () => s.page.getByTestId("projects-sort").selectOption("name")],
      ["clear", async () => s.page.getByTestId("projects-clear").click()],
    ];
    for (const [name, act] of steps) {
      await act();
      await s.page.waitForTimeout(300);
      assertFixed(start, await layout(s.page), name);
    }
    // The list is whole again, and so is every card.
    const end = await layout(s.page);
    assert.deepEqual(end.cards, start.cards);
    s.verify();
  });

for (const size of [DESKTOP, PHONE, { width: 768, height: 900 }, { width: 844, height: 390 }])
  test(`[${size.width}x${size.height}] the toolbar keeps its layout and fits the window`, async (t) => {
    const s = await site(t, { size });
    await open(s);
    const result = await s.page.evaluate(() => {
      const box = (selector) => {
        const r = document.querySelector(selector).getBoundingClientRect();
        return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, w: r.width, h: r.height };
      };
      return {
        search: box(".projects-search"),
        use: box(".projects-use"),
        network: box(".projects-network"),
        sort: box(".projects-sort"),
        width: innerWidth,
        overflow: document.documentElement.scrollWidth - innerWidth,
      };
    });
    assert.ok(result.overflow <= 0);
    for (const key of ["search", "use", "network", "sort"]) {
      assert.ok(result[key].x >= 0 && result[key].right <= result.width, `${key} is in the window`);
      assert.ok(result[key].h >= 43.5, `${key} is a 44px control`);
    }
    // Wide: one row. Up to 60rem: the search on its own row and the selects
    // below it. A phone: two selects side by side and the sort under them.
    if (size.width > 960)
      assert.ok(Math.abs(result.search.y - result.sort.y) < 1, "one row");
    else {
      assert.ok(result.use.y > result.search.bottom - 1, "the selects are under the search");
      if (size.width > 640)
        assert.ok(Math.abs(result.use.y - result.sort.y) < 1, "three selects in a row");
      else {
        assert.ok(Math.abs(result.use.y - result.network.y) < 1, "use case and network side by side");
        assert.ok(result.sort.y > result.use.bottom - 1, "the sort has its own row");
      }
    }
    // A longer selected label does not resize a control.
    const before = result.network.w;
    await s.page.getByTestId("projects-network").selectOption({ index: 1 });
    const after = await s.page.evaluate(
      () => document.querySelector(".projects-network").getBoundingClientRect().width,
    );
    assert.equal(round(after), round(before));
    s.verify();
  });

// What a visitor is likely to paste into the search: a hook's address, a
// transaction or pool hash, or a very long word. None has a place to break.
const PASTED = [
  ["an address", "0x2b21c65d9a7dc6926ee330a1c6e5a8037fd81774"],
  ["a hash", `0x${"ab12cd34".repeat(8)}`],
  ["a word with no break", "q".repeat(125)],
];

for (const size of [DESKTOP, { width: 1024, height: 800 }, { width: 768, height: 900 }, PHONE, NARROW])
  for (const [what, pasted] of PASTED)
    test(`[${size.width}] ${what} pasted into the search leaves the toolbar, the line and the page where they were, and the empty state inside the window`, async (t) => {
      const s = await site(t, { size });
      await open(s);
      const start = await layout(s.page);
      assert.ok(start.overflow <= 0, "no sideways scroll at the start");
      await s.page.getByTestId("projects-search").fill(pasted);
      await expect(
        s.page.getByRole("heading", { level: 2, name: "No project matches" }),
      ).toBeVisible();
      await s.page.waitForTimeout(300);
      // The toolbar, the line above the list and the title controls did not move,
      // and the page is not wider than the window (assertFixed checks both).
      assertFixed(start, await layout(s.page), `${what} pasted`);
      // Everything the empty state shows is inside the window: its sentence, the
      // heading and both buttons, the one that carries the text to Discover too.
      const inside = await s.page.evaluate(() => {
        const empty = document.querySelector(".projects-page .empty-state");
        const out = [];
        for (const element of [empty, ...empty.querySelectorAll("*")]) {
          const r = element.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          out.push({
            tag: element.tagName.toLowerCase(),
            left: r.left,
            right: r.right,
          });
        }
        const toolbar = [".projects-search", ".projects-use", ".projects-network", ".projects-sort"].map((selector) => {
          const r = document.querySelector(selector).getBoundingClientRect();
          return { selector, left: r.left, right: r.right };
        });
        return { out, toolbar, width: document.documentElement.clientWidth };
      });
      assert.ok(inside.out.length >= 4, "the empty state has its parts");
      for (const part of [...inside.out, ...inside.toolbar])
        assert.ok(
          part.left >= -0.5 && part.right <= inside.width + 0.5,
          `${part.tag ?? part.selector} runs from ${Math.round(part.left)} to ${Math.round(part.right)} in a ${inside.width}px window`,
        );
      // The button still does what it says, with the whole text.
      await s.page
        .getByRole("button", { name: `Search Discover for “${pasted}”` })
        .click();
      await expect(s.page.getByRole("heading", { level: 1 })).toHaveText("Uniswap v4 hooks");
      assert.equal(search(s.page.url()).get("q"), pasted);
      s.verify();
    });

for (const size of [DESKTOP, { width: 1920, height: 1000 }, { width: 1024, height: 800 }, { width: 768, height: 900 }])
  test(`[${size.width}] the cards of a row end on one line, and their links line up`, async (t) => {
    const s = await site(t, { size });
    await open(s);
    const rows = await s.page.evaluate(() => {
      const found = new Map();
      for (const element of document.querySelectorAll('[data-testid="projects-card"]')) {
        const r = element.getBoundingClientRect();
        const links = element.querySelector(".projects-card-links").getBoundingClientRect();
        const key = Math.round(r.top + scrollY);
        if (!found.has(key)) found.set(key, []);
        found.get(key).push({
          id: element.dataset.projectId,
          bottom: Math.round((r.bottom + scrollY) * 10) / 10,
          linksBottom: Math.round((links.bottom + scrollY) * 10) / 10,
        });
      }
      return [...found.values()];
    });
    const crowded = rows.filter((row) => row.length >= 2);
    assert.ok(crowded.length >= 1, "the list has a row of two cards or more at this width");
    for (const row of crowded) {
      const ids = row.map((card) => card.id).join(", ");
      assert.equal(new Set(row.map((card) => card.bottom)).size, 1, `the cards of a row end together (${ids})`);
      assert.equal(new Set(row.map((card) => card.linksBottom)).size, 1, `the links of a row line up (${ids})`);
    }
    s.verify();
  });

for (const size of [DESKTOP, SHORT])
  test(`[${size.width}x${size.height}] the first row of cards starts on the screen`, async (t) => {
    const s = await site(t, { size });
    await open(s);
    const top = await s.page.evaluate(
      () => document.querySelector('[data-testid="projects-card"]').getBoundingClientRect().top,
    );
    assert.ok(top < size.height - 80, `the first card starts at ${Math.round(top)}px of ${size.height}`);
    s.verify();
  });

/* ── The phone's dock ──────────────────────────────────────────────────── */

const DOCK = [
  [320, 5],
  [360, 5],
  [375, 6],
  [390, 6],
  [414, 6],
  [430, 7],
  [500, 8],
];

for (const [width, visible] of DOCK)
  test(`[${width}] the dock holds eight tabs, each a 44px target, at least ${visible} wholly in view, Projects among them, and nothing wider than the window`, async (t) => {
    const s = await site(t, { size: { width, height: 800 } });
    await s.goto("");
    await expect(s.page.getByTestId("view-projects")).toBeVisible();
    const measured = await s.page.evaluate(() => {
      const nav = document.querySelector("nav[aria-label='Main navigation']");
      const box = nav.getBoundingClientRect();
      const tabs = [...nav.querySelectorAll("button")].map((button) => {
        const r = button.getBoundingClientRect();
        return {
          id: button.dataset.testid,
          w: r.width,
          h: r.height,
          whole: r.left >= box.left - 0.5 && r.right <= box.right + 0.5,
        };
      });
      return {
        tabs,
        scrollWidth: nav.scrollWidth,
        clientWidth: nav.clientWidth,
        pageOverflow: document.documentElement.scrollWidth - innerWidth,
        navLeft: box.left,
        navRight: box.right,
        wash: getComputedStyle(nav).backgroundImage.includes("linear-gradient"),
      };
    });
    assert.equal(measured.tabs.length, 8);
    assert.deepEqual(
      measured.tabs.map((tab) => tab.id),
      ["overview", "analytics", "projects", "chains", "map", "compare", "watchlist", "learn"].map((view) => `view-${view}`),
    );
    for (const tab of measured.tabs) {
      assert.ok(tab.w >= 44 && tab.h >= 44, `${tab.id} is ${tab.w}x${tab.h}`);
      assert.ok(tab.w >= 55.5, `${tab.id} keeps its label whole (${tab.w}px)`);
    }
    assert.ok(
      measured.tabs.filter((tab) => tab.whole).length >= visible,
      `${measured.tabs.filter((tab) => tab.whole).length} tabs whole at ${width}px`,
    );
    assert.equal(measured.tabs.find((tab) => tab.id === "view-projects").whole, true);
    assert.ok(measured.pageOverflow <= 0, "nothing is wider than the window");
    if (measured.scrollWidth > measured.clientWidth)
      assert.equal(measured.wash, true, "a cut edge shows the soft cue");
    // The tab that is current is in view whichever it is.
    await s.page.getByTestId("view-learn").click();
    await expect(s.page.getByTestId("view-learn")).toHaveAttribute("aria-current", "page");
    await s.page.waitForTimeout(400);
    const learn = await s.page.evaluate(() => {
      const nav = document.querySelector("nav[aria-label='Main navigation']");
      const r = nav.querySelector("[data-testid='view-learn']").getBoundingClientRect();
      const box = nav.getBoundingClientRect();
      return r.left >= box.left - 0.5 && r.right <= box.right + 0.5;
    });
    assert.equal(learn, true, "Learn is in view once chosen");
    s.verify();
  });

test("the live page keeps its 68px tabs, and has no Projects tab or page", { skip: LIVE ? false : "set RADAR_TEST_LIVE_DIST to a build made without VITE_STATIC_EDITION" }, async (t) => {
  const liveHtml = readFileSync(resolve(LIVE, "index.html"), "utf8");
  assert.doesNotMatch(liveHtml, /data-edition/);
  const s = await site(t, { size: PHONE, dist: LIVE, mount: "/" });
  await s.page.goto(`${s.server.url}?view=learn`);
  await expect(s.page.getByTestId("view-learn")).toBeVisible({ timeout: 60000 });
  const widths = await s.page.evaluate(() =>
    [...document.querySelectorAll("nav[aria-label='Main navigation'] button")].map(
      (button) => Math.round(button.getBoundingClientRect().width),
    ),
  );
  assert.ok(widths.every((width) => width >= 68), `tabs are ${widths.join(", ")}px wide`);
  await expect(s.page.getByTestId("view-projects")).toHaveCount(0);
});

/* ── First paint ───────────────────────────────────────────────────────── */

test("a phone's first paint asks for few logos, and reaching the end of the list changes no card's height", async (t) => {
  const s = await site(t, { size: PHONE });
  const images = [];
  s.page.on("request", (request) => {
    if (/\/protocols\/[^/]+\.(png|svg)$/.test(new URL(request.url()).pathname))
      images.push(request.url());
  });
  await open(s);
  await s.page.waitForTimeout(800);
  assert.ok(images.length <= 15, `${images.length} logos on first paint`);
  const before = await layout(s.page);
  await s.page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 600) {
      scrollTo(0, y);
      await new Promise((done) => setTimeout(done, 40));
    }
    scrollTo(0, document.body.scrollHeight);
  });
  await s.page.waitForTimeout(800);
  const after = await layout(s.page);
  assert.deepEqual(after.cards, before.cards, "no card changed height as its logo arrived");
  s.verify();
});

/* ── A real snapshot, when one is given ────────────────────────────────── */

test("on a real snapshot the page lists a reasonable number of projects, each with what a card needs, and keeps still", { skip: OWN_DATA ? false : "RADAR_TEST_DATA is not set" }, async (t) => {
  for (const size of SIZES) {
    const s = await site(t, { size });
    await open(s);
    const total = (await cardIds(s.page)).length;
    assert.ok(total >= 60 && total <= 120, `${total} cards`);
    const cards = await s.page.getByTestId("projects-card").evaluateAll((list) =>
      list.map((element) => ({
        id: element.dataset.projectId,
        name: element.querySelector(".projects-card-name").textContent.replace(/\s+/g, " ").trim(),
        description: element.querySelector(".projects-card-description").textContent.trim(),
        networks: element.querySelector(".projects-card-networks .sr-only").textContent.trim(),
      })),
    );
    const names = new Set();
    for (const entry of cards) {
      assert.ok(entry.name.length > 0);
      assert.ok(!/^(?:0x)?[0-9a-f]{12,}$/i.test(entry.name), `${entry.name} is not a hash`);
      assert.ok(entry.description.length >= 30, `${entry.name}: description`);
      assert.ok(entry.networks.length > 10, `${entry.name}: networks`);
      assert.ok(!names.has(entry.name), `${entry.name} appears once`);
      names.add(entry.name);
    }
    // ≥ marks the sums, as the rest of the page does.
    assert.ok((await s.page.locator(".projects-figures dd", { hasText: "≥" }).count()) > 0);
    const start = await layout(s.page);
    // Every window, when the snapshot offers 7D and 30D: each card keeps its height.
    const windows = (await s.page.locator(".window-switch button").allInnerTexts()).map(flat);
    for (const label of windows.filter((name) => name !== "24H")) {
      await s.page.locator(".window-switch button", { hasText: new RegExp(`^${label}$`) }).click();
      await s.page.waitForTimeout(500);
      const now = await layout(s.page);
      assertFixed(start, now, `real data, window ${label}`);
      for (const [id, height] of Object.entries(start.cards))
        assert.equal(now.cards[id], height, `window ${label}: ${id} changed height`);
    }
    await s.page.locator(".window-switch button", { hasText: /^24H$/ }).click();
    await s.page.waitForTimeout(300);
    assertFixed(start, await layout(s.page), "real data, back to 24H");
    await s.page.getByTestId("projects-search").fill("a");
    await s.page.getByTestId("projects-sort").selectOption("name");
    await s.page.waitForTimeout(300);
    assertFixed(start, await layout(s.page), `real data at ${size.width}`);
    await s.page.getByTestId("projects-clear").click();
    await s.page.waitForTimeout(300);
    const end = await layout(s.page);
    assertFixed(start, end, `real data at ${size.width}, cleared`);
    assert.deepEqual(end.cards, start.cards);
    const result = await new AxeBuilder({ page: s.page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    assert.deepEqual(
      result.violations
        .filter((v) => ["serious", "critical"].includes(v.impact))
        .map((v) => `${v.id}: ${v.nodes[0].target.join(" ")}`),
      [],
    );
    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      await s.page.screenshot({ path: resolve(SHOTS, `projects-${size.width}.png`) });
    }
    s.verify();
  }
});

test("a build under test is an edition build", () => {
  assert.ok(existsSync(resolve(DIST, "index.html")));
  assert.match(html, /data-edition="snapshot"/);
});
