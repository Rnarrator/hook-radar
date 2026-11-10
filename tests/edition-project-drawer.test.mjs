import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ENVIO_MARKET_SOURCE } from "../server/market-envio.mjs";
import {
  COMMUNITY_INDEXER_SOURCE,
  discoverySummary,
  emptyPoolsCopy,
  measuredNetworks,
  orderedPools,
  poolWording,
  projectIdentity,
  reportedByIndexer,
} from "../src/project-presentation.ts";

const NOW = Date.parse("2026-10-28T14:05:00.000Z");
const names = {
  arbitrum: "Arbitrum",
  base: "Base",
  ethereum: "Ethereum",
  robinhood: "Robinhood Chain",
  unichain: "Unichain",
};
const chainName = (slug) => names[slug] ?? slug;

/* ── Which networks the snapshot measured ──────────────────────────────── */

test("the measured networks are those the market coverage table counts a pool on", () => {
  assert.deepEqual(
    measuredNetworks({
      marketCoverage: {
        networks: [
          { chain: "base", measuredPools: 504 },
          { chain: "arbitrum", measuredPools: 0 },
          { chain: "ethereum", measuredPools: 370 },
        ],
      },
      coverage: { measuredChains: ["something-else"] },
    }),
    ["base", "ethereum"],
  );
});

test("without a coverage table the coverage summary names them, and without either they are unknown", () => {
  assert.deepEqual(
    measuredNetworks({
      coverage: { measuredChains: ["base", "ethereum", "base"] },
    }),
    ["base", "ethereum"],
  );
  assert.deepEqual(
    measuredNetworks({
      marketCoverage: { networks: [] },
      coverage: { measuredChains: ["base"] },
    }),
    ["base"],
  );
  assert.equal(measuredNetworks({}), null);
  assert.equal(
    measuredNetworks({ marketCoverage: null, coverage: null }),
    null,
  );
});

test("a table in which no network has a measured pool says so rather than falling back", () => {
  assert.deepEqual(
    measuredNetworks({
      marketCoverage: { networks: [{ chain: "bnb", measuredPools: 0 }] },
      coverage: { measuredChains: ["base"] },
    }),
    [],
  );
});

/* ── The empty Pools tab ───────────────────────────────────────────────── */

const LIVE_EMPTY = {
  title: "Pool data isn’t available yet",
  body: "Our market sources don’t have pools for this project yet. You can still explore its hooks.",
};

test("a snapshot says the pools were not measured, not that no source has them", () => {
  const copy = emptyPoolsCopy({
    edition: true,
    chain: "all",
    measured: ["unichain", "base", "ethereum", "robinhood"],
    chainName,
  });
  assert.equal(copy.title, "No pools measured in this snapshot");
  assert.equal(
    copy.body,
    "This snapshot measures a sample of hook pools on Base, Ethereum, Robinhood Chain and Unichain. None of this project’s pools are in that sample, so it may still have pools that were not measured.",
  );
  for (const text of [copy.title, copy.body]) {
    assert.doesNotMatch(text, /\byet\b/i);
    assert.doesNotMatch(text, /market sources/i);
    assert.doesNotMatch(text, /isn’t available/i);
  }
});

test("a network the snapshot does not measure is named as such", () => {
  const copy = emptyPoolsCopy({
    edition: true,
    chain: "arbitrum",
    measured: ["base", "ethereum"],
    chainName,
  });
  assert.equal(copy.title, "No pools measured in this snapshot");
  assert.equal(copy.body, "This snapshot does not measure pools on Arbitrum.");
});

test("a measured network where none of the project's pools fell in the sample says where", () => {
  const copy = emptyPoolsCopy({
    edition: true,
    chain: "base",
    measured: ["base", "ethereum"],
    chainName,
  });
  assert.equal(
    copy.body,
    "This snapshot measures a sample of hook pools on Base and Ethereum. None of this project’s pools on Base are in that sample, so it may still have pools there that were not measured.",
  );
});

test("when the snapshot does not list its networks the copy names none", () => {
  for (const measured of [null, []]) {
    const copy = emptyPoolsCopy({
      edition: true,
      chain: "all",
      measured,
      chainName,
    });
    assert.equal(
      copy.body,
      "This snapshot measures a sample of hook pools. None of this project’s pools are in that sample, so it may still have pools that were not measured.",
    );
  }
  // Unknown networks never turn a filtered network into "not measured".
  assert.match(
    emptyPoolsCopy({
      edition: true,
      chain: "arbitrum",
      measured: null,
      chainName,
    }).body,
    /None of this project’s pools on Arbitrum are in that sample/,
  );
});

test("one measured network is named alone", () => {
  assert.match(
    emptyPoolsCopy({
      edition: true,
      chain: "all",
      measured: ["base"],
      chainName,
    }).body,
    /sample of hook pools on Base\. None/,
  );
});

test("outside the edition the empty Pools tab keeps its words", () => {
  for (const options of [
    { edition: false, chain: "all", measured: ["base"], chainName },
    { edition: false, chain: "arbitrum", measured: ["base"], chainName },
    // The flag is unset in this process, so the default is the live wording.
    { chain: "all", measured: ["base"], chainName },
  ])
    assert.deepEqual(emptyPoolsCopy(options), LIVE_EMPTY);
});

/* ── The order of the pool list ────────────────────────────────────────── */

const pool = (id, volume, overrides = {}) => ({
  id,
  chain: "base",
  name: id,
  address: id,
  hookAddress: null,
  projectId: "p",
  url: "https://example.test",
  source: "DEX Screener",
  liquidityUsd: 10,
  volumeUsd: { h1: volume, h6: volume, h24: volume },
  createdAt: null,
  tokens: [],
  metricUpdatedAt: new Date(NOW - 30_000).toISOString(),
  metricStatus: "live",
  ...overrides,
});

test("the edition lists the largest current volume first, a measured zero before an unknown, ties by id", () => {
  // An unknown volume is stored before the measured zero, so a list that does
  // not tell them apart keeps the stored order and is caught.
  const pools = [
    pool("0xa", null),
    pool("0xd", 0),
    pool("0xc", 250),
    pool("0xb", 250),
    pool("0xe", 9_000_000),
    pool("0xf", 12.5),
  ];
  assert.deepEqual(
    orderedPools(pools, "h24", NOW, true).map((row) => row.id),
    ["0xe", "0xb", "0xc", "0xf", "0xd", "0xa"],
  );
  // The input is untouched.
  assert.deepEqual(
    pools.map((row) => row.id),
    ["0xa", "0xd", "0xc", "0xb", "0xe", "0xf"],
  );
});

test("a volume that is no longer current counts as unknown and goes last", () => {
  const old = pool("0x1", 5_000_000, {
    metricUpdatedAt: new Date(NOW - 20 * 60_000).toISOString(),
  });
  const unconfirmed = pool("0x2", 4_000_000, { metricStatus: undefined });
  const current = pool("0x3", 1);
  assert.deepEqual(
    orderedPools([old, unconfirmed, current], "h24", NOW, true).map(
      (row) => row.id,
    ),
    ["0x3", "0x1", "0x2"],
  );
});

test("the chosen window decides the order", () => {
  const a = pool("0xa", 1, { volumeUsd: { h1: 9, h6: 2, h24: 1 } });
  const b = pool("0xb", 1, { volumeUsd: { h1: 1, h6: 8, h24: 3 } });
  const ids = (window) =>
    orderedPools([a, b], window, NOW, true).map((row) => row.id);
  assert.deepEqual(ids("h1"), ["0xa", "0xb"]);
  assert.deepEqual(ids("h6"), ["0xb", "0xa"]);
  assert.deepEqual(ids("h24"), ["0xb", "0xa"]);
});

test("outside the edition the list keeps the order it was given", () => {
  const pools = [pool("0xb", 1), pool("0xa", 1_000)];
  assert.equal(orderedPools(pools, "h24", NOW, false), pools);
  // Unset flag in this process: the default is the live order.
  assert.equal(orderedPools(pools, "h24", NOW), pools);
});

/* ── The wording of the pool counts ────────────────────────────────────── */

test("a snapshot calls its pool count measured everywhere it appears", () => {
  const words = poolWording(true);
  assert.equal(words.readoutLabel, "Pools measured");
  assert.equal(words.countNote(345), "Measured in this snapshot");
  assert.equal(words.countNote(null), "None measured");
  assert.equal(words.tabFigure(345, "345"), "measured 345");
  assert.equal(words.tabFigure(null, "—"), "none measured");
  assert.deepEqual(words.setupCount(345, "345"), {
    figure: "345",
    unit: "measured pools",
  });
  assert.deepEqual(words.setupCount(1, "1"), {
    figure: "1",
    unit: "measured pool",
  });
  assert.deepEqual(words.setupCount(null, "—"), {
    figure: "None",
    unit: "measured",
  });
  assert.equal(words.listUnit(false), "measured pools");
  assert.equal(words.listUnit(true), "matching measured pools");
  assert.equal(words.listOrder("24H"), "Sorted by 24H volume");
});

test("a snapshot's list of one pool is singular", () => {
  const words = poolWording(true);
  assert.equal(words.listUnit(false, 1), "measured pool");
  assert.equal(words.listUnit(true, 1), "matching measured pool");
  for (const total of [0, 2, 345, null, undefined]) {
    assert.equal(words.listUnit(false, total), "measured pools");
    assert.equal(words.listUnit(true, total), "matching measured pools");
  }
});

test("outside the edition the pool counts keep today's words", () => {
  for (const words of [poolWording(false), poolWording()]) {
    assert.equal(words.readoutLabel, "Pools found");
    assert.equal(words.countNote(345), "From market sources");
    assert.equal(words.countNote(null), "Not available");
    assert.equal(words.tabFigure(345, "345"), "345");
    assert.equal(words.tabFigure(null, "—"), "—");
    assert.deepEqual(words.setupCount(345, "345"), {
      figure: "345",
      unit: "pools",
    });
    assert.deepEqual(words.setupCount(1, "1"), { figure: "1", unit: "pool" });
    assert.deepEqual(words.setupCount(null, "—"), {
      figure: "—",
      unit: "pools",
    });
    assert.equal(words.listUnit(false), "pools");
    assert.equal(words.listUnit(true), "matching pools");
    // The live list says "pools" for one as it always has.
    assert.equal(words.listUnit(false, 1), "pools");
    assert.equal(words.listUnit(true, 1), "matching pools");
    assert.equal(words.listOrder("24H"), null);
  }
});

/* ── Who reported a discovered hook ────────────────────────────────────── */

const INDEXER_TEXT =
  "Hook address reported by the v4.xyz indexer for pools Hook Radar measured. Project identity and contract source have not been verified.";
const CENSUS_TEXT =
  "Discovered from a PoolManager initialization event. Project identity and contract source have not been verified.";

const hook = (discovery, sourceUrl) => ({
  id: "1:0x00",
  address: "0x00",
  chain: "base",
  chainId: 8453,
  name: "Hook 0x00",
  description: "",
  verifiedSource: false,
  discovery,
  flags: {},
  properties: { swapAccess: "unknown" },
  auditUrl: null,
  sourceUrl,
  explorerUrl: "https://example.test",
});
const project = (deployments, description) => ({
  id: "hook-1",
  name: "Hook 0x00",
  description,
  category: "Other",
  chains: ["base"],
  deployments,
  sourceUrl: deployments[0]?.sourceUrl ?? "",
});
const fromIndexer = project(
  [hook("onchain", COMMUNITY_INDEXER_SOURCE)],
  INDEXER_TEXT,
);
const fromCensus = project(
  [
    hook(
      "onchain",
      "https://developers.uniswap.org/docs/protocols/v4/deployments",
    ),
  ],
  CENSUS_TEXT,
);

test("the page recognises the source URL the collector stamps on an indexer-reported hook", () => {
  // collector/assemble.mjs gives such a hook ENVIO_MARKET_SOURCE. If the two ever
  // part, the drawer would call an indexer-reported hook a PoolManager discovery.
  assert.equal(COMMUNITY_INDEXER_SOURCE, ENVIO_MARKET_SOURCE);
  assert.match(
    readFileSync(new URL("../collector/assemble.mjs", import.meta.url), "utf8"),
    /deployment.sourceUrl = ENVIO_MARKET_SOURCE/,
  );
});

test("only a hook whose every deployment came from the indexer is reported by it", () => {
  assert.equal(reportedByIndexer(fromIndexer), true);
  assert.equal(reportedByIndexer(fromCensus), false);
  assert.equal(
    reportedByIndexer(
      project(
        [
          hook("onchain", COMMUNITY_INDEXER_SOURCE),
          hook("onchain", fromCensus.deployments[0].sourceUrl),
        ],
        "",
      ),
    ),
    false,
  );
  // A registry listing that cites the same page is not an indexer report.
  assert.equal(
    reportedByIndexer(project([hook(undefined, COMMUNITY_INDEXER_SOURCE)], "")),
    false,
  );
  assert.equal(reportedByIndexer(project([], "")), false);
});

test("the edition names an indexer-reported hook for what it is and shows the snapshot's description", () => {
  const identity = projectIdentity(fromIndexer, { edition: true });
  assert.equal(identity.label, "Reported by the v4.xyz indexer");
  assert.equal(identity.description, INDEXER_TEXT);
  assert.equal(discoverySummary(fromIndexer, { edition: true }), INDEXER_TEXT);
  // It was never seen in a PoolManager event, so that wording must not appear,
  // and a census date would not describe it.
  const census = "Census as of 27 Oct 2026";
  for (const text of [
    projectIdentity(fromIndexer, { edition: true, census }).description,
    discoverySummary(fromIndexer, { edition: true, census }),
  ]) {
    assert.doesNotMatch(text, /pool creation events/i);
    assert.doesNotMatch(text, /census/i);
  }
});

test("an indexer-reported hook with no description is never described as a PoolManager discovery", () => {
  const census = "Census as of 27 Oct 2026";
  for (const blank of ["", "   ", "\n\t"]) {
    const row = project([hook("onchain", COMMUNITY_INDEXER_SOURCE)], blank);
    for (const options of [
      { edition: true },
      { edition: true, census },
      { edition: true, census: null },
    ]) {
      const identity = projectIdentity(row, options);
      assert.equal(identity.label, "Reported by the v4.xyz indexer");
      assert.equal(identity.description, INDEXER_TEXT);
      // The sentence under the name and the identity card say the same thing.
      assert.equal(discoverySummary(row, options), identity.description);
      assert.doesNotMatch(
        discoverySummary(row, options),
        /pool creation events/i,
      );
      assert.doesNotMatch(discoverySummary(row, options), /census/i);
    }
    // The live page does not take the edition's wording.
    assert.equal(
      discoverySummary(row, { edition: false, census }),
      "Hook contract identified in Uniswap v4 pool creation events.",
    );
    assert.equal(
      projectIdentity(row, { edition: false }).label,
      "Onchain discovery",
    );
  }
});

test("the edition keeps the PoolManager wording for a census hook and dates it", () => {
  const census = "Census as of 27 Oct 2026";
  assert.equal(
    discoverySummary(fromCensus, { edition: true, census }),
    "Hook contract identified in Uniswap v4 pool creation events. Census as of 27 Oct 2026.",
  );
  const identity = projectIdentity(fromCensus, { edition: true, census });
  assert.equal(identity.label, "Onchain discovery");
  assert.equal(
    identity.description,
    "Found in Uniswap v4 pool creation events. No named registry listing is available. Census as of 27 Oct 2026.",
  );
  // No census date, no dangling sentence.
  assert.equal(
    discoverySummary(fromCensus, { edition: true, census: null }),
    "Hook contract identified in Uniswap v4 pool creation events.",
  );
  assert.equal(
    projectIdentity(fromCensus, { edition: true }).description,
    "Found in Uniswap v4 pool creation events. No named registry listing is available.",
  );
});

test("outside the edition every discovered hook keeps the live identity", () => {
  const census = "Census as of 27 Oct 2026";
  for (const row of [fromIndexer, fromCensus]) {
    for (const options of [{ edition: false, census }, { census }, undefined]) {
      assert.equal(projectIdentity(row, options).label, "Onchain discovery");
      assert.equal(
        projectIdentity(row, options).description,
        "Found in Uniswap v4 pool creation events. No named registry listing is available.",
      );
      assert.equal(
        discoverySummary(row, options),
        "Hook contract identified in Uniswap v4 pool creation events.",
      );
    }
  }
});

/* ── The component hands the edition's words to the page ───────────────── */

const component = readFileSync(
  new URL("../src/components/ProjectDetail.tsx", import.meta.url),
  "utf8",
);

test("the drawer writes no time in the visitor's own zone except on the live page", () => {
  const uses = component.match(/toLocaleString\(/g) ?? [];
  assert.equal(uses.length, 1, "one use, inside timeDetail()");
  assert.match(
    component,
    /STATIC_EDITION\s*\?\s*\(fullTimeLabel\(value\) \?\? undefined\)\s*:\s*new Date\(value\)\.toLocaleString\(\)/,
  );
});

test("the live words of the drawer are still in the source for the live page", () => {
  // The edition's copy replaces these through the helpers above; the live page
  // keeps them verbatim.
  for (const live of [
    "Updates unavailable",
    "Showing the last loaded project. Updates resume automatically.",
    "Price data isn’t available yet.",
  ])
    assert.ok(component.includes(live), live);
});
