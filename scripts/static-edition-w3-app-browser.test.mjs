// The "W3 app" fixes of the Auto Snapshot edition in a real browser: a host that
// stores the data files, the Analytics empty and loading screens, the wording of
// the phone cards, counts and pagers, an unknown network, the dated file names,
// the footer credit and the Data & sources dialog.
//
// Like the other static-edition browser checks it builds nothing: point it at an
// edition build (VITE_STATIC_EDITION=1) with RADAR_TEST_DIST. By default the data
// is the deterministic TEST data in tests/fixtures/static-data/data;
// RADAR_TEST_DATA names another data folder (the real collector output, say) and
// the expectations are derived from that folder's own files where they can be.
// The server (scripts/static-edition-server.mjs) answers every /api path with 404
// and records every request. No production data, no network, no service.
//
//   RADAR_TEST_DIST=dist/test-build \
//     node --test scripts/static-edition-w3-app-browser.test.mjs
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import test, { after, before } from "node:test";
import { chromium, expect } from "@playwright/test";
import { startStaticEditionServer } from "./static-edition-server.mjs";
import AxeBuilder from "@axe-core/playwright";
import { RELOAD_HINT, fullTimeLabel } from "../src/edition.ts";
import { launchpadRegistry } from "../shared/launchpad-registry.ts";

const DIST = resolve(process.env.RADAR_TEST_DIST || "dist");
const DATA = resolve(
  process.env.RADAR_TEST_DATA || "tests/fixtures/static-data/data",
);
const builtPage = readFileSync(resolve(DIST, "index.html"), "utf8");
if (!/<html[^>]*\sdata-edition="snapshot"/.test(builtPage))
  throw new Error(
    `${DIST} is not an edition build: its index.html has no data-edition="snapshot" on the root element. Build with VITE_STATIC_EDITION=1 and name it in RADAR_TEST_DIST.`,
  );
// Where the build under test is meant to be served from (a build made with
// VITE_BASE=/sub/dir/ lives there; the default build works anywhere).
const entry =
  builtPage.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/)?.[1] ?? "";
const MOUNT =
  process.env.RADAR_TEST_MOUNT ||
  (entry.startsWith("./") ? "/" : entry.replace(/assets\/[^/]+$/, "") || "/");

const DESKTOP = { width: 1440, height: 1000 };
const PHONE = { width: 390, height: 844 };
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const read = (name) => readFileSync(resolve(DATA, name), "utf8");
const snapshotText = read("snapshot.json");
const snapshot = JSON.parse(snapshotText);
const generated = Date.parse(snapshot.generatedAt);

/** Every ISO time inside a JSON text moved by `ms`: another run of the same data. */
const shiftTimes = (text, ms) =>
  text.replace(
    /"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)"/g,
    (_, time) => `"${new Date(Date.parse(time) + ms).toISOString()}"`,
  );
const generatedOf = (text) => JSON.parse(text).generatedAt;

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
 * not found); `cacheControl` makes the host's data answers storable, as a CDN
 * with a time to live does; `allow` names console errors a test expects. */
async function site(
  t,
  {
    size = DESKTOP,
    data = {},
    cacheControl = null,
    clock = "fixed",
    at = generated + 2 * MINUTE,
    allow = () => false,
  } = {},
) {
  const server = await startStaticEditionServer({
    distDir: DIST,
    dataDir: DATA,
    mount: MOUNT,
    cacheControl,
  });
  for (const [name, body] of Object.entries(data)) server.setData(name, body);
  const context = await browser.newContext({
    viewport: size,
    reducedMotion: "reduce",
    ...(size.width < 600 ? { hasTouch: true, isMobile: true } : {}),
  });
  if (clock === "fixed") await context.clock.setFixedTime(at);
  else await context.clock.install({ time: at });
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
    url: server.url,
    errors,
    ready: async () => {
      await expect(page.getByTestId("snapshot-line")).toBeVisible({
        timeout: 60000,
      });
      await page.waitForTimeout(300);
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

/* ── A host that stores the data files ─────────────────────────────────── */

test("a host that lets the browser store /data for four hours still shows the newest snapshot after a reload or a new visit", async (t) => {
  const s = await site(t, { cacheControl: "public, max-age=14400" });
  await s.goto("");
  await s.ready();
  await expect(s.page.getByTestId("snapshot-line")).toContainText(
    fullTimeLabel(snapshot.generatedAt),
  );
  assert.equal(s.asks("snapshot.json").length, 1);
  // The collector publishes run B (everything three hours later).
  const later = shiftTimes(snapshotText, 3 * HOUR);
  s.server.setData("snapshot.json", later);
  // F5: the page asks the host to revalidate, whatever the stored copy's age.
  await s.page.reload();
  await expect(s.page.getByTestId("snapshot-line")).toContainText(
    fullTimeLabel(generatedOf(later)),
    { timeout: 30000 },
  );
  assert.equal(s.asks("snapshot.json").length, 2, "the host was asked again");
  // A new visit to the same address does too.
  const again = shiftTimes(snapshotText, 6 * HOUR);
  s.server.setData("snapshot.json", again);
  await s.goto("");
  await expect(s.page.getByTestId("snapshot-line")).toContainText(
    fullTimeLabel(generatedOf(again)),
    { timeout: 30000 },
  );
  assert.equal(s.asks("snapshot.json").length, 3);
  s.verify();
});

test("a cold load downloads the snapshot exactly once (the early request is the page's own)", async (t) => {
  const s = await site(t);
  await s.goto("");
  await s.ready();
  await s.page.waitForTimeout(800);
  assert.equal(s.asks("snapshot.json").length, 1);
  // Opening other pages from inside the page keeps it that way.
  await s.page.getByTestId("view-chains").click();
  await expect(main(s.page)).toContainText("Explore by network");
  assert.equal(s.asks("snapshot.json").length, 1);
  s.verify();
});

test("a download the early request started is ended by the stall guard like any other", async (t) => {
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
    "The snapshot stopped downloading.",
    { timeout: 15000 },
  );
});

test("a late snapshot stops telling the visitor to reload once the status file says the site holds nothing newer", async (t) => {
  // The visitor's clock is thirteen hours past the snapshot, which is later than
  // the schedule explains; the site's status file names the same run.
  const s = await site(t, { clock: "install", at: generated + 13 * HOUR });
  s.server.setData(
    "status.json",
    JSON.stringify({
      ...JSON.parse(read("status.json")),
      generatedAt: snapshot.generatedAt,
    }),
  );
  await s.goto("");
  await s.ready();
  const line = s.page.getByTestId("snapshot-line");
  await expect(line).toContainText("newer data should have been published");
  // Nothing has been asked yet: reloading may help, so the line says so.
  await expect(line).toContainText(RELOAD_HINT);
  const asked = s.asks("status.json").length;
  await s.page.clock.fastForward(31 * MINUTE);
  await expect.poll(() => s.asks("status.json").length).toBe(asked + 1);
  // The check found nothing newer: a reload cannot help when the site itself is
  // late, so the hint goes, and the figures keep their date.
  await expect(line).not.toContainText(RELOAD_HINT);
  await expect(line).toContainText("newer data should have been published");
  await expect(line).toContainText(
    `Figures are from ${fullTimeLabel(snapshot.generatedAt)}.`,
  );
  await expect(s.page.getByTestId("snapshot-reload")).toHaveCount(0);
  assert.equal(
    s.asks("snapshot.json").length,
    1,
    "the file is not asked again",
  );
  s.verify();
});

/* ── Analytics with no figures, and the loading and retry screens ──────── */

const overviewFailure = (m) =>
  /overview-all-h24\.json|\b404\b/.test(`${m.location().url} ${m.text()}`);

/** A route that holds the answer for a data file until `release()`. */
async function hold(page, pattern) {
  let release;
  const gate = new Promise((done) => (release = done));
  await page.route(pattern, async (route) => {
    await gate;
    await route.continue();
  });
  return release;
}

const activeElement = (page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    return {
      tag: el?.tagName ?? "",
      text: (el?.textContent || "").trim().replace(/\s+/g, " "),
    };
  });

for (const [name, size] of Object.entries({ desktop: DESKTOP, phone: PHONE }))
  test(`[${name}] with no all-networks overview the page offers 'Open full analytics', not an 'All networks' button that does nothing`, async (t) => {
    const s = await site(t, {
      size,
      data: { "overview-all-h24.json": null },
      allow: overviewFailure,
    });
    await s.goto("?view=analytics");
    const empty = s.page.locator(".empty-state");
    await expect(
      empty.getByRole("heading", { name: "Analytics unavailable" }),
    ).toBeVisible({ timeout: 60000 });
    await expect(empty).toContainText(
      "Hook volume, reserves and network distribution from the snapshot.",
    );
    await expect(empty).not.toContainText("Current measurements");
    await expect(
      empty.getByRole("button", { name: "Open full analytics" }),
    ).toBeVisible();
    await expect(
      empty.getByRole("button", { name: "All networks" }),
    ).toHaveCount(0);
    // The full analytics still open from the snapshot.
    await empty.getByRole("button", { name: "Open full analytics" }).click();
    await expect(s.page.getByTestId("snapshot-line")).toBeVisible({
      timeout: 60000,
    });
  });

test("a network the snapshot publishes no analytics for keeps its 'All networks' button, and its heading follows the page's h1", async (t) => {
  const s = await site(t, { allow: (m) => /404/.test(m.text()) });
  await s.goto("?view=analytics&analytics_chain=nonexistent");
  const empty = s.page.locator(".empty-state");
  await expect(empty).toContainText(
    "No analytics are published for this network in this snapshot",
    { timeout: 60000 },
  );
  // A level-2 heading straight under the page's h1 (axe: heading-order).
  assert.equal(await empty.locator("h2").count(), 1);
  assert.equal(await empty.locator("h3").count(), 0);
  const axe = await new AxeBuilder({ page: s.page })
    .withRules(["heading-order", "page-has-heading-one"])
    .analyze();
  assert.deepEqual(
    axe.violations.map((violation) => violation.id),
    [],
  );
  await empty.getByRole("button", { name: "All networks" }).click();
  await expect(s.page.getByTestId("snapshot-line")).toBeVisible({
    timeout: 60000,
  });
  assert.doesNotMatch(s.page.url(), /analytics_chain/);
});

test("the loading screens say a published snapshot is loading, not that measurements are fetched", async (t) => {
  for (const [query, title] of [
    ["", "Loading hook directory"],
    ["?view=chains", "Loading chain explorer"],
    ["?view=compare", "Loading hook directory"],
    ["?view=watchlist", "Loading hook directory"],
  ]) {
    const s = await site(t);
    const release = await hold(s.page, "**/data/snapshot.json");
    await s.goto(query);
    const screen = s.page.locator(".loading-screen");
    await expect(screen).toContainText(title, { timeout: 30000 });
    await expect(screen).toContainText(
      "Loading the latest published snapshot…",
    );
    assert.doesNotMatch(
      await screen.innerText(),
      /Fetching|market measurements|Finding hooks/,
      query,
    );
    release();
    await s.ready();
  }
  // Analytics, while its overview file is on the way.
  const s = await site(t);
  const release = await hold(s.page, "**/data/overview-all-h24.json");
  await s.goto("?view=analytics");
  const empty = s.page.locator(".empty-state");
  await expect(empty).toContainText("Loading analytics…", { timeout: 30000 });
  await expect(empty).toContainText(
    "Hook volume, reserves and network distribution from the snapshot.",
  );
  assert.doesNotMatch(await empty.innerText(), /Current measurements/);
  release();
  await s.ready();
});

test("pressing Retry with the keyboard keeps focus in the page, and a success moves it to the page's heading", async (t) => {
  // The snapshot is missing; the visitor tabs to Retry and presses Enter.
  const s = await site(t, {
    data: { "snapshot.json": null },
    allow: (m) => /404/.test(m.text()),
  });
  await s.goto("");
  const notice = s.page.locator(".error-notice");
  await expect(notice).toBeVisible({ timeout: 60000 });
  const retry = notice.getByRole("button", { name: /^Retry/ });
  await retry.focus();
  const release = await hold(s.page, "**/data/snapshot.json");
  await s.page.keyboard.press("Enter");
  // While the request runs the button stays, labelled, and not focus-dropping.
  await expect(retry).toHaveText("Retrying…");
  await expect(retry).toHaveAttribute("aria-disabled", "true");
  assert.equal((await activeElement(s.page)).text, "Retrying…");
  release();
  // It fails again (still missing): the button is back and still has focus.
  await expect(retry).toHaveText("Retry", { timeout: 30000 });
  await expect(retry).not.toHaveAttribute("aria-disabled", "true");
  assert.deepEqual(await activeElement(s.page), {
    tag: "BUTTON",
    text: "Retry",
  });
  // The file comes back; Enter again loads it, and focus lands on the heading.
  s.server.setData("snapshot.json", snapshotText);
  await s.page.unroute("**/data/snapshot.json");
  await s.page.keyboard.press("Enter");
  await s.ready();
  await expect
    .poll(async () => (await activeElement(s.page)).tag, { timeout: 10000 })
    .toBe("H1");
});

test("pressing Retry analytics with the keyboard keeps focus in the page", async (t) => {
  const s = await site(t, {
    data: { "overview-all-h24.json": null },
    allow: overviewFailure,
  });
  await s.goto("?view=analytics");
  const notice = s.page.locator(".error-notice");
  await expect(notice).toBeVisible({ timeout: 60000 });
  // /^Retry/ matches the label while the request runs ("Retrying…") too.
  const retry = notice.getByRole("button", { name: /^Retry/ });
  await expect(retry).toHaveText("Retry analytics");
  await retry.focus();
  // The request is held, so the test sees it run (the label is the same before
  // and after it, and a press while it runs is ignored, which is its point).
  const release = await hold(s.page, "**/data/overview-all-h24.json");
  await s.page.keyboard.press("Enter");
  await expect(retry).toHaveText("Retrying…");
  await expect(retry).toHaveAttribute("aria-disabled", "true");
  release();
  // Failing again, the notice and its button are still there, focus on it.
  await expect(retry).toHaveText("Retry analytics", { timeout: 30000 });
  await expect(retry).not.toHaveAttribute("aria-disabled", "true");
  assert.deepEqual(await activeElement(s.page), {
    tag: "BUTTON",
    text: "Retry analytics",
  });
  // Back: the overview loads and focus moves to the page's heading.
  s.server.setData("overview-all-h24.json", read("overview-all-h24.json"));
  await s.page.unroute("**/data/overview-all-h24.json");
  await s.page.keyboard.press("Enter");
  await expect(s.page.getByTestId("snapshot-line")).toBeVisible({
    timeout: 60000,
  });
  await expect
    .poll(async () => (await activeElement(s.page)).tag, { timeout: 10000 })
    .toBe("H1");
});

/* ── Cards, pagers, captions, networks and scope counts ────────────────── */

const poolsOf = (id) => snapshot.pools.filter((pool) => pool.projectId === id);
const hookProjects = snapshot.projects.filter(
  (project) => project.entityType !== "platform" && project.deployments.length,
);
const measured = hookProjects.find((project) => poolsOf(project.id).length > 0);
// A project the snapshot holds no pool of: one the data already has, or, when
// every project has one (the small test data), the first one with its pools left
// out of the file.
const natural = hookProjects.find(
  (project) => poolsOf(project.id).length === 0,
);
const unmeasured = natural ?? hookProjects[hookProjects.length - 1];
const withoutPools = (keep) => {
  const copy = structuredClone(snapshot);
  const gone = new Set(
    copy.pools.filter((pool) => !keep(pool)).map((pool) => pool.projectId),
  );
  copy.pools = copy.pools.filter(keep);
  // A project left with no pool is one the snapshot did not measure: its
  // metrics are the ones the collector writes for such a project.
  for (const project of copy.projects)
    if (
      gone.has(project.id) &&
      !copy.pools.some((pool) => pool.projectId === project.id)
    )
      project.metrics = {
        poolCount: null,
        liquidityUsd: null,
        volumeUsd: { h1: null, h6: null, h24: null },
        coverage: "unavailable",
        note: "No exact hook-attributed market metrics are available in the current measured sample.",
      };
  return JSON.stringify(copy);
};

/** The snapshot with every figure of one project's pools withheld by the provider. */
function withheld(id) {
  const copy = structuredClone(snapshot);
  for (const pool of copy.pools)
    if (pool.projectId === id) {
      pool.liquidityUsd = null;
      pool.volumeUsd = { h1: null, h6: null, h24: null };
    }
  return JSON.stringify(copy);
}

test("[phone] a card for a project the snapshot did not measure says so, and one whose pools came back without values says that", async (t) => {
  assert.ok(unmeasured && measured, "the data holds two projects to compare");
  assert.notEqual(unmeasured.id, measured.id);
  const s = await site(t, {
    size: PHONE,
    data: natural
      ? {}
      : {
          "snapshot.json": withoutPools(
            (pool) => pool.projectId !== unmeasured.id,
          ),
        },
  });
  await s.goto(`?market=all&q=${encodeURIComponent(unmeasured.name)}`);
  await s.ready();
  const card = s.page
    .locator(".mobile-project")
    .filter({ hasText: unmeasured.name })
    .first();
  await expect(card).toContainText("Not measured in this snapshot");
  await expect(card).toContainText("No pools measured");
  const text = await card.innerText();
  assert.doesNotMatch(
    text,
    /isn[’']t available yet|Pool count unavailable|refreshing/,
  );
  s.verify();

  const patched = await site(t, {
    size: PHONE,
    data: { "snapshot.json": withheld(measured.id) },
  });
  await patched.goto(`?market=all&q=${encodeURIComponent(measured.name)}`);
  await patched.ready();
  const reported = patched.page
    .locator(".mobile-project")
    .filter({ hasText: measured.name })
    .first();
  await expect(reported).toContainText("Not reported by the provider");
  const kept = await reported.innerText();
  assert.doesNotMatch(
    kept,
    /Not measured in this snapshot|isn[’']t available yet/,
  );
  // The pools are still counted: they were measured.
  assert.match(kept, /\d+ (observed )?pools?/);
  patched.verify();
});

test("the pager and the export note count entries where the scope holds unnamed hooks, projects where it does not", async (t) => {
  const s = await site(t);
  await s.goto("");
  await s.ready();
  await expect(s.page.locator(".table-footer p").first()).toContainText(
    /\bprojects?\b/,
  );
  for (const market of ["observed", "active", "all"]) {
    await s.goto(`?market=${market}`);
    await s.ready();
    const footer = s.page.locator(".table-footer p").first();
    await expect(footer).toContainText(/\b(entry|entries)\b/);
    assert.doesNotMatch(await footer.innerText(), /\bprojects?\b/, market);
  }
  s.verify();
});

test("Ecosystem insights does not call the snapshot's list the whole directory", async (t) => {
  const s = await site(t);
  const caption = s.page.locator(".monitor-heading p").first();
  await s.goto("");
  await s.ready();
  await expect(caption).toHaveText(
    "Directory entries per use case · in this snapshot’s list",
  );
  for (const market of ["observed", "active", "all"]) {
    await s.goto(`?market=${market}`);
    await s.ready();
    await expect(caption).toHaveText(
      "Directory entries per use case · matching this view",
    );
    assert.doesNotMatch(await caption.innerText(), /whole directory/);
  }
  // The market scope narrows the caption only: History stays available.
  await expect(s.page.locator("#monitor-history-tab")).toBeEnabled();
  s.verify();
});

test("a network the snapshot does not know is dropped from the menu, the chip and the address", async (t) => {
  const s = await site(t);
  await s.goto("?chain=bogus");
  await s.ready();
  await expect(s.page.locator("select").first()).toHaveValue("all");
  assert.doesNotMatch(s.page.url(), /chain=bogus/);
  await expect(s.page.locator(".active-filters")).toHaveCount(0);
  await expect(s.page.locator("#project-index")).not.toContainText(/bogus/i);
  // The list is the unfiltered one, not an empty result.
  await expect(s.page.locator("tbody tr").first()).toBeVisible();
  await expect(s.page.locator(".empty-state")).toHaveCount(0);
  // With a scope in the address, only the unknown network is dropped.
  await s.goto("?market=observed&chain=bogus");
  await s.ready();
  assert.match(s.page.url(), /market=observed/);
  assert.doesNotMatch(s.page.url(), /chain=/);
  s.verify();
});

// A network the snapshot lists that no project is deployed on: one the data
// already has, or, when every listed network has a project (the small test
// data), one added to the list.
const listedOnlyNetwork = snapshot.chains.find(
  (chain) =>
    !snapshot.projects.some((project) => project.chains.includes(chain.slug)) &&
    !(snapshot.inventory?.networks ?? []).some(
      (row) => row.chain === chain.slug && row.hookCount > 0,
    ),
);
const addedNetwork = {
  id: 324,
  slug: "zksync",
  name: "ZKsync",
  explorer: "https://explorer.zksync.io",
};

test("a network the snapshot lists, with no project deployed on it, is the menu's choice when the address names it", async (t) => {
  const network = listedOnlyNetwork ?? addedNetwork;
  assert.ok(
    !snapshot.projects.some((project) => project.chains.includes(network.slug)),
  );
  const s = await site(t, {
    data: listedOnlyNetwork
      ? {}
      : {
          "snapshot.json": JSON.stringify({
            ...snapshot,
            chains: [...snapshot.chains, addedNetwork],
          }),
        },
  });
  await s.goto(`?chain=${network.slug}`);
  await s.ready();
  // The menu, the chip and the address say the same network, and the list says
  // nothing matches it (no project is deployed there).
  const menu = s.page.locator("select").first();
  await expect(menu).toHaveValue(network.slug);
  await expect(menu.locator("option:checked")).toHaveText(network.name);
  await expect(s.page.locator(".active-filters")).toContainText(network.name);
  assert.match(s.page.url(), new RegExp(`chain=${network.slug}`));
  await expect(s.page.locator(".empty-state")).toBeVisible();
  // The visitor can leave it from the menu.
  await menu.selectOption("all");
  await expect(s.page.locator("tbody tr").first()).toBeVisible();
  assert.doesNotMatch(s.page.url(), /chain=/);
  await expect(s.page.locator(".active-filters")).toHaveCount(0);
  // A network a project is deployed on is still in the menu, chosen or not.
  const deployed = snapshot.projects.flatMap((project) => project.chains)[0];
  await expect(menu.locator(`option[value="${deployed}"]`)).toHaveCount(1);
  s.verify();
});

// A network the snapshot lists and measured nothing on: one the data already
// has, or, when every network has a pool (the small test data), the last one
// with its pools left out of the file.
const naturalNetwork = snapshot.chains.find(
  (chain) => !snapshot.pools.some((pool) => pool.chain === chain.slug),
);
const poolNetworks = [...new Set(snapshot.pools.map((pool) => pool.chain))];
const unmeasuredNetwork =
  naturalNetwork ??
  snapshot.chains.find((chain) => chain.slug === poolNetworks.at(-1));

test("a real network with no measured pool says so in the scopes that count only measured pools", async (t) => {
  assert.ok(unmeasuredNetwork, "the data lists a network to leave unmeasured");
  const s = await site(t, {
    data: naturalNetwork
      ? {}
      : {
          "snapshot.json": withoutPools(
            (pool) => pool.chain !== unmeasuredNetwork.slug,
          ),
        },
  });
  for (const market of ["observed", "active"]) {
    await s.goto(`?market=${market}&chain=${unmeasuredNetwork.slug}`);
    await s.ready();
    const empty = s.page.locator(".empty-state");
    await expect(empty).toContainText(
      `This snapshot measures no pools on ${unmeasuredNetwork.name}.`,
    );
    assert.doesNotMatch(
      await empty.innerText(),
      /Nothing in this snapshot matches/,
    );
    // The network stays chosen: it is real.
    await expect(s.page.locator("select").first()).toHaveValue(
      unmeasuredNetwork.slug,
    );
  }
  s.verify();
});

/** The four figures of the ecosystem strip, as read on the page. */
async function stripFigures(page) {
  const cells = await page.evaluate(() =>
    [...document.querySelectorAll("#ecosystem-stats > *")].map((el) => ({
      text: el.textContent || "",
      value: (el.querySelector("strong") || el).textContent || "",
    })),
  );
  const number = (text) => Number(String(text).replace(/[^0-9]/g, ""));
  return {
    projects: number(cells[0].value),
    pools: number(cells[1].value),
    volumePools: number(
      /([\d,]+) pools? with current volume data/.exec(cells[2].text)?.[1],
    ),
    networks: number(cells[3].value),
    networksNote: cells[3].text,
  };
}

test("the ecosystem strip's counts cover what the list shows: volume pools within the pool count, and measured networks beside market data", async (t) => {
  const s = await site(t);
  const networksOf = (rows) => new Set(rows.map((pool) => pool.chain)).size;
  const attributed = snapshot.pools.filter((pool) => pool.projectId);
  for (const market of ["observed", "active"]) {
    await s.goto(`?market=${market}`);
    await s.ready();
    const figures = await stripFigures(s.page);
    // The volume total never counts pools the strip's own pool count leaves out.
    assert.ok(
      figures.volumePools <= figures.pools,
      `${market}: ${figures.volumePools} pools with volume data of ${figures.pools}`,
    );
    // Networks are those where a pool was measured (not where the listed
    // projects are merely deployed).
    assert.ok(
      figures.networks <= networksOf(attributed),
      `${market}: ${figures.networks} networks`,
    );
    assert.match(figures.networksNote, /measured pools/);
  }
  // Beside market data the count is that of the measured pools, and fewer than
  // the networks the same projects are deployed on (the Projects scope's count).
  await s.goto("?market=observed");
  await s.ready();
  const observed = await stripFigures(s.page);
  // Projects and All hooks keep the deployment-based count and its label.
  for (const query of ["", "?market=all"]) {
    await s.goto(query);
    await s.ready();
    const figures = await stripFigures(s.page);
    assert.ok(figures.networks > observed.networks, query);
    assert.match(figures.networksNote, /Networks in this view/);
    assert.doesNotMatch(figures.networksNote, /measured pools/);
  }
  s.verify();
});

/** A pool the snapshot did not carry, measured half a minute before it was taken,
 * with a figure for each window unless `over` says otherwise. */
function extraPool(n, over = {}) {
  const template = snapshot.pools[0];
  const chain = over.chain ?? template.chain;
  return {
    ...structuredClone(template),
    id: `${chain}:w3extra${n}`,
    address: `0x${(0x7000000 + n).toString(16).padStart(64, "0")}`,
    name: `X${n} / W3`,
    tokens: [`X${n}`, "W3"],
    url: `https://www.geckoterminal.com/${chain}/pools/w3extra${n}`,
    metricStatus: "live",
    liquidityUsd: 1000,
    volumeUsd: { h1: 10, h6: 60, h24: 240 },
    metricUpdatedAt: new Date(generated - 30_000).toISOString(),
    ...over,
  };
}
const withExtraPools = (extra) =>
  JSON.stringify({ ...snapshot, pools: [...snapshot.pools, ...extra] });

/** The ecosystem strip's figures in one scope. */
async function stripIn(s, market) {
  await s.goto(`?market=${market}`);
  await s.ready();
  const figures = await stripFigures(s.page);
  const volume = await s.page.evaluate(
    () =>
      document.querySelector("#ecosystem-stats > :nth-child(3) strong")
        ?.textContent,
  );
  return { ...figures, volume };
}

test("pools no listed entry owns change none of the figures of the scopes that list entries, and count where nothing narrows the list", async (t) => {
  const [first, second] = poolNetworks;
  assert.ok(first, "the data measures pools");
  // Five that nobody lists (no project, two networks) with a figure, and one
  // measured without any volume.
  const nobody = [
    ...[0, 1, 2, 3, 4].map((n) =>
      extraPool(n, {
        projectId: null,
        hookAddress: null,
        chain: n % 2 ? (second ?? first) : first,
      }),
    ),
    extraPool(5, {
      projectId: null,
      hookAddress: null,
      chain: first,
      volumeUsd: { h1: null, h6: null, h24: null },
    }),
  ];
  const plain = await site(t);
  const crowded = await site(t, {
    data: { "snapshot.json": withExtraPools(nobody) },
  });
  for (const market of ["projects", "observed", "active"]) {
    const before = await stripIn(plain, market);
    const after = await stripIn(crowded, market);
    assert.deepEqual(after, before, `${market}: the same figures`);
    // The volume total never counts pools the strip's own pool count leaves out.
    assert.ok(
      after.volumePools <= after.pools,
      `${market}: ${after.volumePools} pools with volume data of ${after.pools}`,
    );
  }
  // Where nothing narrows the list, the five pools with a figure are counted
  // (the one without volume is not).
  const everything = await stripIn(plain, "all");
  const everythingNow = await stripIn(crowded, "all");
  assert.equal(everythingNow.volumePools, everything.volumePools + 5);
  plain.verify();
  crowded.verify();
});

test("the measured scopes count the networks where a listed entry has a measured pool, not every network its hooks are deployed on", async (t) => {
  // Only the busiest network keeps its pools; the projects stay deployed on the
  // networks they were.
  const counts = new Map();
  for (const pool of snapshot.pools.filter((row) => row.projectId))
    counts.set(pool.chain, (counts.get(pool.chain) ?? 0) + 1);
  const [busiest] = [...counts].sort((a, b) => b[1] - a[1])[0];
  const s = await site(t, {
    data: {
      "snapshot.json": withoutPools((pool) => pool.chain === busiest),
    },
  });
  const deployed = await stripIn(s, "projects");
  assert.ok(
    deployed.networks > 1,
    `the projects are deployed on ${deployed.networks} networks`,
  );
  assert.match(deployed.networksNote, /Networks in this view/);
  for (const market of ["observed", "active"]) {
    const measured = await stripIn(s, market);
    assert.equal(measured.networks, 1, `${market}: the networks with a pool`);
    assert.match(measured.networksNote, /measured pools/);
  }
  s.verify();
});

const registryOnly = launchpadRegistry.find(
  (record) => !snapshot.projects.some((project) => project.id === record.id),
);

test("a launchpad's drawer sets the tab title to the platform's own name", async (t) => {
  assert.ok(
    registryOnly,
    "a reviewed launchpad that is not a snapshot project",
  );
  const s = await site(t);
  await s.goto(`?project=${registryOnly.id}`);
  await expect(s.page.getByRole("dialog")).toBeVisible({ timeout: 60000 });
  await expect(s.page).toHaveTitle(`${registryOnly.name} · Hook Radar`);
  assert.doesNotMatch(await s.page.title(), /Project details/);
  // A platform the snapshot does carry keeps the title it always had.
  for (const project of snapshot.projects
    .filter((row) => launchpadRegistry.some((record) => record.id === row.id))
    .slice(0, 2)) {
    await s.goto(`?project=${project.id}`);
    await expect(s.page.getByRole("dialog")).toBeVisible({ timeout: 60000 });
    await expect(s.page).toHaveTitle(`${project.name} · Hook Radar`);
  }
  s.verify();
});

/* ── Downloads ─────────────────────────────────────────────────────────── */

test("the two files a visitor can download carry the snapshot's date in their names", async (t) => {
  const day = snapshot.generatedAt.slice(0, 10);
  const s = await site(t);
  await s.goto("");
  await s.ready();
  await s.page.getByTestId("share-button").click();
  const dialog = s.page.getByRole("dialog");
  const [json] = await Promise.all([
    s.page.waitForEvent("download"),
    dialog.getByRole("button", { name: /^Download JSON/ }).click(),
  ]);
  assert.equal(json.suggestedFilename(), `hook-radar-snapshot-${day}.json`);
  const [csv] = await Promise.all([
    s.page.waitForEvent("download"),
    dialog.getByRole("button", { name: "Download CSV" }).click(),
  ]);
  assert.equal(csv.suggestedFilename(), `hook-radar-projects-${day}.csv`);
  s.verify();
});

/* ── The footer credit and the third-party notices ─────────────────────── */

// What the footer says for each service, and the id of the source that makes the
// page credit it (the Frontier configuration is listed as "frontier-chains").
const CREDIT_WORDS = {
  dexscreener: "DEX Screener",
  geckoterminal: "GeckoTerminal",
  registry: "Uniswap hooklist",
  v4xyz: "v4.xyz indexer",
  "frontier-chains": "Frontier",
  census: "Hook Radar’s own index of PoolManager events",
};
const supplied = (sources, id) =>
  sources.some((source) => source.id === id && source.status !== "unavailable");
const withSources = (change) => {
  const copy = structuredClone(snapshot);
  copy.sources = change(copy.sources);
  return JSON.stringify(copy);
};

test("the footer credits only the services this snapshot's sources say supplied something", async (t) => {
  const cases = {
    "as published": (sources) => sources,
    "DEX Screener supplied nothing": (sources) =>
      sources.map((source) =>
        source.id === "dexscreener"
          ? { ...source, status: "unavailable" }
          : source,
      ),
    "GeckoTerminal is not in the list": (sources) =>
      sources.filter((source) => source.id !== "geckoterminal"),
    "the Frontier configuration was unavailable": (sources) =>
      sources.map((source) =>
        source.id === "frontier-chains"
          ? { ...source, status: "unavailable" }
          : source,
      ),
  };
  for (const [name, change] of Object.entries(cases)) {
    const sources = change(structuredClone(snapshot.sources));
    const s = await site(t, {
      data: { "snapshot.json": withSources(change) },
    });
    await s.goto("");
    await s.ready();
    const credit = s.page.getByTestId("source-credit");
    const text = await credit.innerText();
    let credited = 0;
    for (const [id, words] of Object.entries(CREDIT_WORDS)) {
      const wanted = supplied(sources, id);
      credited += wanted ? 1 : 0;
      assert.equal(
        text.includes(words),
        wanted,
        `${name}: "${words}" ${wanted ? "is missing from" : "must not be in"} "${text}"`,
      );
    }
    assert.ok(credited > 0, `${name}: at least one service is credited`);
    // The credit never contradicts the Data & sources cards.
    await s.page
      .getByRole("button", { name: "Data & sources" })
      .first()
      .click();
    const dialog = s.page.getByRole("dialog");
    for (const source of sources.filter((row) => CREDIT_WORDS[row.id]))
      if (source.status === "unavailable")
        await expect(
          dialog.locator(".source-item").filter({ hasText: source.name }),
        ).toContainText("Unavailable");
    s.verify();
  }
});

test("the guide, which loads no snapshot, credits no provider but keeps the footer's own links and the notices", async (t) => {
  const s = await site(t);
  await s.goto("?view=learn");
  await expect(
    s.page.getByRole("heading", { name: "Understand v4 hooks" }),
  ).toBeVisible({ timeout: 30000 });
  const footer = s.page.locator("footer.footer");
  await expect(
    footer.getByRole("button", { name: "Data & sources" }),
  ).toBeVisible();
  await expect(s.page.getByTestId("source-credit")).toHaveCount(0);
  assert.equal(s.asks("snapshot.json").length, 0, "the guide loads no data");
  await expect(footer).toContainText("Protocol logos belong to their owners.");
  s.verify();
});

for (const [name, size] of Object.entries({ desktop: DESKTOP, phone: PHONE }))
  test(`[${name}] the footer links to the third-party notices, and the link reaches the file wherever the site is served`, async (t) => {
    const s = await site(t, { size });
    await s.goto("");
    await s.ready();
    const notice = s.page.getByTestId("third-party-notices");
    await expect(notice).toContainText(
      "Protocol logos belong to their owners.",
    );
    const link = notice.getByRole("link", { name: "Third-party notices" });
    await expect(link).toBeVisible();
    // It stands among the words of its sentence in a colour close to theirs, so
    // it is underlined (and set in the weight of the credit links above it).
    const style = await link.evaluate((a) => {
      const computed = getComputedStyle(a);
      return {
        line: computed.textDecorationLine,
        weight: computed.fontWeight,
      };
    });
    assert.match(style.line, /underline/);
    assert.equal(style.weight, "500");
    const href = await link.evaluate((a) => a.href);
    // Under the base the site is served from, not the host's root.
    assert.equal(new URL(href).pathname, `${MOUNT}third-party-notices.txt`);
    const answer = await s.page.request.get(href);
    assert.equal(answer.status(), 200);
    const text = await answer.text();
    assert.match(text, /third-party|notice/i);
    // Nothing overflows sideways on a phone.
    if (name === "phone")
      assert.ok(
        await s.page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth + 1,
        ),
        "side scroll",
      );
    s.verify();
  });

/* ── What the build ships ──────────────────────────────────────────────── */

/** Every file of a folder, relative and with forward slashes. */
function filesOf(dir, prefix = "") {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap(
    (entry) =>
      entry.isDirectory()
        ? filesOf(dir, `${prefix}${entry.name}/`)
        : [`${prefix}${entry.name}`],
  );
}

test("the built edition ships no file nothing references, and every file its page, styles and scripts name is there", () => {
  const shipped = filesOf(DIST);
  // The previous identity's font, the logo manifest and the logo README are not
  // referenced by anything the page loads.
  assert.deepEqual(
    shipped.filter((file) =>
      /^fonts\/IBMPlexMono-|^protocols\/(?:sources\.json|README\.md)$/.test(
        file,
      ),
    ),
    [],
  );
  const has = (path) => existsSync(join(DIST, path));
  const missing = [];
  const named = (from, reference) => {
    const clean = reference.split(/[?#]/)[0];
    if (!clean || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|data:)/i.test(clean)) return;
    // The data files are the host's, beside the page (not part of the build).
    if (/^(?:\.\/|\/)?(?:[^/]+\/)*data\//.test(clean)) return;
    const base = clean.startsWith("/")
      ? clean.slice(MOUNT.length).replace(/^\/+/, "")
      : posix.normalize(posix.join(posix.dirname(from), clean));
    if (!has(base)) missing.push(`${from} names ${reference}`);
  };
  // The page itself.
  const html = readFileSync(join(DIST, "index.html"), "utf8");
  for (const match of html.matchAll(/\b(?:href|src)="([^"]+)"/g))
    named("index.html", match[1]);
  // The styles: url(...) with the path relative to the stylesheet.
  for (const file of shipped.filter((name) => name.endsWith(".css")))
    for (const match of readFileSync(join(DIST, file), "utf8").matchAll(
      /url\(\s*["']?([^)"']+?)["']?\s*\)/g,
    ))
      named(file, match[1]);
  // The scripts: string literals that name a file of a folder the build ships.
  const literal =
    /["'`](\.?\/?(?:protocols|fonts)\/[A-Za-z0-9_./-]+\.(?:png|svg|ttf|woff2?|json|txt|webp|jpg))["'`]/g;
  for (const file of shipped.filter((name) => name.endsWith(".js")))
    for (const match of readFileSync(join(DIST, file), "utf8").matchAll(
      literal,
    ))
      named("index.html", match[1].replace(/^\//, "./"));
  assert.deepEqual(missing, []);
  assert.ok(shipped.length > 20, "a build, not an empty folder");
});

/* ── Data & sources, and the tooltips ──────────────────────────────────── */

const grouped = (value) => value.toLocaleString("en-US");

for (const [name, size] of Object.entries({ desktop: DESKTOP, phone: PHONE }))
  test(`[${name}] Data & sources counts the measured pools once, names each source's link, and gives the census no link`, async (t) => {
    const s = await site(t, { size });
    await s.goto("");
    await s.ready();
    await s.page
      .getByRole("button", { name: "Data & sources" })
      .first()
      .click();
    const dialog = s.page.getByRole("dialog");
    await expect(dialog.locator(".pool-index-coverage")).toBeVisible();
    // One number for "pools measured in this snapshot": every pool the snapshot
    // holds, as the Pools card and the coverage figures count it.
    const held = snapshot.pools.length;
    await expect(dialog.locator(".pool-index-coverage")).toContainText(
      `${grouped(held)} ${held === 1 ? "pool" : "pools"} measured in this snapshot`,
    );
    await expect(dialog.locator(".methodology-stats")).toContainText(
      new RegExp(
        `${grouped(snapshot.coverage.totalObservedPools)}\\s*pools in the market sample`,
      ),
    );
    // The collection run's span reads in one form, a date on both ends.
    const run = dialog.locator(".edition-run");
    if (await run.count())
      await expect(run).toContainText(
        /Measurements taken\s*\d{1,2} [A-Z][a-z]{2} \d{4}, \d\d:\d\d UTC to \d{1,2} [A-Z][a-z]{2} \d{4}, \d\d:\d\d UTC/,
      );
    // Every card with a link says whose source it is; the census has none.
    const cards = dialog.locator(".source-item");
    const total = await cards.count();
    assert.equal(total, snapshot.sources.length);
    for (const source of snapshot.sources) {
      const card = cards.filter({ hasText: source.name }).first();
      const link = card.getByRole("link");
      if (source.id === "census") {
        await expect(link).toHaveCount(0);
        await expect(card).toContainText("Hook Radar");
      } else {
        await expect(link).toHaveCount(1);
        await expect(link).toHaveAccessibleName(
          `View source for ${source.name}`,
        );
        // The visible words are unchanged.
        await expect(link).toContainText("View source");
        await expect(link).toHaveAttribute("href", new URL(source.url).href);
      }
    }
    // No two links of the list share a name.
    const names = await dialog
      .getByRole("link", { name: /^View source/ })
      .evaluateAll((links) =>
        links.map(
          (a) =>
            a.getAttribute("aria-label") ||
            (a.textContent || "").replace(/\s+/g, " ").trim(),
        ),
      );
    assert.equal(new Set(names).size, names.length, names.join(" | "));
    s.verify();
  });

test("a tooltip writes its counts as the page does, with a thousands separator", async (t) => {
  // Thousands of measurements of one listed project's hooks: 1,100 current, 1,020
  // of them current ones the provider served from its cache, and 1,050 older than
  // five minutes when the snapshot was taken. (The real snapshot has counts like
  // these; the small test data has none.)
  assert.ok(measured, "the data holds a listed project with pools");
  const owner = poolsOf(measured.id)[0];
  const mine = (n, over) =>
    extraPool(n, {
      chain: owner.chain,
      projectId: measured.id,
      hookAddress: owner.hookAddress,
      ...over,
    });
  const many = [
    ...Array.from({ length: 1100 }, (_, n) => mine(100 + n)),
    ...Array.from({ length: 1020 }, (_, n) =>
      mine(2000 + n, { metricStatus: "cached" }),
    ),
    ...Array.from({ length: 1050 }, (_, n) =>
      mine(4000 + n, {
        metricUpdatedAt: new Date(generated - 20 * MINUTE).toISOString(),
      }),
    ),
  ];
  const s = await site(t, {
    data: { "snapshot.json": withExtraPools(many) },
  });
  await s.goto("");
  await s.ready();
  const titles = await s.page.evaluate(() =>
    [...document.querySelectorAll("[title]")].map((el) => el.title),
  );
  const measuredTitles = titles.filter((title) =>
    /current pools?\./.test(title),
  );
  assert.ok(measuredTitles.length > 0, "the page has measurement tooltips");
  for (const title of measuredTitles)
    assert.doesNotMatch(
      title,
      /(?:^|[ .])\d{4,} (?:current pools?|older observations?|cached|pools? have)/,
      title,
    );
  // Each of the counts that passed a thousand is written with its separator.
  const separated = (words) =>
    new RegExp(`(?:^|[ .])\\d{1,3}(?:,\\d{3})+ ${words}`);
  for (const [name, words] of [
    ["current pools", "current pools\\."],
    ["cached pools", "cached; these amounts"],
    ["older observations", "older observations are excluded"],
  ])
    assert.ok(
      measuredTitles.some((title) => separated(words).test(title)),
      `a tooltip counts ${name} with a thousands separator`,
    );
  s.verify();
});
