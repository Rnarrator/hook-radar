import { useId } from "react";
import type { ReactNode } from "react";
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
import { compositionParts } from "../analytics-composition";
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
  disabled = false,
}: ControlBarProps) {
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
        <div className="analytics-focus-bar" role="status">
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
  caption: ReactNode;
  primary?: boolean;
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
  disabled?: boolean;
}) {
  const id = useId().replace(/:/g, "");
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
        <p className="analytics-scope-line">{scope}</p>
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
        {items.map((item) => {
          const selectable = item.key !== "projects";
          const active = item.key === metric;
          return (
            <div
              key={item.key}
              className={`analytics-metric${item.primary ? " analytics-metric-primary" : ""}`}
              data-active={active || undefined}
            >
              <span className="analytics-metric-label">{item.label}</span>
              <strong data-testid={item.testId} title={item.exact}>
                {item.value}
              </strong>
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
                    METRIC_OPTIONS.find(([value]) => value === item.key)?.[1] ??
                    ""
                  ).toLowerCase()}
                  <ArrowRight size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      {composition}
      {method}
    </section>
  );
}

/** Network tints: one periwinkle stepped by rank, so length carries magnitude
 * and no extra categorical hue is spent on networks. */
const NETWORK_TINTS = [100, 85, 71, 60, 52];
const networkTint = (rank: number) =>
  `color-mix(in oklab, var(--iris) ${NETWORK_TINTS[Math.min(rank, NETWORK_TINTS.length - 1)]}%, var(--surface-4))`;
const TAIL_COLOR = "color-mix(in oklab, var(--ink-faint) 82%, var(--surface-3))";

/** Two composition ribbons under the readouts: where the tracked total came
 * from by network, and by use case. They reuse the contributor bars' values
 * and denominator, select and clear the same focus, and say so in their names. */
export function AnalyticsComposition({
  model,
  metric,
  focus,
  setFocus,
  disabled = false,
}: {
  model: ContributorsModel;
  metric: AnalyticsMetric;
  focus: AnalyticsFocus | null;
  setFocus: (focus: AnalyticsFocus | null) => void;
  disabled?: boolean;
}) {
  const composition = compositionParts(model, metric);
  if (!composition) return null;
  const copy = metricCopy(metric, model.windowKey);
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
      valueLabel: formatMetric(metric, part.value),
      shareLabel: formatPercent(part.share),
      inert: part.tail,
      hatched: part.remainder,
      ariaLabel: `Composition bar, ${part.label}: ${formatMetricExact(metric, part.value)}, ${formatPercent(part.share)} ${copy.denominator}${part.tail ? "" : `. Focus ${entity}.`}`,
    }));
  const select = (kind: AnalyticsFocus["kind"]) => (id: string | null) =>
    setFocus(id === null ? null : { kind, id });
  return (
    <div className="analytics-composition" data-testid="analytics-composition">
      {composition.networks.length > 0 && (
        <div className="analytics-composition-row">
          <span className="analytics-composition-label">By network</span>
          <Ribbon
            label={`${copy.name} by network, composition`}
            segments={segments(composition.networks, "network", (_, rank) =>
              networkTint(rank),
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
  children,
}: ContributorsProps) {
  const id = useId().replace(/:/g, "");
  const oldest = parseClock(proof?.oldestAt ?? null);
  const expires = parseClock(proof?.expiresAt ?? null);
  const freshness =
    proof && proof.currentPools > 0 && oldest !== null
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
  const copy = metricCopy(metric, model.windowKey);
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
    return {
      id: network.chain,
      label: network.name,
      valueLabel:
        crossNetwork && breakdown
          ? formatMetric(metric, portion?.value ?? null)
          : formatMetric(metric, value),
      exactLabel: formatMetricExact(
        metric,
        crossNetwork && breakdown ? (portion?.value ?? null) : value,
      ),
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
              : `${formatMetric(metric, value)} network total`}{" "}
            · {formatCount(portion?.pools ?? 0)} pools in focus
          </>
        ) : (
          <>
            {formatCount(pools)} measured {plural(pools, "pool", "pools")}
          </>
        ),
      dimmed:
        (focus?.kind === "network" && focus.id !== network.chain) ||
        (crossNetwork && !!breakdown && !(portion && portion.pools > 0)),
      ariaLabel: `${network.name}: ${formatMetricExact(metric, value)}${share === null ? "" : `, ${formatPercent(share)} ${copy.denominator}`}${crossNetwork && breakdown && focusLabel ? `; ${formatMetricExact(metric, portion?.value ?? null)} in ${focusLabel}` : ""}. Focus network.`,
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
    return {
      id: slice.category,
      label: slice.category,
      swatch: useCaseColor(slice.category),
      color: useCaseColor(slice.category),
      valueLabel:
        crossCategory && breakdown
          ? formatMetric(metric, portion?.value ?? null)
          : formatMetric(metric, slice.value),
      exactLabel: formatMetricExact(
        metric,
        crossCategory && breakdown ? (portion?.value ?? null) : slice.value,
      ),
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
              : `${formatMetric(metric, slice.value)} use-case total`}{" "}
            · {formatCount(portion?.pools ?? 0)} pools in focus
          </>
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
      ariaLabel: `${slice.category}: ${formatMetricExact(metric, slice.value)}${slice.share === null ? "" : `, ${formatPercent(slice.share)} ${copy.denominator}`}. Focus use case.`,
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
          Ranked by {copy.measure.toLowerCase()} in {scopeLabel}. Select a bar
          to focus every chart and table on it; select it again or press
          Escape to clear. Percentages are {copy.denominator} in this scope,
          not market share.
        </p>
      </header>
      <div className="analytics-contributors-grid">
        <ChartFrame
          className="contrib-plate contrib-networks"
          title={`${copy.name} by network`}
          caption={
            crossNetwork ? (
              crossCaption("network")
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
                      caption={`${copy.measure} by network, ${scopeLabel}`}
                      label="Network"
                      metric={metric}
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
              {total === null
                ? STATIC_EDITION
                  ? `No current ${copy.measure.toLowerCase()} in ${scopeLabel}: no pool in ${poolsIn} was measured within five minutes of ${wholeSnapshot ? "it" : "the snapshot"}.`
                  : `No current ${copy.measure.toLowerCase()} in ${scopeLabel}; bars appear when sources report measurements within five minutes.`
                : `Bars show share of ${formatMetric(metric, total)} ${copy.measure.toLowerCase()} across ${formatCount(totalPools)} measured pools.`}{" "}
              Networks without a current measurement are omitted, not shown as
              zero.
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
            }
          />
        </ChartFrame>
        <ChartFrame
          className="contrib-plate contrib-categories"
          title={`${copy.name} by use case`}
          caption={
            crossCategory ? (
              crossCaption("use case")
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
                      caption={`${copy.measure} by use case, ${scopeLabel}`}
                      label="Use case"
                      metric={metric}
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
              ) : (
                copy.measure
              )}
            </span>
            <strong
              title={formatMetricExact(
                metric,
                focusedSlice ? focusedSlice.value : total,
              )}
            >
              {formatMetric(metric, focusedSlice ? focusedSlice.value : total)}
            </strong>
            <small>
              {focusedSlice
                ? `${formatPercent(focusedSlice.share)} ${copy.denominator}`
                : positive
                  ? `Measured total · ${scopeLabel}`
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
                {formatMetricExact(metric, focusedSlice.value)} ·{" "}
                {formatCount(focusedSlice.measuredPools)} measured{" "}
                {plural(focusedSlice.measuredPools, "pool", "pools")}
              </>
            ) : (
              "Select a use case to focus its networks, projects and pools."
            )}
          </p>
        </ChartFrame>
      </div>
      {children}
    </section>
  );
}

function MetricTable({
  caption,
  label,
  metric,
  rows,
  denominator,
}: {
  caption: string;
  label: string;
  metric: AnalyticsMetric;
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
            <th scope="col">{metric === "trading" ? "Pools with trading" : "USD"}</th>
            <th scope="col">Share {denominator}</th>
            <th scope="col">Measured pools</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <th scope="row">{row.label}</th>
              <td>{formatMetricExact(metric, row.value)}</td>
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
          Totals use only pools measured within{" "}
          {STATIC_EDITION ? "five minutes of the snapshot" : "the last five minutes"}.
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
