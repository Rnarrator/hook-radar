// The Auto Snapshot edition in a real browser. It builds nothing: point it at an
// edition build (VITE_STATIC_EDITION=1) with RADAR_TEST_DIST and it serves that
// build next to the deterministic TEST data in tests/fixtures/static-data/data
// through scripts/static-edition-server.mjs, which answers every /api path with
// 404 and records every request. No production data, no network, no service.
//
//   RADAR_TEST_DIST=dist/test-build \
//     node --test scripts/static-edition-browser.test.mjs
//
// RADAR_TEST_MOUNT names the path the build is served under; by default it is
// read from the build (a relative build is also served under /sub/dir/).
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { startStaticEditionServer } from "./static-edition-server.mjs";
import {
  aggregateCurrentMarkets,
  refreshMarketSnapshot,
} from "../shared/market-freshness.ts";
import { money } from "../src/model.ts";
import { fullTimeLabel, timeLabel } from "../src/edition.ts";
import { GENERATED_AT } from "../tests/fixtures/static-data/generate.mjs";

const DIST = resolve(process.env.RADAR_TEST_DIST || "dist");
const DATA = resolve("tests/fixtures/static-data/data");
const generated = Date.parse(GENERATED_AT);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DESKTOP = { width: 1440, height: 1000 };
const PHONE = { width: 390, height: 844 };

const fixture = (name) => JSON.parse(readFileSync(resolve(DATA, name), "utf8"));
const snapshotFixture = fixture("snapshot.json");
const evaluated = refreshMarketSnapshot(snapshotFixture, generated);
const projectVolume = (id, window = "h24") =>
  evaluated.projects.find((project) => project.id === id).metrics.volumeUsd[
    window
  ];

// How the build under test is meant to be served.
const html = readFileSync(resolve(DIST, "index.html"), "utf8");
const entry =
  html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/)?.[1] ?? "";
const relativeBuild = entry.startsWith("./");
const builtMount = relativeBuild
  ? "/"
  : entry.replace(/assets\/[^/]+$/, "") || "/";
const MOUNT = process.env.RADAR_TEST_MOUNT || builtMount;

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
  {
    size = DESKTOP,
    visitorNow = generated + 2 * MINUTE,
    mount = MOUNT,
    data = {},
    storage = null,
  } = {},
) {
  const server = await startStaticEditionServer({
    distDir: DIST,
    dataDir: DATA,
    mount,
  });
  for (const [name, body] of Object.entries(data)) server.setData(name, body);
  const context = await browser.newContext({
    viewport: size,
    reducedMotion: "reduce",
    acceptDownloads: true,
  });
  // Time moves, but starts at the chosen moment: the visitor opens an old
  // snapshot, not a new one.
  await context.clock.setFixedTime(visitorNow);
  if (storage)
    await context.addInitScript((entries) => {
      for (const [key, value] of Object.entries(entries))
        localStorage.setItem(key, value);
    }, storage);
  const page = await context.newPage();
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) => {
    if (request.failure()?.errorText !== "net::ERR_ABORTED")
      errors.push(`requestfailed: ${request.url()}`);
  });
  t.after(async () => {
    await context.close();
    await server.close();
  });
  return {
    page,
    server,
    context,
    errors,
    url: server.url,
    goto: (query = "") => page.goto(`${server.url}${query}`),
    /** The page asked no service, hit no error and failed no request. */
    verify() {
      assert.deepEqual(errors, [], "console and page errors");
      assert.deepEqual(
        server.apiRequests().map((row) => `${row.method} ${row.path}`),
        [],
        "requests to /api",
      );
      assert.equal(
        server.requests.some((row) => /early-discovery/.test(row.path)),
        false,
        "the live early-discovery script is not part of the edition",
      );
      assert.equal(
        server.requests.filter((row) => row.status >= 400).length,
        0,
        `no request failed: ${server.requests
          .filter((row) => row.status >= 400)
          .map((row) => `${row.status} ${row.path}`)
          .join(", ")}`,
      );
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

const RELATIVE_AGE =
  /\b\d+\s?(?:s|m|min|h|d)\s+ago\b|\bjust now\b|\b\d+m(?:\s\d+s)?\s+old\b|\b\d+h\s\d+m\s+old\b/i;

/** Everything a visitor can read, except the one line that is allowed to say how
 * long ago the snapshot was taken (by the visitor's own clock). */
const visibleText = (page) =>
  page.evaluate(() => {
    const line = document.querySelector('[data-testid="snapshot-line"]');
    const own = line?.innerText ?? "";
    return document.body.innerText.replace(own, "");
  });

const noRelativeAges = async (page, where) => {
  const text = await visibleText(page);
  const found = text.match(RELATIVE_AGE);
  assert.equal(
    found,
    null,
    `${where}: a relative age is shown ("${found?.[0]}")`,
  );
  return text;
};

// Wording that reads the data against the present: the five-minute rule is
// applied at the snapshot's own time, and the census is a dated export that is
// never rescanned.
const LIVE_CLOCK =
  /last (?:5|five) minutes|\bright now\b|figures are current(?! as of the snapshot)|waiting for current market data|\bcaught up\b|needs a refresh|check overdue|awaiting refresh|recently checked|history syncs|\bsyncing\b/i;

/** Everything a visitor can read or hear, not only what is on screen: the text
 * inside closed disclosures, and separately every title and aria-label. The one
 * line that may say how long ago the snapshot was taken is left out. */
const everything = (page) =>
  page.evaluate(() => {
    const line = document.querySelector('[data-testid="snapshot-line"]');
    const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT"]);
    const text = [];
    const attributes = [];
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || skip.has(parent.tagName) || line?.contains(parent))
        continue;
      text.push(node.textContent);
    }
    for (const element of document.querySelectorAll("[title], [aria-label]")) {
      if (line?.contains(element)) continue;
      for (const name of ["title", "aria-label"]) {
        const value = element.getAttribute(name);
        if (value) attributes.push(value);
      }
    }
    const flat = (parts) => parts.join(" | ").replace(/\s+/g, " ");
    return { text: flat(text), attributes: flat(attributes) };
  });

/** No age relative to now in any text, and no wording that reads the data
 * against the present in any text or tooltip. (A tooltip may still say how old
 * a measurement was "at the snapshot time".) */
const readsAtSnapshotTime = async (page, where) => {
  const { text, attributes } = await everything(page);
  const around = (value, found) =>
    value.slice(Math.max(0, found.index - 50), found.index + 70);
  const age = text.match(RELATIVE_AGE);
  assert.equal(
    age,
    null,
    `${where}: a relative age ("${age && around(text, age)}")`,
  );
  for (const [name, value] of [
    ["text", text],
    ["a tooltip", attributes],
  ]) {
    const found = value.match(LIVE_CLOCK);
    assert.equal(
      found,
      null,
      `${where}: wording that reads against the present, in ${name} ("${found && around(value, found)}")`,
    );
  }
};

test("the build under test is an edition build", () => {
  assert.doesNotMatch(html, /early-discovery/);
  const assets = readdirSync(resolve(DIST, "assets")).filter((name) =>
    name.endsWith(".js"),
  );
  const code = assets
    .map((name) => readFileSync(resolve(DIST, "assets", name), "utf8"))
    .join("\n");
  assert.match(code, /snapshot\.json/);
  assert.match(code, /overview-all-/);
  assert.match(code, /Snapshot taken/);
});

test("Discover reads only the published files, at 1440 and 390 px", async (t) => {
  for (const size of [DESKTOP, PHONE]) {
    const s = await site(t, { size });
    await s.goto();
    await ready(s.page, { phone: size === PHONE });
    s.verify();
    const files = s.server
      .dataRequests()
      .map((row) => row.path.split("/").pop());
    assert.ok(files.includes("snapshot.json"), "the snapshot file is read");
    assert.ok(files.includes("history.json"), "the recorded history is read");
    assert.equal(s.server.dataRequests().length, files.length);
  }
});

// G13: the head's early request for the snapshot is the one the page then
// reads. A second request for the same 1 MB file (a preload the page cannot
// reuse, or a second fetch of its own) would double what a first visit costs.
test("a cold load of Discover requests snapshot.json exactly once", async (t) => {
  for (const size of [DESKTOP, PHONE]) {
    const s = await site(t, { size });
    await s.goto();
    await ready(s.page, { phone: size === PHONE });
    // Let any late request show up before counting.
    await s.page.waitForTimeout(800);
    const snapshotRequests = s.server
      .dataRequests()
      .filter(
        (row) => row.path.split("?")[0].split("/").pop() === "snapshot.json",
      );
    assert.equal(
      snapshotRequests.length,
      1,
      `snapshot.json requested ${snapshotRequests.length} times at ${size.width}px: ${snapshotRequests
        .map((row) => `${row.method} ${row.path} ${row.status}`)
        .join(", ")}`,
    );
    s.verify();
  }
});

test("the dated status line says when the snapshot was taken, how it is renewed and how old it is", async (t) => {
  const cases = [
    [2 * MINUTE, "2 min ago"],
    [HOUR + 12_000, "1 h ago"],
  ];
  for (const [after, age] of cases) {
    const s = await site(t, { visitorNow: generated + after });
    await s.goto();
    await ready(s.page);
    const line = s.page.getByTestId("snapshot-line");
    await expect(line).toContainText("Snapshot taken 28 Oct 2026, 14:05 UTC");
    await expect(line).toContainText("refreshed every few hours");
    await expect(line).toContainText(age);
    await expect(line.locator("time")).toHaveAttribute(
      "datetime",
      GENERATED_AT,
    );
    assert.equal(await s.page.getByTestId("snapshot-line").count(), 1);
    s.verify();
  }
});

// A snapshot older than the schedule explains (G7): the line stops repeating
// the rhythm, says whose clock the age is, and keeps the time the figures are
// from. A page cannot tell a late snapshot from a clock set ahead.
test("a snapshot older than the schedule explains says so, by the visitor's clock, and keeps its own time", async (t) => {
  const s = await site(t, { visitorNow: generated + 3 * 24 * HOUR });
  await s.goto();
  await ready(s.page);
  const line = s.page.getByTestId("snapshot-line");
  await expect(line).toContainText(
    "By this device’s clock, this snapshot is 3 d old; newer data should have been published.",
  );
  await expect(line).toContainText("Figures are from 28 Oct 2026, 14:05 UTC.");
  await expect(line).not.toContainText("refreshed every few hours");
  await expect(line).toHaveClass(/is-stale/);
  await expect(line.locator("time")).toHaveAttribute("datetime", GENERATED_AT);
  assert.equal(await s.page.getByTestId("snapshot-line").count(), 1);
  s.verify();
});

test("the dated line is on every page that shows data, once", async (t) => {
  const s = await site(t);
  for (const view of [
    "overview",
    "map",
    "chains",
    "analytics",
    "compare",
    "watchlist",
  ]) {
    await s.goto(`?view=${view}`);
    await expect(s.page.getByTestId("snapshot-line")).toBeVisible({
      timeout: 30000,
    });
    assert.equal(await s.page.getByTestId("snapshot-line").count(), 1, view);
    await expect(s.page.getByTestId("snapshot-line")).toContainText(
      "28 Oct 2026, 14:05 UTC",
    );
  }
  s.verify();
});

test("a snapshot an hour old still shows its figures as of its own time", async (t) => {
  const s = await site(t, { visitorNow: generated + HOUR + 30_000 });
  await s.goto();
  await ready(s.page);
  await expect(s.page.getByTestId("snapshot-line")).toContainText("1 h ago");
  // Every project's volume is what the snapshot's own time gives, not "—".
  for (const id of ["alpha", "gamma", "delta"]) {
    const row = s.page.locator("tbody tr", {
      has: s.page.getByTestId(`project-${id}`),
    });
    const cell = await row.locator("td.observed-number").first().innerText();
    assert.ok(
      cell.startsWith(money(projectVolume(id))),
      `${id}: expected ${money(projectVolume(id))}, saw "${cell}"`,
    );
    assert.notEqual(money(projectVolume(id)), "—");
  }
  // The headline figure for the named projects, from the same shared rule.
  const named = snapshotFixture.pools.filter((pool) => pool.projectId);
  const expected = money(
    aggregateCurrentMarkets(named, generated).volumeUsd.h24,
  );
  await expect(s.page.locator("#ecosystem-stats")).toContainText(expected);
  await expect(s.page.locator("#ecosystem-stats")).toContainText(
    "pools with current volume data",
  );
  s.verify();
});

test("figures older than five minutes at the snapshot's time are left out exactly as on the live site", async (t) => {
  const s = await site(t);
  await s.goto();
  await ready(s.page);
  const rows = {
    // one pool just inside the window (4:55) and one just outside (5:15)
    gamma: money(400),
    // measured, but only at 7:30
    frontier: "—",
    // reserves only: volume is unavailable, never zero
    beta: "—",
    // a measured zero is a zero
    delta: money(3),
  };
  for (const [id, want] of Object.entries(rows)) {
    const row = s.page.locator("tbody tr", {
      has: s.page.getByTestId(`project-${id}`),
    });
    const cell = await row.locator("td.observed-number").first().innerText();
    assert.ok(cell.startsWith(want), `${id}: expected ${want}, saw "${cell}"`);
    if (want === "—") assert.equal(projectVolume(id), null, id);
  }
  assert.equal(projectVolume("gamma"), 400);
  // The drawer of the project with a measured zero and a stale pool says so.
  await s.page.getByTestId("project-alpha").click();
  const drawer = s.page.locator(".project-detail");
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText("1 older excluded");
  await expect(drawer).toContainText("14:02 UTC");
  s.verify();
});

test("no age is shown relative to now: every one is a UTC time", async (t) => {
  const s = await site(t, { visitorNow: generated + 5 * HOUR });
  const pages = [
    ["Discover", ""],
    ["By use case", "?view=map"],
    ["Networks", "?view=chains"],
    ["One network", "?view=chains&chain_network=base"],
    ["Analytics overview", "?view=analytics"],
    ["Analytics evidence", "?view=analytics&analytics_chain=base"],
    ["Analytics workspace", "?view=analytics&analytics_chain=base&window=h1"],
    ["Compare", "?view=compare&compare=alpha,gamma"],
    ["Project drawer", "?project=alpha"],
    ["Project with only stale pools", "?project=frontier"],
    ["Pools tab", "?project=gamma&tab=pools"],
    ["Hooks tab", "?project=alpha&tab=deployments"],
    ["Launchpad", "?project=bags"],
    ["Market data only", "?market=observed"],
    ["Watchlist", "?view=watchlist"],
  ];
  for (const [name, query] of pages) {
    await s.goto(query);
    await expect(s.page.getByTestId("snapshot-line")).toBeVisible({
      timeout: 30000,
    });
    await s.page.waitForTimeout(400);
    await noRelativeAges(s.page, name);
    await readsAtSnapshotTime(s.page, name);
  }
  // The sources dialog too, from Discover and from a network (which opens its
  // own pricing checks).
  for (const [name, query] of [
    ["Data & sources", ""],
    ["Data & sources on a network", "?view=chains&chain_network=base"],
  ]) {
    await s.goto(query);
    await expect(s.page.getByTestId("snapshot-line")).toBeVisible({
      timeout: 30000,
    });
    await s.page.getByTestId("sources-button").click();
    await expect(s.page.getByRole("dialog")).toBeVisible();
    await noRelativeAges(s.page, name);
    await readsAtSnapshotTime(s.page, name);
  }
  // And what is shown instead is an absolute time.
  await s.goto("?project=alpha");
  await expect(s.page.locator(".project-detail")).toContainText("14:02 UTC");
  s.verify();
});

test("Activity, Refresh and every other control of the live service are gone", async (t) => {
  const s = await site(t);
  await s.goto();
  await ready(s.page);
  const nav = s.page.getByRole("navigation", { name: "Main navigation" });
  assert.deepEqual(
    (await nav.getByRole("button").allInnerTexts()).map((text) =>
      text.replace(/\s+/g, " ").trim(),
    ),
    [
      "Discover",
      "Learn",
      "Analytics",
      "Networks",
      "By use case",
      "Compare",
      "Watchlist",
    ],
  );
  await expect(s.page.getByTestId("view-activity")).toHaveCount(0);
  for (const view of [
    "overview",
    "map",
    "chains",
    "analytics",
    "compare",
    "watchlist",
  ]) {
    await s.goto(`?view=${view}`);
    await expect(s.page.getByTestId("snapshot-line")).toBeVisible({
      timeout: 30000,
    });
    await expect(s.page.getByTestId("refresh-button")).toHaveCount(0);
    await expect(s.page.getByRole("button", { name: /refresh/i })).toHaveCount(
      0,
    );
  }
  // The palette neither lists Activity nor offers a refresh.
  await s.goto();
  await ready(s.page);
  await s.page.keyboard.press("Control+k");
  const palette = s.page.getByRole("dialog");
  await expect(palette).toBeVisible();
  await expect(palette).not.toContainText("Activity");
  await expect(palette).not.toContainText("Refresh data");
  await s.page.keyboard.type("activity");
  await expect(palette.getByRole("option", { name: /^Activity/ })).toHaveCount(
    0,
  );
  await s.page.keyboard.press("Escape");
  // Market views offer no "onchain activity" link; a drawer no Activity button.
  await s.goto("?market=observed");
  await ready(s.page);
  await expect(s.page.getByText("View onchain activity")).toHaveCount(0);
  await s.goto("?project=alpha");
  await expect(s.page.locator(".project-detail")).toBeVisible();
  await expect(s.page.getByRole("button", { name: /activity/i })).toHaveCount(
    0,
  );
  s.verify();
});

test("a link to Activity lands on Discover", async (t) => {
  const s = await site(t);
  await s.goto("?view=activity&activity=alpha&activity_chain=base");
  await ready(s.page);
  await expect(s.page.getByRole("heading", { level: 1 })).toHaveText(
    "Uniswap v4 hooks",
  );
  await expect(s.page.getByTestId("view-overview")).toHaveAttribute(
    "aria-current",
    "page",
  );
  const address = new URL(s.page.url());
  assert.equal(address.searchParams.get("view"), null);
  assert.equal(address.searchParams.get("activity"), null);
  // Back and Forward stay in the edition's own pages.
  await s.page.getByTestId("view-learn").click();
  await s.page.goBack();
  await expect(s.page.getByRole("heading", { level: 1 })).toHaveText(
    "Uniswap v4 hooks",
  );
  s.verify();
});

const TITLES = {
  overview: "Uniswap v4 hooks",
  map: "Explore by use case",
  chains: "Explore by network",
  analytics: "Hook analytics",
  compare: "Compare hooks",
  watchlist: "Your watchlist",
  learn: "Understand v4 hooks",
};

test("every kept view works at 1440 and 390 px without overflow, errors or a service", async (t) => {
  for (const size of [DESKTOP, PHONE]) {
    const s = await site(t, {
      size,
      storage: { "hook-radar-watchlist-v1": JSON.stringify(["alpha"]) },
    });
    for (const [view, title] of Object.entries(TITLES)) {
      const query =
        view === "compare"
          ? "?view=compare&compare=alpha,gamma"
          : `?view=${view}`;
      await s.goto(query);
      await expect(s.page.getByRole("heading", { level: 1 })).toHaveText(
        title,
        {
          timeout: 30000,
        },
      );
      if (view !== "learn")
        await expect(s.page.getByTestId("snapshot-line")).toBeVisible({
          timeout: 30000,
        });
      await s.page.waitForTimeout(500);
      const overflow = await s.page.evaluate(() => ({
        page: document.documentElement.scrollWidth - window.innerWidth,
        body: document.body.scrollWidth - window.innerWidth,
      }));
      assert.ok(
        overflow.page <= 1 && overflow.body <= 1,
        `${view} at ${size.width}px overflows by ${JSON.stringify(overflow)}`,
      );
      await expect(s.page.locator(".error-notice, [role=alert]")).toHaveCount(
        0,
      );
      assert.ok((await s.page.locator("main").innerText()).length > 80, view);
    }
    s.verify();
  }
});

test("a project drawer opens from a link with its pools, hooks and permissions, from the snapshot alone", async (t) => {
  const s = await site(t);
  await s.goto("?project=alpha");
  const drawer = s.page.locator(".project-detail");
  await expect(
    drawer.getByRole("heading", { name: "Alpha Markets" }),
  ).toBeVisible({
    timeout: 30000,
  });
  // Pools from the snapshot's own measured pools; a measured zero reads $0.
  await expect(drawer).toContainText("ETH / ALPHA");
  await expect(drawer).toContainText("WBTC / ALPHA");
  await expect(
    drawer.locator(".pool-card", { hasText: "WBTC / ALPHA" }),
  ).toContainText("$0");
  await expect(
    drawer.locator(".pool-card", { hasText: "ETH / ALPHA" }),
  ).toContainText(money(2400));
  await expect(drawer).toContainText("14:02 UTC");
  // Hooks tab: both deployments, and the address decoder's permissions.
  await drawer.getByRole("tab", { name: /^Hooks/ }).click();
  await expect(drawer.locator(".deployment-list")).toContainText("AlphaHook");
  await expect(drawer.locator(".deployment-list")).toContainText(
    "AlphaEthereumHook",
  );
  s.verify();
  // A project the snapshot does not hold says so instead of waiting for a service.
  const missing = await site(t);
  await missing.goto("?project=not-a-project");
  await expect(
    missing.page.getByText("Project not in this snapshot"),
  ).toBeVisible({
    timeout: 30000,
  });
  await missing.page.getByRole("button", { name: "Back to radar" }).click();
  await expect(
    missing.page.getByText("Project not in this snapshot"),
  ).toHaveCount(0);
  missing.verify();
});

test("a launchpad opens from the registry without asking a directory service", async (t) => {
  const s = await site(t);
  await s.goto("?project=bags");
  const drawer = s.page.locator(".launchpad-paths");
  await expect(drawer).toBeVisible({ timeout: 30000 });
  await s.page.waitForTimeout(600);
  const text = await drawer.innerText();
  assert.doesNotMatch(
    text,
    /Checking the directory|Directory lookup unavailable|Not in the directory yet/,
  );
  s.verify();
});

test("Analytics opens from the published overview and its recorded history", async (t) => {
  const s = await site(t);
  await s.goto("?view=analytics");
  await expect(s.page.getByTestId("snapshot-line")).toBeVisible({
    timeout: 30000,
  });
  const files = () =>
    s.server.dataRequests().map((row) => row.path.split("/").pop());
  await expect.poll(files).toContain("overview-all-h24.json");
  await expect.poll(files).toContain("history.json");
  await expect(s.page.locator("#analytics-history")).toContainText(
    "5 of 5 observations",
  );
  await expect(s.page.locator("#analytics-history")).toContainText(
    "latest at 14:05 UTC",
  );
  // The all-network volume is the shared rule's number at the snapshot's time.
  const total = money(
    aggregateCurrentMarkets(snapshotFixture.pools, generated).volumeUsd.h24,
  );
  await expect(s.page.getByRole("main")).toContainText(total);
  // A published network at 24 hours has its own file.
  await s.goto("?view=analytics&analytics_chain=base");
  await expect.poll(files).toContain("overview-base-h24.json");
  s.verify();
});

test("a network and window the snapshot publishes no overview for are served from the snapshot, with no missing file", async (t) => {
  const s = await site(t);
  await s.goto("?view=analytics&analytics_chain=base&window=h1");
  await expect(s.page.getByRole("heading", { level: 1 })).toHaveText(
    "Hook analytics",
  );
  await expect(s.page.getByTestId("snapshot-line")).toBeVisible({
    timeout: 30000,
  });
  await expect(s.page.getByRole("main")).toContainText("Base", {
    timeout: 30000,
  });
  assert.equal(
    s.server.requests.some((row) => /overview-base-h1/.test(row.path)),
    false,
  );
  // Switching the window away and back never asks for the missing file either.
  await s.page.getByRole("button", { name: "24H" }).click();
  await expect
    .poll(() => s.server.dataRequests().map((row) => row.path.split("/").pop()))
    .toContain("overview-base-h24.json");
  await s.page.getByRole("button", { name: "1H" }).click();
  await s.page.waitForTimeout(600);
  s.verify();
});

test("with no recorded points the history panel is simply absent", async (t) => {
  for (const history of [
    { schemaVersion: 1, points: [] },
    { schemaVersion: 9, points: [{ timestamp: 1, value: 1 }] },
  ]) {
    const s = await site(t, { data: { "history.json": history } });
    await s.goto("?view=analytics");
    await expect(s.page.getByTestId("snapshot-line")).toBeVisible({
      timeout: 30000,
    });
    await expect(s.page.getByRole("main")).toContainText(
      "Hook pools Radar can price",
    );
    await s.page.waitForTimeout(500);
    await expect(s.page.locator("#analytics-history")).toHaveCount(0);
    await expect(s.page.locator(".error-notice, [role=alert]")).toHaveCount(0);
    s.verify();
  }
});

test("Data & sources names every source with what it did and when, and the footer credits the providers", async (t) => {
  // The footer credits the services the snapshot's own source list names
  // (reaudit5:F4). A real run lists the deployment configuration as
  // "frontier-chains" (the fixture's shorter list does not), so the served
  // snapshot carries that source in the shape the collector writes it.
  const frontierSource = {
    id: "frontier-chains",
    name: "Frontier deployment configuration",
    url: "https://api.frontier.fun/chains",
    status: "live",
    updatedAt: "2026-10-28T13:41:15.000Z",
    note: "Fetched at the start of this snapshot run from https://api.frontier.fun/chains.",
  };
  const served = {
    ...snapshotFixture,
    sources: [...snapshotFixture.sources, frontierSource],
  };
  const s = await site(t, { data: { "snapshot.json": served } });
  await s.goto();
  await ready(s.page);
  await s.page.getByTestId("sources-button").click();
  const dialog = s.page.getByRole("dialog");
  await expect(dialog).toContainText("taken 28 Oct 2026, 14:05 UTC");
  for (const source of served.sources) {
    const item = dialog.locator(".source-item", { hasText: source.name });
    await expect(item).toBeVisible();
    await expect(item).toContainText(source.note);
    await expect(item).toContainText(
      `Retrieved ${timeLabel(source.updatedAt, generated)}`,
    );
    // The page writes the address the way a URL reads back (a bare host gets
    // its "/"). The census is Hook Radar's own index, not a page a link could
    // show, so its card has none (reaudit5:F17).
    const link = item.getByRole("link", { name: /View source/ });
    if (source.id === "census") await expect(link).toHaveCount(0);
    else await expect(link).toHaveAttribute("href", new URL(source.url).href);
  }
  // The collection run's own times, from the published status file.
  await expect(dialog).toContainText("Collection started");
  await expect(dialog).toContainText(fullTimeLabel("2026-10-28T13:41:12.000Z"));
  await s.page.keyboard.press("Escape");
  const credit = s.page.getByTestId("source-credit");
  await expect(credit).toBeVisible();
  for (const [name, href] of [
    ["GeckoTerminal", "https://www.geckoterminal.com/"],
    ["DEX Screener", "https://dexscreener.com/"],
    ["Uniswap hooklist", "https://github.com/Uniswap/hooklist"],
    // G7: the credit names the indexer as the v4.xyz service the collector asks.
    ["v4.xyz indexer", "https://www.v4.xyz/"],
    // G7: the deployment configuration is credited to its source.
    ["Frontier", "https://api.frontier.fun/chains"],
  ]) {
    const link = credit.getByRole("link", { name });
    await expect(link).toHaveAttribute("href", href);
    await expect(link).toHaveAttribute("rel", /noopener/);
  }
  // What each provider is credited with: DEX Screener measures prices and
  // GeckoTerminal finds pools and stands in as a fallback (G7), the indexer
  // names hooks and pools, and the census is Hook Radar's own index (as the
  // collector's census source says).
  // (A link with its icon reads as "name ." in innerText.)
  const creditText = (await credit.innerText())
    .replace(/\s+/g, " ")
    .replace(/ ([.,])/g, "$1");
  assert.match(
    creditText,
    /Prices from DEX Screener, with GeckoTerminal for pool discovery and as a fallback\./,
  );
  assert.match(
    creditText,
    /Hook and pool identities from the v4\.xyz indexer\./,
  );
  assert.match(creditText, /Deployment configuration from Frontier\./);
  assert.match(
    creditText,
    /The pool census is Hook Radar’s own index of PoolManager events\./,
  );
  assert.doesNotMatch(creditText, /census from/i);
  const census = snapshotFixture.sources.find(
    (source) => source.id === "census",
  );
  assert.match(census.note, /^Hook Radar's index of PoolManager events/);
  s.verify();
});

test("hook and pool counts read as a dated census", async (t) => {
  const s = await site(t);
  await s.goto();
  await ready(s.page);
  await expect(s.page.getByTestId("masthead-census")).toHaveText(
    "Hooks, pools and networks: census as of 27 Oct 2026",
  );
  const figures = s.page.locator(".masthead-figures");
  await expect(figures).toContainText(
    String(snapshotFixture.inventory.hookCount),
  );
  await expect(figures).toContainText(
    String(snapshotFixture.inventory.hookPoolCount),
  );
  await s.page.getByTestId("sources-button").click();
  const dialog = s.page.getByRole("dialog");
  await expect(dialog).toContainText("Census as of 27 Oct 2026");
  // G7: the census block gives the time its counts are as of, not an "exported" time.
  await expect(dialog).toContainText("As of 27 Oct 2026, 20:11 UTC");
  s.verify();
});

test("every hook or pool count that comes from the census is dated where it is shown", async (t) => {
  // Five hours after the snapshot, so a count that read as measured at the
  // snapshot (let alone at the visitor's clock) would be visibly wrong.
  const s = await site(t, { visitorNow: generated + 5 * HOUR });
  const { page } = s;
  const when = "Census as of 27 Oct 2026";
  const notes = page.getByTestId("census-note");
  const open = async (query) => {
    await s.goto(query);
    await expect(page.getByTestId("snapshot-line")).toBeVisible({
      timeout: 30000,
    });
    await page.waitForTimeout(500);
  };
  const hookPools = String(snapshotFixture.inventory.hookPoolCount);

  // Networks: the summary card, the coverage readout, the pool composition and
  // the network ledger each carry the date beside their counts.
  await open("?view=chains");
  await expect(page.locator("#chains-overview")).toContainText(
    `${hookPools} pools using hooks`,
  );
  await expect(
    page.locator("#chains-overview").getByTestId("census-note"),
  ).toHaveText(when);
  await expect(
    page.locator(".chain-evidence-panel").getByTestId("census-note"),
  ).toHaveText([when, when]);
  await expect(
    page.locator("#chains-networks").getByTestId("census-note"),
  ).toHaveText(when);
  await expect(page.locator("#chains-networks")).toContainText(
    "Hook pool counts are from the census as of 27 Oct 2026.",
  );
  await expect(notes).toHaveCount(4);
  // The comparison by hook pools says whose date its shares are.
  await page.getByRole("button", { name: "Hook pools", exact: true }).click();
  await expect(page.locator(".chain-atlas .chain-chart-note")).toContainText(
    "Share of indexed hook pools, census as of 27 Oct 2026.",
  );

  // One network: the same, and the coverage disclosure names when it was counted.
  await open("?view=chains&chain_network=base");
  await expect(
    page.locator("#chains-overview").getByTestId("census-note"),
  ).toHaveText(when);
  await expect(
    page.locator(".chain-composition-panel").getByTestId("census-note"),
  ).toHaveText(when);
  await expect(page.locator(".chains-market-scope")).toContainText(
    "Indexed hook and pool counts are from the census as of 27 Oct 2026",
  );
  await page.locator(".chains-index-details summary").click();
  await expect(page.locator(".chains-index-body")).toContainText(
    "Census as of 27 Oct 2026 · counted 27 Oct 2026, 20:11 UTC",
  );
  await expect(page.locator(".chains-index-head")).toHaveText(
    /^Chain head checked 27 Oct, 20:10 UTC$/,
  );
  // Every chain time is a UTC time, never the visitor's local one.
  await expect(page.locator(".chains-index-body")).toContainText(
    "27 Oct 2026, 20:10 UTC",
  );

  // Analytics: the evidence statement, and the table of indexed hook pools.
  for (const query of [
    "?view=analytics",
    "?view=analytics&analytics_chain=base",
    "?view=analytics&analytics_chain=base&window=h1",
  ]) {
    await open(query);
    const line = page.locator(".evidence-inventory");
    await expect(line).toContainText(
      /hook pools indexed onchain across \d+ networks? \(\d+ scanned to their recorded target\), census as of 27 Oct 2026\./,
    );
    await expect(line).not.toContainText("caught up");
  }
  await open("?view=analytics");
  await expect(
    page
      .locator(".analytics-overview-coverage-table thead")
      .getByTestId("census-note"),
  ).toHaveText(when);
  await expect(page.locator("#analytics-overview-coverage-note")).toContainText(
    `${hookPools} indexed hook pools in this scope (census as of 27 Oct 2026).`,
  );
  await open("?view=analytics&analytics_chain=base&window=h1");
  await expect(
    page.locator(".analytics-footprint-panel").getByTestId("census-note"),
  ).toHaveText(when);

  // The Data & sources dialog: the census block, with its own export time.
  await open("");
  await page.getByTestId("sources-button").click();
  await expect(page.getByRole("dialog")).toContainText(when);
  // G7: "As of", the census block's own time.
  await expect(page.getByRole("dialog")).toContainText(
    "As of 27 Oct 2026, 20:11 UTC",
  );

  // On a phone the ledger's column heads are hidden, so the counts keep their
  // date in the summary card and in the ledger's own introduction.
  const phone = await site(t, {
    size: PHONE,
    visitorNow: generated + 5 * HOUR,
  });
  await phone.goto("?view=chains");
  await expect(phone.page.getByTestId("snapshot-line")).toBeVisible({
    timeout: 30000,
  });
  await expect(
    phone.page.locator("#chains-overview").getByTestId("census-note"),
  ).toBeVisible();
  await expect(
    phone.page.getByText(
      "Hook pool counts are from the census as of 27 Oct 2026.",
    ),
  ).toBeVisible();
  phone.verify();

  // A project's own pool count is the pools this snapshot measured for it, and
  // says so; it is not a census figure.
  await open("?project=alpha");
  // G2: the project's count is labelled "Pools measured", not "Pools found".
  await expect(
    page.locator(".project-detail .readout", { hasText: "Pools measured" }),
  ).toContainText("Measured in this snapshot");
  s.verify();
});

test("Compare, the watchlist, the palette and exports work with no service", async (t) => {
  const s = await site(t);
  await s.goto();
  await ready(s.page);
  // Watchlist: save a project, find it again, and see an unknown saved id flagged.
  await s.page.getByTestId("watch-alpha").click();
  await s.page.getByTestId("view-watchlist").click();
  await expect(s.page.getByTestId("project-alpha")).toBeVisible();
  // Compare from the list.
  await s.page.getByTestId("view-overview").click();
  await ready(s.page);
  await s.page
    .getByRole("button", { name: "Add Alpha Markets to comparison" })
    .click();
  await s.page
    .getByRole("button", { name: "Add Gamma Fee Guard to comparison" })
    .click();
  await s.page.getByRole("button", { name: /Compare projects/ }).click();
  await expect(s.page.getByRole("heading", { level: 1 })).toHaveText(
    "Compare hooks",
  );
  await expect(s.page.getByRole("main")).toContainText("Gamma Fee Guard");
  // Palette: find a project and open it.
  await s.page.keyboard.press("Control+k");
  await s.page.keyboard.type("gamma");
  await s.page.keyboard.press("Enter");
  await expect(
    s.page
      .locator(".project-detail")
      .getByRole("heading", { name: "Gamma Fee Guard" }),
  ).toBeVisible();
  await s.page.keyboard.press("Escape");
  // Exports are made in the page from the snapshot it holds.
  await s.page.getByTestId("view-overview").click();
  await ready(s.page);
  await s.page.getByTestId("share-button").click();
  const [json] = await Promise.all([
    s.page.waitForEvent("download"),
    s.page.getByRole("button", { name: "Download JSON" }).click(),
  ]);
  // The snapshot's UTC date is in the name (the live name has none).
  const day = GENERATED_AT.slice(0, 10);
  assert.equal(json.suggestedFilename(), `hook-radar-snapshot-${day}.json`);
  const exported = JSON.parse(readFileSync(await json.path(), "utf8"));
  assert.equal(exported.generatedAt, GENERATED_AT);
  assert.equal(exported.pools.length, snapshotFixture.pools.length);
  const [csv] = await Promise.all([
    s.page.waitForEvent("download"),
    s.page.getByRole("button", { name: "Download CSV" }).click(),
  ]);
  assert.equal(csv.suggestedFilename(), `hook-radar-projects-${day}.csv`);
  s.verify();

  // A saved project the snapshot does not hold is flagged, never guessed (G3a/G9:
  // it is named and stays saved, and only the visitor's own Forget removes it).
  const flagged = await site(t, {
    storage: {
      "hook-radar-watchlist-v1": JSON.stringify(["alpha", "gone-project"]),
    },
  });
  await flagged.goto("?view=watchlist");
  const orphan = flagged.page.locator(".orphan-notice");
  await expect(orphan).toContainText(
    "1 saved project is not in this snapshot. It stays saved and will show again when a snapshot includes it.",
    { timeout: 30000 },
  );
  await expect(orphan.locator("code")).toHaveText(["gone-project"]);
  const saved = () =>
    flagged.page.evaluate(() =>
      JSON.parse(localStorage.getItem("hook-radar-watchlist-v1") ?? "[]"),
    );
  assert.deepEqual(await saved(), ["alpha", "gone-project"]);
  flagged.verify();
  await orphan.getByRole("button", { name: "Forget gone-project" }).click();
  await expect(flagged.page.locator(".orphan-notice")).toHaveCount(0);
  assert.deepEqual(await saved(), ["alpha"]);
  flagged.verify();
});

// G3a/G9: a link naming a project the snapshot lacks no longer drops it
// silently. The id stays in the address, gets no column and is listed as not
// carried; the visitor can take it out of the link.
test("a comparison link naming a project the snapshot lacks lists it as not carried instead of waiting on a service", async (t) => {
  const s = await site(t);
  await s.goto("?view=compare&compare=alpha,ghost,gamma");
  await expect(s.page.getByRole("main")).toContainText("Gamma Fee Guard", {
    timeout: 30000,
  });
  const notice = s.page.locator(".comparison-not-carried");
  await expect(notice).toContainText(
    "This link names 1 project this snapshot does not carry",
  );
  await expect(notice.locator("code")).toHaveText(["ghost"]);
  // No column for it: the two carried projects fill two of the four places.
  await expect(s.page.locator(".comparison-selection-count")).toHaveText(
    "2 / 4",
  );
  await expect(
    s.page.getByRole("group", { name: "Selected projects" }).locator("article"),
  ).toHaveCount(2);
  // The address still names all three, so the link a visitor shares is theirs.
  assert.equal(
    new URL(s.page.url()).searchParams.get("compare"),
    "alpha,ghost,gamma",
  );
  await s.page.waitForTimeout(500);
  s.verify();
  // Removing it takes it out of the address and leaves the two columns.
  await notice
    .getByRole("button", { name: "Remove ghost from this link" })
    .click();
  await expect(s.page.locator(".comparison-not-carried")).toHaveCount(0);
  await expect
    .poll(() => new URL(s.page.url()).searchParams.get("compare"))
    .toBe("alpha,gamma");
  await expect(s.page.locator(".comparison-selection-count")).toHaveText(
    "2 / 4",
  );
  s.verify();
});

test("keyboard: skip link, focus order, the palette and the drawer return focus where it was", async (t) => {
  const s = await site(t);
  await s.goto();
  await ready(s.page);
  const active = () =>
    s.page.evaluate(() => {
      const el = document.activeElement;
      const style = el ? getComputedStyle(el) : null;
      const rect = el?.getBoundingClientRect();
      return {
        tag: el?.tagName,
        cls: el?.className?.toString?.() ?? "",
        id: el?.id ?? "",
        testid: el?.getAttribute?.("data-testid") ?? "",
        label: (el?.getAttribute?.("aria-label") || el?.textContent || "")
          .trim()
          .slice(0, 40),
        outline:
          style &&
          style.outlineStyle !== "none" &&
          parseFloat(style.outlineWidth) > 0,
        shadow: style ? style.boxShadow !== "none" : false,
        ringed: Boolean(
          el?.closest?.(".search-box, .select-control, .segmented"),
        ),
        visible: Boolean(rect && rect.width > 0 && rect.height > 0),
        inView: Boolean(
          rect && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight,
        ),
      };
    });
  await s.page.keyboard.press("Tab");
  const first = await active();
  assert.match(first.cls, /skip-link/);
  // It slides into view on focus; give it a moment rather than a fixed instant.
  await expect
    .poll(
      async () => {
        const state = await active();
        return state.visible && state.inView;
      },
      { message: "the skip link is visible when focused" },
    )
    .toBe(true);
  await s.page.keyboard.press("Enter");
  assert.equal((await active()).id, "main");
  // Walk the first stops of the page: each is visible and shows a focus mark.
  await s.page.evaluate(() => document.querySelector(".brand")?.focus());
  const stops = [];
  for (let i = 0; i < 24; i++) {
    await s.page.keyboard.press("Tab");
    stops.push(await active());
  }
  for (const stop of stops) {
    assert.ok(
      stop.visible && stop.inView,
      `${stop.tag} "${stop.label}" is reachable`,
    );
    assert.ok(
      stop.outline || stop.shadow || stop.ringed,
      `${stop.tag} "${stop.label}" shows where focus is`,
    );
  }
  assert.ok(
    stops.some((stop) => stop.testid === "sources-button"),
    "the Data & sources button is in the tab order",
  );
  // The palette opens, takes the typing, and leaves focus where it was.
  await s.page.getByTestId("palette-button").focus();
  await s.page.keyboard.press("Control+k");
  await expect(s.page.getByRole("dialog")).toBeVisible();
  await s.page.keyboard.press("Escape");
  await expect(s.page.getByRole("dialog")).toHaveCount(0);
  // A project opens by keyboard and closes back to its row.
  await s.page.getByTestId("project-alpha").focus();
  await s.page.keyboard.press("Enter");
  await expect(s.page.locator(".project-detail")).toBeVisible();
  const inside = await s.page.evaluate(() =>
    Boolean(
      document.activeElement?.closest(
        "[role=dialog], .drawer, .project-detail",
      ),
    ),
  );
  assert.ok(inside, "focus moves into the drawer");
  await s.page.keyboard.press("Escape");
  await expect(s.page.locator(".project-detail")).toHaveCount(0);
  assert.equal((await active()).testid, "project-alpha");
  // The sources dialog likewise.
  await s.page.getByTestId("sources-button").focus();
  await s.page.keyboard.press("Enter");
  await expect(s.page.getByRole("dialog")).toBeVisible();
  await s.page.keyboard.press("Escape");
  assert.equal((await active()).testid, "sources-button");
  s.verify();
});

const subpathCases = relativeBuild ? ["/", "/sub/dir/"] : [MOUNT];
for (const mount of subpathCases)
  test(`works when served under ${mount}`, async (t) => {
    const s = await site(t, { mount });
    await s.goto();
    await ready(s.page);
    // Every file came from under the mount; nothing was asked of the host root.
    const outside = s.server.requests.filter(
      (row) => !row.path.startsWith(mount),
    );
    assert.deepEqual(
      outside.map((row) => row.path),
      [],
    );
    const files = s.server.dataRequests().map((row) => row.path);
    assert.ok(files.includes(`${mount}data/snapshot.json`), files.join(", "));
    // Logos load from under the mount too (the spotlight shows Frontier's).
    await s.page.getByTestId("project-alpha").waitFor();
    const loaded = await s.page.evaluate(
      () =>
        [...document.images].filter(
          (image) => image.complete && image.naturalWidth > 0,
        ).length,
    );
    assert.ok(loaded >= 1, "an original logo is displayed");
    // A deep link, reload and Back keep working at this path.
    await s.goto("?project=alpha&view=analytics&analytics_chain=base");
    await expect(
      s.page
        .locator(".project-detail")
        .getByRole("heading", { name: "Alpha Markets" }),
    ).toBeVisible({ timeout: 30000 });
    await s.page.reload();
    await expect(
      s.page
        .locator(".project-detail")
        .getByRole("heading", { name: "Alpha Markets" }),
    ).toBeVisible({ timeout: 30000 });
    assert.ok(new URL(s.page.url()).pathname.startsWith(mount));
    s.verify();
  });

test("the controls of every view work without ever asking a service", async (t) => {
  const s = await site(t, {
    storage: { "hook-radar-watchlist-v1": JSON.stringify(["alpha", "gamma"]) },
  });
  const { page } = s;
  const settle = () => page.waitForTimeout(250);

  // Discover: search, filters, scope, network, sort, window, pages.
  await s.goto();
  await ready(page);
  await page.getByTestId("search-input").fill("gamma");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page.getByRole("button", { name: "Clear search" }).click();
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page
    .locator(".advanced-filters")
    .getByRole("button", { name: "Dynamic fees", exact: true })
    .click();
  await settle();
  await page
    .locator(".advanced-filters")
    .getByRole("button", { name: "Any", exact: true })
    .click();
  for (const scope of [
    "All hooks",
    "With market data",
    "Recent trading",
    "Projects",
  ])
    await page
      .getByRole("group", { name: "Directory coverage" })
      .getByRole("button", { name: scope })
      .click();
  await page.getByLabel("Filter by chain").selectOption("base");
  await settle();
  await page.getByLabel("Filter by chain").selectOption("all");
  await page.locator("th button", { hasText: "Pools" }).click();
  for (const window of ["1H", "6H", "24H"])
    await page
      .getByRole("group", { name: "Volume time window" })
      .getByRole("button", { name: window })
      .click();
  await page.getByRole("button", { name: "Launchpads" }).first().click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Launchpads on Uniswap v4",
  );
  await settle();

  // Networks: pick a network, search the protocols, go back to all.
  await s.goto("?view=chains");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Explore by network",
    { timeout: 30000 },
  );
  await page.getByRole("combobox").first().selectOption("base");
  await settle();
  await expect(page.getByRole("main")).toContainText("Base");
  await page.getByRole("combobox").first().selectOption("all");
  await settle();

  // A project drawer: tabs, a pool searched and expanded, then closed.
  await s.goto("?project=gamma");
  const drawer = page.locator(".project-detail");
  await expect(drawer).toBeVisible({ timeout: 30000 });
  await drawer.getByPlaceholder("Pool, token or address").fill("GAMMA2");
  await settle();
  await expect(drawer).toContainText("ETH / GAMMA2");
  await drawer.locator(".pool-card button[aria-expanded]").first().click();
  await settle();
  await drawer.getByRole("tab", { name: /^Hooks/ }).click();
  await drawer.getByRole("tab", { name: /^Pools/ }).click();
  await drawer
    .getByRole("button", { name: /Watch project|Watching|Remove/ })
    .first()
    .click();
  await page.keyboard.press("Escape");

  // By use case: choose a category from the map.
  await s.goto("?view=map");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Explore by use case",
    { timeout: 30000 },
  );
  await settle();

  // Analytics: metrics, a network, the full view behind the overview.
  await s.goto("?view=analytics");
  await expect(page.getByTestId("snapshot-line")).toBeVisible({
    timeout: 30000,
  });
  await page.getByRole("button", { name: "Reserves", exact: true }).click();
  await page
    .getByRole("button", { name: "Pools with trading", exact: true })
    .click();
  await page.getByRole("button", { name: "Volume", exact: true }).click();
  await page.getByRole("combobox").first().selectOption("ethereum");
  await expect
    .poll(() => s.server.dataRequests().map((row) => row.path.split("/").pop()))
    .toContain("overview-ethereum-h24.json");
  await page
    .getByRole("button", { name: /Explore pools & hooks/ })
    .first()
    .click();
  await expect(page.getByRole("main")).toContainText("Ethereum", {
    timeout: 30000,
  });
  for (const range of ["24 hours", "30 days", "All history", "7 days"]) {
    const control = page.getByRole("button", { name: range, exact: true });
    if (await control.count()) await control.first().click();
  }
  await settle();

  // Compare: add from the picker, remove one.
  await s.goto("?view=compare&compare=alpha");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Compare hooks",
    { timeout: 30000 },
  );
  await page
    .getByPlaceholder("Search a name, purpose or hook address")
    .fill("delta");
  await page.getByRole("button", { name: /^Add/ }).first().click();
  await settle();

  // Watchlist with saved projects: the updates panel and removing one.
  await s.goto("?view=watchlist");
  await expect(page.getByTestId("project-alpha")).toBeVisible({
    timeout: 30000,
  });
  await page.getByTestId("watch-alpha").click();
  await settle();

  // Learn, the shortcut list and a Back/Forward round trip.
  await s.goto("?view=learn");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Understand v4 hooks",
    { timeout: 30000 },
  );
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.goBack();
  await page.goForward();
  await settle();
  s.verify();
});

test("no serious accessibility violation on the pages the edition adds to or changes", async (t) => {
  for (const size of [DESKTOP, PHONE]) {
    const s = await site(t, { size });
    const pages = [
      ["Discover", ""],
      ["Networks", "?view=chains"],
      ["By use case", "?view=map"],
      ["Compare", "?view=compare&compare=alpha,gamma"],
      ["Watchlist", "?view=watchlist"],
      ["Project drawer", "?project=alpha"],
      // The share bars of a handful of fixture pools have segments under 1%,
      // narrower than a touch target; the rule is left out for this page only.
      ["Analytics", "?view=analytics", ["target-size"]],
    ];
    for (const [name, query, skip = []] of pages) {
      await s.goto(query);
      await expect(s.page.getByTestId("snapshot-line")).toBeVisible({
        timeout: 30000,
      });
      await s.page.waitForTimeout(800);
      const result = await new AxeBuilder({ page: s.page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .disableRules(skip)
        .analyze();
      const serious = result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact),
      );
      assert.deepEqual(
        serious.map(
          (violation) =>
            `${violation.id}: ${violation.nodes[0].target.join(" ")}`,
        ),
        [],
        `${name} at ${size.width}px`,
      );
    }
    // The dialog that lists the sources and the census.
    await s.goto();
    await ready(s.page, { phone: size === PHONE });
    await s.page.getByTestId("sources-button").click();
    await expect(s.page.getByRole("dialog")).toBeVisible();
    const dialog = await new AxeBuilder({ page: s.page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    assert.deepEqual(
      dialog.violations
        .filter((violation) =>
          ["serious", "critical"].includes(violation.impact),
        )
        .map((violation) => violation.id),
      [],
      `Data & sources at ${size.width}px`,
    );
    s.verify();
  }
});
