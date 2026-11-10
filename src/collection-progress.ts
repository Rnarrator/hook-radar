import type { PoolIndexCoverage } from "../shared/types";
import { networkCaughtUp } from "../shared/indexing.ts";

export const COLLECTION_FACT_TTL_MS = 30000;
export interface CollectionProgressFact {
  collectedChains: number;
  totalChains: number;
  expiresAt: number;
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const block = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= -1;
const target = (value: unknown): value is number | null =>
  value === null || (block(value) && value >= 0);
const statuses = new Set([
  "queued",
  "scanning",
  "complete",
  "error",
  "unavailable",
]);

/** A current collection fact never changes the published search inventory. */
export function collectionProgressFact(
  value: unknown,
  inventory: PoolIndexCoverage,
  receivedAt: number,
  now = receivedAt,
): CollectionProgressFact | null {
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(receivedAt) ||
    receivedAt > now ||
    now - receivedAt >= COLLECTION_FACT_TTL_MS ||
    !object(value) ||
    value.service !== "hook-radar" ||
    value.state !== "ready" ||
    value.ready !== true ||
    value.online !== true ||
    !object(value.runtime) ||
    typeof value.runtime.sampledAt !== "string" ||
    !object(value.collectors) ||
    !object(value.collectors.census) ||
    value.collectors.census.running !== true ||
    !Array.isArray(value.collectors.census.networks) ||
    !Array.isArray(inventory.networks) ||
    !inventory.networks.length ||
    inventory.networks.length > 100 ||
    value.collectors.census.networks.length !== inventory.networks.length
  )
    return null;
  const sampledAt = Date.parse(value.runtime.sampledAt);
  if (
    !Number.isFinite(sampledAt) ||
    sampledAt <= 0 ||
    sampledAt > now + 60000 ||
    now - sampledAt >= COLLECTION_FACT_TTL_MS
  )
    return null;
  const pinned = new Map();
  const chainIds = new Set();
  for (const network of inventory.networks) {
    if (
      !/^[a-z0-9-]{1,48}$/.test(network.chain) ||
      !Number.isSafeInteger(network.chainId) ||
      network.chainId <= 0 ||
      !block(network.scannedToBlock) ||
      !target(network.targetBlock) ||
      pinned.has(network.chain) ||
      chainIds.has(network.chainId)
    )
      return null;
    pinned.set(network.chain, network);
    chainIds.add(network.chainId);
  }
  const seen = new Set();
  let collectedChains = 0;
  for (const network of value.collectors.census.networks) {
    if (!object(network) || typeof network.chain !== "string") return null;
    const previous = pinned.get(network.chain);
    if (
      !previous ||
      seen.has(network.chain) ||
      network.chainId !== previous.chainId ||
      !block(network.scannedToBlock) ||
      !target(network.targetBlock) ||
      typeof network.status !== "string" ||
      !statuses.has(network.status) ||
      network.scannedToBlock < previous.scannedToBlock ||
      (previous.targetBlock !== null &&
        (network.targetBlock === null ||
          network.targetBlock < previous.targetBlock))
    )
      return null;
    seen.add(network.chain);
    if (
      networkCaughtUp({
        targetBlock: network.targetBlock,
        scannedToBlock: network.scannedToBlock,
      })
    )
      collectedChains++;
  }
  if (collectedChains <= inventory.networks.filter(networkCaughtUp).length)
    return null;
  return Object.freeze({
    collectedChains,
    totalChains: inventory.networks.length,
    expiresAt: Math.min(
      receivedAt + COLLECTION_FACT_TTL_MS,
      sampledAt + COLLECTION_FACT_TTL_MS,
    ),
  });
}

export function collectionProgressCopy(fact: CollectionProgressFact) {
  return `Pool history caught up on ${fact.collectedChains} of ${fact.totalChains} ${fact.totalChains === 1 ? "chain" : "chains"}. Updating search results.`;
}
