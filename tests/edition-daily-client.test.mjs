import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildChains } from "../src/chains.ts";
import {
  createDailyLens,
  dailyButtonTitle,
  dailyCaption,
  dailyCardLabel,
  dailyColumnHelp,
  dailyChartCount,
  dailyChartNone,
  dailyColumnLabel,
  dailyCsvHeader,
  dailyDrawerNote,
  dailyExportNote,
  dailyLoadingText,
  dailyNetworksLabel,
  dailyPoolTitle,
  dailyReadyText,
  dailySumSpoken,
  dailySumText,
  dailySumTitle,
  dailyTileLabel,
  dailyTileNote,
  dailyView,
  DAILY_ERROR,
  DAILY_NOT_COVERED,
  DAILY_SCOPE_NOTE,
  DAILY_UNAVAILABLE,
  offersDaily,
  parseDaily,
  youngText,
  youngTitle,
} from "../src/daily.ts";
import { projectCsv } from "../src/export.ts";
import { projectComparator } from "../src/model.ts";
import {
  editionNavigation,
  STATIC_EDITION,
} from "../src/edition.ts";
import { navigationSearch, parseNavigation } from "../src/navigation.ts";
import { orderedPools } from "../src/project-presentation.ts";
import {
  DAILY_FILE_MAX_POOLS,
  DAILY_SOURCE_ID,
  validateDailyShape,
} from "../shared/daily-volume.ts";
import { getLaunchpad } from "../shared/launchpad-registry.ts";
import { DAILY_KEEP_RANK } from "../collector/config.mjs";
import { makeSnapshot } from "./fixtures.mjs";
import { dailyVariant, FIXTURE_THROUGH } from "./fixtures/static-data/daily-variant.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// The page's side of 7D and 30D volume: reading the file, the lens every screen
// shows its figures through, the address, the sort, the model of the Networks
// pages, and the CSV. Pure functions; the screens themselves are in the
// browser test (scripts/edition-daily-browser.test.mjs).

const SHOWN = "2026-10-28T14:05:00.000Z";
const A = `ethereum:0x${"a".repeat(64)}`;
const B = `base:0x${"b".repeat(64)}`;
const C = `base:0x${"c".repeat(64)}`;
const D = `robinhood:0x${"d".repeat(64)}`;
const pool = (key) => {
  const [chain, address] = key.split(":");
  return { id: key, chain, address };
};
const file = (pools, over = {}) => ({
  schemaVersion: 1,
  snapshotGeneratedAt: SHOWN,
  through: FIXTURE_THROUGH,
  source: "geckoterminal",
  pools: pools.sort((x, y) => (x.id < y.id ? -1 : 1)),
  ...over,
});
const row = (id, over = {}) => ({
  id,
  v7: 100,
  v30: 400,
  at: "2026-10-28T00:30:00.000Z",
  ...over,
});

/* ── Reading the file ────────────────────────────────────────────────────── */

test("the page and the collector share one validator, and the file's bounds agree", () => {
  const client = read("src/daily.ts");
  assert.match(client, /from "\.\.\/shared\/daily-volume\.ts"/);
  assert.ok(DAILY_FILE_MAX_POOLS >= DAILY_KEEP_RANK, "the file can hold what the collector keeps");
  const collector = read("collector/daily.mjs");
  assert.match(collector, /validateDailyShape/);
  assert.match(collector, /dailyRunProblem/);
  const gate = read("scripts/check-edition-data.mjs");
  assert.match(gate, /validateDailyShape/);
  assert.match(gate, /dailyRunProblem/);
});

test("the page accepts a valid file, one of another run, and refuses what is old, too new, or not the file", () => {
  assert.equal(parseDaily(file([row(A)]), SHOWN).ok, true);
  // Another run's file: dates of its own, accepted (here the next day's).
  assert.equal(
    parseDaily(file([row(A)], { through: "2026-10-28", snapshotGeneratedAt: "2026-10-29T01:00:00.000Z" }), SHOWN).ok,
    true,
  );
  // One day behind the shown snapshot's newest complete day: still shown.
  assert.equal(parseDaily(file([row(A)], { through: "2026-10-26" }), SHOWN).ok, true);
  const old = parseDaily(file([row(A)], { through: "2026-10-25" }), SHOWN);
  assert.equal(old.ok, false);
  assert.match(old.reason, /too old/);
  const ahead = parseDaily(file([row(A)], { through: "2026-10-30" }), SHOWN);
  assert.equal(ahead.ok, false);
  assert.match(ahead.reason, /later than this snapshot/);
  for (const bad of [null, [], "x", { schemaVersion: 2 }, file([row(A, { v7: 9, v30: 1 })])])
    assert.equal(parseDaily(bad, SHOWN).ok, false);
  assert.equal(parseDaily(file([row(A)]), "not a time").ok, false);
  // A file with no pool has no figure to show: it is unavailable, not a page of dashes.
  const empty = parseDaily(file([]), SHOWN);
  assert.equal(empty.ok, false);
  assert.match(empty.reason, /no pools/);
});

test("the buttons exist only when the snapshot names the daily file as a live source", () => {
  const { snapshot } = dailyVariant();
  assert.equal(offersDaily(snapshot), true);
  assert.equal(offersDaily({ ...snapshot, sources: snapshot.sources.filter((s) => s.id !== DAILY_SOURCE_ID) }), false);
  assert.equal(
    offersDaily({ ...snapshot, sources: snapshot.sources.map((s) => (s.id === DAILY_SOURCE_ID ? { ...s, status: "unavailable" } : s)) }),
    false,
  );
  assert.equal(offersDaily(null), false);
  for (const view of ["overview", "watchlist", "chains"]) assert.equal(dailyView(view), true, view);
  for (const view of ["analytics", "map", "compare", "activity", "learn"]) assert.equal(dailyView(view), false, view);
});

/* ── The lens ────────────────────────────────────────────────────────────── */

test("a pool's figure, and the sum over a set: at least, covered of measured, never a zero for a missing figure", () => {
  const lens = createDailyLens(file([row(A, { v7: 10, v30: 50 }), row(B, { v7: 0, v30: 0 }), row(C, { v7: 5, v30: 9 })]), "d7");
  assert.equal(lens.span, "d7");
  assert.equal(lens.width, 7);
  assert.equal(lens.through, FIXTURE_THROUGH);
  assert.equal(lens.pool(pool(A)).usd, 10);
  assert.equal(lens.pool(pool(D)), null, "a pool with no figure is null");
  assert.equal(lens.pool(pool(B)).usd, 0, "a measured zero is a figure");
  const all = lens.sum([pool(A), pool(B), pool(C), pool(D)]);
  assert.equal(all.usd, 15);
  assert.equal(all.covered, 3);
  assert.equal(all.of, 4);
  assert.equal(all.youngDays, null);
  assert.equal(all.at, "2026-10-28T00:30:00.000Z");
  // A set with no covered pool has no figure: a dash, never $0.
  assert.deepEqual(lens.sum([pool(D)]), { usd: null, covered: 0, of: 1, youngDays: null, at: null });
  assert.deepEqual(lens.sum([]), { usd: null, covered: 0, of: 0, youngDays: null, at: null });
  // A set of covered pools that sum to nothing is a real $0.
  assert.equal(lens.sum([pool(B)]).usd, 0);
  // 30D reads the other column.
  const long = createDailyLens(file([row(A, { v7: 10, v30: 50 })]), "d30");
  assert.equal(long.width, 30);
  assert.equal(long.pool(pool(A)).usd, 50);
});

test("pools are found by network and address, and by the snapshot's own id when that is what it carries", () => {
  const lens = createDailyLens(file([row(A)]), "d7");
  assert.equal(lens.pool({ id: "whatever", chain: "ethereum", address: `0x${"A".repeat(64)}` }).usd, 100);
  assert.equal(lens.pool({ id: A, chain: "other", address: "0x1" }).usd, 100);
  assert.equal(lens.pool({ id: "x", chain: "base", address: `0x${"a".repeat(64)}` }), null, "another network is another pool");
});

test("a pool younger than the span says so, and a set says so only when every covered pool is young", () => {
  const lens = createDailyLens(
    file([row(A, { v7: 6, v30: 6, n7: 2, n30: 2 }), row(B, { v7: 9, v30: 9, n7: 4, n30: 4 }), row(C, { v7: 70, v30: 300, n30: 20 })]),
    "d7",
  );
  assert.equal(lens.pool(pool(A)).days, 2);
  assert.equal(lens.pool(pool(C)).days, null, "20 days old is not young for 7D");
  assert.equal(lens.sum([pool(A), pool(B)]).youngDays, 4, "the longest of them");
  assert.equal(lens.sum([pool(A), pool(B), pool(C)]).youngDays, null, "one older pool: no tag on the total");
  assert.equal(lens.sum([pool(A), pool(D)]).youngDays, 2, "an uncovered pool does not count");
  const long = createDailyLens(file([row(C, { v7: 70, v30: 300, n30: 20 })]), "d30");
  assert.equal(long.pool(pool(C)).days, 20);
  assert.equal(long.sum([pool(C)]).youngDays, 20);
});

test("the words: pinned, plain, short, and none of the engineering terms", () => {
  const lens = createDailyLens(file([row(A, { v7: 1_234_000, v30: 5_000_000 })]), "d7");
  const sum = lens.sum([pool(A), pool(D)]);
  assert.equal(dailyButtonTitle("d7"), "Last 7 full days (UTC), largest pools only");
  assert.equal(dailyButtonTitle("d30"), "Last 30 full days (UTC), largest pools only");
  assert.equal(dailyColumnLabel("d7"), "7D VOLUME");
  assert.equal(dailyColumnLabel("d30"), "30D VOLUME");
  assert.equal(dailyCardLabel("d7"), "7D tracked volume");
  assert.equal(dailyTileLabel("d30"), "Tracked hook volume · 30D");
  assert.equal(dailyNetworksLabel("d7"), "Tracked 7D volume");
  assert.equal(dailyColumnHelp("d7"), "Volume over the last 7 full days (UTC), counted for the largest pools only. A dash means this pool is not covered.");
  assert.equal(dailyCaption(lens), "Full UTC days through 27 Oct. Largest pools only.");
  assert.equal(dailySumText(sum), "≥$1.23M");
  assert.equal(dailySumText(lens.sum([pool(D)])), "—");
  assert.equal(dailySumSpoken(sum), "at least $1.23M");
  assert.equal(dailyTileNote(lens, { ...sum, covered: 40, of: 1426 }), "40 of 1,426 pools covered, through 27 Oct");
  assert.equal(dailyDrawerNote("d7", { ...sum, covered: 3, of: 12 }), "7D covers the largest pools only: 3 of 12 measured pools here.");
  assert.equal(youngText(5), "since launch · 5 days");
  assert.equal(youngText(1), "since launch · 1 day");
  assert.equal(youngTitle(7), "Pools younger than 7 days count from their launch day.");
  assert.equal(DAILY_NOT_COVERED, "Not covered: only the largest pools have 7D and 30D volume.");
  assert.equal(DAILY_ERROR, "Could not load 7D and 30D volume.");
  assert.equal(DAILY_UNAVAILABLE, "No 7D or 30D volume in this snapshot.");
  assert.equal(dailyLoadingText("d7"), "Loading 7D volume");
  assert.equal(dailyReadyText(lens), "Showing 7D volume through 27 Oct");
  assert.equal(DAILY_SCOPE_NOTE, "Daily volume: largest pools only");
  // The Networks chart under a span does not say "measured": the same pools are measured for 24H.
  assert.equal(dailyChartCount("d7", "5", "23"), "5 of 23 with 7D volume");
  assert.equal(dailyChartCount("d30", "1,426", "1,430"), "1,426 of 1,430 with 30D volume");
  assert.equal(dailyChartNone("d7"), "no 7D volume");
  assert.equal(dailyChartNone("d30"), "no 30D volume");
  assert.equal(dailyExportNote("d7"), "The 7D figures are in the CSV. The JSON does not include them.");
  assert.doesNotMatch(dailyChartCount("d7", "5", "23") + dailyChartNone("d30"), /measured/);
  const title = dailySumTitle({ ...sum, covered: 3, of: 12 }, lens);
  assert.match(title, /^At least \$1\.23M: the last 7 full days \(UTC\) through 27 Oct in the 3 of 12 measured pools that have daily data\./);
  assert.match(title, /Pools outside the largest are not included\./);
  assert.match(title, /Read from GeckoTerminal on 28 Oct 2026, 00:30 UTC\./);
  assert.match(title, /can come from another provider/);
  assert.equal(dailySumTitle(lens.sum([pool(D)]), lens), DAILY_NOT_COVERED);
  assert.match(dailyPoolTitle(lens.pool(pool(A)), lens), /^Full UTC days through 27 Oct 2026\. Read from GeckoTerminal on 28 Oct 2026, 00:30 UTC\./);
  assert.match(dailyCsvHeader(lens), /^Observed 7D volume USD \(at least; full UTC days through 2026-10-27; largest pools only\)$/);
  const words = [
    dailyButtonTitle("d7"), dailyColumnHelp("d30"), dailyCaption(lens), title, DAILY_NOT_COVERED, DAILY_ERROR, DAILY_UNAVAILABLE, youngTitle(7),
  ].join(" ");
  for (const jargon of [/candle/i, /ohlcv/i, /checkpoint/i, /\blane\b/i, /backfill/i])
    assert.doesNotMatch(words, jargon);
});

/* ── The address ─────────────────────────────────────────────────────────── */

const base = {
  view: "overview",
  filters: { search: "", chain: "all", category: "all", property: "all", market: "projects" },
  window: "h24",
  project: null,
  detailTab: "pools",
  sort: { key: "volume", direction: "desc" },
};

test("window=d7 and window=d30 are read as a span in the edition only; the window beneath stays 24H", () => {
  for (const [value, span] of [["d7", "d7"], ["d30", "d30"]]) {
    const state = parseNavigation(`?window=${value}`, true);
    assert.equal(state.span, span);
    assert.equal(state.window, "h24");
    // The live build reads the same address as it always did.
    const live = parseNavigation(`?window=${value}`, false);
    assert.equal("span" in live, false);
    assert.equal(live.window, "h24");
  }
  assert.equal(parseNavigation("?window=h6", true).span, null);
  assert.equal(parseNavigation("?window=h6", true).window, "h6");
  assert.equal(parseNavigation("?window=d365", true).span, null);
  assert.equal(parseNavigation("", true).span, null);
  // Nothing is read in this test build (not the edition): the default follows.
  assert.equal(STATIC_EDITION, false);
  assert.equal("span" in parseNavigation("?window=d7"), false);
});

test("the span is written to the address on the views that show one, and only in the edition", () => {
  for (const view of ["overview", "watchlist", "chains"])
    assert.match(navigationSearch({ ...base, view, span: "d7" }, true), /window=d7/, view);
  for (const view of ["analytics", "map", "compare", "activity", "learn"])
    assert.doesNotMatch(navigationSearch({ ...base, view, span: "d30" }, true), /window=/, view);
  assert.equal(navigationSearch({ ...base, span: "d30" }, true), "?window=d30");
  // Never written by the live build, whatever the state holds.
  assert.equal(navigationSearch({ ...base, span: "d7" }, false), "");
  assert.equal(navigationSearch({ ...base, span: "d7" }), "", "the test build is not the edition");
  // A plain window is written as before, and a span wins over the window beneath.
  assert.equal(navigationSearch({ ...base, window: "h6" }, true), "?window=h6");
  assert.equal(navigationSearch({ ...base, window: "h6", span: "d7" }, true), "?window=d7");
  // An address that cannot be a span is not written.
  assert.equal(navigationSearch({ ...base, span: "d99" }, true), "");
  // Reload: what is written is what is read.
  for (const span of ["d7", "d30"]) {
    const written = navigationSearch({ ...base, span }, true);
    assert.equal(parseNavigation(written, true).span, span);
  }
});

test("window=d7 (the volume span) and analytics_range=d7 (the history range) are two different parameters in one address", () => {
  const analytics = { ...base, view: "analytics", analyticsRange: "d30", analyticsChain: "all", span: "d7" };
  const written = navigationSearch(analytics, true);
  assert.match(written, /analytics_range=d30/);
  assert.doesNotMatch(written, /window=d7/, "Analytics shows no spans");
  const both = parseNavigation("?view=chains&window=d7&analytics_range=d30", true);
  assert.equal(both.span, "d7");
  assert.equal(both.analyticsRange, "d30");
  const other = parseNavigation("?window=d30&analytics_range=d1", true);
  assert.equal(other.span, "d30");
  assert.equal(other.analyticsRange, "d1");
});

test("a link to a page that shows no spans drops the span; the pages that do keep it", () => {
  const link = (search) => editionNavigation(parseNavigation(search, true), true);
  for (const view of ["analytics", "map", "compare", "learn"])
    assert.equal(link(`?view=${view}&window=d7`).span, null, view);
  assert.equal(link("?view=activity&window=d7").view, "overview", "Activity lands on Discover");
  assert.equal(link("?view=activity&window=d7").span, null);
  for (const view of ["overview", "watchlist", "chains"])
    assert.equal(link(`?view=${view}&window=d30`).span, "d30", view);
  assert.equal(link("?window=d7").span, "d7");
  // Off in the live build: nothing changes.
  const state = { view: "analytics", span: "d7" };
  assert.equal(editionNavigation(state, false), state);
});

/* ── Sorting ─────────────────────────────────────────────────────────────── */

const projects = [
  { id: "p1", name: "One", deployments: [], metrics: { poolCount: 1, liquidityUsd: null, volumeUsd: { h1: 1, h6: 1, h24: 100 } } },
  { id: "p2", name: "Two", deployments: [], metrics: { poolCount: 1, liquidityUsd: null, volumeUsd: { h1: 1, h6: 1, h24: 500 } } },
  { id: "p3", name: "Three", deployments: [], metrics: { poolCount: 1, liquidityUsd: null, volumeUsd: { h1: 1, h6: 1, h24: null } } },
  { id: "p4", name: "Four", deployments: [], metrics: { poolCount: 1, liquidityUsd: null, volumeUsd: { h1: 1, h6: 1, h24: 50 } } },
];

test("the project sort ranks by the window as it always did, and by a figure the list shows when given one", () => {
  const ids = (list) => list.map((p) => p.id);
  assert.deepEqual(ids([...projects].sort(projectComparator("volume", "desc", "h24"))), ["p2", "p1", "p4", "p3"]);
  // The fifth parameter absent: exactly the same.
  assert.deepEqual(
    ids([...projects].sort(projectComparator("volume", "desc", "h24", undefined, undefined))),
    ["p2", "p1", "p4", "p3"],
  );
  const figure = { p1: 5, p2: null, p3: 0, p4: 9 };
  const byFigure = (direction) =>
    ids([...projects].sort(projectComparator("volume", direction, "h24", undefined, (p) => figure[p.id])));
  assert.deepEqual(byFigure("desc"), ["p4", "p1", "p3", "p2"], "a measured zero ranks; none is last");
  assert.deepEqual(byFigure("asc"), ["p3", "p1", "p4", "p2"], "none is last in both directions");
  // The other sorts do not read the figure.
  assert.deepEqual(
    ids([...projects].sort(projectComparator("name", "asc", "h24", undefined, (p) => figure[p.id]))),
    ["p4", "p1", "p3", "p2"],
  );
});

test("a drawer lists its pools by the span's figure first, the pools without one after, in the window's order", () => {
  const pools = [
    { id: "w", address: "w", chain: "base", volumeUsd: { h24: 9 }, metricUpdatedAt: SHOWN, metricStatus: "live" },
    { id: "x", address: "x", chain: "base", volumeUsd: { h24: 100 }, metricUpdatedAt: SHOWN, metricStatus: "live" },
    { id: "y", address: "y", chain: "base", volumeUsd: { h24: 5 }, metricUpdatedAt: SHOWN, metricStatus: "live" },
    { id: "z", address: "z", chain: "base", volumeUsd: { h24: 50 }, metricUpdatedAt: SHOWN, metricStatus: "live" },
  ];
  const now = Date.parse(SHOWN);
  const names = (list) => list.map((p) => p.id).join("");
  assert.equal(names(orderedPools(pools, "h24", now, true)), "xzwy");
  const daily = { w: 700, y: 3000 };
  assert.equal(
    names(orderedPools(pools, "h24", now, true, (p) => daily[p.id] ?? null)),
    "ywxz",
    "y and w have figures, then x and z in 24H order",
  );
  // The live list keeps the order it is given.
  assert.equal(names(orderedPools(pools, "h24", now, false, (p) => daily[p.id] ?? null)), "wxyz");
});

/* ── The CSV ─────────────────────────────────────────────────────────────── */

function csvWorld() {
  const { snapshot, daily } = dailyVariant();
  const now = Date.parse(snapshot.generatedAt);
  const lens = createDailyLens(daily, "d7");
  const context = { snapshotAt: snapshot.generatedAt, scope: "Partial coverage" };
  return { snapshot, daily, lens, context, now };
}

test("a CSV of a list showing 7D volume carries the span's figure under its own header; without a lens the file is byte for byte what it was", () => {
  const { snapshot, lens, context } = csvWorld();
  const plain = projectCsv(snapshot.projects, snapshot.pools, "h24", "all", context);
  assert.equal(projectCsv(snapshot.projects, snapshot.pools, "h24", "all", context, undefined), plain);
  assert.equal(projectCsv(snapshot.projects, snapshot.pools, "h24", "all", context, null), plain);
  assert.doesNotMatch(plain, /7D|at least|largest pools/);
  const csv = projectCsv(snapshot.projects, snapshot.pools, "h24", "all", context, lens);
  const rows = csv.split("\r\n").map((line) => line.slice(1, -1).split('","'));
  const header = rows[0];
  assert.equal(header[7], "Observed 7D volume USD (at least; full UTC days through 2026-10-27; largest pools only)");
  assert.equal(header.length, rows[1].length);
  const at = (id) => rows.find((r) => r[0] === id);
  assert.equal(at("alpha")[7], "25000", "20,000 + 5,000 + a measured zero");
  assert.equal(at("gamma")[7], "2300");
  assert.equal(at("frontier")[7], "450");
  assert.equal(at("beta")[7], "", "no pool with a figure: blank, never 0");
  assert.equal(at("delta")[7], "");
  // The columns about the 24H measurement's freshness describe another figure.
  for (const column of [10, 11, 14, 15]) assert.equal(at("alpha")[column], "", header[column]);
  // The reserves are the snapshot's, as before.
  assert.equal(at("alpha")[8], projectCsv(snapshot.projects, snapshot.pools, "h24", "all", context).split("\r\n").map((l) => l.slice(1, -1).split('","')).find((r) => r[0] === "alpha")[8]);
});

/* ── The Networks model ──────────────────────────────────────────────────── */

function networksWorld() {
  const snapshot = makeSnapshot({ generatedAt: SHOWN });
  snapshot.chains.push({ id: 5042, slug: "arc", name: "Arc", explorer: "https://explorer.arc.io" });
  const ubi = getLaunchpad("ubi-fun");
  const hook = ubi.paths.filter((path) => path.attribution === "platform-hook").flatMap((path) => path.hooks)[0].address;
  snapshot.projects.push({
    id: "flaunch",
    name: "Flaunch",
    description: "Token launches",
    category: "Launches",
    website: null,
    docs: null,
    sourceUrl: "https://github.com/Uniswap/hooklist",
    deployments: [
      {
        id: `arc:${hook}`,
        address: hook,
        chain: "arc",
        chainId: 5042,
        name: "Flaunch PositionManager",
        description: "A hook of the hooklist",
        verifiedSource: true,
        flags: { beforeSwap: true },
        properties: { dynamicFee: false, upgradeable: false, requiresCustomSwapData: false, vanillaSwap: false, swapAccess: "none" },
        auditUrl: null,
        sourceUrl: "https://github.com/Uniswap/hooklist",
        explorerUrl: `https://explorer.arc.io/address/${hook}`,
      },
    ],
    chains: ["arc"],
    metrics: { poolCount: null, liquidityUsd: null, volumeUsd: { h1: null, h6: null, h24: null }, coverage: "unavailable", note: "" },
    history: [],
  });
  const live = { metricUpdatedAt: SHOWN, metricStatus: "live", createdAt: "2026-10-01T00:00:00Z", tokens: ["A", "B"], source: "Test", url: "https://example.invalid" };
  const shared = `0x${"5".repeat(64)}`;
  snapshot.pools = [
    ...snapshot.pools.map((p) => ({ ...p, ...live, volumeUsd: { h1: 1, h6: 1, h24: 2400 } })),
    // A pool on the hook that two rows publish: the project's and the platform's.
    { ...live, id: `arc:${shared}`, chain: "arc", name: "X / Y", address: shared, hookAddress: hook, projectId: "flaunch", liquidityUsd: 10, volumeUsd: { h1: 1, h6: 1, h24: 800 } },
    // A pool of another network with no daily figure.
    { ...live, id: `base:${"9".repeat(64)}`, chain: "base", name: "M / N", address: `0x${"9".repeat(64)}`, hookAddress: snapshot.projects[0].deployments[0].address, projectId: "alpha", liquidityUsd: 10, volumeUsd: { h1: 1, h6: 1, h24: 100 } },
  ];
  const figures = [
    row(`base:0x${"a".repeat(64)}`, { v7: 3000, v30: 12000 }),
    row(`arc:${shared}`, { v7: 700, v30: 2800 }),
  ];
  const lens = createDailyLens(file(figures, { snapshotGeneratedAt: SHOWN }), "d7");
  return { snapshot, lens, shared, now: Date.parse(SHOWN) };
}

test("over a lens the rows, the networks and the totals are sums over covered pools; a pool two rows publish is in both rows and once in the network", () => {
  const { snapshot, lens, now } = networksWorld();
  const window = buildChains(snapshot, { now, role: "all", hookOverlap: true });
  const spanned = buildChains(snapshot, { now, role: "all", hookOverlap: true, daily: lens });
  const rowOf = (result, id) => result.protocols.find((r) => r.project.id === id);
  // Without a lens: the 24H figures, no daily field.
  assert.equal("daily" in rowOf(window, "alpha"), false);
  assert.equal(rowOf(window, "alpha").volumeUsd, 2400 + 100);
  assert.equal(window.dailyTotals, undefined);
  // With one: Alpha's covered pool, and a count of how many pools were covered.
  const alpha = rowOf(spanned, "alpha");
  assert.equal(alpha.volumeUsd, 3000);
  assert.deepEqual({ covered: alpha.daily.covered, of: alpha.daily.of }, { covered: 1, of: 2 });
  assert.equal(alpha.volumePools, 1);
  // The shared hook's pool is in the project row and in the platform row: each
  // row counts it; the network counts it once; no total adds rows together.
  const flaunch = rowOf(spanned, "flaunch");
  const ubi = rowOf(spanned, "ubi-fun");
  assert.equal(flaunch.volumeUsd, 700);
  assert.equal(ubi.volumeUsd, 700);
  assert.deepEqual(flaunch.sharedHookWith, [ubi.project.name]);
  const arc = spanned.networks.find((n) => n.slug === "arc");
  assert.equal(arc.volumeUsd, 700, "once, not twice");
  assert.equal(arc.daily.covered, 1);
  assert.equal(spanned.networks.find((n) => n.slug === "base").volumeUsd, 3000);
  assert.equal(spanned.networks.find((n) => n.slug === "ethereum").volumeUsd, null, "a network with no figure is a dash");
  assert.equal(spanned.dailyTotals.usd, 3700);
  assert.equal(spanned.dailyTotals.of, snapshot.pools.length);
  // A scoped network's total sums that network's pools only.
  const scoped = buildChains(snapshot, { now, chain: "arc", role: "all", daily: lens });
  assert.equal(scoped.dailyTotals.usd, 700);
  // A project with no covered pool has no figure, not zero.
  const beta = rowOf(spanned, "beta");
  assert.equal(beta.volumeUsd, null);
  assert.equal(beta.daily.covered, 0);
  // Reserves are untouched.
  assert.equal(rowOf(spanned, "alpha").liquidityUsd, rowOf(window, "alpha").liquidityUsd);
});

test("the rows are ordered by the figure they show, so sorting and display agree", () => {
  const { snapshot, lens, now } = networksWorld();
  const spanned = buildChains(snapshot, { now, role: "all", daily: lens });
  const shown = spanned.protocols.map((row) => row.volumeUsd);
  const figures = shown.filter((value) => value !== null);
  assert.deepEqual(figures, [...figures].sort((a, b) => b - a));
  assert.equal(shown.indexOf(null) === -1 || shown.slice(shown.indexOf(null)).every((value) => value === null), true, "rows with no figure come last");
  assert.equal(spanned.protocols[0].project.id, "alpha", "3,000 leads");
});

test("the model of one lens is never served for another or for none", () => {
  const { snapshot, lens, now } = networksWorld();
  const other = createDailyLens(file([row(`base:0x${"a".repeat(64)}`, { v7: 1, v30: 2 })], { snapshotGeneratedAt: SHOWN }), "d30");
  const volume = (result, id) => result.protocols.find((r) => r.project.id === id).volumeUsd;
  const first = buildChains(snapshot, { now, role: "all" });
  assert.equal(volume(first, "alpha"), 2500);
  const a = buildChains(snapshot, { now, role: "all", daily: lens });
  assert.equal(volume(a, "alpha"), 3000);
  const b = buildChains(snapshot, { now, role: "all", daily: other });
  assert.equal(volume(b, "alpha"), 2, "30D of the other file");
  // Back to the window, then to the first lens: each answer is its own.
  assert.equal(volume(buildChains(snapshot, { now, role: "all" }), "alpha"), 2500);
  assert.equal(volume(buildChains(snapshot, { now, role: "all", daily: lens }), "alpha"), 3000);
  assert.equal(buildChains(snapshot, { now, role: "all", daily: lens }).dailyTotals.usd, 3700);
  assert.notEqual(lens.id, other.id);
});
