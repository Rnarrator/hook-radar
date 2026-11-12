// 7D and 30D on the Analytics page: the join of the overview's ledger and the
// daily file, as pure functions. Deterministic TEST data only (the fixture
// snapshot and its daily variant); nothing here is real market data and nothing
// is written anywhere.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { analyticsCsv, buildAnalytics } from "../src/analytics.ts";
import {
  metricCopy,
  poolCategory,
  UNATTRIBUTED,
} from "../src/analytics-focus.ts";
import { sortAnalyticsPools } from "../src/analytics-pools.ts";
import {
  buildSpanModel,
  buildSpanScope,
  coveragePercent,
  ledgerSpanRows,
  spanEmptyText,
  spanDetailNote,
  spanEmptyTitle,
  spanFmt,
  spanFocusBreakdown,
  spanMethodNote,
  spanRowCoverage,
  spanRowPools,
  spanScopeLine,
  spanSummaryLine,
  spanTileCaption,
  spanTileSpoken,
  spanTileTitle,
  spokenCompactUsd,
  workspaceSpanRows,
} from "../src/analytics-span.ts";
import { createDailyLens, parseDaily } from "../src/daily.ts";
import { analyticsOverviewAt } from "../shared/analytics-contributions.ts";
import { validateDailyShape } from "../shared/daily-volume.ts";
import { GENERATED_AT } from "./fixtures/static-data/generate.mjs";
import { analyticsSpanVariant } from "./fixtures/static-data/daily-variant.mjs";

const generated = Date.parse(GENERATED_AT);
const MINUTE = 60_000;
let variant;
let envelope;
let rows;
let lens7;
let lens30;
before(async () => {
  variant = await analyticsSpanVariant();
  envelope = variant.overviews["overview-all-h24.json"];
  rows = ledgerSpanRows(envelope, generated);
  lens7 = createDailyLens(variant.daily, "d7");
  lens30 = createDailyLens(variant.daily, "d30");
});

const byId = (list, id) => list.find((item) => item.id === id);
const scope = (extra = {}) =>
  buildSpanScope({ rows, lens: lens7, hostAt: GENERATED_AT, ...extra });

/* ── Sums ────────────────────────────────────────────────────────────────── */

test("the total is the sum of the daily figures of the measured pools that have one; it is a lower bound over a count", () => {
  const total = scope();
  // base 20,000 + 5,000 + 1,500 + 100, ethereum 0 + 800, robinhood 250.
  assert.equal(total.usd, 27650);
  assert.equal(total.covered, 7);
  // Eight pools have a current 24H volume; one more is reserves only.
  assert.equal(total.of, 8);
  assert.equal(rows.length, 9, "the ledger holds nine current rows");
  assert.equal(rows.filter((row) => row.usd24 === null).length, 1);
  assert.equal(total.complete, false);
  assert.equal(scope({ lens: lens30 }).usd, 90000 + 21000 + 6000 + 400 + 0 + 3200 + 250);
  assert.equal(total.span, "d7");
  assert.equal(total.label, "7D");
  assert.equal(total.through, "2026-10-27");
  assert.equal(total.throughLabel, "27 Oct");
});

test("the networks and the use cases each partition the covered total; shares are of the covered total and add up to one", () => {
  const model = buildSpanModel({ rows, lens: lens7, hostAt: GENERATED_AT });
  const total = model.totals.volumeUsd;
  assert.equal(total, 27650);
  assert.equal(
    model.networks.reduce((sum, network) => sum + (network.volumeUsd ?? 0), 0),
    total,
  );
  assert.equal(
    model.categories.volume.reduce((sum, slice) => sum + (slice.value ?? 0), 0),
    total,
  );
  assert.equal(
    model.networks.reduce((sum, network) => sum + network.volumePools, 0),
    model.totals.volumePools,
  );
  const shares = model.categories.volume
    .filter((slice) => slice.value !== null)
    .map((slice) => slice.share);
  assert.ok(Math.abs(shares.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.deepEqual(
    model.networks.map((network) => network.chain),
    ["base", "ethereum", "robinhood"],
    "ranked by the figure shown",
  );
  assert.equal(byId(model.networks.map((n) => ({ ...n, id: n.chain })), "base").volumeUsd, 26600);
  // The model has no reserves, no pools with trading and no active-pool count:
  // a span says nothing about them.
  assert.equal(model.totals.liquidityUsd, null);
  assert.equal(model.totals.activePools, null);
  assert.deepEqual(model.categories.reserves, []);
  assert.deepEqual(model.categories.trading, []);
  assert.equal(model.windowKey, "h24");
});

test("a covered pool with a real $0 stays $0; a pool with no figure, and a group of only such pools, is null, never zero", () => {
  const model = buildSpanModel({ rows, lens: lens7 });
  // WBTC / ALPHA on Ethereum measured a real zero over 7 days.
  const zero = createDailyLens(
    { ...variant.daily, pools: variant.daily.pools.filter((p) => p.id.startsWith("ethereum:") && p.v7 === 0) },
    "d7",
  );
  const onlyZero = buildSpanScope({ rows, lens: zero });
  assert.equal(onlyZero.usd, 0, "a covered zero is a measured zero");
  assert.equal(onlyZero.covered, 1);
  assert.equal(onlyZero.networks.get("ethereum").usd, 0);
  assert.equal(onlyZero.networks.get("base").usd, null, "no covered pool: a dash");
  assert.equal(onlyZero.networks.get("base").covered, 0);
  assert.equal(onlyZero.networks.get("base").of, 4, "its measured pools are still counted");
  // A scope no pool of which is covered: no figure at all.
  const none = createDailyLens({ ...variant.daily, pools: variant.daily.pools.slice(0, 1) }, "d7");
  const outside = buildSpanScope({
    rows: rows.filter((row) => row.chain === "robinhood"),
    lens: none,
  });
  assert.equal(outside.usd, null);
  assert.equal(outside.covered, 0);
  assert.equal(spanFmt.compact(outside.usd), "—");
  assert.equal(spanTileCaption(outside), "No pool here has 7D data");
  assert.match(spanScopeLine(outside, "Robinhood"), /No pool here has 7D data$/);
  assert.ok(model.networks.every((n) => n.volumeUsd === null || n.volumeUsd >= 0));
});

test("a network with volume and no covered pool is a dash and is left off the bars, not drawn as zero", async () => {
  const noEthereum = await analyticsSpanVariant({ omit: (pool) => pool.chain === "ethereum" });
  const lens = createDailyLens(noEthereum.daily, "d7");
  const model = buildSpanModel({
    rows: ledgerSpanRows(noEthereum.overviews["overview-all-h24.json"], generated),
    lens,
  });
  const ethereum = model.networks.find((n) => n.chain === "ethereum");
  assert.equal(ethereum.volumeUsd, null);
  assert.equal(model.span.networks.get("ethereum").of, 3);
  assert.equal(model.totals.volumeUsd, 26850, "ethereum adds nothing to the total");
  assert.equal(model.networks.at(-1).chain, "ethereum", "unmeasured sorts last");
  assert.equal(spanRowPools(model.span.networks.get("ethereum")), "None of 3 pools covered");
});

test("pools younger than the span are counted, and named in the tooltip", () => {
  const total = scope();
  assert.equal(total.young, 1);
  assert.equal(scope({ lens: lens30 }).young, 1);
  assert.match(spanTileTitle(total), /1 of the 7 pools is younger than 7 days and counts from the launch day\./);
  assert.match(spanTileTitle(total), /^At least \$27,650\.00\. The last 7 full days \(UTC\) through 27 Oct, largest pools only\./);
  assert.match(spanTileTitle(total), /The 24H figure can come from another provider\.$/);
  assert.match(spanTileTitle(total), /Read from GeckoTerminal 28 Oct 2026, 00:10 UTC to 28 Oct 2026, 00:16 UTC\./);
});

test("the Data notes repeat what the tile's tooltip says, so a phone can read it: the exact figure, the young pools, when it was read", () => {
  const total = scope();
  const title = spanTileTitle(total);
  const note = spanDetailNote(total);
  assert.match(note, /^The 7D total is at least \$27,650\.00\. 1 of the 7 pools is younger than 7 days and counts from the launch day\. Read from GeckoTerminal /);
  // Everything the tooltip says after its window sentence, word for word and in
  // the same order: one list feeds both.
  const facts = title.slice(title.indexOf("largest pools only. ") + "largest pools only. ".length);
  assert.ok(facts.length > 40);
  assert.ok(note.endsWith(facts), `${note} / ${facts}`);
  assert.match(spanDetailNote(scope({ lens: lens30 })), /^The 30D total is at least \$120,850\.00\. /);
  // A scope with no covered pool has no figure to spell out, and says no number.
  const none = buildSpanScope({ rows: [], lens: lens7 });
  assert.equal(none.usd, null);
  assert.equal(spanDetailNote(none), null);
});

test("the Data notes name the daily pools this snapshot cannot place, as the tooltip does", () => {
  const stale = `ethereum:0x${"9".padStart(64, "0")}`;
  const total = buildSpanScope({ rows, lens: createDailyLens(withExtra(stale), "d7") });
  assert.match(spanDetailNote(total), /1 more pool with daily data is not in this snapshot's current measurements and is left out\. The 24H figure can come from another provider\.$/);
  assert.doesNotMatch(spanDetailNote(scope()), /left out/);
});

test("an unattributed pool (no project) is covered under Unattributed", () => {
  const model = buildSpanModel({ rows, lens: lens7 });
  const slice = model.categories.volume.find((item) => item.category === UNATTRIBUTED);
  assert.equal(slice.value, 100);
  assert.equal(slice.measuredPools, 1);
  assert.equal(model.span.categories.get(UNATTRIBUTED).of, 1);
});

/* ── What the page cannot place ──────────────────────────────────────────── */

const withExtra = (id) => {
  const file = structuredClone(variant.daily);
  file.pools.push({ id, v7: 9, v30: 9, at: "2026-10-28T00:20:00.000Z" });
  file.pools.sort((a, b) => (a.id < b.id ? -1 : 1));
  assert.ok(validateDailyShape(file).ok);
  return file;
};

test("a daily pool this snapshot has no current measurement for is left out of every figure and counted", () => {
  // gamma2's 24H reading is stale: it is in no ledger.
  const stale = `ethereum:0x${"9".padStart(64, "0")}`;
  const file = withExtra(stale);
  const lens = createDailyLens(file, "d7");
  const total = buildSpanScope({ rows, lens });
  assert.equal(total.skipped, 1);
  assert.equal(total.usd, 27650, "the extra pool adds nothing");
  assert.equal(total.covered, 7);
  assert.match(spanTileTitle(total), /1 more pool with daily data is not in this snapshot's current measurements and is left out\./);
  // Out of scope is not "left out": a Base scope does not count it.
  const base = buildSpanScope({ rows: rows.filter((r) => r.chain === "base"), lens, chain: "base" });
  assert.equal(base.skipped, 0);
  assert.equal(buildSpanScope({ rows: rows.filter((r) => r.chain === "ethereum"), lens, chain: "ethereum" }).skipped, 1);
  // The plain file: nothing skipped.
  assert.equal(scope().skipped, 0);
  assert.doesNotMatch(spanTileTitle(scope()), /left out/);
});

test("a pool whose 24H measurement is a reserves-only row is not a measured pool, and its daily figure is skipped", () => {
  const reservesOnly = rows.find((row) => row.usd24 === null);
  const file = withExtra(reservesOnly.id);
  const total = buildSpanScope({ rows, lens: createDailyLens(file, "d7") });
  assert.equal(total.skipped, 1);
  assert.equal(total.of, 8);
  assert.equal(total.usd, 27650);
});

test("an expired row is not matched, and the rule is the one analyticsOverviewAt applies", () => {
  for (const offset of [-3, 0, 1, 2, 4, 5, 6, 8, 10]) {
    const at = generated + offset * MINUTE;
    const measured = ledgerSpanRows(envelope, at).filter((row) => row.usd24 !== null);
    const derived = analyticsOverviewAt(envelope, at);
    assert.equal(
      measured.length,
      derived.totals.volumePools,
      `offset ${offset} min: the same rows are current`,
    );
  }
  assert.equal(ledgerSpanRows(envelope, generated + 20 * MINUTE).length, 0);
  // At the snapshot's own time nothing has expired.
  assert.equal(ledgerSpanRows(envelope, generated).length, envelope.contributions.rows.length);
});

test("a response with no ledger cannot be split, so there is no span", () => {
  const legacy = { ...envelope };
  delete legacy.contributions;
  assert.equal(ledgerSpanRows(legacy, generated), null);
});

test("a file of another run is accepted and flagged; the same run is not", () => {
  assert.equal(scope().crossRun, false);
  assert.equal(scope({ hostAt: "2026-10-28T15:05:00.000Z" }).crossRun, true);
  assert.equal(scope({ hostAt: null }).crossRun, false, "no host to compare with");
});

/* ── The 24H coverage, said as a fact about the covered pools ───────────── */

test("the coverage share is floored to a tenth, never 100% while a measured pool is left out, and null without 24H volume", () => {
  // 4,028 of 4,031 of the tracked 24H volume is held by the seven covered pools.
  const total = scope();
  assert.ok(Math.abs(total.share24 - 4028 / 4031) < 1e-12);
  assert.equal(coveragePercent(total.share24, total.complete), "99.9%");
  assert.equal(coveragePercent(0.97093, false), "97%");
  assert.equal(coveragePercent(0.9709, false), "97%");
  assert.equal(coveragePercent(0.9999, false), "99.9%");
  assert.equal(coveragePercent(1, false), "99.9%");
  assert.equal(coveragePercent(1, true), "100%");
  assert.equal(coveragePercent(0.0004, false), "<0.1%");
  assert.equal(coveragePercent(0, false), "0%");
  assert.equal(coveragePercent(null, true), null);
  assert.equal(coveragePercent(Number.NaN, true), null);
  assert.equal(coveragePercent(0.971, true), "97.1%");
  // Rows with no positive 24H volume have no share to state.
  const flat = buildSpanScope({ rows: rows.map((row) => ({ ...row, usd24: row.usd24 === null ? null : 0 })), lens: lens7 });
  assert.equal(flat.share24, null);
  assert.doesNotMatch(spanScopeLine(flat, "All networks"), /hold/);
  assert.equal(
    spanScopeLine(scope(), "All networks"),
    "Largest hook pools only · All networks · 7D through 27 Oct · 7 pools hold 99.9% of tracked 24H volume",
  );
  const one = buildSpanScope({ rows: rows.filter((row) => row.chain === "robinhood"), lens: lens7, chain: "robinhood" });
  assert.equal(
    spanScopeLine(one, "Robinhood"),
    "Largest hook pools only · Robinhood · 7D through 27 Oct · 1 pool holds 100% of tracked 24H volume",
  );
  // It is a fact about the covered pools and never scales anything: the span
  // figure does not depend on it.
  assert.equal(scope().usd, 27650);
});

test("a row's own coverage sentence, its pool count, and the empty-state words", () => {
  const ethereum = scope().networks.get("ethereum");
  assert.equal(spanRowPools(ethereum), "2 of 3 pools covered");
  assert.match(spanRowCoverage(ethereum), /^The 2 covered pools hold \d+(\.\d)?% of its tracked 24H volume\.$/);
  assert.equal(spanRowCoverage({ ...ethereum, covered: 0, usd: null }), null);
  assert.equal(spanEmptyTitle("7D", "Unichain"), "No 7D volume for Unichain");
  assert.equal(
    spanEmptyText("7D", false),
    "None of its pools is among the largest, so there is no 7D figure. Missing values are never shown as zero.",
  );
  assert.match(spanEmptyText("30D", true), /^None of the pools here is among the largest/);
});

/* ── Words ───────────────────────────────────────────────────────────────── */

test("every writer marks a lower bound, and a dash stays a dash", () => {
  assert.equal(spanFmt.compact(2_307_258_749.3), "≥$2.31B");
  assert.equal(spanFmt.exact(966855896.64), "≥$966,855,896.64");
  assert.equal(spanFmt.spoken(966855896.64), "at least $966,855,896.64");
  assert.equal(spanFmt.compact(0), "≥$0");
  assert.equal(spanFmt.compact(null), "—");
  assert.equal(spanFmt.exact(null), "Not available");
  assert.equal(spanFmt.spoken(null), "Not available");
  assert.equal(spokenCompactUsd(2_307_258_749.3), "$2.31 billion");
  assert.equal(spokenCompactUsd(9_660_000), "$9.66 million");
  assert.equal(spokenCompactUsd(31_200), "$31.2 thousand");
  assert.equal(spokenCompactUsd(12.5), "$12.50");
  const total = scope();
  assert.equal(spanTileSpoken(total), "at least $27.6 thousand, 7D through 27 Oct");
  assert.equal(spanTileCaption(total), "7 of 8 pools · through 27 Oct");
  assert.equal(spanSummaryLine(total), "As of the snapshot · 7D through 27 Oct");
  assert.match(spanMethodNote(total), /^7D and 30D add up each pool's daily volume over full UTC days, from GeckoTerminal, for the largest pools only: the 7 pools here hold 99\.9% of tracked 24H volume\. A completed day does not age, so the five-minute rule is not applied; the figure is dated by its last day\. Totals are at least that much/);
  assert.match(spanMethodNote(total), /Reserves, pools with trading and the evidence below stay at the snapshot's 24H measurements\.$/);
});

test("float residue in a sum is rounded to cents", () => {
  const file = {
    ...variant.daily,
    pools: variant.daily.pools.slice(0, 3).map((pool, index) => ({ ...pool, v7: [0.1, 0.2, 0.3][index], v30: 1 })),
  };
  const lens = createDailyLens(file, "d7");
  const fixed = rows.filter((row) => lens.pool(row));
  assert.equal(fixed.length, 3);
  const total = buildSpanScope({ rows: fixed, lens });
  assert.equal(total.usd, 0.6, "0.1 + 0.2 + 0.3 is 0.6000000000000001 before rounding");
});

/* ── Focus ───────────────────────────────────────────────────────────────── */

test("a focused portion is computed from the same rows and figures, so a focused total equals its own bar", () => {
  const model = buildSpanModel({ rows, lens: lens7 });
  for (const network of model.networks) {
    const focus = spanFocusBreakdown(rows, lens7, { kind: "network", id: network.chain });
    assert.equal(focus.total.value, network.volumeUsd, network.chain);
    assert.equal(focus.total.pools, model.span.networks.get(network.chain).covered);
    assert.equal(
      [...focus.categories.values()].reduce((sum, slice) => sum + (slice.value ?? 0), 0),
      focus.total.value ?? 0,
    );
  }
  for (const slice of model.categories.volume) {
    const focus = spanFocusBreakdown(rows, lens7, { kind: "category", id: slice.category });
    assert.equal(focus.total.value, slice.value, slice.category);
    // The networks inside a use case add up to the use case.
    assert.equal(
      [...focus.networks.values()].reduce((sum, item) => sum + (item.value ?? 0), 0),
      focus.total.value ?? 0,
    );
  }
  const none = spanFocusBreakdown(rows, lens7, { kind: "category", id: "Oracles" });
  assert.equal(none.total.value, null, "a use case with no covered pool: no figure");
  assert.equal(none.metric, "volume");
});

/* ── The two ways in agree ───────────────────────────────────────────────── */

test("the overview's ledger and the workspace's pool rows give the same totals for every network and use case", () => {
  const result = buildAnalytics(variant.snapshot, { chain: "all", windowKey: "h24", now: generated });
  const fromWorkspace = buildSpanScope({ rows: workspaceSpanRows(result.pools), lens: lens7 });
  const fromLedger = scope();
  for (const key of ["usd", "covered", "of", "young", "complete"])
    assert.equal(fromWorkspace[key], fromLedger[key], key);
  assert.ok(Math.abs(fromWorkspace.share24 - fromLedger.share24) < 1e-12);
  for (const [chain, group] of fromLedger.networks)
    assert.deepEqual(
      { usd: fromWorkspace.networks.get(chain).usd, covered: fromWorkspace.networks.get(chain).covered, of: fromWorkspace.networks.get(chain).of },
      { usd: group.usd, covered: group.covered, of: group.of },
      chain,
    );
  for (const [category, group] of fromLedger.categories)
    assert.deepEqual(
      { usd: fromWorkspace.categories.get(category)?.usd, covered: fromWorkspace.categories.get(category)?.covered },
      { usd: group.usd, covered: group.covered },
      category,
    );
  // The workspace has projects; the overview's ledger has none by name.
  assert.ok(fromWorkspace.projects.size > 0);
  assert.equal(fromLedger.projects.size, 0);
  // The same sum the Networks page takes: the lens over the pools.
  assert.equal(lens7.sum(workspaceSpanRows(result.pools).filter((r) => r.usd24 !== null)).usd, fromLedger.usd);
  // Projects partition the attributed covered volume: with the unattributed pools
  // they make up the whole.
  const attributed = [...fromWorkspace.projects.values()].reduce((sum, g) => sum + (g.usd ?? 0), 0);
  const unattributed = fromWorkspace.categories.get(UNATTRIBUTED).usd ?? 0;
  assert.equal(attributed + unattributed, fromWorkspace.usd);
  // A scope of one network: the same figure as the network's own row.
  const base = buildAnalytics(variant.snapshot, { chain: "base", windowKey: "h24", now: generated });
  const baseScope = buildSpanScope({ rows: workspaceSpanRows(base.pools), lens: lens7, chain: "base" });
  assert.equal(baseScope.usd, fromLedger.networks.get("base").usd);
  const baseLedger = ledgerSpanRows(variant.overviews["overview-base-h24.json"], generated);
  assert.equal(buildSpanScope({ rows: baseLedger, lens: lens7, chain: "base" }).usd, baseScope.usd);
});

/* ── Shared words and sorts that must not change ─────────────────────────── */

test("metricCopy without a span says what it always said; with a span only the volume metric changes", () => {
  const was = {
    volume: {
      h1: ["Volume", "Tracked 1H hook-pool volume", "of tracked 1H volume"],
      h6: ["Volume", "Tracked 6H hook-pool volume", "of tracked 6H volume"],
      h24: ["Volume", "Tracked 24H hook-pool volume", "of tracked 24H volume"],
    },
    reserves: ["Reserves", "Tracked pool reserves", "of tracked reserves"],
  };
  for (const window of ["h1", "h6", "h24"]) {
    const copy = metricCopy("volume", window);
    assert.deepEqual([copy.name, copy.measure, copy.denominator], was.volume[window]);
    assert.equal(copy.unit, "USD");
    assert.equal(copy.money, true);
    assert.deepEqual(metricCopy("volume", window, null), copy);
    assert.deepEqual(metricCopy("volume", window, undefined), copy);
    const reserves = metricCopy("reserves", window);
    assert.deepEqual([reserves.name, reserves.measure, reserves.denominator], was.reserves);
    const trading = metricCopy("trading", window);
    assert.deepEqual(
      [trading.name, trading.measure, trading.denominator, trading.unit, trading.money],
      ["Pools with trading", `Pools with ${window.slice(1)}H trading`, "of pools with trading", "pools", false],
    );
    for (const metric of ["reserves", "trading"])
      assert.deepEqual(metricCopy(metric, window, { label: "7D" }), metricCopy(metric, window), `${metric}: a span changes nothing`);
  }
  const span = metricCopy("volume", "h24", { label: "7D" });
  assert.equal(span.name, "7D volume");
  assert.equal(span.measure, "Tracked 7D hook-pool volume, largest pools only");
  assert.equal(span.denominator, "of covered 7D volume");
  assert.equal(poolCategory({ project: null }), UNATTRIBUTED);
});

test("the pool table sorts by the span's figure; a pool with no figure is last, whichever way it is ordered", () => {
  const result = buildAnalytics(variant.snapshot, { chain: "all", windowKey: "h24", now: generated });
  const names = (list) => list.map((row) => `${row.pool.chain}:${row.pool.address.slice(-3)}`);
  const down = sortAnalyticsPools(result.pools, "span", false, "", new Map(), lens7);
  const figures = down.map((row) => lens7.pool(row.pool)?.usd ?? null);
  assert.deepEqual(figures.slice(0, 7), [20000, 5000, 1500, 800, 250, 100, 0]);
  assert.ok(figures.slice(7).every((value) => value === null), "uncovered pools after the covered ones");
  const up = sortAnalyticsPools(result.pools, "span", true, "", new Map(), lens7);
  assert.deepEqual(up.map((row) => lens7.pool(row.pool)?.usd ?? null).slice(0, 7), [0, 100, 250, 800, 1500, 5000, 20000]);
  assert.ok(up.slice(7).every((row) => lens7.pool(row.pool) === null));
  assert.equal(names(down).length, result.pools.length);
  // Without a lens the sort is the same for every pool: ordered by the key.
  assert.deepEqual(
    names(sortAnalyticsPools(result.pools, "span", false)),
    names(sortAnalyticsPools(result.pools, "span", false, "", new Map(), null)),
  );
  // The other sorts are untouched by the new argument.
  assert.deepEqual(
    names(sortAnalyticsPools(result.pools, "volume", false)),
    names(sortAnalyticsPools(result.pools, "volume", false, "", new Map(), lens7)),
  );
});

/* ── The CSV ─────────────────────────────────────────────────────────────── */

test("the CSV carries the span in five more columns only when asked; without it the bytes are what they were", () => {
  const result = buildAnalytics(variant.snapshot, { chain: "all", windowKey: "h24", now: generated });
  const edition = { edition: true, censusAsOf: variant.snapshot.inventory.generatedAt };
  const plain = analyticsCsv(result, edition);
  assert.equal(analyticsCsv(result, { ...edition, span: undefined }), plain);
  assert.equal(analyticsCsv(result), analyticsCsv(result, {}));
  const csv = analyticsCsv(result, { ...edition, span: { label: "7D", through: lens7.through, lens: lens7 } });
  const lines = csv.replace(/^﻿/, "").split("\r\n").filter(Boolean);
  const cells = (line) => line.split('","').map((cell) => cell.replace(/^"|"$/g, ""));
  const head = cells(lines[0]);
  const plainHead = cells(plain.replace(/^﻿/, "").split("\r\n")[0]);
  assert.deepEqual(head.slice(0, plainHead.length), plainHead, "the existing columns come first, unchanged");
  assert.deepEqual(head.slice(plainHead.length), [
    "span_window", "span_through", "span_volume_usd", "span_basis", "span_covered_pools",
  ]);
  const table = lines.slice(1).map(cells).map((row) => Object.fromEntries(head.map((name, i) => [name, row[i]])));
  const summary = table.find((row) => row.row_type === "summary");
  assert.deepEqual(
    [summary.span_window, summary.span_through, summary.span_volume_usd, summary.span_basis, summary.span_covered_pools],
    ["7D", "2026-10-27", "27650", "at_least", "7"],
  );
  const base = table.find((row) => row.row_type === "network" && row.id === "base");
  assert.deepEqual([base.span_volume_usd, base.span_basis, base.span_covered_pools], ["26600", "at_least", "4"]);
  const pools = table.filter((row) => row.row_type === "pool");
  const covered = pools.filter((row) => row.span_basis === "exact");
  assert.equal(covered.length, 7);
  assert.ok(covered.every((row) => row.span_covered_pools === "1"));
  const zero = covered.find((row) => row.span_volume_usd === "0");
  assert.ok(zero, "a real zero is written as 0");
  const open = pools.filter((row) => row.span_basis === "");
  assert.ok(open.length > 0);
  assert.ok(
    open.every((row) => row.span_volume_usd === "" && row.span_covered_pools === "0"),
    "no figure is a blank, never a zero",
  );
  // The 24H columns are what they were.
  const plainRows = plain.replace(/^﻿/, "").split("\r\n").filter(Boolean).map(cells);
  const withSpan = lines.map(cells);
  assert.deepEqual(withSpan.map((row) => row.slice(0, plainHead.length)), plainRows);
});

test("the published file is accepted as the page reads it: parseDaily with the run of the host", () => {
  const read = parseDaily(variant.daily, GENERATED_AT);
  assert.equal(read.ok, true);
});
