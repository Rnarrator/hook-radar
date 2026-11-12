#!/usr/bin/env node
// What the collector would ask DEX Screener about, from a state folder and a gap.
//
//   node collector/tools/plan-dry-run.mjs <state-dir> <gap-hours> [<gap-hours> ...]
//   node collector/tools/plan-dry-run.mjs state 1 3.7 6 9
//
// For each gap it plans the run as if it started that many hours after the saved
// time of the state (state/pools.json `updatedAt`) and prints the size of each
// lane, how many pools and DEX Screener batches the run would ask for, and how
// the pools that answered in the last day sit in the lanes. It reads the state
// files and nothing else: no request is made to any provider, no file is written,
// and the program has no way to send one (it imports no HTTP client and never
// calls fetch). It runs the same decision and the same planner as a real run
// (decidePlanMode and planMeasurement in collector/measure.mjs), so the numbers
// are the plan's own, for the state as it is.
//
// The size of a run depends on the time of day only through the wheels' phases,
// which are even, so the numbers vary little with the hour. They do depend on the
// gap: the wheels ask the pools that fell due since the last good run.

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LANE_HOT_MAX_AGE_MS,
  LANE_MAX_BATCHES,
  LANE_NEW_MAX_AGE_MS,
  LANE_PERIOD_MS,
  LANE_WARM_MAX_AGE_MS,
} from "../config.mjs";
import { isGeckoCarried } from "../fallback.mjs";
import {
  decidePlanMode,
  LANES,
  laneAnchor,
  laneBatches,
  measurementChains,
  planBurst,
  planMeasurement,
} from "../measure.mjs";
import { priorityPlan } from "../run.mjs";
import { poolKey, readState } from "../state.mjs";

const HOUR_MS = 60 * 60 * 1000;
const USAGE = `Usage: node collector/tools/plan-dry-run.mjs <state-dir> <gap-hours> [<gap-hours> ...] [--json]
  <state-dir>   a folder with pools.json (and history.json, priority.json when there are any)
  <gap-hours>   hours between the saved time of the state and the run (for example 1 3.7 6 9)
  --json        print the reports as JSON
Makes no request and writes no file.`;

/** The report for one gap. `state` is what readState returned. */
export function dryRun(state, gapHours) {
  const updatedAtMs = state.updatedAt ? Date.parse(state.updatedAt) : NaN;
  const known = new Set(
    state.pools.map((pool) => poolKey(pool.chain, pool.id)),
  );
  const priority = priorityPlan(state.priority, known);
  const pools = [...state.pools, ...priority.fresh];
  const nowMs = updatedAtMs + gapHours * HOUR_MS;
  const decision = decidePlanMode({
    pools,
    nowMs,
    updatedAtMs,
    previousPoint: state.history.at(-1) ?? null,
  });
  const plan = planMeasurement(pools, {
    decision,
    nowMs,
    updatedAtMs,
    priorityKeys: priority.keys,
  });
  const full = planBurst(pools, { protectedKeys: priority.keys });
  // The pools a provider measured in the last day before the saved time: the
  // last good run's measurements are among them (a pool's lastSeen moves once a
  // day), so this is the most the state can say about "answering now".
  const recent = pools.filter(
    (pool) =>
      Date.parse(pool.lastSeen) > Date.parse(pool.firstSeen) &&
      Date.parse(pool.lastSeen) >= updatedAtMs - HOUR_MS * 24,
  );
  const chains = new Set(measurementChains().map((chain) => chain.chain));
  const recentEligible = recent.filter((pool) => chains.has(pool.chain));
  const lanesOfRecent = {};
  for (const pool of recentEligible) {
    const lane = plan.laneByKey?.get(poolKey(pool.chain, pool.id)) ?? "full";
    lanesOfRecent[lane] = (lanesOfRecent[lane] ?? 0) + 1;
  }
  return {
    gapHours,
    savedAt: state.updatedAt,
    runAt: Number.isFinite(nowMs) ? new Date(nowMs).toISOString() : null,
    anchorAt:
      plan.mode === "lanes"
        ? new Date(laneAnchor(nowMs, updatedAtMs)).toISOString()
        : null,
    mode: decision.mode,
    reason: decision.code,
    detail: decision.detail,
    knownPools: pools.length,
    plannedPools: plan.planned,
    batches: plan.batches,
    fullPlanBatches: full.batches,
    lanes:
      plan.mode === "lanes"
        ? Object.fromEntries(LANES.map((lane) => [lane, plan.lanes[lane]]))
        : null,
    // The batches each lane adds, in the order the batches are made (they add up
    // to `batches`).
    batchesByLane: plan.mode === "lanes" ? laneBatches(plan) : null,
    deferredPools: plan.mode === "lanes" ? plan.deferred : 0,
    droppedForCeiling: plan.mode === "lanes" ? plan.dropped : 0,
    trimmed: plan.mode === "lanes" ? plan.trimmed : null,
    ceilingBound: plan.mode === "lanes" ? plan.ceilingBound : false,
    maxBatches: plan.mode === "lanes" ? plan.maxBatches : null,
    hotAndNew: decision.hotAndNew ?? null,
    // The pools GeckoTerminal priced last time that answered in the last 72 hours:
    // they sit in WARM (DEX Screener asks about them on its 3-hour wheel) and
    // GeckoTerminal is asked about them in every run, and how many of the pools
    // measured in the last day are among them.
    geckoCarried: decision.geckoCarried ?? null,
    measuredAndCarried:
      plan.mode === "lanes"
        ? recentEligible.filter((pool) =>
            isGeckoCarried(pool, laneAnchor(nowMs, updatedAtMs)),
          ).length
        : null,
    floor: decision.floor ?? null,
    previousPools: decision.previousPools ?? null,
    answeredWithinADay: recent.length,
    answeredWithinADayEligible: recentEligible.length,
    answeredWithinADayByLane: lanesOfRecent,
    answeringAndAsked: recentEligible.filter((pool) => {
      const lane = plan.laneByKey?.get(poolKey(pool.chain, pool.id));
      return plan.mode === "lanes" ? lane === "hot" || lane === "new" : true;
    }).length,
  };
}

const pad = (value, width) => String(value).padStart(width);

/** One report as lines of text. */
export function formatReport(report) {
  const lines = [
    `Gap ${report.gapHours} h: a run at ${report.runAt}`,
    `  plan: ${report.mode}${report.reason ? ` (${report.reason}: ${report.detail})` : ""}`,
  ];
  if (report.lanes) {
    const hours = (ms) => ms / HOUR_MS;
    const names = {
      hot: `HOT  (answered in the last ${hours(LANE_HOT_MAX_AGE_MS)} h; every run)`,
      new: `NEW  (never answered, first seen under ${hours(LANE_NEW_MAX_AGE_MS)} h ago; every run)`,
      warm: `WARM (answered ${hours(LANE_HOT_MAX_AGE_MS)} h to ${hours(LANE_WARM_MAX_AGE_MS) / 24} d ago; once per ${hours(LANE_PERIOD_MS.warm)} h)`,
      cool: `COOL (answered ${hours(LANE_WARM_MAX_AGE_MS) / 24} d or more ago; once per ${hours(LANE_PERIOD_MS.cool)} h)`,
      cold: `COLD (never answered, known ${hours(LANE_NEW_MAX_AGE_MS)} h or more; once per ${hours(LANE_PERIOD_MS.cold)} h)`,
    };
    lines.push(
      `  ${"lane".padEnd(58)} ${pad("known", 7)} ${pad("asked", 7)} ${pad("batches", 8)}`,
    );
    for (const lane of LANES)
      lines.push(
        `  ${names[lane].padEnd(58)} ${pad(report.lanes[lane].known, 7)} ${pad(report.lanes[lane].scheduled, 7)} ${pad(report.batchesByLane[lane], 8)}`,
      );
    lines.push(
      `  not asked, not due: ${report.deferredPools} · cut by the ceiling: ${report.droppedForCeiling}`,
    );
  }
  lines.push(
    `  asked: ${report.plannedPools} of ${report.knownPools} known pools in ${report.batches} DEX Screener batches` +
      (report.maxBatches
        ? ` (ceiling ${report.maxBatches}${report.ceilingBound ? ", BOUND" : ", not reached"})`
        : "") +
      `; the full plan would be ${report.fullPlanBatches} batches`,
  );
  if (report.hotAndNew !== null)
    lines.push(
      `  HOT + NEW ${report.hotAndNew} against a floor of ${report.floor} (${report.previousPools} pools behind the previous history point)`,
    );
  if (report.geckoCarried)
    lines.push(
      `  ${report.geckoCarried} of the WARM pools were priced by GeckoTerminal and answered in the last 72 h: GeckoTerminal is asked about them in every run (${report.measuredAndCarried} of the pools measured in the last 24 h are among them)`,
    );
  lines.push(
    `  pools measured in the last 24 h before the saved time: ${report.answeredWithinADay} (${report.answeredWithinADayEligible} on networks DEX Screener is asked about); ` +
      (report.mode === "lanes"
        ? `HOT or NEW in this plan: ${report.answeringAndAsked}`
        : `all asked in the full plan: ${report.answeringAndAsked}`),
  );
  return lines;
}

export function main(argv = process.argv.slice(2), out = console.log) {
  const json = argv.includes("--json");
  const args = argv.filter((arg) => arg !== "--json");
  return (async () => {
    const [dir, ...gaps] = args;
    const hours = gaps.map(Number);
    if (
      !dir ||
      !gaps.length ||
      hours.some((hour) => !Number.isFinite(hour) || hour <= 0 || hour > 24 * 60)
    ) {
      console.error(USAGE);
      return 2;
    }
    let state;
    try {
      state = await readState(resolve(dir));
    } catch (error) {
      console.error(`Cannot read the state: ${error.message}`);
      return 1;
    }
    const reports = hours.map((hour) => dryRun(state, hour));
    if (json) out(JSON.stringify(reports, null, 2));
    else {
      out(
        `State ${resolve(dir)}: saved ${state.updatedAt ?? "(never)"}, ${state.pools.length} pools; lane ceiling ${LANE_MAX_BATCHES} batches`,
      );
      for (const report of reports) {
        for (const line of formatReport(report)) out(line);
        out("");
      }
    }
    return 0;
  })();
}

const startedDirectly = () => {
  const entry = process.argv[1];
  if (!entry) return false;
  const real = (path) => {
    try {
      return realpathSync.native(path);
    } catch {
      return resolve(path);
    }
  };
  return real(fileURLToPath(import.meta.url)) === real(entry);
};

if (startedDirectly()) process.exitCode = await main();
