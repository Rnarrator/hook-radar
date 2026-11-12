import { useId, useLayoutEffect } from "react";
import { fitFiguresNow } from "../fit-figures";
import type { ReactNode } from "react";
import { useHeldHeight } from "../useHeldHeight";
import {
  NO_SPAN_GROUP,
  spanEmptyText,
  spanEmptyTitle,
  spanRowCoverage,
  spanRowPools,
} from "../analytics-span";
import type { SpanScope } from "../analytics-span";
import type {
  MarketFreshness,
  MetricFreshness,
  WindowKey,
} from "../../shared/types";
import type {
  AnalyticsFocus,
  AnalyticsMetric,
  FocusBreakdown,
  MetricFields,
} from "../analytics-focus";
import {
  evidencePartition,
  metricCopy,
  metricPools,
  metricShare,
  metricValue,
} from "../analytics-focus";
import {
  BarList,
  ChartFrame,
  EVIDENCE_COLORS,
  FreshnessWindow,
  Ribbon,
  SELECTED_COLOR,
  StackedBar,
  UNATTRIBUTED_COLOR,
  formatAge,
  formatOldest,
  formatCount,
  formatMoneyCompact,
  formatMoneyExact,
  formatPercent,
  formatUtc,
  formatUtcClock,
  parseClock,
  useCaseColor,
} from "../charts/index";
import type { BarListRow, RibbonSegment } from "../charts/index";
import { compositionParts, networkColors } from "../analytics-composition";
import type { RibbonPart } from "../analytics-composition";
import { ArrowRight, ChevronDown, Info, Network, X } from "./Icons";
import "./analytics-charts.css";
import { STATIC_EDITION, evaluationNow } from "../edition";

export const METRIC_OPTIONS: readonly [AnalyticsMetric, string][] = [
  ["volume", "Volume"],
  ["reserves", "Reserves"],
  ["trading", "Pools with trading"],
];

export interface FocusSummary {
  /** "Network", "Use case" or "Project". */
  kind: string;
  label: string;
  /** e.g. "$40.00 of $100.00 tracked 24H volume". */
  detail?: ReactNode;
  /** Drill actions (scope to network, open project…). */
  actions?: ReactNode;
}

interface ControlBarProps {
  sections: readonly (readonly [string, string])[];
  metric: AnalyticsMetric;
  setMetric: (metric: AnalyticsMetric) => void;
  chain: string;
  setChain: (chain: string) => void;
  networks: readonly { slug: string; name: string }[];
  /** Keep an unknown deep-linked network visible as the selected value. */
  unknownChain?: boolean;
  windowLabel: string;
  actions: ReactNode;
  focus: FocusSummary | null;
  clearFocus: () => void;
  /** Edition: the focus bar keeps at least the height it had before a span was
   * chosen: its detail is a sentence of another length under 7D or 30D. */
  focusHold?: boolean;
  disabled?: boolean;
}

/** The sticky investigation bar: sections, metric, network scope and data
 * actions, plus the active focus so it stays visible while drilling down. */
export function AnalyticsControlBar({
  sections,
  metric,
  setMetric,
  chain,
  setChain,
  networks,
  unknownChain = false,
  windowLabel,
  actions,
  focus,
  clearFocus,
  focusHold = false,
  disabled = false,
}: ControlBarProps) {
  const focusHeld = useHeldHeight<HTMLDivElement>(focusHold);
  return (
    <div className="analytics-commandbar" data-focused={focus ? "true" : undefined}>
      <div className="analytics-commandbar-row">
        <nav className="analytics-sections" aria-label="Analytics sections">
          {sections.map(([href, label]) => (
            <a key={href} href={href}>
              {label}
            </a>
          ))}
        </nav>
        <div className="analytics-toolbar">
          <div
            className="segmented analytics-metric-switch"
            role="group"
            aria-label="Market composition metric"
          >
            {METRIC_OPTIONS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={metric === value}
                disabled={disabled}
                onClick={() => setMetric(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="select-control analytics-network-select">
            <Network size={16} />
            <span className="sr-only">Analytics network</span>
            <select
              value={chain}
              disabled={disabled}
              onChange={(event) => setChain(event.target.value)}
            >
              <option value="all">All networks</option>
              {unknownChain && <option value={chain}>Unknown network</option>}
              {networks.map((network) => (
                <option key={network.slug} value={network.slug}>
                  {network.name}
                </option>
              ))}
            </select>
            <ChevronDown size={14} />
          </label>
          <span className="analytics-scope-caption">{windowLabel} · USD</span>
          <div className="analytics-toolbar-actions">{actions}</div>
        </div>
      </div>
      {focus && (
        <div
          ref={focusHeld.ref}
          style={focusHeld.style}
          className="analytics-focus-bar"
          role="status"
        >
          <span className="analytics-focus-kind">Focus · {focus.kind}</span>
          <button
            type="button"
            className="analytics-focus-chip"
            onClick={clearFocus}
            aria-label={`Clear focus on ${focus.label}`}
          >
            <strong>{focus.label}</strong>
            <X size={14} />
          </button>
          {focus.detail && (
            <span className="analytics-focus-detail">{focus.detail}</span>
          )}
          {focus.actions && (
            <span className="analytics-focus-actions">{focus.actions}</span>
          )}
        </div>
      )}
    </div>
  );
}

export interface ReadoutItem {
  key: AnalyticsMetric | "projects";
  label: ReactNode;
  value: string;
  testId: string;
  exact?: string;
  /** What a screen reader hears instead of the figure, when the figure carries a
   * mark it would read badly ("≥$2.31B"). The figure is then hidden from the
   * accessibility tree, and its text stays exactly as drawn. */
  spoken?: string;
  caption: ReactNode;
  primary?: boolean;
  /** Edition: the tile keeps at least the height it had before a span was chosen,
   * so a caption of another length moves nothing below it. */
  hold?: boolean;
}

/** "What is measured": the four current readouts in the display face, the
 * active metric marked, and the honest scope line beneath. */
export function AnalyticsReadouts({
  items,
  metric,
  setMetric,
  kicker = "What is measured",
  scope,
  method,
  composition,
  status,
  scopeHold = false,
  scopeHoldWidth = false,
  disabled = false,
}: {
  items: ReadoutItem[];
  metric: AnalyticsMetric;
  setMetric: (metric: AnalyticsMetric) => void;
  kicker?: string;
  scope: ReactNode;
  method: ReactNode;
  /** Composition ribbons shown between the readouts and the method note. */
  composition?: ReactNode;
  /** Live refresh status; the slot is always present so nothing shifts. */
  status?: ReactNode;
  /** Edition: the scope line keeps at least the height it had before a span was
   * chosen (see useHeldHeight). */
  scopeHold?: boolean;
  /** Edition: and the width too, while its figures load or failed (a shorter line
   * would fit beside the heading and move the rows below it). */
  scopeHoldWidth?: boolean;
  disabled?: boolean;
}) {
  const id = useId().replace(/:/g, "");
  const scopeHeld = useHeldHeight<HTMLParagraphElement>(
    scopeHold,
    scopeHoldWidth,
  );
  return (
    <section
      className="analytics-step analytics-measured"
      id="analytics-overview"
      aria-labelledby={`${id}-step`}
    >
      <header className="analytics-step-head analytics-step-head-inline">
        <span className="analytics-step-kicker">{kicker}</span>
        <h2 id={`${id}-step`} className="sr-only">
          Current market measurements
        </h2>
        <p
          ref={scopeHeld.ref}
          style={scopeHeld.style}
          className="analytics-scope-line"
        >
          {scope}
        </p>
        {status !== undefined && (
          <span className="analytics-refresh-status" role="status">
            {status}
          </span>
        )}
      </header>
      <div
        className="analytics-metrics"
        role="group"
        aria-label="Current market measurements"
      >
        {items.map((item) => (
          <ReadoutTile
            key={item.key}
            item={item}
            active={item.key === metric}
            setMetric={setMetric}
            disabled={disabled}
          />
        ))}
      </div>
      {composition}
      {method}
    </section>
  );
}

function ReadoutTile({
  item,
  active,
  setMetric,
  disabled,
}: {
  item: ReadoutItem;
  active: boolean;
  setMetric: (metric: AnalyticsMetric) => void;
  disabled: boolean;
}) {
  const held = useHeldHeight<HTMLDivElement>(item.hold === true);
  const selectable = item.key !== "projects";
  // A figure that changes when a span is chosen is fitted before it is drawn, so
  // a longer one never shows wrapped for a frame (the tile would move).
  useLayoutEffect(() => {
    if (STATIC_EDITION) fitFiguresNow();
  }, [item.value]);
  return (
    <div
      ref={held.ref}
      style={held.style}
      className={`analytics-metric${item.primary ? " analytics-metric-primary" : ""}`}
      data-active={active || undefined}
    >
      <span className="analytics-metric-label">{item.label}</span>
      <strong
        data-testid={item.testId}
        title={item.exact}
        aria-hidden={item.spoken ? true : undefined}
      >
        {/* The pixel face draws "≥" so small that it reads as a "2": the sign
            alone is set in the data face (the text itself is unchanged). */}
        {item.value.startsWith("≥") ? (
          <>
            <span className="analytics-bound-sign">≥</span>
            {item.value.slice(1)}
          </>
        ) : (
          item.value
        )}
      </strong>
      {item.spoken && <span className="sr-only">{item.spoken}</span>}
      {item.caption}
      {selectable && !active && (
        <button
          type="button"
          className="analytics-metric-switch-link"
          disabled={disabled}
          onClick={() => setMetric(item.key as AnalyticsMetric)}
        >
          Rank by{" "}
          {(
            METRIC_OPTIONS.find(([value]) => value === item.key)?.[1] ?? ""
          ).toLowerCase()}
          <ArrowRight size={12} />
        </button>
      )}
    </div>
  );
}

const TAIL_COLOR = "color-mix(in oklab, var(--ink-faint) 82%, var(--surface-3))";

/** Two composition ribbons under the readouts: where the tracked total came
 * from by network, and by use case. They reuse the contributor bars' values
 * and denominator, select and clear the same focus, and say so in their names. */
export function AnalyticsComposition({
  model,
  metric,
  focus,
  setFocus,
  pending = null,
  disabled = false,
  heldKey = null,
}: {
  model: ContributorsModel;
  metric: AnalyticsMetric;
  focus: AnalyticsFocus | null;
  setFocus: (focus: AnalyticsFocus | null) => void;
  /** Edition: the span's figures are loading or failed. The ribbons give way to
   * one line; while loading they keep the height they had, so the page below
   * does not move. */
  pending?: SpanPending | null;
  disabled?: boolean;
  /** Edition: names what the ribbons show apart from the span (network, metric,
   * snapshot). With it the block is never shorter than the tallest it has been
   * for that key at this width: a span lists fewer networks and use cases, its
   * legends wrap onto fewer lines, and pressing 7D, 30D or 24H would otherwise
   * pull everything below the block up or down (see useHeldHeight). Null on the
   * live page, which has no span. */
  heldKey?: string | null;
}) {
  const held = useHeldHeight<HTMLDivElement>(
    pending?.phase === "loading",
    false,
    heldKey,
  );
  const span = metric === "volume" ? model.span : undefined;
  const fmt = valueFormat(metric, span);
  const composition = pending ? null : compositionParts(model, metric);
  if (pending)
    return (
      <div
        ref={held.ref}
        style={held.style}
        className="analytics-composition analytics-span-pending"
        data-testid="analytics-composition"
        role="status"
      >
        <p>{pendingText(pending)}</p>
      </div>
    );
  if (!composition) return null;
  const copy = metricCopy(metric, model.windowKey, span);
  const networkColor = networkColors(
    composition.networks
      .filter((part) => !part.tail && !part.remainder)
      .map((part) => part.id),
    TAIL_COLOR,
  );
  const segments = (
    parts: RibbonPart[],
    entity: string,
    color: (part: RibbonPart, rank: number) => string,
  ): RibbonSegment[] =>
    parts.map((part, rank) => ({
      id: part.id,
      label: part.label,
      value: part.value,
      color: part.remainder ? "var(--ink-muted)" : part.tail ? TAIL_COLOR : color(part, rank),
      valueLabel: fmt.compact(part.value),
      shareLabel: formatPercent(part.share),
      inert: part.tail,
      hatched: part.remainder,
      ariaLabel: `Composition bar, ${part.label}: ${fmt.spoken(part.value)}, ${formatPercent(part.share)} ${copy.denominator}${part.tail ? "" : `. Focus ${entity}.`}`,
    }));
  const select = (kind: AnalyticsFocus["kind"]) => (id: string | null) =>
    setFocus(id === null ? null : { kind, id });
  return (
    <div
      ref={held.ref}
      style={held.style}
      className="analytics-composition"
      data-testid="analytics-composition"
    >
      {composition.networks.length > 0 && (
        <div className="analytics-composition-row">
          <span className="analytics-composition-label">By network</span>
          <Ribbon
            label={`${copy.name} by network, composition`}
            segments={segments(composition.networks, "network", (part) =>
              networkColor.get(part.id) ?? TAIL_COLOR,
            )}
            selectedId={focus?.kind === "network" ? focus.id : null}
            onSelect={select("network")}
            disabled={disabled}
          />
        </div>
      )}
      {composition.categories.length > 0 && (
        <div className="analytics-composition-row">
          <span className="analytics-composition-label">By use case</span>
          <Ribbon
            label={`${copy.name} by use case, composition`}
            segments={segments(composition.categories, "use case", (part) =>
              part.id === "Unattributed" ? UNATTRIBUTED_COLOR : useCaseColor(part.id),
            )}
            selectedId={focus?.kind === "category" ? focus.id : null}
            onSelect={select("category")}
            disabled={disabled}
          />
        </div>
      )}
    </div>
  );
}

/** The summary line of the Data notes. Under a span it says which span and
 * through which day, and at some widths that line wraps differently from the 24H
 * wording; with `heldKey` it is never shorter than it has been for that key, so
 * the History panel and everything below it stay where they were (see
 * useHeldHeight). Without a key it is a plain summary. */
export function AnalyticsMethodSummary({
  heldKey = null,
  children,
}: {
  heldKey?: string | null;
  children: ReactNode;
}) {
  const held = useHeldHeight<HTMLElement>(false, false, heldKey);
  return (
    <summary ref={held.ref} style={held.style}>
      {children}
    </summary>
  );
}

/** A use-case slice for any metric (value is USD or a pool count). */
export interface ContributorSlice {
  category: string;
  value: number | null;
  share: number | null;
  measuredPools: number;
}

export interface ContributorNetwork extends MetricFields {
  chain: string;
  name: string;
}

export interface ContributorsModel {
  chain: string;
  windowKey: WindowKey;
  totals: MetricFields;
  networks: ContributorNetwork[];
  /** Per-metric use-case slices; null when the metric cannot be split. */
  categories: Record<AnalyticsMetric, ContributorSlice[] | null>;
  /** Edition: 7D or 30D of the largest pools. Present only on the model built
   * for the volume metric under a span; every other metric keeps its 24H model. */
  span?: SpanScope;
}

export function formatMetric(
  metric: AnalyticsMetric,
  value: number | null,
): string {
  return metric === "trading" ? formatCount(value) : formatMoneyCompact(value);
}

export function formatMetricExact(
  metric: AnalyticsMetric,
  value: number | null,
): string {
  if (metric !== "trading") return formatMoneyExact(value);
  return value === null ? "Not available" : `${formatCount(value)} pools`;
}

/** How the values of a metric are written: compact (bars, ribbons), exact (a
 * table cell) and spoken (a title or an aria label). Under a span the volume is
 * a lower bound, and every one of them says "at least"; otherwise they are the
 * 24H writers above. */
export interface ValueFormat {
  compact(value: number | null): string;
  exact(value: number | null): string;
  spoken(value: number | null): string;
}

export function valueFormat(
  metric: AnalyticsMetric,
  span?: SpanScope | null,
): ValueFormat {
  if (metric === "volume" && span) return span.fmt;
  return {
    compact: (value) => formatMetric(metric, value),
    exact: (value) => formatMetricExact(metric, value),
    spoken: (value) => formatMetricExact(metric, value),
  };
}

/** The span's figures are on their way (loading) or did not come (error). */
export interface SpanPending {
  phase: "loading" | "error";
  /** "7D" or "30D". */
  label: string;
}

export const pendingText = (pending: SpanPending) =>
  pending.phase === "loading"
    ? `Loading ${pending.label} volume`
    : `Could not load ${pending.label} volume.`;

const plural = (count: number | null, one: string, many: string) =>
  count === 1 ? one : many;

/** Bar geometry: a measured zero (even when the whole scope measured zero)
 * draws a zero tick; only an unmeasured value draws the unmeasured track.
 * Share labels still use `metricShare`, so a zero total shows "—", never a
 * fabricated percentage. */
function barShare(value: number | null, total: number | null) {
  if (value === null) return null;
  const share = metricShare(value, total);
  return share ?? (value === 0 ? 0 : null);
}

interface ContributorsProps {
  model: ContributorsModel;
  metric: AnalyticsMetric;
  focus: AnalyticsFocus | null;
  setFocus: (focus: AnalyticsFocus | null) => void;
  /** Breakdown of the current focus (null without a focus or when the
   * response cannot be split). */
  breakdown: FocusBreakdown | null;
  focusLabel: string | null;
  scopeLabel: string;
  /** Freshness proof of the active metric's measurements, for captions. */
  proof?: MetricFreshness | null;
  now?: number;
  disabled?: boolean;
  kicker?: string;
  title?: string;
  /** Edition: the span's figures are loading or failed (the volume metric under
   * 7D or 30D). The plates give way to one line; while loading they keep the
   * height they had. */
  pending?: SpanPending | null;
  /** Extra plates in the same step (e.g. ranked projects). */
  children?: ReactNode;
}

/** "Who contributed": linked ranked bars for networks and use cases. Selecting
 * a bar focuses every chart and table on it; the other dimension then shows
 * the focused portion inside each bar. Bar length is always the share of the
 * scope's measured total for the metric (the stated denominator). */
export function AnalyticsContributors({
  model,
  metric,
  focus,
  setFocus,
  breakdown,
  focusLabel,
  scopeLabel,
  proof = null,
  now = evaluationNow(),
  disabled = false,
  kicker = "Who contributed",
  title = "Networks and use cases behind the total",
  pending = null,
  children,
}: ContributorsProps) {
  const id = useId().replace(/:/g, "");
  const held = useHeldHeight<HTMLDivElement>(pending?.phase === "loading");
  const span = metric === "volume" ? model.span : undefined;
  const fmt = valueFormat(metric, span);
  const oldest = parseClock(proof?.oldestAt ?? null);
  const expires = parseClock(proof?.expiresAt ?? null);
  const freshness = span
    ? {
        label: `through ${span.throughLabel}`,
        tone: "current" as const,
        dateTime: span.through,
        title: `Full UTC days through ${span.throughLabel}: ${span.label} adds up each pool's daily volume. A completed day does not age, so the five-minute rule is not applied.`,
      }
    : proof && proof.currentPools > 0 && oldest !== null
      ? {
          label: formatOldest(oldest, now),
          tone:
            expires !== null && expires > now
              ? ("current" as const)
              : ("stale" as const),
          dateTime: proof.oldestAt,
          title: `Oldest contributing measurement: ${formatUtc(oldest)}. ${STATIC_EDITION ? "Measurements more than five minutes old when the snapshot was taken" : "Measurements older than five minutes"} never enter these bars.`,
        }
      : { label: "no current measurements", tone: "unknown" as const };
  const copy = metricCopy(metric, model.windowKey, span);
  // The measure in a sentence: "tracked 24H hook-pool volume" (a window's
  // letters are not lower-cased: "7D").
  const measure = span
    ? `tracked ${span.label} hook-pool volume, largest pools only`
    : copy.measure.toLowerCase();
  // The edition's empty states name their scope: a snapshot that holds
  // measurements for other networks must not say it holds none, so only the
  // whole-snapshot scope may speak of "this snapshot".
  const wholeSnapshot = scopeLabel === "all networks";
  const poolsIn = wholeSnapshot ? "this snapshot" : scopeLabel;
  const total = metricValue(model.totals, metric);
  const totalPools = metricPools(model.totals, metric);
  const focusTotal = breakdown?.total.value ?? null;
  const toggle = (kind: AnalyticsFocus["kind"]) => (next: string | null) =>
    setFocus(next === null ? null : { kind, id: next });

  const networks = model.networks
    .map((network) => ({ network, value: metricValue(network, metric) }))
    .filter((row) => row.value !== null)
    .sort(
      (a, b) =>
        (b.value ?? 0) - (a.value ?? 0) ||
        a.network.name.localeCompare(b.network.name),
    );
  const crossNetwork = focus !== null && focus.kind !== "network";
  const networkRows: BarListRow[] = networks.map(({ network, value }) => {
    const share = metricShare(value, total);
    const pools = metricPools(network, metric);
    const portion = crossNetwork ? breakdown?.networks.get(network.chain) : null;
    const portionShare =
      portion && portion.value !== null ? metricShare(portion.value, total) : null;
    const focusShare =
      portion && portion.value !== null
        ? metricShare(portion.value, focusTotal)
        : null;
    const group = span?.networks.get(network.chain);
    return {
      id: network.chain,
      label: network.name,
      valueLabel:
        crossNetwork && breakdown
          ? fmt.compact(portion?.value ?? null)
          : fmt.compact(value),
      // Under a span the title also says how much of the network's own 24H
      // volume its covered pools hold: a fact about them, not a way to scale
      // the figure.
      exactLabel: [
        fmt.spoken(crossNetwork && breakdown ? (portion?.value ?? null) : value),
        group ? spanRowCoverage(group) : null,
      ]
        .filter(Boolean)
        .join(". "),
      shareLabel: formatPercent(crossNetwork && breakdown ? focusShare : share),
      share: barShare(value, total),
      overlay: crossNetwork && breakdown ? (portionShare ?? 0) : undefined,
      overlayColor:
        focus?.kind === "category" ? useCaseColor(focus.id) : SELECTED_COLOR,
      sublabel:
        crossNetwork && breakdown ? (
          <>
            {metric === "trading"
              ? `${formatCount(value)} on this network`
              : `${fmt.compact(value)} network total`}{" "}
            · {formatCount(portion?.pools ?? 0)} pools in focus
          </>
        ) : group ? (
          spanRowPools(group)
        ) : (
          <>
            {formatCount(pools)} measured {plural(pools, "pool", "pools")}
          </>
        ),
      dimmed:
        (focus?.kind === "network" && focus.id !== network.chain) ||
        (crossNetwork && !!breakdown && !(portion && portion.pools > 0)),
      ariaLabel: `${network.name}: ${fmt.spoken(value)}${share === null ? "" : `, ${formatPercent(share)} ${copy.denominator}`}${crossNetwork && breakdown && focusLabel ? `; ${fmt.spoken(portion?.value ?? null)} in ${focusLabel}` : ""}. Focus network.`,
    };
  });

  const slices = model.categories[metric] ?? [];
  const crossCategory = focus !== null && focus.kind !== "category";
  const categoryRows: BarListRow[] = slices.map((slice) => {
    const portion = crossCategory ? breakdown?.categories.get(slice.category) : null;
    const portionShare =
      portion && portion.value !== null ? metricShare(portion.value, total) : null;
    const focusShare =
      portion && portion.value !== null
        ? metricShare(portion.value, focusTotal)
        : null;
    const group = span?.categories.get(slice.category);
    return {
      id: slice.category,
      label: slice.category,
      swatch: useCaseColor(slice.category),
      color: useCaseColor(slice.category),
      valueLabel:
        crossCategory && breakdown
          ? fmt.compact(portion?.value ?? null)
          : fmt.compact(slice.value),
      exactLabel: [
        fmt.spoken(
          crossCategory && breakdown ? (portion?.value ?? null) : slice.value,
        ),
        group ? spanRowCoverage(group) : null,
      ]
        .filter(Boolean)
        .join(". "),
      shareLabel: formatPercent(
        crossCategory && breakdown ? focusShare : slice.share,
      ),
      share:
        slice.share ?? (slice.value === null ? null : barShare(slice.value, total)),
      overlay: crossCategory && breakdown ? (portionShare ?? 0) : undefined,
      overlayColor: useCaseColor(slice.category),
      sublabel:
        crossCategory && breakdown ? (
          <>
            {metric === "trading"
              ? `${formatCount(slice.value)} in this use case`
              : `${fmt.compact(slice.value)} use-case total`}{" "}
            · {formatCount(portion?.pools ?? 0)} pools in focus
          </>
        ) : group ? (
          spanRowPools(group)
        ) : slice.value === null ? (
          "Not measured"
        ) : (
          <>
            {formatCount(slice.measuredPools)} measured{" "}
            {plural(slice.measuredPools, "pool", "pools")}
          </>
        ),
      dimmed:
        (focus?.kind === "category" && focus.id !== slice.category) ||
        (crossCategory && !!breakdown && !(portion && portion.pools > 0)),
      ariaLabel: `${slice.category}: ${fmt.spoken(slice.value)}${slice.share === null ? "" : `, ${formatPercent(slice.share)} ${copy.denominator}`}. Focus use case.`,
    };
  });
  const focusedSlice =
    focus?.kind === "category"
      ? slices.find((slice) => slice.category === focus.id)
      : undefined;
  const positive = total !== null && Number.isFinite(total) && total > 0;
  const crossCaption = (dimension: string) =>
    breakdown && focusLabel ? (
      <>
        <span>
          Highlighted: {focusLabel} portion of each {dimension}
        </span>
        <span aria-hidden="true">·</span>
        <span>% of {focusLabel}</span>
      </>
    ) : null;
  const unsplittable =
    focus && !breakdown ? (
      <p className="contrib-unsplit">
        <Info size={14} /> This response has no pool-level ledger, so the
        focused portion cannot be shown here without estimating it.
      </p>
    ) : null;

  return (
    <section
      className="analytics-step analytics-contributors"
      id="analytics-composition"
      aria-labelledby={`${id}-step`}
    >
      <header className="analytics-step-head">
        <span className="analytics-step-kicker">{kicker}</span>
        <h2 id={`${id}-step`}>{title}</h2>
        <p>
          Ranked by {measure}
          {span ? "," : ""} in {scopeLabel}. Select a bar
          to focus every chart and table on it; select it again or press
          Escape to clear. Percentages are {copy.denominator} in this scope,
          not market share.
        </p>
      </header>
      <div
        ref={held.ref}
        style={held.style}
        className={`analytics-contributors-grid${pending ? " analytics-span-pending" : ""}`}
        role={pending ? "status" : undefined}
      >
        {pending ? (
          <p>{pendingText(pending)}</p>
        ) : (
        <>
        <ChartFrame
          className="contrib-plate contrib-networks"
          title={`${copy.name} by network`}
          caption={
            crossNetwork ? (
              crossCaption("network")
            ) : span ? (
              <>
                <span>Largest pools only</span>
                <span aria-hidden="true">·</span>
                <span>
                  {formatCount(networks.length)}{" "}
                  {plural(networks.length, "network", "networks")} with{" "}
                  {span.label} volume
                </span>
              </>
            ) : (
              <>
                <span>{copy.measure}</span>
                <span aria-hidden="true">·</span>
                <span>
                  {formatCount(networks.length)} measured{" "}
                  {plural(networks.length, "network", "networks")}
                </span>
              </>
            )
          }
          freshness={freshness}
          table={
            networks.length
              ? {
                  render: () => (
                    <MetricTable
                      caption={
                        span
                          ? `${span.label} volume by network, largest pools only, ${scopeLabel}`
                          : `${copy.measure} by network, ${scopeLabel}`
                      }
                      label="Network"
                      metric={metric}
                      span={span}
                      rows={networks.map(({ network, value }) => ({
                        id: network.chain,
                        label: network.name,
                        value,
                        share: metricShare(value, total),
                        pools: metricPools(network, metric),
                      }))}
                      denominator={copy.denominator}
                    />
                  ),
                }
              : null
          }
          footnote={
            <p>
              {span ? (
                total === null ? (
                  `No pool in ${poolsIn} has ${span.label} volume.`
                ) : (
                  `Bars show share of ${fmt.compact(total)} covered ${span.label} volume across ${formatCount(totalPools)} ${plural(totalPools, "pool", "pools")} with daily data.`
                )
              ) : total === null ? (
                STATIC_EDITION ? (
                  `No current ${copy.measure.toLowerCase()} in ${scopeLabel}: no pool in ${poolsIn} was measured within five minutes of ${wholeSnapshot ? "it" : "the snapshot"}.`
                ) : (
                  `No current ${copy.measure.toLowerCase()} in ${scopeLabel}; bars appear when sources report measurements within five minutes.`
                )
              ) : (
                `Bars show share of ${formatMetric(metric, total)} ${copy.measure.toLowerCase()} across ${formatCount(totalPools)} measured pools.`
              )}{" "}
              {span
                ? "Networks with no covered pool are omitted, not shown as zero."
                : "Networks without a current measurement are omitted, not shown as zero."}
            </p>
          }
        >
          {unsplittable && crossNetwork ? unsplittable : null}
          <BarList
            label={`${copy.name} by network values`}
            rows={networkRows}
            selectedId={focus?.kind === "network" ? focus.id : null}
            onSelect={toggle("network")}
            limit={8}
            expandLabel={(count) => `Show all ${formatCount(count)} networks`}
            collapseLabel="Show fewer networks"
            disabled={disabled}
            empty={
              span ? (
                <div className="chart-state" data-kind="empty">
                  <h4>{spanEmptyTitle(span.label, wholeSnapshot ? "this snapshot" : scopeLabel)}</h4>
                  <p>{spanEmptyText(span.label, wholeSnapshot)}</p>
                </div>
              ) : (
              <div className="chart-state" data-kind="empty">
                <h4>No current {copy.name.toLowerCase()} measurements</h4>
                {STATIC_EDITION ? (
                  <p>
                    No pool in {poolsIn} has{" "}
                    {metric === "reserves" ? "a reserve" : "a trading volume"}{" "}
                    measurement taken within five minutes of{" "}
                    {wholeSnapshot ? "it" : "the snapshot"}. Missing values are
                    never shown as zero.
                  </p>
                ) : (
                  <p>
                    Network values appear when sources report fresh{" "}
                    {metric === "reserves" ? "pool reserves" : "trading volume"}{" "}
                    within the five-minute window. Missing values are never
                    shown as zero.
                  </p>
                )}
              </div>
              )
            }
          />
        </ChartFrame>
        <ChartFrame
          className="contrib-plate contrib-categories"
          title={`${copy.name} by use case`}
          caption={
            crossCategory ? (
              crossCaption("use case")
            ) : span ? (
              <>
                <span>Largest pools only</span>
                <span aria-hidden="true">·</span>
                <span>
                  {formatCount(slices.filter((slice) => slice.value !== null).length)}{" "}
                  {plural(
                    slices.filter((slice) => slice.value !== null).length,
                    "use case",
                    "use cases",
                  )}{" "}
                  with {span.label} volume
                </span>
              </>
            ) : (
              <>
                <span>{copy.measure}</span>
                <span aria-hidden="true">·</span>
                <span>
                  {formatCount(slices.filter((slice) => slice.value !== null).length)}{" "}
                  measured{" "}
                  {plural(
                    slices.filter((slice) => slice.value !== null).length,
                    "use case",
                    "use cases",
                  )}
                </span>
              </>
            )
          }
          freshness={freshness}
          table={
            slices.length
              ? {
                  render: () => (
                    <MetricTable
                      caption={
                        span
                          ? `${span.label} volume by use case, largest pools only, ${scopeLabel}`
                          : `${copy.measure} by use case, ${scopeLabel}`
                      }
                      label="Use case"
                      metric={metric}
                      span={span}
                      rows={slices.map((slice) => ({
                        id: slice.category,
                        label: slice.category,
                        value: slice.value,
                        share: slice.share,
                        pools: slice.measuredPools,
                      }))}
                      denominator={copy.denominator}
                    />
                  ),
                }
              : null
          }
          footnote={
            <p>
              Use cases come from each pool’s linked project. Pools not linked
              to a loaded project stay Unattributed; nothing is reassigned.
            </p>
          }
        >
          <div className="contrib-focus-readout">
            <span className="contrib-focus-label">
              {focusedSlice ? (
                <>
                  <i
                    aria-hidden="true"
                    style={{ background: useCaseColor(focusedSlice.category) }}
                  />
                  {focusedSlice.category}
                </>
              ) : span ? (
                `${span.label} volume, largest pools`
              ) : (
                copy.measure
              )}
            </span>
            <strong
              title={fmt.spoken(focusedSlice ? focusedSlice.value : total)}
            >
              {fmt.compact(focusedSlice ? focusedSlice.value : total)}
            </strong>
            <small>
              {focusedSlice
                ? `${formatPercent(focusedSlice.share)} ${copy.denominator}`
                : positive
                  ? span
                    ? `Covered total · ${scopeLabel}`
                    : `Measured total · ${scopeLabel}`
                  : total !== null
                    ? "No positive values"
                    : STATIC_EDITION
                      ? wholeSnapshot
                        ? "No measurements in this snapshot"
                        : `No measurements for ${scopeLabel} in this snapshot`
                      : "Awaiting measurements"}
            </small>
          </div>
          {unsplittable && crossCategory ? unsplittable : null}
          {slices.length > 0 ? (
            <BarList
              label={`${copy.name} by use case values`}
              rows={categoryRows}
              selectedId={focus?.kind === "category" ? focus.id : null}
              onSelect={toggle("category")}
              ranked={false}
              disabled={disabled}
            />
          ) : (
            <p className="contrib-empty">
              {model.categories[metric] === null
                ? "This response cannot split pools with trading by use case. Open the complete workspace for the pool-level breakdown."
                : STATIC_EDITION
                  ? `No pool in ${poolsIn} has a current measurement to split by use case.`
                  : "Fresh pool measurements will populate this breakdown."}
            </p>
          )}
          <p className="contrib-detail">
            {focusedSlice ? (
              <>
                <strong>{focusedSlice.category}</strong> ·{" "}
                {fmt.exact(focusedSlice.value)} ·{" "}
                {span ? (
                  <>
                    {focusedSlice.value === null
                      ? `No ${span.label} volume: none of its pools is among the largest`
                      : spanRowPools(
                          span.categories.get(focusedSlice.category) ??
                            NO_SPAN_GROUP,
                        )}
                  </>
                ) : (
                  <>
                    {formatCount(focusedSlice.measuredPools)} measured{" "}
                    {plural(focusedSlice.measuredPools, "pool", "pools")}
                  </>
                )}
              </>
            ) : (
              "Select a use case to focus its networks, projects and pools."
            )}
          </p>
        </ChartFrame>
        </>
        )}
      </div>
      {children}
    </section>
  );
}

function MetricTable({
  caption,
  label,
  metric,
  span,
  rows,
  denominator,
}: {
  caption: string;
  label: string;
  metric: AnalyticsMetric;
  /** Edition: under a span the dollar column is a lower bound. */
  span?: SpanScope;
  rows: {
    id: string;
    label: string;
    value: number | null;
    share: number | null;
    pools: number | null;
  }[];
  denominator: string;
}) {
  return (
    <div className="chart-table-scroll" tabIndex={0} role="region" aria-label={caption}>
      <table className="chart-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{label}</th>
            <th scope="col">
              {metric === "trading"
                ? "Pools with trading"
                : span
                  ? "USD, at least"
                  : "USD"}
            </th>
            <th scope="col">Share {denominator}</th>
            <th scope="col">{span ? "Covered pools" : "Measured pools"}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <th scope="row">{row.label}</th>
              <td>{valueFormat(metric, span).exact(row.value)}</td>
              <td>{formatPercent(row.share)}</td>
              <td>{formatCount(row.pools)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface EvidenceProps {
  windowKey: WindowKey;
  metric: AnalyticsMetric;
  now: number;
  samplePools: number;
  freshness: MarketFreshness;
  /** Original clocks for the provenance list. */
  publishedAt: string | null;
  evaluatedAt?: string | null;
  inventory: {
    hookPools: number | null;
    hookContracts: number | null;
    networks: number;
    caughtUp: number;
    /** "census as of 27 Oct 2026" in the static edition, which never rescans. */
    census?: string | null;
  } | null;
  pricing?: {
    indexed: number;
    checked: number;
    measured: number;
    missing: number;
    pending: number;
    /** Edition: "census as of 27 Oct 2026", the date of the population. */
    census?: string | null;
    /** Edition: networks with a row, and on how many of them a source
     * responded (checked pools above zero). */
    networks?: number;
    checkedNetworks?: number;
    /** Edition: census networks that have no pricing row, and their pools. */
    unlistedNetworks?: number;
    unlistedPools?: number;
  } | null;
  sourceCount: number;
  /** Opens the Data & sources dialog; omitted where the build has none. */
  openSources?: () => void;
  scopeLabel: string;
  kicker?: string;
  /** Edition: "7D" or "30D" while a span is chosen. The evidence stays the
   * snapshot's 24H measurements, and the header says what a span's total is. */
  spanLabel?: string | null;
  /** Network-level coverage table plate(s). */
  children?: ReactNode;
}

/** "How fresh and complete is the evidence": the observation sample split by
 * measurement quality, where current measurements sit in the five-minute
 * qualification window, the original source clocks, and index coverage. */
export function AnalyticsEvidence({
  windowKey,
  metric,
  now,
  samplePools,
  freshness,
  publishedAt,
  evaluatedAt,
  inventory,
  pricing,
  sourceCount,
  openSources,
  scopeLabel,
  kicker = "Evidence",
  spanLabel = null,
  children,
}: EvidenceProps) {
  const id = useId().replace(/:/g, "");
  const window = windowKey === "h1" ? "1H" : windowKey === "h6" ? "6H" : "24H";
  const volume = freshness.volume[windowKey];
  const reserves = freshness.liquidity;
  const active = metric === "reserves" ? reserves : volume;
  const partitions = [
    {
      key: "volume",
      label: `${window} volume`,
      metricActive: metric !== "reserves",
      partition: evidencePartition(volume, samplePools),
    },
    {
      key: "reserves",
      label: "Reserves",
      metricActive: metric === "reserves",
      partition: evidencePartition(reserves, samplePools),
    },
  ];
  const oldest = parseClock(active.oldestAt);
  const newest = parseClock(active.newestAt);
  const expires = parseClock(active.expiresAt);
  const published = parseClock(publishedAt);
  const evaluated = parseClock(evaluatedAt ?? null);
  const clock = (label: string, time: number | null, note?: string) => (
    <div>
      <dt>{label}</dt>
      <dd>
        {time === null ? (
          "Not available"
        ) : (
          <>
            <time dateTime={new Date(time).toISOString()} title={formatUtc(time)}>
              {formatUtcClock(time)}
            </time>
            {note && <small>{note}</small>}
          </>
        )}
      </dd>
    </div>
  );
  return (
    <section
      className="analytics-step analytics-evidence"
      id="analytics-coverage"
      aria-labelledby={`${id}-step`}
    >
      <header className="analytics-step-head">
        <span className="analytics-step-kicker">{kicker}</span>
        <h2 id={`${id}-step`}>How fresh and complete the evidence is</h2>
        <p>
          {spanLabel ? `${window} totals` : "Totals"} use only pools measured
          within{" "}
          {STATIC_EDITION ? "five minutes of the snapshot" : "the last five minutes"}
          {spanLabel ? "; 7D and 30D add up completed days" : ""}.
          Older and unverifiable observations stay saved but never enter a
          total.
        </p>
      </header>
      <div className="analytics-evidence-grid">
        <ChartFrame
          className="evidence-plate"
          title="Measurement evidence"
          caption={
            <>
              <span>
                {formatCount(samplePools)} pools in the market observation sample
              </span>
              <span aria-hidden="true">·</span>
              <span>{scopeLabel}</span>
            </>
          }
          freshness={
            active.currentPools > 0 && oldest !== null
              ? {
                  label: formatOldest(oldest, now),
                  tone: expires !== null && expires > now ? "current" : "stale",
                  dateTime: active.oldestAt,
                  title: `Oldest contributing measurement: ${formatUtc(oldest)}`,
                }
              : { label: "no current measurements", tone: "unknown" }
          }
          actions={
            openSources ? (
              <button
                type="button"
                className="control"
                onClick={openSources}
                aria-label={`Open sources and coverage details (${formatCount(sourceCount)} ${plural(sourceCount, "source", "sources")})`}
              >
                <Info size={14} /> Sources &amp; coverage details
                <ArrowRight size={14} />
              </button>
            ) : undefined
          }
        >
          <div className="evidence-col">
          <div className="evidence-stacks">
            {partitions.map(({ key, label, metricActive, partition }) => (
              <div
                key={key}
                className="evidence-stack"
                data-active={metricActive || undefined}
              >
                <div className="evidence-stack-head">
                  <span>{label}</span>
                  <small>
                    {partition
                      ? `${formatCount(partition.current)} current of ${formatCount(partition.sample)}`
                      : "Counts unavailable"}
                  </small>
                </div>
                {partition ? (
                  <StackedBar
                    label={`${label} evidence for ${formatCount(partition.sample)} sample pools`}
                    total={partition.sample}
                    denominatorLabel="of sample"
                    segments={[
                      {
                        id: "current",
                        label: "Current",
                        note: STATIC_EDITION
                          ? "measured within 5 minutes of the snapshot · counted"
                          : "measured within 5 minutes · counted",
                        value: partition.current,
                        color: EVIDENCE_COLORS.current,
                      },
                      {
                        id: "older",
                        label: "Older",
                        note: "saved, excluded from totals",
                        value: partition.older,
                        color: EVIDENCE_COLORS.older,
                      },
                      {
                        id: "unverified",
                        label: "Unverified clock",
                        note: "excluded",
                        value: partition.unverified,
                        color: EVIDENCE_COLORS.unverified,
                      },
                      {
                        id: "missing",
                        label: "No value reported",
                        note: STATIC_EDITION
                          ? "not priced in this snapshot"
                          : "not priced or not yet checked",
                        value: partition.missing,
                        color: EVIDENCE_COLORS.missing,
                        hatched: true,
                      },
                    ]}
                  />
                ) : (
                  <p className="evidence-unreconciled">
                    The published counts do not reconcile, so no partition is
                    drawn.
                  </p>
                )}
              </div>
            ))}
          </div>
          </div>
          <div className="evidence-col">
          <div className="evidence-window">
            <div className="evidence-window-head">
              <span>
                Current {metric === "reserves" ? "reserve" : `${window} volume`}{" "}
                measurements in the 5-minute window
              </span>
              <small>{formatCount(active.currentPools)} pools</small>
            </div>
            <FreshnessWindow
              now={now}
              maxAgeMs={freshness.maxAgeMs}
              oldest={oldest}
              newest={newest}
              count={active.currentPools}
              label="Measurement window"
            />
          </div>
          <dl className="evidence-clocks">
            {clock("Oldest contributing", oldest, "original source clock")}
            {clock("Newest contributing", newest)}
            {/* Nothing expires in a snapshot: it is judged at its own time, and
                the oldest and newest counted measurements above say all that
                the first expiry would. */}
            {!STATIC_EDITION &&
              clock(
                "First expiry",
                expires,
                expires !== null && expires > now
                  ? `in ${formatAge(expires - now)}`
                  : "expired · awaiting refresh",
              )}
            {clock("Published", published)}
            {evaluated !== null && clock("Evaluated", evaluated, "does not renew source clocks")}
          </dl>
          {pricing && pricing.indexed > 0 && (
            <div className="evidence-stack evidence-pricing">
              <div className="evidence-stack-head">
                <span>Pricing checks</span>
                <small>
                  {formatCount(pricing.checked)} of{" "}
                  {formatCount(pricing.indexed)}{" "}
                  {STATIC_EDITION ? "" : "discovered "}hook pools checked
                  {STATIC_EDITION && pricing.census
                    ? ` · ${pricing.census}`
                    : ""}
                </small>
              </div>
              {pricing.measured + pricing.missing + pricing.pending ===
              pricing.indexed ? (
                <StackedBar
                  label={
                    STATIC_EDITION
                      ? `Pricing checks for ${formatCount(pricing.indexed)} hook pools in the census`
                      : `Pricing checks for ${formatCount(pricing.indexed)} discovered hook pools`
                  }
                  total={pricing.indexed}
                  denominatorLabel={
                    STATIC_EDITION ? "of the census" : "of discovered"
                  }
                  segments={[
                    {
                      id: "measured",
                      label: "With market observations",
                      value: pricing.measured,
                      color: EVIDENCE_COLORS.current,
                    },
                    {
                      id: "no-data",
                      label: "Checked, no usable data",
                      value: pricing.missing,
                      color: EVIDENCE_COLORS.older,
                    },
                    {
                      id: "pending",
                      label: STATIC_EDITION
                        ? "Not checked in this snapshot"
                        : "Checks remaining",
                      value: pricing.pending,
                      color: EVIDENCE_COLORS.missing,
                      hatched: true,
                    },
                  ]}
                />
              ) : STATIC_EDITION ? (
                <p className="evidence-unreconciled">
                  {formatCount(pricing.measured)} with market observations ·{" "}
                  {formatCount(pricing.missing)} checked without usable data ·{" "}
                  {formatCount(pricing.pending)} not checked in this snapshot.
                  These counts do not add up to the census, so they are not
                  drawn as one partition.
                </p>
              ) : (
                <p className="evidence-unreconciled">
                  {formatCount(pricing.measured)} with market observations ·{" "}
                  {formatCount(pricing.missing)} checked without usable data ·{" "}
                  {formatCount(pricing.pending)} checks remaining. These counts
                  include pools still being added to search, so they are not
                  drawn as one partition.
                </p>
              )}
              {STATIC_EDITION &&
                pricing.networks !== undefined &&
                pricing.networks > 1 &&
                pricing.checkedNetworks !== undefined &&
                pricing.checkedNetworks < pricing.networks && (
                  <p className="evidence-unreconciled">
                    Checks were made on {formatCount(pricing.checkedNetworks)}{" "}
                    of {formatCount(pricing.networks)} networks.
                  </p>
                )}
              {STATIC_EDITION && !!pricing.unlistedNetworks && (
                <p className="evidence-unreconciled">
                  The census also lists {formatCount(pricing.unlistedNetworks)}{" "}
                  {plural(pricing.unlistedNetworks, "network", "networks")} (
                  {formatCount(pricing.unlistedPools ?? 0)} hook{" "}
                  {plural(pricing.unlistedPools ?? 0, "pool", "pools")}) with no
                  pricing check.
                </p>
              )}
            </div>
          )}
          {inventory && (
            <p className="evidence-inventory">
              <strong>{formatCount(samplePools)}</strong> pools sampled for
              market data ·{" "}
              <strong>{formatCount(inventory.hookPools)}</strong> hook pools
              indexed onchain across {formatCount(inventory.networks)}{" "}
              {plural(inventory.networks, "network", "networks")} (
              {formatCount(inventory.caughtUp)}{" "}
              {STATIC_EDITION ? "scanned to their recorded target" : "caught up"})
              {STATIC_EDITION && inventory.census ? `, ${inventory.census}` : ""}.
              Unmeasured pools, including inactive ones, remain part of the
              indexed population.
            </p>
          )}
          </div>
        </ChartFrame>
        {children}
      </div>
    </section>
  );
}
