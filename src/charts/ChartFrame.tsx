import { useId, useState } from "react";
import type { HTMLAttributes, ReactNode } from "react";
import "./charts.css";

export type ChartState =
  | "ready"
  | "loading"
  | "empty"
  | "partial"
  | "error"
  | "stale";

export interface ChartFreshness {
  /** Visible clock text, e.g. "measured 4m ago". */
  label: ReactNode;
  tone: "current" | "stale" | "unknown";
  /** Exact original clock for `title` / `<time datetime>`. */
  dateTime?: string | null;
  title?: string;
}

export interface ChartMessage {
  title: string;
  description: ReactNode;
  action?: ReactNode;
}

export interface ChartFrameProps
  extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  /** Plate title. Becomes the accessible name of the section (a region). */
  title: ReactNode;
  headingLevel?: 2 | 3;
  /** Small mono caps line above the title (e.g. "Who contributed"). */
  kicker?: ReactNode;
  /** What is measured · scope · window, as plain text pieces. */
  caption?: ReactNode;
  freshness?: ChartFreshness | null;
  /** Coverage badge, e.g. "Partial coverage · Not total Uniswap volume". */
  badge?: ReactNode;
  /** Segmented controls placed in the header (scale, range…). */
  controls?: ReactNode;
  legend?: ReactNode;
  /** Export slot (CSV buttons) beside the table disclosure. */
  actions?: ReactNode;
  state?: ChartState;
  /** Explains empty / error / stale / partial states. */
  message?: ChartMessage | null;
  /** "View as table" disclosure; the table renders only while open. */
  table?: {
    summary?: ReactNode;
    count?: number;
    render: () => ReactNode;
  } | null;
  footnote?: ReactNode;
  /** Render a framed instrument plate (default) or a bare section. */
  plate?: boolean;
  children?: ReactNode;
}

/** The instrument plate every chart sits in: a caption that states what is
 * measured, over what scope and how fresh; a legend; designed loading,
 * empty, partial, error and stale states; a "View as table" twin; an export
 * slot; and a footnote for method notes. */
export function ChartFrame({
  title,
  headingLevel = 3,
  kicker,
  caption,
  freshness,
  badge,
  controls,
  legend,
  actions,
  state = "ready",
  message,
  table,
  footnote,
  plate = true,
  className = "",
  children,
  ...section
}: ChartFrameProps) {
  const generated = useId().replace(/:/g, "");
  const titleId = `${generated}-title`;
  const [tableOpen, setTableOpen] = useState(false);
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const showMessage =
    message && (state === "empty" || state === "error" || state === "stale");
  return (
    <section
      aria-labelledby={titleId}
      data-state={state}
      {...section}
      className={`chart-frame${plate ? " plate" : ""} ${className}`.trim()}
    >
      <header className="chart-frame-head">
        <div className="chart-frame-titles">
          {kicker && <span className="chart-kicker">{kicker}</span>}
          <Heading id={titleId} className="chart-title">
            {title}
          </Heading>
          {(caption || freshness) && (
            <p className="chart-caption">
              {caption}
              {freshness && (
                <span
                  className="chart-freshness"
                  data-tone={freshness.tone}
                  title={freshness.title}
                >
                  <span className="chart-freshness-dot" aria-hidden="true" />
                  {freshness.dateTime ? (
                    <time dateTime={freshness.dateTime}>{freshness.label}</time>
                  ) : (
                    freshness.label
                  )}
                </span>
              )}
            </p>
          )}
        </div>
        {controls && <div className="chart-frame-controls">{controls}</div>}
      </header>
      {(badge || legend) && (
        <div className="chart-frame-meta">
          {badge && <span className="chart-badge">{badge}</span>}
          {legend && <div className="chart-legend-slot">{legend}</div>}
        </div>
      )}
      <div
        className="chart-frame-body"
        aria-busy={state === "loading" || undefined}
      >
        {showMessage ? (
          <div
            className="chart-state"
            data-kind={state}
            role={state === "error" ? "alert" : undefined}
          >
            <span className="chart-state-rule" aria-hidden="true" />
            <strong>{message.title}</strong>
            <p>{message.description}</p>
            {message.action}
          </div>
        ) : state === "loading" && !children ? (
          <div className="chart-skeleton" aria-hidden="true">
            <span className="skeleton" />
            <span className="skeleton" />
            <span className="skeleton" />
          </div>
        ) : (
          children
        )}
        {state === "partial" && message && (
          <p className="chart-partial-note">
            <strong>{message.title}</strong> {message.description}
          </p>
        )}
      </div>
      {(table || actions) && (
        <div className="chart-frame-foot">
          {table && (
            <details
              className="chart-table-disclosure"
              onToggle={(event) => setTableOpen(event.currentTarget.open)}
            >
              <summary>
                <span>
                  {table.summary ?? "View as table"}
                  {table.count !== undefined && (
                    <small>{table.count.toLocaleString("en-US")}</small>
                  )}
                </span>
                <svg
                  className="chart-table-chevron"
                  viewBox="0 0 16 16"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path d="M4 6l4 4 4-4" />
                </svg>
              </summary>
              {tableOpen && (
                <div className="chart-table-body">{table.render()}</div>
              )}
            </details>
          )}
          {actions && <div className="chart-frame-actions">{actions}</div>}
        </div>
      )}
      {footnote && <div className="chart-footnote">{footnote}</div>}
    </section>
  );
}

/** Visually hidden polite live region for inspection announcements made
 * outside a focused slider (e.g. Previous/Next buttons, pointer pins). */
export function ChartAnnouncer({ message }: { message: string }) {
  return (
    <span className="sr-only" role="status" aria-live="polite">
      {message}
    </span>
  );
}
