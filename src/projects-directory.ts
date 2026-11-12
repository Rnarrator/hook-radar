/** The Projects page of the Auto Snapshot edition: who builds with v4 hooks.
 *
 * Pure rules, no React. The page asks the same chain model as the Networks page
 * (buildChains) for its rows and keeps the ones that have a public identity the
 * page can check. Nothing here is a second source of numbers: every figure is a
 * row's own, so a card, the Networks list, the Launchpads list and the project
 * drawer agree.
 *
 * WHAT MAKES A ROW A LISTED PROJECT. Any one of these, and nothing else:
 *   - it is a launch platform record (a reviewed launchpad, or the published
 *     platform guide), which has no contract of its own to be confused with;
 *   - its own listing carries an https website or documentation link;
 *   - it has original artwork in the reviewed artwork tables.
 * A website or artwork from the reviewed family table says "this is the project
 * of that name": that table matches a family by the name of its deployments, so
 * it is not proof that a contract belongs to the project, and nothing on the page
 * says "verified", "official project" or "by". A name, a description that
 * mentions a project, or a platform that integrates a hook never lists anything:
 * this file adds no rule of its own on a name and keeps no list of projects.
 * Registry listings and shared names do not establish common ownership or
 * endorsement.
 *
 * The edition's helpers are passed `true` explicitly, so a test run in Node
 * (where the build flag is off) reads exactly what the edition's page prints. */
import type { ChainProtocol, ChainRole } from "./chains.ts";
import { chainRoles, launchpadProfile } from "./chains.ts";
import { catalogHookCount, sortChainCatalog } from "./chain-catalog.ts";
import { lowerBoundMark, rowScopeNotes } from "./edition-platform-copy.ts";
import { unmeasuredCardNote } from "./edition.ts";
import { foldSearchText, searchTerms } from "./pool-search.ts";
import { getProtocolArtwork } from "./protocol-logos.ts";
import { dailyThrough, youngText } from "./daily.ts";
import type { DailyLens, DailySum } from "./daily.ts";
import type { ProjectsSort } from "./navigation.ts";

/** Why a row is listed. */
export type ProjectReason =
  "launch-platform" | "official-link" | "verified-artwork";

/** The most cards the page draws. The rule keeps the list to a few dozen; a list
 * past this asks the reader to narrow it instead of drawing every card. */
export const PROJECTS_RENDER_MAX = 150;

const httpsLink = (value: string | null | undefined): boolean => {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

/** Whether a row is a listed project, and the first reason it is. The row's own
 * project is read, never the row's `website`, which is a fallback the Networks
 * page fills in for Uniswap's own families. */
export function projectIdentity(
  row: Pick<ChainProtocol, "project">,
): ProjectReason | null {
  const { project } = row;
  if (project.entityType === "platform") return "launch-platform";
  if (httpsLink(project.website) || httpsLink(project.docs))
    return "official-link";
  if (getProtocolArtwork(project) !== null) return "verified-artwork";
  return null;
}

/** The listed projects among a model's rows, in the order they came in. */
export function listProjects(
  rows: readonly ChainProtocol[],
): ChainProtocol[] {
  return rows.filter((row) => projectIdentity(row) !== null);
}

/** How many named rows the rule leaves to Discover. */
export function unlistedCount(rows: readonly ChainProtocol[]): number {
  return rows.length - listProjects(rows).length;
}

/* ── Names, labels and networks ────────────────────────────────────────── */

const roleLabels = new Map<ChainRole, string>(
  chainRoles.map((role) => [role.id, role.label]),
);
const roleOrder = new Map<ChainRole, number>(
  chainRoles.map((role, index) => [role.id, index]),
);

export const roleLabel = (role: ChainRole): string =>
  roleLabels.get(role) ?? role;

/** A row's use-case labels in the page's fixed order (reviewed roles first). */
export function projectRoles(
  row: Pick<ChainProtocol, "roles">,
): { id: ChainRole; label: string }[] {
  return [...row.roles]
    .sort((a, b) => (roleOrder.get(a) ?? 99) - (roleOrder.get(b) ?? 99))
    .map((id) => ({ id, label: roleLabel(id) }));
}

const statusLabels = {
  live: "Live",
  restricted: "Restricted",
  deprecated: "Deprecated",
  planned: "Planned",
  unverified: "Status unverified",
} as const;

/** The reviewed operating status of a launch platform, as the Launchpads list
 * words it. A hook project has none: nothing is invented for it. */
export function projectStatus(
  row: Pick<
    ChainProtocol,
    "project" | "roles" | "roleEvidence" | "website" | "docs"
  >,
): { status: keyof typeof statusLabels; label: string } | null {
  if (row.project.entityType !== "platform") return null;
  const profile = launchpadProfile(row);
  return profile
    ? { status: profile.status, label: statusLabels[profile.status] }
    : null;
}

/** A name with only its letters and digits, in one case: two names that differ
 * in spaces, dots or capitals are the same name. */
function squash(text: string): string {
  let out = "";
  for (const character of foldSearchText(text))
    if (
      character.toLowerCase() !== character.toUpperCase() ||
      (character >= "0" && character <= "9")
    )
      out += character;
  return out;
}

/** The brand of the artwork a hook project carries, when it is not the name the
 * card shows ("FablesRampETH" carries the Fables artwork). Shown quietly above
 * the name: no "by", no "official". Null for a platform, a row without artwork
 * and a row whose name is the brand. */
export function projectBrand(
  row: Pick<ChainProtocol, "project">,
): string | null {
  if (row.project.entityType === "platform") return null;
  const artwork = getProtocolArtwork(row.project);
  if (!artwork) return null;
  return squash(artwork.protocol) === squash(row.project.name)
    ? null
    : artwork.protocol;
}

export interface NetworkLine {
  /** Display names to print, the chosen network first. */
  shown: string[];
  /** How many more there are. */
  more: number;
  /** Every network, for the tooltip. */
  all: string[];
}

/** The networks of a card: up to `limit` names, then a count. */
export function networkLine(
  row: Pick<ChainProtocol, "chainSlugs">,
  names: ReadonlyMap<string, string>,
  chosen = "all",
  limit = 3,
): NetworkLine {
  const slugs = [...row.chainSlugs];
  const first = slugs.indexOf(chosen);
  if (first > 0) slugs.unshift(...slugs.splice(first, 1));
  const all = slugs.map((slug) => names.get(slug) ?? slug);
  return {
    shown: all.slice(0, limit),
    more: Math.max(0, all.length - limit),
    all,
  };
}

/** Hooks listed under a project, or null when the listing carries identity only. */
export const knownHooks = (row: ChainProtocol): number | null =>
  catalogHookCount(row);

/* ── Figures ───────────────────────────────────────────────────────────── */

export interface ProjectFigures {
  /** No pool of the project is in the snapshot: nothing was measured. */
  unmeasured: boolean;
  pools: number | null;
  /** "≥" while the pool count is a lower bound. */
  poolsMark: "≥" | "";
  volume: number | null;
  volumeMark: "≥" | "";
  reserves: number | null;
  reservesMark: "≥" | "";
}

/** A row's three readouts, as the Networks list prints them. A missing figure is
 * null (a dash), never zero; a sum over pools the snapshot may not hold all of
 * carries the "at least" mark. */
export function projectFigures(row: ChainProtocol): ProjectFigures {
  return {
    unmeasured:
      row.poolCount === null &&
      row.volumeUsd === null &&
      row.liquidityUsd === null,
    pools: row.poolCount,
    poolsMark: row.poolCount !== null && !row.poolCountExact ? "≥" : "",
    volume: row.volumeUsd,
    volumeMark: lowerBoundMark(
      row.poolCount,
      row.poolCountExact,
      row.volumeUsd,
      true,
    ),
    reserves: row.liquidityUsd,
    reservesMark: lowerBoundMark(
      row.poolCount,
      row.poolCountExact,
      row.liquidityUsd,
      true,
    ),
  };
}

/** What a card with no figure says. `network` is the display name of the
 * network the list is cut to, when it is. */
export const unmeasuredNote = (network?: string | null): string =>
  unmeasuredCardNote(0, network);

/* ── Notes ─────────────────────────────────────────────────────────────── */

/** Names that two or more rows of the model share cannot tell a listed project
 * from an unlisted hook of the same name, so only a name held by exactly one row
 * of `all` counts as the name of a listed project. */
export function listedNames(
  listed: readonly ChainProtocol[],
  all: readonly ChainProtocol[],
): Set<string> {
  const held = new Map<string, number>();
  for (const row of all)
    held.set(row.project.name, (held.get(row.project.name) ?? 0) + 1);
  const names = new Set<string>();
  for (const row of listed)
    if (held.get(row.project.name) === 1) names.add(row.project.name);
  return names;
}

/** The sentence under a card whose hook another row publishes too. It names only
 * projects this page lists and counts the rest, which are in Discover. */
export function sharedPoolNote(
  row: Pick<ChainProtocol, "sharedHookWith">,
  listed: ReadonlySet<string>,
): string | null {
  const others = row.sharedHookWith ?? [];
  if (others.length === 0) return null;
  const named = others.filter((name) => listed.has(name));
  const rest = others.length - named.length;
  const parts = [...named];
  if (rest > 0)
    parts.push(
      `${rest} other hook ${rest === 1 ? "entry" : "entries"} in Discover`,
    );
  const list =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return `Shares a hook with ${list}. Overlapping pools count in each row and are never added together.`;
}

/** Every note under a card: a scope note of its figures (Frontier's), then the
 * shared-hook sentence. */
export function projectNotes(
  row: ChainProtocol,
  listed: ReadonlySet<string>,
): string[] {
  const notes = rowScopeNotes({ project: row.project }, true);
  const shared = sharedPoolNote(row, listed);
  if (shared) notes.push(shared);
  return notes;
}

/* ── Search, filters and order ─────────────────────────────────────────── */

/** Text as the search compares it: width, case and spaces folded as Discover
 * does, and the accents taken off (a typed "cafe" finds "Café"). */
function fold(text: string): string {
  let plain = "";
  for (const character of text.normalize("NFKD")) {
    const point = character.codePointAt(0) ?? 0;
    // Combining marks are the accents of the letters before them.
    if (point < 0x300 || point > 0x36f) plain += character;
  }
  return foldSearchText(plain);
}

/** What the search reads for a row: its name, description, artwork brand, use
 * case labels and network names. A pool, a token or an address is a Discover
 * search; it is not read here. */
function searchText(
  row: ChainProtocol,
  names: ReadonlyMap<string, string>,
): string {
  return fold(
    [
      row.project.name,
      row.project.description,
      projectBrand(row) ?? "",
      ...projectRoles(row).map((role) => role.label),
      ...row.chainSlugs.map((slug) => names.get(slug) ?? slug),
    ].join(" "),
  );
}

/** The rows whose text holds every word of the query. */
export function searchProjects(
  rows: readonly ChainProtocol[],
  query: string,
  names: ReadonlyMap<string, string>,
): ChainProtocol[] {
  const terms = searchTerms(fold(query.slice(0, 300)));
  if (terms.length === 0) return [...rows];
  return rows.filter((row) => {
    const text = searchText(row, names);
    return terms.every((term) => text.includes(term));
  });
}

export function filterByUse(
  rows: readonly ChainProtocol[],
  use: ChainRole | "all",
): ChainProtocol[] {
  return use === "all" ? [...rows] : rows.filter((row) => row.roles.includes(use));
}

/** The list the page shows: search, then use case, then the order. */
export function visibleProjects(
  rows: readonly ChainProtocol[],
  {
    query,
    use,
    sort,
    names,
  }: {
    query: string;
    use: ChainRole | "all";
    sort: ProjectsSort;
    names: ReadonlyMap<string, string>;
  },
): ChainProtocol[] {
  return sortChainCatalog(
    filterByUse(searchProjects(rows, query, names), use),
    sort,
  );
}

export interface UseCaseOption {
  id: ChainRole;
  label: string;
  count: number;
}

/** The use cases the listed rows hold, in the page's order, split into the
 * reviewed roles and the directory use cases. Counts are over `rows` (the list
 * of the chosen network, before search); a use case no row holds is left out. */
export function useCaseOptions(rows: readonly ChainProtocol[]): {
  reviewed: UseCaseOption[];
  cases: UseCaseOption[];
} {
  const counts = new Map<ChainRole, number>();
  for (const row of rows)
    for (const role of new Set(row.roles))
      counts.set(role, (counts.get(role) ?? 0) + 1);
  const options = chainRoles
    .filter((role) => (counts.get(role.id) ?? 0) > 0)
    .map((role) => ({
      id: role.id,
      label: role.label,
      count: counts.get(role.id)!,
    }));
  return {
    reviewed: options.filter(
      (option) => option.id === "launchpads" || option.id === "dexes",
    ),
    cases: options.filter(
      (option) => option.id !== "launchpads" && option.id !== "dexes",
    ),
  };
}

export interface NetworkOption {
  slug: string;
  name: string;
  count: number;
}

/** The networks the listed rows run on, the busiest first. */
export function networkOptions(
  rows: readonly ChainProtocol[],
  names: ReadonlyMap<string, string>,
): NetworkOption[] {
  const counts = new Map<string, number>();
  for (const row of rows)
    for (const slug of new Set(row.chainSlugs))
      counts.set(slug, (counts.get(slug) ?? 0) + 1);
  return [...counts]
    .map(([slug, count]) => ({ slug, name: names.get(slug) ?? slug, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/* ── The line above the list ───────────────────────────────────────────── */

const projectNoun = (count: number) => (count === 1 ? "project" : "projects");

/** "71 projects on 20 networks · 42 with tracked pools", or while the list is
 * cut, "12 of 71 projects · Launchpads · Base". Counts only; no total of money. */
export function projectsMeta({
  shown,
  total,
  networks,
  withPools,
  use,
  network,
  filtered,
}: {
  /** Rows after search, use case and network. */
  shown: number;
  /** Rows of the whole list, whatever the filters. */
  total: number;
  /** Networks the whole list runs on. */
  networks: number;
  /** Rows of the whole list with a pool in the snapshot. */
  withPools: number;
  use: string | null;
  network: string | null;
  filtered: boolean;
}): string {
  if (!filtered)
    return `${total.toLocaleString("en-US")} ${projectNoun(total)} on ${networks.toLocaleString("en-US")} ${networks === 1 ? "network" : "networks"} · ${withPools.toLocaleString("en-US")} with tracked pools`;
  return [
    `${shown.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} ${projectNoun(total)}`,
    use,
    network,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Rows of a list with at least one pool in the snapshot. */
export const withTrackedPools = (rows: readonly ChainProtocol[]): number =>
  rows.filter((row) => row.poolCount !== null && row.poolCount > 0).length;

/* ── The figure of a 7D or 30D card ────────────────────────────────────── */

/** The line under a card's figures while 7D or 30D is chosen: the day the
 * figures run to, or "since launch" when every pool behind the sum is younger
 * than the span. Null while no figure is shown. The same words DailyAmount
 * prints under a figure; here they sit on one reserved line of the card. */
export function dailyFigureNote(
  sum: Pick<DailySum, "usd" | "youngDays"> | null | undefined,
  lens: Pick<DailyLens, "throughMs"> | null,
): string | null {
  if (!lens || !sum || sum.usd === null) return null;
  return sum.youngDays !== null
    ? youngText(sum.youngDays)
    : `through ${dailyThrough(lens)}`;
}
