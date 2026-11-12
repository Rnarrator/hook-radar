import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAINS_URL, FRONTIER_URL, REGISTRY_URL } from "../server/model.mjs";
import * as config from "../collector/config.mjs";
import { laneNetworkGuard, withLaneGuard } from "../collector/lane-guard.mjs";
import {
  decidePlanMode,
  decidePlanSafely,
  fallbackBatches,
  measurementChains,
  planBurst,
  planLanes,
  planMeasurement,
  planSafely,
  plannerFailure,
  runBurst,
} from "../collector/measure.mjs";
import { createHttpClient } from "../collector/http.mjs";
import { planNotices, planStatusSafely, runCollector } from "../collector/run.mjs";
import { assessQuality } from "../collector/quality.mjs";
import { lanePlanNote } from "../collector/assemble.mjs";
import { historyJson, poolsJson } from "../collector/state.mjs";
import {
  address,
  blockNetwork,
  dexRow,
  FakeClock,
  fakeFetch,
  statePool,
} from "../collector/testing.mjs";

blockNetwork();

// The lane plan's refusal of a network DEX Screener did not answer for, the cases where the
// lane plan falls back to the full plan, and the order of the GeckoTerminal
// fallback in the lane plan. Everything runs on made-up pools and fake providers:
// nothing reaches a provider and nothing is written outside a scratch folder.

const H = 3600000;
const DAY = 24 * H;
const T0 = Date.parse("2026-11-12T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const hashId = (n, salt = "guard") =>
  `0x${createHash("sha256").update(`${salt}:${n}`).digest("hex")}`;
const keyOf = (pool) => `${pool.chain}:${pool.id}`;
const chain = (slug) => measurementChains().find((c) => c.chain === slug);

/** A pool a provider measured `lastAgo` before `at`. */
const answered = (n, { chain: slug = "base", lastAgo, at, salt } = {}) =>
  statePool(n, {
    id: hashId(n, salt),
    chain: slug,
    firstSeen: iso(at - lastAgo - 30 * DAY),
    lastSeen: iso(at - lastAgo),
  });
/** A pool added `firstAgo` before `at` that never answered. */
const silent = (n, { chain: slug = "base", firstAgo, at, salt } = {}) =>
  statePool(n, {
    id: hashId(n, salt),
    chain: slug,
    firstSeen: iso(at - firstAgo),
    lastSeen: iso(at - firstAgo),
  });

/* ── The guard on a plan and a burst ─────────────────────────────────────── */

/** A lane plan with `hot` HOT pools and `cold` COLD ones (all due) on each of the
 * networks, and a burst that answered `answeredOf[slug]` of the HOT ones. */
function guardWorld(specs) {
  const at = T0 - 20 * H;
  const pools = [];
  let n = 1;
  for (const [slug, { hot, cold = 0 }] of Object.entries(specs)) {
    for (let i = 0; i < hot; i++, n++)
      pools.push(answered(n, { chain: slug, lastAgo: (i % 20) * H, at }));
    for (let i = 0; i < cold; i++, n++)
      pools.push(silent(n, { chain: slug, firstAgo: 30 * DAY, at }));
  }
  const plan = planLanes(pools, { nowMs: T0, updatedAtMs: at });
  const hotKeys = (slug) =>
    pools
      .filter((p) => p.chain === slug && plan.laneByKey.get(keyOf(p)) === "hot")
      .map(keyOf);
  return { pools, plan, hotKeys };
}
const burstOf = (down, answeredKeys, unsupported = []) => ({
  downNetworks: down,
  unsupportedNetworks: unsupported,
  answeredKeys: new Set(answeredKeys),
});

test("a network DEX Screener did not answer for, with 50 or more HOT pools and under 80% of its HOT and NEW pools answered, is refused", () => {
  const { plan, hotKeys } = guardWorld({
    base: { hot: 120, cold: 60 },
    ethereum: { hot: 400 },
  });
  const guard = laneNetworkGuard({
    plan,
    burst: burstOf(["base"], hotKeys("ethereum")),
  });
  assert.equal(guard.ok, false);
  assert.equal(guard.failures.length, 1);
  assert.match(guard.failures[0], /DEX Screener did not answer for Base/);
  assert.match(guard.failures[0], /only 0 of its 120 pools that answer or are new/);
  assert.match(guard.failures[0], /at least 80% are required/);
  assert.match(guard.failures[0], /leave the network out of the snapshot/);
  assert.deepEqual(guard.networks, [
    { chain: "base", hot: 120, hotAndNew: 120, answered: 0, share: 0, refused: true },
  ]);
});

test("the boundaries: 50 HOT pools are judged and 49 are not; 80% answered passes and 79% does not", () => {
  const judged = (hot, answeredCount) => {
    const { plan, hotKeys } = guardWorld({ base: { hot, cold: 150 } });
    return laneNetworkGuard({
      plan,
      burst: burstOf(["base"], hotKeys("base").slice(0, answeredCount)),
    });
  };
  assert.equal(config.LANE_GUARD_MIN_HOT_POOLS, 50);
  assert.equal(judged(50, 0).ok, false, "50 HOT pools, none answered");
  assert.equal(judged(49, 0).ok, true, "49 HOT pools are too few to judge");
  assert.equal(judged(49, 0).networks[0].refused, false);
  // 100 HOT pools: 80 answered is 80%, which meets the gate's own share.
  assert.equal(judged(100, 80).ok, true);
  assert.equal(judged(100, 79).ok, false);
});

test("only a network the burst found down is judged: failed batches here and there, a burst out of time and a network DEX Screener does not index do not refuse", () => {
  const { plan, hotKeys } = guardWorld({
    base: { hot: 120, cold: 60 },
    ethereum: { hot: 400 },
  });
  // Nothing answered for Base but the burst did not stop it (a few failed batches,
  // or it ran out of time): the gate's shares judge that, not this guard.
  assert.equal(
    laneNetworkGuard({ plan, burst: burstOf([], hotKeys("ethereum")) }).ok,
    true,
  );
  assert.deepEqual(
    laneNetworkGuard({ plan, burst: burstOf([], []) }).networks,
    [],
  );
  // A network DEX Screener answered HTTP 400 for is not an outage.
  assert.equal(
    laneNetworkGuard({
      plan,
      burst: burstOf(["base"], hotKeys("ethereum"), ["base"]),
    }).ok,
    true,
  );
  // A network that is down, with enough answered before it went down, passes.
  assert.equal(
    laneNetworkGuard({
      plan,
      burst: burstOf(["base"], [...hotKeys("ethereum"), ...hotKeys("base").slice(0, 100)]),
    }).ok,
    true,
  );
});

test("NEW pools count in the share, never toward the 50 HOT pools; and the full plan is not judged", () => {
  const at = T0 - 20 * H;
  const hot = Array.from({ length: 60 }, (_, i) =>
    answered(i + 1, { lastAgo: (i % 10) * H, at }),
  );
  const fresh = Array.from({ length: 60 }, (_, i) =>
    silent(100 + i, { firstAgo: 5 * H, at }),
  );
  const plan = planLanes([...hot, ...fresh], { nowMs: T0, updatedAtMs: at });
  assert.equal(plan.lanes.new.scheduled, 60);
  // 60 of the 120 HOT and NEW pools answered is 50%: refused.
  const half = burstOf(["base"], [...hot.map(keyOf)]);
  const verdict = laneNetworkGuard({ plan, burst: half });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.networks[0].hotAndNew, 120);
  assert.equal(verdict.networks[0].answered, 60);
  // Only NEW pools on the network (no HOT): nothing priced is lost, not judged.
  const onlyNew = planLanes(fresh, { nowMs: T0, updatedAtMs: at });
  assert.equal(laneNetworkGuard({ plan: onlyNew, burst: burstOf(["base"], []) }).ok, true);
  // The full plan has no guard: its gate is what it was.
  const full = planBurst([...hot, ...fresh]);
  assert.deepEqual(laneNetworkGuard({ plan: full, burst: burstOf(["base"], []) }), {
    ok: true,
    failures: [],
    networks: [],
  });
});

test("withLaneGuard adds the guard's sentences after the gate's, never lowers a refusal, and leaves the gate's checks as they were", () => {
  const gate = assessQuality({
    currentPools: 600,
    currentVolumePools: 600,
    observedPools: 600,
    plannedPools: 1000,
    requestedPools: 1000,
    checkedPools: 1000,
    snapshotValid: true,
    overviewsValid: true,
  });
  assert.equal(gate.ok, true);
  const { plan } = guardWorld({ base: { hot: 60 } });
  const refusing = { ok: false, failures: ["a network"], networks: [] };
  const passing = { ok: true, failures: [], networks: [] };
  const refused = withLaneGuard(gate, refusing, plan);
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.failures, ["a network"]);
  assert.deepEqual(refused.checks, gate.checks);
  assert.equal(withLaneGuard(gate, passing, plan).ok, true);
  assert.deepEqual(withLaneGuard(gate, passing, plan).networkGuard, {
    minHotPools: 50,
    minShare: 0.8,
    networks: [],
  });
  // A gate that refuses stays refused, with its own reasons first.
  const failing = assessQuality({
    currentPools: 0,
    plannedPools: 10,
    requestedPools: 0,
    snapshotValid: true,
    overviewsValid: true,
  });
  const both = withLaneGuard(failing, refusing, plan);
  assert.equal(both.ok, false);
  assert.equal(both.failures.at(-1), "a network");
  assert.equal(both.failures.length, failing.failures.length + 1);
  assert.equal(withLaneGuard(failing, passing, plan).ok, false);
  // The full plan carries no guard rows.
  assert.equal(withLaneGuard(gate, passing, planBurst([])).networkGuard, null);
});

/* ── A run: one network goes down ────────────────────────────────────────── */

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

/** The state of a run with the lane plan, a gap of 13 hours after the saved time so
 * that every wheel is due. Ethereum is the bulk of the sample; the others are the
 * networks the tests take down. */
function outageWorld() {
  const saved = T0 - 13 * H;
  const pools = [];
  const live = new Set();
  let n = 1;
  const add = (slug, hot, cold) => {
    for (let i = 0; i < hot; i++, n++) {
      const p = {
        ...answered(n, { chain: slug, lastAgo: (i % 20) * H, at: saved, salt: "out" }),
        hookAddress: hook,
      };
      pools.push(p);
      live.add(p.id);
    }
    for (let i = 0; i < cold; i++, n++)
      pools.push({
        ...silent(n, { chain: slug, firstAgo: 30 * DAY, at: saved, salt: "out" }),
        hookAddress: hook,
      });
  };
  add("ethereum", 1200, 30);
  add("base", 120, 60); // 180 pools: six batches, so five failures stop it
  add("arc", 30, 150); // 180 pools but only 30 HOT: too few to be judged
  add("ink", 60, 150); // 210 pools; its HOT pools are answered by nothing
  add("unichain", 60, 0); // 60 pools: two batches, and both fail
  return { pools, live, saved };
}

async function outageRun({ failFor = {}, every = 0, env = {}, runOptions = {} } = {}) {
  const world = outageWorld();
  const dir = await mkdtemp(join(tmpdir(), "collector-guard-"));
  const clock = new FakeClock(T0);
  const known = new Map(world.pools.map((p) => [p.id, p]));
  let dsCount = 0;
  const answer = (call) => {
    const url = call.url;
    if (url === REGISTRY_URL) return { body: [HOOK_ROW] };
    if (url === CHAINS_URL)
      return {
        body: {
          ethereum: { chainId: 1 },
          base: { chainId: 8453 },
          arc: { chainId: 5042 },
          ink: { chainId: 57073 },
          unichain: { chainId: 130 },
        },
      };
    if (url === FRONTIER_URL) return { body: [] };
    const match = /^https:\/\/api\.dexscreener\.com\/latest\/dex\/pairs\/([^/]+)\/(.+)$/.exec(url);
    if (match) {
      dsCount++;
      if (failFor[match[1]]) return { status: failFor[match[1]], body: {} };
      if (every && dsCount % every === 0) return { status: 503, body: {} };
      const ids = match[2].split(",");
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
  await writeFile(join(state, "pools.json"), poolsJson(iso(world.saved), world.pools));
  await writeFile(
    join(state, "history.json"),
    historyJson([{ timestamp: world.saved, value: 1000, pools: 1250 }]),
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
  return { dir, state, result, fetchImpl, world, done: () => rm(dir, { recursive: true, force: true }) };
}

test("with no outage the world publishes, and the lane plan asks every network's HOT pools", async () => {
  const run = await outageRun();
  try {
    const { result } = run;
    assert.equal(result.ok, true, result.quality.failures.join("; "));
    const { counts } = result.status;
    assert.equal(counts.plan.mode, "lanes");
    assert.deepEqual(counts.downNetworks, []);
    assert.deepEqual(counts.plan.networkGuard, {
      minHotPools: 50,
      minShare: 0.8,
      networks: [],
    });
  } finally {
    await run.done();
  }
});

test("a 5xx from DEX Screener for one network that holds 120 HOT pools is refused with the lane plan, although the gate's own shares pass", async () => {
  const run = await outageRun({ failFor: { base: 500 } });
  try {
    const { result, dir } = run;
    // The gate's own verdict is a pass: its two shares are above 80% (the
    // defect this guard closes: the lane plan published a network's outage).
    const { checks } = result.quality;
    assert.ok(checks.share >= 0.8, `requested ${checks.share}`);
    assert.ok(checks.answeredShare >= 0.8, `answered ${checks.answeredShare}`);
    assert.equal(result.quality.checks.minShare, 0.8);
    // The guard refuses, and only the guard.
    assert.equal(result.ok, false);
    assert.equal(result.quality.failures.length, 1);
    assert.match(result.quality.failures[0], /DEX Screener did not answer for Base/);
    assert.match(result.quality.failures[0], /only 0 of its 120 pools that answer or are new/);
    assert.equal(result.published, false);
    // A refused run writes nothing and the saved state is as it was.
    assert.equal(
      await readdir(join(dir, "data")).then(
        (names) => names.length,
        () => 0,
      ),
      0,
      "nothing was published",
    );
    assert.equal(result.status.counts.plan.mode, "lanes");
    assert.deepEqual(result.status.counts.downNetworks, ["base"]);
    assert.deepEqual(
      result.status.counts.plan.networkGuard.networks.map(({ chain: slug, refused }) => [slug, refused]),
      [["base", true]],
    );
    // The 7D and 30D step did not spend its requests on a run that is refused.
    assert.equal(result.status.counts.daily.requested, 0);
    assert.match(result.status.counts.daily.skipped, /would not pass the quality gate/);
    assert.equal(
      run.fetchImpl.calls.filter((call) => call.url.includes("geckoterminal")).length,
      result.status.counts.requests.geckoterminal,
    );
  } finally {
    await run.done();
  }
});

test("the same outage on the full plan is judged by the gate alone, as before: COLLECTOR_FULL_PLAN does not add the guard", async () => {
  const run = await outageRun({ failFor: { base: 500 }, env: { COLLECTOR_FULL_PLAN: "1" } });
  try {
    const { result } = run;
    assert.equal(result.status.counts.plan.mode, "full");
    assert.equal(result.quality.networkGuard, null);
    assert.equal(result.status.counts.plan.networkGuard, null);
    // Whatever the gate decides here, no sentence of the guard is in it.
    assert.equal(
      result.quality.failures.some((line) => /did not answer for/.test(line)),
      false,
    );
  } finally {
    await run.done();
  }
});

test("a network with fewer than 50 HOT pools that goes down is not refused: the run publishes and says which network DEX Screener did not answer for", async () => {
  const run = await outageRun({ failFor: { arc: 500 } });
  try {
    const { result } = run;
    assert.equal(result.ok, true, result.quality.failures.join("; "));
    assert.deepEqual(result.status.counts.downNetworks, ["arc"]);
    const [row] = result.status.counts.plan.networkGuard.networks;
    assert.equal(row.chain, "arc");
    assert.equal(row.hot, 30);
    assert.equal(row.answered, 0);
    assert.equal(row.refused, false);
  } finally {
    await run.done();
  }
});

test("a network of 60 HOT pools is judged: five failed batches in a row stop it and it is refused", async () => {
  const run = await outageRun({ failFor: { ink: 500 } });
  try {
    const { result } = run;
    assert.equal(result.ok, false);
    assert.match(result.quality.failures.at(-1), /did not answer for Ink/);
    assert.deepEqual(result.status.counts.downNetworks, ["ink"]);
  } finally {
    await run.done();
  }
});

test("a network of two batches that both fail is down too, at any gap: 60 HOT pools and no wheel pool due", async () => {
  const run = await outageRun({ failFor: { unichain: 500 } });
  try {
    const { result } = run;
    assert.equal(result.ok, false);
    assert.match(result.quality.failures.at(-1), /did not answer for Unichain/);
    assert.deepEqual(result.status.counts.downNetworks, ["unichain"]);
    const [row] = result.status.counts.plan.networkGuard.networks;
    assert.deepEqual(
      [row.chain, row.hot, row.hotAndNew, row.answered, row.refused],
      ["unichain", 60, 60, 0, true],
    );
  } finally {
    await run.done();
  }
});

test("failed batches that are not five in a row, in every network, do not stop a network and do not trip the guard", async () => {
  // Every 7th DEX Screener batch of the run fails, at random networks in the
  // breadth-first order: no network has five failures in a row.
  const run = await outageRun({ every: 7 });
  try {
    const { result } = run;
    assert.deepEqual(result.status.counts.downNetworks, []);
    assert.equal(
      result.quality.failures.some((line) => /did not answer for/.test(line)),
      false,
    );
    assert.ok(result.status.counts.dexscreener.failedBatches.total > 0);
  } finally {
    await run.done();
  }
});

test("a network DEX Screener answers HTTP 400 for as its first answer is not an outage: it is unindexed, and the guard leaves it alone", async () => {
  const run = await outageRun({ failFor: { base: 400 } });
  try {
    const { result } = run;
    assert.deepEqual(result.status.counts.unsupportedNetworks, ["base"]);
    assert.deepEqual(result.status.counts.downNetworks, []);
    assert.equal(
      result.quality.failures.some((line) => /did not answer for/.test(line)),
      false,
    );
  } finally {
    await run.done();
  }
});

/* ── What the burst counts as a network that is down ────────────────────── */

test("the burst lists a network DEX Screener did not answer for: five failed batches in a row, or two or more with none answered; not one failed batch, not failures among answers, not an unindexed network", async () => {
  const at = T0 - 3 * H;
  const group = (slug, count) =>
    Array.from({ length: count }, (_, i) =>
      answered(i + 1, { chain: slug, lastAgo: H, at, salt: "down" + slug }),
    );
  // Batches per network: arc 7, base 3, ethereum 2, ink 1, optimism 1, polygon 3,
  // unichain 3.
  const pools = [
    ...group("arc", 210),
    ...group("base", 90),
    ...group("ethereum", 60),
    ...group("ink", 30),
    ...group("optimism", 30),
    ...group("polygon", 90),
    ...group("unichain", 90),
  ];
  const plan = planLanes(pools, { nowMs: T0, updatedAtMs: at });
  // One network at a time fails (so the provider's own stop after five failures in
  // a row, which networks that fail together can reach, is not what is looked at):
  // `fails(k)` says whether its k-th batch (from 0) fails; `status` is what it answers.
  const run = async (slug, fails, status = 500) => {
    const seen = new Map();
    const clock = new FakeClock(T0);
    const fetchImpl = fakeFetch(clock, (call) => {
      const match = /pairs\/([^/]+)\/(.+)$/.exec(call.url);
      if (!match) return { status: 404, body: {} };
      const k = seen.get(match[1]) ?? 0;
      seen.set(match[1], k + 1);
      return match[1] === slug && fails(k)
        ? { status: typeof status === "function" ? status(k) : status, body: {} }
        : { body: { pairs: null } };
    });
    const client = createHttpClient({
      fetchImpl,
      now: clock.now,
      sleep: clock.sleep,
      userAgent: "Test/1 (+https://github.com/example/repo)",
    });
    return runBurst({ client, plan, now: clock.now, fallbackRequests: 0 });
  };
  const always = () => true;
  // Seven batches, all failed: stopped after five (the other two are not sent).
  const arc = await run("arc", always);
  assert.deepEqual(arc.downNetworks, ["arc"]);
  const row = arc.networks.find((n) => n.chain === "arc");
  assert.deepEqual([row.failedBatches, row.requested], [5, 150]);
  // Three batches, all failed: down, although it never reached five.
  assert.deepEqual((await run("base", always)).downNetworks, ["base"]);
  // Two batches, both failed: down.
  assert.deepEqual((await run("ethereum", always)).downNetworks, ["ethereum"]);
  // Failure at the beginning of a network that then answers: not down.
  const late = await run("polygon", (k) => k < 2);
  assert.deepEqual(late.downNetworks, []);
  assert.equal(late.networks.find((n) => n.chain === "polygon").failedBatches, 2);
  // A failure among answers: not down.
  assert.deepEqual((await run("unichain", (k) => k === 1)).downNetworks, []);
  // One batch, failed: not down (too little to call an outage).
  const single = await run("ink", always);
  assert.deepEqual(single.downNetworks, []);
  assert.equal(single.networks.find((n) => n.chain === "ink").failedBatches, 1);
  // HTTP 400 as the first answer: a network DEX Screener does not index.
  const unindexed = await run("optimism", always, 400);
  assert.deepEqual(unindexed.downNetworks, []);
  assert.deepEqual(unindexed.unsupportedNetworks, ["optimism"]);
  // A failure and then HTTP 400 as the first answer: two failed batches and none
  // answered, but the network is unindexed, which is not the same as down.
  const mixed = await run("polygon", always, (k) => (k === 0 ? 500 : 400));
  assert.deepEqual(mixed.unsupportedNetworks, ["polygon"]);
  assert.deepEqual(mixed.downNetworks, []);
  assert.equal(mixed.networks.find((n) => n.chain === "polygon").failedBatches, 2);
  // Nothing wrong anywhere, and nothing planned: nothing is down.
  assert.deepEqual((await run("none", always)).downNetworks, []);
  const clock = new FakeClock(T0);
  const idle = await runBurst({
    client: createHttpClient({
      fetchImpl: fakeFetch(clock, () => ({ body: { pairs: null } })),
      now: clock.now,
      sleep: clock.sleep,
      userAgent: "Test/1 (+https://github.com/example/repo)",
    }),
    plan: planBurst([]),
    now: clock.now,
    fallbackRequests: 0,
  });
  assert.deepEqual(idle.downNetworks, []);
});

/* ── The lane plan that cannot be trusted ────────────────────────────────── */

const manyHot = (count, at, chainSlug = "base") =>
  Array.from({ length: count }, (_, i) =>
    answered(i + 1, { chain: chainSlug, lastAgo: (i % 20) * H, at, salt: "many" }),
  );

test("HOT and NEW that alone need more batches than the ceiling are the full plan, with a reason, not a plan past the ceiling", () => {
  const at = T0 - 3 * H;
  const decide = (count) =>
    decidePlanMode({
      pools: manyHot(count, at),
      nowMs: T0,
      updatedAtMs: at,
      previousPoint: { pools: count },
    });
  const limit = config.LANE_MAX_BATCHES * 30; // 6,600 pools on one network
  assert.equal(decide(limit).mode, "lanes", "220 batches exactly fit");
  const over = decide(limit + 1);
  assert.equal(over.mode, "full");
  assert.equal(over.code, "above-ceiling");
  assert.equal(over.batches, config.LANE_MAX_BATCHES + 1);
  assert.match(over.detail, /need 221 DEX Screener batches, more than the lane plan's ceiling of 220/);
  assert.match(over.detail, /never cut/);
  // The status file reports it as a fall back (nothing asked for it).
  const counts = {
    plannedPools: 8500,
    droppedForCap: 0,
    plan: {
      mode: "full",
      reason: over.code,
      detail: over.detail,
      fellBack: true,
      batches: 284,
      ceilingBound: null,
    },
  };
  const lines = planNotices(counts, { GITHUB_ACTIONS: "true" });
  assert.ok(lines.some((line) => line.startsWith("::warning title=Lane plan not used::")));
  // Several networks: the batches are rounded up per network, as the burst sends them.
  const split = [
    ...manyHot(3300, at, "base"),
    ...manyHot(3300, at, "ethereum").map((p, i) => ({ ...p, id: hashId(i, "eth") })),
  ];
  assert.equal(
    decidePlanMode({
      pools: split,
      nowMs: T0,
      updatedAtMs: at,
      previousPoint: { pools: split.length },
    }).mode,
    "lanes",
    "110 + 110 batches",
  );
});

test("a planner that throws is the full plan with the reason planner-error, never a failed collect step", () => {
  const boom = () => {
    throw new Error("a pool had no id\nand a second line");
  };
  const decision = decidePlanSafely({ pools: [] }, boom);
  assert.equal(decision.mode, "full");
  assert.equal(decision.code, "planner-error");
  assert.equal(decision.detail, "the lane planner failed (a pool had no id and a second line)");
  assert.deepEqual(decision, plannerFailure(new Error("a pool had no id\nand a second line")));
  // An exception that is not an Error, and a very long message, are kept short.
  assert.match(plannerFailure("text").detail, /\(text\)$/);
  assert.ok(plannerFailure(new Error("x".repeat(1000))).detail.length < 260);
  // The plan: the lane plan throws, the full plan is made, the decision changes.
  const at = T0 - 3 * H;
  const pools = manyHot(40, at);
  const lanesDecision = { mode: "lanes", code: null, detail: null };
  const made = planSafely(
    pools,
    { decision: lanesDecision, nowMs: T0, updatedAtMs: at },
    (list, options) => {
      if (options.decision.mode === "lanes") throw new Error("boom");
      return planMeasurement(list, options);
    },
  );
  assert.equal(made.plan.mode, "full");
  assert.equal(made.decision.code, "planner-error");
  assert.equal(made.plan.planned, 40);
  // Nothing changes when the planner works.
  const fine = planSafely(pools, { decision: lanesDecision, nowMs: T0, updatedAtMs: at });
  assert.equal(fine.plan.mode, "lanes");
  assert.equal(fine.decision, lanesDecision);
  // A full plan that throws is not caught: there is nothing safer to run.
  assert.throws(
    () =>
      planSafely([], { decision: { mode: "full", code: "forced" } }, () => {
        throw new Error("full");
      }),
    /full/,
  );
});

test("a run whose lane planner throws publishes with the full plan and says so loudly", async () => {
  for (const options of [
    {
      decidePlan: () => {
        throw new Error("decision failed");
      },
    },
    {
      makePlan: (pools, planOptions) => {
        if (planOptions.decision.mode === "lanes") throw new Error("plan failed");
        return planMeasurement(pools, planOptions);
      },
    },
  ]) {
    const run = await outageRun({ runOptions: options });
    try {
      const { result } = run;
      assert.equal(result.ok, true, result.quality.failures.join("; "));
      const { plan } = result.status.counts;
      assert.equal(plan.mode, "full");
      assert.equal(plan.reason, "planner-error");
      assert.equal(plan.fellBack, true);
      assert.match(plan.detail, /^the lane planner failed \(/);
      assert.equal(result.status.counts.lanes, null);
      const lines = planNotices(result.status.counts, { GITHUB_ACTIONS: "true" });
      assert.ok(lines.some((line) => line.startsWith("::warning title=Lane plan not used::")));
      assert.ok(lines.some((line) => /the lane planner failed/.test(line)));
    } finally {
      await run.done();
    }
  }
});

test("a status that cannot be described is reported as such, with the numbers the plan holds, and does not fail the run", () => {
  const at = T0 - 3 * H;
  const plan = planLanes(manyHot(5, at), { nowMs: T0, updatedAtMs: at });
  // A burst without the sets planStatus reads: it throws.
  const status = planStatusSafely({
    plan,
    decision: { mode: "lanes", code: null, detail: null },
    burst: {},
  });
  assert.equal(status.plan.mode, "lanes");
  assert.equal(status.plan.batches, plan.batches);
  assert.equal(status.plan.fellBack, false);
  // The message is kept whole (a run of spaces becomes one, a long one is cut).
  assert.match(status.plan.error, /^Cannot read properties of undefined/);
  assert.equal(status.lanes, null);
});

/* ── The GeckoTerminal fallback, in the lane plan ────────────────────────── */

test("in the lane plan the priority list does not rank the GeckoTerminal fallback: pools GeckoTerminal measured last time come first, then the plan's order", async () => {
  const at = T0 - 3 * H;
  const listed = answered(1, { lastAgo: H, at, salt: "fb" });
  const geckoPool = { ...answered(2, { lastAgo: 2 * H, at, salt: "fb" }), via: "geckoterminal" };
  const other = answered(3, { lastAgo: 3 * H, at, salt: "fb" });
  const pools = [listed, other, geckoPool];
  const run = async (plan) => {
    const clock = new FakeClock(T0);
    const fetchImpl = fakeFetch(clock, (call) =>
      call.url.includes("dexscreener.com")
        ? { body: { pairs: null } }
        : { body: { data: [] } },
    );
    const client = createHttpClient({
      fetchImpl,
      now: clock.now,
      sleep: clock.sleep,
      userAgent: "Test/1 (+https://github.com/example/repo)",
    });
    await runBurst({ client, plan, now: clock.now, fallbackRequests: 1 });
    const call = fetchImpl.calls.find((c) => c.url.includes("geckoterminal.com"));
    return /pools\/multi\/([^?]+)/.exec(call.url)[1].split(",");
  };
  // The lane plan, the priority list naming `listed`: the list is counted, never
  // used to rank, so the GeckoTerminal pool is first and the plan's order follows.
  const lanes = planLanes(pools, {
    nowMs: T0,
    updatedAtMs: at,
    priorityKeys: new Set([keyOf(listed)]),
  });
  assert.equal(lanes.plannedProtected, 1, "the list is counted");
  const inLanes = await run(lanes);
  assert.equal(inLanes[0], geckoPool.id, "the pool GeckoTerminal measured comes first");
  assert.equal(inLanes.length, 3);
  assert.deepEqual(
    inLanes.slice(1).sort(),
    [listed.id, other.id].sort(),
    "the others follow in the plan's own order",
  );
  // The same pools and the same list in the full plan: the listed pool is first.
  const full = planBurst(pools, { protectedKeys: new Set([keyOf(listed)]) });
  const inFull = await run(full);
  assert.equal(inFull[0], listed.id, "the full plan ranks the priority list first");
  assert.equal(inFull[1], geckoPool.id);
  // The ordering function itself, for a lane plan's empty list.
  const pairs = [listed, geckoPool, other].map((pool) => ({ chain: chain("base"), pool }));
  const noList = fallbackBatches(pairs, 1, { protectedKeys: new Set() });
  assert.equal(noList[0].pools[0].id, geckoPool.id);
  const withList = fallbackBatches(pairs, 1, { protectedKeys: new Set([keyOf(listed)]) });
  assert.equal(withList[0].pools[0].id, listed.id);
});

/* ── The notes and the constants ─────────────────────────────────────────── */

test("the DEX Screener note says when the plan reached its ceiling, and says nothing of it otherwise", () => {
  const plain = lanePlanNote({ asked: 4492, known: 8956, ceilingBound: false, maxBatches: 220 });
  assert.match(plain, /This snapshot asked about 4,492 of the 8,956 pools the collector knows/);
  assert.doesNotMatch(plain, /limit of/);
  const bound = lanePlanNote({ asked: 6600, known: 9500, ceilingBound: true, maxBatches: 220 });
  assert.match(
    bound,
    /This plan reached its limit of 220 batches a run, so some of the pools that were due were left for their next turn\./,
  );
  // It comes after the periods and before the closing sentence.
  assert.match(bound, /every 12 hours\)\. This plan reached[^]*A pool that was not asked is unchecked in this snapshot, not zero\.$/);
  // The full plan has no such note at all.
  assert.equal(lanePlanNote(null), "");
  // A caller that does not say (the earlier shape) gets the plain note.
  assert.doesNotMatch(lanePlanNote({ asked: 1, known: 2 }), /limit of/);
});

test("a plan that sent more batches than its limit (the pools that answer and the new pools are never cut, and discovery adds new ones) says how many it sent, in the note and in the run's notice", () => {
  // Within the limit: the wording is the one above, with no number of batches.
  const within = lanePlanNote({ asked: 6600, known: 9500, ceilingBound: true, maxBatches: 220, batches: 220 });
  assert.match(
    within,
    /This plan reached its limit of 220 batches a run, so some of the pools that were due were left for their next turn\./,
  );
  assert.doesNotMatch(within, /and sent/);
  // Over it (a heavy run saw 236): the note says so, and still says what was left out.
  const over = lanePlanNote({ asked: 6550, known: 9500, ceilingBound: true, maxBatches: 220, batches: 236 });
  assert.match(
    over,
    /This plan reached its limit of 220 batches a run and sent 236, because the pools that answer and the new pools are never left out, so some of the pools that were due were left for their next turn\./,
  );
  // A plan that did not reach its limit says nothing of it, whatever the numbers.
  assert.doesNotMatch(
    lanePlanNote({ asked: 10, known: 20, ceilingBound: false, maxBatches: 220, batches: 236 }),
    /limit of|and sent/,
  );
  // The notice of the run, with pools cut and without.
  const counts = (batches, droppedForCap) => ({
    plannedPools: 6550,
    droppedForCap,
    plan: {
      mode: "lanes",
      reason: null,
      fellBack: false,
      batches,
      maxBatches: 220,
      ceilingBound: true,
      trimmed: { warm: 345, cool: 1000, cold: 790 },
    },
  });
  const cut = planNotices(counts(236, 2135), {}).at(-1);
  assert.match(cut, /^NOTE: The lane plan reached its ceiling of 220 DEX Screener batches and sent 236, because the pools that answer and the new pools are never cut\. 2135 pools that were due were left out/);
  const exact = planNotices(counts(220, 2135), {}).at(-1);
  assert.match(exact, /^NOTE: The lane plan reached its ceiling of 220 DEX Screener batches\. 2135 pools that were due were left out/);
  // Nothing was cut: HOT and NEW alone need more; the sentence already says so.
  const alone = planNotices(counts(236, 0), {}).at(-1);
  assert.match(alone, /^NOTE: The lane plan reached its ceiling of 220 DEX Screener batches\. The pools that answer and the new pools alone need more than that/);
});

test("the guard's constants are the ones of the design, and the gate's own share is the guard's", () => {
  assert.equal(config.LANE_GUARD_MIN_HOT_POOLS, 50);
  assert.equal(config.MIN_REQUESTED_SHARE, 0.8);
  // Five failed batches in a row stop a network: the guard judges exactly those.
  assert.equal(config.MAX_CONSECUTIVE_FAILURES, 5);
});
