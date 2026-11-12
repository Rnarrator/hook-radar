import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { AnalyticsResult } from "../analytics";
import type { WindowKey } from "../../shared/types";
import {
  analyticsPoolKey,
  poolChartAxis,
  poolMeasurement,
  poolScatterCohort,
  sortAnalyticsPools,
  POOL_PAGE_SIZE,
} from "../analytics-pools";
import type { PoolScale, PoolSort } from "../analytics-pools";
import { matchesFocus, poolCategory } from "../analytics-focus";
import type { AnalyticsFocus } from "../analytics-focus";
import {
  BarTrack,
  ChartFrame,
  Scatter,
  formatAge,
  formatCount,
  formatMoneyAxis,
  formatMoneyCompact,
  formatPercent,
  formatUtc,
  formatUtcClock,
  parseClock,
  useCaseColor,
} from "../charts/index";
import { shortAddress, windows } from "../model";
import { STATIC_EDITION } from "../edition";
import { spanLabel } from "../daily";
import { useDailyView } from "../daily-view";
import { DailyAmount } from "./DailyAmount";
import { ProtocolLogo } from "./ProtocolLogo";
import { External } from "./Primitives";
import {
  ArrowDown,
  ArrowUp,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Search,
  X,
} from "./Icons";
import "./analytics-pools.css";

interface Props {
  result: AnalyticsResult;
  windowKey: WindowKey;
  disabled?: boolean;
  openProject: (id: string) => void;
  /** Absent where the page has no activity view (the static edition). */
  inspectActivity?: (projectId: string, chain: string) => void;
  focus?: AnalyticsFocus | null;
  focusLabel?: string | null;
  setFocus?: (focus: AnalyticsFocus | null) => void;
}

function exactMoney(value: number | null) {
  const valid = poolMeasurement(value);
  return valid === null
    ? "No current measurement"
    : valid > 0 && valid < 0.000001
      ? `$${valid.toExponential(5)}`
      : valid.toLocaleString("en-US", {
          style: "currency",
          currency: "USD",
          maximumFractionDigits: 8,
        });
}

function axisMoney(value: number) {
  if (value === 0) return "$0";
  if (value < 0.01 || value >= 1e15)
    return `$${value.toExponential(1).replace(".0e", "e")}`;
  return formatMoneyAxis(value);
}

/** Drill down: the distribution of current pools (reserves vs volume, use-case
 * colour) and the complete pool table, both cross-filtered by the focus. */
export function AnalyticsPoolExplorer({
  result,
  windowKey,
  disabled = false,
  openProject,
  inspectActivity,
  focus = null,
  focusLabel = null,
  setFocus,
}: Props) {
  const chartId = useId().replace(/:/g, "");
  const tableId = useId();
  // Edition: 7D or 30D of the largest pools, as one more column. The window
  // beneath is always 24H, so the 24H column, the scatter and the readouts stay
  // as they are and say 24H.
  const daily = useDailyView();
  const spanKey = STATIC_EDITION && windowKey === "h24" ? daily.span : null;
  const spanText = spanKey ? spanLabel(spanKey) : null;
  const lens = spanKey ? daily.lens : null;
  const searchRef = useRef<HTMLInputElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState<PoolScale>("log");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<PoolSort>(spanKey ? "span" : "volume");
  const [ascending, setAscending] = useState(false);
  const [page, setPage] = useState(0);
  // The pools are ordered by the figure the page leads with: the span's while one
  // is chosen, the 24H volume when it is not.
  useEffect(() => {
    if (spanKey && sort === "volume") {
      setSort("span");
      setAscending(false);
    } else if (!spanKey && sort === "span") {
      setSort("volume");
      setAscending(false);
    }
    // Only a change of span moves the order; the visitor's own choice stays.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spanKey]);
  useEffect(() => {
    setPage(0);
    setSelectedKey(null);
  }, [result.chain, windowKey, focus?.kind, focus?.id]);
  const names = useMemo(
    () =>
      new Map(result.networks.map((network) => [network.chain, network.name])),
    [result.networks],
  );
  const scoped = useMemo(
    () => result.pools.filter((row) => matchesFocus(row, focus)),
    [result.pools, focus],
  );
  const cohort = useMemo(() => poolScatterCohort(scoped), [scoped]);
  const rows = useMemo(
    () => sortAnalyticsPools(scoped, sort, ascending, query, names, lens),
    [scoped, sort, ascending, query, names, lens],
  );
  const pageCount = Math.max(1, Math.ceil(rows.length / POOL_PAGE_SIZE));
  const activePage = Math.min(page, pageCount - 1);
  const pageRows = rows.slice(
    activePage * POOL_PAGE_SIZE,
    (activePage + 1) * POOL_PAGE_SIZE,
  );
  const activeIndex = Math.max(
    0,
    cohort.rows.findIndex((row) => analyticsPoolKey(row) === selectedKey),
  );
  const selected = cohort.rows[activeIndex];
  const x = useMemo(
    () =>
      poolChartAxis(
        cohort.rows.map((row) => row.liquidityUsd!),
        scale,
      ),
    [cohort.rows, scale],
  );
  const y = useMemo(
    () =>
      poolChartAxis(
        cohort.rows.map((row) => row.volumeUsd!),
        scale,
      ),
    [cohort.rows, scale],
  );
  const legend = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of cohort.rows)
      counts.set(poolCategory(row), (counts.get(poolCategory(row)) || 0) + 1);
    return [...counts].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    );
  }, [cohort.rows]);
  const volumeLabel = `Tracked ${windows[windowKey]} volume`;

  function selectIndex(index: number) {
    if (!disabled && cohort.rows[index])
      setSelectedKey(analyticsPoolKey(cohort.rows[index]));
  }
  function changeSort(next: PoolSort) {
    setSort(next);
    setAscending(next === sort ? !ascending : next === "name");
    setPage(0);
  }
  function findInTable(address: string) {
    setQuery(address);
    setPage(0);
    tableRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    window.setTimeout(() => searchRef.current?.focus({ preventScroll: true }), 300);
  }
  const sortButton = (key: PoolSort, label: string) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => changeSort(key)}
      aria-label={`Sort pools by ${label.toLowerCase()}`}
    >
      {label}
      {sort === key ? (
        ascending ? (
          <ArrowUp size={13} />
        ) : (
          <ArrowDown size={13} />
        )
      ) : (
        <span className="pool-sort-space" />
      )}
    </button>
  );
  const focusChip =
    focus && focusLabel && setFocus ? (
      <button
        type="button"
        className="analytics-focus-chip"
        onClick={() => setFocus(null)}
        aria-label={`Clear focus on ${focusLabel}`}
      >
        <span>Focused on</span> <strong>{focusLabel}</strong>
        <X size={14} />
      </button>
    ) : null;
  const measuredAt = selected ? parseClock(selected.pool.metricUpdatedAt) : null;

  return (
    <section
      className="analytics-pool-explorer"
      aria-label="Pool market analytics"
    >
      <ChartFrame
        className="analytics-pool-scatter"
        kicker="Pool distribution"
        title="Tracked volume & reserves"
        caption={
          <>
            <span className="pool-chart-cohort">
              {cohort.eligible > cohort.rows.length
                ? `Top ${formatCount(cohort.rows.length)} of ${formatCount(cohort.eligible)} eligible pools · ranked by tracked volume`
                : `${formatCount(cohort.rows.length)} ${cohort.rows.length === 1 ? "pool" : "pools"} with current, positive volume and reserves`}
            </span>
            {focusLabel && (
              <>
                <span aria-hidden="true">·</span>
                <span>focus: {focusLabel}</span>
              </>
            )}
          </>
        }
        controls={
          <div
            className="segmented pool-scale-control"
            role="group"
            aria-label="Pool chart scale"
          >
            <button
              type="button"
              aria-pressed={scale === "log"}
              onClick={() => setScale("log")}
              disabled={disabled}
            >
              Log
            </button>
            <button
              type="button"
              aria-pressed={scale === "linear"}
              onClick={() => setScale("linear")}
              disabled={disabled}
            >
              Linear
            </button>
          </div>
        }
        legend={
          legend.length ? (
            <ul className="pool-chart-legend" aria-label="Use cases in this plot">
              {legend.map(([category, count]) => {
                const pressed =
                  focus?.kind === "category" && focus.id === category;
                return (
                  <li key={category}>
                    <button
                      type="button"
                      aria-pressed={pressed}
                      disabled={disabled || !setFocus}
                      onClick={() =>
                        setFocus?.(
                          pressed ? null : { kind: "category", id: category },
                        )
                      }
                      title={`Focus ${category} across charts and tables`}
                    >
                      <i
                        aria-hidden="true"
                        data-hollow={category === "Unattributed" || undefined}
                        style={{ color: useCaseColor(category) }}
                      />
                      {category}
                      <small>{formatCount(count)}</small>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null
        }
        table={
          cohort.rows.length
            ? {
                summary: "View plotted pools as table",
                count: cohort.rows.length,
                render: () => (
                  <div
                    className="chart-table-scroll"
                    tabIndex={0}
                    role="region"
                    aria-label="Plotted pools"
                  >
                    <table className="chart-table">
                      <caption>
                        Plotted pools: current tracked volume and reported
                        reserves (USD)
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">Pool</th>
                          <th scope="col">Use case</th>
                          <th scope="col">{volumeLabel}</th>
                          <th scope="col">Reported reserves</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cohort.rows.map((row) => (
                          <tr
                            key={analyticsPoolKey(row)}
                            data-selected={row === selected ? "true" : undefined}
                          >
                            <th scope="row">
                              {row.pool.name || shortAddress(row.pool.address)} ·{" "}
                              {names.get(row.pool.chain) || row.pool.chain}
                            </th>
                            <td>{poolCategory(row)}</td>
                            <td>{exactMoney(row.volumeUsd)}</td>
                            <td>{exactMoney(row.liquidityUsd)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ),
              }
            : null
        }
        footnote={
          <div className="pool-chart-method">
            <span>
              {formatCount(cohort.rows.length)} of {formatCount(cohort.eligible)}{" "}
              eligible pools plotted
              {cohort.eligible > cohort.rows.length ? " · largest by volume" : ""}
              .
            </span>
            <span>
              {formatCount(cohort.unavailable)} missing one measurement ·{" "}
              {formatCount(cohort.zero)} with zero volume or reserves excluded.
            </span>
            <span>
              Reported reserves are provider estimates, not executable depth or
              protocol TVL.
            </span>
          </div>
        }
      >
        <div className="pool-scatter-layout">
          <div className="pool-scatter-main">
            {selected && x && y ? (
              <Scatter
                points={cohort.rows.map((row) => ({
                  key: analyticsPoolKey(row),
                  x: row.liquidityUsd!,
                  y: row.volumeUsd!,
                  color: useCaseColor(poolCategory(row)),
                  hollow: !row.project,
                }))}
                xAxis={x}
                yAxis={y}
                formatX={axisMoney}
                formatY={axisMoney}
                xLabel={`Reported reserves · USD${scale === "log" ? " (log)" : ""}`}
                yLabel={`${volumeLabel} · USD${scale === "log" ? " (log)" : ""}`}
                selected={activeIndex}
                onSelect={selectIndex}
                sliderLabel="Selected pool in volume and reserves chart"
                valueText={(index) => {
                  const row = cohort.rows[index];
                  return `${row.pool.name}, ${names.get(row.pool.chain) || row.pool.chain}, ${formatMoneyCompact(row.volumeUsd)} volume, ${formatMoneyCompact(row.liquidityUsd)} reported reserves`;
                }}
                describedBy={`${chartId}-instructions`}
                disabled={disabled}
                tooltip={(index) => {
                  const row = cohort.rows[index];
                  return (
                    <>
                      <span className="chart-tooltip-series">
                        {poolCategory(row)} ·{" "}
                        {names.get(row.pool.chain) || row.pool.chain}
                      </span>
                      <strong>{row.pool.name || shortAddress(row.pool.address)}</strong>
                      <span>
                        {volumeLabel}: {exactMoney(row.volumeUsd)}
                      </span>
                      <span>Reserves: {exactMoney(row.liquidityUsd)}</span>
                      <small>
                        {row.project?.name || "Unattributed project"} · click to
                        inspect
                      </small>
                    </>
                  );
                }}
              />
            ) : (
              <div className="pool-chart-empty chart-state" data-kind="empty">
                <strong>
                  {STATIC_EDITION
                    ? "No matching measurements in this snapshot"
                    : "No matching measurements yet"}
                </strong>
                <p>
                  This chart needs pools with current, positive volume and
                  reserves{focusLabel ? ` in ${focusLabel}` : ""}. Available
                  measurements still appear in the table below.
                </p>
              </div>
            )}
            <p
              className="pool-chart-instructions"
              id={`${chartId}-instructions`}
            >
              {selected
                ? "Hover to preview; click, tap or use the arrow keys to inspect a pool."
                : "Current observations only."}{" "}
              {scale === "log"
                ? "Both axes use a logarithmic scale."
                : "Both axes use a linear scale."}{" "}
              Hollow points are pools not linked to a loaded project.
            </p>
          </div>
          <aside className="pool-chart-detail" aria-label="Selected pool">
            {selected ? (
              <>
                <div className="pool-chart-selection">
                  <span>
                    Pool {formatCount(activeIndex + 1)} /{" "}
                    {formatCount(cohort.rows.length)}
                  </span>
                  <div>
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => selectIndex(activeIndex - 1)}
                      disabled={disabled || activeIndex === 0}
                      aria-label="Previous plotted pool"
                    >
                      <ChevronLeft size={16} />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => selectIndex(activeIndex + 1)}
                      disabled={
                        disabled || activeIndex === cohort.rows.length - 1
                      }
                      aria-label="Next plotted pool"
                    >
                      <ChevronRight size={16} />
                    </button>
                  </div>
                </div>
                <div className="pool-selected-identity">
                  {selected.project && (
                    <ProtocolLogo project={selected.project} />
                  )}
                  <div>
                    <strong>
                      {selected.pool.name ||
                        shortAddress(selected.pool.address)}
                    </strong>
                    <span>
                      {selected.project?.name || "Unattributed project"} ·{" "}
                      {names.get(selected.pool.chain) || selected.pool.chain}
                    </span>
                  </div>
                </div>
                <span
                  className="category-tag pool-selected-category"
                  data-category={poolCategory(selected)}
                >
                  {poolCategory(selected)}
                </span>
                <span
                  className="pool-selected-address address"
                  title={selected.pool.address}
                >
                  {shortAddress(selected.pool.address)}
                </span>
                <dl className="pool-selected-metrics">
                  <div>
                    <dt>{volumeLabel}</dt>
                    <dd title={exactMoney(selected.volumeUsd)}>
                      {formatMoneyCompact(selected.volumeUsd)}
                    </dd>
                  </div>
                  <div>
                    <dt>Reported reserves</dt>
                    <dd title={exactMoney(selected.liquidityUsd)}>
                      {formatMoneyCompact(selected.liquidityUsd)}
                    </dd>
                  </div>
                  <div>
                    <dt>Share of tracked {windows[windowKey]} volume</dt>
                    <dd>{formatPercent(selected.volumeShare)}</dd>
                  </div>
                  <div>
                    <dt>Measured (original clock)</dt>
                    <dd>
                      {measuredAt === null ? (
                        "Time unavailable"
                      ) : (
                        <>
                          <time
                            dateTime={new Date(measuredAt).toISOString()}
                            title={formatUtc(measuredAt)}
                          >
                            {formatUtcClock(measuredAt)}
                          </time>
                          <small>
                            {formatAge(Date.parse(result.asOf) - measuredAt)}{" "}
                            {STATIC_EDITION ? "before the snapshot" : "before evaluation"}
                          </small>
                        </>
                      )}
                    </dd>
                  </div>
                </dl>
                <div className="pool-selected-actions">
                  {selected.project && (
                    <>
                      <button
                        type="button"
                        className="analytics-text-button"
                        disabled={disabled}
                        onClick={() => openProject(selected.project!.id)}
                      >
                        View project <ArrowRight size={14} />
                      </button>
                      {inspectActivity && (
                        <button
                          type="button"
                          className="analytics-text-button"
                          disabled={disabled}
                          onClick={() =>
                            inspectActivity(
                              selected.project!.id,
                              selected.pool.chain,
                            )
                          }
                        >
                          Project activity <ArrowRight size={14} />
                        </button>
                      )}
                      {setFocus && (
                        <button
                          type="button"
                          className="analytics-text-button"
                          disabled={disabled}
                          onClick={() =>
                            setFocus({ kind: "project", id: selected.project!.id })
                          }
                        >
                          Focus project <ArrowRight size={14} />
                        </button>
                      )}
                    </>
                  )}
                  <button
                    type="button"
                    className="analytics-text-button"
                    disabled={disabled}
                    onClick={() => findInTable(selected.pool.address)}
                  >
                    Find in pool table <ArrowRight size={14} />
                  </button>
                  <External href={selected.pool.url}>View source</External>
                </div>
                <span className="sr-only" role="status">
                  Selected {selected.pool.name},{" "}
                  {formatMoneyCompact(selected.volumeUsd)} volume and{" "}
                  {formatMoneyCompact(selected.liquidityUsd)} reported reserves.
                </span>
              </>
            ) : (
              <div className="pool-chart-no-selection">
                <span>Pool inspector</span>
                <p>
                  {STATIC_EDITION
                    ? "Select a pool from the measurements in this snapshot."
                    : "Select a pool when matching measurements become available."}
                </p>
              </div>
            )}
          </aside>
        </div>
      </ChartFrame>

      <div
        className="analytics-pool-table-panel plate"
        ref={tableRef}
        aria-labelledby={`${chartId}-table-title`}
        role="group"
      >
        <div className="analytics-panel-heading">
          <div>
            <span className="analytics-section-number">Market explorer</span>
            <h3 id={`${chartId}-table-title`}>Pool markets</h3>
            <p className="analytics-panel-caption">
              {formatCount(scoped.length)} pools with at least one current
              measurement{focusLabel ? ` in ${focusLabel}` : ""} · original
              measurement clocks in UTC
            </p>
          </div>
          <div className="pool-table-tools">
            {focusChip}
            <label className="search-box analytics-pool-search">
              <Search size={16} />
              <span className="sr-only">Search pool markets</span>
              <input
                ref={searchRef}
                aria-label="Search pool markets"
                type="search"
                value={query}
                maxLength={200}
                placeholder="Pool, project, network or address"
                disabled={disabled}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(0);
                }}
              />
              {query && (
                <button
                  type="button"
                  className="clear-search"
                  disabled={disabled}
                  aria-label="Clear pool search"
                  onClick={() => {
                    setQuery("");
                    setPage(0);
                    searchRef.current?.focus();
                  }}
                >
                  <X size={14} />
                </button>
              )}
            </label>
          </div>
        </div>
        <div
          className="analytics-pool-table-scroll"
          tabIndex={0}
          role="region"
          aria-label="Pool markets table, scroll horizontally for more columns"
        >
          <table
            className="analytics-pool-table"
            id={tableId}
            data-span={spanText ? "true" : undefined}
          >
            <thead>
              <tr>
                <th
                  scope="col"
                  aria-sort={
                    sort === "name"
                      ? ascending
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                >
                  {sortButton("name", "Pool / project")}
                </th>
                <th scope="col">Network</th>
                {spanText && (
                  <th
                    scope="col"
                    aria-sort={
                      sort === "span"
                        ? ascending
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                  >
                    {sortButton("span", `${spanText} volume`)}
                  </th>
                )}
                <th
                  scope="col"
                  aria-sort={
                    sort === "volume"
                      ? ascending
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                >
                  {sortButton("volume", `Tracked ${windows[windowKey]} volume`)}
                </th>
                <th
                  scope="col"
                  aria-sort={
                    sort === "reserves"
                      ? ascending
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                >
                  {sortButton("reserves", "Reported reserves")}
                </th>
                <th
                  scope="col"
                  title="Share of current tracked hook-pool volume in this scope"
                >
                  Share of tracked volume
                </th>
                <th scope="col">Measured (UTC)</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((row) => {
                const clock = parseClock(row.pool.metricUpdatedAt);
                return (
                  <tr key={analyticsPoolKey(row)}>
                    <th scope="row">
                      <div className="pool-table-identity">
                        {row.project ? (
                          <ProtocolLogo project={row.project} />
                        ) : (
                          <span className="pool-table-unlinked" aria-hidden="true" />
                        )}
                        <div>
                          <strong
                            title={`${row.pool.name} · ${row.pool.address}`}
                          >
                            {row.pool.name || shortAddress(row.pool.address)}
                          </strong>
                          {row.project ? (
                            <button
                              type="button"
                              disabled={disabled}
                              onClick={() => openProject(row.project!.id)}
                            >
                              <i
                                aria-hidden="true"
                                style={{
                                  background: useCaseColor(row.project.category),
                                }}
                              />
                              <span title={row.project.name}>
                                {row.project.name}
                              </span>
                              <ArrowRight size={12} />
                            </button>
                          ) : (
                            <span>Unattributed project</span>
                          )}
                          <span
                            className="pool-table-address"
                            title={row.pool.address}
                          >
                            {shortAddress(row.pool.address)}
                          </span>
                        </div>
                      </div>
                    </th>
                    <td className="pool-table-network" data-label="Network">
                      {names.get(row.pool.chain) || row.pool.chain}
                    </td>
                    {spanText && (
                      <td className="pool-table-volume" data-label={`${spanText} volume`}>
                        <DailyAmount pool={lens ? lens.pool(row.pool) : null} />
                      </td>
                    )}
                    <td
                      title={exactMoney(row.volumeUsd)}
                      className="pool-table-volume"
                      data-label={`${windows[windowKey]} volume`}
                    >
                      {formatMoneyCompact(poolMeasurement(row.volumeUsd))}
                    </td>
                    <td
                      title={exactMoney(row.liquidityUsd)}
                      data-label="Reserves"
                    >
                      {formatMoneyCompact(poolMeasurement(row.liquidityUsd))}
                    </td>
                    <td data-label="Share of volume">
                      <span className="pool-table-share">
                        {formatPercent(poolMeasurement(row.volumeShare))}
                        {/* A measured zero is drawn as zero even when the scope total
                            is zero and no percentage exists. */}
                        <BarTrack
                          share={
                            poolMeasurement(row.volumeShare) ??
                            (poolMeasurement(row.volumeUsd) === 0 ? 0 : null)
                          }
                          color={useCaseColor(poolCategory(row))}
                        />
                      </span>
                    </td>
                    <td className="pool-table-clock" data-label="Measured (UTC)">
                      {clock === null ? (
                        "—"
                      ) : (
                        <time
                          dateTime={new Date(clock).toISOString()}
                          title={formatUtc(clock)}
                        >
                          {new Date(clock).toISOString().slice(11, 19)}
                        </time>
                      )}
                    </td>
                    <td className="pool-table-actions">
                      {row.project && inspectActivity && (
                        <button
                          type="button"
                          className="icon-button"
                          disabled={disabled}
                          onClick={() =>
                            inspectActivity(row.project!.id, row.pool.chain)
                          }
                          aria-label={`${row.project.name} activity on ${names.get(row.pool.chain) || row.pool.chain}`}
                          title="View project activity"
                        >
                          <ArrowRight size={16} />
                        </button>
                      )}
                      <External href={row.pool.url}>
                        <span className="sr-only">
                          Source for {row.pool.name} on{" "}
                          {names.get(row.pool.chain) || row.pool.chain}
                        </span>
                      </External>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!rows.length && (
          <div className="pool-table-empty">
            <strong>
              {query
                ? "No pools match your search"
                : "No current pool measurements"}
            </strong>
            <p>
              {query
                ? "Try a token pair, project name, network or pool address."
                : STATIC_EDITION
                  ? "No pool in this scope has a current volume or reserve measurement in this snapshot."
                  : "Pools appear here when current volume or reserve measurements are available."}
            </p>
            {query && (
              <button
                type="button"
                className="control"
                onClick={() => {
                  setQuery("");
                  setPage(0);
                  searchRef.current?.focus();
                }}
                disabled={disabled}
              >
                Clear search
              </button>
            )}
          </div>
        )}
        <div className="pool-table-footer">
          <span role="status">
            {rows.length
              ? `${formatCount(activePage * POOL_PAGE_SIZE + 1)}–${formatCount(Math.min((activePage + 1) * POOL_PAGE_SIZE, rows.length))} of ${formatCount(rows.length)} pools${query ? " matched" : ""}`
              : "0 pools"}
          </span>
          <div className="pool-table-pagination">
            <button
              type="button"
              className="icon-button"
              disabled={disabled || activePage === 0}
              aria-label="Previous pool page"
              aria-controls={tableId}
              onClick={() => setPage(activePage - 1)}
            >
              <ChevronLeft size={16} />
            </button>
            <span>
              {activePage + 1} / {formatCount(pageCount)}
            </span>
            <button
              type="button"
              className="icon-button"
              disabled={disabled || activePage === pageCount - 1}
              aria-label="Next pool page"
              aria-controls={tableId}
              onClick={() => setPage(activePage + 1)}
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
        <p className="pool-table-note">
          — means no current measurement; $0 is a measured zero. Shares use
          tracked hook-pool volume in this scope, not total Uniswap volume. The
          CSV export keeps the same scope and each pool’s original measurement
          clock.
        </p>
      </div>
    </section>
  );
}
