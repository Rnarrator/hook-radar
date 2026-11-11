import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildChains, launchpadEntryFromRecord } from "../src/chains.ts";
import { getLaunchpad } from "../shared/launchpad-registry.ts";
import {
  networksFigureNote,
  parseHistory,
  parseHistoryPools,
  poolsFigureNote,
  poolsWithVolumeWords,
  recordedPools,
} from "../src/edition.ts";
import {
  FRONTIER_SCOPE_NOTE,
  lowerBoundMark,
  rowScopeNotes,
} from "../src/edition-platform-copy.ts";
import { projectCoverageNote } from "../src/project-presentation.ts";
import { historyCsv } from "../src/history-chart.ts";
import { makeSnapshot } from "./fixtures.mjs";

const source = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/* ── A hook on two networks is two hooks (Umia) ─────────────────────────── */

test("a platform that publishes one address on two networks has two exact hooks in the edition, one in the live build", () => {
  const umia = getLaunchpad("umia");
  const hooks = umia.paths
    .filter((path) => path.attribution === "platform-hook")
    .flatMap((path) =>
      path.hooks.map((hook) => `${path.chain}:${hook.address}`),
    );
  const addresses = new Set(
    umia.paths
      .filter((path) => path.attribution === "platform-hook")
      .flatMap((path) => path.hooks.map((hook) => hook.address)),
  );
  // The record this was found on: one contract address, two networks.
  assert.equal(new Set(hooks).size, 2);
  assert.equal(addresses.size, 1);
  assert.equal(
    launchpadEntryFromRecord(umia, { hooksByChain: true }).hookSummary,
    "2 exact hooks published",
  );
  // Off, it is the count the live page has always shown.
  assert.equal(
    launchpadEntryFromRecord(umia, { hooksByChain: false }).hookSummary,
    "1 exact hook published",
  );
  // Another platform is the same either way: its hooks are on one network each.
  const other = getLaunchpad("pons");
  assert.equal(
    launchpadEntryFromRecord(other, { hooksByChain: true }).hookSummary,
    launchpadEntryFromRecord(other, { hooksByChain: false }).hookSummary,
  );
  // The test build is not the edition: the default is the live count.
  assert.equal(
    launchpadEntryFromRecord(umia).hookSummary,
    "1 exact hook published",
  );
});

test("the edition count of a platform's hooks agrees with the Known hooks column beside it", () => {
  // Known hooks counts chain and address pairs (buildChains' own attribution);
  // the summary under the name must say the same number.
  const umia = getLaunchpad("umia");
  const snapshot = makeSnapshot();
  snapshot.chains.push(
    { id: 8453, slug: "base", name: "Base", explorer: "https://basescan.org" },
    {
      id: 4663,
      slug: "robinhood",
      name: "Robinhood",
      explorer: "https://robinscan.io",
    },
  );
  const row = buildChains(snapshot, {
    role: "launchpads",
    now: Date.now(),
  }).protocols.find((candidate) => candidate.project.id === "umia");
  assert.equal(row.attribution.mappedHooks, 2);
  assert.match(
    launchpadEntryFromRecord(umia, { hooksByChain: true }).hookSummary,
    /^2 exact hooks/,
  );
});

/* ── A sum over measured pools beside a lower-bound count ───────────────── */

test("a USD sum is marked as a lower bound where the pool count beside it is one, in the edition only", () => {
  assert.equal(lowerBoundMark(1, false, 1286.14, true), "≥");
  assert.equal(
    lowerBoundMark(156, false, 0, true),
    "≥",
    "a measured zero is a sum",
  );
  // Nothing measured, nothing to bound: the figure is a dash.
  assert.equal(lowerBoundMark(1, false, null, true), "");
  assert.equal(lowerBoundMark(null, false, 5, true), "");
  // An exact count is not a lower bound.
  assert.equal(lowerBoundMark(12, true, 5, true), "");
  // The live build never marks.
  assert.equal(lowerBoundMark(1, false, 5, false), "");
  assert.equal(
    lowerBoundMark(1, false, 5),
    "",
    "the test build is not the edition",
  );
});

test("the Launchpads and Networks rows and the platform drawer put the mark before the sums", () => {
  const catalog = source("src/components/ChainProtocolCatalog.tsx");
  assert.match(
    catalog,
    /lowerBoundMark\(\s*row\.poolCount,\s*row\.poolCountExact,\s*row\.volumeUsd,?\s*\)/,
  );
  assert.match(
    catalog,
    /lowerBoundMark\(\s*row\.poolCount,\s*row\.poolCountExact,\s*row\.liquidityUsd,?\s*\)/,
  );
  assert.match(catalog, /\{volumeMark\}\s*\{money\(row\.volumeUsd\)\}/);
  assert.match(catalog, /\{reservesMark\}\s*\{money\(row\.liquidityUsd\)\}/);
  assert.match(
    source("src/components/PlatformDetail.tsx"),
    /lowerBoundMark\(market\.pools > 0/,
  );
});

/* ── What Frontier's figures leave out ──────────────────────────────────── */

test("Frontier's row and drawer say its figures are Uniswap v4 pool trades only, and no other row says so", () => {
  assert.match(FRONTIER_SCOPE_NOTE, /Uniswap v4 pools only/);
  assert.match(FRONTIER_SCOPE_NOTE, /bonding curve/);
  assert.deepEqual(rowScopeNotes({ project: { id: "frontier" } }, true), [
    FRONTIER_SCOPE_NOTE,
  ]);
  assert.deepEqual(rowScopeNotes({ project: { id: "pons" } }, true), []);
  assert.deepEqual(rowScopeNotes({ project: { id: "frontier" } }, false), []);
  const options = {
    pools: [{ chain: "robinhood", source: "Frontier AMM index/configuration" }],
    snapshotPools: [{ chain: "robinhood" }],
    edition: true,
  };
  assert.ok(
    projectCoverageNote({ ...options, projectId: "frontier" }).endsWith(
      FRONTIER_SCOPE_NOTE,
    ),
  );
  assert.ok(
    projectCoverageNote({
      ...options,
      projectId: "frontier",
      pools: [],
    }).endsWith(FRONTIER_SCOPE_NOTE),
  );
  assert.doesNotMatch(
    projectCoverageNote({ ...options, projectId: "pons" }),
    /bonding curve/,
  );
  assert.doesNotMatch(projectCoverageNote(options), /bonding curve/);
  assert.equal(projectCoverageNote({ ...options, edition: false }), null);
});

/* ── Two rows that publish one hook ─────────────────────────────────────── */

function snapshotWithSharedHook() {
  const snapshot = makeSnapshot();
  snapshot.chains.push({
    id: 5042,
    slug: "arc",
    name: "Arc",
    explorer: "https://explorer.arc.io",
  });
  const ubi = getLaunchpad("ubi-fun");
  const hook = ubi.paths
    .filter((path) => path.attribution === "platform-hook")
    .flatMap((path) => path.hooks)[0].address;
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
        properties: {
          dynamicFee: false,
          upgradeable: false,
          requiresCustomSwapData: false,
          vanillaSwap: false,
          swapAccess: "none",
        },
        auditUrl: null,
        sourceUrl: "https://github.com/Uniswap/hooklist",
        explorerUrl: `https://explorer.arc.io/address/${hook}`,
      },
    ],
    chains: ["arc"],
    metrics: {
      poolCount: null,
      liquidityUsd: null,
      volumeUsd: { h1: null, h6: null, h24: null },
      coverage: "unavailable",
      note: "",
    },
    history: [],
  });
  return snapshot;
}

test("the one hook that the ubi.fun record and the hook list give to two rows is named on both, and the pools are not added together", () => {
  const snapshot = snapshotWithSharedHook();
  const rows = (options) =>
    buildChains(snapshot, { now: Date.now(), role: "all", ...options })
      .protocols;
  const find = (list, id) => list.find((row) => row.project.id === id);
  const on = rows({ hookOverlap: true });
  assert.deepEqual(find(on, "ubi-fun").sharedHookWith, ["Flaunch"]);
  assert.deepEqual(find(on, "flaunch").sharedHookWith, [
    find(on, "ubi-fun").project.name,
  ]);
  // A row that shares nothing carries nothing.
  assert.equal(find(on, "alpha").sharedHookWith, undefined);
  // Off, rows are exactly what they were.
  const off = rows({ hookOverlap: false });
  assert.equal("sharedHookWith" in find(off, "ubi-fun"), false);
  assert.equal("sharedHookWith" in find(off, "flaunch"), false);
  // The note is the same words on both rows.
  assert.deepEqual(
    rowScopeNotes(
      { project: { id: "ubi-fun" }, sharedHookWith: ["Flaunch"] },
      true,
    ),
    [
      "Shares a hook with Flaunch: that hook’s pools count in each listed project’s row and are not added together.",
    ],
  );
  assert.match(
    rowScopeNotes(
      { project: { id: "x" }, sharedHookWith: ["A", "B", "C"] },
      true,
    )[0],
    /^Shares a hook with A, B and C:/,
  );
});

/* ── The Discover strip and Analytics wording ───────────────────────────── */

test("the Discover strip says how many pools the whole snapshot measured when its scope is narrower", () => {
  assert.equal(
    poolsFigureNote(1017, 1392, true),
    "Pools measured in this view · 1,392 in the whole snapshot",
  );
  assert.equal(
    poolsFigureNote(1392, 1392, true),
    "Pools measured in this snapshot",
  );
  assert.equal(
    poolsFigureNote(null, 1392, true),
    "Pools measured in this snapshot",
  );
  assert.equal(
    poolsFigureNote(1017, 1392, false),
    "Pools measured in this snapshot",
  );
  assert.equal(
    networksFigureNote({ measuredScope: true, measuredNetworks: 7 }, true),
    "Networks with measured pools in this view",
  );
  assert.equal(
    networksFigureNote({ measuredScope: false, measuredNetworks: 7 }, true),
    "Networks in this view · pools measured on 7",
  );
  assert.equal(
    networksFigureNote({ measuredScope: false, measuredNetworks: 7 }, false),
    "Networks in this view",
  );
  assert.match(
    source("src/App.tsx"),
    /poolsFigureNote\(\s*scopedPoolCount,\s*snapshot\.pools\.length/,
  );
  assert.match(source("src/App.tsx"), /networksFigureNote\(\{/);
});

test("a pool with a measured volume is a measured pool, not a pool 'with volume', in the edition's Analytics", () => {
  assert.equal(poolsWithVolumeWords(true), "measured");
  assert.equal(poolsWithVolumeWords(false), "with volume");
  assert.match(
    source("src/components/AnalyticsWorkspace.tsx"),
    /\{poolsWithVolumeWords\(\)\}/,
  );
  assert.doesNotMatch(
    source("src/components/AnalyticsWorkspace.tsx"),
    /pools"}\s*with\s*volume/,
  );
});

/* ── The pools behind each recorded point ───────────────────────────────── */

test("the recorded history keeps how many pools stood behind each value, apart from the points, and drops a count that is not one", () => {
  const file = {
    schemaVersion: 1,
    points: [
      { timestamp: 1_000_000_000_000, value: 10, pools: 2209 },
      { timestamp: 1_000_000_100_000, value: 20, pools: 1392.5 },
      { timestamp: 1_000_000_200_000, value: 30, pools: -1 },
      { timestamp: 1_000_000_300_000, value: 40, pools: "1392" },
      { timestamp: 1_000_000_400_000, value: 50 },
      { timestamp: 1_000_000_500_000, value: 60, pools: 0 },
    ],
  };
  // The points are what they were: the overview envelope admits a timestamp
  // and a value only, so a count in a point would make it invalid.
  assert.deepEqual(
    parseHistory(file).map((point) => Object.keys(point)),
    file.points.map(() => ["timestamp", "value"]),
  );
  assert.deepEqual(
    [...parseHistoryPools(file)],
    [
      [1_000_000_000_000, 2209],
      [1_000_000_500_000, 0],
    ],
  );
  assert.equal(parseHistoryPools(null).size, 0);
  assert.equal(parseHistoryPools({ points: "x" }).size, 0);
  recordedPools.replace(parseHistoryPools(file));
  assert.equal(recordedPools.get(1_000_000_000_000), 2209);
  assert.equal(recordedPools.get(1_000_000_100_000), undefined);
  recordedPools.replace(new Map());
  assert.equal(recordedPools.get(1_000_000_000_000), undefined);
});

test("the history file's pool counts are read where the page loads it, and replaced with it", () => {
  assert.ok(
    source("src/edition-data.ts").includes(
      "recordedPools.replace(points ? parseHistoryPools(json) : new Map())",
    ),
  );
  assert.ok(
    source("src/components/AnalyticsHistory.tsx").includes(
      "recordedPools.get(point.timestamp)",
    ),
  );
});

test("the history CSV has a pools column only when the points carry one", () => {
  const options = { range: "all", exportedAt: "2026-11-11T12:00:00.000Z" };
  const points = [
    { timestamp: 1_794_000_000_000, value: 339226102.06 },
    { timestamp: 1_794_000_900_000, value: 250204997.97 },
  ];
  const pools = new Map([[1_794_000_000_000, 2209]]);
  const withPools = historyCsv(points, {
    ...options,
    poolsAt: (point) => pools.get(point.timestamp),
  }).split("\r\n");
  assert.match(
    withPools[0],
    /"recorded_volume_usd_h24_rolling","pools_measured","metric"/,
  );
  assert.match(
    withPools[1],
    /,"339226102.06","2209","tracked hook-pool volume/,
  );
  assert.match(withPools[2], /,"250204997.97","","tracked hook-pool volume/);
  // No count for any point, or no way to ask: the file is the one it was.
  assert.doesNotMatch(historyCsv(points, options), /pools_measured/);
  assert.doesNotMatch(
    historyCsv(points, { ...options, poolsAt: () => undefined }),
    /pools_measured/,
  );
  assert.match(source("src/components/AnalyticsHistory.tsx"), /Pools measured/);
});
