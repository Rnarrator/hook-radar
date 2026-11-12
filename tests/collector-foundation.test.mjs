import test from "node:test";
import assert from "node:assert/strict";
import {
  cp,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MARKET_CHAINS, METRIC_CHAINS } from "../server/market-chains.mjs";
import { discoverPools, discoveryStats } from "../collector/discover.mjs";
import { createHttpClient } from "../collector/http.mjs";
import { failureReason, planBurst, runBurst } from "../collector/measure.mjs";
import {
  acceptDexScreenerPairs,
  classifyDexScreenerPairs,
} from "../collector/providers/dexscreener.mjs";
import {
  acceptGeckoPools,
  classifyGeckoPools,
} from "../collector/providers/geckoterminal.mjs";
import { frontierFetchJson } from "../collector/providers/frontier.mjs";
import {
  FIXTURES,
  main,
  nextPools,
  parseArguments,
  providerCounts,
  runCollector,
} from "../collector/run.mjs";
import {
  CURSORS_MAX_BYTES,
  cursorsProblem,
  isCursors,
  nextCursors,
  poolsJson,
  readState,
  resolveCursors,
  writeState,
} from "../collector/state.mjs";
import {
  assertTraceAllowed,
  formatTrace,
  parseTraceList,
  traceReport,
  TRACE_MAX_POOLS,
} from "../collector/trace.mjs";
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

// The first-answer stamp, the per-run counts in status.json, the cursors in the
// header of pools.json and the local-only --trace of collector/run.mjs.

const base = MARKET_CHAINS.find((chain) => chain.chain === "base");
const iso = (ms) => new Date(ms).toISOString();
const T0 = Date.parse("2026-11-12T12:00:00.000Z");

async function scratch(prefix = "collector-foundation-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, done: () => rm(dir, { recursive: true, force: true }) };
}

const quietly = async (work) => {
  const { log, error } = console;
  const out = [];
  console.log = (...args) => out.push(args.join(" "));
  console.error = () => {};
  try {
    return { value: await work(), out };
  } finally {
    console.log = log;
    console.error = error;
  }
};

/** Every file under a folder as relative path -> text. */
async function filesUnder(dir, prefix = "") {
  const found = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      Object.assign(found, await filesUnder(path, `${prefix}${entry.name}/`));
    else found[`${prefix}${entry.name}`] = await readFile(path, "utf8");
  }
  return found;
}

/** The overview files carry a publication id: random bytes drawn once per
 * process and a number that counts the publications of that process. It differs
 * between any two runs of the same code, and it is the only thing masked when
 * two runs are compared. */
const masked = (text) =>
  text.replace(/("publication":\{"id":")[0-9a-f]{32}:\d+"/g, '$1<random>:<n>"');

/** One offline replay of the recorded fixtures into a scratch folder. */
async function offlineRun({
  trace = null,
  stateDir = join(FIXTURES, "state"),
} = {}) {
  const { dir, done } = await scratch();
  const result = await runCollector({
    offline: true,
    stateDir,
    outDir: dir,
    stateOutDir: join(dir, "state"),
    minCurrent: 20,
    trace,
    env: {},
  });
  return { dir, done, result };
}

const fixtureState = await readState(join(FIXTURES, "state"));
const keyOf = (pool) => `${pool.chain}:${pool.id}`;

/* ── (a) The first-answer stamp ─────────────────────────────────────────── */

test("a pool added and answered within a day is stamped at its first answer; one never answered is not", () => {
  const added = iso(T0 - 2 * 3600000);
  const answered = statePool(1, {
    source: "v4.xyz",
    firstSeen: added,
    lastSeen: added,
  });
  const silent = statePool(2, {
    source: "v4.xyz",
    firstSeen: added,
    lastSeen: added,
  });
  const discovered = statePool(3, {
    source: "v4.xyz",
    firstSeen: iso(T0 - 300000),
    lastSeen: iso(T0 - 300000),
  });
  const quiet = statePool(4, {
    firstSeen: "2026-11-01T00:00:00.000Z",
    lastSeen: iso(T0 - 3600000),
  });
  const measured = new Map(
    [answered, discovered, quiet].map((pool) => [keyOf(pool), {}]),
  );
  const next = nextPools({
    pools: [answered, silent, quiet],
    found: [discovered],
    measured,
    generatedAtMs: T0,
  });
  const by = Object.fromEntries(next.map((pool) => [pool.id, pool]));
  assert.equal(by[answered.id].lastSeen, iso(T0), "first answer: stamped");
  assert.ok(
    Date.parse(by[answered.id].lastSeen) >
      Date.parse(by[answered.id].firstSeen),
  );
  assert.equal(
    by[discovered.id].lastSeen,
    iso(T0),
    "found by this run's discovery and measured by it: stamped",
  );
  assert.ok(
    Date.parse(by[discovered.id].lastSeen) >
      Date.parse(by[discovered.id].firstSeen),
  );
  assert.equal(
    by[silent.id].lastSeen,
    by[silent.id].firstSeen,
    "never answered: not stamped",
  );
  assert.equal(
    by[quiet.id].lastSeen,
    quiet.lastSeen,
    "answered within the day already: stays quiet",
  );
  // The next run, an hour later, does not move the stamp again.
  const later = nextPools({
    pools: next,
    found: [],
    measured,
    generatedAtMs: T0 + 3600000,
  });
  const byLater = Object.fromEntries(later.map((pool) => [pool.id, pool]));
  assert.equal(byLater[answered.id].lastSeen, iso(T0));
  assert.equal(byLater[discovered.id].lastSeen, iso(T0));
  // ... and a day on it moves as it always did.
  const dayLater = nextPools({
    pools: next,
    found: [],
    measured,
    generatedAtMs: T0 + 25 * 3600000,
  });
  assert.equal(
    dayLater.find((pool) => pool.id === answered.id).lastSeen,
    iso(T0 + 25 * 3600000),
  );
});

/* ── (c) The cursors in the header of pools.json ────────────────────────── */

const withHeader = async (cursorsText) => {
  const { dir, done } = await scratch("collector-cursors-");
  await cp(join(FIXTURES, "state"), dir, { recursive: true });
  const text = poolsJson(null, fixtureState.pools).replace(
    '"cursors":{}',
    cursorsText === undefined ? "" : `"cursors":${cursorsText}`,
  );
  await writeFile(
    join(dir, "pools.json"),
    cursorsText === undefined
      ? text.replace('"updatedAt":null,,', '"updatedAt":null,')
      : text,
  );
  return { dir, done };
};

test("the header of pools.json: today's files have no cursors and read as none; a file without the field is still valid", async () => {
  assert.deepEqual(fixtureState.cursors, {});
  const text = await readFile(join(FIXTURES, "state", "pools.json"), "utf8");
  assert.equal(JSON.parse(text).cursors, undefined);
  const { dir, done } = await withHeader(undefined);
  try {
    assert.equal(
      JSON.parse(await readFile(join(dir, "pools.json"), "utf8")).cursors,
      undefined,
    );
    assert.deepEqual((await readState(dir)).cursors, {});
  } finally {
    await done();
  }
});

test("cursors of the allowed shape are read back as written", async () => {
  const cursors = {
    gt: { robinhood: { p: 12, at: 480123 }, xlayer: { p: 0.5, at: 1 } },
    scan: { base: { block: 123456789, at: 5 } },
  };
  for (const value of [
    {},
    cursors,
    { family: { "chain:1": { note: "a short text", n: 0 } } },
  ]) {
    const { dir, done } = await withHeader(JSON.stringify(value));
    try {
      assert.deepEqual((await readState(dir)).cursors, value);
    } finally {
      await done();
    }
  }
});

test("a malformed cursors header is refused, whatever the malformation", async () => {
  const tooMany = (count) =>
    JSON.stringify({
      gt: Object.fromEntries(
        Array.from({ length: count }, (_, i) => [`c${i}`, { p: i }]),
      ),
    });
  const malformed = {
    "an array": "[]",
    null: "null",
    "a number": "1",
    "a text": '"x"',
    "a family that is a list": '{"gt":[]}',
    "a key that is a list": '{"gt":{"base":[]}}',
    "a negative number": '{"gt":{"base":{"p":-1}}}',
    "a null field": '{"gt":{"base":{"p":null}}}',
    "a boolean field": '{"gt":{"base":{"p":true}}}',
    "a nested field": '{"gt":{"base":{"p":{"q":1}}}}',
    "a text of over 100 characters": JSON.stringify({
      gt: { base: { p: "x".repeat(101) } },
    }),
    "a family name with a space": '{"bad family":{}}',
    "a family name that starts with an underscore":
      '{"__proto__":{"base":{"p":1}}}',
    "a key with a slash": '{"gt":{"a/b":{"p":1}}}',
    "a field name with a hyphen": '{"gt":{"base":{"p-q":1}}}',
    "more than 64 keys": tooMany(65),
    "more than 8 KB": JSON.stringify({
      a: Object.fromEntries(
        Array.from({ length: 64 }, (_, i) => [
          `k${i}`,
          { t: "y".repeat(100), u: "y".repeat(60) },
        ]),
      ),
    }),
  };
  assert.ok(malformed["more than 8 KB"].length > CURSORS_MAX_BYTES);
  for (const [what, text] of Object.entries(malformed)) {
    const { dir, done } = await withHeader(text);
    try {
      await assert.rejects(readState(dir), /cursors/, what);
    } finally {
      await done();
    }
  }
  assert.equal(isCursors({}), true);
  assert.equal(isCursors(undefined), false);
});

test("pools.json is written with its cursors in the header, keys in order, and a rewrite that changes nothing changes no byte", async () => {
  const text = poolsJson("2026-11-12T00:00:00.000Z", fixtureState.pools);
  assert.ok(
    text.startsWith(
      '{"schemaVersion":1,"updatedAt":"2026-11-12T00:00:00.000Z","cursors":{},"pools":[\n',
    ),
  );
  const a = {
    gt: { xlayer: { p: 1, at: 2 }, base: { at: 4, p: 3 } },
    scan: {},
  };
  const b = {
    scan: {},
    gt: { base: { p: 3, at: 4 }, xlayer: { at: 2, p: 1 } },
  };
  const sorted = poolsJson(null, fixtureState.pools, a);
  assert.equal(sorted, poolsJson(null, fixtureState.pools, b));
  assert.ok(
    sorted.startsWith(
      '{"schemaVersion":1,"updatedAt":null,"cursors":{"gt":{"base":{"at":4,"p":3},"xlayer":{"at":2,"p":1}},"scan":{}},"pools":[\n',
    ),
  );
  assert.deepEqual(JSON.parse(sorted).pools, fixtureState.pools);
});

test("writeState carries the cursors into the file, and refuses a shape readState would refuse before it writes anything", async () => {
  const { dir, done } = await scratch("collector-cursors-write-");
  try {
    const cursors = { gt: { base: { p: 7, at: 9 } } };
    // readState's `daily` is { records, note }; writeState takes the records (or
    // nothing), so the 7D and 30D file is left alone here.
    const { daily: _daily, ...withoutDaily } = fixtureState;
    const state = { ...withoutDaily, updatedAt: "2026-11-12T00:00:00.000Z" };
    await writeState(dir, { ...state, cursors });
    assert.deepEqual((await readState(dir)).cursors, cursors);
    // Without cursors the header says so.
    await writeState(dir, state);
    assert.deepEqual((await readState(dir)).cursors, {});
    const before = await readFile(join(dir, "pools.json"), "utf8");
    await assert.rejects(
      writeState(dir, { ...state, cursors: { gt: [] } }),
      /cursors/,
    );
    assert.equal(await readFile(join(dir, "pools.json"), "utf8"), before);
  } finally {
    await done();
  }
});

test("a run writes the cursors it read back into the header, and no other part of the state changes because of them", async () => {
  const cursors = {
    gt: { base: { p: 3, at: 11 } },
    scan: { base: { block: 99, at: 1 } },
  };
  const { dir: stateDir, done: doneState } = await withHeader(
    JSON.stringify(cursors),
  );
  const plain = await offlineRun();
  const kept = await offlineRun({ stateDir });
  try {
    assert.equal(kept.result.ok, true, kept.result.quality.failures.join("; "));
    const header = JSON.parse(
      await readFile(join(kept.dir, "state", "pools.json"), "utf8"),
    );
    assert.deepEqual(header.cursors, cursors);
    const without = JSON.parse(
      await readFile(join(plain.dir, "state", "pools.json"), "utf8"),
    );
    assert.deepEqual(without.cursors, {});
    assert.deepEqual(header.pools, without.pools);
    assert.equal(
      await readFile(join(kept.dir, "snapshot.json"), "utf8"),
      await readFile(join(plain.dir, "snapshot.json"), "utf8"),
    );
  } finally {
    await Promise.all([doneState(), plain.done(), kept.done()]);
  }
});

test("the cursors cap is bytes of UTF-8 as written to the file, not characters", async () => {
  // 64 keys of a text of 40 characters of 3 bytes each: under 8,192 characters,
  // over 8,192 bytes.
  const wide = {
    a: Object.fromEntries(
      Array.from({ length: 64 }, (_, i) => [
        `k${String(i).padStart(2, "0")}`,
        { t: "中".repeat(40) },
      ]),
    ),
  };
  const text = JSON.stringify(wide);
  assert.ok(text.length < CURSORS_MAX_BYTES, `${text.length} characters`);
  assert.ok(Buffer.byteLength(text) > CURSORS_MAX_BYTES, "and more bytes");
  assert.equal(isCursors(wide), false);
  assert.equal(cursorsProblem(wide), "too-big");
  const { dir, done } = await withHeader(text);
  try {
    await assert.rejects(readState(dir), /cursors/);
  } finally {
    await done();
  }
  // The same count of ASCII characters is within the cap.
  const narrow = JSON.parse(text.replaceAll("中", "x"));
  assert.equal(isCursors(narrow), true);
});

test("cursorsProblem names why cursors are refused in one short word, and an object without a prototype is as good as a plain one", () => {
  const cases = [
    [{}, null],
    [{ gt: { base: { p: 1 } } }, null],
    [Object.assign(Object.create(null), { gt: { base: { p: 1 } } }), null],
    [{ gt: Object.assign(Object.create(null), { base: { p: 1 } }) }, null],
    [null, "shape"],
    [[], "shape"],
    [undefined, "shape"],
    ["x", "shape"],
    [new Map(), "shape"],
    [{ gt: [] }, "shape"],
    [{ gt: { base: { p: -1 } } }, "shape"],
    [{ gt: { base: { p: Number.NaN } } }, "shape"],
    [{ gt: { base: { p: Infinity } } }, "shape"],
    [{ gt: { base: { p: "x".repeat(101) } } }, "shape"],
    [{ Gt: { base: { p: 1 } } }, "shape"],
    [
      Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`f${i}`, {}])),
      "too-many-families",
    ],
    [
      { gt: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, {}])) },
      "too-many-keys",
    ],
    [
      {
        gt: {
          base: Object.fromEntries(
            Array.from({ length: 17 }, (_, i) => [`f${i}`, i]),
          ),
        },
      },
      "too-many-fields",
    ],
  ];
  for (const [value, problem] of cases)
    assert.equal(cursorsProblem(value), problem, String(JSON.stringify(value)).slice(0, 60));
  for (const [value, problem] of cases)
    assert.equal(isCursors(value), problem === null);
  // The reasons are words of a fixed set: nothing the proposal said is echoed.
  assert.match(
    cursorsProblem({ "secret key with spaces": {} }),
    /^[a-z-]+$/,
  );
});

test("a step's cursors are written when they have the allowed shape, in order; otherwise the cursors that were read are kept and the reason is given", () => {
  const kept = { gt: { base: { p: 3, at: 11 } } };
  const good = { scan: { base: { block: 7, at: 2 } }, gt: { base: { p: 4, at: 12 } } };
  const accepted = resolveCursors(good, kept);
  assert.equal(accepted.refused, null);
  assert.deepEqual(accepted.cursors, good);
  assert.deepEqual(Object.keys(accepted.cursors), ["gt", "scan"], "keys in order");
  const bad = [
    [{ gt: [] }, "shape"],
    [null, "shape"],
    [{ gt: { base: { p: -1 } } }, "shape"],
    [{ gt: { base: { p: "x".repeat(101) } } }, "shape"],
    [{ gt: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, {}])) }, "too-many-keys"],
  ];
  for (const [value, reason] of bad) {
    const refused = resolveCursors(value, kept);
    assert.deepEqual(refused, { cursors: kept, refused: reason });
    assert.equal(refused.cursors, kept, "the very cursors that were read");
  }
  // A value that cannot even be inspected is refused, not thrown.
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.deepEqual(resolveCursors(revoked.proxy, kept), {
    cursors: kept,
    refused: "unreadable",
  });
  // A step is a function of a copy: it cannot change what was read, it may
  // throw, and what it returns goes the same way.
  const same = nextCursors(kept);
  assert.deepEqual(same, { cursors: kept, refused: null });
  const moved = nextCursors(kept, (cursors) => {
    cursors.gt.base.p = 5;
    return cursors;
  });
  assert.deepEqual(moved.cursors, { gt: { base: { p: 5, at: 11 } } });
  assert.deepEqual(kept, { gt: { base: { p: 3, at: 11 } } }, "the original");
  assert.deepEqual(
    nextCursors(kept, () => {
      throw new Error("a step failed");
    }),
    { cursors: kept, refused: "threw" },
  );
  assert.deepEqual(nextCursors(kept, () => ({ gt: [] })), {
    cursors: kept,
    refused: "shape",
  });
});

test("a step's bad cursors do not fail a run that passed its gate: the data is published, the header keeps what was read and status.json says why", async () => {
  const kept = { gt: { base: { p: 3, at: 11 } } };
  const { dir: stateDir, done: doneState } = await withHeader(
    JSON.stringify(kept),
  );
  const plain = await offlineRun({ stateDir });
  const runs = {};
  try {
    const bad = {
      "of the wrong shape": [() => ({ gt: [] }), "shape"],
      "that is not an object": [() => null, "shape"],
      "too big": [
        () => ({
          a: Object.fromEntries(
            Array.from({ length: 64 }, (_, i) => [
              `k${i}`,
              { t: "y".repeat(100), u: "y".repeat(60) },
            ]),
          ),
        }),
        "too-big",
      ],
      "from a step that throws": [
        () => {
          throw new Error("a step failed");
        },
        "threw",
      ],
    };
    const plainStatus = JSON.parse(
      await readFile(join(plain.dir, "status.json"), "utf8"),
    );
    assert.deepEqual(plainStatus.counts.cursors, { families: 1, refused: null });
    for (const [what, [moveCursors, reason]] of Object.entries(bad)) {
      const run = await (async () => {
        const { dir, done } = await scratch();
        const result = await runCollector({
          offline: true,
          stateDir,
          outDir: dir,
          stateOutDir: join(dir, "state"),
          minCurrent: 20,
          moveCursors,
          env: {},
        });
        return { dir, done, result };
      })();
      runs[what] = run;
      assert.equal(run.result.ok, true, `${what}: ${run.result.quality.failures}`);
      assert.equal(run.result.published, true, what);
      const header = JSON.parse(
        await readFile(join(run.dir, "state", "pools.json"), "utf8"),
      );
      assert.deepEqual(header.cursors, kept, what);
      // The file is still one the next run can read.
      assert.deepEqual((await readState(join(run.dir, "state"))).cursors, kept);
      const status = JSON.parse(
        await readFile(join(run.dir, "status.json"), "utf8"),
      );
      assert.deepEqual(status.counts.cursors, { families: 1, refused: reason }, what);
      // Nothing else is different from a run that proposed nothing.
      for (const name of ["snapshot.json", "history.json"])
        assert.equal(
          await readFile(join(run.dir, name), "utf8"),
          await readFile(join(plain.dir, name), "utf8"),
          `${what}: ${name}`,
        );
      assert.equal(
        await readFile(join(run.dir, "state", "pools.json"), "utf8"),
        await readFile(join(plain.dir, "state", "pools.json"), "utf8"),
        `${what}: pools.json`,
      );
    }
    // A proposal of the allowed shape is written, and counted.
    const { dir, done } = await scratch();
    runs.good = { dir, done };
    const result = await runCollector({
      offline: true,
      stateDir,
      outDir: dir,
      stateOutDir: join(dir, "state"),
      minCurrent: 20,
      moveCursors: (cursors) => ({
        ...cursors,
        scan: { base: { block: 9, at: 1 } },
      }),
      env: {},
    });
    assert.equal(result.ok, true);
    assert.deepEqual((await readState(join(dir, "state"))).cursors, {
      gt: { base: { p: 3, at: 11 } },
      scan: { base: { block: 9, at: 1 } },
    });
    assert.deepEqual(
      JSON.parse(await readFile(join(dir, "status.json"), "utf8")).counts.cursors,
      { families: 2, refused: null },
    );
  } finally {
    await Promise.all([
      doneState(),
      plain.done(),
      ...Object.values(runs).map((run) => run.done()),
    ]);
  }
});

/* ── (b) What the providers did, counted ────────────────────────────────── */

// Eight pools on base and four on ethereum. DEX Screener answers the base batch
// with: a priced row (A), a row with no figures (C), a row whose currencies
// disagree (D), a row on another network (E), a row for a pool nobody asked
// about, and nothing for B. It fails the ethereum batch with HTTP 500.
// GeckoTerminal prices B and answers the ethereum batch with HTTP 503.
const world = () => {
  const mk = (seed, overrides = {}) =>
    statePool(seed, {
      source: "v4.xyz",
      firstSeen: "2026-11-12T10:00:00.000Z",
      lastSeen: iso(T0 - seed * 1000),
      ...overrides,
    });
  const [A, B, C, D, E, F, G, H] = [1, 2, 3, 4, 5, 6, 7, 8].map((seed) =>
    mk(seed),
  );
  const eth = [11, 12, 13, 14].map((seed) => mk(seed, { chain: "ethereum" }));
  const stranger = mk(99);
  const dsBase = [
    dexRow(A),
    dexRow(C, { volume: {}, liquidity: {} }),
    dexRow(D, { baseToken: { address: address(9999), symbol: "X" } }),
    dexRow(E, { chainId: "ethereum" }),
    dexRow(stranger),
  ];
  const geckoRow = (pool) => ({
    id: `${base.gecko}_${pool.id}`,
    type: "pool",
    attributes: {
      address: pool.id,
      name: "G",
      volume_usd: { h1: "1", h6: "2", h24: "3" },
      reserve_in_usd: "5",
    },
    relationships: {
      dex: { data: { id: base.dex } },
      base_token: { data: { id: `${base.gecko}_${pool.tokens[0]}` } },
      quote_token: { data: { id: `${base.gecko}_${pool.tokens[1]}` } },
    },
  });
  const answer = (call) => {
    if (call.url.includes("dexscreener.com"))
      return call.url.includes("/pairs/ethereum/")
        ? { status: 500 }
        : { body: { pairs: dsBase } };
    return call.url.includes("/networks/eth/")
      ? { status: 503 }
      : { body: { data: [geckoRow(B)] } };
  };
  return { A, B, C, D, E, F, G, H, eth, stranger, answer };
};

async function burstOf(pools, answer, { trace = null, maxPools } = {}) {
  const clock = new FakeClock(T0);
  const fetchImpl = fakeFetch(clock, answer);
  const client = createHttpClient({
    fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
    userAgent: "Test/1 (+https://github.com/example/repo)",
  });
  const plan = planBurst(pools, maxPools ? { maxPools } : {});
  const burst = await runBurst({ client, plan, now: clock.now, trace });
  return { burst, plan, client, fetchImpl };
}

test("the burst counts DEX Screener's batches, failed batches by reason, rows returned and rejected by reason, pools asked and pools with a row", async () => {
  const w = world();
  const pools = [w.A, w.B, w.C, w.D, w.E, w.F, w.G, w.H, ...w.eth];
  const { burst } = await burstOf(pools, w.answer);
  const { retry, ...counts } = burst.telemetry.dexscreener;
  assert.deepEqual(counts, {
    batches: 2,
    failedBatches: { total: 1, byReason: { "http-500": 1 } },
    // Five rows came back in the base batch; the failed batch returned none.
    rowsReturned: 5,
    rowsWithoutValue: 1,
    rowsRejected: { total: 3, byReason: { identity: 1, chain: 1, tokens: 1 } },
    poolsAsked: 12,
    // A and C: a row for the pool, whether or not it carries a figure.
    poolsWithRow: 2,
  });
  // The Ethereum batch failed with an HTTP 500 and was asked again once; the
  // provider answered 500 again. It is one failed batch, asked again and still
  // failed (the retry has its own tests, collector-retry).
  assert.deepEqual(
    [retry.failedFirstPass, retry.retried, retry.recovered, retry.stillFailed],
    [1, 1, 0, 1],
  );
  assert.deepEqual(retry.stillFailedBatches, [
    { chain: "ethereum", pools: 4, reason: "http-500", retried: true },
  ]);
  // The counts agree with each other and with what the burst kept.
  const d = burst.telemetry.dexscreener;
  assert.equal(d.rowsReturned, d.rowsRejected.total + d.poolsWithRow);
  assert.equal(d.batches, burst.dexRequests);
  assert.equal(d.poolsAsked, burst.requestedPools);
  assert.equal(
    [...burst.measured.values()].filter(
      (p) => p.metricProvider === "dexscreener",
    ).length,
    d.poolsWithRow - d.rowsWithoutValue,
  );
});

test("the burst counts GeckoTerminal's fallback requests, failures by reason, ids asked and pools measured per network", async () => {
  const w = world();
  const pools = [w.A, w.B, w.C, w.D, w.E, w.F, w.G, w.H, ...w.eth];
  const { burst, client } = await burstOf(pools, w.answer);
  const { fallback: detail, ...counts } = burst.telemetry.geckoterminal;
  assert.deepEqual(counts, {
    // One batch for base (the unresolved pools of the plan), one for ethereum.
    requests: 2,
    failures: { total: 1, byReason: { "http-503": 1 } },
    idsAsked: 7 + 4,
    measured: 1,
    measuredByNetwork: { base: 1 },
    // Nothing went wrong that was not a provider's answer.
    errors: { total: 0, last: null },
  });
  // The full plan keeps the earlier order: everything is counted as `ordered`.
  assert.equal(detail.mode, "ordered");
  assert.deepEqual(detail.requests, { tier0: 0, sweep: 0, ordered: 2 });
  assert.deepEqual(detail.idsAsked, { carried: 0, unindexed: 0, sweep: 0, ordered: 11 });
  assert.deepEqual(detail.measured, { carried: 0, unindexed: 0, sweep: 0, ordered: 1 });
  assert.deepEqual(detail.networks, {
    base: { requests: 1, ids: 7, measured: 1 },
    ethereum: { requests: 1, ids: 4, measured: 0 },
  });
  assert.equal(burst.telemetry.geckoterminal.requests, burst.fallback.requests);
  assert.equal(burst.telemetry.geckoterminal.idsAsked, burst.fallback.ids);
  assert.equal(burst.telemetry.geckoterminal.measured, burst.fallback.measured);
  assert.equal(client.stats().geckoterminal.failed, 1);
});

test("a burst with nothing to report has zero counts and empty reason tables, not missing ones", async () => {
  const { burst } = await burstOf([statePool(1)], () => ({
    body: { pairs: null },
  }));
  assert.deepEqual(burst.telemetry.dexscreener.failedBatches, {
    total: 0,
    byReason: {},
  });
  assert.deepEqual(burst.telemetry.dexscreener.rowsRejected, {
    total: 0,
    byReason: { identity: 0, chain: 0, tokens: 0 },
  });
  assert.equal(burst.trace, null, "no trace: nothing is recorded");
});

test("a GeckoTerminal discovery page that fails is counted with its reason: an HTTP status, the client's code or the answer's", async () => {
  const chains = METRIC_CHAINS.slice(0, 4);
  const slugOf = (url) => chains.find((c) => url.includes(`/networks/${c.gecko}/`));
  const client = {
    isStopped: () => false,
    async getJson(provider, url) {
      if (provider !== "geckoterminal")
        throw Object.assign(new Error("x"), { code: "http", status: 500 });
      const index = chains.indexOf(slugOf(url));
      if (index === 0)
        throw Object.assign(new Error("x"), { code: "http", status: 503 });
      if (index === 1) throw Object.assign(new Error("x"), { code: "timeout" });
      // An answer that is not a page of pools.
      if (index === 2) return { data: { data: "nope" } };
      return { data: { data: [] } };
    },
  };
  const found = await discoverPools({
    client,
    known: new Set(),
    hookless: new Set(),
    page: 1,
    maxDiscovery: 4,
    maxResolves: 0,
    now: () => T0,
    notAfter: T0 + 60000,
    chains,
  });
  assert.equal(found.stats.geckoPages, 1, "one page was read");
  assert.equal(found.stats.geckoPageFailures, 3);
  assert.deepEqual(found.stats.geckoPageFailureReasons, {
    "http-503": 1,
    shape: 1,
    timeout: 1,
  });
  assert.equal(
    Object.values(found.stats.geckoPageFailureReasons).reduce((a, b) => a + b, 0),
    found.stats.geckoPageFailures,
  );
  // A run that did not look for pools has none.
  assert.deepEqual(discoveryStats().geckoPageFailureReasons, {});
});

test("every failure of a request has a short reason: an HTTP status, the client's code or the answer's", () => {
  const status = (code, extra = {}) =>
    Object.assign(new Error("x"), { code, ...extra });
  assert.equal(failureReason(status("http", { status: 500 })), "http-500");
  assert.equal(failureReason(status("http", { status: 404 })), "http-404");
  assert.equal(failureReason(status("http")), "http");
  for (const code of [
    "timeout",
    "network",
    "size",
    "json",
    "rate-limited",
    "forbidden",
    "shape",
    "ambiguous",
    "clock",
  ])
    assert.equal(failureReason(status(code)), code);
  assert.equal(failureReason(new Error("plain")), "other");
  assert.equal(failureReason(status("Not A Reason!")), "other");
  assert.equal(failureReason(undefined), "other");
});

test("the row classifiers sort the rows the accept functions keep from those they drop, with the reason, and the accept functions are unchanged", () => {
  const w = world();
  const wanted = [w.A, w.C, w.D, w.E].map((pool) => pool.id);
  const structural = new Map(
    [w.A, w.B, w.C, w.D, w.E].map((pool) => [pool.id, pool]),
  );
  const rows = [
    dexRow(w.A),
    dexRow(w.D, { baseToken: { address: address(9999), symbol: "X" } }),
    dexRow(w.E, { chainId: "ethereum" }),
    dexRow(w.C, { dexId: "sushiswap" }),
    dexRow(w.stranger),
    { pairAddress: "nonsense" },
    null,
  ];
  const classified = classifyDexScreenerPairs(
    { pairs: rows },
    base,
    wanted,
    structural,
  );
  assert.deepEqual(classified.accepted, [rows[0]]);
  assert.equal(classified.returned, 7);
  assert.deepEqual(classified.rejected, [
    { id: w.D.id, reason: "tokens" },
    { id: w.E.id, reason: "chain" },
    { id: w.C.id, reason: "chain" },
    { id: w.stranger.id, reason: "identity" },
    { id: null, reason: "identity" },
    { id: null, reason: "identity" },
  ]);
  assert.deepEqual(
    acceptDexScreenerPairs({ pairs: rows }, base, wanted, structural),
    classified.accepted,
  );
  // A v4 label other than v4 is a row for another version of the DEX.
  assert.deepEqual(
    classifyDexScreenerPairs(
      { pairs: [dexRow(w.A, { labels: ["v3"] })] },
      base,
      wanted,
      structural,
    ).rejected,
    [{ id: w.A.id, reason: "chain" }],
  );
  // The two ways a batch is refused as a whole carry a code.
  assert.throws(
    () => classifyDexScreenerPairs({ pairs: "x" }, base, wanted, structural),
    (error) =>
      error.code === "shape" && /unexpected batch shape/.test(error.message),
  );
  assert.throws(
    () =>
      classifyDexScreenerPairs(
        { pairs: [dexRow(w.A), dexRow(w.A)] },
        base,
        wanted,
        structural,
      ),
    (error) =>
      error.code === "ambiguous" && /ambiguous pool IDs/.test(error.message),
  );
  // A row named twice that was rejected is not ambiguous: it is two rejections.
  assert.equal(
    classifyDexScreenerPairs(
      { pairs: [dexRow(w.E, { chainId: "x" }), dexRow(w.E, { chainId: "x" })] },
      base,
      wanted,
      structural,
    ).rejected.length,
    2,
  );
});

test("the accept functions are for the tests only: nothing the collector runs calls them, so the classifiers are the one path", async () => {
  const root = new URL("../collector/", import.meta.url);
  const sources = async (dir) => {
    const found = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
      if (entry.isDirectory()) {
        if (entry.name !== "fixtures") found.push(...(await sources(path)));
      } else if (entry.name.endsWith(".mjs")) found.push(path);
    }
    return found;
  };
  const callers = [];
  for (const file of await sources(root)) {
    const text = await readFile(file, "utf8");
    if (/\b(?:acceptDexScreenerPairs|acceptGeckoPools)\b/.test(text))
      callers.push(file.pathname.split("/collector/").at(-1));
  }
  assert.deepEqual(callers.sort(), [
    "providers/dexscreener.mjs",
    "providers/geckoterminal.mjs",
  ]);
  for (const name of ["dexscreener", "geckoterminal"]) {
    const text = await readFile(new URL("providers/" + name + ".mjs", root), "utf8");
    assert.match(text, /FOR THE TESTS\./, name);
  }
});

test("the GeckoTerminal classifier gives the same split, with the same reasons, and acceptGeckoPools keeps its answer", () => {
  const w = world();
  const wanted = [w.A, w.B, w.C].map((pool) => pool.id);
  const structural = new Map([w.A, w.B, w.C].map((pool) => [pool.id, pool]));
  const row = (pool, overrides = {}) => ({
    id: `${base.gecko}_${pool.id}`,
    type: "pool",
    attributes: {
      address: pool.id,
      name: "G",
      volume_usd: { h24: "3" },
      reserve_in_usd: "5",
    },
    relationships: {
      dex: { data: { id: base.dex } },
      base_token: { data: { id: `${base.gecko}_${pool.tokens[0]}` } },
      quote_token: { data: { id: `${base.gecko}_${pool.tokens[1]}` } },
    },
    ...overrides,
  });
  const rows = [
    row(w.A),
    row(w.B, { relationships: { dex: { data: { id: "uniswap-v3-base" } } } }),
    row(w.C, { id: "base_0xother" }),
    row(w.D),
    row(w.C, {
      relationships: {
        dex: { data: { id: base.dex } },
        base_token: { data: { id: `${base.gecko}_${address(777)}` } },
        quote_token: { data: { id: `${base.gecko}_${address(778)}` } },
      },
      id: `${base.gecko}_${w.C.id}`,
    }),
  ];
  const classified = classifyGeckoPools(
    { data: rows },
    base,
    wanted,
    structural,
  );
  assert.deepEqual(classified.accepted, [rows[0]]);
  assert.equal(classified.returned, 5);
  assert.deepEqual(classified.rejected, [
    { id: w.B.id, reason: "chain" },
    { id: w.C.id, reason: "identity" },
    { id: w.D.id, reason: "identity" },
    { id: w.C.id, reason: "tokens" },
  ]);
  assert.deepEqual(
    acceptGeckoPools({ data: rows }, base, wanted, structural),
    classified.accepted,
  );
  assert.throws(
    () => classifyGeckoPools({ data: null }, base, wanted, structural),
    (error) => error.code === "shape",
  );
});

test("Frontier's listing is read for what it says: its rows and its own total, and null (not zero) when it did not answer", async () => {
  const answer = (data) => ({
    getJson: async () => ({ data, observedAt: T0 }),
  });
  const coins = Array.from({ length: 100 }, () => ({}));
  const read = async (client, id = "frontier-coins") => {
    const { fetchJson, listing } = frontierFetchJson(client);
    await fetchJson(id, "https://api.frontier.fun/coinsPage?limit=100", {
      validate: (value) => value,
    });
    return listing;
  };
  // More coins than the listing holds: the total says so.
  assert.deepEqual(await read(answer({ data: coins, total: 130 })), {
    rows: 100,
    total: 130,
  });
  assert.deepEqual(await read(answer({ data: [], total: 0 })), {
    rows: 0,
    total: 0,
  });
  // A listing with no usable total, or no rows, reports what it has.
  assert.deepEqual(await read(answer({ data: coins })), {
    rows: 100,
    total: null,
  });
  assert.deepEqual(await read(answer({ data: coins, total: -1 })), {
    rows: 100,
    total: null,
  });
  assert.deepEqual(await read(answer({ data: "x", total: 3 })), {
    rows: null,
    total: 3,
  });
  // A request that failed says nothing: not zero.
  const failing = {
    getJson: async () => {
      throw Object.assign(new Error("HTTP 503"), { code: "http", status: 503 });
    },
  };
  assert.deepEqual(await read(failing), { rows: null, total: null });
  // The statistics answer is not the listing.
  assert.deepEqual(
    await read(answer({ data: coins, total: 9 }), "frontier-stats"),
    { rows: null, total: null },
  );
});

test("the client's own record of each provider is published as the status file states it", () => {
  const stats = {
    registry: {
      requests: 2,
      succeeded: 2,
      failed: 0,
      bytes: 5,
      firstRequestAt: T0,
      lastRequestAt: T0 + 1000,
      lastStatus: 200,
      retryAfterMs: null,
      rateLimitWaits: 0,
      rateLimitWaitedMs: 0,
      gapMs: 1000,
      stopped: null,
    },
    dexscreener: {
      requests: 0,
      succeeded: 0,
      failed: 0,
      bytes: 0,
      firstRequestAt: null,
      lastRequestAt: null,
      lastStatus: null,
      retryAfterMs: null,
      rateLimitWaits: 0,
      rateLimitWaitedMs: 0,
      gapMs: 400,
      stopped: null,
    },
    geckoterminal: {
      requests: 3,
      succeeded: 1,
      failed: 2,
      bytes: 1,
      firstRequestAt: T0,
      lastRequestAt: T0 + 5000,
      lastStatus: 429,
      retryAfterMs: 30000,
      rateLimitWaits: 1,
      rateLimitWaitedMs: 30000,
      gapMs: 24000,
      stopped: {
        reason: "rate limited again after waiting (HTTP 429)",
        at: T0 + 5000,
        status: 429,
        retryAfterMs: 30000,
      },
    },
  };
  assert.deepEqual(providerCounts(stats), {
    registry: {
      requests: 2,
      succeeded: 2,
      failed: 0,
      lastStatus: 200,
      firstRequestAt: iso(T0),
      lastRequestAt: iso(T0 + 1000),
      stopped: null,
    },
    dexscreener: {
      requests: 0,
      succeeded: 0,
      failed: 0,
      lastStatus: null,
      firstRequestAt: null,
      lastRequestAt: null,
      stopped: null,
    },
    geckoterminal: {
      requests: 3,
      succeeded: 1,
      failed: 2,
      lastStatus: 429,
      firstRequestAt: iso(T0),
      lastRequestAt: iso(T0 + 5000),
      stopped: {
        reason: "rate limited again after waiting (HTTP 429)",
        at: iso(T0 + 5000),
        status: 429,
        retryAfterMs: 30000,
      },
    },
  });
});

/* ── The status file ────────────────────────────────────────────────────── */

test("status.json has exactly these counts, and the new ones agree with the old ones and with the snapshot", async () => {
  const { dir, done, result } = await offlineRun();
  try {
    assert.equal(result.ok, true, result.quality.failures.join("; "));
    const status = JSON.parse(await readFile(join(dir, "status.json"), "utf8"));
    assert.deepEqual(
      Object.keys(status.counts).sort(),
      [
        "answeredPools",
        "checkedPools",
        "currentPools",
        "cursors",
        "daily",
        "deferredPools",
        "deployments",
        "discoveredHookless",
        "discoveredPools",
        "discovery",
        "droppedForCap",
        "dexscreener",
        "fallbackMeasured",
        "fallbackRequests",
        "frontier",
        "geckoterminal",
        "lanes",
        "measuredPools",
        "networks",
        "plan",
        "plannedDiscoveredPools",
        "plannedPools",
        "priorityPools",
        "projects",
        "providers",
        "rateLimitWaits",
        "requestedPools",
        "requests",
        "statePools",
        "downNetworks",
        "trackedPools",
        "unsupportedNetworks",
      ].sort(),
    );
    const {
      dexscreener: ds,
      geckoterminal: gt,
      providers,
      frontier,
      requests,
    } = status.counts;
    assert.deepEqual(Object.keys(ds), [
      "batches",
      "failedBatches",
      "rowsReturned",
      "rowsWithoutValue",
      "rowsRejected",
      "poolsAsked",
      "poolsWithRow",
      "retry",
    ]);
    assert.deepEqual(Object.keys(gt), [
      "requests",
      "failures",
      "idsAsked",
      "measured",
      "measuredByNetwork",
      "errors",
      "fallback",
    ]);
    assert.deepEqual(Object.keys(frontier).slice(-3), [
      "listingRows",
      "listingTotal",
      "failure",
    ]);
    // The recorded state has no bookmarks and no step proposed any.
    assert.deepEqual(status.counts.cursors, { families: 0, refused: null });
    // They agree with the counts that were there before.
    assert.equal(ds.batches, requests.dexscreener);
    assert.equal(ds.poolsAsked, status.counts.requestedPools);
    assert.equal(gt.requests, status.counts.fallbackRequests);
    assert.equal(gt.measured, status.counts.fallbackMeasured);
    assert.equal(
      ds.failedBatches.total,
      Object.values(ds.failedBatches.byReason).reduce((a, b) => a + b, 0),
    );
    assert.equal(ds.rowsReturned, ds.rowsRejected.total + ds.poolsWithRow);
    assert.equal(
      Object.values(gt.measuredByNetwork).reduce((a, b) => a + b, 0),
      gt.measured,
    );
    assert.ok(ds.batches > 0 && ds.rowsReturned > 0 && gt.requests > 0);
    // The recorded Frontier listing holds 12 rows and says its total is 12.
    assert.deepEqual([frontier.listingRows, frontier.listingTotal], [12, 12]);
    // Every provider the client knows is there, with times as UTC text.
    assert.deepEqual(Object.keys(providers).sort(), [
      "dexscreener",
      "frontier",
      "geckoterminal",
      "goldsky",
      "registry",
      "v4xyz",
    ]);
    for (const [id, row] of Object.entries(providers)) {
      assert.deepEqual(
        Object.keys(row),
        [
          "requests",
          "succeeded",
          "failed",
          "lastStatus",
          "firstRequestAt",
          "lastRequestAt",
          "stopped",
        ],
        id,
      );
      assert.equal(row.requests, requests[id], id);
      assert.equal(row.requests, row.succeeded + row.failed, id);
      assert.equal(row.requests === 0, row.firstRequestAt === null, id);
      if (row.firstRequestAt !== null) {
        assert.match(row.firstRequestAt, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/, id);
        assert.ok(
          Date.parse(row.lastRequestAt) >= Date.parse(row.firstRequestAt),
          id,
        );
      }
    }
    // The file is public, and nothing new in it is an address or a link: only
    // counts, short reasons and times.
    assert.doesNotMatch(
      JSON.stringify({ ds, gt, providers }),
      /https?:\/\/|0x[0-9a-f]{40}/i,
    );
  } finally {
    await done();
  }
});

/* ── (e) The trace ──────────────────────────────────────────────────────── */

test("a trace is a list of chain:0x<64 hex> keys: lower-cased, de-duplicated, and anything else is refused", () => {
  const id = poolId(1);
  const upper = `0x${id.slice(2).toUpperCase()}`;
  assert.deepEqual(
    [...parseTraceList(` base:${id} , base:${upper},arc:${poolId(2)}`)],
    [`base:${id}`, `arc:${poolId(2)}`],
  );
  for (const bad of [
    "",
    " , ",
    "base",
    `base:${id.slice(0, 20)}`,
    `Base:${id}`,
    `base:${id},oops`,
    `:${id}`,
    `base:0x${"g".repeat(64)}`,
  ])
    assert.throws(() => parseTraceList(bad), /--trace/, JSON.stringify(bad));
  const many = Array.from(
    { length: TRACE_MAX_POOLS + 1 },
    (_, i) => `base:${poolId(i + 1)}`,
  );
  assert.equal(
    parseTraceList(many.slice(0, TRACE_MAX_POOLS).join(",")).size,
    TRACE_MAX_POOLS,
  );
  assert.throws(() => parseTraceList(many.join(",")), /at most/);
});

test("--trace refuses to run under GitHub Actions: at the command line, in main and in the collector, before any request", async () => {
  const key = `base:${poolId(1)}`;
  const onGitHub = { GITHUB_ACTIONS: "true" };
  assert.throws(() => assertTraceAllowed(onGitHub), /GitHub Actions/);
  assert.doesNotThrow(() => assertTraceAllowed({}));
  assert.doesNotThrow(() => assertTraceAllowed({ GITHUB_ACTIONS: "" }));
  assert.throws(
    () => parseArguments(["--trace", key], onGitHub),
    /GitHub Actions/,
  );
  assert.deepEqual([...parseArguments(["--trace", key], {}).trace], [key]);
  assert.equal(
    parseArguments(["--offline", "--no-publish"], onGitHub).trace,
    undefined,
  );

  const { dir, done } = await scratch("collector-trace-refused-");
  try {
    const exit = await quietly(() =>
      main(["--offline", "--out", dir, "--trace", key], onGitHub),
    );
    assert.equal(exit.value, 2);
    assert.deepEqual(await readdir(dir), [], "nothing is written");
    // The collector itself refuses too, so a caller that skips the parser cannot
    // carry a trace into the hourly job: no request is made.
    const calls = [];
    await assert.rejects(
      runCollector({
        stateDir: join(FIXTURES, "state"),
        outDir: dir,
        publish: false,
        trace: [key],
        env: onGitHub,
        fetchImpl: async (url) => {
          calls.push(String(url));
          throw new Error("no request may be made");
        },
      }),
      /GitHub Actions/,
    );
    assert.deepEqual(calls, []);
  } finally {
    await done();
  }
});

test("a trace says what happened to each pool: measured, rejected, answered with no market value, not answered, not asked and why", async () => {
  const w = world();
  // `cut` is the oldest of the base pools and falls below a plan of 11 pools.
  const cut = statePool(50, {
    source: "v4.xyz",
    lastSeen: "2026-10-01T00:00:00.000Z",
    firstSeen: "2026-10-01T00:00:00.000Z",
  });
  const nowhere = statePool(60, { chain: "nowhere", source: "v4.xyz" });
  const unknown = `base:${poolId(777)}`;
  const pools = [
    w.A,
    w.B,
    w.C,
    w.D,
    w.E,
    w.F,
    w.G,
    w.H,
    ...w.eth,
    cut,
    nowhere,
  ];
  const asked = [w.A, w.B, w.C, w.D, w.E, w.eth[0], cut, nowhere].map(keyOf);
  const trace = new Set([...asked, unknown]);
  const { burst, plan } = await burstOf(pools, w.answer, {
    trace,
    maxPools: 12,
  });
  assert.equal(plan.planned, 12);
  const report = traceReport({ keys: trace, pools, plan, burst });
  const by = Object.fromEntries(report.map((row) => [row.key, row]));
  assert.equal(report.length, trace.size);

  const measuredA = by[keyOf(w.A)];
  assert.equal(measuredA.outcome, "measured");
  assert.match(
    measuredA.summary,
    /measured by DEX Screener: liquidity 25000 USD, 24h volume 1000 USD/,
  );
  assert.match(measuredA.geckoterminal, /not asked: DEX Screener measured it/);

  const viaGecko = by[keyOf(w.B)];
  assert.equal(viaGecko.outcome, "measured");
  assert.match(viaGecko.summary, /measured by GeckoTerminal/);
  assert.match(viaGecko.dexscreener, /answered the batch but returned no row/);

  const noValue = by[keyOf(w.C)];
  assert.equal(noValue.outcome, "no-market-value");
  assert.match(noValue.summary, /row that has no liquidity and no volume/);
  assert.match(
    noValue.dexscreener,
    /returned a row with no liquidity and no volume/,
  );

  const rejected = by[keyOf(w.D)];
  assert.equal(rejected.outcome, "rejected");
  assert.match(rejected.summary, /currencies disagree/);
  const otherChain = by[keyOf(w.E)];
  assert.equal(otherChain.outcome, "rejected");
  assert.match(
    otherChain.dexscreener,
    /another network, DEX or Uniswap version/,
  );

  const failed = by[keyOf(w.eth[0])];
  assert.equal(failed.outcome, "not-answered");
  assert.match(failed.dexscreener, /its batch failed \(http-500\)/);
  assert.match(failed.geckoterminal, /its batch failed \(http-503\)/);

  const left = by[keyOf(cut)];
  assert.equal(left.outcome, "not-asked");
  assert.match(
    left.dexscreener,
    /left out of this run's plan \(the plan holds 12 pools\)/,
  );
  const noNamespace = by[keyOf(nowhere)];
  assert.equal(noNamespace.outcome, "not-asked");
  assert.match(
    noNamespace.dexscreener,
    /no market namespace for the network nowhere/,
  );
  const stranger = by[unknown];
  assert.equal(stranger.outcome, "not-asked");
  assert.match(stranger.summary, /not a pool this run knows/);

  const lines = formatTrace(report);
  assert.equal(lines[0], `Trace of ${trace.size} pools:`);
  assert.ok(lines.includes(`  ${keyOf(w.D)}`));
  assert.ok(
    lines.every((line) => /^[\x20-\x7e]*$/.test(line)),
    "plain text",
  );
});

test("a trace says a figure the provider did not give is not reported, and a measured zero is a zero", () => {
  const pool = statePool(1);
  const measured = (figures) =>
    new Map([
      [
        keyOf(pool),
        {
          metricProvider: "dexscreener",
          metricUpdatedAt: "2026-11-12T11:59:00.000Z",
          ...figures,
        },
      ],
    ]);
  const report = (figures) =>
    traceReport({
      keys: new Set([keyOf(pool)]),
      pools: [pool],
      plan: { networks: [{ chain: base, pools: [pool] }], planned: 1 },
      burst: { measured: measured(figures), trace: null },
    })[0];
  assert.equal(
    report({ liquidityUsd: null, volumeUsd: { h24: 0 } }).summary,
    "measured by DEX Screener: liquidity not reported, 24h volume 0 USD, observed 2026-11-12T11:59:00.000Z",
  );
  assert.equal(
    report({ liquidityUsd: 12.5, volumeUsd: { h24: null } }).summary,
    "measured by DEX Screener: liquidity 12.5 USD, 24h volume not reported, observed 2026-11-12T11:59:00.000Z",
  );
});

test("a trace changes nothing a run asks, keeps or publishes, and says the same for every pool the snapshot carries", async () => {
  const plain = await offlineRun();
  const keys = fixtureState.pools.slice(0, TRACE_MAX_POOLS).map(keyOf);
  const traced = await offlineRun({ trace: new Set(keys) });
  const again = await offlineRun();
  try {
    assert.equal(
      traced.result.ok,
      true,
      traced.result.quality.failures.join("; "),
    );
    // The same requests. (The v4.xyz and GeckoTerminal lanes run side by side
    // while discovery looks, and the replay reads each recording from disk, so
    // the order they are served in varies from one run to the next: they are
    // compared as lists.)
    const urls = (run) =>
      run.result.served.map((row) => `${row.recorded} ${row.url}`).sort();
    assert.deepEqual(urls(traced), urls(plain));
    assert.deepEqual(urls(again), urls(plain));
    // The same files, byte for byte (an overview file's random publication id
    // aside, which also differs between two runs without a trace).
    const a = await filesUnder(plain.dir);
    const b = await filesUnder(traced.dir);
    const c = await filesUnder(again.dir);
    assert.deepEqual(Object.keys(b).sort(), Object.keys(a).sort());
    for (const name of Object.keys(a)) {
      assert.equal(masked(b[name]), masked(a[name]), name);
      assert.equal(
        masked(c[name]),
        masked(a[name]),
        `${name}, run twice without a trace`,
      );
    }
    assert.equal(a["status.json"], b["status.json"]);
    assert.equal(a["snapshot.json"], b["snapshot.json"]);
    assert.equal(plain.result.trace, null);
    // Every pool traced is told as the snapshot has it.
    const inSnapshot = new Set(
      traced.result.snapshot.pools.map((pool) => pool.id),
    );
    assert.equal(traced.result.trace.length, keys.length);
    for (const row of traced.result.trace) {
      assert.equal(
        row.outcome === "measured",
        inSnapshot.has(row.key),
        row.key,
      );
      assert.ok(
        [
          "measured",
          "rejected",
          "no-market-value",
          "not-answered",
          "not-asked",
        ].includes(row.outcome),
      );
    }
    assert.ok(
      traced.result.trace.filter((row) => row.outcome === "measured").length >
        20,
    );
  } finally {
    await Promise.all([plain.done(), traced.done(), again.done()]);
  }
});

test("main prints the trace after the result line, and still prints it when the run is refused", async () => {
  const { dir, done } = await scratch("collector-trace-main-");
  try {
    const known = keyOf(fixtureState.pools[0]);
    const unknown = `base:${poolId(4242)}`;
    const run = await quietly(() =>
      main(["--offline", "--out", dir, "--trace", `${known},${unknown}`], {}),
    );
    assert.equal(run.value, 0);
    assert.match(run.out[0], /^PASS /);
    assert.equal(run.out[1], "Trace of 2 pools:");
    assert.ok(run.out.includes(`  ${known}`));
    assert.ok(run.out.includes(`  ${unknown}`));
    assert.ok(run.out.some((line) => /not a pool this run knows/.test(line)));
    // Refused (too few current pools for the gate): the trace is the reason to look.
    const refused = await quietly(() =>
      main(
        [
          "--offline",
          "--out",
          join(dir, "again"),
          "--min-current",
          "100000",
          "--trace",
          known,
        ],
        {},
      ),
    );
    assert.equal(refused.value, 1);
    assert.match(refused.out[0], /^REFUSED /);
    assert.ok(refused.out.includes("Trace of 1 pool:"));
    assert.equal(
      existsSync(join(dir, "again")),
      false,
      "a refused run writes nothing",
    );
  } finally {
    await done();
  }
});

/* ── What the change must not touch ─────────────────────────────────────── */

test("the quality gate is untouched: its file, the inputs it is given and the default it starts from are the ones of the design", async () => {
  const lf = (text) => text.split("\r\n").join("\n");
  const { createHash } = await import("node:crypto");
  const quality = lf(
    await readFile(
      new URL("../collector/quality.mjs", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(
    createHash("sha256").update(quality).digest("hex"),
    "ce56f3fd71ee59168fd65e88718132a203d002f37c25a6ea52e57e58475d960c",
    "collector/quality.mjs changed: a stage that adds coverage may not move a gate input or a threshold",
  );
  const run = lf(
    await readFile(new URL("../collector/run.mjs", import.meta.url), "utf8"),
  );
  // The gate that decides publication is the last call. (The 7D and 30D step
  // asks an earlier one, whose answer only decides whether that step spends its
  // requests; it is the run's own gate that publishes or refuses.) The provider
  // stops it reports are those of the measurement phase, `statsBeforeDaily`: a
  // stop in the 7D and 30D step that follows is that step's own business.
  const start = run.lastIndexOf("assessQuality({");
  const call = run
    .slice(start, run.indexOf("});", start) + 3)
    .replace(/\s+/g, "");
  assert.equal(
    call,
    "assessQuality({currentPools:currentPoolCount(snapshot),currentVolumePools:snapshot.summary.freshness?.volume?.h24?.currentPools??0,observedPools:snapshot.pools.length,plannedPools:plan.planned,requestedPools:burst.requestedPools,checkedPools:burst.answeredPools,snapshotValid:validSnapshot(snapshot),overviewsValid,volumeMeasured:historyPointFor(snapshot.summary)!==null,minCurrent,previousPoint:state.history.at(-1)??null,generatedAtMs,stoppedProviders:Object.entries(statsBeforeDaily).filter(([,row])=>row.stopped).map(([id,row])=>`${id}(${row.stopped.reason})`),unsupportedNetworks:[...burst.unsupportedNetworks].sort(),});",
    "the inputs of the gate in collector/run.mjs changed",
  );
  assert.match(run, /\n {2}minCurrent = MIN_CURRENT_POOLS,\n/);
  assert.match(
    run,
    /options\.minCurrent \?\? \(options\.offline \? 20 : MIN_CURRENT_POOLS\)/,
  );
});

test("the request counts of status.json agree with each other and with what the run was served", async () => {
  // A consistency check only: the status file repeats the client's own counts,
  // so this cannot notice a request that was added. The test at the end of this
  // file pins what an offline run sends, and the trace test above checks that a
  // trace asks the same ones.
  const { dir, done, result } = await offlineRun();
  try {
    const status = JSON.parse(await readFile(join(dir, "status.json"), "utf8"));
    const total = Object.values(status.counts.providers).reduce(
      (sum, row) => sum + row.requests,
      0,
    );
    assert.equal(total, status.counts.requests.total);
    assert.equal(result.served.length, status.counts.requests.total);
  } finally {
    await done();
  }
});

/* ── The burst's batch loop, with a scripted provider ───────────────────── */

// askBatch was taken out of the burst loop with no change in behaviour. Nothing
// else in the suite says so for these branches: a success that ends a run of
// failures, a batch that was never sent, a request repeated after a 429. The
// provider here is a fake that answers by the number of the request.

const dexIdsOf = (url) => url.split("/").pop().split(",");

/** `count` seeded pools of one network, with distinct ids. */
const poolsOf = (chain, count, from) =>
  Array.from({ length: count }, (_, index) =>
    statePool(from + index, {
      chain,
      lastSeen: iso(T0 - (from + index) * 1000),
    }),
  );

/** A DEX Screener that answers every batch with a priced row for each id, except
 * where `script(network, n, sent)` (n counts that network's batches from 1, sent
 * counts every DEX Screener request) gives another answer. Returns the burst
 * and what the provider saw. */
async function scriptedBurst(pools, script = () => null, options = {}) {
  const byId = new Map(pools.map((pool) => [pool.id, pool]));
  const seen = [];
  const counts = new Map();
  const answer = (call) => {
    if (!call.url.includes("dexscreener.com")) return { body: { data: [] } };
    const network = call.url.split("/").at(-2);
    const n = (counts.get(network) ?? 0) + 1;
    counts.set(network, n);
    seen.push({ network, n, at: call.at });
    return (
      script(network, n, seen.length) ?? {
        body: { pairs: dexIdsOf(call.url).map((id) => dexRow(byId.get(id))) },
      }
    );
  };
  const clock = new FakeClock(T0);
  const fetchImpl = fakeFetch(clock, answer);
  const client = createHttpClient({
    fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
    userAgent: "Test/1 (+https://github.com/example/repo)",
  });
  const plan = planBurst(pools);
  // The first pass over the plan is what these tests pin: a failed batch is asked
  // again once by the retry (collector-retry), which would add requests here.
  const burst = await runBurst({
    client,
    plan,
    now: clock.now,
    fallbackRequests: 0,
    retryBatches: 0,
    ...options,
  });
  return { burst, client, fetchImpl, seen, plan };
}

test("a success ends a run of failed batches: a network is dropped after five failures in a row, not after five in all", async () => {
  // Base fails four batches, answers one, and so on; Ethereum always answers.
  // The batches go round the networks, so the client's own count of failures in a
  // row is reset by Ethereum's answers and only the network's own count can
  // stop it. Base's count is reset by its answer, so it never reaches five.
  const base12 = poolsOf("base", 12 * 30, 1000);
  const eth8 = poolsOf("ethereum", 8 * 30, 5000);
  const answers = new Set([5, 10]);
  const flap = await scriptedBurst([...base12, ...eth8], (network, n) =>
    network === "base" && !answers.has(n) ? { status: 500 } : null,
  );
  const sent = (found, network) =>
    found.seen.filter((c) => c.network === network).length;
  assert.equal(sent(flap, "base"), 12, "every batch of base was sent");
  assert.equal(sent(flap, "ethereum"), 8);
  const row = (found, slug) => found.burst.networks.find((n) => n.chain === slug);
  assert.equal(row(flap, "base").failedBatches, 10);
  assert.equal(row(flap, "base").checked, 2 * 30);
  assert.equal(row(flap, "ethereum").failedBatches, 0);
  assert.deepEqual(flap.burst.telemetry.dexscreener.failedBatches, {
    total: 10,
    byReason: { "http-500": 10 },
  });
  assert.equal(flap.burst.unsupportedNetworks.length, 0);

  // The control: base that never answers is dropped at its fifth failure, while
  // Ethereum goes on and is asked all eight batches.
  const dead = await scriptedBurst([...base12, ...eth8], (network) =>
    network === "base" ? { status: 500 } : null,
  );
  assert.equal(sent(dead, "base"), 5, "five failures in a row end that network");
  assert.equal(sent(dead, "ethereum"), 8, "the others carry on");
  assert.equal(dead.burst.telemetry.dexscreener.failedBatches.total, 5);
  assert.equal(dead.client.isStopped("dexscreener"), false);
});

test("a batch that was never sent is not a request: the burst's time ran out, and every count says only what was sent", async () => {
  const pools = poolsOf("base", 8 * 30, 1000);
  // The client starts a request no later than the burst's budget, and the
  // provider's 400 ms gap decides when each can start: at 0, 400 and 800 ms. A
  // budget of 1,000 ms lets three batches go and refuses the fourth before it
  // is sent (the loop's own check passes at 800 ms, the client's does not).
  const cut = await scriptedBurst(pools, () => null, { budgetMs: 1000 });
  assert.deepEqual(
    cut.seen.map((c) => c.at - T0),
    [0, 400, 800],
  );
  const d = cut.burst.telemetry.dexscreener;
  assert.equal(d.batches, 3);
  assert.equal(d.poolsAsked, 90);
  assert.equal(d.rowsReturned, 90);
  assert.equal(d.failedBatches.total, 0, "a batch not sent did not fail");
  assert.equal(cut.burst.dexRequests, 3);
  assert.equal(cut.burst.requestedPools, 90);
  assert.equal(cut.burst.requestedKeys.size, 90);
  assert.equal(cut.burst.checkedPools, 90);
  assert.equal(cut.burst.answeredPools, 90);
  assert.equal(cut.burst.networks[0].requested, 90);
  assert.equal(cut.burst.networks[0].planned, 8 * 30);
  assert.equal(cut.client.stats().dexscreener.requests, 3);
  assert.equal(cut.fetchImpl.calls.length, 3);
  assert.equal(cut.client.isStopped("dexscreener"), false);

  // A burst whose budget is already spent asks nothing.
  const none = await scriptedBurst(pools, () => null, { budgetMs: 0 });
  assert.equal(none.seen.length, 0);
  assert.equal(none.burst.telemetry.dexscreener.batches, 0);
  assert.equal(none.burst.telemetry.dexscreener.poolsAsked, 0);
  assert.equal(none.burst.requestedPools, 0);
  assert.equal(none.burst.requestedKeys.size, 0);
  assert.equal(none.burst.networks[0].requested, 0);

  // The same cut at the loop's own check: a budget of 800 ms is used up when the
  // fourth batch is due, so the burst ends before anything is asked for it, and
  // the three that went are all that is counted.
  const early = await scriptedBurst(pools, () => null, { budgetMs: 800 });
  assert.deepEqual(
    early.seen.map((c) => c.at - T0),
    [0, 400, 800],
  );
  assert.equal(early.burst.telemetry.dexscreener.batches, 3);
  assert.equal(early.burst.telemetry.dexscreener.poolsAsked, 90);
  assert.equal(early.burst.requestedPools, 90);
});

test("a batch repeated after a rate-limit wait is one batch for the burst and two requests for the client", async () => {
  const pools = poolsOf("base", 4 * 30, 1000);
  const limited = await scriptedBurst(pools, (network, n, sent) =>
    sent === 2
      ? { status: 429, headers: { "retry-after": "23" }, body: "slow down" }
      : null,
  );
  assert.equal(limited.fetchImpl.calls.length, 5, "four batches and a repeat");
  assert.equal(
    limited.fetchImpl.calls[2].url,
    limited.fetchImpl.calls[1].url,
    "the refused request is the one sent again",
  );
  const d = limited.burst.telemetry.dexscreener;
  assert.equal(d.batches, 4);
  assert.equal(limited.client.stats().dexscreener.requests, d.batches + 1);
  assert.equal(limited.burst.dexRequests, 4);
  assert.equal(d.poolsAsked, 120, "each pool is asked about once");
  assert.equal(d.rowsReturned, 120);
  assert.equal(d.failedBatches.total, 0, "the repeat answered: no failed batch");
  assert.equal(limited.burst.networks[0].failedBatches, 0);
  assert.equal(limited.burst.networks[0].checked, 120);
  assert.equal(limited.burst.measured.size, 120);
  assert.equal(limited.client.stats().dexscreener.rateLimitWaits, 1);
});

test("what an offline run sends is pinned: 89 requests, three of them DEX Screener batches, and no more", async () => {
  // A change that legitimately adds a request (a lane, a retry, a probe) changes
  // these numbers on purpose, and says so in COLLECTOR-NOTES. One that adds a
  // request without meaning to fails here: the run's own total is compared with
  // a number, not with a count of itself. The 7D and 30D step is the last of the
  // run and asks GeckoTerminal for the daily answer of 20 pools: 69 requests
  // before it, 89 with it.
  const { dir, done, result } = await offlineRun();
  try {
    const status = JSON.parse(await readFile(join(dir, "status.json"), "utf8"));
    assert.deepEqual(status.counts.requests, {
      total: 89,
      dexscreener: 3,
      geckoterminal: 41,
      v4xyz: 39,
      registry: 2,
      frontier: 3,
      goldsky: 1,
    });
    assert.equal(result.served.length, 89);
    assert.equal(status.counts.dexscreener.batches, 3);
    assert.equal(status.counts.dexscreener.poolsAsked, 59);
    assert.equal(status.counts.geckoterminal.requests, 1);
    assert.equal(status.counts.daily.requested, 20);
  } finally {
    await done();
  }
});
