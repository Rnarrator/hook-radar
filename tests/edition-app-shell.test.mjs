// The Auto Snapshot edition's app shell without a browser: saved projects the
// snapshot does not carry, the order of compared ids, which publication a page
// is judged at, how files from two runs are brought together, when a download
// counts as stalled, what a failed load says, and what an overview file's 404
// means. The same flows in a real browser are in
// scripts/static-edition-shell-browser.test.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { mock } from "node:test";
import {
  evaluationNow,
  freezeEvaluationClock,
  isOlderPublication,
  overviewAnswer,
  viewPublicationAt,
} from "../src/edition.ts";
import {
  NOT_PUBLISHED_TITLE,
  PUBLISHING_NOTE,
  RECONCILE_ATTEMPTS,
  RECONNECT_LIMIT,
  SAVED_NAMES_KEY,
  SAVED_NONE_IN_SNAPSHOT,
  STALL_MS,
  carriedFirst,
  createStallGuard,
  failureOf,
  overviewFailureMessage,
  parseSavedNames,
  readJsonBody,
  reconcileStep,
  rememberSavedNames,
  savedExportNote,
  savedNotInSnapshot,
  savedNotInSnapshotNotice,
  snapshotFailureMessage,
  snapshotUrlFor,
  withRun,
  withSavedName,
} from "../src/edition-shell.ts";
import { refreshMarketSnapshot } from "../shared/market-freshness.ts";
import { GENERATED_AT } from "./fixtures/static-data/generate.mjs";

const fixture = () =>
  JSON.parse(
    readFileSync(
      new URL("./fixtures/static-data/data/snapshot.json", import.meta.url),
      "utf8",
    ),
  );
// The checkout may have CRLF working files; sources are compared without them.
const source = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );

const HOUR = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();

/* ── Saved projects ────────────────────────────────────────────────────── */

test("the saved ids a snapshot does not carry are the ones its projects lack, in the order saved", () => {
  const carried = new Set(["alpha", "beta"]);
  assert.deepEqual(
    savedNotInSnapshot(["zeta", "alpha", "gone", "beta"], carried),
    ["zeta", "gone"],
  );
  assert.deepEqual(savedNotInSnapshot(["alpha"], carried), []);
  assert.deepEqual(savedNotInSnapshot([], carried), []);
  // Nothing carried: everything saved is outside, and none is dropped.
  assert.deepEqual(savedNotInSnapshot(["a", "b"], new Set()), ["a", "b"]);
});

test("the notice says the entries stay saved, names no registry and offers no bulk removal", () => {
  assert.equal(
    savedNotInSnapshotNotice(1),
    "1 saved project is not in this snapshot. It stays saved and will show again when a snapshot includes it.",
  );
  assert.equal(
    savedNotInSnapshotNotice(3),
    "3 saved projects are not in this snapshot. They stay saved and will show again when a snapshot includes them.",
  );
  assert.equal(
    savedNotInSnapshotNotice(1200),
    "1,200 saved projects are not in this snapshot. They stay saved and will show again when a snapshot includes them.",
  );
  for (const text of [
    savedNotInSnapshotNotice(2),
    SAVED_NONE_IN_SNAPSHOT,
    savedExportNote(2),
  ]) {
    assert.doesNotMatch(text, /unavailable|registry\b.*dropped|remove/i, text);
  }
  assert.match(SAVED_NONE_IN_SNAPSHOT, /registry-named projects/);
  assert.equal(
    savedExportNote(1),
    "1 saved project is not in this snapshot, so it is not in these files.",
  );
  assert.equal(
    savedExportNote(4),
    "4 saved projects are not in this snapshot, so they are not in these files.",
  );
});

test("the name map has a key of its own, never the watchlist's", () => {
  assert.equal(SAVED_NAMES_KEY, "hook-radar-watchlist-names-v1");
  assert.notEqual(SAVED_NAMES_KEY, "hook-radar-watchlist-v1");
});

test("stored names are read defensively", () => {
  assert.deepEqual(parseSavedNames(null), {});
  assert.deepEqual(parseSavedNames(""), {});
  assert.deepEqual(parseSavedNames("not json"), {});
  assert.deepEqual(parseSavedNames("[1,2]"), {});
  assert.deepEqual(parseSavedNames("7"), {});
  assert.deepEqual(
    parseSavedNames(
      JSON.stringify({
        alpha: "Alpha Hook",
        "Bad Id": "x",
        beta: 5,
        gamma: "   ",
        long: "n".repeat(121),
        ok: "n".repeat(120),
      }),
    ),
    { alpha: "Alpha Hook", ok: "n".repeat(120) },
  );
});

test("one name is set, replaced or dropped, and an unchanged map is the same object", () => {
  const names = { alpha: "Alpha" };
  assert.equal(withSavedName(names, "alpha", "Alpha"), names);
  assert.equal(withSavedName(names, "alpha", "  Alpha  "), names);
  assert.deepEqual(withSavedName(names, "alpha", "Alpha v2"), {
    alpha: "Alpha v2",
  });
  assert.deepEqual(withSavedName(names, "beta", "Beta"), {
    alpha: "Alpha",
    beta: "Beta",
  });
  assert.deepEqual(withSavedName(names, "alpha", null), {});
  assert.equal(withSavedName(names, "beta", null), names);
  assert.equal(withSavedName(names, "beta", ""), names);
  assert.deepEqual(names, { alpha: "Alpha" }, "the input is never changed");
});

test("names follow the saved projects the snapshot carries and are kept for the ones it does not", () => {
  const projects = [
    { id: "alpha", name: "Alpha" },
    { id: "beta", name: "Beta" },
  ];
  // First sight: names are taken for the saved ids that are carried.
  const first = rememberSavedNames({}, ["alpha", "gone"], projects);
  assert.deepEqual(first, { alpha: "Alpha" });
  // A later snapshot without alpha: its name stays, so the notice can use it.
  const later = rememberSavedNames(first, ["alpha", "gone"], [projects[1]]);
  assert.equal(later, first);
  assert.deepEqual(later, { alpha: "Alpha" });
  // A project renamed in the registry is renamed here.
  assert.deepEqual(
    rememberSavedNames(first, ["alpha"], [{ id: "alpha", name: "Alpha 2" }]),
    { alpha: "Alpha 2" },
  );
  // Un-starred or forgotten: the name goes with the id.
  assert.deepEqual(rememberSavedNames(first, ["beta"], projects), {
    beta: "Beta",
  });
  assert.deepEqual(rememberSavedNames(first, [], projects), {});
  // Nothing to change: the same object, so no render and no storage write.
  assert.equal(rememberSavedNames(first, ["alpha"], projects), first);
  const empty = {};
  assert.equal(rememberSavedNames(empty, [], projects), empty);
});

/* ── Compared projects ─────────────────────────────────────────────────── */

test("the projects the snapshot carries come before the ones it lacks", () => {
  const carried = new Set(["a", "b", "c", "d"]);
  assert.deepEqual(carriedFirst(["g1", "a", "g2", "b"], carried), [
    "a",
    "b",
    "g1",
    "g2",
  ]);
  // The address keeps four ids: a project added next to a ghost is not the one
  // that falls off the end.
  assert.deepEqual(
    carriedFirst(["g1", "a", "b", "c", "d"], carried).slice(0, 4),
    ["a", "b", "c", "d"],
  );
  assert.deepEqual(carriedFirst([], carried), []);
});

/* ── Which publication a page is judged at ─────────────────────────────── */

test("the lightweight Analytics page is judged at its overview, every other page at the snapshot", () => {
  const snapshotAt = "2026-10-28T00:14:11.461Z";
  const overviewAt = "2026-10-28T03:14:00.000Z";
  assert.equal(
    viewPublicationAt({ lite: true, snapshotAt, overviewAt }),
    overviewAt,
  );
  assert.equal(
    viewPublicationAt({ lite: false, snapshotAt, overviewAt }),
    snapshotAt,
  );
});

test("the other file only stands in while the page's own has not loaded, and no file means no time", () => {
  const at = "2026-10-28T00:14:11.461Z";
  assert.equal(viewPublicationAt({ lite: true, snapshotAt: at }), at);
  assert.equal(viewPublicationAt({ lite: false, overviewAt: at }), at);
  assert.equal(
    viewPublicationAt({ lite: true, overviewAt: null, snapshotAt: at }),
    at,
  );
  assert.equal(viewPublicationAt({ lite: true }), null);
  assert.equal(viewPublicationAt({ lite: false, snapshotAt: "nope" }), null);
  // An unreadable time is not used in place of the other file's good one.
  assert.equal(
    viewPublicationAt({ lite: true, overviewAt: "nope", snapshotAt: at }),
    at,
  );
});

test("a snapshot next to a newer overview keeps its figures when judged at its own time", () => {
  // The bug: one shared clock. The overview (3 h newer than the snapshot)
  // froze it, and the snapshot's five-minute-old measurements counted as
  // expired under a banner that still said it was fresh.
  const snapshot = fixture();
  const snapshotAt = snapshot.generatedAt;
  const overviewAt = iso(Date.parse(snapshotAt) + 3 * HOUR);
  const judgedAt = (lite) =>
    Date.parse(viewPublicationAt({ lite, snapshotAt, overviewAt }));

  const own = refreshMarketSnapshot(snapshot, judgedAt(false));
  assert.deepEqual(own.summary.volumeUsd, { h1: 176, h6: 1016, h24: 3731 });
  const shared = refreshMarketSnapshot(snapshot, judgedAt(true));
  assert.equal(shared.summary.volumeUsd.h24, null, "judged at the overview");
  assert.notDeepEqual(own.summary.volumeUsd, shared.summary.volumeUsd);
});

test("the clock is no longer written by a file that merely loaded last", () => {
  // The hook never freezes the shared clock; App.tsx sets it in the render from
  // viewPublicationAt, and fetchSnapshot no longer freezes it either.
  const hook = source("src/useAnalyticsOverview.ts");
  assert.doesNotMatch(hook, /freezeEvaluationClock/);
  const app = source("src/App.tsx");
  assert.doesNotMatch(app, /freezeEvaluationClock\(shown/);
  assert.match(
    app,
    /if \(STATIC_EDITION\)\s*freezeEvaluationClock\(\s*viewPublicationAt\(\{\s*lite: analyticsLite,/,
  );
  // And the freeze it does make is the editions's: the live clock stays the visitor's.
  freezeEvaluationClock(GENERATED_AT);
  assert.ok(Math.abs(evaluationNow() - Date.now()) < 1000);
});

test("a file older than the one on screen is recognised, an equal or unreadable one is not", () => {
  const shown = "2026-10-28T03:14:00.000Z";
  assert.equal(isOlderPublication("2026-10-28T00:14:11.461Z", shown), true);
  assert.equal(isOlderPublication(shown, shown), false);
  assert.equal(isOlderPublication("2026-10-28T06:00:00.000Z", shown), false);
  assert.equal(isOlderPublication(Date.parse(shown) - 1, shown), true);
  assert.equal(isOlderPublication("nope", shown), false);
  assert.equal(isOlderPublication(shown, undefined), false);
  assert.equal(isOlderPublication(null, shown), false);
});

/* ── An overview file the host does not have ───────────────────────────── */

test("a 404 on one network's overview means it is not published; on the all-networks file it can pass", () => {
  assert.equal(overviewAnswer(404, "atlantis"), "not-published");
  assert.equal(overviewAnswer(404, "base"), "not-published");
  assert.equal(overviewAnswer(404, "all"), "failed");
  assert.equal(overviewAnswer(429, "atlantis"), "busy");
  assert.equal(overviewAnswer(429, "all"), "busy");
  for (const status of [400, 403, 500, 502, 503])
    assert.equal(overviewAnswer(status, "atlantis"), "failed", String(status));
});

test("the title for an unpublished network says what the page knows and nothing more", () => {
  assert.equal(
    NOT_PUBLISHED_TITLE,
    "No analytics are published for this network in this snapshot",
  );
});

test("the overview hook maps the 404, remembers it and keeps its Retry for what can pass", () => {
  const hook = source("src/useAnalyticsOverview.ts");
  assert.match(
    hook,
    /overviewAnswer\(response\.status, query\.chain\) === "not-published"/,
  );
  assert.match(hook, /unpublished\.add\(staticUrl\)/);
  assert.match(
    hook,
    /if \(staticUrl !== null && unpublished\.has\(staticUrl\)\)/,
  );
  assert.match(hook, /notPublished\?: boolean/);
  // The live page keeps its 30 s deadline; only the edition has the stall guard.
  assert.match(
    hook,
    /const deadline = stall\s*\?\s*undefined\s*:\s*setTimeout\(\(\) => controller\.abort\(\), 30000\)/,
  );
});

/* ── Files from two runs ───────────────────────────────────────────────── */

test("an overview newer than the snapshot asks for the snapshot again, up to three times, then says so", () => {
  const snapshotAt = "2026-10-28T00:14:11.461Z";
  const overviewAt = "2026-10-28T03:14:00.000Z";
  assert.equal(RECONCILE_ATTEMPTS, 3);
  for (let used = 0; used < RECONCILE_ATTEMPTS; used++)
    assert.equal(
      reconcileStep(overviewAt, snapshotAt, used),
      "reload-snapshot",
      `attempt ${used + 1}`,
    );
  assert.equal(reconcileStep(overviewAt, snapshotAt, 3), "late");
  assert.equal(reconcileStep(overviewAt, snapshotAt, 9), "late");
});

test("a snapshot newer than the overview asks for the overview again, with the same limit", () => {
  const overviewAt = "2026-10-28T00:14:11.461Z";
  const snapshotAt = "2026-10-28T03:14:00.000Z";
  assert.equal(reconcileStep(overviewAt, snapshotAt, 0), "reload-overview");
  assert.equal(reconcileStep(overviewAt, snapshotAt, 2), "reload-overview");
  assert.equal(reconcileStep(overviewAt, snapshotAt, 3), "late");
});

test("two files of one run are settled, however many attempts were used; unreadable times are left alone", () => {
  const at = "2026-10-28T00:14:11.461Z";
  assert.equal(reconcileStep(at, at, 0), "settled");
  assert.equal(reconcileStep(at, at, 7), "settled");
  assert.equal(reconcileStep(null, at, 0), "settled");
  assert.equal(reconcileStep(at, "nope", 0), "settled");
});

test("the page names the wait in one calm line and the retried address carries the run", () => {
  assert.equal(
    PUBLISHING_NOTE,
    "A newer snapshot is still being published; reload in a minute.",
  );
  assert.equal(
    withRun("/data/overview-all-h24.json", "2026-10-28T03:14:00.000Z"),
    "/data/overview-all-h24.json?v=2026-10-28T03%3A14%3A00.000Z",
  );
  assert.equal(
    snapshotUrlFor("2026-10-28T03:14:00.000Z", "/repo/"),
    "/repo/data/snapshot.json?v=2026-10-28T03%3A14%3A00.000Z",
  );
});

test("the first snapshot request takes the plain-address request the head script started; every other request makes its own", () => {
  const app = source("src/App.tsx");
  // The page's early request (vite.config.ts) is taken once, by the first plain
  // request only; a retry has a fetch of its own, and a retry for a given run is
  // the only one with another address.
  assert.match(
    app,
    /STATIC_EDITION && !newerThan\s*\?\s*takeEarlySnapshot\(snapshotUrl\(\), controller\.signal\)\s*:\s*null;\s*const response = early\s*\?\s*await early/,
  );
  assert.match(
    app,
    /STATIC_EDITION\s*\?\s*await fetch\(snapshotUrl\(\), \{\s*signal: controller\.signal,\s*cache: "no-cache",\s*\}\)/,
  );
  assert.match(
    app,
    /STATIC_EDITION && newerThan\s*\?\s*await fetch\(snapshotUrlFor\(newerThan\), \{\s*signal: controller\.signal,\s*cache: "no-cache",\s*\}\)/,
  );
  // One request for the file, never a parallel second: the history is another
  // file. (The address appears twice: where the early request is taken, and
  // where the page makes its own.)
  assert.equal(app.match(/snapshotUrl\(\)/g).length, 2);
});

test("a run asked for once is not carried into later requests for the file", () => {
  // A cache that keys on the address would hand back the old copy of a file
  // asked for under last deploy's run: the run is read when a request starts, it
  // is no reason to start one, and it is cleared once the files agree (or the
  // tries are used up).
  const hook = source("src/useAnalyticsOverview.ts");
  assert.match(hook, /runRef\.current = run;/);
  assert.match(
    hook,
    /\?\s*runRef\.current\s*\?\s*withRun\(staticUrl, runRef\.current\)/,
  );
  assert.match(hook, /\}, \[enabled, key, retry, revision\]\);/);
  const app = source("src/App.tsx");
  assert.match(
    app,
    /if \(step === "settled" \|\| step === "late"\) \{[^}]*setOverviewRunWanted\(null\);\s*return;\s*\}/,
  );
  assert.match(
    app,
    /function retryOverview\(\) \{\s*setOverviewRunWanted\(null\);/,
  );
});

test("a snapshot older than the one on screen is never shown", () => {
  const app = source("src/App.tsx");
  assert.match(
    app,
    /const held = sourceRef\.current;\s*if \(held && isOlderPublication\(data\.generatedAt, held\.generatedAt\)\) \{[^}]*return;\s*\}\s*shown = prepareEditionSnapshot/,
  );
  const hook = source("src/useAnalyticsOverview.ts");
  assert.match(
    hook,
    /isOlderPublication\(\s*shown\.publication\.generatedAt,\s*previous\.data\.publication\.generatedAt,?\s*\)/,
  );
});

test("the unknown ids of a link are kept, and only the carried ones are counted", () => {
  const app = source("src/App.tsx");
  // The effect that dropped them (and rewrote the address) is gone.
  assert.doesNotMatch(
    app,
    /setComparison\(\(ids\) =>\s*ids\.every\(\(id\) => known\.has\(id\)\)/,
  );
  assert.match(app, /const carriedComparison = useMemo\(/);
  assert.match(app, /ids=\{comparison\}/, "Compare gets every id of the link");
  for (const counted of [
    /carriedComparison\.length && view !== "compare"/,
    /\{carriedComparison\.length > 0 && \(\s*<span className="nav-count">/,
    /\{carriedComparison\.length\} selected/,
    /else if \(carriedComparison\.length < 4\)/,
    /\[view, carriedComparison\.length, watchlist\.length\]/,
  ])
    assert.match(app, counted, String(counted));
  assert.doesNotMatch(
    app,
    /\bcomparison\.length\b/,
    "no count of the raw list is left",
  );
});

/* ── A download that has stopped ───────────────────────────────────────── */

test("a download stalls after thirty silent seconds, not after a total time", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    assert.equal(STALL_MS, 30_000);
    let calls = 0;
    const guard = createStallGuard(() => calls++);
    mock.timers.tick(29_999);
    assert.equal(calls, 0);
    assert.equal(guard.stalled(), false);
    mock.timers.tick(1);
    assert.equal(calls, 1);
    assert.equal(guard.stalled(), true);
    // It fires once, and bytes after the stop do not start it again.
    guard.touch();
    mock.timers.tick(120_000);
    assert.equal(calls, 1);
  } finally {
    mock.timers.reset();
  }
});

test("bytes keep a download alive however long it takes: nothing like a 90 s cap", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let calls = 0;
    const guard = createStallGuard(() => calls++);
    // 6 minutes on a slow link, a piece every 20 s.
    for (let piece = 0; piece < 18; piece++) {
      mock.timers.tick(20_000);
      guard.touch();
    }
    assert.equal(calls, 0);
    assert.equal(guard.stalled(), false);
    // The link then stops.
    mock.timers.tick(30_000);
    assert.equal(calls, 1);
  } finally {
    mock.timers.reset();
  }
});

test("a finished download is not reported as stalled later", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let calls = 0;
    const guard = createStallGuard(() => calls++, 1000);
    mock.timers.tick(500);
    guard.stop();
    mock.timers.tick(10_000);
    assert.equal(calls, 0);
    assert.equal(guard.stalled(), false);
    guard.touch();
    mock.timers.tick(10_000);
    assert.equal(calls, 0, "touch after stop does not re-arm");
  } finally {
    mock.timers.reset();
  }
});

const streamOf = (pieces) =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const piece of pieces)
          controller.enqueue(new TextEncoder().encode(piece));
        controller.close();
      },
    }),
  );

test("a body is read piece by piece, each piece counting as progress", async () => {
  let touched = 0;
  const value = await readJsonBody(
    streamOf(['{"a":', "[1,2,", '3],"b":"é"}']),
    () => touched++,
  );
  assert.deepEqual(value, { a: [1, 2, 3], b: "é" });
  assert.equal(touched, 3);
});

test("a multi-byte character split across pieces is read whole", async () => {
  const bytes = new TextEncoder().encode('{"name":"Ünï"}');
  const cut = bytes.indexOf(0xc3) + 1; // between the two bytes of "Ü"
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, cut));
        controller.enqueue(bytes.slice(cut));
        controller.close();
      },
    }),
  );
  assert.deepEqual(await readJsonBody(response), { name: "Ünï" });
});

test("a body that is not JSON is a SyntaxError, and a cut body rejects", async () => {
  await assert.rejects(() => readJsonBody(streamOf(["<html>"])), SyntaxError);
  await assert.rejects(() => readJsonBody(streamOf(['{"a":1'])), SyntaxError);
  const broken = new Response(
    new ReadableStream({
      pull() {
        throw new TypeError("network error");
      },
    }),
  );
  await assert.rejects(() => readJsonBody(broken), TypeError);
});

test("a response with no stream is read whole", async () => {
  const value = await readJsonBody({
    body: null,
    json: async () => ({ ok: 1 }),
  });
  assert.deepEqual(value, { ok: 1 });
});

/* ── What a failed load says ───────────────────────────────────────────── */

const BANNED = /data service|cooling down|saved data is verified|refresh/i;

test("no failure of a static host talks about a service, a refresh or verified saved data", () => {
  const failures = [
    { kind: "status", status: 404 },
    { kind: "status", status: 403 },
    { kind: "status", status: 429 },
    { kind: "status", status: 500 },
    { kind: "status", status: 503 },
    { kind: "network" },
    { kind: "unreadable" },
    { kind: "stalled" },
  ];
  for (const failure of failures)
    for (const text of [
      snapshotFailureMessage(failure),
      overviewFailureMessage(failure),
    ]) {
      assert.doesNotMatch(text, BANNED, text);
      // Every one says what to do next.
      assert.match(text, /try again|Check your connection/i, text);
    }
});

test("the snapshot sentence for a missing or failing file is the plain one", () => {
  const plain =
    "The snapshot could not be loaded. The site may be updating; try again in a few minutes.";
  for (const status of [404, 403, 500, 502, 503])
    assert.equal(
      snapshotFailureMessage({ kind: "status", status }),
      plain,
      String(status),
    );
  assert.equal(
    snapshotFailureMessage({ kind: "status", status: 429 }),
    "The snapshot could not be loaded. The host is busy; try again in a minute.",
  );
  assert.equal(
    snapshotFailureMessage({ kind: "network" }),
    "The snapshot could not be loaded. Check your connection and try again.",
  );
  assert.equal(
    snapshotFailureMessage({ kind: "unreadable" }),
    "The snapshot could not be read. The site may be updating; try again in a few minutes.",
  );
  assert.equal(
    snapshotFailureMessage({ kind: "stalled" }),
    "The snapshot stopped downloading. Check your connection and try again.",
  );
});

test("an analytics file that cannot be read is told apart from a lost connection", () => {
  assert.notEqual(
    overviewFailureMessage({ kind: "unreadable" }),
    overviewFailureMessage({ kind: "network" }),
  );
  assert.match(
    overviewFailureMessage({ kind: "network" }),
    /Check your connection/,
  );
  assert.doesNotMatch(
    overviewFailureMessage({ kind: "unreadable" }),
    /connection/,
  );
  assert.match(overviewFailureMessage({ kind: "status", status: 429 }), /busy/);
});

test("a thrown value is sorted into the failure it stands for", () => {
  assert.deepEqual(failureOf(new TypeError("Failed to fetch"), false), {
    kind: "network",
  });
  assert.deepEqual(failureOf(new SyntaxError("Unexpected token"), false), {
    kind: "unreadable",
  });
  // The guard's abort wins over whatever the aborted read threw.
  assert.deepEqual(failureOf(new DOMException("aborted", "AbortError"), true), {
    kind: "stalled",
  });
  assert.deepEqual(failureOf(new TypeError("x"), true), { kind: "stalled" });
  // A message the code threw itself is shown as it is.
  assert.equal(
    failureOf(new Error("Analytics response exceeded its safe size."), false),
    null,
  );
});

test("the page stops trying by itself after five attempts", () => {
  assert.equal(RECONNECT_LIMIT, 5);
  const app = source("src/App.tsx");
  assert.match(
    app,
    /\(!serviceStarting && \(snapshot \|\| !error\)\) \|\|\s*\(STATIC_EDITION && connectionFailures > RECONNECT_LIMIT\)/,
  );
});

test("the edition's failure copy replaces the live wording only behind the flag", () => {
  const app = source("src/App.tsx");
  // The live strings are still there for the live build.
  for (const live of [
    "Refresh is cooling down. Try again shortly.",
    "The data service is temporarily unavailable. Please retry.",
    "We couldn’t reach the data service. Check your connection and try again.",
    "The data service took too long. Please retry.",
    "We’ll reconnect automatically. Your saved watchlist is safe.",
  ])
    assert.ok(app.includes(live), live);
  // The edition's request has a stall guard where the live one has its 90 s cap.
  assert.match(
    app,
    /const timer = stall\s*\?\s*undefined\s*:\s*setTimeout\(\(\) => controller\.abort\(\), 90000\)/,
  );
  assert.match(
    app,
    /const stall = STATIC_EDITION\s*\?\s*createStallGuard\(\(\) => controller\.abort\(\)\)\s*:\s*null/,
  );
  assert.match(app, /readJsonBody\(response, stall\?\.touch\)/);
  // One Retry: the notice keeps it; the empty panel gives its button up in the edition.
  assert.match(app, /STATIC_EDITION && error \? undefined : \(/);
  // The history file is read beside the snapshot, not after it.
  assert.match(
    app,
    /const recorded = STATIC_EDITION\s*\?\s*loadRecordedHistory\(controller\.signal\)\s*:\s*null;/,
  );
  assert.match(app, /shown = prepareEditionSnapshot\(data, await recorded\)/);
});

/* ── The watchlist key ─────────────────────────────────────────────────── */

test("the watchlist is written only by a star, an un-star and a Forget; the bulk removal is the live page's", () => {
  const app = source("src/App.tsx");
  const writes = [
    ...app.matchAll(/localStorage\.setItem\("hook-radar-watchlist-v1"/g),
  ];
  assert.equal(
    writes.length,
    2,
    "toggleWatch and the live page's removeUnavailableWatches",
  );
  // The edition's notice offers a Forget for each entry and no bulk button.
  const edition = app.slice(
    app.indexOf("(STATIC_EDITION ? ("),
    app.indexOf('<div className="notice orphan-notice" role="status">'),
  );
  assert.match(edition, /Forget/);
  assert.match(edition, /onClick=\{\(\) => toggleWatch\(id\)\}/);
  assert.doesNotMatch(edition, /removeUnavailableWatches|Remove unavailable/);
  // The one place the live button is rendered is the non-edition branch.
  assert.equal(app.match(/onClick=\{removeUnavailableWatches\}/g).length, 1);
});

/* ── The state follows the address ─────────────────────────────────────── */

test("adding a project cuts Compare's state to the four ids the address keeps", () => {
  const app = source("src/App.tsx");
  // The ids a link names that the snapshot lacks go last, and the ones past the
  // fourth leave the state in the same step they leave the address; otherwise
  // Compare says "This link names ..." about an id the link no longer has.
  assert.match(
    app,
    /carriedFirst\(\s*next,\s*new Set\(sourceSnapshot\.projects\.map\(\(project\) => project\.id\)\),?\s*\)\.slice\(0, 4\)/,
  );
  assert.deepEqual(
    carriedFirst(
      ["a", "b", "c", "gone", "d"],
      new Set(["a", "b", "c", "d"]),
    ).slice(0, 4),
    ["a", "b", "c", "d"],
  );
});

test("the 'All networks' buttons of an Analytics page with no figures keep focus on the page", () => {
  const app = source("src/App.tsx");
  // The button is replaced once the all-networks page starts to load, so focus
  // moves to the heading first, and only when there is a network to leave. The
  // focus move is the edition's: the live build's button only changes the chain
  // (changed here for the review finding that it had reached the live build).
  assert.match(
    app,
    /function showAllAnalyticsNetworks\(\) \{\s*if \(analyticsChain === "all"\) return;\s*if \(STATIC_EDITION\) viewHeadingRef\.current\?\.focus\(\{ preventScroll: true \}\);\s*changeAnalyticsChain\("all"\);\s*\}/,
  );
  assert.equal(app.match(/onClick=\{showAllAnalyticsNetworks\}/g).length, 2);
  // No "All networks" button on these pages calls the bare change any more.
  assert.doesNotMatch(
    app,
    /onClick=\{\(\) => changeAnalyticsChain\("all"\)\}\s*>\s*All networks/,
  );
});
