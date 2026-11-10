import type {
  Chain,
  DirectoryPage,
  PoolIndexCoverage,
  RadarProject,
  RadarSnapshot,
  SourceStatus,
} from "./types";

/** Bounded directory publication, independent of the full analytics snapshot. */
export const DISCOVERY_PROFILE = Object.freeze({
  profile: "discovery" as const,
  version: 1 as const,
  projectHistory: "deferred" as const,
  poolMembership: "deferred" as const,
  aggregateMarkets: "deferred" as const,
});
export const DISCOVERY_MAX_BYTES = 8 * 1024 * 1024;

export interface DiscoveryQuery {
  search: string;
  chain: string;
  category: string;
  property: string;
  market: string;
  sort: string;
  direction: string;
  window: string;
  offset: number;
  limit: number;
  saved: boolean;
  ids: string[];
}

export interface DiscoveryProject extends Omit<RadarProject, "history"> {
  history?: never;
  historyPointCount: number;
}

export interface DiscoveryPage extends Omit<
  DirectoryPage,
  "projects" | "scope"
> {
  projects: DiscoveryProject[];
  scope: Omit<DirectoryPage["scope"], "poolIds">;
}

export interface DiscoveryEnvelope {
  schemaVersion: 1;
  presentation: typeof DISCOVERY_PROFILE;
  /** Ready means normal server recovery gates passed, not full price coverage. */
  ready: true;
  publication: {
    /** Opaque identity of this immutable public frame, not a canonical proof. */
    id: string;
    generatedAt: string;
    status: RadarSnapshot["status"];
  };
  request: DiscoveryQuery;
  chains: Chain[];
  sources: SourceStatus[];
  inventory?: PoolIndexCoverage;
  page: DiscoveryPage;
}

export function discoveryQueryKey(query: DiscoveryQuery): string {
  return JSON.stringify([
    query.search,
    query.chain,
    query.category,
    query.property,
    query.market,
    query.sort,
    query.direction,
    query.window,
    query.offset,
    query.limit,
    query.saved,
    query.ids,
  ]);
}
