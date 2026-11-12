import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectPublishedData,
  publishBlockers,
} from "../scripts/check-edition-data.mjs";
import { CHAINS_URL, FRONTIER_URL, REGISTRY_URL } from "../server/model.mjs";
import * as config from "../collector/config.mjs";
import { FIXTURES, requestReserve, runCollector } from "../collector/run.mjs";
import { poolsJson, readState } from "../collector/state.mjs";
import {
  address,
  blockNetwork,
  dexRow,
  FakeClock,
  fakeFetch,
  statePool,
} from "../collector/testing.mjs";
import {
  DAILY_SOURCE_ID,
  dayNumber,
  validateDailyShape,
} from "../shared/daily-volume.ts";

blockNetwork();

// Whole runs with the daily-volume step in them, on fake providers and a fake
// clock: where the step sits in the run, what it spends, what it publishes and
// what it cannot do. No test here reaches a provider.

const T0 = Date.parse("2026-11-12T01:14:00.000Z");
const DS = /^https:\/\/api\.dexscreener\.com\/latest\/dex\/pairs\/[a-z]+\/(.+)$/;
const OHLCV =
  /^https:\/\/api\.geckoterminal\.com\/api\/v2\/networks\/([a-z0-9_-]+)\/pools\/(0x[0-9a-f]{64})\/ohlcv\/day\?/;
const isDaily = (call) => OHLCV.test(call.url);
const hook = (hookAddress, chain, chainId) => ({
  hook: {
    address: hookAddress,
    chainId,
    chain,
    name: "BunniHook",
    description: "BunniHook test deployment",
    verifiedSource: true,
  },
  properties: { dynamicFee: true, upgradeable: false },
});
const BUNNI_BASE = address(9001);
const BUNNI_ETH = address(9003);
const REGISTRY = [hook(BUNNI_BASE, "base", 8453), hook(BUNNI_ETH, "ethereum", 1)];
const CHAIN_DATA = { ethereum: { chainId: 1 }, base: { chainId: 8453 } };

/** 70 Base and 40 Ethereum pools; pool number i has a 24h volume that falls with i. */
function world() {
  const pools = [
    ...Array.from({ length: 70 }, (_, i) =>
      statePool(1 + i, { chain: "base", hookAddress: BUNNI_BASE.toLowerCase() }),
    ),
    ...Array.from({ length: 40 }, (_, i) =>
      statePool(100 + i, { chain: "ethereum", hookAddress: BUNNI_ETH.toLowerCase() }),
    ),
  ];
  const volume = new Map(pools.map((pool, i) => [pool.id, 900_000 - i * 1000]));
  return { pools, volume };
}

/** The provider's answer: one candle per day, the newest being the day in progress. */
function candles(today, count, volumeOf) {
  return {
    data: {
      id: "x",
      type: "ohlcv_request_response",
      attributes: {
        ohlcv_list: Array.from({ length: count }, (_, k) => [
          (today - k) * 86400,
          1,
          1,
          1,
          1,
          volumeOf(today - k),
        ]),
      },
    },
  };
}

function providers(pools, volume, options = {}) {
  const { onDaily, onBatch, dark = new Set(), onGecko } = options;
  return (call, n, clock) => {
    const { url } = call;
    if (url === REGISTRY_URL) return { body: REGISTRY };
    if (url === CHAINS_URL) return { body: CHAIN_DATA };
    if (url === FRONTIER_URL) return { body: [] };
    const daily = OHLCV.exec(url);
    if (daily) {
      const special = onDaily?.(daily[2], call);
      if (special) return special;
      return { body: candles(dayNumber(clock.now()), 33, () => 100) };
    }
    const ds = DS.exec(url);
    if (ds) {
      const special = onBatch?.(call, n);
      if (special) return special;
      const wanted = new Set(ds[1].split(","));
      const rows = pools
        .filter((pool) => wanted.has(pool.id) && !dark.has(pool.id))
        .map((pool) =>
          dexRow(pool, {
            volume: { h1: 10, h6: 100, h24: volume.get(pool.id) },
            liquidity: { usd: 50000 },
          }),
        );
      return { body: { pairs: rows.length ? rows : null } };
    }
    if (url.includes("api.geckoterminal.com") && onGecko) {
      const special = onGecko(call, n);
      if (special) return special;
    }
    return { body: { data: [] } };
  };
}

async function folder(t) {
  const dir = await mkdtemp(join(tmpdir(), "collector-daily-run-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** One run. The state directory is shared by successive runs of a test. */
async function collect(t, { dir, start = T0, pools, volume, label = "run", ...options }) {
  const stateDir = join(dir, "state");
  await mkdir(stateDir, { recursive: true });
  const outDir = join(dir, label);
  const clock = new FakeClock(start);
  const answer = providers(pools, volume, options);
  const fetchImpl = fakeFetch(clock, (call, n) => answer(call, n, clock));
  const result = await runCollector({
    stateDir,
    outDir,
    stateOutDir: stateDir,
    minCurrent: 20,
    fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
    env: { GITHUB_REPOSITORY: "owner/hook-radar", ...(options.env ?? {}) },
    maxDiscovery: 0,
    ...(options.dailyMaxRequests === undefined
      ? {}
      : { dailyMaxRequests: options.dailyMaxRequests }),
  });
  const read = async (name) => {
    try {
      return await readFile(join(outDir, name), "utf8");
    } catch {
      return null;
    }
  };
  return { result, fetchImpl, clock, stateDir, outDir, read };
}

async function seed(dir, pools) {
  await mkdir(join(dir, "state"), { recursive: true });
  await writeFile(join(dir, "state", "pools.json"), poolsJson(null, pools));
}

test("a run reads the largest pools after everything else and publishes the file, the source row, the counts and the state", async (t) => {
  const dir = await folder(t);
  const { pools, volume } = world();
  await seed(dir, pools);
  const run = await collect(t, { dir, pools, volume });
  const { result, fetchImpl } = run;
  assert.equal(result.ok, true, result.quality.failures.join("; "));
  assert.equal(result.published, true);

  // Where the step sits: every daily request comes after every other request, so
  // the burst, its fallback and Frontier are never held up by it.
  const calls = fetchImpl.calls;
  const lastOther = calls.map((call, i) => [isDaily(call), i]).filter(([d]) => !d).at(-1)[1];
  const firstDaily = calls.findIndex(isDaily);
  assert.ok(firstDaily > lastOther, `daily reads start at ${firstDaily}, the last other request is ${lastOther}`);
  const daily = calls.filter(isDaily);
  assert.equal(daily.length, 20, "the first run reads the 20 largest pools it has room for");
  assert.ok(daily.every((call) => call.headers.accept === "application/json;version=20230302"));
  assert.ok(daily.every((call) => /Hook|HookRadar/.test(call.headers["user-agent"])));
  // The largest first: pool number 1 of the world is the largest.
  assert.equal(OHLCV.exec(daily[0].url)[2], pools[0].id);
  const gaps = daily.slice(1).map((call, i) => call.at - daily[i].at);
  assert.ok(gaps.every((gap) => gap >= 12000));
  assert.ok(calls.length <= 399);

  // The file.
  const text = await run.read("daily.json");
  assert.ok(text, "daily.json was written");
  assert.ok(Buffer.byteLength(text) < 10 * 1024, `${Buffer.byteLength(text)} bytes`);
  const shape = validateDailyShape(JSON.parse(text));
  assert.equal(shape.ok, true, shape.reason);
  const { file } = shape;
  assert.equal(file.snapshotGeneratedAt, result.snapshot.generatedAt);
  assert.equal(file.through, "2026-11-11");
  assert.equal(file.pools.length, 20);
  // 32 complete days of 100 each at the end day, whichever window is asked for.
  assert.ok(file.pools.every((p) => p.v7 === 700 && p.v30 === 3000));
  assert.ok(file.pools.every((p) => !("n7" in p) && !("n30" in p)));

  // The snapshot names the file, once, in existing fields only.
  const rows = result.snapshot.sources.filter((source) => source.id === DAILY_SOURCE_ID);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "live");
  assert.match(rows[0].note, /^Complete UTC days up to 11 Nov 2026 for 20 of the largest pools/);
  assert.deepEqual((await inspectPublishedData(run.outDir)).problems, []);
  assert.deepEqual(await publishBlockers(run.outDir), []);

  // The status: the requests of the step are counted once, in the lane's total
  // and in their own right.
  const status = JSON.parse(await run.read("status.json"));
  assert.equal(status.counts.requests.total, calls.length);
  const gecko = calls.filter((call) => call.url.includes("api.geckoterminal.com"));
  assert.equal(status.counts.requests.geckoterminal, gecko.length);
  assert.equal(status.counts.daily.requested, 20);
  assert.equal(status.counts.daily.read, 20);
  assert.equal(status.counts.daily.selected, 40);
  assert.equal(status.counts.daily.due, 40);
  assert.equal(status.counts.daily.through, "2026-11-11");
  assert.equal(status.counts.daily.published, 20);
  assert.match(status.counts.daily.stopped, /limit of 20/);
  const sourceRow = (id) => status.sources.find((source) => source.id === id);
  assert.equal(sourceRow(DAILY_SOURCE_ID).requests, 20);
  assert.equal(sourceRow("geckoterminal"), undefined, "no market request went to GeckoTerminal");

  // The state: 40 records, 20 of them read.
  const state = await readState(run.stateDir);
  assert.equal(state.daily.records.length, 40);
  assert.equal(state.daily.records.filter((rec) => rec.result === "ok").length, 20);
  assert.equal(state.daily.note, null);
  assert.equal(state.updatedAt, result.snapshot.generatedAt);
});

test("the step moves nothing the page judges: the snapshot time, the state time and every pool are the same with it on and off", async (t) => {
  const { pools, volume } = world();
  const on = await folder(t);
  const off = await folder(t);
  await seed(on, pools);
  await seed(off, pools);
  const withStep = await collect(t, { dir: on, pools, volume });
  const without = await collect(t, { dir: off, pools, volume, dailyMaxRequests: 0 });
  assert.equal(withStep.result.snapshot.generatedAt, without.result.snapshot.generatedAt);
  const stateOn = await readState(withStep.stateDir);
  const stateOff = await readState(without.stateDir);
  assert.equal(stateOn.updatedAt, withStep.result.snapshot.generatedAt);
  assert.equal(stateOff.updatedAt, without.result.snapshot.generatedAt);
  assert.deepEqual(withStep.result.snapshot.pools, without.result.snapshot.pools);
  assert.deepEqual(withStep.result.snapshot.summary, without.result.snapshot.summary);
  const status = JSON.parse(await withStep.read("status.json"));
  const bare = JSON.parse(await without.read("status.json"));
  assert.equal(status.burstEndedAt, bare.burstEndedAt);
  assert.equal(status.generatedAt, bare.generatedAt);
  assert.equal(status.counts.requests.total, bare.counts.requests.total + 20);
  // Off: no request, no file, no source row, no state file, and a reason.
  assert.equal(without.fetchImpl.calls.filter(isDaily).length, 0);
  assert.equal(await without.read("daily.json"), null);
  assert.equal(
    without.result.snapshot.sources.some((source) => source.id === DAILY_SOURCE_ID),
    false,
  );
  assert.equal(stateOff.daily.present, false);
  assert.match(bare.counts.daily.skipped, /switched off/);
  assert.equal(bare.counts.daily.requested, 0);
  // The sources of the two snapshots differ by the one row.
  assert.deepEqual(
    withStep.result.snapshot.sources.filter((source) => source.id !== DAILY_SOURCE_ID),
    without.result.snapshot.sources,
  );
});

test("later runs read what is left, then nothing: a pool is read once per checkpoint and the committed state stays quiet", async (t) => {
  const dir = await folder(t);
  const { pools, volume } = world();
  await seed(dir, pools);
  const one = await collect(t, { dir, pools, volume, label: "one", start: T0 });
  assert.equal(one.fetchImpl.calls.filter(isDaily).length, 20);
  const two = await collect(t, { dir, pools, volume, label: "two", start: T0 + 20 * 60_000 });
  const secondReads = two.fetchImpl.calls.filter(isDaily);
  assert.equal(secondReads.length, 20, "the 20 pools that were left");
  const firstIds = new Set(
    one.fetchImpl.calls.filter(isDaily).map((call) => OHLCV.exec(call.url)[2]),
  );
  assert.ok(secondReads.every((call) => !firstIds.has(OHLCV.exec(call.url)[2])));
  const afterTwo = await readFile(join(dir, "state", "daily.json"), "utf8");
  const three = await collect(t, { dir, pools, volume, label: "three", start: T0 + 40 * 60_000 });
  assert.equal(three.fetchImpl.calls.filter(isDaily).length, 0, "everything was read at this checkpoint");
  const status = JSON.parse(await three.read("status.json"));
  assert.equal(status.counts.daily.due, 0);
  assert.equal(status.counts.daily.requested, 0);
  assert.equal(
    await readFile(join(dir, "state", "daily.json"), "utf8"),
    afterTwo,
    "a quiet run does not rewrite the file",
  );
  // The file it publishes is the same readings, for the new snapshot.
  const files = [await two.read("daily.json"), await three.read("daily.json")].map((text) =>
    JSON.parse(text),
  );
  assert.equal(files[0].pools.length, 40);
  assert.deepEqual(files[1].pools, files[0].pools);
  assert.equal(files[1].snapshotGeneratedAt, three.result.snapshot.generatedAt);
  // At 04:00 UTC the next checkpoint reads them all again, largest first.
  const four = await collect(t, {
    dir,
    pools,
    volume,
    label: "four",
    start: Date.parse("2026-11-12T04:05:00.000Z"),
  });
  const reads = four.fetchImpl.calls.filter(isDaily);
  assert.equal(reads.length, 20);
  assert.equal(OHLCV.exec(reads[0].url)[2], pools[0].id);
});

test("a step that fails does not fail the run, and the readings of earlier runs are still published", async (t) => {
  const dir = await folder(t);
  const { pools, volume } = world();
  await seed(dir, pools);
  await collect(t, { dir, pools, volume, label: "one", start: T0 });
  const before = await readFile(join(dir, "state", "daily.json"), "utf8");
  const broken = await collect(t, {
    dir,
    pools,
    volume,
    label: "two",
    start: T0 + 90 * 60_000,
    onDaily: () => ({ status: 503, body: "busy" }),
  });
  assert.equal(broken.result.ok, true, broken.result.quality.failures.join("; "));
  assert.equal(broken.result.published, true);
  const status = JSON.parse(await broken.read("status.json"));
  assert.equal(status.counts.daily.failed, 5);
  assert.match(status.counts.daily.stopped, /5 requests in a row failed/);
  assert.equal(await readFile(join(dir, "state", "daily.json"), "utf8"), before);
  const file = JSON.parse(await broken.read("daily.json"));
  assert.equal(file.pools.length, 20, "the earlier readings are published again");
  assert.equal(file.snapshotGeneratedAt, broken.result.snapshot.generatedAt);
  assert.deepEqual((await inspectPublishedData(broken.outDir)).problems, []);
});

test("a run that will be refused spends no daily request and writes nothing", async (t) => {
  const dir = await folder(t);
  const { pools, volume } = world();
  await seed(dir, pools);
  let batches = 0;
  const run = await collect(t, {
    dir,
    pools,
    volume,
    onBatch: () => (++batches >= 2 ? { status: 429, headers: { "retry-after": "400" }, body: {} } : null),
  });
  assert.equal(run.result.ok, false);
  assert.equal(run.result.published, false);
  assert.equal(run.fetchImpl.calls.filter(isDaily).length, 0);
  assert.match(run.result.status.counts.daily.skipped, /would not pass the quality gate/);
  assert.equal((await readState(run.stateDir)).daily.present, false);
  assert.equal(await run.read("daily.json"), null);
});

test("with GeckoTerminal already stopped in the run the step is left out and the run still publishes", async (t) => {
  const dir = await folder(t);
  const { pools, volume } = world();
  await seed(dir, pools);
  // Ten pools DEX Screener does not return are asked of GeckoTerminal, which
  // refuses twice and is stopped.
  const dark = new Set(pools.slice(100, 110).map((pool) => pool.id));
  const run = await collect(t, {
    dir,
    pools,
    volume,
    dark,
    onGecko: () => ({ status: 429, headers: { "retry-after": "0" }, body: {} }),
  });
  assert.equal(run.result.ok, true, run.result.quality.failures.join("; "));
  assert.equal(run.fetchImpl.calls.filter(isDaily).length, 0);
  assert.match(run.result.status.counts.daily.skipped, /GeckoTerminal was stopped/);
  // The market note of GeckoTerminal still tells its own story: it was stopped
  // before the step, and the step added nothing to it.
  const note = run.result.snapshot.sources.find((source) => source.id === "geckoterminal").note;
  assert.match(note, /Stopped for this run/);
});

test("a rate-limit answer inside the step changes neither the quality gate nor the market notes", async (t) => {
  const dir = await folder(t);
  const { pools, volume } = world();
  await seed(dir, pools);
  const calm = await collect(t, { dir: await seedFolder(t, pools), pools, volume, dailyMaxRequests: 0, label: "calm" });
  let n = 0;
  const run = await collect(t, {
    dir,
    pools,
    volume,
    onDaily: () => (++n >= 3 ? { status: 429, headers: { "retry-after": "0" }, body: {} } : null),
  });
  assert.equal(run.result.ok, true, run.result.quality.failures.join("; "));
  const status = JSON.parse(await run.read("status.json"));
  assert.match(status.counts.daily.stopped, /stopped for this run/);
  assert.equal(status.counts.daily.read, 2);
  // The sources the page reads describe the measurement phase: unchanged.
  const strip = (snapshot) =>
    snapshot.sources.filter((source) => source.id !== DAILY_SOURCE_ID);
  assert.deepEqual(strip(run.result.snapshot), strip(calm.result.snapshot));
  assert.deepEqual(run.result.quality.failures, []);
  // What was read before the refusal is published.
  assert.equal(JSON.parse(await run.read("daily.json")).pools.length, 2);
});

async function seedFolder(t, pools) {
  const dir = await folder(t);
  await seed(dir, pools);
  return dir;
}

test("COLLECTOR_DAILY_MAX_REQUESTS can only lower the step's limit; 0 switches it off; anything else changes nothing", async (t) => {
  assert.equal(config.DAILY_MAX_REQUESTS, 20);
  assert.equal(config.resolveDailyMaxRequests({}), 20);
  assert.equal(config.resolveDailyMaxRequests({ COLLECTOR_DAILY_MAX_REQUESTS: "3" }), 3);
  assert.equal(config.resolveDailyMaxRequests({ COLLECTOR_DAILY_MAX_REQUESTS: " 0 " }), 0);
  for (const bad of ["99", "5000", "", "abc", "-1", "2.5", "1e1", "0x10"])
    assert.equal(
      config.resolveDailyMaxRequests({ COLLECTOR_DAILY_MAX_REQUESTS: bad }),
      20,
      JSON.stringify(bad),
    );
  const { pools, volume } = world();
  const three = await collect(t, {
    dir: await seedFolder(t, pools),
    pools,
    volume,
    env: { COLLECTOR_DAILY_MAX_REQUESTS: "3" },
  });
  assert.equal(three.fetchImpl.calls.filter(isDaily).length, 3);
  const off = await collect(t, {
    dir: await seedFolder(t, pools),
    pools,
    volume,
    env: { COLLECTOR_DAILY_MAX_REQUESTS: "0" },
  });
  assert.equal(off.fetchImpl.calls.filter(isDaily).length, 0);
  assert.match(off.result.status.counts.daily.skipped, /COLLECTOR_DAILY_MAX_REQUESTS is 0/);
  // The run option wins, and is clamped to the contract's 20.
  const wide = await collect(t, {
    dir: await seedFolder(t, pools),
    pools,
    volume,
    dailyMaxRequests: 500,
  });
  assert.equal(wide.fetchImpl.calls.filter(isDaily).length, 20);
});

test("a corrupt state/daily.json is ignored with a note, the run publishes, and the next state file is a good one", async (t) => {
  const dir = await folder(t);
  const { pools, volume } = world();
  await seed(dir, pools);
  await writeFile(join(dir, "state", "daily.json"), "<<<<<<< HEAD\nnot json\n");
  const run = await collect(t, { dir, pools, volume });
  assert.equal(run.result.ok, true, run.result.quality.failures.join("; "));
  const status = JSON.parse(await run.read("status.json"));
  assert.match(status.counts.daily.note, /not valid JSON, so the daily volume starts empty/);
  const state = await readState(run.stateDir);
  assert.equal(state.daily.note, null, "the file was replaced");
  assert.equal(state.daily.records.length, 40);
});

test("a pool whose answer names other currencies is unreadable and gets no figure", async (t) => {
  const dir = await folder(t);
  const { pools, volume } = world();
  await seed(dir, pools);
  const wrong = pools[0].id;
  const run = await collect(t, {
    dir,
    pools,
    volume,
    onDaily: (id) =>
      id === wrong
        ? {
            body: {
              ...candles(dayNumber(T0), 33, () => 100),
              meta: {
                base: { address: address(4242) },
                quote: { address: address(4243) },
              },
            },
          }
        : null,
  });
  const status = JSON.parse(await run.read("status.json"));
  assert.equal(status.counts.daily.unreadable, 1);
  const file = JSON.parse(await run.read("daily.json"));
  assert.equal(file.pools.some((p) => p.id.endsWith(wrong)), false);
  assert.equal(file.pools.length, 19);
});

test("the heaviest run: what the request cap leaves for the step, by the contract's own numbers", () => {
  // The step starts after everything else, and takes only what is left of 399.
  // Real discovery run of 11 November 2026 (status.json): 380 requests, 19 left.
  // The documented full-size fake run: 388 requests, 11 left. The ceiling of a
  // discovery run (3 registry and configuration, 306 DEX Screener batches for
  // 8,500 pools on 22 networks, 6 fallback, 3 Frontier, 80 discovery): 398, 1 left.
  const reserve = requestReserve(8500);
  assert.equal(reserve, 315, "batches, fallback and Frontier reserved for the plan");
  const ceiling = 3 + (reserve - 6 - 3) + 6 + 3 + 80;
  assert.equal(ceiling, 398);
  for (const [used, left] of [
    [380, 19],
    [388, 11],
    [ceiling, 1],
    [300, 20],
  ])
    assert.equal(Math.min(config.DAILY_MAX_REQUESTS, config.MAX_REQUESTS_PER_RUN - used), left);
  // Time: the worst discovery run (900 s of discovery, 270 s burst deadline, 36 s
  // of Frontier) plus a full step (240 s to start and 20 s for the last request)
  // fits the job's 45 minutes with room.
  const worst =
    config.DISCOVERY_BUDGET_MS +
    config.BURST_DEADLINE_MS +
    36_000 +
    config.DAILY_BUDGET_MS +
    config.REQUEST_TIMEOUT_MS;
  assert.ok(worst < 40 * 60_000, `${worst / 60000} minutes`);
  assert.equal(config.DAILY_LATEST_START_MS, 30 * 60_000);
});

test("an offline replay runs the step on the recorded answers, marked offline, and the gate refuses its output", async (t) => {
  const dir = await folder(t);
  const outDir = join(dir, "out");
  const result = await runCollector({
    offline: true,
    stateDir: join(FIXTURES, "state"),
    outDir,
    stateOutDir: join(outDir, "state"),
    minCurrent: 20,
  });
  assert.equal(result.ok, true, result.quality.failures.join("; "));
  const status = result.status;
  assert.equal(status.offline, true);
  // The replay has no real time, so only the step's limit of 20 applies.
  assert.equal(status.counts.daily.requested, 20);
  assert.equal(status.counts.daily.published, 20);
  assert.equal(status.counts.daily.unreadable, 0);
  assert.ok(status.counts.daily.read > 0);
  const file = JSON.parse(await readFile(join(outDir, "daily.json"), "utf8"));
  assert.equal(validateDailyShape(file).ok, true);
  assert.equal(file.pools.length, 20);
  assert.ok((await stat(join(outDir, "daily.json"))).size < 10 * 1024);
  const problems = (await inspectPublishedData(outDir)).problems;
  assert.ok(problems.some((problem) => /offline/.test(problem)));
  assert.equal(problems.some((problem) => /daily\.json/.test(problem)), false);
});
