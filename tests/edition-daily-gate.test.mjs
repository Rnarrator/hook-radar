import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectPublishedData } from "../scripts/check-edition-data.mjs";
import {
  DAILY_FILE_MAX_POOLS,
  DAILY_PAGE_NEWER_DAYS,
  DAILY_SOURCE_ID,
  DAILY_SPANS,
  dailyPageProblem,
  dailyRunProblem,
  dayLabel,
  dayNumber,
  lastCompleteDay,
  parseDayLabel,
  validateDailyShape,
} from "../shared/daily-volume.ts";

// The one definition of a valid 7D and 30D file, the data gate that refuses
// what it rejects, and the page's own reading of it. Folders are written by the
// test, with the files a collector run writes.

const GENERATED = "2026-11-12T01:30:00.000Z";
const A = `ethereum:0x${"a".repeat(64)}`;
const B = `base:0x${"b".repeat(64)}`;
const row = (id, over = {}) => ({
  id,
  v7: 100,
  v30: 400,
  at: "2026-11-12T00:50:00.000Z",
  ...over,
});
const file = (over = {}) => ({
  schemaVersion: 1,
  snapshotGeneratedAt: GENERATED,
  through: "2026-11-11",
  source: "geckoterminal",
  pools: [row(A), row(B)].sort((x, y) => (x.id < y.id ? -1 : 1)),
  ...over,
});
const view = (sources = [{ id: "dexscreener" }, { id: DAILY_SOURCE_ID }]) => ({
  generatedAt: GENERATED,
  sources,
});

test("the spans are 7 and 30 complete UTC days", () => {
  assert.deepEqual({ ...DAILY_SPANS }, { d7: 7, d30: 30 });
  assert.equal(DAILY_SOURCE_ID, "geckoterminal-daily");
});

test("UTC day arithmetic: the last complete day, and a label that is a real date", () => {
  const ms = Date.parse(GENERATED);
  assert.equal(dayLabel(lastCompleteDay(ms)), "2026-11-11");
  assert.equal(dayLabel(lastCompleteDay(Date.parse("2026-11-12T00:00:00.000Z"))), "2026-11-11");
  assert.equal(dayLabel(lastCompleteDay(Date.parse("2026-11-11T23:59:59.999Z"))), "2026-11-10");
  assert.equal(dayNumber(Date.parse("2026-11-12T00:00:00.000Z")), lastCompleteDay(ms) + 1);
  assert.equal(parseDayLabel("2026-11-11"), lastCompleteDay(ms));
  for (const bad of ["2026-02-30", "2026-13-01", "2026-1-1", "20261111", "", null, 5, "2026-11-11T00:00:00Z"])
    assert.equal(parseDayLabel(bad), null, String(bad));
});

test("a valid file passes the shared shape check, with and without the young-pool days", () => {
  assert.equal(validateDailyShape(file()).ok, true);
  const young = file({
    pools: [row(A, { v7: 10, v30: 10, n7: 3, n30: 3 }), row(B, { n30: 12 })].sort(
      (x, y) => (x.id < y.id ? -1 : 1),
    ),
  });
  assert.equal(validateDailyShape(young).ok, true);
  assert.equal(validateDailyShape(file({ pools: [row(A, { v7: 0, v30: 0 })] })).ok, true, "a measured zero is a value");
});

const INVALID = {
  "not an object": () => [],
  null: () => null,
  "another schema version": () => file({ schemaVersion: 2 }),
  "a field that is not part of the file": () => ({ ...file(), extra: 1 }),
  "no snapshot time": () => file({ snapshotGeneratedAt: "yesterday" }),
  "an end day that is not a date": () => file({ through: "2026-02-30" }),
  "an end day with a time": () => file({ through: "2026-11-11T00:00:00Z" }),
  "another source": () => file({ source: "dexscreener" }),
  "pools that are not a list": () => file({ pools: {} }),
  "a list with no pool in it": () => file({ pools: [] }),
  "more than 200 pools": () =>
    file({
      pools: Array.from({ length: DAILY_FILE_MAX_POOLS + 1 }, (_, i) =>
        row(`ethereum:0x${i.toString(16).padStart(64, "0")}`),
      ),
    }),
  "a pool that is not an object": () => file({ pools: [1] }),
  "a pool with a field of its own": () => file({ pools: [{ ...row(A), name: "x" }] }),
  "an id without a network": () => file({ pools: [row(`0x${"a".repeat(64)}`)] }),
  "an id in upper case": () => file({ pools: [row(`ethereum:0x${"A".repeat(64)}`)] }),
  "an id that is too short": () => file({ pools: [row("ethereum:0xabc")] }),
  "the same pool twice": () => file({ pools: [row(A), row(A)] }),
  "pools out of order": () => file({ pools: [row(A), row(B)] }),
  "a 7D that is text": () => file({ pools: [row(A, { v7: "100" })] }),
  "a 7D that is not finite": () => file({ pools: [row(A, { v7: null })] }),
  "a negative volume": () => file({ pools: [row(A, { v7: -1 })] }),
  "an absurd volume": () => file({ pools: [row(A, { v30: 1e13 })] }),
  "a 30D below the 7D": () => file({ pools: [row(A, { v7: 500, v30: 400 })] }),
  "a reading with no time": () => file({ pools: [row(A, { at: "x" })] }),
  "an n7 without an n30": () => file({ pools: [row(A, { n7: 3 })] }),
  "an n7 of 7": () => file({ pools: [row(A, { n7: 7, n30: 7 })] }),
  "an n7 of 0": () => file({ pools: [row(A, { n7: 0, n30: 3 })] }),
  "an n30 of 30": () => file({ pools: [row(A, { n30: 30 })] }),
  "an n30 below its n7": () => file({ pools: [row(A, { n7: 5, n30: 4 })] }),
  "a fractional n30": () => file({ pools: [row(A, { n30: 3.5 })] }),
};
for (const [label, make] of Object.entries(INVALID))
  test(`the shared shape check refuses ${label}`, () => {
    const result = validateDailyShape(make());
    assert.equal(result.ok, false);
    assert.equal(typeof result.reason, "string");
  });

test("run rules: the file belongs to this snapshot, ends on its newest complete day or the one before, counts only ended days, and is named as a source once", () => {
  const ok = (over, v = view()) => dailyRunProblem(validateDailyShape(file(over)).file, v);
  assert.equal(ok({}), null);
  assert.equal(ok({ through: "2026-11-10", pools: [row(A, { at: "2026-11-11T01:00:00.000Z" })] }), null, "one day behind is allowed");
  assert.match(ok({ snapshotGeneratedAt: "2026-11-12T01:29:00.000Z" }), /another run/);
  assert.match(ok({ through: "2026-11-12" }), /neither the last complete day/, "the day in progress is never an end day");
  assert.match(ok({ through: "2026-11-09", pools: [row(A, { at: "2026-11-10T01:00:00.000Z" })] }), /neither the last complete day/);
  assert.match(
    ok({ pools: [row(A, { at: "2026-11-11T22:00:00.000Z" })] }),
    /read before 2026-11-11 had ended/,
    "a day read before it ended was not complete",
  );
  assert.match(ok({ pools: [row(A, { at: "2026-11-12T02:01:00.000Z" })] }), /read long after the snapshot time/);
  assert.equal(ok({ pools: [row(A, { at: "2026-11-12T01:59:00.000Z" })] }), null);
  assert.match(ok({}, view([{ id: "dexscreener" }])), /does not name it as a source exactly once/);
  assert.match(
    ok({}, view([{ id: DAILY_SOURCE_ID }, { id: DAILY_SOURCE_ID }])),
    /exactly once/,
  );
});

test("the page's rule: an end day from one day behind the shown snapshot to two days ahead of it", () => {
  const shown = Date.parse(GENERATED);
  const at = (through) => dailyPageProblem(validateDailyShape(file({ through })).file, shown);
  assert.equal(at("2026-11-11"), null);
  assert.equal(at("2026-11-10"), null, "one day behind");
  assert.match(at("2026-11-09"), /too old/);
  assert.equal(at("2026-11-13"), null, "a file of a later run, with its own dates");
  assert.equal(at("2026-11-11".replace("11-11", "11-13")), null);
  assert.match(at("2026-11-14"), /later than this snapshot/);
  assert.equal(DAILY_PAGE_NEWER_DAYS, 2);
});

// The gate over a folder.

async function folder(t, { snapshot = { generatedAt: GENERATED, sources: [{ id: "dexscreener" }, { id: DAILY_SOURCE_ID }] }, daily, status = { generatedAt: GENERATED } } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "edition-daily-gate-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  if (snapshot) await writeFile(join(dir, "snapshot.json"), JSON.stringify(snapshot));
  if (status) await writeFile(join(dir, "status.json"), JSON.stringify(status));
  if (daily !== undefined)
    await writeFile(join(dir, "daily.json"), typeof daily === "string" ? daily : JSON.stringify(daily));
  return dir;
}
const problems = async (dir) => (await inspectPublishedData(dir)).problems;
const none = { snapshot: { generatedAt: GENERATED, sources: [{ id: "dexscreener" }] } };

test("the gate passes a folder with a valid daily.json, and one with neither the file nor the source row", async (t) => {
  assert.deepEqual(await problems(await folder(t, { daily: file() })), []);
  assert.deepEqual(await problems(await folder(t, { ...none })), []);
});

test("the gate refuses a daily.json from another run", async (t) => {
  const dir = await folder(t, { daily: file({ snapshotGeneratedAt: "2026-11-12T00:20:00.000Z" }) });
  assert.match((await problems(dir)).join("; "), /daily\.json: it belongs to another run than snapshot\.json/);
});

test("the gate refuses a partial day marked complete, in either way it can be marked", async (t) => {
  // An end day that is the day in progress.
  const inProgress = await folder(t, { daily: file({ through: "2026-11-12" }) });
  assert.match((await problems(inProgress)).join("; "), /neither the last complete day/);
  // A reading taken before the end day was over.
  const early = await folder(t, {
    daily: file({ pools: [row(A, { at: "2026-11-11T23:59:59.000Z" })] }),
  });
  assert.match((await problems(early)).join("; "), /read before 2026-11-11 had ended/);
});

test("the gate refuses a 7D above a 30D, duplicate or malformed ids, and a field it does not know", async (t) => {
  for (const daily of [
    file({ pools: [row(A, { v7: 9, v30: 5 })] }),
    file({ pools: [row(A), row(A)] }),
    file({ pools: [row("0xnot-a-pool")] }),
    { ...file(), name: "x" },
  ]) {
    const found = await problems(await folder(t, { daily }));
    assert.equal(found.length, 1, JSON.stringify(found));
    assert.match(found[0], /daily\.json is not valid: /);
  }
});

test("the gate keeps the file and the source row in step: one without the other is refused", async (t) => {
  assert.match(
    (await problems(await folder(t, { daily: file(), snapshot: none.snapshot }))).join("; "),
    /does not name it as a source exactly once/,
  );
  assert.match(
    (await problems(await folder(t, {}))).join("; "),
    /names the daily volume as a source but daily\.json is missing/,
  );
  assert.match(
    (
      await problems(
        await folder(t, {
          daily: file(),
          snapshot: { generatedAt: GENERATED, sources: [{ id: DAILY_SOURCE_ID }, { id: DAILY_SOURCE_ID }] },
        }),
      )
    ).join("; "),
    /exactly once/,
  );
});

test("the gate refuses a daily.json that is not JSON, and one that sits beside no snapshot", async (t) => {
  assert.match(
    (await problems(await folder(t, { daily: "<<<<<<< HEAD" }))).join("; "),
    /daily\.json cannot be read: it is not valid JSON/,
  );
  const lonely = await folder(t, { snapshot: null, status: null, daily: file() });
  assert.match((await problems(lonely)).join("; "), /no snapshot\.json/);
});

test("a gate that is given the real script on a real folder exits non-zero for a bad daily.json", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const bad = await folder(t, { daily: file({ snapshotGeneratedAt: "2026-11-12T00:20:00.000Z" }) });
  const good = await folder(t, { daily: file() });
  const run = (dir) =>
    spawnSync(process.execPath, ["scripts/check-edition-data.mjs", dir], {
      encoding: "utf8",
    });
  const refused = run(bad);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /daily\.json: it belongs to another run/);
  const passed = run(good);
  assert.equal(passed.status, 0, passed.stderr);
});
