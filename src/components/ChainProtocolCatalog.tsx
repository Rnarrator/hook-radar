import { useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  MetricFreshness,
  RadarSnapshot,
  WindowKey,
} from "../../shared/types";
import type {
  ChainExplorerResult,
  ChainNetwork,
  ChainProtocol,
  ChainRole,
  LaunchpadHookModel,
  LaunchpadProfile,
  LaunchpadStatus,
} from "../chains";
import { launchpadProfile } from "../chains";
import {
  catalogHookCount,
  pinChainProtocol,
  chainCatalogPage,
  sortChainCatalog,
  type ChainCatalogSort,
} from "../chain-catalog";
import { count, money, windows } from "../model";
import { formatMoneyExact } from "../charts/format";
import { STATIC_EDITION, fullTimeLabel, timeLabel, utcDate } from "../edition";
import { noPricedPoolNote, reviewNotesHeading } from "../edition-platform-copy";
import {
  ArrowRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Search,
  X,
} from "./Icons";
import { Empty, External } from "./Primitives";
import { ProtocolLogo } from "./ProtocolLogo";
import "./chain-protocol-catalog.css";

interface Props {
  result: ChainExplorerResult;
  chain: string;
  windowKey: WindowKey;
  now: number;
  search: string;
  setSearch: (search: string) => void;
  role: ChainRole | "all";
  setRole: (role: ChainRole | "all") => void;
  openProject: (id: string, tab?: "deployments" | "pools") => void;
  /** Absent where the page has no activity view (the static edition). */
  inspectActivity?: (id: string, chain: string) => void;
  browseHooks: (chain: string) => void;
  chooseNetwork: (chain: string) => void;
  registrySource?: RadarSnapshot["sources"][number];
  updating?: boolean;
  disabled?: boolean;
}

/** Reviewed product roles are source-backed; the rest mirror the directory's
 * single use-case classification. Both stay filters, never rankings. */
const reviewedRoles: readonly ChainRole[] = ["launchpads", "dexes"];

/** Pinned to the top of the Launchpads list, and labelled as such. */
const PINNED_LAUNCHPAD = "frontier";

/** Why a reviewed platform's volume is, or is not, a number. */
function attributionNote(row: ChainProtocol): string | null {
  const attribution = row.attribution;
  if (!attribution)
    return row.project.entityType === "platform"
      ? "No hook contract is published for it, so nothing is counted here."
      : null;
  const hooks = (count: number) => `${count} published ${count === 1 ? "hook" : "hooks"}`;
  if (attribution.mappedHooks > 0)
    return row.volumeUsd !== null
      ? `Counts the pools of its own ${hooks(attribution.mappedHooks)}: ${attribution.hooksWithPools} with current prices.`
      : attribution.hooksWithPools > 0
        ? STATIC_EDITION
          ? `Pools on its ${hooks(attribution.mappedHooks)} have no price within five minutes of the snapshot.`
          : `Pools on its ${hooks(attribution.mappedHooks)} have no price under five minutes old right now.`
        : noPricedPoolNote(hooks(attribution.mappedHooks));
  if (attribution.sharedProtocolId)
    return `Launches run on shared hooks, so their volume is counted under ${attribution.sharedProtocolId === "doppler" ? "Doppler" : "the shared protocol"}.`;
  if (attribution.perLaunchHooks)
    return "It deploys a separate hook for every launch, so none can be listed and its volume cannot be attributed.";
  return "No hook contract is published for it, so its volume cannot be attributed.";
}

const statusLabels: Record<LaunchpadStatus, string> = {
  live: "Live",
  restricted: "Restricted",
  deprecated: "Deprecated",
  planned: "Planned",
  unverified: "Status unverified",
};

/** A review date as a short, locale-formatted day; the stored value is a UTC date. */
function reviewedOn(value: string): string {
  const time = Date.parse(value);
  return Number.isFinite(time)
    ? new Date(time).toLocaleDateString(undefined, {
        dateStyle: "medium",
        timeZone: "UTC",
      })
    : value;
}

/** A reviewed status finding as written. In the edition, one that quotes the
 * live index's pool count is headed with the day it was reviewed. */
function statusNoteText(profile: LaunchpadProfile): string {
  const heading = reviewNotesHeading(profile.statusNote, profile.reviewedAt);
  return heading
    ? `${heading}: ${profile.statusNote}`
    : (profile.statusNote ?? "");
}

/** The "Operating status" line of a reviewed platform's sources. */
function reviewedStatusText(profile: LaunchpadProfile): string {
  const label = statusLabels[profile.status];
  // The heading carries the review day, so "Reviewed …" is not said twice.
  if (reviewNotesHeading(profile.statusNote, profile.reviewedAt))
    return `${label} · ${statusNoteText(profile)}`;
  return `${label}${profile.statusNote ? ` · ${profile.statusNote}` : ""}${profile.reviewedAt ? ` Reviewed ${reviewedOn(profile.reviewedAt)}.` : ""}`;
}

const hookModelLabels: Record<LaunchpadHookModel, string> = {
  "own-hooks": "Its own listed hooks",
  "shared-hooks": "Shared hooks",
  "configurable-hooks": "Configurable hook logic",
  "hookless-pools": "Some launches use hookless pools",
};

function exactDate(value: string | null | undefined) {
  // The edition states every time in UTC, as the dates beside it do.
  if (STATIC_EDITION)
    return fullTimeLabel(value) ?? "Measurement time unavailable";
  return value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
        timeZoneName: "short",
      })
    : "Measurement time unavailable";
}

function age(value: string | null | undefined, now: number) {
  const stamp = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(stamp)) return "time unavailable";
  if (STATIC_EDITION) return timeLabel(stamp) ?? "time unavailable";
  const elapsed = Math.max(0, now - stamp);
  if (elapsed < 60_000) return "just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return `${Math.floor(elapsed / 86_400_000)}d ago`;
}

/** A network no project lists in the snapshot (edition): what the snapshot
 * holds there, which is nothing, and what the census counted, each with its own
 * date. The census count is the network's own row and is left out when the
 * snapshot has none; it is never read as zero. Those contracts are not in the
 * snapshot, so the sentence does not send the reader to look for them. */
function emptyNetworkNote(network: ChainNetwork | null, now: number): string {
  const lead = `No project in the ${utcDate(now)} snapshot lists or measures a hook ${network ? "on this network" : "here"}.`;
  if (!network?.inventory) return lead;
  const census = network.inventory;
  if (!Number.isFinite(census.hookCount) || census.hookCount < 0) return lead;
  const counted = census.updatedAt ? Date.parse(census.updatedAt) : NaN;
  const whose = Number.isFinite(counted)
    ? `The census (${utcDate(counted)})`
    : "The census";
  if (census.hookCount === 0)
    return `${lead} ${whose} counts no hook contracts here.`;
  const sum = `${network.caughtUp ? "" : "at least "}${count(census.hookCount)} hook ${census.hookCount === 1 ? "contract" : "contracts"}`;
  return `${lead} ${whose} counts ${sum} here; ${census.hookCount === 1 ? "its address is" : "their addresses are"} not part of this snapshot.`;
}

function exactMoney(value: number | null) {
  if (value !== null && STATIC_EDITION) return formatMoneyExact(value);
  return value === null
    ? "No current measurement available"
    : new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: "USD",
        maximumSignificantDigits: 17,
      }).format(value);
}

function Measurement({
  freshness,
  now,
  label,
}: {
  freshness: MetricFreshness;
  now: number;
  label: string;
}) {
  const excluded = freshness.stalePools + freshness.unknownPools;
  const stamp = freshness.currentPools
    ? freshness.oldestAt
    : freshness.latestObservedAt;
  return (
    <div className="chains-measurement">
      <span className="chains-measurement-label">{label}</span>
      <span>
        {freshness.currentPools
          ? `${count(freshness.currentPools)} current ${freshness.currentPools === 1 ? "pool" : "pools"}`
          : freshness.stalePools
            ? "Measurements expired"
            : freshness.unknownPools
              ? "Freshness unavailable"
              : "No measurements available"}
      </span>
      {stamp && (
        <time dateTime={stamp} title={exactDate(stamp)}>
          {freshness.currentPools ? "Oldest current" : "Last measurement"}:{" "}
          {exactDate(stamp)}
          {/* The edition's full time is already UTC: no second form beside it. */}
          {!STATIC_EDITION && (
            <>
              {" "}
              <span>({age(stamp, now)})</span>
            </>
          )}
        </time>
      )}
      {excluded > 0 && (
        <span className="chains-measurement-excluded">
          {count(excluded)} {excluded === 1 ? "measurement" : "measurements"}{" "}
          excluded from totals
        </span>
      )}
    </div>
  );
}

function RoleRail({
  result,
  role,
  setRole,
  disabled,
}: {
  result: ChainExplorerResult;
  role: ChainRole | "all";
  setRole: (role: ChainRole | "all") => void;
  disabled: boolean;
}) {
  const id = useId();
  const strip = useRef<HTMLDivElement>(null);
  // On phones the rail scrolls sideways: reveal the pressed role inside the
  // strip only, never by scrolling the page.
  useEffect(() => {
    const element = strip.current;
    if (!element || element.scrollWidth <= element.clientWidth) return;
    const pressed = element.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!pressed) return;
    const offset =
      pressed.getBoundingClientRect().left -
      element.getBoundingClientRect().left;
    if (offset < 0 || offset + pressed.offsetWidth > element.clientWidth)
      element.scrollLeft += offset - 16;
  }, [role]);
  const visible = result.roles.filter(
    (item): item is { id: ChainRole; label: string; count: number } =>
      item.id !== "all" && (item.count > 0 || item.id === role),
  );
  const byCount = (
    a: { count: number; label: string },
    b: { count: number; label: string },
  ) => b.count - a.count || a.label.localeCompare(b.label);
  const reviewed = visible
    .filter((item) => reviewedRoles.includes(item.id))
    .sort(byCount);
  const useCases = visible
    .filter((item) => !reviewedRoles.includes(item.id))
    .sort(byCount);
  const largest = Math.max(1, ...visible.map((item) => item.count));
  const item = (entry: { id: ChainRole; label: string; count: number }) => (
    <button
      key={entry.id}
      type="button"
      className="chain-role-bar"
      data-role={entry.id}
      aria-pressed={role === entry.id}
      aria-label={`Explore ${entry.label}: ${count(entry.count)} ${entry.count === 1 ? "project" : "projects"}`}
      disabled={disabled}
      onClick={() => setRole(entry.id)}
    >
      <span className="chain-role-label">{entry.label}</span>
      <span className="chain-role-count">{count(entry.count)}</span>
      <span className="chain-role-bar-track" aria-hidden="true">
        <span style={{ width: `${(entry.count / largest) * 100}%` }} />
      </span>
    </button>
  );
  return (
    <section className="chain-catalog-rail" aria-labelledby={`${id}-title`}>
      <p className="chain-rail-kicker">Filter by role</p>
      <h3 id={`${id}-title`}>What’s being built</h3>
      {visible.length === 0 && result.totalProtocols === 0 ? (
        <div className="chain-chart-empty">
          <strong>No classified projects yet</strong>
          <p>Use cases will appear when projects are listed on this network.</p>
        </div>
      ) : (
        <div
          ref={strip}
          className="chain-catalog-role-strip chain-role-chart"
          role="group"
          aria-label="Browse protocol types"
        >
          <button
            type="button"
            className="chain-role-bar chain-role-all"
            aria-pressed={role === "all"}
            aria-label="View all use cases"
            disabled={disabled}
            onClick={() => setRole("all")}
          >
            <span className="chain-role-label">All use cases</span>
            <span className="chain-role-count">
              {count(result.totalProtocols)}
            </span>
          </button>
          {reviewed.length > 0 && (
            <div
              className="chain-role-group"
              role="group"
              aria-labelledby={`${id}-reviewed`}
            >
              <span className="chain-role-group-label" id={`${id}-reviewed`}>
                Reviewed roles
              </span>
              {reviewed.map(item)}
            </div>
          )}
          {useCases.length > 0 && (
            <div
              className="chain-role-group"
              role="group"
              aria-labelledby={`${id}-cases`}
            >
              <span className="chain-role-group-label" id={`${id}-cases`}>
                Directory use cases
              </span>
              {useCases.map(item)}
            </div>
          )}
        </div>
      )}
      <p className="chain-rail-note">
        Counts cover every listed project in this network scope, before search.
        A project can hold more than one role.
      </p>
    </section>
  );
}

function LaunchpadBuiltOn({
  row,
  profile,
  openProject,
  disabled,
}: {
  row: ChainProtocol;
  profile: LaunchpadProfile;
  openProject: Props["openProject"];
  disabled: boolean;
}) {
  const platform = row.project.entityType === "platform";
  const hooks = catalogHookCount(row);
  return (
    <div className="chain-launchpad-builton">
      <span className="chain-launchpad-label">Built on</span>
      <ol>
        {profile.builtOn.map((item) => (
          <li key={item.name}>
            {item.projectId ? (
              <button
                className="chain-builton-node"
                onClick={() => openProject(item.projectId!)}
                disabled={disabled}
              >
                {item.name}
              </button>
            ) : item.sourceUrl ? (
              <External href={item.sourceUrl}>{item.name}</External>
            ) : (
              <span className="chain-builton-node static">{item.name}</span>
            )}
          </li>
        ))}
        <li>
          <span className="chain-builton-node static">Uniswap v4</span>
        </li>
        {platform ? (
          <li>
            <span className="chain-builton-node pending">
              {profile.hookSummary || "Hook attribution not established"}
            </span>
          </li>
        ) : hooks === 0 ? (
          <li>
            <span className="chain-builton-node pending">
              No hooks listed under {row.project.name}
            </span>
          </li>
        ) : (
          <>
            <li>
              <button
                className="chain-builton-node link"
                aria-label={`View ${row.project.name} hooks`}
                title={`Hooks listed under ${row.project.name}`}
                onClick={() => openProject(row.project.id, "deployments")}
                disabled={disabled}
              >
                Hooks
              </button>
            </li>
            <li>
              <button
                className="chain-builton-node link"
                aria-label={`View ${row.project.name} pools`}
                title={`Pools using hooks listed under ${row.project.name}`}
                onClick={() => openProject(row.project.id, "pools")}
                disabled={disabled}
              >
                Pools
              </button>
            </li>
          </>
        )}
      </ol>
    </div>
  );
}

export function ChainProtocolCatalog({
  result,
  chain,
  windowKey,
  now,
  search,
  setSearch,
  role,
  setRole,
  openProject,
  inspectActivity,
  browseHooks,
  chooseNetwork,
  registrySource,
  updating = false,
  disabled = false,
}: Props) {
  const searchId = useId();
  const searchInput = useRef<HTMLInputElement>(null);
  const catalogHeading = useRef<HTMLHeadingElement>(null);
  const [sort, setSort] = useState<ChainCatalogSort>("volume");
  const [pageIndex, setPageIndex] = useState(0);
  useEffect(() => setPageIndex(0), [chain, search, role, sort]);
  const sorted = useMemo(() => {
    const ordered = sortChainCatalog(result.protocols, sort);
    if (role !== "launchpads") return ordered;
    // Frontier is pinned first in the Launchpads list whatever the sort; every
    // other row keeps the chosen order, and the row says it is pinned.
    return pinChainProtocol(ordered, PINNED_LAUNCHPAD);
  }, [result.protocols, sort, role]);
  useEffect(() => {
    setPageIndex((current) => chainCatalogPage(sorted.length, current).page);
  }, [sorted.length]);
  const networkNames = useMemo(
    () => new Map(result.networks.map((item) => [item.slug, item.name])),
    [result.networks],
  );
  const paging = chainCatalogPage(sorted.length, pageIndex);
  const shown = sorted.slice(paging.start, paging.end);
  const network = result.selectedNetwork;
  const launchpadMode = role === "launchpads";
  const hasFilters = search.trim().length > 0 || role !== "all";
  const roleName = (value: string) =>
    result.roles.find((item) => item.id === value)?.label || value;
  const resetFilters = () => {
    setSearch("");
    setRole("all");
    searchInput.current?.focus();
  };
  const browseOtherNetworks = () => {
    setSearch("");
    setRole("all");
    chooseNetwork("all");
  };
  const changePage = (next: number) => {
    setPageIndex(next);
    catalogHeading.current?.focus({ preventScroll: true });
    catalogHeading.current?.scrollIntoView({
      block: "start",
      behavior: "instant",
    });
  };
  if (network?.deploymentSupport && result.totalProtocols === 0) return null;
  const metricLabels = [
    `Known hooks${network ? ` on ${network.name}` : ""}`,
    // The edition counts the pools measured in the snapshot, not an index.
    STATIC_EDITION ? "Pools in snapshot" : "Pools using hooks",
    `Tracked ${windows[windowKey]} volume`,
    "Reported reserves",
  ];
  return (
    <section
      id="chains-projects"
      className={`chains-protocols chain-catalog${launchpadMode ? " is-launchpads" : ""}`}
      aria-labelledby="chains-protocols-title"
      aria-busy={updating}
    >
      <div className="chains-section-heading chain-catalog-heading">
        <div>
          <p className="chains-section-kicker">
            {launchpadMode
              ? `Launch platforms · ${network ? network.name : "All networks"}`
              : "Protocol directory"}
          </p>
          <h2 id="chains-protocols-title" ref={catalogHeading} tabIndex={-1}>
            {launchpadMode ? "Launchpads" : "Projects & protocols"}{" "}
            <span>{count(result.filteredProtocols)}</span>
          </h2>
          <p>
            {launchpadMode
              ? `Token launch platforms and infrastructure using v4${network ? ` on ${network.name}` : ""}.`
              : network?.deploymentSupport
                ? `Published hook listings for ${network.name}.`
                : network
                  ? `Hooks and protocols on ${network.name}.`
                  : "Explore the projects building with v4."}
          </p>
        </div>
        {!network && (
          <button
            className="chains-text-button chain-catalog-browse"
            onClick={() => browseHooks(chain)}
            disabled={disabled}
          >
            Browse all hooks <ArrowRight size={14} />
          </button>
        )}
      </div>
      <div className="chain-catalog-layout">
        <RoleRail
          result={result}
          role={role}
          setRole={setRole}
          disabled={disabled}
        />
        <div className="chain-catalog-main">
          <div className="chains-catalog-controls">
            <div className="chains-search">
              <Search size={16} />
              <label className="sr-only" htmlFor={searchId}>
                Find a protocol
              </label>
              <input
                id={searchId}
                ref={searchInput}
                aria-label="Find a protocol"
                value={search}
                maxLength={300}
                placeholder="Search projects, hooks or addresses"
                onChange={(event) =>
                  setSearch(
                    event.target.value
                      .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
                      .slice(0, 300),
                  )
                }
                disabled={disabled}
              />
              {search && (
                <button
                  aria-label="Clear protocol search"
                  onClick={() => {
                    setSearch("");
                    searchInput.current?.focus();
                  }}
                  disabled={disabled}
                >
                  <X size={16} />
                </button>
              )}
            </div>
            <label className="select-control chains-role-select">
              <span className="sr-only">Protocol type</span>
              <select
                value={role}
                onChange={(event) =>
                  setRole(event.target.value as ChainRole | "all")
                }
                disabled={disabled}
              >
                {result.roles.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.label} ({count(item.count)})
                  </option>
                ))}
              </select>
              <ChevronDown size={14} />
            </label>
            <label className="select-control chain-catalog-sort">
              <span className="sr-only">Sort projects</span>
              <select
                value={sort}
                onChange={(event) =>
                  setSort(event.target.value as ChainCatalogSort)
                }
                disabled={disabled}
              >
                <option value="volume">Tracked volume: high to low</option>
                <option value="reserves">Reserves: high to low</option>
                <option value="hooks">Most known hooks</option>
                <option value="pools">Most hook pools</option>
                <option value="name">Name: A–Z</option>
              </select>
              <ChevronDown size={14} />
            </label>
          </div>
          <div className="chains-catalog-meta">
            <p
              className="chains-filter-results"
              role="status"
              aria-live="polite"
            >
              {updating
                ? "Updating results…"
                : `${count(result.filteredProtocols)} of ${count(result.totalProtocols)} listed ${result.totalProtocols === 1 ? "project" : "projects"}${network ? ` on ${network.name}` : " across all networks"}${role !== "all" ? ` · ${roleName(role)}` : ""}`}
            </p>
            {hasFilters && (
              <button
                className="chains-clear"
                onClick={resetFilters}
                disabled={disabled}
              >
                Clear filters <X size={13} />
              </button>
            )}
          </div>
          {shown.length ? (
            <div className="chains-protocol-list">
              <div className="chains-protocol-columns" aria-hidden="true">
                <span>{launchpadMode ? "Launchpad" : "Project"}</span>
                <span>
                  {metricLabels.map((label) => (
                    <span key={label}>{label}</span>
                  ))}
                </span>
              </div>
              {shown.map((row) => {
                const profile = launchpadMode ? launchpadProfile(row) : null;
                const platform = row.project.entityType === "platform";
                const networksShown =
                  profile || chain === "all" ? row.chainSlugs : [];
                const networkLimit = profile ? 6 : 4;
                return (
                  <article
                    className={`chains-protocol${profile ? " is-launchpad" : ""}`}
                    key={row.project.id}
                    aria-label={row.project.name}
                  >
                    <div className="chains-protocol-main">
                      <div className="chains-protocol-identity">
                        <ProtocolLogo project={row.project} />
                        <div>
                          <div className="chains-protocol-titleline">
                            <button
                              className="chains-protocol-name"
                              onClick={() => openProject(row.project.id)}
                              disabled={disabled}
                            >
                              {row.project.name}
                            </button>
                            {launchpadMode &&
                              row.project.id === PINNED_LAUNCHPAD && (
                                <span
                                  className="chain-launchpad-pin"
                                  title="Frontier is pinned to the top of this list. The other launchpads follow in the order you choose above."
                                >
                                  Pinned
                                </span>
                              )}
                            {profile && (
                              <span
                                className="chain-launchpad-status"
                                data-status={profile.status}
                                title={
                                  profile.status === "unverified"
                                    ? "Operating status has not been reviewed from a primary source."
                                    : profile.statusNote
                                      ? statusNoteText(profile)
                                      : `Operating status from a reviewed source${profile.reviewedAt ? ` (${reviewedOn(profile.reviewedAt)})` : ""}.`
                                }
                              >
                                {statusLabels[profile.status]}
                              </span>
                            )}
                          </div>
                          <div className="chains-role-tags">
                            {row.roles.map((item) => (
                              <button
                                key={item}
                                aria-label={`Show ${roleName(item)}`}
                                title={
                                  row.roleEvidence.find(
                                    (evidence) => evidence.role === item,
                                  )?.note
                                }
                                onClick={() =>
                                  setRole(role === item ? "all" : item)
                                }
                                aria-pressed={role === item}
                                data-reviewed={reviewedRoles.includes(item)}
                                disabled={disabled}
                              >
                                {roleName(item)}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                      {profile ? (
                        <div className="chain-launchpad-offer">
                          <p className="chain-launchpad-offers">
                            {profile.offers}{" "}
                            <External href={profile.offersSourceUrl}>
                              Source
                            </External>
                          </p>
                          {profile.offers.trim() !==
                            row.project.description.trim() && (
                            <p
                              className="chains-protocol-description"
                              title={row.project.description}
                            >
                              {row.project.description}
                            </p>
                          )}
                          {profile.hookModels.length > 0 && (
                            <p className="chain-launchpad-models">
                              <span className="chain-launchpad-label">
                                Launch model
                              </span>
                              {profile.hookModels
                                .map((model) => hookModelLabels[model])
                                .join(" · ")}
                            </p>
                          )}
                          {profile.documentedNetworks &&
                            profile.documentedNetworks.length > 0 && (
                              <p className="chain-launchpad-models">
                                <span className="chain-launchpad-label">
                                  Documented on
                                </span>
                                {profile.documentedNetworks
                                  .map((slug) => networkNames.get(slug) || slug)
                                  .join(" · ")}
                              </p>
                            )}
                        </div>
                      ) : (
                        <p
                          className="chains-protocol-description"
                          title={row.project.description}
                        >
                          {row.project.description}
                        </p>
                      )}
                      {networksShown.length > 0 && (
                        <div
                          className="chains-protocol-networks"
                          title={
                            platform
                              ? "Networks named in the platform documentation."
                              : "Networks with a listed deployment, linked pool or indexed pool evidence."
                          }
                        >
                          {profile && (
                            <span className="chain-launchpad-label">
                              Networks
                            </span>
                          )}
                          {networksShown.slice(0, networkLimit).map((slug) => (
                            <button
                              key={slug}
                              onClick={() => chooseNetwork(slug)}
                              aria-current={slug === chain ? "true" : undefined}
                              disabled={disabled}
                            >
                              {networkNames.get(slug) || slug}
                            </button>
                          ))}
                          {networksShown.length > networkLimit && (
                            <button
                              onClick={() =>
                                openProject(row.project.id, "deployments")
                              }
                              disabled={disabled}
                              aria-label={`View all ${networksShown.length} ${row.project.name} networks`}
                            >
                              +{networksShown.length - networkLimit} networks
                            </button>
                          )}
                        </div>
                      )}
                      {profile && (
                        <LaunchpadBuiltOn
                          row={row}
                          profile={profile}
                          openProject={openProject}
                          disabled={disabled}
                        />
                      )}
                      <div className="chains-protocol-links">
                        {platform ? (
                          <button
                            className="chains-hook-link"
                            aria-label={`View ${row.project.name} platform`}
                            onClick={() =>
                              openProject(row.project.id, "deployments")
                            }
                            disabled={disabled}
                          >
                            View platform <ArrowRight size={13} />
                          </button>
                        ) : (
                          <>
                            {!profile && (
                              <>
                                <button
                                  className="chains-hook-link"
                                  aria-label={`View ${row.project.name} hooks`}
                                  onClick={() =>
                                    openProject(row.project.id, "deployments")
                                  }
                                  disabled={disabled}
                                >
                                  View hooks <ArrowRight size={13} />
                                </button>
                                <button
                                  aria-label={`View ${row.project.name} pools`}
                                  onClick={() =>
                                    openProject(row.project.id, "pools")
                                  }
                                  disabled={disabled}
                                >
                                  Pools
                                </button>
                              </>
                            )}
                            {inspectActivity && (
                              <button
                                aria-label={`Inspect ${row.project.name} activity`}
                                onClick={() =>
                                  inspectActivity(row.project.id, chain)
                                }
                                disabled={disabled}
                              >
                                Activity
                              </button>
                            )}
                          </>
                        )}
                        <External href={profile?.website ?? row.website}>
                          Website
                        </External>
                        <External href={profile?.docs ?? row.docs}>Docs</External>
                      </div>
                    </div>
                    <div className="chains-protocol-side">
                      <dl className="chains-protocol-metrics">
                        <div>
                          <dt>{metricLabels[0]}</dt>
                          <dd
                            title={
                              catalogHookCount(row) === null
                                ? platform
                                  ? "Platform support is documented; no exact hook contract is published for it, so nothing is counted here."
                                  : "Pool history confirms this project on the network; hook deployment metadata is not listed."
                                : undefined
                            }
                          >
                            {count(catalogHookCount(row))}
                          </dd>
                        </div>
                        <div>
                          <dt>{metricLabels[1]}</dt>
                          <dd
                            title={
                              row.poolCount !== null && !row.poolCountExact
                                ? STATIC_EDITION
                                  ? "At least this many pools were measured in this snapshot"
                                  : "Known lower bound from retained pool evidence"
                                : undefined
                            }
                          >
                            {row.poolCount !== null && !row.poolCountExact
                              ? "≥"
                              : ""}
                            {count(row.poolCount)}
                          </dd>
                        </div>
                        <div>
                          <dt>{metricLabels[2]}</dt>
                          <dd title={exactMoney(row.volumeUsd)}>
                            {money(row.volumeUsd)}
                          </dd>
                        </div>
                        <div>
                          <dt>{metricLabels[3]}</dt>
                          <dd title={exactMoney(row.liquidityUsd)}>
                            {money(row.liquidityUsd)}
                          </dd>
                        </div>
                      </dl>
                      {launchpadMode && attributionNote(row) && (
                        <p className="chains-protocol-attribution">
                          {attributionNote(row)}
                        </p>
                      )}
                      <div className="chains-protocol-disclosures">
                      <details className="chain-catalog-market">
                        <summary>
                          Market data <ChevronDown size={13} />
                        </summary>
                        <div className="chains-protocol-freshness">
                          <Measurement
                            freshness={row.freshness.volume[windowKey]}
                            now={now}
                            label="Tracked volume"
                          />
                          <Measurement
                            freshness={row.freshness.liquidity}
                            now={now}
                            label="Reserves"
                          />
                          <p>
                            Only pool measurements younger than five minutes
                            {STATIC_EDITION ? " when the snapshot was taken" : ""}{" "}
                            contribute to these USD figures. Unavailable values
                            are not zero.
                          </p>
                        </div>
                      </details>
                      <details className="chains-protocol-sources">
                        <summary>
                          Project sources <ChevronDown size={13} />
                        </summary>
                        <div>
                          <External href={row.sourceUrl}>
                            {platform
                              ? "Platform documentation"
                              : row.publishedHookCount > 0
                                ? "Identity source"
                                : "Registry listing"}
                          </External>
                          {row.roleEvidence.map((evidence) => (
                            <p key={evidence.role}>
                              <strong>{roleName(evidence.role)}</strong>
                              <span>{evidence.note}</span>
                              <External href={evidence.sourceUrl}>
                                Source
                              </External>
                            </p>
                          ))}
                          {profile && (
                            <p className="chain-launchpad-status-note">
                              <strong>Operating status</strong>
                              <span>
                                {profile.status === "unverified"
                                  ? "Not yet reviewed from a primary source. A classification above is not an operating-status claim."
                                  : reviewedStatusText(profile)}
                              </span>
                              {profile.statusSourceUrl && (
                                <External href={profile.statusSourceUrl}>
                                  Status source
                                </External>
                              )}
                            </p>
                          )}
                          {profile?.sources
                            .filter(
                              (source) =>
                                source.url !== row.sourceUrl &&
                                !row.roleEvidence.some(
                                  (evidence) =>
                                    evidence.sourceUrl === source.url,
                                ),
                            )
                            .map((source) => (
                              <External href={source.url} key={source.url}>
                                {source.label}
                              </External>
                            ))}
                        </div>
                      </details>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <Empty
              title={
                hasFilters
                  ? "No matching projects"
                  : "No listed projects on this network"
              }
              icon={<Search size={27} />}
              action={
                hasFilters ? (
                  <button
                    className="control"
                    onClick={resetFilters}
                    disabled={disabled}
                  >
                    Clear filters
                  </button>
                ) : network?.deploymentSupport ? (
                  <button
                    className="control"
                    onClick={browseOtherNetworks}
                    disabled={disabled}
                  >
                    Browse other networks
                  </button>
                ) : STATIC_EDITION ? undefined : (
                  // The edition has no on-chain discovery behind this button:
                  // it would open a list this snapshot holds nothing for.
                  <button
                    className="control"
                    onClick={() => browseHooks(chain)}
                    disabled={disabled}
                  >
                    Explore on-chain hooks
                  </button>
                )
              }
            >
              {hasFilters
                ? launchpadMode && !search.trim()
                  ? `No launchpad is listed${network ? ` on ${network.name}` : ""}. Try another network or protocol type.`
                  : "Try another name, address or protocol type."
                : network?.deploymentSupport
                  ? "Uniswap has not published a v4 deployment for this network. Choose another network to explore indexed hooks and markets."
                  : STATIC_EDITION
                    ? emptyNetworkNote(network, now)
                    : "No named project lists a hook here yet. Unnamed contracts may still appear in on-chain discovery."}
            </Empty>
          )}
          {sorted.length > 0 && (
            <div className="chain-catalog-bottom">
              <p
                className="chain-catalog-page-status"
                role="status"
                aria-live="polite"
              >
                Showing {count(paging.start + 1)}–{count(paging.end)} of{" "}
                {count(sorted.length)} projects
                {paging.pages > 1 &&
                  ` · Page ${paging.page + 1} of ${paging.pages}`}
              </p>
              {paging.pages > 1 && (
                <nav
                  className="chain-catalog-pagination"
                  aria-label="Project pages"
                >
                  <button
                    className="control"
                    aria-label="Previous project page"
                    disabled={disabled || paging.page === 0}
                    onClick={() => changePage(paging.page - 1)}
                  >
                    <ChevronLeft size={14} />
                    Previous
                  </button>
                  <button
                    className="control"
                    aria-label="Next project page"
                    disabled={disabled || paging.page === paging.pages - 1}
                    onClick={() => changePage(paging.page + 1)}
                  >
                    Next
                    <ChevronRight size={14} />
                  </button>
                </nav>
              )}
            </div>
          )}
          {registrySource && (
            <p className="chains-registry-freshness">
              {registrySource.status === "live"
                ? "Registry fetched"
                : "Saved registry"}
              {registrySource.updatedAt ? (
                <time
                  dateTime={registrySource.updatedAt}
                  title={exactDate(registrySource.updatedAt)}
                >
                  {" "}
                  {age(registrySource.updatedAt, now)}
                </time>
              ) : (
                " · last fetch unavailable"
              )}
              .{" "}
              {STATIC_EDITION
                ? "Project listings include published hooks; the census also counts unnamed contracts, which are not listed here."
                : "Project listings include published hooks; on-chain discovery also includes unnamed contracts."}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
