// COLLECTOR_MAX_DISCOVERY: how the Snapshot workflow's gate turns discovery off
// for the runs that only measure the pools already known. It works like
// --max-discovery, can only lower discovery, and changes nothing when it is empty
// or invalid. A run with discovery off must also say so in what it publishes: it
// must not read as "no new pools exist".
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveMaxDiscovery } from "../collector/config.mjs";
import { main } from "../collector/run.mjs";
import { blockNetwork } from "../collector/testing.mjs";

blockNetwork();

test("COLLECTOR_MAX_DISCOVERY is a whole number from 0 to 999,999; anything else changes nothing", () => {
  const read = (value) =>
    resolveMaxDiscovery({ COLLECTOR_MAX_DISCOVERY: value });
  for (const [text, number] of [
    ["0", 0],
    ["1", 1],
    ["5", 5],
    [" 12 ", 12],
    ["007", 7],
    ["40", 40],
    ["999999", 999999],
  ])
    assert.equal(read(text), number, JSON.stringify(text));
  for (const text of [
    "",
    "   ",
    "abc",
    "-1",
    "-0",
    "1.5",
    "1e3",
    "0x10",
    "1,000",
    "1000000",
    "99999999999999999999",
    "NaN",
    "Infinity",
    "５",
    null,
    undefined,
    5,
  ])
    assert.equal(read(text), undefined, JSON.stringify(text));
  assert.equal(resolveMaxDiscovery({}), undefined, "not set");
});

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

/** Run the program as the workflow does: offline, with the environment set.
 * The recording is small, so the run uses a lowered gate of 10 pools unless
 * minCurrent is null, which leaves the offline default (20). */
async function runWith(env, extraArguments = [], { minCurrent = "10" } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "collector-discovery-env-"));
  const before = process.env.COLLECTOR_MAX_DISCOVERY;
  if (env === undefined) delete process.env.COLLECTOR_MAX_DISCOVERY;
  else process.env.COLLECTOR_MAX_DISCOVERY = env;
  try {
    const code = await quietly(() =>
      main([
        "--offline",
        "--out",
        dir,
        // With discovery off 18 of the recording's pools are current, fewer than
        // the offline default of 20, so most runs here lower the gate to 10.
        ...(minCurrent === null ? [] : ["--min-current", minCurrent]),
        ...extraArguments,
      ]),
    );
    const json = async (name) =>
      JSON.parse(await readFile(join(dir, name), "utf8"));
    return code === 0
      ? {
          code,
          snapshot: await json("snapshot.json"),
          status: await json("status.json"),
        }
      : { code, wrote: (await readdir(dir)).length };
  } finally {
    if (before === undefined) delete process.env.COLLECTOR_MAX_DISCOVERY;
    else process.env.COLLECTOR_MAX_DISCOVERY = before;
    await rm(dir, { recursive: true, force: true });
  }
}
const source = (run, id) => run.snapshot.sources.find((item) => item.id === id);

test("with no setting, discovery runs; COLLECTOR_MAX_DISCOVERY=0 turns it off and the small recording passes the gate lowered to 10 pools", async () => {
  const on = await runWith(undefined);
  assert.equal(on.code, 0);
  assert.equal(on.status.counts.discovery.geckoPages, 20);
  assert.equal(on.status.counts.discovery.indexerLists, 20);
  assert.ok(source(on, "v4xyz"), "the v4.xyz indexer was asked");

  for (const empty of ["", "   ", "garbage", "-1", "1.5"]) {
    const unchanged = await runWith(empty);
    assert.equal(unchanged.code, 0, JSON.stringify(empty));
    assert.deepEqual(
      unchanged.status.counts.discovery,
      on.status.counts.discovery,
      `${JSON.stringify(empty)} changes nothing`,
    );
  }
  for (const huge of ["40", "999999"]) {
    const unchanged = await runWith(huge);
    assert.equal(unchanged.code, 0);
    assert.deepEqual(
      unchanged.status.counts.discovery,
      on.status.counts.discovery,
      `${huge} cannot raise discovery above no limit`,
    );
  }

  const off = await runWith("0");
  assert.equal(
    off.code,
    0,
    "a run that only measures passes the quality gate lowered to 10 pools",
  );
  assert.equal(off.status.counts.discovery.geckoPages, 0);
  assert.equal(off.status.counts.discovery.indexerLists, 0);
  assert.equal(off.status.counts.discovery.resolvesTried, 0);
  assert.equal(
    off.status.counts.discovery.page,
    null,
    "no page was chosen: not run",
  );
  assert.equal(off.status.counts.requests.v4xyz, 0, "no v4.xyz request");
  // The measuring itself is unchanged: the same pools are asked about.
  assert.ok(off.status.counts.requests.dexscreener > 0);
});

test("turning discovery off lowers no threshold: at the offline default of 20 pools the small recording is refused, and with discovery on it passes", async () => {
  // 18 of the recording's pools are current without discovery, 20 are needed:
  // the run publishes nothing, as any run that falls short of the gate does. The
  // lowered gate of 10 in the other tests is the recording's own size, not a
  // weaker rule (the live minimum is 500 and the offline flag alone may go below it).
  const off = await runWith("0", [], { minCurrent: null });
  assert.equal(off.code, 1, "refused");
  assert.equal(off.wrote, 0, "nothing was written");
  const lowered = await runWith("0");
  assert.ok(
    lowered.status.counts.currentPools < 20,
    `${lowered.status.counts.currentPools} current pools without discovery`,
  );
  assert.ok(lowered.status.counts.currentPools >= 10);
  // The collector notes give the same two numbers: the default and the count.
  const notes = ["docs/edition/COLLECTOR-NOTES.md", "docs/COLLECTOR-NOTES.md"]
    .map((path) => new URL(`../${path}`, import.meta.url))
    .find((url) => existsSync(url));
  assert.ok(notes, "the collector notes are part of the edition");
  const words = (await readFile(notes, "utf8")).replace(/\s+/g, " ");
  assert.ok(
    words.includes(
      `at the default offline minimum of 20 it is refused, with ${lowered.status.counts.currentPools} pools that carry a current volume`,
    ),
    "COLLECTOR-NOTES says what the default gate does with the recording",
  );
  // The same recording with discovery on has more than the default needs.
  const on = await runWith(undefined, [], { minCurrent: null });
  assert.equal(on.code, 0, "with discovery on the default gate passes");
  assert.ok(on.status.counts.currentPools >= 20);
});

test("a smaller number limits the networks discovery looks at, and the command line wins", async () => {
  const two = await runWith("2");
  assert.equal(two.code, 0);
  assert.equal(two.status.counts.discovery.indexerLists, 2);
  // --max-discovery given on the command line is used, not the environment.
  const line = await runWith("0", ["--max-discovery", "3"]);
  assert.equal(line.code, 0);
  assert.equal(line.status.counts.discovery.indexerLists, 3);
  const lineOff = await runWith("5", ["--max-discovery", "0"]);
  assert.equal(lineOff.code, 0);
  assert.equal(lineOff.status.counts.discovery.indexerLists, 0);
  assert.equal(lineOff.status.counts.discovery.geckoPages, 0);
});

test("a snapshot made without discovery says so and does not read as 'no new pools exist'", async () => {
  const on = await runWith(undefined);
  const off = await runWith("0");
  const gecko = source(off, "geckoterminal");
  assert.ok(
    gecko,
    "GeckoTerminal still stands in for pools DEX Screener missed",
  );
  assert.match(gecko.note, /pages read: 0/);
  assert.match(gecko.note, /this run did not look for new pools/);
  // There is no card for the v4.xyz indexer: it was not asked, so nothing says it
  // found nothing.
  assert.equal(source(off, "v4xyz"), undefined);
  for (const item of off.snapshot.sources)
    assert.doesNotMatch(
      item.note ?? "",
      /no new pools|nothing new|none found/i,
      item.id,
    );
  // A run that did look says how many pages it read, and does not carry the line.
  const looked = source(on, "geckoterminal");
  assert.match(looked.note, /pages read: 20\)/);
  assert.doesNotMatch(looked.note, /did not look for new pools/);
  // The pools of the earlier discoveries stay in the snapshot: only the looking
  // is skipped.
  assert.ok(off.snapshot.pools.length > 0);
});
