/** Canonical PoolManager event analytics; never an estimate of USD volume or users. */
export type ActivityWindow = "h1" | "h24" | "d7";
export const ACTIVITY_FEE_BANDS = [
  { id: "zero", label: "0%", minimumPips: 0, maximumPips: 0 },
  { id: "very-low", label: "Up to 0.01%", minimumPips: 1, maximumPips: 100 },
  { id: "low", label: "0.01–0.05%", minimumPips: 101, maximumPips: 500 },
  { id: "standard", label: "0.05–0.30%", minimumPips: 501, maximumPips: 3000 },
  { id: "elevated", label: "0.30–1%", minimumPips: 3001, maximumPips: 10000 },
  { id: "high", label: "1–10%", minimumPips: 10001, maximumPips: 100000 },
  {
    id: "very-high",
    label: "Above 10%",
    minimumPips: 100001,
    maximumPips: 1000000,
  },
] as const;
export interface ActivityFeeRates {
  swaps: number;
  minimumPips: number | null;
  maximumPips: number | null;
  /** Arithmetic mean per Swap event; never weighted by value or liquidity. */
  averagePips: number | null;
  bands: {
    id: string;
    label: string;
    minimumPips: number;
    maximumPips: number;
    swaps: number;
  }[];
}
export interface ActivityTotals {
  swaps: number;
  transactions: number;
  activePools: number;
  liquidityChanges: number;
  liquidityAdds: number;
  liquidityRemoves: number;
  liquidityPokes: number;
}
export interface ActivityBucket {
  timestamp: number;
  swaps: number;
  liquidityChanges: number;
  complete: boolean;
  /** Null/absent means a legacy cache did not retain this detail. */
  liquidityAdds?: number | null;
  liquidityRemoves?: number | null;
  liquidityPokes?: number | null;
}
export interface ActivitySwap {
  id: string;
  chain: string;
  chainId: number;
  poolId: string;
  poolName: string | null;
  hookAddress: string;
  transactionHash: string;
  transactionUrl: string;
  blockNumber: number;
  blockHash: string;
  timestamp: number;
  logIndex: number;
  sender: string;
  /** Signed raw PoolManager deltas; may exclude hook return deltas. */
  amount0: string;
  amount1: string;
  currency0: string | null;
  currency1: string | null;
  /** Event's effective fee in hundredths of a basis point; not earned fees. */
  feePips: number;
  tick: number;
}
export interface ActivityNetwork {
  chain: string;
  chainId: number;
  name: string;
  status: "complete" | "partial" | "unavailable";
  finality: "finalized" | "confirmed";
  sourceUrl: string;
  fromBlock: number | null;
  toBlock: number | null;
  scannedToBlock: number | null;
  throughTimestamp: number | null;
  headTimestamp: number | null;
  headHash: string | null;
  pools: number | null;
  mode: "selected-pools" | "manager-events";
  observed: ActivityTotals;
  note: string | null;
}
export interface ActivityPoolSummary {
  chain: string;
  chainId: number;
  poolId: string;
  name: string | null;
  hookAddress: string;
  swaps: number;
  transactions: number;
  liquidityChanges: number;
  liquidityAdds?: number | null;
  liquidityRemoves?: number | null;
  liquidityPokes?: number | null;
  lastSwapAt: number | null;
  minFeePips: number | null;
  maxFeePips: number | null;
}
export interface ActivityReport {
  schemaVersion: 1;
  projectId: string;
  projectName: string;
  window: ActivityWindow;
  generatedAt: string;
  windowStart: number;
  windowEnd: number;
  /** Explicit historical exclusive upper bound, in epoch seconds. */
  requestedEnd?: number | null;
  /** Stable resolved hook and canonical namespace binding for fair period comparisons. */
  comparisonScopeKey?: string;
  status: "complete" | "partial" | "unavailable";
  cached: boolean;
  /** A bounded background scan is running; clients may poll its verified progress. */
  refreshing: boolean;
  stale: boolean;
  /** Null means the request's full canonical pool scope was not proven. */
  totals: ActivityTotals | null;
  /** Proven matching events only. Partial results are lower bounds, never zero-activity claims. */
  observed: ActivityTotals;
  scope: {
    totalPools: number | null;
    listedPools: number;
    chains: number;
    hookAddress: string | null;
    poolId: string | null;
    inventoryComplete: boolean;
  };
  networks: ActivityNetwork[];
  buckets: ActivityBucket[];
  pools: ActivityPoolSummary[];
  latestSwaps: ActivitySwap[];
  /** Event-count distribution, unavailable for older caches lacking detail. */
  feeRates?: ActivityFeeRates | null;
  methodology: {
    eventSource: string;
    notes: string[];
    usdVolume: null;
    earnedFees: null;
    uniqueTraders: null;
  };
  warning: string | null;
}
