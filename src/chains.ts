import { evaluationNow, STATIC_EDITION } from "./edition.ts";
import type {
  Category,
  HookDeployment,
  MarketFreshness,
  Pool,
  PoolIndexNetwork,
  RadarProject,
  RadarSnapshot,
  WindowKey,
} from "../shared/types";
import { aggregateCurrentMarkets } from "../shared/market-freshness.ts";
import { isPublishedPlatformProject } from "../shared/published-platform-hooks.ts";
import { networkCaughtUp, networkHeadFresh } from "../shared/indexing.ts";
import { buildAnalyticsSummary } from "./analytics.ts";
import type { AnalyticsSummary, AnalyticsTotals } from "./analytics.ts";
import { isOfficialUniswapHookFamily } from "./protocol-logos.ts";
import {
  launchpadListingProjects,
  launchpadRecordFor,
} from "./launchpads.ts";
import {
  LAUNCHPAD_REVIEWED_AT,
  launchpadRegistry as reviewedLaunchpads,
} from "../shared/launchpad-registry.ts";
import {
  deploymentSupportForNetwork,
  type DeploymentSupportEvidence,
} from "../shared/deployment-support.ts";

export type ChainRole =
  | "launchpads"
  | "launches"
  | "dexes"
  | "liquidity"
  | "fees"
  | "mev"
  | "orders"
  | "oracles"
  | "access"
  | "other";

export const chainRoles: readonly { id: ChainRole; label: string }[] = [
  { id: "launchpads", label: "Launchpads" },
  { id: "dexes", label: "DEXs & AMMs" },
  { id: "launches", label: "Token launches" },
  { id: "liquidity", label: "Liquidity" },
  { id: "fees", label: "Fees" },
  { id: "mev", label: "MEV protection" },
  { id: "orders", label: "Orders" },
  { id: "oracles", label: "Oracles" },
  { id: "access", label: "Access" },
  { id: "other", label: "Other hooks" },
];

const categoryRole: Record<Category, ChainRole> = {
  Launches: "launches",
  Liquidity: "liquidity",
  Fees: "fees",
  MEV: "mev",
  Orders: "orders",
  Oracles: "oracles",
  Access: "access",
  Other: "other",
};

export interface ChainRoleEvidence {
  role: ChainRole;
  sourceUrl: string | null;
  note: string;
}

/** These are product-function classifications, not operating-status or ownership
 * claims. Primary descriptions were reviewed on 2026-10-17. The exact directory
 * identity and an official website/docs host must agree before they apply. */
const reviewedFunctions: Readonly<
  Record<
    string,
    {
      name: string;
      hosts: readonly string[];
      role: "launchpads" | "dexes";
      sourceUrl: string;
      note: string;
    }
  >
> = {
  eulerswap: {
    name: "EulerSwap",
    hosts: ["euler.finance"],
    role: "dexes",
    sourceUrl: "https://www.euler.finance/blog/eulerswap",
    note: "Euler describes EulerSwap as a decentralized exchange combining an AMM with lending vaults.",
  },
  angstrom: {
    name: "Angstrom",
    hosts: ["angstrom.xyz", "sorellalabs.xyz"],
    role: "dexes",
    sourceUrl:
      "https://github.com/SorellaLabs/angstrom/blob/main/contracts/docs/overview.md",
    note: "Sorella describes Angstrom as a hybrid AMM and orderbook exchange built with Uniswap v4.",
  },
  bunni: {
    name: "Bunni",
    hosts: ["bunni.xyz"],
    role: "dexes",
    sourceUrl: "https://github.com/Bunniapp/bunni-v2",
    note: "Bunni's published repository describes its Uniswap v4 DEX. This identifies its design, not whether a deployment is operating.",
  },
  clanker: {
    name: "Clanker",
    hosts: ["clanker.world"],
    role: "launchpads",
    sourceUrl: "https://www.clanker.world/about",
    note: "Clanker provides token creation with launch liquidity and configurable creator rewards.",
  },
  flaunch: {
    name: "Flaunch",
    hosts: ["flaunch.gg"],
    role: "launchpads",
    sourceUrl: "https://docs.flaunch.gg/",
    note: "Flaunch describes its token launch protocol and launchpad infrastructure.",
  },
  frontier: {
    name: "Frontier",
    hosts: ["frontier.fun"],
    role: "launchpads",
    sourceUrl: "https://docs.frontier.fun/",
    note: "Frontier provides modular token launch infrastructure and configurable Uniswap v4 markets.",
  },
  doppler: {
    name: "Doppler",
    hosts: ["doppler.lol"],
    role: "launchpads",
    sourceUrl: "https://docs.doppler.lol/explainer",
    note: "Doppler provides token creation, price discovery auctions and liquidity migration.",
  },
  zora: {
    name: "Zora",
    hosts: ["zora.co"],
    role: "launchpads",
    sourceUrl: "https://docs.zora.co/coins",
    note: "Zora Coins creates creator and content tokens with dedicated Uniswap v4 pools and hooks.",
  },
};

function safeLink(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function hasOfficialLink(project: RadarProject, hosts: readonly string[]) {
  return [project.website, project.docs].some((link) => {
    const safe = safeLink(link);
    if (!safe) return false;
    const url = new URL(safe);
    return (
      url.protocol === "https:" &&
      hosts.some(
        (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
      )
    );
  });
}

/** A named public listing describes a project family; an anonymous pool hook
 * or a description mentioning an exchange does not establish a protocol. */
export function chainProtocolRoles(project: RadarProject): {
  roles: ChainRole[];
  roleEvidence: ChainRoleEvidence[];
} {
  const role = categoryRole[project.category];
  const roles = new Set<ChainRole>([role]);
  const roleEvidence: ChainRoleEvidence[] = [
    {
      role,
      sourceUrl: safeLink(project.sourceUrl),
      note: "Broad use case from the directory classification; not a protocol operating-status claim.",
    },
  ];
  const reviewed = reviewedFunctions[project.id];
  const listed = launchpadRecordFor(project);
  if (listed) {
    roles.add("launchpads");
    roleEvidence.push({
      role: "launchpads",
      sourceUrl: listed.docs,
      note: "A reviewed launchpad platform. Networks, hooks and status come from its own first-party sources; none establishes ownership of every pool.",
    });
  }
  if (isPublishedPlatformProject(project)) {
    roles.add("launchpads");
    roleEvidence.push({
      role: "launchpads",
      sourceUrl: project.sourceUrl,
      note: "The official platform guide documents token launches. Supported networks do not establish hook ownership.",
    });
  }
  if (
    reviewed &&
    project.name === reviewed.name &&
    project.deployments.some(
      (deployment) => deployment.discovery !== "onchain",
    ) &&
    hasOfficialLink(project, reviewed.hosts)
  ) {
    roles.add(reviewed.role);
    roleEvidence.push({
      role: reviewed.role,
      sourceUrl: reviewed.sourceUrl,
      note: reviewed.note,
    });
  }
  return { roles: [...roles], roleEvidence };
}

export interface ChainProtocol {
  project: RadarProject;
  website: string | null;
  docs: string | null;
  sourceUrl: string | null;
  deployments: HookDeployment[];
  hookCount: number;
  registeredHookCount: number;
  publishedHookCount: number;
  discoveredHookCount: number;
  poolCount: number | null;
  /** Complete means indexed through the captured heads, not priced coverage. */
  poolCountExact: boolean;
  roles: ChainRole[];
  roleEvidence: ChainRoleEvidence[];
  volumeUsd: number | null;
  liquidityUsd: number | null;
  observedPools: number;
  volumePools: number;
  liquidityPools: number;
  freshness: MarketFreshness;
  chainSlugs: string[];
  /** Reviewed launch platforms only: their figures cover the exact hooks the
   * platform's own sources publish, measured pool by pool (never the hooks of a
   * shared protocol, which stay counted under that protocol). */
  attribution?: PlatformAttribution;
  /** Edition: the names of the other listed rows that publish a hook this row
   * publishes too (the same network and address). The pools of such a hook are
   * in each of those rows and are never added together. */
  sharedHookWith?: string[];
}

export interface PlatformAttribution {
  /** Distinct hook contracts the platform itself publishes in this scope. */
  mappedHooks: number;
  /** Of those, how many have at least one priced pool in the loaded sample. */
  hooksWithPools: number;
  /** Radar project id of the shared protocol its launches run on, when it has
   * no hooks of its own in this scope. */
  sharedProtocolId: string | null;
  /** Its docs say every launch deploys a separate hook, so none is listed. */
  perLaunchHooks: boolean;
}

export interface ChainNetwork {
  slug: string;
  name: string;
  chainId: number | null;
  explorer: string | null;
  inventory: PoolIndexNetwork | null;
  deploymentSupport: DeploymentSupportEvidence | null;
  protocolCount: number;
  /** Unique listed family contracts, separate from inventory.hookCount. */
  hookCount: number;
  observedPools: number;
  volumeUsd: number | null;
  liquidityUsd: number | null;
  volumePools: number;
  liquidityPools: number;
  freshness: MarketFreshness;
  caughtUp: boolean;
  headFresh: boolean;
}

export interface ChainExplorerResult {
  chain: string;
  knownChain: boolean;
  windowKey: WindowKey;
  asOf: string;
  networks: ChainNetwork[];
  selectedNetwork: ChainNetwork | null;
  protocols: ChainProtocol[];
  totalProtocols: number;
  filteredProtocols: number;
  /** Unique listed family contracts in scope, not all indexed contracts. */
  hookCount: number;
  roles: { id: ChainRole | "all"; label: string; count: number }[];
  totals: AnalyticsTotals;
  inventory: {
    hookCount: number | null;
    hookPoolCount: number | null;
    poolCount: number | null;
    networkCount: number;
    indexedNetworks: number;
    caughtUpChains: number;
    freshChains: number;
  };
}

function uniqueDeployments(deployments: readonly HookDeployment[]) {
  const result = new Map<string, HookDeployment>();
  for (const deployment of deployments) {
    const key = `${deployment.chain}:${deployment.address.toLowerCase()}`;
    const previous = result.get(key);
    if (
      !previous ||
      (previous.discovery === "onchain" && deployment.discovery !== "onchain")
    )
      result.set(key, deployment);
  }
  return [...result.values()];
}

function familyChains(project: RadarProject, pools: readonly Pool[]) {
  return [
    ...new Set([
      ...(project.entityType === "platform" ? project.chains : []),
      ...project.deployments.map((deployment) => deployment.chain),
      ...pools.map((pool) => pool.chain),
      ...Object.entries(project.poolInventory?.chains || {})
        .filter(([, count]) => count > 0)
        .map(([slug]) => slug),
    ]),
  ].sort();
}

function familyPoolCount(
  project: RadarProject,
  chain: string,
  observedPools: number,
  networks: ReadonlyMap<string, PoolIndexNetwork>,
  familyChainSlugs: readonly string[],
) {
  const checkedCount = (count: number, complete: boolean) => ({
    // A saved inventory head can predate retained pool evidence. Keep the
    // proven lower bound rather than claiming zero pools beside a real pool.
    poolCount: Math.max(count, observedPools),
    poolCountExact: complete && count >= observedPools,
  });
  const inventory = project.poolInventory;
  if (inventory) {
    if (chain === "all") {
      const complete =
        inventory.complete &&
        familyChainSlugs.every((slug) => {
          const network = networks.get(slug);
          return !network || networkCaughtUp(network);
        });
      return checkedCount(inventory.poolCount, complete);
    }
    // A different chain still catching up does not make this chain's supplied
    // count incomplete. Conversely, a newer pending target invalidates an old
    // global complete flag. Market freshness remains a separate question.
    const network = networks.get(chain);
    const complete = network ? networkCaughtUp(network) : inventory.complete;
    const count = inventory.chains[chain];
    if (count !== undefined) return checkedCount(count, complete);
    if (inventory.complete) return checkedCount(0, complete);
  }
  // An all-chain aggregate cannot establish a missing chain-specific count.
  return { poolCount: observedPools || null, poolCountExact: false };
}

/** For each row, the other rows that publish one of the same hooks: a hook is a
 * network and an address. A reviewed platform's hooks are the ones its own
 * sources publish; any other row's are its deployments. Two rows can hold the
 * same hook when a platform's first-party record and a hook list name one
 * contract differently; the page lists both and says so. */
export function hookOverlapNames(
  rows: readonly ChainProtocol[],
  records: readonly (Pick<LaunchpadRecordLike, "paths"> & { id: string })[],
  chain = "all",
): Map<string, string[]> {
  const platformRecords = new Map(records.map((record) => [record.id, record]));
  const keysOf = (row: ChainProtocol): Set<string> => {
    const record = row.attribution
      ? platformRecords.get(row.project.id)
      : undefined;
    const keys = new Set<string>();
    if (record) {
      for (const path of record.paths)
        if (
          path.attribution === "platform-hook" &&
          (chain === "all" || path.chain === chain)
        )
          for (const hook of path.hooks)
            keys.add(`${path.chain}:${hook.address.toLowerCase()}`);
    } else
      for (const deployment of row.deployments)
        keys.add(`${deployment.chain}:${deployment.address.toLowerCase()}`);
    return keys;
  };
  const owners = new Map<string, ChainProtocol[]>();
  for (const row of rows)
    for (const key of keysOf(row)) {
      const list = owners.get(key) || [];
      list.push(row);
      owners.set(key, list);
    }
  const overlap = new Map<string, string[]>();
  for (const row of rows) {
    const names = new Set<string>();
    for (const key of keysOf(row))
      for (const other of owners.get(key) || [])
        if (other.project.id !== row.project.id) names.add(other.project.name);
    if (names.size) overlap.set(row.project.id, [...names].sort());
  }
  return overlap;
}

const descending = (a: number | null, b: number | null) =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : b - a;

/** Build a Uniswap v4 chain directory from retained named public families and
 * exact chain evidence. Lean snapshots retain every listed family even when
 * their anonymous onchain directory is paginated. No whole-chain DeFi claim is
 * made: inventory, project listings and current market observations stay apart. */
function buildChainBase(
  snapshot: RadarSnapshot,
  analytics: AnalyticsSummary,
  {
    chain = "all",
    windowKey = "h24",
    now = evaluationNow(),
    listings = true,
    hookOverlap = STATIC_EDITION,
  }: {
    chain?: string;
    windowKey?: WindowKey;
    now?: number;
    listings?: boolean;
    hookOverlap?: boolean;
  } = {},
): ChainExplorerResult {
  const poolsByProject = new Map<string, Pool[]>();
  for (const pool of analytics.observedPools) {
    if (!pool.projectId) continue;
    if (!poolsByProject.has(pool.projectId))
      poolsByProject.set(pool.projectId, []);
    poolsByProject.get(pool.projectId)!.push(pool);
  }
  // Reviewed launchpad platforms are frontend-derived listings. A project the
  // service already publishes under the same id always wins.
  const published = new Set(snapshot.projects.map((project) => project.id));
  const reviewedListings = listings
    ? launchpadListingProjects(snapshot.chains).filter(
        (listing) => !published.has(listing.id),
      )
    : [];
  // A listing's volume comes from the pools of its own exact hooks (chain and
  // address), in one pass over the measured pools. Hooks of a shared protocol
  // are never attributed here, so nothing is counted under two owners.
  const listingIds = new Set(reviewedListings.map((listing) => listing.id));
  const platformHookOwners = new Map<string, string[]>();
  for (const record of reviewedLaunchpads) {
    if (!listingIds.has(record.id)) continue;
    for (const path of record.paths) {
      if (path.attribution !== "platform-hook") continue;
      for (const hook of path.hooks) {
        const key = `${path.chain}:${hook.address.toLowerCase()}`;
        const owners = platformHookOwners.get(key) || [];
        if (!owners.includes(record.id)) owners.push(record.id);
        platformHookOwners.set(key, owners);
      }
    }
  }
  const listingPools = new Map<string, Pool[]>();
  if (platformHookOwners.size)
    for (const pool of analytics.observedPools) {
      if (!pool.hookAddress) continue;
      const owners = platformHookOwners.get(
        `${pool.chain}:${pool.hookAddress.toLowerCase()}`,
      );
      if (!owners) continue;
      for (const id of owners) {
        const rows = listingPools.get(id) || [];
        rows.push(pool);
        listingPools.set(id, rows);
      }
    }
  const named = [
    ...new Map(
      [...snapshot.projects, ...reviewedListings].map((project) => [
        project.id,
        project,
      ]),
    ).values(),
  ].filter(
    (project) =>
      project.entityType === "platform" ||
      project.deployments.some(
        (deployment) => deployment.discovery !== "onchain",
      ),
  );
  const chainsByProject = new Map(
    named.map((project) => [
      project.id,
      familyChains(project, poolsByProject.get(project.id) || []),
    ]),
  );
  const metadata = new Map(
    snapshot.chains.map((network) => [network.slug, network]),
  );
  const inventoryByChain = new Map(
    (snapshot.inventory?.networks || []).map((network) => [
      network.chain,
      network,
    ]),
  );
  const analyticsByChain = new Map(
    analytics.networks.map((network) => [network.chain, network]),
  );
  const deploymentChainIds = new Map<string, number>();
  for (const project of snapshot.projects)
    for (const deployment of project.deployments)
      if (!deploymentChainIds.has(deployment.chain))
        deploymentChainIds.set(deployment.chain, deployment.chainId);
  const listedByChain = new Map<string, RadarProject[]>();
  const listedHooksByChain = new Map<string, Set<string>>();
  for (const project of named) {
    for (const slug of chainsByProject.get(project.id)!) {
      if (!listedByChain.has(slug)) listedByChain.set(slug, []);
      listedByChain.get(slug)!.push(project);
    }
    for (const deployment of project.deployments) {
      if (!listedHooksByChain.has(deployment.chain))
        listedHooksByChain.set(deployment.chain, new Set());
      listedHooksByChain
        .get(deployment.chain)!
        .add(deployment.address.toLowerCase());
    }
  }
  const networkSlugs = new Set([
    ...metadata.keys(),
    ...inventoryByChain.keys(),
    ...deploymentChainIds.keys(),
    ...analytics.observedPools.map((pool) => pool.chain),
    ...[...chainsByProject.values()].flat(),
  ]);
  const empty = aggregateCurrentMarkets([], now);
  const networks = [...networkSlugs]
    .map((slug): ChainNetwork => {
      const meta = metadata.get(slug);
      const inventory = inventoryByChain.get(slug) || null;
      const measurements = analyticsByChain.get(slug);
      const chainId =
        meta?.id ?? inventory?.chainId ?? deploymentChainIds.get(slug) ?? null;
      return {
        slug,
        name: meta?.name || inventory?.name || slug,
        chainId,
        explorer: safeLink(meta?.explorer),
        inventory,
        deploymentSupport: deploymentSupportForNetwork({
          chain: slug,
          chainId,
          indexedManager: inventory?.manager,
        }),
        protocolCount: listedByChain.get(slug)?.length || 0,
        hookCount: listedHooksByChain.get(slug)?.size || 0,
        observedPools: measurements?.samplePools || 0,
        volumeUsd: measurements?.volumeUsd ?? null,
        liquidityUsd: measurements?.liquidityUsd ?? null,
        volumePools: measurements?.volumePools || 0,
        liquidityPools: measurements?.liquidityPools || 0,
        freshness: measurements?.freshness || empty.freshness,
        caughtUp: inventory ? networkCaughtUp(inventory) : false,
        headFresh: inventory ? networkHeadFresh(inventory, now) : false,
      };
    })
    .sort(
      (a, b) =>
        b.protocolCount - a.protocolCount || a.name.localeCompare(b.name),
    );
  const selectedNetwork =
    networks.find((network) => network.slug === chain) || null;
  const knownChain = chain === "all" || selectedNetwork !== null;
  const projectsInScope = named.filter(
    (project) =>
      chain === "all" || chainsByProject.get(project.id)!.includes(chain),
  );
  const protocolRows = projectsInScope.map((project): ChainProtocol => {
    const reviewed = listingIds.has(project.id);
    const pools = (
      (reviewed ? listingPools.get(project.id) : poolsByProject.get(project.id)) ||
      []
    ).filter((pool) => chain === "all" || pool.chain === chain);
    const record = reviewed
      ? reviewedLaunchpads.find((candidate) => candidate.id === project.id)
      : undefined;
    const attribution: PlatformAttribution | undefined = record
      ? (() => {
          const paths = record.paths.filter(
            (path) => chain === "all" || path.chain === chain,
          );
          const own = new Set(
            paths
              .filter((path) => path.attribution === "platform-hook")
              .flatMap((path) =>
                path.hooks.map(
                  (hook) => `${path.chain}:${hook.address.toLowerCase()}`,
                ),
              ),
          );
          const seen = new Set(
            pools
              .filter((pool) => pool.hookAddress)
              .map((pool) => `${pool.chain}:${pool.hookAddress!.toLowerCase()}`),
          );
          return {
            mappedHooks: own.size,
            hooksWithPools: [...own].filter((key) => seen.has(key)).length,
            sharedProtocolId:
              own.size === 0
                ? (paths.find((path) => path.attribution === "shared-protocol")
                    ?.protocolId ?? null)
                : null,
            perLaunchHooks:
              own.size === 0 && paths.some((path) => path.perLaunchHooks === true),
          };
        })()
      : undefined;
    const aggregate = aggregateCurrentMarkets(pools, now);
    const deployments = uniqueDeployments(
      project.deployments.filter(
        (deployment) => chain === "all" || deployment.chain === chain,
      ),
    );
    const registeredHookCount = deployments.filter(
      (deployment) => !deployment.discovery,
    ).length;
    const publishedHookCount = deployments.filter(
      (deployment) => deployment.discovery === "published",
    ).length;
    const officialUniswap = isOfficialUniswapHookFamily(project);
    return {
      project,
      website:
        safeLink(project.website) ||
        (officialUniswap ? "https://uniswap.org/" : null),
      docs:
        safeLink(project.docs) ||
        (officialUniswap
          ? "https://github.com/Uniswap/v4-hooks-public#docs"
          : null),
      sourceUrl:
        safeLink(project.sourceUrl) ||
        (officialUniswap ? "https://github.com/Uniswap/v4-hooks-public" : null),
      deployments,
      hookCount: deployments.length,
      registeredHookCount,
      publishedHookCount,
      discoveredHookCount:
        deployments.length - registeredHookCount - publishedHookCount,
      ...familyPoolCount(
        project,
        chain,
        pools.length,
        inventoryByChain,
        chainsByProject.get(project.id)!,
      ),
      ...chainProtocolRoles(project),
      volumeUsd: aggregate.volumeUsd[windowKey],
      liquidityUsd: aggregate.liquidityUsd,
      observedPools: pools.length,
      volumePools: aggregate.freshness.volume[windowKey].currentPools,
      liquidityPools: aggregate.freshness.liquidity.currentPools,
      freshness: aggregate.freshness,
      chainSlugs: chainsByProject.get(project.id)!,
      ...(attribution ? { attribution } : {}),
    };
  });
  if (hookOverlap)
    for (const [id, names] of hookOverlapNames(
      protocolRows,
      reviewedLaunchpads,
      chain,
    )) {
      const row = protocolRows.find((candidate) => candidate.project.id === id);
      if (row) row.sharedHookWith = names;
    }
  const protocols = protocolRows.sort(
    (a, b) =>
      descending(a.volumeUsd, b.volumeUsd) ||
      descending(a.liquidityUsd, b.liquidityUsd) ||
      // Projects with indexed hooks come before platform listings that only
      // carry identity, so unmeasured published records are not buried.
      b.hookCount - a.hookCount ||
      a.project.name.localeCompare(b.project.name) ||
      a.project.id.localeCompare(b.project.id),
  );
  const inventoryNetworks = (snapshot.inventory?.networks || []).filter(
    (network) => chain === "all" || network.chain === chain,
  );
  const emptyTotals: AnalyticsTotals = {
    volumeUsd: null,
    liquidityUsd: null,
    samplePools: 0,
    volumePools: 0,
    liquidityPools: 0,
    activePools: 0,
    attributedProjects: 0,
    unattributedPools: 0,
    unattributedVolumeUsd: null,
    unlistedProjects: 0,
    concentration: null,
    freshness: empty.freshness,
  };
  return {
    chain,
    knownChain,
    windowKey,
    asOf: analytics.asOf,
    networks,
    selectedNetwork,
    protocols,
    totalProtocols: protocolRows.length,
    filteredProtocols: protocols.length,
    hookCount: uniqueDeployments(protocolRows.flatMap((row) => row.deployments))
      .length,
    roles: [
      { id: "all", label: "All uses", count: protocolRows.length },
      ...chainRoles.map((option) => ({
        ...option,
        count: protocolRows.filter((row) => row.roles.includes(option.id))
          .length,
      })),
    ],
    totals:
      chain === "all"
        ? analytics.totals
        : analyticsByChain.get(chain) || emptyTotals,
    inventory: {
      hookCount: inventoryNetworks.length
        ? inventoryNetworks.reduce((sum, network) => sum + network.hookCount, 0)
        : null,
      hookPoolCount: inventoryNetworks.length
        ? inventoryNetworks.reduce(
            (sum, network) => sum + network.hookPoolCount,
            0,
          )
        : null,
      poolCount: inventoryNetworks.length
        ? inventoryNetworks.reduce((sum, network) => sum + network.poolCount, 0)
        : null,
      networkCount: chain === "all" ? networks.length : knownChain ? 1 : 0,
      indexedNetworks: inventoryNetworks.length,
      caughtUpChains: inventoryNetworks.filter(networkCaughtUp).length,
      freshChains: inventoryNetworks.filter((network) =>
        networkHeadFresh(network, now),
      ).length,
    },
  };
}

interface ChainCache {
  now: number;
  windowKey: WindowKey;
  projects: RadarSnapshot["projects"];
  pools: RadarSnapshot["pools"];
  chains: RadarSnapshot["chains"];
  inventory: RadarSnapshot["inventory"];
  analytics: AnalyticsSummary;
  scopes: Map<string, ChainExplorerResult>;
}

// Snapshot evidence is immutable in the application. Keep only one clock/window
// generation per snapshot; aging measurements always invalidate this cache.
// Query changes filter an existing model instead of recalculating 25k+ prices.
const chainCache = new WeakMap<RadarSnapshot, ChainCache>();

export function buildChains(
  snapshot: RadarSnapshot,
  {
    chain = "all",
    role = "all",
    search = "",
    windowKey = "h24",
    now = evaluationNow(),
    listings = true,
    hookOverlap = STATIC_EDITION,
  }: {
    chain?: string;
    role?: ChainRole | "all";
    search?: string;
    windowKey?: WindowKey;
    now?: number;
    /** Include reviewed launchpad platforms that the service does not publish. */
    listings?: boolean;
    /** Edition: say which rows publish the same hook (see `sharedHookWith`). */
    hookOverlap?: boolean;
  } = {},
): ChainExplorerResult {
  let cache = chainCache.get(snapshot);
  if (
    !cache ||
    cache.now !== now ||
    cache.windowKey !== windowKey ||
    cache.projects !== snapshot.projects ||
    cache.pools !== snapshot.pools ||
    cache.chains !== snapshot.chains ||
    cache.inventory !== snapshot.inventory
  ) {
    cache = {
      now,
      windowKey,
      projects: snapshot.projects,
      pools: snapshot.pools,
      chains: snapshot.chains,
      inventory: snapshot.inventory,
      analytics: buildAnalyticsSummary(snapshot, { windowKey, now }),
      scopes: new Map(),
    };
    chainCache.set(snapshot, cache);
  }
  const scopeKey = `${listings ? "listings" : "published"}:${hookOverlap ? "overlap" : "plain"}:${chain}`;
  let base = cache.scopes.get(scopeKey);
  if (!base) {
    base = buildChainBase(snapshot, cache.analytics, {
      chain,
      windowKey,
      now,
      listings,
      hookOverlap,
    });
    if (cache.scopes.size >= 32)
      cache.scopes.delete(cache.scopes.keys().next().value!);
    cache.scopes.set(scopeKey, base);
  }
  const needle = search.trim().toLowerCase().slice(0, 300);
  const protocols = base.protocols.filter(
    (row) =>
      (role === "all" || row.roles.includes(role)) &&
      (!needle ||
        [
          row.project.name,
          row.project.description,
          ...row.deployments.flatMap((deployment) => [
            deployment.name,
            deployment.address,
          ]),
        ].some((text) => text.toLowerCase().includes(needle))),
  );
  return { ...base, protocols, filteredProtocols: protocols.length };
}

/* ── Launchpad presentation profiles ─────────────────────────────────────────
 * Optional, source-backed facts shown on Launchpads rows. They never change
 * role classification, counts, attribution or market totals above: a project
 * is a launchpad only through `chainProtocolRoles`. Add reviewed entries to
 * `launchpadRegistry`, keyed by the exact directory project id. Every field is
 * optional; an absent field is presented as "not reviewed", never inferred.
 * Model platform → underlying protocol → exact hooks/pools with `builtOn`; a
 * shared protocol keeps its own hooks and pools (never double-count them). */

/** Operating status from a primary source. "unverified" = not yet reviewed.
 * Same vocabulary as `LaunchpadStatus` in shared/launchpad-types.ts. */
export type LaunchpadStatus =
  | "live"
  | "restricted"
  | "deprecated"
  | "planned"
  | "unverified";

export const launchpadStatuses: readonly LaunchpadStatus[] = [
  "live",
  "restricted",
  "deprecated",
  "planned",
  "unverified",
];

/** How launches reach v4 pools, per documentation (a platform may use several). */
export type LaunchpadHookModel =
  | "own-hooks"
  | "shared-hooks"
  | "configurable-hooks"
  | "hookless-pools";

export interface LaunchpadSource {
  label: string;
  url: string;
}

export interface LaunchpadBuiltOn {
  /** Underlying protocol or shared launch infrastructure, e.g. a launch SDK. */
  name: string;
  /** Directory project id when that protocol is itself listed (rows link to it). */
  projectId?: string | null;
  sourceUrl?: string | null;
}

export interface LaunchpadRegistryEntry {
  /** One plain-language sentence: what a person can do with this launchpad. */
  offers?: string;
  offersSourceUrl?: string;
  status?: LaunchpadStatus;
  /** Qualification such as "public launches closed; allowlist only". */
  statusNote?: string;
  statusSourceUrl?: string;
  /** ISO date of the human source review (not a live check). */
  reviewedAt?: string;
  builtOn?: readonly LaunchpadBuiltOn[];
  hookModels?: readonly LaunchpadHookModel[];
  /** Plain-language summary of the exact hooks the platform publishes. */
  hookSummary?: string;
  /** Chain slugs the official documentation names; may differ from evidence. */
  documentedNetworks?: readonly string[];
  website?: string;
  docs?: string;
  sources?: readonly LaunchpadSource[];
}

/** Operating status of the platforms that have their own directory records
 * (their hooks come from the published directory, not from the registry above),
 * read on 2026-10-24 from each platform's own website or documentation only.
 * The evidence is what the pages say today, not an uptime check: their docs are
 * undated, so each note says what was read. Pools.xyz renders only in a
 * browser, so it was read there (its own homepage, 2026-10-24). */
const originalPlatformStatus: Readonly<
  Record<string, Readonly<LaunchpadRegistryEntry>>
> = {
  frontier: {
    status: "live",
    statusNote:
      "Inferred from Frontier's documentation, which describes creating a coin on Robinhood Chain with no listing fee or waiting list. The docs are undated.",
    statusSourceUrl: "https://docs.frontier.fun/launching/creating-a-coin",
    documentedNetworks: ["robinhood"],
    reviewedAt: "2026-10-24",
  },
  clanker: {
    status: "live",
    statusNote:
      "Inferred from Clanker's website, which says an ERC-20 can be launched on Base, Ethereum, BNB Chain and more; its docs describe a V4 SDK deploy function. Pages undated.",
    statusSourceUrl: "https://www.clanker.world",
    documentedNetworks: ["base", "ethereum", "bnb", "arbitrum"],
    reviewedAt: "2026-10-24",
  },
  flaunch: {
    status: "live",
    statusNote:
      "Inferred from Flaunch's documentation, which describes a token launch flow (fixed-price fair launch, creator revenue) with a Base example. The docs are undated.",
    statusSourceUrl: "https://docs.flaunch.gg/getting-started/flaunch-a-coin",
    documentedNetworks: ["base"],
    reviewedAt: "2026-10-24",
  },
  doppler: {
    status: "live",
    statusNote:
      "Doppler's website says it is live on Base, Monad and Ethereum Mainnet and offers a Launch a token button; its docs describe launching through price discovery auctions.",
    statusSourceUrl: "https://www.doppler.lol",
    documentedNetworks: ["base", "monad", "ethereum"],
    reviewedAt: "2026-10-24",
  },
  "pools-xyz": {
    status: "live",
    statusNote:
      "Pools' own website says users can launch and trade the newest tokens on Robinhood Chain and Arc, with a Launch a token button and a Top tokens list.",
    statusSourceUrl: "https://pools.xyz",
    documentedNetworks: ["robinhood", "arc"],
    reviewedAt: "2026-10-24",
  },
  zora: {
    status: "live",
    statusNote:
      "Inferred from Zora's documentation: each coin trades in a dedicated Uniswap v4 pool with a custom hook, and the SDK guide documents creating coins on Base mainnet. Docs undated.",
    statusSourceUrl: "https://docs.zora.co/coins/sdk/create-coin",
    documentedNetworks: ["base"],
    reviewedAt: "2026-10-24",
  },
};

/** Reviewed launchpad facts from shared/launchpad-registry.ts (2026-10-23),
 * plus the operating status of the original platform records above. */
export const launchpadRegistry: Readonly<
  Record<string, Readonly<LaunchpadRegistryEntry>>
> = Object.freeze({
  ...originalPlatformStatus,
  ...Object.fromEntries(
    reviewedLaunchpads.map((record) => [
      record.id,
      launchpadEntryFromRecord(record, {
        reviewedAt: record.reviewedAt ?? LAUNCHPAD_REVIEWED_AT,
        protocolName: (id) => (id === "doppler" ? "Doppler" : null),
      }),
    ]),
  ),
});

export interface LaunchpadProfile {
  offers: string;
  offersSourceUrl: string | null;
  status: LaunchpadStatus;
  statusNote: string | null;
  statusSourceUrl: string | null;
  reviewedAt: string | null;
  builtOn: { name: string; projectId: string | null; sourceUrl: string | null }[];
  hookModels: LaunchpadHookModel[];
  hookSummary: string | null;
  documentedNetworks: string[] | null;
  website: string | null;
  docs: string | null;
  sources: LaunchpadSource[];
}

const hookModels: readonly LaunchpadHookModel[] = [
  "own-hooks",
  "shared-hooks",
  "configurable-hooks",
  "hookless-pools",
];

/** Presentation facts for a launchpad row: registry entries first, otherwise
 * the existing role evidence. Returns null for rows without the launchpad role. */
export function launchpadProfile(
  row: Pick<
    ChainProtocol,
    "project" | "roles" | "roleEvidence" | "website" | "docs"
  >,
  registry: Readonly<
    Record<string, Readonly<LaunchpadRegistryEntry>>
  > = launchpadRegistry,
): LaunchpadProfile | null {
  if (!row.roles.includes("launchpads")) return null;
  const entry: Readonly<LaunchpadRegistryEntry> = Object.hasOwn(
    registry,
    row.project.id,
  )
    ? registry[row.project.id]
    : {};
  const evidence = row.roleEvidence.filter(
    (item) => item.role === "launchpads",
  );
  // A platform record's description is its documented offer; a reviewed
  // hook family's offer is the reviewed product-function note.
  const reviewed =
    row.project.entityType === "platform" ? undefined : evidence.at(-1);
  const text = (value: string | undefined) =>
    typeof value === "string" && value.trim() ? value.trim() : null;
  const reviewedAt =
    entry.reviewedAt && Number.isFinite(Date.parse(entry.reviewedAt))
      ? entry.reviewedAt
      : null;
  const sources = [
    ...(entry.sources || []),
    ...evidence.map((item) => ({
      label:
        row.project.entityType === "platform"
          ? "Platform documentation"
          : "Launchpad classification source",
      url: item.sourceUrl || "",
    })),
  ]
    .map((source) => ({ label: source.label, url: safeLink(source.url) }))
    .filter(
      (source, index, list): source is LaunchpadSource =>
        !!source.url &&
        !!source.label &&
        list.findIndex((other) => other.url === source.url) === index,
    );
  return {
    offers:
      text(entry.offers) ||
      text(reviewed?.note) ||
      text(row.project.description) ||
      "",
    offersSourceUrl:
      safeLink(entry.offersSourceUrl) ||
      (text(entry.offers)
        ? null
        : safeLink(reviewed?.sourceUrl) || safeLink(row.project.sourceUrl)),
    status:
      entry.status && launchpadStatuses.includes(entry.status)
        ? entry.status
        : "unverified",
    statusNote: text(entry.statusNote),
    statusSourceUrl: safeLink(entry.statusSourceUrl),
    reviewedAt,
    builtOn: (entry.builtOn || [])
      .filter((item) => text(item.name))
      .map((item) => ({
        name: item.name.trim(),
        projectId: text(item.projectId ?? undefined),
        sourceUrl: safeLink(item.sourceUrl),
      })),
    hookModels: [...new Set(entry.hookModels || [])].filter((model) =>
      hookModels.includes(model),
    ),
    hookSummary: text(entry.hookSummary),
    documentedNetworks: entry.documentedNetworks
      ? [...new Set(entry.documentedNetworks)].filter((slug) =>
          /^[a-z0-9][a-z0-9-]{0,99}$/.test(slug),
        )
      : null,
    website: safeLink(entry.website) || row.website,
    docs: safeLink(entry.docs) || row.docs,
    sources,
  };
}

/** Structural subset of `LaunchpadRecord` in shared/launchpad-types.ts, so this
 * module stays independent of that registry's loading. */
export interface LaunchpadRecordLike {
  readonly description: string;
  readonly website: string;
  readonly docs: string;
  readonly status: LaunchpadStatus;
  readonly statusNote: string;
  readonly paths: readonly {
    readonly label: string;
    readonly chain: string;
    readonly status: LaunchpadStatus;
    readonly poolKind: "hooked" | "hookless" | "unknown";
    readonly attribution: "platform-hook" | "shared-protocol" | "none";
    readonly perLaunchHooks?: boolean;
    /** Directory project id of the shared protocol the hooks belong to. */
    readonly protocolId?: string;
    readonly hooks: readonly { readonly address: string }[];
    readonly evidence: readonly { readonly url: string; readonly note: string }[];
  }[];
}

/** Adapt a reviewed launchpad record to the presentation entry above. Shared
 * protocol hooks become `builtOn` links (counted under that protocol, never
 * re-attributed); planned paths do not count as documented networks. */
export function launchpadEntryFromRecord(
  record: LaunchpadRecordLike,
  {
    reviewedAt,
    protocolName,
    hooksByChain = STATIC_EDITION,
  }: {
    reviewedAt?: string;
    protocolName?: (id: string) => string | null;
    /** Count a hook once for each network it is deployed on, as the rest of the
     * page does (a hook is a chain and an address). Off, an address deployed on
     * two networks counts once, as the live page has always counted it; the
     * edition turns it on. */
    hooksByChain?: boolean;
  } = {},
): LaunchpadRegistryEntry {
  const models = new Set<LaunchpadHookModel>();
  for (const path of record.paths) {
    if (path.attribution === "platform-hook") models.add("own-hooks");
    if (path.attribution === "shared-protocol") models.add("shared-hooks");
    if (path.poolKind === "hookless") models.add("hookless-pools");
  }
  const protocols = [
    ...new Set(
      record.paths.flatMap((path) =>
        path.attribution === "shared-protocol" && path.protocolId
          ? [path.protocolId]
          : [],
      ),
    ),
  ];
  const unique = (attribution: "platform-hook" | "shared-protocol") =>
    new Set(
      record.paths
        .filter((path) => path.attribution === attribution)
        .flatMap((path) =>
          path.hooks.map((hook) =>
            hooksByChain
              ? `${path.chain}:${hook.address.toLowerCase()}`
              : hook.address,
          ),
        ),
    ).size;
  const own = unique("platform-hook");
  const shared = unique("shared-protocol");
  const sharedName = protocols.map((id) => protocolName?.(id) || id).join(", ");
  const hookSummary = own
    ? `${own} exact ${own === 1 ? "hook" : "hooks"} published${shared ? ` · plus shared ${sharedName} hooks` : ""}`
    : shared
      ? `Shared ${sharedName} hooks · counted under ${sharedName}`
      : record.paths.some((path) => path.perLaunchHooks)
        ? "A separate hook for every launch · none listed"
        : record.paths.some((path) => path.poolKind === "hookless")
          ? "No hook · pools are hookless"
          : "No hook attributed";
  return {
    offers: record.description,
    offersSourceUrl: record.docs || record.website,
    hookSummary,
    status: record.status,
    statusNote: record.statusNote,
    reviewedAt,
    builtOn: protocols.map((id) => ({
      name: protocolName?.(id) || id,
      projectId: id,
    })),
    hookModels: [...models],
    documentedNetworks: [
      ...new Set(
        record.paths
          .filter((path) => path.status !== "planned")
          .map((path) => path.chain),
      ),
    ],
    website: record.website,
    docs: record.docs,
    sources: record.paths.flatMap((path) =>
      path.evidence.map((item) => ({
        label: `${path.label} · source`,
        url: item.url,
      })),
    ),
  };
}
