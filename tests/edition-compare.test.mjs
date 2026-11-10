// Compare in the Auto Snapshot edition: ids the snapshot does not carry are set
// aside and named (never a column that waits for a service that is not there),
// the picker and the metric cells say what the snapshot actually holds, and the
// live site keeps its own words. The component is rendered on the server with
// the edition flag forced on through a shim for ../model; nothing is built.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { makeSnapshot } from "./fixtures.mjs";

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
  }))
    output = output.replaceAll(
      JSON.stringify(specifier),
      JSON.stringify(target),
    );
  return `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`;
}
const realModel = new URL("../src/model.ts", import.meta.url).href;
const realEdition = new URL("../src/edition.ts", import.meta.url).href;
// The same module with only the edition flag turned on.
const withFlag = (href) =>
  `data:text/javascript;base64,${Buffer.from(
    `export * from ${JSON.stringify(href)};\nexport const STATIC_EDITION = true;\n`,
  ).toString("base64")}`;

async function load(model, editionFlag) {
  const icons = await componentModule("../src/components/Icons.tsx");
  const logo = await componentModule("../src/components/ProtocolLogo.tsx", {
    "../protocol-logos": new URL("../src/protocol-logos.ts", import.meta.url)
      .href,
    "../fallback-mark": new URL("../src/fallback-mark.ts", import.meta.url)
      .href,
  });
  const primitives = await componentModule("../src/components/Primitives.tsx", {
    "../model": model,
    "./Icons": icons,
  });
  const provenance = await componentModule("../src/MarketProvenance.tsx", {
    "./model": model,
    "./edition": editionFlag,
    "./provenance": new URL("../src/provenance.ts", import.meta.url).href,
  });
  const glyph = await componentModule("../src/components/PermissionGlyph.tsx", {
    "../hook-permissions": new URL(
      "../src/hook-permissions.ts",
      import.meta.url,
    ).href,
  });
  const signature = await componentModule(
    "../src/components/CallbackSignature.tsx",
    {
      "../comparison": new URL("../src/comparison.ts", import.meta.url).href,
      "./PermissionGlyph": glyph,
    },
  );
  const component = await componentModule(
    "../src/components/HookComparison.tsx",
    {
      "../model": model,
      "../directory": new URL("../src/directory.ts", import.meta.url).href,
      "../comparison": new URL("../src/comparison.ts", import.meta.url).href,
      "../scope": new URL("../src/scope.ts", import.meta.url).href,
      "../MarketProvenance": provenance,
      "./Icons": icons,
      "./ProtocolLogo": logo,
      "./Primitives": primitives,
      "./CallbackSignature": signature,
      "./PermissionGlyph": glyph,
    },
  );
  return import(component);
}
const edition = await load(withFlag(realModel), withFlag(realEdition));
const live = await load(realModel, realEdition);

const plain = (html) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const render = (module, snapshot, ids = [], options = {}) =>
  renderToStaticMarkup(
    createElement(module.HookComparison, {
      snapshot,
      ids,
      onChange() {},
      onOpenProject() {},
      ...options,
    }),
  );

const ago = (ms) => new Date(Date.now() - ms).toISOString();
const pool = (id, projectId, values = {}) => ({
  id,
  chain: "base",
  name: `${id} / TEST`,
  address: "0x" + "b".repeat(64),
  hookAddress: null,
  projectId,
  url: "https://www.geckoterminal.com/base/pools/test",
  source: "Test indexed pool",
  liquidityUsd: 10000,
  volumeUsd: { h1: 10, h6: 60, h24: 2400 },
  createdAt: "2026-10-01T00:00:00Z",
  tokens: ["ETH", "TEST"],
  metricUpdatedAt: ago(1000),
  metricStatus: "live",
  ...values,
});

test("partitionComparisonIds sets aside ids the snapshot lacks and keeps the rest in order", () => {
  const carried = new Set(["alpha", "beta", "gamma", "delta", "epsilon"]);
  const { selection, notCarried } = edition.partitionComparisonIds(
    ["gamma", "ghost", "alpha", "hook-0000000000000000zzzz", "beta"],
    carried,
  );
  assert.deepEqual(selection, ["gamma", "alpha", "beta"]);
  assert.deepEqual(notCarried, ["ghost", "hook-0000000000000000zzzz"]);
});

test("ids the snapshot lacks never use one of the four columns", () => {
  const carried = new Set(["a", "b", "c", "d", "e"]);
  const { selection, notCarried } = edition.partitionComparisonIds(
    ["x1", "x2", "a", "b", "x3", "c", "d", "e"],
    carried,
  );
  assert.deepEqual(selection, ["a", "b", "c", "d"]);
  assert.deepEqual(notCarried, ["x1", "x2", "x3"]);
});

test("uppercase, bad characters, repeats and non-strings are still ignored", () => {
  const carried = new Set(["alpha"]);
  const { selection, notCarried } = edition.partitionComparisonIds(
    [
      "Alpha",
      "alpha",
      "alpha",
      "bad id",
      "../etc",
      "",
      "-lead",
      "x".repeat(101),
      "ghost",
      "ghost",
      null,
      7,
    ],
    carried,
  );
  assert.deepEqual(selection, ["alpha"]);
  assert.deepEqual(notCarried, ["ghost"]);
  assert.deepEqual(edition.partitionComparisonIds([], carried), {
    selection: [],
    notCarried: [],
  });
});

test("a link naming a missing project shows the carried ones and says so, with no endless loading column", () => {
  const snapshot = makeSnapshot();
  const html = render(edition, snapshot, ["alpha", "ghost-project", "beta"]);
  const text = plain(html);
  assert.match(html, /data-count="2"/);
  assert.match(text, /2 \/ 4/);
  assert.match(
    text,
    /This link names 1 project this snapshot does not carry \(it carries registry-named projects and projects with at least one measured pool\): ghost-project Remove/,
  );
  assert.match(html, /aria-label="Remove ghost-project from this link"/);
  assert.match(html, /class="notice comparison-not-carried" role="status"/);
  assert.doesNotMatch(text, /Loading project details/);
  assert.doesNotMatch(html, /aria-busy="true"/);
  assert.doesNotMatch(html, /<th scope="col">ghost-project<\/th>/);
  assert.doesNotMatch(
    html,
    /aria-label="Remove ghost-project from comparison"/,
  );
  assert.match(html, /aria-label="Remove Alpha Markets from comparison"/);
  assert.match(html, /aria-label="Remove Beta Liquidity from comparison"/);
});

test("several missing projects are counted and each can be removed", () => {
  const html = render(edition, makeSnapshot(), [
    "ghost-one",
    "alpha",
    "ghost-two",
  ]);
  const text = plain(html);
  assert.match(text, /This link names 2 projects this snapshot does not carry/);
  assert.match(html, /aria-label="Remove ghost-one from this link"/);
  assert.match(html, /aria-label="Remove ghost-two from this link"/);
  assert.match(html, /data-count="1"/);
  assert.match(text, /Add another project to start comparing/);
});

test("only missing projects leave the plain empty picker, still with the line", () => {
  const html = render(edition, makeSnapshot(), ["ghost-one", "ghost-two"]);
  const text = plain(html);
  assert.match(text, /Choose projects to compare/);
  assert.match(text, /This link names 2 projects this snapshot does not carry/);
  assert.match(html, /data-count="0"/);
  assert.doesNotMatch(html, /<table/);
  assert.doesNotMatch(text, /Loading project details/);
  assert.match(html, /aria-label="Add Alpha Markets"/);
  assert.match(text, /Search this snapshot/);
});

test("a link that names only carried projects has no line", () => {
  const html = render(edition, makeSnapshot(), ["alpha", "beta"]);
  assert.doesNotMatch(plain(html), /does not carry/);
  assert.doesNotMatch(html, /comparison-not-carried/);
});

test("the live site keeps its words and its loading column for an unknown id", () => {
  const html = render(live, makeSnapshot(), ["alpha", "ghost-project"]);
  const text = plain(html);
  assert.doesNotMatch(text, /does not carry/);
  assert.doesNotMatch(html, /comparison-not-carried/);
  assert.match(text, /Loading project details…/);
  assert.match(html, /<th scope="col">ghost-project<\/th>/);
  assert.match(html, /aria-label="Remove ghost-project from comparison"/);
  const empty = plain(render(live, makeSnapshot(), []));
  assert.match(empty, /Search the full directory/);
  assert.doesNotMatch(empty, /Search this snapshot/);
});

test("the picker names the snapshot, not a directory, in the edition only", () => {
  const empty = plain(render(edition, makeSnapshot(), []));
  assert.match(empty, /Search this snapshot/);
  assert.doesNotMatch(empty, /Search the full directory/);
  const picker = (module, snapshot) =>
    renderToStaticMarkup(
      createElement(module.ProjectPicker, { snapshot, onSelect() {} }),
    );
  // Nothing to list: the empty answer says what the snapshot carries.
  const bare = makeSnapshot({ projects: [], pools: [] });
  const text = plain(picker(edition, bare));
  assert.match(
    text,
    /Nothing in this snapshot matches\. It carries registry-named projects and projects with a measured pool, so other hooks are not included\./,
  );
  assert.doesNotMatch(text, /No projects match/);
  const liveText = plain(picker(live, bare));
  assert.match(
    liveText,
    /No projects match\. Try a project name or exact hook address\./,
  );
  assert.doesNotMatch(liveText, /Nothing in this snapshot/);
});

const snapshotWithCases = () => {
  const snapshot = makeSnapshot();
  snapshot.projects.push({
    ...structuredClone(snapshot.projects[0]),
    id: "delta",
    name: "Delta Zero",
  });
  snapshot.pools = [
    // alpha: current volume, reserve value never reported
    pool("alpha-1", "alpha", { liquidityUsd: null }),
    // beta: no pool in the snapshot at all
    // frontier: a value, but measured too long before the snapshot
    pool("frontier-1", "frontier", { metricUpdatedAt: ago(30 * 60 * 1000) }),
    // delta: a real measured zero
    pool("delta-1", "delta", {
      liquidityUsd: 0,
      volumeUsd: { h1: 0, h6: 0, h24: 0 },
    }),
  ];
  return snapshot;
};
const cells = (html, label) => {
  const row = html.match(
    new RegExp(`<th scope="row">(?:(?!</tr>).)*?${label}(?:(?!</tr>).)*</tr>`),
  );
  assert(row, `row ${label}`);
  return [...row[0].matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((cell) =>
    plain(cell[1]),
  );
};

test("an empty metric cell says why: not in the snapshot, not reported, or not fresh", () => {
  const snapshot = snapshotWithCases();
  for (const [id, volume, reserves] of [
    [
      "beta",
      "— Not measured in this snapshot",
      "— Not measured in this snapshot",
    ],
    ["alpha", "$2.4K", "— Not reported by the provider"],
    ["frontier", "— No fresh measurements", "— No fresh measurements"],
  ]) {
    const html = render(edition, snapshot, [id]);
    assert.match(
      cells(html, "24h volume")[0],
      new RegExp(`^${volume.replace("$", "\\$")}`),
    );
    assert.match(
      cells(html, "Pool reserves")[0],
      new RegExp(`^${reserves.replace("$", "\\$")}`),
    );
  }
});

// What assessReserveEvidence (server/reserve-value.mjs) leaves on a pool whose
// provider gave a reserve total that Hook Radar then withheld, or never gave one.
const withheld = (status) => ({
  liquidityUsd: null,
  liquidityStatus: status,
  liquidityNote:
    status === "unavailable"
      ? "The provider did not supply a usable USD reserve valuation."
      : "Reserve valuation withheld: reported total does not match token component valuations. Trading volume is retained as reported.",
});

test("a reserve figure the provider gave and Hook Radar withheld is not called unreported", () => {
  const snapshot = makeSnapshot();
  snapshot.projects.push(
    { ...structuredClone(snapshot.projects[0]), id: "delta", name: "Delta" },
    { ...structuredClone(snapshot.projects[0]), id: "gamma", name: "Gamma" },
  );
  snapshot.pools = [
    pool("alpha-1", "alpha", withheld("inconsistent")),
    pool("beta-1", "beta", withheld("unverified")),
    pool("delta-1", "delta", withheld("unavailable")),
    // no status at all: older data, still "not reported"
    pool("gamma-1", "gamma", { liquidityUsd: null }),
  ];
  const html = render(edition, snapshot, ["alpha", "beta", "delta", "gamma"]);
  const reserves = cells(html, "Pool reserves");
  const WITHHELD = /^— Withheld: the reported figure could not be verified/;
  assert.match(reserves[0], WITHHELD);
  assert.match(reserves[1], WITHHELD);
  assert.match(reserves[2], /^— Not reported by the provider/);
  assert.match(reserves[3], /^— Not reported by the provider/);
  // withheld is still a dash, never a number
  assert.doesNotMatch(reserves.join(" "), /\$/);
  assert.doesNotMatch(reserves[0] + reserves[1], /Not reported/);
  // the hover title says the same
  assert.match(
    html,
    /title="Withheld: the reported figure could not be verified">—<\/strong>/,
  );
  // volume has no such status: it keeps its own words (here it was retained)
  const volume = cells(html, "24h volume");
  assert.match(volume[0], /^\$2\.4K 1 current pool/);
  assert.match(volume[1], /^\$2\.4K 1 current pool/);
});

test("a project mixing unavailable and withheld pools is called withheld; a measured pool wins", () => {
  const snapshot = makeSnapshot();
  snapshot.projects.push({
    ...structuredClone(snapshot.projects[0]),
    id: "delta",
    name: "Delta",
  });
  snapshot.pools = [
    pool("alpha-1", "alpha", withheld("unavailable")),
    pool("alpha-2", "alpha", withheld("inconsistent")),
    // beta: one pool without a figure and one with a current value
    pool("beta-1", "beta", withheld("unverified")),
    pool("beta-2", "beta", { liquidityUsd: 5000 }),
    // delta: a withheld pool, but only the volume window is empty here
    pool("delta-1", "delta", {
      ...withheld("inconsistent"),
      volumeUsd: { h1: null, h6: null, h24: null },
    }),
  ];
  const html = render(edition, snapshot, ["alpha", "beta", "delta"]);
  const reserves = cells(html, "Pool reserves");
  assert.match(reserves[0], /^— Withheld: the reported figure/);
  assert.match(reserves[1], /^\$5\.0K 1 current pool/);
  assert.doesNotMatch(reserves[1], /Withheld|Not reported/);
  assert.match(reserves[2], /^— Withheld: the reported figure/);
  // an empty volume next to a withheld reserve figure is still "not reported"
  assert.match(cells(html, "24h volume")[2], /^— Not reported by the provider/);
});

test("the live site does not use the withheld wording", () => {
  const snapshot = makeSnapshot();
  snapshot.pools = [pool("alpha-1", "alpha", withheld("inconsistent"))];
  const html = render(live, snapshot, ["alpha"]);
  assert.doesNotMatch(plain(html), /Withheld: the reported figure/);
  assert.match(cells(html, "Pool reserves")[0], /^— No fresh measurements/);
});

test("a null is never drawn as zero and a measured zero stays zero", () => {
  const snapshot = snapshotWithCases();
  const html = render(edition, snapshot, ["alpha", "beta", "delta"]);
  const volume = cells(html, "24h volume");
  const reserves = cells(html, "Pool reserves");
  assert.match(volume[0], /^\$2\.4K 1 current pool/);
  assert.match(volume[1], /^— Not measured in this snapshot/);
  assert.match(volume[2], /^\$0 1 current pool/);
  assert.match(reserves[0], /^— Not reported by the provider/);
  assert.match(reserves[1], /^— Not measured in this snapshot/);
  assert.match(reserves[2], /^\$0 1 current pool/);
  assert.doesNotMatch(volume[1] + reserves[0] + reserves[1], /\$0/);
  // the hover title carries the same reason
  assert.match(html, /title="Not reported by the provider">—<\/strong>/);
});

test("scoped to a network the project has no pool on, the cell says it is not in the snapshot", () => {
  const snapshot = snapshotWithCases();
  snapshot.pools[0].chain = "ethereum";
  const html = render(edition, snapshot, ["alpha", "delta"], {
    network: "base",
    onNetworkChange() {},
  });
  assert.match(
    cells(html, "24h volume")[0],
    /^— Not measured in this snapshot/,
  );
  assert.match(cells(html, "24h volume")[1], /^\$0 1 current pool/);
});

test("the live site keeps saying No fresh measurements for every empty cell", () => {
  const snapshot = snapshotWithCases();
  for (const id of ["beta", "alpha", "frontier"]) {
    const html = render(live, snapshot, [id]);
    const text = plain(html);
    assert.doesNotMatch(
      text,
      /Not measured in this snapshot|Not reported by the provider/,
    );
    assert.match(
      cells(html, "Pool reserves")[0],
      /^(— No fresh measurements|\$)/,
    );
  }
  const html = render(live, snapshot, ["beta"]);
  assert.match(cells(html, "24h volume")[0], /^— No fresh measurements/);
  assert.match(html, /title="Not measured in this scope">—<\/strong>/);
});

test("the methodology note speaks of the snapshot's pool counts and UTC times in the edition; the live words stay", () => {
  const snapshot = snapshotWithCases();
  const ids = ["alpha", "delta"];
  const edited = plain(render(edition, snapshot, ids));
  assert.match(
    edited,
    /Where these comparisons come from.*Pool counts are the pools measured in this snapshot \(an observed sample, labelled as such\)\. Neither pool counts nor contract counts measure adoption\./,
  );
  assert.match(
    edited,
    /Each cell shows its contributing pools, source and the UTC time of its oldest measurement\. Different coverage and measurement times can make rankings misleading\./,
  );
  // Nothing in the edition describes the live service's initialization events
  // or an age that the cells (absolute UTC times) do not show.
  assert.doesNotMatch(edited, /initialization events|original measurement age/);
  const unchanged = plain(render(live, snapshot, ids));
  assert.match(
    unchanged,
    /Pool totals come from indexed initialization events when available\. An observed sample is labeled explicitly\. Neither pool counts nor contract counts measure adoption\./,
  );
  assert.match(
    unchanged,
    /Each cell shows its contributing pools, source and original measurement age\. Different coverage and measurement times can make rankings misleading\./,
  );
  assert.doesNotMatch(unchanged, /measured in this snapshot \(an observed/);
});
