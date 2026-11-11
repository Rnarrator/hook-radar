import { Fragment, useDeferredValue, useMemo, useRef } from "react";
import type {
  MetricFreshness,
  RadarSnapshot,
  WindowKey,
} from "../../shared/types";
import { buildChains } from "../chains";
import type { ChainNetwork, ChainRole } from "../chains";
import {
  chainHeadCheckLead,
  chainHeadCheckTerm,
  chainIndexState as indexState,
  chainMeasurementLead,
  chainSourceNote,
} from "../chain-network-directory";
import { ChainNetworkDirectory } from "./ChainNetworkDirectory";
import { ChainCharts } from "./ChainCharts";
import { ChainProtocolCatalog } from "./ChainProtocolCatalog";
import {
  count,
  filterProjects,
  money,
  safeUrl,
  shortAddress,
  windows,
} from "../model";
import {
  CENSUS_HOOKS_SCOPE,
  STATIC_EDITION,
  censusHeading,
  censusLabel,
  fullTimeLabel,
  timeLabel,
  utcDate,
} from "../edition";
import { ArrowRight, ChevronDown, ChevronLeft, Info, Network } from "./Icons";
import { Empty, External } from "./Primitives";
import { CensusNote } from "./EditionStatus";
import "./chains.css";

interface Props {
  snapshot: RadarSnapshot;
  windowKey: WindowKey;
  now: number;
  chain: string;
  setChain: (chain: string) => void;
  search: string;
  setSearch: (search: string) => void;
  role: ChainRole | "all";
  setRole: (role: ChainRole | "all") => void;
  openProject: (id: string, tab?: "deployments" | "pools") => void;
  /** Absent where the page has no activity view (the static edition). */
  inspectActivity?: (id: string, chain: string) => void;
  openAnalytics: (chain: string) => void;
  browseHooks: (chain: string) => void;
  /** Opens the Data & sources dialog; omitted where the build has none. */
  openSources?: () => void;
  disabled?: boolean;
}

function elapsed(value: string | null | undefined, now: number) {
  const stamp = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(stamp)) return null;
  if (STATIC_EDITION) return timeLabel(stamp);
  const age = Math.max(0, now - stamp);
  if (age < 60_000) return "just now";
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m ago`;
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h ago`;
  return `${Math.floor(age / 86_400_000)}d ago`;
}

function exactDate(value: string | null | undefined) {
  // The edition states every time in UTC, the clock the snapshot keeps.
  if (STATIC_EDITION) return fullTimeLabel(value) ?? "Not checked";
  return value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "Not checked";
}

function addressUrl(explorer: string | null, address: string) {
  const base = safeUrl(explorer);
  if (!base || !/^0x[a-f\d]{40}$/i.test(address)) return undefined;
  return new URL(`address/${address}`, `${base.replace(/\/$/, "")}/`).href;
}

/** Freshness note for a readout: the measurement cohort and its oldest clock.
 * Unavailable stays unavailable; expired observations are named, not hidden. */
function Measurement({
  freshness,
  now,
}: {
  freshness: MetricFreshness;
  now: number;
}) {
  const excluded = freshness.stalePools + freshness.unknownPools;
  const emptyLabel = freshness.stalePools
    ? "Measurements expired"
    : freshness.unknownPools
      ? "Freshness unavailable"
      : "No measurements available";
  return (
    <span
      className="chains-measurement"
      title={
        freshness.oldestAt
          ? `Oldest current measurement: ${exactDate(freshness.oldestAt)}. ${STATIC_EDITION ? "Measurements more than five minutes old when the snapshot was taken are excluded." : "Measurements older than five minutes are excluded."}`
          : "No current pool measurements are available for this metric. Unavailable amounts are not zero."
      }
    >
      <span>
        {freshness.currentPools
          ? `${count(freshness.currentPools)} current ${freshness.currentPools === 1 ? "pool" : "pools"}`
          : emptyLabel}
      </span>
      {freshness.currentPools > 0 && freshness.oldestAt && (
        <time dateTime={freshness.oldestAt}>
          {chainMeasurementLead()}{" "}
          {elapsed(freshness.oldestAt, now) || "at an unknown time"}
        </time>
      )}
      {freshness.currentPools === 0 && freshness.latestObservedAt && (
        <time
          dateTime={freshness.latestObservedAt}
          title={exactDate(freshness.latestObservedAt)}
        >
          Last measurement{" "}
          {elapsed(freshness.latestObservedAt, now) || "at an unknown time"}
        </time>
      )}
      {excluded > 0 && (
        <span className="chains-measurement-excluded">
          {count(excluded)} {excluded === 1 ? "measurement" : "measurements"}{" "}
          excluded from totals
        </span>
      )}
    </span>
  );
}

/** A share as a whole percent, never rounding a partial share up to 100%. */
function sharePercent(share: number): string {
  const percent = share * 100;
  return `${percent >= 99.5 && percent < 100 ? ">99" : Math.round(percent)}%`;
}

/** Share of the recorded block range already scanned. Derived only from the
 * saved inventory's own block numbers; no estimate when a target is missing. */
function scanProgress(network: ChainNetwork) {
  const inventory = network.inventory;
  if (!inventory || inventory.targetBlock === null) return null;
  const span = inventory.targetBlock - inventory.startBlock;
  if (!Number.isFinite(span) || span <= 0) return null;
  const done = Math.min(
    span,
    Math.max(0, inventory.scannedToBlock - inventory.startBlock),
  );
  return done / span;
}

function scanLabel(share: number | null, caughtUp: boolean) {
  if (caughtUp) return "Scanned to the recorded target block";
  if (share === null) return "Recorded target block unavailable";
  const percent = share * 100;
  return `Scanned ${percent > 99.9 && percent < 100 ? ">99.9" : percent.toLocaleString(undefined, { maximumFractionDigits: 1 })}% of the recorded block range`;
}

export function ChainExplorer({
  snapshot,
  windowKey,
  now,
  chain,
  setChain,
  search,
  setSearch,
  role,
  setRole,
  openProject,
  inspectActivity,
  openAnalytics,
  browseHooks,
  openSources,
  disabled = false,
}: Props) {
  const networkSelect = useRef<HTMLSelectElement>(null);
  const deferredSearch = useDeferredValue(search);
  const result = useMemo(
    () =>
      buildChains(snapshot, {
        chain,
        search: deferredSearch,
        role,
        windowKey,
        now,
      }),
    [snapshot, chain, deferredSearch, role, windowKey, now],
  );
  const network = result.selectedNetwork;
  // Hook and pool counts are a dated export, not measured at the snapshot.
  const census = STATIC_EDITION
    ? censusLabel(snapshot.inventory, snapshot.generatedAt)
    : null;
  const launchpadMode = role === "launchpads";
  const unsupportedEmpty =
    !!network?.deploymentSupport && result.totalProtocols === 0;
  // The edition has no on-chain discovery behind "Browse all hooks". On an
  // indexed network where the snapshot lists, measures and holds nothing, it
  // would open a list with no result: the hooks list is filtered by the same
  // rule (a deployment on the network, or a platform that lists it).
  const nothingToBrowse =
    STATIC_EDITION &&
    !!network &&
    !network.deploymentSupport &&
    network.protocolCount === 0 &&
    network.observedPools === 0 &&
    filterProjects(snapshot.projects, {
      search: "",
      chain: network.slug,
      category: "all",
      property: "all",
      market: "all",
    }).length === 0;
  const status = network ? indexState(network) : null;
  const sourceNote = network ? chainSourceNote(network) : null;
  const scopedName = network?.name || "All networks";
  const registrySource = snapshot.sources.find(
    (source) => source.id === "registry",
  );
  const chooseNetwork = (slug: string) => {
    setChain(slug);
    networkSelect.current?.focus();
  };
  const browseOtherNetworks = () => {
    setSearch("");
    setRole("all");
    chooseNetwork("all");
  };
  const changeCatalogRole = (nextRole: ChainRole | "all") => {
    setRole(nextRole);
    // Reordering the keyed catalog keeps the active control. Reveal it without
    // overriding focus chosen by actions such as Clear filters.
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.closest("#chains-projects"))
        active.scrollIntoView({ block: "nearest", behavior: "instant" });
    });
  };
  const scan = network ? scanProgress(network) : null;
  const headAge = network?.inventory
    ? elapsed(network.inventory.headCheckedAt, now)
    : null;

  // Stable sibling keys preserve catalog sort and focus when changing category.
  const networkOverview = (
    <Fragment key="network">
      {network && (
        <section
          className="chains-profile"
          aria-labelledby="chain-profile-title"
        >
          <button
            className="chains-back-link"
            onClick={() => chooseNetwork("all")}
            disabled={disabled}
          >
            <ChevronLeft size={14} /> All networks
          </button>
          <div className="chains-profile-top">
            <div className="chains-profile-identity">
              <p className="chains-eyebrow">
                {network.deploymentSupport
                  ? "Network support"
                  : "Network profile"}
                {network.chainId !== null && (
                  <span> · Chain ID {String(network.chainId)}</span>
                )}
              </p>
              <h2 id="chain-profile-title">
                {network.deploymentSupport
                  ? `${network.name} & Uniswap`
                  : `${network.name} on v4`}
              </h2>
            </div>
            <div className="chains-profile-actions">
              {!network.deploymentSupport && (
                <button
                  className="control"
                  onClick={() => openAnalytics(chain)}
                  disabled={disabled}
                >
                  Network analytics <ArrowRight size={14} />
                </button>
              )}
              {(!network.deploymentSupport || network.hookCount > 0) &&
                !nothingToBrowse && (
                  <button
                    className="chains-text-button"
                    onClick={() => browseHooks(chain)}
                    disabled={disabled}
                  >
                    {network.deploymentSupport
                      ? "Browse registry hooks"
                      : "Browse all hooks"}{" "}
                    <ArrowRight size={14} />
                  </button>
                )}
              <External href={network.explorer}>Block explorer</External>
            </div>
          </div>
          {network.deploymentSupport ? (
            <div className="chains-deployment-note">
              <div>
                <Info size={15} />
                <strong>{network.deploymentSupport.label}</strong>
              </div>
              <p>{network.deploymentSupport.description}</p>
              <div className="chains-deployment-sources">
                {network.deploymentSupport.sources.map((source) => (
                  <External href={source.url} key={source.url}>
                    {source.label}
                  </External>
                ))}
              </div>
              <span>
                Sources reviewed{" "}
                <time dateTime={network.deploymentSupport.reviewedAt}>
                  {STATIC_EDITION
                    ? Number.isFinite(
                        Date.parse(network.deploymentSupport.reviewedAt),
                      )
                      ? utcDate(
                          Date.parse(network.deploymentSupport.reviewedAt),
                        )
                      : "an unknown date"
                    : new Date(
                        network.deploymentSupport.reviewedAt,
                      ).toLocaleDateString(undefined, {
                        dateStyle: "medium",
                        timeZone: "UTC",
                      })}
                </time>
              </span>
              {unsupportedEmpty && (
                <button
                  className="control chains-support-recovery"
                  onClick={browseOtherNetworks}
                  disabled={disabled}
                >
                  Browse other networks <ArrowRight size={14} />
                </button>
              )}
            </div>
          ) : network.inventory ? (
            <details className="chains-index-details">
              <summary>
                <span
                  className={`chains-status-dot ${status?.state}`}
                  aria-hidden="true"
                />
                <span className="chains-index-status">{status?.label}</span>
                <span className="chains-index-head">
                  {STATIC_EDITION
                    ? network.inventory.headCheckedAt
                      ? `${chainHeadCheckLead(network)} ${headAge || "at an unknown time"}`
                      : "Head not checked"
                    : network.headFresh
                      ? `Head checked ${headAge || "recently"}`
                      : network.inventory.headCheckedAt
                        ? `Head check overdue${headAge ? ` · last ${headAge}` : ""}`
                        : "Head not checked"}
                </span>
                <span className="chains-index-scan">
                  {scanLabel(scan, network.caughtUp)}
                </span>
                <span className="chains-index-toggle">
                  Data coverage <ChevronDown size={14} />
                </span>
              </summary>
              <div className="chains-index-body">
                {scan !== null && (
                  <div
                    className="chains-scan-meter"
                    role="img"
                    aria-label={scanLabel(scan, network.caughtUp)}
                  >
                    <span
                      style={{
                        width: `${network.caughtUp ? 100 : scan * 100}%`,
                      }}
                    />
                  </div>
                )}
                <dl>
                  {STATIC_EDITION && census && (
                    <div>
                      <dt>Census</dt>
                      <dd>
                        {censusHeading(snapshot.inventory, snapshot.generatedAt)}
                        {network.inventory.updatedAt && (
                          <>
                            {" "}
                            · counted {fullTimeLabel(network.inventory.updatedAt)}
                          </>
                        )}
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt>
                      {STATIC_EDITION
                        ? "Hook contracts found (at least)"
                        : "Hook contracts indexed"}
                    </dt>
                    <dd>{count(network.inventory.hookCount)}</dd>
                  </div>
                  <div>
                    <dt>Pools using hooks</dt>
                    <dd>{count(network.inventory.hookPoolCount)}</dd>
                  </div>
                  <div>
                    <dt>All v4 pools indexed</dt>
                    <dd>{count(network.inventory.poolCount)}</dd>
                  </div>
                  <div>
                    <dt>
                      {STATIC_EDITION
                        ? "Blocks scanned at the census"
                        : "Blocks scanned"}
                    </dt>
                    <dd>
                      {count(network.inventory.startBlock)}–
                      {count(network.inventory.scannedToBlock)}
                    </dd>
                  </div>
                  <div>
                    <dt>Recorded target block</dt>
                    <dd>{count(network.inventory.targetBlock)}</dd>
                  </div>
                  <div>
                    <dt>{chainHeadCheckTerm(network)}</dt>
                    <dd>{exactDate(network.inventory.headCheckedAt)}</dd>
                  </div>
                </dl>
                <div className="chains-manager">
                  <span>PoolManager</span>
                  <External
                    href={addressUrl(
                      network.explorer,
                      network.inventory.manager,
                    )}
                  >
                    {shortAddress(network.inventory.manager)}
                  </External>
                </div>
                <p>
                  {STATIC_EDITION
                    ? "Counts cover initialized pools in the scanned block range, as they stood at the census. A checked chain head and a completed scan are tracked separately."
                    : "Counts cover initialized pools in the scanned block range. A recently checked head and a completed scan are tracked separately."}
                </p>
                {sourceNote && <p className="chains-warning">{sourceNote}</p>}
              </div>
            </details>
          ) : (
            <div className="chains-registry-note">
              <Info size={15} />
              <span>
                A canonical pool index is unavailable for this network. Registry
                listings are shown below where available.
              </span>
            </div>
          )}
        </section>
      )}

      {launchpadMode && (
        <header className="chains-section-heading chains-overview-heading">
          <div>
            <p className="chains-section-kicker">Network context</p>
            <h2>Network overview</h2>
            <p>
              {scopedName} · Network totals remain all-protocol totals,
              including protocols outside launchpads.
            </p>
          </div>
        </header>
      )}
      <div
        className="chains-summary"
        id="chains-overview"
        role="group"
        aria-label={`${scopedName} overview`}
      >
        <div>
          <span>Listed projects</span>
          <strong>{count(result.totalProtocols)}</strong>
          <small>Projects and reviewed platforms with public sources</small>
        </div>
        <div>
          <span>
            {STATIC_EDITION
              ? "Hook contracts found (at least)"
              : "Indexed hook contracts"}
          </span>
          <strong>{count(result.inventory.hookCount)}</strong>
          <small>
            {result.inventory.hookPoolCount === null
              ? "No canonical pool index"
              : `${count(result.inventory.hookPoolCount)} pools using hooks`}
            {result.inventory.hookPoolCount !== null && (
              <CensusNote label={census} />
            )}
          </small>
        </div>
        <div>
          <span>Tracked {windows[windowKey]} volume</span>
          <strong>{money(result.totals.volumeUsd)}</strong>
          <small>
            <Measurement
              freshness={result.totals.freshness.volume[windowKey]}
              now={now}
            />
            {result.totals.volumeUsd !== null && (
              <span className="chains-coverage-flag">
                Partial coverage · Not total Uniswap volume
              </span>
            )}
            {result.totals.concentration &&
              result.totals.concentration.topThreePoolShare >= 0.5 && (
                <span
                  className="chains-coverage-flag chains-concentration-flag"
                  title={`The largest pool holds ${sharePercent(result.totals.concentration.topPoolShare)} of this tracked volume and the three largest hold ${sharePercent(result.totals.concentration.topThreePoolShare)}.`}
                >
                  Top 3 pools: {sharePercent(result.totals.concentration.topThreePoolShare)} of this volume
                </span>
              )}
          </small>
        </div>
        <div>
          <span>Reported reserves</span>
          <strong>{money(result.totals.liquidityUsd)}</strong>
          <small>
            <Measurement
              freshness={result.totals.freshness.liquidity}
              now={now}
            />
          </small>
        </div>
      </div>
      <p className="chains-market-scope">
        <Info size={13} />
        <span>
          {network?.deploymentSupport
            ? "No v4 pool inventory or current USD measurements are available for this network."
            : STATIC_EDITION && census
              ? `USD figures cover measured pools. Indexed hook and pool counts are from the ${census}; they also include pools without current prices. ${CENSUS_HOOKS_SCOPE}`
              : "USD figures cover measured pools. Indexed hook and pool counts also include pools without current prices."}
        </span>
      </p>

      <ChainCharts
        result={result}
        windowKey={windowKey}
        disabled={disabled}
        onSelectNetwork={chooseNetwork}
        census={census}
      />
      {chain === "all" && (
        <ChainNetworkDirectory
          networks={result.networks}
          windowKey={windowKey}
          disabled={disabled}
          onSelectNetwork={chooseNetwork}
          census={census}
        />
      )}
    </Fragment>
  );
  const catalog = (
    <ChainProtocolCatalog
      key="catalog"
      result={result}
      chain={chain}
      windowKey={windowKey}
      now={now}
      search={search}
      setSearch={setSearch}
      role={role}
      setRole={changeCatalogRole}
      openProject={openProject}
      inspectActivity={inspectActivity}
      browseHooks={browseHooks}
      chooseNetwork={chooseNetwork}
      registrySource={registrySource}
      updating={search !== deferredSearch}
      disabled={disabled}
    />
  );

  return (
    <section
      className={`chains-workspace${network ? " chains-network-selected" : ""}${launchpadMode ? " chains-launchpad-mode" : ""}`}
      aria-label="Chains and protocols"
    >
      <div className="chains-toolbar">
        <label className="select-control chains-network-select">
          <Network size={16} />
          <span className="sr-only">Browse network</span>
          <select
            ref={networkSelect}
            value={chain}
            onChange={(event) => setChain(event.target.value)}
            disabled={disabled}
          >
            <option value="all">All networks</option>
            {!result.knownChain && (
              <option value={chain}>Unknown network</option>
            )}
            {result.networks.map((row) => (
              <option value={row.slug} key={row.slug}>
                {row.name}
              </option>
            ))}
          </select>
          <ChevronDown size={14} />
        </label>
        <p className="chains-scope-caption">
          <span>
            {network
              ? network.name
              : result.knownChain
                ? `${count(result.networks.length)} networks · ${count(result.inventory.indexedNetworks)} indexed${STATIC_EDITION && census ? ` · ${census}` : ""}`
                : STATIC_EDITION
                  ? "Network not in this snapshot"
                  : "Network not in directory"}
          </span>
          <span>{windows[windowKey]} window</span>
        </p>
        {openSources && (
          <button
            className="chains-text-button chains-sources-button"
            onClick={openSources}
          >
            <Info size={14} /> Data sources
          </button>
        )}
      </div>
      {result.knownChain && (
        <nav className="chains-section-nav" aria-label="Chain sections">
          {!unsupportedEmpty && launchpadMode && (
            <a href="#chains-projects">Launchpads</a>
          )}
          <a href="#chains-overview">Overview</a>
          {chain === "all" && <a href="#chains-networks">Networks</a>}
          {!unsupportedEmpty && !launchpadMode && (
            <a href="#chains-projects">Protocols</a>
          )}
          <a href="#chains-method">Data notes</a>
        </nav>
      )}

      {!result.knownChain ? (
        <Empty
          title="Network not found"
          icon={<Network size={27} />}
          headingLevel={STATIC_EDITION ? 2 : 3}
          action={
            <button className="control" onClick={browseOtherNetworks}>
              Browse all networks
            </button>
          }
        >
          {STATIC_EDITION
            ? `This link names a network that is not in the ${fullTimeLabel(snapshot.generatedAt) ?? "saved"} snapshot. Choose a network to explore its v4 hooks and protocols.`
            : "This link names a network that is not in the current directory or pool index. Choose a network to explore its v4 hooks and protocols."}
        </Empty>
      ) : (
        <>
          {launchpadMode
            ? [catalog, networkOverview]
            : [networkOverview, catalog]}
          <details className="chains-method" id="chains-method">
            <summary>
              <Info size={14} /> About these numbers <ChevronDown size={14} />
            </summary>
            <div className="chains-method-body">
              <p>
                Projects are named families from the hook registry and
                documented first-party deployments. Categories describe recorded
                use cases; one project can have multiple roles. Hook and pool
                counts cover the selected network. A ≥ pool count is a known
                lower bound.
                {STATIC_EDITION
                  ? " In the project lists the count is the pools measured in this snapshot."
                  : ""}
              </p>
              <p>
                Volume covers tracked hook pools with measurements younger than
                five minutes{STATIC_EDITION ? " when the snapshot was taken" : ""}.
                It is not total Uniswap volume. Unavailable
                amounts remain blank and older observations are excluded.
                Reported reserves are provider valuations. Registry listings and
                shared names do not establish common ownership or endorsement.
              </p>
              <p>
                Launchpads and DEXs are reviewed product roles: a project gets
                one only when its official documentation describes that product
                and its listing matches an official site, or when Uniswap’s
                platform guide documents it. A launch platform may use its own hooks,
                shared hooks or hookless pools.
              </p>
              {openSources && (
                <button className="chains-text-button" onClick={openSources}>
                  View data sources <ArrowRight size={13} />
                </button>
              )}
            </div>
          </details>
        </>
      )}
    </section>
  );
}
