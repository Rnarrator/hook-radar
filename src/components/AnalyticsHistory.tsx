import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Point } from "../../shared/types";
import {
  analyticsHistoryKeys,
  analyticsPointTime,
  roundExactUsd,
} from "../analytics";
import type { AnalyticsHistoryRange } from "../analytics";
import type { AnalyticsMetric } from "../analytics-focus";
import {
  historyChartScale,
  historyChartSegments,
  historyCsv,
  historyExportTimes,
  historyGapLabel,
  historyObservationChange,
} from "../history-chart";
import {
  ChartAnnouncer,
  ChartFrame,
  LineChart,
  formatAge,
  formatSince,
  formatCount,
  formatMoneyAxis,
  formatMoneyCompact,
  formatMoneyFull,
  formatUtc,
} from "../charts/index";
import { STATIC_EDITION } from "../edition";
import { ArrowRight, Check, ChevronLeft, ChevronRight, Download } from "./Icons";
import "./analytics-history.css";

const PAGE_SIZE = 50;
const RANGES = [
  ["d1", "24 hours"],
  ["d7", "7 days"],
  ["d30", "30 days"],
  ["all", "All history"],
] as const;

interface Props {
  /** Observations inside the selected range (already validated/sorted). */
  points: Point[];
  /** Number of valid observations across all history. */
  allPoints: number;
  /** History is recorded only for the all-network scope. */
  available: boolean;
  range: AnalyticsHistoryRange;
  setRange: (range: AnalyticsHistoryRange) => void;
  showAllNetworks: () => void;
  metric: AnalyticsMetric;
  now: number;
  disabled?: boolean;
  /** Step label for the investigation sequence ("02 · What changed"). */
  kicker?: string;
}

/** "What changed": the recorded rolling 24h tracked hook-pool volume series.
 * Only stored observations are drawn; unknown intervals break the line; the
 * inspected panel shows each observation's original measurement time. */
export function AnalyticsHistory({
  points,
  allPoints,
  available,
  range,
  setRange,
  showAllNetworks,
  metric,
  now,
  disabled = false,
  kicker = "What changed",
}: Props) {
  const id = useId().replace(/:/g, "");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [valuesPage, setValuesPage] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const [exported, setExported] = useState("");
  const exportTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => () => clearTimeout(exportTimer.current), []);
  const pointKeys = useMemo(() => analyticsHistoryKeys(points), [points]);
  const pointIndexes = useMemo(
    () => new Map(pointKeys.map((key, index) => [key, index])),
    [pointKeys],
  );
  const times = useMemo(() => points.map(analyticsPointTime), [points]);
  const values = useMemo(() => points.map((point) => point.value), [points]);
  const scale = useMemo(() => historyChartScale(points), [points]);
  const { segments, gaps } = useMemo(
    () => historyChartSegments(points),
    [points],
  );
  const allZero = useMemo(
    () => points.length > 0 && points.every((point) => point.value === 0),
    [points],
  );
  const hasHistory = available && allPoints > 0;
  const metricNote =
    metric !== "volume" ? (
      <p className="history-metric-note">
        Stored history exists for tracked 24H volume only.{" "}
        {metric === "reserves" ? "Reserves" : "Pool counts"} are{" "}
        {STATIC_EDITION ? "measured at the snapshot" : "current measurements"}{" "}
        without a recorded series, so this chart still shows volume.
      </p>
    ) : null;

  const rangeControl = hasHistory ? (
    <div
      className="window-switch analytics-history-range"
      role="group"
      aria-label="History range"
    >
      {RANGES.map(([value, label]) => (
        <button
          key={value}
          type="button"
          className={range === value ? "selected" : ""}
          aria-pressed={range === value}
          disabled={disabled}
          onClick={() => setRange(value)}
        >
          {label}
        </button>
      ))}
    </div>
  ) : null;

  const footnote = (
    <p>
      Each observation is the preceding 24 hours of tracked hook-pool volume,
      not volume during the gap between points, and never a daily sum.
      Tracked pools and observation endpoints can change; movements do not
      isolate organic growth. Partial coverage · Not total Uniswap volume.
    </p>
  );

  if (!available || !points.length) {
    const unavailable = !available;
    return (
      <ChartFrame
        id="analytics-history"
        className="analytics-history-panel"
        data-history-empty={!hasHistory}
        kicker={kicker}
        title="Recorded 24h volume"
        headingLevel={2}
        caption={
          unavailable
            ? "Rolling 24H tracked hook-pool volume · saved for the all-network scope"
            : "Rolling 24H tracked hook-pool volume · All networks"
        }
        controls={rangeControl}
        state="empty"
        message={null}
      >
        <div className="history-empty" data-kind={unavailable ? "scope" : allPoints ? "range" : "none"}>
          <div>
            {unavailable ? (
              <h3>History is recorded across all networks</h3>
            ) : (
              <strong>
                {allPoints
                  ? "No observations in this range"
                  : "No network-wide history is recorded"}
              </strong>
            )}
            <p>
              {unavailable
                ? "The saved series combines tracked pools across networks. A network-specific history is not available."
                : allPoints
                  ? "Choose a wider time range to see earlier recorded volume."
                  : STATIC_EDITION
                    ? "A point is saved only when a snapshot has pools measured within five minutes of it; none has been saved. Current totals stay available above."
                    : "A point is saved only when every contributing pool has a fresh measurement; none has been saved. Current totals stay available above, and projects with recorded history list it under Archived observations in their details."}{" "}
              <span className="history-empty-note">
                Missing observations are never shown as zero.
              </span>
            </p>
          </div>
          {unavailable && (
            <button
              type="button"
              className="analytics-text-button"
              onClick={showAllNetworks}
              disabled={disabled}
            >
              Show all-network history <ArrowRight size={14} />
            </button>
          )}
        </div>
        {metricNote}
      </ChartFrame>
    );
  }

  const selectedMatch =
    selectedKey === null ? -1 : (pointIndexes.get(selectedKey) ?? -1);
  const selected = selectedMatch < 0 ? points.length - 1 : selectedMatch;
  const followingLatest = selectedMatch < 0;
  const inspected = hover ?? selected;
  const active = points[inspected];
  const latest = selected === points.length - 1;
  const change = historyObservationChange(points, inspected);
  const lastPage = Math.max(0, Math.ceil(points.length / PAGE_SIZE) - 1);
  const currentPage = Math.min(valuesPage, lastPage);
  const pageStart = currentPage * PAGE_SIZE;
  const describe = (index: number) =>
    `${formatUtc(times[index])}: ${formatMoneyFull(values[index])} observed 24h volume`;

  function select(index: number, announce = false) {
    setSelectedKey(pointKeys[index]);
    if (announce)
      setAnnouncement(
        `Observation ${index + 1} of ${points.length}. ${describe(index)}.`,
      );
  }

  function download() {
    clearTimeout(exportTimer.current);
    try {
      // The edition's `now` is the snapshot's time: the file is dated when it
      // is made, and the snapshot's time is its own column.
      const { exportedAt, snapshotAt } = historyExportTimes(now);
      // An amount is written in cents, as the page shows it: the stored sum
      // carries float residue (339226102.0600004) that is not a measurement.
      const csv = historyCsv(
        STATIC_EDITION
          ? points.map((point) => ({
              ...point,
              value: roundExactUsd(point.value),
            }))
          : points,
        { range, exportedAt, snapshotAt },
      );
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `hook-radar-recorded-24h-volume-${range}-${exportedAt.slice(0, 10)}.csv`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExported("History CSV downloaded");
    } catch {
      setExported("Download unavailable. Please retry.");
    }
    exportTimer.current = setTimeout(() => setExported(""), 5000);
  }

  const latestTime = times[times.length - 1];
  return (
    <ChartFrame
      id="analytics-history"
      className="analytics-history-panel"
      data-history-empty={false}
      kicker={kicker}
      title="Recorded 24h volume"
      headingLevel={2}
      caption={
        <>
          <span>Rolling 24H tracked hook-pool volume</span>
          <span aria-hidden="true">·</span>
          <span>All networks</span>
          <span aria-hidden="true">·</span>
          <span>
            {formatCount(points.length)} of {formatCount(allPoints)}{" "}
            {allPoints === 1 ? "observation" : "observations"}
          </span>
        </>
      }
      freshness={{
        label: `latest ${formatSince(latestTime, now)}`,
        tone: now - latestTime < 2 * 3600000 ? "current" : "stale",
        dateTime: new Date(latestTime).toISOString(),
        title: `Latest recorded observation: ${formatUtc(latestTime)}`,
      }}
      controls={rangeControl}
      table={{
        summary: "View recorded values",
        count: points.length,
        render: () => (
          <>
            <div
              className="chart-table-scroll history-values-scroll"
              tabIndex={0}
              role="region"
              aria-label="Recorded volume values"
            >
              <table className="chart-table">
                <caption className="sr-only">
                  Every saved rolling 24 hour volume observation in the selected
                  range, oldest first, in UTC
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Observation time (UTC)</th>
                    <th scope="col">Recorded 24h volume</th>
                  </tr>
                </thead>
                <tbody>
                  {points
                    .slice(pageStart, pageStart + PAGE_SIZE)
                    .map((point, index) => (
                      <tr
                        key={pointKeys[pageStart + index]}
                        data-selected={
                          pageStart + index === selected ? "true" : undefined
                        }
                      >
                        <td>
                          <time
                            dateTime={new Date(
                              times[pageStart + index],
                            ).toISOString()}
                            title={new Date(
                              times[pageStart + index],
                            ).toISOString()}
                          >
                            {formatUtc(times[pageStart + index])}
                          </time>
                        </td>
                        <td
                          title={String(
                            STATIC_EDITION
                              ? roundExactUsd(point.value)
                              : point.value,
                          )}
                        >
                          {formatMoneyFull(point.value)}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            <div className="history-pagination">
              <span role="status">
                {formatCount(pageStart + 1)}–
                {formatCount(Math.min(points.length, pageStart + PAGE_SIZE))} of{" "}
                {formatCount(points.length)} observations
              </span>
              <div>
                <button
                  type="button"
                  className="control"
                  disabled={currentPage === 0}
                  onClick={() => setValuesPage(currentPage - 1)}
                  aria-label="Previous recorded values"
                >
                  <ChevronLeft size={14} />
                  Previous
                </button>
                <button
                  type="button"
                  className="control"
                  disabled={currentPage === lastPage}
                  onClick={() => setValuesPage(currentPage + 1)}
                  aria-label="Next recorded values"
                >
                  Next
                  <ChevronRight size={14} />
                </button>
              </div>
            </div>
          </>
        ),
      }}
      actions={
        <>
          <button
            type="button"
            className="control"
            onClick={download}
            disabled={disabled}
            title="Download the observations in this range with original timestamps"
          >
            {exported === "History CSV downloaded" ? (
              <Check size={14} />
            ) : (
              <Download size={14} />
            )}
            History CSV
          </button>
          <span className="sr-only" role="status">
            {exported}
          </span>
        </>
      }
      footnote={footnote}
    >
      {metricNote}
      <div className="history-layout">
        <div className="history-plot">
          <LineChart
            times={times}
            values={values}
            keys={pointKeys}
            segments={segments}
            gaps={gaps}
            yScale={scale}
            selected={selected}
            onSelect={(index) => select(index)}
            onHover={setHover}
            onClear={() => setSelectedKey(null)}
            formatAxisValue={formatMoneyAxis}
            formatValue={formatMoneyFull}
            ariaLabel="Recorded 24h volume chart"
            sliderLabel="Explore analytics volume history"
            valueText={describe}
            describedBy={`${id}-help`}
            seriesLabel="Rolling 24H volume"
            scopeLabel="All networks · tracked hook pools"
            gapTitle={(from, to) =>
              `No recorded observations between ${formatUtc(times[from])} and ${formatUtc(times[to])}`
            }
            disabled={disabled}
          />
          <div className="history-chart-footer">
            <div className="history-legend">
              <span>
                <i className="history-legend-line" aria-hidden="true" />
                {points.length <= 80
                  ? "Rolling 24h volume · each dot is one stored observation"
                  : "Rolling 24h volume · every vertex is a stored observation; isolated ones are dotted"}
              </span>
              {gaps.length > 0 && (
                <span>
                  <i className="history-legend-gap" aria-hidden="true" />
                  {formatCount(gaps.length)}{" "}
                  {gaps.length === 1 ? "gap" : "gaps"} {historyGapLabel()}
                </span>
              )}
            </div>
            <p id={`${id}-help`}>
              Hover to inspect, click or tap to pin
              <span> · Focus the chart and use arrow keys, Home, End</span>
            </p>
          </div>
          {(points.length === 1 || allZero) && (
            <p className="history-state-note">
              {points.length === 1
                ? "One saved observation. A second is needed to show a time series."
                : "Every recorded observation in this range has a value of $0."}
            </p>
          )}
        </div>
        <aside className="history-readout" aria-label="Inspected observation">
          <div className="analytics-history-readout history-selected-value">
            <span className="history-readout-label">
              <span
                className={
                  hover === null && followingLatest
                    ? "history-label-dot"
                    : "history-label-dot selected"
                }
              />
              {hover !== null
                ? "Inspected recorded volume"
                : followingLatest
                  ? "Latest recorded volume"
                  : "Selected recorded volume"}
            </span>
            <strong title={formatMoneyFull(active.value)}>
              {formatMoneyCompact(active.value)}
            </strong>
            <time
              dateTime={new Date(times[inspected]).toISOString()}
              title={new Date(times[inspected]).toISOString()}
            >
              {formatUtc(times[inspected])}
            </time>
          </div>
          <dl className="history-inspect-meta">
            <div>
              <dt>Exact value</dt>
              <dd>{formatMoneyFull(active.value)}</dd>
            </div>
            <div>
              <dt>Measures</dt>
              <dd>Rolling 24H volume ending at this time · All networks</dd>
            </div>
            <div>
              <dt>From previous observation</dt>
              <dd>
                {change ? (
                  <>
                    <span className="history-change" data-sign={Math.sign(change.delta)}>
                      {change.delta > 0 ? "+" : change.delta < 0 ? "−" : "±"}
                      {formatMoneyCompact(Math.abs(change.delta))}
                    </span>{" "}
                    <small>
                      {formatAge(change.elapsedMs)} earlier · a change in the
                      rolling value, not volume traded in between
                    </small>
                  </>
                ) : (
                  <small>No earlier observation in this range</small>
                )}
              </dd>
            </div>
          </dl>
          <div className="history-navigation">
            <span className="history-observation-count">
              Observation <strong>{formatCount(selected + 1)}</strong> /{" "}
              {formatCount(points.length)}
            </span>
            <div
              className="history-navigation-buttons"
              role="group"
              aria-label="Browse recorded observations"
            >
              <button
                type="button"
                className="icon-button"
                onClick={() => select(selected - 1, true)}
                disabled={disabled || selected === 0}
                aria-label="Previous observation"
                title="Previous observation"
              >
                <ChevronLeft size={17} />
              </button>
              <button
                type="button"
                className="icon-button"
                onClick={() => select(selected + 1, true)}
                disabled={disabled || latest}
                aria-label="Next observation"
                title="Next observation"
              >
                <ChevronRight size={17} />
              </button>
              <button
                type="button"
                className="control history-latest"
                onClick={() => {
                  setSelectedKey(null);
                  setAnnouncement(
                    `Latest observation. ${describe(points.length - 1)}.`,
                  );
                }}
                disabled={disabled || followingLatest}
                aria-label="Show latest observation"
              >
                Latest
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
          <ChartAnnouncer message={announcement} />
        </aside>
      </div>
    </ChartFrame>
  );
}
