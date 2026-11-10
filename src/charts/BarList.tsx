import { useId, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import "./charts.css";

export interface BarListRow {
  id: string;
  label: string;
  /** Secondary line under the label (pool counts, notes). */
  sublabel?: ReactNode;
  /** Formatted primary value ("$40.00", "—", "12"). */
  valueLabel: string;
  /** Exact value for the title tooltip. */
  exactLabel?: string;
  /** Formatted share in a <small> ("40%", "—"). */
  shareLabel?: string;
  /** Bar length as a fraction (0–1) of the chart denominator. null means not
   * measured: the track shows an explicit unmeasured state, never a zero bar. */
  share: number | null;
  /** Focused portion (cross-filter), as a fraction of the same denominator. */
  overlay?: number | null;
  overlayColor?: string;
  /** Bar colour (CSS colour expression). */
  color?: string;
  /** Small identity swatch beside the label (e.g. use-case colour). */
  swatch?: string;
  /** Leading artwork (protocol logo). */
  leading?: ReactNode;
  /** Complete accessible name of the row button. */
  ariaLabel: string;
  /** Dimmed because the current focus excludes it. */
  dimmed?: boolean;
}

export interface BarListProps {
  rows: readonly BarListRow[];
  /** Accessible name of the list. */
  label: string;
  selectedId?: string | null;
  /** Toggle selection; called with null to clear (Escape). */
  onSelect?: (id: string | null) => void;
  /** Rows shown before the expand control. */
  limit?: number;
  expandLabel?: (total: number) => string;
  collapseLabel?: string;
  disabled?: boolean;
  /** Number the rows (01, 02 …). */
  ranked?: boolean;
  empty?: ReactNode;
  className?: string;
}

const clampShare = (value: number | null | undefined) =>
  value === null || value === undefined || !Number.isFinite(value)
    ? 0
    : Math.max(0, Math.min(1, value)) * 100;

/** Ranked horizontal bars with toggle selection. Each row is a button with
 * aria-pressed; a measured zero shows an empty track with a zero tick, an
 * unmeasured value shows a hatched track and "—". Bar length is the share of
 * the chart's stated denominator, never of the largest visible bar. */
export function BarList({
  rows,
  label,
  selectedId = null,
  onSelect,
  limit,
  expandLabel = (total) => `Show all ${total.toLocaleString("en-US")}`,
  collapseLabel = "Show fewer",
  disabled = false,
  ranked = true,
  empty,
  className = "",
}: BarListProps) {
  const id = useId().replace(/:/g, "");
  const [expanded, setExpanded] = useState(false);
  if (!rows.length) return <>{empty}</>;
  const shown =
    limit && !expanded && !rows.some((row, index) => index >= limit && row.id === selectedId)
      ? rows.slice(0, limit)
      : rows;
  return (
    <div
      className={`chart-barlist ${className}`.trim()}
      data-ranked={ranked || undefined}
    >
      <ol className="chart-barlist-rows" id={`${id}-rows`} aria-label={label}>
        {shown.map((row, index) => {
          const selected = selectedId === row.id;
          const measured = row.share !== null && Number.isFinite(row.share);
          return (
            <li key={row.id}>
              <button
                type="button"
                className="chart-bar-row"
                aria-pressed={onSelect ? selected : undefined}
                aria-label={row.ariaLabel}
                data-selected={selected || undefined}
                data-dimmed={row.dimmed || undefined}
                disabled={disabled || !onSelect}
                onClick={() => onSelect?.(selected ? null : row.id)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && selectedId !== null) {
                    event.preventDefault();
                    onSelect?.(null);
                  }
                }}
                style={
                  {
                    "--bar-color": row.color,
                    "--bar-overlay": row.overlayColor,
                    "--row-index": index,
                  } as CSSProperties
                }
              >
                {ranked && (
                  <span className="chart-bar-rank" aria-hidden="true">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                )}
                <span className="chart-bar-body">
                  <span className="chart-bar-label">
                    {row.leading}
                    {row.swatch && (
                      <i
                        className="chart-bar-swatch"
                        aria-hidden="true"
                        style={{ background: row.swatch }}
                      />
                    )}
                    <strong>{row.label}</strong>
                    {row.sublabel && (
                      <span className="chart-bar-sublabel">{row.sublabel}</span>
                    )}
                    <span className="chart-bar-value" title={row.exactLabel}>
                      {row.valueLabel}
                      {row.shareLabel !== undefined && (
                        <small>{row.shareLabel}</small>
                      )}
                    </span>
                  </span>
                  <span
                    className="chart-bar-track"
                    data-unmeasured={!measured || undefined}
                    aria-hidden="true"
                  >
                    <span
                      className="chart-bar-fill"
                      data-positive={(measured && (row.share ?? 0) > 0) || undefined}
                      data-zero={(measured && row.share === 0) || undefined}
                      style={{ width: `${clampShare(row.share)}%` }}
                    />
                    {row.overlay !== undefined && row.overlay !== null && (
                      <span
                        className="chart-bar-overlay"
                        style={{ width: `${clampShare(row.overlay)}%` }}
                      />
                    )}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {limit !== undefined && rows.length > limit && (
        <button
          type="button"
          className="chart-expand"
          aria-expanded={expanded}
          aria-controls={`${id}-rows`}
          disabled={disabled}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? collapseLabel : expandLabel(rows.length)}
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="M4 6l4 4 4-4" />
          </svg>
        </button>
      )}
    </div>
  );
}

/** A bare bar track for custom rows (e.g. ranked tables) that need the same
 * geometry and unmeasured/zero treatment as BarList. */
export function BarTrack({
  share,
  overlay,
  color,
  overlayColor,
}: {
  share: number | null;
  overlay?: number | null;
  color?: string;
  overlayColor?: string;
}) {
  const measured = share !== null && Number.isFinite(share);
  return (
    <span
      className="chart-bar-track"
      data-unmeasured={!measured || undefined}
      aria-hidden="true"
      style={
        { "--bar-color": color, "--bar-overlay": overlayColor } as CSSProperties
      }
    >
      <span
        className="chart-bar-fill"
        data-positive={(measured && (share ?? 0) > 0) || undefined}
        data-zero={(measured && share === 0) || undefined}
        style={{ width: `${clampShare(share)}%` }}
      />
      {overlay !== undefined && overlay !== null && (
        <span
          className="chart-bar-overlay"
          style={{ width: `${clampShare(overlay)}%` }}
        />
      )}
    </span>
  );
}
