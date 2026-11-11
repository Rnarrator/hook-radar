import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSnapshot } from "../src/model.ts";
import { isAnalyticsOverviewEnvelope } from "../shared/analytics-overview.ts";
import { marketMeasurementState } from "../shared/market-freshness.ts";
import { MARKET_CHAINS } from "../server/market-chains.mjs";
import { observationTime } from "../collector/http.mjs";
import { FIXTURES, main, ROOT, runCollector } from "../collector/run.mjs";
import {
  acceptDexScreenerPairs,
  DS_NETWORKS,
} from "../collector/providers/dexscreener.mjs";
import { acceptGeckoPools } from "../collector/providers/geckoterminal.mjs";
import { readState } from "../collector/state.mjs";
import { blockNetwork } from "../collector/testing.mjs";

blockNetwork();

const manifest = JSON.parse(
  await readFile(join(FIXTURES, "manifest.json"), "utf8"),
);
const fixtureState = await readState(join(FIXTURES, "state"));
const body = async (entry) =>
  JSON.parse(await readFile(join(FIXTURES, entry.file), "utf8"));
const live = await import("../server/market-enricher.mjs").catch(() => null);
// The replay also covers Frontier's own market figures: ten pooled coin markets.
const FRONTIER_POOLS = JSON.parse(
  await readFile(join(FIXTURES, "frontier-2.json"), "utf8"),
).data.filter((coin) => coin.isLPd).length;

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), "collector-offline-"));
  return { dir, done: () => rm(dir, { recursive: true, force: true }) };
}
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

test("the fixtures are complete recordings of real responses, within the live request budget", async () => {
  assert.ok(manifest.entries.length <= 16);
  const count = (host) =>
    manifest.entries.filter((entry) => entry.provider === host).length;
  assert.ok(count("api.dexscreener.com") <= 5);
  assert.ok(count("api.geckoterminal.com") <= 2);
  assert.ok(count("www.v4.xyz") <= 3);
  for (const entry of manifest.entries) {
    assert.equal(entry.status, 200);
    assert.ok(Number.isFinite(Date.parse(entry.date)), entry.url);
    assert.ok(new URL(entry.url).protocol === "https:");
    // The manifest counts the bytes of the recording. .gitattributes keeps
    // collector/fixtures out of line-end conversion (-text), so a fresh
    // checkout holds exactly those bytes. A copy checked out before that rule
    // existed (Windows, core.autocrlf) holds CRLF where the recording has LF:
    // it is judged with LF line ends, never with any other change.
    const raw = await readFile(join(FIXTURES, entry.file));
    const recorded =
      raw.length === entry.bytes
        ? raw
        : Buffer.from(raw.toString("utf8").replace(/\r\n/g, "\n"));
    assert.equal(recorded.length, entry.bytes, entry.file);
    assert.doesNotThrow(() => JSON.parse(recorded.toString("utf8")));
  }
  // The recording is as old as its own headers say, not stamped with today.
  assert.ok(
    manifest.entries.every(
      (entry) =>
        Date.parse(entry.date) <= Date.parse(manifest.recordedAt) + 120000,
    ),
  );
  assert.ok(fixtureState.pools.length > 20);
  assert.ok(fixtureState.pools.every((pool) => pool.source === "v4.xyz"));
});

test("what was not recorded is said so: the three Frontier answers are marked derived or synthetic, nothing else is", async () => {
  const marked = manifest.entries.filter(
    (entry) => "derived" in entry || "synthetic" in entry,
  );
  assert.deepEqual(
    marked.map((entry) => entry.file),
    ["frontier-2.json", "frontier-3.json", "goldsky-1.json"],
  );
  for (const entry of marked)
    assert.match(
      entry.derived ?? entry.synthetic,
      /^(Derived, not recorded|Hand-built for the replay, never recorded):/,
    );
  // The index answer is invented: one round number for every pool.
  const index = JSON.parse(
    await readFile(join(FIXTURES, "goldsky-1.json"), "utf8"),
  );
  assert.ok(
    index.data.pools.every(
      (pool) => pool.totalValueLockedToken1 === "100000000",
    ),
  );
  // The listing holds only fields the collector reads.
  const coins = JSON.parse(
    await readFile(join(FIXTURES, "frontier-2.json"), "utf8"),
  );
  assert.equal(coins.total, coins.data.length);
  assert.ok(
    coins.data.every(
      (coin) => !("image" in coin) && !("creator" in coin) && !("tape" in coin),
    ),
  );
});

test("observation times of the recorded responses come from their Date and Age", () => {
  for (const entry of manifest.entries) {
    const receivedAt = Date.parse(entry.date) + 200;
    const observed = observationTime({
      receivedAt,
      date: entry.date,
      age: entry.age === null ? null : String(entry.age),
    });
    assert.equal(
      observed,
      receivedAt - Math.max((entry.age ?? 0) * 1000, 200),
      entry.url,
    );
    assert.ok(observed <= Date.parse(entry.date));
  }
});

test("on every recorded DEX Screener and GeckoTerminal response, the acceptance rules keep exact requested pools only", async () => {
  const identities = new Map(
    fixtureState.pools.map((pool) => [`${pool.chain}:${pool.id}`, pool]),
  );
  // The one pool found by discovery in the recording.
  const detail = manifest.entries.find((entry) =>
    entry.url.includes("/api/pool/"),
  );
  const detailId = detail.url.split("_").at(-1);
  const detailRow = (await body(detail)).Pool[0];
  identities.set(`base:${detailId}`, {
    id: detailId,
    chain: "base",
    hookAddress: detailRow.hooks.toLowerCase(),
    tokens: [detailRow.token0, detailRow.token1].map((token) =>
      token.slice(token.indexOf("_") + 1).toLowerCase(),
    ),
  });
  let accepted = 0;
  for (const entry of manifest.entries) {
    const url = new URL(entry.url);
    if (entry.provider === "api.dexscreener.com") {
      const [, , , , network, ids] = url.pathname.split("/");
      const chain = MARKET_CHAINS.find((c) => DS_NETWORKS[c.chain] === network);
      const requested = ids.split(",");
      const structural = new Map(
        requested.map((id) => [id, identities.get(`${chain.chain}:${id}`)]),
      );
      const value = await body(entry);
      const rows = acceptDexScreenerPairs(value, chain, requested, structural);
      assert.ok(rows.length > 0);
      assert.ok(rows.length <= requested.length);
      assert.ok(
        rows.every((row) => requested.includes(row.pairAddress.toLowerCase())),
      );
      assert.ok(
        rows.every((row) => row.dexId === "uniswap" && row.chainId === network),
      );
      if (live)
        assert.deepEqual(
          rows,
          live.validateMarketBatch(
            value,
            "dexscreener",
            chain,
            requested,
            structural,
          ).pairs,
        );
      accepted += rows.length;
    }
    if (entry.url.includes("/pools/multi/")) {
      const parts = url.pathname.split("/");
      const chain = MARKET_CHAINS.find((c) => c.gecko === parts[4]);
      const requested = parts.at(-1).split(",");
      const structural = new Map(
        requested.map((id) => [id, identities.get(`${chain.chain}:${id}`)]),
      );
      const value = await body(entry);
      const rows = acceptGeckoPools(value, chain, requested, structural);
      assert.ok(rows.length > 0);
      if (live)
        assert.deepEqual(
          rows,
          live.validateMarketBatch(
            value,
            "geckoterminal",
            chain,
            requested,
            structural,
          ).data,
        );
      accepted += rows.length;
    }
  }
  assert.equal(accepted, manifest.burst.measured);
});

test("an offline run replays the recording end to end without touching the network", async () => {
  const { dir, done } = await scratch();
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("The network was used during an offline run.");
  };
  try {
    const state = join(dir, "state");
    const result = await runCollector({
      offline: true,
      stateDir: join(FIXTURES, "state"),
      outDir: dir,
      stateOutDir: state,
      minCurrent: 20,
    });
    assert.equal(result.ok, true, result.quality.failures.join("; "));
    assert.equal(result.published, true);
    const snapshot = JSON.parse(
      await readFile(join(dir, "snapshot.json"), "utf8"),
    );
    assert.equal(isSnapshot(snapshot), true);
    // Exactly the pools the recording measured, nothing invented. One recorded
    // GeckoTerminal row (a Base pool, ...31ef) carries no figure at all: its
    // reserve is "0.0" and unverified and every volume is null. It was answered,
    // so it counts as checked, but it is no measurement and is not in the
    // snapshot, and the counts all say the same.
    const RECORDED_ROWS_WITHOUT_A_FIGURE = 1;
    assert.equal(
      snapshot.pools.length,
      manifest.burst.measured - RECORDED_ROWS_WITHOUT_A_FIGURE + FRONTIER_POOLS,
    );
    assert.equal(
      snapshot.pools.some((pool) => pool.address.endsWith("31ef")),
      false,
    );
    const base = snapshot.marketCoverage.networks.find(
      (network) => network.chain === "base",
    );
    assert.equal(base.missingPools, RECORDED_ROWS_WITHOUT_A_FIGURE);
    const generatedAt = Date.parse(snapshot.generatedAt);
    assert.ok(
      snapshot.pools.every(
        (pool) => marketMeasurementState(pool, generatedAt) === "current",
      ),
    );
    // Every time is a recorded one: the response Date of the request that measured it.
    const dexDates = new Set(
      manifest.entries
        .filter((entry) => entry.provider === "api.dexscreener.com")
        .map((entry) => new Date(Date.parse(entry.date)).toISOString()),
    );
    const geckoDate = manifest.entries.find((entry) =>
      entry.url.includes("/pools/multi/"),
    ).date;
    for (const pool of snapshot.pools) {
      if (pool.metricProvider === "dexscreener")
        assert.ok(dexDates.has(pool.metricUpdatedAt), pool.metricUpdatedAt);
      else if (pool.metricProvider === "frontier")
        assert.ok(
          Date.parse(pool.metricUpdatedAt) <=
            Date.parse(
              manifest.entries.find((entry) => entry.file === "frontier-2.json")
                .date,
            ),
        );
      else {
        assert.equal(pool.metricProvider, "geckoterminal");
        assert.equal(
          pool.metricUpdatedAt,
          new Date(Date.parse(geckoDate)).toISOString(),
        );
      }
      assert.ok(
        Date.parse(pool.metricUpdatedAt) <
          Date.parse(manifest.recordedAt) + 120000,
      );
    }
    assert.equal(snapshot.generatedAt >= [...dexDates].sort().at(-1), true);
    assert.equal(snapshot.status, "partial");
    assert.ok(snapshot.projects.length > 100);
    assert.ok(snapshot.sources.some((source) => source.id === "dexscreener"));
    // The census keeps its exported timestamps.
    assert.equal(
      snapshot.inventory.generatedAt,
      fixtureState.census.inventory.generatedAt,
    );
    // Overviews: every network, all validators pass, built at the snapshot's time.
    const names = (await readdir(dir)).filter((name) =>
      name.startsWith("overview-"),
    );
    assert.ok(
      names.includes("overview-all-h24.json") &&
        names.includes("overview-base-h24.json"),
    );
    for (const name of names) {
      const [, chain, window] = /^overview-(.+)-(h1|h6|h24)\.json$/.exec(name);
      const envelope = JSON.parse(await readFile(join(dir, name), "utf8"));
      assert.equal(
        isAnalyticsOverviewEnvelope(envelope, { chain, window }),
        true,
        name,
      );
      assert.equal(envelope.asOf, snapshot.generatedAt);
      assert.ok(Buffer.byteLength(JSON.stringify(envelope)) <= 2 * 1024 * 1024);
    }
    assert.equal(names.length, 3 + snapshot.chains.length);
    // Status: marked as an offline replay, counts are the real counts.
    const status = JSON.parse(await readFile(join(dir, "status.json"), "utf8"));
    assert.equal(status.offline, true);
    // The recorder counted the row without a figure as measured (it did not
    // look at the figures); a replay does not.
    assert.equal(
      status.counts.measuredPools,
      manifest.burst.measured - RECORDED_ROWS_WITHOUT_A_FIGURE + FRONTIER_POOLS,
    );
    assert.equal(status.counts.frontier.poolsSupplied, FRONTIER_POOLS);
    assert.equal(status.counts.requests.frontier, 3);
    assert.equal(status.counts.requests.goldsky, 1);
    assert.equal(
      snapshot.pools.filter((pool) => pool.metricProvider === "frontier")
        .length,
      FRONTIER_POOLS,
    );
    assert.equal(status.counts.trackedPools, snapshot.pools.length);
    assert.equal(
      status.counts.fallbackMeasured,
      manifest.burst.fallback.measured - RECORDED_ROWS_WITHOUT_A_FIGURE,
    );
    assert.equal(status.previousGeneratedAt, null);
    // The state moves forward: the discovered pool is kept, history has one point.
    const next = await readState(state);
    assert.equal(next.pools.length, fixtureState.pools.length + 1);
    assert.equal(next.history.length, 1);
    assert.equal(next.updatedAt, snapshot.generatedAt);
    // A second run from that state: same pools, no second history point inside five minutes,
    // and it knows when the previous snapshot was taken.
    const again = await runCollector({
      offline: true,
      stateDir: state,
      outDir: join(dir, "second"),
      stateOutDir: join(dir, "second", "state"),
      minCurrent: 20,
    });
    assert.equal(again.ok, true);
    assert.equal(again.status.previousGeneratedAt, snapshot.generatedAt);
    assert.equal(again.historyPoints.length, 1);
    // The pools GeckoTerminal measured are asked for first the second time (the
    // fallback hint). The recorded row without a figure is no longer one of them,
    // so the request is composed differently from the recorded one and the replay
    // has no answer to it: what comes back unchanged is every pool DEX Screener
    // measured, by id and by figure.
    const priced = (published) =>
      published.pools
        .filter((pool) => pool.metricProvider === "dexscreener")
        .map((pool) => [pool.id, JSON.stringify(pool.volumeUsd)]);
    assert.ok(priced(snapshot).length > 30);
    assert.deepEqual(priced(again.snapshot), priced(snapshot));
    for (const pool of again.snapshot.pools)
      assert.ok(
        snapshot.pools.some((first) => first.id === pool.id),
        "the second run invents no pool",
      );
  } finally {
    globalThis.fetch = realFetch;
    await done();
  }
});

test("the default quality gate refuses the small recording, and nothing is written", async () => {
  const { dir, done } = await scratch();
  try {
    const out = join(dir, "out");
    const result = await runCollector({
      offline: true,
      stateDir: join(FIXTURES, "state"),
      outDir: out,
      stateOutDir: join(out, "state"),
      minCurrent: 500,
    });
    assert.equal(result.ok, false);
    assert.match(result.quality.failures.join(" "), /at least 500/);
    assert.equal(existsSync(out), false);
  } finally {
    await done();
  }
});

test("an offline run through the command line writes only where it is told", async () => {
  const { dir, done } = await scratch();
  const publicData = join(ROOT, "public", "data");
  const before = {
    publicData: existsSync(publicData),
    pools: statSync(join(ROOT, "state", "pools.json")).mtimeMs,
    fixture: statSync(join(FIXTURES, "state", "pools.json")).mtimeMs,
  };
  try {
    assert.equal(await quietly(() => main(["--offline"])), 2);
    assert.equal(existsSync(publicData), before.publicData);
    assert.equal(await quietly(() => main(["--offline", "--no-publish"])), 0);
    assert.equal(await quietly(() => main(["--offline", "--out", dir])), 0);
    assert.ok((await readdir(dir)).includes("snapshot.json"));
    assert.ok(existsSync(join(dir, "state", "pools.json")));
    assert.equal(existsSync(publicData), before.publicData);
    assert.equal(
      statSync(join(ROOT, "state", "pools.json")).mtimeMs,
      before.pools,
    );
    assert.equal(
      statSync(join(FIXTURES, "state", "pools.json")).mtimeMs,
      before.fixture,
    );
    // Online, the gate cannot be lowered from the command line.
    assert.equal(await quietly(() => main(["--min-current", "5"])), 2);
  } finally {
    await done();
  }
});
