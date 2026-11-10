import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  EDITION_RECHECK_MS,
  editionCatchUpDue,
  editionNavigation,
  editionViews,
  findIndexedHook,
} from "../src/edition.ts";
import { navigationSearch, parseNavigation } from "../src/navigation.ts";

const allViews = [
  "overview",
  "learn",
  "analytics",
  "chains",
  "map",
  "activity",
  "compare",
  "watchlist",
];

test("a link to Activity lands on Discover in the edition", () => {
  const state = parseNavigation(
    "?view=activity&activity=alpha&activity_chain=base&activity_window=h1",
  );
  assert.equal(state.view, "activity");
  const landed = editionNavigation(state, true);
  assert.equal(landed.view, "overview");
  assert.equal(landed.activityProject, null);
  // The address the page rewrites itself to no longer names Activity.
  const rewritten = new URLSearchParams(navigationSearch(landed));
  assert.equal(rewritten.get("view"), null);
  assert.equal(rewritten.get("activity"), null);
});

test("every other page and every filter survives untouched", () => {
  for (const view of allViews.filter((item) => item !== "activity")) {
    const state = parseNavigation(
      `?view=${view}&chain=base&category=Fees&window=h6&q=abc`,
    );
    assert.equal(editionNavigation(state, true), state);
  }
});

test("a Frontier extension selection in a link is dropped", () => {
  const state = parseNavigation(
    `?project=frontier&tab=deployments&extension_chain=robinhood&extension_hook=0x${"1".repeat(40)}`,
  );
  assert.ok(state.extensionSelection);
  const landed = editionNavigation(state, true);
  assert.equal(landed.extensionSelection, null);
  assert.equal(landed.project, "frontier");
});

test("without the edition navigation is returned exactly as parsed", () => {
  const state = parseNavigation("?view=activity&activity=alpha");
  assert.equal(editionNavigation(state, false), state);
  assert.equal(editionNavigation(state), state);
});

test("the edition's pages are the live pages minus Activity, with the guide last", () => {
  assert.deepEqual(editionViews(allViews, true), [
    "overview",
    "analytics",
    "chains",
    "map",
    "compare",
    "watchlist",
    "learn",
  ]);
  // The live order is untouched: the guide stays second and Activity stays.
  assert.deepEqual(editionViews(allViews, false), allViews);
  assert.deepEqual(allViews.slice(0, 2), ["overview", "learn"]);
});

test("the guide goes last whatever else a list holds, and a list without it is only filtered", () => {
  assert.deepEqual(
    editionViews(["learn", "overview", "activity", "compare"], true),
    ["overview", "compare", "learn"],
  );
  assert.deepEqual(editionViews(["overview", "map"], true), ["overview", "map"]);
  assert.deepEqual(editionViews([], true), []);
  // Called with no second argument it follows the build flag, which is unset
  // when the tests run in Node: the live order.
  assert.deepEqual(editionViews(allViews), allViews);
});

test("the Jump list and the header tabs read their order from the same function", () => {
  const palette = readFileSync(
    new URL("../src/components/CommandPalette.tsx", import.meta.url),
    "utf8",
  );
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(
    palette,
    /for \(const view of editionViews\(pages\.map\(\(page\) => page\.view\)\)\)/,
  );
  assert.match(app, /editionViews\(\s*\[\s*"overview",\s*"learn",/);
  // The phone's bottom tab bar is the same navigation element, styled by
  // width, so there is no second list of tabs that could disagree.
  assert.equal(app.match(/aria-label="Main navigation"/g)?.length, 1);
});

test("a long-open page asks again only after half an hour away", () => {
  const start = Date.parse("2026-10-28T14:10:00.000Z");
  assert.equal(editionCatchUpDue(null, start), false);
  assert.equal(editionCatchUpDue(start, start + EDITION_RECHECK_MS), false);
  assert.equal(editionCatchUpDue(start, start + EDITION_RECHECK_MS + 1), true);
});

test("a launchpad hook is found by exact chain and address only", () => {
  const projects = [
    {
      id: "alpha",
      name: "Alpha",
      category: "Launches",
      deployments: [
        { chain: "base", address: "0xABCDEF0000000000000000000000000000000001" },
      ],
    },
  ];
  const lower = "0xabcdef0000000000000000000000000000000001";
  assert.equal(findIndexedHook(projects, "base", lower)?.id, "alpha");
  assert.equal(findIndexedHook(projects, "ethereum", lower), null);
  assert.equal(findIndexedHook(projects, "base", lower.slice(0, 20)), null);
  assert.equal(findIndexedHook(projects, "base", "Alpha"), null);
  assert.equal(findIndexedHook([], "base", lower), null);
});
