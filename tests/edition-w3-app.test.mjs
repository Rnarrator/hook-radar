// The app-shell fixes of the "W3 app" review group: the early snapshot request
// and the status check for a newer snapshot, the Analytics empty and loading
// screens, the wording of cards, counts and pagers, the dated file names, the
// footer credit built from the snapshot's sources, the Data & sources dialog and
// the files the edition build leaves out. Pure rules run in Node; components are
// rendered on the server the way tests/edition-status.test.mjs renders them.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import {
  EDITION_RECHECK_MS,
  NO_POOLS_MEASURED,
  RELOAD_HINT,
  fullTimeLabel,
  knownNetwork,
  listNoun,
  networkMenu,
  noPoolsOnNetwork,
  snapshotFileName,
  statusUrl,
  unmeasuredCardNote,
  useCaseCaption,
} from "../src/edition.ts";
import { takeEarlySnapshot } from "../src/edition-data.ts";
import {
  EDITION_PROBE_MS,
  fetchPublishedAt,
  isNewer,
  probeDue,
  publicationCheck,
} from "../src/edition-status-probe.ts";
import { startStaticEditionServer } from "../scripts/static-edition-server.mjs";
import { GENERATED_AT } from "./fixtures/static-data/generate.mjs";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const generated = Date.parse(GENERATED_AT);

const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );

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
const { EditionCensus, EditionRunTimes, SnapshotLine } = await import(status);
const provenanceModule = await componentModule("../src/MarketProvenance.tsx", {
  "./model": model,
  "./edition": new URL("../src/edition.ts", import.meta.url).href,
  "./provenance": new URL("../src/provenance.ts", import.meta.url).href,
});
const { measurementTitle } = await import(provenanceModule);
const fixture = (name) =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/static-data/data/${name}`, import.meta.url),
      "utf8",
    ),
  );

const plain = (html) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/ ([.,;)])/g, "$1")
    .replace(/\( /g, "(")
    .trim();

/** The status line as a visitor reads it when their clock says `visitorNow`. */
function renderLine(t, visitorNow, props = {}) {
  t.mock.method(Date, "now", () => visitorNow);
  return renderToStaticMarkup(
    createElement(SnapshotLine, { generatedAt: GENERATED_AT, ...props }),
  );
}

/* ── 1. The early request and the status check ─────────────────────────── */

test("the status check asks every half hour, and a tab that was away that long is due", () => {
  assert.equal(EDITION_PROBE_MS, 30 * MINUTE);
  assert.equal(EDITION_PROBE_MS, EDITION_RECHECK_MS);
  assert.equal(probeDue(null, generated), true, "never checked");
  assert.equal(probeDue(generated, generated + EDITION_PROBE_MS), false);
  assert.equal(probeDue(generated, generated + EDITION_PROBE_MS + 1), true);
  assert.equal(probeDue(generated, generated + MINUTE), false);
});

test("only a later run, with both times readable, is newer", () => {
  assert.equal(isNewer(generated + HOUR, generated), true);
  assert.equal(isNewer(generated, generated), false, "the same run");
  assert.equal(isNewer(generated - HOUR, generated), false, "an older run");
  for (const bad of [null, undefined, NaN, Infinity, "garbage", ""]) {
    assert.equal(isNewer(bad, generated), false, `published ${bad}`);
    assert.equal(isNewer(generated + HOUR, bad), false, `shown ${bad}`);
  }
  // Times as the files write them are read too.
  assert.equal(
    isNewer(new Date(generated + HOUR).toISOString(), GENERATED_AT),
    true,
  );
});

test("a status answer that names nothing newer is still an answer; an unreadable one is not", () => {
  const shown = generated;
  // Nothing read yet, or nothing that could be read: the page knows nothing.
  assert.deepEqual(publicationCheck(null, shown), {
    newerAt: null,
    checked: false,
  });
  // The same run, or an older one (a host still serving the old file): read,
  // and nothing newer.
  for (const published of [generated, generated - HOUR])
    assert.deepEqual(publicationCheck(published, shown), {
      newerAt: null,
      checked: true,
    });
  // A later run is named, in the form the status line prints.
  assert.deepEqual(publicationCheck(generated + 3 * HOUR, shown), {
    newerAt: new Date(generated + 3 * HOUR).toISOString(),
    checked: true,
  });
  // The page shown is judged by its own time: the same answer is "newer" for an
  // older page and "nothing newer" for a later one.
  assert.notEqual(publicationCheck(generated, generated - HOUR).newerAt, null);
  assert.equal(publicationCheck(generated, generated + HOUR).newerAt, null);
  assert.equal(publicationCheck(generated, undefined).newerAt, null);
  assert.equal(publicationCheck(generated, undefined).checked, true);
  // The hook keeps the latest answer it has had, so an offer already made is not
  // taken back by a host that once answers with an older file.
  const hook = read("src/edition-status-probe.ts");
  assert.match(hook, /Math\.max\(previous, answer\)/);
  assert.match(hook, /if \(!controller\.signal\.aborted && answer !== null\)/);
});

async function withFetch(answer, action) {
  const before = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return answer(url, init);
  };
  try {
    return await action(calls);
  } finally {
    globalThis.fetch = before;
  }
}

test("the status file is read without any cache, and an answer that cannot be used is silent", async () => {
  const ok =
    (body, status = 200) =>
    () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
      });
  await withFetch(ok({ generatedAt: GENERATED_AT }), async (calls) => {
    assert.equal(await fetchPublishedAt(), generated);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, statusUrl());
    assert.equal(calls[0].init.cache, "no-store", "a stored copy says nothing");
  });
  for (const [name, answer] of [
    ["a 404", ok("Not found", 404)],
    ["a 500", ok("oops", 500)],
    ["text that is not JSON", ok("<html>")],
    ["an array", ok([GENERATED_AT])],
    ["no generatedAt", ok({ counts: {} })],
    ["a generatedAt that is not a time", ok({ generatedAt: "soon" })],
    ["a generatedAt that is a number", ok({ generatedAt: 5 })],
    [
      "a network failure",
      () => {
        throw new TypeError("Failed to fetch");
      },
    ],
  ])
    await withFetch(answer, async () =>
      assert.equal(await fetchPublishedAt(), null, name),
    );
});

test("the early snapshot request is taken once, for the address it was made for, and ends with the page's request", () => {
  const request = (url = "/data/snapshot.json") => {
    let aborted = 0;
    const promise = Promise.resolve(new Response("{}"));
    return {
      held: { url, abort: () => aborted++, promise },
      promise,
      aborted: () => aborted,
    };
  };
  // Taken once: the holder is empty afterwards, so a retry makes its own.
  const first = request();
  const holder = { __hookRadarSnapshot: first.held };
  const control = new AbortController();
  assert.equal(
    takeEarlySnapshot("/data/snapshot.json", control.signal, holder),
    first.promise,
  );
  assert.equal(holder.__hookRadarSnapshot, undefined);
  assert.equal(
    takeEarlySnapshot("/data/snapshot.json", control.signal, holder),
    null,
  );
  // The page's stall guard aborts its controller: the early request ends too.
  assert.equal(first.aborted(), 0);
  control.abort();
  assert.equal(first.aborted(), 1);
  // Another address (a different base) is not served from it, and it is gone.
  const other = request("/other/data/snapshot.json");
  const held = { __hookRadarSnapshot: other.held };
  assert.equal(
    takeEarlySnapshot(
      "/data/snapshot.json",
      new AbortController().signal,
      held,
    ),
    null,
  );
  assert.equal(held.__hookRadarSnapshot, undefined);
  // None started (Learn, Analytics), or something that is not a request.
  assert.equal(
    takeEarlySnapshot("/data/snapshot.json", new AbortController().signal, {}),
    null,
  );
  assert.equal(
    takeEarlySnapshot("/data/snapshot.json", new AbortController().signal, {
      __hookRadarSnapshot: { url: "/data/snapshot.json" },
    }),
    null,
  );
  // A signal that is already aborted ends the early request at once.
  const late = request();
  const gone = new AbortController();
  gone.abort();
  takeEarlySnapshot("/data/snapshot.json", gone.signal, {
    __hookRadarSnapshot: late.held,
  });
  assert.equal(late.aborted(), 1);
});

test("a newer snapshot is offered with a Reload button, never swapped in", (t) => {
  const newerAt = new Date(generated + 13 * HOUR).toISOString();
  const html = renderLine(t, generated + 13 * HOUR + MINUTE, { newerAt });
  const text = plain(html);
  assert.match(
    text,
    new RegExp(
      `A newer snapshot is available \\(taken ${fullTimeLabel(newerAt)}\\)\\.`,
    ),
  );
  assert.match(
    html,
    /<button type="button" class="control snapshot-reload" data-testid="snapshot-reload">Reload<\/button>/,
  );
  // A calm sentence in a polite live region, in the dated status line itself.
  assert.match(html, /<span class="snapshot-line-newer" role="status">/);
  assert.match(html, /^<p class="snapshot-line is-stale"/);
  // The figures on screen keep their own date.
  assert.ok(
    text.includes(`Figures are from ${fullTimeLabel(GENERATED_AT)}.`),
    text,
  );
  // With a newer run named, the stale sentence does not also say "reload to check".
  assert.doesNotMatch(text, new RegExp(RELOAD_HINT));
});

test("once the status file has been read and names nothing newer, a late snapshot no longer says to reload", (t) => {
  const visitorNow = generated + 13 * HOUR;
  // Not read yet: the hint, as before.
  const before = plain(renderLine(t, visitorNow, { checked: false }));
  assert.ok(before.endsWith(RELOAD_HINT), before);
  // Read, nothing newer: the site itself is late and a reload would not help, so
  // the line states the age and the date of the figures and stops there.
  t.mock.restoreAll();
  const after = plain(renderLine(t, visitorNow, { checked: true }));
  assert.doesNotMatch(after, /Reload/);
  assert.ok(
    after.endsWith(
      "newer data should have been published. Figures are from " +
        fullTimeLabel(GENERATED_AT) +
        ".",
    ),
    after,
  );
  // A status file that names a newer run is the Reload offer, as before.
  t.mock.restoreAll();
  const newer = renderLine(t, visitorNow, {
    checked: true,
    newerAt: new Date(visitorNow).toISOString(),
  });
  assert.match(newer, /snapshot-reload/);
  assert.doesNotMatch(plain(newer), new RegExp(RELOAD_HINT));
  // The page hands both answers of the status check to the line.
  const app = read("src/App.tsx");
  assert.equal(app.match(/newerAt=\{newerPublication\}/g).length, 2);
  assert.equal(app.match(/checked=\{publicationChecked\}/g).length, 2);
});

test("without a probe answer a late snapshot says to reload; a fresh one says nothing more", (t) => {
  const late = plain(renderLine(t, generated + 13 * HOUR));
  assert.ok(late.endsWith(RELOAD_HINT), late);
  assert.equal(RELOAD_HINT, "Reload this page to check for a newer one.");
  t.mock.restoreAll();
  const fresh = renderLine(t, generated + HOUR);
  assert.doesNotMatch(plain(fresh), /Reload/);
  // The live region is in the page already, empty, so its sentence is announced.
  assert.match(
    fresh,
    /<span class="snapshot-line-newer" role="status"><\/span>/,
  );
  assert.doesNotMatch(fresh, /snapshot-reload/);
});

test("the page keeps what it loaded: no silent re-download on return to the tab, a probe instead", () => {
  const app = read("src/App.tsx");
  assert.doesNotMatch(app, /editionCatchUpDue/, "the silent swap is gone");
  assert.doesNotMatch(app, /retryOverviewRef|lastOverviewAt/);
  // One hook, never on the guide, fed the publication time of what is drawn.
  assert.match(
    app,
    /useNewerPublication\(\s*analyticsLite\s*\?\s*overview\.data\?\.publication\.generatedAt\s*:\s*sourceSnapshot\?\.generatedAt,\s*STATIC_EDITION && view !== "learn",\s*\)/,
  );
  assert.equal(app.match(/newerAt=\{newerPublication\}/g).length, 2);
  // Back in the foreground the edition asks for nothing: the live refresh policy
  // (catchUpDue) runs only when the flag is off.
  assert.match(
    app,
    /if \(\s*!STATIC_EDITION &&\s*bulkStarted\.current &&\s*catchUpDue\(lastSnapshotAt\.current, at, needRef\.current\)\s*\)\s*void fetchSnapshot\(false, true\);/,
  );
  const probe = read("src/edition-status-probe.ts");
  assert.match(probe, /cache: "no-store"/);
  assert.match(probe, /document\.visibilityState !== "visible"/);
  assert.match(probe, /window\.addEventListener\("focus", wake\)/);
  assert.match(probe, /document\.addEventListener\("visibilitychange", wake\)/);
});

/* ── 3-7. Cards, pagers, captions, networks and scope counts ───────────── */

test("a phone card with no market figure says why: not measured, or not reported", () => {
  // No pool of the project is in the snapshot: it was not measured. Nothing is
  // "yet" to come, and nothing is a provider's gap.
  assert.equal(unmeasuredCardNote(0), "Not measured in this snapshot");
  assert.equal(
    unmeasuredCardNote(0, "Base"),
    "Not measured on Base in this snapshot",
  );
  // Pools were measured and the provider gave no value: the same split Compare
  // makes (unmeasuredReason in HookComparison.tsx).
  assert.equal(unmeasuredCardNote(1), "Not reported by the provider");
  assert.equal(unmeasuredCardNote(12, "Base"), "Not reported by the provider");
  assert.equal(NO_POOLS_MEASURED, "No pools measured");
  for (const text of [
    unmeasuredCardNote(0),
    unmeasuredCardNote(3),
    NO_POOLS_MEASURED,
  ])
    assert.doesNotMatch(text, /yet|unavailable|refreshing/i);
});

test("the card's wording is the edition's, and the live wording stays behind the flag", () => {
  const app = read("src/App.tsx");
  assert.match(
    app,
    /STATIC_EDITION\s*\?\s*\/\/ The snapshot measured a sample: nothing is pending\.\s*unmeasuredCardNote\(\s*\(pagePools\.get\(project\.id\) \?\? NO_POOLS\)\.length,/,
  );
  assert.match(app, /"Market data isn’t available yet"/, "live wording stays");
  assert.match(app, /"Pool count unavailable"/, "live wording stays");
});

test("a list of hooks is counted in entries wherever the scope holds unnamed hooks", () => {
  for (const market of ["all", "observed", "active"]) {
    assert.equal(listNoun(market, 480), "entries", market);
    assert.equal(listNoun(market, 1), "entry", market);
    assert.equal(listNoun(market, 0), "entries", market);
  }
  assert.equal(listNoun("projects", 2057), "projects");
  assert.equal(listNoun("projects", 1), "project");
  assert.equal(listNoun(undefined, 3), "projects");
  assert.equal(listNoun("observed", null), "entries");
  const app = read("src/App.tsx");
  assert.equal(
    app.match(/STATIC_EDITION\s*\?\s*listNoun\(filters\.market, resultCount\)/g)
      .length,
    2,
    "under the table and in the export note",
  );
});

test("the use-case counts are described by what they cover", () => {
  assert.equal(useCaseCaption(false), "in this snapshot’s list");
  assert.equal(useCaseCaption(true), "matching this view");
  for (const caption of [useCaseCaption(false), useCaseCaption(true)])
    assert.doesNotMatch(caption, /whole directory/);
  const monitor = read("src/components/Monitor.tsx");
  assert.match(monitor, /useCaseCaption\(filtered \|\| narrowed\)/);
  // Live: the old caption, untouched.
  assert.match(
    monitor,
    /: filtered\s*\? "matching this view"\s*: "whole directory"/,
  );
  // The market scope narrows the caption only; History stays tied to `filtered`.
  assert.match(
    read("src/App.tsx"),
    /narrowed=\{\s*STATIC_EDITION && filters\.market !== "projects"\s*\}/,
  );
  assert.match(monitor, /disabled=\{filtered && tab\.mode === "history"\}/);
});

test("a network the snapshot does not know is dropped; one it knows but did not measure is named", () => {
  const chains = [{ slug: "base" }, { slug: "arbitrum" }];
  assert.equal(knownNetwork("base", chains), true);
  assert.equal(knownNetwork("bogus", chains), false);
  // A network a project is deployed on is a choice the menu offers.
  assert.equal(knownNetwork("elsewhere", chains, ["elsewhere"]), true);
  assert.equal(knownNetwork("bogus", chains, ["elsewhere"]), false);
  assert.equal(
    noPoolsOnNetwork("Arbitrum"),
    "This snapshot measures no pools on Arbitrum.",
  );
  const app = read("src/App.tsx");
  assert.match(
    app,
    /useLayoutEffect\(\(\) => \{\s*if \(\s*STATIC_EDITION &&\s*sourceSnapshot &&\s*filters\.chain !== "all" &&\s*!knownNetwork\(filters\.chain, sourceSnapshot\.chains, deploymentChains\)/,
  );
  assert.match(
    app,
    /\(filters\.market === "observed" \|\| filters\.market === "active"\) &&\s*!snapshot!\.pools\.some\(\(pool\) => pool\.chain === filters\.chain\)/,
  );
});

test("the network menu offers the network the address names when the snapshot lists it but no project is deployed there", () => {
  const chains = [{ slug: "base" }, { slug: "ethereum" }, { slug: "zksync" }];
  const deployed = ["base", "ethereum"];
  // Listed, no project deployed: the menu gains it, in order.
  assert.deepEqual(networkMenu(deployed, "zksync", chains), [
    "base",
    "ethereum",
    "zksync",
  ]);
  assert.deepEqual(networkMenu(["base", "zksync"], "ethereum", chains), [
    "base",
    "ethereum",
    "zksync",
  ]);
  // Already offered, none chosen, or one the snapshot does not list: unchanged,
  // and the caller's list is not altered.
  assert.deepEqual(networkMenu(deployed, "base", chains), deployed);
  assert.deepEqual(networkMenu(deployed, "all", chains), deployed);
  assert.deepEqual(networkMenu(deployed, "bogus", chains), deployed);
  assert.deepEqual(networkMenu([], "zksync", chains), ["zksync"]);
  assert.deepEqual(deployed, ["base", "ethereum"]);
  // The edition's menu is built from it; the live menu keeps its own list.
  const app = read("src/App.tsx");
  assert.match(
    app,
    /const networkOptions =\s*STATIC_EDITION && sourceSnapshot\s*\?\s*networkMenu\(deploymentChains, filters\.chain, sourceSnapshot\.chains\)\s*:\s*deploymentChains;/,
  );
  assert.match(app, /\{networkOptions\.map\(\(chain\) => \(/);
});

test("the trading scope's volume and pool count cover the listed projects' pools, and the network count the measured ones", () => {
  const app = read("src/App.tsx");
  // Recent trading narrows the pool set to the listed projects, like the
  // market-data scope does (only in the edition: the live app is unchanged).
  assert.match(
    app,
    /filters\.market === "observed" \|\|\s*\(STATIC_EDITION && filters\.market === "active"\) \|\|\s*view === "watchlist";/,
  );
  // Networks: those of the measured pools in the two measured scopes; the
  // deployment count stays for Projects and All hooks.
  assert.match(
    app,
    /scopedMeasuredScope\s*\?\s*\[\.\.\.new Set\(scopedPools\.map\(\(pool\) => pool\.chain\)\)\]\s*:\s*\[\s*\.\.\.new Set\(\s*filtered\.flatMap\(\(project\) =>\s*project\.deployments\.map\(\(deployment\) => deployment\.chain\)/,
  );
  assert.match(app, /"Networks with measured pools in this view"/);
  assert.match(app, /"Networks in this view"/);
});

test("a launchpad's drawer names the platform in the tab and in history (edition only)", () => {
  const app = read("src/App.tsx");
  assert.match(
    app,
    /projectName:\s*\(STATIC_EDITION \? registryRecord\?\.name : undefined\) \?\?\s*\(selected\?\.id === selectedId \? selected\.name : undefined\)/,
  );
});

/* ── 8. Dated file names ───────────────────────────────────────────────── */

test("a download made in the edition carries the snapshot's UTC date; the live name is untouched", () => {
  assert.equal(
    snapshotFileName(
      "hook-radar-projects.csv",
      "2026-10-28T16:03:40.446Z",
      true,
    ),
    "hook-radar-projects-2026-10-28.csv",
  );
  assert.equal(
    snapshotFileName(
      "hook-radar-snapshot.json",
      "2026-10-28T16:03:40.446Z",
      true,
    ),
    "hook-radar-snapshot-2026-10-28.json",
  );
  // The date is the UTC date, whatever the visitor's zone.
  assert.equal(
    snapshotFileName("a.csv", "2026-10-28T23:59:59.000+00:00", true),
    "a-2026-10-28.csv",
  );
  assert.equal(
    snapshotFileName("a.csv", "2026-10-29T01:30:00.000+05:00", true),
    "a-2026-10-28.csv",
  );
  assert.equal(
    snapshotFileName("a.csv", Date.UTC(2026, 9, 28, 16), true),
    "a-2026-10-28.csv",
  );
  // With the flag off, or no readable time, the name is the plain one.
  for (const generatedAt of ["2026-10-28T16:03:40.446Z", null, undefined, "x"])
    assert.equal(
      snapshotFileName("hook-radar-projects.csv", generatedAt, false),
      "hook-radar-projects.csv",
    );
  for (const bad of ["garbage", "", null, undefined, NaN])
    assert.equal(
      snapshotFileName("hook-radar-projects.csv", bad, true),
      "hook-radar-projects.csv",
      String(bad),
    );
  assert.equal(
    snapshotFileName("noextension", GENERATED_AT, true),
    "noextension-2026-10-28",
  );
  // This test runs without the flag (plain Node): the default is the live name.
  assert.equal(
    snapshotFileName("hook-radar-projects.csv", GENERATED_AT),
    "hook-radar-projects.csv",
  );
});

test("the live names stay literal in the server downloads and go through the helper only for the page's own files", () => {
  const app = read("src/App.tsx");
  assert.match(
    app,
    /serverDownload\(\s*"\/api\/snapshot\/export\.json",\s*"hook-radar-snapshot\.json",\s*\)/,
  );
  assert.match(
    app,
    /serverDownload\(\s*`\/api\/directory\/export\.csv\?\$\{params\}`,\s*"hook-radar-projects\.csv",\s*\)/,
  );
  assert.equal(
    app.match(
      /snapshotFileName\(\s*"hook-radar-(?:projects\.csv|snapshot\.json)",\s*snapshot\.generatedAt,?\s*\)/g,
    ).length,
    2,
  );
});

/* ── 10. One count of measured pools, thousands separators, one time form ─ */

test("the census block counts the pools the snapshot holds, including one a provider answered for with no value", () => {
  const snapshot = fixture("snapshot.json");
  const text = (value) =>
    plain(
      renderToStaticMarkup(createElement(EditionCensus, { snapshot: value })),
    );
  const held = snapshot.pools.length;
  assert.match(
    text(snapshot),
    new RegExp(`${held} pools measured in this snapshot`),
  );
  // One more pool, answered for by the provider with no figure at all: it is
  // still a measured pool (the Pools card and the coverage figures count it).
  const empty = {
    ...snapshot.pools[0],
    id: "ethereum:no-value",
    liquidityUsd: null,
    volumeUsd: { h1: null, h6: null, h24: null },
  };
  const withEmpty = { ...snapshot, pools: [...snapshot.pools, empty] };
  assert.match(
    text(withEmpty),
    new RegExp(`${held + 1} pools measured in this snapshot`),
  );
  // One pool reads "pool", not "pools".
  assert.match(
    text({ ...snapshot, pools: [empty] }),
    /1 pool measured in this snapshot/,
  );
  // A measured zero and a missing value are both measured pools.
  assert.match(
    text({
      ...snapshot,
      pools: [
        { ...empty, liquidityUsd: 0, volumeUsd: { h1: 0, h6: 0, h24: 0 } },
      ],
    }),
    /1 pool measured in this snapshot/,
  );
});

test("a measurement tooltip writes its counts as the visible labels do, in the edition only", () => {
  const provenance = {
    oldestAt: "2026-10-28T15:59:00.000Z",
    poolCount: 1592,
    observedPoolCount: 2209,
    cachedPoolCount: 1200,
    unknownTimestampCount: 1100,
    unknownStatusCount: 1300,
    stalePoolCount: 1010,
  };
  const edition = measurementTitle(provenance, "h24", true);
  assert.match(
    edition,
    /Oldest current pool measurement: 28 Oct 2026, 15:59 UTC\./,
  );
  assert.match(edition, /1,592 current pools\./);
  assert.match(edition, /1,010 older observations are excluded/);
  assert.match(edition, /1,200 cached;/);
  assert.match(edition, /1,100 measurement timestamps unavailable/);
  assert.match(edition, /1,300 pools have unknown freshness status/);
  assert.doesNotMatch(edition, /\b1592\b|\b1010\b|\b1200\b/);
  // The live tooltip is untouched: the plain number.
  const live = measurementTitle(provenance, "h24", false);
  assert.match(live, / 1592 current pools\./);
  assert.match(
    live,
    /^Oldest current pool measurement: .*\. 1592 current pools\./,
  );
  // Small counts read the same either way.
  assert.match(
    measurementTitle(
      { ...provenance, poolCount: 1, cachedPoolCount: 0 },
      "h24",
      true,
    ),
    /1 current pool\./,
  );
});

test("the collection run gives both ends of the measurement span in one form", () => {
  const run = {
    generatedAt: "2026-10-28T16:03:40.446Z",
    collectionStartedAt: "2026-10-28T15:49:31.029Z",
    burstStartedAt: "2026-10-28T15:59:33.879Z",
    burstEndedAt: "2026-10-28T16:03:40.446Z",
    previousGeneratedAt: null,
  };
  const shown = plain(
    renderToStaticMarkup(createElement(EditionRunTimes, { run })),
  );
  assert.match(
    shown,
    /Measurements taken 28 Oct 2026, 15:59 UTC to 28 Oct 2026, 16:03 UTC/,
  );
  assert.match(shown, /Collection started 28 Oct 2026, 15:49 UTC/);
  // A run that crosses midnight reads right too: the start has its own date.
  const across = plain(
    renderToStaticMarkup(
      createElement(EditionRunTimes, {
        run: {
          ...run,
          burstStartedAt: "2026-10-27T23:58:00.000Z",
          burstEndedAt: "2026-10-28T00:03:00.000Z",
          generatedAt: "2026-10-28T00:03:00.000Z",
        },
      }),
    ),
  );
  assert.match(
    across,
    /Measurements taken 27 Oct 2026, 23:58 UTC to 28 Oct 2026, 00:03 UTC/,
  );
});

/* ── 9 and 11. The footer and the Data & sources links ─────────────────── */

test("every footer but the guide's is given the sources of the file it stands under; the guide credits nothing", () => {
  const app = read("src/App.tsx");
  const footers = [...app.matchAll(/<SiteFooter([\s\S]*?)\/>/g)].map(
    (match) => match[1],
  );
  assert.equal(footers.length, 4, "the four footers");
  const [guide, ...others] = footers;
  assert.doesNotMatch(guide, /sources=/, "the guide loads no snapshot");
  assert.deepEqual(
    others.map((footer) => footer.match(/sources=\{([^}]+)\}/)?.[1]),
    ["overview.data?.sources", "snapshot?.sources", "snapshot.sources"],
  );
  // Every footer takes the one way into the dialog, which is absent where the
  // build has none (the edition by its owner's choice): no footer button.
  assert.ok(
    footers.every((footer) => /onSources=\{openSources\}/.test(footer)),
    "each footer is given openSources, not its own opener",
  );
  const footer = read("src/components/SiteFooter.tsx");
  // The notices link is a root-absolute literal, so the edition build makes it
  // relative to where the site is served from; it and the line stand only in the
  // edition, and only while the owner's switch (EDITION_SOURCES_DIALOG) is on.
  assert.match(footer, /href="\/third-party-notices\.txt"/);
  assert.match(footer, /Protocol logos belong to their owners\./);
  assert.match(
    footer,
    /\{FOOTER_CREDITS && \(\s*<p\s+className="footer-credit footer-notices"/,
  );
  assert.match(
    footer,
    /\{FOOTER_CREDITS && <SourceCredit sources=\{sources\} \/>\}/,
  );
  assert.match(footer, /\{onSources && <button onClick=\{onSources\}>/);
});

test("each source card's link names its source for a screen reader, and the census card, which is Hook Radar's own index, has none", () => {
  const app = read("src/App.tsx");
  assert.match(
    app,
    /STATIC_EDITION && source\.id === "census" \? null : \(\s*<External href=\{source\.url\}>\s*View source\s*\{STATIC_EDITION && \(\s*<span className="sr-only">\s*\{` for \$\{source\.name\}`\}\s*<\/span>\s*\)\}\s*<\/External>\s*\)/,
  );
});

test("the census card's own note is what says where it comes from", () => {
  // The collector's note for the census (collector/assemble.mjs) says it is
  // Hook Radar's own index; the page offers no link to a page that is not it.
  const assemble = read("collector/assemble.mjs");
  assert.match(assemble, /Hook Radar's index of PoolManager events/);
});

/* ── The test server's cacheControl option ─────────────────────────────── */

test("the test server can make /data storable for hours, as a host with a time to live does, and changes nothing else", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "edition-w3-server-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "dist", "assets"), { recursive: true });
  await mkdir(join(root, "data"), { recursive: true });
  await writeFile(join(root, "dist", "index.html"), "<p>page</p>");
  await writeFile(join(root, "dist", "assets", "app.js"), "1");
  await writeFile(
    join(root, "data", "snapshot.json"),
    JSON.stringify({ generatedAt: GENERATED_AT }),
  );
  const headers = async (server, path) => {
    const answer = await fetch(`${server.url}${path}`);
    await answer.arrayBuffer();
    return answer.headers.get("cache-control");
  };
  const plain = await startStaticEditionServer({
    distDir: join(root, "dist"),
    dataDir: join(root, "data"),
  });
  t.after(() => plain.close());
  assert.equal(
    await headers(plain, "data/snapshot.json"),
    "public, max-age=0, must-revalidate",
  );
  const stored = await startStaticEditionServer({
    distDir: join(root, "dist"),
    dataDir: join(root, "data"),
    cacheControl: "public, max-age=14400",
  });
  t.after(() => stored.close());
  assert.equal(
    await headers(stored, "data/snapshot.json"),
    "public, max-age=14400",
  );
  // The page and the hashed assets keep the headers they had.
  assert.equal(await headers(stored, ""), "public, max-age=0, must-revalidate");
  assert.equal(
    await headers(stored, "assets/app.js"),
    "public, max-age=31536000, immutable",
  );
  // A data file that was replaced has another ETag, so a revalidating request
  // gets the new file even while the old one is still "fresh".
  const first = await fetch(`${stored.url}data/snapshot.json`);
  const etag = first.headers.get("etag");
  await first.arrayBuffer();
  stored.setData("snapshot.json", { generatedAt: "2026-10-29T00:00:00.000Z" });
  const after = await fetch(`${stored.url}data/snapshot.json`, {
    headers: { "If-None-Match": etag },
  });
  assert.equal(after.status, 200);
  assert.notEqual(after.headers.get("etag"), etag);
});

test("the Analytics and home failure screens: Retry stays mounted, one heading level under the h1, no button that does nothing", () => {
  const app = read("src/App.tsx");
  // A disabled button drops keyboard focus to the top of the page: the edition
  // keeps both Retry buttons enabled (aria-disabled, "Retrying…") while the
  // request runs. The live build keeps `disabled`.
  assert.match(
    app,
    /disabled=\{STATIC_EDITION \? undefined : refreshing \|\| loading\}\s*aria-disabled=\{\s*STATIC_EDITION && \(refreshing \|\| loading\) \? true : undefined\s*\}/,
  );
  assert.match(
    app,
    /disabled=\{STATIC_EDITION \? undefined : overview\.loading\}\s*aria-disabled=\{\s*STATIC_EDITION && overview\.loading \? true : undefined\s*\}/,
  );
  assert.equal(app.match(/\? "Retrying…"/g).length, 2);
  // The empty screens sit under the page's h1: a level-2 heading, not a 3.
  assert.match(
    app,
    /<Empty\s+headingLevel=\{2\}\s+title=\{NOT_PUBLISHED_TITLE\}/,
  );
  assert.match(app, /headingLevel=\{STATIC_EDITION \? 2 : 3\}/);
  // "All networks" is offered on "Analytics unavailable" only away from All
  // networks; on All networks it would change nothing.
  assert.match(
    app,
    /\{\(!STATIC_EDITION \|\| analyticsChain !== "all"\) && \(\s*<button\s+className="control"\s+onClick=\{showAllAnalyticsNetworks\}/,
  );
});
