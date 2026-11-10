export type WindowKey = "h1" | "h6" | "h24";
export type Category =
  | "Launches"
  | "Liquidity"
  | "Fees"
  | "MEV"
  | "Orders"
  | "Oracles"
  | "Access"
  | "Other";
export interface Chain {
  id: number;
  slug: string;
  name: string;
  explorer: string;
}
export interface SourceStatus {
  id: string;
  name: string;
  url: string;
  status: "live" | "cached" | "unavailable";
  updatedAt: string | null;
  note: string;
}
export interface Point {
  timestamp: number;
  value: number;
}
export interface HookDeployment {
  id: string;
  address: string;
  chain: string;
  chainId: number;
  name: string;
  description: string;
  verifiedSource: boolean;
  flags: Record<string, boolean>;
  properties: {
    dynamicFee: boolean;
    upgradeable: boolean;
    requiresCustomSwapData: boolean;
    vanillaSwap: boolean;
    swapAccess: string;
  };
  auditUrl: string | null;
  sourceUrl: string;
  explorerUrl: string;
  discovery?: "onchain" | "published";
}
export interface PoolKey {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hookAddress: string;
  managerAddress: string;
  creationBlock: number;
}
export interface Pool {
  id: string;
  chain: string;
  name: string;
  address: string;
  hookAddress: string | null;
  projectId: string | null;
  url: string;
  source: string;
  liquidityUsd: number | null;
  volumeUsd: Record<WindowKey, number | null>;
  createdAt: string | null;
  tokens: string[];
  metricUpdatedAt?: string | null;
  metricStatus?: "live" | "cached" | "unavailable";
  discovery?: "onchain";
  liquidityStatus?: "reported" | "inconsistent" | "unverified" | "unavailable";
  liquidityNote?: string;
  poolKey?: PoolKey;
}
export interface MetricFreshness {
  observedPools: number;
  currentPools: number;
  stalePools: number;
  unknownPools: number;
  oldestAt: string | null;
  newestAt: string | null;
  latestObservedAt: string | null;
  expiresAt: string | null;
}
export interface MarketFreshness {
  maxAgeMs: number;
  expiresAt: string | null;
  liquidity: MetricFreshness;
  volume: Record<WindowKey, MetricFreshness>;
}
export interface ProjectMetrics {
  poolCount: number | null;
  liquidityUsd: number | null;
  volumeUsd: Record<WindowKey, number | null>;
  coverage: "measured" | "partial" | "unavailable";
  note: string;
  freshness?: MarketFreshness;
}
export interface RadarProject {
  id: string;
  /** A documented application, without inferred hook ownership or market totals. */
  entityType?: "platform";
  name: string;
  description: string;
  category: Category;
  website: string | null;
  docs: string | null;
  sourceUrl: string;
  deployments: HookDeployment[];
  chains: string[];
  metrics: ProjectMetrics;
  /** Deferred only in the explicitly negotiated dashboard presentation. */
  history?: Point[];
  historyPointCount?: number;
  poolInventory?: {
    poolCount: number;
    complete: boolean;
    chains: Record<string, number>;
    replacementToken?: string;
  };
}
export interface PoolIndexNetwork {
  chain: string;
  chainId: number;
  name: string;
  manager: string;
  dataset: string | null;
  startBlock: number;
  scannedToBlock: number;
  targetBlock: number | null;
  status: "queued" | "scanning" | "complete" | "unavailable" | "error";
  poolCount: number;
  hookPoolCount: number;
  hookCount: number;
  updatedAt: string | null;
  headCheckedAt?: string | null;
  lastError: string | null;
  finality?: "finalized" | "confirmed";
  cacheWarning?: string | null;
}
export interface PoolIndexCoverage {
  generatedAt: string;
  running: boolean;
  poolCount: number;
  hookPoolCount: number;
  hookCount: number;
  networks: PoolIndexNetwork[];
}
export interface PoolPage {
  projectId: string;
  total: number;
  offset: number;
  nextOffset: number | null;
  nextCursor?: string | null;
  replacementToken?: string;
  pools: Pool[];
}
export interface TokenMetadata {
  chain: string;
  address: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  updatedAt: string | null;
  status: "live" | "cached" | "unavailable";
  sourceUrl: string;
}
export interface TokenMetadataResponse {
  projectId: string;
  tokens: TokenMetadata[];
}
export interface DirectoryPage {
  projects: RadarProject[];
  total: number;
  offset: number;
  nextOffset: number | null;
  scope: {
    poolCount: number | null;
    chains: string[];
    poolIds: string[];
    eventIds: string[];
    /** Scoped records from the same directory generation; absent on older servers. */
    events?: RadarEvent[];
  };
  map: { category: Category; total: number; projects: DirectoryMapNode[] }[];
  landscape: { category: Category; total: number }[];
  missingIds: string[];
}
export interface DirectoryMapNode {
  id: string;
  name: string;
  description: string;
  category: Category;
  chains: string[];
  deploymentCount: number;
  artwork: { protocol: string; src: string } | null;
  fingerprint: { address: string; chain: string } | null;
}
export interface MarketCoverageNetwork {
  chain: string;
  chainId: number;
  inventoryPools: number;
  checkedPools: number;
  measuredPools: number;
  pendingPools: number;
  missingPools: number;
  attemptedPools: number;
  status: "live" | "cached" | "unavailable";
}
export interface MarketIndexCoverage {
  networks: MarketCoverageNetwork[];
  cacheWarning: string | null;
}
export type FrontierExtensionKind =
  "feeCalculator" | "observer" | "feeRecipient";
export type ExtensionDataStatus = "live" | "cached" | "unavailable";
export interface FrontierExtension {
  id: string;
  name: string;
  purpose: string;
  description: string;
  kind: FrontierExtensionKind;
  roles: FrontierExtensionKind[];
  status: "active" | "coming-soon";
  address: string | null;
  legacyAddresses: string[];
  implId: string | null;
  legacyImplIds: string[];
  orderRank: number;
  baseFeeProvider: boolean;
  leafOf: string | null;
  docsUrl: string;
}
export interface FrontierBoundExtension {
  address: string;
  known: boolean;
  id: string | null;
  name: string;
  purpose: string;
  description: string;
  kind: FrontierExtensionKind;
  roles: FrontierExtensionKind[];
  rawConfig: string | null;
  docsUrl: string;
}
export interface FrontierExtensionPool {
  poolId: string;
  coinAddress: string;
  name: string;
  hookAddress: string;
}
export interface FrontierPoolExtensions {
  poolId: string;
  coinAddress: string;
  feeCalculators: FrontierBoundExtension[];
  observers: FrontierBoundExtension[];
  feeRecipient: FrontierBoundExtension | null;
  hookConfig: {
    lpShareBps: string;
    fixedFee: string;
    sniperWindow: string;
    communityFeeRatio: string;
    stakingVault: string;
    registeredAtTimestamp: string;
  };
  protocolFeeRatio: string | null;
}
export interface FrontierExtensionsResponse {
  projectId: "frontier";
  chainId: 4663;
  hookAddress: string;
  hookGeneration: "current" | "legacy";
  status: ExtensionDataStatus;
  updatedAt: string | null;
  sourceUrl: string;
  docsUrl: string;
  note: string;
  catalogStatus: ExtensionDataStatus;
  catalogUpdatedAt: string | null;
  catalog: FrontierExtension[];
  pool: FrontierPoolExtensions | null;
  pools: FrontierExtensionPool[];
  totalPools: number;
  poolsTruncated: boolean;
}
export interface RadarEvent {
  id: string;
  type: "new-project" | "new-deployment" | "metadata-change" | "activity";
  title: string;
  description: string;
  timestamp: string;
  projectId: string | null;
  chain: string | null;
  url: string | null;
}
export interface RadarSnapshot {
  schemaVersion: 1;
  presentation?: {
    profile: "dashboard";
    version: 1;
    projectHistory: "deferred";
    poolEvidence: "deferred";
  };
  generatedAt: string;
  status: "live" | "partial" | "cached" | "offline";
  chains: Chain[];
  projects: RadarProject[];
  pools: Pool[];
  events: RadarEvent[];
  sources: SourceStatus[];
  history: Point[];
  summary: {
    indexedProjects: number;
    indexedDeployments: number;
    trackedPools: number;
    liquidityUsd: number | null;
    volumeUsd: Record<WindowKey, number | null>;
    freshness?: MarketFreshness;
  };
  coverage: {
    title: string;
    description: string;
    measuredChains: string[];
    registryDeployments: number;
    attributedPools: number;
    totalObservedPools: number;
  };
  inventory?: PoolIndexCoverage;
  marketCoverage?: MarketIndexCoverage;
  directory?: {
    mode: "paginated";
    totalProjects: number;
    totalDeployments: number;
    loadedProjects: number;
  };
}

export interface RadarStartupProgress {
  phase: "checking-history" | "checking-pools" | "preparing-radar";
  checkedPools?: number;
  totalPools?: number;
}
