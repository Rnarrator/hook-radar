// Networks, Analytics and the pricing-check wording of the Auto Snapshot
// edition: what a pricing row says when the price source gave no result, how
// many networks "checked" counts, the empty state of a network no project
// lists, exact amounts in cents, and the head check in the analytics export.
// The components are compiled from source once as the edition
// (VITE_STATIC_EDITION=1) and once as the live build (flag unset) and rendered
// to markup, so these tests read the strings a visitor reads and also prove the
// live strings did not change. Plain fixtures; nothing here is real market data
// and nothing is written anywhere.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  analyticsCsv,
  buildAnalytics,
  inventoryHeadCheckFailed,
  roundExactUsd,
} from "../src/analytics.ts";
import { chainHeadCheckFailed } from "../src/chain-network-directory.ts";

process.env.TZ = "Pacific/Kiritimati";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dataDir = resolve(root, "tests/fixtures/static-data/data");
const snapshot = JSON.parse(
  readFileSync(resolve(dataDir, "snapshot.json"), "utf8"),
);
const generated = Date.parse(snapshot.generatedAt);
const CENSUS_AT = snapshot.inventory.generatedAt;

/* ── The components, once per flavour ─────────────────────────────────── */

const flavours = {};
const projectRequire = createRequire(resolve(root, "package.json"));

/** Source files are transpiled one by one (TypeScript only) and wired with a
 * small CommonJS loader; stylesheets are empty; packages come from
 * node_modules. The edition flag is the text the bundler would replace. */
function loadFlavour(edition, { openTables = false } = {}) {
  const flag = edition ? '"1"' : "undefined";
  const cache = new Map();
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
    const source = readFileSync(file, "utf8")
      .replaceAll("import.meta.env.VITE_STATIC_EDITION", flag)
      .replaceAll("import.meta.env.BASE_URL", '"/"');
    const { outputText } = ts.transpileModule(source, {
      fileName: file,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
    });
    const requireFrom = (specifier) => {
      if (!specifier.startsWith(".")) return projectRequire(specifier);
      if (specifier.endsWith(".css")) return {};
      const target = local(file, specifier);
      const real = load(target);
      // The "View as table" disclosure opens on a click; where a test needs the
      // table in the markup, the frame shows it as soon as it renders.
      return openTables && target === resolve(root, "src/charts/ChartFrame.tsx")
        ? {
            ...real,
            ChartFrame: ({ children, table }) =>
              projectRequire("react").createElement(
                projectRequire("react").Fragment,
                null,
                children,
                table ? table.render() : null,
              ),
          }
        : real;
    };
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
    formatMoneyFull: at("src/charts/format.ts").formatMoneyFull,
    buildChains: at("src/chains.ts").buildChains,
    MarketCoverage: at("src/components/MarketCoverage.tsx").MarketCoverage,
    AnalyticsEvidence: at("src/components/AnalyticsCharts.tsx")
      .AnalyticsEvidence,
    AnalyticsWorkspace: at("src/components/AnalyticsWorkspace.tsx")
      .AnalyticsWorkspace,
    AnalyticsHistory: at("src/components/AnalyticsHistory.tsx")
      .AnalyticsHistory,
    ChainExplorer: at("src/components/ChainExplorer.tsx").ChainExplorer,
    ChainProtocolCatalog: at("src/components/ChainProtocolCatalog.tsx")
      .ChainProtocolCatalog,
    ChainCharts: at("src/components/ChainCharts.tsx").ChainCharts,
    ChainNetworkDirectory: at("src/components/ChainNetworkDirectory.tsx")
      .ChainNetworkDirectory,
  };
  loaded.freezeEvaluationClock(snapshot.generatedAt);
  return loaded;
}

before(() => {
  flavours.edition = loadFlavour(true);
  flavours.live = loadFlavour(false);
  flavours.editionTables = loadFlavour(true, { openTables: true });
  flavours.liveTables = loadFlavour(false, { openTables: true });
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

/** Every title, aria-label and aria-valuetext of a piece of markup. */
function attributes(html) {
  const found = [];
  for (const match of html.matchAll(
    /\s(title|aria-label|aria-valuetext)="([^"]*)"/g,
  ))
    found.push(match[2]);
  return found;
}
/** Dollar amounts of a cent or more that carry more than two decimals. */
function overPrecise(text) {
  return [...text.matchAll(/\$([\d,]+\.\d{3,})/g)]
    .map((match) => match[0])
    .filter((amount) => Number(amount.slice(1).replaceAll(",", "")) >= 0.01);
}
/** An amount in cents as the edition writes it: 3268.3000000000002 -> "$3,268.30". */
const usd2 = (value) =>
  "$" +
  Number(value.toFixed(2)).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

/* ── Exact amounts ────────────────────────────────────────────────────── */

test("roundExactUsd drops float residue from a cent up and leaves the rest alone", () => {
  assert.equal(roundExactUsd(339226102.0600004), 339226102.06);
  assert.equal(roundExactUsd(192436102.76999998), 192436102.77);
  assert.equal(roundExactUsd(8627875.750000002), 8627875.75);
  assert.equal(roundExactUsd(44372005.32000001), 44372005.32);
  assert.equal(roundExactUsd(124552403.02850002), 124552403.03);
  // A cent and more is cents; below a cent a figure keeps its digits.
  assert.equal(roundExactUsd(0.01), 0.01);
  assert.equal(roundExactUsd(0.000123), 0.000123);
  assert.equal(roundExactUsd(0.0099999), 0.0099999);
  // A measured zero stays zero and a value that is not a number stays so.
  assert.ok(Object.is(roundExactUsd(0), 0));
  assert.ok(Number.isNaN(roundExactUsd(Number.NaN)));
  assert.equal(roundExactUsd(Infinity), Infinity);
  assert.equal(roundExactUsd(1234.5), 1234.5);
});

test("an exact amount reads in cents in the edition and as before live", () => {
  const edition = flavours.edition.formatMoneyFull;
  const live = flavours.live.formatMoneyFull;
  assert.equal(edition(339226102.0600004), "$339,226,102.06");
  assert.equal(edition(192436102.76999998), "$192,436,102.77");
  assert.equal(edition(5000), "$5,000.00");
  // Below a cent the digits stay, without binary residue; zero is zero.
  assert.equal(edition(0.000123), "$0.000123");
  assert.equal(edition(0.007), "$0.007");
  assert.equal(edition(0), "$0");
  assert.equal(edition(Number.NaN), "Not available");
  // The live build writes every recorded digit, as it did.
  assert.equal(live(339226102.0600004), "$339,226,102.0600004");
  assert.equal(live(1234567.891234567), "$1,234,567.891234567");
  assert.equal(live(0), "$0");
});

/** The fixture with pool volumes whose sums carry float residue. */
function noisySnapshot() {
  const shot = structuredClone(snapshot);
  const base = shot.pools.filter(
    (pool) => pool.chain === "base" && pool.projectId === "alpha",
  );
  // 1000.01 + 2000.02 is 3000.0299999999997: the residue of a sum of cents.
  base[0].volumeUsd.h24 = 1000.01;
  base[1].volumeUsd.h24 = 2000.02;
  return shot;
}

test("the Networks charts and ledger carry no float residue in a title or an aria-label", () => {
  const shot = noisySnapshot();
  const result = flavours.edition.buildChains(shot, {
    chain: "all",
    search: "",
    role: "all",
    windowKey: "h24",
    now: generated,
  });
  const live = flavours.live.buildChains(shot, {
    chain: "all",
    search: "",
    role: "all",
    windowKey: "h24",
    now: generated,
  });
  // The residue is really in the sums these figures are made of.
  const sum = result.networks.find((row) => row.slug === "base");
  assert.notEqual(
    sum.volumeUsd,
    Number(sum.volumeUsd.toFixed(2)),
    "the fixture sum carries residue",
  );
  const props = { windowKey: "h24", onSelectNetwork: noop, census: null };
  for (const component of ["ChainCharts", "ChainNetworkDirectory"]) {
    const edition = render("edition", component, {
      ...props,
      result,
      networks: result.networks,
    });
    const titles = attributes(edition.html);
    assert.ok(titles.length > 3, component + " has exact values to read");
    assert.deepEqual(
      overPrecise(titles.join("\n")),
      [],
      component + " in the edition",
    );
    assert.ok(titles.join("\n").includes(usd2(sum.volumeUsd)), component);
    // Live keeps the recorded digits: nothing changes for the live site.
    const before = render("live", component, {
      ...props,
      result: live,
      networks: live.networks,
    });
    assert.ok(
      overPrecise(attributes(before.html).join("\n")).length > 0,
      component + " live is unchanged",
    );
  }
});

test("a project's exact volume in the directory reads in cents in the edition", () => {
  const shot = noisySnapshot();
  const build = (flavour) =>
    flavours[flavour].buildChains(shot, {
      chain: "base",
      search: "",
      role: "all",
      windowKey: "h24",
      now: generated,
    });
  const props = (result) => ({
    result,
    chain: "base",
    windowKey: "h24",
    now: generated,
    search: "",
    setSearch: noop,
    role: "all",
    setRole: noop,
    openProject: noop,
    browseHooks: noop,
    chooseNetwork: noop,
  });
  const edition = render(
    "edition",
    "ChainProtocolCatalog",
    props(build("edition")),
  );
  const titles = attributes(edition.html).join("\n");
  // Alpha's two current Base pools: 1000.01 + 2000.02 is 3000.0299999999997.
  assert.ok(titles.includes("$3,000.03"), "the project's exact volume");
  assert.deepEqual(overPrecise(titles), []);
  const live = render("live", "ChainProtocolCatalog", props(build("live")));
  assert.ok(overPrecise(attributes(live.html).join("\n")).length > 0);
});

function historyProps(values) {
  const start = Date.parse("2026-10-28T06:00:00.000Z");
  return {
    points: values.map((value, index) => ({
      timestamp: start + index * 3 * 3600_000,
      value,
    })),
    allPoints: values.length,
    available: true,
    range: "all",
    setRange: noop,
    showAllNetworks: noop,
    metric: "volume",
    now: generated,
  };
}

test("the recorded-volume panel reads exact values in cents", () => {
  const props = historyProps([0.000123, 339226102.0600004, 339226102.0600004]);
  const { html, text } = render("edition", "AnalyticsHistory", props);
  assert.match(text, /\$339,226,102\.06\b/);
  assert.doesNotMatch(html, /339,226,102\.06\d/);
  assert.doesNotMatch(html, /339226102\.0600004/, "not in a title either");
  assert.deepEqual(overPrecise(html), []);
  // The slider speaks the same figure, and the inspected value too.
  assert.match(
    html,
    /aria-valuetext="[^"]*\$339,226,102\.06 observed 24h volume"/,
  );
  assert.match(html, /title="\$339,226,102\.06"/);
  // Live: the recorded digits, as before.
  const live = render("live", "AnalyticsHistory", props).html;
  assert.match(live, /\$339,226,102\.0600004 observed 24h volume/);
  // A figure below a cent keeps its digits, and a measured zero stays zero.
  const small = render(
    "edition",
    "AnalyticsHistory",
    historyProps([339226102.0600004, 0.000123]),
  ).html;
  assert.match(small, /aria-valuetext="[^"]*\$0\.000123 observed 24h volume"/);
  const zero = render("edition", "AnalyticsHistory", historyProps([5, 0])).html;
  assert.match(zero, /aria-valuetext="[^"]*: \$0 observed 24h volume"/);
});

/* ── The analytics export ─────────────────────────────────────────────── */

const report = (shot = snapshot) =>
  buildAnalytics(shot, { chain: "all", windowKey: "h24", now: generated });

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
      // the row end follows
    } else if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  return rows;
}

/** The census as the real one had it: Celo's head check failed, the scan still
 * reached its target; another network failed for a reason that is not the head;
 * another is still scanning. */
function censusCases() {
  const shot = structuredClone(snapshot);
  const by = (chain) => shot.inventory.networks.find((n) => n.chain === chain);
  Object.assign(by("base"), {
    status: "error",
    lastError:
      "Census source head is behind the canonical deployment or saved checkpoint",
  });
  Object.assign(by("ethereum"), {
    status: "error",
    lastError: "Public census step exceeded its deadline",
  });
  Object.assign(by("robinhood"), { status: "scanning" });
  return shot;
}

test("the edition export says whether the census head check passed", () => {
  const options = { edition: true, censusAsOf: CENSUS_AT };
  const rows = parseCsv(analyticsCsv(report(), options));
  const head = rows[0];
  const at = head.indexOf("head_check_at_census");
  assert.equal(
    head[at - 1],
    "head_checked_at",
    "next to the time it qualifies",
  );
  const state = (rows, id) =>
    rows.find(
      (row) => row[0] === "network" && row[head.indexOf("id")] === id,
    )?.[at];
  assert.equal(state(rows, "base"), "passed");
  assert.equal(state(rows, "ethereum"), "passed");

  const cases = parseCsv(analyticsCsv(report(censusCases()), options));
  // The recorded head-check error: failed, whatever the time beside it says.
  assert.equal(state(cases, "base"), "failed");
  // An error that says nothing about the head, and a scan still running: the
  // row cannot say how the head check ended, so the cell is blank, not "failed".
  assert.equal(state(cases, "ethereum"), "");
  assert.equal(state(cases, "robinhood"), "");
  // The time of the last passing check is still written as recorded.
  const time = cases.find(
    (row) => row[0] === "network" && row[head.indexOf("id")] === "base",
  )[head.indexOf("head_checked_at")];
  assert.equal(
    time,
    snapshot.inventory.networks.find((n) => n.chain === "base").headCheckedAt,
  );
  // Rows that carry no census counts carry no verdict either.
  for (const row of cases.slice(1))
    if (row[0] === "project" || row[0] === "pool" || row[0] === "summary")
      assert.equal(row[at], "", row[0]);
  // The live export does not have the column.
  assert.ok(
    !parseCsv(analyticsCsv(report()))[0].includes("head_check_at_census"),
  );
});

test("the export and the Networks page agree on which error is a head-check error", () => {
  const messages = [
    "Census source head is behind the canonical deployment or saved checkpoint",
    "Census source returned an invalid finalized head",
    "Census head contradicts the saved checkpoint hash",
    "Census head contradicts the saved checkpoint hash: 0xabc",
    "Public census step exceeded its deadline",
    "",
    null,
  ];
  for (const message of messages)
    for (const status of ["error", "complete", "unavailable"]) {
      const inventory = { status, lastError: message };
      assert.equal(
        inventoryHeadCheckFailed(inventory),
        chainHeadCheckFailed({ inventory }),
        `${status} ${message}`,
      );
    }
  assert.equal(inventoryHeadCheckFailed(null), false);
  assert.equal(inventoryHeadCheckFailed(undefined), false);
});

test("the edition export writes dollar amounts in cents; the live export is unchanged", () => {
  const shot = noisySnapshot();
  const sub = shot.pools.find(
    (pool) => pool.id === "base:gamma" || pool.projectId === "gamma",
  );
  sub.volumeUsd.h24 = 0.004;
  const options = { edition: true, censusAsOf: CENSUS_AT };
  const rows = parseCsv(analyticsCsv(report(shot), options));
  const head = rows[0];
  const amounts = ["observed_volume_usd", "observed_liquidity_usd"].map((n) =>
    head.indexOf(n),
  );
  const decimals = (value) => (value.split(".")[1] ?? "").length;
  for (const row of rows.slice(1))
    for (const index of amounts) {
      const value = row[index];
      if (value === "" || Number(value) < 0.01) continue;
      assert.ok(decimals(value) <= 2, `${row[0]} ${head[index]} ${value}`);
    }
  const total = rows.find((row) => row[0] === "summary");
  const unrounded = report(shot).totals.volumeUsd;
  assert.notEqual(unrounded, Number(unrounded.toFixed(2)), "residue was there");
  assert.equal(total[amounts[0]], String(Number(unrounded.toFixed(2))));
  // A figure below a cent keeps its digits; a missing one stays blank.
  const pool = rows.find(
    (row) =>
      row[0] === "pool" && row[head.indexOf("observed_volume_usd")] === "0.004",
  );
  assert.ok(pool, "the sub-cent pool amount is written as it is");
  // Nothing else in the file changes: only amounts are rounded.
  const live = parseCsv(analyticsCsv(report(shot)));
  const liveTotal = live.find((row) => row[0] === "summary");
  assert.equal(
    liveTotal[head.indexOf("observed_volume_usd")],
    String(unrounded),
  );
  assert.equal(rows.length, live.length);
  for (const [i, row] of rows.entries())
    for (const name of ["row_type", "id", "sample_pools", "as_of"])
      assert.equal(row[head.indexOf(name)], live[i][live[0].indexOf(name)]);
});

/* ── Pricing checks by network ────────────────────────────────────────── */

const row = (chain, chainId, fields) => ({
  chain,
  chainId,
  inventoryPools: 100,
  checkedPools: 0,
  measuredPools: 0,
  pendingPools: 100,
  missingPools: 0,
  attemptedPools: 0,
  status: "unavailable",
  ...fields,
});
const answered = (chain, chainId) =>
  row(chain, chainId, {
    checkedPools: 10,
    measuredPools: 4,
    pendingPools: 90,
    missingPools: 6,
    attemptedPools: 10,
    status: "live",
  });

/** The pricing rows as the real snapshot had them: fifteen networks where a
 * source responded, Zora and X Layer asked with no result, five not asked.
 * `flag` is the collector's optional "not indexed" mark on those two. */
function realShapedCoverage(flag) {
  const shot = structuredClone(snapshot);
  const names = {
    7777777: ["zora", "Zora"],
    196: ["xlayer", "X Layer"],
  };
  const chains = [];
  const networks = [];
  for (let i = 1; i <= 15; i++) {
    const slug = `net${String(i).padStart(2, "0")}`;
    chains.push({ id: 1000 + i, slug, name: `Net ${i}`, explorer: null });
    networks.push(answered(slug, 1000 + i));
  }
  for (const [id, [slug, name]] of Object.entries(names))
    chains.push({ id: Number(id), slug, name, explorer: null });
  networks.push(
    row("zora", 7777777, {
      inventoryPools: 11,
      pendingPools: 11,
      attemptedPools: 11,
      ...(flag === undefined ? {} : { unsupported: flag }),
    }),
    row("xlayer", 196, {
      inventoryPools: 1515,
      pendingPools: 1515,
      attemptedPools: 5,
      ...(flag === undefined ? {} : { unsupported: flag }),
    }),
  );
  for (let i = 1; i <= 5; i++) {
    const slug = `idle${i}`;
    chains.push({ id: 2000 + i, slug, name: `Idle ${i}`, explorer: null });
    networks.push(row(slug, 2000 + i));
  }
  shot.chains = [...shot.chains, ...chains];
  shot.marketCoverage = { cacheWarning: null, networks };
  return shot;
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

test("a network the source gave no result for is not called a source that failed to respond", () => {
  for (const flag of [undefined, false]) {
    const shot = realShapedCoverage(flag);
    const { html, text } = render("edition", "MarketCoverage", {
      snapshot: shot,
    });
    assert.doesNotMatch(text, /did not respond/i, `flag ${flag}`);
    assert.match(
      text,
      /Zora No pricing results for this network Checked 0 of 11/,
    );
    assert.match(
      text,
      /X Layer No pricing results for this network Checked 0 of 1,515/,
    );
    assert.match(
      html,
      /data-state="unavailable">No pricing results for this network</,
    );
    // Fifteen networks had a source respond: that is what "checked" means.
    assert.match(text, /Checks were made on 15 of 22 networks\./);
    assert.doesNotMatch(text, /17 of 22/);
  }
});

test("a network the price source does not index says so when the collector marks it", () => {
  const shot = realShapedCoverage(true);
  const { html, text } = render("edition", "MarketCoverage", {
    snapshot: shot,
  });
  assert.match(text, /Zora Not indexed by the price source Checked 0 of 11/);
  assert.match(
    text,
    /X Layer Not indexed by the price source Checked 0 of 1,515/,
  );
  assert.doesNotMatch(text, /did not respond|No pricing results/i);
  // Not a failure: no warning dot, and the count is still of responding networks.
  assert.match(html, /data-state="empty">Not indexed by the price source</);
  assert.match(text, /Checks were made on 15 of 22 networks\./);
  // A mark on a network a source did answer for does not unsay the answer.
  const odd = structuredClone(shot);
  odd.marketCoverage.networks[0].unsupported = true;
  assert.match(
    render("edition", "MarketCoverage", { snapshot: odd }).text,
    /Net 1 Source responded/,
  );
  // Selected on its own, the row reads the same.
  const only = render("edition", "MarketCoverage", {
    snapshot: shot,
    initialNetwork: "xlayer",
  }).text;
  assert.match(only, /X Layer Not indexed by the price source/);
  assert.doesNotMatch(only, /Checks were made on/);
});

test("the same count and wording reach the Analytics workspace", () => {
  for (const flag of [undefined, true]) {
    const shot = realShapedCoverage(flag);
    const { text } = render("edition", "AnalyticsWorkspace", {
      ...WORKSPACE_PROPS,
      snapshot: shot,
    });
    assert.match(text, /Checks were made on 15 of 22 networks\./);
    assert.doesNotMatch(text, /17 of 22|did not respond/);
  }
  // The evidence block takes the count of networks where a source responded.
  const evidence = render("edition", "AnalyticsEvidence", {
    windowKey: "h24",
    metric: "volume",
    now: generated,
    samplePools: 12,
    freshness: JSON.parse(
      readFileSync(resolve(dataDir, "overview-all-h24.json"), "utf8"),
    ).totals.freshness,
    publishedAt: snapshot.generatedAt,
    evaluatedAt: snapshot.generatedAt,
    inventory: null,
    pricing: {
      indexed: 100,
      checked: 10,
      measured: 4,
      missing: 6,
      pending: 90,
      census: "census as of 27 Oct 2026",
      networks: 22,
      checkedNetworks: 15,
      unlistedNetworks: 0,
      unlistedPools: 0,
    },
    sourceCount: 4,
    openSources: noop,
    scopeLabel: "All networks",
  }).text;
  assert.match(evidence, /Checks were made on 15 of 22 networks\./);
  // Every network answered: nothing to say.
  const all = render("edition", "AnalyticsEvidence", {
    windowKey: "h24",
    metric: "volume",
    now: generated,
    samplePools: 12,
    freshness: JSON.parse(
      readFileSync(resolve(dataDir, "overview-all-h24.json"), "utf8"),
    ).totals.freshness,
    publishedAt: snapshot.generatedAt,
    evaluatedAt: snapshot.generatedAt,
    inventory: null,
    pricing: {
      indexed: 100,
      checked: 10,
      measured: 4,
      missing: 6,
      pending: 90,
      networks: 22,
      checkedNetworks: 22,
    },
    sourceCount: 4,
    openSources: noop,
    scopeLabel: "All networks",
  }).text;
  assert.doesNotMatch(all, /Checks were made on/);
});

test("the live build keeps its pricing wording", () => {
  const { text } = render("live", "MarketCoverage", {
    snapshot: realShapedCoverage(true),
  });
  assert.match(text, /Zora Source unavailable/);
  assert.doesNotMatch(
    text,
    /Not indexed by the price source|No pricing results/,
  );
  assert.doesNotMatch(text, /Checks were made on/);
});

/* ── A network no project lists ───────────────────────────────────────── */

/** HyperEVM as the real census had it: 27 hook contracts, 155 hook pools, and
 * no project or pool in the snapshot. */
function withCensusOnlyNetwork(fields = {}, drop = []) {
  const shot = structuredClone(snapshot);
  const template = shot.inventory.networks.find((n) => n.chain === "robinhood");
  const network = {
    ...template,
    chain: "hyperevm",
    chainId: 999,
    name: "HyperEVM",
    hookCount: 27,
    hookPoolCount: 155,
    poolCount: 167,
    updatedAt: "2026-10-27T21:08:28.976Z",
    ...fields,
  };
  for (const key of drop) delete network[key];
  shot.inventory.networks.push(network);
  shot.chains.push({
    id: 999,
    slug: "hyperevm",
    name: "HyperEVM",
    explorer: null,
  });
  return shot;
}
function catalog(flavour, shot, chain, extra = {}) {
  const result = flavours[flavour].buildChains(shot, {
    chain,
    search: "",
    role: "all",
    windowKey: "h24",
    now: generated,
  });
  return render(flavour, "ChainProtocolCatalog", {
    result,
    chain,
    windowKey: "h24",
    now: generated,
    search: "",
    setSearch: noop,
    role: "all",
    setRole: noop,
    openProject: noop,
    browseHooks: noop,
    chooseNetwork: noop,
    ...extra,
  });
}
const EXPLORE = /Explore on-chain hooks/;

test("a network with no listed project offers no dead control and says what the census counted", () => {
  const { html, text } = catalog(
    "edition",
    withCensusOnlyNetwork(),
    "hyperevm",
  );
  assert.match(text, /No listed projects on this network/);
  assert.match(
    text,
    /No project in the 28 Oct 2026 snapshot lists or measures a hook on this network\. The census \(27 Oct 2026\) counts 27 hook contracts here; their addresses are not part of this snapshot\./,
  );
  assert.doesNotMatch(html, EXPLORE);
  assert.doesNotMatch(text, /on-chain discovery|onchain discovery/i);
  // Nothing follows the empty state's text: no action of any kind.
  const emptyState = html.slice(html.indexOf('class="empty-state"'));
  assert.ok(emptyState.length > 100, "the empty state is there");
  assert.ok(!emptyState.includes("<button"), "no control in the empty state");
  // Live: the copy and the button are unchanged.
  const live = catalog("live", withCensusOnlyNetwork(), "hyperevm");
  assert.match(live.html, EXPLORE);
  assert.match(
    live.text,
    /No named project lists a hook here yet\. Unnamed contracts may still appear in on-chain discovery\./,
  );
});

test("the census sentence is left out when its count is missing, never read as zero", () => {
  const none = withCensusOnlyNetwork({ hookCount: undefined });
  const text = catalog("edition", none, "hyperevm").text;
  assert.match(
    text,
    /lists or measures a hook on this network\.(?! The census)/,
  );
  assert.doesNotMatch(text, /The census|hook contracts here|\b0 hook/);
  const nulled = withCensusOnlyNetwork({ hookCount: null });
  assert.doesNotMatch(
    catalog("edition", nulled, "hyperevm").text,
    /The census/,
  );
  // A measured zero is said as a zero count.
  const zero = catalog(
    "edition",
    withCensusOnlyNetwork({ hookCount: 0 }),
    "hyperevm",
  ).text;
  assert.match(
    zero,
    /The census \(27 Oct 2026\) counts no hook contracts here\./,
  );
  assert.doesNotMatch(zero, /not part of this snapshot/);
});

test("the census sentence keeps its own date, one contract and an unfinished scan", () => {
  const one = catalog(
    "edition",
    withCensusOnlyNetwork({ hookCount: 1 }),
    "hyperevm",
  ).text;
  assert.match(
    one,
    /counts 1 hook contract here; its address is not part of this snapshot\./,
  );
  const dated = catalog(
    "edition",
    withCensusOnlyNetwork({ updatedAt: "2026-10-25T08:00:00.000Z" }),
    "hyperevm",
  ).text;
  assert.match(dated, /The census \(25 Oct 2026\) counts 27/);
  const undated = catalog(
    "edition",
    withCensusOnlyNetwork({ updatedAt: null }),
    "hyperevm",
  ).text;
  assert.match(undated, /The census counts 27 hook contracts here/);
  assert.doesNotMatch(undated, /null|NaN|Invalid/);
  // The scan had not reached its target: the count is a floor.
  const partial = catalog(
    "edition",
    withCensusOnlyNetwork({
      status: "scanning",
      scannedToBlock: 1,
      targetBlock: 99,
    }),
    "hyperevm",
  ).text;
  assert.match(partial, /counts at least 27 hook contracts here/);
});

test("a network that has listed projects is unchanged", () => {
  for (const flavour of ["edition", "live"]) {
    const { html, text } = catalog(flavour, snapshot, "base", {
      registrySource: snapshot.sources.find(
        (source) => source.id === "registry",
      ),
    });
    assert.doesNotMatch(text, /No listed projects on this network/);
    assert.doesNotMatch(text, /lists or measures a hook/);
    assert.match(text, /Hooks and protocols on Base\./);
    assert.ok(html.includes("chains-protocol-list"), flavour);
    // The registry note under the list says what the list holds and, in the
    // edition, that the census (not on-chain discovery) counts the rest.
    assert.match(text, /Project listings include published hooks; /, flavour);
    if (flavour === "edition") {
      assert.match(
        text,
        /the census also counts unnamed contracts, which are not listed here\./,
      );
      assert.doesNotMatch(text, /on-chain discovery/i);
    } else {
      assert.match(
        text,
        /on-chain discovery also includes unnamed contracts\./,
      );
    }
  }
  // A filter that finds nothing keeps its own wording and its own button.
  const result = flavours.edition.buildChains(snapshot, {
    chain: "base",
    search: "no-such-project-anywhere",
    role: "all",
    windowKey: "h24",
    now: generated,
  });
  const filtered = render("edition", "ChainProtocolCatalog", {
    result,
    chain: "base",
    windowKey: "h24",
    now: generated,
    search: "no-such-project-anywhere",
    setSearch: noop,
    role: "all",
    setRole: noop,
    openProject: noop,
    browseHooks: noop,
    chooseNetwork: noop,
  });
  assert.match(filtered.text, /Try another name, address or protocol type\./);
  assert.match(filtered.html, /Clear filters/);
});

/* ── The network page's header ────────────────────────────────────────── */

function explorer(flavour, shot, chain) {
  return render(flavour, "ChainExplorer", {
    snapshot: shot,
    windowKey: "h24",
    now: generated,
    chain,
    setChain: noop,
    search: "",
    setSearch: noop,
    role: "all",
    setRole: noop,
    openProject: noop,
    openAnalytics: noop,
    browseHooks: noop,
    openSources: noop,
  });
}
const BROWSE = /Browse all hooks/;
const selected = (flavour, shot, chain) =>
  flavours[flavour].buildChains(shot, {
    chain,
    search: "",
    role: "all",
    windowKey: "h24",
    now: generated,
  }).selectedNetwork;

test("the header of a network the snapshot holds nothing for does not offer a list with no result", () => {
  const shot = withCensusOnlyNetwork();
  const network = selected("edition", shot, "hyperevm");
  // The case: counted by the census, nothing in the snapshot.
  assert.equal(network.protocolCount, 0);
  assert.equal(network.observedPools, 0);
  assert.ok(!network.deploymentSupport);
  const { html, text } = explorer("edition", shot, "hyperevm");
  assert.match(text, /HyperEVM on v4/);
  assert.doesNotMatch(html, BROWSE);
  assert.doesNotMatch(html, EXPLORE);
  // The rest of the header stays.
  assert.match(text, /Network analytics/);
  assert.match(text, /All networks/);
  assert.match(text, /No listed projects on this network/);
  // Live: the header is as it was.
  assert.match(explorer("live", shot, "hyperevm").html, BROWSE);
});

test("the header keeps its list where the snapshot has something to list there", () => {
  // A network with listed projects.
  assert.match(explorer("edition", snapshot, "base").html, BROWSE);
  assert.match(explorer("live", snapshot, "base").html, BROWSE);

  // A contract the census found and no registry names: the hooks list shows
  // it, so the list is not empty even though the network lists no project.
  const unnamed = withCensusOnlyNetwork();
  const clone = structuredClone(unnamed.projects.find((p) => p.id === "delta"));
  clone.id = "unnamed-on-hyperevm";
  clone.name = "Unnamed on HyperEVM";
  clone.deployments = clone.deployments.map((deployment) => ({
    ...deployment,
    chain: "hyperevm",
    chainId: 999,
    discovery: "onchain",
  }));
  unnamed.projects.push(clone);
  const network = selected("edition", unnamed, "hyperevm");
  assert.equal(network.protocolCount, 0, "the catalog does not name it");
  assert.equal(network.observedPools, 0);
  assert.match(explorer("edition", unnamed, "hyperevm").html, BROWSE);

  // A pool measured on the network, whatever project it belongs to.
  const measured = withCensusOnlyNetwork();
  const pool = structuredClone(
    measured.pools.find((p) => p.projectId === null),
  );
  pool.id = "measured-on-hyperevm";
  pool.chain = "hyperevm";
  measured.pools.push(pool);
  assert.ok(selected("edition", measured, "hyperevm").observedPools > 0);
  assert.match(explorer("edition", measured, "hyperevm").html, BROWSE);
});

test("a network Uniswap has published no v4 deployment to keeps its header as it was", () => {
  // The reviewed ZKsync note: its header offers the registry list only when a
  // listed hook is on it. The edition changes nothing there.
  const withZksync = (listed) => {
    const shot = structuredClone(snapshot);
    shot.chains.push({
      id: 324,
      slug: "zksync",
      name: "ZKsync",
      explorer: null,
    });
    if (listed) {
      const clone = structuredClone(
        shot.projects.find((p) => p.id === "delta"),
      );
      clone.id = "listed-on-zksync";
      clone.name = "Listed on ZKsync";
      clone.deployments = clone.deployments.map((deployment) => ({
        ...deployment,
        chain: "zksync",
        chainId: 324,
      }));
      shot.projects.push(clone);
    }
    return shot;
  };
  for (const flavour of ["edition", "live"]) {
    const empty = explorer(flavour, withZksync(false), "zksync");
    assert.match(empty.text, /ZKsync & Uniswap/, flavour);
    assert.doesNotMatch(empty.html, /Browse registry hooks|Browse all hooks/);
    const listed = explorer(flavour, withZksync(true), "zksync");
    assert.match(listed.html, /Browse registry hooks/, flavour);
  }
});

/* ── The recorded values table ────────────────────────────────────────── */

const RESIDUE = [339226102.0600004, 192436102.76999998, 8627875.750000002];
const valueTitles = (html) =>
  [...html.matchAll(/<td title="([^"]*)">\$/g)].map((match) => match[1]);

test("each recorded value in the table carries its cents in its title, and live keeps the digits", () => {
  const props = historyProps(RESIDUE);
  const edition = render("editionTables", "AnalyticsHistory", props);
  assert.deepEqual(
    valueTitles(edition.html),
    ["339226102.06", "192436102.77", "8627875.75"],
    "oldest first, in cents",
  );
  assert.deepEqual(overPrecise(edition.text), []);
  // Live writes every digit that was recorded, as it did.
  const live = render("liveTables", "AnalyticsHistory", props);
  assert.deepEqual(valueTitles(live.html), RESIDUE.map(String));
  // Below a cent the digits stay; zero is zero.
  const small = render(
    "editionTables",
    "AnalyticsHistory",
    historyProps([0.000123, 0, 5]),
  );
  assert.deepEqual(valueTitles(small.html), ["0.000123", "0", "5"]);
});
