import { isAddress, isPoolId, ZERO_ADDRESS } from "./model.mjs";
import { networkCaughtUp } from "../shared/indexing.ts";
import { isPoolKey } from "../shared/pool-key.ts";
import { CENSUS_CHAINS } from "./census-chains.mjs";
import {
  cooperativeSortSteps,
  runCooperatively,
  runSynchronously,
} from "./cooperative.mjs";

const canonicalManagers = new Map(
  CENSUS_CHAINS.map((row) => [row.chainId, row.manager]),
);
const poolDisplayName = (pool) =>
  pool.name ||
  pool.tokens
    ?.map((token) =>
      token === ZERO_ADDRESS
        ? "Native"
        : `${token.slice(0, 6)}…${token.slice(-4)}`,
    )
    .join(" / ") ||
  "Indexed v4 pool";

/** Only full keys from a canonical manager are eligible for contract metadata. */
export function canonicalPoolKey(pool, networks = []) {
  const network = networks.find(
    (row) => row.chain === pool.chain && row.chainId === pool.chainId,
  );
  const key = {
    currency0: pool.tokens?.[0],
    currency1: pool.tokens?.[1],
    fee: pool.fee,
    tickSpacing: pool.tickSpacing,
    hookAddress: pool.hookAddress,
    managerAddress: network?.manager,
    creationBlock: pool.creationBlock,
  };
  return network &&
    isAddress(network.manager) &&
    canonicalManagers.get(network.chainId)?.toLowerCase() ===
      network.manager.toLowerCase() &&
    pool.tokens?.length === 2 &&
    isPoolKey(key, pool.hookAddress)
    ? key
    : null;
}

// A validated census already owns this normalized identity string. Reuse it
// only if every character still matches the authoritative chain/address pair.
// Provider-specific IDs must not change deduplication or coverage semantics.
function normalizedPoolIdentity(pool, lowerAddress) {
  const prefix = `${pool.chain}:`;
  return typeof pool.id === "string" &&
    pool.id.length === prefix.length + lowerAddress.length &&
    pool.id.startsWith(prefix) &&
    pool.id.endsWith(lowerAddress)
    ? pool.id
    : prefix + lowerAddress;
}

/** Build a complete unpublished projection in bounded, cooperative steps. */
export function* joinPoolInventorySteps(inventory, projects, measured = []) {
  if (!inventory || !Array.isArray(inventory.pools)) return null;
  const owners = new Map();
  const chainIds = new Map();
  let work = 0;
  for (const project of projects) {
    for (const deployment of project.deployments) {
      owners.set(
        `${deployment.chainId}:${deployment.address.toLowerCase()}`,
        project.id,
      );
      chainIds.set(deployment.chain, deployment.chainId);
      if (++work % 1024 === 0) yield;
    }
    if (++work % 1024 === 0) yield;
  }
  const seen = new Set();
  const indexedIds = new Set();
  const hookIds = new Set();
  let pools = [];
  const byProject = new Map();
  let supplementalCount = 0;
  // Process the authoritative inventory before supplemental measurements. Avoid
  // copying the full input array and constructing provider clones up front.
  for (const [rows, measuredRows] of [
    [inventory.pools, false],
    [measured, true],
  ]) {
    for (const input of rows) {
      if (++work % 1024 === 0) yield;
      const lowerAddress = input.address.toLowerCase();
      const id = normalizedPoolIdentity(input, lowerAddress);
      if (!measuredRows) indexedIds.add(id);
      if (
        !isPoolId(input.address) ||
        !isAddress(input.hookAddress) ||
        input.hookAddress === ZERO_ADDRESS ||
        seen.has(id)
      )
        continue;
      const chainId = measuredRows ? chainIds.get(input.chain) : input.chainId;
      const projectId = owners.get(
        `${chainId}:${input.hookAddress.toLowerCase()}`,
      );
      if (!projectId) continue;
      seen.add(id);
      const record = {
        ...input,
        ...(measuredRows ? { chainId } : {}),
        id,
        address: lowerAddress,
        projectId,
      };
      pools.push(record);
      if (!byProject.has(projectId)) byProject.set(projectId, []);
      byProject.get(projectId).push(record);
      hookIds.add(`${record.chainId}:${record.hookAddress}`);
      if (measuredRows && !indexedIds.has(id)) supplementalCount++;
    }
  }
  const networks = Array.isArray(inventory.networks) ? inventory.networks : [];
  for (const [projectId, list] of byProject) {
    const sorted = yield* cooperativeSortSteps(
      list,
      (a, b) =>
        (Date.parse(b.createdAt || "") || b.creationBlock || 0) -
          (Date.parse(a.createdAt || "") || a.creationBlock || 0) ||
        a.id.localeCompare(b.id),
    );
    byProject.set(projectId, sorted);
    if (++work % 1024 === 0) yield;
  }
  const byChain = new Map(networks.map((network) => [network.chain, network]));
  const updates = [];
  const counts = new Map();
  for (const project of projects) {
    const observed = byProject.get(project.id) || [];
    counts.clear();
    for (const pool of observed) {
      counts.set(pool.chain, (counts.get(pool.chain) || 0) + 1);
      if (++work % 1024 === 0) yield;
    }
    updates.push([
      project,
      {
        poolCount: observed.length,
        complete:
          project.chains.length > 0 &&
          project.chains.every(
            (chain) =>
              byChain.has(chain) && networkCaughtUp(byChain.get(chain)),
          ),
        chains: Object.fromEntries(
          project.chains.map((chain) => [chain, counts.get(chain) || 0]),
        ),
      },
    ]);
    if (++work % 1024 === 0) yield;
  }
  pools = yield* cooperativeSortSteps(
    pools,
    (a, b) =>
      (b.creationBlock || 0) - (a.creationBlock || 0) ||
      a.id.localeCompare(b.id),
  );
  // No caller-visible project is changed during yielded work. The caller can
  // discard a cancelled projection without exposing partially updated counts.
  for (const [project, poolInventory] of updates)
    project.poolInventory = poolInventory;
  return {
    pools,
    byProject,
    coverage: {
      generatedAt: inventory.generatedAt,
      running: inventory.running === true,
      poolCount:
        (inventory.poolsIncludeZeroHooks === false
          ? networks.reduce((sum, network) => sum + network.poolCount, 0)
          : indexedIds.size) + supplementalCount,
      hookPoolCount: pools.length,
      hookCount: hookIds.size,
      networks,
    },
  };
}

/** Synchronous compatibility for existing consumers and deterministic tests. */
export function joinPoolInventory(inventory, projects, measured = []) {
  return runSynchronously(
    joinPoolInventorySteps(inventory, projects, measured),
  );
}

/** Keep public request handling responsive while projecting large inventories. */
export function joinPoolInventoryAsync(
  inventory,
  projects,
  measured = [],
  options = {},
) {
  return runCooperatively(
    joinPoolInventorySteps(inventory, projects, measured),
    options,
  );
}

export function inventoryPoolPage(
  joined,
  projectId,
  measured,
  {
    chain = "all",
    offset = 0,
    limit = 50,
    after = null,
    q = "",
    tokenNames = () => [],
  } = {},
) {
  if (
    typeof q !== "string" ||
    q.length > 200 ||
    /[\u0000-\u001f\u007f]/.test(q)
  )
    throw new RangeError("Invalid pool search query.");
  const query = q.trim().toLowerCase();
  const structural = (joined?.byProject.get(projectId) || []).filter(
    (pool) => chain === "all" || pool.chain === chain,
  );
  const amounts = new Map(
    measured
      .filter((pool) => pool.projectId === projectId)
      .map((pool) => [pool.id, pool]),
  );
  const structuralIds = new Set(structural.map((pool) => pool.id));
  const all = [
    ...structural,
    ...[...amounts.values()].filter(
      (pool) =>
        (chain === "all" || pool.chain === chain) &&
        !structuralIds.has(pool.id),
    ),
  ].filter(
    (pool) =>
      !query ||
      [
        pool.address,
        pool.hookAddress,
        poolDisplayName(pool),
        ...(pool.tokens || []),
        amounts.get(pool.id)?.name,
        ...(amounts.get(pool.id)?.tokens || []),
        ...tokenNames(pool),
      ].some(
        (field) =>
          typeof field === "string" && field.toLowerCase().includes(query),
      ),
  );
  if (after) {
    const anchor = all.findIndex((pool) => pool.id === after);
    if (anchor < 0)
      throw new RangeError("Pool page has changed. Refresh the pool list.");
    offset = anchor + 1;
  }
  const selected = all.slice(offset, offset + limit);
  const hasMore = offset + selected.length < all.length;
  return {
    projectId,
    total: all.length,
    offset,
    nextOffset: hasMore ? offset + selected.length : null,
    nextCursor: hasMore ? selected.at(-1).id : null,
    pools: selected.map((pool) => {
      const measuredPool = amounts.get(pool.id);
      const key = canonicalPoolKey(pool, joined?.coverage.networks);
      const row = measuredPool
        ? { ...measuredPool }
        : {
            id: pool.id,
            chain: pool.chain,
            name: poolDisplayName(pool),
            address: pool.address,
            hookAddress: pool.hookAddress,
            projectId,
            url:
              pool.chain === "hyperevm"
                ? `https://hyperevmscan.io/address/${pool.hookAddress}`
                : `https://app.uniswap.org/explore/pools/${pool.chain}/${pool.address}`,
            source: pool.chain === "hyperevm" ? "Hook contract" : "Uniswap",
            tokens: pool.tokens || [],
            createdAt: pool.createdAt || null,
            liquidityUsd: null,
            volumeUsd: { h1: null, h6: null, h24: null },
            metricUpdatedAt: null,
            metricStatus: "unavailable",
            discovery: "onchain",
          };
      // Provider observations can update prices but cannot overwrite the immutable key.
      delete row.poolKey;
      if (key) {
        row.poolKey = key;
        row.hookAddress = pool.hookAddress;
        row.tokens = [...pool.tokens];
        row.createdAt = pool.createdAt || null;
      }
      return row;
    }),
  };
}
