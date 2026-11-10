import { useState } from "react";
import type { PointerEvent, ReactNode } from "react";
import { inspectionKeyHandler, useCoarsePointer, useElementWidth } from "./hooks";
import { thinTicks } from "./scales";
import type { NumericAxis } from "./scales";
import "./charts.css";

export interface ScatterPoint {
  key: string;
  x: number;
  y: number;
  /** Fill colour (CSS colour expression). */
  color: string;
  /** Dimmed by the current focus (still inspectable). */
  dimmed?: boolean;
  /** Hollow marker (e.g. unattributed). */
  hollow?: boolean;
}

export interface ScatterProps {
  points: readonly ScatterPoint[];
  xAxis: NumericAxis;
  yAxis: NumericAxis;
  formatX: (value: number) => string;
  formatY: (value: number) => string;
  /** Axis titles with units; log axes should say "log". */
  xLabel: string;
  yLabel: string;
  selected: number;
  onSelect: (index: number) => void;
  sliderLabel: string;
  valueText: (index: number) => string;
  describedBy?: string;
  /** Hover tooltip content (mouse only; touch pins via selection). */
  tooltip?: (index: number) => ReactNode;
  disabled?: boolean;
  height?: number;
  className?: string;
}

/** Relationship of two positive measurements (log or linear axes). Points
 * are picked by nearest distance (≥ 24px hit area), never by landing on a
 * tiny dot; the plot is a focusable slider for keyboard inspection. */
export function Scatter({
  points,
  xAxis,
  yAxis,
  formatX,
  formatY,
  xLabel,
  yLabel,
  selected,
  onSelect,
  sliderLabel,
  valueText,
  describedBy,
  tooltip,
  disabled = false,
  height = 320,
  className = "",
}: ScatterProps) {
  const [wrapper, width] = useElementWidth<HTMLDivElement>(640);
  const coarse = useCoarsePointer();
  const [hover, setHover] = useState<number | null>(null);
  const compact = width < 420;
  const longest = Math.max(
    4,
    ...yAxis.ticks.map((tick) => formatY(tick.value).length),
  );
  const left = Math.max(compact ? 50 : 62, Math.ceil(longest * 6.8) + 14);
  const right = width - (compact ? 10 : 18);
  const top = 26;
  const bottom = height - 40;
  const px = (value: number) =>
    left + (xAxis.position(value) ?? 0) * (right - left);
  const py = (value: number) =>
    bottom - (yAxis.position(value) ?? 0) * (bottom - top);
  const active = points[selected];
  const inspected = hover ?? selected;

  function nearest(event: PointerEvent<SVGRectElement>) {
    const bounds = event.currentTarget.ownerSVGElement!.getBoundingClientRect();
    const scale = width / Math.max(1, bounds.width);
    const cx = (event.clientX - bounds.left) * scale;
    const cy = (event.clientY - bounds.top) * scale;
    let best = -1;
    let distance = Infinity;
    points.forEach((point, index) => {
      const dx = px(point.x) - cx;
      const dy = py(point.y) - cy;
      const d = dx * dx + dy * dy;
      if (d < distance) {
        distance = d;
        best = index;
      }
    });
    return distance <= 28 * 28 ? best : -1;
  }

  const keyDown = inspectionKeyHandler({
    count: points.length,
    index: selected,
    onSelect: (index) => {
      setHover(null);
      onSelect(index);
    },
    disabled,
  });
  const xTicks = thinTicks(xAxis.ticks, right - left, compact ? 64 : 76);
  // Draw dimmed points first so emphasised points sit on top.
  const order = points
    .map((point, index) => ({ point, index }))
    .sort(
      (a, b) =>
        Number(!a.point.dimmed) - Number(!b.point.dimmed) ||
        Number(a.index === selected) - Number(b.index === selected),
    );
  return (
    <div ref={wrapper} className={`chart-scatter ${className}`.trim()}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        role="group"
        aria-label={`${yLabel} by ${xLabel}`}
      >
        <text x={left} y={12} className="chart-axis-unit" textAnchor="start">
          {yLabel}
        </text>
        {yAxis.ticks.map((tick, index) => {
          const ty = bottom - tick.fraction * (bottom - top);
          return (
            <g key={`y${index}`}>
              <line
                x1={left}
                x2={right}
                y1={ty}
                y2={ty}
                className={tick.fraction === 0 ? "chart-baseline" : "chart-grid"}
              />
              <text
                x={left - 9}
                y={ty + 4}
                textAnchor="end"
                className="chart-axis-label"
              >
                {formatY(tick.value)}
              </text>
            </g>
          );
        })}
        {xTicks.map((tick, index) => {
          const tx = left + tick.fraction * (right - left);
          return (
            <g key={`x${index}`}>
              <line x1={tx} x2={tx} y1={top} y2={bottom} className="chart-grid" />
              <text
                x={tx}
                y={bottom + 18}
                textAnchor={
                  tick.fraction === 0
                    ? "start"
                    : tick.fraction === 1
                      ? "end"
                      : "middle"
                }
                className="chart-axis-label"
              >
                {formatX(tick.value)}
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
          {xLabel}
        </text>
        {active && (
          <>
            <line
              x1={px(active.x)}
              x2={px(active.x)}
              y1={top}
              y2={bottom}
              className="chart-crosshair"
            />
            <line
              x1={left}
              x2={right}
              y1={py(active.y)}
              y2={py(active.y)}
              className="chart-crosshair"
            />
          </>
        )}
        {order.map(({ point, index }) => (
          <circle
            key={point.key}
            cx={px(point.x)}
            cy={py(point.y)}
            r={index === selected ? 6.5 : index === inspected ? 6 : 4.5}
            className="chart-dot"
            data-dimmed={point.dimmed || undefined}
            data-hollow={point.hollow || undefined}
            data-selected={index === selected || undefined}
            style={
              point.hollow ? { stroke: point.color } : { fill: point.color }
            }
          />
        ))}
        {active && (
          <circle
            className="chart-dot-ring"
            cx={px(active.x)}
            cy={py(active.y)}
            r={11}
          />
        )}
        <rect
          x={left - 8}
          y={top - 8}
          width={right - left + 16}
          height={bottom - top + 16}
          fill="transparent"
          className="chart-slider"
          tabIndex={disabled || !points.length ? -1 : 0}
          role="slider"
          aria-label={sliderLabel}
          aria-disabled={disabled || undefined}
          aria-valuemin={1}
          aria-valuemax={points.length}
          aria-valuenow={selected + 1}
          aria-valuetext={points.length ? valueText(selected) : undefined}
          aria-describedby={describedBy}
          onPointerDown={(event) => {
            if (disabled) return;
            const index = nearest(event);
            if (index >= 0) {
              setHover(null);
              onSelect(index);
            }
          }}
          onPointerMove={(event) => {
            if (disabled || event.pointerType !== "mouse") return;
            const index = nearest(event);
            setHover(index >= 0 ? index : null);
          }}
          onPointerLeave={() => setHover(null)}
          onKeyDown={keyDown}
          style={{ cursor: hover !== null ? "pointer" : undefined }}
        />
      </svg>
      {hover !== null && !coarse && tooltip && points[hover] && (
        <div
          className="chart-tooltip"
          role="presentation"
          style={{
            left: `${Math.round(px(points[hover].x))}px`,
            top: `${Math.round(py(points[hover].y))}px`,
          }}
          data-flip={px(points[hover].x) > width * 0.6 || undefined}
        >
          {tooltip(hover)}
        </div>
      )}
    </div>
  );
}
