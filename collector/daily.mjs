import { isPoolId } from "../server/model.mjs";
import {
  ADDITIONAL_MARKET_CHAINS,
  MARKET_CHAINS,
} from "../server/market-chains.mjs";
import {
  DAILY_SOURCE,
  DAILY_SOURCE_ID,
  DAILY_SPANS,
  dailyRunProblem,
  dayLabel,
  dayNumber,
  dayStartMs,
  lastCompleteDay,
  validateDailyShape,
} from "../shared/daily-volume.ts";
import { marketMeasurementState } from "../shared/market-freshness.ts";
import {
  DAILY_BUDGET_MS,
  DAILY_CHECKPOINT_HOURS,
  DAILY_JOIN_RANK,
  DAILY_KEEP_RANK,
  DAILY_MAX_REQUESTS,
  DAILY_MAX_UNREADABLE,
  DAILY_RANK_GRACE_MS,
  DAILY_READY_SHARE,
  DAILY_STORED_DAYS,
  LAST_SEEN_GRANULARITY_MS,
  MAX_BYTES,
  MAX_CONSECUTIVE_FAILURES,
} from "./config.mjs";
import { roundCents } from "./history.mjs";
import {
  geckoOhlcvUrl,
  GT_DAILY_ACCEPT,
  parseOhlcv,
  UnreadableOhlcv,
} from "./providers/geckoterminal.mjs";
import { poolKey } from "./state.mjs";

// 7D and 30D volume of the largest pools.
//
// Providers report 1h, 6h and 24h volume only. A longer window needs the daily
// candles of the pool, one GeckoTerminal request each, so only the pools that
// matter get them: the largest by 24h volume (the top 40 hold about 95 percent of
// the volume the snapshot tracks). A figure is the sum of the last 7 (30)
// COMPLETE UTC days; the day in progress is never counted, so a day, once
// stored, never changes, and a pool needs reading about twice a day (at the
// checkpoints in config.mjs), not every hour.
//
// The step runs last: after the measurement burst, its fallback and the Frontier
// step, with the snapshot time already fixed, so it can delay neither the
// measurements nor the page's five-minute rule. It spends only the requests the
// 399-request cap still allows, one at a time on the GeckoTerminal lane, and it
// never throws: whatever goes wrong is a note, and the records it had are kept.

const iso = (ms) => new Date(ms).toISOString();
const HOUR_MS = 60 * 60 * 1000;
const byRecordKey = (a, b) =>
  a.chain === b.chain
    ? a.id < b.id
      ? -1
      : a.id > b.id
        ? 1
        : 0
    : a.chain < b.chain
      ? -1
      : 1;

/** The networks the step can ask GeckoTerminal about: those with a verified
 * GeckoTerminal namespace, by their slug. */
export const dailyChains = () =>
  new Map(
    [...MARKET_CHAINS, ...ADDITIONAL_MARKET_CHAINS]
      .filter((chain) => /^[a-z0-9_-]+$/.test(chain.gecko || ""))
      .map((chain) => [chain.chain, chain]),
  );

const newRecord = (chain, id, stamp) => ({
  chain,
  id,
  lastRankedAt: stamp,
  attemptedAt: null,
  result: null,
  fetchedAt: null,
  bad: 0,
  start: null,
  days: [],
});

/** How many measured pools are current at the snapshot time, and how many of them
 * carry a 24h volume: what the quality gate counts, known before the snapshot is
 * assembled. */
export function currentMeasured(measured, generatedAtMs) {
  let pools = 0;
  let withVolume = 0;
  for (const pool of measured.values()) {
    if (marketMeasurementState(pool, generatedAtMs) !== "current") continue;
    pools++;
    const h24 = pool.volumeUsd?.h24;
    if (typeof h24 === "number" && Number.isFinite(h24) && h24 >= 0)
      withVolume++;
  }
  return { pools, withVolume };
}

/** The pools of this run that can have daily volume, largest 24h volume first
 * (ties by network then id): measured and current at the snapshot time, with a
 * 24h volume above zero, on a network GeckoTerminal has a namespace for. */
export function rankPools(measured, generatedAtMs, chains = dailyChains()) {
  const rows = [];
  for (const [key, pool] of measured) {
    const h24 = pool.volumeUsd?.h24;
    const id = String(pool.address ?? "").toLowerCase();
    if (
      !chains.has(pool.chain) ||
      !isPoolId(id) ||
      typeof h24 !== "number" ||
      !Number.isFinite(h24) ||
      h24 <= 0 ||
      marketMeasurementState(pool, generatedAtMs) !== "current"
    )
      continue;
    rows.push({ key, chain: pool.chain, id, h24 });
  }
  rows.sort(
    (a, b) =>
      b.h24 - a.h24 ||
      (a.chain < b.chain ? -1 : a.chain > b.chain ? 1 : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return rows.map((row, index) => ({ ...row, rank: index + 1 }));
}

/** The records after this run's ranking: a pool joins at `joinRank` or better and
 * stays while it ranks `keepRank` or better. A record whose pool was not ranked
 * (not measured, not current, no volume) is kept for the grace period after it
 * was last ranked, then dropped; at most `keepRank` records are kept, the
 * best-ranked first. The ranking time of a record moves at most once a day, so
 * the committed state stays quiet. */
export function selectDaily({
  previous,
  ranked,
  generatedAtMs,
  joinRank = DAILY_JOIN_RANK,
  keepRank = DAILY_KEEP_RANK,
}) {
  const stamp = iso(generatedAtMs);
  const rankOf = new Map(ranked.map((row) => [row.key, row.rank]));
  const kept = [];
  const known = new Set();
  for (const record of previous) {
    const key = poolKey(record.chain, record.id);
    known.add(key);
    const rank = rankOf.get(key);
    if (rank !== undefined) {
      if (rank > keepRank) continue;
      const stale =
        generatedAtMs - Date.parse(record.lastRankedAt) >=
        LAST_SEEN_GRANULARITY_MS;
      kept.push({
        record: stale ? { ...record, lastRankedAt: stamp } : record,
        order: rank,
      });
    } else if (
      generatedAtMs - Date.parse(record.lastRankedAt) <=
      DAILY_RANK_GRACE_MS
    )
      kept.push({ record, order: Infinity });
  }
  for (const row of ranked) {
    if (row.rank > joinRank) break;
    if (!known.has(row.key))
      kept.push({ record: newRecord(row.chain, row.id, stamp), order: row.rank });
  }
  kept.sort(
    (a, b) =>
      a.order - b.order ||
      (a.record.lastRankedAt < b.record.lastRankedAt
        ? 1
        : a.record.lastRankedAt > b.record.lastRankedAt
          ? -1
          : 0) ||
      byRecordKey(a.record, b.record),
  );
  return kept.slice(0, keepRank).map((entry) => entry.record);
}

/** The latest checkpoint (a UTC hour of DAILY_CHECKPOINT_HOURS) not after `ms`. */
export function latestCheckpoint(ms) {
  const start = dayStartMs(dayNumber(ms));
  return Math.max(
    ...DAILY_CHECKPOINT_HOURS.map((hour) => start + hour * HOUR_MS).filter(
      (time) => time <= ms,
    ),
  );
}

/** Whether a record is read in a run at `nowMs`. Never answered: yes. A readable
 * or unreadable answer: once per checkpoint, and again when the last readable
 * answer was true before the UTC day began (a cached copy from just before
 * midnight cannot carry the day that ended). No data or an unknown pool: asked
 * once a day, after 00:00 UTC. */
export function isDue(record, nowMs) {
  if (record.result === null || record.attemptedAt === null) return true;
  const attempted = Date.parse(record.attemptedAt);
  if (record.result === "none" || record.result === "missing")
    return attempted < dayStartMs(dayNumber(nowMs));
  if (attempted < latestCheckpoint(nowMs)) return true;
  return (
    record.result === "ok" &&
    record.fetchedAt !== null &&
    Date.parse(record.fetchedAt) < dayStartMs(dayNumber(nowMs))
  );
}

/** A record whose figures can be published: it has a readable answer, and has not
 * been unreadable twice in a row. A pool GeckoTerminal has no data for, does not
 * know, or answers unreadably again and again is "not covered": out of the file
 * and out of the readiness share. */
export function isCovered(record) {
  return (
    record.fetchedAt !== null &&
    (record.result === "ok" ||
      (record.result === "unreadable" && record.bad < DAILY_MAX_UNREADABLE))
  );
}

/** The record after a readable answer: the answer wins for every day it lists,
 * older stored days stay (a calendar window of DAILY_STORED_DAYS), and the pool's
 * first day is learned when the answer was not cut at its row limit. Returns the
 * record and how many stored days the answer revised. */
export function mergeRead(record, read, { attemptedAt, observedAt }) {
  const days = new Map(record.days);
  let revised = 0;
  for (const [day, usd] of read.days) {
    if (days.has(day) && days.get(day) !== usd) revised++;
    days.set(day, usd);
  }
  const newest = dayNumber(observedAt) - 1;
  const kept = [...days]
    .filter(([day]) => day > newest - DAILY_STORED_DAYS)
    .sort((a, b) => a[0] - b[0]);
  // The first day on file is the pool's first day only when the answer was not
  // cut: a short answer starts where GeckoTerminal's history for the pool does.
  const start =
    read.full || read.oldest === null
      ? record.start
      : record.start === null
        ? read.oldest
        : Math.min(record.start, read.oldest);
  // An answer that holds no complete day yet (a pool that began today) is "no
  // data", not a reading: there is nothing the time of the answer was true for.
  const nothing = !kept.length;
  return {
    record: {
      ...record,
      attemptedAt: iso(attemptedAt),
      result: nothing ? "none" : "ok",
      fetchedAt: nothing ? record.fetchedAt : iso(observedAt),
      bad: 0,
      start,
      days: kept,
    },
    revised,
  };
}

const definite = (record, result, attemptedAt) => ({
  ...record,
  attemptedAt: iso(attemptedAt),
  result,
});

/** What the step did, for status.json (counts.daily). */
export const emptyDailyReport = () => ({
  selected: 0,
  due: 0,
  requested: 0,
  read: 0,
  noData: 0,
  missing: 0,
  unreadable: 0,
  failed: 0,
  revisedDays: 0,
  through: null,
  published: 0,
  covered: 0,
  readyShare: null,
  stopped: null,
  skipped: null,
  note: null,
});

const NOT_SENT = new Set(["budget", "stopped", "url", "body", "provider", "accept"]);
const stoppedReason = (client) =>
  client.stats().geckoterminal.stopped?.reason ?? "stopped";

/** The reads of one run. `records` are this run's selection, `measured` the
 * pools the snapshot carries (a pool that is not measured now is not read: it
 * would not be published). Due pools are read largest 24h volume first, one
 * request each, until the list is empty, DAILY_MAX_REQUESTS requests have gone
 * out on the GeckoTerminal lane (a cooldown's second try counts), the cap is
 * spent, the lane is stopped, no request can start within `budgetMs` (the lane's
 * own gap included), or MAX_CONSECUTIVE_FAILURES requests in a row failed on the
 * network. Never throws. */
export async function collectDaily({
  client,
  records,
  measured,
  now,
  maxRequests = DAILY_MAX_REQUESTS,
  budgetMs = DAILY_BUDGET_MS,
  chains = dailyChains(),
}) {
  const report = { ...emptyDailyReport(), selected: records.length };
  const done = new Map();
  // Requests of this step: those the GeckoTerminal lane counted since it began,
  // a cooldown's second try among them.
  const lane = () => client.stats().geckoterminal;
  const firstCount = lane().requests;
  const sent = () => lane().requests - firstCount;
  try {
    const startedAt = now();
    const nowMs = startedAt;
    const due = records
      .filter((record) => measured.has(poolKey(record.chain, record.id)))
      .filter((record) => isDue(record, nowMs))
      .sort(
        (a, b) =>
          (measured.get(poolKey(b.chain, b.id))?.volumeUsd?.h24 ?? 0) -
            (measured.get(poolKey(a.chain, a.id))?.volumeUsd?.h24 ?? 0) ||
          byRecordKey(a, b),
      );
    report.due = due.length;
    let failedInARow = 0;
    for (const record of due) {
      if (sent() >= maxRequests) {
        report.stopped = `the limit of ${maxRequests} requests for this step was reached`;
        break;
      }
      if (client.requestsLeft() < 1) {
        report.stopped = "the run's request budget is spent";
        break;
      }
      if (client.isStopped("geckoterminal")) {
        report.stopped = `GeckoTerminal was stopped for this run (${stoppedReason(client)})`;
        break;
      }
      const key = poolKey(record.chain, record.id);
      const pool = measured.get(key);
      let result;
      try {
        result = await client.getJson(
          "geckoterminal",
          geckoOhlcvUrl(chains.get(record.chain), record.id),
          {
            maxBytes: MAX_BYTES.geckoDaily,
            notAfter: startedAt + budgetMs,
            tolerate: [404],
            accept: GT_DAILY_ACCEPT,
          },
        );
      } catch (error) {
        if (NOT_SENT.has(error?.code)) {
          report.stopped =
            error.code === "budget"
              ? "no further request could start in the time this step has"
              : error.code === "stopped"
                ? `GeckoTerminal was stopped for this run (${stoppedReason(client)})`
                : "a request was refused before it was sent";
          break;
        }
        if (error?.code === "http" && error.status === 404) {
          report.missing++;
          failedInARow = 0;
          done.set(key, definite(record, "missing", now()));
          continue;
        }
        if (error?.code === "rate-limited" || error?.code === "forbidden") {
          report.failed++;
          report.stopped = `GeckoTerminal was stopped for this run (${stoppedReason(client)})`;
          break;
        }
        // Network, timeout, a server error, an unreadable body: the pool stays
        // due, and nothing is recorded about it.
        report.failed++;
        if (++failedInARow >= MAX_CONSECUTIVE_FAILURES) {
          report.stopped = `${MAX_CONSECUTIVE_FAILURES} requests in a row failed`;
          break;
        }
        continue;
      }
      failedInARow = 0;
      let read;
      try {
        read = parseOhlcv(result.data, result.observedAt, pool?.tokens ?? null);
      } catch (error) {
        if (!(error instanceof UnreadableOhlcv)) throw error;
        report.unreadable++;
        done.set(key, {
          ...definite(record, "unreadable", now()),
          bad: Math.min(99, record.bad + 1),
        });
        continue;
      }
      if (!read.rows) {
        // An empty list is "no data" for a pool never read; for a pool with
        // days on file it is a history that vanished, which is not believed.
        if (record.days.length) {
          report.unreadable++;
          done.set(key, {
            ...definite(record, "unreadable", now()),
            bad: Math.min(99, record.bad + 1),
          });
        } else {
          report.noData++;
          done.set(key, definite(record, "none", now()));
        }
        continue;
      }
      const merged = mergeRead(record, read, {
        attemptedAt: now(),
        observedAt: result.observedAt,
      });
      report.revisedDays += merged.revised;
      if (merged.record.result === "ok") report.read++;
      else report.noData++;
      done.set(key, merged.record);
    }
  } catch (error) {
    // The step is an extra: a defect in it must not take the run down.
    report.stopped = `the step failed (${String(error?.message || error).slice(0, 160)})`;
  }
  report.requested = sent();
  return {
    records: records.map(
      (record) => done.get(poolKey(record.chain, record.id)) ?? record,
    ),
    report,
  };
}

/** The sums of one record at its end day, or null when a figure cannot be given:
 * the days from the start of the longer span (or from the pool's first day, if
 * later) up to the end day must all be on file, and the pool must have had a
 * complete day by then.
 *
 * A pool younger than a span has `n` set: the days it was live, from its launch
 * day to the end day. The launch day is the earlier of the pool's creation day
 * (`createdAtMs`) and its first day at GeckoTerminal, and is used only when the
 * record saw the pool's whole history; a pool whose history was cut at the row
 * limit has more than 33 days and is never young. Days before the first one
 * GeckoTerminal has are days without trades, so the sums over a span are exact
 * either way. */
export function windowFigures(record, end, createdAtMs) {
  if (record.start !== null && record.start > end) return null;
  const byDay = new Map(record.days);
  const sums = {};
  for (const [span, width] of Object.entries(DAILY_SPANS)) {
    const from = end - width + 1;
    const needed = record.start !== null ? Math.max(from, record.start) : from;
    let sum = 0;
    for (let day = needed; day <= end; day++) {
      if (!byDay.has(day)) return null;
    }
    for (let day = from; day <= end; day++) sum += byDay.get(day) ?? 0;
    sums[span] = roundCents(sum);
  }
  let launch = null;
  if (record.start !== null) {
    launch = record.start;
    if (Number.isFinite(createdAtMs))
      launch = Math.min(launch, dayNumber(createdAtMs));
  }
  const lived = launch === null ? null : end - launch + 1;
  return {
    v7: sums.d7,
    v30: sums.d30,
    ...(lived !== null && lived >= 1 && lived < DAILY_SPANS.d7
      ? { n7: lived }
      : {}),
    ...(lived !== null && lived >= 1 && lived < DAILY_SPANS.d30
      ? { n30: lived }
      : {}),
  };
}

/** The file to publish: the covered pools' figures, all up to one end day.
 *
 * The end day is the last complete UTC day of the snapshot when pools holding
 * DAILY_READY_SHARE of the covered volume (this run's 24h volume, or equal
 * weights when none has any) were read after that day ended, and the day before
 * otherwise, so the figures advance together and no total mixes two end days.
 * Only pools in this run's measured set with a figure at the end day are listed.
 * Returns `{ file: null, ... }` when nothing qualifies, which is also the
 * expiry: nothing older than one day behind the newest complete day is shown. */
export function buildDailyDataset({ records, measured, generatedAtMs }) {
  const newest = lastCompleteDay(generatedAtMs);
  const covered = records.filter(isCovered);
  const weightOf = (record) => {
    const pool = measured.get(poolKey(record.chain, record.id));
    const h24 = pool?.volumeUsd?.h24;
    return pool &&
      marketMeasurementState(pool, generatedAtMs) === "current" &&
      typeof h24 === "number" &&
      Number.isFinite(h24) &&
      h24 > 0
      ? h24
      : 0;
  };
  const total = covered.reduce((sum, record) => sum + weightOf(record), 0);
  const weight = (record) => (total > 0 ? weightOf(record) : 1);
  const all = covered.reduce((sum, record) => sum + weight(record), 0);
  const readAfter = (record, day) =>
    Date.parse(record.fetchedAt) >= dayStartMs(day + 1);
  const ready = covered
    .filter((record) => readAfter(record, newest))
    .reduce((sum, record) => sum + weight(record), 0);
  const share = covered.length ? ready / all : null;
  const empty = {
    file: null,
    through: null,
    covered: covered.length,
    readyShare: share,
    pools: 0,
    firstRead: null,
    lastRead: null,
  };
  if (!covered.length) return empty;
  const end = share >= DAILY_READY_SHARE ? newest : newest - 1;
  const pools = [];
  for (const record of covered) {
    const key = poolKey(record.chain, record.id);
    const pool = measured.get(key);
    if (!pool || !readAfter(record, end)) continue;
    const figures = windowFigures(
      record,
      end,
      Date.parse(pool.createdAt ?? ""),
    );
    if (!figures) continue;
    pools.push({ id: key, ...figures, at: record.fetchedAt });
  }
  if (!pools.length) return { ...empty, through: dayLabel(end) };
  pools.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const file = {
    schemaVersion: 1,
    snapshotGeneratedAt: iso(generatedAtMs),
    through: dayLabel(end),
    source: DAILY_SOURCE,
    pools,
  };
  const times = pools.map((pool) => pool.at).sort();
  const shape = validateDailyShape(file);
  const problem = shape.ok
    ? dailyRunProblem(file, {
        generatedAt: iso(generatedAtMs),
        sources: [{ id: DAILY_SOURCE_ID }],
      })
    : shape.reason;
  // A file that does not validate is dropped, never published.
  if (problem)
    return { ...empty, through: dayLabel(end), problem };
  return {
    ...empty,
    file,
    through: file.through,
    pools: pools.length,
    firstRead: times[0],
    lastRead: times.at(-1),
  };
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const dayMonth = (ms) => `${new Date(ms).getUTCDate()} ${MONTHS[new Date(ms).getUTCMonth()]}`;
const clock = (ms) => `${dayMonth(ms)} ${iso(ms).slice(11, 16)}`;

/** The source row that tells the page the file exists. Existing fields only. */
export function dailySource(dataset) {
  if (!dataset.file) return null;
  const through = Date.parse(`${dataset.through}T00:00:00.000Z`);
  const first = Date.parse(dataset.firstRead);
  const last = Date.parse(dataset.lastRead);
  return {
    id: DAILY_SOURCE_ID,
    name: "GeckoTerminal daily volume",
    url: "https://www.geckoterminal.com",
    status: "live",
    updatedAt: dataset.lastRead,
    note: `Complete UTC days up to ${dayMonth(through)} ${new Date(through).getUTCFullYear()} for ${dataset.pools.toLocaleString("en-US")} of the largest pools, read ${first === last ? clock(first) : `${clock(first)} to ${clock(last)}`} UTC. Other pools are not covered; a pool with no daily data is unavailable, not zero.`,
  };
}
