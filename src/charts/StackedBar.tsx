import type { ReactNode } from "react";
import { formatCount, formatPercent } from "./format";
import "./charts.css";

export interface StackedSegment {
  id: string;
  label: string;
  value: number;
  color: string;
  /** Hatched fill for "absent" states (no value, not checked). */
  hatched?: boolean;
  /** Extra legend text (e.g. "older than 5 minutes"). */
  note?: ReactNode;
}

export interface StackedBarProps {
  segments: readonly StackedSegment[];
  /** Denominator; segments are fractions of it. Must equal their sum for a
   * complete partition — the component never renormalises. */
  total: number;
  /** Accessible summary label, e.g. "Volume evidence for 41,217 sample pools". */
  label: string;
  /** What the percentages are "of", shown in the legend. */
  denominatorLabel?: string;
  formatValue?: (value: number) => string;
  /** Emphasise one segment (others dim). */
  highlight?: string | null;
  legend?: boolean;
  className?: string;
}

/** A single 100% bar for evidence quality and coverage partitions. Non-zero
 * segments keep at least 2px so they remain visible; exact counts and
 * percentages of the stated denominator are always in the legend. */
export function StackedBar({
  segments,
  total,
  label,
  denominatorLabel,
  formatValue = formatCount,
  highlight = null,
  legend = true,
  className = "",
}: StackedBarProps) {
  const valid = Number.isFinite(total) && total > 0;
  const summary = segments
    .map(
      (segment) =>
        `${segment.label} ${formatValue(segment.value)}${valid ? ` (${formatPercent(segment.value / total)})` : ""}`,
    )
    .join(", ");
  return (
    <div className={`chart-stack ${className}`.trim()}>
      <div
        className="chart-stack-bar"
        role="img"
        aria-label={`${label}: ${summary}`}
        data-empty={!valid || undefined}
      >
        {valid &&
          segments
            .filter((segment) => segment.value > 0)
            .map((segment) => (
              <span
                key={segment.id}
                className="chart-stack-segment"
                data-hatched={segment.hatched || undefined}
                data-dimmed={
                  (highlight !== null && highlight !== segment.id) || undefined
                }
                style={{
                  flexGrow: segment.value,
                  flexBasis: 0,
                  background: segment.hatched ? undefined : segment.color,
                  color: segment.color,
                }}
              />
            ))}
      </div>
      {legend && (
        <ul className="chart-stack-legend">
          {segments.map((segment) => (
            <li
              key={segment.id}
              data-dimmed={
                (highlight !== null && highlight !== segment.id) || undefined
              }
            >
              <i
                aria-hidden="true"
                data-hatched={segment.hatched || undefined}
                style={{
                  background: segment.hatched ? undefined : segment.color,
                  color: segment.color,
                }}
              />
              <span className="chart-stack-label">
                {segment.label}
                {segment.note && <small>{segment.note}</small>}
              </span>
              <span className="chart-stack-value">
                {formatValue(segment.value)}
                <small>
                  {valid ? formatPercent(segment.value / total) : "—"}
                  {denominatorLabel ? ` ${denominatorLabel}` : ""}
                </small>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
