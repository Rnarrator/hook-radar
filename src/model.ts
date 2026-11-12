import type { RadarProject, RadarSnapshot, WindowKey } from "../shared/types";
import { isPoolKey } from "../shared/pool-key.ts";
import { isMarketCoverage } from "../shared/market-coverage.ts";
import { isDirectoryInfo } from "../shared/directory.ts";
import { isPublishedPlatformProject } from "../shared/published-platform-hooks.ts";
import { STATIC_EDITION, timeLabel } from "./edition.ts";
import {
  foldSearchText,
  matchSearchTerms,
  searchTerms,
} from "./pool-search.ts";
import type { PoolSearchIndex } from "./pool-search.ts";
// Components that render the edition's differences import the flag from here,
// where their isolated render tests already resolve the module.
export { STATIC_EDITION };

export const categories = [
  "Launches",
  "Liquidity",
  "Fees",
  "MEV",
  "Orders",
  "Oracles",
  "Access",
  "Other",
] as const;
export type View =
  | "overview"
  | "analytics"
  | "chains"
  | "map"
  | "learn"
  | "watchlist"
  | "compare"
  | "activity";
export type SortKey = "name" | "deployments" | "volume" | "liquidity" | "pools";
export type PropertyFilter =
  "all" | "dynamic" | "verified" | "upgradeable" | "custom";
export interface Filters {
  search: string;
  chain: string;
  category: string;
  property: PropertyFilter;
  market?: "projects" | "all" | "observed" | "active";
}
export const windows: Record<WindowKey, string> = {
  h1: "1H",
  h6: "6H",
  h24: "24H",
};

/** A search names a network when it is at least three characters and starts the
 * network's name or short name: "base", "uni" (Unichain), "x layer", "bnb". Two
 * letters would match half the list. */
function namesNetwork(
  query: string,
  chains: readonly string[],
  chainNames: ReadonlyMap<string, string>,
) {
  return (
    query.length >= 3 &&
    chains.some((chain) =>
      [chain, chainNames.get(chain)].some((label) =>
        label?.toLowerCase().startsWith(query),
      ),
    )
  );
}

/** For each word of a search, whether it is part of the name of one of `chains`:
 * a word alone ("base", "uni") or with its neighbours ("x layer", "world
 * chain"). A network's name has at most three words. */
function networkWordFlags(
  terms: readonly string[],
  chains: readonly string[],
  chainNames: ReadonlyMap<string, string>,
) {
  const flags = terms.map(() => false);
  for (let start = 0; start < terms.length; start++)
    for (let end = start; end < Math.min(terms.length, start + 3); end++)
      if (
        namesNetwork(terms.slice(start, end + 1).join(" "), chains, chainNames)
      )
        for (let index = start; index <= end; index++) flags[index] = true;
  return flags;
}

/** The text of a project the search reads, folded once per object: the project's
 * name, use case and description, and each hook's address, name and description. */
const foldedText = new WeakMap<object, readonly string[]>();
function foldedFields(owner: object, fields: () => string[]) {
  let value = foldedText.get(owner);
  if (!value) {
    value = fields().map(foldSearchText);
    foldedText.set(owner, value);
  }
  return value;
}
const allFoldedText = new WeakMap<RadarProject, readonly string[]>();
function projectSearchFields(
  project: RadarProject,
  deployments: RadarProject["deployments"],
) {
  // With no network selected the whole list of hooks is read: keep that list.
  const whole = deployments === project.deployments;
  const known = whole ? allFoldedText.get(project) : undefined;
  if (known) return known;
  const own = foldedFields(project, () => [
    project.name,
    project.description,
    project.category,
  ]);
  const fields = deployments.length
    ? own.concat(
        ...deployments.map((d) =>
          foldedFields(d, () => [d.address, d.name, d.description]),
        ),
      )
    : own;
  if (whole) allFoldedText.set(project, fields);
  return fields;
}

/** The deployments a search reads: those on the selected network, or all. */
function scopedDeployments(project: RadarProject, chain: string) {
  return chain === "all"
    ? project.deployments
    : project.deployments.filter((d) => d.chain === chain);
}

/** The whole search, as typed, found in the project's own text, or naming one of
 * its networks. This is what the search has always matched. */
function matchesProjectText(
  project: RadarProject,
  deployments: RadarProject["deployments"],
  query: string,
  chain: string,
  chainNames: ReadonlyMap<string, string> | undefined,
) {
  return (
    [
      project.name,
      project.description,
      project.category,
      ...deployments.flatMap((d) => [d.address, d.name, d.description]),
    ].some((value) => value.toLowerCase().includes(query)) ||
    (chainNames !== undefined &&
      namesNetwork(
        query,
        chain === "all" ? project.chains : [chain],
        chainNames,
      ))
  );
}

/** Which words of a search name a network the page knows, whether or not a
 * project runs there. Worked out once per search. */
function searchNetworkWords(
  terms: readonly string[],
  chainNames: ReadonlyMap<string, string> | undefined,
) {
  return chainNames === undefined || !terms.length
    ? terms.map(() => false)
    : networkWordFlags(terms, [...chainNames.keys()], chainNames);
}

/** The search read word by word, through the project's text or one of its
 * measured pools. */
function matchesWords(
  project: RadarProject,
  deployments: RadarProject["deployments"],
  terms: readonly string[],
  networkWords: readonly boolean[],
  chain: string,
  chainNames: ReadonlyMap<string, string> | undefined,
  poolSearch: PoolSearchIndex,
) {
  const pools = poolSearch.get(project.id) ?? [];
  // The words that name a network this project runs on (in scope).
  let own: boolean[] | undefined;
  return matchSearchTerms(
    terms,
    projectSearchFields(project, deployments),
    networkWords,
    (index) => {
      if (chainNames === undefined) return false;
      own ??= networkWordFlags(
        terms,
        chain === "all" ? project.chains : [chain],
        chainNames,
      );
      return own[index];
    },
    chain === "all" ? pools : pools.filter((entry) => entry.chain === chain),
  );
}

/** `chainNames` (short name to display name) lets the search also find the
 * projects that run on a network; without it only the text of a project matches.
 *
 * `poolSearch` (see pool-search.ts) lets it also find a project by one of its
 * measured pools: a token symbol, a pair, a token address, a pool id or a pool
 * address. Without it nothing about the search changes. */
export function filterProjects(
  projects: RadarProject[],
  filters: Filters,
  chainNames?: ReadonlyMap<string, string>,
  poolSearch?: PoolSearchIndex,
) {
  const query = filters.search.trim().toLowerCase();
  const terms = poolSearch && query ? searchTerms(filters.search) : [];
  const networkWords = searchNetworkWords(terms, chainNames);
  return projects.filter((project) => {
    if (filters.category !== "all" && project.category !== filters.category)
      return false;
    const deployments = scopedDeployments(project, filters.chain);
    if (
      filters.chain !== "all" &&
      !deployments.length &&
      !(
        project.entityType === "platform" &&
        project.chains.includes(filters.chain)
      )
    )
      return false;
    if (
      filters.property === "dynamic" &&
      !deployments.some((d) => d.properties.dynamicFee)
    )
      return false;
    if (
      filters.property === "verified" &&
      !deployments.some((d) => d.verifiedSource)
    )
      return false;
    if (
      filters.property === "upgradeable" &&
      !deployments.some((d) => d.properties.upgradeable)
    )
      return false;
    if (
      filters.property === "custom" &&
      !deployments.some((d) => d.properties.requiresCustomSwapData)
    )
      return false;
    return (
      !query ||
      matchesProjectText(
        project,
        deployments,
        query,
        filters.chain,
        chainNames,
      ) ||
      (poolSearch !== undefined &&
        matchesWords(
          project,
          deployments,
          terms,
          networkWords,
          filters.chain,
          chainNames,
          poolSearch,
        ) !== null)
    );
  });
}

/** The pool a listed project matched through, for the line a row shows; null when
 * the project's own text matched (or nothing did). It repeats the decision of
 * `filterProjects` on a project that function listed, so the two cannot differ. */
export function poolMatchFor(
  project: RadarProject,
  filters: Filters,
  chainNames: ReadonlyMap<string, string> | undefined,
  poolSearch: PoolSearchIndex | undefined,
) {
  const query = filters.search.trim().toLowerCase();
  if (!poolSearch || !query) return null;
  const deployments = scopedDeployments(project, filters.chain);
  if (matchesProjectText(project, deployments, query, filters.chain, chainNames))
    return null;
  const terms = searchTerms(filters.search);
  const match = matchesWords(
    project,
    deployments,
    terms,
    searchNetworkWords(terms, chainNames),
    filters.chain,
    chainNames,
    poolSearch,
  );
  return match?.via === "pool" ? match : null;
}
export function projectComparator(
  key: SortKey,
  direction: "asc" | "desc",
  window: WindowKey,
  poolCount: (project: RadarProject) => number | null = (project) =>
    project.metrics.poolCount,
  /** Edition: the figure a "volume" sort ranks by, when the list shows 7D or
   * 30D volume instead of the project's own window. Absent: the window's. */
  volumeOf: (project: RadarProject) => number | null = (project) =>
    project.metrics.volumeUsd[window],
) {
  const value = (p: RadarProject): number | string | null =>
    key === "name"
      ? p.name.toLowerCase()
      : key === "deployments"
        ? p.deployments.length
        : key === "volume"
          ? volumeOf(p)
          : key === "liquidity"
            ? p.metrics.liquidityUsd
            : poolCount(p);
  return (a: RadarProject, b: RadarProject) => {
    const av = value(a),
      bv = value(b);
    if (av === null && bv === null) return a.name.localeCompare(b.name);
    if (av === null) return 1;
    if (bv === null) return -1;
    const comparison =
      typeof av === "string" && typeof bv === "string"
        ? av.localeCompare(bv)
        : Number(av) - Number(bv);
    return (
      (direction === "asc" ? comparison : -comparison) ||
      a.name.localeCompare(b.name)
    );
  };
}
export function sortProjects(
  projects: RadarProject[],
  key: SortKey,
  direction: "asc" | "desc",
  window: WindowKey,
) {
  return [...projects].sort(projectComparator(key, direction, window));
}
export function money(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value === 0) return "$0";
  if (value < 0.01) return "<$0.01";
  // Round first, then pick the unit, so 999,950 reads "$1.00M", not "$1000.0K".
  if (value >= 1e9 || Number((value / 1e6).toFixed(2)) >= 1000)
    return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6 || Number((value / 1e3).toFixed(1)) >= 1000)
    return `$${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3 || Number(value.toFixed(2)) >= 1000)
    return `$${(value / 1e3).toFixed(1)}K`;
  return `$${value.toFixed(2)}`;
}
export function count(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value)
    ? "—"
    : value.toLocaleString("en-US");
}
export function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
export function safeUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol)
      ? parsed.href
      : undefined;
  } catch {
    return undefined;
  }
}
export function relativeTime(
  value: string | null | undefined,
  now = Date.now(),
) {
  if (!value) return "Unknown";
  // The static edition shows when, not how long ago: its clock is the snapshot's.
  if (STATIC_EDITION) return timeLabel(value) ?? "Unknown";
  const difference = now - new Date(value).getTime();
  if (!Number.isFinite(difference)) return "Unknown";
  if (difference < 60000) return "Just now";
  if (difference < 3600000) return `${Math.floor(difference / 60000)}m ago`;
  if (difference < 86400000) return `${Math.floor(difference / 3600000)}h ago`;
  return `${Math.floor(difference / 86400000)}d ago`;
}
/** `relativeTime` for the middle of a sentence ("updated 3m ago"). A clock time
 * keeps its capitals ("updated 14:03 UTC"). */
export function inlineTime(
  value: string | null | undefined,
  now = Date.now(),
) {
  const text = relativeTime(value, now);
  return STATIC_EDITION ? text : text.toLowerCase();
}
export function readWatchlist(): string[] {
  try {
    const saved = JSON.parse(
      localStorage.getItem("hook-radar-watchlist-v1") || "[]",
    );
    return Array.isArray(saved)
      ? [
          ...new Set(
            saved.filter(
              (v) =>
                typeof v === "string" && /^[a-z0-9][a-z0-9-]{0,99}$/.test(v),
            ),
          ),
        ].slice(0, 2000)
      : [];
  } catch {
    return [];
  }
}
export function csvCell(value: unknown) {
  const text = String(value ?? "");
  const safe =
    typeof value === "string" && /^[\s\u0000-\u001f]*[=+@-]/.test(text)
      ? `'${text}`
      : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** How far past "now" a published timestamp may lie before it is rejected. */
const FUTURE_SKEW_MS = 60_000;

/** The latest time a published timestamp (a census head check, say) may carry.
 * On the live service that is the viewer's clock plus a minute of skew. In the
 * static edition the file is a frozen record that is read long after it was
 * taken, possibly on a device whose clock is wrong, so the visitor's clock is
 * not consulted: the snapshot's own generatedAt is the reference. Without a
 * usable reference the viewer's clock stands in, as on the live service. */
export function futureSkewLimit(
  generatedAt: unknown,
  edition: boolean = STATIC_EDITION,
  now?: number,
): number {
  const published =
    edition && typeof generatedAt === "string"
      ? Date.parse(generatedAt)
      : Number.NaN;
  return (
    (Number.isFinite(published) ? published : (now ?? Date.now())) +
    FUTURE_SKEW_MS
  );
}

/** Validate the fields used by rendering before accepting a network response. */
export function isSnapshot(value: unknown): value is RadarSnapshot {
  return isSnapshotFor(value, STATIC_EDITION);
}

/** `isSnapshot` with the edition flag as an argument, so both builds can be
 * tested from one process. */
export function isSnapshotFor(
  value: unknown,
  edition: boolean,
): value is RadarSnapshot {
  const object = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  const strings = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((item) => typeof item === "string");
  const dashboard =
    object(value) &&
    object(value.presentation) &&
    value.presentation.profile === "dashboard" &&
    value.presentation.version === 1 &&
    value.presentation.projectHistory === "deferred" &&
    value.presentation.poolEvidence === "deferred";
  if (object(value) && value.presentation !== undefined && !dashboard)
    return false;
  if (
    object(value) &&
    value.directory !== undefined &&
    !isDirectoryInfo(value.directory, value.projects)
  )
    return false;
  const metric = (v: unknown) =>
    v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0);
  const volume = (v: unknown) =>
    object(v) && ["h1", "h6", "h24"].every((key) => metric(v[key]));
  const nullableString = (v: unknown) => v === null || typeof v === "string";
  const point = (v: unknown) =>
    object(v) &&
    typeof v.timestamp === "number" &&
    Number.isFinite(v.timestamp) &&
    typeof v.value === "number" &&
    Number.isFinite(v.value) &&
    v.value >= 0;
  const chain = (v: unknown) =>
    object(v) &&
    Number.isSafeInteger(v.id) &&
    Number(v.id) > 0 &&
    typeof v.slug === "string" &&
    /^[a-z0-9][a-z0-9-]{0,99}$/.test(v.slug) &&
    typeof v.name === "string" &&
    v.name.trim().length > 0 &&
    v.name.length <= 200 &&
    typeof v.explorer === "string" &&
    v.explorer.length <= 2048 &&
    Boolean(safeUrl(v.explorer));
  const deployment = (v: unknown) =>
    object(v) &&
    [
      "id",
      "address",
      "chain",
      "name",
      "description",
      "sourceUrl",
      "explorerUrl",
    ].every((key) => typeof v[key] === "string") &&
    typeof v.chainId === "number" &&
    typeof v.verifiedSource === "boolean" &&
    object(v.flags) &&
    Object.values(v.flags).every((flag) => typeof flag === "boolean") &&
    object(v.properties) &&
    [
      "dynamicFee",
      "upgradeable",
      "requiresCustomSwapData",
      "vanillaSwap",
    ].every(
      (key) =>
        typeof (v.properties as Record<string, unknown>)[key] === "boolean",
    ) &&
    typeof v.properties.swapAccess === "string";
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    typeof value.generatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.generatedAt)) ||
    !["live", "partial", "cached", "offline"].includes(String(value.status))
  )
    return false;
  if (
    !Array.isArray(value.projects) ||
    !value.projects.every(
      (p) =>
        object(p) &&
        (p.entityType === undefined || isPublishedPlatformProject(p)) &&
        ["id", "name", "description", "sourceUrl"].every(
          (key) => typeof p[key] === "string",
        ) &&
        categories.includes(p.category as (typeof categories)[number]) &&
        strings(p.chains) &&
        Array.isArray(p.deployments) &&
        p.deployments.every(deployment) &&
        object(p.metrics) &&
        metric(p.metrics.poolCount) &&
        metric(p.metrics.liquidityUsd) &&
        volume(p.metrics.volumeUsd) &&
        ["measured", "partial", "unavailable"].includes(
          String(p.metrics.coverage),
        ) &&
        typeof p.metrics.note === "string" &&
        ((Array.isArray(p.history) &&
          p.history.every(point) &&
          (p.historyPointCount === undefined ||
            p.historyPointCount === p.history.length)) ||
          (dashboard &&
            p.history === undefined &&
            Number.isSafeInteger(p.historyPointCount) &&
            Number(p.historyPointCount) >= 0)),
    )
  )
    return false;
  if (
    value.projects.some(
      (project) =>
        project.poolInventory !== undefined &&
        (!object(project.poolInventory) ||
          !Number.isSafeInteger(project.poolInventory.poolCount) ||
          Number(project.poolInventory.poolCount) < 0 ||
          typeof project.poolInventory.complete !== "boolean" ||
          (project.poolInventory.replacementToken !== undefined &&
            (typeof project.poolInventory.replacementToken !== "string" ||
              !/^[a-f0-9]{64}$/.test(
                project.poolInventory.replacementToken,
              ))) ||
          !object(project.poolInventory.chains) ||
          !Object.values(project.poolInventory.chains).every(
            (amount) => Number.isSafeInteger(amount) && Number(amount) >= 0,
          )),
    )
  )
    return false;
  if (value.inventory !== undefined) {
    const inventory = value.inventory;
    const nonnegative = (amount: unknown) =>
      Number.isSafeInteger(amount) && Number(amount) >= 0;
    const headCheckLimit = futureSkewLimit(value.generatedAt, edition);
    if (
      !object(inventory) ||
      typeof inventory.generatedAt !== "string" ||
      !Number.isFinite(Date.parse(inventory.generatedAt)) ||
      typeof inventory.running !== "boolean" ||
      ![
        inventory.poolCount,
        inventory.hookPoolCount,
        inventory.hookCount,
      ].every(nonnegative) ||
      !Array.isArray(inventory.networks) ||
      !inventory.networks.every(
        (network) =>
          object(network) &&
          ["chain", "name", "manager"].every(
            (key) => typeof network[key] === "string",
          ) &&
          /^0x[\da-fA-F]{40}$/.test(String(network.manager)) &&
          nonnegative(network.chainId) &&
          Number(network.chainId) > 0 &&
          nonnegative(network.startBlock) &&
          Number.isSafeInteger(network.scannedToBlock) &&
          Number(network.scannedToBlock) >= -1 &&
          (network.targetBlock === null || nonnegative(network.targetBlock)) &&
          ["queued", "scanning", "complete", "unavailable", "error"].includes(
            String(network.status),
          ) &&
          [network.poolCount, network.hookPoolCount, network.hookCount].every(
            nonnegative,
          ) &&
          nullableString(network.dataset) &&
          nullableString(network.updatedAt) &&
          (network.headCheckedAt === undefined ||
            network.headCheckedAt === null ||
            (typeof network.headCheckedAt === "string" &&
              Number.isFinite(Date.parse(network.headCheckedAt)) &&
              Date.parse(network.headCheckedAt) > 0 &&
              Date.parse(network.headCheckedAt) <= headCheckLimit)) &&
          nullableString(network.lastError) &&
          (network.cacheWarning === undefined ||
            nullableString(network.cacheWarning)),
      )
    )
      return false;
  }
  if (
    value.marketCoverage !== undefined &&
    !isMarketCoverage(value.marketCoverage)
  )
    return false;
  if (
    !Array.isArray(value.pools) ||
    !value.pools.every(
      (p) =>
        object(p) &&
        ["id", "chain", "name", "address", "url", "source"].every(
          (key) => typeof p[key] === "string",
        ) &&
        nullableString(p.projectId) &&
        nullableString(p.hookAddress) &&
        (p.poolKey === undefined || isPoolKey(p.poolKey, p.hookAddress)) &&
        strings(p.tokens) &&
        (p.liquidityStatus === undefined ||
          ["reported", "inconsistent", "unverified", "unavailable"].includes(
            String(p.liquidityStatus),
          )) &&
        (p.liquidityNote === undefined ||
          (typeof p.liquidityNote === "string" &&
            p.liquidityNote.length <= 500)) &&
        metric(p.liquidityUsd) &&
        volume(p.volumeUsd),
    )
  )
    return false;
  if (
    !Array.isArray(value.events) ||
    !value.events.every(
      (e) =>
        object(e) &&
        ["id", "title", "description", "timestamp"].every(
          (key) => typeof e[key] === "string",
        ) &&
        nullableString(e.projectId) &&
        nullableString(e.url),
    )
  )
    return false;
  if (
    !Array.isArray(value.sources) ||
    !value.sources.every(
      (s) =>
        object(s) &&
        ["id", "name", "url", "note"].every(
          (key) => typeof s[key] === "string",
        ) &&
        nullableString(s.updatedAt) &&
        ["live", "cached", "unavailable"].includes(String(s.status)),
    )
  )
    return false;
  if (
    !Array.isArray(value.history) ||
    !value.history.every(point) ||
    !Array.isArray(value.chains) ||
    !value.chains.every(chain)
  )
    return false;
  return (
    object(value.summary) &&
    volume(value.summary.volumeUsd) &&
    metric(value.summary.liquidityUsd) &&
    object(value.coverage) &&
    typeof value.coverage.title === "string" &&
    typeof value.coverage.description === "string" &&
    strings(value.coverage.measuredChains) &&
    ["registryDeployments", "attributedPools", "totalObservedPools"].every(
      (key) =>
        typeof (value.coverage as Record<string, unknown>)[key] === "number",
    )
  );
}
