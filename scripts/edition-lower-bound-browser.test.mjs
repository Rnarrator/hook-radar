// What the Launchpads list and the Frontier drawer of the Auto Snapshot edition
// say about the reach of their figures, in a real browser: a USD sum beside a
// lower-bound pool count carries the mark too, Frontier's figures say they leave
// bonding-curve trades out, and a platform with a hook on each of two
// networks counts two hooks (the per-network count of one contract published on
// two networks is pinned in tests/edition-lower-bounds.test.mjs, because no
// reviewed platform has that case). Like
// scripts/edition-platform-browser.test.mjs it
// builds nothing: point it at an edition build (VITE_STATIC_EDITION=1) with
// RADAR_TEST_DIST; it serves that build next to the TEST data in
// tests/fixtures/static-data/data (or RADAR_TEST_DATA) through
// scripts/static-edition-server.mjs, which answers every /api path with 404.
//
//   RADAR_TEST_DIST=<build> node --test scripts/edition-lower-bound-browser.test.mjs
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { startStaticEditionServer } from "./static-edition-server.mjs";
import { FRONTIER_SCOPE_NOTE } from "../src/edition-platform-copy.ts";

const DIST = resolve(process.env.RADAR_TEST_DIST || "dist");
const DATA = resolve(
  process.env.RADAR_TEST_DATA || "tests/fixtures/static-data/data",
);
const DESKTOP = { width: 1440, height: 1000 };
const PHONE = { width: 390, height: 844 };
const snapshotFile = JSON.parse(
  readFileSync(resolve(DATA, "snapshot.json"), "utf8"),
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

async function site(t, { size = DESKTOP } = {}) {
  const server = await startStaticEditionServer({
    distDir: DIST,
    dataDir: DATA,
  });
  const context = await browser.newContext({
    viewport: size,
    timezoneId: "Asia/Bangkok",
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
    goto: (query = "") => page.goto(`${server.url}${query}`),
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

/** Each row of the list as { name, cells: { label: { text, title } } }. */
const readRows = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("#chains-projects .chains-protocol")].map(
      (element) => ({
        name: element.getAttribute("aria-label"),
        notes: [
          ...element.querySelectorAll('[data-testid="row-scope-note"]'),
        ].map((note) => note.textContent.trim()),
        summary: element.textContent.replace(/\s+/g, " "),
        cells: Object.fromEntries(
          [...element.querySelectorAll("dl > div")].map((group) => {
            const dd = group.querySelector("dd");
            return [
              group.querySelector("dt")?.textContent.trim().toLowerCase(),
              {
                text: dd?.textContent.trim() ?? "",
                title: dd?.getAttribute("title") ?? null,
              },
            ];
          }),
        ),
      }),
    ),
  );

async function list(s, query) {
  await s.goto(query);
  await expect(
    s.page.locator("#chains-projects .chains-protocol").first(),
  ).toBeVisible({ timeout: 30000 });
  return readRows(s.page);
}
const launchpads = (s) => list(s, "?view=chains&chain_role=launchpads");

/** The list narrowed to one name by the page's own search. */
async function searched(s, name) {
  await list(s, "?view=chains&chain_role=launchpads");
  await s.page.fill('input[aria-label="Find a protocol"]', name);
  await expect(
    s.page.locator(
      '#chains-projects .chains-protocol[aria-label="' + name + '"]',
    ),
  ).toBeVisible({ timeout: 30000 });
  return readRows(s.page);
}

test("a USD sum beside a lower-bound pool count is a lower bound too, and a dash is not marked", async (t) => {
  for (const size of [DESKTOP, PHONE]) {
    const s = await site(t, { size });
    // Every project with a measured pool is in this list; Launchpads alone may
    // hold only rows whose figures are all unavailable.
    const rows = await list(s, "?view=chains");
    const bounded = rows.filter((row) =>
      row.cells["pools in snapshot"]?.text.startsWith("≥"),
    );
    assert.ok(bounded.length >= 1, "a row with a measured pool count");
    let marked = 0;
    for (const row of bounded)
      for (const label of ["tracked 24h volume", "reported reserves"]) {
        const cell = row.cells[label];
        assert.ok(cell, `${row.name} has ${label}`);
        if (cell.text === "—") {
          assert.ok(!cell.text.includes("≥"), `${row.name} ${label}: a dash`);
          continue;
        }
        marked++;
        assert.match(cell.text, /^≥\$/, `${row.name} ${label}: ${cell.text}`);
        // The title stays the exact amount, as everywhere else on the page.
        assert.match(
          cell.title ?? "",
          /^\$[\d,]+\.\d{2}$/,
          `${row.name} ${label}`,
        );
      }
    assert.ok(marked >= 1, "at least one marked sum");
    // A row with no measured pool has no mark anywhere.
    for (const row of rows.filter(
      (candidate) =>
        !candidate.cells["pools in snapshot"]?.text.startsWith("≥"),
    ))
      for (const label of ["tracked 24h volume", "reported reserves"])
        assert.ok(
          !row.cells[label]?.text.includes("≥"),
          `${row.name} ${label} has no measured pool`,
        );
    s.verify();
  }
});

test("Frontier's row says its figures are Uniswap v4 pool trades only, and no other row does", async (t) => {
  const hasFrontier = snapshotFile.projects.some(
    (project) => project.id === "frontier",
  );
  if (!hasFrontier) return t.skip("the data has no Frontier project");
  for (const size of [DESKTOP, PHONE]) {
    const s = await site(t, { size });
    const rows = await launchpads(s);
    const frontier = rows.find((row) => row.name === "Frontier");
    assert.ok(frontier, "Frontier is in the Launchpads list");
    assert.deepEqual(frontier.notes, [FRONTIER_SCOPE_NOTE]);
    for (const row of rows.filter((candidate) => candidate.name !== "Frontier"))
      assert.ok(
        !row.notes.some((note) => /bonding curve/.test(note)),
        `${row.name} has no curve note`,
      );
    s.verify();
  }
});

test("Frontier's drawer carries the same scope in its market coverage", async (t) => {
  const hasFrontier = snapshotFile.projects.some(
    (project) => project.id === "frontier",
  );
  if (!hasFrontier) return t.skip("the data has no Frontier project");
  const s = await site(t);
  await s.goto("?project=frontier");
  await expect(s.page.locator(".project-detail")).toBeVisible({
    timeout: 30000,
  });
  await s.page
    .getByRole("button", { name: /About this data/ })
    .first()
    .click();
  const text = await s.page
    .locator(".project-detail")
    .evaluate((element) => element.textContent.replace(/\s+/g, " "));
  assert.ok(text.includes(FRONTIER_SCOPE_NOTE), "the drawer says it");
  s.verify();
});

test("a platform with a hook on each of two networks says two exact hooks, as its Known hooks does", async (t) => {
  const s = await site(t);
  const rows = await searched(s, "Umia");
  const umia = rows.find((row) => row.name === "Umia");
  assert.ok(umia, "Umia is in the Launchpads list");
  assert.match(umia.summary, /2 exact hooks published/);
  assert.equal(umia.cells["known hooks"].text, "2");
  s.verify();
});

test("Umia's Robinhood Chain sources show the pool id and transaction in full and fit a phone", async (t) => {
  const s = await site(t, { size: PHONE });
  await s.goto("?project=umia");
  const sources = s.page.locator('ul.lp-evidence[aria-label*="Robinhood"]');
  await expect(sources.first()).toBeVisible({ timeout: 30000 });
  const note = sources.first().locator("li").first().locator("> span").first();
  await note.scrollIntoViewIfNeeded();
  const text = (await note.textContent())
    .replace(/\s+/g, " ")
    .trim();
  assert.match(text, /Checked on-chain separately on 2026-11-12/);
  // Both long strings are there whole, so a reader can paste them into an
  // explorer, and they wrap inside the drawer instead of widening it.
  assert.ok(
    text.includes(
      "0x18f3778f93a34c08d41a03e6b3a466a37ec0fd1b019e43f622927ba0c339838b",
    ),
  );
  assert.ok(
    text.includes(
      "0x25e64d72e0cb87bf260fc49fcf71e750ba6795b179e0cea605e3f7e6f36b0173",
    ),
  );
  const box = await note.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= PHONE.width, "inside the screen");
  const sideways = await s.page.evaluate(() => {
    const root = document.documentElement;
    const drawer = document.querySelector(".project-detail");
    return [
      root.scrollWidth - root.clientWidth,
      drawer ? drawer.scrollWidth - drawer.clientWidth : 0,
    ];
  });
  assert.deepEqual(sideways, [0, 0], "no sideways scroll");
  s.verify();
});
