// 7D and 30D on the Analytics page, read as markup: the strings a visitor reads,
// and what must NOT change. The components are compiled from source once as the
// edition and once as the live build (tests/component-flavours.mjs) and rendered
// with the span's context around them. Deterministic TEST data only (the fixture
// snapshot and its daily variant); nothing here is real market data.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { createDailyLens } from "../src/daily.ts";
import { GENERATED_AT } from "./fixtures/static-data/generate.mjs";
import { analyticsSpanVariant } from "./fixtures/static-data/daily-variant.mjs";
import { loadFlavour, renderPage } from "./component-flavours.mjs";

process.env.TZ = "Pacific/Kiritimati";

const generated = Date.parse(GENERATED_AT);
const noop = () => {};
const OVERVIEW = "src/components/AnalyticsOverview.tsx";
const WORKSPACE = "src/components/AnalyticsWorkspace.tsx";
const TRADING = {
  [OVERVIEW]: [
    [
      'const [metric, setMetric] = useState<AnalyticsMetric>("volume");',
      'const [metric, setMetric] = useState<AnalyticsMetric>("trading");',
    ],
  ],
};
const RESERVES = {
  [OVERVIEW]: [
    [
      'const [metric, setMetric] = useState<AnalyticsMetric>("volume");',
      'const [metric, setMetric] = useState<AnalyticsMetric>("reserves");',
    ],
  ],
};
const focused = (kind, id) => ({
  [OVERVIEW]: [
    [
      "const [focus, setFocus] = useState<AnalyticsFocus | null>(null);",
      `const [focus, setFocus] = useState<AnalyticsFocus | null>({ kind: "${kind}", id: "${id}" });`,
    ],
  ],
});

let variant;
let envelope;
let flavours;
before(async () => {
  variant = await analyticsSpanVariant();
  envelope = variant.overviews["overview-all-h24.json"];
  flavours = {
    edition: loadFlavour(true),
    live: loadFlavour(false),
    trading: loadFlavour(true, TRADING),
    reserves: loadFlavour(true, RESERVES),
    network: loadFlavour(true, focused("network", "ethereum")),
    useCase: loadFlavour(true, focused("category", "Oracles")),
    liveFocused: loadFlavour(false, focused("network", "ethereum")),
  };
  for (const flavour of Object.values(flavours))
    flavour.freezeEvaluationClock(GENERATED_AT);
});

const view = (lens, phase = "ready", span = "d7") => ({ span, lens, phase });
const ready = (span = "d7") =>
  view(createDailyLens(variant.daily, span), "ready", span);
const OVERVIEW_PROPS = () => ({
  envelope,
  now: generated,
  range: "all",
  setRange: noop,
  setChain: noop,
  openSources: noop,
  openDetails: noop,
});
const overview = (flavour, daily = null, props = {}) =>
  renderPage(flavours[flavour], "AnalyticsOverview", { ...OVERVIEW_PROPS(), ...props }, daily);
const workspace = (flavour, daily = null, props = {}) =>
  renderPage(
    flavours[flavour],
    "AnalyticsWorkspace",
    {
      snapshot: variant.snapshot,
      windowKey: "h24",
      now: generated,
      chain: "all",
      range: "all",
      setChain: noop,
      setRange: noop,
      openProject: noop,
      browseHooks: noop,
      openSources: noop,
      ...props,
    },
    daily,
  );

/** The part of the markup between two markers. */
function between(html, from, to) {
  const start = html.indexOf(from);
  assert.notEqual(start, -1, `${from} is in the page`);
  const end = html.indexOf(to, start + from.length);
  return html.slice(start, end === -1 ? undefined : end);
}
const regions = (html) => ({
  tile: between(html, 'data-testid="analytics-volume"', 'class="analytics-metric"'),
  composition: between(html, 'class="analytics-composition', '<details class="analytics-method"'),
  contributors: between(html, 'class="analytics-step analytics-contributors"', 'class="analytics-step analytics-evidence"'),
});
/** The Data notes' paragraph with the exact figure and the covered pools' facts. */
const detailNote = (html) =>
  between(html, 'data-testid="analytics-span-detail">', "</p>").replace(
    'data-testid="analytics-span-detail">',
    "",
  );
/** Every dollar amount in the markup says "at least": a lower bound is never
 * written as an exact figure. */
function assertMarked(html, where) {
  // The tile sets its sign in the data face (a span around the character only).
  html = html.replace(/<span class="analytics-bound-sign">≥<\/span>/g, "≥");
  for (const match of html.matchAll(/\$\d/g)) {
    const before = html.slice(Math.max(0, match.index - 10), match.index);
    assert.ok(
      /(≥|at least |At least )$/.test(before),
      `${where}: a bare dollar amount near "${html.slice(Math.max(0, match.index - 40), match.index + 20).replace(/\s+/g, " ")}"`,
    );
  }
}

/* ── The default page is the page it was ─────────────────────────────────── */

test("without a span the edition's Analytics reads as before, and names the window on every tile", () => {
  const plain = overview("edition");
  assert.match(plain.text, /Trading volume · 24H/);
  assert.match(plain.text, /Pools with trading · 24H/);
  assert.match(plain.text, /Hook pools Radar can price · All networks · 24H window · measured within 5 minutes of the snapshot/);
  assert.match(plain.text, /24H window · USD/);
  assert.match(plain.text, /All figures are current as of the snapshot/);
  assert.match(plain.text, /Totals use only pools measured within five minutes of the snapshot\./);
  assert.doesNotMatch(plain.text, /7D|30D|largest pools|covered 7D|through d+ Oct/);
  // An inactive provider ("off") is the same as none.
  const off = overview("edition", { span: null, lens: null, phase: "off" });
  assert.equal(off.html, plain.html);
  // The live build never has a span, whatever surrounds it.
  const live = overview("live");
  assert.equal(overview("live", ready()).html, live.html, "the live build ignores a span");
  assert.match(live.text, /Pools with trading/);
  assert.doesNotMatch(live.text, /Pools with trading ·/, "the live label did not change");
  assert.equal(overview("liveFocused", ready()).html, overview("liveFocused").html);
});

/* ── 7D and 30D ──────────────────────────────────────────────────────────── */

test("7D: the tile, the scope line, the caption beside the controls and the chrome say what is shown", () => {
  const page = overview("edition", ready());
  assert.match(page.text, /Trading volume · 7D/);
  const tile = regions(page.html).tile;
  assert.match(tile, /^data-testid="analytics-volume"/);
  assert.match(page.html, /<strong data-testid="analytics-volume" title="At least \$27,650\.00\. The last 7 full days \(UTC\) through 27 Oct, largest pools only\./);
  assert.match(page.html, /aria-hidden="true"><span class="analytics-bound-sign">≥<\/span>\$27\.6K<\/strong><span class="sr-only">at least \$27\.6 thousand, 7D through 27 Oct<\/span>/);
  assert.match(page.text, /7 of 8 pools · through 27 Oct/);
  assert.match(
    page.text,
    /Partial coverage · Not total Uniswap volume Largest hook pools only · All networks · 7D through 27 Oct · 7 pools hold 99\.9% of tracked 24H volume/,
  );
  assert.doesNotMatch(page.text, /Hook pools Radar can price/, "the 24H scope line is not there");
  assert.match(page.text, /7D window · USD/);
  assert.match(page.text, /As of the snapshot · 7D through 27 Oct/);
  // Reserves and pools with trading are the snapshot's own 24H measurements.
  assert.match(page.text, /Reserves held in pools/);
  assert.match(page.text, /Pools with trading · 24H/);
  assert.match(page.text, /Of 8 pools with current volume/);
  // The method note says so, once, in the collapsed Data notes.
  assert.match(page.text, /24H and reserve figures: A measurement counts only if it was less than five minutes old/);
  assert.match(page.text, /7D and 30D add up each pool's daily volume over full UTC days, from GeckoTerminal, for the largest pools only: the 7 pools here hold 99\.9% of tracked 24H volume\./);
  // The tile's tooltip cannot be opened on a phone: its exact figure and the
  // facts about the covered pools are in the notes too.
  assert.match(detailNote(page.html), /^The 7D total is at least \$27,650\.00\. 1 of the 7 pools is younger than 7 days and counts from the launch day\. Read from GeckoTerminal /);
  // The evidence is 24H and says what a span's total is.
  assert.match(page.text, /24H totals use only pools measured within five minutes of the snapshot; 7D and 30D add up completed days\. Older and unverifiable/);
  assert.doesNotMatch(page.text, /Totals use only pools measured within five minutes of the snapshot\./);
  // 30D reads the same file.
  const thirty = overview("edition", ready("d30"));
  assert.match(thirty.text, /Trading volume · 30D/);
  assert.match(thirty.html, /≥\$120\.8K/);
  assert.match(thirty.text, /30D window · USD/);
});

test("7D: the ribbons, the bars and their tables name the span, mark every amount, and give each row its own coverage", () => {
  const page = overview("edition", ready());
  const { composition, contributors } = regions(page.html);
  assert.match(composition, /aria-label="7D volume by network, composition"/);
  assert.match(composition, /aria-label="7D volume by use case, composition"/);
  assert.match(composition, /Composition bar, Base: at least \$26,600\.00, 96\.2% of covered 7D volume\. Focus network\./);
  assert.doesNotMatch(composition, /Not assigned/, "no remainder: the total is the sum of the same rows");
  assert.match(contributors, /Ranked by tracked 7D hook-pool volume, largest pools only, in all networks\. Select a bar to focus every chart and table on it; select it again or press Escape to clear\. Percentages are of covered 7D volume in this scope, not market share\./);
  assert.match(contributors, /7D volume by network/);
  assert.match(contributors, /7D volume by use case/);
  assert.match(contributors, /Largest pools only/);
  assert.match(contributors, /3 networks with 7D volume/);
  assert.match(contributors, /through 27 Oct/);
  assert.match(contributors, /Bars show share of ≥\$27\.6K covered 7D volume across 7 pools with daily data\. Networks with no covered pool are omitted, not shown as zero\./);
  assert.match(contributors, /4 of 4 pools covered/);
  assert.match(contributors, /2 of 3 pools covered/);
  assert.match(contributors, /The 4 covered pools hold \d+(\.\d)?% of its tracked 24H volume\./);
  assert.match(contributors, /Covered total · all networks/);
  assert.doesNotMatch(contributors, /Measurements more than five minutes old|never enter these bars/);
  // Every dollar amount in the tile, the ribbons and the bars is a lower bound.
  for (const [name, html] of Object.entries(regions(page.html))) assertMarked(html, name);
  assert.equal(contributors.includes("Measured pools"), false, "its pools are covered ones");
});

test("a focus under 7D: the focus bar, the portions and a use case with no covered pool say so, and nothing is a bare amount", () => {
  const network = overview("network", ready());
  assert.match(network.text, /Focus · Network Ethereum/);
  assert.match(network.text, /≥\$800\.00 of ≥\$27\.6K covered 7D volume · 2\.9%/);
  assertMarked(between(network.html, 'class="analytics-focus-bar"', 'class="analytics-step analytics-measured"'), "focus bar");
  for (const [name, html] of Object.entries(regions(network.html))) assertMarked(html, `network focus, ${name}`);
  const useCase = overview("useCase", ready());
  assert.match(useCase.text, /Focus · Use case Oracles/);
  assert.match(useCase.text, /No 7D volume: none of its pools is among the largest/);
  assert.match(useCase.text, /Oracles · Not available · No 7D volume: none of its pools is among the largest/);
  for (const [name, html] of Object.entries(regions(useCase.html))) assertMarked(html, `use case focus, ${name}`);
  // A focused network inside 7D keeps the other bars' portions.
  assert.match(regions(network.html).contributors, /Highlighted|network total|pools in focus|covered/);
});

test("the reserves and pools-with-trading metrics are byte for byte the 24H page while a span is chosen", () => {
  for (const flavour of ["trading", "reserves"]) {
    const plain = overview(flavour);
    const span = overview(flavour, ready());
    const a = regions(plain.html);
    const b = regions(span.html);
    assert.equal(b.composition, a.composition, `${flavour}: the ribbons`);
    assert.equal(b.contributors, a.contributors, `${flavour}: the bars, the tables, the notes`);
    // The command bar says 24H: the span is the volume metric's.
    assert.match(span.text, /24H window · USD/, flavour);
    assert.doesNotMatch(span.text, /7D window/, flavour);
    // The rest of the page follows the span (the tile, the scope line, the notes).
    assert.match(span.text, /Trading volume · 7D/, flavour);
  }
});

test("while the figures load, the tile and the ribbons and bars say so and show no 24H figure under the 7D label", () => {
  const loading = overview("edition", view(null, "loading"));
  assert.match(loading.text, /Trading volume · 7D …/);
  assert.match(loading.text, /Loading 7D volume/);
  assert.equal(loading.html.match(/Loading 7D volume/g).length >= 3, true, "the tile, the ribbons and the bars");
  const { composition, contributors } = regions(loading.html);
  assert.match(composition, /analytics-span-pending/);
  assert.match(contributors, /analytics-span-pending/);
  assert.doesNotMatch(composition, /chart-ribbon/);
  assert.doesNotMatch(contributors, /chart-bar|contrib-networks/);
  assert.doesNotMatch(loading.text, /\$313|\$2\.4K/);
  assert.doesNotMatch(loading.html, /analytics-span-detail/, "no exact 7D figure before there is one");
  // A focus is not described with 24H numbers while the 7D ones are loading.
  assert.doesNotMatch(overview("network", view(null, "loading")).text, /covered 7D volume · /);
});

test("when the figures did not come: a dash, 'Not loaded', and one line in place of the ribbons and the bars", () => {
  const failed = overview("edition", view(null, "error"));
  assert.match(failed.text, /Trading volume · 7D —/);
  assert.match(failed.text, /Not loaded/);
  assert.match(failed.text, /Could not load 7D volume\./);
  const { composition, contributors } = regions(failed.html);
  assert.match(composition, /Could not load 7D volume\./);
  assert.match(contributors, /Could not load 7D volume\./);
  assert.doesNotMatch(failed.text, /Loading 7D volume/);
  // The other metrics still render.
  const reserves = overview("reserves", view(null, "error"));
  assert.doesNotMatch(regions(reserves.html).composition, /Could not load/);
  assert.match(regions(reserves.html).contributors, /Reserves by network/);
});

test("a response with no ledger cannot be split, so the span is not drawn", () => {
  const legacy = { ...envelope };
  delete legacy.contributions;
  const plain = overview("edition", null, { envelope: legacy });
  const span = overview("edition", ready(), { envelope: legacy });
  assert.equal(span.html, plain.html);
  assert.doesNotMatch(span.text, /7D/);
});

test("a network with volume and no covered pool: a dash and the plain reason, never a zero", async () => {
  const noEthereum = await analyticsSpanVariant({ omit: (pool) => pool.chain === "ethereum" });
  const lens = createDailyLens(noEthereum.daily, "d7");
  const ethereum = noEthereum.overviews["overview-ethereum-h24.json"];
  const page = overview("edition", { span: "d7", lens, phase: "ready" }, { envelope: ethereum });
  assert.match(page.text, /Trading volume · 7D —/);
  assert.match(page.text, /No pool here has 7D data/);
  assert.match(page.text, /Largest hook pools only · Ethereum · 7D through 27 Oct · No pool here has 7D data/);
  assert.match(page.text, /No 7D volume for Ethereum/);
  assert.match(page.text, /None of its pools is among the largest, so there is no 7D figure\. Missing values are never shown as zero\./);
  assert.doesNotMatch(page.html, /chart-ribbon/, "no ribbon without a figure");
  assert.doesNotMatch(page.html.slice(page.html.indexOf('data-testid="analytics-volume"'), page.html.indexOf('data-testid="analytics-liquidity"')), /\$0/);
});

/* ── The full analytics ──────────────────────────────────────────────────── */

test("the full analytics: the tile, the ranked hooks, the pool table's 7D column and the notes follow the span; the 24H panels say 24H", () => {
  const page = workspace("edition", ready());
  assert.match(page.text, /Trading volume · 7D/);
  assert.match(page.text, /7 of 8 pools · through 27 Oct/);
  assert.match(page.text, /Largest hook pools only · All networks · 7D through 27 Oct · 7 pools hold 99\.9% of tracked 24H volume/);
  assert.match(page.text, /Tracked 7D hook-pool volume, largest pools only · bars and percentages are shares of covered 7D volume in all networks/);
  assert.match(page.text, /7D volume · share/);
  // Ranked hooks: a project's figure is the sum of its covered pools.
  assert.match(page.text, /Alpha Markets .*≥\$25\.0K/);
  assert.match(page.text, /A dash means none of the hook's pools is among the largest\./);
  // The pool table has the span's column, its own sort, and the 24H column too.
  assert.match(page.html, /aria-label="Sort pools by 7d volume"/);
  assert.match(page.html, /aria-sort="descending"[^>]*><button[^>]*aria-label="Sort pools by 7d volume"/);
  assert.match(page.html, /data-label="7D volume"/);
  assert.match(page.html, /Sort pools by tracked 24h volume/);
  assert.match(page.text, /since launch · 1 day/);
  assert.match(page.text, /Not covered: only the largest pools have 7D and 30D volume\./);
  // The scatter and the evidence are the snapshot's 24H measurements.
  assert.match(page.text, /Tracked 24H volume · USD/);
  assert.match(page.text, /24H totals use only pools measured within five minutes of the snapshot; 7D and 30D add up completed days\./);
  assert.match(page.text, /As of the snapshot · 7D through 27 Oct/);
  assert.match(page.html, /title="Export current market measurements and network inventory \(original measurement clocks\), and the 7D figures of the largest pools"/);
  // The ribbons and bars are the span's: every amount is a lower bound.
  const composition = between(page.html, 'class="analytics-composition', '<details class="analytics-method"');
  const bars = between(page.html, 'class="analytics-contributors-grid', 'id="analytics-hooks"');
  assert.match(composition, /7D volume by network, composition/);
  assertMarked(composition, "composition");
  assertMarked(bars, "bars");
  // The ranked hooks: each figure is a lower bound or a dash.
  const ranked = [
    ...page.html.matchAll(
      /<span class="analytics-project-value"><strong>([^<]*)<\/strong>/g,
    ),
  ].map((m) => m[1]);
  assert.ok(ranked.length >= 4);
  assert.ok(
    ranked.every((text) => /^(≥\$|—$)/.test(text)),
    `ranked hooks: ${ranked.join(" | ")}`,
  );
  // Without a span: none of it.
  const plain = workspace("edition");
  assert.doesNotMatch(plain.text, /7D|30D/);
  assert.doesNotMatch(plain.html, /analytics-span-detail/);
  assert.doesNotMatch(plain.html, /data-label="7D volume"|aria-label="Sort pools by 7d volume"/);
  assert.match(plain.html, /title="Export current market measurements and network inventory \(original measurement clocks\)"/);
  assert.equal(workspace("live", ready()).html, workspace("live").html);
});

test("the full analytics while the figures load: the table column and the tile are ellipses, the ranking stays the 24H one and says so", () => {
  const loading = workspace("edition", view(null, "loading"));
  assert.match(loading.text, /Trading volume · 7D …/);
  assert.match(loading.text, /Loading 7D volume/);
  assert.match(loading.text, /Tracked 24H hook-pool volume · bars and percentages are shares of tracked 24H volume in all networks/);
  assert.match(loading.html, /data-label="7D volume"/);
  assert.match(loading.html, /daily-pending/);
  const failed = workspace("edition", view(null, "error"));
  assert.match(failed.text, /Could not load 7D volume\./);
  assert.match(failed.text, /Not loaded/);
});
