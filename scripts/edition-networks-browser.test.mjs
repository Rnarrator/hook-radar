// The Networks pages and the masthead of the Auto Snapshot edition in a real
// browser, with the visitor in Bangkok (UTC+7), where local time and the
// snapshot's UTC dates fall on different days. It builds nothing: point it at an
// edition build (VITE_STATIC_EDITION=1) with RADAR_TEST_DIST.
//
//   RADAR_TEST_DIST=<build> node --test scripts/edition-networks-browser.test.mjs
//
// By default it serves the deterministic TEST data in tests/fixtures/static-data/
// data and makes two of its networks the cases that matter: one whose head check
// failed at the census, and one with no census at all. RADAR_TEST_DATA names
// another data folder (a collector run); the test then uses the networks that
// folder really has and fails if it has no such case. Nothing here writes data.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { startStaticEditionServer } from "./static-edition-server.mjs";
import { censusLabel, fullTimeLabel } from "../src/edition.ts";

const DIST = resolve(process.env.RADAR_TEST_DIST || "dist");
const OWN_DATA = Boolean(process.env.RADAR_TEST_DATA);
const DATA = resolve(
  process.env.RADAR_TEST_DATA || "tests/fixtures/static-data/data",
);
const DESKTOP = { width: 1440, height: 1000 };
const PHONE = { width: 390, height: 844 };

const snapshot = JSON.parse(
  readFileSync(resolve(DATA, "snapshot.json"), "utf8"),
);
const html = readFileSync(resolve(DIST, "index.html"), "utf8");
const entry =
  html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/)?.[1] ?? "";
const MOUNT = entry.startsWith("./")
  ? "/"
  : entry.replace(/assets\/[^/]+$/, "") || "/";

const failed = (network) => ["error", "unavailable"].includes(network.status);
const HEAD_ERRORS = [
  "Census source head is behind the canonical deployment or saved checkpoint",
  "Census source returned an invalid finalized head",
  "Census head contradicts the saved checkpoint hash",
];

// The data under test. With the fixtures, make the two cases; with a real
// collector run, find them.
let served = snapshot;
if (!OWN_DATA) {
  served = structuredClone(snapshot);
  const victim = served.inventory.networks.find((n) => n.chain === "ethereum");
  victim.status = "error";
  victim.lastError =
    "Census source head is behind the canonical deployment or saved checkpoint";
  // Robinhood has no census: it is listed, but nothing was counted for it.
  served.inventory.networks = served.inventory.networks.filter(
    (n) => n.chain !== "robinhood",
  );
}
const failedNetwork = served.inventory.networks.find(failed);
const uncensused = served.chains.find(
  (chain) => !served.inventory.networks.some((n) => n.chain === chain.slug),
);
// The same census, but the failed network's error is a deadline, which says
// nothing about its head. A page must not call that a failed head check.
const NOT_HEAD_ERROR = "Public census step exceeded its deadline";
const notHead = structuredClone(served);
const notHeadNetwork = notHead.inventory.networks.find(
  (n) => n.chain === failedNetwork?.chain,
);
if (notHeadNetwork) {
  notHeadNetwork.lastError = NOT_HEAD_ERROR;
  // The scan fell short of its target by a tenth of its range.
  notHeadNetwork.scannedToBlock =
    notHeadNetwork.targetBlock -
    Math.max(
      1,
      Math.floor((notHeadNetwork.targetBlock - notHeadNetwork.startBlock) / 10),
    );
}
// The label the page prints: the census date and how many days before the
// snapshot it was taken (the fixture's census is the day before its snapshot).
const census = censusLabel(served.inventory, served.generatedAt);
const censusDay = census.replace(/^census as of /, "");
const HOOKS_SCOPE =
  "A hook used on two networks is counted on both; newer hooks are not included.";

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
  { size = DESKTOP, timezoneId = "Asia/Bangkok", data = null } = {},
) {
  const server = await startStaticEditionServer({
    distDir: DIST,
    dataDir: DATA,
    mount: MOUNT,
  });
  if (data) server.setData("snapshot.json", data);
  else if (!OWN_DATA) server.setData("snapshot.json", served);
  const context = await browser.newContext({
    viewport: size,
    timezoneId,
    locale: "en-US",
    reducedMotion: "reduce",
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
      await page.waitForTimeout(400);
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

// The parts of the Networks page these components draw: the toolbar, the
// profile, the summary, the charts and the ledger. (The project catalog below
// them is another component's.)
const OWN =
  ".chains-toolbar, .chains-profile, #chains-overview, .chain-charts, #chains-networks, .empty-state";

/** Every title and aria-label, and the text, inside the parts named. */
const everything = (page, selector = OWN) =>
  page.evaluate((selector) => {
    const attributes = [];
    const text = [];
    for (const root of document.querySelectorAll(selector)) {
      text.push(root.innerText);
      for (const element of [
        root,
        ...root.querySelectorAll("[title], [aria-label]"),
      ])
        for (const name of ["title", "aria-label"]) {
          const value = element.getAttribute(name);
          if (value) attributes.push(value);
        }
    }
    return { attributes, text: text.join(String.fromCharCode(10)) };
  }, selector);

// A time the way the visitor's own zone would write it (en-US here), or with a
// zone name: the snapshot's dates are UTC and these would disagree with them.
const LOCAL_TIME =
  /\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:AM|PM)\b|\bGMT[+-]\d|\b\d{1,2}\/\d{1,2}\/\d{4}\b/;

test("the data has the cases this test is about", () => {
  assert.ok(failedNetwork, "a census network whose head check failed");
  assert.ok(
    HEAD_ERRORS.some((known) => failedNetwork.lastError?.startsWith(known)),
    "its recorded error is a head-check error",
  );
  assert.ok(uncensused, "a listed network with no census");
});

test("Networks: a failed head check is dated, named and agrees with the scan", async (t) => {
  const s = await site(t);
  const { page } = s;
  await s.goto("?view=chains");
  const legend = page.locator(".chain-evidence-legend");
  await expect(legend).toContainText(
    `Head check failed at census (${failedNetwork.name})`,
  );
  await expect(
    legend
      .locator("li", { hasText: "Head check failed at census" })
      .locator("b"),
  ).toHaveText("1");
  const coverage = page.locator(".chain-evidence-panel");
  await expect(coverage).toContainText(
    /of \d+ indexed networks were scanned to their recorded target when the census was taken/,
  );
  // The bar's text alternative names it too.
  await expect(page.locator(".chain-evidence-bar")).toHaveAttribute(
    "aria-label",
    new RegExp(`head check failed at census \\(${failedNetwork.name}\\)`),
  );
  const { text } = await everything(page);
  assert.doesNotMatch(text, /Index source unavailable|currently unavailable/);

  // The ledger row of that network says the same, and its tooltip is UTC.
  const more = page.getByRole("button", { name: "Show all networks" });
  if (await more.count()) await more.click();
  const row = page.locator(".chains-network-row", {
    has: page.getByRole("button", { name: `Explore ${failedNetwork.name}` }),
  });
  await expect(row.locator(".chains-network-status")).toContainText(
    "Head check failed at census",
  );
  await expect(row.locator(".chains-network-status")).toHaveAttribute(
    "title",
    new RegExp(
      `Head checked: ${fullTimeLabel(failedNetwork.headCheckedAt).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.$`,
    ),
  );
  s.verify();
});

test("one network: the footer says what the census recorded, not what is true now", async (t) => {
  const s = await site(t);
  const { page } = s;
  await s.goto(`?view=chains&chain_network=${failedNetwork.chain}`);
  const details = page.locator(".chains-index-details");
  await expect(details.locator(".chains-index-status")).toHaveText(
    "Head check failed at census",
  );
  // The time is that of the last check that passed, and says so.
  await expect(details.locator(".chains-index-head")).toHaveText(
    /^Last passing head check /,
  );
  await details.locator("summary").click();
  const checked = fullTimeLabel(failedNetwork.headCheckedAt);
  const reached = failedNetwork.scannedToBlock >= failedNetwork.targetBlock;
  await expect(details.locator("dl dt", { hasText: /head check/i })).toHaveText(
    "Last passing head check",
  );
  await expect(details.locator(".chains-warning")).toHaveText(
    `The indexing source did not pass its head check at the census (its last passing head check was ${checked}). ${
      reached
        ? "The saved block range was scanned to its recorded target."
        : "Saved block evidence remains visible."
    }`,
  );
  await expect(
    page.locator(".chain-composition-panel .chain-chart-note"),
  ).toContainText("head check failed at census");
  const { text, attributes } = await everything(page);
  assert.doesNotMatch(text, /currently unavailable|Index source unavailable/);
  // Nothing gives the passing check's time as the last check.
  assert.doesNotMatch(text, /Last head check|Head last checked|\(last checked/);
  for (const value of attributes)
    assert.doesNotMatch(value, LOCAL_TIME, `local time in "${value}"`);
  s.verify();
});

test("an error that is not a head-check failure is not called one", async (t) => {
  assert.ok(notHeadNetwork, "the failed network is in the altered data");
  const { name, chain } = notHeadNetwork;
  const s = await site(t, { data: notHead });
  const { page } = s;

  // The ledger and the legend: an error at the census, with no cause invented.
  await s.goto("?view=chains");
  const legend = page.locator(".chain-evidence-legend");
  await expect(legend).toContainText(`Index source error at census (${name})`);
  await expect(legend).not.toContainText("Head check failed");
  await expect(page.locator(".chain-evidence-bar")).toHaveAttribute(
    "aria-label",
    new RegExp(`index source error at census \\(${name}\\)`),
  );
  const more = page.getByRole("button", { name: "Show all networks" });
  if (await more.count()) await more.click();
  await expect(
    page
      .locator(".chains-network-row", {
        has: page.getByRole("button", { name: `Explore ${name}` }),
      })
      .locator(".chains-network-status"),
  ).toContainText("Index source error at census");
  const networks = await everything(page);
  assert.doesNotMatch(
    [networks.text, ...networks.attributes].join(" | "),
    /head check failed|did not pass its head|Index source unavailable|currently unavailable/i,
  );

  // The network's own page: its head check is not blamed, its time is not
  // renamed, and the scan that fell short is said to have fallen short.
  await s.goto(`?view=chains&chain_network=${chain}`);
  const details = page.locator(".chains-index-details");
  await expect(details.locator(".chains-index-status")).toHaveText(
    "Index source error at census",
  );
  await expect(details.locator(".chains-index-head")).toHaveText(
    /^Chain head checked /,
  );
  await details.locator("summary").click();
  await expect(details.locator("dl dt", { hasText: /head/i })).toHaveText(
    "Head last checked",
  );
  await expect(details.locator(".chains-warning")).toHaveText(
    "The indexing source reported an error at the census. Saved block evidence remains visible.",
  );
  await expect(
    page.locator(".chain-composition-panel .chain-chart-note"),
  ).toContainText("index source error at census");
  const own = await everything(page);
  assert.doesNotMatch(
    [own.text, ...own.attributes].join(" | "),
    /head check failed|did not pass its head|Last passing|Last head check|currently unavailable|Index source unavailable/i,
  );
  s.verify();
});

test("Networks: no tooltip shows local time, and the figure's time is the oldest measurement", async (t) => {
  for (const size of [DESKTOP, PHONE]) {
    const s = await site(t, { size });
    const { page } = s;
    await s.goto("?view=chains");
    const { text, attributes } = await everything(page);
    for (const value of attributes)
      assert.doesNotMatch(value, LOCAL_TIME, `local time in "${value}"`);
    assert.doesNotMatch(text, LOCAL_TIME);
    // The ledger's tooltips do carry UTC times.
    const titles = await page
      .locator(".chains-network-measurement[title^='Oldest']")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("title")));
    assert.ok(titles.length > 0, "a network with a measurement tooltip");
    for (const title of titles)
      assert.match(
        title,
        /^Oldest contributing measurement: \d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2} UTC$/,
      );
    // "updated" read as the time of the update; it is the oldest measurement.
    const overview = page.locator("#chains-overview");
    await expect(overview).toContainText(/oldest measured \d{2}:\d{2} UTC/);
    await expect(overview).not.toContainText(/\bupdated\b/);
    s.verify();
  }
});

test("Networks: the indexed-network count carries its census date", async (t) => {
  for (const size of [DESKTOP, PHONE]) {
    const s = await site(t, { size });
    const { page } = s;
    await s.goto("?view=chains");
    const indexed = served.inventory.networks.length;
    await expect(page.locator(".chains-scope-caption")).toContainText(
      new RegExp(
        `${served.chains.length} networks · ${indexed} indexed · census as of ${censusDay}`,
        "i",
      ),
    );
    // No sideways scrolling on the page.
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      `horizontal overflow at ${size.width}px`,
    );
    s.verify();
  }
});

test("a network with no census has no census tag", async (t) => {
  const s = await site(t);
  const { page } = s;
  await s.goto(`?view=chains&chain_network=${uncensused.slug}`);
  const panel = page.locator(".chain-composition-panel");
  await expect(panel).toContainText(
    "No pool inventory is available for this scope",
  );
  await expect(panel.getByTestId("census-note")).toHaveCount(0);
  // A network that has one keeps it.
  const counted = served.inventory.networks.find((n) => !failed(n));
  await s.goto(`?view=chains&chain_network=${counted.chain}`);
  await expect(
    page.locator(".chain-composition-panel").getByTestId("census-note"),
  ).toHaveText(census.charAt(0).toUpperCase() + census.slice(1));
  s.verify();
});

test("the masthead dates its Networks figure and agrees with the Networks page", async (t) => {
  const s = await site(t);
  const { page } = s;
  await s.goto("");
  await expect(page.getByTestId("masthead-census")).toHaveText(
    `Hooks, pools and networks: ${census}. ${HOOKS_SCOPE}`,
  );
  const figure = page
    .locator(".masthead-figures > div")
    .filter({ has: page.getByText("Networks", { exact: true }) });
  const indexed = served.inventory.networks.length;
  await expect(figure.locator("dd").first()).toHaveText(String(indexed));
  await expect(figure.locator(".masthead-note")).toHaveText(
    "with indexed pools",
  );
  // The same number the Networks page gives for the same words.
  await s.goto("?view=chains");
  await expect(page.locator(".chains-network-result-count")).toHaveText(
    `${indexed} with indexed pools`,
  );
  s.verify();
});

test("the masthead and the Networks page say how old the census was, in days", async (t) => {
  // The census 14.7 days before the snapshot: the dates differ by 15.
  const old = structuredClone(served);
  old.inventory.generatedAt = new Date(
    Date.parse(old.generatedAt) - 14.7 * 86400000,
  ).toISOString();
  const label = censusLabel(old.inventory, old.generatedAt);
  assert.match(label, /, 15 days before this snapshot$/);
  for (const size of [DESKTOP, PHONE]) {
    const s = await site(t, { size, data: old });
    const { page } = s;
    await s.goto("");
    // The hook total is a lower bound and says so.
    const hooks = page
      .locator(".masthead-figures > div")
      .filter({ has: page.getByText("Hooks", { exact: true }) });
    await expect(hooks.locator("dd").first()).toHaveText(
      `at least ${old.inventory.hookCount}`,
    );
    if (size === DESKTOP)
      await expect(page.getByTestId("masthead-census")).toHaveText(
        `Hooks, pools and networks: ${label}. ${HOOKS_SCOPE}`,
      );
    await s.goto("?view=chains");
    await expect(page.locator("#chains-networks")).toContainText(
      `Hook pool counts are from the ${label}.`,
    );
    await expect(
      page.locator("#chains-overview").getByTestId("census-note"),
    ).toHaveText(label.charAt(0).toUpperCase() + label.slice(1));
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      `horizontal overflow at ${size.width}px`,
    );
    s.verify();
  }
  // A census that is newer than its snapshot (a mix-up of files) gets no age.
  const future = structuredClone(served);
  future.inventory.generatedAt = new Date(
    Date.parse(future.generatedAt) + 2 * 86400000,
  ).toISOString();
  const s = await site(t, { data: future });
  await s.goto("");
  await expect(s.page.getByTestId("masthead-census")).toHaveText(
    `Hooks, pools and networks: ${censusLabel(future.inventory)}. ${HOOKS_SCOPE}`,
  );
  await expect(s.page.getByTestId("masthead-census")).not.toContainText(
    "days before",
  );
  s.verify();
});

test("Networks: the hook count is 'at least' and the blocks are those scanned at the census", async (t) => {
  for (const size of [DESKTOP, PHONE]) {
    const s = await site(t, { size });
    const { page } = s;
    await s.goto("?view=chains");
    const card = page.locator("#chains-overview");
    await expect(card).toContainText("Hook contracts found (at least)");
    await expect(card).not.toContainText("Indexed hook contracts");
    await expect(page.locator(".chains-market-scope")).toContainText(
      HOOKS_SCOPE,
    );
    const counted = served.inventory.networks.find((n) => !failed(n));
    await s.goto(`?view=chains&chain_network=${counted.chain}`);
    await page.locator(".chains-index-details summary").click();
    const body = page.locator(".chains-index-body");
    await expect(body).toContainText("Hook contracts found (at least)");
    await expect(body).toContainText("Blocks scanned at the census");
    await expect(body).not.toContainText("Hook contracts indexed");
    await expect(body).toContainText(String(counted.hookCount));
    // The evidence beside the composition chart names the same figure the same way.
    const evidence = page.locator(".chain-chart-evidence");
    await expect(evidence).toContainText("Hook contracts found (at least)");
    await expect(evidence).not.toContainText("Distinct pool hooks");
    s.verify();
  }
  // Analytics: the pill and the hook-contract column of the footprint table.
  const s = await site(t);
  await s.goto("?view=analytics&analytics_chain=base&window=h1");
  const footprint = s.page.locator(".analytics-footprint-panel");
  await expect(
    footprint.getByRole("columnheader", { name: "Hook contracts (at least)" }),
  ).toBeVisible();
  await expect(footprint).toContainText("Newer hooks are not included.");
  await expect(footprint.locator(".analytics-footprint-summary")).toContainText(
    /at least [\d,]+ hook contracts/,
  );
  s.verify();
});

// Every figure a census gives for hook contracts is a lower bound, so wherever
// the page prints one it must say "at least": the masthead tile, the Networks
// card and evidence, and the Analytics pill. The sweep reads the rendered text
// instead of a list of components, so a hook figure added later is held to it.
// Not census figures, and so not lower bounds: the hook contracts a reviewed
// project lists (registry rows) and the words of a sort menu.
const REGISTRY_OR_MENU =
  /^(?:listed hook contracts|known hooks|most hook contracts|fewest hook contracts)\b/i;
const HOOK_FIGURE =
  /\b(?:hook contracts?|hook addresses|distinct pool hooks)\b/i;

test("every hook-contract figure the census gives says 'at least', wherever it is printed", async (t) => {
  const counted = served.inventory.networks.find((n) => !failed(n));
  const pages = [
    "?view=chains",
    `?view=chains&chain_network=${counted.chain}`,
    "?view=analytics&analytics_chain=base&window=h1",
  ];
  for (const size of [DESKTOP, PHONE]) {
    const s = await site(t, { size });
    for (const query of pages) {
      await s.goto(query);
      const seen = await s.page.evaluate(
        ({ figure, exempt }) => {
          const figureRe = new RegExp(figure, "i");
          const exemptRe = new RegExp(exempt, "i");
          const rows = [];
          for (const el of document.querySelectorAll("body *")) {
            if (el.children.length > 3) continue;
            const words = (el.innerText || "").trim().replace(/\s+/g, " ");
            if (!words || words.length > 120) continue;
            if (!figureRe.test(words) || !/\d/.test(words)) continue;
            if (exemptRe.test(words)) continue;
            rows.push(words);
          }
          return [...new Set(rows)];
        },
        { figure: HOOK_FIGURE.source, exempt: REGISTRY_OR_MENU.source },
      );
      assert.ok(seen.length > 0, `${query}: the sweep found no hook figure`);
      assert.deepEqual(
        seen.filter((words) => !/at least/i.test(words)),
        [],
        `${query} at ${size.width}px: a hook figure without "at least"`,
      );
    }
    s.verify();
  }
});

test("an unknown network is not said to have been removed, and its heading is in order", async (t) => {
  for (const size of [DESKTOP, PHONE]) {
    const s = await site(t, { size });
    const { page } = s;
    await s.goto("?view=chains&chain_network=nonexistent");
    const empty = page.locator(".empty-state");
    await expect(
      empty.getByRole("heading", { name: "Network not found" }),
    ).toBeVisible();
    // Directly under the page title: level 2, not a skipped level 3.
    assert.equal(
      await empty
        .locator("h1, h2, h3")
        .first()
        .evaluate((node) => node.tagName),
      "H2",
    );
    await expect(empty).toContainText(
      `is not in the ${fullTimeLabel(served.generatedAt)} snapshot`,
    );
    await expect(page.locator(".chains-scope-caption")).toContainText(
      "Network not in this snapshot",
    );
    const { text } = await everything(page);
    assert.doesNotMatch(
      text,
      /current directory|pool index|Network not in directory/,
    );
    const result = await new AxeBuilder({ page })
      .withRules(["heading-order"])
      .analyze();
    assert.deepEqual(
      result.violations.map((violation) => violation.id),
      [],
      `heading order at ${size.width}px`,
    );
    s.verify();
  }
});
