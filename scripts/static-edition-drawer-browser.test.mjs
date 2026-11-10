// The project drawer of the Auto Snapshot edition in a real browser: it says
// what the snapshot measured, not what the data sources hold. Point it at an
// edition build (VITE_STATIC_EDITION=1) with RADAR_TEST_DIST; it serves that
// build next to the deterministic TEST data in tests/fixtures/static-data/data
// through scripts/static-edition-server.mjs (every /api path is a 404, every
// request is recorded). No production data, no network, no service.
//
//   RADAR_TEST_DIST=dist/test-build \
//     node --test scripts/static-edition-drawer-browser.test.mjs
//
// The tests that reshape the snapshot (server.setData) use the fixture. To read
// the same screens against a real snapshot, name its folder in RADAR_TEST_DATA
// (for example a copy of public/data): the fixture-shaping tests are skipped and
// the real-data test checks the same rules on whatever projects it finds.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { startStaticEditionServer } from "./static-edition-server.mjs";
import { GENERATED_AT } from "../tests/fixtures/static-data/generate.mjs";
import { PUBLISHING_NOTE } from "../src/edition-shell.ts";

const DIST = resolve(process.env.RADAR_TEST_DIST || "dist");
const REAL = Boolean(process.env.RADAR_TEST_DATA);
// Why the cases that need the test fixture are skipped on a real snapshot, and
// the cases that need a real snapshot are skipped on the fixture.
const FIXTURE_ONLY =
  REAL &&
  "needs the test fixture's named projects, pools and times (or reshapes it with server.setData); a real snapshot has none of them";
const REAL_ONLY = !REAL && "needs RADAR_TEST_DATA: a real collected snapshot";
const DATA = resolve(
  process.env.RADAR_TEST_DATA || "tests/fixtures/static-data/data",
);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const DESKTOP = { width: 1440, height: 1000 };
const PHONE = { width: 390, height: 844 };

const snapshotText = readFileSync(resolve(DATA, "snapshot.json"), "utf8");
const snapshotFixture = JSON.parse(snapshotText);
const generated = Date.parse(snapshotFixture.generatedAt ?? GENERATED_AT);

// How the build under test is meant to be served.
const html = readFileSync(resolve(DIST, "index.html"), "utf8");
const entry =
  html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/)?.[1] ?? "";
const builtMount = entry.startsWith("./")
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

/** A page on the edition. The visitor is in Bangkok (UTC+7), so a time written
 * in the visitor's own zone cannot pass for a UTC one. */
async function site(
  t,
  {
    size = DESKTOP,
    visitorNow = generated + 2 * MINUTE,
    snapshot = null,
    timezoneId = "Asia/Bangkok",
  } = {},
) {
  const server = await startStaticEditionServer({
    distDir: DIST,
    dataDir: DATA,
    mount: MOUNT,
  });
  if (snapshot) server.setData("snapshot.json", snapshot);
  const context = await browser.newContext({
    viewport: size,
    reducedMotion: "reduce",
    timezoneId,
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
    context,
    errors,
    drawer: page.locator(".project-detail"),
    async open(query) {
      await page.goto(`${server.url}${query}`);
      await expect(page.locator(".project-detail")).toBeVisible({
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

/* ── Test snapshots ────────────────────────────────────────────────────── */

const alphaPool = snapshotFixture.pools.find(
  (row) => row.projectId === "alpha",
);
const stampOf = (index) => `0x${(5000 + index).toString(16).padStart(64, "0")}`;
const ADDED = 44;

/** Alpha, which the fixture gives four pools, with forty-four more measured
 * ones. They are stored in an order that is neither by volume nor by id, so a
 * list that merely keeps the stored order is caught. One was created in the
 * year before the snapshot (its date carries the year). */
function manyPools() {
  const value = structuredClone(snapshotFixture);
  const added = Array.from({ length: ADDED }, (_, index) => ({
    ...structuredClone(alphaPool),
    id: `base:added${index}`,
    address: stampOf(index),
    name: `T${index} / ALPHA`,
    tokens: [`T${index}`, "ALPHA"],
    url: `https://www.geckoterminal.com/base/pools/added${index}`,
    liquidityUsd: 1000 + index,
    volumeUsd: {
      h1: ((index * 53) % 97) * 10 + 10,
      h6: ((index * 29) % 89) * 10 + 10,
      h24: ((index * 37) % 101) * 1000 + 1000,
    },
    createdAt:
      index === 7
        ? "2025-12-31T23:59:00.000Z"
        : "2026-10-0" + (1 + (index % 8)) + "T12:30:00.000Z",
    metricUpdatedAt: "2026-10-28T14:04:00.000Z",
    metricStatus: "live",
  }));
  // Stored the other way round, the pool with no current volume comes before the
  // measured zero and the largest pools last.
  value.pools = [...added, ...value.pools.reverse()];
  return value;
}

/** Delta without its one pool, so it has none; and Robinhood, where Frontier's
 * only pool was, no longer measured at all. */
function noMeasuredPools() {
  const value = structuredClone(snapshotFixture);
  value.pools = value.pools.filter(
    (row) => !["delta", "frontier"].includes(row.projectId),
  );
  // A project without a measured pool has no totals, as the collector writes it.
  for (const row of value.projects)
    if (["delta", "frontier"].includes(row.id))
      row.metrics = {
        poolCount: null,
        liquidityUsd: null,
        volumeUsd: { h1: null, h6: null, h24: null },
        coverage: "unavailable",
        note: "No exact hook-attributed market metrics are available in the current measured sample.",
      };
  // The coverage table keeps its own arithmetic (shared/market-coverage.ts).
  for (const row of value.marketCoverage.networks)
    if (row.chain === "robinhood") {
      row.measuredPools = 0;
      row.missingPools = row.checkedPools;
      row.status = "unavailable";
    }
  value.coverage.measuredChains = value.coverage.measuredChains.filter(
    (chain) => chain !== "robinhood",
  );
  return value;
}

const censusDeployment = (id, address, sourceUrl, description) => ({
  ...structuredClone(snapshotFixture.projects[0].deployments[0]),
  id: `8453:${address}`,
  address,
  chain: "base",
  chainId: 8453,
  name: `Hook ${address.slice(0, 10)}…`,
  description,
  discovery: "onchain",
  sourceUrl,
  explorerUrl: `https://example.invalid/address/${address}`,
});

/** One hook found in the census of PoolManager events and one that only the
 * v4.xyz indexer reported, with the descriptions the collector writes. */
function discoveredHooks() {
  const value = structuredClone(snapshotFixture);
  const census =
    "Discovered from a PoolManager initialization event. Project identity and contract source have not been verified.";
  const indexer =
    "Hook address reported by the v4.xyz indexer for pools Hook Radar measured. Project identity and contract source have not been verified.";
  const deployments =
    "https://developers.uniswap.org/docs/protocols/v4/deployments";
  const indexerPage =
    "https://developers.uniswap.org/docs/community/tooling/v4-community-indexer";
  const add = (id, sourceUrl, description, address) =>
    value.projects.push({
      ...structuredClone(value.projects[0]),
      id,
      name: `Hook ${address.slice(0, 10)}…`,
      description,
      category: "Other",
      sourceUrl,
      deployments: [censusDeployment(id, address, sourceUrl, description)],
      chains: ["base"],
      metrics: {
        poolCount: null,
        liquidityUsd: null,
        volumeUsd: { h1: null, h6: null, h24: null },
        coverage: "unavailable",
        note: "",
      },
    });
  add(
    "hook-census",
    deployments,
    census,
    "0xaaaa000000000000000000000000000000000c80",
  );
  add(
    "hook-indexer",
    indexerPage,
    indexer,
    "0xbbbb000000000000000000000000000000000c80",
  );
  return value;
}

const cards = (page) => page.locator(".pool-card");
const cardIds = (page) =>
  page
    .locator(".pool-card")
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-pool-id")));

/** The order the drawer should list alpha's pools in for a window: the largest
 * volume the snapshot counts as current, a measured zero before an unknown, and
 * the pool id to settle a tie. Written out here, apart from the page's code. */
function expectedOrder(value, window) {
  const fresh = (row) =>
    ["live", "cached"].includes(row.metricStatus ?? "") &&
    row.metricUpdatedAt &&
    generated - Date.parse(row.metricUpdatedAt) < 5 * MINUTE;
  const volume = (row) =>
    fresh(row) && typeof row.volumeUsd[window] === "number"
      ? row.volumeUsd[window]
      : null;
  return value.pools
    .filter((row) => row.projectId === "alpha")
    .sort((a, b) => {
      const x = volume(a);
      const y = volume(b);
      if (x === null && y !== null) return 1;
      if (y === null && x !== null) return -1;
      if (x !== y) return y - x;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .map((row) => row.address.toLowerCase());
}

/* ── The tests ─────────────────────────────────────────────────────────── */

test(
  "a project with no measured pool says so, and names where the snapshot measured",
  { skip: FIXTURE_ONLY },
  async (t) => {
    const s = await site(t, { snapshot: noMeasuredPools() });
    await s.open("?project=delta");
    const { drawer } = s;
    await expect(drawer.locator(".empty-state h3")).toHaveText(
      "No pools measured in this snapshot",
    );
    await expect(drawer.locator(".empty-state")).toContainText(
      "This snapshot measures a sample of hook pools on Base and Ethereum. None of this project’s pools are in that sample, so it may still have pools that were not measured.",
    );
    // Every place the count is shown says the same: none were measured.
    await expect(
      drawer.locator(".readout", { hasText: "Pools measured" }),
    ).toContainText("None measured");
    await expect(drawer.getByRole("tab", { name: /Pools/ })).toContainText(
      "none measured",
    );
    await expect(drawer.locator(".project-structure")).toContainText(
      "None measured",
    );
    // "None" is a word, not a figure: it carries no "—" tooltip.
    const none = drawer.locator(".project-structure strong", {
      hasText: /^None$/,
    });
    await expect(none).toHaveCount(1);
    assert.equal(await none.getAttribute("title"), null);
    const text = await drawer.innerText();
    assert.doesNotMatch(text, /\byet\b/i, "no promise of a later fill-in");
    assert.doesNotMatch(text, /market sources/i);
    assert.doesNotMatch(text, /isn’t available|Not available|Pools found/);
    // The hooks are still one click away.
    await drawer.getByRole("button", { name: "Explore hooks" }).click();
    await expect(drawer.locator("#deployment-panel")).toBeVisible();
    s.verify();
  },
);

test(
  "a network the snapshot does not measure is named as one",
  { skip: FIXTURE_ONLY },
  async (t) => {
    const s = await site(t, { snapshot: noMeasuredPools() });
    // Frontier's pool is gone and Robinhood is no longer a measured network.
    await s.open("?project=frontier");
    await expect(s.drawer.locator(".empty-state")).toContainText(
      "This snapshot measures a sample of hook pools on Base and Ethereum.",
    );
    await s.drawer
      .getByRole("combobox", { name: "Filter project by network" })
      .selectOption({ label: "Robinhood" });
    await expect(s.drawer.locator(".empty-state")).toContainText(
      "This snapshot does not measure pools on Robinhood.",
    );
    await expect(s.drawer.locator(".empty-state")).not.toContainText(
      /\byet\b/i,
    );
    // The empty state still offers the way back.
    await s.drawer.getByRole("button", { name: "Show all networks" }).click();
    await expect(
      s.drawer.getByRole("combobox", { name: "Filter project by network" }),
    ).toHaveValue("all");
    // A deep link already filtered to a measured network, with none of the
    // project's pools in it, says where the sample is.
    await s.open("?view=chains&chain_network=ethereum&project=delta");
    await expect(s.drawer.locator(".empty-state")).toContainText(
      "This snapshot measures a sample of hook pools on Base and Ethereum. None of this project’s pools on Ethereum are in that sample, so it may still have pools there that were not measured.",
    );
    s.verify();
  },
);

test(
  "a project with many pools counts them as measured, lists the largest first and dates every time in UTC",
  { skip: FIXTURE_ONLY },
  async (t) => {
    const value = manyPools();
    const s = await site(t, { snapshot: value });
    await s.open("?project=alpha");
    const { drawer, page } = s;
    const total = 4 + ADDED;

    // Wording: the count is the pools measured, everywhere it is shown.
    await expect(
      drawer.locator(".readout", { hasText: "Pools measured" }),
    ).toContainText(`${total}`);
    await expect(
      drawer.locator(".readout", { hasText: "Pools measured" }),
    ).toContainText("Measured in this snapshot");
    await expect(drawer.getByRole("tab", { name: /Pools/ })).toHaveText(
      `Pools measured ${total}`,
    );
    await expect(drawer.locator(".project-structure")).toContainText(
      `${total} measured pools`,
    );
    await expect(drawer.locator(".pool-list-progress")).toHaveText(
      `Showing 20 of ${total} measured pools · Sorted by 24H volume`,
    );
    assert.doesNotMatch(await drawer.innerText(), /Pools found/);

    // Order: largest current 24H volume first; a measured zero, then the pool
    // whose measurement is too old to count.
    const expected = expectedOrder(value, "h24");
    assert.deepEqual(await cardIds(page), expected.slice(0, 20));
    await drawer.getByRole("button", { name: "Show 20 more pools" }).click();
    assert.deepEqual(await cardIds(page), expected.slice(0, 40));
    // The last page removes the button: focus moves to the first pool it added.
    await drawer.getByRole("button", { name: "Show 8 more pools" }).focus();
    await page.keyboard.press("Enter");
    assert.deepEqual(await cardIds(page), expected);
    await expect(drawer.getByRole("button", { name: /more pool/ })).toHaveCount(
      0,
    );
    const focused = await page.evaluate(() => {
      const active = document.activeElement;
      const list = [...document.querySelectorAll(".pool-card")];
      return {
        inDrawer: Boolean(active?.closest(".project-detail")),
        card: list.indexOf(active?.closest(".pool-card")),
      };
    });
    assert.deepEqual(
      focused,
      { inDrawer: true, card: 40 },
      "focus stays in the list",
    );
    await expect(drawer.locator(".pool-list-progress")).toHaveText(
      `Showing ${total} of ${total} measured pools · Sorted by 24H volume`,
    );
    // The last two rows are the measured zero and the pool whose measurement is
    // too old to count: never ahead of a measured amount, never shown as zero.
    await expect(
      cards(page)
        .nth(total - 2)
        .locator(".pool-metric")
        .first(),
    ).toContainText("$0");
    await expect(
      cards(page)
        .nth(total - 1)
        .locator(".pool-metric")
        .first(),
    ).toContainText("—");

    // Every tooltip and detail time is labelled UTC, not the visitor's zone.
    const own = page.locator(
      `.pool-card[data-pool-id="${alphaPool.address.toLowerCase()}"]`,
    );
    await expect(own.locator(".pool-age time")).toHaveAttribute(
      "title",
      "1 Oct 2026, 00:00 UTC",
    );
    await expect(own.locator(".pool-measured[title]")).toHaveAttribute(
      "title",
      "28 Oct 2026, 14:04 UTC",
    );
    const staleAddress = value.pools.find(
      (row) => row.id === "base:alpha4",
    ).address;
    const stale = page.locator(
      `.pool-card[data-pool-id="${staleAddress.toLowerCase()}"]`,
    );
    await stale.getByRole("button", { name: /^Details for / }).click();
    await expect(stale.locator(".pool-recorded-observation time")).toHaveText(
      "28 Oct 2026, 13:50 UTC",
    );
    const poolList = await page
      .locator(".pool-card")
      .evaluateAll((rows) =>
        rows
          .flatMap((row) =>
            [row, ...row.querySelectorAll("[title], [aria-label]")].flatMap(
              (el) =>
                ["title", "aria-label"].map(
                  (name) => el.getAttribute(name) ?? "",
                ),
            ),
          )
          .concat(rows.map((row) => row.textContent ?? "")),
      );
    for (const text of poolList)
      assert.doesNotMatch(
        text,
        /\d{1,2}:\d{2}:\d{2}\s?[AP]M|GMT[+-]|\b\d{1,2}\/\d{1,2}\/\d{4}\b/,
        `a time in the visitor's zone: ${text}`,
      );

    // Another window orders by that window's volume and says so.
    await s.open("?project=alpha&window=h1");
    await expect(drawer.locator(".pool-list-progress")).toContainText(
      "Sorted by 1H volume",
    );
    assert.deepEqual(
      await cardIds(page),
      expectedOrder(value, "h1").slice(0, 20),
    );
    s.verify();
  },
);

test(
  "the pool order is judged at the snapshot's time, not the visitor's, forty days later",
  { skip: FIXTURE_ONLY },
  async (t) => {
    const value = manyPools();
    // Every measurement here is current at the snapshot's time and forty days old
    // on the visitor's clock. A sort that read the visitor's clock would find no
    // pool current, and fall back to the pool id while still saying "by volume".
    const s = await site(t, {
      snapshot: value,
      visitorNow: generated + 40 * DAY,
    });
    const { drawer, page } = s;
    for (const [window, label] of [
      ["h24", "24H"],
      ["h6", "6H"],
      ["h1", "1H"],
    ]) {
      await s.open(
        window === "h24" ? "?project=alpha" : `?project=alpha&window=${window}`,
      );
      const more = drawer.getByRole("button", {
        name: /^Show \d+ more pools?/,
      });
      while (await more.count()) await more.first().click();
      await expect(drawer.locator(".pool-list-progress")).toHaveText(
        `Showing ${4 + ADDED} of ${4 + ADDED} measured pools · Sorted by ${label} volume`,
      );
      const expected = expectedOrder(value, window);
      assert.equal(expected.length, 4 + ADDED);
      assert.deepEqual(
        await cardIds(page),
        expected,
        `${label} order at the visitor's +40 days`,
      );
    }
    s.verify();
  },
);

/** Lists every pool (the one created the year before has the longest date)
 * and checks that each Created date stays inside its column. */
async function assertCreatedFits(s, width) {
  const { page, drawer } = s;
  await expect(page.locator(".pool-table-head")).toBeVisible();
  for (const label of ["Show 20 more pools", "Show 8 more pools"])
    await drawer.getByRole("button", { name: label }).click();
  const columns = await page.evaluate(() => {
    const head = document.querySelector(".pool-table-head > span:last-child");
    const box = head.getBoundingClientRect();
    return [...document.querySelectorAll(".pool-age time")].map((time) => {
      const at = time.getBoundingClientRect();
      return {
        text: time.textContent,
        left: at.left - box.left,
        right: at.right - box.right,
      };
    });
  });
  assert.equal(columns.length, 4 + ADDED, `every pool is listed at ${width}px`);
  assert.ok(
    columns.some((row) => /^31 Dec 2025, 23:59 UTC$/.test(row.text)),
    `the year is shown at ${width}px`,
  );
  for (const row of columns) {
    assert.ok(
      row.right <= 1,
      `${row.text} runs past the column's right edge by ${row.right} at ${width}px`,
    );
    assert.ok(
      row.left >= -1,
      `${row.text} runs past the column's left edge by ${row.left} at ${width}px`,
    );
  }
}

test(
  "the Created column holds a date with its year, and a search keeps the order",
  { skip: FIXTURE_ONLY },
  async (t) => {
    const s = await site(t, { snapshot: manyPools() });
    await s.open("?project=alpha&window=h24");
    await assertCreatedFits(s, DESKTOP.width);
    // A search among the measured pools keeps the volume order.
    await s.drawer.getByRole("searchbox", { name: "Search pools" }).fill("T1");
    await expect(s.drawer.locator(".pool-list-progress")).toContainText(
      "matching measured pools",
    );
    s.verify();
  },
);

test(
  "the Created column holds a date with its year at the widths between a phone and a desktop",
  { skip: FIXTURE_ONLY },
  async (t) => {
    // 601 to 767 px keeps the table, with a narrower grid than the desktop's
    // (600 px and below turn each pool into a card).
    for (const width of [620, 660, 700, 767]) {
      const s = await site(t, {
        size: { width, height: 900 },
        snapshot: manyPools(),
      });
      await s.open("?project=alpha&window=h24");
      await assertCreatedFits(s, width);
      s.verify();
    }
  },
);

test(
  "on a phone the drawer states when the snapshot was taken and keeps a long date inside the sheet",
  { skip: FIXTURE_ONLY },
  async (t) => {
    const value = manyPools();
    // The visitor comes back forty days later: the page behind the drawer says
    // how old it is, but is covered by the drawer on a phone.
    const s = await site(t, {
      size: PHONE,
      snapshot: value,
      visitorNow: generated + 40 * DAY,
    });
    await s.open("?project=alpha");
    await expect(s.drawer.getByTestId("drawer-snapshot-time")).toBeVisible();
    await expect(s.drawer.getByTestId("drawer-snapshot-time")).toHaveText(
      "Snapshot taken 28 Oct 2026, 14:05 UTC",
    );
    // The measurement notes in the totals name their own times in UTC too.
    await expect(s.drawer.locator(".detail-stats")).toContainText("UTC");
    for (const label of ["Show 20 more pools", "Show 8 more pools"])
      await s.drawer.getByRole("button", { name: label }).click();
    const fit = await s.page.evaluate(() => {
      const drawer = document.querySelector(".project-detail");
      return {
        pageWider: document.documentElement.scrollWidth > innerWidth,
        drawerWider: drawer.scrollWidth > drawer.clientWidth,
        outside: [...drawer.querySelectorAll(".pool-age time")]
          .filter((time) => time.getBoundingClientRect().right > innerWidth)
          .map((time) => time.textContent),
      };
    });
    assert.deepEqual(fit, {
      pageWider: false,
      drawerWider: false,
      outside: [],
    });
    s.verify();
  },
);

/** Every ISO time inside a JSON text moved by `ms`: another run of the same data. */
const shiftTimes = (text, ms) =>
  text.replace(
    /"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)"/g,
    (_, time) => `"${new Date(Date.parse(time) + ms).toISOString()}"`,
  );

/** The one way the edition still fails to reach a newer snapshot with a
 * snapshot on screen: the overview file belongs to a later run than the
 * snapshot (a deploy landed between the two requests), so the page asks for the
 * snapshot again under that run's address (`snapshot.json?v=<run>`, three
 * tries), and those requests fail. The page asks for nothing on return to the
 * tab any more (it reads a small status file instead). Opens Analytics to load
 * the later overview and returns once the three tries have failed and the page
 * has stopped. */
async function failToCatchUp(s, blocked, ms) {
  const later = shiftTimes(
    readFileSync(resolve(DATA, "overview-all-h24.json"), "utf8"),
    ms,
  );
  s.server.setData("overview-all-h24.json", later);
  const tried = blocked.length;
  await s.page.getByTestId("view-analytics").click();
  await expect.poll(() => blocked.length, { timeout: 30000 }).toBe(tried + 3);
  await expect(s.page.locator(".error-notice")).toBeVisible();
  // After its third try the page says the newer snapshot is still being
  // published, and stops (no loop).
  await expect(s.page.getByText(PUBLISHING_NOTE)).toHaveCount(1, {
    timeout: 30000,
  });
  await s.page.waitForTimeout(300);
  assert.equal(blocked.length, tried + 3, "no fourth try");
}

test(
  "a failed check for a newer snapshot offers Retry inside the drawer and says which snapshot is shown",
  { skip: FIXTURE_ONLY },
  async (t) => {
    const s = await site(t);
    // The snapshot a newer run's address cannot deliver.
    const blocked = [];
    await s.context.route(/\/snapshot\.json\?v=/, (route) => {
      blocked.push(route.request().url());
      return route.fulfill({
        status: 404,
        contentType: "text/plain",
        body: "Not found",
      });
    });
    await s.page.goto(s.server.url);
    await expect(s.page.getByTestId("snapshot-line")).toBeVisible({
      timeout: 30000,
    });
    await failToCatchUp(s, blocked, 3 * HOUR);
    // Back on Discover the drawer opens with the failure in it.
    await s.page.getByTestId("view-overview").click();
    await s.page
      .getByRole("button", { name: "View Alpha Markets details" })
      .click();
    await expect(s.drawer).toBeVisible();
    const notice = s.drawer.getByTestId("project-service-notice");
    await expect(notice).toContainText("Couldn’t check for a newer snapshot");
    await expect(notice).toContainText(
      "Showing the snapshot taken 28 Oct 2026, 14:05 UTC.",
    );
    await expect(notice).not.toContainText(
      /resume automatically|last loaded project/i,
    );
    // The notice is part of the drawer, which is what a phone shows.
    const retry = notice.getByRole("button", { name: "Retry" });
    const focusedControl = () =>
      s.page.evaluate(() => {
        const active = document.activeElement;
        return {
          inNotice: Boolean(active?.closest(".detail-service-notice")),
          text: active?.textContent?.trim() ?? "",
        };
      });
    // Retry while the snapshot still cannot be fetched. The keyboard stays on
    // the button (a disabled one would drop it) and the notice says the retry
    // ran and failed.
    s.server.setData("snapshot.json", null);
    await retry.focus();
    await s.page.keyboard.press("Enter");
    assert.equal(
      (await focusedControl()).inNotice,
      true,
      "focus stays on Retry while it checks",
    );
    await expect(notice.locator("strong")).toHaveText(
      "Still couldn’t check for a newer snapshot",
    );
    await expect(notice).toContainText(
      "Showing the snapshot taken 28 Oct 2026, 14:05 UTC.",
    );
    assert.deepEqual(await focusedControl(), {
      inNotice: true,
      text: "Retry",
    });
    // A second press is just as safe, and Tab carries on from the button.
    await s.page.keyboard.press("Enter");
    await expect(notice.locator("strong")).toHaveText(
      "Still couldn’t check for a newer snapshot",
    );
    assert.equal((await focusedControl()).text, "Retry");
    await s.page.keyboard.press("Tab");
    const next = await s.page.evaluate(() => ({
      inDrawer: Boolean(document.activeElement?.closest(".project-detail")),
      label:
        document.activeElement?.getAttribute("aria-label") ??
        document.activeElement?.textContent?.trim(),
    }));
    assert.equal(next.inDrawer, true, "Tab stays in the drawer");
    assert.notEqual(
      next.label,
      "Close panel",
      "Tab does not restart the drawer",
    );

    // The snapshot comes back: the next press loads it and the notice goes.
    s.server.setData("snapshot.json", snapshotText);
    await retry.focus();
    await s.page.keyboard.press("Enter");
    await expect(notice).toHaveCount(0);
    await expect(
      s.drawer.locator(".readout", { hasText: "Pools measured" }),
    ).toBeVisible();
    assert.equal(blocked.length, 3, "Retry asks for the plain address");

    // A failure after that is a new one, not "still": a still later run.
    await s.page.getByRole("button", { name: "Close panel" }).click();
    await expect(s.drawer).toHaveCount(0);
    await failToCatchUp(s, blocked, 6 * HOUR);
    await s.page.getByTestId("view-overview").click();
    await s.page
      .getByRole("button", { name: "View Alpha Markets details" })
      .click();
    await expect(notice.locator("strong")).toHaveText(
      "Couldn’t check for a newer snapshot",
    );
    // Unreachable files are logged by the browser; nothing else may be.
    assert.deepEqual(
      s.errors.filter((line) => !/404|Failed to load resource/i.test(line)),
      [],
    );
    assert.deepEqual(s.server.apiRequests(), [], "requests to /api");
  },
);

test(
  "a project with one measured pool reads in the singular and has nothing to sort",
  { skip: FIXTURE_ONLY },
  async (t) => {
    const s = await site(t);
    // Delta has the one pool the fixture gives it.
    await s.open("?project=delta");
    await expect(cards(s.page)).toHaveCount(1);
    await expect(s.drawer.locator(".pool-list-progress")).toHaveText(
      "Showing 1 of 1 measured pool",
    );
    await expect(s.drawer.locator(".project-structure")).toContainText(
      "1 measured pool",
    );
    // A figure keeps its tooltip.
    await expect(
      s.drawer
        .getByRole("button", { name: "Explore pools using these hooks" })
        .locator("strong"),
    ).toHaveAttribute("title", "1");
    // More than one is still plural and says how it is ordered.
    await s.open("?project=gamma");
    await expect(s.drawer.locator(".pool-list-progress")).toHaveText(
      "Showing 3 of 3 measured pools · Sorted by 24H volume",
    );
    // A search that leaves one pool leaves nothing to sort either.
    await s.drawer
      .getByRole("searchbox", { name: "Search pools" })
      .fill(
        snapshotFixture.pools.find((row) => row.id === "ethereum:gamma2").name,
      );
    await expect(cards(s.page)).toHaveCount(1);
    await expect(s.drawer.locator(".pool-list-progress")).toHaveText(
      "Showing 1 of 1 matching measured pool",
    );
    s.verify();
  },
);

test(
  "a pool without price data says the snapshot holds none",
  { skip: FIXTURE_ONLY },
  async (t) => {
    const s = await site(t);
    // base:beta2 has neither volume nor reserves in the fixture.
    await s.open("?project=beta");
    const address = snapshotFixture.pools
      .find((row) => row.id === "base:beta2")
      .address.toLowerCase();
    const card = s.page.locator(`.pool-card[data-pool-id="${address}"]`);
    await expect(card.locator(".pool-measured")).toHaveText(
      "No price data in this snapshot.",
    );
    // "Yet" promises a fill-in a frozen file does not make.
    assert.doesNotMatch(await card.innerText(), /yet|isn’t available/i);
    s.verify();
  },
);

test(
  "a hook found in the census is dated and one reported by the indexer is named for it",
  { skip: FIXTURE_ONLY },
  async (t) => {
    const s = await site(t, { snapshot: discoveredHooks() });
    await s.open("?project=hook-census");
    await expect(s.drawer.locator(".project-origin")).toContainText(
      "Onchain discovery",
    );
    await expect(s.drawer.locator(".detail-summary")).toHaveText(
      "Hook contract identified in Uniswap v4 pool creation events. Census as of 27 Oct 2026.",
    );
    await s.drawer.getByRole("button", { name: "About this data" }).click();
    await expect(s.drawer.locator("#project-data-details")).toContainText(
      "Found in Uniswap v4 pool creation events. No named registry listing is available. Census as of 27 Oct 2026.",
    );

    await s.open("?project=hook-indexer");
    await expect(s.drawer.locator(".project-origin")).toContainText(
      "Reported by the v4.xyz indexer",
    );
    await expect(s.drawer.locator(".detail-summary")).toHaveText(
      "Hook address reported by the v4.xyz indexer for pools Hook Radar measured. Project identity and contract source have not been verified.",
    );
    await s.drawer.getByRole("button", { name: "About this data" }).click();
    const panel = await s.drawer.locator("#project-data-details").innerText();
    assert.doesNotMatch(panel, /pool creation events|census/i);
    assert.doesNotMatch(
      await s.drawer.locator(".detail-hero").innerText(),
      /pool creation events/i,
    );
    s.verify();
  },
);

// The same rules on a real snapshot: whatever projects it holds.
test(
  "a real snapshot's drawers say what was measured",
  { skip: REAL_ONLY },
  async (t) => {
    const withPools = new Map();
    for (const row of snapshotFixture.pools)
      if (row.projectId)
        withPools.set(row.projectId, (withPools.get(row.projectId) ?? 0) + 1);
    const largest = [...withPools].sort((a, b) => b[1] - a[1])[0];
    const empty = snapshotFixture.projects.find(
      (row) => row.entityType !== "platform" && !withPools.has(row.id),
    );
    assert.ok(largest && empty, "a project with pools and one without");

    const phone = await site(t, {
      size: PHONE,
      visitorNow: generated + 40 * DAY,
    });
    await phone.open(`?project=${empty.id}`);
    await expect(phone.drawer.locator(".empty-state h3")).toHaveText(
      "No pools measured in this snapshot",
    );
    assert.doesNotMatch(
      await phone.drawer.innerText(),
      /\byet\b|market sources|Pools found/i,
    );
    await expect(
      phone.drawer.getByTestId("drawer-snapshot-time"),
    ).toContainText("Snapshot taken");

    const s = await site(t);
    await s.open(`?project=${largest[0]}`);
    await expect(
      s.drawer.locator(".readout", { hasText: "Pools measured" }),
    ).toContainText(`${largest[1]}`);
    await expect(s.drawer.locator(".pool-list-progress")).toContainText(
      "measured pools · Sorted by 24H volume",
    );
    const volumes = await s.page
      .locator(".pool-card")
      .evaluateAll((rows) =>
        rows.map(
          (row) => row.querySelector(".pool-metric-value")?.textContent ?? "",
        ),
      );
    const number = (text) => {
      const match = /^\$([\d,.]+)([KMB]?)$/.exec(text);
      return match
        ? Number(match[1].replace(/,/g, "")) *
            { "": 1, K: 1e3, M: 1e6, B: 1e9 }[match[2]]
        : null;
    };
    const amounts = volumes.map(number);
    for (let index = 1; index < amounts.length; index++)
      if (amounts[index] !== null && amounts[index - 1] !== null)
        assert.ok(
          amounts[index - 1] >= amounts[index] * 0.999,
          `${volumes[index - 1]} before ${volumes[index]}`,
        );
    // The tooltips of the pool rows are UTC.
    const titles = await s.page
      .locator(".pool-card time[title], .pool-card .pool-measured[title]")
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("title")));
    assert.ok(titles.length > 0);
    for (const title of titles)
      assert.match(title, /^\d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2} UTC$/);
    s.verify();
  },
);
