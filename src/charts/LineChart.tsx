import { memo, useMemo, useState } from "react";
import type { PointerEvent } from "react";
import { formatUtc, formatUtcTick } from "./format";
import { inspectionKeyHandler, useCoarsePointer, useElementWidth } from "./hooks";
import { nearestIndex, timeTicks } from "./scales";
import "./charts.css";

export interface LineChartProps {
  /** Observation times in epoch ms, ascending (duplicates allowed). */
  times: readonly number[];
  /** Observed values, same length as `times`. */
  values: readonly number[];
  /** Stable identity per observation (React keys). */
  keys: readonly string[];
  /** Contiguous runs of indices; lines are drawn only within a run. */
  segments: readonly (readonly number[])[];
  /** Unknown intervals between runs, drawn as bands, never bridged. */
  gaps: readonly { from: number; to: number }[];
  yScale: { maximum: number; ticks: readonly number[] };
  /** Pinned (selected) observation index. */
  selected: number;
  onSelect: (index: number) => void;
  /** Hovered observation (mouse only), or null when the pointer leaves. */
  onHover?: (index: number | null) => void;
  /** Escape: clear the pinned selection. */
  onClear?: () => void;
  formatAxisValue: (value: number) => string;
  formatValue: (value: number) => string;
  /** Accessible name of the chart group. */
  ariaLabel: string;
  /** Accessible name of the focusable inspection slider. */
  sliderLabel: string;
  valueText: (index: number) => string;
  describedBy?: string;
  /** Series name in the tooltip (e.g. "Rolling 24H volume"). */
  seriesLabel: string;
  /** Scope line in the tooltip (e.g. "All networks · tracked hook pools"). */
  scopeLabel?: string;
  gapTitle?: (from: number, to: number) => string;
  gapLabel?: string;
  /** Draw every observation marker up to this count; above it only isolated
   * observations get markers (every observation stays a path vertex). */
  maxMarkers?: number;
  disabled?: boolean;
  className?: string;
}

const round = (value: number) => Math.round(value * 100) / 100;

type Geometry = {
  x: (time: number) => number;
  y: (value: number) => number;
  left: number;
  right: number;
  top: number;
  bottom: number;
};

// Series geometry is independent of hover and selection so pointer movement
// never re-renders thousands of path vertices.
const Series = memo(function Series({
  times,
  values,
  keys,
  segments,
  gaps,
  geometry,
  maxMarkers,
  gapTitle,
  gapLabel,
}: {
  times: readonly number[];
  values: readonly number[];
  keys: readonly string[];
  segments: readonly (readonly number[])[];
  gaps: readonly { from: number; to: number }[];
  geometry: Geometry;
  maxMarkers: number;
  gapTitle?: (from: number, to: number) => string;
  gapLabel?: string;
}) {
  const { x, y, top, bottom } = geometry;
  const markers =
    times.length <= maxMarkers
      ? times.map((_, index) => index)
      : segments.filter((run) => run.length === 1).map((run) => run[0]);
  // One zero-length round-capped subpath per observation: an exact dot at the
  // real position, never a connecting line.
  const markerPath = markers
    .map((index) => {
      const px = round(x(times[index]));
      const py = round(y(values[index]));
      return `M${px},${py}L${px},${py}`;
    })
    .join("");
  return (
    <>
      {gaps.map(({ from, to }) => {
        const x1 = x(times[from]);
        const x2 = x(times[to]);
        return (
          <g key={`gap-${keys[from]}-${keys[to]}`} className="chart-gap">
            {gapTitle && <title>{gapTitle(from, to)}</title>}
            <rect
              x={x1}
              y={top}
              width={Math.max(0, x2 - x1)}
              height={bottom - top}
              className="chart-gap-band"
            />
            <line x1={x1} x2={x1} y1={top} y2={bottom} className="chart-gap-edge" />
            <line x1={x2} x2={x2} y1={top} y2={bottom} className="chart-gap-edge" />
            {gapLabel && x2 - x1 > 84 && (
              <text
                x={(x1 + x2) / 2}
                y={top + 16}
                textAnchor="middle"
                className="chart-gap-label"
              >
                {gapLabel}
              </text>
            )}
          </g>
        );
      })}
      {segments.map((run) => {
        const path = run
          .map(
            (index, at) =>
              `${at ? "L" : "M"}${round(x(times[index]))},${round(y(values[index]))}`,
          )
          .join("");
        return (
          <g key={keys[run[0]]}>
            {run.length > 1 && (
              <path
                d={`${path}L${round(x(times[run[run.length - 1]]))},${round(bottom)}L${round(x(times[run[0]]))},${round(bottom)}Z`}
                className="chart-area"
              />
            )}
            {run.length > 1 && <path d={path} className="chart-line" />}
          </g>
        );
      })}
      <path d={markerPath} className="chart-observations-ring" />
      <path d={markerPath} className="chart-observations" />
    </>
  );
});

/** Time series of real observations. Breaks the line at unknown intervals,
 * marks individual observations, and offers pointer (hover/tap-to-pin) and
 * full keyboard inspection through a focusable slider. */
export function LineChart({
  times,
  values,
  keys,
  segments,
  gaps,
  yScale,
  selected,
  onSelect,
  onHover,
  onClear,
  formatAxisValue,
  formatValue,
  ariaLabel,
  sliderLabel,
  valueText,
  describedBy,
  seriesLabel,
  scopeLabel,
  gapTitle,
  gapLabel = "No observations",
  maxMarkers = 80,
  disabled = false,
  className = "",
}: LineChartProps) {
  const [wrapper, width] = useElementWidth<HTMLDivElement>(960);
  const coarse = useCoarsePointer();
  const [hover, setHover] = useState<number | null>(null);
  const compact = width < 540;
  const start = times[0];
  const end = times[times.length - 1];
  const longest = Math.max(
    ...yScale.ticks.map((value) => formatAxisValue(value).length),
  );
  const left = Math.min(width * 0.4, Math.max(compact ? 48 : 64, longest * 7 + 16));
  const right = width - (compact ? 8 : 14);
  const top = 18;
  const height = compact ? 250 : 300;
  const bottom = height - 50;
  const geometry = useMemo<Geometry>(
    () => ({
      x: (time: number) =>
        end === start
          ? (left + right) / 2
          : left + ((time - start) / (end - start)) * (right - left),
      y: (value: number) =>
        bottom - (value / yScale.maximum) * (bottom - top),
      left,
      right,
      top,
      bottom,
    }),
    [start, end, left, right, bottom, yScale.maximum],
  );
  const ticks = useMemo(
    () => timeTicks(start, end, compact ? 3 : 6),
    [start, end, compact],
  );
  if (!times.length) return null;
  const span = end - start;
  const inspected = hover ?? selected;
  const ix = geometry.x(times[inspected]);
  const iy = geometry.y(values[inspected]);

  function pick(event: PointerEvent<SVGRectElement>) {
    const bounds = event.currentTarget.ownerSVGElement!.getBoundingClientRect();
    const position =
      ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * width;
    const time =
      start + ((position - left) / Math.max(1, right - left)) * (end - start);
    return nearestIndex(times, time);
  }
  const setHovered = (index: number | null) => {
    setHover(index);
    onHover?.(index);
  };
  const keyDown = inspectionKeyHandler({
    count: times.length,
    index: selected,
    onSelect: (index) => {
      setHovered(null);
      onSelect(index);
    },
    onClear,
    disabled,
  });
  let previousDay = "";
  return (
    <div
      ref={wrapper}
      className={`chart-line-chart ${className}`.trim()}
      data-compact={compact || undefined}
    >
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        role="group"
        aria-label={ariaLabel}
      >
        {yScale.ticks.map((value) => (
          <g key={value} className="chart-grid-row">
            <line
              x1={left}
              x2={right}
              y1={geometry.y(value)}
              y2={geometry.y(value)}
              className={value === 0 ? "chart-baseline" : "chart-grid"}
            />
            <text
              x={left - 10}
              y={geometry.y(value) + 4}
              textAnchor="end"
              className="chart-axis-label"
            >
              {formatAxisValue(value)}
            </text>
          </g>
        ))}
        <Series
          times={times}
          values={values}
          keys={keys}
          segments={segments}
          gaps={gaps}
          geometry={geometry}
          maxMarkers={maxMarkers}
          gapTitle={gapTitle}
          gapLabel={gapLabel}
        />
        {ticks.map((time, index) => {
          const tx = geometry.x(time);
          const label = formatUtcTick(time, span);
          const showDay =
            label.secondary !== null && label.secondary !== previousDay;
          if (label.secondary) previousDay = label.secondary;
          const anchor =
            ticks.length === 1
              ? "middle"
              : tx - left < 28
                ? "start"
                : right - tx < 28
                  ? "end"
                  : "middle";
          return (
            <g key={`${time}-${index}`}>
              <line
                x1={tx}
                x2={tx}
                y1={bottom}
                y2={bottom + 5}
                className="chart-baseline"
              />
              <text
                x={tx}
                y={bottom + 21}
                textAnchor={anchor}
                className="chart-axis-label"
              >
                {label.primary}
                {showDay && (
                  <tspan x={tx} dy="15" className="chart-axis-sublabel">
                    {label.secondary}
                  </tspan>
                )}
              </text>
            </g>
          );
        })}
        <text
          x={right}
          y={height - 4}
          textAnchor="end"
          className="chart-axis-unit"
        >
          UTC
        </text>
        <line
          x1={ix}
          x2={ix}
          y1={top}
          y2={bottom}
          className="chart-crosshair"
        />
        {hover !== null && hover !== selected && (
          <circle
            cx={geometry.x(times[selected])}
            cy={geometry.y(values[selected])}
            r={4}
            className="chart-pinned-point"
          />
        )}
        <circle cx={ix} cy={iy} r={9} className="chart-inspected-halo" />
        <circle cx={ix} cy={iy} r={4.5} className="chart-inspected-point" />
        <rect
          x={left - 6}
          y={top - 10}
          width={right - left + 12}
          height={bottom - top + 20}
          fill="transparent"
          className="chart-slider"
          tabIndex={disabled ? -1 : 0}
          role="slider"
          aria-label={sliderLabel}
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={times.length - 1}
          aria-valuenow={selected}
          aria-valuetext={valueText(selected)}
          aria-describedby={describedBy}
          aria-disabled={disabled || undefined}
          onPointerDown={(event) => {
            if (disabled) return;
            const index = pick(event);
            if (index >= 0) {
              setHovered(null);
              onSelect(index);
            }
          }}
          onPointerMove={(event) => {
            if (disabled || event.pointerType !== "mouse") return;
            const index = pick(event);
            if (index >= 0 && index !== hover) setHovered(index);
          }}
          onPointerLeave={() => hover !== null && setHovered(null)}
          onKeyDown={keyDown}
        />
      </svg>
      {hover !== null && !coarse && (
        <div
          className="chart-tooltip"
          role="presentation"
          style={{
            left: `${Math.round(ix)}px`,
            top: `${Math.round(Math.max(top, iy))}px`,
          }}
          data-flip={ix > width * 0.62 || undefined}
        >
          <span className="chart-tooltip-series">{seriesLabel}</span>
          <strong>{formatValue(values[hover])}</strong>
          <time dateTime={new Date(times[hover]).toISOString()}>
            {formatUtc(times[hover])}
          </time>
          {scopeLabel && <span className="chart-tooltip-scope">{scopeLabel}</span>}
        </div>
      )}
    </div>
  );
}
