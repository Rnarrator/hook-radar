import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  MetricFreshness,
  RadarSnapshot,
  WindowKey,
} from "../../shared/types";
import { analyticsCsv, analyticsHistory, buildAnalytics } from "../analytics";
import type { AnalyticsHistoryRange, AnalyticsProject } from "../analytics";
import { analyticsCategorySlices } from "../analytics-chart-data";
import {
  categoryTradingSlices,
  metricCopy,
  metricShare,
  metricValue,
  workspaceFocusBreakdown,
} from "../analytics-focus";
import type { AnalyticsFocus, AnalyticsMetric } from "../analytics-focus";
import {
  BarTrack,
  RatioMeter,
  formatSince,
  formatCount,
  formatMoneyCompact,
  formatPercent,
  formatUtc,
  parseClock,
  useCaseColor,
} from "../charts/index";
import { historyExportTimes } from "../history-chart";
import { windows } from "../model";
import {
  STATIC_EDITION,
  censusLabel,
  poolsWithVolumeWords,
  timeLabel,
} from "../edition";
import { CensusNote } from "./EditionStatus";
import { ProtocolLogo } from "./ProtocolLogo";
import { AnalyticsHistory } from "./AnalyticsHistory";
import {
  AnalyticsComposition,
  AnalyticsContributors,
  AnalyticsControlBar,
  AnalyticsEvidence,
  AnalyticsReadouts,
  formatMetric,
  formatMetricExact,
} from "./AnalyticsCharts";
import type { ContributorsModel, FocusSummary } from "./AnalyticsCharts";
import { AnalyticsPoolExplorer } from "./AnalyticsPoolExplorer";
import {
  ArrowRight,
  Check,
  ChevronDown,
  Download,
  Info,
  Search,
  X,
} from "./Icons";
import "./analytics.css";

interface Props {
  snapshot: RadarSnapshot;
  windowKey: WindowKey;
  now: number;
  chain: string;
  range: AnalyticsHistoryRange;
  setChain: (chain: string) => void;
  setRange: (range: AnalyticsHistoryRange) => void;
  openProject: (id: string) => void;
  /** Absent where the page has no activity view (the static edition). */
  inspectActivity?: (projectId: string, chain: string) => void;
  browseHooks: (chain: string) => void;
  /** Opens the Data & sources dialog; omitted where the build has none. */
  openSources?: () => void;
  disabled?: boolean;
}

type ProjectOrder = "volumeUsd" | "liquidityUsd" | "activePools";
const ORDER_FOR: Record<AnalyticsMetric, ProjectOrder> = {
  volume: "volumeUsd",
  reserves: "liquidityUsd",
  trading: "activePools",
};
const METRIC_FOR: Record<ProjectOrder, AnalyticsMetric> = {
  volumeUsd: "volume",
  liquidityUsd: "reserves",
  activePools: "trading",
};

function age(value: string | null | undefined, now: number) {
  const stamp = parseClock(value);
  if (stamp === null) return "Not checked";
  if (STATIC_EDITION) return timeLabel(stamp) ?? "Not checked";
  const seconds = Math.max(0, Math.floor((now - stamp) / 1000));
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/** The complete Analytics investigation: what is measured → what changed →
 * who contributed → how fresh and complete the evidence is → drill down. */
export function AnalyticsWorkspace({
  snapshot,
  windowKey,
  now,
  chain,
  range,
  setChain,
  setRange,
  openProject,
  inspectActivity,
  browseHooks,
  openSources,
  disabled = false,
}: Props) {
  const result = useMemo(
    () => buildAnalytics(snapshot, { chain, windowKey, now }),
    [snapshot, chain, windowKey, now],
  );
  // Indexed pool counts are a dated export, not measured at the snapshot.
  const census = STATIC_EDITION
    ? censusLabel(snapshot.inventory, snapshot.generatedAt)
    : null;
  const [metric, setMetricState] = useState<AnalyticsMetric>("volume");
  const [focus, setFocus] = useState<AnalyticsFocus | null>(null);
  const [allProjects, setAllProjects] = useState(false);
  const [projectQuery, setProjectQuery] = useState("");
  const projectSearchInput = useRef<HTMLInputElement>(null);
  const [projectOrder, setProjectOrder] = useState<ProjectOrder>("volumeUsd");
  const [exportNotice, setExportNotice] = useState("");
  const exportTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => () => clearTimeout(exportTimer.current), []);
  useEffect(() => {
    setAllProjects(false);
    setProjectQuery("");
    setFocus(null);
  }, [chain, windowKey]);
  // The ranking follows the chosen metric; "Rank by" can still override it.
  const setMetric = (next: AnalyticsMetric) => {
    setMetricState(next);
    setProjectOrder(ORDER_FOR[next]);
  };
  useEffect(() => {
    if (!focus) return;
    const clear = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, select, textarea, [role='dialog']")) return;
      setFocus(null);
    };
    window.addEventListener("keydown", clear);
    return () => window.removeEventListener("keydown", clear);
  }, [focus]);

  const history = useMemo(
    () => analyticsHistory(result.history, range, now),
    [result.history, range, now],
  );
  const totals = result.totals;
  const copy = metricCopy(metric, windowKey);
  const networkOptions = useMemo(() => {
    const options = new Map(
      snapshot.chains.map((network) => [network.slug, network.name]),
    );
    for (const network of snapshot.inventory?.networks || [])
      options.set(network.chain, network.name);
    for (const pool of snapshot.pools)
      if (!options.has(pool.chain)) options.set(pool.chain, pool.chain);
    return [...options]
      .map(([slug, name]) => ({ slug, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [snapshot.chains, snapshot.inventory, snapshot.pools]);
  const networkName =
    networkOptions.find((network) => network.slug === chain)?.name || chain;
  const knownChain =
    chain === "all" || networkOptions.some((network) => network.slug === chain);
  const scopeLabel = chain === "all" ? "all networks" : networkName;
  const names = useMemo(
    () => new Map(result.networks.map((network) => [network.chain, network.name])),
    [result.networks],
  );

  const model = useMemo<ContributorsModel>(
    () => ({
      chain,
      windowKey,
      totals,
      networks: result.networks,
      categories: {
        volume: analyticsCategorySlices(result, "volume"),
        reserves: analyticsCategorySlices(result, "reserves"),
        trading: categoryTradingSlices(
          result.pools,
          metricValue(totals, "trading"),
        ),
      },
    }),
    [result, chain, windowKey, totals],
  );
  const breakdown = useMemo(
    () => (focus ? workspaceFocusBreakdown(result.pools, metric, focus) : null),
    [focus, metric, result.pools],
  );
  const projectsById = useMemo(
    () => new Map(result.projects.map((row) => [row.project.id, row])),
    [result.projects],
  );
  const focusLabel = !focus
    ? null
    : focus.kind === "network"
      ? names.get(focus.id) || focus.id
      : focus.kind === "category"
        ? focus.id
        : projectsById.get(focus.id)?.project.name || focus.id;
  const scopeTotal = metricValue(totals, metric);
  const focusSummary: FocusSummary | null =
    focus && focusLabel
      ? {
          kind:
            focus.kind === "network"
              ? "Network"
              : focus.kind === "category"
                ? "Use case"
                : "Project",
          label: focusLabel,
          detail: breakdown ? (
            <>
              {formatMetric(metric, breakdown.total.value)} of{" "}
              {formatMetric(metric, scopeTotal)}{" "}
              {copy.measure.toLowerCase()} ·{" "}
              {formatPercent(metricShare(breakdown.total.value, scopeTotal))} ·{" "}
              {formatCount(breakdown.total.pools)} measured{" "}
              {breakdown.total.pools === 1 ? "pool" : "pools"}
            </>
          ) : null,
          actions:
            focus.kind === "network" && chain === "all" ? (
              <button
                type="button"
                className="analytics-text-button"
                onClick={() => setChain(focus.id)}
                disabled={disabled}
              >
                View analytics on {focusLabel} <ArrowRight size={14} />
              </button>
            ) : focus.kind === "project" ? (
              <>
                <button
                  type="button"
                  className="analytics-text-button"
                  onClick={() => openProject(focus.id)}
                  disabled={disabled}
                >
                  Open project <ArrowRight size={14} />
                </button>
                {inspectActivity && (
                  <button
                    type="button"
                    className="analytics-text-button"
                    onClick={() => inspectActivity(focus.id, chain)}
                    disabled={disabled}
                  >
                    Activity <ArrowRight size={14} />
                  </button>
                )}
              </>
            ) : focus.kind === "category" ? (
              <button
                type="button"
                className="analytics-text-button"
                onClick={() => browseHooks(chain)}
                disabled={disabled}
              >
                Browse hooks <ArrowRight size={14} />
              </button>
            ) : null,
        }
      : null;

  // Leading hooks: ranked projects, cross-filtered by the active focus.
  const rankMetric = METRIC_FOR[projectOrder];
  const rankTotal = metricValue(totals, rankMetric);
  const rankBreakdown = useMemo(
    () =>
      focus && focus.kind === "network"
        ? workspaceFocusBreakdown(result.pools, rankMetric, focus)
        : null,
    [focus, rankMetric, result.pools],
  );
  const secondaryMetric: AnalyticsMetric =
    rankMetric === "reserves" ? "volume" : "reserves";
  const secondaryBreakdown = useMemo(
    () =>
      focus && focus.kind === "network"
        ? workspaceFocusBreakdown(result.pools, secondaryMetric, focus)
        : null,
    [focus, secondaryMetric, result.pools],
  );
  const rankedProjects = useMemo(() => {
    const query = projectQuery.trim().toLocaleLowerCase();
    const rankValue = (row: AnalyticsProject) =>
      rankBreakdown
        ? (rankBreakdown.projects.get(row.project.id)?.value ?? null)
        : metricValue(row, rankMetric);
    return result.projects
      .filter(
        (row) =>
          !query ||
          `${row.project.name} ${row.project.category} ${row.project.chains.join(" ")}`
            .toLocaleLowerCase()
            .includes(query),
      )
      .filter((row) =>
        !focus
          ? true
          : focus.kind === "category"
            ? row.project.category === focus.id
            : focus.kind === "network"
              ? (rankBreakdown?.projects.get(row.project.id)?.pools ?? 0) > 0
              : true,
      )
      .map((row) => ({ row, value: rankValue(row) }))
      .sort(
        (a, b) =>
          (b.value ?? -1) - (a.value ?? -1) ||
          a.row.project.name.localeCompare(b.row.project.name),
      );
  }, [result.projects, projectQuery, rankMetric, rankBreakdown, focus]);
  const projectLimit = allProjects ? 30 : 8;
  const shownProjects = rankedProjects.slice(0, projectLimit);
  const missingVolume = totals.unattributedVolumeUsd;
  const hasCurrent = totals.volumePools > 0 || totals.liquidityPools > 0;
  const volumeFreshness = totals.freshness.volume[windowKey];
  const reserveFreshness = totals.freshness.liquidity;
  const measuredNetworkCount = result.networks.filter(
    (network) => network.volumePools > 0 || network.liquidityPools > 0,
  ).length;

  function clearProjectSearch() {
    setProjectQuery("");
    setAllProjects(false);
    projectSearchInput.current?.focus();
  }

  function download() {
    if (disabled) return;
    clearTimeout(exportTimer.current);
    try {
      const blob = new Blob(
        [
          analyticsCsv(
            result,
            STATIC_EDITION
              ? {
                  edition: true,
                  censusAsOf: snapshot.inventory?.generatedAt ?? null,
                }
              : undefined,
          ),
        ],
        { type: "text/csv;charset=utf-8" },
      );
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      // The edition's `now` is the snapshot's time: the file is dated the day it
      // is made (live, `now` is today, so the name is the same as before).
      link.download = `hook-radar-analytics-${chain}-${windowKey}-${historyExportTimes(now).exportedAt.slice(0, 10)}.csv`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExportNotice("CSV downloaded");
    } catch {
      setExportNotice("Download unavailable. Please retry.");
    }
    exportTimer.current = setTimeout(() => setExportNotice(""), 5000);
  }

  const historyFirst = result.historyAvailable && result.history.length > 0;
  // See AnalyticsOverview: no panel that only says there is nothing to chart.
  // The snapshot holds the all-network series whichever network is shown.
  const seriesRecorded = useMemo(
    () => analyticsHistory(snapshot.history, "all", now).length > 0,
    [snapshot.history, now],
  );
  const showHistory = result.historyAvailable
    ? result.history.length > 0
    : seriesRecorded;
  const historyPanel = (
    <AnalyticsHistory
      points={history}
      allPoints={result.history.length}
      available={result.historyAvailable}
      range={range}
      setRange={setRange}
      showAllNetworks={() => setChain("all")}
      metric={metric}
      now={now}
      disabled={disabled}
      kicker={historyFirst ? "02 · What changed" : "What changed"}
    />
  );

  const rankCopy = metricCopy(rankMetric, windowKey);
  const leadingHooks = (
    <section
      className="analytics-hooks-plate plate"
      id="analytics-hooks"
      aria-labelledby="analytics-projects-heading"
    >
      <div className="analytics-panel-heading">
        <div>
          <span className="analytics-section-number">Projects &amp; hooks</span>
          <h3 id="analytics-projects-heading">Leading hooks</h3>
          <p className="analytics-panel-caption">
            {rankCopy.measure}
            {focus?.kind === "network" ? ` on ${focusLabel} only` : ""}
            {focus && focus.kind !== "network" ? ` · focus: ${focusLabel}` : ""}{" "}
            · bars and percentages are shares {rankCopy.denominator} in{" "}
            {scopeLabel}
          </p>
        </div>
        <span className="analytics-panel-count">
          {formatCount(rankedProjects.length)}{" "}
          {STATIC_EDITION
            ? rankedProjects.length === 1
              ? "project or unnamed hook"
              : "projects and unnamed hooks"
            : rankedProjects.length === 1
              ? "hook"
              : "hooks"}{" "}
          with current measurements
        </span>
      </div>
      <div className="analytics-project-tools">
        <div className="analytics-project-search">
          <Search size={15} />
          <input
            ref={projectSearchInput}
            aria-label="Find a hook in rankings"
            type="search"
            placeholder="Find a hook, use case or network…"
            maxLength={160}
            value={projectQuery}
            onChange={(event) => {
              setProjectQuery(event.target.value);
              setAllProjects(false);
            }}
            disabled={disabled}
          />
          {projectQuery && (
            <button
              type="button"
              className="icon-button"
              aria-label="Clear rankings search"
              title="Clear rankings search"
              onClick={clearProjectSearch}
              disabled={disabled}
            >
              <X size={16} />
            </button>
          )}
        </div>
        <label className="select-control analytics-project-sort">
          <span>Rank by</span>
          <select
            aria-label="Rank hooks by"
            value={projectOrder}
            onChange={(event) =>
              setProjectOrder(event.target.value as ProjectOrder)
            }
            disabled={disabled}
          >
            <option value="volumeUsd">Trading volume</option>
            <option value="liquidityUsd">Reported reserves</option>
            <option value="activePools">Pools with trading</option>
          </select>
          <ChevronDown size={14} />
        </label>
      </div>
      {shownProjects.length ? (
        <>
          <div
            className="analytics-ranking-columns analytics-project-columns"
            aria-hidden="true"
          >
            <span />
            <span>Hook / use case</span>
            <span>
              {rankCopy.name}
              {focus?.kind === "network" ? ` on ${focusLabel}` : ""} · share
            </span>
            <span>
              {rankMetric === "reserves"
                ? `${windows[windowKey]} volume`
                : "Reported reserves"}
            </span>
            <span />
          </div>
          <ol className="analytics-project-list">
            {shownProjects.map(({ row, value }, index) => {
              const share = metricShare(value, rankTotal);
              const selected =
                focus?.kind === "project" && focus.id === row.project.id;
              const secondaryReserves = rankMetric !== "reserves";
              const onNetwork = rankBreakdown?.projects.get(row.project.id);
              const secondarySlice = secondaryBreakdown?.projects.get(
                row.project.id,
              );
              const secondaryValue = secondaryBreakdown
                ? (secondarySlice?.value ?? null)
                : secondaryReserves
                  ? row.liquidityUsd
                  : row.volumeUsd;
              const secondaryPools = secondaryBreakdown
                ? (secondarySlice?.pools ?? 0)
                : secondaryReserves
                  ? row.liquidityPools
                  : row.volumePools;
              return (
                <li
                  key={row.project.id}
                  data-selected={selected || undefined}
                  data-dimmed={
                    (focus?.kind === "project" && !selected) || undefined
                  }
                >
                  <span className="analytics-rank">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <button
                    type="button"
                    className="analytics-project-identity"
                    onClick={() => openProject(row.project.id)}
                    disabled={disabled}
                    aria-label={`Open ${row.project.name} project`}
                  >
                    <ProtocolLogo project={row.project} />
                    <span>
                      <strong title={row.project.name}>
                        {row.project.name}
                      </strong>
                      <span>
                        <span
                          className="category-tag"
                          data-category={row.project.category}
                        >
                          {row.project.category}
                        </span>
                        {onNetwork ? (
                          <>
                            {formatCount(onNetwork.pools)}{" "}
                            {onNetwork.pools === 1 ? "pool" : "pools"} on{" "}
                            {focusLabel}
                          </>
                        ) : (
                          <>
                            {formatCount(row.volumePools)}{" "}
                            {row.volumePools === 1 ? "pool" : "pools"}{" "}
                            {poolsWithVolumeWords()}
                          </>
                        )}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="analytics-project-bar"
                    aria-pressed={selected}
                    disabled={disabled}
                    onClick={() =>
                      setFocus(
                        selected ? null : { kind: "project", id: row.project.id },
                      )
                    }
                    aria-label={`${row.project.name}: ${formatMetricExact(rankMetric, value)}${share === null ? "" : `, ${formatPercent(share)} ${rankCopy.denominator}`}. Focus project.`}
                    title="Focus this project across charts and tables"
                  >
                    <span className="analytics-project-value">
                      <strong>{formatMetric(rankMetric, value)}</strong>
                      <small>{formatPercent(share)}</small>
                    </span>
                    <BarTrack
                      share={value === null ? null : (share ?? (value === 0 ? 0 : null))}
                      color={useCaseColor(row.project.category)}
                    />
                  </button>
                  <span className="analytics-project-reserves">
                    <span className="analytics-mobile-metric-label">
                      {secondaryReserves
                        ? "Reported reserves"
                        : `${windows[windowKey]} volume`}
                    </span>
                    <strong>{formatMoneyCompact(secondaryValue)}</strong>
                    <small>
                      {formatCount(secondaryPools)}{" "}
                      {secondaryPools === 1 ? "pool" : "pools"}
                      {secondaryBreakdown ? ` on ${focusLabel}` : ""}
                    </small>
                  </span>
                  {inspectActivity && (
                    <button
                      type="button"
                      className="analytics-event-button icon-button"
                      onClick={() => inspectActivity(row.project.id, chain)}
                      disabled={disabled}
                      aria-label={`Inspect ${row.project.name} activity`}
                      title={`Inspect ${row.project.name} onchain activity`}
                    >
                      <ArrowRight size={14} />
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
          {!focus && (totals.unlistedProjects > 0 || missingVolume !== null) && (
            <p className="analytics-ranking-note">
              Some measured pools are not matched to a loaded project. Their
              amounts remain in network totals
              {missingVolume !== null && missingVolume > 0
                ? ` (${formatMoneyCompact(missingVolume)} tracked volume)`
                : ""}
              .
            </p>
          )}
          {rankedProjects.length > 8 && (
            <button
              type="button"
              className="analytics-expand"
              aria-expanded={allProjects}
              onClick={() => setAllProjects(!allProjects)}
            >
              {allProjects
                ? "Show fewer hooks"
                : `Show top ${Math.min(30, rankedProjects.length)} hooks`}
              <ChevronDown size={14} />
            </button>
          )}
          {allProjects && rankedProjects.length > 30 && (
            <p className="analytics-ranking-note">
              Showing the top 30 of {formatCount(rankedProjects.length)}{" "}
              {STATIC_EDITION ? "projects and unnamed hooks" : "hooks"} with
              current measurements.
            </p>
          )}
        </>
      ) : (
        <AnalyticsEmpty
          title={
            projectQuery
              ? "No matching hooks"
              : focus
                ? `No hooks with current data in ${focusLabel}`
                : "No hooks with current market data"
          }
          description={
            projectQuery
              ? `Try a project name, use case or network. Rankings include ${STATIC_EDITION ? "projects and unnamed hooks" : "hooks"} with current measurements.`
              : "Older measurements do not enter this ranking. Browse the directory for hook contracts, capabilities and pools."
          }
          action={
            <button
              type="button"
              className="analytics-text-button"
              onClick={() =>
                projectQuery ? clearProjectSearch() : browseHooks(chain)
              }
              disabled={disabled}
            >
              {projectQuery ? "Clear search" : "Browse hooks"}{" "}
              <ArrowRight size={14} />
            </button>
          }
        />
      )}
      <p className="analytics-panel-footnote">
        {rankMetric === "trading"
          ? "Pools with trading counts pools with positive current volume; a pool without a current volume measurement is not counted. "
          : "Pool counts under each hook do not indicate trading. "}
        Shares are {rankCopy.denominator} in{" "}
        {chain === "all" ? "this view" : networkName}, not ecosystem market
        share. Bar colour is the hook’s use case.
      </p>
    </section>
  );

  const footprint = (
    <section
      className="analytics-footprint-panel plate"
      aria-labelledby="analytics-footprint-heading"
    >
      <div className="analytics-panel-heading">
        <div>
          <span className="analytics-section-number">Index coverage</span>
          <h3 id="analytics-footprint-heading">Onchain footprint</h3>
          <p className="analytics-panel-caption">
            PoolManager history, independent of USD pricing.
          </p>
          <CensusNote label={census} />
        </div>
        <button
          type="button"
          className="analytics-text-button"
          onClick={() => browseHooks(chain)}
          disabled={disabled}
        >
          Browse hooks <ArrowRight size={14} />
        </button>
      </div>
      <div className="analytics-footprint-summary">
        <span>
          <strong>{formatCount(result.inventory.hookPoolCount)}</strong> hook
          pools
        </span>
        <span>
          {STATIC_EDITION && result.inventory.hookCount !== null && "at least "}
          <strong>{formatCount(result.inventory.hookCount)}</strong> hook
          contracts
        </span>
        <span>
          <strong>
            {formatCount(result.inventory.caughtUpChains)} /{" "}
            {formatCount(result.inventory.networks.length)}
          </strong>{" "}
          captured targets reached
        </span>
      </div>
      {result.inventory.networks.length ? (
        <div
          className="analytics-footprint-scroll"
          tabIndex={0}
          role="region"
          aria-label="Network pool inventory"
          aria-describedby="analytics-footprint-note"
        >
          <table className="analytics-footprint-table">
            <thead>
              <tr>
                <th scope="col">Network</th>
                <th scope="col">Hook pools</th>
                <th scope="col">All v4 pools</th>
                <th scope="col">
                  {STATIC_EDITION ? "Hook contracts (at least)" : "Hook contracts"}
                </th>
                <th scope="col">History scanned</th>
                <th scope="col">Target checked</th>
                <th scope="col">
                  <span className="sr-only">Explore</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {result.inventory.networks.map((network) => {
                const measured = result.networks.find(
                  (row) => row.chain === network.chain,
                );
                const reached = measured?.caughtUp || false;
                const fresh = measured?.headFresh || false;
                const checked = parseClock(network.headCheckedAt);
                return (
                  <tr
                    key={network.chain}
                    data-focused={
                      (focus?.kind === "network" && focus.id === network.chain) ||
                      undefined
                    }
                  >
                    <th scope="row">{network.name}</th>
                    <td>{formatCount(network.hookPoolCount)}</td>
                    <td>{formatCount(network.poolCount)}</td>
                    <td>{formatCount(network.hookCount)}</td>
                    <td>
                      <span
                        className={`analytics-index-state ${reached ? "reached" : "pending"}`}
                      >
                        <span
                          className={`status-led ${reached ? "green" : "amber"}`}
                        />
                        {reached
                          ? "Target reached"
                          : network.status === "error" ||
                              network.status === "unavailable"
                            ? "Check unavailable"
                            : network.status === "queued"
                              ? "Queued"
                              : "Syncing"}
                      </span>
                      <span className="analytics-block-range">
                        {formatCount(network.scannedToBlock)} /{" "}
                        {formatCount(network.targetBlock)}
                      </span>
                    </td>
                    <td>
                      <time
                        dateTime={network.headCheckedAt || undefined}
                        title={
                          checked === null
                            ? "Time unavailable"
                            : formatUtc(checked)
                        }
                        className={
                          fresh ? "analytics-head-current" : "analytics-head-old"
                        }
                      >
                        {age(network.headCheckedAt, now)}
                      </time>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="analytics-event-button icon-button"
                        onClick={() => browseHooks(network.chain)}
                        disabled={disabled}
                        aria-label={`Browse hooks on ${network.name}`}
                        title={`Browse hooks on ${network.name}`}
                      >
                        <ArrowRight size={14} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <AnalyticsEmpty
          title={
            STATIC_EDITION
              ? "No pool inventory for this scope in the census"
              : "Pool inventory is not available yet"
          }
          description={
            STATIC_EDITION
              ? "Network rows come from the dated census export. Market measurements and the census are separate."
              : "Network rows appear after saved PoolManager history has been loaded. Market measurements and inventory sync are tracked separately."
          }
        />
      )}
      {result.inventory.networks.length > 0 && (
        <p className="analytics-scroll-hint" aria-hidden="true">
          Swipe the table sideways for scan status and head checks →
        </p>
      )}
      <p id="analytics-footprint-note" className="analytics-panel-footnote">
        A reached target verifies the captured block range. It does not mean a
        new chain head has just been checked. Hook contracts are counted per
        network; they are not unique teams or active users.
        {STATIC_EDITION && " Newer hooks are not included."}
      </p>
    </section>
  );

  const pricing = useMemo(() => {
    const networks = (snapshot.marketCoverage?.networks || []).filter(
      (network) => chain === "all" || network.chain === chain,
    );
    if (!networks.length) return null;
    const sums = networks.reduce(
      (sum, network) => ({
        indexed: sum.indexed + network.inventoryPools,
        checked: sum.checked + network.checkedPools,
        measured: sum.measured + network.measuredPools,
        missing: sum.missing + network.missingPools,
        pending: sum.pending + network.pendingPools,
      }),
      { indexed: 0, checked: 0, measured: 0, missing: 0, pending: 0 },
    );
    // The population is the dated census; the edition says so beside the count.
    if (!STATIC_EDITION) return sums;
    // Census networks with no pricing row: the count above is not the census's
    // own total, and the page says so.
    const unlisted =
      chain === "all"
        ? (snapshot.inventory?.networks ?? []).filter(
            (network) =>
              network.hookPoolCount > 0 &&
              !networks.some((row) => row.chainId === network.chainId),
          )
        : [];
    return {
      ...sums,
      census,
      networks: networks.length,
      // Networks where a source responded: that is what "checked" means.
      checkedNetworks: networks.filter((network) => network.checkedPools > 0)
        .length,
      unlistedNetworks: unlisted.length,
      unlistedPools: unlisted.reduce(
        (total, network) => total + network.hookPoolCount,
        0,
      ),
    };
  }, [snapshot.marketCoverage, snapshot.inventory, chain, census]);

  return (
    <section className="analytics-workspace" aria-label="Hook analytics">
      <AnalyticsControlBar
        sections={[
          ["#analytics-overview", "Measured"],
          ...(showHistory
            ? ([["#analytics-history", "Change"]] as const)
            : []),
          ["#analytics-composition", "Contributors"],
          ["#analytics-coverage", "Evidence"],
          ["#analytics-pools", "Pools"],
        ]}
        metric={metric}
        setMetric={setMetric}
        chain={chain}
        setChain={setChain}
        networks={networkOptions}
        unknownChain={!knownChain}
        windowLabel={`${windows[windowKey]} window`}
        focus={focusSummary}
        clearFocus={() => setFocus(null)}
        disabled={disabled}
        actions={
          <>
            {openSources && (
              <button
                type="button"
                className="analytics-text-button"
                onClick={openSources}
              >
                <Info size={14} /> Data sources
              </button>
            )}
            <button
              type="button"
              className="control"
              onClick={download}
              disabled={disabled}
              aria-label="Export analytics CSV"
              title="Export current market measurements and network inventory (original measurement clocks)"
            >
              {exportNotice === "CSV downloaded" ? (
                <Check size={14} />
              ) : (
                <Download size={14} />
              )}
              <span>Export CSV</span>
            </button>
          </>
        }
      />
      <p className="analytics-export-notice" role="status">
        {exportNotice}
      </p>
      {!knownChain && (
        <div className="analytics-invalid-scope notice" role="status">
          <Info size={16} />
          <span>
            {STATIC_EDITION
              ? "This network is not in this snapshot."
              : "This network is not in the current directory."}
          </span>
          <button
            type="button"
            className="analytics-text-button"
            onClick={() => setChain("all")}
          >
            Show all networks <ArrowRight size={14} />
          </button>
        </div>
      )}

      <AnalyticsReadouts
        kicker="01 · At a glance"
        metric={metric}
        setMetric={setMetric}
        disabled={disabled}
        scope={
          <>
            <span className="analytics-coverage-badge">
              Partial coverage · Not total Uniswap volume
            </span>
            <span>
              Hook pools Radar can price · {chain === "all" ? "All networks" : networkName}{" "}
              · {windows[windowKey]} window ·{" "}
              {STATIC_EDITION
                ? "measured within 5 minutes of the snapshot"
                : "measured within the last 5 minutes"}
            </span>
          </>
        }
        items={[
          {
            key: "volume",
            primary: true,
            label: <>Trading volume · {windows[windowKey]}</>,
            value: formatMoneyCompact(totals.volumeUsd),
            exact: formatMetricExact("volume", totals.volumeUsd),
            testId: "analytics-volume",
            caption: (
              <Measurement freshness={totals.freshness.volume[windowKey]} now={now} />
            ),
          },
          {
            key: "reserves",
            label: "Reserves held in pools",
            value: formatMoneyCompact(totals.liquidityUsd),
            exact: formatMetricExact("reserves", totals.liquidityUsd),
            testId: "analytics-liquidity",
            caption: (
              <Measurement freshness={totals.freshness.liquidity} now={now} />
            ),
          },
          {
            key: "trading",
            label: "Pools with trading",
            value: totals.volumePools ? formatCount(totals.activePools) : "—",
            testId: "analytics-active-pools",
            caption: (
              <span className="analytics-metric-caption">
                {totals.volumePools
                  ? `Of ${formatCount(totals.volumePools)} pools with current volume`
                  : STATIC_EDITION
                    ? "No current volume measurements"
                    : "Awaiting current volume measurements"}
                {totals.volumePools > 0 && (
                  <RatioMeter ratio={totals.activePools / totals.volumePools} />
                )}
              </span>
            ),
          },
          {
            key: "projects",
            // Unnamed hooks are counted one by one beside the named projects.
            label: STATIC_EDITION ? (
              <>Measured projects &amp; unnamed hooks</>
            ) : (
              <>Measured projects &amp; hooks</>
            ),
            value: hasCurrent ? formatCount(totals.attributedProjects) : "—",
            testId: "analytics-measured-projects",
            caption: (
              <span className="analytics-metric-caption">
                {formatCount(measuredNetworkCount)}{" "}
                {measuredNetworkCount === 1 ? "network" : "networks"} with
                volume or reserve data
              </span>
            ),
          },
        ]}
        composition={
          <AnalyticsComposition
            model={model}
            metric={metric}
            focus={focus}
            setFocus={setFocus}
            disabled={disabled}
          />
        }
        method={
          <details className="analytics-method">
            <summary>
              <span className={`status-led ${hasCurrent ? "green" : "amber"}`} />
              <span>
                {hasCurrent
                  ? STATIC_EDITION
                    ? "All figures are current as of the snapshot"
                    : "All figures are current"
                  : STATIC_EDITION
                    ? chain === "all"
                      ? "No current market data in this snapshot"
                      : `No current market data for ${scopeLabel} in this snapshot`
                    : "Waiting for current market data"}
              </span>
              <span className="analytics-method-summary">
                How these numbers are measured
              </span>
              <ChevronDown size={14} />
            </summary>
            <div className="analytics-method-body">
              <p>
                Volume and reserve totals include only tracked v4 pools with
                hooks and measurements less than five minutes old
                {STATIC_EDITION ? " when the snapshot was taken" : ""}. Each
                pool is counted once. Missing amounts stay unavailable; a measured zero
                stays zero. Uniswap v2, v3 and v4 pools without hooks are
                excluded.
              </p>
              <p>
                Coverage, rolling time windows and USD valuations can differ
                from Uniswap’s figures. A network with volume or reserve data
                may still have unmeasured pools. Shares use tracked volume in
                this view; the percentage of all hook trading volume covered is
                not verified. Reserves are provider valuations, not executable
                liquidity or protocol TVL.
              </p>
              {(volumeFreshness.stalePools > 0 ||
                volumeFreshness.unknownPools > 0) && (
                <p>
                  Excluded from volume: {formatCount(volumeFreshness.stalePools)}{" "}
                  older observations; {formatCount(volumeFreshness.unknownPools)}{" "}
                  observations with unverified freshness.
                </p>
              )}
              {(reserveFreshness.stalePools > 0 ||
                reserveFreshness.unknownPools > 0) && (
                <p>
                  Excluded from reserves:{" "}
                  {formatCount(reserveFreshness.stalePools)} older observations;{" "}
                  {formatCount(reserveFreshness.unknownPools)} observations with
                  unverified freshness.
                </p>
              )}
              {openSources && (
                <button
                  type="button"
                  className="analytics-text-button"
                  onClick={openSources}
                >
                  Check coverage and sources <ArrowRight size={14} />
                </button>
              )}
            </div>
          </details>
        }
      />

      {historyFirst && historyPanel}

      <AnalyticsContributors
        kicker={historyFirst ? "03 · Who contributed" : "02 · Who contributed"}
        title="Networks, use cases and hooks behind the total"
        model={model}
        metric={metric}
        focus={focus}
        setFocus={setFocus}
        breakdown={breakdown}
        focusLabel={focusLabel}
        scopeLabel={scopeLabel}
        proof={
          metric === "reserves"
            ? totals.freshness.liquidity
            : totals.freshness.volume[windowKey]
        }
        now={now}
        disabled={disabled}
      >
        {leadingHooks}
      </AnalyticsContributors>

      <AnalyticsEvidence
        kicker={historyFirst ? "04 · Evidence" : "03 · Evidence"}
        windowKey={windowKey}
        metric={metric}
        now={now}
        samplePools={totals.samplePools}
        freshness={totals.freshness}
        publishedAt={result.snapshotAt}
        evaluatedAt={result.asOf}
        inventory={
          result.inventory.networks.length
            ? {
                hookPools: result.inventory.hookPoolCount,
                hookContracts: result.inventory.hookCount,
                networks: result.inventory.networks.length,
                caughtUp: result.inventory.caughtUpChains,
                census,
              }
            : null
        }
        pricing={pricing}
        sourceCount={snapshot.sources.length}
        openSources={openSources}
        scopeLabel={chain === "all" ? "All networks" : networkName}
      >
        {footprint}
      </AnalyticsEvidence>

      {showHistory && !historyFirst && historyPanel}

      <div id="analytics-pools" className="analytics-anchor analytics-step">
        <header className="analytics-step-head">
          <span className="analytics-step-kicker">
            {historyFirst ? "05 · Drill down" : "04 · Drill down"}
          </span>
          <h2>Pools behind the numbers</h2>
          <p>
            Every current pool measurement in {scopeLabel}
            {focus && focusLabel ? `, focused on ${focusLabel}` : ""}. Select a
            point or row to open its project
            {STATIC_EDITION ? " or source" : ", activity or source"}.
          </p>
        </header>
        <AnalyticsPoolExplorer
          result={result}
          windowKey={windowKey}
          disabled={disabled}
          openProject={openProject}
          inspectActivity={inspectActivity}
          focus={focus}
          focusLabel={focusLabel}
          setFocus={setFocus}
        />
      </div>
    </section>
  );
}

function Measurement({
  freshness,
  now,
}: {
  freshness: MetricFreshness;
  now: number;
}) {
  if (!freshness.currentPools)
    return (
      <span className="analytics-metric-caption">
        {STATIC_EDITION
          ? "No current measurements"
          : "Awaiting current measurements"}
      </span>
    );
  const oldest = parseClock(freshness.oldestAt);
  const title = `${formatCount(freshness.currentPools)} exact pools contribute. Oldest current measurement: ${oldest === null ? "time unavailable" : formatUtc(oldest)}. Only observations younger than five minutes${STATIC_EDITION ? " when the snapshot was taken" : ""} contribute; source clocks allow one minute of skew.${freshness.stalePools ? ` ${formatCount(freshness.stalePools)} older observations excluded.` : ""}${freshness.unknownPools ? ` ${formatCount(freshness.unknownPools)} observations with unverified freshness excluded.` : ""}`;
  return (
    <span className="analytics-metric-caption analytics-measurement" title={title}>
      <span className="analytics-dot" aria-hidden="true" />
      {formatCount(freshness.currentPools)}{" "}
      {freshness.currentPools === 1 ? "pool" : "pools"} ·{" "}
      <time dateTime={freshness.oldestAt || undefined}>
        oldest {oldest === null ? "unknown" : formatSince(oldest, now)}
      </time>
    </span>
  );
}

export function AnalyticsEmpty({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="analytics-empty">
      <Info size={19} />
      <strong>{title}</strong>
      <p>{description}</p>
      {action}
    </div>
  );
}
