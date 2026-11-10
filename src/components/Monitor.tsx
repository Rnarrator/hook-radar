import { useEffect, useMemo, useRef, useState } from "react";
import type {
  RadarProject,
  RadarSnapshot,
  WindowKey,
} from "../../shared/types";
import { categories, count, money, windows } from "../model";
import { duplicateFamilyNames } from "../provenance";
import { FamilyFingerprint } from "../MarketProvenance";
import {
  analyticsHistory,
  analyticsHistoryKeys,
  analyticsPointTime,
} from "../analytics";
import {
  historyAxisMoney,
  historyChartScale,
  historyChartSegments,
  historyGapWords,
  historyNearestPoint,
} from "../history-chart";
import {
  STATIC_EDITION,
  shortTimeLabel,
  useCaseCaption,
  utcClock,
  utcDayMonth,
} from "../edition";
import "./monitor.css";
import "./monitor-history.css";

type Mode = "landscape" | "markets" | "history";
interface Props {
  snapshot: RadarSnapshot;
  landscape: RadarProject[];
  projects: RadarProject[];
  categoryCounts?: { category: string; total: number }[];
  category: string;
  windowKey: WindowKey;
  filtered: boolean;
  /** Edition: a market scope other than Projects narrows the counts too. It
   * changes the caption only; History stays tied to `filtered`. */
  narrowed?: boolean;
  setCategory: (category: string) => void;
  openProject: (id: string) => void;
  /** Opens the Data & sources dialog; omitted where the build has none. */
  openSources?: () => void;
  onClearScope: () => void;
}

export function Monitor({
  snapshot,
  landscape,
  projects,
  categoryCounts,
  category,
  windowKey,
  filtered,
  narrowed = false,
  setCategory,
  openProject,
  openSources,
  onClearScope,
}: Props) {
  const [mode, setMode] = useState<Mode>("landscape");
  const requestedHistory = useRef(false);
  const historyTab = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (filtered) {
      if (mode === "history") setMode("landscape");
    } else if (requestedHistory.current) {
      requestedHistory.current = false;
      setMode("history");
      historyTab.current?.focus({ preventScroll: true });
    }
  }, [filtered, mode]);
  const tabs: { mode: Mode; label: string }[] = [
    { mode: "landscape", label: "Categories" },
    { mode: "markets", label: "Market activity" },
    { mode: "history", label: "History" },
  ];
  function onTabKey(
    event: React.KeyboardEvent<HTMLButtonElement>,
    current: Mode,
  ) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const enabled = tabs.filter((tab) => !filtered || tab.mode !== "history");
    const index = enabled.findIndex((tab) => tab.mode === current);
    const next =
      event.key === "Home"
        ? enabled[0]
        : event.key === "End"
          ? enabled.at(-1)!
          : enabled[
              (index + (event.key === "ArrowRight" ? 1 : -1) + enabled.length) %
                enabled.length
            ];
    setMode(next.mode);
    event.currentTarget.parentElement
      ?.querySelector<HTMLButtonElement>(`[data-mode="${next.mode}"]`)
      ?.focus();
  }
  return (
    <div className="panel monitor-panel">
      <div className="panel-heading monitor-heading">
        <div>
          <span className="monitor-kicker">Ecosystem insights</span>
          <h2>
            {mode === "landscape"
              ? "Hooks by use case"
              : mode === "markets"
                ? "Highest tracked volume"
                : "Tracked volume over time"}
          </h2>
          {mode === "landscape" ? (
            <p>
              Directory entries per use case ·{" "}
              {STATIC_EDITION
                ? // The snapshot's list is never the whole directory.
                  useCaseCaption(filtered || narrowed)
                : filtered
                  ? "matching this view"
                  : "whole directory"}
            </p>
          ) : (
            <p>
              {mode === "markets"
                ? `Tracked ${windows[windowKey]} hook-pool volume · USD. Saved measurements may be from different times.`
                : "Saved rolling 24h volume from tracked hook pools · USD"}
            </p>
          )}
        </div>
      </div>
      <div
        className="monitor-tabs"
        role="tablist"
        aria-label="Ecosystem insights"
      >
        {tabs.map((tab) => (
          <button
            key={tab.mode}
            data-mode={tab.mode}
            id={`monitor-${tab.mode}-tab`}
            ref={tab.mode === "history" ? historyTab : undefined}
            role="tab"
            aria-selected={mode === tab.mode}
            aria-controls="monitor-content"
            tabIndex={mode === tab.mode ? 0 : -1}
            disabled={filtered && tab.mode === "history"}
            aria-describedby={
              filtered && tab.mode === "history"
                ? "history-scope-note"
                : undefined
            }
            title={
              filtered && tab.mode === "history"
                ? "History shows all tracked market data. Clear filters to view it."
                : undefined
            }
            onKeyDown={(event) => onTabKey(event, tab.mode)}
            onClick={() => setMode(tab.mode)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {filtered && (
        <div className="history-scope-note">
          <p id="history-scope-note">History shows all tracked pools.</p>
          <button
            onClick={() => {
              requestedHistory.current = true;
              onClearScope();
            }}
          >
            View all history
          </button>
        </div>
      )}
      <div
        id="monitor-content"
        role="tabpanel"
        aria-labelledby={`monitor-${mode}-tab`}
      >
        {mode === "landscape" ? (
          <Landscape
            projects={landscape}
            counts={categoryCounts}
            category={category}
            setCategory={setCategory}
          />
        ) : mode === "markets" ? (
          <Markets
            projects={projects}
            duplicateNames={duplicateFamilyNames(snapshot.projects)}
            windowKey={windowKey}
            openProject={openProject}
            openSources={openSources}
          />
        ) : (
          <History points={snapshot.history} />
        )}
      </div>
      <p className="monitor-note">
        {mode === "landscape"
          ? "Select a category to filter hooks. Categories are based on project descriptions."
          : mode === "markets"
            ? "Includes pools with market data. Other pools may be missing. Not total Uniswap volume."
            : "Each point shows the preceding 24 hours. The tracked pools can change between updates."}
      </p>
    </div>
  );
}

function Landscape({
  projects,
  counts,
  category,
  setCategory,
}: Pick<Props, "category" | "setCategory"> & {
  projects: RadarProject[];
  counts?: Props["categoryCounts"];
}) {
  const groups = categories.map((name) => ({
    name,
    count:
      counts?.find((row) => row.category === name)?.total ??
      projects.filter((project) => project.category === name).length,
  }));
  const max = Math.max(...groups.map((group) => group.count), 1);
  return (
    <div
      className="composition-chart"
      role="group"
      aria-label="Hooks by category"
    >
      {groups.map((group, index) => (
        <button
          key={group.name}
          className={`composition-row ${category === group.name ? "chosen" : ""}`}
          data-category={group.name}
          aria-pressed={category === group.name}
          onClick={() =>
            setCategory(category === group.name ? "all" : group.name)
          }
        >
          <span className="composition-label">{group.name}</span>
          <span className="bar-track">
            <span
              className={`composition-bar tone-${index % 4}`}
              style={{ width: `${(group.count / max) * 100}%` }}
            >
              {group.count > 0 && <span className="bar-cap" />}
            </span>
          </span>
          <span className="composition-value">{count(group.count)}</span>
        </button>
      ))}
    </div>
  );
}

function Markets({
  projects,
  duplicateNames,
  windowKey,
  openProject,
  openSources,
}: Pick<Props, "projects" | "windowKey" | "openProject" | "openSources"> & {
  duplicateNames: Set<string>;
}) {
  const everyMeasured = projects.filter(
    (project) => project.metrics.volumeUsd[windowKey] !== null,
  );
  const measured = [...everyMeasured]
    .sort(
      (a, b) =>
        b.metrics.volumeUsd[windowKey]! - a.metrics.volumeUsd[windowKey]!,
    )
    .slice(0, 6);
  // Bars are fractions of a stated denominator: the tracked volume of every
  // measured project in this view, never of the largest visible bar.
  const denominator = everyMeasured.reduce(
    (sum, project) => sum + project.metrics.volumeUsd[windowKey]!,
    0,
  );
  if (!measured.length)
    return (
      <div className="monitor-empty">
        <strong>No volume data for these hooks</strong>
        <p>
          Market sources haven’t returned volume for these projects. Pools and
          contracts remain available in the directory.
        </p>
        {openSources && (
          <button className="control" onClick={openSources}>
            View data coverage
          </button>
        )}
      </div>
    );
  return (
    <>
    <div className="market-bars">
      {measured.map((project) => (
        <button
          key={project.id}
          onClick={() => openProject(project.id)}
          aria-label={`Explore ${project.name} pools`}
        >
          <span className="market-bar-heading">
            <strong>{project.name}</strong>
            <span
              title={project.metrics.volumeUsd[windowKey]!.toLocaleString(
                "en-US",
                {
                  style: "currency",
                  currency: "USD",
                },
              )}
            >
              {money(project.metrics.volumeUsd[windowKey])}
            </span>
          </span>
          {duplicateNames.has(project.name.trim().toLowerCase()) && (
            <FamilyFingerprint project={project} />
          )}
          <span className="market-bar-track">
            <span
              style={{
                width: `${denominator > 0 ? (project.metrics.volumeUsd[windowKey]! / denominator) * 100 : 0}%`,
              }}
            />
          </span>
          <small>
            {project.metrics.poolCount}{" "}
            {project.metrics.poolCount === 1 ? "pool" : "pools"} with data ·{" "}
            {project.category}
          </small>
        </button>
      ))}
    </div>
    <p className="market-bars-scope">
      Bar length is each project’s share of tracked volume across the{" "}
      {count(everyMeasured.length)} measured{" "}
      {everyMeasured.length === 1 ? "project" : "projects"} in this view. Not
      market share.
    </p>
    </>
  );
}

function History({ points: rawPoints }: { points: RadarSnapshot["history"] }) {
  const points = useMemo(() => analyticsHistory(rawPoints, "all"), [rawPoints]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(920);
  const scale = useMemo(() => historyChartScale(points), [points]);
  const segments = useMemo(() => historyChartSegments(points), [points]);
  const pointKeys = useMemo(() => analyticsHistoryKeys(points), [points]);
  const chart = useMemo(() => {
    const start = points.length ? analyticsPointTime(points[0]) : 0;
    const end = points.length ? analyticsPointTime(points.at(-1)!) : start;
    const labelWidth = scale.ticks.reduce(
      (maximum, value) =>
        Math.max(maximum, historyAxisMoney(value).length * 7.5),
      0,
    );
    const left = Math.max(width < 450 ? 57 : 67, labelWidth + 12);
    const right = width - 12;
    const x = (timestamp: number) =>
      left + ((timestamp - start) / Math.max(end - start, 1)) * (right - left);
    const y = (value: number) => 176 - (value / scale.maximum) * 142;
    const paths = segments.segments.map((segment) =>
      segment
        .map((index, position) => {
          const point = points[index];
          return `${position ? "L" : "M"}${x(analyticsPointTime(point))},${y(point.value)}`;
        })
        .join(" "),
    );
    // Mark actual source observations only. Dense histories retain every path
    // vertex and selectable point without allocating an SVG node for each one.
    const markerIndexes =
      points.length <= 80
        ? points.map((_, index) => index)
        : Array.from({ length: 80 }, (_, index) =>
            Math.round((index * (points.length - 1)) / 79),
          );
    const isolatedPath = segments.segments
      .filter((segment) => segment.length === 1)
      .map(([index]) => {
        const coordinates = `${x(analyticsPointTime(points[index]))},${y(points[index].value)}`;
        return `M${coordinates}L${coordinates}`;
      })
      .join(" ");
    return {
      start,
      end,
      left,
      right,
      x,
      y,
      paths,
      markerIndexes,
      isolatedPath,
    };
  }, [points, width, scale, segments]);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const update = () => setWidth(Math.max(240, element.clientWidth));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [points.length]);
  // The edition saves one point per collection run that measured pool volume,
  // so the next such run adds the second; the live service waits for fresh
  // market data instead. The wording speaks of saved observations, not runs: a
  // run that measured no pool volume stores nothing, so a snapshot can exist
  // with no observation saved.
  if (points.length < 2 && STATIC_EDITION)
    return (
      <div className="monitor-empty">
        <strong>
          {points.length ? "Not enough history yet" : "No volume history yet"}
        </strong>
        <p>
          {points.length
            ? "One volume observation is saved."
            : "No volume observation is saved yet."}{" "}
          The chart appears once two are saved.
        </p>
      </div>
    );
  if (points.length < 2)
    return (
      <div className="monitor-empty">
        <strong>
          {points.length
            ? "Waiting for a second measurement"
            : "No volume history yet"}
        </strong>
        <p>
          {points.length
            ? "The first update is saved. The chart appears after the next update."
            : "The chart will appear as new market data arrives."}
        </p>
        <span>Only fresh market data adds a new point.</span>
      </div>
    );
  const { start, end, left, right, x, y, paths, markerIndexes, isolatedPath } =
    chart;
  const date = (timestamp: number) =>
    STATIC_EDITION
      ? // The edition writes every time as a 24-hour UTC clock ("28 Oct, 14:05
        // UTC"), as the rest of the page does.
        (shortTimeLabel(timestamp < 1e12 ? timestamp * 1000 : timestamp) ??
        "Time unavailable")
      : new Date(
          timestamp < 1e12 ? timestamp * 1000 : timestamp,
        ).toLocaleString("en-US", {
          timeZone: "UTC",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          timeZoneName: "short",
        });
  const selectedIndex =
    selectedKey === null ? -1 : pointKeys.indexOf(selectedKey);
  const selected = selectedIndex < 0 ? null : selectedIndex;
  const active = points[selected ?? points.length - 1];
  const exactActiveValue = active.value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumSignificantDigits: 17,
  });
  const axisDate = (timestamp: number) =>
    width < 550 && end - start < 86400000
      ? STATIC_EDITION
        ? `${utcClock(timestamp < 1e12 ? timestamp * 1000 : timestamp)} UTC`
        : new Date(
            timestamp < 1e12 ? timestamp * 1000 : timestamp,
          ).toLocaleTimeString("en-US", {
            timeZone: "UTC",
            hour: "2-digit",
            minute: "2-digit",
          })
      : STATIC_EDITION && width < 550
        ? // Days of runs: two full date-and-time labels would run into each
          // other on a phone. The readout above names the exact time.
          utcDayMonth(timestamp < 1e12 ? timestamp * 1000 : timestamp)
        : date(timestamp);
  function pointAt(event: React.PointerEvent<SVGRectElement>) {
    const bounds = event.currentTarget.ownerSVGElement!.getBoundingClientRect();
    const position =
      ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * width;
    const timestamp =
      start + ((position - left) / Math.max(1, right - left)) * (end - start);
    const nearest = historyNearestPoint(points, timestamp);
    if (nearest >= 0) setSelectedKey(pointKeys[nearest]);
  }
  return (
    <div ref={container} className="observations-chart">
      <div className="observation-readout">
        <time dateTime={new Date(analyticsPointTime(active)).toISOString()}>
          {date(active.timestamp)}
        </time>
        <strong title={exactActiveValue}>{money(active.value)}</strong>
        <span>Saved 24h hook-pool volume</span>
      </div>
      <svg
        viewBox={`0 0 ${width} 212`}
        role="group"
        aria-label="Recorded 24h volume"
      >
        {scale.ticks.map((value) => (
          <g key={value}>
            <line
              x1={left}
              x2={right}
              y1={y(value)}
              y2={y(value)}
              className="observation-grid"
            />
            <text
              x={left - 8}
              y={y(value) + 4}
              textAnchor="end"
              className="svg-text"
            >
              {historyAxisMoney(value)}
            </text>
          </g>
        ))}
        {segments.gaps.map(({ from, to }) => (
          <rect
            key={`${from}-${to}`}
            x={x(analyticsPointTime(points[from]))}
            y="34"
            width={Math.max(
              0,
              x(analyticsPointTime(points[to])) -
                x(analyticsPointTime(points[from])),
            )}
            height="142"
            className="observation-gap"
            aria-hidden="true"
          />
        ))}
        {paths.map((path, index) => (
          <path key={index} d={path} className="observation-series" />
        ))}
        {isolatedPath && (
          <path
            d={isolatedPath}
            className="observation-isolated"
            aria-hidden="true"
          />
        )}
        {markerIndexes.map((index) => (
          <rect
            key={pointKeys[index]}
            aria-hidden="true"
            x={x(analyticsPointTime(points[index])) - 1.75}
            y={y(points[index].value) - 1.75}
            width="3.5"
            height="3.5"
            className="observation-marker"
          />
        ))}
        <circle
          cx={x(analyticsPointTime(active))}
          cy={y(active.value)}
          r="4"
          className="observation-active-marker"
          aria-hidden="true"
        />
        {selected !== null && (
          <line
            x1={x(analyticsPointTime(active))}
            x2={x(analyticsPointTime(active))}
            y1="25"
            y2="180"
            stroke="var(--rule-focus)"
            strokeDasharray="3 4"
            pointerEvents="none"
          />
        )}
        <text x={left} y="206" className="svg-text">
          {axisDate(start)}
        </text>
        <text x={right} y="206" textAnchor="end" className="svg-text">
          {axisDate(end)}
        </text>
        <rect
          x={left}
          y="20"
          width={right - left}
          height="162"
          fill="transparent"
          className="observation-control"
          tabIndex={0}
          role="slider"
          aria-label="Explore volume history"
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={points.length - 1}
          aria-valuenow={Math.min(
            selected ?? points.length - 1,
            points.length - 1,
          )}
          aria-valuetext={`${date(active.timestamp)}: ${exactActiveValue} saved 24h hook-pool volume`}
          onPointerDown={pointAt}
          onPointerMove={(event) => {
            if (event.pointerType === "mouse") pointAt(event);
          }}
          onPointerLeave={(event) => {
            if (
              event.pointerType === "mouse" &&
              document.activeElement !== event.currentTarget
            )
              setSelectedKey(null);
          }}
          onFocus={() =>
            setSelectedKey(pointKeys[selected ?? points.length - 1])
          }
          onKeyDown={(event) => {
            if (
              ![
                "ArrowLeft",
                "ArrowRight",
                "ArrowUp",
                "ArrowDown",
                "Home",
                "End",
              ].includes(event.key)
            )
              return;
            event.preventDefault();
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? points.length - 1
                  : Math.max(
                      0,
                      Math.min(
                        points.length - 1,
                        (selected ?? points.length - 1) +
                          (event.key === "ArrowRight" || event.key === "ArrowUp"
                            ? 1
                            : -1),
                      ),
                    );
            setSelectedKey(pointKeys[next]);
          }}
        />
      </svg>
      <p className="observation-help">
        Hover or tap the plot. Arrow keys move between observations.
        {segments.gaps.length > 0 && (
          <span className="observation-gap-note">
            Shaded spans have no recorded observations for over{" "}
            {historyGapWords()}.
          </span>
        )}
      </p>
    </div>
  );
}
