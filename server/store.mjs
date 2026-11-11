import { open, unlink, mkdir, rename } from "node:fs/promises";
import { SourceCache, boundedJson } from "./source-cache.mjs";
import { PROVIDER_REQUEST_OBSERVER } from "./provider-fetch.mjs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  joinPoolInventory,
  joinPoolInventorySteps,
  inventoryPoolPage,
} from "./inventory.mjs";
import { runSynchronously, runCooperatively } from "./cooperative.mjs";
import { normalizeCachedLiquidity } from "./reserve-value.mjs";
import { getFrontierMarketObservation } from "./providers.mjs";
import { MarketAttributionCache } from "./market-attribution-cache.mjs";
import {
  safePublicationFailure,
  safeRefreshFailureRecord,
} from "./publication-conflict.mjs";
import { networkCaughtUp } from "../shared/indexing.ts";
import { isPoolKey } from "../shared/pool-key.ts";
import { isMarketCoverage } from "../shared/market-coverage.ts";
import {
  aggregateCurrentMarkets,
  aggregateCurrentMarketsSteps,
  marketMeasurementState,
  observedMetricValue,
} from "../shared/market-freshness.ts";
import { isDirectoryInfo } from "../shared/directory.ts";
import { isPublishedPlatformProject } from "../shared/published-platform-hooks.ts";
import { leanSnapshotAsync, refreshSnapshotAsync } from "./directory.mjs";
import { snapshotJsonChunks } from "./snapshot-json.mjs";
import { renamePrimarySnapshot } from "./snapshot-commit.mjs";
import { writeStartupView } from "./startup-view.mjs";
import { recoverProjectHistory } from "./history-recovery-source.mjs";
import {
  removedHistorySteps,
  safeHistoryArchiveReason,
} from "./history-archive-records.mjs";
import {
  readPrimarySnapshot,
  PRIMARY_SNAPSHOT_MAX_BYTES,
} from "./primary-snapshot.mjs";
import { CensusHookDirectory } from "./census-hook-directory.mjs";
import {
  packedCensusInventoryStore,
  PackedCanonicalLookup,
} from "./census-packed-store.mjs";
import {
  REGISTRY_URL,
  cleanText,
  CHAINS_URL,
  FRONTIER_URL,
  validateRegistry,
  validateChains,
  validateFrontier,
  createDirectory,
  createDirectorySteps,
  attributePools,
  attributePoolsSteps,
  applyMetrics,
  applyMetricsSteps,
  registryEvents,
  registryEventsSteps,
  appendHistory,
  digest,
} from "./model.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const BOOTSTRAP = join(ROOT, "server", "bootstrap");
export const DEFAULT_CACHE = join(ROOT, ".radar-cache");
const SOURCE_LIMIT = 18 * 1024 * 1024;
const REFRESH_TTL = 5 * 60 * 1000;
const COOLDOWN = 30 * 1000;
const REFRESH_BUDGET = 60 * 1000;
const publicationFailureOperations = new WeakMap();
const validTimestamp = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  Date.parse(value) >= 0 &&
  Date.parse(value) <= Date.now() + 60000;
const textField = (value) => typeof value === "string";
const countField = (value) => Number.isSafeInteger(value) && value >= 0;
const OVERLAY_FALLBACK_LIMIT = 10000;

/** Index a captured complete project generation without allocating a temporary
 * tuple array for every family. The private Map is returned only when complete;
 * duplicate IDs retain native Map's first position and last-value precedence. */
export function* indexProjectRowsSteps(projects) {
  const indexed = new Map();
  const count = projects.length;
  for (let index = 0; index < count; index++) {
    if (index && index % 512 === 0) yield;
    const project = projects[index];
    indexed.set(project.id, project);
  }
  return indexed;
}

/** Platform listings describe supported networks, not hook ownership. Keep
 * them outside the canonical inventory projection while retaining the exact
 * hook-family objects that receive its verified counts. */
export function* inventoryHookProjectsSteps(projects) {
  let owners;
  for (let index = 0; index < projects.length; index++) {
    if (index && index % 1024 === 0) yield;
    const project = projects[index];
    if (project.entityType === "platform") owners ??= projects.slice(0, index);
    else owners?.push(project);
  }
  return owners || projects;
}

/** Reuse only complete, equal records in the same ordered slot. Callers still
 * compute current source/canonical/freshness results before this comparison.
 * Inputs stay immutable; incomplete cooperative work is never published. */
export function* reusePublishedRowsSteps(previous, current) {
  if (previous === current) return previous;
  let shared = null;
  let unchanged = previous.length === current.length;
  for (let index = 0; index < current.length; index++) {
    if (index && index % 256 === 0) yield;
    const row = current[index];
    if (
      index < previous.length &&
      (row === previous[index] || isDeepStrictEqual(row, previous[index]))
    ) {
      if (row !== previous[index]) {
        shared ??= current.slice();
        shared[index] = previous[index];
      }
    } else unchanged = false;
  }
  return unchanged ? previous : shared || current;
}

const poolIdentityKey = (pool) =>
  `${pool.chain}:${String(pool.address).toLowerCase()}`;

// Only reconcile already-recorded points while rebasing a proven newer overlay.
// A slow candidate may contain an older historical prefix; the committed frame
// owns equal-time conflicts. Ordinary five-minute sampling remains unchanged.
function mergeCommittedHistory(candidate = [], committed = []) {
  if (candidate === committed || !committed.length) return candidate;
  if (!candidate.length) return committed;
  const points = new Map(candidate.map((point) => [point.timestamp, point]));
  for (const point of committed) points.set(point.timestamp, point);
  return [...points.values()]
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-672);
}

function canonicalMarketIdentity(pool) {
  if (
    !pool ||
    !Number.isSafeInteger(pool.chainId) ||
    pool.chainId <= 0 ||
    !/^0x[\da-f]{64}$/i.test(pool.address) ||
    !/^0x[\da-f]{40}$/i.test(pool.hookAddress) ||
    /^0x0{40}$/i.test(pool.hookAddress) ||
    !Array.isArray(pool.tokens) ||
    pool.tokens.length !== 2 ||
    !pool.tokens.every((value) => /^0x[\da-f]{40}$/i.test(value)) ||
    !Number.isSafeInteger(pool.fee) ||
    !((pool.fee >= 0 && pool.fee <= 1000000) || pool.fee === 8388608) ||
    !Number.isSafeInteger(pool.tickSpacing) ||
    pool.tickSpacing < 1 ||
    pool.tickSpacing > 32767 ||
    !Number.isSafeInteger(pool.creationBlock) ||
    pool.creationBlock < 0 ||
    (pool.creationBlockHash != null &&
      !/^0x[\da-f]{64}$/i.test(pool.creationBlockHash))
  )
    return null;
  return JSON.stringify([
    pool.chain,
    pool.chainId,
    pool.address.toLowerCase(),
    pool.hookAddress.toLowerCase(),
    pool.tokens.map((token) => token.toLowerCase()),
    pool.fee,
    pool.tickSpacing,
    pool.creationBlock,
    pool.creationBlockHash?.toLowerCase() || null,
  ]);
}

// Production lookups use the census factory's fixed committed prefix. Generic
// test/import inventories are supported only at a deliberately small bound.
function marketInventoryLookup(inventory) {
  if (!inventory?.pools || !Array.isArray(inventory.networks)) return null;
  const packed = new Map();
  for (const network of inventory.networks) {
    const entry = packedCensusInventoryStore(inventory.pools, network.chain);
    if (entry)
      packed.set(network.chain, {
        entry,
        lookup: new PackedCanonicalLookup(entry, () => true),
      });
  }
  if (packed.size === inventory.networks.length)
    return {
      packed,
      get: (pool) =>
        packed.get(pool.chain)?.lookup.get(pool.address.toLowerCase()),
    };
  if (inventory.pools.length > OVERLAY_FALLBACK_LIMIT) return null;
  const rows = new Map();
  for (const pool of inventory.pools) {
    if (!canonicalMarketIdentity(pool)) return null;
    rows.set(poolIdentityKey(pool), { ...pool, tokens: [...pool.tokens] });
  }
  if (rows.size !== inventory.pools.length) return null;
  return { rows, get: (pool) => rows.get(poolIdentityKey(pool)) };
}

function* preservesMarketInventorySteps(previous, inventory, before, current) {
  if (
    !before ||
    !current ||
    previous?.appendOnly !== true ||
    inventory?.appendOnly !== true ||
    previous.networks.length !== inventory.networks.length ||
    previous.poolsIncludeZeroHooks !== inventory.poolsIncludeZeroHooks ||
    inventory.pools.length < previous.pools.length
  )
    return false;
  const networks = new Map(inventory.networks.map((row) => [row.chain, row]));
  if (networks.size !== inventory.networks.length) return false;
  const validHead = (row, lookup) =>
    countField(row.scannedToBlock) ||
    (row.scannedToBlock === -1 &&
      row.startBlock === 0 &&
      row.lastBlockHash === null &&
      row.poolCount === 0 &&
      row.hookPoolCount === 0 &&
      row.hookCount === 0 &&
      lookup.packed?.get(row.chain)?.entry.count === 0);
  for (const row of previous.networks) {
    const next = networks.get(row.chain);
    if (
      !next ||
      row.chainId !== next.chainId ||
      typeof row.manager !== "string" ||
      row.manager.toLowerCase() !== next.manager?.toLowerCase() ||
      row.startBlock !== next.startBlock ||
      row.dataset !== next.dataset ||
      !validHead(row, before) ||
      !validHead(next, current) ||
      next.scannedToBlock < row.scannedToBlock ||
      !["poolCount", "hookPoolCount", "hookCount"].every(
        (key) =>
          countField(row[key]) &&
          countField(next[key]) &&
          next[key] >= row[key],
      ) ||
      (next.scannedToBlock === row.scannedToBlock &&
        (next.lastBlockHash !== row.lastBlockHash ||
          next.poolCount !== row.poolCount ||
          next.hookPoolCount !== row.hookPoolCount ||
          next.hookCount !== row.hookCount))
    )
      return false;
    if (before.packed) {
      const old = before.packed.get(row.chain)?.entry;
      const latest = current.packed?.get(row.chain)?.entry;
      if (
        !old ||
        !latest ||
        old.store !== latest.store ||
        latest.count < old.count
      )
        return false;
    }
  }
  if (before.rows) {
    let work = 0;
    for (const [id, pool] of before.rows) {
      const identity = canonicalMarketIdentity(pool);
      if (
        !identity ||
        identity !== canonicalMarketIdentity(current.rows?.get(id))
      )
        return false;
      if (++work % 512 === 0) yield;
    }
  }
  return true;
}

function marketRowMatchesCanonical(row, canonical, manager) {
  return Boolean(
    canonical &&
    row.id === canonical.id &&
    row.chain === canonical.chain &&
    row.chainId === canonical.chainId &&
    row.address?.toLowerCase() === canonical.address.toLowerCase() &&
    row.hookAddress?.toLowerCase() === canonical.hookAddress.toLowerCase() &&
    Array.isArray(row.tokens) &&
    row.tokens.length === 2 &&
    row.tokens.every(
      (token, index) =>
        typeof token === "string" &&
        token.toLowerCase() === canonical.tokens[index].toLowerCase(),
    ) &&
    (row.fee === undefined || row.fee === canonical.fee) &&
    (row.tickSpacing === undefined ||
      row.tickSpacing === canonical.tickSpacing) &&
    (row.creationBlock === undefined ||
      row.creationBlock === canonical.creationBlock) &&
    (row.creationBlockHash === undefined ||
      (row.creationBlockHash === null && canonical.creationBlockHash == null) ||
      (typeof row.creationBlockHash === "string" &&
        row.creationBlockHash.toLowerCase() ===
          canonical.creationBlockHash?.toLowerCase())) &&
    (row.poolKey === undefined ||
      (isPoolKey(row.poolKey, canonical.hookAddress) &&
        row.poolKey.currency0.toLowerCase() ===
          canonical.tokens[0].toLowerCase() &&
        row.poolKey.currency1.toLowerCase() ===
          canonical.tokens[1].toLowerCase() &&
        row.poolKey.fee === canonical.fee &&
        row.poolKey.tickSpacing === canonical.tickSpacing &&
        row.poolKey.managerAddress.toLowerCase() === manager?.toLowerCase() &&
        row.poolKey.creationBlock === canonical.creationBlock)),
  );
}

function newerMarketRow(previous, incoming, now = Date.now()) {
  const before = Date.parse(previous.metricUpdatedAt || "");
  const next = Date.parse(incoming.metricUpdatedAt || "");
  if (
    previous.metricProvider === "envio" &&
    incoming.metricProvider === "envio" &&
    Number.isFinite(next)
  ) {
    const oldQualified =
      normalizeCachedLiquidity(previous, now).liquidityUsd !== null;
    const newQualified =
      normalizeCachedLiquidity(incoming, now).liquidityUsd !== null;
    // A source-fetch clock is not a price clock. A newly qualified quote may
    // honestly be older, while an unqualified newer fetch cannot erase it.
    if (oldQualified !== newQualified) return newQualified;
  }
  return (
    Number.isFinite(next) &&
    (!Number.isFinite(before) ||
      next > before ||
      (next === before && incoming.metricStatus !== previous.metricStatus))
  );
}

function retainPoolStructure(previous, incoming, now = Date.now()) {
  const next = { ...previous };
  for (const key of [
    "liquidityUsd",
    "liquidityStatus",
    "liquidityNote",
    "liquidityEvidence",
    "metricUpdatedAt",
    "metricStatus",
    "metricProvider",
    "metricProvenance",
    "source",
    "url",
  ]) {
    if (incoming[key] === undefined) delete next[key];
    else next[key] = incoming[key];
  }
  next.volumeUsd = { ...incoming.volumeUsd };
  return normalizeMetricProvenance(next, [], false, now);
}

/** New canonical rows have no market checks until an exact-ID lookup proves one.
 * Preserve a published observation generation while inventory grows, accounting
 * for its additional rows solely as pending work. Replacements need a real join.
 */
export function alignAppendOnlyMarketCoverage(coverage, previous, inventory) {
  if (
    !coverage ||
    !isMarketCoverage(coverage) ||
    inventory?.appendOnly !== true ||
    !Array.isArray(previous?.networks) ||
    !Array.isArray(inventory.networks)
  )
    return coverage;
  const before = new Map(previous.networks.map((row) => [row.chain, row]));
  const current = new Map(inventory.networks.map((row) => [row.chain, row]));
  let changed = false;
  const networks = coverage.networks.map((row) => {
    const old = before.get(row.chain);
    const next = current.get(row.chain);
    if (
      !old ||
      !next ||
      old.chainId !== row.chainId ||
      next.chainId !== row.chainId ||
      typeof old.manager !== "string" ||
      typeof next.manager !== "string" ||
      !/^0x[\da-f]{40}$/i.test(old.manager) ||
      old.manager.toLowerCase() !== next.manager.toLowerCase() ||
      old.dataset !== next.dataset ||
      old.startBlock !== next.startBlock ||
      ![old, next].every((network) =>
        [
          "startBlock",
          "scannedToBlock",
          "poolCount",
          "hookPoolCount",
          "hookCount",
        ].every((key) => countField(network[key])),
      ) ||
      next.hookPoolCount > next.poolCount ||
      next.hookCount > next.hookPoolCount ||
      next.scannedToBlock < old.scannedToBlock ||
      next.poolCount < old.poolCount ||
      next.hookPoolCount < old.hookPoolCount ||
      next.hookCount < old.hookCount ||
      (next.scannedToBlock === old.scannedToBlock &&
        next.lastBlockHash !== old.lastBlockHash) ||
      row.inventoryPools > old.hookPoolCount ||
      next.hookPoolCount <= row.inventoryPools
    )
      return row;
    changed = true;
    return {
      ...row,
      inventoryPools: next.hookPoolCount,
      pendingPools: row.pendingPools + next.hookPoolCount - row.inventoryPools,
    };
  });
  return changed ? { ...coverage, networks } : coverage;
}

const numberField = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const nullableNumber = (value) => value === null || numberField(value);
const urlField = (value) =>
  typeof value === "string" &&
  /^https:\/\//.test(value) &&
  (() => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    } catch {
      return false;
    }
  })();
const nullableUrl = (value) => value === null || urlField(value);
const windowsField = (value) =>
  value && ["h1", "h6", "h24"].every((key) => nullableNumber(value[key]));
const historyField = (value) =>
  Array.isArray(value) &&
  value.length <= 672 &&
  value.every(
    (point, index) =>
      point &&
      numberField(point.timestamp) &&
      numberField(point.value) &&
      (!index || value[index - 1].timestamp < point.timestamp),
  );
function validDeployment(value) {
  return Boolean(
    value &&
    textField(value.id) &&
    /^0x[\da-fA-F]{40}$/.test(value.address) &&
    textField(value.chain) &&
    countField(value.chainId) &&
    value.chainId > 0 &&
    textField(value.name) &&
    textField(value.description) &&
    typeof value.verifiedSource === "boolean" &&
    value.flags &&
    !Array.isArray(value.flags) &&
    Object.keys(value.flags).length === 14 &&
    Object.values(value.flags).every((flag) => typeof flag === "boolean") &&
    value.properties &&
    [
      "dynamicFee",
      "upgradeable",
      "requiresCustomSwapData",
      "vanillaSwap",
    ].every((key) => typeof value.properties[key] === "boolean") &&
    textField(value.properties.swapAccess) &&
    nullableUrl(value.auditUrl) &&
    urlField(value.sourceUrl) &&
    urlField(value.explorerUrl),
  );
}
function validPool(value) {
  return Boolean(
    value &&
    textField(value.id) &&
    textField(value.chain) &&
    textField(value.name) &&
    /^0x(?:[\da-fA-F]{40}|[\da-fA-F]{64})$/.test(value.address) &&
    /^0x[\da-fA-F]{40}$/.test(value.hookAddress) &&
    (value.poolKey === undefined ||
      isPoolKey(value.poolKey, value.hookAddress)) &&
    textField(value.projectId) &&
    urlField(value.url) &&
    textField(value.source) &&
    (value.liquidityStatus === undefined ||
      ["reported", "inconsistent", "unverified", "unavailable"].includes(
        value.liquidityStatus,
      )) &&
    (value.liquidityNote === undefined ||
      (textField(value.liquidityNote) && value.liquidityNote.length <= 500)) &&
    nullableNumber(value.liquidityUsd) &&
    windowsField(value.volumeUsd) &&
    (value.createdAt === null || validTimestamp(value.createdAt)) &&
    Array.isArray(value.tokens) &&
    value.tokens.every(textField) &&
    (value.metricUpdatedAt === undefined ||
      value.metricUpdatedAt === null ||
      validTimestamp(value.metricUpdatedAt)) &&
    (value.metricStatus === undefined ||
      ["live", "cached", "unavailable"].includes(value.metricStatus)),
  );
}
function validProject(value) {
  return Boolean(
    value &&
    textField(value.id) &&
    textField(value.name) &&
    textField(value.description) &&
    [
      "Launches",
      "Liquidity",
      "Fees",
      "MEV",
      "Orders",
      "Oracles",
      "Access",
      "Other",
    ].includes(value.category) &&
    nullableUrl(value.website) &&
    nullableUrl(value.docs) &&
    urlField(value.sourceUrl) &&
    Array.isArray(value.deployments) &&
    (value.entityType === "platform"
      ? isPublishedPlatformProject(value)
      : value.entityType === undefined && value.deployments.length > 0) &&
    value.deployments.every(validDeployment) &&
    Array.isArray(value.chains) &&
    value.chains.every(textField) &&
    value.metrics &&
    (value.metrics.poolCount === null || countField(value.metrics.poolCount)) &&
    nullableNumber(value.metrics.liquidityUsd) &&
    windowsField(value.metrics.volumeUsd) &&
    ["measured", "partial", "unavailable"].includes(value.metrics.coverage) &&
    textField(value.metrics.note) &&
    historyField(value.history) &&
    (value.poolInventory === undefined ||
      (value.poolInventory &&
        countField(value.poolInventory.poolCount) &&
        typeof value.poolInventory.complete === "boolean" &&
        (value.poolInventory.replacementToken === undefined ||
          (typeof value.poolInventory.replacementToken === "string" &&
            /^[a-f0-9]{64}$/.test(value.poolInventory.replacementToken))) &&
        value.poolInventory.chains &&
        !Array.isArray(value.poolInventory.chains) &&
        Object.values(value.poolInventory.chains).every(countField))),
  );
}
function validInventory(value) {
  return (
    value === undefined ||
    Boolean(
      value &&
      validTimestamp(value.generatedAt) &&
      typeof value.running === "boolean" &&
      [value.poolCount, value.hookPoolCount, value.hookCount].every(
        countField,
      ) &&
      Array.isArray(value.networks) &&
      value.networks.length <= 100 &&
      value.networks.every(
        (network) =>
          network &&
          textField(network.chain) &&
          textField(network.name) &&
          countField(network.chainId) &&
          network.chainId > 0 &&
          /^0x[\da-fA-F]{40}$/.test(network.manager) &&
          (network.dataset === null || textField(network.dataset)) &&
          countField(network.startBlock) &&
          Number.isSafeInteger(network.scannedToBlock) &&
          network.scannedToBlock >= network.startBlock - 1 &&
          (network.targetBlock === null || countField(network.targetBlock)) &&
          ["queued", "scanning", "complete", "unavailable", "error"].includes(
            network.status,
          ) &&
          [network.poolCount, network.hookPoolCount, network.hookCount].every(
            countField,
          ) &&
          (network.updatedAt === null || validTimestamp(network.updatedAt)) &&
          (network.headCheckedAt === undefined ||
            network.headCheckedAt === null ||
            validTimestamp(network.headCheckedAt)) &&
          (network.lastError === null || textField(network.lastError)) &&
          (network.cacheWarning === undefined ||
            network.cacheWarning === null ||
            textField(network.cacheWarning)),
      ),
    )
  );
}
export function validSnapshot(value) {
  return Boolean(
    value &&
    value.schemaVersion === 1 &&
    (value.directory === undefined ||
      isDirectoryInfo(value.directory, value.projects)) &&
    validInventory(value.inventory) &&
    (value.marketCoverage === undefined ||
      isMarketCoverage(value.marketCoverage)) &&
    validTimestamp(value.generatedAt) &&
    ["live", "partial", "cached", "offline"].includes(value.status) &&
    Array.isArray(value.projects) &&
    value.projects.every(validProject) &&
    Array.isArray(value.pools) &&
    value.pools.every(validPool) &&
    Array.isArray(value.chains) &&
    value.chains.every(
      (chain) =>
        chain &&
        countField(chain.id) &&
        chain.id > 0 &&
        textField(chain.slug) &&
        textField(chain.name) &&
        (chain.explorer === "" || urlField(chain.explorer)),
    ) &&
    Array.isArray(value.sources) &&
    value.sources.every(
      (source) =>
        source &&
        textField(source.id) &&
        textField(source.name) &&
        urlField(source.url) &&
        ["live", "cached", "unavailable"].includes(source.status) &&
        (source.updatedAt === null || validTimestamp(source.updatedAt)) &&
        textField(source.note),
    ) &&
    Array.isArray(value.events) &&
    value.events.every(
      (event) =>
        event &&
        textField(event.id) &&
        [
          "new-project",
          "new-deployment",
          "metadata-change",
          "activity",
        ].includes(event.type) &&
        textField(event.title) &&
        textField(event.description) &&
        validTimestamp(event.timestamp) &&
        (event.projectId === null || textField(event.projectId)) &&
        (event.chain === null || textField(event.chain)) &&
        nullableUrl(event.url),
    ) &&
    historyField(value.history) &&
    value.summary &&
    countField(value.summary.indexedProjects) &&
    countField(value.summary.indexedDeployments) &&
    countField(value.summary.trackedPools) &&
    nullableNumber(value.summary.liquidityUsd) &&
    windowsField(value.summary.volumeUsd) &&
    value.coverage &&
    textField(value.coverage.title) &&
    textField(value.coverage.description) &&
    Array.isArray(value.coverage.measuredChains) &&
    value.coverage.measuredChains.every(textField) &&
    ["registryDeployments", "attributedPools", "totalObservedPools"].every(
      (key) => countField(value.coverage[key]),
    ) &&
    value.summary.indexedProjects ===
      (value.directory?.mode === "paginated"
        ? value.directory.totalProjects
        : value.projects.length) &&
    value.summary.trackedPools === value.pools.length &&
    value.summary.indexedDeployments ===
      (value.directory?.mode === "paginated"
        ? value.directory.totalDeployments
        : value.projects.reduce(
            (total, project) => total + project.deployments.length,
            0,
          )) &&
    value.summary.indexedDeployments >=
      (value.directory?.mode === "paginated"
        ? value.directory.totalProjects - value.projects.length
        : 0) +
        value.projects.reduce(
          (total, project) => total + project.deployments.length,
          0,
        ),
  );
}
async function readJson(path) {
  return boundedJson(path, 64 * 1024 * 1024);
}
async function atomicJson(
  path,
  data,
  maxBytes = Infinity,
  { primary = false } = {},
) {
  await mkdir(resolve(path, ".."), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, "wx");
    await file.writeFile(
      (async function* () {
        let bytes = 0;
        for await (const chunk of snapshotJsonChunks(data)) {
          bytes += chunk.length;
          if (bytes > maxBytes)
            throw Object.assign(
              new Error(
                "Snapshot exceeds its recovery size limit; the previous complete file is preserved.",
              ),
              {
                code: "RADAR_SNAPSHOT_TOO_LARGE",
              },
            );
          yield chunk;
        }
      })(),
    );
    await file.sync();
    await file.close();
    file = null;
    if (primary) await renamePrimarySnapshot(temporary, path);
    else await rename(temporary, path);
  } finally {
    await file?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

function abortable(promise, signal) {
  if (signal.aborted) {
    // A promise can reject in the same turn that cancellation wins admission.
    // Observe that losing branch even though it cannot publish a result.
    Promise.resolve(promise).catch(() => {});
    return Promise.reject(new DOMException("Request aborted", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(new DOMException("Request aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function cancelSourceBody(body) {
  try {
    // Cleanup must not delay recovery or replace a usable cached response.
    Promise.resolve(body?.cancel()).catch(() => {});
  } catch {
    /* A broken transport can throw before returning a cancellation promise. */
  }
}

export class SourceClient {
  constructor({
    cacheDir = DEFAULT_CACHE,
    fetchImpl = fetch,
    now = () => Date.now(),
    online = true,
    cacheBudgets = {},
    pruneDisk = false,
    parseJson = JSON.parse,
  } = {}) {
    if (typeof parseJson !== "function")
      throw new TypeError("Source JSON parser must be a function.");
    Object.defineProperty(this, "parseJson", { value: parseJson });
    this.cacheDir = cacheDir;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.online = online;
    this.cache = new SourceCache({
      directory: join(cacheDir, "sources"),
      ...cacheBudgets,
    });
    this.memory = this.cache.memory;
    this.pending = new Map();
    this.pendingIds = new Map();
    this.requestIdentities = new WeakMap();
    this.nextRequestIdentity = 0;
    this.pruneDisk = pruneDisk;
    this.cacheWrites = 0;
  }
  async pruneCache() {
    const protectedFiles = new Set(
      [...this.pendingIds.values()].map((id) => `${digest(id)}.json`),
    );
    return this.cache.prune(protectedFiles);
  }
  async getCached(id, validate, maxBytes = SOURCE_LIMIT) {
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > SOURCE_LIMIT
    )
      throw new RangeError("Invalid source response size limit.");
    const memory = this.memory.get(id);
    const cached =
      memory ||
      (await boundedJson(
        join(this.cacheDir, "sources", `${digest(id)}.json`),
        maxBytes * 2 + 8192,
        this.parseJson,
      ));
    if (!cached || !validTimestamp(cached.updatedAt)) return null;
    try {
      if (
        Buffer.byteLength(JSON.stringify(cached.raw ?? cached.data)) > maxBytes
      ) {
        this.cache.remove(id);
        return null;
      }
      const data = validate ? validate(cached.raw ?? cached.data) : cached.data;
      const row = { ...cached, data };
      this.cache.retain(id, row);
      return row;
    } catch {
      return null;
    }
  }
  async seed(id, filename, validate) {
    if (await this.getCached(id, validate)) return;
    const bundled = await readJson(join(BOOTSTRAP, filename));
    if (!bundled) return;
    try {
      const row = { ...bundled, data: validate(bundled.data) };
      this.cache.retain(id, row);
    } catch {
      /* Invalid bundle cannot become a live source. */
    }
  }
  async fetchJson(id, url, options = {}) {
    const objectIdentity = (value) => {
      if (!value || !["object", "function"].includes(typeof value)) return null;
      if (!this.requestIdentities.has(value))
        this.requestIdentities.set(value, ++this.nextRequestIdentity);
      return this.requestIdentities.get(value);
    };
    const key = `${id}:${digest([
      url,
      options.method || "GET",
      options.body || null,
      options.maxBytes ?? SOURCE_LIMIT,
      options.ttlMs ?? 0,
      options.timeoutMs ?? 15000,
      options.headers || {},
      options.respectResponseAge === true,
      objectIdentity(options.validate),
      objectIdentity(options.signal),
    ])}`;
    if (this.pending.has(key)) return this.pending.get(key);
    const job = this._fetchJson(id, url, options).finally(() => {
      this.pending.delete(key);
      this.pendingIds.delete(key);
    });
    this.pending.set(key, job);
    this.pendingIds.set(key, id);
    return job;
  }
  async _fetchJson(
    id,
    url,
    {
      validate,
      timeoutMs = 15000,
      ttlMs = 0,
      method = "GET",
      body,
      maxBytes = SOURCE_LIMIT,
      headers = {},
      respectResponseAge = false,
      requestObserver,
      signal,
    } = {},
  ) {
    const cached = await this.getCached(id, validate, maxBytes);
    if (cached && cached.url !== url) {
      this.cache.remove(id);
    }
    const usable = cached?.url === url ? cached : null;
    const cacheAge = usable
      ? this.now() - Date.parse(usable.updatedAt)
      : Infinity;
    if (usable && cacheAge >= 0 && cacheAge < ttlMs)
      return {
        ...usable,
        status: "cached",
        note: "Previously measured source; cached to avoid repeated upstream requests.",
      };
    let failure = "Network access is disabled.";
    if (signal?.aborted) failure = "Refresh deadline reached.";
    else if (this.online) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) controller.abort();
      let reader;
      let responseBody;
      try {
        const parsed = new URL(url);
        // Source URLs are authored by the server, never taken from API request parameters.
        if (parsed.protocol !== "https:" || parsed.username || parsed.password)
          throw new Error("Source URL must use HTTPS");
        controller.signal.throwIfAborted();
        const flight = Promise.resolve(
          this.fetchImpl(url, {
            method,
            body,
            signal: controller.signal,
            redirect: "error",
            ...(typeof requestObserver === "function"
              ? { [PROVIDER_REQUEST_OBSERVER]: requestObserver }
              : {}),
            headers: {
              Accept: "application/json",
              "User-Agent":
                "HookRadar/1.0 (+https://github.com/Uniswap/hooklist)",
              ...(body ? { "Content-Type": "application/json" } : {}),
              ...headers,
            },
          }),
        );
        // Fetch implementations can finish after their owner has timed out.
        // Observe the losing branch and release its body without publishing it.
        flight.then(
          (late) => {
            if (controller.signal.aborted) cancelSourceBody(late?.body);
          },
          () => {},
        );
        const response = await abortable(flight, controller.signal);
        responseBody = response.body;
        if (!response.ok)
          throw new Error(
            response.status === 429
              ? "Upstream rate limit reached (HTTP 429)"
              : `Upstream returned HTTP ${response.status}`,
          );
        const length = Number(response.headers.get("content-length"));
        if (Number.isFinite(length) && length > maxBytes)
          throw new Error("Source response exceeded size limit");
        reader = response.body.getReader();
        const chunks = [];
        let bytes = 0;
        while (true) {
          const { done, value } = await abortable(
            reader.read(),
            controller.signal,
          );
          if (done) break;
          bytes += value.length;
          if (bytes > maxBytes) {
            throw new Error("Source response exceeded size limit");
          }
          chunks.push(value);
        }
        const raw = this.parseJson(Buffer.concat(chunks).toString("utf8"));
        const data = validate ? validate(raw) : raw;
        controller.signal.throwIfAborted();
        let observedAt = this.now();
        if (respectResponseAge) {
          const age = response.headers.get("age");
          if (age !== null && !/^\d+$/.test(age))
            throw new Error("Source returned an invalid cache age.");
          const ageMs = age === null ? 0 : Number(age) * 1000;
          const date = response.headers.get("date");
          const origin = date === null ? null : Date.parse(date);
          if (
            !Number.isFinite(ageMs) ||
            ageMs < 0 ||
            (date !== null &&
              (!Number.isFinite(origin) || origin > observedAt + 60000))
          )
            throw new Error("Source cache time is unavailable.");
          observedAt -= Math.max(
            ageMs,
            origin === null ? 0 : Math.max(0, observedAt - origin),
          );
          if (observedAt < 0 || !Number.isFinite(observedAt))
            throw new Error(
              "Source cache time is outside the supported range.",
            );
        }
        const row = {
          data,
          ...(validate && data !== raw ? { raw } : {}),
          url,
          updatedAt: new Date(observedAt).toISOString(),
        };
        this.cache.retain(id, row);
        try {
          await atomicJson(
            join(this.cacheDir, "sources", `${digest(id)}.json`),
            row,
          );
          if (this.pruneDisk && ++this.cacheWrites % 64 === 0)
            await this.pruneCache();
        } catch {
          /* Read-only disks must not break source reads. */
        }
        return {
          ...row,
          status: "live",
          note: "Fetched successfully from the published source.",
        };
      } catch (error) {
        failure = signal?.aborted
          ? "Refresh deadline reached."
          : error?.name === "AbortError"
            ? "Source timed out."
            : String(error?.message || "Source request failed").slice(0, 160);
        // Stop unread error/oversized responses as well as timed-out requests.
        controller.abort();
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (controller.signal.aborted) {
          // Stream cancellation is cleanup, not part of the refresh's critical path.
          // An upstream whose cancellation never settles must not hold the shared flight.
          cancelSourceBody(reader || responseBody);
        }
        try {
          reader?.releaseLock();
        } catch {
          /* Reader cleanup cannot replace the source's result. */
        }
      }
    }
    if (usable)
      return {
        ...usable,
        status: "cached",
        note: `${failure} Showing the last successful response.`,
      };
    return {
      data: null,
      url,
      updatedAt: null,
      status: "unavailable",
      note: failure,
    };
  }
}

function* withdrawnPoolIds(inventory, previousPools) {
  const withdrawn = new Set();
  if (inventory?.appendOnly === true || !previousPools?.length)
    return withdrawn;
  const current = new Set();
  let operations = 0;
  const identity = (pool) =>
    pool.id || `${pool.chain}:${pool.address.toLowerCase()}`;
  for (const pool of inventory?.pools || []) {
    if (++operations % 1024 === 0) yield;
    current.add(identity(pool));
  }
  for (const pool of previousPools) {
    if (++operations % 1024 === 0) yield;
    const id = identity(pool);
    if (!current.has(id)) withdrawn.add(id);
  }
  return withdrawn;
}

/** Remove only the synthetic completeness-only inventory once attached to an
 * exact catalog platform by a status-only census publication. This migration
 * never changes hook inventories, measurements, history or source clocks. */
export function migrateSavedPlatformInventory(input) {
  if (!input || !Array.isArray(input.projects)) return input;
  let changed = false;
  const projects = input.projects.map((project) => {
    const inventory = project?.poolInventory;
    if (
      !inventory ||
      typeof inventory !== "object" ||
      Array.isArray(inventory) ||
      Object.keys(inventory).length !== 1 ||
      !Object.hasOwn(inventory, "complete") ||
      typeof inventory.complete !== "boolean"
    )
      return project;
    const { poolInventory: _inventory, ...candidate } = project;
    if (!isPublishedPlatformProject(candidate)) return project;
    changed = true;
    return candidate;
  });
  return changed ? { ...input, projects } : input;
}

/** A historical presentation, never canonical proof or a freshness clock. */
export function prepareSavedSnapshot(input, now = Date.now()) {
  let cached = migrateSavedPlatformInventory(input);
  if (
    cached?.summary &&
    typeof cached.summary === "object" &&
    !Array.isArray(cached.summary) &&
    cached.summary.indexedProjects === undefined
  ) {
    const { registeredProjects, registeredDeployments, ...summary } =
      cached.summary;
    cached = {
      ...cached,
      summary: {
        ...summary,
        indexedProjects: registeredProjects,
        indexedDeployments: registeredDeployments,
      },
    };
  }
  if (!validSnapshot(cached)) return null;
  const pools = cached.pools.map((pool) =>
    normalizeMetricProvenance(pool, cached.sources, true, now),
  );
  const projects = cached.projects.map((project) => ({
    ...project,
    name: cleanText(project.name, 200),
    description: cleanText(project.description),
    deployments: project.deployments.map((deployment) => ({
      ...deployment,
      name: cleanText(deployment.name, 200),
      description: cleanText(deployment.description),
    })),
    metrics: {
      ...project.metrics,
      poolCount: null,
      liquidityUsd: null,
      volumeUsd: { h1: null, h6: null, h24: null },
      coverage: "unavailable",
    },
  }));
  applyMetrics(projects, pools, marketCoverageNote(pools), now);
  return {
    ...cached,
    projects,
    pools,
    status: "cached",
    ...(cached.marketCoverage
      ? {
          marketCoverage: {
            ...cached.marketCoverage,
            networks: cached.marketCoverage.networks.map((network) => ({
              ...network,
              status: network.status === "live" ? "cached" : network.status,
            })),
          },
        }
      : {}),
    sources: cached.sources.map((source) =>
      source.status === "live"
        ? {
            ...source,
            status: "cached",
            note: "Saved snapshot. Refresh to check current source availability.",
          }
        : source,
    ),
    summary: {
      ...cached.summary,
      trackedPools: pools.length,
      ...aggregateCurrentMarkets(pools, now),
    },
    coverage: {
      ...cached.coverage,
      registryDeployments: registryDeploymentCount(cached.projects),
      description: marketCoverageNote(pools),
    },
  };
}

export class RadarStore {
  constructor({
    cacheDir = DEFAULT_CACHE,
    fetchImpl = fetch,
    now = () => Date.now(),
    online = true,
    metricsCollector = null,
    retainedMetricsCollector = null,
    census = null,
    marketEnricher = null,
    tokenMetadataClient = null,
    poolIndexService = null,
    initialInventory = null,
    historyRecovery = null,
    historyArchive = null,
    refreshBudgetMs = REFRESH_BUDGET,
  } = {}) {
    this.cacheDir = cacheDir;
    this.now = now;
    this.client = new SourceClient({ cacheDir, fetchImpl, now, online });
    this.metricsCollector = metricsCollector;
    this.retainedMetricsCollector = retainedMetricsCollector;
    this.retainedMetricsPending = null;
    this.retainedMetricsController = null;
    this.retainedMetricsLastAttempt = null;
    this.census = census;
    this.marketEnricher = marketEnricher;
    this.tokenMetadataClient = tokenMetadataClient;
    this.poolIndexService = poolIndexService;
    this.initialInventory = initialInventory;
    this.historyRecovery = historyRecovery;
    this.historyArchive = historyArchive;
    this.historyArchiveFailure = null;
    this.historyRecoveryReport = null;
    this.initialInventoryLookup = marketInventoryLookup(initialInventory);
    this.hookDirectory = new CensusHookDirectory();
    this.marketStamp = null;
    this.marketPoolsReference = null;
    this.publishedCanonicalInventory = null;
    this.publishedMarketLookup = null;
    this.marketOverlayRows = new Map();
    this.marketOverlayRevision = 0;
    this.marketOverlayPending = null;
    this.marketOverlayPublication = null;
    this.marketProjectionAdmission = null;
    this.marketAttributionCache = new MarketAttributionCache();
    this.collectedMarketFrame = null;
    this.backgroundProjectionTimer = null;
    this.completedPublications = Object.create(null);
    this.snapshotInventories = new WeakMap();
    this.joinedInventory = null;
    this.projectionTail = null;
    this.projectionController = new AbortController();
    this.refreshControllers = new Set();
    this.inventoryPending = null;
    this.inventoryStamp = null;
    this.inventoryPoolsReference = null;
    this.directoryInputs = null;
    this.snapshot = null;
    this.pending = null;
    this.lastAttempt = 0;
    this.initialized = false;
    this.initPromise = null;
    this.lastError = null;
    this.lastPersistenceError = null;
    this.lastRefreshFailure = null;
    this.savedStartupView = null;
    this.draining = false;
    this.refreshBudgetMs =
      Number.isFinite(refreshBudgetMs) && refreshBudgetMs > 0
        ? refreshBudgetMs
        : REFRESH_BUDGET;
  }
  get snapshot() {
    return this._snapshot;
  }
  set snapshot(value) {
    this._snapshot = value;
    // This memo only avoids re-consuming the exact current overlay frame.
    // Keeping it after another publication pins an obsolete full directory.
    // Per-pool canonical overlay proofs live separately in marketOverlayRows.
    if (this.marketOverlayPublication?.snapshot !== value)
      this.marketOverlayPublication = null;
    if (value && this.snapshotInventories)
      this.snapshotInventories.set(value, this.joinedInventory);
  }
  getSnapshotInventory(snapshot) {
    return this.snapshotInventories.has(snapshot)
      ? this.snapshotInventories.get(snapshot)
      : this.joinedInventory;
  }
  _cooperate(iterator, signal = this.projectionController.signal) {
    const combined =
      signal === this.projectionController.signal
        ? signal
        : AbortSignal.any([signal, this.projectionController.signal]);
    combined.throwIfAborted();
    // A yielded native/third-party promise may ignore cancellation. Its result
    // cannot resume the generator after drain, and does not hold the UI flight.
    return abortable(
      runCooperatively(iterator, { signal: combined }),
      combined,
    );
  }
  *_archiveRemovedHistorySteps(
    previous,
    candidate,
    {
      requireArchive = false,
      sourceJoined = this.getSnapshotInventory(previous),
    } = {},
  ) {
    if (!previous || previous === candidate) return;
    if (!this.historyArchive) {
      if (requireArchive)
        for (const batch of removedHistorySteps(
          previous,
          candidate,
          sourceJoined,
        )) {
          if (batch?.points.length)
            throw Object.assign(
              new Error(
                "History recovery requires an archive for observations outside the hot window.",
              ),
              { code: "RADAR_HISTORY_ARCHIVE" },
            );
          yield;
        }
      return;
    }
    try {
      let pending = [],
        count = 0,
        bytes = 2;
      const write = (batches) =>
        (this.historyArchive.appendMany
          ? this.historyArchive.appendMany(batches)
          : batches.reduce(
              (tail, batch) =>
                tail.then(() => this.historyArchive.append(batch)),
              Promise.resolve(),
            )
        ).catch((error) => {
          // The cooperative runner rejects yielded promises directly rather
          // than injecting them through generator.throw().
          this.historyArchiveFailure = safeHistoryArchiveReason(error);
          throw error;
        });
      for (const batch of removedHistorySteps(
        previous,
        candidate,
        sourceJoined,
      )) {
        if (!batch) {
          yield;
          continue;
        }
        const size = Buffer.byteLength(JSON.stringify(batch)) + 1;
        if (
          pending.length &&
          (count + batch.points.length > 1000 || bytes + size > 2 * 1024 * 1024)
        ) {
          yield write(pending);
          pending = [];
          count = 0;
          bytes = 2;
        }
        pending.push(batch);
        count += batch.points.length;
        bytes += size;
      }
      if (pending.length) yield write(pending);
      this.historyArchiveFailure = null;
    } catch (error) {
      this.historyArchiveFailure = safeHistoryArchiveReason(error);
      throw error;
    }
  }
  /** Archive writes may yield to a retained-price or canonical publication.
   * A changed frame must be rebuilt. A verified append may retain the original
   * candidate prefix, but never advances its inventory pointer or source clocks. */
  *_preparePublicationSteps(candidate, inventory) {
    if (!this.historyArchive)
      return yield* this._preserveMarketOverlaysSteps(candidate, inventory);
    const result = yield* this._preserveMarketOverlaysSteps(
      candidate,
      inventory,
    );
    const committed = this.snapshot;
    const revision = this.marketOverlayRevision;
    const canonical = this.census?.getInventory();
    // Capture the exact native receipt and immutable source prefixes before any
    // archival await. Later counts or an appendOnly flag alone are not proof.
    const indexService = this.poolIndexService;
    const publications = indexService?.published;
    const nativePublicationRequired = publications instanceof WeakMap;
    const publication = nativePublicationRequired
      ? publications.get(inventory)
      : null;
    const heads = publication?.heads;
    const nativePreserved = () =>
      this.poolIndexService === indexService &&
      indexService?.published === publications &&
      publications?.get(inventory) === publication &&
      publication?.heads === heads &&
      indexService?.preservesHeads?.(heads) === true;
    const hadNativeProof = Array.isArray(heads) && nativePreserved();
    const packedLookup = (source) =>
      source?.pools &&
      Array.isArray(source.networks) &&
      source.networks.every((network) =>
        packedCensusInventoryStore(source.pools, network.chain),
      )
        ? marketInventoryLookup(source)
        : null;
    const candidateLookup = hadNativeProof ? packedLookup(inventory) : null;
    const canonicalLookup =
      canonical === inventory
        ? candidateLookup
        : hadNativeProof
          ? packedLookup(canonical)
          : null;
    yield* this._archiveRemovedHistorySteps(committed, result);
    let publicationConflicts = 0;
    let latest;
    let canonicalPreserved = false;
    // Keep the original snapshot/revision short-circuit: a failed earlier
    // dimension must not start a compatibility scan or extra canonical read.
    if (
      this.snapshot === committed &&
      this.marketOverlayRevision === revision
    ) {
      latest = this.census?.getInventory();
      canonicalPreserved =
        latest === canonical &&
        (!nativePublicationRequired ||
          (hadNativeProof && inventory === canonical));
      if (
        !canonicalPreserved &&
        candidateLookup &&
        canonicalLookup &&
        nativePreserved()
      ) {
        const latestLookup = packedLookup(latest);
        canonicalPreserved =
          (yield* preservesMarketInventorySteps(
            inventory,
            latest,
            candidateLookup,
            latestLookup,
          )) &&
          (canonical === inventory ||
            (yield* preservesMarketInventorySteps(
              canonical,
              latest,
              canonicalLookup,
              latestLookup,
            )));
        // Only factory-backed immutable store lineage proves ancestry before a
        // newer census prefix reaches SQLite. Generic rows stay reference-fenced.
        // Retain the exact terminal generation fence around the shared iterator.
        if (canonicalPreserved)
          canonicalPreserved = this.census?.getInventory() === latest;
      }
      if (nativePublicationRequired && (!hadNativeProof || !nativePreserved()))
        canonicalPreserved = false;
    }
    if (
      (this.snapshot !== committed && (publicationConflicts |= 1)) ||
      (this.marketOverlayRevision !== revision &&
        (publicationConflicts |= 2)) ||
      (!canonicalPreserved && (publicationConflicts |= 4))
    )
      throw Object.assign(
        new Error(
          "Newer observations are being published; the previous view is preserved.",
        ),
        {
          code: "RADAR_MARKET_OVERLAY_BUSY",
          publicationStage: "archive-fence",
          publicationConflictMask: publicationConflicts,
        },
      );
    return result;
  }
  _initialInventoryPreserved(current = this.census?.getInventory()) {
    return Boolean(
      this.initialInventory &&
      this.initialInventoryLookup &&
      runSynchronously(
        preservesMarketInventorySteps(
          this.initialInventory,
          current,
          this.initialInventoryLookup,
          marketInventoryLookup(current),
        ),
      ),
    );
  }
  _canonicalInventory() {
    const current = this.census?.getInventory();
    return this._initialInventoryPreserved(current)
      ? this.initialInventory
      : current;
  }
  _releaseInitialInventory() {
    if (!this.initialized || !this.joinedInventory) return;
    this.initialInventory = null;
    this.initialInventoryLookup = null;
  }
  _rememberCanonicalInventory(inventory) {
    this.publishedCanonicalInventory = inventory
      ? Object.freeze({
          ...inventory,
          networks: Object.freeze(
            inventory.networks.map((network) => Object.freeze({ ...network })),
          ),
        })
      : null;
    this.publishedMarketLookup = marketInventoryLookup(inventory);
  }
  startBackgroundProjection({
    intervalMs = 5000,
    onError = () => {},
    onSuccess = () => {},
    refreshSources = false,
  } = {}) {
    if (
      !Number.isSafeInteger(intervalMs) ||
      intervalMs < 10 ||
      intervalMs > 300000 ||
      typeof onError !== "function" ||
      typeof onSuccess !== "function" ||
      typeof refreshSources !== "boolean"
    )
      throw new RangeError(
        "Background publication requires a bounded interval and error callback.",
      );
    if (this.backgroundProjectionTimer || this.draining) return this;
    this.completedPublications ??= Object.create(null);
    const failedOperations = new Map();
    const report = (error, component, operation) => {
      if (this.draining) return;
      // Inventory synchronization also runs a market projection after its
      // canonical commit. Only that internal stage can redirect its failure.
      if (publicationFailureOperations.get(error) === "market-projection") {
        component = "markets";
        operation = "market-projection";
      }
      failedOperations.set(operation, {
        component,
        token: this.completedPublications[operation],
      });
      try {
        Promise.resolve(onError(error, component, operation)).catch(() => {});
      } catch {
        /* An operational observer cannot stop publication. */
      }
    };
    const complete = (component, operation) => {
      if (this.draining) return;
      failedOperations.delete(operation);
      try {
        Promise.resolve(onSuccess(component, operation)).catch(() => {});
      } catch {
        /* An operational observer cannot stop publication. */
      }
    };
    const observe = (start, component, operation, completed = () => true) => {
      const before = this.completedPublications[operation];
      let job;
      try {
        job = start();
      } catch (error) {
        report(error, component, operation);
        return;
      }
      Promise.resolve(job)
        .then(() => {
          // Only a validated commit/collection advances this operation's token.
          // A newer committed source frame also completes the work; a reader
          // frame, retained response or superseded no-op does not.
          const current = this.completedPublications[operation];
          if (
            current !== before &&
            failedOperations.get(operation)?.token !== current &&
            completed()
          )
            complete(component, operation);
        })
        .catch((error) => report(error, component, operation));
    };
    const pulse = () => {
      if (this.draining || !this.initialized || !this.snapshot) return;
      try {
        if (
          refreshSources &&
          this.client.online &&
          !this.pending &&
          this.now() - this.lastAttempt >= REFRESH_TTL
        )
          observe(
            () => this.refresh(),
            "snapshot",
            "refresh",
            () => !this.lastError && !this.lastPersistenceError,
          );
        if (
          this.retainedMetricsCollector &&
          this.client.online &&
          !this.retainedMetricsPending &&
          (this.retainedMetricsLastAttempt === null ||
            this.now() - this.retainedMetricsLastAttempt >= 60000)
        )
          observe(
            () => this.collectRetainedMarkets(),
            "markets",
            "retained-markets",
          );
        const inventory = this.census?.getInventory();
        const stamp = inventory
          ? `${inventory.revision ?? ""}:${inventory.generatedAt}`
          : null;
        const enriched = this.marketEnricher?.getSnapshot();
        const needsMarkets = enriched && enriched !== this.marketStamp;
        // Each lane owns one coalesced flight. Never append periodic callbacks
        // to a long SQLite transaction's projection queue.
        if (
          inventory &&
          stamp !== this.inventoryStamp &&
          !this.inventoryPending &&
          !this.projectionTail
        )
          observe(() => this.syncInventoryAsync(), "inventory", "inventory");
        else if (
          needsMarkets &&
          !this.projectionTail &&
          !this.marketProjectionPending
        )
          observe(() => this.syncMarkets(), "markets", "market-projection");
        // Admit the normal projection first. Its identical source frame needs
        // no competing overlay; a blocked canonical job or a newer market
        // frame still gets the independent retained-generation path below.
        if (needsMarkets && this.joinedInventory && !this.marketOverlayPending)
          observe(
            () => this.syncRetainedMarkets(),
            "markets",
            "market-overlay",
          );
        // Another verified publication path may already have completed a
        // failed projection (for example a full refresh consuming its inputs).
        // Reader-only freshness frames never advance these commit tokens.
        for (const [operation, failure] of failedOperations)
          if (
            operation !== "pulse" &&
            this.completedPublications[operation] !== failure.token &&
            (operation !== "refresh" ||
              (!this.lastError && !this.lastPersistenceError))
          )
            complete(failure.component, operation);
        complete("snapshot", "pulse");
      } catch (error) {
        report(error, "snapshot", "pulse");
      }
    };
    this.backgroundProjectionTimer = setInterval(pulse, intervalMs);
    this.backgroundProjectionTimer.unref?.();
    return this;
  }
  collectRetainedMarkets() {
    if (
      this.draining ||
      !this.initialized ||
      !this.client.online ||
      !this.retainedMetricsCollector
    )
      return Promise.resolve(this.snapshot);
    if (this.retainedMetricsPending) return this.retainedMetricsPending;
    if (
      this.retainedMetricsLastAttempt !== null &&
      this.now() - this.retainedMetricsLastAttempt < 60000
    )
      return Promise.resolve(this.snapshot);
    this.retainedMetricsLastAttempt = this.now();
    const controller = new AbortController();
    this.retainedMetricsController = controller;
    const timer = setTimeout(() => controller.abort(), this.refreshBudgetMs);
    timer.unref?.();
    const fetchJson = (id, url, options = {}) => {
      controller.signal.throwIfAborted();
      return this.client.fetchJson(id, url, {
        ...options,
        signal: controller.signal,
      });
    };
    const pending = (async () => {
      try {
        const config = await abortable(
          fetchJson("frontier-chains", FRONTIER_URL, {
            ttlMs: 300000,
            validate: validateFrontier,
          }),
          controller.signal,
        );
        controller.signal.throwIfAborted();
        if (!config.data)
          throw new Error("Frontier market configuration is unavailable.");
        const metrics = await abortable(
          this.retainedMetricsCollector({
            fetchJson,
            frontierChains: config.data,
            now: this.now(),
            signal: controller.signal,
          }),
          controller.signal,
        );
        controller.signal.throwIfAborted();
        await abortable(
          this.syncCollectedMarkets(metrics, { signal: controller.signal }),
          controller.signal,
        );
        controller.signal.throwIfAborted();
        this.completedPublications["retained-markets"] = {};
        return this.snapshot;
      } finally {
        clearTimeout(timer);
        if (this.retainedMetricsController === controller)
          this.retainedMetricsController = null;
      }
    })();
    this.retainedMetricsPending = pending;
    pending
      .finally(() => {
        if (this.retainedMetricsPending === pending)
          this.retainedMetricsPending = null;
      })
      .catch(() => {});
    return pending;
  }
  syncRetainedMarkets() {
    if (this.draining) return Promise.resolve(this.snapshot);
    if (this.marketOverlayPending) return this.marketOverlayPending;
    if (
      this.marketProjectionPending &&
      this.marketProjectionAdmission?.enriched ===
        this.marketEnricher?.getSnapshot()
    )
      return Promise.resolve(this.snapshot);
    const pending = this._cooperate(this._syncRetainedMarketsSteps()).catch(
      (error) => {
        if (this.draining && error?.name === "AbortError") return this.snapshot;
        throw error;
      },
    );
    this.marketOverlayPending = pending;
    pending
      .finally(() => {
        if (this.marketOverlayPending === pending)
          this.marketOverlayPending = null;
      })
      .catch(() => {});
    return pending;
  }
  async syncCollectedMarkets(metrics, { signal } = {}) {
    if (this.draining || signal?.aborted || !this.joinedInventory)
      return this.snapshot;
    // Consume only the original producer-branded objects. Public provider
    // labels, JSON caches and copies cannot authorize canonical price updates.
    const pools = (metrics?.pools || []).filter((row) =>
      getFrontierMarketObservation(row),
    );
    const collected = Object.freeze({
      pools: Object.freeze(pools),
      signal,
      sources: Object.freeze(
        (metrics.sources || []).map((source) => Object.freeze({ ...source })),
      ),
    });
    this.collectedMarketFrame = collected;
    // An empty/quarantined newer frame invalidates any older yielded handoff.
    if (!pools.length) return this.snapshot;
    if (this.marketOverlayPending)
      await this.marketOverlayPending.catch(() => {});
    if (
      this.draining ||
      signal?.aborted ||
      this.collectedMarketFrame !== collected
    )
      return this.snapshot;
    const pending = this._cooperate(
      this._syncRetainedMarketsSteps(collected),
      signal || this.projectionController.signal,
    );
    this.marketOverlayPending = pending;
    try {
      return await pending;
    } finally {
      if (this.marketOverlayPending === pending)
        this.marketOverlayPending = null;
    }
  }
  *_syncRetainedMarketsSteps(collected = null) {
    const base = this.snapshot;
    const previous = this.publishedCanonicalInventory;
    const before = this.publishedMarketLookup;
    const joined = this.getSnapshotInventory(base);
    if (
      this.draining ||
      collected?.signal?.aborted ||
      !base ||
      !previous ||
      !before ||
      (!collected && !this.marketEnricher) ||
      !joined?.heads ||
      !this.poolIndexService?.preservesHeads?.(joined.heads)
    )
      return;
    // Read the enricher first so aging and canonical quarantine still run.
    // A frame already consumed by a complete projection needs no overlay scan.
    const enriched = collected || this.marketEnricher.getSnapshot();
    if (
      !enriched ||
      (!collected && enriched === this.marketStamp) ||
      (this.marketOverlayPublication?.snapshot === base &&
        this.marketOverlayPublication.enriched === enriched)
    )
      return;
    const inventory = this.census?.getInventory();
    const current = marketInventoryLookup(inventory);
    if (
      !(yield* preservesMarketInventorySteps(
        previous,
        inventory,
        before,
        current,
      ))
    )
      return;
    const known = new Map(
      base.pools.map((pool) => [poolIdentityKey(pool), pool]),
    );
    const chainIds = new Map(
      base.chains.map((chain) => [chain.slug, chain.id]),
    );
    const bounds = new Map(
      previous.networks.map((network) => [network.chain, network]),
    );
    const replacements = new Map();
    const staged = new Map(this.marketOverlayRows);
    let work = 0;
    for (const original of enriched.pools || []) {
      if (++work % 256 === 0) yield;
      const proof = collected ? getFrontierMarketObservation(original) : null;
      if (collected && !proof) continue;
      const row = proof
        ? { ...proof, metricProvenance: proof.provenance }
        : original;
      const key = poolIdentityKey(row);
      const old = known.get(key);
      if (!old || !newerMarketRow(old, row, this.now())) continue;
      const canonical = before.get(old);
      const identity = canonicalMarketIdentity(canonical);
      const latest = current.get(old);
      if (
        !identity ||
        identity !== canonicalMarketIdentity(latest) ||
        canonical.creationBlock > bounds.get(old.chain)?.scannedToBlock ||
        !marketRowMatchesCanonical(
          {
            ...old,
            chainId: chainIds.get(old.chain),
            ...(proof ? { tokens: proof.tokens } : {}),
          },
          canonical,
          bounds.get(old.chain)?.manager,
        ) ||
        !marketRowMatchesCanonical(
          row,
          canonical,
          bounds.get(old.chain)?.manager,
        ) ||
        !validTimestamp(row.metricUpdatedAt) ||
        !windowsField(row.volumeUsd) ||
        !nullableNumber(row.liquidityUsd) ||
        !urlField(row.url) ||
        !["live", "cached"].includes(row.metricStatus) ||
        !(proof
          ? row.metricProvider === "frontier"
          : ["dexscreener", "geckoterminal", "envio"].includes(
              row.metricProvider,
            ))
      )
        continue;
      const pool = retainPoolStructure(old, row, this.now());
      replacements.set(key, pool);
      staged.set(key, {
        identity,
        pool,
        heads: joined.heads,
        sources: enriched.sources || [],
        publicationRevision: this.marketOverlayRevision + 1,
      });
    }
    if (!replacements.size) return;
    const sources = [
      ...new Map(
        [...base.sources, ...(enriched.sources || [])].map((source) => [
          source.id,
          source,
        ]),
      ).values(),
    ];
    const candidate = yield* this._marketOverlaySnapshotSteps(
      base,
      replacements,
      sources,
    );
    yield* this._archiveRemovedHistorySteps(base, candidate);
    // A source replacement, canonical publication, or drain can happen while
    // the bounded price aggregation yields. None may inherit this old proof.
    const latestInventory = this.census?.getInventory();
    const latestLookup = marketInventoryLookup(latestInventory);
    if (
      !(yield* preservesMarketInventorySteps(
        previous,
        latestInventory,
        before,
        latestLookup,
      ))
    )
      return;
    if (
      this.draining ||
      collected?.signal?.aborted ||
      this.snapshot !== base ||
      this.publishedCanonicalInventory !== previous ||
      !this.poolIndexService.preservesHeads(joined.heads) ||
      this.census?.getInventory() !== latestInventory ||
      (collected
        ? this.collectedMarketFrame !== enriched
        : this.marketEnricher.getSnapshot() !== enriched)
    )
      return;
    for (const [key] of replacements) {
      if (
        staged.get(key).identity !==
        canonicalMarketIdentity(latestLookup.get(known.get(key)))
      )
        return;
    }
    this.marketOverlayRows = staged;
    this.marketOverlayRevision++;
    this.snapshot = candidate;
    this.marketOverlayPublication = { snapshot: candidate, enriched };
    this.completedPublications["market-overlay"] = {};
    return candidate;
  }
  *_marketOverlaySnapshotSteps(
    base,
    replacements,
    sources = base.sources,
    committedHistory = null,
  ) {
    const changedProjects = new Set();
    const pools = base.pools.map((pool) => {
      const next = replacements.get(poolIdentityKey(pool));
      if (!next) return pool;
      changedProjects.add(pool.projectId);
      return next;
    });
    const priced = [];
    const projects = [];
    let work = 0;
    for (const project of base.projects) {
      if (++work % 512 === 0) yield;
      const next = changedProjects.has(project.id)
        ? {
            ...project,
            history: mergeCommittedHistory(
              project.history,
              committedHistory?.projects.get(project.id),
            ),
          }
        : project;
      projects.push(next);
      if (next !== project) priced.push(next);
    }
    yield* applyMetricsSteps(
      priced,
      pools,
      "Prices and rolling volumes are supplied by market providers for exact indexed pool IDs. Unpriced pools remain in the census and can be browsed separately.",
      this.now(),
    );
    const byProject = new Map();
    for (const pool of pools) {
      if (!byProject.has(pool.projectId)) byProject.set(pool.projectId, []);
      byProject.get(pool.projectId).push(pool);
    }
    for (const project of priced) {
      const contributors = byProject
        .get(project.id)
        .filter((pool) => observedMetricValue(pool, "h24") !== null);
      const fresh = freshMeasurements(contributors, this.now());
      project.history = appendHistory(
        project.history || [],
        fresh ? project.metrics.volumeUsd.h24 : null,
        fresh ? Date.parse(oldestMeasurement(contributors)) : this.now(),
      );
    }
    const amounts = yield* aggregateCurrentMarketsSteps(pools, this.now());
    const { volumeUsd } = amounts;
    const contributors = pools.filter(
      (pool) => observedMetricValue(pool, "h24") !== null,
    );
    const fresh = freshMeasurements(contributors, this.now());
    return {
      ...base,
      generatedAt: new Date(this.now()).toISOString(),
      projects,
      pools,
      sources,
      summary: {
        ...base.summary,
        ...amounts,
      },
      coverage: { ...base.coverage, description: marketCoverageNote(pools) },
      history: appendHistory(
        mergeCommittedHistory(base.history, committedHistory?.history),
        fresh ? volumeUsd.h24 : null,
        fresh ? Date.parse(oldestMeasurement(contributors)) : this.now(),
      ),
    };
  }
  *_preservedOverlayHistorySteps(candidate, inventory, lookup, replacements) {
    const committed = this.snapshot;
    const joined = this.getSnapshotInventory(committed);
    const previousInventory = this.publishedCanonicalInventory;
    const previousLookup = this.publishedMarketLookup;
    if (
      !committed ||
      !joined?.heads ||
      !this.poolIndexService?.preservesHeads?.(joined.heads) ||
      !(yield* preservesMarketInventorySteps(
        previousInventory,
        inventory,
        previousLookup,
        lookup,
      ))
    )
      return null;
    const affected = new Set(
      [...replacements.values()].map((pool) => pool.projectId),
    );
    const candidates = new Map(
      candidate.pools.map((pool) => [poolIdentityKey(pool), pool]),
    );
    const contributors = new Map(
      committed.pools
        .filter((pool) => observedMetricValue(pool, "h24") !== null)
        .map((pool) => [poolIdentityKey(pool), pool]),
    );
    const unsafe = new Set();
    const chainIds = new Map(
      committed.chains.map((chain) => [chain.slug, chain.id]),
    );
    const managers = new Map(
      inventory.networks.map((network) => [network.chain, network.manager]),
    );
    let globalSafe = true;
    let work = 0;
    // A project's existing aggregate history must not cross an ownership or
    // canonical-membership change. Global history needs the entire contributing
    // set; a proven single-pool overlay is insufficient to vouch for its peers.
    for (const pool of [...contributors.values(), ...candidate.pools]) {
      if (++work % 256 === 0) yield;
      if (observedMetricValue(pool, "h24") === null) continue;
      const key = poolIdentityKey(pool);
      const previous = contributors.get(key);
      const next = candidates.get(key);
      const canonical = lookup.get(pool);
      if (
        !previous ||
        !next ||
        previous.projectId !== next.projectId ||
        !canonicalMarketIdentity(canonical) ||
        canonicalMarketIdentity(previousLookup.get(pool)) !==
          canonicalMarketIdentity(canonical) ||
        !marketRowMatchesCanonical(
          { ...pool, chainId: chainIds.get(pool.chain) },
          canonical,
          managers.get(pool.chain),
        )
      ) {
        globalSafe = false;
        unsafe.add(pool.projectId);
        if (previous) unsafe.add(previous.projectId);
        if (next) unsafe.add(next.projectId);
      }
    }
    const projects = new Map();
    for (const project of committed.projects) {
      if (++work % 512 === 0) yield;
      if (affected.has(project.id) && !unsafe.has(project.id))
        projects.set(project.id, project.history);
    }
    return {
      snapshot: committed,
      heads: joined.heads,
      projects,
      history: globalSafe ? committed.history : undefined,
    };
  }
  *_preserveMarketOverlaysSteps(candidate, inventory) {
    let publicationConflicts = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const revision = this.marketOverlayRevision;
      const lookup = marketInventoryLookup(inventory);
      if (!lookup || !this.marketOverlayRows.size) return candidate;
      const replacements = new Map();
      const sourceReplacements = new Map();
      let upgradedAny = false;
      const retained = new Map();
      const chainIds = new Map(
        candidate.chains.map((chain) => [chain.slug, chain.id]),
      );
      const managers = new Map(
        inventory.networks.map((network) => [network.chain, network.manager]),
      );
      const validHeads = new Map();
      const preservesHeads = (heads) => {
        if (!validHeads.has(heads))
          validHeads.set(
            heads,
            this.poolIndexService?.preservesHeads?.(heads) === true,
          );
        return validHeads.get(heads);
      };
      let work = 0;
      for (const pool of candidate.pools) {
        if (++work % 256 === 0) yield;
        const key = poolIdentityKey(pool);
        const overlay = this.marketOverlayRows.get(key);
        if (
          !overlay ||
          !preservesHeads(overlay.heads) ||
          overlay.identity !== canonicalMarketIdentity(lookup.get(pool))
        )
          continue;
        // A normal market projection may have already published a newer value
        // than this remembered overlay. Remember that proven value too, so a
        // later slow metadata refresh cannot resurrect an older measurement.
        const canonical = lookup.get(pool);
        const upgraded =
          newerMarketRow(overlay.pool, pool, this.now()) &&
          marketRowMatchesCanonical(
            { ...pool, chainId: chainIds.get(pool.chain) },
            canonical,
            managers.get(pool.chain),
          ) &&
          validTimestamp(pool.metricUpdatedAt) &&
          windowsField(pool.volumeUsd) &&
          nullableNumber(pool.liquidityUsd) &&
          urlField(pool.url) &&
          ["live", "cached"].includes(pool.metricStatus) &&
          ["dexscreener", "geckoterminal", "envio"].includes(
            pool.metricProvider,
          );
        const sourceIds = new Set(
          (overlay.sources || []).map((source) => source.id),
        );
        retained.set(
          key,
          upgraded
            ? {
                ...overlay,
                pool,
                publicationRevision: revision + 1,
                sources: candidate.sources.filter((source) =>
                  sourceIds.has(source.id),
                ),
              }
            : overlay,
        );
        upgradedAny ||= upgraded;
        if (newerMarketRow(pool, overlay.pool, this.now())) {
          replacements.set(
            key,
            retainPoolStructure(pool, overlay.pool, this.now()),
          );
          for (const source of overlay.sources || []) {
            const previousSource = sourceReplacements.get(source.id);
            if (
              !previousSource ||
              (overlay.publicationRevision || 0) >=
                previousSource.publicationRevision
            )
              sourceReplacements.set(source.id, {
                source,
                publicationRevision: overlay.publicationRevision || 0,
              });
          }
        }
      }
      const committedHistory = replacements.size
        ? yield* this._preservedOverlayHistorySteps(
            candidate,
            inventory,
            lookup,
            replacements,
          )
        : null;
      const result = replacements.size
        ? yield* this._marketOverlaySnapshotSteps(
            candidate,
            replacements,
            [
              ...new Map(
                [
                  ...candidate.sources,
                  ...[...sourceReplacements.values()].map(
                    (entry) => entry.source,
                  ),
                ].map((source) => [source.id, source]),
              ).values(),
            ],
            committedHistory,
          )
        : candidate;
      if (
        (revision !== this.marketOverlayRevision &&
          (publicationConflicts |= 2)) ||
        (committedHistory &&
          committedHistory.snapshot !== this.snapshot &&
          (publicationConflicts |= 1))
      )
        continue;
      if (retained.size) {
        const latestInventory = this.census?.getInventory();
        const latestLookup = marketInventoryLookup(latestInventory);
        const sourcePreserved = yield* preservesMarketInventorySteps(
          inventory,
          latestInventory,
          lookup,
          latestLookup,
        );
        if (
          (revision !== this.marketOverlayRevision &&
            (publicationConflicts |= 2)) ||
          (committedHistory &&
            committedHistory.snapshot !== this.snapshot &&
            (publicationConflicts |= 1)) ||
          (this.census?.getInventory() !== latestInventory &&
            (publicationConflicts |= 4))
        )
          continue;
        validHeads.clear();
        if (
          !sourcePreserved ||
          (committedHistory && !preservesHeads(committedHistory.heads)) ||
          [...retained.values()].some(
            (overlay) =>
              !preservesHeads(overlay.heads) ||
              overlay.identity !==
                canonicalMarketIdentity(latestLookup.get(overlay.pool)),
          )
        ) {
          this.marketOverlayRows = new Map();
          return candidate;
        }
      }
      this.marketOverlayRows = retained;
      if (upgradedAny) this.marketOverlayRevision++;
      return result;
    }
    const error = new Error(
      "Newer market observations are being published; retain the completed snapshot.",
    );
    error.code = "RADAR_MARKET_OVERLAY_BUSY";
    error.publicationStage = "overlay-rebase";
    error.publicationConflictMask = publicationConflicts;
    throw error;
  }
  async init() {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._init();
    return this.initPromise;
  }
  async _init() {
    await Promise.all([
      this.client.seed("registry", "registry.json", validateRegistry),
      this.client.seed("chains", "chains.json", validateChains),
      this.client.seed("frontier-chains", "frontier.json", validateFrontier),
    ]);
    const saved = await readPrimarySnapshot(
      join(this.cacheDir, "snapshot.json"),
      { signal: this.projectionController.signal },
    );
    this.snapshot = prepareSavedSnapshot(saved, this.now());
    if (saved !== null && !this.snapshot)
      throw Object.assign(
        new Error(
          "Saved snapshot failed validation; initialization stopped to preserve recorded history.",
        ),
        { code: "RADAR_SNAPSHOT_INVALID" },
      );
    if (!this.snapshot)
      this.snapshot = await this.buildSnapshot({ bootstrap: true });
    if (this.historyRecovery) {
      const recovered = await recoverProjectHistory(
        this.snapshot,
        this.historyRecovery,
        {
          signal: this.projectionController.signal,
          validateSnapshot: validSnapshot,
          normalizeSnapshot: migrateSavedPlatformInventory,
        },
      );
      await this._cooperate(
        this._archiveRemovedHistorySteps(
          recovered.sourceSnapshot,
          recovered.archiveTarget,
          {
            requireArchive: true,
            sourceJoined: null,
          },
        ),
        this.projectionController.signal,
      );
      this.projectionController.signal.throwIfAborted();
      this.snapshot = recovered.snapshot;
      this.historyRecoveryReport = recovered.report;
    }
    if (!this.directoryInputs) {
      const [registry, chains, frontier] = await Promise.all([
        this.client.getCached("registry", validateRegistry),
        this.client.getCached("chains", validateChains),
        this.client.getCached("frontier-chains", validateFrontier),
      ]);
      this.directoryInputs = {
        registry: registry?.data || [],
        chainData: chains?.data || {},
        frontierChains: frontier?.data || [],
      };
    }
    this.initialized = true;
    this._releaseInitialInventory();
    this.marketEnricher?.prioritizePools?.(
      this.snapshot.pools.map((pool) => ({
        ...pool,
        chainId: this.snapshot.chains.find((chain) => chain.slug === pool.chain)
          ?.id,
      })),
    );
  }
  async buildSnapshot({ bootstrap = false } = {}) {
    const controller = new AbortController();
    if (this.draining) controller.abort();
    this.refreshControllers.add(controller);
    const timer = bootstrap
      ? null
      : setTimeout(() => controller.abort(), this.refreshBudgetMs);
    const fetchJson = (id, url, options) =>
      this.client.fetchJson(id, url, {
        ...options,
        ...(url.startsWith("https://api.geckoterminal.com/")
          ? { timeoutMs: 40000 }
          : {}),
        signal: controller.signal,
      });
    try {
      return await this._buildSnapshot({
        bootstrap,
        fetchJson,
        signal: controller.signal,
        onCollected: () => {
          // The network budget bounds collection, not a legitimate multi-minute
          // atomic SQL projection. Drain has its own independent cancellation.
          if (timer) clearTimeout(timer);
        },
      });
    } finally {
      if (timer) clearTimeout(timer);
      this.refreshControllers.delete(controller);
    }
  }
  async _buildSnapshot({
    bootstrap,
    fetchJson,
    signal = this.projectionController.signal,
    onCollected,
  }) {
    const drainSignal = this.projectionController.signal;
    drainSignal.throwIfAborted();
    const definitions = [
      ["registry", "Uniswap hook registry", REGISTRY_URL, validateRegistry],
      ["chains", "Uniswap chain registry", CHAINS_URL, validateChains],
      [
        "frontier-chains",
        "Frontier deployment configuration",
        FRONTIER_URL,
        validateFrontier,
      ],
    ];
    const results = await abortable(
      Promise.all(
        definitions.map(async ([id, name, url, validate]) => {
          const result = bootstrap
            ? {
                ...(await this.client.getCached(id, validate)),
                status: "cached",
                note: "Bundled public source captured at the displayed timestamp. Refresh checks for updates.",
              }
            : await fetchJson(id, url, { validate });
          return {
            ...result,
            id,
            name,
            url,
            status: result.data ? result.status : "unavailable",
            updatedAt: result.updatedAt || null,
          };
        }),
      ),
      drainSignal,
    );
    drainSignal.throwIfAborted();
    const registry = results[0].data || [];
    const chainData = results[1].data || {};
    const frontierChains = results[2].data || [];
    let inventory = this._canonicalInventory();
    const sources = results.map(
      ({ id, name, url, status, updatedAt, note }) => ({
        id,
        name,
        url,
        status,
        updatedAt,
        note,
      }),
    );
    let metrics = {
      pools: [],
      sources: [],
      history: [],
      measuredChains: [],
      totalObservedPools: 0,
      notes:
        "Market coverage uses only pools with an exact hook address. Registry presence does not prove trading activity.",
    };
    if (!bootstrap && this.metricsCollector) {
      try {
        metrics = {
          ...metrics,
          ...(await abortable(
            this.metricsCollector({
              fetchJson,
              signal,
              registry,
              frontierChains,
              now: this.now(),
              inventory: inventory?.pools || [],
            }),
            drainSignal,
          )),
        };
      } catch (error) {
        if (drainSignal.aborted) throw error;
        sources.push({
          id: "market-collector",
          name: "Market sources",
          url: REGISTRY_URL,
          status: "unavailable",
          updatedAt: null,
          note: "Market collection failed. Registry browsing remains available.",
        });
      }
    }
    // Legacy/public AMM measurements are already complete here. Known canonical
    // rows can be updated before a historical SQLite projection acquires them.
    drainSignal.throwIfAborted();
    // A source deadline lets the collector finish returning completed chains
    // plus each timed-out source's honest cached/unavailable result. Only drain
    // discards the whole acquisition; late provider data cannot enter its cache.
    await abortable(
      this.syncCollectedMarkets(metrics, { signal: drainSignal }),
      drainSignal,
    );
    drainSignal.throwIfAborted();
    onCollected?.();
    // Background indexing can advance while slower legacy collectors are awaited.
    // Attribute prices against the newest proven hook identities before consuming the price revision.
    return this._withProjection((projectionSignal) =>
      this._projectSnapshot({
        bootstrap,
        registry,
        chainData,
        frontierChains,
        inventory,
        metrics,
        sources,
        signal: projectionSignal,
      }),
    );
  }
  _withProjection(operation) {
    if (this.draining && this.snapshot) return Promise.resolve(this.snapshot);
    const previous = this.projectionTail;
    const signal = this.projectionController.signal;
    const admitted = () => {
      if (this.draining && this.snapshot) return this.snapshot;
      signal.throwIfAborted();
      return operation(signal);
    };
    const work = previous
      ? previous.catch(() => {}).then(admitted)
      : Promise.resolve().then(admitted);
    const pending = abortable(work, signal).catch((error) => {
      if (this.draining && signal.aborted && this.snapshot)
        return this.snapshot;
      throw error;
    });
    this.projectionTail = pending;
    pending
      .finally(() => {
        if (this.projectionTail === pending) this.projectionTail = null;
      })
      .catch(() => {});
    return pending;
  }
  _inventorySuperseded(inventory) {
    if (inventory && inventory === this.initialInventory)
      return !this._initialInventoryPreserved();
    if (!inventory || inventory.appendOnly === true) return false;
    return this.census?.getInventory()?.pools !== inventory.pools;
  }
  async _projectSnapshot({
    bootstrap,
    registry,
    chainData,
    frontierChains,
    inventory,
    metrics,
    sources,
    attempt = 0,
    signal = this.projectionController.signal,
  }) {
    signal.throwIfAborted();
    inventory = this._canonicalInventory() || inventory;
    const recoveringDirectory =
      !this.joinedInventory && this.snapshot?.directory?.mode === "paginated";
    const expandedChains = { ...chainData };
    for (const network of inventory?.networks || [])
      if (!expandedChains[network.chain])
        expandedChains[network.chain] = { chainId: network.chainId };
    this.directoryInputs = {
      registry,
      chainData: expandedChains,
      frontierChains,
    };
    const directory = await this._cooperate(
      createDirectorySteps(
        registry,
        expandedChains,
        frontierChains,
        await this._cooperate(
          this.hookDirectory.projectSteps(inventory),
          signal,
        ),
        { includePlatforms: true },
      ),
      signal,
    );
    const enriched = this.marketEnricher?.getSnapshot();
    let consumeEnriched = false;
    if (enriched) {
      metrics.pools = mergeMarketRecords(
        metrics.pools || [],
        enriched.pools || [],
      );
      metrics.sources = [
        ...(metrics.sources || []),
        ...(enriched.sources || []),
      ];
      metrics.totalObservedPools = Math.max(
        metrics.totalObservedPools || 0,
        metrics.pools.length,
      );
    }
    const withdrawnIds = await this._cooperate(
      withdrawnPoolIds(inventory, this.inventoryPoolsReference),
      signal,
    );
    metrics = {
      ...metrics,
      pools: (metrics.pools || []).filter(
        (pool) =>
          !withdrawnIds.has(`${pool.chain}:${pool.address.toLowerCase()}`),
      ),
    };
    sources.push(...(metrics.sources || []));
    let pools = (
      await this._cooperate(
        attributePoolsSteps(metrics.pools || [], directory.projects),
        signal,
      )
    ).map((pool) =>
      normalizeMetricProvenance(pool, metrics.sources || [], false, this.now()),
    );
    // A partial upstream outage must not erase previously attributed markets from another chain.
    const failedChains = new Map();
    for (const source of metrics.sources || [])
      if (source.status === "unavailable") {
        if (/^(?:gecko|initialize)-/.test(source.id))
          failedChains.set(
            source.id.replace(/^(?:gecko|initialize)-/, ""),
            source,
          );
        else if (
          ["frontier-coins", "frontier-market-attribution"].includes(source.id)
        )
          failedChains.set("robinhood", source);
      }
    if (!bootstrap && this.snapshot?.pools?.length) {
      if (
        !pools.length &&
        !(metrics.sources || []).some((source) => source.status === "live")
      )
        for (const chain of this.snapshot.coverage?.measuredChains || [])
          failedChains.set(chain, { url: REGISTRY_URL });
      for (const [chain, failure] of failedChains) {
        if (pools.some((pool) => pool.chain === chain)) continue;
        const chainId = directory.chains.find(
          (item) => item.slug === chain,
        )?.id;
        const retained = attributePools(
          this.snapshot.pools
            .filter(
              (pool) =>
                pool.chain === chain &&
                !withdrawnIds.has(
                  `${pool.chain}:${pool.address.toLowerCase()}`,
                ),
            )
            .map((pool) => ({
              ...normalizeMetricProvenance(
                pool,
                this.snapshot.sources,
                true,
                this.now(),
              ),
              chainId,
            })),
          directory.projects,
        );
        if (!retained.length) continue;
        pools.push(...retained);
        sources.push({
          id: `retained-metrics-${chain}`,
          name: `Saved market measurements · ${chain}`,
          url: failure.url,
          status: "cached",
          updatedAt: oldestMeasurement(retained),
          note: "This chain’s upstream request failed. Showing pool measurements from their original observation time; they are not current trading totals.",
        });
      }
    }
    const coverageNote = marketCoverageNote(pools);
    await this._cooperate(
      applyMetricsSteps(directory.projects, pools, coverageNote, this.now()),
      signal,
    );
    this.marketEnricher?.prioritizePools?.(
      pools.map((pool) => ({
        ...pool,
        chainId: directory.chains.find((chain) => chain.slug === pool.chain)
          ?.id,
      })),
    );
    const generatedAt = new Date(this.now()).toISOString();
    const summary = {
      indexedProjects: directory.projects.length,
      indexedDeployments: directory.projects.reduce(
        (total, project) => total + project.deployments.length,
        0,
      ),
      trackedPools: pools.length,
      ...(await this._cooperate(
        aggregateCurrentMarketsSteps(pools, this.now()),
        signal,
      )),
    };
    const previousProjects = await this._cooperate(
      indexProjectRowsSteps(this.snapshot?.projects || []),
      signal,
    );
    const historiesByProject = new Map();
    for (const pool of pools) {
      if (observedMetricValue(pool, "h24") === null) continue;
      if (!historiesByProject.has(pool.projectId))
        historiesByProject.set(pool.projectId, []);
      historiesByProject.get(pool.projectId).push(pool);
    }
    await this._cooperate(
      function* () {
        let operations = 0;
        for (const project of directory.projects) {
          if (++operations % 1024 === 0) yield;
          const contributors = historiesByProject.get(project.id) || [];
          const fresh = freshMeasurements(contributors, this.now());
          project.history = appendHistory(
            previousProjects.get(project.id)?.history || project.history,
            fresh ? project.metrics.volumeUsd.h24 : null,
            fresh ? Date.parse(oldestMeasurement(contributors)) : this.now(),
          );
        }
      }.call(this),
      signal,
    );
    const contributors = pools.filter(
      (pool) => observedMetricValue(pool, "h24") !== null,
    );
    const measuredFresh = freshMeasurements(contributors, this.now());
    sources = [
      ...new Map(sources.map((source) => [source.id, source])).values(),
    ];
    const live = sources.filter((source) => source.status === "live").length;
    const status = bootstrap
      ? registry.length
        ? "cached"
        : "offline"
      : !live
        ? registry.length
          ? "cached"
          : "offline"
        : sources.some((source) => source.status !== "live") || !pools.length
          ? "partial"
          : "live";
    const inventoryProjects = await this._cooperate(
      inventoryHookProjectsSteps(directory.projects),
      signal,
    );
    const joinedInventory =
      this.poolIndexService && inventory
        ? await this.poolIndexService.project(
            inventory,
            inventoryProjects,
            pools,
            { signal },
          )
        : await this._cooperate(
            joinPoolInventorySteps(inventory, inventoryProjects, pools),
            signal,
          );
    signal.throwIfAborted();
    const events = recoveringDirectory
      ? this.snapshot.events
      : await this._cooperate(
          registryEventsSteps(this.snapshot, directory.projects, generatedAt),
          signal,
        );
    if (this._inventorySuperseded(inventory)) {
      if (attempt >= 2)
        throw new Error(
          "Pool data changed during refresh. The last complete view is retained; retry shortly.",
        );
      return this._projectSnapshot({
        bootstrap,
        registry,
        chainData,
        frontierChains,
        inventory,
        metrics,
        sources,
        attempt: attempt + 1,
        signal,
      });
    }
    if (enriched) {
      const attributedIds = new Set(
        pools.map((pool) => `${pool.chain}:${pool.address.toLowerCase()}`),
      );
      // An append-only census may advance while this directory is assembled.
      // Keep newer, not-yet-attributable prices pending for the next generation.
      const fullyAttributed = (enriched.pools || []).every((pool) => {
        const id = `${pool.chain}:${pool.address.toLowerCase()}`;
        return withdrawnIds.has(id) || attributedIds.has(id);
      });
      consumeEnriched = fullyAttributed;
    }
    let snapshot = {
      schemaVersion: 1,
      generatedAt,
      status,
      ...directory,
      ...(joinedInventory ? { inventory: joinedInventory.coverage } : {}),
      ...(enriched
        ? {
            marketCoverage: {
              networks: enriched.networks || [],
              cacheWarning: enriched.cacheWarning || null,
            },
          }
        : {}),
      pools,
      events,
      sources,
      history: appendHistory(
        this.snapshot?.history || [],
        measuredFresh ? summary.volumeUsd.h24 : null,
        measuredFresh
          ? Date.parse(oldestMeasurement(contributors))
          : this.now(),
      ),
      summary,
      coverage: {
        title: pools.length
          ? "Measured pool sample · incomplete ecosystem coverage"
          : "Registry inventory · market coverage unavailable",
        description: coverageNote,
        measuredChains: [...new Set(pools.map((pool) => pool.chain))],
        registryDeployments: registryDeploymentCount(directory.projects),
        attributedPools: pools.length,
        totalObservedPools: Math.max(
          pools.length,
          numberValue(metrics.totalObservedPools),
        ),
      },
    };
    try {
      snapshot = await this._cooperate(
        this._preparePublicationSteps(snapshot, inventory),
        signal,
      );
    } catch (error) {
      const failure = safePublicationFailure(error);
      if (
        attempt >= 2 ||
        failure.code !== "RADAR_MARKET_OVERLAY_BUSY" ||
        failure.stage !== "archive-fence"
      )
        throw error;
      signal.throwIfAborted();
      // Retained prices can commit while the archive ACK yields. Rebuild from
      // that newer complete history, using the already collected observations
      // and their original clocks. Share the canonical retry budget; never
      // publish the superseded candidate or repeat provider acquisition.
      return this._projectSnapshot({
        bootstrap,
        registry,
        chainData,
        frontierChains,
        inventory,
        metrics,
        sources,
        attempt: attempt + 1,
        signal,
      });
    }
    signal.throwIfAborted();
    if (consumeEnriched) {
      this.marketStamp = enriched;
      this.marketPoolsReference = enriched.pools;
    }
    this.joinedInventory = joinedInventory;
    this.inventoryPoolsReference = inventory?.pools || null;
    this.inventoryStamp = inventory
      ? `${inventory.revision ?? ""}:${inventory.generatedAt}`
      : null;
    this._rememberCanonicalInventory(inventory);
    this.snapshot = snapshot;
    if (inventory) this.completedPublications.inventory = {};
    if (consumeEnriched) {
      this.completedPublications["market-projection"] = {};
      this.completedPublications["market-overlay"] = {};
    }
    return snapshot;
  }
  _recordRefreshFailure(error) {
    const previous = safeRefreshFailureRecord(this.lastRefreshFailure);
    const at = this.now();
    const recordedAt =
      Number.isFinite(at) && at >= 0 && at <= 8.64e15
        ? new Date(at).toISOString()
        : null;
    this.lastRefreshFailure = {
      ...safePublicationFailure(error),
      active: true,
      resolvedAt: null,
      firstRecordedAt: previous?.active ? previous.firstRecordedAt : recordedAt,
      lastRecordedAt: recordedAt,
      occurrences: Math.min(
        (previous?.active ? previous.occurrences : 0) + 1,
        2147483647,
      ),
    };
  }
  _resolveRefreshFailure() {
    const previous = safeRefreshFailureRecord(this.lastRefreshFailure);
    if (!previous?.active) return;
    const at = this.now();
    this.lastRefreshFailure = {
      ...previous,
      active: false,
      resolvedAt:
        Number.isFinite(at) && at >= 0 && at <= 8.64e15
          ? new Date(at).toISOString()
          : null,
    };
  }
  async refresh({ force = false } = {}) {
    await this.init();
    if (this.draining) return this.snapshot;
    if (this.pending) return this.pending;
    const elapsed = this.now() - this.lastAttempt;
    if (this.lastAttempt && elapsed < (force ? COOLDOWN : REFRESH_TTL))
      return this.snapshot;
    this.lastAttempt = this.now();
    this.pending = (async () => {
      try {
        const snapshot = await this.buildSnapshot();
        if (this.draining) return this.snapshot;
        this.lastError = null;
        let saved;
        try {
          saved = await leanSnapshotAsync(snapshot);
          await atomicJson(
            join(this.cacheDir, "snapshot.json"),
            saved,
            PRIMARY_SNAPSHOT_MAX_BYTES,
            { primary: true },
          );
          this.lastPersistenceError = null;
        } catch (error) {
          this.lastPersistenceError = "Snapshot persistence failed.";
          this.lastError =
            error?.code === "RADAR_SNAPSHOT_TOO_LARGE"
              ? "Snapshot exceeds the recovery size limit; the previous saved snapshot is preserved."
              : "Disk cache is unavailable; in-memory reads continue.";
          this._recordRefreshFailure(error);
        }
        if (saved && !this.lastPersistenceError)
          await this.saveStartupView(
            saved,
            this.projectionController.signal,
          ).catch(() => {});
        if (!this.lastError && !this.lastPersistenceError) {
          this.completedPublications.refresh = {};
          this._resolveRefreshFailure();
        }
        return snapshot;
      } catch (error) {
        if (this.draining && error?.name === "AbortError") return this.snapshot;
        this.lastError = String(error?.message || "Refresh failed").slice(
          0,
          200,
        );
        this._recordRefreshFailure(error);
        if (this.snapshot) return this.snapshot;
        throw error;
      } finally {
        this.pending = null;
      }
    })();
    return this.pending;
  }
  async saveStartupView(snapshot, signal) {
    // Refresh serializes primary persistence. Reusing the identical completed
    // frame does not need a second optional presentation write.
    if (this.savedStartupView?.deref() === snapshot) return;
    if (
      await writeStartupView({
        cacheDir: this.cacheDir,
        snapshot,
        validate: validSnapshot,
        signal,
      })
    )
      this.savedStartupView = new WeakRef(snapshot);
  }
  /** Browser presentations read one complete publication without starting a
   * second catalog/freshness scan. The normal background publisher renews
   * sources, and the browser ages these unchanged observation clocks before
   * rendering. Ordinary snapshots and exports retain getSnapshot semantics. */
  async getPublishedSnapshot() {
    await this.init();
    if (!this.draining && this.census && !this.joinedInventory)
      await this.syncInventoryAsync();
    return this.snapshot;
  }
  async getSnapshot() {
    await this.init();
    // Active HTTP handlers may finish against the last complete generation.
    // Shutdown must not turn those reads into new background indexing work.
    if (this.draining) return this.snapshot;
    const inventory = this.census?.getInventory();
    if (
      this.poolIndexService ||
      this.historyArchive ||
      (inventory?.pools.length || 0) > 5000
    ) {
      // Serve the last complete projection while the next generation is assembled.
      // First recovery is awaited so unknown saved families are immediately browsable.
      const canonical = this._canonicalInventory();
      const stamp = canonical
        ? `${canonical.revision ?? ""}:${canonical.generatedAt}`
        : null;
      if (!this.joinedInventory || stamp !== this.inventoryStamp) {
        const pending = this.syncInventoryAsync();
        if (!this.joinedInventory) await pending;
        else pending.catch(() => {});
      }
      if (!this.projectionTail) this.syncMarkets()?.catch?.(() => {});
      // Prices for the published canonical generation need no SQLite catch-up.
      // Keep this bounded overlay independent of a long historical append.
      if (this.joinedInventory) this.syncRetainedMarkets().catch(() => {});
    } else if (!this.projectionTail) {
      this.syncInventory();
      await this.syncMarkets({ withinProjection: true });
    }
    if (
      !this.draining &&
      this.now() - this.lastAttempt >= REFRESH_TTL &&
      !this.pending
    )
      this.refresh().catch(() => {});
    const previous = this.snapshot;
    const previousInventory = this.getSnapshotInventory(previous);
    const refreshed = await refreshSnapshotAsync(previous, {
      now: this.now,
    });
    // Canonical and price publications may advance while freshness yields.
    // Never replace that newer complete generation with this reader's frame.
    if (this.snapshot !== previous) {
      const retained = this.snapshot;
      const retainedInventory = this.getSnapshotInventory(retained);
      const frame = await refreshSnapshotAsync(retained, { now: this.now });
      // A second publication can advance during this reader-only recheck too.
      // Keep its native paging proof paired with the exact returned generation.
      this.snapshotInventories.set(frame, retainedInventory);
      return frame;
    }
    if (this.marketOverlayPending || this.projectionTail) {
      // A normal projection or price overlay still owns this generation. Readers can
      // age its last complete measurements privately without invalidating the
      // owner's exact-base publication guard or waiting for its scan/archive write.
      this.snapshotInventories.set(refreshed, previousInventory);
      return refreshed;
    }
    const overlayPublication = this.marketOverlayPublication;
    this.snapshot = refreshed;
    if (this.snapshot !== previous && this.snapshotInventories.has(previous))
      this.snapshotInventories.set(
        this.snapshot,
        this.snapshotInventories.get(previous),
      );
    if (this.snapshot !== previous && overlayPublication?.snapshot === previous)
      this.marketOverlayPublication = {
        ...overlayPublication,
        snapshot: this.snapshot,
      };
    return this.snapshot;
  }
  syncInventory() {
    if (this.draining) return this.snapshot;
    if (this.historyArchive) return this.syncInventoryAsync();
    const result = runSynchronously(this._syncInventorySteps());
    this._releaseInitialInventory();
    return result;
  }
  syncInventoryAsync() {
    if (this.draining) return Promise.resolve(this.snapshot);
    if (this.inventoryPending) return this.inventoryPending;
    const pending = this._withProjection(async (signal) => {
      const result = await this._cooperate(
        this._syncInventorySteps(signal),
        signal,
      );
      if (result === false)
        await this._cooperate(this._syncInventorySteps(signal), signal);
      try {
        await this.syncMarkets({ withinProjection: true, signal });
      } catch (error) {
        const failure =
          error && typeof error === "object"
            ? error
            : new Error("Market projection did not complete", { cause: error });
        publicationFailureOperations.set(failure, "market-projection");
        throw failure;
      }
      this._releaseInitialInventory();
      return this.snapshot;
    });
    this.inventoryPending = pending;
    pending
      .finally(() => {
        if (this.inventoryPending === pending) this.inventoryPending = null;
      })
      .catch(() => {});
    return pending;
  }
  *_syncInventorySteps(signal = this.projectionController.signal) {
    signal.throwIfAborted();
    if (!this.census || !this.snapshot || !this.directoryInputs) return;
    const inventory = this._canonicalInventory();
    const stamp = inventory
      ? `${inventory.revision ?? ""}:${inventory.generatedAt}`
      : null;
    if (!inventory || stamp === this.inventoryStamp) return;
    if (
      this.joinedInventory &&
      inventory.pools === this.inventoryPoolsReference
    ) {
      if (this.poolIndexService)
        yield this.poolIndexService.sync(inventory, { signal });
      const base = this.snapshot;
      const previousJoined = this.joinedInventory;
      const superseded = () =>
        this.snapshot !== base ||
        this.joinedInventory !== previousJoined ||
        this._canonicalInventory()?.pools !== inventory.pools;
      const networkStates = new Map(
        inventory.networks.map((network) => [
          network.chain,
          networkCaughtUp(network),
        ]),
      );
      const publishedHeads = this.poolIndexService?.replacementToken
        ? this.poolIndexService.heads(inventory)
        : null;
      let changed = false;
      const updated = [];
      let work = 0;
      for (const project of base.projects) {
        if (++work % 512 === 0) yield;
        if (isPublishedPlatformProject(project)) {
          updated.push(project);
          continue;
        }
        const complete =
          project.chains.length > 0 &&
          project.chains.every((chain) => networkStates.get(chain) === true);
        const replacementToken = publishedHeads
          ? this.poolIndexService.replacementToken(project, publishedHeads)
          : undefined;
        if (
          project.poolInventory?.complete === complete &&
          project.poolInventory?.replacementToken === replacementToken
        ) {
          updated.push(project);
          continue;
        }
        changed = true;
        const poolInventory = { ...project.poolInventory, complete };
        delete poolInventory.replacementToken;
        updated.push({
          ...project,
          poolInventory: {
            ...poolInventory,
            ...(replacementToken ? { replacementToken } : {}),
          },
        });
      }
      // Retained prices publish outside the canonical projection queue. Never
      // attach old cloned rows to their newer snapshot after a chunk yields.
      if (superseded()) return false;
      const projects = changed ? updated : base.projects;
      const coverage = {
        ...previousJoined.coverage,
        poolCount:
          inventory.poolsIncludeZeroHooks === false
            ? inventory.networks.reduce(
                (sum, network) => sum + network.poolCount,
                0,
              ) +
              Math.max(
                0,
                previousJoined.coverage.poolCount -
                  previousJoined.coverage.networks.reduce(
                    (sum, network) => sum + network.poolCount,
                    0,
                  ),
              )
            : previousJoined.coverage.poolCount,
        generatedAt: inventory.generatedAt,
        running: inventory.running === true,
        networks: inventory.networks,
      };
      const joinedInventory = {
        ...previousJoined,
        coverage,
        ...(this.poolIndexService
          ? { heads: this.poolIndexService.heads(inventory) }
          : {}),
      };
      const marketCoverage = alignAppendOnlyMarketCoverage(
        base.marketCoverage,
        base.inventory,
        inventory,
      );
      const candidate = {
        ...base,
        generatedAt: new Date(this.now()).toISOString(),
        projects,
        inventory: coverage,
        ...(marketCoverage ? { marketCoverage } : {}),
      };
      const snapshot = yield* this._preparePublicationSteps(
        candidate,
        inventory,
      );
      signal.throwIfAborted();
      if (superseded()) return false;
      this.joinedInventory = joinedInventory;
      this.inventoryStamp = stamp;
      this._rememberCanonicalInventory(inventory);
      this.snapshot = snapshot;
      this.completedPublications.inventory = {};
      return;
    }
    // Paginated warm snapshots deliberately omit unpriced census families.
    // Restoring them from saved journals is recovery, not new discovery.
    const recoveringDirectory =
      !this.joinedInventory && this.snapshot.directory?.mode === "paginated";
    const { registry, chainData, frontierChains } = this.directoryInputs;
    let operations = 0;
    const withdrawnIds = yield* withdrawnPoolIds(
      inventory,
      this.inventoryPoolsReference,
    );
    const expandedChains = { ...chainData };
    for (const network of inventory.networks || [])
      if (!expandedChains[network.chain])
        expandedChains[network.chain] = { chainId: network.chainId };
    const directory = yield* createDirectorySteps(
      registry,
      expandedChains,
      frontierChains,
      yield* this.hookDirectory.projectSteps(inventory),
      { includePlatforms: true },
    );
    const ids = new Map(
      directory.chains.map((chain) => [chain.slug, chain.id]),
    );
    const pools = yield* attributePoolsSteps(
      this.snapshot.pools
        .filter(
          (pool) =>
            !withdrawnIds.has(`${pool.chain}:${pool.address.toLowerCase()}`),
        )
        .map((pool) => ({
          ...pool,
          chainId: ids.get(pool.chain),
        })),
      directory.projects,
    );
    const inventoryProjects = yield* inventoryHookProjectsSteps(
      directory.projects,
    );
    const joinedInventory = this.poolIndexService
      ? yield this.poolIndexService.project(
          inventory,
          inventoryProjects,
          pools,
          { signal },
        )
      : yield* joinPoolInventorySteps(inventory, inventoryProjects, pools);

    yield* applyMetricsSteps(
      directory.projects,
      pools,
      this.snapshot.coverage.description,
      this.now(),
    );
    const previous = yield* indexProjectRowsSteps(this.snapshot.projects);
    for (const project of directory.projects) {
      if (++operations % 1024 === 0) yield;
      project.history = previous.get(project.id)?.history || project.history;
    }
    const generatedAt = new Date(this.now()).toISOString();
    const events = recoveringDirectory
      ? this.snapshot.events
      : yield* registryEventsSteps(
          this.snapshot,
          directory.projects,
          generatedAt,
        );
    if (this._inventorySuperseded(inventory)) return false;
    const marketCoverage = alignAppendOnlyMarketCoverage(
      this.snapshot.marketCoverage,
      this.snapshot.inventory,
      inventory,
    );
    const candidate = {
      ...this.snapshot,
      ...directory,
      generatedAt,
      pools,
      inventory: joinedInventory.coverage,
      ...(marketCoverage ? { marketCoverage } : {}),
      events,
      summary: {
        ...this.snapshot.summary,
        trackedPools: pools.length,
        ...(yield* aggregateCurrentMarketsSteps(pools, this.now())),
        indexedProjects: directory.projects.length,
        indexedDeployments: directory.projects.reduce(
          (sum, project) => sum + project.deployments.length,
          0,
        ),
      },
      coverage: {
        ...this.snapshot.coverage,
        attributedPools: pools.length,
        measuredChains: [...new Set(pools.map((pool) => pool.chain))],
        registryDeployments: registryDeploymentCount(directory.projects),
      },
    };
    const snapshot = yield* this._preparePublicationSteps(candidate, inventory);
    signal.throwIfAborted();
    this.joinedInventory = joinedInventory;
    this.inventoryStamp = stamp;
    this.inventoryPoolsReference = inventory.pools;
    this._rememberCanonicalInventory(inventory);
    this.snapshot = snapshot;
    this.completedPublications.inventory = {};
  }
  async getProjectPools(projectId, options = {}) {
    const signal = options.signal
      ? AbortSignal.any([options.signal, this.projectionController.signal])
      : this.projectionController.signal;
    signal.throwIfAborted();
    this.poolIndexService?.index?.assertUserReadAvailable?.();
    const snapshot = await abortable(this.getSnapshot(), signal);
    signal.throwIfAborted();
    const project = snapshot.projects.find(
      (project) => project.id === projectId,
    );
    if (!project) return null;
    const joined = this.getSnapshotInventory(snapshot);
    const tokenNames = (pool) =>
      (pool.tokens || []).flatMap((address) => {
        if (
          !/^0x[0-9a-f]{40}$/i.test(address) ||
          !Number.isSafeInteger(pool.chainId)
        )
          return [];
        const token = this.tokenMetadataClient?.peek?.({
          chain: pool.chain,
          chainId: pool.chainId,
          address,
        });
        return token && token.status !== "unavailable"
          ? [token.symbol, token.name]
          : [];
      });
    if (joined?.indexService)
      return joined.indexService.page(
        joined,
        project,
        snapshot.pools,
        { ...options, signal, userRead: true },
        tokenNames,
        this.tokenMetadataClient?.cache,
      );
    const result = inventoryPoolPage(joined, projectId, snapshot.pools, {
      ...options,
      tokenNames,
    });
    signal.throwIfAborted();
    return result;
  }
  syncMarkets({
    withinProjection = false,
    signal = this.projectionController.signal,
  } = {}) {
    if (this.draining) return Promise.resolve(this.snapshot);
    if (!this.poolIndexService && !this.historyArchive)
      return runSynchronously(this._syncMarketsSteps(signal));
    if (withinProjection)
      return this._cooperate(this._syncMarketsSteps(signal), signal);
    if (this.marketProjectionPending)
      return this.joinedInventory &&
        this.marketProjectionAdmission?.enriched !==
          this.marketEnricher?.getSnapshot()
        ? this.syncRetainedMarkets()
        : this.marketProjectionPending;
    if (this.joinedInventory && this.projectionTail)
      return this.syncRetainedMarkets();
    const admission = { enriched: this.marketEnricher?.getSnapshot() };
    this.marketProjectionAdmission = admission;
    const pending = this._withProjection((projectionSignal) =>
      this._cooperate(
        this._syncMarketsSteps(projectionSignal, admission),
        projectionSignal,
      ),
    );
    this.marketProjectionPending = pending;
    pending
      .finally(() => {
        if (this.marketProjectionPending === pending)
          this.marketProjectionPending = null;
        if (this.marketProjectionAdmission === admission)
          this.marketProjectionAdmission = null;
      })
      .catch(() => {});
    return pending;
  }
  *_syncMarketsSteps(
    signal = this.projectionController.signal,
    admission = null,
  ) {
    signal.throwIfAborted();
    if (!this.marketEnricher || !this.snapshot) return;
    const base = this.snapshot;
    const previousJoined = this.getSnapshotInventory(base);
    const inventory = this._canonicalInventory();
    // Canonical membership transitions and price quarantine belong to inventory projection.
    // A market overlay must never hide a pending directory generation by advancing its pointer.
    if (
      this.joinedInventory &&
      inventory?.pools !== this.inventoryPoolsReference
    )
      return;
    const enriched = this.marketEnricher.getSnapshot();
    if (admission) admission.enriched = enriched;
    if (!enriched || enriched === this.marketStamp) return;
    const sources = [
      ...new Map(
        [...this.snapshot.sources, ...(enriched.sources || [])].map(
          (source) => [source.id, source],
        ),
      ).values(),
    ];
    if (enriched.pools === this.marketPoolsReference) {
      this.marketStamp = enriched;
      this.snapshot = {
        ...this.snapshot,
        sources,
        generatedAt: new Date(this.now()).toISOString(),
        marketCoverage: {
          networks: enriched.networks || [],
          cacheWarning: enriched.cacheWarning || null,
        },
      };
      this.completedPublications["market-projection"] = {};
      this.completedPublications["market-overlay"] = {};
      return;
    }
    const chainIds = new Map(
      this.snapshot.chains.map((chain) => [chain.slug, chain.id]),
    );
    const inputs = mergeMarketRecords(
      this.snapshot.pools.map((pool) => ({
        ...pool,
        chainId: chainIds.get(pool.chain),
      })),
      enriched.pools || [],
    );
    const attributed = yield* attributePoolsSteps(inputs, base.projects, {
      ownershipCache: this.marketAttributionCache,
    });
    const pools = yield* reusePublishedRowsSteps(
      base.pools,
      attributed.map((pool) =>
        normalizeMetricProvenance(
          pool,
          enriched.sources || [],
          false,
          this.now(),
        ),
      ),
    );
    const byProject = new Map();
    for (const pool of pools) {
      if (!byProject.has(pool.projectId)) byProject.set(pool.projectId, []);
      byProject.get(pool.projectId).push(pool);
    }
    const needsInventoryJoin =
      !this.joinedInventory ||
      inventory?.pools !== this.inventoryPoolsReference;
    const canRestrictRecount = () =>
      Boolean(this.poolIndexService) &&
      this.poolIndexService.published instanceof WeakMap &&
      typeof this.poolIndexService.preservesHeads === "function" &&
      Array.isArray(previousJoined?.heads) &&
      !needsInventoryJoin &&
      Boolean(inventory) &&
      inventory.pools === this.inventoryPoolsReference &&
      this.inventoryStamp ===
        `${inventory.revision ?? ""}:${inventory.generatedAt}` &&
      previousJoined?.indexService === this.poolIndexService &&
      previousJoined.heads ===
        this.poolIndexService?.published?.get(inventory)?.heads &&
      this.poolIndexService.preservesHeads(previousJoined.heads);
    const restrictedRecount = canRestrictRecount();
    const affectedOwners = restrictedRecount
      ? new Set([
          ...base.pools.map((pool) => pool.projectId),
          ...byProject.keys(),
        ])
      : null;
    // Inventory joins write poolInventory; price updates only affect priced owners.
    const cloneForInventory =
      needsInventoryJoin && Array.isArray(inventory?.pools);
    const pricedProjects = [];
    const recountProjects = [];
    let projects = [];
    let projectWork = 0;
    for (const project of base.projects) {
      if (++projectWork % 512 === 0) yield;
      const priced = byProject.has(project.id);
      const projected = cloneForInventory || priced ? { ...project } : project;
      if (priced) pricedProjects.push(projected);
      if (affectedOwners?.has(project.id)) recountProjects.push(projected);
      projects.push(projected);
    }
    yield* applyMetricsSteps(
      pricedProjects,
      pools,
      "Prices and rolling volumes are supplied by market providers for exact indexed pool IDs. Unpriced pools remain in the census and can be browsed separately.",
      this.now(),
    );
    for (const project of pricedProjects) {
      const contributors = byProject
        .get(project.id)
        .filter((pool) => observedMetricValue(pool, "h24") !== null);
      const fresh = freshMeasurements(contributors, this.now());
      project.history = appendHistory(
        project.history || [],
        fresh ? project.metrics.volumeUsd.h24 : null,
        fresh ? Date.parse(oldestMeasurement(contributors)) : this.now(),
      );
    }
    const amounts = yield* aggregateCurrentMarketsSteps(pools, this.now());
    const { volumeUsd } = amounts;
    let joinedInventory = this.joinedInventory;
    if (this.poolIndexService && inventory) {
      let joined = yield this.poolIndexService.project(
        inventory,
        yield* inventoryHookProjectsSteps(
          restrictedRecount ? recountProjects : projects,
        ),
        pools,
        { updateProjects: false, signal },
      );
      // Exact pinned heads prove unpriced owners' canonical counts, completion
      // and replacement tokens already match this frame. Only current/prior
      // price owners can change supplemental counts; all measurements still
      // pass through canonical membership, names and coverage reconciliation.
      // Any uncertainty after the await restores the exhaustive recount.
      if (
        restrictedRecount &&
        (!canRestrictRecount() || joined.heads !== previousJoined.heads)
      )
        joined = yield this.poolIndexService.project(
          inventory,
          yield* inventoryHookProjectsSteps(projects),
          pools,
          { updateProjects: false, signal },
        );
      if (joined.poolInventoryUpdates?.size)
        projects = projects.map((project) =>
          joined.poolInventoryUpdates.has(project.id)
            ? {
                ...project,
                poolInventory: joined.poolInventoryUpdates.get(project.id),
              }
            : project,
        );
      joinedInventory = joined;
    }
    if (needsInventoryJoin) {
      if (!this.poolIndexService)
        joinedInventory = joinPoolInventory(
          inventory,
          yield* inventoryHookProjectsSteps(projects),
          pools,
        );
      // A supplemental market join does not consume a canonical census generation.
      // Keep the reference/stamp paired until syncInventory publishes that generation.
    }
    projects = yield* reusePublishedRowsSteps(base.projects, projects);
    const contributors = pools.filter(
      (pool) => observedMetricValue(pool, "h24") !== null,
    );
    const fresh = freshMeasurements(contributors, this.now());
    const candidate = {
      ...this.snapshot,
      generatedAt: new Date(this.now()).toISOString(),
      projects,
      pools,
      sources,
      ...(joinedInventory ? { inventory: joinedInventory.coverage } : {}),
      marketCoverage: {
        networks: enriched.networks || [],
        cacheWarning: enriched.cacheWarning || null,
      },
      summary: {
        ...this.snapshot.summary,
        trackedPools: pools.length,
        ...amounts,
      },
      coverage: {
        ...this.snapshot.coverage,
        description: marketCoverageNote(pools),
        attributedPools: pools.length,
        totalObservedPools: Math.max(
          pools.length,
          this.snapshot.coverage.totalObservedPools,
        ),
        measuredChains: [...new Set(pools.map((pool) => pool.chain))],
      },
      history: appendHistory(
        this.snapshot.history,
        fresh ? volumeUsd.h24 : null,
        fresh ? Date.parse(oldestMeasurement(contributors)) : this.now(),
      ),
    };
    const snapshot = yield* this._preparePublicationSteps(candidate, inventory);
    signal.throwIfAborted();
    this.joinedInventory = joinedInventory;
    this.marketStamp = enriched;
    this.marketPoolsReference = enriched.pools;
    this.snapshot = snapshot;
    this.completedPublications["market-projection"] = {};
    this.completedPublications["market-overlay"] = {};
  }
  health() {
    return {
      ok: true,
      service: "hook-radar",
      version: "1.0.0",
      refreshing: Boolean(this.pending),
      status: this.snapshot?.status || "starting",
      generatedAt: this.snapshot?.generatedAt || null,
      nextRefreshAt: new Date(
        Math.max(this.now(), this.lastAttempt + COOLDOWN),
      ).toISOString(),
      cacheWarning: this.lastError,
      indexing: this.census?.running || false,
    };
  }
  beginDrain() {
    clearInterval(this.backgroundProjectionTimer);
    this.backgroundProjectionTimer = null;
    this.draining = true;
    this.marketAttributionCache.clear();
    this.projectionController.abort();
    for (const controller of this.refreshControllers) controller.abort();
    this.retainedMetricsController?.abort();
    this.client.online = false;
  }
  drain() {
    if (this.drainPending) return this.drainPending;
    this.beginDrain();
    this.drainPending = (async () => {
      await Promise.allSettled(
        [
          this.pending,
          this.inventoryPending,
          this.retainedMetricsPending,
          this.marketOverlayPending,
          this.projectionTail,
          ...this.client.pending.values(),
        ].filter(Boolean),
      );
      if (!this.initialized || !this.snapshot) return;
      // Census journals and market shards are saved by their own collectors.
      // The UI snapshot is a derived, completed generation: persisting it is
      // sufficient. Catching up here would rebuild millions of already durable
      // rows after admission has stopped and can exhaust the shutdown deadline.
      try {
        await atomicJson(
          join(this.cacheDir, "snapshot.json"),
          await leanSnapshotAsync(this.snapshot),
          PRIMARY_SNAPSHOT_MAX_BYTES,
          { primary: true },
        );
        this.lastPersistenceError = null;
      } catch (error) {
        this.lastPersistenceError = "Snapshot persistence failed.";
        throw error;
      }
      // Optional saved-view work belongs to normal refresh. Do not add a second
      // large write to the mandatory shutdown/receipt budget.
      await this.client.cache.prunePending;
    })();
    return this.drainPending;
  }
}
function mergeMarketRecords(existing, incoming) {
  const pools = new Map();
  for (const pool of [...existing, ...incoming]) {
    const key = `${pool.chain}:${String(pool.address).toLowerCase()}`;
    const previous = pools.get(key);
    if (
      !previous ||
      (Date.parse(pool.metricUpdatedAt || "") || 0) >=
        (Date.parse(previous.metricUpdatedAt || "") || 0)
    )
      pools.set(key, pool);
  }
  return [...pools.values()];
}
function cleanNote(value) {
  const note = Array.isArray(value)
    ? value.filter((row) => typeof row === "string").join(" ")
    : value;
  return typeof note === "string"
    ? note.slice(0, 1600)
    : "Partial pool sample. Missing measurements are unavailable, never zero-filled.";
}
function registryDeploymentCount(projects) {
  return projects.reduce(
    (sum, project) =>
      sum +
      project.deployments.filter(
        (deployment) => deployment.sourceUrl === REGISTRY_URL,
      ).length,
    0,
  );
}
function marketCoverageNote(pools) {
  const names = [];
  if (pools.some((pool) => /DEX Screener/i.test(pool.source)))
    names.push("DEX Screener");
  if (pools.some((pool) => /GeckoTerminal/i.test(pool.source)))
    names.push("GeckoTerminal");
  if (pools.some((pool) => /Frontier/i.test(pool.source)))
    names.push("Frontier’s public AMM index");
  return (
    `Observed market data covers ${pools.length.toLocaleString("en-US")} pools across ${new Set(pools.map((pool) => pool.chain)).size} networks${names.length ? ` from ${names.join(", ")}` : ""}. Dollar totals use available observations, not ecosystem totals. Unpriced pools remain browsable; missing values are unavailable, never zero.` +
    (names.includes("Frontier’s public AMM index")
      ? " Frontier estimates use native ETH AMM swaps and core reserves at the observed ETH/USD price; bonding-curve trades and separately held hook assets are excluded."
      : "")
  );
}
function numberValue(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}
function normalizeMetricProvenance(
  pool,
  sources,
  cached = false,
  now = Date.now(),
) {
  // Legacy Gecko snapshots can recover the amount observation time from that source.
  // Unknown timestamps remain unknown; snapshot generation never substitutes for them.
  const origin = sources.find((source) => source.id === `gecko-${pool.chain}`);
  const candidate =
    pool.metricUpdatedAt === undefined
      ? origin?.updatedAt
      : pool.metricUpdatedAt;
  const metricUpdatedAt = validTimestamp(candidate)
    ? new Date(Date.parse(candidate)).toISOString()
    : null;
  const candidateStatus =
    pool.metricStatus === undefined ? origin?.status : pool.metricStatus;
  const metricStatus =
    !metricUpdatedAt || !["live", "cached"].includes(candidateStatus)
      ? "unavailable"
      : cached
        ? "cached"
        : candidateStatus;
  return {
    ...normalizeCachedLiquidity(pool, now),
    metricUpdatedAt,
    metricStatus,
  };
}
function oldestMeasurement(pools) {
  if (
    !pools.length ||
    pools.some((pool) => !validTimestamp(pool.metricUpdatedAt))
  )
    return null;
  return pools.map((pool) => pool.metricUpdatedAt).sort()[0];
}
function freshMeasurements(pools, now = Date.now()) {
  return (
    pools.length > 0 &&
    pools.every(
      (pool) =>
        pool.metricStatus === "live" &&
        marketMeasurementState(pool, now) === "current",
    )
  );
}
