import { packedCensusInventoryStore } from "./census-packed-store.mjs";

const ADDRESS = /^0x[\da-f]{40}$/i;
const POOL_ID = /^0x[\da-f]{64}$/i;
const ZERO = "0x" + "0".repeat(40);
const DYNAMIC_FEE_EVIDENCE = Symbol("directory dynamic-fee pool evidence");
export const directoryDynamicFees = (pool) =>
  pool?.[DYNAMIC_FEE_EVIDENCE] === true || Boolean(Number(pool.fee) & 8388608);

// A published census is grouped by its network order. Generic inventories do
// not make that promise and always take the exhaustive path below.
function segments(inventory) {
  if (
    inventory?.appendOnly !== true ||
    !Array.isArray(inventory.networks) ||
    typeof inventory.poolsIncludeZeroHooks !== "boolean"
  )
    return null;
  const result = [];
  const seen = new Set();
  let start = 0;
  for (const network of inventory.networks) {
    const size = inventory.poolsIncludeZeroHooks
      ? network.poolCount
      : network.hookPoolCount;
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      !Number.isSafeInteger(network.chainId) ||
      network.chainId <= 0 ||
      typeof network.chain !== "string" ||
      typeof network.manager !== "string" ||
      seen.has(network.chain) ||
      start + size > inventory.pools.length
    )
      return null;
    seen.add(network.chain);
    const first = size ? inventory.pools[start] : null;
    const last = size ? inventory.pools[start + size - 1] : null;
    if (
      size &&
      [first, last].some(
        (pool) =>
          pool?.chain !== network.chain || pool.chainId !== network.chainId,
      )
    )
      return null;
    result.push({
      chain: network.chain,
      chainId: network.chainId,
      manager: network.manager.toLowerCase(),
      dataset: network.dataset,
      startBlock: network.startBlock,
      scannedToBlock: network.scannedToBlock,
      lastBlockHash: network.lastBlockHash,
      start,
      size,
      firstId: first?.id,
      lastId: last?.id,
    });
    start += size;
  }
  return start === inventory.pools.length ? result : null;
}

function appendedSpans(previous, current, pools) {
  if (!previous || !current || previous.length !== current.length) return null;
  const result = [];
  for (let index = 0; index < current.length; index++) {
    const before = previous[index];
    const after = current[index];
    if (
      ["chain", "chainId", "manager", "dataset", "startBlock"].some(
        (key) => before[key] !== after[key],
      ) ||
      before.size > after.size ||
      before.scannedToBlock > after.scannedToBlock ||
      (before.scannedToBlock === after.scannedToBlock &&
        before.lastBlockHash !== after.lastBlockHash) ||
      (before.size &&
        (pools[after.start]?.id !== before.firstId ||
          pools[after.start + before.size - 1]?.id !== before.lastId))
    )
      return null;
    if (after.size > before.size)
      result.push({
        start: after.start + before.size,
        end: after.start + after.size,
      });
  }
  return result;
}

function packedSegments(inventory, current) {
  if (!current) return null;
  const entries = current.map((segment) => {
    const entry = packedCensusInventoryStore(inventory.pools, segment.chain);
    return entry &&
      entry.start === segment.start &&
      entry.count === segment.size &&
      entry.store.chain.chain === segment.chain &&
      entry.store.chain.chainId === segment.chainId
      ? entry
      : null;
  });
  return entries.every(Boolean) ? entries : null;
}

function preservesPackedStores(previous, current) {
  if (!previous && !current) return true;
  return Boolean(
    previous &&
    current &&
    previous.length === current.length &&
    previous.every(
      (entry, index) =>
        entry.store === current[index].store &&
        entry.count <= current[index].count,
    ),
  );
}

/**
 * Directory identity depends on distinct hook deployments, not every pool.
 * Retain actual canonical representatives and inspect only proven appends.
 * A private symbol records a later dynamic-fee pool without changing the first
 * representative's key or provenance. It cannot come from JSON or serialize
 * into canonical journals. Full membership/counts remain with the pool index.
 */
export class CensusHookDirectory {
  constructor() {
    this.reference = null;
    this.previousSegments = null;
    this.previousPacked = null;
    this.rows = new Map();
    this.projected = Object.freeze([]);
    this.stats = Object.freeze({
      inputPools: 0,
      representativeHooks: 0,
      scannedPools: 0,
      appendOnly: false,
    });
  }

  *projectSteps(inventory) {
    if (!Array.isArray(inventory?.pools)) return [];
    const current = segments(inventory);
    const packed = packedSegments(inventory, current);
    const spans = preservesPackedStores(this.previousPacked, packed)
      ? appendedSpans(this.previousSegments, current, inventory.pools)
      : null;
    const appendOnly = spans !== null;
    if (inventory.pools === this.reference && appendOnly && !spans.length)
      return this.projected;
    const rows = appendOnly ? this.rows : new Map();
    // A projection is cancellable at every yield. Stage all additions and
    // dynamic-fee upgrades so abandoning one candidate cannot change the
    // previously published map or contaminate a different subsequent append.
    const updates = new Map();
    const ranges = spans || [{ start: 0, end: inventory.pools.length }];
    let scanned = 0;
    for (const range of ranges) {
      let packedIndex = 0;
      let lastDynamicEntry = null;
      let lastDynamicHook = null;
      for (let index = range.start; index < range.end; index++) {
        if (++scanned % 1024 === 0) yield;
        let pool, id, previous;
        if (packed) {
          while (
            packedIndex < packed.length &&
            index >= packed[packedIndex].start + packed[packedIndex].count
          )
            packedIndex++;
          const entry = packed[packedIndex];
          if (!entry || index < entry.start)
            throw new Error(
              "Packed hook directory exceeded its committed bounds.",
            );
          const position = index - entry.start;
          const identity = entry.store.hookFeeAt(position);
          // The private packed factory already proves canonical identity
          // fields. Generic rows below retain their independent validation.
          if (!identity)
            throw new Error("Packed hook directory identity is unavailable.");
          if (identity.hookAddress === ZERO) continue;
          // Repeated dynamic hooks can add no further directory evidence.
          // Still read every bounded record; only skip rebuilding its Map key.
          // Keep this cache local so cancellation cannot publish an upgrade.
          if (
            entry === lastDynamicEntry &&
            identity.hookAddress === lastDynamicHook
          )
            continue;
          id = `${entry.store.chain.chainId}:${identity.hookAddress}`;
          previous = updates.get(id) || rows.get(id);
          // A dynamic-fee representative already records all information this
          // duplicate could add. Keep its exact first canonical record without
          // decoding tokens, timestamps and provenance for millions of pools.
          if (previous && directoryDynamicFees(previous)) {
            lastDynamicEntry = entry;
            lastDynamicHook = identity.hookAddress;
            continue;
          }
          // A later row can only add dynamic-fee evidence. Materialize the
          // complete canonical row solely for the first representative.
          pool = previous ? identity : entry.store.at(position);
        } else {
          pool = inventory.pools[index];
          if (
            !ADDRESS.test(pool?.hookAddress) ||
            pool.hookAddress.toLowerCase() === ZERO ||
            !POOL_ID.test(pool.address)
          )
            continue;
          id = `${pool.chainId}:${pool.hookAddress.toLowerCase()}`;
          previous = updates.get(id) || rows.get(id);
        }
        if (!previous) updates.set(id, pool);
        else if (!directoryDynamicFees(previous) && directoryDynamicFees(pool))
          updates.set(
            id,
            Object.freeze({ ...previous, [DYNAMIC_FEE_EVIDENCE]: true }),
          );
      }
    }
    const projected = [];
    for (const [id, pool] of rows) {
      projected.push(updates.get(id) || pool);
      if (projected.length % 1024 === 0) yield;
    }
    for (const [id, pool] of updates) {
      if (rows.has(id)) continue;
      projected.push(pool);
      if (projected.length % 1024 === 0) yield;
    }
    // No yields follow this commit boundary.
    for (const [id, pool] of updates) rows.set(id, pool);
    this.reference = inventory.pools;
    this.previousSegments = current;
    this.previousPacked = packed;
    this.rows = rows;
    this.projected = Object.freeze(projected);
    this.stats = Object.freeze({
      inputPools: inventory.pools.length,
      representativeHooks: projected.length,
      scannedPools: scanned,
      appendOnly,
    });
    return this.projected;
  }
}
