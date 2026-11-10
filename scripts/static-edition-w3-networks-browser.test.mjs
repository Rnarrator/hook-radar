// The Networks and Analytics fixes of the Auto Snapshot edition in a real
// browser: what a pricing row says when the price source gave no result and how
// many networks "checked" counts (Data details on Networks and the Evidence
// section of Analytics), the empty state of a network no project lists, exact
// amounts in cents in every title, aria-label and aria-valuetext, and the files
// the page exports. It builds nothing: point it at an edition build
// (VITE_STATIC_EDITION=1) with RADAR_TEST_DIST and it serves that build next to
// the deterministic TEST data (tests/fixtures/static-data/data) through
// scripts/static-edition-server.mjs, with the snapshot and history replaced by
// the test's own cases. Nothing is written to any data folder and no service is
// touched.
//
//   RADAR_TEST_DIST=<build> node --test scripts/static-edition-w3-networks-browser.test.mjs
//
// RADAR_TEST_PORT names the port the test server listens on (default: any free
// port). RADAR_TEST_DATA names another published-data folder for the one test
// that reads the snapshot as a collector run made it; the others always use the
// fixtures, which are the cases they need.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { startStaticEditionServer } from "./static-edition-server.mjs";
import { sourcesDialogDist } from "./edition-sources-build.mjs";

const DIST = resolve(process.env.RADAR_TEST_DIST || "dist");
// "Data details" opens the Data & sources dialog, which the edition's page does
// not have (its owner's choice, EDITION_SOURCES_DIALOG in src/edition.ts); the
// pricing checks it lists are tested on a build of the same source with the
// switch on (scripts/edition-sources-build.mjs).
const SOURCES_DIST = await sourcesDialogDist();
const FIXTURES = resolve("tests/fixtures/static-data/data");
const OWN_DATA = process.env.RADAR_TEST_DATA
  ? resolve(process.env.RADAR_TEST_DATA)
  : null;
const PORT = Number(process.env.RADAR_TEST_PORT || 0);
const DESKTOP = { width: 1440, height: 1000 };
const PHONE = { width: 390, height: 844 };

const readData = (dir, name) =>
  JSON.parse(readFileSync(resolve(dir, name), "utf8"));
const fixture = readData(FIXTURES, "snapshot.json");
const generated = Date.parse(fixture.generatedAt);

/* ── The cases ────────────────────────────────────────────────────────── */

const coverageRow = (chain, chainId, fields = {}) => ({
  chain,
  chainId,
  inventoryPools: 100,
  checkedPools: 0,
  measuredPools: 0,
  pendingPools: 100,
  missingPools: 0,
  attemptedPools: 0,
  status: "unavailable",
  ...fields,
});

/** The real snapshot's three cases: networks where a source responded (the
 * fixture's own three), Zora and X Layer asked with no result, and a network
 * nobody asked about. `flag` is the collector's optional "not indexed" mark. */
function pricingCases(flag) {
  const shot = structuredClone(fixture);
  const extra = [
    [7777777, "zora", "Zora"],
    [196, "xlayer", "X Layer"],
    [130, "unichain", "Unichain"],
  ];
  for (const [id, slug, name] of extra)
    shot.chains.push({ id, slug, name, explorer: "https://basescan.org" });
  shot.marketCoverage.networks.push(
    coverageRow("zora", 7777777, {
      inventoryPools: 11,
      pendingPools: 11,
      attemptedPools: 11,
      ...(flag ? { unsupported: true } : {}),
    }),
    coverageRow("xlayer", 196, {
      inventoryPools: 1515,
      pendingPools: 1515,
      attemptedPools: 5,
      ...(flag ? { unsupported: true } : {}),
    }),
    coverageRow("unichain", 130),
  );
  return shot;
}

/** The fixture with HyperEVM as the real census had it (27 hook contracts, 155
 * hook pools) and no project or pool in the snapshot; Ethereum's head check
 * failed at the census. Pool volumes whose sums carry float residue. */
function networkCases() {
  const shot = structuredClone(fixture);
  const template = shot.inventory.networks.find((n) => n.chain === "robinhood");
  shot.inventory.networks.push({
    ...template,
    chain: "hyperevm",
    chainId: 999,
    name: "HyperEVM",
    hookCount: 27,
    hookPoolCount: 155,
    poolCount: 167,
    updatedAt: "2026-10-27T21:08:28.976Z",
  });
  shot.chains.push({
    id: 999,
    slug: "hyperevm",
    name: "HyperEVM",
    explorer: "https://basescan.org",
  });
  Object.assign(
    shot.inventory.networks.find((n) => n.chain === "ethereum"),
    {
      status: "error",
      lastError:
        "Census source head is behind the canonical deployment or saved checkpoint",
    },
  );
  // 1000.01 + 2000.02 is 3000.0299999999997: the residue of a sum of cents.
  const alpha = shot.pools.filter(
    (pool) => pool.chain === "base" && pool.projectId === "alpha",
  );
  alpha[0].volumeUsd.h24 = 1000.01;
  alpha[1].volumeUsd.h24 = 2000.02;
  return shot;
}

const NOISY = [339226102.0600004, 339226102.0600004, 192436102.76999998];
const noisyHistory = () => ({
  schemaVersion: 1,
  points: NOISY.map((value, index) => ({
    timestamp: generated - (NOISY.length - index) * 3 * 3600_000 + 17 * 60_000,
    value,
    pools: 12,
  })).sort((a, b) => a.timestamp - b.timestamp),
});

/* ── Browser ──────────────────────────────────────────────────────────── */

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

async function site(
  t,
  {
    size = DESKTOP,
    snapshot = null,
    history = null,
    dataDir = FIXTURES,
    dist = DIST,
  } = {},
) {
  const server = await startStaticEditionServer({
    distDir: dist,
    dataDir,
    mount: "/",
    port: PORT,
  });
  if (snapshot) server.setData("snapshot.json", snapshot);
  if (history) server.setData("history.json", history);
  const context = await browser.newContext({
    viewport: size,
    locale: "en-US",
    reducedMotion: "reduce",
    acceptDownloads: true,
  });
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
    goto: async (query = "") => {
      await page.goto(`${server.url}${query}`);
      await expect(page.getByTestId("snapshot-line")).toBeVisible({
        timeout: 30000,
      });
      await page.waitForTimeout(300);
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

const noSideways = (page, where) =>
  page.evaluate(
    (where) =>
      document.documentElement.scrollWidth <=
      document.documentElement.clientWidth + 1
        ? null
        : `${where}: the page scrolls sideways`,
    where,
  );

/** Every title, aria-label and aria-valuetext in the page that writes a dollar
 * amount of a cent or more with more than two decimals, or that is itself a
 * bare number of a cent or more with more than two decimals (the History
 * table's cells carry their exact value that way: title="339226102.0600004"). */
const overPrecise = (page) =>
  page.evaluate(() => {
    const found = [];
    for (const element of document.querySelectorAll(
      "[title], [aria-label], [aria-valuetext]",
    ))
      for (const name of ["title", "aria-label", "aria-valuetext"]) {
        const value = element.getAttribute(name);
        if (!value) continue;
        for (const match of value.matchAll(/\$([\d,]+\.\d{3,})/g))
          if (Number(match[1].replaceAll(",", "")) >= 0.01)
            found.push(`${name}: ${value.slice(0, 140)}`);
        if (
          /^-?\d+\.\d{3,}$/.test(value.trim()) &&
          Math.abs(Number(value)) >= 0.01
        )
          found.push(`${name}: ${value.slice(0, 140)}`);
      }
    return found;
  });

async function openDataDetails(page) {
  await page.getByRole("button", { name: "Data details" }).click();
  const summary = page
    .locator("summary", { hasText: "Pricing checks by network" })
    .first();
  await summary.scrollIntoViewIfNeeded();
  await summary.click();
  return page.locator(".market-coverage").first();
}

/* ── Pricing checks by network ────────────────────────────────────────── */

for (const [label, size] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
]) {
  test(`Data details (${label}), with the switch on: no pricing result is not a source that did not respond`, async (t) => {
    const s = await site(t, {
      size,
      snapshot: pricingCases(false),
      dist: SOURCES_DIST,
    });
    await s.goto("?view=chains");
    const card = await openDataDetails(s.page);
    const zora = card.locator(".market-network-list li", { hasText: "Zora" });
    await expect(zora).toContainText("No pricing results for this network");
    await expect(zora).toContainText(/Checked\s*0\s*of\s*11/);
    const xlayer = card.locator(".market-network-list li", {
      hasText: "X Layer",
    });
    await expect(xlayer).toContainText("No pricing results for this network");
    await expect(xlayer).toContainText(/Checked\s*0\s*of\s*1,515/);
    // The source did respond for the three fixture networks; Zora and X Layer
    // gave no result and Unichain was not asked.
    await expect(card).toContainText("Checks were made on 3 of 6 networks.");
    const text = await s.page.locator("body").innerText();
    assert.doesNotMatch(text, /did not respond/i);
    assert.doesNotMatch(text, /Checks were made on 5 of 6/);
    assert.equal(await noSideways(s.page, "Data details"), null);
    s.verify();
  });

  test(`Data details (${label}), with the switch on: a network the collector marked as not indexed says so`, async (t) => {
    const s = await site(t, {
      size,
      snapshot: pricingCases(true),
      dist: SOURCES_DIST,
    });
    await s.goto("?view=chains");
    const card = await openDataDetails(s.page);
    for (const name of ["Zora", "X Layer"]) {
      const row = card.locator(".market-network-list li", { hasText: name });
      await expect(row).toContainText("Not indexed by the price source");
      await expect(row.locator("[data-state]").first()).toHaveAttribute(
        "data-state",
        "empty",
      );
    }
    await expect(card).toContainText("Checks were made on 3 of 6 networks.");
    assert.doesNotMatch(
      await s.page.locator("body").innerText(),
      /did not respond|No pricing results/i,
    );
    s.verify();
  });
}

test("Analytics evidence counts the networks where a source responded", async (t) => {
  const s = await site(t, { snapshot: pricingCases(false) });
  await s.goto("?view=analytics");
  await s.page
    .getByRole("button", { name: "Open projects, hooks and pools" })
    .click();
  const evidence = s.page.locator("#analytics-coverage");
  await expect(evidence).toBeVisible({ timeout: 30000 });
  await expect(evidence).toContainText("Checks were made on 3 of 6 networks.");
  assert.doesNotMatch(await evidence.innerText(), /did not respond|4 of 6/);
  s.verify();
});

/* ── A network no project lists ───────────────────────────────────────── */

for (const [label, size] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
]) {
  test(`Networks (${label}): a network with no listed project has no dead control`, async (t) => {
    const s = await site(t, { size, snapshot: networkCases() });
    await s.goto("?view=chains&chain_network=hyperevm");
    const empty = s.page.locator(".empty-state");
    await expect(empty).toContainText("No listed projects on this network");
    await expect(empty).toContainText(
      "No project in the 28 Oct 2026 snapshot lists or measures a hook on this network. The census (27 Oct 2026) counts 27 hook contracts here; their addresses are not part of this snapshot.",
    );
    await expect(empty.getByRole("button")).toHaveCount(0);
    await expect(
      s.page.getByRole("button", { name: "Explore on-chain hooks" }),
    ).toHaveCount(0);
    // The header offers no second way to the same empty list; its other
    // actions stay.
    const actions = s.page.locator(".chains-profile-actions");
    await expect(
      actions.getByRole("button", { name: "Network analytics" }),
    ).toBeVisible();
    await expect(
      s.page.getByRole("button", { name: /Browse (all|registry) hooks/ }),
    ).toHaveCount(0);
    assert.doesNotMatch(
      await s.page.locator("body").innerText(),
      /on-chain discovery/i,
    );
    assert.equal(await noSideways(s.page, "hyperevm"), null);
    s.verify();
  });
}

test("Networks: a network that has listed projects is unchanged", async (t) => {
  const s = await site(t, { snapshot: networkCases() });
  await s.goto("?view=chains&chain_network=base");
  await expect(s.page.locator("#chains-projects")).toBeVisible();
  await expect(s.page.locator(".chains-protocol-list")).toBeVisible();
  await expect(
    s.page.getByRole("button", { name: "Browse all hooks" }),
  ).toBeVisible();
  assert.doesNotMatch(
    await s.page.locator("#chains-projects").innerText(),
    /lists or measures a hook|No listed projects/,
  );
  s.verify();
});

/* ── Exact amounts ────────────────────────────────────────────────────── */

test("Networks and Analytics: no title or aria-label writes an amount past the cent", async (t) => {
  const s = await site(t, {
    snapshot: networkCases(),
    history: noisyHistory(),
  });
  await s.goto("?view=chains");
  assert.deepEqual(await overPrecise(s.page), [], "Networks, all networks");
  // The residue really is in the data the figures come from.
  const titles = await s.page.evaluate(() =>
    [...document.querySelectorAll("[title], [aria-label]")]
      .map(
        (el) => `${el.getAttribute("title")} ${el.getAttribute("aria-label")}`,
      )
      .join("\n"),
  );
  assert.match(titles, /\$[\d,]+\.\d{2}\b/, "exact amounts are read in cents");
  await s.goto("?view=chains&chain_network=base");
  assert.deepEqual(await overPrecise(s.page), [], "Networks, Base");
  // The project directory's exact volume: 1000.01 + 2000.02.
  await expect(
    s.page.locator('.chains-protocol-metrics dd[title="$3,000.03"]').first(),
  ).toBeAttached();

  await s.goto("?view=analytics");
  await s.page
    .getByRole("button", { name: "Open projects, hooks and pools" })
    .click();
  const history = s.page.locator("#analytics-history");
  await expect(history).toBeVisible({ timeout: 30000 });
  assert.deepEqual(await overPrecise(s.page), [], "Analytics workspace");
  // The inspected value, the slider and the recorded values all read in cents.
  await expect(history.locator(".history-inspect-meta dd").first()).toHaveText(
    "$192,436,102.77",
  );
  const slider = history.locator('[role="slider"]').first();
  await expect(slider).toHaveAttribute(
    "aria-valuetext",
    /\$192,436,102\.77 observed 24h volume$/,
  );
  await history.getByText("View recorded values").click();
  // The table renders when the disclosure opens: wait for its rows before
  // reading them (allInnerTexts and evaluateAll do not wait).
  const valueCells = history.locator(".chart-table tbody td:nth-child(2)");
  await expect(valueCells).toHaveCount(3);
  const rows = await valueCells.allInnerTexts();
  assert.deepEqual(rows.map((row) => row.trim()).sort(), [
    "$192,436,102.77",
    "$339,226,102.06",
    "$339,226,102.06",
  ]);
  // Each cell also carries its exact value in its title: in cents, as the cell
  // reads, not the stored sum (339226102.0600004).
  const cellTitles = await valueCells.evaluateAll((cells) =>
    cells.map((cell) => cell.getAttribute("title")),
  );
  assert.deepEqual(cellTitles.sort(), [
    "192436102.77",
    "339226102.06",
    "339226102.06",
  ]);
  assert.deepEqual(await overPrecise(s.page), [], "Analytics, table open");
  assert.doesNotMatch(await history.innerText(), /0600004|76999998/);
  s.verify();
});

test("the exported files write amounts in cents and say how the head check ended", async (t) => {
  const s = await site(t, {
    snapshot: networkCases(),
    history: noisyHistory(),
  });
  await s.goto("?view=analytics");
  await s.page
    .getByRole("button", { name: "Open projects, hooks and pools" })
    .click();
  const history = s.page.locator("#analytics-history");
  await expect(history).toBeVisible({ timeout: 30000 });

  // The history file: every value as the page shows it, nothing else changed.
  const [historyFile] = await Promise.all([
    s.page.waitForEvent("download"),
    history.getByRole("button", { name: "History CSV" }).click(),
  ]);
  const historyCsv = readFileSync(await historyFile.path(), "utf8")
    .replace(/^﻿/, "")
    .trimEnd()
    .split("\r\n");
  const cells = (line) => line.slice(1, -1).split('","');
  const values = historyCsv.slice(1).map((line) => cells(line)[2]);
  assert.deepEqual(values.sort(), [
    "192436102.77",
    "339226102.06",
    "339226102.06",
  ]);

  // The analytics file.
  const [analyticsFile] = await Promise.all([
    s.page.waitForEvent("download"),
    s.page.getByRole("button", { name: "Export analytics CSV" }).click(),
  ]);
  const lines = readFileSync(await analyticsFile.path(), "utf8")
    .replace(/^﻿/, "")
    .trimEnd()
    .split("\r\n");
  const header = cells(lines[0]);
  const at = (name) => header.indexOf(name);
  assert.ok(at("head_check_at_census") > at("head_checked_at"), "the column");
  const rowsOf = lines.slice(1).map(cells);
  const network = (id) =>
    rowsOf.find((row) => row[0] === "network" && row[at("id")] === id);
  // Ethereum's head check failed at the census; Base's passed.
  assert.equal(network("ethereum")[at("head_check_at_census")], "failed");
  assert.equal(network("base")[at("head_check_at_census")], "passed");
  assert.equal(
    network("ethereum")[at("head_checked_at")],
    fixture.inventory.networks.find((n) => n.chain === "ethereum")
      .headCheckedAt,
    "the time of the last passing check, as recorded",
  );
  for (const row of rowsOf)
    for (const name of ["observed_volume_usd", "observed_liquidity_usd"]) {
      const value = row[at(name)];
      if (value === "" || Number(value) < 0.01) continue;
      assert.ok(
        (value.split(".")[1] ?? "").length <= 2,
        `${row[0]} ${name} ${value}`,
      );
    }
  s.verify();
});

test("a real collector run reads the same (RADAR_TEST_DATA)", async (t) => {
  if (!OWN_DATA) return t.skip("no RADAR_TEST_DATA");
  const real = readData(OWN_DATA, "snapshot.json");
  const s = await site(t, { dataDir: OWN_DATA });
  await s.goto("?view=chains");
  assert.deepEqual(await overPrecise(s.page), [], "Networks, real data");
  const card = await openDataDetails(s.page);
  const asked = real.marketCoverage.networks.filter(
    (row) => row.checkedPools > 0,
  ).length;
  const all = real.marketCoverage.networks.length;
  if (asked < all)
    await expect(card).toContainText(
      `Checks were made on ${asked} of ${all} networks.`,
    );
  assert.doesNotMatch(
    await s.page.locator("body").innerText(),
    /did not respond/i,
  );
  await s.goto("?view=analytics");
  await s.page
    .getByRole("button", { name: "Open projects, hooks and pools" })
    .click();
  await expect(s.page.locator("#analytics-history")).toBeVisible({
    timeout: 30000,
  });
  assert.deepEqual(await overPrecise(s.page), [], "Analytics, real data");

  // An indexed network that no project lists and no pool measures (HyperEVM
  // in the first collector runs) has no header button to an empty list. The
  // rule is the hooks list's own: a deployment on the network, a pool on it, or
  // a platform that lists it.
  const listed = new Set([
    ...real.projects.flatMap((project) => [
      ...project.deployments.map((deployment) => deployment.chain),
      ...(project.entityType === "platform" ? project.chains : []),
    ]),
    ...real.pools.map((pool) => pool.chain),
  ]);
  const bare = real.inventory.networks.filter(
    (network) => !listed.has(network.chain),
  );
  for (const network of bare) {
    await s.goto(`?view=chains&chain_network=${network.chain}`);
    await expect(s.page.locator(".chains-profile-actions")).toBeVisible();
    await expect(
      s.page.getByRole("button", { name: /Browse (all|registry) hooks/ }),
      network.chain,
    ).toHaveCount(0);
    await expect(
      s.page.getByRole("button", { name: "Explore on-chain hooks" }),
    ).toHaveCount(0);
  }
  // A network that lists projects keeps the button.
  const withProjects = real.inventory.networks.find((network) =>
    listed.has(network.chain),
  );
  if (withProjects) {
    await s.goto(`?view=chains&chain_network=${withProjects.chain}`);
    await expect(
      s.page.getByRole("button", { name: "Browse all hooks" }),
    ).toBeVisible();
  }
  s.verify();
});
