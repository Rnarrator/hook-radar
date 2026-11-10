import { randomBytes } from "node:crypto";
import { analyticsHistory, buildAnalyticsSummary } from "../src/analytics.ts";
import { analyticsCategorySlices } from "../src/analytics-chart-data.ts";
import {
  aggregateCurrentMarketsSteps,
  marketMeasurementState,
  observedMetricValue,
} from "../shared/market-freshness.ts";
import {
  ANALYTICS_OVERVIEW_MAX_BYTES,
  ANALYTICS_OVERVIEW_PROFILE,
  analyticsOverviewQueryFromParams,
  isAnalyticsOverviewEnvelope,
  isAnalyticsOverviewQuery,
} from "../shared/analytics-overview.ts";
import { cooperativeSortSteps, runCooperatively } from "./cooperative.mjs";

const identities = new WeakMap();
const session = randomBytes(16).toString("hex");
let sequence = 0;
function publicationId(snapshot) {
  let id = identities.get(snapshot);
  if (!id) {
    id = `${session}:${++sequence}`;
    identities.set(snapshot, id);
  }
  return id;
}

function* overviewSteps(snapshot, request, now, includeContributions) {
  const names = new Map(snapshot.chains.map((n) => [n.slug, n.name]));
  for (const network of snapshot.inventory?.networks || [])
    names.set(network.chain, network.name);
  let work = 0;
  for (const pool of snapshot.pools) {
    if (++work % 256 === 0) yield;
    if (!names.has(pool.chain)) names.set(pool.chain, pool.chain);
  }
  if (request.chain !== "all" && !names.has(request.chain))
    throw new RangeError("Unknown analytics network.");
  // Share the established pool deduplication and complete-sample arithmetic.
  // No project aggregate or paginated selection contributes to these totals.
  yield;
  const summary = buildAnalyticsSummary(snapshot, {
    chain: request.chain,
    windowKey: request.window,
    now,
  });
  yield;
  const projects = new Map(snapshot.projects.map((p) => [p.id, p]));
  const categoryPools = new Map();
  const rows = [];
  for (const pool of summary.observedPools) {
    if (++work % 256 === 0) yield;
    if (marketMeasurementState(pool, now) !== "current") continue;
    const volumeUsd = observedMetricValue(pool, request.window);
    const liquidityUsd = observedMetricValue(pool, "liquidity");
    if (volumeUsd === null && liquidityUsd === null) continue;
    const project = projects.get(pool.projectId) || null;
    const category = project?.category || "Unattributed";
    if (!categoryPools.has(category)) categoryPools.set(category, []);
    categoryPools.get(category).push(pool);
    rows.push({ pool, project, volumeUsd, liquidityUsd, volumeShare: null });
  }
  const proofs = new Map();
  for (const [category, pools] of categoryPools)
    proofs.set(
      category,
      (yield* aggregateCurrentMarketsSteps(pools, now)).freshness,
    );
  // Preserve the full workspace's summation order, including IEEE-754 rounding.
  const descending = (a, b) =>
    a === b ? 0 : a === null ? 1 : b === null ? -1 : b - a;
  const sortedRows = yield* cooperativeSortSteps(
    rows,
    (a, b) =>
      descending(a.volumeUsd, b.volumeUsd) ||
      descending(a.liquidityUsd, b.liquidityUsd) ||
      a.pool.id.localeCompare(b.pool.id),
  );
  const categorySeries = (metric) =>
    analyticsCategorySlices(
      { pools: sortedRows, totals: summary.totals },
      metric,
    ).map((row) => ({
      ...row,
      freshness:
        metric === "volume"
          ? proofs.get(row.category).volume[request.window]
          : proofs.get(row.category).liquidity,
    }));
  const projectIndexes = new Map();
  const contributionProjects = [];
  const categoryRanks = new Map(
    sortedRows.map((row, index) => [row.pool, index]),
  );
  const contributionRows = [];
  for (const pool of includeContributions ? summary.observedPools : []) {
    if (++work % 256 === 0) yield;
    if (marketMeasurementState(pool, now) !== "current") continue;
    const amounts = ["h1", "h6", "h24", "liquidity"].map((metric) =>
      observedMetricValue(pool, metric),
    );
    if (amounts.every((value) => value === null)) continue;
    let projectIndex = -1;
    if (pool.projectId) {
      if (!projectIndexes.has(pool.projectId)) {
        const project = projects.get(pool.projectId);
        projectIndexes.set(pool.projectId, contributionProjects.length);
        contributionProjects.push([
          pool.projectId,
          !!project,
          project?.category || "Unattributed",
        ]);
      }
      projectIndex = projectIndexes.get(pool.projectId);
    }
    contributionRows.push([
      pool.chain,
      pool.address.toLowerCase(),
      projectIndex,
      pool.metricUpdatedAt,
      ...amounts,
      categoryRanks.get(pool) ?? -1,
    ]);
  }
  return {
    schemaVersion: 1,
    presentation: ANALYTICS_OVERVIEW_PROFILE,
    ready: true,
    publication: {
      id: publicationId(snapshot),
      generatedAt: snapshot.generatedAt,
      status: snapshot.status,
    },
    request,
    asOf: summary.asOf,
    networks: [...names]
      .map(([slug, name]) => ({ slug, name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    sources: snapshot.sources,
    inventory: snapshot.inventory || null,
    totals: summary.totals,
    networkTotals: summary.networks,
    categories: {
      volume: categorySeries("volume"),
      reserves: categorySeries("reserves"),
    },
    history: {
      available: request.chain === "all",
      points:
        request.chain === "all"
          ? analyticsHistory(snapshot.history, "all", now)
          : [],
    },
    ...(includeContributions
      ? {
          contributions: {
            version: 1,
            scope: "initial-current-cohort",
            projects: contributionProjects,
            rows: contributionRows,
          },
        }
      : {}),
  };
}

/** Caller applies the same published-frame, readiness, request admission and
 * cancellation gates as discovery. This returns a distinct aggregate protocol. */
export async function analyticsOverviewAsync(snapshot, params, runtime = {}) {
  runtime.signal?.throwIfAborted();
  const request =
    params instanceof URLSearchParams
      ? analyticsOverviewQueryFromParams(params)
      : params;
  if (!isAnalyticsOverviewQuery(request))
    throw new RangeError("Invalid analytics overview query.");
  const now = runtime.now ?? Date.now();
  if (
    !Number.isFinite(now) ||
    now < 0 ||
    !Number.isFinite(new Date(now).getTime())
  )
    throw new RangeError("Invalid analytics evaluation clock.");
  const result = await runCooperatively(
    overviewSteps(
      snapshot,
      { ...request },
      now,
      runtime.contributions === true,
    ),
    runtime,
  );
  runtime.signal?.throwIfAborted();
  if (!isAnalyticsOverviewEnvelope(result, request))
    throw new TypeError("The published analytics overview is invalid.");
  return result;
}

export function analyticsOverviewJson(envelope) {
  if (!isAnalyticsOverviewEnvelope(envelope))
    throw new TypeError("A validated analytics overview is required.");
  const text = JSON.stringify(envelope);
  if (Buffer.byteLength(text) > ANALYTICS_OVERVIEW_MAX_BYTES)
    throw new RangeError(
      "The analytics overview exceeds its bounded response size.",
    );
  return text;
}
