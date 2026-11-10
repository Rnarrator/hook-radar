import test from "node:test";
import assert from "node:assert/strict";
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

test("the edition's pages are the live pages minus Activity, in the same order", () => {
  assert.deepEqual(
    editionViews(allViews, true),
    allViews.filter((view) => view !== "activity"),
  );
  assert.deepEqual(editionViews(allViews, false), allViews);
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
