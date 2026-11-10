import type { CSSProperties } from "react";
import "./charts.css";

export interface RibbonSegment {
  id: string;
  label: string;
  /** Positive measured value; the segment's length is proportional to it. */
  value: number;
  /** Colour expression for the mark (text never wears it). */
  color: string;
  valueLabel: string;
  shareLabel: string;
  /** Complete accessible name of a selectable segment. */
  ariaLabel: string;
  /** A grouped tail or unassigned remainder: drawn and listed, not selectable. */
  inert?: boolean;
  /** Hatched fill for a part no row accounts for. */
  hatched?: boolean;
}

export interface RibbonProps {
  segments: readonly RibbonSegment[];
  /** Accessible name of the group, e.g. "Volume by network". */
  label: string;
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  disabled?: boolean;
  className?: string;
}

/** One horizontal composition bar: each segment's length is its share of the
 * stated total, 2px of surface between neighbours, 4px rounded outer ends.
 * Segments are toggle buttons (aria-pressed) that behave exactly like the
 * ranked bars; the legend below repeats names and shares for sighted readers
 * and is hidden from assistive technology, which reads the segment names. */
export function Ribbon({
  segments,
  label,
  selectedId = null,
  onSelect,
  disabled = false,
  className = "",
}: RibbonProps) {
  const dimmed = (segment: RibbonSegment) =>
    selectedId !== null && segment.id !== selectedId;
  return (
    <div className={`chart-ribbon ${className}`.trim()} role="group" aria-label={label}>
      <div className="chart-ribbon-bar">
        {segments.map((segment) =>
          segment.inert ? (
            <span
              key={segment.id}
              className="chart-ribbon-segment"
              role="img"
              aria-label={segment.ariaLabel}
              title={`${segment.label} · ${segment.valueLabel} · ${segment.shareLabel}`}
              data-inert="true"
              data-hatched={segment.hatched || undefined}
              data-dimmed={dimmed(segment) || undefined}
              style={
                {
                  flexGrow: segment.value,
                  "--ribbon-color": segment.color,
                } as CSSProperties
              }
            />
          ) : (
            <button
              key={segment.id}
              type="button"
              className="chart-ribbon-segment"
              aria-pressed={onSelect ? selectedId === segment.id : undefined}
              aria-label={segment.ariaLabel}
              title={`${segment.label} · ${segment.valueLabel} · ${segment.shareLabel}`}
              data-selected={selectedId === segment.id || undefined}
              data-dimmed={dimmed(segment) || undefined}
              disabled={disabled || !onSelect}
              onClick={() =>
                onSelect?.(selectedId === segment.id ? null : segment.id)
              }
              style={
                {
                  flexGrow: segment.value,
                  "--ribbon-color": segment.color,
                } as CSSProperties
              }
            />
          ),
        )}
      </div>
      <ul className="chart-ribbon-legend" aria-hidden="true">
        {segments.map((segment) => (
          <li key={segment.id} data-dimmed={dimmed(segment) || undefined}>
            <i
              data-hatched={segment.hatched || undefined}
              style={{ "--ribbon-color": segment.color } as CSSProperties}
            />
            <span>{segment.label}</span>
            <small>{segment.shareLabel}</small>
          </li>
        ))}
      </ul>
    </div>
  );
}
