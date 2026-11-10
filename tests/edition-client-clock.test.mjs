import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createEvaluationClock,
  evaluationNow,
  freezeEvaluationClock,
} from "../src/edition.ts";
import {
  MARKET_MAX_AGE_MS,
  aggregateCurrentMarkets,
  marketMeasurementState,
  refreshMarketSnapshot,
} from "../shared/market-freshness.ts";
import { GENERATED_AT } from "./fixtures/static-data/generate.mjs";

const fixture = () =>
  JSON.parse(
    readFileSync(
      new URL("./fixtures/static-data/data/snapshot.json", import.meta.url),
      "utf8",
    ),
  );
const generated = Date.parse(GENERATED_AT);

test("the five-minute window itself is unchanged", () => {
  assert.equal(MARKET_MAX_AGE_MS, 5 * 60 * 1000);
});

test("without the edition the evaluation time is the visitor's clock and cannot be frozen", () => {
  freezeEvaluationClock(GENERATED_AT);
  const before = Date.now();
  const now = evaluationNow();
  assert.ok(now >= before && now <= Date.now());
  assert.notEqual(now, generated);
});

test("an edition clock stays at the snapshot's time while the visitor's moves on", async () => {
  const clock = createEvaluationClock(true);
  assert.equal(clock.frozen(), null);
  assert.ok(Math.abs(clock.now() - Date.now()) < 1000);
  clock.freeze(GENERATED_AT);
  assert.equal(clock.now(), generated);
  await new Promise((done) => setTimeout(done, 15));
  assert.equal(clock.now(), generated);
  clock.freeze(generated + 1000);
  assert.equal(clock.now(), generated + 1000);
});

test("an unreadable snapshot time thaws the clock instead of inventing one", () => {
  const clock = createEvaluationClock(true);
  for (const bad of ["not a date", "", null, undefined, Number.NaN, -1]) {
    clock.freeze(GENERATED_AT);
    clock.freeze(bad);
    assert.equal(clock.frozen(), null, String(bad));
  }
});

test("a disabled clock ignores a freeze", () => {
  const clock = createEvaluationClock(false);
  clock.freeze(GENERATED_AT);
  assert.equal(clock.frozen(), null);
});

test("evaluated at the snapshot's own time, measurements under five minutes old count and older ones are left out", () => {
  const snapshot = fixture();
  const at = refreshMarketSnapshot(snapshot, generated);
  assert.deepEqual(at.summary.volumeUsd, { h1: 176, h6: 1016, h24: 3731 });
  const state = (id) =>
    marketMeasurementState(
      snapshot.pools.find((pool) => pool.id === id),
      generated,
    );
  assert.equal(state("base:alpha1"), "current");
  assert.equal(state("ethereum:gamma3"), "current"); // 4:55 old
  assert.equal(state("ethereum:gamma2"), "stale"); // 5:15 old
  assert.equal(state("robinhood:front1"), "stale"); // 7:30 old
  assert.equal(state("base:alpha4"), "stale"); // 15:00 old
  assert.equal(state("base:beta2"), "unknown"); // never measured
  const frontier = at.projects.find((project) => project.id === "frontier");
  assert.equal(frontier.metrics.volumeUsd.h24, null);
});

test("a measurement exactly five minutes old is out, one millisecond younger is in", () => {
  const edge = (age) => ({
    metricStatus: "live",
    metricUpdatedAt: new Date(generated - age).toISOString(),
    liquidityUsd: 1,
    volumeUsd: { h1: 1, h6: 1, h24: 1 },
  });
  assert.equal(
    marketMeasurementState(edge(MARKET_MAX_AGE_MS), generated),
    "stale",
  );
  assert.equal(
    marketMeasurementState(edge(MARKET_MAX_AGE_MS - 1), generated),
    "current",
  );
});

test("judged by the visitor's clock an hour later every figure would be gone: the reason the edition evaluates at snapshot time", () => {
  const snapshot = fixture();
  const later = refreshMarketSnapshot(snapshot, generated + 3_600_000);
  assert.equal(later.summary.volumeUsd.h24, null);
  const now = aggregateCurrentMarkets(snapshot.pools, generated);
  assert.equal(now.volumeUsd.h24, 3731);
  assert.equal(now.freshness.volume.h24.currentPools, 7);
  assert.equal(now.freshness.volume.h24.stalePools, 3);
  assert.equal(now.freshness.volume.h24.oldestAt, "2026-10-28T14:00:05.000Z");
});

test("a measured zero stays zero and an absent price stays absent", () => {
  const at = refreshMarketSnapshot(fixture(), generated);
  const alpha = at.projects.find((project) => project.id === "alpha");
  const beta = at.projects.find((project) => project.id === "beta");
  assert.equal(alpha.metrics.volumeUsd.h24, 3300);
  assert.equal(beta.metrics.volumeUsd.h24, null);
  assert.equal(beta.metrics.liquidityUsd, 7000);
  const zero = at.pools.find((pool) => pool.id === "ethereum:alpha3");
  assert.deepEqual(zero.volumeUsd, { h1: 0, h6: 0, h24: 0 });
});
