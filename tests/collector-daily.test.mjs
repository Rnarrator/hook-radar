import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as config from "../collector/config.mjs";
import {
  buildDailyDataset,
  collectDaily,
  currentMeasured,
  dailyChains,
  dailySource,
  isCovered,
  isDue,
  latestCheckpoint,
  mergeRead,
  rankPools,
  selectDaily,
  windowFigures,
} from "../collector/daily.mjs";
import { createHttpClient } from "../collector/http.mjs";
import {
  geckoOhlcvUrl,
  GT_DAILY_ACCEPT,
  parseOhlcv,
  UnreadableOhlcv,
} from "../collector/providers/geckoterminal.mjs";
import {
  dailyJson,
  isDailyRecord,
  isDailyState,
  poolsJson,
  readState,
} from "../collector/state.mjs";
import {
  address,
  blockNetwork,
  FakeClock,
  fakeFetch,
  poolId,
} from "../collector/testing.mjs";
import { dayNumber, dayLabel, dayStartMs } from "../shared/daily-volume.ts";

blockNetwork();

// The daily-volume step, piece by piece: the day-candle request and parser (run
// against the answers recorded from the live API on 11 November 2026, and
// against hand-built bad ones), the records, the checkpoints, the reads on a
// fake clock, and the file the readings make. Nothing here reaches a provider.

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "collector",
  "fixtures",
  "daily",
);
const recorded = async (name) => {
  const sample = JSON.parse(await readFile(join(FIXTURES, name), "utf8"));
  return {
    ...sample,
    body: JSON.parse(sample.bodyText),
    observedAt: Date.parse(sample.headers.date),
  };
};
const ETHEREUM = dailyChains().get("ethereum");
const ISO = (ms) => new Date(ms).toISOString();
// A run just after midnight UTC on 12 November 2026: the first checkpoint.
const T0 = Date.parse("2026-11-12T01:14:00.000Z");
const TODAY = dayNumber(T0);
const NOV11 = TODAY - 1;
const ID = (seed) => poolId(seed);

/** The answer of the provider for a pool: newest first, one candle per day. */
function candles(today, count, volumeOf = () => 10, { meta } = {}) {
  const list = [];
  for (let k = 0; k < count; k++) {
    const day = today - k;
    list.push([day * 86400, 1, 1, 1, 1, volumeOf(day)]);
  }
  return {
    data: { id: "x", type: "ohlcv_request_response", attributes: { ohlcv_list: list } },
    ...(meta ? { meta } : {}),
  };
}

test("the request names the exact pool, its network and every parameter of the verified shape", () => {
  const id = ID(7);
  assert.equal(
    geckoOhlcvUrl(ETHEREUM, id),
    `https://api.geckoterminal.com/api/v2/networks/eth/pools/${id}/ohlcv/day?limit=33&currency=usd&include_empty_intervals=true`,
  );
  assert.equal(
    geckoOhlcvUrl(ETHEREUM, id.toUpperCase().replace("0X", "0x")),
    geckoOhlcvUrl(ETHEREUM, id),
    "the pool id is written in lower case",
  );
  assert.equal(GT_DAILY_ACCEPT, "application/json;version=20230302");
  assert.throws(() => geckoOhlcvUrl(ETHEREUM, "0x1234"), /exact pool ID/);
  assert.throws(() => geckoOhlcvUrl(ETHEREUM, `${id}/../x`), /exact pool ID/);
  assert.throws(() => geckoOhlcvUrl({ gecko: "a/b" }, id), /namespace/);
  assert.throws(() => geckoOhlcvUrl({ chain: "x" }, id), /namespace/);
  assert.equal(config.DAILY_CANDLES, 33);
});

test("every network with a GeckoTerminal namespace can be asked; one without cannot", () => {
  const chains = dailyChains();
  for (const slug of ["ethereum", "base", "robinhood", "xlayer", "ink"])
    assert.ok(chains.has(slug), slug);
  assert.equal(chains.get("xlayer").gecko, "x-layer");
  assert.equal(chains.has("nowhere"), false);
});

// What the live API answered on 11 November 2026 (22:47 to 22:59 UTC).

test("a recorded answer for a busy Ethereum pool: 33 rows, the day in progress left out", async () => {
  const sample = await recorded("01-eth-busy.json");
  const read = parseOhlcv(sample.body, sample.observedAt, [
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    "0xdac17f958d2ee523a2206206994597c13d831ec7",
  ]);
  assert.equal(read.rows, 33);
  assert.equal(read.full, true);
  assert.equal(read.days.length, 32);
  assert.equal(read.oldest, dayNumber(Date.parse("2026-10-10")));
  // 11 November was still going at 22:48 UTC: it is not a stored day.
  assert.equal(read.days.at(-1)[0], dayNumber(Date.parse("2026-11-10")));
  assert.ok(read.days.every(([, usd]) => usd > 0));
  assert.deepEqual(
    read.days.map(([day]) => day),
    [...read.days.map(([day]) => day)].sort((a, b) => a - b),
    "ascending, though the provider lists the newest first",
  );
  // The same answer an hour after midnight has one more complete day.
  const later = parseOhlcv(sample.body, Date.parse("2026-11-12T00:01:00Z"));
  assert.equal(later.days.length, 33);
});

test("a recorded answer without empty days is refused: a sparse pool's 33 rows span two months", async () => {
  const sample = await recorded("03-eth-sparse.json");
  assert.throws(
    () => parseOhlcv(sample.body, sample.observedAt),
    (error) =>
      error instanceof UnreadableOhlcv && /day is missing/.test(error.reason),
  );
});

test("a recorded answer with empty days included: contiguous days, a day without trades is a measured zero", async () => {
  const sample = await recorded("04-eth-sparse-empty.json");
  const read = parseOhlcv(sample.body, sample.observedAt);
  assert.equal(read.days.length, 32);
  const zeros = read.days.filter(([, usd]) => usd === 0).length;
  assert.ok(zeros > 5, `${zeros} quiet days are zeros, not gaps`);
  for (let index = 1; index < read.days.length; index++)
    assert.equal(read.days[index][0] - read.days[index - 1][0], 1);
});

test("recorded answers for pools younger than the window: fewer rows, and where the history starts", async () => {
  const frontier = await recorded("05-robinhood-frontier.json");
  const read = parseOhlcv(frontier.body, frontier.observedAt);
  assert.equal(read.rows, 14);
  assert.equal(read.full, false);
  assert.equal(read.oldest, dayNumber(Date.parse("2026-10-29")));
  assert.equal(read.days.length, 13);
  // A pool that began today has one row, and no complete day.
  const young = await recorded("07-base-young.json");
  const today = parseOhlcv(young.body, young.observedAt);
  assert.deepEqual(
    { days: today.days, rows: today.rows, full: today.full },
    { days: [], rows: 1, full: false },
  );
  assert.equal(today.oldest, dayNumber(Date.parse("2026-11-11")));
  for (const name of ["08-xlayer.json", "10-robinhood-old.json"]) {
    const sample = await recorded(name);
    assert.ok(parseOhlcv(sample.body, sample.observedAt).days.length >= 20, name);
  }
});

test("the recorded answers name the pool's currencies, and the parser holds them to the pool's own", async () => {
  const sample = await recorded("05-robinhood-frontier.json");
  const token = sample.body.meta.base.address;
  // The native currency (the zero address) is not compared.
  assert.doesNotThrow(() =>
    parseOhlcv(sample.body, sample.observedAt, [
      "0x0000000000000000000000000000000000000000",
      token,
    ]),
  );
  assert.throws(
    () =>
      parseOhlcv(sample.body, sample.observedAt, [
        "0x0000000000000000000000000000000000000000",
        address(77),
      ]),
    (error) => /other currencies/.test(error.reason),
  );
  // An answer that names nothing is judged by the pool id in the request alone.
  const { meta: _meta, ...unnamed } = sample.body;
  assert.doesNotThrow(() =>
    parseOhlcv(unnamed, sample.observedAt, [address(1), address(2)]),
  );
});

test("the recorded refusals are what the client's own rules expect", async () => {
  for (const name of ["02-429-rate-limit.json", "06-429-second.json"]) {
    const sample = await recorded(name);
    assert.equal(sample.status, 429);
    assert.equal(sample.headers["retry-after"], "0");
    assert.equal(sample.body.status.error_code, 429);
  }
  for (const name of ["00-wrong-slug-404.json", "09-unknown-pool-404.json"]) {
    const sample = await recorded(name);
    assert.equal(sample.status, 404);
    assert.equal(sample.body.errors[0].status, "404");
  }
});

// Answers that are not the verified shape: the parser refuses all of them.

const BAD = {
  "no body": () => ({}),
  "no data": () => ({ data: {} }),
  "a list that is not a list": () => ({
    data: { attributes: { ohlcv_list: "x" } },
  }),
  "34 rows": () => candles(TODAY, 34),
  "a row that is not a candle": () => {
    const body = candles(TODAY, 3);
    body.data.attributes.ohlcv_list[1] = "x";
    return body;
  },
  "a row of five entries": () => {
    const body = candles(TODAY, 3);
    body.data.attributes.ohlcv_list[1].pop();
    return body;
  },
  "a candle that does not start at midnight": () => {
    const body = candles(TODAY, 3);
    body.data.attributes.ohlcv_list[1][0] += 3600;
    return body;
  },
  "a fractional timestamp": () => {
    const body = candles(TODAY, 3);
    body.data.attributes.ohlcv_list[1][0] += 0.5;
    return body;
  },
  "a timestamp in milliseconds": () => {
    const body = candles(TODAY, 3);
    body.data.attributes.ohlcv_list[1][0] *= 1000;
    return body;
  },
  "a day after the reading": () => candles(TODAY + 1, 3),
  "a day listed twice": () => {
    const body = candles(TODAY, 3);
    body.data.attributes.ohlcv_list[2] = [...body.data.attributes.ohlcv_list[1]];
    return body;
  },
  "a missing day": () => {
    const body = candles(TODAY, 4);
    body.data.attributes.ohlcv_list.splice(1, 1);
    return body;
  },
  "a negative volume": () => candles(TODAY, 3, () => -1),
  "a null volume": () => candles(TODAY, 3, () => null),
  "a volume written as text": () => candles(TODAY, 3, () => "5"),
  "an absurd volume": () => candles(TODAY, 3, () => 1e13),
  "an infinite volume": () => candles(TODAY, 3, () => Infinity),
};

for (const [label, make] of Object.entries(BAD))
  test(`an answer with ${label} is unreadable`, () => {
    // JSON turns Infinity into null; the parser meets what the wire carries.
    const wire = JSON.parse(JSON.stringify(make()));
    assert.throws(
      () => parseOhlcv(wire, T0),
      (error) => error instanceof UnreadableOhlcv,
    );
  });

test("the order of the rows does not matter, an empty list is no data, and the largest allowed volume passes", () => {
  const body = candles(TODAY, 5, (day) => day - (TODAY - 10));
  const ascending = structuredClone(body);
  ascending.data.attributes.ohlcv_list.reverse();
  assert.deepEqual(parseOhlcv(ascending, T0), parseOhlcv(body, T0));
  assert.deepEqual(parseOhlcv(candles(TODAY, 0), T0), {
    days: [],
    oldest: null,
    full: false,
    rows: 0,
  });
  assert.equal(
    parseOhlcv(candles(TODAY, 2, () => 9.99e12), T0).days[0][1],
    9.99e12,
  );
  assert.equal(parseOhlcv(candles(TODAY, 33), T0).full, true);
  assert.equal(parseOhlcv(candles(TODAY, 32), T0).full, false);
});

// The records.

const record = (seed, over = {}) => ({
  chain: "ethereum",
  id: ID(seed),
  lastRankedAt: ISO(T0 - 3600_000),
  attemptedAt: null,
  result: null,
  fetchedAt: null,
  bad: 0,
  start: null,
  days: [],
  ...over,
});
const key = (rec) => `${rec.chain}:${rec.id}`;

const poolOf = (seed, h24, over = {}) => ({
  id: `ethereum:${ID(seed)}`,
  chain: "ethereum",
  chainId: 1,
  address: ID(seed),
  tokens: [address(seed * 2), address(seed * 2 + 1)],
  volumeUsd: { h1: 0, h6: 0, h24 },
  metricUpdatedAt: ISO(T0 - 60_000),
  metricStatus: "live",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});
const measuredOf = (...pools) =>
  new Map(pools.map((pool) => [`${pool.chain}:${pool.address}`, pool]));

test("a record is valid only in the exact shape the state keeps", () => {
  const good = record(1, {
    attemptedAt: ISO(T0),
    result: "ok",
    fetchedAt: ISO(T0),
    start: 20700,
    days: [
      [20700, 1],
      [20701, 0],
    ],
  });
  assert.equal(isDailyRecord(good), true);
  assert.equal(isDailyRecord(record(1)), true);
  for (const broken of [
    { ...good, id: ID(1).toUpperCase().replace("0X", "0x") },
    { ...good, chain: "Not A Slug" },
    { ...good, result: "maybe" },
    { ...good, result: null },
    { ...good, attemptedAt: null },
    { ...good, days: [[20701, 1], [20700, 1]] },
    { ...good, days: [[20700, -1]] },
    { ...good, days: [[20700, 1e13]] },
    { ...good, days: [[20700.5, 1]] },
    { ...good, days: Array.from({ length: 36 }, (_, i) => [20700 + i, 1]) },
    { ...good, bad: -1 },
    { ...good, start: "x" },
    { ...good, extra: 1 },
    { ...good, fetchedAt: "yesterday" },
  ])
    assert.equal(isDailyRecord(broken), false, JSON.stringify(broken).slice(0, 80));
  assert.equal(
    isDailyState({ schemaVersion: 1, updatedAt: null, pools: [good, good] }),
    false,
    "a pool twice",
  );
  assert.equal(
    isDailyState({
      schemaVersion: 1,
      updatedAt: null,
      pools: Array.from({ length: 61 }, (_, i) => record(i + 1)),
    }),
    false,
    "more than 60 records",
  );
});

// Ranking and selection.

test("the ranking is by 24h volume; stale, unmeasured, zero and unaskable pools are not ranked", () => {
  const pools = [
    poolOf(1, 500),
    poolOf(2, 900),
    poolOf(3, 900), // ties by id
    poolOf(4, 0), // a measured zero is no volume to rank
    poolOf(5, null),
    poolOf(6, 700, { metricUpdatedAt: ISO(T0 - 6 * 60_000) }), // stale
    poolOf(7, 800, { chain: "nowhere" }), // no GeckoTerminal namespace
    poolOf(8, 800, { metricStatus: "unavailable" }),
  ];
  const ranked = rankPools(measuredOf(...pools), T0);
  assert.deepEqual(
    ranked.map((row) => [row.rank, row.id]),
    [
      [1, [ID(2), ID(3)].sort()[0]],
      [2, [ID(2), ID(3)].sort()[1]],
      [3, ID(1)],
    ],
  );
  assert.deepEqual(currentMeasured(measuredOf(...pools), T0), {
    pools: 6,
    withVolume: 5,
  });
});

const ranking = (count) =>
  Array.from({ length: count }, (_, index) => ({
    key: `ethereum:${ID(index + 1)}`,
    chain: "ethereum",
    id: ID(index + 1),
    h24: 1000 - index,
    rank: index + 1,
  }));

test("a pool joins at rank 40, stays to rank 60, leaves beyond it, and the file never holds more than 60", () => {
  const first = selectDaily({
    previous: [],
    ranked: ranking(70),
    generatedAtMs: T0,
  });
  assert.equal(first.length, 40);
  assert.deepEqual(
    first.map((rec) => rec.id),
    ranking(40).map((row) => row.id),
  );
  assert.ok(first.every((rec) => rec.result === null && rec.days.length === 0));
  // The next run: the pools at ranks 41 to 60 that are on file stay, none joins
  // at 41 to 60, and one that fell to rank 61 goes.
  const reshuffled = ranking(70);
  const previous = [...first, record(45), record(61)];
  const second = selectDaily({
    previous,
    ranked: reshuffled,
    generatedAtMs: T0 + 3600_000,
  });
  const ids = new Set(second.map((rec) => rec.id));
  assert.equal(ids.has(ID(45)), true, "rank 45 stays");
  assert.equal(ids.has(ID(61)), false, "rank 61 leaves");
  assert.equal(ids.has(ID(46)), false, "rank 46 does not join");
  assert.equal(second.length, 41);
});

test("a pool that is not measured keeps its record for three days, then loses it; the cap is 60", () => {
  const ranked = ranking(10);
  const keep = record(500, { lastRankedAt: ISO(T0 - 2.9 * 86400_000) });
  const drop = record(501, { lastRankedAt: ISO(T0 - 3.1 * 86400_000) });
  const out = selectDaily({ previous: [keep, drop], ranked, generatedAtMs: T0 });
  assert.equal(out.some((rec) => rec.id === keep.id), true);
  assert.equal(out.some((rec) => rec.id === drop.id), false);
  // Over 60: ten new joiners at the top push out the lowest ranked and the
  // longest unranked.
  const crowd = Array.from({ length: 56 }, (_, i) => record(100 + i));
  const rankedCrowd = [
    ...ranking(10),
    ...crowd.map((rec, i) => ({
      key: key(rec),
      chain: rec.chain,
      id: rec.id,
      h24: 100 - i,
      rank: 11 + i,
    })),
  ];
  const full = selectDaily({
    previous: [...crowd, keep],
    ranked: rankedCrowd,
    generatedAtMs: T0,
  });
  assert.equal(full.length, 60);
  assert.equal(full.some((rec) => rec.id === keep.id), false, "unranked goes first");
  assert.equal(full[0].id, ID(1), "best ranked first");
});

test("the time a pool was last ranked moves at most once a day, so the committed state stays quiet", () => {
  const rec = record(1, { lastRankedAt: ISO(T0 - 3 * 3600_000) });
  const quiet = selectDaily({
    previous: [rec],
    ranked: ranking(5),
    generatedAtMs: T0,
  });
  assert.equal(quiet.find((r) => r.id === rec.id).lastRankedAt, rec.lastRankedAt);
  const old = record(1, { lastRankedAt: ISO(T0 - 25 * 3600_000) });
  const moved = selectDaily({
    previous: [old],
    ranked: ranking(5),
    generatedAtMs: T0,
  });
  assert.equal(moved.find((r) => r.id === old.id).lastRankedAt, ISO(T0));
});

// When a pool is read.

test("the two checkpoints of the day, to the millisecond", () => {
  const day = dayStartMs(TODAY);
  assert.equal(latestCheckpoint(day), day);
  assert.equal(latestCheckpoint(day + 4 * 3600_000 - 1), day);
  assert.equal(latestCheckpoint(day + 4 * 3600_000), day + 4 * 3600_000);
  assert.equal(latestCheckpoint(day + 86400_000 - 1), day + 4 * 3600_000);
  assert.deepEqual(config.DAILY_CHECKPOINT_HOURS, [0, 4]);
});

test("a pool is due once per checkpoint: never read, after 00:00, after 04:00, never twice in between", () => {
  const day = dayStartMs(TODAY);
  const at = (hours, minutes = 0) => day + (hours * 60 + minutes) * 60_000;
  const read = (when) =>
    record(1, {
      attemptedAt: ISO(when),
      result: "ok",
      fetchedAt: ISO(when),
      days: [[TODAY - 1, 1]],
    });
  assert.equal(isDue(record(1), at(1)), true, "never read");
  const afterMidnight = read(at(0, 10));
  assert.equal(isDue(afterMidnight, at(3, 59)), false);
  assert.equal(isDue(afterMidnight, at(4, 0)), true, "the 04:00 checkpoint");
  const afterFour = read(at(4, 10));
  assert.equal(isDue(afterFour, at(23, 59)), false);
  assert.equal(isDue(afterFour, at(24, 0)), true, "the next 00:00");
  // The same just before midnight: the pool read at 23:59 is due at 00:00.
  assert.equal(isDue(read(at(-0.0167)), at(0, 0)), true);
  // A read whose answer was true before midnight (a cached copy) is due again
  // at once, in the same checkpoint window.
  const cached = record(1, {
    attemptedAt: ISO(at(0, 5)),
    result: "ok",
    fetchedAt: ISO(at(0, 5) - 15 * 60_000),
    days: [[TODAY - 2, 1]],
  });
  assert.equal(isDue(cached, at(1, 10)), true);
  // No data and an unknown pool are asked once a day.
  for (const result of ["none", "missing"]) {
    const rec = record(1, { attemptedAt: ISO(at(0, 10)), result });
    assert.equal(isDue(rec, at(4, 0)), false, result);
    assert.equal(isDue(rec, at(23, 59)), false, result);
    assert.equal(isDue(rec, at(24, 0)), true, result);
  }
  // An unreadable answer is asked again at the next checkpoint.
  const bad = record(1, { attemptedAt: ISO(at(0, 10)), result: "unreadable", bad: 1 });
  assert.equal(isDue(bad, at(3, 59)), false);
  assert.equal(isDue(bad, at(4, 0)), true);
});

test("covered: a pool with a reading, unless it has been unreadable twice in a row", () => {
  const base = { fetchedAt: ISO(T0), days: [[TODAY - 1, 1]] };
  assert.equal(isCovered(record(1, { ...base, result: "ok" })), true);
  assert.equal(isCovered(record(1, { ...base, result: "unreadable", bad: 1 })), true);
  assert.equal(isCovered(record(1, { ...base, result: "unreadable", bad: 2 })), false);
  assert.equal(isCovered(record(1, { ...base, result: "none" })), false);
  assert.equal(isCovered(record(1, { ...base, result: "missing" })), false);
  assert.equal(isCovered(record(1)), false);
});

// Merging a reading into the days on file.

test("a new answer wins for every day it lists, older days stay, and revisions are counted", async () => {
  const sample = await recorded("01-eth-busy.json");
  const first = parseOhlcv(sample.body, sample.observedAt);
  const fresh = record(1);
  const one = mergeRead(fresh, first, {
    attemptedAt: sample.observedAt + 1000,
    observedAt: sample.observedAt,
  });
  assert.equal(one.record.result, "ok");
  assert.equal(one.record.days.length, 32);
  assert.equal(one.record.start, null, "a cut answer does not say where the history begins");
  assert.equal(one.record.fetchedAt, ISO(sample.observedAt));
  assert.equal(one.revised, 0);
  assert.equal(isDailyRecord(one.record), true);
  // The next day: one more complete day, one old day revised, the oldest kept.
  const nextBody = structuredClone(sample.body);
  const list = nextBody.data.attributes.ohlcv_list;
  list.pop(); // the oldest row falls off the 33
  list.unshift([(NOV11 + 1) * 86400, 1, 1, 1, 1, 123]); // 12 Nov in progress
  list[1][5] = 456; // 11 Nov, now complete
  const revisedDay = list[5];
  const before = revisedDay[5];
  revisedDay[5] = before + 1;
  const next = parseOhlcv(nextBody, T0);
  const two = mergeRead(one.record, next, { attemptedAt: T0, observedAt: T0 });
  assert.equal(two.revised, 1);
  assert.equal(two.record.days.length, 33, "the day that fell off the answer is kept");
  assert.equal(two.record.days.at(-1)[0], NOV11);
  assert.equal(two.record.days.at(-1)[1], 456);
  assert.equal(two.record.days[0][0], dayNumber(Date.parse("2026-10-10")));
});

test("days older than 35 are dropped, and the pool's first day is learned from an answer that was not cut", () => {
  const old = record(1, {
    days: [
      [NOV11 - 40, 5],
      [NOV11 - 34, 6],
      [NOV11 - 33, 7],
    ],
    start: null,
  });
  const read = parseOhlcv(candles(TODAY, 5), T0);
  const { record: merged } = mergeRead(old, read, { attemptedAt: T0, observedAt: T0 });
  assert.deepEqual(
    merged.days.map(([day]) => day),
    [NOV11 - 34, NOV11 - 33, NOV11 - 3, NOV11 - 2, NOV11 - 1, NOV11],
  );
  assert.equal(merged.start, TODAY - 4, "five rows: the history starts at the oldest");
  // A later, cut answer cannot move it.
  const cut = parseOhlcv(candles(TODAY, 33), T0);
  assert.equal(mergeRead(merged, cut, { attemptedAt: T0, observedAt: T0 }).record.start, TODAY - 4);
});

test("an answer with only the day in progress is no data yet, not a reading", () => {
  const read = parseOhlcv(candles(TODAY, 1), T0);
  const { record: merged } = mergeRead(record(1), read, {
    attemptedAt: T0,
    observedAt: T0,
  });
  assert.equal(merged.result, "none");
  assert.equal(merged.fetchedAt, null);
  assert.equal(merged.start, TODAY);
  assert.equal(isCovered(merged), false);
});

// Reading on a fake clock.

function setup({ answer, clockStart = T0, clientOptions = {} } = {}) {
  const clock = new FakeClock(clockStart);
  const fetchImpl = fakeFetch(clock, (call, n) => {
    const id = /pools\/(0x[0-9a-f]{64})\//.exec(call.url)?.[1];
    return answer(id, call, n);
  });
  const client = createHttpClient({
    fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
    userAgent: "Test/1 (+https://github.com/example/repo)",
    ...clientOptions,
  });
  return { clock, fetchImpl, client };
}
const okAnswer = (days = 32) => ({ body: candles(TODAY, days + 1, () => 5) });

/** Pools 1..n with falling volume, and a record for each. */
function field(n) {
  const pools = Array.from({ length: n }, (_, i) => poolOf(i + 1, 10000 - i * 100));
  return {
    pools,
    measured: measuredOf(...pools),
    records: pools.map((pool, i) => record(i + 1)),
  };
}

test("the largest pools are read first, one request at a time, at least 12 seconds apart, with the pinned Accept header", async () => {
  const { measured, records } = field(25);
  const { client, fetchImpl, clock } = setup({ answer: () => okAnswer() });
  const { records: out, report } = await collectDaily({
    client,
    records: [...records].reverse(),
    measured,
    now: clock.now,
  });
  assert.equal(fetchImpl.calls.length, 20);
  assert.deepEqual(
    fetchImpl.calls.map((call) => /pools\/(0x[0-9a-f]{64})\//.exec(call.url)[1]),
    records.slice(0, 20).map((rec) => rec.id),
    "largest 24h volume first",
  );
  const gaps = fetchImpl.calls.slice(1).map((call, i) => call.at - fetchImpl.calls[i].at);
  assert.ok(gaps.every((gap) => gap >= 12000), String(Math.min(...gaps)));
  for (const call of fetchImpl.calls) {
    assert.equal(call.headers.accept, GT_DAILY_ACCEPT);
    assert.equal(call.method, "GET");
    assert.match(call.url, /\/ohlcv\/day\?limit=33&currency=usd&include_empty_intervals=true$/);
  }
  assert.equal(report.requested, 20);
  assert.equal(report.read, 20);
  assert.equal(report.due, 25);
  assert.match(report.stopped, /limit of 20 requests/);
  // The five smallest stay as they were, due next run.
  const untouched = out.filter((rec) => rec.result === null);
  assert.deepEqual(
    untouched.map((rec) => rec.id).sort(),
    records.slice(20).map((rec) => rec.id).sort(),
  );
  for (const rec of out.filter((r) => r.result === "ok")) {
    assert.equal(rec.days.length, 32);
    assert.equal(isDailyRecord(rec), true);
  }
});

test("the step cannot be asked for more than 20 requests, nor start a read it has no time for", async () => {
  const { measured, records } = field(10);
  const tight = setup({ answer: () => okAnswer() });
  const tightRun = await collectDaily({
    client: tight.client,
    records,
    measured,
    now: tight.clock.now,
    maxRequests: 99,
    budgetMs: 30000,
  });
  // Starts at 0, 12 and 24 s; the fourth would start at 36 s, past the limit.
  assert.equal(tight.fetchImpl.calls.length, 3);
  assert.match(tightRun.report.stopped, /no further request could start/);
  assert.equal(tightRun.report.requested, 3);
  const few = setup({ answer: () => okAnswer() });
  const fewRun = await collectDaily({
    client: few.client,
    records,
    measured,
    now: few.clock.now,
    maxRequests: 4,
  });
  assert.equal(few.fetchImpl.calls.length, 4);
  assert.equal(fewRun.report.read, 4);
  // A client with 2 requests left in its cap sends 2.
  const capped = setup({
    answer: () => okAnswer(),
    clientOptions: { maxRequests: 2 },
  });
  const cappedRun = await collectDaily({
    client: capped.client,
    records,
    measured,
    now: capped.clock.now,
  });
  assert.equal(capped.fetchImpl.calls.length, 2);
  assert.match(cappedRun.report.stopped, /budget is spent/);
  assert.equal(capped.client.requestsLeft(), 0);
});

test("a rate-limit answer: one cooldown, a doubled gap that the allowance follows, and the retry counts as a request", async () => {
  const { measured, records } = field(30);
  const refuseFirst = () => {
    let first = true;
    return () => {
      if (first) {
        first = false;
        return {
          status: 429,
          headers: { "retry-after": "0" },
          body: { status: { error_code: 429 } },
        };
      }
      return okAnswer();
    };
  };
  const slow = setup({ answer: refuseFirst() });
  const { records: out, report } = await collectDaily({
    client: slow.client,
    records,
    measured,
    now: slow.clock.now,
  });
  const { fetchImpl, client } = slow;
  // The gap doubles to 24 s for the rest of the run, so only the requests that
  // can start within the step's 240 s are sent: starts at 0 (refused), 24
  // (the retry), 48, and so on up to 240, eleven in all.
  assert.equal(report.requested, 11);
  assert.equal(fetchImpl.calls.length, 11);
  assert.equal(report.read, 10, "the refused request and its retry are one pool");
  assert.match(report.stopped, /no further request could start/);
  const retryGap = fetchImpl.calls[1].at - fetchImpl.calls[0].at;
  assert.ok(retryGap >= 24000, `the retry waited ${retryGap} ms`);
  const later = fetchImpl.calls
    .slice(2)
    .map((call, i) => call.at - fetchImpl.calls[i + 1].at);
  assert.ok(later.every((gap) => gap >= 24000), "the doubled gap holds for the rest of the run");
  assert.equal(client.stats().geckoterminal.rateLimitWaits, 1);
  assert.equal(out.filter((rec) => rec.result === "ok").length, 10);
  // The retry is a request of the step's own limit: with 5 allowed, 4 pools.
  const limited = setup({ answer: refuseFirst() });
  const five = await collectDaily({
    client: limited.client,
    records,
    measured,
    now: limited.clock.now,
    maxRequests: 5,
  });
  assert.equal(limited.fetchImpl.calls.length, 5);
  assert.equal(five.report.read, 4);
  assert.match(five.report.stopped, /limit of 5 requests/);
});

test("a second rate-limit answer stops the step; what was read is kept and nothing fails", async () => {
  const { measured, records } = field(10);
  let n = 0;
  const { client, clock } = setup({
    answer: () => {
      n++;
      return n === 3 || n === 4
        ? { status: 429, headers: { "retry-after": "0" }, body: {} }
        : okAnswer();
    },
  });
  const { records: out, report } = await collectDaily({
    client,
    records,
    measured,
    now: clock.now,
  });
  assert.match(report.stopped, /stopped for this run/);
  assert.equal(report.read, 2);
  assert.equal(out.filter((rec) => rec.result === "ok").length, 2);
  assert.equal(client.isStopped("geckoterminal"), true);
  // Asked again with the lane stopped, the step sends nothing.
  const again = await collectDaily({ client, records: out, measured, now: clock.now });
  assert.equal(again.report.requested, 0);
  assert.match(again.report.stopped, /stopped for this run/);
});

test("five failures on the network in a row end the step, and the pools stay due", async () => {
  const { measured, records } = field(12);
  const { client, clock, fetchImpl } = setup({
    answer: () => ({ status: 503, body: "busy" }),
  });
  const { records: out, report } = await collectDaily({
    client,
    records,
    measured,
    now: clock.now,
  });
  assert.equal(fetchImpl.calls.length, 5);
  assert.equal(report.failed, 5);
  assert.match(report.stopped, /5 requests in a row failed/);
  assert.ok(out.every((rec) => rec.result === null && rec.attemptedAt === null));
  assert.ok(out.every((rec) => isDue(rec, T0)));
});

test("an answer that is HTTP 200 but unreadable is an answer: it is not asked again at this checkpoint and does not stop the step", async () => {
  const { measured, records } = field(12);
  const stuck = new Set(records.slice(0, 5).map((rec) => rec.id));
  const { client, clock } = setup({
    answer: (id) =>
      stuck.has(id) ? { body: candles(TODAY, 4, () => "x") } : okAnswer(),
  });
  const { records: out, report } = await collectDaily({
    client,
    records,
    measured,
    now: clock.now,
  });
  assert.equal(report.unreadable, 5);
  assert.equal(report.read, 7, "the five largest are stuck and the rest are read");
  assert.equal(report.stopped, null);
  for (const rec of out.slice(0, 5)) {
    assert.equal(rec.result, "unreadable");
    assert.equal(rec.bad, 1);
    assert.equal(rec.attemptedAt !== null, true);
    assert.equal(isDue(rec, clock.now()), false, "once per checkpoint window");
    assert.equal(isDue(rec, dayStartMs(TODAY) + 4 * 3600_000), true);
  }
});

test("an unreadable answer keeps the days on file, and a second one takes the pool out of the covered set", async () => {
  const days = Array.from({ length: 32 }, (_, i) => [NOV11 - 31 + i, 7]);
  const have = record(1, {
    attemptedAt: ISO(T0 - 86400_000),
    result: "ok",
    fetchedAt: ISO(T0 - 86400_000),
    days,
  });
  const measured = measuredOf(poolOf(1, 1000));
  const { client, clock } = setup({ answer: () => ({ body: candles(TODAY, 3, () => -1) }) });
  const one = await collectDaily({ client, records: [have], measured, now: clock.now });
  assert.equal(one.records[0].result, "unreadable");
  assert.deepEqual(one.records[0].days, days, "nothing is replaced by a shorter history");
  assert.equal(one.records[0].fetchedAt, have.fetchedAt);
  assert.equal(isCovered(one.records[0]), true);
  const later = setup({
    answer: () => ({ body: candles(TODAY, 3, () => -1) }),
    clockStart: T0 + 4 * 3600_000,
  });
  const two = await collectDaily({
    client: later.client,
    records: one.records,
    measured: measuredOf(poolOf(1, 1000, { metricUpdatedAt: ISO(T0 + 4 * 3600_000 - 60_000) })),
    now: later.clock.now,
  });
  assert.equal(two.records[0].bad, 2);
  assert.equal(isCovered(two.records[0]), false);
});

test("an empty list for a pool with days on file is a vanished history and is not believed; for a new pool it is no data", async () => {
  const have = record(1, {
    attemptedAt: ISO(T0 - 86400_000),
    result: "ok",
    fetchedAt: ISO(T0 - 86400_000),
    days: [[NOV11 - 1, 7]],
  });
  const { client, clock } = setup({ answer: () => ({ body: candles(TODAY, 0) }) });
  const out = await collectDaily({
    client,
    records: [have, record(2)],
    measured: measuredOf(poolOf(1, 100), poolOf(2, 50)),
    now: clock.now,
  });
  assert.equal(out.records[0].result, "unreadable");
  assert.deepEqual(out.records[0].days, have.days);
  assert.equal(out.records[1].result, "none");
  assert.equal(out.report.noData, 1);
});

test("a pool GeckoTerminal does not know is missing, an answer and not a failure: five in a row do not stop the step", async () => {
  const { measured, records } = field(9);
  const unknown = new Set(records.slice(0, 6).map((rec) => rec.id));
  const { client, clock } = setup({
    answer: (id) =>
      unknown.has(id)
        ? { status: 404, body: { errors: [{ status: "404", title: "Not Found" }] } }
        : okAnswer(),
  });
  const { records: out, report } = await collectDaily({
    client,
    records,
    measured,
    now: clock.now,
  });
  assert.equal(report.missing, 6);
  assert.equal(report.read, 3);
  assert.equal(report.failed, 0);
  assert.equal(report.stopped, null);
  assert.equal(client.isStopped("geckoterminal"), false);
  assert.ok(out.slice(0, 6).every((rec) => rec.result === "missing"));
  // Not due again today.
  assert.ok(out.slice(0, 6).every((rec) => !isDue(rec, T0 + 20 * 3600_000)));
});

test("a pool the snapshot does not carry is not read, and a record is not read twice in a checkpoint window", async () => {
  const { pools, records } = field(4);
  const measured = measuredOf(pools[0], pools[2]);
  const { client, clock, fetchImpl } = setup({ answer: () => okAnswer() });
  const first = await collectDaily({ client, records, measured, now: clock.now });
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(first.report.due, 2);
  const again = await collectDaily({
    client,
    records: first.records,
    measured,
    now: clock.now,
  });
  assert.equal(again.report.due, 0);
  assert.equal(again.report.requested, 0);
  assert.equal(fetchImpl.calls.length, 2, "idempotent: nothing is asked twice");
  assert.deepEqual(again.records, first.records);
});

test("an answer that is a cached copy is dated by its own Date and Age, so its last day is not complete", async () => {
  const at = Date.parse("2026-11-12T00:05:00.000Z");
  const { pools, records } = field(1);
  // 900 seconds old: true at 23:50 on 11 November, when that day was in progress.
  const { client, clock } = setup({
    clockStart: at,
    answer: () => ({
      headers: { age: "900" },
      body: candles(NOV11, 33, () => 5),
    }),
  });
  const measured = measuredOf({
    ...pools[0],
    metricUpdatedAt: ISO(at - 60_000),
  });
  const { records: out } = await collectDaily({
    client,
    records,
    measured,
    now: clock.now,
  });
  assert.equal(out[0].fetchedAt, "2026-11-11T23:50:00.000Z");
  assert.equal(out[0].days.at(-1)[0], NOV11 - 1, "11 November is not stored");
  assert.equal(isDue(out[0], at + 3600_000), true, "read again after midnight");
});

// Figures.

const run = (from, to, usd = 1) =>
  Array.from({ length: to - from + 1 }, (_, i) => [from + i, usd]);

test("7D and 30D are exact sums of the last complete days, and a quiet window is a real zero", () => {
  const end = NOV11 - 1;
  const rec = record(1, {
    days: run(end - 31, end).map(([day], i) => [day, i + 1]),
  });
  const figures = windowFigures(rec, end, Date.parse("2026-01-01"));
  // The newest 7 days carry 26..32, the newest 30 carry 3..32.
  assert.equal(figures.v7, 26 + 27 + 28 + 29 + 30 + 31 + 32);
  assert.equal(
    figures.v30,
    Array.from({ length: 30 }, (_, i) => i + 3).reduce((a, b) => a + b),
  );
  assert.equal("n7" in figures || "n30" in figures, false);
  const quiet = windowFigures(record(2, { days: run(end - 31, end, 0) }), end, null);
  assert.deepEqual(quiet, { v7: 0, v30: 0 });
  // A figure is rounded to the cent, like every other sum.
  const cents = windowFigures(record(3, { days: run(end - 31, end, 0.1) }), end, null);
  assert.equal(cents.v30, 3);
});

test("a missing day inside the window means no figure: a gap is never counted as zero", () => {
  const end = NOV11 - 1;
  const days = run(end - 31, end).filter(([day]) => day !== end - 3);
  assert.equal(windowFigures(record(1, { days }), end, null), null);
  // A gap older than the 7-day window still takes the 30-day figure away, and
  // with it the pool: a pool is listed with both figures or not at all.
  assert.equal(windowFigures(record(1, { days: run(end - 5, end) }), end, null), null);
});

test("a pool younger than the window: its figure covers the days it was live, and says how many", () => {
  const end = NOV11 - 1;
  const rec = record(1, { start: end - 9, days: run(end - 9, end, 2) });
  // Ten days old (the first day on file is its first day).
  assert.deepEqual(windowFigures(rec, end, null), { v7: 14, v30: 20, n30: 10 });
  // Its creation day, when known and earlier, is the launch day.
  const created = windowFigures(rec, end, Date.UTC(2026, 9, 28, 8));
  assert.equal(created.n30, end - dayNumber(Date.UTC(2026, 9, 28)) + 1);
  assert.equal("n7" in created, false);
  // Five days old: both windows say so.
  const five = record(1, { start: end - 4, days: run(end - 4, end, 3) });
  assert.deepEqual(windowFigures(five, end, null), { v7: 15, v30: 15, n7: 5, n30: 5 });
  // Launched after the end day: no complete day yet, no figure.
  assert.equal(windowFigures(record(1, { start: end + 1, days: [] }), end, null), null);
  // An old pool whose answer was cut is never young, whatever its creation day says.
  const cut = record(1, { start: null, days: run(end - 31, end) });
  assert.equal("n30" in windowFigures(cut, end, Date.UTC(2026, 10, 5)), false);
  // A pool created long ago that first traded recently: days before its first
  // candle were quiet, the sums are exact, and it is not "young".
  const late = record(1, { start: end - 9, days: run(end - 9, end, 2) });
  const old = windowFigures(late, end, Date.UTC(2026, 0, 1));
  assert.deepEqual(old, { v7: 14, v30: 20 });
});

test("an answer one day behind still gives the figure at the earlier end day", () => {
  const end = NOV11 - 1;
  const rec = record(1, { days: run(end - 31, end + 1) });
  assert.equal(windowFigures(rec, end, null).v30, 30);
  assert.equal(windowFigures(rec, end + 1, null).v30, 30);
});

// The file.

// The snapshot of the file tests: 12 November, 01:30 UTC. Its pools were
// measured a minute before it.
const GEN = Date.parse("2026-11-12T01:30:00.000Z");
const datasetPool = (seed, h24, over = {}) =>
  poolOf(seed, h24, { metricUpdatedAt: ISO(GEN - 60_000), ...over });
const covered = (seed, over = {}) =>
  record(seed, {
    attemptedAt: over.fetchedAt ?? ISO(T0),
    result: "ok",
    fetchedAt: ISO(T0 - 20 * 60_000),
    days: run(NOV11 - 32, NOV11, 10),
    ...over,
  });

test("the end day is the newest complete day when 90 percent of the volume was read after it ended", () => {
  // 12 November, 01:30 UTC: 11 November is the newest complete day.
  const generatedAtMs = Date.parse("2026-11-12T01:30:00.000Z");
  const big = covered(1);
  const small = covered(2, { fetchedAt: "2026-11-11T22:00:00.000Z" });
  const measured = measuredOf(datasetPool(1, 900), datasetPool(2, 100));
  const out = buildDailyDataset({ records: [big, small], measured, generatedAtMs });
  assert.equal(out.through, "2026-11-11");
  assert.equal(out.readyShare, 0.9);
  assert.deepEqual(
    out.file.pools.map((p) => p.id),
    [key(big)],
    "the pool read before the day ended is left out until it is read again",
  );
  assert.equal(out.file.pools[0].v7, 70);
  assert.equal(out.file.pools[0].v30, 300);
  assert.equal(out.file.pools[0].at, big.fetchedAt, "the pool's own reading time");
  assert.equal(out.file.snapshotGeneratedAt, ISO(generatedAtMs));
});

test("below 90 percent the dataset ends one day earlier, and no total mixes two end days", () => {
  const generatedAtMs = Date.parse("2026-11-12T01:30:00.000Z");
  const measured = measuredOf(datasetPool(1, 800), datasetPool(2, 200));
  const out = buildDailyDataset({
    records: [covered(1), covered(2, { fetchedAt: "2026-11-11T22:00:00.000Z" })],
    measured,
    generatedAtMs,
  });
  assert.equal(out.readyShare, 0.8);
  assert.equal(out.through, "2026-11-10");
  assert.equal(out.file.pools.length, 2, "both were read after 10 November ended");
  assert.ok(out.file.pools.every((p) => Date.parse(p.at) >= Date.parse("2026-11-11T00:00:00Z")));
  assert.equal(out.file.pools[0].v7, 70, "figures are at 10 November for both");
});

test("a pool GeckoTerminal has no data for, does not know, or answers unreadably twice is not covered and cannot hold the date back", () => {
  const generatedAtMs = Date.parse("2026-11-12T01:30:00.000Z");
  const measured = measuredOf(
    datasetPool(1, 900),
    datasetPool(2, 100),
    datasetPool(3, 5000),
    datasetPool(4, 5000),
    datasetPool(5, 5000),
    datasetPool(6, 300),
  );
  const old = "2026-11-10T08:00:00.000Z";
  const records = [
    covered(1),
    covered(2),
    covered(3, { result: "missing", fetchedAt: null, days: [] }),
    covered(4, { result: "none", fetchedAt: null, days: [] }),
    covered(5, { result: "unreadable", bad: 2, fetchedAt: old }),
    // Unreadable once is still covered: it counts, and it is old, so it holds
    // the share down (900 + 100 of 1,300).
    covered(6, { result: "unreadable", bad: 1, fetchedAt: old }),
  ];
  const out = buildDailyDataset({ records, measured, generatedAtMs });
  assert.equal(out.covered, 3);
  assert.equal(out.through, "2026-11-10");
  assert.deepEqual(
    out.file.pools.map((p) => p.id),
    [1, 2, 6].map((seed) => `ethereum:${ID(seed)}`).sort().filter((id) => id !== `ethereum:${ID(6)}`),
    "the pool read on 10 November, before 10 November ended, has no figure at 10 November",
  );
  // Without the unreadable-once pool the ready share is 100 percent.
  const clean = buildDailyDataset({
    records: records.filter((rec) => rec.id !== ID(6)),
    measured,
    generatedAtMs,
  });
  assert.equal(clean.through, "2026-11-11");
  assert.equal(clean.readyShare, 1);
  assert.equal(clean.file.pools.length, 2);
});

test("nothing ready, nothing covered, nothing measured: no file, which is also the expiry", () => {
  const generatedAtMs = Date.parse("2026-11-12T01:30:00.000Z");
  const measured = measuredOf(datasetPool(1, 900));
  assert.equal(buildDailyDataset({ records: [], measured, generatedAtMs }).file, null);
  assert.equal(
    buildDailyDataset({ records: [record(1)], measured, generatedAtMs }).file,
    null,
  );
  // Read two days ago: older than one day behind the newest complete day.
  const stale = covered(1, { fetchedAt: "2026-11-10T09:00:00.000Z" });
  assert.equal(buildDailyDataset({ records: [stale], measured, generatedAtMs }).file, null);
  // Read, but the snapshot does not carry the pool.
  assert.equal(
    buildDailyDataset({ records: [covered(1)], measured: new Map(), generatedAtMs }).file,
    null,
  );
});

test("with no volume anywhere the pools weigh the same", () => {
  const generatedAtMs = Date.parse("2026-11-12T01:30:00.000Z");
  const measured = measuredOf(datasetPool(1, 0), datasetPool(2, 0));
  const out = buildDailyDataset({
    records: [covered(1), covered(2, { fetchedAt: "2026-11-11T22:00:00.000Z" })],
    measured,
    generatedAtMs,
  });
  assert.equal(out.readyShare, 0.5);
  assert.equal(out.through, "2026-11-10");
});

test("the file passes the shared validator, young pools carry their days, and the source row says what the file covers", () => {
  const generatedAtMs = Date.parse("2026-11-12T01:30:00.000Z");
  const young = covered(2, { start: NOV11 - 3, days: run(NOV11 - 3, NOV11, 4) });
  const measured = measuredOf(
    datasetPool(1, 900),
    datasetPool(2, 300, { createdAt: ISO(Date.UTC(2026, 10, 8, 12)) }),
  );
  const out = buildDailyDataset({ records: [covered(1), young], measured, generatedAtMs });
  const one = out.file.pools.find((p) => p.id.endsWith(ID(2)));
  assert.deepEqual(
    { v7: one.v7, v30: one.v30, n7: one.n7, n30: one.n30 },
    { v7: 16, v30: 16, n7: 4, n30: 4 },
  );
  const source = dailySource(out);
  assert.equal(source.id, "geckoterminal-daily");
  assert.equal(source.status, "live");
  assert.equal(source.updatedAt, out.lastRead);
  assert.match(source.note, /^Complete UTC days up to 11 Nov 2026 for 2 of the largest pools, read 12 Nov 00:54 UTC\./);
  assert.match(source.note, /unavailable, not zero\.$/);
  assert.equal(dailySource({ file: null }), null);
  assert.equal(dayLabel(NOV11), "2026-11-11");
});

// State on disk.

async function stateDir(daily) {
  const dir = await mkdtemp(join(tmpdir(), "collector-daily-"));
  await writeFile(join(dir, "pools.json"), poolsJson(null, []));
  if (daily !== undefined) await writeFile(join(dir, "daily.json"), daily);
  return dir;
}

test("a missing state/daily.json means no daily data yet, with no note", async (t) => {
  const dir = await stateDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = await readState(dir);
  assert.deepEqual(state.daily, { records: [], present: false, note: null });
});

test("a state/daily.json that cannot be used is ignored with a note and can never fail a run", async (t) => {
  const good = dailyJson(ISO(T0), [record(1), record(2)]);
  const cases = {
    "garbage text": "this is not json",
    "merge conflict markers": `<<<<<<< HEAD\n${good}\n=======\n${good}\n>>>>>>> origin/main\n`,
    "a truncated file": good.slice(0, good.length - 40),
    "valid JSON of the wrong shape": '{"schemaVersion":1,"pools":"x"}',
    "an array": "[]",
    "a record with a bad field": good.replace(ID(1), ID(1).toUpperCase().replace("0X", "0x")),
    "an unknown field": good.replace('"schemaVersion":1', '"schemaVersion":1,"extra":true'),
  };
  for (const [label, text] of Object.entries(cases)) {
    const dir = await stateDir(text);
    t.after(() => rm(dir, { recursive: true, force: true }));
    const state = await readState(dir);
    assert.deepEqual(state.daily.records, [], label);
    assert.match(state.daily.note, /starts empty/, label);
    assert.equal(state.daily.present, true, label);
  }
  const dir = await stateDir(`﻿${good}`);
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal((await readState(dir)).daily.records.length, 2, "a byte order mark is tolerated");
});

test("the daily state is written one record to a line and reads back as it was", async (t) => {
  const records = [
    record(2, { attemptedAt: ISO(T0), result: "ok", fetchedAt: ISO(T0), days: run(NOV11 - 3, NOV11, 2.5), start: NOV11 - 3 }),
    record(1),
  ];
  const text = dailyJson(ISO(T0), records);
  assert.equal(text.split("\n").length, 2 + records.length + 1, "header, one line each, closing");
  const dir = await stateDir(text);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const back = (await readState(dir)).daily;
  assert.equal(back.note, null);
  assert.deepEqual(
    back.records.map((rec) => rec.id),
    [ID(1), ID(2)].sort(),
    "sorted by network and id",
  );
  assert.equal(
    JSON.stringify(back.records.find((rec) => rec.id === ID(2))),
    JSON.stringify(records[0]),
  );
  // Sizes: 60 records of 35 days stay small.
  const full = Array.from({ length: 60 }, (_, i) =>
    record(i + 1, { attemptedAt: ISO(T0), result: "ok", fetchedAt: ISO(T0), days: run(NOV11 - 34, NOV11, 123456.78) }),
  );
  assert.ok(Buffer.byteLength(dailyJson(ISO(T0), full)) < 80 * 1024);
  assert.equal(isDailyState(JSON.parse(dailyJson(ISO(T0), full))), true);
});
