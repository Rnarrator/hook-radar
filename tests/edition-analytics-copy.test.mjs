// The Auto Snapshot edition's Analytics and coverage wording, and the census
// date in the analytics CSV. The components are compiled from source, once as
// the edition (VITE_STATIC_EDITION=1) and once as the live build (flag unset),
// and rendered to markup, so these tests read the strings a visitor reads and
// also prove the live strings did not change. Plain fixtures; nothing here is
// real market data and nothing is written anywhere.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { analyticsCsv, buildAnalytics } from "../src/analytics.ts";

// A visitor 14 hours ahead of UTC: any time formatted in the visitor's zone
// would show the next day, so a local time in the markup is a failure.
process.env.TZ = "Pacific/Kiritimati";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dataDir = resolve(root, "tests/fixtures/static-data/data");
const readJson = (name) =>
  JSON.parse(readFileSync(resolve(dataDir, name), "utf8"));
const snapshot = readJson("snapshot.json");
const envelope = readJson("overview-all-h24.json");
const generated = Date.parse(snapshot.generatedAt);
const CENSUS_AT = snapshot.inventory.generatedAt;

/* ── CSV ──────────────────────────────────────────────────────────────── */

const LIVE_HEADER = [
  "row_type",
  "scope",
  "window",
  "as_of",
  "snapshot_at",
  "id",
  "name",
  "network",
  "observed_volume_usd",
  "observed_liquidity_usd",
  "share_of_observed_volume",
  "sample_pools",
  "current_volume_pools",
  "current_liquidity_pools",
  "positive_volume_pools",
  "attributed_hook_families",
  "unattributed_current_pools",
  "unattributed_observed_volume_usd",
  "indexed_hook_pools",
  "indexed_hook_contracts",
  "caught_up",
  "head_fresh",
  "volume_oldest_observation_at",
  "volume_latest_observation_at",
  "liquidity_oldest_observation_at",
  "liquidity_latest_observation_at",
];
// head_check_at_census says how the census's head check ended: head_checked_at
// is only the last check that passed (a failed check does not set it), so a
// network whose check failed (Celo) must not read as checked on its own.
const EDITION_HEADER = [
  ...LIVE_HEADER.slice(0, 20),
  "census_as_of",
  "scanned_to_target",
  "head_checked_at",
  "head_check_at_census",
  ...LIVE_HEADER.slice(22),
];

/** Rows of cells; every cell is quoted, a quote inside is doubled. */
function parseCsv(text) {
  assert.ok(text.startsWith("﻿"), "starts with a byte-order mark");
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const body = text.slice(1);
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quoted) {
      if (c === '"' && body[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\r") {
      // the newline that follows is the row end
    } else if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  assert.equal(row.length + cell.length, 0, "ends with a newline");
  return rows;
}
const report = (shot = snapshot, chain = "all", windowKey = "h24") =>
  buildAnalytics(shot, { chain, windowKey, now: generated });
const columns = (rows, names) => {
  const head = rows[0];
  return rows.slice(1).map((row) => names.map((n) => row[head.indexOf(n)]));
};
const rowsOf = (rows, type) => rows.slice(1).filter((row) => row[0] === type);

test("without the edition option the export is exactly the live one", () => {
  for (const options of [
    undefined,
    {},
    { edition: false },
    { censusAsOf: CENSUS_AT },
  ]) {
    const rows = parseCsv(
      options === undefined
        ? analyticsCsv(report())
        : analyticsCsv(report(), options),
    );
    assert.deepEqual(rows[0], LIVE_HEADER, JSON.stringify(options));
    assert.ok(rows.every((row) => row.length === LIVE_HEADER.length));
  }
  const rows = parseCsv(analyticsCsv(report()));
  const [summary] = rowsOf(rows, "summary");
  const idx = (name) => LIVE_HEADER.indexOf(name);
  assert.equal(summary[idx("indexed_hook_pools")], "93");
  assert.equal(summary[idx("caught_up")], "", "no flag on the summary row");
  const bases = rowsOf(rows, "network").filter(
    (row) => row[idx("id")] === "base",
  );
  assert.equal(bases.length, 1);
  assert.equal(bases[0][idx("caught_up")], "true");
  // The snapshot is 14 hours after the chain head was checked: the live flag
  // says so, and it is the live export that keeps saying it.
  assert.equal(bases[0][idx("head_fresh")], "false");
  assert.ok(!rows[0].includes("census_as_of"));
});

test("the edition export dates every row that carries census counts", () => {
  const rows = parseCsv(
    analyticsCsv(report(), { edition: true, censusAsOf: CENSUS_AT }),
  );
  assert.deepEqual(rows[0], EDITION_HEADER);
  assert.ok(rows.every((row) => row.length === EDITION_HEADER.length));
  for (const gone of ["caught_up", "head_fresh"])
    assert.ok(!rows[0].includes(gone), gone);
  const idx = (name) => EDITION_HEADER.indexOf(name);

  // The date is written as published, not re-formatted or shifted.
  const [summary] = rowsOf(rows, "summary");
  assert.equal(summary[idx("indexed_hook_pools")], "93");
  assert.equal(summary[idx("indexed_hook_contracts")], "31");
  assert.equal(summary[idx("census_as_of")], CENSUS_AT);
  assert.equal(summary[idx("scanned_to_target")], "");
  assert.equal(summary[idx("head_checked_at")], "");
  assert.equal(summary[idx("head_check_at_census")], "");

  const networks = rowsOf(rows, "network");
  assert.ok(networks.length >= 3);
  for (const row of networks) {
    const inventory = snapshot.inventory.networks.find(
      (n) => n.chain === row[idx("id")],
    );
    if (!inventory) continue;
    assert.equal(
      row[idx("indexed_hook_pools")],
      String(inventory.hookPoolCount),
    );
    assert.equal(row[idx("census_as_of")], CENSUS_AT, row[idx("id")]);
    assert.equal(row[idx("scanned_to_target")], "true");
    // The head's own check time, as recorded; never compared with a clock.
    assert.equal(row[idx("head_checked_at")], inventory.headCheckedAt);
    // A complete scan with a head check on record: that check passed.
    assert.equal(row[idx("head_check_at_census")], "passed", row[idx("id")]);
  }

  // Rows with no census counts carry no census date either.
  for (const row of [...rowsOf(rows, "project"), ...rowsOf(rows, "pool")])
    for (const name of [
      "indexed_hook_pools",
      "indexed_hook_contracts",
      "census_as_of",
      "scanned_to_target",
      "head_checked_at",
      "head_check_at_census",
    ])
      assert.equal(row[idx(name)], "", `${row[0]} ${name}`);
  assert.ok(
    rowsOf(rows, "project").length > 0 && rowsOf(rows, "pool").length > 0,
  );
});

test("apart from the census columns the edition export is the live export", () => {
  const live = parseCsv(analyticsCsv(report()));
  const edition = parseCsv(
    analyticsCsv(report(), { edition: true, censusAsOf: CENSUS_AT }),
  );
  assert.deepEqual(edition[0], EDITION_HEADER);
  assert.equal(edition.length, live.length);
  const shared = LIVE_HEADER.filter(
    (name) => !["caught_up", "head_fresh"].includes(name),
  );
  assert.deepEqual(
    columns(edition, shared),
    columns(live, shared),
    "every other column keeps its value",
  );
});

test("a network the census does not list, or a snapshot with no census, gets no census date", () => {
  const without = structuredClone(snapshot);
  without.inventory.networks = without.inventory.networks.filter(
    (n) => n.chain !== "robinhood",
  );
  const rows = parseCsv(
    analyticsCsv(report(without), { edition: true, censusAsOf: CENSUS_AT }),
  );
  assert.deepEqual(rows[0], EDITION_HEADER);
  const idx = (name) => EDITION_HEADER.indexOf(name);
  const robinhood = rowsOf(rows, "network").find(
    (row) => row[idx("id")] === "robinhood",
  );
  assert.ok(robinhood, "the network still has its measured row");
  for (const name of [
    "indexed_hook_pools",
    "indexed_hook_contracts",
    "census_as_of",
    "scanned_to_target",
    "head_checked_at",
    "head_check_at_census",
  ])
    assert.equal(robinhood[idx(name)], "", name);

  const bare = structuredClone(snapshot);
  delete bare.inventory;
  const bareRows = parseCsv(
    analyticsCsv(report(bare), { edition: true, censusAsOf: CENSUS_AT }),
  );
  assert.deepEqual(bareRows[0], EDITION_HEADER);
  const [summary] = rowsOf(bareRows, "summary");
  for (const name of [
    "indexed_hook_pools",
    "indexed_hook_contracts",
    "census_as_of",
  ])
    assert.equal(summary[idx(name)], "", name);
});

/* ── Components ───────────────────────────────────────────────────────── */

const flavours = {};
const projectRequire = createRequire(resolve(root, "package.json"));

/** The components, compiled from source the way the build reads them, once with
 * the edition flag on and once with it unset. Source files are transpiled one by
 * one (TypeScript only) and wired with a small CommonJS loader; stylesheets are
 * empty; packages come from node_modules.
 *
 * `patches` ({ "src/...": [[from, to]] }) rewrites a line of a source file
 * before it is compiled. It is how a state that only a click or a keystroke
 * reaches (an expanded list, a search with no match) is rendered to markup
 * without a browser: it sets that state's initial value. A patch that matches
 * nothing throws, so a renamed line cannot quietly turn it into a no-op. */
function loadFlavour(edition, patches = {}) {
  const flag = edition ? '"1"' : "undefined";
  const cache = new Map();
  const applied = new Set();
  const local = (from, specifier) => {
    const base = resolve(dirname(from), specifier);
    for (const candidate of [
      base,
      base + ".ts",
      base + ".tsx",
      join(base, "index.ts"),
      join(base, "index.tsx"),
    ])
      if (existsSync(candidate) && statSync(candidate).isFile())
        return candidate;
    throw new Error("cannot resolve " + specifier + " from " + from);
  };
  function load(file) {
    const cached = cache.get(file);
    if (cached) return cached.exports;
    const module = { exports: {} };
    cache.set(file, module);
    let source = readFileSync(file, "utf8")
      .replaceAll("import.meta.env.VITE_STATIC_EDITION", flag)
      .replaceAll("import.meta.env.BASE_URL", '"/"');
    const relative = file.slice(root.length + 1).replaceAll("\\", "/");
    for (const [from, to] of patches[relative] ?? []) {
      assert.ok(
        source.includes(from),
        relative + " no longer contains " + from,
      );
      source = source.replace(from, () => to);
      applied.add(relative);
    }
    const { outputText } = ts.transpileModule(source, {
      fileName: file,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
    });
    const requireFrom = (specifier) =>
      specifier.startsWith(".")
        ? specifier.endsWith(".css")
          ? {}
          : load(local(file, specifier))
        : projectRequire(specifier);
    new Function("exports", "require", "module", outputText)(
      module.exports,
      requireFrom,
      module,
    );
    return module.exports;
  }
  const at = (path) => load(resolve(root, path));
  const loaded = {
    createElement: projectRequire("react").createElement,
    renderToStaticMarkup:
      projectRequire("react-dom/server").renderToStaticMarkup,
    freezeEvaluationClock: at("src/edition.ts").freezeEvaluationClock,
    MarketCoverage: at("src/components/MarketCoverage.tsx").MarketCoverage,
    AnalyticsEvidence: at("src/components/AnalyticsCharts.tsx")
      .AnalyticsEvidence,
    AnalyticsOverview: at("src/components/AnalyticsOverview.tsx")
      .AnalyticsOverview,
    AnalyticsWorkspace: at("src/components/AnalyticsWorkspace.tsx")
      .AnalyticsWorkspace,
    AnalyticsHistory: at("src/components/AnalyticsHistory.tsx")
      .AnalyticsHistory,
  };
  for (const file of Object.keys(patches))
    assert.ok(
      applied.has(file),
      file + " was never loaded, so its patch did nothing",
    );
  // The edition judges freshness at the snapshot's own time.
  loaded.freezeEvaluationClock(snapshot.generatedAt);
  return loaded;
}

// States that only a click or a keystroke reaches, set as initial values: the
// project ranking expanded to its top 30, and a project search with no match.
const WORKSPACE = "src/components/AnalyticsWorkspace.tsx";
const EXPANDED = {
  [WORKSPACE]: [
    [
      "const [allProjects, setAllProjects] = useState(false);",
      "const [allProjects, setAllProjects] = useState(true);",
    ],
  ],
};
const RESERVES = {
  [WORKSPACE]: [
    [
      'const [metric, setMetricState] = useState<AnalyticsMetric>("volume");',
      'const [metric, setMetricState] = useState<AnalyticsMetric>("reserves");',
    ],
  ],
};
const SEARCHED = {
  [WORKSPACE]: [
    [
      'const [projectQuery, setProjectQuery] = useState("");',
      'const [projectQuery, setProjectQuery] = useState("no-such-project");',
    ],
  ],
};

before(() => {
  flavours.edition = loadFlavour(true);
  flavours.live = loadFlavour(false);
  flavours.editionExpanded = loadFlavour(true, EXPANDED);
  flavours.liveExpanded = loadFlavour(false, EXPANDED);
  flavours.editionReserves = loadFlavour(true, RESERVES);
  flavours.editionSearched = loadFlavour(true, SEARCHED);
  flavours.liveSearched = loadFlavour(false, SEARCHED);
});

const decode = (html) =>
  html
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"');
const plain = (html) =>
  decode(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
const noop = () => {};

function render(flavour, name, props) {
  const m = flavours[flavour];
  const html = m.renderToStaticMarkup(m.createElement(m[name], props));
  return { html: decode(html), text: plain(html) };
}
const WORKSPACE_PROPS = {
  snapshot,
  windowKey: "h24",
  now: generated,
  chain: "all",
  range: "all",
  setChain: noop,
  setRange: noop,
  openProject: noop,
  browseHooks: noop,
  openSources: noop,
};
const workspace = (flavour, props = {}) =>
  render(flavour, "AnalyticsWorkspace", { ...WORKSPACE_PROPS, ...props });

const coverageRow = (chain, chainId, row) => ({
  chain,
  chainId,
  inventoryPools: 1000,
  checkedPools: 0,
  measuredPools: 0,
  pendingPools: 1000,
  missingPools: 0,
  attemptedPools: 0,
  status: "unavailable",
  ...row,
});
/** The three cases the page must tell apart, as the collector can publish them. */
function coverageSnapshot() {
  const shot = structuredClone(snapshot);
  shot.chains = [
    { ...shot.chains[0], id: 56, slug: "bnb", name: "BNB Chain" },
    { ...shot.chains[0], id: 130, slug: "unichain", name: "Unichain" },
    { ...shot.chains[0], id: 7777777, slug: "zora", name: "Zora" },
    ...shot.chains,
  ];
  shot.marketCoverage = {
    cacheWarning: null,
    networks: [
      // Asked, answered, nothing priced (the source did respond).
      coverageRow("bnb", 56, {
        checkedPools: 34,
        pendingPools: 966,
        missingPools: 34,
        attemptedPools: 34,
      }),
      // Never asked.
      coverageRow("unichain", 130),
      // Asked, no answer at all.
      coverageRow("zora", 7777777, { attemptedPools: 11 }),
    ],
  };
  return shot;
}
const EDITION_QUEUE_WORDS =
  /Checks remaining|awaiting|still being added|Waiting for first check|\bdiscovered\b|not yet checked|\bwill populate\b|Awaiting|progressbar|First expiry|\bexpir/;
// A pool with no check result was not asked about OR asked without an answer
// ("checked" means a source responded), so no label may say it was outside the
// list of pools asked about.
const CHECK_LIST_CLAIM = /check list/i;

test("pricing coverage in the edition: a finished pass over a dated census", () => {
  const { html, text } = render("edition", "MarketCoverage", {
    snapshot: coverageSnapshot(),
  });
  assert.doesNotMatch(text, EDITION_QUEUE_WORDS);
  assert.doesNotMatch(text, CHECK_LIST_CLAIM);
  assert.doesNotMatch(html, /role="progressbar"/);
  assert.match(
    html,
    /role="img" aria-label="Hook pools in the census by check result: 0 with market observations, 34 checked without usable data, 2,966 not checked in this snapshot"/,
  );
  // The population is dated, and the three cases read differently.
  assert.match(
    text,
    /34 of 3,000 hook pools checked · census as of 27 Oct 2026/,
  );
  assert.doesNotMatch(text, /\d%/, "no percent of the census as progress");
  assert.match(text, /Not checked in this snapshot 2,966/);
  assert.match(text, /BNB Chain Source responded/);
  assert.match(text, /Unichain Not checked in this snapshot/);
  // Asked with no result is not a source that failed to respond: the snapshot
  // cannot tell a network the source does not index from one it did not answer.
  assert.match(text, /Zora No pricing results for this network/);
  assert.doesNotMatch(text, /did not respond/);
  assert.doesNotMatch(text, /Source unavailable|Source responding/);
  assert.match(
    text,
    /34 checked pools have no usable market data in this snapshot\./,
  );
  assert.match(
    text,
    /Pools without a check result were either not asked about or asked without a response\./,
  );
  // Only BNB Chain had a source respond; Zora was asked and Unichain was not.
  assert.match(text, /Checks were made on 1 of 3 networks\./);
  // The census lists three networks that have no pricing row here, so the
  // count above is not the census's own total.
  assert.match(
    text,
    /The census also lists 3 networks \(93 hook pools\) with no pricing check\./,
  );
});

test("pools that were asked and never answered are not called unasked", () => {
  // Zora: 11 hook pools in the census, all 11 asked (attemptedPools), no source
  // responded (checkedPools 0), so all 11 are pending in the collector's own
  // arithmetic (inventory minus checked). They are not "outside the list".
  const shot = coverageSnapshot();
  const zora = shot.marketCoverage.networks.find((row) => row.chain === "zora");
  zora.inventoryPools = 11;
  zora.pendingPools = 11;
  assert.equal(zora.attemptedPools, 11);
  assert.equal(zora.checkedPools, 0);
  const card = render("edition", "MarketCoverage", { snapshot: shot }).text;
  assert.match(
    card,
    /Zora No pricing results for this network Checked 0 of 11 .*?Not checked in this snapshot 11/,
  );
  assert.doesNotMatch(card, CHECK_LIST_CLAIM);
  // Selected on its own, the totals say the same.
  const only = render("edition", "MarketCoverage", {
    snapshot: shot,
    initialNetwork: "zora",
  }).text;
  assert.match(only, /0 of 11 hook pools checked · census as of 27 Oct 2026/);
  assert.match(only, /Not checked in this snapshot 11/);
  assert.doesNotMatch(only, CHECK_LIST_CLAIM);
  // The same wording reaches the Analytics page for that network, in the
  // totals and in the evidence block.
  const page = workspace("edition", { snapshot: shot, chain: "zora" }).text;
  assert.match(page, /0 of 11 hook pools checked/);
  assert.match(page, /Not checked in this snapshot 11 100% of the census/);
  assert.doesNotMatch(page, CHECK_LIST_CLAIM);
  // And the dot for that row reads from the counts, not from "not asked".
  assert.match(
    render("edition", "MarketCoverage", { snapshot: shot }).html,
    /data-state="unavailable">No pricing results for this network</,
  );
});

test("the dots follow what the row says, not the stored status", () => {
  const { html } = render("edition", "MarketCoverage", {
    snapshot: coverageSnapshot(),
  });
  const state = (label) =>
    new RegExp(`data-state="(\\w+)">${label}<`).exec(html)?.[1];
  assert.equal(
    state("Source responded"),
    "live",
    "BNB was stored as unavailable",
  );
  assert.equal(state("Not checked in this snapshot"), "empty");
  assert.equal(state("No pricing results for this network"), "unavailable");
});

test("when every network was asked there is no network-count note", () => {
  const { text } = render("edition", "MarketCoverage", { snapshot });
  assert.doesNotMatch(text, /Checks were made on|census also lists/);
  assert.match(text, /12 of 93 hook pools checked · census as of 27 Oct 2026/);
  const one = structuredClone(snapshot);
  one.marketCoverage.networks = one.marketCoverage.networks.filter(
    (row) => row.chain !== "robinhood",
  );
  assert.match(
    render("edition", "MarketCoverage", { snapshot: one }).text,
    /The census also lists 1 network \(4 hook pools\) with no pricing check\./,
  );
  assert.doesNotMatch(
    render("edition", "MarketCoverage", {
      snapshot: one,
      initialNetwork: "base",
    }).text,
    /census also lists/,
    "a single network's view is not about the others",
  );
});

test("a snapshot with no census date still states the check list without a date", () => {
  const bare = structuredClone(snapshot);
  delete bare.inventory;
  const { text } = render("edition", "MarketCoverage", { snapshot: bare });
  assert.match(text, /12 of 93 hook pools checked(?! ·)/);
  assert.doesNotMatch(text, /null|undefined/);
});

test("a snapshot with no pricing rows says so without promising checks", () => {
  const nothing = structuredClone(snapshot);
  nothing.marketCoverage.networks = [];
  const { text } = render("edition", "MarketCoverage", { snapshot: nothing });
  assert.match(text, /No hook pools in the census to check\./);
  assert.doesNotMatch(text, /begin once|discovered onchain/);
});

test("pricing coverage in the live build is unchanged", () => {
  const { html, text } = render("live", "MarketCoverage", {
    snapshot: coverageSnapshot(),
  });
  assert.match(html, /role="progressbar"/);
  assert.match(text, /Among discovered hook pools/);
  assert.match(text, /34 of 3,000 hook pools checked 1.1%/);
  assert.match(text, /Checks remaining 2,966/);
  assert.match(text, /BNB Chain Source unavailable/);
  assert.match(text, /Unichain Waiting for first check/);
  assert.match(text, /Zora Source unavailable/);
  assert.match(text, /Remaining checks are awaiting a successful response\./);
  assert.match(text, /34 checked pools have no usable market data yet\./);
  assert.doesNotMatch(
    text,
    /census as of|Source responded|Source did not respond|in this snapshot|check list|Not checked/,
  );
  const grown = structuredClone(snapshot);
  grown.inventory.hookPoolCount = 50;
  assert.match(
    render("live", "MarketCoverage", { snapshot: grown }).text,
    /Pricing checks include new pools still being added to search\./,
  );
  const nothing = structuredClone(snapshot);
  nothing.marketCoverage.networks = [];
  assert.match(
    render("live", "MarketCoverage", { snapshot: nothing }).text,
    /Pricing checks begin once hook pools are discovered onchain\./,
  );
});

test("the checks block of the evidence section says what the edition did", () => {
  const props = {
    windowKey: "h24",
    metric: "volume",
    now: generated,
    samplePools: 12,
    freshness: envelope.totals.freshness,
    publishedAt: snapshot.generatedAt,
    evaluatedAt: snapshot.generatedAt,
    inventory: null,
    pricing: {
      indexed: 3000,
      checked: 34,
      measured: 0,
      missing: 34,
      pending: 2966,
      census: "census as of 27 Oct 2026",
      networks: 3,
      checkedNetworks: 2,
      unlistedNetworks: 5,
      unlistedPools: 482,
    },
    sourceCount: 4,
    openSources: noop,
    scopeLabel: "All networks",
  };
  const { text } = render("edition", "AnalyticsEvidence", props);
  assert.doesNotMatch(text, EDITION_QUEUE_WORDS);
  assert.match(
    text,
    /34 of 3,000 hook pools checked · census as of 27 Oct 2026/,
  );
  assert.doesNotMatch(text, CHECK_LIST_CLAIM);
  assert.match(text, /Not checked in this snapshot 2,966 98\.9% of the census/);
  assert.match(text, /Checks were made on 2 of 3 networks\./);
  assert.match(
    text,
    /The census also lists 5 networks \(482 hook pools\) with no pricing check\./,
  );
  assert.match(text, /No value reported not priced in this snapshot/);
  assert.doesNotMatch(text, /not yet checked|First expiry/);
  // The clocks that stay are the ones a snapshot can honestly give.
  assert.match(text, /Oldest contributing 14:00:05 UTC/);
  assert.match(text, /Newest contributing 14:04:55 UTC/);
  assert.match(text, /Published 14:05:00 UTC/);

  const unreconciled = render("edition", "AnalyticsEvidence", {
    ...props,
    pricing: { ...props.pricing, pending: 5 },
  }).text;
  assert.match(
    unreconciled,
    /5 not checked in this snapshot\. These counts do not add up to the census/,
  );
  assert.doesNotMatch(unreconciled, EDITION_QUEUE_WORDS);
  assert.doesNotMatch(unreconciled, CHECK_LIST_CLAIM);

  const live = render("live", "AnalyticsEvidence", {
    ...props,
    pricing: {
      ...props.pricing,
      census: undefined,
      networks: undefined,
      checkedNetworks: undefined,
    },
  }).text;
  assert.match(live, /34 of 3,000 discovered hook pools checked(?! ·)/);
  assert.match(live, /Checks remaining 2,966 98\.9% of discovered/);
  assert.match(live, /No value reported not priced or not yet checked/);
  assert.match(live, /First expiry/);
  assert.doesNotMatch(live, /census|Checks were made on/);
  assert.doesNotMatch(
    render("live", "AnalyticsEvidence", { ...props }).text,
    /census also lists/,
  );
  const liveOff = render("live", "AnalyticsEvidence", {
    ...props,
    pricing: { ...props.pricing, pending: 5 },
  }).text;
  assert.match(
    liveOff,
    /5 checks remaining\. These counts include pools still being added to search/,
  );
});

test("the full workspace reads as a snapshot and counts what it counts", () => {
  const { text } = workspace("edition");
  assert.doesNotMatch(text, EDITION_QUEUE_WORDS);
  assert.doesNotMatch(text, /\bactivity\b/i);
  assert.match(text, /Measured projects & unnamed hooks 4/);
  assert.match(text, /4 projects and unnamed hooks with current measurements/);
  assert.doesNotMatch(text, /Measured projects & hooks|\d hooks with current/);
  assert.match(text, /Select a point or row to open its project or source\./);
  assert.match(text, /No value reported not priced in this snapshot/);
  assert.match(text, /12 of 93 hook pools checked · census as of 27 Oct 2026/);
  assert.doesNotMatch(text, CHECK_LIST_CLAIM);
  assert.match(text, /Not checked in this snapshot 81/);
});

test("the full workspace names census networks that have no pricing row", () => {
  const gap = structuredClone(snapshot);
  gap.marketCoverage.networks = gap.marketCoverage.networks.filter(
    (row) => row.chain !== "robinhood",
  );
  const all = workspace("edition", { snapshot: gap }).text;
  assert.match(all, /11 of 89 hook pools checked · census as of 27 Oct 2026/);
  assert.match(
    all,
    /The census also lists 1 network \(4 hook pools\) with no pricing check\./,
  );
  assert.doesNotMatch(
    workspace("edition", { snapshot: gap, chain: "base" }).text,
    /census also lists/,
  );
  assert.doesNotMatch(
    workspace("edition").text,
    /census also lists/,
    "nothing to reconcile when every census network has a row",
  );
  assert.doesNotMatch(
    workspace("live", { snapshot: gap }).text,
    /census also lists/,
  );
});

test("the full workspace says on how many networks a source responded when it did not on all", () => {
  const unasked = structuredClone(snapshot);
  const row = unasked.marketCoverage.networks.find(
    (network) => network.chain === "robinhood",
  );
  Object.assign(row, {
    checkedPools: 0,
    measuredPools: 0,
    missingPools: 0,
    pendingPools: row.inventoryPools,
    attemptedPools: 0,
    status: "unavailable",
  });
  assert.match(
    workspace("edition", { snapshot: unasked }).text,
    /Checks were made on 2 of 3 networks\./,
  );
  assert.doesNotMatch(
    workspace("edition").text,
    /Checks were made on/,
    "every network was asked",
  );
  assert.doesNotMatch(
    workspace("edition", { snapshot: unasked, chain: "base" }).text,
    /Checks were made on/,
    "one network's view is not about the others",
  );
  assert.doesNotMatch(
    workspace("live", { snapshot: unasked }).text,
    /Checks were made on/,
  );
});

test("the full workspace in the live build is unchanged", () => {
  const { text } = workspace("live");
  assert.match(text, /Measured projects & hooks 4/);
  assert.match(text, /4 hooks with current measurements/);
  assert.match(
    text,
    /Select a point or row to open its project, activity or source\./,
  );
  assert.match(text, /No value reported not priced or not yet checked/);
  assert.match(text, /12 of 93 discovered hook pools checked/);
  assert.match(text, /Checks remaining 81/);
  assert.match(text, /First expiry/);
});

/** The snapshot with 'count' more projects, each with one current pool. */
function withManyProjects(count) {
  const shot = structuredClone(snapshot);
  const project = shot.projects.find((row) => row.id === "alpha");
  const pool = shot.pools.find((row) => row.projectId === "alpha");
  for (let i = 0; i < count; i++) {
    const id = "extra-" + i;
    shot.projects.push({
      ...structuredClone(project),
      id,
      name: "Extra " + String(i).padStart(2, "0"),
    });
    shot.pools.push({
      ...structuredClone(pool),
      id: "base:" + id,
      // Distinct from every fixture pool: a repeated address is one pool.
      address: "0x" + "e".repeat(40) + String(i).padStart(24, "0"),
      projectId: id,
    });
  }
  return shot;
}

test("the ranking's long-list note counts projects and unnamed hooks in the edition, hooks in the live build", () => {
  const shot = withManyProjects(36);
  // 4 projects of the fixture have current pools, plus the 36 added.
  const edition = render("editionExpanded", "AnalyticsWorkspace", {
    ...WORKSPACE_PROPS,
    snapshot: shot,
  }).text;
  assert.match(edition, /Measured projects & unnamed hooks 40/);
  assert.match(edition, /Show fewer hooks/, "the list is expanded");
  assert.match(
    edition,
    /Showing the top 30 of 40 projects and unnamed hooks with current measurements\./,
  );
  assert.doesNotMatch(edition, /top 30 of 40 hooks/);
  const live = render("liveExpanded", "AnalyticsWorkspace", {
    ...WORKSPACE_PROPS,
    snapshot: shot,
  }).text;
  assert.match(live, /Show fewer hooks/, "the list is expanded");
  assert.match(
    live,
    /Showing the top 30 of 40 hooks with current measurements\./,
  );
  assert.doesNotMatch(live, /unnamed/);
  // Collapsed, the note is not shown in either build.
  assert.doesNotMatch(
    workspace("edition", { snapshot: shot }).text,
    /Showing the top 30/,
  );
});

test("a project search with no match says what the ranking includes, per build", () => {
  const edition = render(
    "editionSearched",
    "AnalyticsWorkspace",
    WORKSPACE_PROPS,
  ).text;
  assert.match(edition, /No matching hooks/);
  assert.match(
    edition,
    /Try a project name, use case or network\. Rankings include projects and unnamed hooks with current measurements\./,
  );
  assert.match(edition, /Clear search/);
  const live = render(
    "liveSearched",
    "AnalyticsWorkspace",
    WORKSPACE_PROPS,
  ).text;
  assert.match(live, /No matching hooks/);
  assert.match(
    live,
    /Try a project name, use case or network\. Rankings include hooks with current measurements\./,
  );
  assert.doesNotMatch(live, /unnamed/);
});

test("a network the snapshot does not carry, and empty breakdowns", () => {
  const edition = workspace("edition", { chain: "zksync" }).text;
  assert.match(edition, /This network is not in this snapshot\./);
  assert.doesNotMatch(edition, /current directory/);
  // The scope is named: the snapshot as a whole is not said to be empty.
  assert.match(
    edition,
    /No pool in zksync has a trading volume measurement taken within five minutes of the snapshot\. Missing values are never shown as zero\./,
  );
  assert.match(edition, /No measurements for zksync in this snapshot/);
  assert.match(
    edition,
    /No pool in zksync has a current measurement to split by use case\./,
  );
  assert.match(
    edition,
    /no pool in zksync was measured within five minutes of the snapshot\./,
  );
  assert.doesNotMatch(edition, SNAPSHOT_WIDE_EMPTY);
  assert.match(edition, /No pool inventory for this scope in the census/);
  assert.doesNotMatch(
    edition,
    /Awaiting measurements|will populate|Network values appear|bars appear when|inventory is not available yet/,
  );

  const live = workspace("live", { chain: "zksync" }).text;
  assert.match(live, /This network is not in the current directory\./);
  assert.match(live, /Awaiting measurements/);
  assert.match(live, /Fresh pool measurements will populate this breakdown\./);
  assert.match(
    live,
    /Network values appear when sources report fresh trading volume within the five-minute window\. Missing values are never shown as zero\./,
  );
  assert.match(
    live,
    /bars appear when sources report measurements within five minutes\./,
  );
  assert.match(live, /Pool inventory is not available yet/);
});

/** The three sentences (and the small line) that say a scope has nothing
 * measured, as a snapshot-wide claim. */
const SNAPSHOT_WIDE_EMPTY =
  /No pool in this snapshot|no pool in this snapshot|No measurements in this snapshot|No current market data in this snapshot/;

test("a network with nothing measured does not say the whole snapshot has nothing", () => {
  // The snapshot holds measurements for Base and Ethereum; BNB Chain is one of
  // its networks, with no pool measured. 16 of the 23 networks of the real
  // snapshot are in this position.
  const shot = coverageSnapshot();
  const all = workspace("edition", { snapshot: shot }).text;
  assert.match(all, /Trading volume · 24H \$3\.7K/, "the snapshot has data");
  assert.doesNotMatch(all, SNAPSHOT_WIDE_EMPTY);
  const bnb = workspace("edition", { snapshot: shot, chain: "bnb" }).text;
  assert.match(bnb, /BNB Chain/);
  assert.doesNotMatch(bnb, /This network is not in this snapshot/);
  assert.match(
    bnb,
    /No pool in BNB Chain has a trading volume measurement taken within five minutes of the snapshot\. Missing values are never shown as zero\./,
  );
  assert.match(
    bnb,
    /No current tracked 24h hook-pool volume in BNB Chain: no pool in BNB Chain was measured within five minutes of the snapshot\./,
  );
  assert.match(bnb, /No measurements for BNB Chain in this snapshot/);
  assert.match(
    bnb,
    /No pool in BNB Chain has a current measurement to split by use case\./,
  );
  assert.doesNotMatch(bnb, SNAPSHOT_WIDE_EMPTY);
  assert.match(bnb, /No current market data for BNB Chain in this snapshot/);
  assert.doesNotMatch(bnb, /Awaiting measurements|will populate/);
  // The reserves ranking names the scope the same way.
  const reserves = render("editionReserves", "AnalyticsWorkspace", {
    ...WORKSPACE_PROPS,
    snapshot: shot,
    chain: "bnb",
  }).text;
  assert.match(
    reserves,
    /No pool in BNB Chain has a reserve measurement taken within five minutes of the snapshot\./,
  );
  assert.match(
    reserves,
    /No current tracked pool reserves in BNB Chain: no pool in BNB Chain was measured within five minutes of the snapshot\./,
  );
  assert.doesNotMatch(reserves, SNAPSHOT_WIDE_EMPTY);
});

test("with nothing measured anywhere the empty states speak of the snapshot", () => {
  const bare = structuredClone(snapshot);
  bare.pools = [];
  const edition = workspace("edition", { snapshot: bare }).text;
  assert.match(
    edition,
    /No pool in this snapshot has a trading volume measurement taken within five minutes of it\. Missing values are never shown as zero\./,
  );
  assert.match(edition, /No measurements in this snapshot/);
  assert.match(edition, /No current market data in this snapshot/);
  assert.match(
    edition,
    /No pool in this snapshot has a current measurement to split by use case\./,
  );
  assert.match(
    edition,
    /No current tracked 24h hook-pool volume in all networks: no pool in this snapshot was measured within five minutes of it\./,
  );
  const live = workspace("live", { snapshot: bare }).text;
  assert.doesNotMatch(live, /in this snapshot/);
  assert.match(live, /Awaiting measurements/);
});

// The export is a click handler, which markup rendering cannot reach: the
// wiring is read from the source (as edition-client-sources.test.mjs does), and
// the downloaded file itself is checked in the browser run.
test("the workspace's export hands the edition the census date, and only the edition", () => {
  const source = readFileSync(
    resolve(root, "src/components/AnalyticsWorkspace.tsx"),
    "utf8",
  );
  assert.match(
    source,
    /analyticsCsv\(\s*result,\s*STATIC_EDITION\s*\?\s*\{\s*edition: true,\s*censusAsOf: snapshot\.inventory\?\.generatedAt \?\? null,?\s*\}\s*:\s*undefined,?\s*\)/,
  );
  assert.equal(
    source.match(/analyticsCsv\(/g).length,
    1,
    "no second export path that skips the census date",
  );
});

test("the overview shows UTC times in its tooltips and method note, never the visitor's zone", () => {
  const props = {
    envelope,
    now: generated,
    range: "all",
    setRange: noop,
    setChain: noop,
    openSources: noop,
    openDetails: noop,
  };
  const edition = render("edition", "AnalyticsOverview", props);
  const oldest = envelope.totals.freshness.volume.h24.oldestAt;
  assert.ok(
    edition.html.includes(
      `title="Oldest contributing measurement: 28 Oct 2026, 14:00 UTC (${oldest})"`,
    ),
    "the tooltip names the UTC time and keeps the recorded timestamp",
  );
  assert.match(
    edition.text,
    /Publication: 28 Oct 2026, 14:05 UTC\. Evaluated: 28 Oct 2026, 14:05 UTC\. Evaluation does not renew source timestamps\./,
  );
  // 14:05 UTC is the next morning at UTC+14; none of that may leak in.
  assert.doesNotMatch(
    edition.html,
    /29 Oct|Oct 29|10\/29|\bGMT\b|\b[AP]M\b|your local time/,
  );
  assert.match(edition.text, /Measured projects & unnamed hooks 4/);
  assert.doesNotMatch(edition.text, EDITION_QUEUE_WORDS);

  const live = render("live", "AnalyticsOverview", props);
  assert.match(live.text, /your local time; /);
  assert.match(live.text, /Measured projects & hooks 4/);
  assert.match(
    live.html,
    /title="Oldest contributing measurement: 10\/29\/2026/,
  );
});

// The page a visitor reaches first (the overview) names its scope in the same
// way. Every measurement in the envelope is judged an hour after the snapshot,
// so none is current: the state a network with nothing measured is in.
test("the overview's empty states name the network, or the snapshot for all networks", () => {
  const props = (file) => ({
    envelope: readJson(file),
    now: generated + 3600000,
    range: "all",
    setRange: noop,
    setChain: noop,
    openSources: noop,
    openDetails: noop,
  });
  const base = render(
    "edition",
    "AnalyticsOverview",
    props("overview-base-h24.json"),
  ).text;
  assert.match(
    base,
    /No pool in Base has a trading volume measurement taken within five minutes of the snapshot\./,
  );
  assert.match(
    base,
    /No current tracked 24h hook-pool volume in Base: no pool in Base was measured within five minutes of the snapshot\./,
  );
  assert.match(base, /No measurements for Base in this snapshot/);
  assert.match(
    base,
    /No pool in Base has a current measurement to split by use case\./,
  );
  assert.match(base, /No current market data for Base in this snapshot/);
  assert.doesNotMatch(base, SNAPSHOT_WIDE_EMPTY);

  const all = render(
    "edition",
    "AnalyticsOverview",
    props("overview-all-h24.json"),
  ).text;
  assert.match(
    all,
    /No pool in this snapshot has a trading volume measurement taken within five minutes of it\./,
  );
  assert.match(
    all,
    /No current tracked 24h hook-pool volume in all networks: no pool in this snapshot was measured within five minutes of it\./,
  );
  assert.match(all, /No measurements in this snapshot/);
  assert.match(
    all,
    /No pool in this snapshot has a current measurement to split by use case\./,
  );
  assert.match(all, /No current market data in this snapshot/);

  // The live build keeps its own wording for the same state.
  const live = render(
    "live",
    "AnalyticsOverview",
    props("overview-base-h24.json"),
  ).text;
  assert.match(live, /Waiting for current market data/);
  assert.match(live, /Awaiting measurements/);
  assert.doesNotMatch(live, /in this snapshot|of the snapshot/);
});

// The recorded-history panel with no point saved. The live rule (a point only
// when every contributing pool is fresh, with the archive of a project's own
// history under "Archived observations") is not the edition's: it saves a point
// from the pools current at a snapshot, only when there are some, and has no
// archive panel.
const LIVE_NO_HISTORY =
  "A point is saved only when every contributing pool has a fresh measurement; none has been saved. Current totals stay available above, and projects with recorded history list it under Archived observations in their details.";
const historyPanel = (flavour, props = {}) =>
  render(flavour, "AnalyticsHistory", {
    points: [],
    allPoints: 0,
    available: true,
    range: "all",
    setRange: noop,
    showAllNetworks: noop,
    metric: "volume",
    now: generated,
    ...props,
  });

test("with no point saved the edition's history panel states the snapshot's rule, not the live one", () => {
  const { text, html } = historyPanel("edition");
  assert.match(text, /No network-wide history is recorded/);
  assert.match(
    text,
    /A point is saved only when a snapshot has pools measured within five minutes of it; none has been saved\. Current totals stay available above\./,
  );
  // The live rule and the panel the edition does not have are not mentioned.
  assert.doesNotMatch(text, /every contributing pool/);
  assert.doesNotMatch(text, /Archived observations/);
  assert.doesNotMatch(text, /projects with recorded history/);
  // A missing observation is still never a zero.
  assert.match(text, /Missing observations are never shown as zero\./);
  assert.doesNotMatch(html, /data-kind="range"|data-kind="scope"/);
  assert.match(html, /data-kind="none"/);
});

test("with no point saved the live history panel is word for word what it was", () => {
  const { text, html } = historyPanel("live");
  assert.match(text, /No network-wide history is recorded/);
  assert.ok(
    text.includes(
      `${LIVE_NO_HISTORY} Missing observations are never shown as zero.`,
    ),
    text,
  );
  assert.match(html, /data-kind="none"/);
});

test("the other empty states of the history panel read the same in both builds", () => {
  for (const props of [
    // History exists, but not inside the chosen range.
    { allPoints: 3 },
    // History is saved for all networks only.
    { available: false },
  ]) {
    const edition = historyPanel("edition", props);
    const live = historyPanel("live", props);
    assert.equal(edition.text, live.text, JSON.stringify(props));
  }
  assert.match(
    historyPanel("edition", { allPoints: 3 }).text,
    /No observations in this range.*Choose a wider time range to see earlier recorded volume\./,
  );
  assert.match(
    historyPanel("edition", { available: false }).text,
    /History is recorded across all networks/,
  );
});
