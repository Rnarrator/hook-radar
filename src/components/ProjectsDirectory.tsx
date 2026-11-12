import { useDeferredValue, useId, useMemo, useRef } from "react";
import type { RadarSnapshot, WindowKey } from "../../shared/types";
import { buildChains } from "../chains";
import type { ChainProtocol, ChainRole } from "../chains";
import { count, money, windows } from "../model";
import { dailyNetworksLabel } from "../daily";
import { useDailyView } from "../daily-view";
import { projectsQuery } from "../navigation";
import type { ChainRoleFilter, ProjectsSort } from "../navigation";
import {
  PROJECTS_RENDER_MAX,
  dailyFigureNote,
  knownHooks,
  listProjects,
  listedNames,
  networkLine,
  networkOptions,
  projectBrand,
  projectFigures,
  projectNotes,
  projectRoles,
  projectStatus,
  projectsMeta,
  roleLabel,
  unlistedCount,
  unmeasuredNote,
  useCaseOptions,
  visibleProjects,
  withTrackedPools,
} from "../projects-directory";
import { ArrowRight, ChevronDown, Info, Network, Search, X } from "./Icons";
import { Empty, External } from "./Primitives";
import { ProtocolLogo } from "./ProtocolLogo";
import { DailyAmount, NO_SUM } from "./DailyAmount";
import "./projects-directory.css";

interface Props {
  snapshot: RadarSnapshot;
  windowKey: WindowKey;
  now: number;
  network: string;
  setNetwork: (network: string) => void;
  search: string;
  setSearch: (search: string) => void;
  use: ChainRoleFilter;
  setUse: (use: ChainRoleFilter) => void;
  sort: ProjectsSort;
  setSort: (sort: ProjectsSort) => void;
  /** Remove the search, the use case and the network in one step. */
  clearFilters: () => void;
  openProject: (id: string, tab?: "deployments" | "pools") => void;
  /** Open Discover on its hook list. */
  browseHooks: () => void;
  /** Open Discover with this search. */
  searchDiscover: (query: string) => void;
  disabled?: boolean;
}

const sortOptions: readonly { id: ProjectsSort; label: string }[] = [
  { id: "volume", label: "Highest volume" },
  { id: "reserves", label: "Highest reserves" },
  { id: "pools", label: "Most pools" },
  { id: "name", label: "Name A–Z" },
];

function ProjectCard({
  row,
  names,
  listed,
  chosenNetwork,
  networkName,
  windowKey,
  openProject,
  disabled,
}: {
  row: ChainProtocol;
  names: ReadonlyMap<string, string>;
  listed: ReadonlySet<string>;
  chosenNetwork: string;
  networkName: string | null;
  windowKey: WindowKey;
  openProject: Props["openProject"];
  disabled: boolean;
}) {
  const daily = useDailyView();
  const project = row.project;
  const platform = project.entityType === "platform";
  const brand = projectBrand(row);
  const status = projectStatus(row);
  const roles = projectRoles(row);
  const figures = projectFigures(row);
  const networks = networkLine(row, names, chosenNetwork);
  const hooks = knownHooks(row);
  const notes = projectNotes(row, listed);
  const note = daily.span ? dailyFigureNote(row.daily, daily.lens) : null;
  const volumeLabel = daily.span
    ? dailyNetworksLabel(daily.span)
    : `Tracked ${windows[windowKey]} volume`;
  return (
    <li className="projects-item">
      <article
        className="projects-card"
        aria-label={project.name}
        data-testid="projects-card"
        data-project-id={project.id}
      >
        <div className="projects-card-head">
          <ProtocolLogo project={project} />
          <div className="projects-card-title">
            {brand && (
              <span className="projects-card-brand" aria-hidden="true">
                {brand}
              </span>
            )}
            <button
              type="button"
              className="projects-card-name"
              onClick={() => openProject(project.id)}
              disabled={disabled}
            >
              {project.name}
              {brand && <span className="sr-only">, {brand}</span>}
            </button>
          </div>
        </div>
        <ul className="projects-card-chips" aria-label="Use case and status">
          {roles.map((role) => (
            <li key={role.id} data-reviewed={role.id === "launchpads" || role.id === "dexes"}>
              {role.label}
            </li>
          ))}
          {status && (
            <li
              className="projects-card-status"
              data-status={status.status}
              title={
                status.status === "unverified"
                  ? "Operating status has not been reviewed from a primary source."
                  : "Operating status from a reviewed source."
              }
            >
              {status.label}
            </li>
          )}
        </ul>
        <p className="projects-card-description">{project.description}</p>
        <p
          className="projects-card-networks"
          title={
            platform
              ? "Networks named in the platform’s documentation"
              : "Networks with a listed deployment, linked pool or pool evidence"
          }
        >
          <Network size={14} />
          <span className="sr-only">Networks: {networks.all.join(", ")}.</span>
          <span className="projects-card-network-names" aria-hidden="true">
            {networks.shown.join(" · ")}
            {networks.more > 0 ? ` +${networks.more}` : ""}
          </span>
          {hooks !== null && (
            <span className="projects-card-hooks">
              {count(hooks)} known {hooks === 1 ? "hook" : "hooks"}
            </span>
          )}
        </p>
        {figures.unmeasured ? (
          <p className="projects-card-unmeasured">
            {unmeasuredNote(networkName)}
          </p>
        ) : (
          <>
            <dl className="projects-figures">
              <div>
                <dt>{volumeLabel}</dt>
                <dd>
                  {daily.span ? (
                    <DailyAmount sum={row.daily ?? NO_SUM} compact />
                  ) : (
                    <>
                      {figures.volumeMark}
                      {money(figures.volume)}
                    </>
                  )}
                </dd>
              </div>
              <div>
                <dt>Pools in snapshot</dt>
                <dd
                  title={
                    figures.poolsMark
                      ? "At least this many pools were measured in this snapshot"
                      : undefined
                  }
                >
                  {figures.poolsMark}
                  {count(figures.pools)}
                </dd>
              </div>
              <div>
                <dt>Reported reserves</dt>
                <dd>
                  {figures.reservesMark}
                  {money(figures.reserves)}
                </dd>
              </div>
            </dl>
            {/* One line is kept for the day a 7D or 30D figure runs to, in every
                window, so choosing a window moves nothing. */}
            <p className="projects-figures-note" aria-hidden="true">
              {note ?? " "}
            </p>
          </>
        )}
        {notes.map((text) => (
          <p className="projects-card-note" key={text}>
            {text}
          </p>
        ))}
        <div className="projects-card-links">
          <External href={project.website}>
            Website<span className="sr-only"> of {project.name}</span>
          </External>
          <External href={project.docs}>
            Docs<span className="sr-only"> of {project.name}</span>
          </External>
        </div>
      </article>
    </li>
  );
}

export function ProjectsDirectory({
  snapshot,
  windowKey,
  now,
  network,
  setNetwork,
  search,
  setSearch,
  use,
  setUse,
  sort,
  setSort,
  clearFilters,
  openProject,
  browseHooks,
  searchDiscover,
  disabled = false,
}: Props) {
  const searchId = useId();
  const searchInput = useRef<HTMLInputElement>(null);
  const deferredSearch = useDeferredValue(search);
  const daily = useDailyView();
  // The whole list, before any network is chosen: its counts, its networks and
  // the number of hooks left to Discover. The same model (and cache entry) the
  // page heading reads.
  const everyone = useMemo(
    () => buildChains(snapshot, { chain: "all", windowKey, now, hookOverlap: true }),
    [snapshot, windowKey, now],
  );
  // The figures of the list: the chosen network's own, over the 7D or 30D lens
  // when one is chosen, exactly as the Networks page builds them.
  const scoped = useMemo(
    () =>
      network === "all" && !daily.lens
        ? everyone
        : buildChains(snapshot, {
            chain: network,
            windowKey,
            now,
            hookOverlap: true,
            daily: daily.lens,
          }),
    [snapshot, everyone, network, windowKey, now, daily.lens],
  );
  const names = useMemo(
    () => new Map(everyone.networks.map((item) => [item.slug, item.name])),
    [everyone.networks],
  );
  const listedAll = useMemo(() => listProjects(everyone.protocols), [everyone]);
  const listedInScope = useMemo(() => listProjects(scoped.protocols), [scoped]);
  const listedSet = useMemo(
    () => listedNames(listedInScope, scoped.protocols),
    [listedInScope, scoped],
  );
  const visible = useMemo(
    () =>
      visibleProjects(listedInScope, {
        query: deferredSearch,
        use,
        sort,
        names,
      }),
    [listedInScope, deferredSearch, use, sort, names],
  );
  const useOptions = useMemo(() => useCaseOptions(listedInScope), [listedInScope]);
  const networks = useMemo(
    () => networkOptions(listedAll, names),
    [listedAll, names],
  );
  const unlisted = unlistedCount(everyone.protocols);
  const networkName =
    network === "all" ? null : (names.get(network) ?? scoped.selectedNetwork?.name ?? network);
  const filtered = search.trim() !== "" || use !== "all" || network !== "all";
  const useHeld =
    use === "all" ||
    [...useOptions.reviewed, ...useOptions.cases].some((item) => item.id === use);
  const meta = projectsMeta({
    shown: visible.length,
    total: listedAll.length,
    networks: networks.length,
    withPools: withTrackedPools(listedAll),
    use: use === "all" ? null : roleLabel(use as ChainRole),
    network: networkName,
    filtered,
  });
  const shown = visible.slice(0, PROJECTS_RENDER_MAX);
  const clear = () => {
    clearFilters();
    searchInput.current?.focus();
  };
  const useOption = (item: { id: ChainRole; label: string; count: number }) => (
    <option value={item.id} key={item.id}>
      {item.label} ({count(item.count)})
    </option>
  );

  return (
    <section className="projects-page" aria-label="Projects" data-testid="projects-page">
      <div className="projects-toolbar">
        <div className="projects-search">
          <Search size={16} />
          <label className="sr-only" htmlFor={searchId}>
            Search projects by name, use case or network
          </label>
          <input
            id={searchId}
            ref={searchInput}
            data-testid="projects-search"
            aria-label="Search projects by name, use case or network"
            value={search}
            maxLength={300}
            placeholder="Search projects"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="search"
            onChange={(event) => setSearch(projectsQuery(event.target.value))}
            disabled={disabled}
          />
          {search && (
            <button
              type="button"
              aria-label="Clear project search"
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
        <label className="select-control projects-use">
          <span className="sr-only">Use case</span>
          <select
            data-testid="projects-use"
            value={use}
            onChange={(event) => setUse(event.target.value as ChainRoleFilter)}
            disabled={disabled}
          >
            <option value="all">
              All use cases ({count(listedInScope.length)})
            </option>
            {!useHeld && (
              <option value={use}>{roleLabel(use as ChainRole)} (0)</option>
            )}
            {useOptions.reviewed.length > 0 && (
              <optgroup label="Reviewed roles">
                {useOptions.reviewed.map(useOption)}
              </optgroup>
            )}
            {useOptions.cases.length > 0 && (
              <optgroup label="Use cases">{useOptions.cases.map(useOption)}</optgroup>
            )}
          </select>
          <ChevronDown size={14} />
        </label>
        <label className="select-control projects-network">
          <span className="sr-only">Network</span>
          <select
            data-testid="projects-network"
            value={network}
            onChange={(event) => setNetwork(event.target.value)}
            disabled={disabled}
          >
            <option value="all">All networks ({count(listedAll.length)})</option>
            {!scoped.knownChain && <option value={network}>Unknown network</option>}
            {networks.map((item) => (
              <option value={item.slug} key={item.slug}>
                {item.name} ({count(item.count)})
              </option>
            ))}
          </select>
          <ChevronDown size={14} />
        </label>
        <label className="select-control projects-sort">
          <span className="sr-only">Sort projects</span>
          <select
            data-testid="projects-sort"
            value={sort}
            onChange={(event) => setSort(event.target.value as ProjectsSort)}
            disabled={disabled}
          >
            {sortOptions.map((item) => (
              <option value={item.id} key={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          <ChevronDown size={14} />
        </label>
      </div>
      <div className="projects-meta">
        <p role="status" aria-live="polite" data-testid="projects-meta">
          <span>{scoped.knownChain ? meta : "Network not in this snapshot"}</span>
        </p>
        {/* Always laid out, hidden while no filter is set, so a filter that
            appears moves nothing. A hidden button is out of the tab order. */}
        <button
          type="button"
          className="projects-clear"
          data-testid="projects-clear"
          onClick={clear}
          disabled={disabled}
          data-idle={filtered ? undefined : "true"}
          aria-hidden={filtered ? undefined : true}
          tabIndex={filtered ? undefined : -1}
        >
          Clear filters <X size={13} />
        </button>
      </div>

      {!scoped.knownChain ? (
        <Empty
          title="Network not found"
          icon={<Network size={27} />}
          headingLevel={2}
          action={
            <button className="control" onClick={clear} disabled={disabled}>
              All networks
            </button>
          }
        >
          This link names a network that is not in this snapshot. Choose a
          network to see the projects that run on it.
        </Empty>
      ) : listedAll.length === 0 ? (
        <Empty
          title="No projects are listed in this snapshot"
          icon={<Search size={27} />}
          headingLevel={2}
          action={
            <button className="control" onClick={browseHooks} disabled={disabled}>
              Browse hooks
            </button>
          }
        >
          Hooks with no public project behind them are in Discover.
        </Empty>
      ) : visible.length === 0 ? (
        <Empty
          title="No project matches"
          icon={<Search size={27} />}
          headingLevel={2}
          action={
            <span className="projects-empty-actions">
              <button
                className="primary-button"
                onClick={clear}
                disabled={disabled}
              >
                Clear filters
              </button>
              {search.trim() !== "" && (
                <button
                  className="control"
                  onClick={() => searchDiscover(search.trim())}
                  disabled={disabled}
                >
                  Search Discover for “{search.trim()}”
                </button>
              )}
            </span>
          }
        >
          {search.trim() !== ""
            ? `No listed project matches “${search.trim()}”. A hook with no named project behind it is in Discover.`
            : "No listed project matches these filters."}
        </Empty>
      ) : (
        <>
          <h2 className="sr-only">Listed projects</h2>
          <ul className="projects-grid" data-testid="projects-list">
            {shown.map((row) => (
              <ProjectCard
                key={row.project.id}
                row={row}
                names={names}
                listed={listedSet}
                chosenNetwork={network}
                networkName={networkName}
                windowKey={windowKey}
                openProject={openProject}
                disabled={disabled}
              />
            ))}
          </ul>
          {visible.length > shown.length && (
            <p className="projects-limit" data-testid="projects-limit">
              Showing the first {count(shown.length)} of {count(visible.length)}{" "}
              projects. Narrow the list with the search or a filter.
            </p>
          )}
        </>
      )}

      <p className="projects-discover">
        Looking for a single hook?
        <button
          type="button"
          className="projects-text-button"
          data-testid="projects-browse-hooks"
          onClick={browseHooks}
          disabled={disabled}
        >
          Browse every hook in Discover <ArrowRight size={14} />
        </button>
      </p>

      <details className="projects-method" id="projects-method">
        <summary>
          <Info size={14} /> About these numbers <ChevronDown size={14} />
        </summary>
        <div className="projects-method-body">
          <p>
            A project is listed when it is a launch platform, has a website or
            documentation of its own, or has original artwork in the reviewed
            tables. A name alone never lists a project. The hook families in the
            reviewed tables are matched by the names of their deployments, so
            a listing is not a check of who owns a contract. Registry listings
            and shared names do not establish common ownership or endorsement.
            Sibling hook families of one brand are separate entries, each with
            its own figures.
          </p>
          <p>
            Volume covers tracked hook pools whose measurements were less than
            five minutes old when the snapshot was taken. It is not total Uniswap
            volume. A ≥ sign marks a lower bound: the project may have more
            pools than the snapshot holds. A dash means not measured, not zero.
            Reported reserves are provider valuations.
          </p>
          <p>
            The order follows the sort you choose, by tracked volume to begin
            with. It is not a ranking of quality and no project is placed
            first: only tracked pools are added up, so a busy hook can sit above
            a better-known project. Two projects can publish one hook; its pools
            count in each row and are never added together, so there is no total
            across projects.
          </p>
          <p>
            Hooks with no public project behind them ({count(unlisted)} in this
            snapshot) are in Discover.
          </p>
        </div>
      </details>
    </section>
  );
}
