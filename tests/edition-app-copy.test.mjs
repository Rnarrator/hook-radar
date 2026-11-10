// The Auto Snapshot edition's Discover wording, the text for a project the
// snapshot does not carry, the Data & sources dialog and the project CSV, without
// a browser: what each says, and that the live page keeps its own words. The same
// screens in a real browser are in scripts/static-edition-copy-browser.test.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  EXPORT_FILES_NOTE,
  LIST_HOLDS,
  NO_MATCH_IN_SNAPSHOT,
  PROJECT_NOT_CARRIED,
  exportScope,
  filtersNote,
  listScopeLabel,
  openingDetailTab,
  projectsFigureNote,
  recentTradingCaption,
  watchlistScopeNote,
} from "../src/edition.ts";
import { projectCsv } from "../src/export.ts";
import { makeSnapshot } from "./fixtures.mjs";

// The checkout may have CRLF working files; sources are compared without them.
const source = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );
const app = source("src/App.tsx");

/* ── Discover: what the list holds ─────────────────────────────────────── */

test("the All hooks note says what the snapshot lists and never every hook", () => {
  assert.equal(
    LIST_HOLDS,
    "Registry-named projects and hooks with a measured pool in this snapshot",
  );
  assert.doesNotMatch(LIST_HOLDS, /every|discovered|unnamed contracts/i);
});

test("a search that finds nothing says the snapshot carries a sample and other hooks are not in it", () => {
  assert.equal(
    NO_MATCH_IN_SNAPSHOT,
    "Nothing in this snapshot matches. It carries registry-named projects and projects with a measured pool, so other hooks are not included.",
  );
  // Not the live page's "try another name": the hook may exist elsewhere.
  assert.doesNotMatch(NO_MATCH_IN_SNAPSHOT, /Try a different/);
});

test("Recent trading is read against the snapshot, not a clock", () => {
  assert.equal(
    recentTradingCaption("24H"),
    "Positive 24H trading volume · pools measured within 5 minutes of the snapshot",
  );
  assert.match(recentTradingCaption("1H"), /^Positive 1H trading volume/);
  for (const window of ["1H", "6H", "24H"]) {
    const caption = recentTradingCaption(window);
    assert.doesNotMatch(caption, /under 5m old|\bold\b|ago/);
    assert.match(caption, /of the snapshot$/);
  }
});

test("the Projects figure is named projects only where the scope is", () => {
  assert.equal(projectsFigureNote("projects"), "Named projects in this view");
  assert.equal(projectsFigureNote(undefined), "Named projects in this view");
  assert.equal(projectsFigureNote("all"), LIST_HOLDS);
  // Market data and recent trading include hooks no registry names.
  for (const market of ["observed", "active"]) {
    assert.equal(projectsFigureNote(market), "Hooks and projects in this view");
    assert.doesNotMatch(projectsFigureNote(market), /Named/);
  }
});

test("the scope chip and an export name the list the same way", () => {
  assert.equal(listScopeLabel("overview", "projects"), "Named projects");
  assert.equal(listScopeLabel("overview", undefined), "Named projects");
  assert.equal(listScopeLabel("overview", "all"), "All hooks in this snapshot");
  assert.equal(listScopeLabel("overview", "observed"), "With market data");
  assert.equal(listScopeLabel("overview", "active"), "Recent trading");
  assert.equal(listScopeLabel("map", "active"), "Recent trading");
  // A watchlist is its own scope whatever the market says.
  for (const market of ["projects", "all", "observed", "active", undefined])
    assert.equal(listScopeLabel("watchlist", market), "Your watchlist");
});

test("a project drawer opens on Hooks only for a hook project the snapshot carries without a measured pool", () => {
  assert.equal(openingDetailTab({}, false), "deployments");
  assert.equal(openingDetailTab({ entityType: "hook" }, false), "deployments");
  assert.equal(openingDetailTab({}, true), "pools");
  // A platform listing and a project the snapshot lacks keep the Pools tab.
  assert.equal(openingDetailTab({ entityType: "platform" }, false), "pools");
  assert.equal(openingDetailTab(undefined, false), "pools");
  assert.equal(openingDetailTab(null, false), "pools");
});

/* ── The project nobody carries ────────────────────────────────────────── */

test("a project the snapshot does not carry is not blamed on the registry", () => {
  assert.equal(
    PROJECT_NOT_CARRIED,
    "This snapshot does not carry this project. It holds registry-named projects and projects with at least one measured pool.",
  );
  assert.doesNotMatch(PROJECT_NOT_CARRIED, /removed|renamed/i);
  // The drawer's title is what a visitor finds it by; the text under it must
  // not repeat it.
  assert.doesNotMatch(PROJECT_NOT_CARRIED, /Project not in this snapshot/i);
});

/* ── Export scope ──────────────────────────────────────────────────────── */

test("an export's scope states partial coverage, the list and the network, in plain ASCII", () => {
  assert.equal(
    exportScope({ list: "Named projects", network: "All networks" }),
    "Partial coverage; Not total Uniswap volume; Named projects; All networks",
  );
  assert.equal(
    exportScope({
      list: "Your watchlist",
      network: "Base",
      notes: [
        "Filtered by search",
        null,
        undefined,
        false,
        "1 saved project is not in this snapshot, so it is not in these files.",
      ],
    }),
    "Partial coverage; Not total Uniswap volume; Your watchlist; Base; Filtered by search; 1 saved project is not in this snapshot, so it is not in these files.",
  );
  // A spreadsheet that opens the file without a byte-order mark must not garble it.
  assert.match(
    exportScope({
      list: listScopeLabel("overview", "all"),
      network: "All networks",
    }),
    /^[\x20-\x7e]+$/,
  );
});

test("only the filters that narrow the rows are named", () => {
  const none = { search: "", category: "all", property: "all" };
  assert.equal(filtersNote(none), null);
  assert.equal(filtersNote({ ...none, search: "   " }), null);
  assert.equal(filtersNote({ ...none, search: "alpha" }), "Filtered by search");
  assert.equal(
    filtersNote({ search: "a", category: "Fees", property: "dynamic" }),
    "Filtered by search, category, hook feature",
  );
});

test("a Watchlist cut by the scope says so in its export, and one that is not cut says nothing", () => {
  // The scope can leave out a saved project the snapshot carries, so the file
  // must not be read as the whole Watchlist.
  assert.equal(
    watchlistScopeNote("watchlist", "active"),
    "Narrowed by scope: Recent trading",
  );
  assert.equal(
    watchlistScopeNote("watchlist", "observed"),
    "Narrowed by scope: With market data",
  );
  assert.equal(
    watchlistScopeNote("watchlist", "projects"),
    "Narrowed by scope: Named projects",
  );
  // "All hooks" and a missing market select every project.
  assert.equal(watchlistScopeNote("watchlist", "all"), null);
  assert.equal(watchlistScopeNote("watchlist", undefined), null);
  // The note is the Watchlist's: another view states its own scope label.
  for (const view of ["overview", "map"])
    assert.equal(watchlistScopeNote(view, "active"), null);
  // It reads in the scope column, in plain ASCII, after the Watchlist's name.
  assert.equal(
    exportScope({
      list: listScopeLabel("watchlist", "active"),
      network: "All networks",
      notes: [
        watchlistScopeNote("watchlist", "active"),
        filtersNote({ search: "", category: "all", property: "all" }),
      ],
    }),
    "Partial coverage; Not total Uniswap volume; Your watchlist; All networks; Narrowed by scope: Recent trading",
  );
  assert.match(watchlistScopeNote("watchlist", "active"), /^[\x20-\x7e]+$/);
});

test("the dialog describes the JSON file in plain words, not by a property name", () => {
  assert.equal(
    EXPORT_FILES_NOTE,
    "Blank metrics mean unavailable data. JSON is the whole snapshot, with its source freshness and the measured pools; it also lists which projects this view shows.",
  );
  assert.doesNotMatch(EXPORT_FILES_NOTE, /exportedView|projectIds/);
  // The key still names the view inside the file; the sentence no longer does.
  assert(app.includes("exportedView: {"));
  assert.doesNotMatch(app, /listed in its exportedView/);
});

/* ── The project CSV ───────────────────────────────────────────────────── */

const LEGACY_HEADER = [
  "Directory ID",
  "Project",
  "Purpose",
  "Category",
  "Chains",
  "Indexed deployments",
  "Deployment addresses",
  "Current observed 24H volume USD",
  "Current reported reserve valuation USD",
  "Metric coverage",
  "Volume oldest measurement ISO",
  "Volume cached pools",
  "Reserves oldest measurement ISO",
  "Reserves cached pools",
  "Volume older pools excluded",
  "Volume latest recorded measurement ISO",
  "Reserves older pools excluded",
  "Reserves latest recorded measurement ISO",
  "Source",
]
  .map((name) => `"${name}"`)
  .join(",");
const AT = "2026-10-28T14:05:00.000Z";
const SCOPE =
  "Partial coverage; Not total Uniswap volume; Named projects; All networks";

const csvOf = (...rest) => {
  const snapshot = makeSnapshot();
  snapshot.pools[0].metricUpdatedAt = "2026-10-01T00:00:00.000Z";
  snapshot.pools[0].metricStatus = "cached";
  return projectCsv(snapshot.projects, snapshot.pools, "h24", ...rest).split(
    "\r\n",
  );
};

test("called as the live page calls it, the CSV keeps its exact header and rows", () => {
  const rows = csvOf();
  assert.equal(rows[0], LEGACY_HEADER);
  assert.equal(rows.length, makeSnapshot().projects.length + 1);
  // An argument that is not given and one that is undefined are the same file.
  assert.deepEqual(csvOf("all"), rows);
  assert.deepEqual(csvOf("all", undefined), rows);
});

test("with a snapshot time and scope the CSV adds two columns after the live ones and relabels the two 'Current' figures", () => {
  const live = csvOf();
  const dated = csvOf("all", { snapshotAt: AT, scope: SCOPE });
  assert.equal(dated.length, live.length);
  assert.equal(
    dated[0],
    LEGACY_HEADER.replace(
      '"Current observed 24H volume USD","Current reported reserve valuation USD"',
      '"Observed 24H volume USD at snapshot","Reported reserve valuation USD at snapshot"',
    ) + ',"Snapshot time (UTC)","Scope"',
  );
  assert.doesNotMatch(dated[0], /Current/);
  // Every live cell keeps its value and its place; the two new ones follow it.
  for (let row = 1; row < live.length; row += 1)
    assert.equal(dated[row], `${live[row]},"${AT}","${SCOPE}"`, `row ${row}`);
});

test("the dated CSV states the window of the figure and the chain it was cut to", () => {
  const snapshot = makeSnapshot();
  const header = (window) =>
    projectCsv(snapshot.projects, snapshot.pools, window, "all", {
      snapshotAt: AT,
      scope: SCOPE,
    }).split("\r\n")[0];
  assert.match(header("h1"), /"Observed 1H volume USD at snapshot"/);
  assert.match(header("h6"), /"Observed 6H volume USD at snapshot"/);
  // A chain's cut changes the rows and not the columns.
  const base = projectCsv(snapshot.projects, snapshot.pools, "h24", "base", {
    snapshotAt: AT,
    scope: SCOPE,
  }).split("\r\n");
  assert.equal(base[0], header("h24"));
  assert.equal(base.length, snapshot.projects.length + 1);
});

test("an unavailable figure is still blank, never zero, in the dated CSV", () => {
  const dated = csvOf("all", { snapshotAt: AT, scope: SCOPE });
  // The same unavailable tail the live file shows for the project with no figures.
  assert.match(dated.join("\n"), /"unavailable","","0","","0","0","","0",""/);
});

test("a time or scope that needs quoting survives the CSV", () => {
  const dated = csvOf("all", {
    snapshotAt: AT,
    scope: 'A "quoted", scope; and a comma',
  });
  assert(dated[1].endsWith(',"A ""quoted"", scope; and a comma"'));
});

/* ── The page's own use of all this ────────────────────────────────────── */

const gated = (name) =>
  new RegExp(`STATIC_EDITION\\s*\\?\\s*(?:\\{?\\s*)?${name}\\b`).test(app);

test("the page uses the edition's words only in the edition", () => {
  for (const name of [
    "recentTradingCaption\\(",
    "LIST_HOLDS",
    "projectsFigureNote\\(",
    "listScopeLabel\\(",
    "PROJECT_NOT_CARRIED",
    "EXPORT_FILES_NOTE",
  ])
    assert(gated(name), `${name} is chosen by STATIC_EDITION`);
  // A watchlist narrowed to nothing is not a search of the snapshot: it keeps
  // the live page's words.
  assert.match(
    app,
    /STATIC_EDITION && view !== "watchlist"\s*\?\s*NO_MATCH_IN_SNAPSHOT/,
  );
  // The live page keeps each of its own sentences, word for word.
  for (const live of [
    "Positive ${windows[windowKey]} volume · measurements under 5m old",
    "Every discovered hook, including unnamed contracts",
    "Named projects and unnamed hooks",
    "Named projects in this view",
    "Try a different name, address, chain or category.",
    "This shared link may refer to a project that has been removed or renamed in the registry.",
    "Source status becomes available when the first snapshot loads.",
    "New projects, deployments and metadata changes are",
    '"Download JSON"',
    '"Retry details"',
    "JSON includes source freshness and the observed pool sample.",
  ])
    assert(app.includes(live), live);
});

test("a drawer that cannot load its snapshot offers 'Try again' in the edition and keeps 'Retry details' on the live page", () => {
  assert.match(app, /STATIC_EDITION \? "Try again" : "Retry details"/);
});

test("Data & sources no longer claims a refresh rhythm or registry change detection in the edition", () => {
  assert.doesNotMatch(app, /REFRESH_NOTE/);
  assert.doesNotMatch(app, /refreshed every few hours/);
  assert.match(app, /"This edition does not track registry changes\."/);
});

test("the sources dialog gives the run times of its own snapshot only", () => {
  assert.match(app, /<EditionRun\s+snapshotAt=\{snapshot\.generatedAt\}\s*\/>/);
  assert.doesNotMatch(app, /<EditionRun\s*\/>/);
});

test("Data & sources opened where no snapshot is loaded starts the snapshot, in the edition only", () => {
  const effect = app.match(
    /const sourcesNeedSnapshot =([\s\S]*?)useEffect\(\(\) => \{([\s\S]*?)\}, \[sourcesNeedSnapshot\]\);/,
  );
  assert(effect, "the effect is there");
  assert.match(
    effect[1],
    /STATIC_EDITION\s*&&\s*modal === "sources"\s*&&\s*!sourceSnapshot/,
  );
  // The lightweight Analytics page has its sources in its own file.
  assert.match(
    effect[1],
    /analyticsLite && \(overview\.data \|\| overview\.loading\)/,
  );
  assert.match(effect[2], /void fetchSnapshot\(\)/);
});

test("the project CSV is dated in the edition and written as before on the live page", () => {
  // The file name carries the snapshot's date in the edition (snapshotFileName
  // returns the live name unchanged): the call's name argument is that helper.
  const call = app.match(
    /projectCsv\(([\s\S]*?)\),\s*snapshotFileName\(\s*"hook-radar-projects\.csv",\s*snapshot\.generatedAt,?\s*\)/,
  );
  assert(call, "the call is there");
  assert.match(
    call[1],
    /STATIC_EDITION\s*\?\s*\{\s*snapshotAt: snapshot\.generatedAt/,
  );
  assert.match(call[1], /:\s*undefined/);
  // A Watchlist cut by the scope names the cut, before the other filters.
  assert.match(
    call[1],
    /notes: \[\s*watchlistScopeNote\(view, filters\.market\),\s*filtersNote\(filters\)/,
  );
  // The live names are unchanged, including the server downloads, which are
  // never dated: the literals stay, and only the page's own files go through
  // the dating helper.
  assert(app.includes('"hook-radar-projects.csv"'));
  assert(app.includes('"hook-radar-snapshot.json"'));
  assert.match(
    app,
    /serverDownload\(\s*"\/api\/snapshot\/export\.json",\s*"hook-radar-snapshot\.json",\s*\)/,
  );
  assert.match(
    app,
    /serverDownload\(\s*`\/api\/directory\/export\.csv\?\$\{params\}`,\s*"hook-radar-projects\.csv",\s*\)/,
  );
  assert.match(
    app,
    /snapshotFileName\(\s*"hook-radar-snapshot\.json",\s*snapshot\.generatedAt,?\s*\)/,
  );
  assert.match(app, /"Download JSON \(full snapshot\)"/);
});

test("a drawer opened by the page chooses its tab only in the edition", () => {
  assert.match(
    app,
    /const nextTab: DetailTab =\s*requestedTab \?\? \(next \? openingTab\(next\) : "pools"\);/,
  );
  assert.match(app, /if \(!STATIC_EDITION \|\| !snapshot\) return "pools";/);
});
