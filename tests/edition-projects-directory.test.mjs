// The Projects page of the Auto Snapshot edition: which rows it lists, what a
// card says, how the list is searched and ordered, the address it keeps, the
// tab it adds and the rules it must keep (no name decides a listing, no pin,
// null is not zero, a sum over a sample is "at least"). Pure rules run in Node;
// the page is rendered on the server the way tests/edition-w3-app.test.mjs
// renders its components. The edition's helpers take an explicit `true`, so what
// runs here is what the edition's build prints.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { buildChains, chainRoles } from "../src/chains.ts";
import {
  PROJECTS_RENDER_MAX,
  dailyFigureNote,
  filterByUse,
  listProjects,
  listedNames,
  networkLine,
  networkOptions,
  projectBrand,
  projectFigures,
  projectIdentity,
  projectNotes,
  projectRoles,
  projectStatus,
  projectsMeta,
  searchProjects,
  sharedPoolNote,
  unlistedCount,
  unmeasuredNote,
  useCaseOptions,
  visibleProjects,
  withTrackedPools,
} from "../src/projects-directory.ts";
import {
  EDITION_ONLY_VIEWS,
  editionNavigation,
  editionViews,
} from "../src/edition.ts";
import {
  SPAN_VIEWS,
  chainRoleKeys,
  navigationSearch,
  parseNavigation,
  projectSortKeys,
  projectsQuery,
} from "../src/navigation.ts";
import { browserTitle } from "../src/browser-title.ts";
import { dailyView, DAILY_VIEWS } from "../src/daily.ts";
import { getProtocolArtwork } from "../src/protocol-logos.ts";
import { verifiedProtocolFamilies } from "../src/protocol-identities.ts";
import { MARKET_MAX_AGE_MS } from "../shared/market-freshness.ts";
import { makeSnapshot, testProjects } from "./fixtures.mjs";

const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const iso = (time) => new Date(time).toISOString();
const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );
/** Source with its comments cut out, so a rule about code is not tripped by the
 * words of an explanation. */
const code = (path) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

/* ── A small snapshot with every kind of row ───────────────────────────── */

const address = (digit) => `0x${String(digit).repeat(39)}1`;
const deployment = (n, chain, name) => ({
  ...testProjects[0].deployments[0],
  id: `${chain}:${address(n)}`,
  address: address(n),
  chain,
  chainId: { base: 8453, ethereum: 1, robinhood: 4663 }[chain],
  name,
});
const project = (id, name, n, chain, extra = {}) => ({
  id,
  name,
  description: `${name} is a hook project used by the tests.`,
  category: "Launches",
  website: null,
  docs: null,
  sourceUrl: "https://github.com/Uniswap/hooklist",
  deployments: [deployment(n, chain, `${name}Hook`)],
  chains: [chain],
  metrics: {
    poolCount: null,
    liquidityUsd: null,
    volumeUsd: { h1: null, h6: null, h24: null },
    coverage: "unavailable",
    note: "",
  },
  history: [],
  ...extra,
});
const pool = (id, projectId, hook, chain, volume, liquidity, age = 1000) => ({
  ...makeSnapshot().pools[0],
  id,
  chain,
  address: `0x${id.padEnd(64, "0").slice(0, 64)}`,
  hookAddress: hook,
  projectId,
  volumeUsd: { h1: volume / 24, h6: volume / 4, h24: volume },
  liquidityUsd: liquidity,
  metricStatus: "live",
  metricUpdatedAt: iso(NOW - age),
});

function listedSnapshot() {
  const snapshot = makeSnapshot();
  snapshot.generatedAt = iso(NOW);
  const alpha = project("alpha", "Alpha Markets", 1, "base", {
    website: "https://alpha.example",
    chains: ["base", "ethereum"],
    deployments: [
      deployment(1, "base", "AlphaHook"),
      deployment(2, "ethereum", "AlphaEthereumHook"),
    ],
  });
  snapshot.projects = [
    alpha,
    // No site, no artwork, no platform flag: left to Discover.
    project("beta", "Beta Liquidity", 3, "base", { category: "Liquidity" }),
    // An http-only site is not a public identity the page can check.
    project("gamma", "Gamma Fees", 4, "base", {
      website: "http://gamma.example",
    }),
    // Documentation alone is enough.
    project("delta", "Delta Docs", 5, "base", {
      docs: "https://docs.delta.example",
      category: "Fees",
    }),
    // A measured zero.
    project("frontier", "Frontier", 6, "robinhood", {
      website: "https://frontier.fun",
      docs: "https://docs.frontier.fun",
    }),
    // Artwork in the reviewed tables, no site of its own.
    project("clanker", "Clanker", 7, "base"),
    // The same name, another id: the name lists nothing.
    project("hook-clone", "Clanker", 8, "base"),
    // A launch platform record.
    project("platform-x", "Platform X", 9, "base", {
      entityType: "platform",
      deployments: [],
      website: "https://platformx.example",
    }),
    // Two rows that publish one hook.
    project("twin-a", "Twin A", 10, "base", {
      website: "https://twin-a.example",
    }),
    project("twin-b", "Twin B", 10, "base", {
      website: "https://twin-b.example",
    }),
    project("twin-x", "Twin X", 10, "base"),
  ];
  snapshot.pools = [
    pool("a1", "alpha", address(1), "base", 40, 400),
    pool("a2", "alpha", address(2), "ethereum", 60, 600),
    pool("f1", "frontier", address(6), "robinhood", 0, 0),
    pool("old", "alpha", address(1), "base", 9e9, 9e9, MARKET_MAX_AGE_MS + 1),
    pool("t1", "twin-a", address(10), "base", 5, 50),
  ];
  return snapshot;
}

const model = (snapshot, options = {}) =>
  buildChains(snapshot, {
    chain: "all",
    now: NOW,
    hookOverlap: true,
    listings: false,
    ...options,
  });
const listedIds = (rows) => rows.map((row) => row.project.id);
const rowOf = (result, id) =>
  result.protocols.find((row) => row.project.id === id);

/* ── Which rows are listed ─────────────────────────────────────────────── */

test("a row is listed for a platform record, an https site or documentation, or reviewed artwork; a name lists nothing", () => {
  const result = model(listedSnapshot());
  const why = Object.fromEntries(
    result.protocols.map((row) => [row.project.id, projectIdentity(row)]),
  );
  assert.deepEqual(why, {
    alpha: "official-link",
    beta: null,
    gamma: null,
    delta: "official-link",
    frontier: "official-link",
    clanker: "verified-artwork",
    "hook-clone": null,
    "platform-x": "launch-platform",
    "twin-a": "official-link",
    "twin-b": "official-link",
    "twin-x": null,
  });
  assert.deepEqual(listedIds(listProjects(result.protocols)).sort(), [
    "alpha",
    "clanker",
    "delta",
    "frontier",
    "platform-x",
    "twin-a",
    "twin-b",
  ]);
  assert.equal(unlistedCount(result.protocols), 4);
});

test("a row with no platform flag, no https website or docs and no artwork is excluded, whatever it is called", () => {
  for (const name of ["Clanker", "Frontier", "Pons", "Angstrom", "Uniswap"]) {
    const row = {
      project: project("hook-1234567890abcdef", name, 1, "base"),
    };
    assert.equal(projectIdentity(row), null, name);
  }
  // The link rule reads the project's own fields: the Networks page's fallback
  // address for Uniswap's own families is the row's, and counts for nothing.
  assert.equal(
    projectIdentity({
      project: project("x", "X", 1, "base"),
      website: "https://uniswap.org/",
      docs: "https://github.com/Uniswap/v4-hooks-public#docs",
    }),
    null,
  );
  // Neither does a link that is not https, a bad address or an empty one.
  for (const link of ["http://a.example", "ftp://a.example", "nonsense", ""])
    assert.equal(
      projectIdentity({
        project: project("x", "X", 1, "base", { website: link, docs: link }),
      }),
      null,
      link,
    );
});

test("the rule is read from the code: no pattern on a name, no list of projects, no pin", () => {
  for (const path of [
    "src/projects-directory.ts",
    "src/components/ProjectsDirectory.tsx",
  ]) {
    const source = code(path);
    assert.doesNotMatch(source, /new RegExp|\.match\(|\.test\(/, path);
    assert.doesNotMatch(source, /pinChainProtocol/, path);
    assert.doesNotMatch(source, /frontier/i, `${path} has no special case`);
  }
  // The identity rule keeps no list of ids or names of its own.
  const rule = code("src/projects-directory.ts").match(
    /export function projectIdentity[\s\S]*?\n}\n/,
  )[0];
  assert.doesNotMatch(rule, /\.id\b|\.name\b|includes\(|\[\s*"/);
  // And nothing in the new code names a file of the live service.
  const mine = [
    read("src/projects-directory.ts"),
    read("src/components/ProjectsDirectory.tsx"),
    read("src/components/projects-directory.css"),
  ].join("\n");
  assert.doesNotMatch(mine, /server\//);
});

test("listing is scoped by network without dropping a row: a network's list is its own rows of the whole list", () => {
  const snapshot = listedSnapshot();
  const everyone = listProjects(model(snapshot).protocols);
  const names = new Map(model(snapshot).networks.map((n) => [n.slug, n.name]));
  for (const slug of ["base", "ethereum", "robinhood"]) {
    const scoped = listProjects(model(snapshot, { chain: slug }).protocols);
    assert.deepEqual(
      listedIds(scoped).sort(),
      listedIds(everyone)
        .filter((id) => rowOf(model(snapshot), id).chainSlugs.includes(slug))
        .sort(),
      slug,
    );
  }
  // The options count what the list holds.
  const options = networkOptions(everyone, names);
  assert.deepEqual(
    options.map((o) => [o.slug, o.count]),
    [
      ["base", 6],
      ["ethereum", 1],
      ["robinhood", 1],
    ],
  );
  assert.equal(options[0].name, "Base");
  // A network the model has no name for is called by its slug.
  assert.equal(networkOptions(everyone, new Map())[0].name, "base");
  // The figures are the chosen network's own.
  const onEthereum = rowOf(model(snapshot, { chain: "ethereum" }), "alpha");
  assert.equal(onEthereum.volumeUsd, 60);
  assert.equal(rowOf(model(snapshot), "alpha").volumeUsd, 100);
});

/* ── Cards ─────────────────────────────────────────────────────────────── */

test("a figure that was not measured is a dash, a measured zero is $0, a sum over a sample is at least", () => {
  const result = model(listedSnapshot());
  const alpha = projectFigures(rowOf(result, "alpha"));
  assert.equal(alpha.volume, 100);
  assert.equal(alpha.reserves, 1000);
  assert.equal(alpha.pools, 3, "the old pool is counted, not summed");
  // A sum of measured pools whose count is a lower bound is marked.
  assert.equal(alpha.poolsMark, "≥");
  assert.equal(alpha.volumeMark, "≥");
  assert.equal(alpha.reservesMark, "≥");
  assert.equal(alpha.unmeasured, false);
  // A measured zero stays zero, and is marked like any other sum.
  const frontier = projectFigures(rowOf(result, "frontier"));
  assert.equal(frontier.volume, 0);
  assert.equal(frontier.reserves, 0);
  assert.equal(frontier.volumeMark, "≥");
  // Nothing measured: null everywhere, no mark, and the card says so.
  const delta = projectFigures(rowOf(result, "delta"));
  assert.equal(delta.volume, null);
  assert.equal(delta.reserves, null);
  assert.equal(delta.pools, null);
  assert.equal(delta.volumeMark, "");
  assert.equal(delta.poolsMark, "");
  assert.equal(delta.unmeasured, true);
  // A row whose count is exact carries no mark. (Exactness comes from the
  // census; it is not guessed here.)
  const exact = projectFigures({
    ...rowOf(result, "alpha"),
    poolCountExact: true,
  });
  assert.equal(exact.volumeMark, "");
  assert.equal(exact.poolsMark, "");
  // A volume with pools measured but no price in the window is null, with the
  // pool count shown: not "unmeasured", and still no zero.
  const unpriced = projectFigures({
    ...rowOf(result, "alpha"),
    volumeUsd: null,
    liquidityUsd: null,
  });
  assert.equal(unpriced.unmeasured, false);
  assert.equal(unpriced.volume, null);
  assert.equal(unpriced.volumeMark, "");
});

test("the note of a card with nothing measured names the network the list is cut to", () => {
  assert.equal(unmeasuredNote(), "Not measured in this snapshot");
  assert.equal(unmeasuredNote(null), "Not measured in this snapshot");
  assert.equal(unmeasuredNote("Base"), "Not measured on Base in this snapshot");
});

test("a 7D or 30D card names the day its figure runs to, or says it counts from launch; nothing without a figure", () => {
  const lens = { throughMs: Date.parse("2026-11-11T00:00:00Z") };
  assert.equal(
    dailyFigureNote({ usd: 5, youngDays: null }, lens),
    "through 11 Nov",
  );
  assert.equal(
    dailyFigureNote({ usd: 5, youngDays: 3 }, lens),
    "since launch · 3 days",
  );
  assert.equal(
    dailyFigureNote({ usd: 5, youngDays: 1 }, lens),
    "since launch · 1 day",
  );
  assert.equal(dailyFigureNote({ usd: null, youngDays: null }, lens), null);
  assert.equal(dailyFigureNote(undefined, lens), null);
  assert.equal(dailyFigureNote({ usd: 5, youngDays: null }, null), null);
  // A measured zero is a figure.
  assert.equal(
    dailyFigureNote({ usd: 0, youngDays: null }, lens),
    "through 11 Nov",
  );
});

test("a platform shows its reviewed status, a hook project none; use cases are in the page's order", () => {
  // The reviewed launch platforms come with the model (listings are on).
  const result = model(listedSnapshot(), { listings: true });
  const bags = rowOf(result, "bags");
  assert.equal(projectIdentity(bags), "launch-platform");
  const platform = projectStatus(bags);
  assert.equal(platform.status, "live");
  assert.equal(platform.label, "Live");
  assert.equal(projectStatus(rowOf(result, "alpha")), null);
  // A platform entry that is not a reviewed launchpad has no status to show.
  assert.equal(projectStatus(rowOf(model(listedSnapshot()), "platform-x")), null);
  const roles = projectRoles(bags).map((r) => r.label);
  assert.deepEqual(roles, ["Launchpads", "Token launches"]);
  // The order is the chain model's role order.
  const order = chainRoles.map((role) => role.label);
  const sorted = roles.every(
    (label, index) => index === 0 || order.indexOf(roles[index - 1]) < order.indexOf(label),
  );
  assert.ok(sorted);
});

test("the artwork brand shows above a name that is not the brand, never for a platform or a name that is the brand", () => {
  const entries = Object.entries(verifiedProtocolFamilies);
  assert.ok(entries.length > 5, "the reviewed table is read");
  let differing = 0;
  for (const [id, family] of entries) {
    const built = {
      id,
      name: family.name,
      description: "",
      deployments: family.deployments.map((d) => ({ ...d, discovery: "published" })),
    };
    const artwork = getProtocolArtwork(built);
    if (!artwork) continue;
    const brand = projectBrand({ project: built });
    const same =
      artwork.protocol.toLowerCase().replace(/[^a-z0-9]/g, "") ===
      family.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    assert.equal(brand, same ? null : artwork.protocol, family.name);
    if (!same) differing += 1;
  }
  assert.ok(differing > 0, "at least one family carries another brand");
  // A platform has no brand line; nor does a row without artwork.
  assert.equal(
    projectBrand({ project: { ...project("p", "P", 1, "base"), entityType: "platform" } }),
    null,
  );
  assert.equal(projectBrand({ project: project("q", "Q", 1, "base") }), null);
});

test("the networks of a card: up to three, the chosen one first, then a count and the full list", () => {
  const names = new Map(
    ["a", "b", "c", "d", "e"].map((slug) => [slug, slug.toUpperCase()]),
  );
  const row = { chainSlugs: ["a", "b", "c", "d", "e"] };
  assert.deepEqual(networkLine(row, names), {
    shown: ["A", "B", "C"],
    more: 2,
    all: ["A", "B", "C", "D", "E"],
  });
  assert.deepEqual(networkLine(row, names, "d").shown, ["D", "A", "B"]);
  assert.equal(networkLine({ chainSlugs: ["a"] }, names).more, 0);
  assert.deepEqual(networkLine({ chainSlugs: ["zz"] }, names).all, ["zz"]);
});

/* ── Notes: scope and shared hooks ─────────────────────────────────────── */

test("a shared-hook sentence names only the projects this page lists and counts the rest, which are in Discover", () => {
  const listed = new Set(["Alpha", "Beta"]);
  const say = (names) => sharedPoolNote({ sharedHookWith: names }, listed);
  const tail =
    "Overlapping pools count in each row and are never added together.";
  assert.equal(say([]), null);
  assert.equal(say(undefined), null);
  assert.equal(say(["Alpha"]), `Shares a hook with Alpha. ${tail}`);
  assert.equal(say(["Alpha", "Beta"]), `Shares a hook with Alpha and Beta. ${tail}`);
  assert.equal(
    say(["Alpha", "Gone"]),
    `Shares a hook with Alpha and 1 other hook entry in Discover. ${tail}`,
  );
  assert.equal(
    say(["Alpha", "Beta", "X", "Y", "Z"]),
    `Shares a hook with Alpha, Beta and 3 other hook entries in Discover. ${tail}`,
  );
  assert.equal(
    say(["Gone", "Else"]),
    `Shares a hook with 2 other hook entries in Discover. ${tail}`,
  );
  // An unlisted name is never printed.
  assert.doesNotMatch(say(["Alpha", "Gone"]), /Gone/);
});

test("on a snapshot, two listed rows name each other and the unlisted third is only counted", () => {
  const result = model(listedSnapshot());
  const listed = listProjects(result.protocols);
  const names = listedNames(listed, result.protocols);
  const a = rowOf(result, "twin-a");
  assert.deepEqual([...a.sharedHookWith].sort(), ["Twin B", "Twin X"]);
  assert.equal(
    sharedPoolNote(a, names),
    "Shares a hook with Twin B and 1 other hook entry in Discover. Overlapping pools count in each row and are never added together.",
  );
  // A name two rows hold cannot tell a listed project from an unlisted hook.
  const held = listedNames(listed, [
    ...result.protocols,
    { project: { name: "Twin B" } },
  ]);
  assert.equal(held.has("Twin B"), false);
  assert.equal(held.has("Twin A"), true);
  // The shared-hook note and a scope note come from the row, in this order.
  assert.deepEqual(projectNotes(a, names), [sharedPoolNote(a, names)]);
  const frontier = projectNotes(rowOf(result, "frontier"), names);
  assert.equal(frontier.length, 1);
  assert.match(frontier[0], /bonding curve/);
});

/* ── Search, use case and order ────────────────────────────────────────── */

function everyone() {
  const result = model(listedSnapshot());
  return {
    result,
    rows: listProjects(result.protocols),
    names: new Map(result.networks.map((n) => [n.slug, n.name])),
  };
}

test("the default order is tracked volume, a measured zero before nothing measured, then name and id", () => {
  const { rows, names } = everyone();
  const order = (sort) =>
    listedIds(visibleProjects(rows, { query: "", use: "all", sort, names }));
  assert.deepEqual(order("volume"), [
    "alpha", // 100
    "twin-a", // 5
    "frontier", // measured zero
    "clanker",
    "delta",
    "platform-x",
    "twin-b",
  ]);
  assert.deepEqual(order("name"), [
    "alpha",
    "clanker",
    "delta",
    "frontier",
    "platform-x",
    "twin-a",
    "twin-b",
  ]);
  assert.equal(order("pools")[0], "alpha");
  assert.equal(order("reserves")[0], "alpha");
  // No project is moved to the front: each stays at its rank by volume.
  assert.ok(order("volume").indexOf("frontier") > order("volume").indexOf("twin-a"));
});

test("a search keeps the rows that hold every word, folds accents and reads network and use-case names", () => {
  const { rows, names } = everyone();
  const find = (query) => listedIds(searchProjects(rows, query, names)).sort();
  assert.deepEqual(find("alpha markets"), ["alpha"]);
  assert.deepEqual(find("MARKETS  alpha"), ["alpha"]);
  assert.deepEqual(find("alpha zzz"), []);
  assert.deepEqual(find("ethereum"), ["alpha"], "a network's name finds its projects");
  assert.ok(find("robinhood").includes("frontier"));
  assert.ok(find("fees").includes("delta"), "a use case's name finds its projects");
  assert.deepEqual(find(""), listedIds(rows).sort());
  assert.deepEqual(find("   "), listedIds(rows).sort());
  // Accents are folded on both sides (a typed "cafe" finds "Café").
  const accented = [
    { ...rows[0], project: { ...rows[0].project, name: "Café Markets" } },
  ];
  assert.equal(searchProjects(accented, "cafe", names).length, 1);
  assert.equal(searchProjects(accented, "CAFÉ", names).length, 1);
  // The brand of a hook's artwork finds it.
  const clone = [{ ...rows[0], project: { ...rows[0].project, id: "clanker", name: "Clanker" } }];
  assert.equal(searchProjects(clone, "clanker", names).length, 1);
  // A pool or an address is a Discover search: it finds nothing here.
  assert.deepEqual(find(address(1)), []);
  // The query is cut at 300 characters.
  assert.equal(searchProjects(rows, `alpha ${"x".repeat(400)}`, names).length, 0);
});

test("a use-case filter keeps the rows that hold the role; the options count the list, in order, without empty ones", () => {
  const { rows, names } = everyone();
  // The reviewed launchpad role needs the product's own site: Frontier has it,
  // a row called Clanker with no site does not.
  assert.deepEqual(
    listedIds(filterByUse(rows, "launchpads")).sort(),
    ["frontier"],
  );
  assert.equal(filterByUse(rows, "all").length, rows.length);
  const { reviewed, cases } = useCaseOptions(rows);
  assert.deepEqual(
    reviewed.map((o) => [o.id, o.count]),
    [["launchpads", 1]],
  );
  assert.ok(cases.every((o) => o.count > 0));
  const labels = [...reviewed, ...cases].map((o) => o.label);
  const order = chainRoles.map((r) => r.label);
  assert.deepEqual(
    labels,
    order.filter((label) => labels.includes(label)),
    "in the chain model's order",
  );
  assert.equal(cases.find((o) => o.id === "launches").count > 0, true);
  // Nothing in the options comes from outside the list given.
  assert.deepEqual(useCaseOptions([]), { reviewed: [], cases: [] });
  assert.equal(
    visibleProjects(rows, { query: "alpha", use: "liquidity", sort: "name", names }).length,
    0,
  );
});

test("the line above the list is counts only, never a total of money", () => {
  const base = {
    shown: 71,
    total: 71,
    networks: 20,
    withPools: 42,
    use: null,
    network: null,
    filtered: false,
  };
  assert.equal(
    projectsMeta(base),
    "71 projects on 20 networks · 42 with tracked pools",
  );
  assert.equal(
    projectsMeta({ ...base, shown: 12, use: "Launchpads", network: "Base", filtered: true }),
    "12 of 71 projects · Launchpads · Base",
  );
  assert.equal(projectsMeta({ ...base, shown: 3, filtered: true }), "3 of 71 projects");
  assert.equal(
    projectsMeta({ ...base, total: 1, networks: 1, withPools: 0 }),
    "1 project on 1 network · 0 with tracked pools",
  );
  assert.doesNotMatch(projectsMeta(base), /\$/);
  assert.equal(withTrackedPools(everyone().rows), 3);
  assert.equal(PROJECTS_RENDER_MAX, 150);
});

/* ── The address ───────────────────────────────────────────────────────── */

test("the Projects scope round-trips through the address and is written only on its own page", () => {
  const search =
    "?view=projects&projects_q=fables&projects_network=base&projects_use=launchpads&projects_sort=name";
  const state = parseNavigation(search, true);
  assert.equal(state.view, "projects");
  assert.equal(state.projectsSearch, "fables");
  assert.equal(state.projectsNetwork, "base");
  assert.equal(state.projectsUse, "launchpads");
  assert.equal(state.projectsSort, "name");
  const query = new URLSearchParams(navigationSearch(state, true));
  assert.equal(query.get("view"), "projects");
  assert.equal(query.get("projects_q"), "fables");
  assert.equal(query.get("projects_network"), "base");
  assert.equal(query.get("projects_use"), "launchpads");
  assert.equal(query.get("projects_sort"), "name");
  // Defaults are not written.
  const plain = navigationSearch(parseNavigation("?view=projects", true), true);
  assert.equal(plain, "?view=projects");
  // Another page writes none of it.
  const elsewhere = navigationSearch({ ...state, view: "chains" }, true);
  assert.doesNotMatch(elsewhere, /projects_/);
  // The open project keeps its own name: `project` is the drawer.
  const open = new URLSearchParams(
    navigationSearch({ ...state, project: "alpha", detailTab: "pools" }, true),
  );
  assert.equal(open.get("project"), "alpha");
  assert.equal(open.get("projects_use"), "launchpads");
});

test("a value the address cannot hold falls back; a search is cut and cleaned", () => {
  const state = parseNavigation(
    "?view=projects&projects_network=Not%20A%20Slug&projects_use=nonsense&projects_sort=desc",
    true,
  );
  assert.equal(state.projectsNetwork, "all");
  assert.equal(state.projectsUse, "all");
  assert.equal(state.projectsSort, "volume");
  assert.deepEqual([...projectSortKeys], ["volume", "reserves", "pools", "name"]);
  for (const key of chainRoleKeys)
    assert.equal(
      parseNavigation(`?view=projects&projects_use=${key}`, true).projectsUse,
      key,
    );
  const long = parseNavigation(
    `?view=projects&projects_q=${"a".repeat(400)}`,
    true,
  );
  assert.equal(long.projectsSearch.length, 300);
  assert.equal(projectsQuery("a\u0000b\u001fc\u007fd"), "abcd");
  assert.equal(projectsQuery(null), "");
  assert.equal(projectsQuery("x".repeat(500)).length, 300);
  const written = navigationSearch(
    { ...parseNavigation("?view=projects", true), projectsSearch: "a b&c" },
    true,
  );
  assert.equal(new URLSearchParams(written).get("projects_q"), "a b&c");
});

test("without the edition a link to the Projects page lands on Discover", () => {
  assert.equal(parseNavigation("?view=projects").view, "overview");
  assert.equal(parseNavigation("?view=projects", false).view, "overview");
  assert.equal(parseNavigation("?view=projects", true).view, "projects");
  // And the live address never carries its scope.
  const live = navigationSearch(
    { ...parseNavigation("?view=projects", true), projectsUse: "fees" },
    false,
  );
  assert.doesNotMatch(live, /projects_/);
});

test("7D and 30D are kept on the Projects page in the edition and dropped from every other page that shows none", () => {
  const link = (search) => editionNavigation(parseNavigation(search, true), true);
  assert.equal(link("?view=projects&window=d7").span, "d7");
  assert.equal(link("?view=projects&window=d30").span, "d30");
  assert.equal(link("?view=map&window=d7").span, null);
  assert.ok(SPAN_VIEWS.includes("projects"));
  assert.ok(DAILY_VIEWS.includes("projects"));
  assert.equal(dailyView("projects"), true);
  // It is written back to the address.
  const state = link("?view=projects&window=d30");
  assert.equal(new URLSearchParams(navigationSearch(state, true)).get("window"), "d30");
});

/* ── The tab ───────────────────────────────────────────────────────────── */

test("the edition's pages put Projects between Analytics and Networks; the live list does not have it", () => {
  const all = [
    "overview",
    "learn",
    "analytics",
    "projects",
    "chains",
    "map",
    "activity",
    "compare",
    "watchlist",
  ];
  assert.deepEqual(editionViews(all, true), [
    "overview",
    "analytics",
    "projects",
    "chains",
    "map",
    "compare",
    "watchlist",
    "learn",
  ]);
  assert.deepEqual(
    editionViews(all, false),
    all.filter((view) => view !== "projects"),
  );
  assert.deepEqual([...EDITION_ONLY_VIEWS], ["projects"]);
  // A list that does not have it is returned as it was.
  assert.deepEqual(editionViews(["overview", "map"], false), ["overview", "map"]);
});

test("the header and the Jump list put Projects third, beside the same function", () => {
  const app = read("src/App.tsx");
  assert.match(app, /"analytics",\s*"projects",\s*"chains",/);
  assert.match(app, /data-testid=\{`view-\$\{item\}`\}/);
  const palette = read("src/components/CommandPalette.tsx");
  const pages = palette.slice(palette.indexOf("const pages"));
  assert.ok(
    pages.indexOf('view: "projects"') > pages.indexOf('view: "analytics"') &&
      pages.indexOf('view: "projects"') < pages.indexOf('view: "chains"'),
    "the palette lists it before Networks",
  );
  assert.match(pages, /label: "Projects", hint: "Who builds on v4 hooks"/);
  assert.equal(browserTitle({ view: "projects" }), "Uniswap v4 projects · Hook Radar");
});

test("the phone dock's narrower tabs belong to the edition only", () => {
  const css = read("src/design/shell.css");
  assert.match(
    css,
    /@media \(max-width: 60rem\) \{\s*:root\[data-edition="snapshot"\] \.topbar nav button \{\s*flex: 1 0 3\.5rem;/,
  );
  // The live rule keeps its width.
  assert.match(css, /\.topbar nav button \{\s*flex: 1 0 4\.25rem;/);
});

/* ── The page, rendered ────────────────────────────────────────────────── */

async function componentModule(path, replacements = {}) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  let output = ts.transpileModule(source, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  output = output.replace(/^import ["'][^"']+\.css["'];?\s*$/gm, "");
  for (const [specifier, target] of Object.entries({
    "lucide-react": import.meta.resolve("lucide-react"),
    react: import.meta.resolve("react"),
    "react/jsx-runtime": import.meta.resolve("react/jsx-runtime"),
    ...replacements,
  })) {
    output = output.replaceAll(JSON.stringify(specifier), JSON.stringify(target));
  }
  return `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`;
}

const href = (path) => new URL(path, import.meta.url).href;
const iconsModule = await componentModule("../src/components/Icons.tsx");
const primitivesModule = await componentModule("../src/components/Primitives.tsx", {
  "../model": href("../src/model.ts"),
  "./Icons": iconsModule,
});
const logoModule = await componentModule("../src/components/ProtocolLogo.tsx", {
  "../protocol-logos": href("../src/protocol-logos.ts"),
  "../fallback-mark": href("../src/fallback-mark.ts"),
});
const dailyAmountModule = await componentModule("../src/components/DailyAmount.tsx", {
  "../model": href("../src/model.ts"),
  "../daily": href("../src/daily.ts"),
  "../daily-view": href("../src/daily-view.ts"),
});
const pageModule = await componentModule("../src/components/ProjectsDirectory.tsx", {
  "../chains": href("../src/chains.ts"),
  "../model": href("../src/model.ts"),
  "../daily": href("../src/daily.ts"),
  "../daily-view": href("../src/daily-view.ts"),
  "../navigation": href("../src/navigation.ts"),
  "../projects-directory": href("../src/projects-directory.ts"),
  "./Icons": iconsModule,
  "./Primitives": primitivesModule,
  "./ProtocolLogo": logoModule,
  "./DailyAmount": dailyAmountModule,
});
const { ProjectsDirectory } = await import(pageModule);

const noop = () => {};
function page(snapshot, props = {}) {
  // The server marks the seams between text pieces with comments; a reader does
  // not see them.
  return renderToStaticMarkup(
    createElement(ProjectsDirectory, {
      snapshot,
      windowKey: "h24",
      now: NOW,
      network: "all",
      setNetwork: noop,
      search: "",
      setSearch: noop,
      use: "all",
      setUse: noop,
      sort: "volume",
      setSort: noop,
      clearFilters: noop,
      openProject: noop,
      browseHooks: noop,
      searchDiscover: noop,
      ...props,
    }),
  ).replaceAll("<!-- -->", "");
}
const text = (html) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;|&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
const cardOf = (html, id) => {
  const start = html.indexOf(`data-project-id="${id}"`);
  assert.ok(start >= 0, `a card for ${id}`);
  return html.slice(start, html.indexOf("</article>", start));
};

/** What the page draws for a snapshot: the chain model with the reviewed launch
 * platforms the page always adds, its listed rows and their order. */
function expected(snapshot, options = {}) {
  const result = buildChains(snapshot, {
    chain: "all",
    now: NOW,
    hookOverlap: true,
    ...options,
  });
  const names = new Map(result.networks.map((n) => [n.slug, n.name]));
  const rows = listProjects(result.protocols);
  return {
    result,
    names,
    rows,
    ordered: visibleProjects(rows, { query: "", use: "all", sort: "volume", names }),
  };
}
const cardIds = (html) =>
  [...html.matchAll(/data-project-id="([^"]+)"/g)].map((m) => m[1]);

test("every listed project has a card, in volume order, with a name that is one button", () => {
  const snapshot = listedSnapshot();
  const html = page(snapshot);
  const ids = cardIds(html);
  assert.deepEqual(ids, listedIds(expected(snapshot).ordered));
  // The project rows of the fixture come in volume order, the unmeasured last.
  const mine = ids.filter((id) =>
    ["alpha", "twin-a", "frontier", "clanker", "delta", "platform-x", "twin-b"].includes(id),
  );
  assert.deepEqual(mine.slice(0, 3), ["alpha", "twin-a", "frontier"]);
  assert.equal(mine.length, 7);
  // Excluded rows have no card.
  for (const id of ["beta", "gamma", "hook-clone", "twin-x"])
    assert.doesNotMatch(html, new RegExp(`data-project-id="${id}"`));
  const alpha = cardOf(html, "alpha");
  assert.equal(alpha.match(/<button/g).length, 1, "the name is the card's one button");
  assert.match(alpha, /<button[^>]*class="projects-card-name"[^>]*>Alpha Markets</);
  assert.match(html, /aria-label="Alpha Markets"[^>]*data-testid="projects-card"[^>]*data-project-id="alpha"/);
});

test("figures read ≥ for a sample, a dash for nothing and $0 for a measured zero; a card with nothing measured has the note and no readouts", () => {
  const html = page(listedSnapshot());
  const alpha = text(cardOf(html, "alpha"));
  assert.match(alpha, /Tracked 24H volume ≥\$100\.00 Pools in snapshot ≥3 Reported reserves ≥\$1\.0K/);
  const frontier = text(cardOf(html, "frontier"));
  assert.match(frontier, /Tracked 24H volume ≥\$0 /);
  assert.match(frontier, /Counts trades in its Uniswap v4 pools only/);
  const delta = cardOf(html, "delta");
  assert.match(text(delta), /Not measured in this snapshot/);
  assert.doesNotMatch(delta, /Tracked 24H volume/);
  assert.doesNotMatch(delta, /<dl/);
  // A network cut names the network in the note.
  const onBase = page(listedSnapshot(), { network: "base" });
  assert.match(text(cardOf(onBase, "delta")), /Not measured on Base in this snapshot/);
  // A dash is not a zero: a project with pools and no price in the window.
  const aged = listedSnapshot();
  aged.pools = aged.pools.map((p) => ({ ...p, metricUpdatedAt: iso(NOW - MARKET_MAX_AGE_MS - 1) }));
  const stale = text(cardOf(page(aged), "alpha"));
  assert.match(stale, /Tracked 24H volume — Pools in snapshot ≥\d+ Reported reserves —/);
});

test("a verified logo says official artwork; no artwork is the neutral mark and never called official", () => {
  const html = page(listedSnapshot());
  assert.match(cardOf(html, "clanker"), /Clanker · official artwork/);
  assert.match(cardOf(html, "clanker"), /data-protocol="Clanker"/);
  const neutral = cardOf(html, "delta");
  assert.match(neutral, /Delta Docs · no verified protocol logo/);
  assert.doesNotMatch(neutral, /official/i);
  assert.doesNotMatch(neutral, /data-protocol=/);
  assert.match(neutral, /protocol-logo-fallback/);
});

test("links open in a new window with no opener, carry the project in their name and are absent when the project has none", () => {
  const html = page(listedSnapshot());
  const alpha = cardOf(html, "alpha");
  assert.match(alpha, /<a class="external " href="https:\/\/alpha\.example\/" target="_blank" rel="noopener noreferrer">Website<span class="sr-only"> of Alpha Markets<\/span>/);
  assert.doesNotMatch(alpha, />Docs</);
  const clanker = cardOf(html, "clanker");
  assert.doesNotMatch(clanker, /<a /);
  const delta = cardOf(html, "delta");
  assert.match(delta, /Docs<span class="sr-only"> of Delta Docs/);
  assert.doesNotMatch(delta, />Website</);
});

test("the toolbar: a search, a use-case select with groups, a network select with counts and a sort", () => {
  const snapshot = listedSnapshot();
  const html = page(snapshot);
  const { rows, names } = expected(snapshot);
  const base = networkOptions(rows, names).find((o) => o.slug === "base");
  const networks = networkOptions(rows, names).length;
  assert.match(html, /aria-label="Search projects by name, use case or network"/);
  assert.match(html, /placeholder="Search projects"/);
  assert.match(html, new RegExp(`<option value="all"[^>]*>All use cases \\(${rows.length}\\)</option>`));
  assert.match(html, /<optgroup label="Reviewed roles">/);
  assert.match(html, /<optgroup label="Use cases">/);
  assert.match(html, new RegExp(`<option value="all"[^>]*>All networks \\(${rows.length}\\)</option>`));
  assert.match(html, new RegExp(`<option value="base">Base \\(${base.count}\\)</option>`));
  assert.match(html, /<option value="ethereum">Ethereum \(\d+\)<\/option>/);
  for (const label of ["Highest volume", "Highest reserves", "Most pools", "Name A–Z"])
    assert.match(html, new RegExp(`>${label}<`));
  // The meta line states counts; "Clear filters" is laid out and idle.
  assert.match(
    text(html),
    new RegExp(`${rows.length} projects on ${networks} networks · ${withTrackedPools(rows)} with tracked pools`),
  );
  assert.match(html, /data-testid="projects-clear"[^>]*data-idle="true"[^>]*aria-hidden="true"[^>]*tabindex="-1"/);
});

test("a filter shows its words and un-hides the clear control", () => {
  const snapshot = listedSnapshot();
  const { rows, names } = expected(snapshot, { chain: "base" });
  const everyone = expected(snapshot).rows.length;
  const html = page(snapshot, { use: "launchpads", network: "base", search: "x" });
  const shown = visibleProjects(rows, { query: "x", use: "launchpads", sort: "volume", names }).length;
  assert.match(text(html), new RegExp(`${shown} of ${everyone} projects · Launchpads · Base`));
  assert.doesNotMatch(html, /data-idle=/);
});

test("nothing that matches says so and offers a way out; a search can go on in Discover", () => {
  const html = page(listedSnapshot(), { search: "zzzz" });
  assert.match(text(html), /No project matches/);
  assert.match(text(html), /No listed project matches “zzzz”/);
  assert.match(text(html), /A hook with no named project behind it is in Discover/);
  assert.match(text(html), /Clear filters/);
  assert.match(text(html), /Search Discover for “zzzz”/);
  // Without a query there is no Discover offer.
  const filtered = page(listedSnapshot(), { use: "mev" });
  assert.match(text(filtered), /No project matches/);
  assert.doesNotMatch(text(filtered), /Search Discover for/);
  assert.match(text(filtered), /No listed project matches these filters/);
});

test("an unknown network is not found, with a way back; the page has Data notes and a way to Discover", () => {
  const snapshot = listedSnapshot();
  const html = page(snapshot, { network: "nowhere" });
  assert.match(text(html), /Network not found/);
  assert.match(text(html), /All networks/);
  assert.doesNotMatch(html, /data-testid="projects-card"/);
  const full = text(page(snapshot));
  const unlisted = unlistedCount(expected(snapshot).result.protocols);
  assert.match(full, /Looking for a single hook\? Browse every hook in Discover/);
  assert.match(full, /About these numbers/);
  assert.match(full, /A name alone never lists a project/);
  assert.match(
    full,
    /Registry listings and shared names do not establish common ownership or endorsement/,
  );
  assert.match(full, /It is not total Uniswap volume/);
  assert.match(full, /no project is placed first/);
  assert.match(
    full,
    new RegExp(`Hooks with no public project behind them \\(${unlisted} in this snapshot\\) are in Discover`),
  );
});

test("a list longer than the limit draws the limit and says to narrow it", () => {
  const snapshot = listedSnapshot();
  for (let i = 0; i < PROJECTS_RENDER_MAX + 5; i += 1)
    snapshot.projects.push(
      project(`bulk-${i}`, `Bulk ${String(i).padStart(3, "0")}`, 20 + (i % 9), "base", {
        website: `https://bulk-${i}.example`,
        deployments: [
          { ...deployment(20 + (i % 9), "base", `Bulk${i}Hook`), id: `base:bulk-${i}`, address: `0x${(i + 1).toString(16).padStart(40, "0")}` },
        ],
      }),
    );
  const html = page(snapshot);
  const total = expected(snapshot).rows.length;
  assert.ok(total > PROJECTS_RENDER_MAX);
  assert.equal(cardIds(html).length, PROJECTS_RENDER_MAX);
  assert.match(
    text(html),
    new RegExp(`Showing the first 150 of ${total} projects\\. Narrow the list with the search or a filter\\.`),
  );
});

test("the page's own words are plain: no clock, no age, no notice of what it is not, no claim of verification", () => {
  // Names and descriptions of projects are the registry's, so only the words
  // the page writes are read.
  const own = code("src/components/ProjectsDirectory.tsx");
  const logic = code("src/projects-directory.ts");
  for (const source of [own, logic])
    for (const word of [
      /\bright now\b/i,
      /\bago\b/i,
      /real-time/i,
      /not exhaustive/i,
      /prototype/i,
      /\bdemo\b/i,
      /decorative/i,
      /work in progress/i,
    ])
      assert.doesNotMatch(source, word);
  // No card or note says "verified", "official project" or "by".
  assert.doesNotMatch(own, /\bverified\b|official project|>\s*by\s/i);
  assert.doesNotMatch(
    JSON.stringify([...Object.values(sharedSentences())]),
    /verified|official/i,
  );
});

function sharedSentences() {
  return {
    one: sharedPoolNote({ sharedHookWith: ["A"] }, new Set(["A"])),
    rest: sharedPoolNote({ sharedHookWith: ["A", "B"] }, new Set(["A"])),
    unmeasured: unmeasuredNote("Base"),
  };
}

/* ── A real snapshot, when one is given ────────────────────────────────── */

const REAL = process.env.RADAR_TEST_DATA
  ? resolve(process.env.RADAR_TEST_DATA, "snapshot.json")
  : null;

test(
  "every project on a real snapshot has a name, a description, a network and a place of its own",
  { skip: REAL && existsSync(REAL) ? false : "RADAR_TEST_DATA is not set" },
  () => {
    const snapshot = JSON.parse(readFileSync(REAL, "utf8"));
    const result = buildChains(snapshot, {
      chain: "all",
      now: Date.parse(snapshot.generatedAt),
      hookOverlap: true,
    });
    const rows = listProjects(result.protocols);
    assert.ok(rows.length >= 30 && rows.length <= 150, `${rows.length} rows`);
    const ids = new Set();
    const shown = new Set();
    for (const row of rows) {
      const { project: p } = row;
      assert.ok(p.name.trim().length > 0, "a name");
      assert.ok(!/^(?:0x)?[0-9a-f]{12,}$/i.test(p.name.trim()), `${p.name} is not a hash`);
      assert.ok(p.description.trim().length >= 30, `${p.name}: description`);
      assert.ok(row.chainSlugs.length >= 1, `${p.name}: a network`);
      assert.ok(!ids.has(p.id), `${p.name}: one row per id`);
      ids.add(p.id);
      assert.ok(!shown.has(p.name), `${p.name}: one row per name`);
      shown.add(p.name);
      assert.ok(projectRoles(row).length >= 1, `${p.name}: a use case`);
    }
    // The rule keeps most named rows out: the list is the few with an identity.
    assert.ok(unlistedCount(result.protocols) > rows.length);
  },
);
