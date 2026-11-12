import { evaluationNow } from "./edition.ts";
import type { RadarProject, RadarSnapshot, WindowKey } from "../shared/types";
import type { Filters } from "./model";
import { filterProjects } from "./model.ts";
import type { PoolSearchIndex } from "./pool-search.ts";
import {
  aggregateCurrentMarkets,
  marketMeasurementState,
  MARKET_MAX_AGE_MS,
} from "../shared/market-freshness.ts";

export interface ProjectPoolScope {
  readonly pools: RadarSnapshot["pools"];
  readonly chain: string;
  readonly byProject: Map<string, RadarSnapshot["pools"]>;
  readonly withMarketData: Set<string>;
  readonly withRecentTrading: Record<WindowKey, Set<string>>;
  readonly evaluatedAt: number;
  readonly expiresAt: number;
}

const emptyScopeMetrics = new WeakMap<
  ProjectPoolScope,
  RadarProject["metrics"]
>();
function unmeasuredScopeMetrics(scope: ProjectPoolScope) {
  let value = emptyScopeMetrics.get(scope);
  if (!value) {
    const amounts = aggregateCurrentMarkets([]);
    Object.freeze(amounts.volumeUsd);
    for (const row of [
      amounts.freshness.liquidity,
      ...Object.values(amounts.freshness.volume),
    ])
      Object.freeze(row);
    Object.freeze(amounts.freshness.volume);
    Object.freeze(amounts.freshness);
    value = Object.freeze({
      poolCount: null,
      ...amounts,
      coverage: "unavailable" as const,
      note: `Observed pool sample on ${scope.chain}. Missing metrics are unavailable, not zero.`,
    });
    emptyScopeMetrics.set(scope, value);
  }
  return value;
}

/** Build one private pool lookup, yielding during large server projections. */
export function* projectPoolScopeSteps(
  pools: RadarSnapshot["pools"],
  chain: string,
  now = evaluationNow(),
): Generator<void, ProjectPoolScope> {
  const byProject = new Map<string, RadarSnapshot["pools"]>();
  const withMarketData = new Set<string>();
  const withRecentTrading = {
    h1: new Set<string>(),
    h6: new Set<string>(),
    h24: new Set<string>(),
  };
  let expiresAt = Infinity;
  let operations = 0;
  for (const pool of pools) {
    if (pool.projectId && (chain === "all" || pool.chain === chain)) {
      const list = byProject.get(pool.projectId) || [];
      list.push(pool);
      byProject.set(pool.projectId, list);
      if (marketMeasurementState(pool, now) === "current") {
        const volumes = pool.volumeUsd;
        const known = (value: number | null | undefined) =>
          typeof value === "number" && Number.isFinite(value) && value >= 0;
        if (
          known(pool.liquidityUsd) ||
          (["h1", "h6", "h24"] as const).some((metric) =>
            known(volumes?.[metric]),
          )
        )
          withMarketData.add(pool.projectId);
        for (const metric of ["h1", "h6", "h24"] as const) {
          const value = volumes?.[metric];
          if (known(value) && value! > 0)
            withRecentTrading[metric].add(pool.projectId);
        }
        if (pool.metricUpdatedAt)
          expiresAt = Math.min(
            expiresAt,
            Date.parse(pool.metricUpdatedAt) + MARKET_MAX_AGE_MS,
          );
      }
    }
    if (++operations % 1024 === 0) yield;
  }
  return {
    pools,
    chain,
    byProject,
    withMarketData,
    withRecentTrading,
    evaluatedAt: now,
    expiresAt,
  };
}

function projectPoolScope(
  pools: RadarSnapshot["pools"],
  chain: string,
  now: number,
) {
  const steps = projectPoolScopeSteps(pools, chain, now);
  let result = steps.next();
  while (!result.done) result = steps.next();
  return result.value;
}

/** Scope measured amounts and deployment counts before selecting observed families. */
export function selectProjects(
  projects: RadarProject[],
  pools: RadarSnapshot["pools"],
  filters: Filters,
  prepared?: ProjectPoolScope,
  now = evaluationNow(),
  window: WindowKey = "h24",
  chainNames?: ReadonlyMap<string, string>,
  poolSearch?: PoolSearchIndex,
) {
  const needsPoolScope =
    filters.chain !== "all" ||
    filters.market === "observed" ||
    filters.market === "active";
  const scope = needsPoolScope
    ? prepared?.pools === pools &&
      prepared.chain === filters.chain &&
      now >= prepared.evaluatedAt &&
      now < prepared.expiresAt
      ? prepared
      : projectPoolScope(pools, filters.chain, now)
    : null;
  const candidates =
    filters.market === "projects"
      ? projects.filter(
          (project) =>
            project.entityType === "platform" ||
            project.deployments.some(
              (deployment) => deployment.discovery !== "onchain",
            ),
        )
      : filters.market === "active"
        ? projects.filter((project) =>
            scope?.withRecentTrading[window].has(project.id),
          )
        : filters.market === "observed"
          ? projects.filter((project) => scope?.withMarketData.has(project.id))
          : projects;
  const listed = filterProjects(candidates, filters, chainNames, poolSearch);
  return listed.map((project) => {
    if (filters.chain === "all") return project;
    if (project.entityType === "platform")
      return { ...project, chains: [filters.chain] };
    const observed = scope?.byProject.get(project.id) || [];
    return {
      ...project,
      chains: [filters.chain],
      deployments: project.deployments.filter(
        (deployment) => deployment.chain === filters.chain,
      ),
      metrics: observed.length
        ? {
            poolCount: observed.length,
            ...aggregateCurrentMarkets(observed, now),
            coverage: "partial" as const,
            note: `Observed pool sample on ${filters.chain}. Missing metrics are unavailable, not zero.`,
          }
        : unmeasuredScopeMetrics(scope!),
    };
  });
}
