import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { CHAINS_URL, FRONTIER_URL, REGISTRY_URL } from "../server/model.mjs";
import { isSnapshot } from "../src/model.ts";
import {
  GT_FALLBACK_MAX_REQUESTS,
  MAX_DISCOVERED_MEASURED,
  MAX_MEASURED_POOLS,
  MAX_PRIORITY_POOLS,
} from "../collector/config.mjs";
import {
  buildPriority,
  hookOwners,
  main as exportPriority,
  priorityFileText,
  RECENT_PLATFORM_MS,
  SHARED_TOP,
} from "../collector/export-priority.mjs";
import {
  fallbackBatches,
  measurementChains,
  planBurst,
} from "../collector/measure.mjs";
import { FIXTURES, priorityPlan, runCollector } from "../collector/run.mjs";
import {
  isPlainPoolName,
  isPriorityFile,
  isPriorityPool,
  poolKey,
  poolsJson,
  priorityJson,
  readState,
} from "../collector/state.mjs";
import {
  address,
  blockNetwork,
  dexRow,
  FakeClock,
  fakeFetch,
  poolId,
  statePool,
} from "../collector/testing.mjs";

blockNetwork();

const ROOT = new URL("..", import.meta.url);
const EXPORTED = "2026-10-31T18:32:52.350Z";

const record = (seed, overrides = {}) => ({
  id: poolId(seed),
  chain: "base",
  hookAddress: address(7000 + (seed % 3)),
  tokens: [address(8000 + seed * 2), address(8001 + seed * 2)].sort(),
  name: `AAA${seed} / WETH`,
  createdAt: "2026-10-30T10:00:00.000Z",
  projectId: "pons",
  ...overrides,
});
const file = (pools, extra = {}) => ({
  schemaVersion: 1,
  exportedAt: EXPORTED,
  selection: {
    snapshotGeneratedAt: EXPORTED,
    rule: "A rule.",
    counts: { pools: pools.length },
  },
  pools,
  ...extra,
});

/* ── What the file may hold ─────────────────────────────────────────────── */

test("a priority record is a plain pool identity: these fields, in this shape, and nothing else", () => {
  assert.equal(isPriorityPool(record(1)), true);
  assert.equal(isPriorityPool(record(2, { createdAt: null })), true);
  const bad = {
    "an extra url": { ...record(1), url: "https://dexscreener.com/base/x" },
    "an extra sourceUrl": { ...record(1), sourceUrl: "https://x.test/?key=1" },
    "a figure": { ...record(1), volumeUsd: { h24: 5 } },
    "a provider label": { ...record(1), metricProvider: "dexscreener" },
    "a source": { ...record(1), source: "census" },
    "a dynamic-fee flag": { ...record(1), dynamicFee: true },
    "a missing project": (({ projectId, ...rest }) => rest)(record(1)),
    "a missing name": (({ name, ...rest }) => rest)(record(1)),
    "a pool id in capitals": { ...record(1), id: record(1).id.toUpperCase() },
    "a short pool id": { ...record(1), id: address(3) },
    "a hook in capitals": {
      ...record(1),
      hookAddress: `0x${"AB".repeat(20)}`,
    },
    "no hook": { ...record(1), hookAddress: `0x${"0".repeat(40)}` },
    "one currency": { ...record(1), tokens: [address(1)] },
    "the same currency twice": {
      ...record(1),
      tokens: [address(1), address(1)],
    },
    "a symbol for a currency": { ...record(1), tokens: ["ETH", address(1)] },
    "a name with a web address": { ...record(1), name: "visit https://x.test" },
    "a name with www": { ...record(1), name: "www.x / ETH" },
    "a name with markup": { ...record(1), name: "<b>A</b> / ETH" },
    "a name with a quote": { ...record(1), name: 'A" / ETH' },
    "a name with a newline": { ...record(1), name: "A\n/ ETH" },
    "an empty name": { ...record(1), name: "" },
    "a very long name": { ...record(1), name: "A".repeat(101) },
    "a time that is no time": { ...record(1), createdAt: "yesterday" },
    "a project that is a sentence": { ...record(1), projectId: "Some Project" },
    "an empty project": { ...record(1), projectId: "" },
    "a network that is no slug": { ...record(1), chain: "Base Chain" },
    "an array": [record(1)],
    null: null,
  };
  for (const [what, row] of Object.entries(bad))
    assert.equal(isPriorityPool(row), false, what);
  assert.equal(isPlainPoolName("PEPE / WETH"), true);
  assert.equal(isPlainPoolName("日本 / ETH"), true);
  assert.equal(isPlainPoolName(5), false);
});

test("a priority file has the pools, when they were exported and how they were chosen, and no more than the allowed number", () => {
  const pools = [record(1), record(2)];
  assert.equal(isPriorityFile(file(pools)), true);
  const bad = {
    "another schema": file(pools, { schemaVersion: 2 }),
    "no export time": file(pools, { exportedAt: "later" }),
    "an extra field": file(pools, { secrets: "x" }),
    "no selection": (({ selection, ...rest }) => rest)(file(pools)),
    "an extra selection field": file(pools, {
      selection: { ...file(pools).selection, url: "https://x.test" },
    }),
    "a count that is a word": file(pools, {
      selection: {
        ...file(pools).selection,
        counts: { pools: "two" },
      },
    }),
    "a repeated pool": file([record(1), record(1)]),
    "a row that is not a pool": file([record(1), { ...record(2), url: "x" }]),
    "too many pools": file(
      Array.from({ length: MAX_PRIORITY_POOLS + 1 }, (_, i) => record(i + 1)),
    ),
  };
  for (const [what, value] of Object.entries(bad))
    assert.equal(isPriorityFile(value), false, what);
  // The same pool id on two networks is two pools.
  assert.equal(
    isPriorityFile(file([record(1), record(1, { chain: "ethereum" })])),
    true,
  );
});

test("the state reads the priority list when there is one, and refuses one that is not valid", async () => {
  const dir = await mkdtemp(join(tmpdir(), "collector-priority-"));
  try {
    await mkdir(join(dir, "state"), { recursive: true });
    const state = join(dir, "state");
    await writeFile(join(state, "pools.json"), poolsJson(null, []));
    assert.equal((await readState(state)).priority, null);
    const pools = [record(1), record(2)];
    await writeFile(
      join(state, "priority.json"),
      priorityJson(
        { exportedAt: EXPORTED, selection: file(pools).selection },
        pools,
      ),
    );
    const read = await readState(state);
    assert.equal(read.priority.exportedAt, EXPORTED);
    assert.deepEqual(
      read.priority.pools.map((pool) => pool.id).sort(),
      pools.map((pool) => pool.id).sort(),
    );
    await writeFile(
      join(state, "priority.json"),
      JSON.stringify(file([{ ...record(1), url: "https://x.test" }])),
    );
    await assert.rejects(readState(state), /priority\.json has an unexpected/);
    await writeFile(join(state, "priority.json"), "not json");
    await assert.rejects(readState(state), /priority\.json is not valid JSON/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** Whether `text` is the priority file the state writes for `value`, line ends
 * aside: a Windows checkout of the repository has CRLF, the collector writes LF. */
const writtenLikeTheState = (text, value) =>
  text.replace(/\r\n/g, "\n") ===
  priorityJson(
    { exportedAt: value.exportedAt, selection: value.selection },
    value.pools,
  );

test("a priority list with CRLF line ends, as a Windows checkout has it, is read and is the same file", async () => {
  const pools = [record(1), record(2)];
  const header = { exportedAt: EXPORTED, selection: file(pools).selection };
  const lf = priorityJson(header, pools);
  assert.ok(!lf.includes("\r"));
  const crlf = lf.replace(/\n/g, "\r\n");
  assert.ok(crlf.includes("\r\n"));
  assert.ok(writtenLikeTheState(crlf, { ...header, pools }));
  assert.ok(writtenLikeTheState(lf, { ...header, pools }));
  // Another layout of the same records is not the file the state writes.
  assert.equal(
    writtenLikeTheState(JSON.stringify({ ...header, pools }, null, 2), {
      ...header,
      pools,
    }),
    false,
  );
  const dir = await mkdtemp(join(tmpdir(), "collector-priority-"));
  try {
    await mkdir(join(dir, "state"), { recursive: true });
    await writeFile(join(dir, "state", "pools.json"), poolsJson(null, []));
    await writeFile(join(dir, "state", "priority.json"), crlf);
    const read = await readState(join(dir, "state"));
    assert.equal(read.priority.pools.length, 2);
    assert.equal(read.priority.exportedAt, EXPORTED);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the priority list committed in state/ is valid, holds identities only and is within its limit", async (t) => {
  const path = new URL("state/priority.json", ROOT);
  if (!existsSync(path)) return t.skip("state/priority.json is not here");
  const text = await readFile(path, "utf8");
  const value = JSON.parse(text);
  assert.equal(isPriorityFile(value), true);
  assert.ok(value.pools.length > 0 && value.pools.length <= MAX_PRIORITY_POOLS);
  // The checks above are the whole of it: no other field, no web address.
  assert.doesNotMatch(text, /https?:\/\//i);
  assert.doesNotMatch(text, /api[-_ ]?key|secret|token=/i);
  assert.ok(
    value.pools.every((pool) => Object.keys(pool).length === 7),
    "seven fields in every record",
  );
  // Written the way the state is, one record per line. A checkout may end its
  // lines with CRLF (git on Windows does, with core.autocrlf), so compare the
  // text and not its line ends.
  assert.ok(
    writtenLikeTheState(text, value),
    "state/priority.json is not written one record per line the way the state is",
  );
  const known = new Set(measurementChains().map((chain) => chain.chain));
  const unpriced = value.pools.filter((pool) => !known.has(pool.chain));
  assert.equal(
    unpriced.length,
    0,
    `networks the collector does not price: ${[...new Set(unpriced.map((p) => p.chain))]}`,
  );
});

/* ── Choosing the pools ─────────────────────────────────────────────────── */

async function offlineSnapshot() {
  const dir = await mkdtemp(join(tmpdir(), "collector-priority-"));
  try {
    const result = await runCollector({
      offline: true,
      stateDir: join(FIXTURES, "state"),
      outDir: dir,
      stateOutDir: join(dir, "state"),
      minCurrent: 20,
    });
    assert.equal(result.ok, true);
    return JSON.parse(JSON.stringify(result.snapshot));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const platformRegistry = (chain, hooks, id = "alpha-pad") => [
  {
    id,
    paths: [
      {
        attribution: "platform-hook",
        chain,
        hooks: hooks.map((hook) => ({ address: hook })),
      },
      {
        attribution: "shared-protocol",
        chain,
        hooks: [{ address: address(1) }],
      },
    ],
  },
];

test("the list is made of the exact hooks of reviewed platforms and of named projects, with the age limits stated", async () => {
  const snapshot = await offlineSnapshot();
  assert.equal(isSnapshot(snapshot), true);
  const at = Date.parse(snapshot.generatedAt);
  // A hook of the fixture that belongs to no named project: a platform's own.
  const anonymous = snapshot.pools.filter((pool) =>
    snapshot.projects.some(
      (project) => /^hook-/.test(project.id) && project.id === pool.projectId,
    ),
  );
  const platformHook = anonymous[0].hookAddress;
  const onThatHook = snapshot.pools.filter(
    (pool) => pool.hookAddress === platformHook,
  );
  // Age: one pool measured two days earlier is no longer "probably trading".
  onThatHook[0].metricUpdatedAt = new Date(
    at - RECENT_PLATFORM_MS - 1000,
  ).toISOString();
  // A pool with no figure at all has no measurement.
  if (onThatHook[1]) {
    onThatHook[1].liquidityUsd = null;
    onThatHook[1].volumeUsd = { h1: null, h6: null, h24: null };
  }
  const registry = platformRegistry(anonymous[0].chain, [platformHook]);
  const built = buildPriority(snapshot, { exportedAt: EXPORTED, registry });
  const ids = new Set(built.pools.map((pool) => pool.id));
  assert.equal(ids.has(onThatHook[0].address), false, "measured too long ago");
  if (onThatHook[1])
    assert.equal(ids.has(onThatHook[1].address), false, "never measured");
  for (const pool of onThatHook.slice(2)) {
    assert.equal(ids.has(pool.address), true);
    assert.equal(
      built.pools.find((row) => row.id === pool.address).projectId,
      "alpha-pad",
    );
  }
  // Named projects bring their pools with them: Angstrom's two, none renamed.
  const angstrom = snapshot.pools.filter((p) => p.projectId === "angstrom");
  assert.ok(angstrom.length >= 2);
  for (const pool of angstrom) assert.equal(ids.has(pool.address), true);
  // Every record is a valid one, and the file holds nothing else.
  assert.ok(built.pools.every(isPriorityPool));
  assert.equal(isPriorityFile(built.file), true);
  assert.equal(built.file.selection.snapshotGeneratedAt, snapshot.generatedAt);
  assert.match(built.file.selection.rule, /exact hooks/);
});

test("the four shared protocols give their top fifty pools by 24h volume, measured within a week, and the others give all within a day", async () => {
  const snapshot = await offlineSnapshot();
  const at = Date.parse(snapshot.generatedAt);
  const doppler = snapshot.pools.filter((pool) => pool.projectId === "doppler");
  assert.ok(doppler.length >= 10);
  // Give them known volumes and ages, and more pools than the cap by copying.
  const extra = Array.from({ length: SHARED_TOP + 20 }, (_, i) => ({
    ...doppler[0],
    id: `base:${poolId(500 + i)}`,
    address: poolId(500 + i),
    tokens: [address(9000 + i * 2), address(9001 + i * 2)].sort(),
    volumeUsd: { h1: 0, h6: 0, h24: 1000 + i },
    metricUpdatedAt: new Date(at - 3 * 24 * 3600 * 1000).toISOString(),
  }));
  extra[0].metricUpdatedAt = new Date(at - 8 * 24 * 3600 * 1000).toISOString();
  extra[0].volumeUsd.h24 = 9e9;
  snapshot.pools.push(...extra);
  const { pools } = buildPriority(snapshot, {
    exportedAt: EXPORTED,
    registry: [],
  });
  const taken = pools.filter((pool) => pool.projectId === "doppler");
  assert.equal(taken.length, SHARED_TOP);
  // The highest volumes among those measured within a week: the one measured
  // eight days earlier is not taken whatever its volume.
  assert.equal(
    taken.some((pool) => pool.id === extra[0].address),
    false,
  );
  assert.equal(
    taken.some((pool) => pool.id === extra.at(-1).address),
    true,
  );
  assert.equal(
    taken.some((pool) => pool.id === extra[1].address),
    false,
    "the lowest of the extra pools is below the fiftieth",
  );
});

test("the list leaks nothing: provider addresses, keys and figures in the snapshot never reach it", async () => {
  const snapshot = await offlineSnapshot();
  for (const pool of snapshot.pools) {
    pool.url = "https://dexscreener.com/x?apikey=SECRETVALUE";
    pool.liquidityNote = "SECRETVALUE";
  }
  for (const project of snapshot.projects)
    for (const deployment of project.deployments)
      deployment.sourceUrl = "https://x.test/?token=SECRETVALUE";
  snapshot.inventory.networks[0].sourceUrl = "https://x.test/?key=SECRETVALUE";
  const built = buildPriority(snapshot, { exportedAt: EXPORTED });
  const text = priorityFileText(built.file);
  assert.ok(built.pools.length > 0);
  assert.doesNotMatch(text, /SECRETVALUE|https?:|apikey/i);
  assert.equal(isPriorityFile(JSON.parse(text)), true);
});

test("a hook that two entities publish is listed under the one that is not a shared protocol", () => {
  const snapshot = {
    projects: [
      {
        id: "flaunch",
        deployments: [{ chain: "base", address: address(42) }],
      },
    ],
  };
  const owners = hookOwners(
    snapshot,
    platformRegistry("base", [address(42)], "ubi-fun"),
  );
  assert.deepEqual([...owners.get(`base:${address(42)}`)].sort(), [
    "flaunch",
    "ubi-fun",
  ]);
  // The unnamed on-chain hook projects own nothing for the list.
  const anonymous = hookOwners(
    {
      projects: [
        {
          id: "hook-abc",
          deployments: [{ chain: "base", address: address(7) }],
        },
      ],
    },
    [],
  );
  assert.equal(anonymous.size, 0);
});

test("the export command writes only the list, reads a saved snapshot, and refuses a remote address", async () => {
  const snapshot = await offlineSnapshot();
  const dir = await mkdtemp(join(tmpdir(), "collector-priority-"));
  const quietly = async (work) => {
    const { log, error } = console;
    console.log = console.error = () => {};
    try {
      return await work();
    } finally {
      console.log = log;
      console.error = error;
    }
  };
  try {
    const saved = join(dir, "snapshot.json.gz");
    await writeFile(saved, gzipSync(JSON.stringify(snapshot)));
    const state = join(dir, "state");
    assert.equal(
      await quietly(() =>
        exportPriority([
          "--from-file",
          saved,
          "--exported-at",
          EXPORTED,
          "--state",
          state,
        ]),
      ),
      0,
    );
    const written = JSON.parse(
      await readFile(join(state, "priority.json"), "utf8"),
    );
    assert.equal(isPriorityFile(written), true);
    assert.equal(written.exportedAt, EXPORTED);
    assert.ok(written.pools.length > 0);
    // Only the one file is written.
    assert.deepEqual((await import("node:fs")).readdirSync(state), [
      "priority.json",
    ]);
    // A remote address, or a time in the future, is refused.
    assert.equal(
      await quietly(() => exportPriority(["--url", "https://example.com"])),
      1,
    );
    assert.equal(
      await quietly(() =>
        exportPriority([
          "--from-file",
          saved,
          "--exported-at",
          "2999-01-01T00:00:00Z",
        ]),
      ),
      2,
    );
    assert.equal(await quietly(() => exportPriority(["--wrong"])), 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ── The plan ───────────────────────────────────────────────────────────── */

const at = (offset) =>
  new Date(
    Date.parse("2026-11-01T00:00:00.000Z") + offset * 1000,
  ).toISOString();
const keysOf = (pools) =>
  new Set(pools.map((pool) => poolKey(pool.chain, pool.id)));
const plannedIds = (plan) =>
  new Set(
    plan.networks.flatMap((network) => network.pools.map((pool) => pool.id)),
  );

test("priority pools are planned before every other pool, whatever their age, and take the places of the pools that went longest unanswered", () => {
  // 100 seeded pools, the 20 oldest-seen of them on the priority list; room for 80.
  const seeded = Array.from({ length: 100 }, (_, i) =>
    statePool(i + 1, { lastSeen: at(1000 - i) }),
  );
  const guarded = seeded.slice(80);
  const plan = planBurst(seeded, {
    maxPools: 80,
    protectedKeys: keysOf(guarded),
  });
  assert.equal(plan.planned, 80);
  assert.equal(plan.plannedProtected, 20);
  const planned = plannedIds(plan);
  for (const pool of guarded) assert.equal(planned.has(pool.id), true);
  // The 60 most recently seen of the others fill the rest.
  for (const pool of seeded.slice(0, 60))
    assert.equal(planned.has(pool.id), true);
  for (const pool of seeded.slice(60, 80))
    assert.equal(planned.has(pool.id), false);
  assert.equal(plan.protectedKeys.size, 20);
  // Without the list it is the usual order.
  const usual = planBurst(seeded, { maxPools: 80 });
  assert.equal(usual.plannedProtected, 0);
  assert.deepEqual(plannedIds(usual), keysOfIds(seeded.slice(0, 80)));
});
const keysOfIds = (pools) => new Set(pools.map((pool) => pool.id));

test("the list takes places inside the seeded allowance, so a longer list never squeezes discovery out and the plan is never larger", () => {
  const seeded = Array.from({ length: MAX_MEASURED_POOLS }, (_, i) =>
    statePool(10000 + i, { lastSeen: at(0) }),
  );
  const listed = Array.from({ length: 700 }, (_, i) =>
    statePool(60000 + i, { lastSeen: at(-99999) }),
  );
  const discovered = Array.from({ length: 300 }, (_, i) =>
    statePool(80000 + i, { source: "v4.xyz", lastSeen: at(500 + i) }),
  );
  const plan = planBurst([...seeded, ...listed, ...discovered], {
    maxSeeded: MAX_MEASURED_POOLS,
    protectedKeys: keysOf(listed),
  });
  assert.equal(plan.plannedProtected, 700);
  assert.equal(plan.plannedDiscovered, 300);
  assert.equal(plan.planned, MAX_MEASURED_POOLS + 300);
  assert.ok(plan.planned <= MAX_MEASURED_POOLS + MAX_DISCOVERED_MEASURED);
  const planned = plannedIds(plan);
  for (const pool of listed) assert.equal(planned.has(pool.id), true);
  for (const pool of discovered) assert.equal(planned.has(pool.id), true);
  // 700 seeded pools left the plan to make room: the ones seen longest ago.
  assert.equal(seeded.filter((pool) => !planned.has(pool.id)).length, 700);
});

test("a listed pool that was found by discovery is planned as a listed pool, once, and a list longer than its limit is cut", () => {
  const found = statePool(1, { source: "v4.xyz", lastSeen: at(-5) });
  const seeded = Array.from({ length: 5 }, (_, i) => statePool(10 + i));
  const plan = planBurst([found, ...seeded], {
    maxPools: 3,
    maxSeeded: 3,
    protectedKeys: keysOf([found]),
  });
  assert.equal(plan.plannedProtected, 1);
  assert.equal(plan.plannedDiscovered, 0);
  assert.equal(plan.planned, 3);
  assert.equal(plannedIds(plan).has(found.id), true);
  const many = Array.from({ length: MAX_PRIORITY_POOLS + 50 }, (_, i) =>
    statePool(100000 + i),
  );
  const cut = planBurst(many, {
    maxPools: many.length,
    protectedKeys: keysOf(many),
  });
  assert.equal(cut.plannedProtected, MAX_PRIORITY_POOLS);
  assert.equal(cut.planned, many.length);
  // The same list and the same pools always give the same plan.
  const again = planBurst(many, {
    maxPools: many.length,
    protectedKeys: keysOf(many),
  });
  assert.deepEqual(
    again.networks.map((n) => n.pools.map((p) => p.id)),
    cut.networks.map((n) => n.pools.map((p) => p.id)),
  );
});

test("a listed pool on a network the providers do not price is not requested, and is counted like any other", () => {
  const nowhere = statePool(1, { chain: "nowhere" });
  const plan = planBurst([nowhere, statePool(2)], {
    protectedKeys: keysOf([nowhere]),
  });
  assert.equal(plan.plannedProtected, 0);
  assert.equal(plan.unsupported, 1);
  assert.equal(plan.planned, 1);
});

/* ── The GeckoTerminal fallback ─────────────────────────────────────────── */

const chainOf = (slug) => measurementChains().find((c) => c.chain === slug);
const rowsOf = (slug, pools) =>
  pools.map((pool) => ({ chain: chainOf(slug), pool }));

test("the fallback is six requests and asks for the listed pools first, the ones GeckoTerminal measured last time before the rest", () => {
  assert.equal(GT_FALLBACK_MAX_REQUESTS, 6);
  const plain = Array.from({ length: 70 }, (_, i) =>
    statePool(i + 1, { chain: "base" }),
  );
  const hinted = statePool(200, { chain: "base", via: "geckoterminal" });
  const listed = statePool(201, { chain: "base" });
  const listedHinted = statePool(202, { chain: "base", via: "geckoterminal" });
  const batches = fallbackBatches(
    rowsOf("base", [...plain, hinted, listed, listedHinted]),
    1,
    { protectedKeys: keysOf([listed, listedHinted]) },
  );
  assert.equal(batches.length, 1);
  assert.deepEqual(
    batches[0].pools.slice(0, 4).map((pool) => pool.id),
    [listedHinted.id, listed.id, hinted.id, plain[0].id],
  );
  assert.equal(batches[0].pools.length, 30);
});

test("with only a few requests the fallback does not spend one on a handful of low-ranked pools of another network", () => {
  const listedBase = Array.from({ length: 31 }, (_, i) =>
    statePool(i + 1, { chain: "base" }),
  );
  const listedEth = statePool(100, { chain: "ethereum" });
  const otherUnichain = statePool(300, { chain: "unichain" });
  const rows = [
    ...rowsOf("base", listedBase),
    ...rowsOf("ethereum", [listedEth]),
    ...rowsOf("unichain", [otherUnichain]),
  ];
  const keys = keysOf([...listedBase, listedEth]);
  const two = fallbackBatches(rows, 2, { protectedKeys: keys });
  // One full Base batch and one with the last Base pool; Ethereum's listed pool
  // and Unichain's other one do not fit: Base's open batch took the 31st pool.
  assert.deepEqual(
    two.map((batch) => [batch.chain.chain, batch.pools.length]),
    [
      ["base", 30],
      ["base", 1],
    ],
  );
  const three = fallbackBatches(rows, 3, { protectedKeys: keys });
  assert.deepEqual(
    three.map((batch) => [batch.chain.chain, batch.pools.length]),
    [
      ["base", 30],
      ["base", 1],
      ["ethereum", 1],
    ],
  );
  const four = fallbackBatches(rows, 4, { protectedKeys: keys });
  assert.equal(four.at(-1).chain.chain, "unichain");
  assert.equal(fallbackBatches(rows, 0).length, 0);
});

/* ── A run ──────────────────────────────────────────────────────────────── */

const CHAIN_DATA = { base: { chainId: 8453 } };
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

async function runWithList({ statePools, list, dark = new Set() }) {
  const dir = await mkdtemp(join(tmpdir(), "collector-priority-"));
  const clock = new FakeClock();
  const known = new Map(
    [...statePools, ...list.pools].map((pool) => [pool.id, pool]),
  );
  const answer = (call) => {
    const url = call.url;
    if (url === REGISTRY_URL) return { body: [HOOK_ROW] };
    if (url === CHAINS_URL) return { body: CHAIN_DATA };
    if (url === FRONTIER_URL) return { body: [] };
    if (url.startsWith("https://api.dexscreener.com/latest/dex/pairs/base/")) {
      const ids = url.split("/").pop().split(",");
      const rows = ids
        .filter((id) => !dark.has(id) && known.has(id))
        .map((id) => dexRow(known.get(id)));
      return { body: { pairs: rows.length ? rows : null } };
    }
    return { status: 404, body: {} };
  };
  const fetchImpl = fakeFetch(clock, answer);
  const state = join(dir, "state");
  await mkdir(state, { recursive: true });
  await writeFile(join(state, "pools.json"), poolsJson(null, statePools));
  await writeFile(
    join(state, "priority.json"),
    priorityJson(
      { exportedAt: list.exportedAt, selection: list.selection },
      list.pools,
    ),
  );
  const result = await runCollector({
    stateDir: state,
    outDir: join(dir, "data"),
    stateOutDir: state,
    minCurrent: 5,
    maxDiscovery: 0,
    maxPools: 40,
    fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
    env: { GITHUB_REPOSITORY: "owner/hook-radar" },
  });
  return {
    dir,
    state,
    result,
    fetchImpl,
    done: () => rm(dir, { recursive: true, force: true }),
  };
}

test("a run adds the listed pools the state does not hold, measures them, keeps them in the state, and says how many", async () => {
  const hook = HOOK_ROW.hook.address.toLowerCase();
  const seeded = Array.from({ length: 30 }, (_, i) =>
    statePool(i + 1, { hookAddress: hook, lastSeen: at(1000 - i) }),
  );
  const listed = Array.from({ length: 12 }, (_, i) =>
    record(500 + i, { hookAddress: hook, projectId: "pons" }),
  );
  // Two of the listed pools are already in the state, one of them as a pool that
  // went unanswered the longest.
  listed[0].id = seeded[29].id;
  listed[0].tokens = seeded[29].tokens;
  const list = { ...file(listed), pools: listed };
  const run = await runWithList({ statePools: seeded, list });
  try {
    const { result } = run;
    assert.equal(result.ok, true, result.quality.failures.join("; "));
    const priority = result.status.counts.priorityPools;
    assert.deepEqual(priority, {
      listed: 12,
      addedToState: 11,
      planned: 12,
      measured: 12,
    });
    // The plan holds the 40 pools allowed: the 12 listed, then the others in the
    // usual order; the state now holds the 11 new ones too.
    assert.equal(result.status.counts.plannedPools, 40);
    const next = await readState(run.state);
    assert.equal(next.pools.length, 30 + 11);
    for (const row of listed)
      assert.equal(
        next.pools.some(
          (pool) => pool.id === row.id && pool.source === "census",
        ),
        true,
      );
    // Every listed pool is a measured pool of the snapshot, by its own hook.
    const measured = new Set(result.snapshot.pools.map((pool) => pool.address));
    for (const row of listed) assert.equal(measured.has(row.id), true);
    // A second run knows them: none is added again.
    const again = await runWithList({
      statePools: next.pools,
      list,
    });
    try {
      assert.equal(again.result.status.counts.priorityPools.addedToState, 0);
    } finally {
      await again.done();
    }
  } finally {
    await run.done();
  }
});

test("a listed pool nobody answers for stays on the list and in the plan; it is unresolved, never zero", async () => {
  const hook = HOOK_ROW.hook.address.toLowerCase();
  const seeded = Array.from({ length: 30 }, (_, i) =>
    statePool(i + 1, { hookAddress: hook, lastSeen: at(1000 - i) }),
  );
  const listed = [record(900, { hookAddress: hook })];
  const run = await runWithList({
    statePools: seeded,
    list: { ...file(listed), pools: listed },
    dark: new Set([listed[0].id]),
  });
  try {
    const { result } = run;
    assert.equal(result.ok, true, result.quality.failures.join("; "));
    assert.deepEqual(result.status.counts.priorityPools, {
      listed: 1,
      addedToState: 1,
      planned: 1,
      measured: 0,
    });
    assert.equal(
      result.snapshot.pools.some((pool) => pool.address === listed[0].id),
      false,
    );
  } finally {
    await run.done();
  }
});

test("with no priority list a run is what it was: nothing is added and the counts say so", async () => {
  const dir = await mkdtemp(join(tmpdir(), "collector-priority-"));
  try {
    const result = await runCollector({
      offline: true,
      stateDir: join(FIXTURES, "state"),
      outDir: dir,
      stateOutDir: join(dir, "state"),
      minCurrent: 20,
    });
    assert.deepEqual(result.status.counts.priorityPools, {
      listed: 0,
      addedToState: 0,
      planned: 0,
      measured: 0,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a priority record becomes an ordinary seeded pool record", () => {
  const row = record(1);
  const { fresh, keys } = priorityPlan(
    { exportedAt: EXPORTED, pools: [row] },
    new Set(),
  );
  assert.deepEqual(fresh, [
    {
      id: row.id,
      chain: row.chain,
      hookAddress: row.hookAddress,
      tokens: row.tokens,
      name: row.name,
      createdAt: row.createdAt,
      source: "census",
      firstSeen: EXPORTED,
      lastSeen: EXPORTED,
    },
  ]);
  assert.deepEqual([...keys], [poolKey(row.chain, row.id)]);
  assert.deepEqual(priorityPlan(null, new Set()), {
    keys: new Set(),
    fresh: [],
  });
});
