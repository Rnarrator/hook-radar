import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import {
  CLOCK_BEHIND_NOTE,
  CLOCK_BEHIND_TOLERANCE_MS,
  REFRESH_NOTE,
  SNAPSHOT_STALE_AFTER_MS,
  parseRunTimes,
  runTimesFor,
  snapshotAge,
  snapshotStatusLine,
} from "../src/edition.ts";
import { providerSources } from "../collector/assemble.mjs";
import { PROVIDERS } from "../collector/config.mjs";
import { GENERATED_AT } from "./fixtures/static-data/generate.mjs";

// The edition's status line, run block, census label and footer credit: the
// rules in src/edition.ts, and the components that print them (rendered on the
// server, the way tests/market-coverage-render.test.mjs renders a component).

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
    output = output.replaceAll(
      JSON.stringify(specifier),
      JSON.stringify(target),
    );
  }
  return `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`;
}

const model = new URL("../src/model.ts", import.meta.url).href;
const icons = await componentModule("../src/components/Icons.tsx");
const primitives = await componentModule("../src/components/Primitives.tsx", {
  "../model": model,
  "./Icons": icons,
});
const status = await componentModule("../src/components/EditionStatus.tsx", {
  "../edition": new URL("../src/edition.ts", import.meta.url).href,
  "../model": model,
  "./Icons": icons,
  "./Primitives": primitives,
});
const { EditionCensus, EditionRunTimes, SnapshotLine, SourceCredit } =
  await import(status);

const plain = (html) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/ ([.,;])/g, "$1")
    .trim();
const fixture = (name) =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/static-data/data/${name}`, import.meta.url),
      "utf8",
    ),
  );

const generated = Date.parse(GENERATED_AT);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const TAKEN = "28 Oct 2026, 14:05 UTC";

/** The line as a visitor reads it when their clock says `visitorNow`. */
function renderLine(t, visitorNow, props = {}) {
  t.mock.method(Date, "now", () => visitorNow);
  return renderToStaticMarkup(
    createElement(SnapshotLine, { generatedAt: GENERATED_AT, ...props }),
  );
}

/* ── The status line: fresh, stale, and a clock that is behind ─────────── */

test("a fresh snapshot keeps the line it always had, up to four hours", () => {
  assert.equal(SNAPSHOT_STALE_AFTER_MS, 4 * HOUR);
  for (const [after, age] of [
    [30 * MINUTE, "30 min ago"],
    [HOUR, "1 h ago"],
    [4 * HOUR, "4 h ago"],
  ]) {
    const line = snapshotStatusLine(GENERATED_AT, generated + after);
    assert.equal(line.taken, `Snapshot taken ${TAKEN}`, age);
    assert.equal(line.note, REFRESH_NOTE, age);
    assert.equal(line.note, "refreshed every few hours", age);
    assert.equal(line.age, age);
    assert.equal(line.stale, false, age);
    assert.equal(line.staleText, null, age);
  }
});

test("past four hours the rhythm is dropped and the line says the snapshot is old", () => {
  for (const [after, span] of [
    [4 * HOUR + MINUTE, "4 h 1 min"],
    [5 * HOUR, "5 h"],
    [13 * HOUR, "13 h"],
    [26 * HOUR, "1 d 2 h"],
    [3 * DAY, "3 d"],
    [40 * DAY, "40 d"],
  ]) {
    const line = snapshotStatusLine(GENERATED_AT, generated + after);
    assert.equal(line.stale, true, span);
    assert.equal(
      line.note,
      null,
      `${span}: no cadence claim beside an old age`,
    );
    assert.equal(
      line.staleText,
      `By this device’s clock, this snapshot is ${span} old; newer data should have been published.`,
    );
    assert.equal(line.takenAt, TAKEN);
    // The plain age is still available for anything that wants it.
    assert.equal(line.age, `${span} ago`);
  }
  // One millisecond past the limit is already stale; the limit itself is not.
  assert.equal(
    snapshotStatusLine(GENERATED_AT, generated + SNAPSHOT_STALE_AFTER_MS).stale,
    false,
  );
  assert.equal(
    snapshotStatusLine(GENERATED_AT, generated + SNAPSHOT_STALE_AFTER_MS + 1)
      .stale,
    true,
  );
});

test("a visitor clock behind the snapshot never reads 'just now'", () => {
  assert.equal(CLOCK_BEHIND_TOLERANCE_MS, 5 * MINUTE);
  // Ordinary drift, up to five minutes, is still "just now".
  for (const behind of [0, MINUTE, 4 * MINUTE, 5 * MINUTE]) {
    const line = snapshotStatusLine(GENERATED_AT, generated - behind);
    assert.equal(line.age, "just now", `${behind / MINUTE} min behind`);
    assert.equal(line.stale, false);
    assert.equal(line.note, REFRESH_NOTE);
  }
  // Further behind it is a wrong clock: no age, said so, and never stale.
  for (const behind of [5 * MINUTE + 1, 6 * MINUTE, HOUR, 3 * HOUR, 3 * DAY]) {
    const line = snapshotStatusLine(GENERATED_AT, generated - behind);
    assert.equal(line.age, CLOCK_BEHIND_NOTE, `${behind / MINUTE} min behind`);
    assert.notEqual(line.age, "just now");
    assert.equal(line.stale, false);
    assert.equal(line.staleText, null);
    assert.equal(line.taken, `Snapshot taken ${TAKEN}`);
  }
  assert.match(CLOCK_BEHIND_NOTE, /clock is behind/);
});

test("a time that is not a time has no status line", () => {
  assert.equal(snapshotStatusLine("garbage", generated), null);
  assert.equal(snapshotStatusLine("", generated), null);
});

test("the plain age helper is unchanged: the line, not the helper, handles a clock that is behind", () => {
  assert.equal(snapshotAge(generated, generated + 3 * DAY), "3 d ago");
  assert.equal(snapshotAge(generated, generated - HOUR), "just now");
  assert.equal(snapshotAge("garbage", generated), null);
});

/* ── The status line as rendered ───────────────────────────────────────── */

test("a fresh line renders as before: taken, rhythm, age, amber light", (t) => {
  const html = renderLine(t, generated + 30 * MINUTE + 20_000);
  assert.equal(
    plain(html),
    `Snapshot taken ${TAKEN} · refreshed every few hours · 30 min ago`,
  );
  assert.match(html, /<p class="snapshot-line" data-testid="snapshot-line">/);
  assert.match(html, /class="status-led amber"/);
  assert.doesNotMatch(html, /is-stale/);
  assert.equal(html.match(/<time /g).length, 1);
  assert.match(html, new RegExp(`<time dateTime="${GENERATED_AT}">`));
});

test("a stale line says so plainly, with the time its figures are from", (t) => {
  for (const [after, span] of [
    [13 * HOUR, "13 h"],
    [3 * DAY, "3 d"],
    [40 * DAY, "40 d"],
  ]) {
    const html = renderLine(t, generated + after + 20_000);
    const text = plain(html);
    assert.equal(
      text,
      // A late snapshot ends with the way to settle it: until the status check
      // has named a newer run the page cannot tell a late site from an old tab.
      `By this device’s clock, this snapshot is ${span} old; newer data should have been published. Figures are from ${TAKEN}. Reload this page to check for a newer one.`,
    );
    assert.match(html, /class="snapshot-line is-stale"/);
    assert.match(html, /data-testid="snapshot-line"/);
    assert.doesNotMatch(html, /status-led amber/);
    assert.doesNotMatch(text, /refreshed every few hours/);
    assert.doesNotMatch(text, / ago/);
    // The figures' time is still a machine-readable time, once.
    assert.equal(html.match(/<time /g).length, 1);
    assert.match(
      html,
      new RegExp(`<time dateTime="${GENERATED_AT}">${TAKEN}</time>`),
    );
    t.mock.restoreAll();
  }
});

test("a line passed a class keeps it, fresh or stale", (t) => {
  assert.match(
    renderLine(t, generated + MINUTE, { className: "wide" }),
    /class="snapshot-line wide"/,
  );
  t.mock.restoreAll();
  assert.match(
    renderLine(t, generated + 2 * DAY, { className: "wide" }),
    /class="snapshot-line is-stale wide"/,
  );
});

test("a wrong device clock is named instead of 'just now'", (t) => {
  const text = plain(renderLine(t, generated - 3 * HOUR));
  assert.equal(
    text,
    `Snapshot taken ${TAKEN} · refreshed every few hours · this device’s clock is behind`,
  );
  assert.doesNotMatch(text, /just now/);
});

test("a snapshot taken a minute ago is 'just now', not a clock complaint", (t) => {
  const text = plain(renderLine(t, generated + 20_000));
  assert.match(text, /· just now$/);
});

// The page cannot tell a snapshot that is late from a visitor clock that is set
// ahead, so the warning names the clock it rests on instead of stating the age
// as a fact about the snapshot.
test("the stale warning rests on this device's clock, and says so", (t) => {
  // A snapshot published a moment ago, read on a clock set 13 hours ahead,
  // gets the same line as a snapshot that really is 13 hours old.
  const ahead = plain(renderLine(t, generated + 13 * HOUR));
  t.mock.restoreAll();
  assert.match(ahead, /^By this device’s clock, this snapshot is 13 h old; /);
  assert.doesNotMatch(ahead, /^This snapshot/);
  for (const after of [4 * HOUR + MINUTE, 3 * DAY, 40 * DAY]) {
    const line = snapshotStatusLine(GENERATED_AT, generated + after);
    assert.match(line.staleText, /^By this device’s clock, this snapshot is /);
    assert.match(line.staleText, /; newer data should have been published\.$/);
  }
  // Lines that make no claim about being old do not carry the qualifier.
  for (const offset of [MINUTE, 4 * HOUR, -3 * HOUR]) {
    const line = snapshotStatusLine(GENERATED_AT, generated + offset);
    assert.equal(line.staleText, null);
  }
  const fresh = plain(renderLine(t, generated + HOUR));
  assert.doesNotMatch(fresh, /By this device/);
});

// Beside the strip's two buttons the longer stale sentence must wrap on its own
// side. Measured in Chrome with the real data, without these rules the buttons
// wrapped onto two lines between 961 and about 1150 px.
test("the stale line leaves the strip's buttons their width where the strip is a row", () => {
  const css = readFileSync(
    new URL("../src/components/edition.css", import.meta.url),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const shell = readFileSync(
    new URL("../src/design/shell.css", import.meta.url),
    "utf8",
  ).replace(/\r\n/g, "\n");
  // The strip stacks at 60rem and below; the rules start one pixel above it.
  assert.match(
    shell,
    /@media \(max-width: 60rem\) \{\s*\.coverage-strip \{\s*flex-direction: column;/,
  );
  const row = css.match(
    /@media \(min-width: 60\.0625rem\) \{\n([\s\S]*?)\n\}\n/,
  );
  assert.ok(row, "no min-width: 60.0625rem block in edition.css");
  const rules = row[1];
  assert.match(
    rules,
    /\.coverage-strip > \.snapshot-line\.is-stale \{\s*flex: 1 1 0;\s*min-width: 0;\s*\}/,
  );
  assert.match(
    rules,
    /\.coverage-strip > \.snapshot-line\.is-stale \+ \.coverage-actions \{\s*flex: none;\s*\}/,
  );
  // Stacked (a column), a zero flex basis would collapse the line's height.
  assert.doesNotMatch(css.replace(row[0], ""), /flex: 1 1 0/);
});

/* ── The collection run belongs to the snapshot beside it ──────────────── */

test("the status file names the run it describes", () => {
  const run = parseRunTimes(fixture("status.json"));
  assert.equal(run.generatedAt, GENERATED_AT);
  assert.equal(run.burstEndedAt, GENERATED_AT);
  assert.equal(run.previousGeneratedAt, "2026-10-28T11:04:41.000Z");
  // A name with no times of the run's own is nothing to show.
  assert.equal(parseRunTimes({ generatedAt: GENERATED_AT }), null);
  // A name that is not a time is not kept, but the times still are.
  const unnamed = parseRunTimes({
    generatedAt: "soon",
    burstEndedAt: GENERATED_AT,
  });
  assert.equal(unnamed.generatedAt, null);
  assert.equal(unnamed.burstEndedAt, GENERATED_AT);
  assert.equal(
    parseRunTimes({ generatedAt: 5, burstEndedAt: GENERATED_AT }).generatedAt,
    null,
  );
});

test("run times are matched to the snapshot on the page by the run's own time", () => {
  const run = parseRunTimes(fixture("status.json"));
  // Same run: shown, however the instant is written.
  assert.equal(runTimesFor(run, GENERATED_AT), run);
  assert.equal(runTimesFor(run, "2026-10-28T14:05:00+00:00"), run);
  assert.equal(runTimesFor(run, generated), run);
  // A later or earlier deploy: not shown.
  assert.equal(
    runTimesFor(run, new Date(generated - 3 * HOUR).toISOString()),
    null,
  );
  assert.equal(runTimesFor(run, new Date(generated + 1).toISOString()), null);
  // A status file that does not say which run it is cannot be matched.
  const unnamed = { ...run, generatedAt: null };
  assert.equal(runTimesFor(unnamed, GENERATED_AT), null);
  // An unreadable snapshot time cannot match anything.
  assert.equal(runTimesFor(run, null), null);
  assert.equal(runTimesFor(run, "garbage"), null);
  // Without a snapshot time to compare (the prop absent) it behaves as before.
  assert.equal(runTimesFor(run), run);
  assert.equal(runTimesFor(run, undefined), run);
  assert.equal(runTimesFor(null, GENERATED_AT), null);
  assert.equal(runTimesFor(null), null);
});

test("the run block prints only the run that made the snapshot", () => {
  const run = parseRunTimes(fixture("status.json"));
  const show = (snapshotAt) =>
    renderToStaticMarkup(createElement(EditionRunTimes, { run, snapshotAt }));

  const same = plain(show(GENERATED_AT));
  assert.match(same, /Collection started 28 Oct 2026, 13:41 UTC/);
  // Both ends in one form (each with its date): the start used to be the short
  // same-day "14:01 UTC" beside an end that carried the date.
  assert.match(
    same,
    /Measurements taken 28 Oct 2026, 14:01 UTC to 28 Oct 2026, 14:05 UTC/,
  );
  assert.match(same, /Previous snapshot 28 Oct 2026, 11:04 UTC/);

  // The tab outlived a deploy: the status file is the next run's. Nothing is
  // printed rather than another run's times under this snapshot's date.
  const later = new Date(generated + 3 * HOUR).toISOString();
  assert.equal(show(later), "");
  assert.equal(
    renderToStaticMarkup(
      createElement(EditionRunTimes, {
        run: { ...run, generatedAt: later },
        snapshotAt: GENERATED_AT,
      }),
    ),
    "",
  );

  // No snapshot time passed: as today.
  assert.equal(plain(show(undefined)), same);
  assert.equal(
    renderToStaticMarkup(createElement(EditionRunTimes, { run: null })),
    "",
  );
});

// EditionRun reads the status file in an effect, which a server render never
// runs, so what it hands the block is read from its source.
test("the component that reads the status file hands the block the snapshot's time", () => {
  const text = readFileSync(
    new URL("../src/components/EditionStatus.tsx", import.meta.url),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const reader = text.slice(text.indexOf("export function EditionRun("));
  assert.match(
    reader,
    /export function EditionRun\(\{ snapshotAt \}: \{ snapshotAt\?: string \}\)/,
  );
  assert.match(
    reader,
    /<EditionRunTimes run=\{run\} snapshotAt=\{snapshotAt\} \/>/,
  );
  assert.match(reader, /parseRunTimes\(await response\.json\(\)\)/);
});

/* ── The census block does not claim an export time ────────────────────── */

test("the census block is dated 'As of', and claims no export time", () => {
  const snapshot = fixture("snapshot.json");
  // The real census is exported after the moment it describes: the block only
  // knows the moment it describes.
  const asOf = "2026-10-27T21:08:49.927Z";
  const html = renderToStaticMarkup(
    createElement(EditionCensus, {
      snapshot: {
        ...snapshot,
        inventory: { ...snapshot.inventory, generatedAt: asOf },
      },
    }),
  );
  const text = plain(html);
  assert.match(text, /Census as of 27 Oct 2026/);
  assert.match(text, /As of 27 Oct 2026, 21:08 UTC/);
  assert.doesNotMatch(text, /exported/i);
});

/* ── The footer credit ─────────────────────────────────────────────────── */

// The credit is built from the sources the snapshot on the page names (one per
// provider the collector used; "unavailable" when it supplied nothing).
const everySource = [
  "registry",
  "chains",
  "frontier-chains",
  "dexscreener",
  "geckoterminal",
  "v4xyz",
  "census",
].map((id) => ({ id, status: id === "census" ? "cached" : "live" }));
const without = (...ids) =>
  everySource.filter((source) => !ids.includes(source.id));
const unavailable = (...ids) =>
  everySource.map((source) =>
    ids.includes(source.id) ? { ...source, status: "unavailable" } : source,
  );
const credit = (sources) =>
  plain(renderToStaticMarkup(createElement(SourceCredit, { sources })));

test("the credit says what each service did, when the run names them all", () => {
  const html = renderToStaticMarkup(
    createElement(SourceCredit, { sources: everySource }),
  );
  assert.equal(
    plain(html),
    "Prices from DEX Screener, with GeckoTerminal for pool discovery and as a fallback. Hooks from the Uniswap hooklist. Hook and pool identities from the v4.xyz indexer. Deployment configuration from Frontier. The pool census is Hook Radar’s own index of PoolManager events.",
  );
  assert.match(html, /data-testid="source-credit"/);
  // GeckoTerminal measured nothing in some runs: it is never "market data".
  assert.doesNotMatch(plain(html), /market data/i);
  // One name for the indexer, as on the Data & sources cards.
  assert.doesNotMatch(html, /Envio|envio\.dev/);
  assert.doesNotMatch(plain(html), /census from/i);
});

test("the credit credits only the services the snapshot's sources say supplied something", () => {
  const FULL = plain(
    renderToStaticMarkup(createElement(SourceCredit, { sources: everySource })),
  );
  // DEX Screener supplied nothing in this run: it is not credited, and
  // GeckoTerminal is no "fallback" for prices that were never measured by it.
  const noDex = credit(unavailable("dexscreener"));
  assert.doesNotMatch(noDex, /DEX Screener/);
  assert.match(
    noDex,
    /^Prices and pool discovery from GeckoTerminal\. Hooks from the Uniswap hooklist\./,
  );
  assert.equal(credit(without("dexscreener")), noDex, "absent is unavailable");
  // GeckoTerminal is not in the list: DEX Screener alone measures.
  const noGecko = credit(without("geckoterminal"));
  assert.doesNotMatch(noGecko, /GeckoTerminal/);
  assert.match(
    noGecko,
    /^Prices from DEX Screener\. Hooks from the Uniswap hooklist\./,
  );
  assert.equal(credit(unavailable("geckoterminal")), noGecko);
  // Frontier's configuration was not available: no credit for it.
  const noFrontier = credit(unavailable("frontier-chains"));
  assert.doesNotMatch(noFrontier, /Frontier|Deployment configuration/);
  assert.equal(credit(without("frontier-chains")), noFrontier);
  assert.equal(
    noFrontier,
    FULL.replace(" Deployment configuration from Frontier.", ""),
  );
  // Each of the others, one at a time.
  assert.doesNotMatch(credit(unavailable("registry")), /hooklist/);
  assert.doesNotMatch(credit(unavailable("v4xyz")), /v4\.xyz/);
  assert.doesNotMatch(credit(unavailable("census")), /census/);
  // A source the registry lists twice or that the credit does not know
  // ("chains", an invented one) adds nothing.
  assert.equal(
    credit([...everySource, { id: "invented", status: "live" }]),
    FULL,
  );
  assert.equal(credit(without("chains")), FULL);
  // Nothing supplied, no list, or a list that is not one: no sentence at all,
  // not an empty paragraph (the footer keeps its Data & sources button).
  for (const sources of [
    undefined,
    null,
    [],
    "dexscreener",
    unavailable(...everySource.map((source) => source.id)),
  ])
    assert.equal(
      renderToStaticMarkup(createElement(SourceCredit, { sources })),
      "",
      String(sources),
    );
  // A page that loads no snapshot passes none.
  assert.equal(renderToStaticMarkup(createElement(SourceCredit)), "");
});

test("Frontier is credited for its own pools' figures only when the run read its coin listing", () => {
  const withMarkets = [
    ...everySource,
    { id: "frontier-coins", status: "live" },
    { id: "frontier-stats", status: "live" },
    { id: "frontier-amm-index", status: "live" },
  ];
  const text = credit(withMarkets);
  assert.equal(
    text,
    "Prices from DEX Screener, with GeckoTerminal for pool discovery and as a fallback. Figures for Frontier’s own pools from Frontier and its public AMM index. Hooks from the Uniswap hooklist. Hook and pool identities from the v4.xyz indexer. Deployment configuration from Frontier. The pool census is Hook Radar’s own index of PoolManager events.",
  );
  // Unavailable or absent: no such sentence, and the rest is what it was.
  for (const sources of [
    withMarkets.map((source) =>
      source.id === "frontier-coins"
        ? { ...source, status: "unavailable" }
        : source,
    ),
    everySource,
  ])
    assert.doesNotMatch(credit(sources), /Figures for Frontier/);
  // Its configuration alone is the deployment credit, as before.
  assert.match(credit(everySource), /Deployment configuration from Frontier\./);
});

test("the credit links are the ones on the Data & sources cards", () => {
  const html = renderToStaticMarkup(
    createElement(SourceCredit, { sources: everySource }),
  );
  const links = Object.fromEntries(
    [...html.matchAll(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g)].map((m) => [
      plain(m[2]),
      m[1],
    ]),
  );
  // What the collector writes on each card.
  const at = Date.parse("2026-10-28T13:50:00.000Z");
  const lane = {
    requests: 3,
    succeeded: 3,
    firstRequestAt: at,
    lastRequestAt: at,
    stopped: null,
  };
  const card = Object.fromEntries(
    providerSources({
      stats: { dexscreener: lane, geckoterminal: lane, v4xyz: lane },
      measured: new Map([
        [
          "a",
          {
            metricProvider: "dexscreener",
            metricUpdatedAt: "2026-10-28T14:00:00.000Z",
          },
        ],
      ]),
      discovery: {
        geckoPages: 2,
        indexerLists: 3,
        indexerListed: 10,
        resolvesTried: 4,
      },
      census: {
        exportedAt: "2026-10-28T10:00:00.000Z",
        inventory: { generatedAt: "2026-10-27T20:11:09.000Z" },
      },
      registrySources: [
        {
          id: "registry",
          name: "Uniswap hooklist",
          url: "https://github.com/Uniswap/hooklist",
        },
      ],
    }).map((source) => [source.id, new URL(source.url).href]),
  );
  assert.deepEqual(links, {
    "DEX Screener": card.dexscreener,
    GeckoTerminal: card.geckoterminal,
    "Uniswap hooklist": card.registry,
    "v4.xyz indexer": card.v4xyz,
    Frontier: new URL(PROVIDERS.frontier.url).href,
  });
  for (const rel of html.matchAll(/<a [^>]*rel="([^"]+)"/g))
    assert.match(rel[1], /noopener/);
});
