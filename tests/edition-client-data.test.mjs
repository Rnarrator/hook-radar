import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  historyUpTo,
  parseHistory,
  parseRunTimes,
  prepareEditionSnapshot,
  withRecordedHistory,
} from "../src/edition.ts";
import { editionDirectory, loadRecordedHistory } from "../src/edition-data.ts";
import { isSnapshot } from "../src/model.ts";
import { isAnalyticsOverviewEnvelope } from "../shared/analytics-overview.ts";
import {
  CENSUS_AT,
  GENERATED_AT,
  buildStaticFixtures,
} from "./fixtures/static-data/generate.mjs";

const dataDir = new URL("./fixtures/static-data/data/", import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, dataDir), "utf8"));
const generated = Date.parse(GENERATED_AT);

test("the committed fixture files are exactly what the generator builds", async () => {
  const built = await buildStaticFixtures();
  const names = Object.keys(built).sort();
  assert.deepEqual(readdirSync(dataDir).sort(), names);
  for (const name of names)
    assert.deepEqual(read(name), JSON.parse(JSON.stringify(built[name])), name);
});

test("the fixtures pass the validators the live client uses", () => {
  assert.equal(isSnapshot(read("snapshot.json")), true);
  for (const name of readdirSync(dataDir).filter((file) =>
    file.startsWith("overview-"),
  )) {
    const [, chain, window] = name.replace(".json", "").split("-");
    assert.equal(
      isAnalyticsOverviewEnvelope(read(name), { chain, window }),
      true,
      name,
    );
  }
});

test("no fixture measurement is dated after the snapshot, and the files are marked as fixtures", () => {
  const snapshot = read("snapshot.json");
  for (const pool of snapshot.pools)
    if (pool.metricUpdatedAt)
      assert.ok(Date.parse(pool.metricUpdatedAt) <= generated, pool.id);
  assert.equal(snapshot.generatedAt, GENERATED_AT);
  assert.equal(snapshot.inventory.generatedAt, CENSUS_AT);
  assert.equal(read("status.json").collectorVersion, "fixture");
  assert.equal(read("overview-all-h24.json").asOf, GENERATED_AT);
});

test("recorded history is read exactly as written", () => {
  const points = parseHistory(read("history.json"));
  assert.equal(points.length, 5);
  assert.deepEqual(points[0], { timestamp: generated - 12 * 3_600_000, value: 3100 });
  assert.equal(points.at(-1).timestamp, generated);
  assert.equal(points.at(-1).value, 3731);
});

test("a history file that is not one is refused rather than guessed at", () => {
  const good = { schemaVersion: 1, points: [{ timestamp: 1_700_000_000_000, value: 1 }] };
  assert.ok(parseHistory(good));
  assert.deepEqual(parseHistory({ schemaVersion: 1, points: [] }), []);
  for (const bad of [
    null,
    [],
    "text",
    { schemaVersion: 2, points: [] },
    { points: [] },
    { schemaVersion: 1 },
    { schemaVersion: 1, points: {} },
    { schemaVersion: 1, points: [null] },
    { schemaVersion: 1, points: [{ timestamp: 1_700_000_000_000, value: -1 }] },
    { schemaVersion: 1, points: [{ timestamp: 1_700_000_000_000, value: "3" }] },
    { schemaVersion: 1, points: [{ timestamp: "x", value: 1 }] },
    { schemaVersion: 1, points: [{ timestamp: 0, value: 1 }] },
    {
      schemaVersion: 1,
      points: [
        { timestamp: 1_700_000_100_000, value: 1 },
        { timestamp: 1_700_000_000_000, value: 1 },
      ],
    },
    {
      schemaVersion: 1,
      points: Array.from({ length: 673 }, (_, index) => ({
        timestamp: 1_700_000_000_000 + index,
        value: 1,
      })),
    },
  ])
    assert.equal(parseHistory(bad), null, JSON.stringify(bad).slice(0, 80));
});

test("history never reaches past the time an overview was evaluated", () => {
  const points = parseHistory(read("history.json"));
  assert.equal(historyUpTo(points, GENERATED_AT).length, 5);
  assert.equal(historyUpTo(points, new Date(generated - 1).toISOString()).length, 4);
  assert.deepEqual(historyUpTo(points, "garbage"), []);
});

test("the all-networks overview takes the recorded history and stays valid", () => {
  const points = parseHistory(read("history.json"));
  const all = read("overview-all-h24.json");
  assert.equal(all.history.points.length, 0);
  const merged = withRecordedHistory(all, points);
  assert.equal(merged.history.points.length, 5);
  assert.equal(merged.history.available, true);
  assert.equal(
    isAnalyticsOverviewEnvelope(merged, { chain: "all", window: "h24" }),
    true,
  );
  // The original object is untouched.
  assert.equal(all.history.points.length, 0);
});

test("a single network, no history and an empty file leave the overview as it is", () => {
  const points = parseHistory(read("history.json"));
  const base = read("overview-base-h24.json");
  assert.equal(withRecordedHistory(base, points), base);
  const all = read("overview-all-h24.json");
  assert.equal(withRecordedHistory(all, null), all);
  assert.equal(withRecordedHistory(all, []), all);
});

test("the edition drops what only a live service could serve and keeps every value", () => {
  const source = read("snapshot.json");
  source.projects[0].poolInventory = { poolCount: 3, complete: true, chains: { base: 3 } };
  source.directory = { mode: "paginated", totalProjects: 5, totalDeployments: 7, loadedProjects: 5 };
  const before = JSON.stringify(source);
  const points = parseHistory(read("history.json"));
  const prepared = prepareEditionSnapshot(source, points);
  assert.equal(JSON.stringify(source), before, "the input is not changed");
  assert.equal(prepared.directory, undefined);
  assert.ok(prepared.projects.every((project) => project.poolInventory === undefined));
  assert.equal(prepared.history.length, 5);
  assert.deepEqual(prepared.pools, source.pools);
  assert.deepEqual(prepared.inventory, source.inventory);
  assert.equal(prepared.generatedAt, source.generatedAt);
  assert.equal(isSnapshot(prepared), true);
});

test("without recorded history the snapshot keeps its own series", () => {
  const source = { ...read("snapshot.json"), history: [{ timestamp: 5, value: 6 }] };
  assert.deepEqual(prepareEditionSnapshot(source, null).history, source.history);
  assert.deepEqual(prepareEditionSnapshot(source, []).history, source.history);
});

test("the run times in the status file are shown only when they are times", () => {
  const run = parseRunTimes(read("status.json"));
  assert.equal(run.burstEndedAt, GENERATED_AT);
  assert.equal(run.previousGeneratedAt, "2026-10-28T11:04:41.000Z");
  assert.equal(parseRunTimes({ burstEndedAt: "later" }), null);
  assert.equal(parseRunTimes(null), null);
  assert.equal(parseRunTimes([]), null);
});

test("the history file is requested next to the page and a failure is an empty panel, not an error", async (t) => {
  const real = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = real;
  });
  const calls = [];
  const answer = (response) => {
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      if (response instanceof Error) throw response;
      return response;
    };
  };
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status });

  answer(json(read("history.json")));
  assert.equal((await loadRecordedHistory()).length, 5);
  assert.equal(calls[0].url, "/data/history.json");
  assert.equal(calls[0].init.cache, "no-cache");
  answer(json({}, 404));
  assert.equal(await loadRecordedHistory(), null);
  answer(new TypeError("offline"));
  assert.equal(await loadRecordedHistory(), null);
  answer(json({ schemaVersion: 9, points: [] }));
  assert.equal(await loadRecordedHistory(), null);
  answer(new Response("not json", { status: 200 }));
  assert.equal(await loadRecordedHistory(), null);
});

test("the loaded projects are announced to whoever reads the directory", () => {
  const seen = [];
  const stop = editionDirectory.subscribe(() => seen.push(editionDirectory.version()));
  const before = editionDirectory.version();
  editionDirectory.set([{ id: "a", name: "A", category: "Fees", deployments: [] }]);
  assert.deepEqual(seen, [before + 1]);
  assert.equal(editionDirectory.projects().length, 1);
  stop();
  editionDirectory.set([]);
  assert.equal(seen.length, 1);
});

test("a snapshot and an overview from different runs are never judged at each other's time", async () => {
  const { reconcileRuns } = await import("../src/edition.ts");
  const run = "2026-10-28T14:05:00.000Z";
  const later = "2026-10-28T17:05:00.000Z";
  assert.equal(reconcileRuns(run, run), null);
  assert.equal(reconcileRuns(later, run), "reload-snapshot");
  assert.equal(reconcileRuns(run, later), "reload-overview");
  for (const bad of [null, undefined, "", "soon"]) {
    assert.equal(reconcileRuns(bad, run), null);
    assert.equal(reconcileRuns(run, bad), null);
  }
});
