// How old the census was when the snapshot was taken, said on the figures that
// come from it. The age is whole UTC days between the census date and the
// snapshot's date, worked out from the two times the data carries, never from
// the visitor's clock. Only wording changes: no figure becomes null or zero.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import {
  CENSUS_HOOKS_SCOPE,
  censusAgeDays,
  censusAgeText,
  censusHeading,
  censusLabel,
} from "../src/edition.ts";

const CENSUS = "2026-10-27T21:08:49.000Z";
const inventory = { generatedAt: CENSUS };

test("the age is the difference of the two dates the page shows", () => {
  // The real figures: the census of 27 Oct 2026 and a snapshot of 11 Nov 2026.
  assert.equal(censusAgeDays(CENSUS, "2026-11-11T14:30:41.000Z"), 15);
  // 14.7 days apart, as in the first week of the edition: 15, as 27 Oct to 11 Nov.
  assert.equal(censusAgeDays(CENSUS, "2026-11-11T10:30:00.000Z"), 15);
  // 14.45 days apart still reads 15: the dates differ by 15.
  assert.equal(censusAgeDays(CENSUS, "2026-11-11T08:00:00.000Z"), 15);
  // Less than a day apart across midnight is still a different date.
  assert.equal(
    censusAgeDays("2026-10-27T23:59:59.000Z", "2026-10-28T00:00:01.000Z"),
    1,
  );
  // The same date, hours apart: the same day. The same instant too.
  assert.equal(censusAgeDays(CENSUS, "2026-10-27T23:00:00.000Z"), 0);
  assert.equal(censusAgeDays(CENSUS, CENSUS), 0);
  assert.equal(censusAgeDays(CENSUS, "2026-10-28T21:08:49.000Z"), 1);
  assert.equal(censusAgeDays(CENSUS, "2026-10-29T00:00:00.000Z"), 2);
  assert.equal(censusAgeDays(CENSUS, "2027-10-27T00:00:00.000Z"), 365);
  // Times given as milliseconds work too.
  assert.equal(
    censusAgeDays(Date.parse(CENSUS), Date.parse("2026-11-11T00:00:00Z")),
    15,
  );
});

test("an age that cannot be right is not shown", () => {
  // A census newer than the snapshot (a clock or file mix-up): no age.
  assert.equal(
    censusAgeDays("2026-11-12T00:00:00.000Z", "2026-11-11T14:30:41.000Z"),
    null,
  );
  assert.equal(
    censusAgeDays("2026-10-28T00:00:00.000Z", "2026-10-27T23:59:59.000Z"),
    null,
  );
  // A missing or unreadable time on either side.
  for (const bad of [null, undefined, "", "bad", "2026-13-45", Number.NaN])
    assert.equal(
      censusAgeDays(bad, "2026-11-11T14:30:41.000Z"),
      null,
      String(bad),
    );
  for (const bad of [null, undefined, "", "bad", Number.NaN])
    assert.equal(censusAgeDays(CENSUS, bad), null, String(bad));
});

test("the age in words", () => {
  assert.equal(censusAgeText(0), "the same day as this snapshot");
  assert.equal(censusAgeText(1), "the day before this snapshot");
  assert.equal(censusAgeText(2), "2 days before this snapshot");
  assert.equal(censusAgeText(15), "15 days before this snapshot");
  assert.equal(censusAgeText(365), "365 days before this snapshot");
  for (const bad of [null, undefined, -1, 1.5, Number.NaN, Infinity])
    assert.equal(censusAgeText(bad), null, String(bad));
});

test("the census label carries the age only when the snapshot's time is given and later", () => {
  // Without the snapshot's time the label is the one it always was.
  assert.equal(censusLabel(inventory), "census as of 27 Oct 2026");
  assert.equal(censusHeading(inventory), "Census as of 27 Oct 2026");
  assert.equal(
    censusLabel(inventory, "2026-11-11T14:30:41.000Z"),
    "census as of 27 Oct 2026, 15 days before this snapshot",
  );
  assert.equal(
    censusHeading(inventory, "2026-11-11T14:30:41.000Z"),
    "Census as of 27 Oct 2026, 15 days before this snapshot",
  );
  assert.equal(
    censusLabel(inventory, "2026-10-27T23:00:00.000Z"),
    "census as of 27 Oct 2026, the same day as this snapshot",
  );
  assert.equal(
    censusLabel(inventory, "2026-10-28T00:10:00.000Z"),
    "census as of 27 Oct 2026, the day before this snapshot",
  );
  // A census newer than the snapshot, or a snapshot time that is missing or
  // unreadable: the date stays, no age is claimed.
  for (const snapshotAt of [
    "2026-10-01T00:00:00.000Z",
    null,
    undefined,
    "",
    "bad",
  ])
    assert.equal(
      censusLabel(inventory, snapshotAt),
      "census as of 27 Oct 2026",
      String(snapshotAt),
    );
  // No census date, no label, whatever the snapshot says.
  for (const missing of [
    null,
    undefined,
    { generatedAt: "bad" },
    { generatedAt: "" },
  ])
    assert.equal(censusLabel(missing, "2026-11-11T14:30:41.000Z"), null);
  assert.equal(censusHeading(null, "2026-11-11T14:30:41.000Z"), null);
});

test("nothing here reads the visitor's clock", async () => {
  const source = await readFile(
    new URL("../src/edition.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("const DAY_MS");
  const end = source.indexOf("export const CENSUS_HOOKS_SCOPE");
  const block = source.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.doesNotMatch(block, /Date\.now|new Date\(\)|performance\.now/);
  // And censusLabel gives the same answer whatever the clock says.
  const real = Date.now;
  try {
    for (const fake of [0, Date.parse("2030-01-01T00:00:00Z")]) {
      Date.now = () => fake;
      assert.equal(
        censusLabel(inventory, "2026-11-11T14:30:41.000Z"),
        "census as of 27 Oct 2026, 15 days before this snapshot",
      );
    }
  } finally {
    Date.now = real;
  }
});

// ---- the masthead tiles, with the edition flag on and off ------------------

async function mastheadModule(edition) {
  const source = await readFile(
    new URL("../src/components/Masthead.tsx", import.meta.url),
    "utf8",
  );
  const flag = `data:text/javascript,${encodeURIComponent(
    `export const STATIC_EDITION = ${edition}; export const CENSUS_HOOKS_SCOPE = ${JSON.stringify(CENSUS_HOOKS_SCOPE)};`,
  )}`;
  let output = ts.transpileModule(source, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  for (const [specifier, target] of Object.entries({
    "react/jsx-runtime": import.meta.resolve("react/jsx-runtime"),
    "../model": new URL("../src/model.ts", import.meta.url).href,
    "../edition": flag,
  }))
    output = output.replaceAll(
      JSON.stringify(specifier),
      JSON.stringify(target),
    );
  return import(
    `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`
  );
}

const text = (markup) =>
  markup
    .replace(/<[^>]+>/g, "")
    .replaceAll("&amp;", "&")
    .replaceAll("&#x27;", "'");

const FIGURES = {
  projects: 120,
  hooks: 348449,
  pools: 15908190,
  networks: 22,
};
const LABEL = "census as of 27 Oct 2026, 15 days before this snapshot";

test("in the edition the Hooks tile reads 'at least' and one line says how old the census is", async () => {
  const { MastheadFigures } = await mastheadModule(true);
  const markup = renderToStaticMarkup(
    createElement(MastheadFigures, { ...FIGURES, census: LABEL }),
  );
  const words = text(markup);
  assert.match(words, /Hooksat least 348,449found onchain/);
  assert.match(words, /Pools15,908,190using a hook/);
  assert.match(words, /Projects120listed by name/);
  assert.match(words, /Networks22with indexed pools/);
  // Only the hook total is a lower bound.
  assert.equal((words.match(/at least/g) ?? []).length, 1);
  assert.match(
    words,
    new RegExp(
      `Hooks, pools and networks: ${LABEL.replaceAll(".", "\\.")}\\. A hook used on two networks is counted on both; newer hooks are not included\\.$`,
    ),
  );
  assert.match(
    markup,
    /title="Hook contracts found by the census; the same address on two networks counts twice\."/,
  );
});

test("an unavailable hook total stays unavailable and a measured zero stays a zero", async () => {
  const { MastheadFigures } = await mastheadModule(true);
  const missing = text(
    renderToStaticMarkup(
      createElement(MastheadFigures, {
        ...FIGURES,
        hooks: null,
        census: LABEL,
      }),
    ),
  );
  assert.match(missing, /Hooks—found onchain/);
  assert.doesNotMatch(missing, /at least/);
  const zero = text(
    renderToStaticMarkup(
      createElement(MastheadFigures, {
        ...FIGURES,
        hooks: 0,
        pools: 0,
        census: LABEL,
      }),
    ),
  );
  assert.match(zero, /Hooksat least 0found onchain/);
  assert.match(zero, /Pools0using a hook/);
});

test("the census line without an age says only the date, and no census says nothing", async () => {
  const { MastheadFigures } = await mastheadModule(true);
  const dated = text(
    renderToStaticMarkup(
      createElement(MastheadFigures, {
        ...FIGURES,
        census: "census as of 27 Oct 2026",
      }),
    ),
  );
  assert.match(
    dated,
    /Hooks, pools and networks: census as of 27 Oct 2026\. A hook used on two networks is counted on both; newer hooks are not included\.$/,
  );
  const none = renderToStaticMarkup(
    createElement(MastheadFigures, { ...FIGURES, census: null }),
  );
  assert.doesNotMatch(none, /masthead-census/);
});

test("without the edition the masthead is what it always was", async () => {
  const { MastheadFigures } = await mastheadModule(false);
  const markup = renderToStaticMarkup(
    createElement(MastheadFigures, { ...FIGURES, census: null }),
  );
  assert.doesNotMatch(markup, /at least|masthead-bound|masthead-census/);
  assert.equal(
    text(markup),
    "Projects120listed by nameHooks348,449found onchainPools15,908,190using a hookNetworks22chains we follow",
  );
  assert.match(
    markup,
    /title="Individual hook contracts that Radar has found onchain\."/,
  );
  // The same four figures as in the edition: only the words around them differ.
  const edition = text(
    renderToStaticMarkup(
      createElement((await mastheadModule(true)).MastheadFigures, {
        ...FIGURES,
        census: null,
      }),
    ),
  );
  for (const figure of ["120", "348,449", "15,908,190", "22"])
    assert.ok(edition.includes(figure), figure);
});

test("the wording is behind the edition flag wherever the explorer and analytics show a hook count", async () => {
  const read = async (path) =>
    (
      await readFile(new URL(`../src/${path}`, import.meta.url), "utf8")
    ).replace(/\r\n/g, "\n");
  const explorer = await read("components/ChainExplorer.tsx");
  for (const [edition, live] of [
    ["Hook contracts found (at least)", "Hook contracts indexed"],
    ["Hook contracts found (at least)", "Indexed hook contracts"],
    ["Blocks scanned at the census", "Blocks scanned"],
  ]) {
    const at = explorer.indexOf(`"${edition}"`);
    assert.ok(at > 0, `the explorer says "${edition}"`);
    assert.match(explorer.slice(at - 80, at + 120), /STATIC_EDITION/);
    assert.ok(explorer.includes(`"${live}"`), `the live "${live}" stays`);
  }
  // Every call that dates a census figure passes the snapshot's own time.
  for (const [file, call] of [
    [
      "components/ChainExplorer.tsx",
      "censusLabel(snapshot.inventory, snapshot.generatedAt)",
    ],
    [
      "components/MarketCoverage.tsx",
      "censusLabel(snapshot.inventory, snapshot.generatedAt)",
    ],
    [
      "components/AnalyticsWorkspace.tsx",
      "censusLabel(snapshot.inventory, snapshot.generatedAt)",
    ],
    [
      "components/AnalyticsOverview.tsx",
      "censusLabel(envelope.inventory, envelope.publication.generatedAt)",
    ],
    ["App.tsx", "censusLabel(inventoryFigures, snapshot?.generatedAt)"],
  ])
    assert.ok((await read(file)).includes(call), `${file}: ${call}`);
  const analytics = await read("components/AnalyticsWorkspace.tsx");
  assert.match(
    analytics,
    /STATIC_EDITION \? "Hook contracts \(at least\)" : "Hook contracts"/,
  );
  assert.match(
    analytics,
    /STATIC_EDITION && " Newer hooks are not included\."/,
  );
  // The sentence of a network no project lists already names its census date
  // and says "at least" when that network's scan was unfinished: it is left as it was.
  const catalog = await read("components/ChainProtocolCatalog.tsx");
  assert.match(catalog, /network\.caughtUp \? "" : "at least "/);
});

test("the two census hook figures that once had no mark say 'at least' in the edition, and read as before without it", async () => {
  const read = async (path) =>
    (
      await readFile(new URL(`../src/${path}`, import.meta.url), "utf8")
    ).replace(/\r\n/g, "\n");
  // Networks, the evidence beside the composition chart: the card above it says
  // "Hook contracts found (at least)", so this row names the same figure the same way.
  const charts = await read("components/ChainCharts.tsx");
  assert.match(
    charts,
    /STATIC_EDITION\s*\?\s*"Hook contracts found \(at least\)"\s*:\s*"Distinct pool hooks"/,
  );
  // Analytics, the footprint pill: "at least N hook contracts", and only when
  // there is a figure (a dash is not "at least").
  const analytics = await read("components/AnalyticsWorkspace.tsx");
  assert.match(
    analytics,
    /\{STATIC_EDITION && result\.inventory\.hookCount !== null && "at least "\}\s*<strong>\{formatCount\(result\.inventory\.hookCount\)\}<\/strong> hook\s+contracts/,
  );
});

test("the scope line says a hook on two networks is counted on both, and never reads as 'each hook once'", () => {
  assert.equal(
    CENSUS_HOOKS_SCOPE,
    "A hook used on two networks is counted on both; newer hooks are not included.",
  );
  assert.doesNotMatch(CENSUS_HOOKS_SCOPE, /once/i);
});
