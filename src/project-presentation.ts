import type { Pool, RadarProject, WindowKey } from "../shared/types";
import { currentMetricValue } from "../shared/market-freshness.ts";
import { STATIC_EDITION } from "./edition.ts";
import { FRONTIER_SCOPE_NOTE } from "./edition-platform-copy.ts";
import { count, shortAddress } from "./model.ts";

/** Match the directory's count semantics without turning an unknown chain into zero. */
export function projectPoolCount(project: RadarProject, chain = "all") {
  const inventory = project.poolInventory;
  if (!inventory) return project.metrics.poolCount;
  if (chain === "all") return inventory.poolCount;
  return (
    inventory.chains[chain] ??
    (inventory.complete ? 0 : project.metrics.poolCount)
  );
}

export function projectHookCount(project: RadarProject, chain = "all") {
  if (project.entityType === "platform") return null;
  return project.deployments.filter(
    (deployment) => chain === "all" || deployment.chain === chain,
  ).length;
}

export function poolCountIsObserved(project: RadarProject, chain = "all") {
  const inventory = project.poolInventory;
  return (
    !inventory ||
    (chain !== "all" &&
      !inventory.complete &&
      inventory.chains[chain] === undefined)
  );
}

/** Registry classifications describe published metadata, never a live safety assessment. */
export function projectInspection(project: RadarProject) {
  const classified = project.deployments.filter(
    (hook) =>
      hook.discovery !== "onchain" &&
      hook.discovery !== "published" &&
      hook.properties.swapAccess !== "unknown",
  );
  const auditLinks = project.deployments.filter((hook) => {
    if (!hook.auditUrl) return false;
    try {
      const url = new URL(hook.auditUrl);
      return ["https:", "http:"].includes(url.protocol);
    } catch {
      return false;
    }
  }).length;
  return {
    classified: classified.length,
    unknown: project.deployments.length - classified.length,
    dynamicFee: classified.filter((hook) => hook.properties.dynamicFee).length,
    upgradeable: classified.filter((hook) => hook.properties.upgradeable)
      .length,
    customData: classified.filter(
      (hook) => hook.properties.requiresCustomSwapData,
    ).length,
    restricted: classified.filter((hook) =>
      ["temporal", "allowlist", "governance", "other"].includes(
        hook.properties.swapAccess,
      ),
    ).length,
    verifiedSource: classified.filter((hook) => hook.verifiedSource).length,
    auditLinks,
  };
}

/** The community indexer's documentation page. The snapshot collector gives a
 * hook that only the v4.xyz indexer reported this source (collector/assemble.mjs),
 * where a hook from the PoolManager census keeps the deployments page. */
export const COMMUNITY_INDEXER_SOURCE =
  "https://developers.uniswap.org/docs/community/tooling/v4-community-indexer";

/** A discovered hook whose only evidence is the v4.xyz indexer, not the census of
 * PoolManager events. */
export function reportedByIndexer(project: RadarProject) {
  return (
    project.deployments.length > 0 &&
    project.deployments.every(
      (hook) =>
        hook.discovery === "onchain" &&
        hook.sourceUrl === COMMUNITY_INDEXER_SOURCE,
    )
  );
}

/** What an indexer-reported hook says about itself when the snapshot carries no
 * description for it. */
const INDEXER_REPORT_FALLBACK =
  "Hook address reported by the v4.xyz indexer for pools Hook Radar measured. Project identity and contract source have not been verified.";

/** The sentence under a discovered project's name. */
export function discoverySummary(
  project: RadarProject,
  options: { edition?: boolean; census?: string | null } = {},
) {
  const edition = options.edition ?? STATIC_EDITION;
  // The snapshot describes the hooks it holds; an indexer-reported hook was never
  // seen in a PoolManager event, so the census wording would be false for it,
  // whether or not the snapshot gave it a description.
  if (edition && reportedByIndexer(project))
    return project.description.trim() || INDEXER_REPORT_FALLBACK;
  const sentence =
    "Hook contract identified in Uniswap v4 pool creation events.";
  return edition && options.census
    ? `${sentence} ${options.census}.`
    : sentence;
}

/** Naming and discovery provenance are distinct from contract ownership. The
 * snapshot edition also dates a census-found hook and names an indexer-reported
 * one for what it is; the live wording is unchanged. */
export function projectIdentity(
  project: RadarProject,
  options: { edition?: boolean; census?: string | null } = {},
) {
  const edition = options.edition ?? STATIC_EDITION;
  if (project.entityType === "platform")
    return {
      label: "Platform",
      description:
        "A documented application. Its supported networks do not establish ownership of individual hook contracts or pools.",
    };
  const published = project.deployments.filter(
    (hook) => hook.discovery === "published",
  ).length;
  const found = project.deployments.filter(
    (hook) => hook.discovery === "onchain",
  ).length;
  if (found > 0 && found === project.deployments.length) {
    if (edition && reportedByIndexer(project))
      return {
        label: "Reported by the v4.xyz indexer",
        description: project.description.trim() || INDEXER_REPORT_FALLBACK,
      };
    const description =
      "Found in Uniswap v4 pool creation events. No named registry listing is available.";
    return {
      label: "Onchain discovery",
      description:
        edition && options.census
          ? `${description} ${options.census}.`
          : description,
    };
  }
  if (published > 0 && published === project.deployments.length)
    return {
      label: "Published deployment",
      description:
        "The hook name and deployment address are documented in a first-party deployment list. Pool presence comes from indexed creation events; contract controls remain unclassified unless separately listed.",
    };
  return {
    label:
      published > 0
        ? "Published listings"
        : found > 0
          ? "Registry + onchain"
          : "Registry-listed",
    description:
      "Project names come from published listings. Contract ownership has not been independently confirmed.",
  };
}

/* ── The pool list of a snapshot ─────────────────────────────────────────── */

/** The networks where the snapshot measured at least one pool, or null when it
 * does not say. The market coverage table counts the measured pools of every
 * network the collector asked about; the coverage summary names the same
 * networks and stands in for it when the table is absent. */
export function measuredNetworks(snapshot: {
  marketCoverage?: {
    networks: readonly { chain: string; measuredPools: number }[];
  } | null;
  coverage?: { measuredChains: readonly string[] } | null;
}): string[] | null {
  const table = snapshot.marketCoverage?.networks;
  if (table?.length)
    return table
      .filter((network) => network.measuredPools > 0)
      .map((network) => network.chain);
  const named = snapshot.coverage?.measuredChains;
  return named ? [...new Set(named)] : null;
}

/** What the Pools tab says when a project has no pool to list. The live page
 * has no pool for the project in its market sources; a snapshot only measured a
 * sample of hook pools, so it can say no more than that none of this project's
 * is in the sample. */
export function emptyPoolsCopy(options: {
  chain: string;
  measured: readonly string[] | null;
  chainName: (slug: string) => string;
  edition?: boolean;
}) {
  const { chain, measured, chainName } = options;
  if (!(options.edition ?? STATIC_EDITION))
    return {
      title: "Pool data isn’t available yet",
      body: "Our market sources don’t have pools for this project yet. You can still explore its hooks.",
    };
  const title = "No pools measured in this snapshot";
  if (chain !== "all" && measured && !measured.includes(chain))
    return {
      title,
      body: `This snapshot does not measure pools on ${chainName(chain)}.`,
    };
  const names = (measured ?? [])
    .map(chainName)
    .sort((a, b) => a.localeCompare(b, "en"));
  const where = names.length
    ? ` on ${new Intl.ListFormat("en-GB", { type: "conjunction" }).format(names)}`
    : "";
  const whose =
    chain === "all"
      ? "this project’s pools are"
      : `this project’s pools on ${chainName(chain)} are`;
  return {
    title,
    body: `This snapshot measures a sample of hook pools${where}. None of ${whose} in that sample, so it may still have pools${chain === "all" ? "" : " there"} that were not measured.`,
  };
}

/** A project's measured pools from the largest current volume of the chosen
 * window down. A pool without a current volume goes last, never as a zero, and
 * the pool id settles a tie. The live list keeps the order it is given. */
export function orderedPools<T extends Pool>(
  pools: T[],
  windowKey: WindowKey,
  now: number,
  edition: boolean = STATIC_EDITION,
  /** Edition: the 7D or 30D figure of a pool, when the page shows one. A pool
   * with one comes before every pool without, largest first; the rest keep the
   * window's order. Absent: the window's order throughout. */
  dailyOf?: (pool: T) => number | null,
): T[] {
  if (!edition) return pools;
  const volume = new Map(
    pools.map((pool) => [pool, currentMetricValue(pool, windowKey, now)]),
  );
  return [...pools].sort((a, b) => {
    if (dailyOf) {
      const p = dailyOf(a);
      const q = dailyOf(b);
      if (p !== q) {
        if (p === null) return 1;
        if (q === null) return -1;
        return q - p;
      }
    }
    const x = volume.get(a)!;
    const y = volume.get(b)!;
    if (x !== y) {
      if (x === null) return 1;
      if (y === null) return -1;
      return y - x;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** How the drawer words a project's count of pools. The live service finds the
 * pools it lists ("found"); a snapshot lists the ones it measured, and says so
 * wherever the number appears. `figure` is the count as the page formats it. */
export function poolWording(edition: boolean = STATIC_EDITION) {
  return {
    readoutLabel: edition ? "Pools measured" : "Pools found",
    /** The note under the count when the project has no pool inventory. */
    countNote: (count: number | null) =>
      count === null
        ? edition
          ? "None measured"
          : "Not available"
        : edition
          ? "Measured in this snapshot"
          : "From market sources",
    /** The figure beside the Pools tab. */
    tabFigure: (count: number | null, figure: string) =>
      edition
        ? count === null
          ? "none measured"
          : `measured ${figure}`
        : figure,
    /** The pools card of the setup ribbon. */
    setupCount: (count: number | null, figure: string) =>
      edition
        ? count === null
          ? { figure: "None", unit: "measured" }
          : { figure, unit: count === 1 ? "measured pool" : "measured pools" }
        : { figure, unit: count === 1 ? "pool" : "pools" },
    /** The unit in "Showing 20 of 345 …"; a snapshot's list of one is singular.
     * `total` is the count the sentence ends on. */
    listUnit: (searching: boolean, total?: number | null) =>
      edition
        ? `${searching ? "matching " : ""}measured ${total === 1 ? "pool" : "pools"}`
        : searching
          ? "matching pools"
          : "pools",
    /** How the list is ordered, when the page orders it. */
    listOrder: (windowLabel: string) =>
      edition ? `Sorted by ${windowLabel} volume` : null,
  };
}

/* ── Scope of a project's figures in a snapshot ──────────────────────────── */

const plural = (n: number, one: string, many: string) =>
  `${count(n)} ${n === 1 ? one : many}`;

/** The networks of a set of pools, by name, in alphabetical order. */
export function poolNetworks(
  pools: readonly { chain: string }[],
  chainName: (slug: string) => string,
): { slugs: string[]; names: string[] } {
  const slugs = [...new Set(pools.map((pool) => pool.chain))].sort((a, b) =>
    chainName(a).localeCompare(chainName(b), "en"),
  );
  return { slugs, names: slugs.map(chainName) };
}

/** The "Market coverage" paragraph of a project's "About this data" panel. The
 * snapshot's own note counts every pool of the run, so printed under a project
 * it reads as that project's coverage. The edition states the project's own
 * measured pools, networks and sources first, with the snapshot's sample as
 * context; the live page keeps the note it was given (null here). */
export function projectCoverageNote(options: {
  /** The project's measured pools. */
  pools: readonly { chain: string; source: string }[];
  /** Every pool the snapshot measured. */
  snapshotPools: readonly { chain: string }[];
  /** The project's id: Frontier's figures say what they leave out. */
  projectId?: string;
  edition?: boolean;
}): string | null {
  if (!(options.edition ?? STATIC_EDITION)) return null;
  const { pools, snapshotPools } = options;
  const scope =
    options.projectId === "frontier" ? ` ${FRONTIER_SCOPE_NOTE}` : "";
  const wholeSnapshot = snapshotPools.length
    ? ` The snapshot as a whole measured ${plural(snapshotPools.length, "pool", "pools")} on ${plural(new Set(snapshotPools.map((pool) => pool.chain)).size, "network", "networks")}.`
    : "";
  if (!pools.length)
    return `None of this project’s pools were measured in this snapshot, so it has no market totals.${wholeSnapshot} Missing values are unavailable, never zero.${scope}`;
  const sources = [
    ...new Set(pools.map((pool) => pool.source.trim()).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b, "en"));
  return `This project’s totals use its ${plural(pools.length, "measured pool", "measured pools")} on ${plural(new Set(pools.map((pool) => pool.chain)).size, "network", "networks")}${sources.length ? ` from ${sources.join(", ")}` : ""}.${wholeSnapshot} Dollar totals use available observations, not ecosystem totals. Unpriced pools remain browsable; missing values are unavailable, never zero.${scope}`;
}

/** "Arbitrum · Ethereum +2": the first two names and how many more. */
function nameList(names: readonly string[]): string {
  return names.length <= 2
    ? names.join(" · ")
    : `${names.slice(0, 2).join(" · ")} +${names.length - 2}`;
}

/** The "Networks" figure of a project's totals. The networks a project lists a
 * hook on are not the networks where the snapshot measured its pools, so the
 * edition says which is which; the live page keeps its words. */
export function networksReadout(options: {
  /** Every network the project lists a hook or a pool on. */
  networks: readonly string[];
  /** The networks of the project's measured pools. */
  measuredOn: readonly string[];
  chainName: (slug: string) => string;
  edition?: boolean;
}) {
  const edition = options.edition ?? STATIC_EDITION;
  const names = options.networks.map(options.chainName);
  const listed = names.length ? nameList(names) : "None listed";
  if (!edition)
    return { label: "Networks", note: listed, title: names.join(", ") };
  const measured = options.measuredOn.map(options.chainName);
  return {
    label: "Networks with hooks",
    note: measured.length
      ? `Measured pools on ${nameList(measured)}`
      : "No measured pools",
    title: names.length
      ? `Hooks listed on ${names.join(", ")}${measured.length ? `. Measured pools on ${measured.join(", ")}` : ""}`
      : undefined,
  };
}

/** The network count beside "Explore the setup". */
export function setupNetworks(
  networks: readonly string[],
  chainName: (slug: string) => string,
  edition: boolean = STATIC_EDITION,
): string {
  if (networks.length === 1) return chainName(networks[0]);
  return `${count(networks.length)} networks${edition ? " with hooks" : ""}`;
}

/* ── Names of the controls that repeat on every row ──────────────────────── */

/** A pool as a screen reader should hear it: its pair, the end of its id and its
 * network, so the rows of a list that holds several pools of one pair, or one
 * pool id on two networks, are told apart. */
export function poolRowName(
  pool: { name: string; address: string },
  networkName: string,
): string {
  return `${pool.name} ${shortAddress(pool.address)} on ${networkName}`;
}

/** The part of a hook address that tells it from its neighbours. Hook addresses
 * are mined: most start with a run of zeros and end in the same permission bits,
 * so the usual "0x0000…1888" is the same for a dozen hooks of one project. The
 * tag skips the zeros and keeps `digits` of the rest at each end (the whole
 * address when that is all of it). */
export function addressTag(address: string, digits = 4): string {
  const significant = address
    .replace(/^0x/i, "")
    .replace(/^0+/, "")
    .toLowerCase();
  return significant.length > digits * 2
    ? `0x${significant.slice(0, digits)}…${significant.slice(-digits)}`
    : address.toLowerCase();
}

/** The fewest digits per end for which the tags of these addresses are all
 * different: a hook family can share a mined prefix and a suffix, so four are
 * not always enough. The whole address is the last resort. */
export function tagDigits(addresses: readonly string[]): number {
  const distinct = new Set(addresses.map((address) => address.toLowerCase()));
  for (const digits of [4, 6, 8, 12])
    if (
      new Set(addresses.map((address) => addressTag(address, digits))).size ===
      distinct.size
    )
      return digits;
  return 20;
}

/** A hook contract the same way: a project can list one name on every network
 * and one address on several. */
export function hookRowName(
  hook: { name?: string; address: string },
  networkName: string,
  digits = 4,
): string {
  return `${hook.name || "Hook contract"} ${addressTag(hook.address, digits)} on ${networkName}`;
}

/** The accessible names of a pool row's controls in the edition, or null on the
 * live page, which keeps the names it has. The visible text is always part of
 * the name. */
export function poolControlLabels(
  pool: { name: string; address: string; source: string },
  linkText: string,
  networkName: string,
  edition: boolean = STATIC_EDITION,
) {
  if (!edition) return null;
  const who = poolRowName(pool, networkName);
  return {
    details: `Details for ${who}`,
    view: `${linkText} ${who}${pool.source === "Hook contract" ? "" : `, ${pool.source}`}`,
    copyId: `Copy pool ID of ${who}`,
    copyHook: `Copy hook address of ${who}`,
    // Network last, like the hook cards' "View on explorer for …": `who`
    // already ends in "on <Network>", so "… on explorer" after it read as
    // "on Base on explorer" (also the link's hover title).
    explorerHook: `View hook on explorer for ${who}`,
  };
}

/** The same for a hook card's controls. `digits` is the project's tagDigits(). */
export function hookControlLabels(
  hook: { name?: string; address: string },
  networkName: string,
  digits = 4,
  edition: boolean = STATIC_EDITION,
) {
  if (!edition) return null;
  const who = hookRowName(hook, networkName, digits);
  // The copy button shows the short address, so its name starts as the live
  // page's does and adds the part that tells the hooks apart.
  const tag = addressTag(hook.address, digits);
  const short = shortAddress(hook.address);
  return {
    copy: `Copy ${hook.name || "hook"} address ${short} on ${networkName}${tag === short ? "" : ` (${tag})`}`,
    explorer: `View on explorer for ${who}`,
    audit: `Audit for ${who}`,
    details: `Contract details for ${who}`,
    source: `Source entry for ${who}`,
    copyExpanded: `Copy address of ${who}`,
    callbacks: (flags: number) =>
      `${flags} callback ${flags === 1 ? "flag" : "flags"} of ${who}`,
  };
}

/** The accessible name of a list's "Show more" button: what it adds and how many
 * remain. The visible words are always inside it. */
export function showMoreLabel(
  kind: "pools" | "hooks",
  remaining: number,
  edition: boolean = STATIC_EDITION,
): string | undefined {
  if (!edition) return undefined;
  const next = Math.min(20, remaining);
  return kind === "hooks"
    ? `Show ${next} more · ${count(remaining)} remaining hooks`
    : `Show ${next} more ${remaining === 1 ? "pool" : "pools"} · ${count(remaining)} remaining`;
}
