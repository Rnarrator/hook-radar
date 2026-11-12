import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAINS_URL, FRONTIER_URL, REGISTRY_URL } from "../server/model.mjs";
import * as config from "../collector/config.mjs";
import {
  classifyLanes,
  decidePlanMode,
  dueOnWheel,
  LANES,
  laneAnchor,
  laneBatches,
  laneOf,
  nextDue,
  planBurst,
  planLanes,
  planMeasurement,
  poolPhase,
} from "../collector/measure.mjs";
import {
  FIXTURES,
  fitDiscovery,
  laneRequestReserve,
  nextPools,
  parseArguments,
  planNotices,
  requestReserve,
  runCollector,
} from "../collector/run.mjs";
import { historyJson, poolsJson, readState } from "../collector/state.mjs";
import { dryRun, formatReport, main as dryRunMain } from "../collector/tools/plan-dry-run.mjs";
import {
  address,
  blockNetwork,
  dexRow,
  FakeClock,
  fakeFetch,
  statePool,
} from "../collector/testing.mjs";

blockNetwork();

// The lane plan (planLanes in collector/measure.mjs, the constants in
// collector/config.mjs). Everything here runs on made-up pools and fake
// providers: nothing reaches a provider, and no file outside a scratch folder is
// written.

const H = 3600000;
const DAY = 24 * H;
const U = Date.parse("2026-11-12T02:40:25.088Z"); // the saved time of a last good run
const iso = (ms) => new Date(ms).toISOString();
const keyOf = (pool) => `${pool.chain}:${pool.id}`;

// Pool ids are hashes in real life, and the wheels rely on that. statePool's own
// ids are not (they are small numbers), so these tests make their own.
const hashId = (n, salt = "lane") =>
  `0x${createHash("sha256").update(`${salt}:${n}`).digest("hex")}`;
function lcg(seed) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

/** A pool a provider measured `lastAgo` before `at`. */
const answeredPool = (
  n,
  { chain = "base", lastAgo, at = U, source = "census", salt } = {},
) =>
  statePool(n, {
    id: hashId(n, salt),
    chain,
    source,
    firstSeen: iso(at - lastAgo - 30 * DAY),
    lastSeen: iso(at - lastAgo),
  });
/** A pool that was added `firstAgo` before `at` and never answered. */
const silentPool = (
  n,
  { chain = "base", firstAgo, at = U, source = "census", salt } = {},
) =>
  statePool(n, {
    id: hashId(n, salt),
    chain,
    source,
    firstSeen: iso(at - firstAgo),
    lastSeen: iso(at - firstAgo),
  });

// The state of the live edition on 12 November 2026, in proportion: 1,851 pools
// that answered in the last three days (1,497 of them within a day), 90 new ones,
// 897 that answered a week or more ago and 6,118 that never answered.
const MIX = [
  ["robinhood", 0.5],
  ["base", 0.26],
  ["ethereum", 0.1],
  ["arc", 0.06],
  ["ink", 0.04],
  ["unichain", 0.03],
  ["avalanche", 0.005],
  ["xlayer", 0.005],
];
const chainFor = (n) => {
  const x = (n * 0.6180339887) % 1;
  let sum = 0;
  for (const [chain, share] of MIX) {
    sum += share;
    if (x < sum) return chain;
  }
  return "base";
};
function realisticWorld(at = U) {
  const pools = [];
  let n = 1;
  const add = (count, make) => {
    for (let i = 0; i < count; i++, n++) pools.push(make(n, i));
  };
  add(1497, (k, i) =>
    answeredPool(k, { chain: chainFor(k), lastAgo: (i * 24 * H) / 1497, at }),
  );
  add(354, (k, i) =>
    answeredPool(k, {
      chain: chainFor(k),
      lastAgo: 24 * H + 1000 + (i * 24 * H) / 354,
      at,
    }),
  );
  add(90, (k, i) =>
    silentPool(k, {
      chain: chainFor(k),
      firstAgo: (i * 60 * H) / 90 + 1000,
      at,
    }),
  );
  add(897, (k, i) =>
    answeredPool(k, {
      chain: chainFor(k),
      lastAgo: 8 * DAY + (i * 22 * DAY) / 897,
      at,
    }),
  );
  add(6118, (k, i) =>
    silentPool(k, {
      chain: chainFor(k),
      firstAgo: 4 * DAY + (i * 36 * DAY) / 6118,
      at,
    }),
  );
  return pools;
}
const plannedKeys = (plan) =>
  new Set(
    plan.networks.flatMap(({ chain, pools }) =>
      pools.map((pool) => `${chain.chain}:${pool.id}`),
    ),
  );

/* ── The lanes ───────────────────────────────────────────────────────────── */

test("a pool's lane follows what it has answered and how long ago, judged at the anchor", () => {
  const row = (last, first) =>
    statePool(1, {
      id: hashId(1),
      firstSeen: iso(U - first),
      lastSeen: iso(U - last),
    });
  const table = [
    // answered (lastSeen later than firstSeen): by the age of the last answer
    [0, 40 * DAY, "hot"],
    [72 * H - 1, 40 * DAY, "hot"],
    [72 * H, 40 * DAY, "warm"],
    [7 * DAY - 1, 40 * DAY, "warm"],
    [7 * DAY, 40 * DAY, "cool"],
    [300 * DAY, 400 * DAY, "cool"],
    // never answered (lastSeen is firstSeen): by the age of the pool
    [0, 0, "new"],
    [72 * H - 1, 72 * H - 1, "new"],
    [72 * H, 72 * H, "cold"],
    [90 * DAY, 90 * DAY, "cold"],
    // a lastSeen before the firstSeen is no answer: the pool's age decides
    [3 * DAY, 2 * DAY, "new"],
    [5 * DAY, 4 * DAY, "cold"],
  ];
  for (const [last, first, lane] of table)
    assert.equal(laneOf(row(last, first), U), lane, `${last / H} h, ${first / H} h`);
  assert.deepEqual(LANES, ["hot", "new", "warm", "cool", "cold"]);
  // The documented thresholds are the config's.
  assert.equal(config.LANE_HOT_MAX_AGE_MS, 72 * H);
  assert.equal(config.LANE_NEW_MAX_AGE_MS, 72 * H);
  assert.equal(config.LANE_WARM_MAX_AGE_MS, 7 * DAY);
  assert.deepEqual(config.LANE_PERIOD_MS, {
    warm: 3 * H,
    cool: 6 * H,
    cold: 12 * H,
  });
});

test("the real state, in proportion: every pool measured in the last day is HOT and the lanes have the sizes the dry run reported", () => {
  const { lanes, newOverflow } = classifyLanes(realisticWorld(), U + H);
  assert.equal(newOverflow, 0);
  assert.deepEqual(
    Object.fromEntries(LANES.map((lane) => [lane, lanes[lane].length])),
    { hot: 1851, new: 90, warm: 0, cool: 897, cold: 6118 },
  );
});

test("a pool that answered in the last good run is HOT at the next run, whatever its lastSeen age under a day and however long the gap", () => {
  const rnd = lcg(7);
  const gaps = [
    0,
    1,
    60000,
    H,
    3.7 * H,
    6 * H,
    24 * H,
    25 * H,
    72 * H,
    10 * DAY,
    400 * DAY,
    Number.MAX_SAFE_INTEGER - U,
  ];
  const ages = [0, 1, 12 * H, DAY - 2, DAY - 1];
  for (let i = 0; i < 400; i++) ages.push(Math.floor(rnd() * (DAY - 1)));
  for (const age of ages)
    for (const gap of gaps) {
      const pool = answeredPool(1, { lastAgo: age });
      assert.equal(
        laneOf(pool, laneAnchor(U + gap, U)),
        "hot",
        `lastSeen ${age} ms before the saved time, gap ${gap} ms`,
      );
      // And it is asked: HOT is scheduled in every run.
      const plan = planLanes([pool], { nowMs: U + gap, updatedAtMs: U });
      assert.equal(plan.lanes.hot.scheduled, 1);
      assert.equal(plan.planned, 1);
    }
});

test("the margin is real: nextPools leaves a measured pool's lastSeen under a day older than the run, so it stays HOT", () => {
  const rnd = lcg(11);
  for (let i = 0; i < 500; i++) {
    const previousAge =
      i % 3 === 0 ? Math.floor(rnd() * DAY) : Math.floor(rnd() * 90 * DAY);
    const pool = answeredPool(1, { lastAgo: previousAge });
    const [next] = nextPools({
      pools: [pool],
      found: [],
      measured: new Map([[keyOf(pool), {}]]),
      generatedAtMs: U,
    });
    assert.ok(
      U - Date.parse(next.lastSeen) < config.LAST_SEEN_GRANULARITY_MS,
      `previous age ${previousAge}`,
    );
    for (const gap of [0, 6 * H, 3 * DAY, 30 * DAY])
      assert.equal(laneOf(next, laneAnchor(U + gap, U)), "hot");
  }
  // A pool added and answered at its first run is stamped and is HOT too.
  const added = silentPool(2, { firstAgo: 2 * H });
  const [stamped] = nextPools({
    pools: [],
    found: [added],
    measured: new Map([[keyOf(added), {}]]),
    generatedAtMs: U,
  });
  assert.equal(laneOf(stamped, laneAnchor(U + DAY, U)), "hot");
  // 72 hours leave a day of room beyond the worst case (a day for the stamp, a
  // day for the anchor).
  assert.ok(
    config.LANE_HOT_MAX_AGE_MS >=
      config.LAST_SEEN_GRANULARITY_MS + config.LANE_ANCHOR_MAX_AHEAD_MS + DAY,
  );
});

test("a pool that was never answered and was added since the anchor (a clock that is behind) is NEW, not lost", () => {
  const pool = silentPool(3, { firstAgo: -2 * H });
  assert.equal(laneOf(pool, laneAnchor(U + 30 * DAY, U)), "new");
});

/* ── The wheels ──────────────────────────────────────────────────────────── */

test("a pool's phase is the first 32 bits of its id, and a pool falls due once per period", () => {
  assert.equal(poolPhase(`0x${"0".repeat(64)}`), 0);
  assert.equal(poolPhase(`0x80000000${"0".repeat(56)}`), 0.5);
  assert.equal(poolPhase(`0xffffffff${"f".repeat(56)}`) < 1, true);
  assert.equal(poolPhase("0xnot-hex"), 0);
  // Ids are hashes: the phases of 6,000 of them are even.
  const phases = Array.from({ length: 6000 }, (_, i) => poolPhase(hashId(i)));
  for (let bucket = 0; bucket < 10; bucket++) {
    const inBucket = phases.filter(
      (phase) => phase >= bucket / 10 && phase < (bucket + 1) / 10,
    ).length;
    assert.ok(inBucket > 500 && inBucket < 700, `bucket ${bucket}: ${inBucket}`);
  }
  const id = hashId(5);
  const period = 6 * H;
  const first = nextDue(id, period, U);
  assert.ok(first > U && first <= U + period);
  assert.equal(nextDue(id, period, first), first + period);
  // Due exactly at its due time, not just before.
  assert.equal(dueOnWheel(id, period, first - 1, first), true);
  assert.equal(dueOnWheel(id, period, first, first + period - 1), false);
  assert.equal(dueOnWheel(id, period, first - period + 1, first - 1), false);
  // A window as long as the period holds a due time for every pool.
  for (let i = 0; i < 200; i++)
    assert.equal(dueOnWheel(hashId(i), period, U, U + period), true);
});

test("windows that follow each other leave no due time out and count none twice", () => {
  const rnd = lcg(3);
  for (const period of Object.values(config.LANE_PERIOD_MS)) {
    for (let n = 0; n < 100; n++) {
      const id = hashId(n, "tile");
      // Windows shorter than the period hold at most one due time, so the number
      // of windows a pool is due in is the number of its due times in the span.
      let from = U;
      let seen = 0;
      for (let i = 0; i < 60; i++) {
        const to = from + Math.floor((0.05 + 0.9 * rnd()) * period);
        if (dueOnWheel(id, period, from, to)) seen++;
        from = to;
      }
      const offset = poolPhase(id) * period;
      const expected =
        Math.floor((from - offset) / period) - Math.floor((U - offset) / period);
      assert.equal(seen, expected);
    }
  }
});

// Runs after runs, as the saved time and the plan time stand to each other: a run
// plans at t, its burst and the Frontier step end D later, and that is the saved
// time the next run starts from; the next plan is `gap` after it.
function simulate({ lane, gapRange, runs = 60, seed, pools = 240, ages }) {
  const rnd = lcg(seed);
  const members = Array.from({ length: pools }, (_, i) => i + 1);
  const idOf = new Map(members.map((n) => [hashId(n, "sim"), n]));
  const asked = new Map(members.map((n) => [n, []]));
  const times = [];
  const windows = [];
  let planAt = U;
  let saved = U - 3 * H;
  for (let run = 0; run < runs; run++) {
    const at = planAt;
    const world = members.map((n) =>
      lane === "cold"
        ? silentPool(n, { firstAgo: ages.cold, at, salt: "sim" })
        : answeredPool(n, { lastAgo: lane === "warm" ? ages.warm : ages.cool, at, salt: "sim" }),
    );
    const plan = planLanes(world, {
      nowMs: at,
      updatedAtMs: saved,
      maxBatches: Infinity,
    });
    for (const key of plannedKeys(plan)) asked.get(idOf.get(key.split(":")[1])).push(at);
    times.push(at);
    windows.push({
      at,
      from: plan.window.fromMs,
      width: plan.window.toMs - plan.window.fromMs,
    });
    // The burst and the Frontier step: the saved time is later than the plan time
    // by less than the overlap.
    const burst = 30000 + Math.floor(rnd() * 300000);
    assert.ok(burst < config.LANE_WINDOW_OVERLAP_MS);
    saved = at + burst;
    planAt = saved + Math.floor((gapRange[0] + rnd() * (gapRange[1] - gapRange[0])) * H);
  }
  return { asked, times, windows };
}
const AGES = { warm: 4 * DAY, cool: 20 * DAY, cold: 30 * DAY };

test("every pool is asked again by the first run at or after one period since it was last asked, for gaps up to ten hours", () => {
  for (const lane of ["warm", "cool", "cold"]) {
    const period = config.LANE_PERIOD_MS[lane];
    const { asked, times } = simulate({
      lane,
      gapRange: [0.25, 10],
      seed: 21,
      ages: AGES,
    });
    let checked = 0;
    for (const runs of asked.values()) {
      assert.ok(runs.length > 0);
      for (let j = 0; j + 1 < runs.length; j++) {
        const due = times.find((t) => t >= runs[j] + period);
        if (due === undefined) continue;
        assert.ok(
          runs[j + 1] <= due,
          `${lane}: asked at ${runs[j]}, next at ${runs[j + 1]}, the first run a period later is ${due}`,
        );
        checked++;
      }
    }
    assert.ok(checked > 1000, `${lane}: ${checked} intervals checked`);
  }
});

test("every pool is asked at least once in any two periods when the runs are no further apart than a period; further apart, it is asked in every run", () => {
  // The guarantee, written as the property: the interval between two asks of a
  // pool is at most two periods. The gaps stay under the period (the saved time
  // trails the plan time by under the overlap, so the margin is the overlap).
  const margin = config.LANE_WINDOW_OVERLAP_MS / H;
  for (const [lane, longest] of [
    ["warm", 3 - margin],
    ["cool", 6 - margin],
    ["cold", 10], // the longest gap seen in the live edition is 9.1 h
  ]) {
    const period = config.LANE_PERIOD_MS[lane];
    const { asked } = simulate({
      lane,
      gapRange: [0.25, longest],
      seed: 5,
      ages: AGES,
    });
    let worst = 0;
    for (const runs of asked.values())
      for (let j = 0; j + 1 < runs.length; j++)
        worst = Math.max(worst, runs[j + 1] - runs[j]);
    assert.ok(worst <= 2 * period, `${lane}: ${worst / H} h against ${(2 * period) / H} h`);
  }
  // Runs further apart than the period: the whole lane, every run.
  for (const [lane, gap] of [
    ["warm", 4],
    ["warm", 10],
    ["cool", 7],
    ["cold", 12],
  ]) {
    const { asked, times } = simulate({
      lane,
      gapRange: [gap, gap],
      runs: 12,
      seed: 9,
      pools: 60,
      ages: AGES,
    });
    // (The first run's own gap is the one the simulation starts with.)
    for (const runs of asked.values())
      assert.deepEqual(
        runs.filter((time) => time !== times[0]),
        times.slice(1),
        `${lane} at a gap of ${gap} h`,
      );
  }
});

test("at the lane sizes of a few days on, the ceiling binds in ordinary runs and a COLD pool can wait more than two periods; with no ceiling it cannot (the guarantee is the plan's, as COLLECTOR-NOTES says)", () => {
  // The state of the live edition a few days on, at a tenth of its size (the
  // ceiling is scaled too): HOT 190, NEW 9, WARM 140, COOL 90 and COLD 470 pools
  // over the live networks, runs at the gaps the edition has had (2.4 to 9.1
  // hours, in turn), the saved time trailing the plan by 200 to 300 seconds. The
  // full-size figures in COLLECTOR-NOTES are from the same planner at ten times
  // the size and a ceiling of 220.
  const rnd = lcg(12345);
  const nets = [
    ["robinhood", 0.5],
    ["base", 0.27],
    ["ethereum", 0.12],
    ["arc", 0.04],
    ["ink", 0.03],
    ["unichain", 0.02],
    ["avalanche", 0.02],
  ];
  const pick = () => {
    let r = rnd();
    for (const [slug, share] of nets) {
      if (r < share) return slug;
      r -= share;
    }
    return "robinhood";
  };
  const sizes = { hot: 190, new: 9, warm: 140, cool: 90, cold: 470 };
  const world = [];
  for (const [lane, count] of Object.entries(sizes))
    for (let i = 0; i < count; i++)
      world.push({
        lane,
        chain: pick(),
        id: hashId(world.length, "steady"),
        age: { hot: 5 + rnd() * 60, warm: 80 + rnd() * 80, cool: 200 + rnd() * 200 }[lane],
      });
  const gaps = [2.4, 2.9, 6.9, 9.1, 1.8, 4.6, 3.7, 1.1, 5.2, 3.0];
  const simulate = (maxBatches) => {
    const jitter = lcg(99);
    let saved = U;
    let bound = 0;
    const last = new Map();
    const longest = { warm: 0, cool: 0, cold: 0 };
    const laneOfId = new Map(world.map((w) => [w.id, w.lane]));
    for (let run = 0; run < 400; run++) {
      const now = saved + gaps[run % gaps.length] * H;
      const pools = world.map((w) => {
        const answeredAt = now - w.age * H;
        const first = w.lane === "new" ? now - 20 * H : now - 400 * H;
        return statePool(1, {
          id: w.id,
          chain: w.chain,
          firstSeen: iso(w.lane === "cold" || w.lane === "new" ? first : answeredAt - 5 * DAY),
          lastSeen: iso(w.lane === "cold" || w.lane === "new" ? first : answeredAt),
        });
      });
      const plan = planLanes(pools, { nowMs: now, updatedAtMs: saved, maxBatches });
      if (plan.ceilingBound) bound++;
      for (const { pools: rows } of plan.networks)
        for (const pool of rows) {
          const lane = laneOfId.get(pool.id);
          if (lane !== "warm" && lane !== "cool" && lane !== "cold") continue;
          if (last.has(pool.id) && run > 40)
            longest[lane] = Math.max(longest[lane], (now - last.get(pool.id)) / H);
          last.set(pool.id, now);
        }
      saved = now + (200 + jitter() * 100) * 1000;
    }
    return { bound, longest };
  };
  const capped = simulate(22);
  const lifted = simulate(100000);
  // Without a ceiling the plan's guarantee holds: two periods (24 hours) for COLD,
  // and a pool is asked in every run when the gap is longer than its period.
  assert.equal(lifted.bound, 0);
  assert.ok(lifted.longest.cold <= 24, `COLD ${lifted.longest.cold} h`);
  assert.ok(lifted.longest.cool <= 12.5, `COOL ${lifted.longest.cool} h`);
  assert.ok(lifted.longest.warm <= 9.2, `WARM ${lifted.longest.warm} h`);
  // With it the ceiling binds in a good part of the runs and the guarantee does not
  // hold for COLD: a pool waits for a turn that was cut, a period at a time.
  assert.ok(capped.bound > 400 * 0.1, `bound in ${capped.bound} of 400 runs`);
  assert.ok(capped.longest.cold > 24, `COLD ${capped.longest.cold} h`);
});

test("the window starts before the saved time by the overlap, so no stretch between two runs is left out", () => {
  const { windows, times } = simulate({
    lane: "cold",
    gapRange: [0.25, 10],
    runs: 40,
    seed: 17,
    pools: 20,
    ages: AGES,
  });
  for (let i = 1; i < windows.length; i++) {
    // The previous run planned at times[i - 1]; this window starts no later.
    assert.ok(windows[i].from <= times[i - 1], `run ${i}`);
    assert.ok(windows[i].from < times[i]);
  }
  assert.equal(config.LANE_WINDOW_OVERLAP_MS, 6 * 60 * 1000);
  // A plan to saved-time stretch under the overlap, which the Frontier step and
  // the burst deadline allow: 270 s and 36 s, plus the batches before them.
  assert.ok(
    config.LANE_WINDOW_OVERLAP_MS >
      config.BURST_DEADLINE_MS + config.REQUEST_TIMEOUT_MS + 10000,
  );
});

test("a refused run is covered by the next: nothing it would have asked is lost", () => {
  const world = realisticWorld();
  const refused = planLanes(world, { nowMs: U + 2 * H, updatedAtMs: U });
  const next = planLanes(world, { nowMs: U + 5 * H, updatedAtMs: U });
  const later = plannedKeys(next);
  for (const key of plannedKeys(refused))
    assert.ok(later.has(key), `${key} was due in the refused run`);
  assert.ok(next.planned > refused.planned);
});

/* ── The plan ────────────────────────────────────────────────────────────── */

test("the plan is a pure function of the pools, the saved time and the time: the same requests whatever the order, and nothing remembered between runs", () => {
  const world = realisticWorld();
  const plan = (pools) => planLanes(pools, { nowMs: U + 3 * H, updatedAtMs: U });
  const first = plan(world);
  const again = plan(world);
  const reversed = plan([...world].reverse());
  const shuffled = plan(
    [...world].sort((a, b) => (hashId(a.id) < hashId(b.id) ? -1 : 1)),
  );
  const shape = (p) =>
    JSON.stringify(
      p.networks.map(({ chain, pools }) => [
        chain.chain,
        pools.map((pool) => pool.id),
      ]),
    );
  assert.equal(shape(again), shape(first));
  assert.equal(shape(reversed), shape(first));
  assert.equal(shape(shuffled), shape(first));
  assert.equal(first.batches, reversed.batches);
  // Not remembered: no field of the pool records is needed beyond lastSeen and
  // firstSeen, so the plan is the same for records that carry nothing else.
  const bare = world.map((pool) => ({
    id: pool.id,
    chain: pool.chain,
    source: pool.source,
    firstSeen: pool.firstSeen,
    lastSeen: pool.lastSeen,
  }));
  assert.equal(shape(plan(bare)), shape(first));
});

test("the plan's batches are made lane by lane inside a network: HOT first, each lane in id order", () => {
  const world = realisticWorld();
  const plan = planLanes(world, { nowMs: U + 4 * H, updatedAtMs: U });
  const laneOfKey = plan.laneByKey;
  const rank = new Map(LANES.map((lane, i) => [lane, i]));
  let batches = 0;
  for (const { chain, pools } of plan.networks) {
    let last = -1;
    let lastId = "";
    for (const pool of pools) {
      const lane = rank.get(laneOfKey.get(`${chain.chain}:${pool.id}`));
      assert.ok(lane >= last, `${chain.chain}: lanes run in order`);
      if (lane === last) assert.ok(pool.id > lastId, "ids ascend in a lane");
      last = lane;
      lastId = pool.id;
    }
    batches += Math.ceil(pools.length / config.DS_BATCH_SIZE);
    // The first batch of a network is made of pools that answer.
    const answering = pools.filter((pool) =>
      ["hot", "new"].includes(laneOfKey.get(`${chain.chain}:${pool.id}`)),
    );
    const head = pools.slice(0, Math.min(30, pools.length));
    const hot = head.filter((pool) =>
      ["hot", "new"].includes(laneOfKey.get(`${chain.chain}:${pool.id}`)),
    );
    if (answering.length >= 30)
      assert.equal(hot.length, head.length, `${chain.chain}'s first batch`);
  }
  // Batches are rounded up per network, as the burst sends them.
  assert.equal(plan.batches, batches);
  // Largest network first, then by name.
  const sizes = plan.networks.map(({ pools }) => pools.length);
  assert.deepEqual(sizes, [...sizes].sort((a, b) => b - a));
});

test("each lane's share of the batches adds up to the plan's batches, HOT first", () => {
  const world = realisticWorld();
  for (const gap of [0.5, 1, 3.7, 6, 9, 30]) {
    const plan = planLanes(world, { nowMs: U + gap * H, updatedAtMs: U });
    const shares = laneBatches(plan);
    assert.deepEqual(Object.keys(shares), [...LANES]);
    assert.equal(
      Object.values(shares).reduce((a, b) => a + b, 0),
      plan.batches,
      `gap ${gap}`,
    );
    assert.ok(Object.values(shares).every((n) => Number.isInteger(n) && n >= 0));
    // HOT's pools alone need at least their pools / 30 batches.
    assert.ok(shares.hot >= Math.ceil(plan.lanes.hot.scheduled / 30));
    assert.equal(shares.warm, 0);
  }
  // A tiny plan: 20 HOT and 20 NEW in one network are two batches, the first
  // opened by HOT, the second by NEW.
  const tiny = planLanes(
    [
      ...Array.from({ length: 20 }, (_, i) => answeredPool(i + 1, { lastAgo: H })),
      ...Array.from({ length: 20 }, (_, i) => silentPool(100 + i, { firstAgo: H })),
    ],
    { nowMs: U + H, updatedAtMs: U },
  );
  assert.deepEqual(laneBatches(tiny), { hot: 1, new: 1, warm: 0, cool: 0, cold: 0 });
});

test("on the live state's proportions the batches stay within the acceptance numbers at gaps of 1, 3.7, 6 and 9 hours", () => {
  const world = realisticWorld();
  const batches = Object.fromEntries(
    [1, 3.7, 6, 9].map((gap) => [
      gap,
      planLanes(world, { nowMs: U + gap * H, updatedAtMs: U }),
    ]),
  );
  // At most 120 at 1 h, about 150-175 at 3.7 h, at most 220 at 6 h or more.
  assert.ok(batches[1].batches <= 120, `1 h: ${batches[1].batches}`);
  assert.ok(
    batches[3.7].batches >= 140 && batches[3.7].batches <= 175,
    `3.7 h: ${batches[3.7].batches}`,
  );
  assert.ok(batches[6].batches <= 220, `6 h: ${batches[6].batches}`);
  assert.ok(batches[9].batches <= 220, `9 h: ${batches[9].batches}`);
  // The full plan is 288 batches and more, at any gap.
  assert.ok(planBurst(world).batches >= 284);
  // Every answering pool is asked at every gap.
  for (const plan of Object.values(batches)) {
    assert.equal(plan.lanes.hot.scheduled, 1851);
    assert.equal(plan.lanes.new.scheduled, 90);
  }
});

test("the batch ceiling cuts COLD first, then COOL, then WARM, the pools that fell due most recently first, and never HOT or NEW", () => {
  const world = realisticWorld();
  // The live state at a gap of 9 h: COLD is cut, and the ceiling says so.
  const long = planLanes(world, { nowMs: U + 9 * H, updatedAtMs: U });
  assert.equal(long.batches <= config.LANE_MAX_BATCHES, true);
  assert.equal(long.ceilingBound, true);
  assert.ok(long.trimmed.cold > 0);
  assert.equal(long.trimmed.cool, 0);
  assert.equal(long.trimmed.warm, 0);
  assert.equal(long.dropped, long.trimmed.cold);
  // What is kept fell due earlier than what was cut.
  const period = config.LANE_PERIOD_MS.cold;
  const fromMs = U - config.LANE_WINDOW_OVERLAP_MS;
  const asked = plannedKeys(long);
  const kept = world.filter(
    (pool) => long.laneByKey.get(keyOf(pool)) === "cold" && asked.has(keyOf(pool)),
  );
  const cut = world.filter((pool) => long.trimmedKeys.has(keyOf(pool)));
  assert.equal(cut.length, long.trimmed.cold);
  assert.ok(
    Math.max(...kept.map((pool) => nextDue(pool.id, period, fromMs))) <=
      Math.min(...cut.map((pool) => nextDue(pool.id, period, fromMs))),
  );
  // Nothing in the ceiling touched HOT or NEW.
  assert.equal(long.lanes.hot.scheduled, long.lanes.hot.known);
  assert.equal(long.lanes.new.scheduled, long.lanes.new.known);

  // A tighter ceiling cuts COOL once COLD is gone...
  const tight = planLanes(world, {
    nowMs: U + 9 * H,
    updatedAtMs: U,
    maxBatches: 95,
  });
  assert.equal(tight.batches <= 95, true);
  assert.equal(tight.lanes.cold.scheduled, 0);
  assert.ok(tight.trimmed.cool > 0 && tight.lanes.cool.scheduled > 0);
  assert.equal(tight.trimmed.warm, 0);
  // ...and WARM last.
  const warmWorld = [
    ...realisticWorld().filter((pool) => laneOf(pool, U) !== "cool"),
    ...Array.from({ length: 900 }, (_, i) =>
      answeredPool(100000 + i, { chain: chainFor(i), lastAgo: 4 * DAY }),
    ),
  ];
  const warm = planLanes(warmWorld, {
    nowMs: U + 9 * H,
    updatedAtMs: U,
    maxBatches: 85,
  });
  assert.equal(warm.lanes.cold.scheduled, 0);
  assert.ok(warm.trimmed.cold > 0 && warm.trimmed.warm > 0);
  assert.equal(warm.batches <= 85, true);

  // HOT and NEW are never cut: when they alone exceed the ceiling the plan
  // exceeds it and says so.
  const over = planLanes(world, {
    nowMs: U + 9 * H,
    updatedAtMs: U,
    maxBatches: 40,
  });
  assert.equal(over.ceilingBound, true);
  assert.equal(over.lanes.hot.scheduled, 1851);
  assert.equal(over.lanes.new.scheduled, 90);
  assert.equal(
    over.lanes.warm.scheduled + over.lanes.cool.scheduled + over.lanes.cold.scheduled,
    0,
  );
  assert.ok(over.batches > 40);
  // Without the ceiling being reached it is not bound.
  const quiet = planLanes(world, { nowMs: U + H, updatedAtMs: U });
  assert.equal(quiet.ceilingBound, false);
  assert.equal(quiet.dropped, 0);
  assert.equal(config.LANE_MAX_BATCHES, 220);
});

test("pools that were not due, cut or planned add up to the pools the plan could ask about", () => {
  const world = realisticWorld();
  for (const gap of [0.5, 2, 3.7, 9, 30]) {
    const plan = planLanes(world, { nowMs: U + gap * H, updatedAtMs: U });
    assert.equal(plan.planned + plan.deferred + plan.dropped, world.length, `gap ${gap}`);
    assert.equal(plannedKeys(plan).size, plan.planned);
  }
  // `maxPools` is a ceiling on the pools too (the command line's --max-pools
  // selects the full plan, but the planner honours it).
  const small = planLanes(world, { nowMs: U + 9 * H, updatedAtMs: U, maxPools: 3000 });
  assert.ok(small.planned >= 1941);
  assert.ok(small.planned <= 3000);
});

test("NEW holds the 600 newest pools; the others wait in COLD, and the discovery cap of the full plan does not apply", () => {
  const found = Array.from({ length: 700 }, (_, i) =>
    silentPool(i + 1, {
      source: "v4.xyz",
      firstAgo: 10 * H + i * 1000,
      chain: chainFor(i),
    }),
  );
  const plan = planLanes(found, { nowMs: U + 2 * H, updatedAtMs: U, maxBatches: Infinity });
  assert.equal(plan.lanes.new.known, config.LANE_NEW_MAX_POOLS);
  assert.equal(plan.lanes.new.scheduled, 600);
  assert.equal(plan.newOverflow, 100);
  assert.equal(plan.lanes.cold.known, 100);
  // The oldest of them are the ones that wait.
  const waiting = new Set(
    found.slice(600).map(keyOf), // the highest ages
  );
  for (const key of waiting) assert.equal(plan.laneByKey.get(key), "cold");
  // 600 discovered pools are planned; the full plan would stop at 500.
  assert.equal(plan.plannedDiscovered >= 600, true);
  assert.ok(plan.plannedDiscovered > config.MAX_DISCOVERED_MEASURED);
  assert.equal(
    planBurst(found, { maxSeeded: 8000 }).plannedDiscovered,
    config.MAX_DISCOVERED_MEASURED,
  );
});

test("the priority list is counted and never chooses: the same pools are asked with or without it", () => {
  const world = realisticWorld();
  const keys = new Set(world.filter((_, i) => i % 5 === 0).map(keyOf));
  const without = planLanes(world, { nowMs: U + 4 * H, updatedAtMs: U });
  const withList = planLanes(world, {
    nowMs: U + 4 * H,
    updatedAtMs: U,
    priorityKeys: keys,
  });
  assert.deepEqual([...plannedKeys(withList)].sort(), [...plannedKeys(without)].sort());
  assert.equal(without.plannedProtected, 0);
  assert.equal(
    withList.plannedProtected,
    [...plannedKeys(withList)].filter((key) => keys.has(key)).length,
  );
  assert.ok(withList.plannedProtected > 0);
});

test("pools on a network DEX Screener is not asked about are not planned, and are counted as unsupported", () => {
  const world = [
    answeredPool(1, { lastAgo: H }),
    answeredPool(2, { lastAgo: H, chain: "nowhere" }),
  ];
  const plan = planLanes(world, { nowMs: U + H, updatedAtMs: U });
  assert.equal(plan.planned, 1);
  assert.equal(plan.unsupported, 1);
});

/* ── Which plan a run uses ───────────────────────────────────────────────── */

test("the lane plan is the default, and the full plan is used when it is asked for or the lanes cannot be trusted", () => {
  const world = realisticWorld();
  const previousPoint = { timestamp: U - H, value: 1, pools: 1408 };
  const decide = (extra) =>
    decidePlanMode({
      pools: world,
      nowMs: U + 3 * H,
      updatedAtMs: U,
      previousPoint,
      ...extra,
    });
  const ok = decide();
  assert.equal(ok.mode, "lanes");
  assert.equal(ok.code, null);
  assert.equal(ok.hotAndNew, 1941);
  assert.equal(ok.floor, Math.ceil(0.9 * 1408));
  assert.equal(config.LANE_MIN_SHARE_OF_PREVIOUS, 0.9);

  assert.equal(decide({ forced: "forced" }).code, "forced");
  assert.equal(decide({ forced: "max-pools" }).code, "max-pools");
  assert.equal(decide({ updatedAtMs: NaN }).code, "no-saved-time");
  assert.equal(decide({ updatedAtMs: U + 4 * H }).code, "saved-time-in-future");
  assert.equal(decide({ previousPoint: null }).code, "no-history");
  assert.equal(decide({ previousPoint: { pools: 0 } }).code, "no-history");
  assert.equal(decide({ previousPoint: { pools: "many" } }).code, "no-history");
  for (const flip of [
    decide({ forced: "forced" }),
    decide({ updatedAtMs: NaN }),
    decide({ previousPoint: null }),
  ]) {
    assert.equal(flip.mode, "full");
    assert.ok(flip.detail.length > 20);
  }
});

test("the floor is relative: HOT and NEW must hold 90% of the pools behind the previous history point", () => {
  const world = realisticWorld();
  const decide = (pools) =>
    decidePlanMode({
      pools: world,
      nowMs: U + 3 * H,
      updatedAtMs: U,
      previousPoint: { timestamp: U, value: 1, pools },
    });
  // 1,941 pools are HOT or NEW: 90% of 2,156 is 1,941 (1,940.4 rounded up).
  assert.equal(decide(2156).mode, "lanes");
  assert.equal(decide(2157).mode, "full");
  const flipped = decide(2157);
  assert.equal(flipped.code, "below-floor");
  assert.equal(flipped.hotAndNew, 1941);
  assert.equal(flipped.floor, Math.ceil(0.9 * 2157));
  assert.match(flipped.detail, /1941 pools that answered or are new/);
  assert.match(flipped.detail, /90%/);
  // A fixed number would flip as the sample erodes; this one follows it.
  assert.equal(decide(1500).mode, "lanes");
  // Silent pools that are still HOT count (they are in the plan): removing them
  // lowers HOT + NEW.
  const lessHot = world.filter((pool) => laneOf(pool, U + 3 * H) !== "hot");
  assert.equal(
    decidePlanMode({
      pools: lessHot,
      nowMs: U + 3 * H,
      updatedAtMs: U,
      previousPoint: { pools: 1408 },
    }).code,
    "below-floor",
  );
});

test("planMeasurement runs the plan the decision names", () => {
  const world = realisticWorld();
  const lanes = planMeasurement(world, {
    decision: { mode: "lanes" },
    nowMs: U + H,
    updatedAtMs: U,
  });
  const full = planMeasurement(world, {
    decision: { mode: "full", code: "forced" },
    nowMs: U + H,
    updatedAtMs: U,
    full: { maxPools: 8500, maxSeeded: 8000 },
  });
  assert.equal(lanes.mode, "lanes");
  assert.equal(full.mode, "full");
  // The seeded pools of the world fill the full plan up to maxSeeded.
  assert.equal(full.planned, 8000);
  assert.ok(full.batches >= 267);
  assert.ok(lanes.batches < full.batches / 2);
});

/* ── The request budget ──────────────────────────────────────────────────── */

test("the request reserve follows the lane plan, and discovery is no longer cut by it", () => {
  const world = realisticWorld();
  const plan = planLanes(world, { nowMs: U + H, updatedAtMs: U });
  assert.equal(
    laneRequestReserve(plan),
    plan.batches +
      config.LANE_DISCOVERED_RESERVE_BATCHES +
      config.GT_FALLBACK_MAX_REQUESTS +
      config.FRONTIER_MAX_REQUESTS,
  );
  // Discovery wants 20 lists, 20 pages and 40 lookups; the three registry
  // fetches are spent before it. At the lane ceiling it still fits.
  const wanted = { lists: 20, resolves: 40 };
  for (const batches of [plan.batches, config.LANE_MAX_BATCHES]) {
    const reserve = laneRequestReserve({ batches });
    const fit = fitDiscovery({
      ...wanted,
      allowance: config.MAX_REQUESTS_PER_RUN - 3 - reserve,
    });
    assert.deepEqual(fit, wanted, `${batches} batches`);
    // The whole run stays under the contract: registry, discovery, burst,
    // fallback, Frontier.
    assert.ok(
      3 + 80 + reserve - config.LANE_DISCOVERED_RESERVE_BATCHES <=
        config.MAX_REQUESTS_PER_RUN,
    );
  }
  // The full plan's reserve is what it was: 8,500 pools are 284 batches, a batch
  // more for each of the 22 networks, the fallback and Frontier's step.
  assert.equal(requestReserve(8500), Math.ceil(8500 / 30) + 22 + 6 + 3);
  assert.ok(laneRequestReserve({ batches: 220 }) < requestReserve(8500));
});

/* ── A run ───────────────────────────────────────────────────────────────── */

const HOOK_ROW = {
  hook: {
    address: address(9990),
    chainId: 8453,
    chain: "base",
    name: "SomeHook",
    description: "A test deployment",
    verifiedSource: true,
  },
  properties: { dynamicFee: false, upgradeable: false },
};
const hook = HOOK_ROW.hook.address.toLowerCase();
const T0 = Date.parse("2026-10-28T12:00:00.000Z");

/** A small state on Base, as the lanes see it a few hours after the last run. */
function smallWorld({ saved = T0 - 3 * H } = {}) {
  const make = (n, spec) => ({ ...spec, hookAddress: hook, id: hashId(n, "run") });
  const hot = Array.from({ length: 60 }, (_, i) =>
    make(i + 1, answeredPool(i + 1, { lastAgo: (i % 20) * H, at: saved })),
  );
  const silentHot = Array.from({ length: 6 }, (_, i) =>
    make(100 + i, answeredPool(100 + i, { lastAgo: 40 * H, at: saved })),
  );
  const fresh = Array.from({ length: 5 }, (_, i) =>
    make(200 + i, silentPool(200 + i, { firstAgo: 5 * H, at: saved, source: "v4.xyz" })),
  );
  const cool = Array.from({ length: 40 }, (_, i) =>
    make(300 + i, answeredPool(300 + i, { lastAgo: 12 * DAY, at: saved })),
  );
  const cold = Array.from({ length: 200 }, (_, i) =>
    make(400 + i, silentPool(400 + i, { firstAgo: 20 * DAY, at: saved })),
  );
  const live = new Set(
    [...hot, ...fresh.slice(0, 3), ...cool].map((pool) => pool.id),
  );
  return {
    pools: [...hot, ...silentHot, ...fresh, ...cool, ...cold],
    lanes: { hot, silentHot, fresh, cool, cold },
    live,
    saved,
  };
}

async function laneRun({
  world = smallWorld(),
  historyPools = 60,
  historyAt = world.saved,
  env = {},
  runOptions = {},
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), "collector-lanes-"));
  const clock = new FakeClock(T0);
  const known = new Map(world.pools.map((pool) => [pool.id, pool]));
  const answer = (call) => {
    const url = call.url;
    if (url === REGISTRY_URL) return { body: [HOOK_ROW] };
    if (url === CHAINS_URL) return { body: { base: { chainId: 8453 } } };
    if (url === FRONTIER_URL) return { body: [] };
    if (url.startsWith("https://api.dexscreener.com/latest/dex/pairs/base/")) {
      const ids = url.split("/").pop().split(",");
      const rows = ids
        .filter((id) => world.live.has(id) && known.has(id))
        .map((id) => dexRow(known.get(id)));
      return { body: { pairs: rows.length ? rows : null } };
    }
    return { status: 404, body: {} };
  };
  const fetchImpl = fakeFetch(clock, answer);
  const state = join(dir, "state");
  await mkdir(state, { recursive: true });
  const updated = world.saved;
  await writeFile(
    join(state, "pools.json"),
    poolsJson(iso(updated), world.pools),
  );
  if (historyPools !== null)
    await writeFile(
      join(state, "history.json"),
      historyJson([{ timestamp: historyAt, value: 1000, pools: historyPools }]),
    );
  const result = await runCollector({
    stateDir: state,
    outDir: join(dir, "data"),
    stateOutDir: state,
    minCurrent: 20,
    maxDiscovery: 0,
    fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
    env: { GITHUB_REPOSITORY: "owner/hook-radar", ...env },
    ...runOptions,
  });
  const dsAsked = new Set();
  for (const call of fetchImpl.calls)
    if (call.url.startsWith("https://api.dexscreener.com/"))
      for (const id of call.url.split("/").pop().split(",")) dsAsked.add(id);
  return {
    dir,
    state,
    result,
    fetchImpl,
    dsAsked,
    world,
    done: () => rm(dir, { recursive: true, force: true }),
  };
}

test("a run with the lane plan asks about HOT and NEW and what fell due, passes the unchanged gates, and says what it did", async () => {
  const run = await laneRun();
  try {
    const { result, dsAsked, world } = run;
    assert.equal(result.ok, true, result.quality.failures.join("; "));
    const { counts } = result.status;
    assert.equal(counts.plan.mode, "lanes");
    assert.equal(counts.plan.reason, null);
    assert.equal(counts.plan.fellBack, false);
    assert.equal(counts.plan.ceilingBound, false);
    assert.equal(counts.plan.maxBatches, config.LANE_MAX_BATCHES);
    assert.deepEqual(counts.plan.periodsHours, { warm: 3, cool: 6, cold: 12 });
    assert.equal(counts.plan.hotAndNew, 71);
    assert.equal(counts.plan.previousPools, 60);
    assert.equal(counts.plan.floor, 54);

    // The same pools an independent plan names for the window the run reports.
    const expected = planLanes(world.pools, {
      nowMs: Date.parse(counts.plan.windowTo),
      updatedAtMs: world.saved,
    });
    assert.equal(counts.plan.windowFrom, iso(world.saved - config.LANE_WINDOW_OVERLAP_MS));
    assert.equal(counts.plan.anchor, iso(Date.parse(counts.plan.windowTo)));
    assert.deepEqual(
      [...dsAsked].sort(),
      [...plannedKeys(expected)].map((key) => key.split(":")[1]).sort(),
    );
    // HOT and NEW were all asked, and some of the wheels' pools.
    const { hot, silentHot, fresh, cool, cold } = world.lanes;
    for (const pool of [...hot, ...silentHot, ...fresh])
      assert.equal(dsAsked.has(pool.id), true, "an answering or new pool was asked");
    assert.ok(cool.filter((pool) => dsAsked.has(pool.id)).length > 0);
    assert.ok(cool.filter((pool) => !dsAsked.has(pool.id)).length > 0);
    assert.ok(cold.filter((pool) => dsAsked.has(pool.id)).length > 0);
    assert.ok(cold.filter((pool) => !dsAsked.has(pool.id)).length > 100);

    // The counts agree with each other and with the requests.
    assert.equal(counts.plannedPools, dsAsked.size);
    assert.equal(counts.requestedPools, dsAsked.size);
    assert.equal(counts.dexscreener.poolsAsked, dsAsked.size);
    assert.equal(counts.dexscreener.batches, Math.ceil(dsAsked.size / 30));
    assert.equal(counts.droppedForCap, 0);
    assert.equal(
      counts.plannedPools + counts.deferredPools + counts.droppedForCap,
      world.pools.length,
    );
    assert.equal(counts.statePools, world.pools.length);
    assert.equal(result.quality.checks.plannedPools, counts.plannedPools);
    assert.equal(result.quality.checks.requestedPools, counts.requestedPools);
    assert.equal(counts.lanes.hot.known, 66);
    assert.equal(counts.lanes.hot.scheduled, 66);
    assert.equal(counts.lanes.hot.requested, 66);
    assert.equal(counts.lanes.hot.answered, 66);
    assert.equal(counts.lanes.hot.measured, 60);
    assert.deepEqual(counts.lanes.new, {
      known: 5,
      scheduled: 5,
      requested: 5,
      answered: 5,
      measured: 3,
    });
    assert.equal(counts.lanes.warm.known, 0);
    assert.equal(counts.lanes.cool.known, 40);
    assert.equal(counts.lanes.cool.requested, counts.lanes.cool.scheduled);
    assert.equal(counts.lanes.cool.measured, counts.lanes.cool.scheduled);
    assert.equal(counts.lanes.cold.known, 200);
    assert.equal(counts.lanes.cold.measured, 0);
    assert.equal(
      LANES.reduce((sum, lane) => sum + counts.lanes[lane].scheduled, 0),
      counts.plannedPools,
    );

    // The note on DEX Screener says what this snapshot asked.
    const note = result.snapshot.sources.find((s) => s.id === "dexscreener").note;
    assert.match(
      note,
      new RegExp(
        `This snapshot asked about ${dsAsked.size} of the ${world.pools.length} pools the collector knows`,
      ),
    );
    assert.match(note, /every 3 hours/);
    assert.match(note, /every 6 hours/);
    assert.match(note, /every 12 hours/);
    assert.match(note, /not asked is unchecked in this snapshot, not zero/);
    // The plan did not reach its ceiling, so the note does not say it did.
    assert.doesNotMatch(note, /reached its limit/);

    // The state after the run: pools that answered are stamped, the others not.
    const next = await readState(run.state);
    const before = new Map(world.pools.map((pool) => [pool.id, pool]));
    for (const pool of next.pools) {
      const was = before.get(pool.id);
      if (world.live.has(pool.id) && dsAsked.has(pool.id)) {
        // Measured in this run: a never-answered pool is stamped at once; one
        // that answered within the day keeps its stamp.
        if (was.lastSeen === was.firstSeen)
          assert.ok(Date.parse(pool.lastSeen) > Date.parse(pool.firstSeen));
        else assert.ok(Date.parse(pool.lastSeen) >= Date.parse(was.lastSeen));
      } else assert.equal(pool.lastSeen, was.lastSeen, "an unmeasured pool is untouched");
    }
    // A revived COOL pool that was asked is HOT now.
    const revived = world.lanes.cool.filter((pool) => dsAsked.has(pool.id));
    assert.ok(revived.length > 0);
    for (const pool of revived) {
      const row = next.pools.find((p) => p.id === pool.id);
      assert.equal(row.lastSeen, result.snapshot.generatedAt);
    }
  } finally {
    await run.done();
  }
});

test("after ten days without a run the lanes still hold the pools that answered, the plan stays under the ceiling and the run is not refused", async () => {
  const saved = T0 - 10 * DAY;
  const run = await laneRun({
    world: smallWorld({ saved }),
    historyAt: saved,
  });
  try {
    const { result, dsAsked, world } = run;
    assert.equal(result.ok, true, result.quality.failures.join("; "));
    const { counts } = result.status;
    assert.equal(counts.plan.mode, "lanes");
    // The anchor stopped a day after the saved time, so nothing aged out of HOT.
    assert.equal(counts.plan.anchor, iso(saved + config.LANE_ANCHOR_MAX_AHEAD_MS));
    assert.equal(counts.lanes.hot.known, 66);
    assert.ok(counts.lanes.hot.known > 0);
    for (const pool of world.lanes.hot) assert.equal(dsAsked.has(pool.id), true);
    assert.ok(counts.dexscreener.batches <= config.LANE_MAX_BATCHES);
    // A window longer than any period asks every wheel's whole lane.
    assert.equal(counts.lanes.cool.scheduled, 40);
    assert.equal(counts.lanes.cold.scheduled, 200);
    assert.equal(counts.deferredPools, 0);
  } finally {
    await run.done();
  }
});

test("COLLECTOR_FULL_PLAN=1 returns the run to the plan that asks about every known pool, and says it was asked for", async () => {
  for (const env of [{ COLLECTOR_FULL_PLAN: "1" }, { COLLECTOR_FULL_PLAN: " True " }]) {
    const run = await laneRun({ env });
    try {
      const { result, dsAsked, world } = run;
      assert.equal(result.ok, true, result.quality.failures.join("; "));
      const { counts } = result.status;
      assert.equal(counts.plan.mode, "full");
      assert.equal(counts.plan.reason, "forced");
      assert.equal(counts.plan.fellBack, false);
      assert.equal(counts.plan.maxBatches, null);
      assert.equal(counts.lanes, null);
      assert.equal(counts.deferredPools, 0);
      assert.equal(dsAsked.size, world.pools.length);
      assert.equal(counts.plannedPools, world.pools.length);
      const note = result.snapshot.sources.find((s) => s.id === "dexscreener").note;
      assert.doesNotMatch(note, /This snapshot asked about/);
      // Not loud: it was asked for.
      assert.equal(
        planNotices(counts, {}).some((line) => /WARNING/.test(line)),
        false,
      );
    } finally {
      await run.done();
    }
  }
  // An empty, false or unknown value changes nothing: the lanes run.
  for (const value of ["", "0", "false", "off", "maybe", undefined]) {
    assert.equal(config.resolveFullPlan({ COLLECTOR_FULL_PLAN: value }), false);
  }
  const normal = await laneRun({ env: { COLLECTOR_FULL_PLAN: "" } });
  try {
    assert.equal(normal.result.status.counts.plan.mode, "lanes");
  } finally {
    await normal.done();
  }
});

test("--full-plan and --max-pools select the full plan on the command line too", async () => {
  assert.equal(parseArguments(["--full-plan"]).fullPlan, true);
  assert.equal(parseArguments([]).fullPlan, undefined);
  const flag = await laneRun({ runOptions: { fullPlan: true } });
  try {
    assert.equal(flag.result.status.counts.plan.reason, "forced");
  } finally {
    await flag.done();
  }
  const capped = await laneRun({ runOptions: { maxPools: 50 } });
  try {
    assert.equal(capped.result.status.counts.plan.mode, "full");
    assert.equal(capped.result.status.counts.plan.reason, "max-pools");
    assert.equal(capped.result.status.counts.plannedPools, 50);
    assert.equal(capped.result.status.counts.plan.fellBack, false);
  } finally {
    await capped.done();
  }
});

test("when HOT and NEW hold too few pools the run falls back to the full plan, publishes as before, and says so loudly", async () => {
  // The previous history point had 200 pools with a current volume; 71 HOT and
  // NEW pools are far below 90% of that. The point is older than a day, so the
  // quality gate's own comparison with it does not apply.
  const run = await laneRun({
    historyPools: 200,
    historyAt: T0 - 30 * H,
  });
  try {
    const { result, dsAsked, world } = run;
    assert.equal(result.ok, true, result.quality.failures.join("; "));
    const { counts } = result.status;
    assert.equal(counts.plan.mode, "full");
    assert.equal(counts.plan.reason, "below-floor");
    assert.equal(counts.plan.fellBack, true);
    assert.equal(counts.plan.hotAndNew, 71);
    assert.equal(counts.plan.floor, 180);
    assert.equal(counts.plan.previousPools, 200);
    assert.match(counts.plan.detail, /71 pools that answered or are new, fewer than 180/);
    assert.equal(dsAsked.size, world.pools.length);
    const lines = planNotices(counts, {});
    assert.match(lines[0], /^Plan: full \(below-floor\)/);
    assert.ok(lines.some((line) => /^WARNING: /.test(line) && /every known pool/.test(line)));
    const onGitHub = planNotices(counts, { GITHUB_ACTIONS: "true" });
    assert.ok(onGitHub.some((line) => line.startsWith("::warning title=Lane plan not used::")));
  } finally {
    await run.done();
  }
  // No history point to size the sample against, and no saved time: the same.
  const noHistory = await laneRun({ historyPools: null });
  try {
    assert.equal(noHistory.result.status.counts.plan.reason, "no-history");
    assert.equal(noHistory.result.status.counts.plan.fellBack, true);
  } finally {
    await noHistory.done();
  }
});

test("a run whose lane plan reaches the batch ceiling says so, and the pools it left out are counted", async () => {
  // 60 live pools are HOT, and 8,000 cold pools make the wheel large at a gap of
  // a day: the ceiling cuts COLD and the status file names it.
  const base = smallWorld({ saved: T0 - 9 * H });
  const more = Array.from({ length: 9000 }, (_, i) => ({
    ...silentPool(5000 + i, { firstAgo: 20 * DAY, at: base.saved }),
    hookAddress: hook,
    id: hashId(5000 + i, "run"),
  }));
  const world = { ...base, pools: [...base.pools, ...more] };
  const run = await laneRun({ world, historyAt: base.saved });
  try {
    const { result } = run;
    assert.equal(result.ok, true, result.quality.failures.join("; "));
    const { counts } = result.status;
    assert.equal(counts.plan.mode, "lanes");
    assert.equal(counts.plan.ceilingBound, true);
    assert.ok(counts.plan.trimmed.cold > 0);
    assert.equal(counts.droppedForCap, counts.plan.trimmed.cold + counts.plan.trimmed.cool + counts.plan.trimmed.warm);
    assert.ok(counts.dexscreener.batches <= config.LANE_MAX_BATCHES);
    assert.equal(
      counts.plannedPools + counts.deferredPools + counts.droppedForCap,
      world.pools.length,
    );
    const lines = planNotices(counts, { GITHUB_ACTIONS: "true" });
    assert.ok(lines.some((line) => line.startsWith("::notice title=Lane plan hit its batch ceiling::")));
    assert.ok(lines.some((line) => /ceiling of 220 DEX Screener batches/.test(line)));
    assert.equal(lines.some((line) => /warning/i.test(line)), false);
    // The snapshot's own note says so too, after the periods it states.
    const note = result.snapshot.sources.find((s) => s.id === "dexscreener").note;
    assert.match(
      note,
      /every 12 hours\)\. This plan reached its limit of 220 batches a run, so some of the pools that were due were left for their next turn\. A pool that was not asked is unchecked/,
    );
  } finally {
    await run.done();
  }
});

test("the offline replay has no saved time, so it uses the full plan and publishes as it always did", async () => {
  const dir = await mkdtemp(join(tmpdir(), "collector-lanes-offline-"));
  try {
    const result = await runCollector({
      offline: true,
      stateDir: join(FIXTURES, "state"),
      outDir: dir,
      stateOutDir: join(dir, "state"),
      minCurrent: 20,
      env: {},
    });
    assert.equal(result.ok, true, result.quality.failures.join("; "));
    assert.equal(result.published, true);
    const { plan } = result.status.counts;
    assert.equal(plan.mode, "full");
    assert.equal(plan.reason, "no-saved-time");
    assert.equal(plan.fellBack, true);
    assert.equal(result.status.counts.lanes, null);
    assert.ok(result.status.counts.plannedPools > 0);
    assert.equal(plan.batches, result.status.counts.dexscreener.batches);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ── The dry run ─────────────────────────────────────────────────────────── */

test("the plan dry run reads a state folder and makes no request and writes no file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "collector-lanes-dry-"));
  try {
    const world = realisticWorld();
    await writeFile(join(dir, "pools.json"), poolsJson(iso(U), world));
    await writeFile(
      join(dir, "history.json"),
      historyJson([{ timestamp: U - H, value: 1, pools: 1408 }]),
    );
    const before = (await readdir(dir)).sort();
    const lines = [];
    const code = await dryRunMain([dir, "1", "3.7", "6", "9"], (line) =>
      lines.push(line),
    );
    assert.equal(code, 0);
    assert.deepEqual((await readdir(dir)).sort(), before);
    const text = lines.join("\n");
    for (const gap of ["1", "3.7", "6", "9"])
      assert.match(text, new RegExp(`^Gap ${gap} h:`, "m"));
    assert.match(text, /plan: lanes/);
    assert.match(text, /HOT .* 1851 +1851 +[0-9]+/);
    assert.match(text, /lane +known +asked +batches/);
    assert.match(text, /ceiling 220, BOUND/);
    assert.match(text, /pools measured in the last 24 h before the saved time: 1497/);
    assert.match(text, /HOT or NEW in this plan: 1497/);

    const json = [];
    assert.equal(await dryRunMain([dir, "3.7", "--json"], (line) => json.push(line)), 0);
    const [report] = JSON.parse(json.join("\n"));
    assert.equal(report.mode, "lanes");
    assert.equal(report.answeringAndAsked, report.answeredWithinADayEligible);
    assert.equal(report.lanes.hot.scheduled, 1851);
    assert.ok(report.batches < report.fullPlanBatches);

    // The same numbers as the planner's own.
    const state = await readState(dir);
    assert.equal(
      dryRun(state, 6).batches,
      planLanes(world, { nowMs: U + 6 * H, updatedAtMs: U }).batches,
    );
    assert.ok(formatReport(dryRun(state, 1)).length > 8);

    // A state with nothing to start the lanes from reports the full plan.
    await writeFile(join(dir, "pools.json"), poolsJson(null, world));
    const flipped = dryRun(await readState(dir), 3);
    assert.equal(flipped.mode, "full");
    assert.equal(flipped.reason, "no-saved-time");
    assert.equal(flipped.lanes, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the plan dry run refuses a missing folder and bad gaps, and has no way to reach the network", async () => {
  const errors = [];
  const original = console.error;
  console.error = (line) => errors.push(String(line));
  try {
    assert.equal(await dryRunMain([], () => {}), 2);
    assert.equal(await dryRunMain(["somewhere"], () => {}), 2);
    assert.equal(await dryRunMain(["somewhere", "0"], () => {}), 2);
    assert.equal(await dryRunMain(["somewhere", "soon"], () => {}), 2);
    assert.equal(await dryRunMain([join(tmpdir(), "no-such-state-folder"), "1"], () => {}), 1);
  } finally {
    console.error = original;
  }
  assert.ok(errors.some((line) => /Usage: node collector\/tools\/plan-dry-run\.mjs/.test(line)));
  const source = await readFile(
    new URL("../collector/tools/plan-dry-run.mjs", import.meta.url),
    "utf8",
  );
  // No HTTP client, no fetch, no sockets, no file written.
  for (const pattern of [
    /\bfetch\s*\(/,
    /createHttpClient/,
    /\.\/http\.mjs/,
    /node:(?:https?|net|tls|dgram|dns)\b/,
    /\bwriteFile|writeState|appendFile|mkdir\b/,
  ])
    assert.doesNotMatch(source, pattern, String(pattern));
});
