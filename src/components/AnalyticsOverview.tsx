import { useEffect, useMemo, useState } from "react";
import type { AnalyticsOverviewEnvelope } from "../../shared/analytics-overview";
import {
  analyticsOverviewAt,
  overviewMetricCurrent,
} from "../../shared/analytics-overview";
import type { MetricFreshness } from "../../shared/types";
import { analyticsHistory } from "../analytics";
import type { AnalyticsHistoryRange } from "../analytics";
import {
  metricCopy,
  metricShare,
  metricValue,
  overviewCategoryTrading,
  overviewFocusBreakdown,
} from "../analytics-focus";
import type { AnalyticsFocus, AnalyticsMetric } from "../analytics-focus";
import {
  RatioMeter,
  formatSince,
  formatCount,
  formatMoneyCompact,
  formatPercent,
  formatUtc,
  parseClock,
} from "../charts/index";
import { windows } from "../model";
import { STATIC_EDITION, censusLabel, fullTimeLabel } from "../edition";
import { CensusNote } from "./EditionStatus";
import {
  AnalyticsComposition,
  AnalyticsContributors,
  AnalyticsControlBar,
  AnalyticsEvidence,
  AnalyticsReadouts,
  formatMetric,
  formatMetricExact,
} from "./AnalyticsCharts";
import type { ContributorsModel, FocusSummary } from "./AnalyticsCharts";
import { AnalyticsHistory } from "./AnalyticsHistory";
import { ArrowRight, ChevronDown, Info, RefreshCw } from "./Icons";
import "./analytics.css";

interface Props {
  envelope: AnalyticsOverviewEnvelope;
  now: number;
  range: AnalyticsHistoryRange;
  setRange: (range: AnalyticsHistoryRange) => void;
  setChain: (chain: string) => void;
  /** Opens the Data & sources dialog; omitted where the build has none. */
  openSources?: () => void;
  openDetails: () => void;
  /** The all-network history series has been read and has points. */
  seriesRecorded?: boolean;
  disabled?: boolean;
  refreshing?: boolean;
}

function Measurement({ proof, now }: { proof: MetricFreshness; now: number }) {
  const current = overviewMetricCurrent(proof, now);
  const oldest = parseClock(proof.oldestAt);
  return (
    <span
      className="analytics-metric-caption"
      title={
        proof.oldestAt
          ? `Oldest contributing measurement: ${STATIC_EDITION ? (fullTimeLabel(proof.oldestAt) ?? "time unavailable") : new Date(proof.oldestAt).toLocaleString()} (${proof.oldestAt})`
          : undefined
      }
    >
      {current && oldest !== null ? (
        <>
          <span className="analytics-dot" aria-hidden="true" />
          {formatCount(proof.currentPools)}{" "}
          {proof.currentPools === 1 ? "pool" : "pools"} · oldest{" "}
          {formatSince(oldest, now)}
        </>
      ) : proof.currentPools > 0 ? (
        STATIC_EDITION ? (
          "Measurements expired · awaiting the next snapshot"
        ) : (
          "Measurements expired · awaiting refresh"
        )
      ) : (
        "No current measurements"
      )}
    </span>
  );
}

/** Bounded overview: the same investigation sequence as the full workspace,
 * built only from the published aggregate envelope and its contribution
 * ledger. Projects, hooks and pools open the full workspace explicitly; this
 * component never constructs a partial RadarSnapshot. */
export function AnalyticsOverview({
  envelope: publishedEnvelope,
  now,
  range,
  setRange,
  setChain,
  openSources,
  openDetails,
  seriesRecorded = false,
  disabled = false,
  refreshing = false,
}: Props) {
  const envelope = useMemo(
    () => analyticsOverviewAt(publishedEnvelope, now),
    [publishedEnvelope, now],
  );
  const { request, totals } = envelope;
  const [metric, setMetric] = useState<AnalyticsMetric>("volume");
  const [focus, setFocus] = useState<AnalyticsFocus | null>(null);
  useEffect(() => setFocus(null), [request.chain, request.window]);
  useEffect(() => {
    if (!focus) return;
    const clear = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, select, textarea, [role='dialog']")) return;
      setFocus(null);
    };
    window.addEventListener("keydown", clear);
    return () => window.removeEventListener("keydown", clear);
  }, [focus]);
  const volumeCurrent = overviewMetricCurrent(
    totals.freshness.volume[request.window],
    now,
  );
  const reservesCurrent = overviewMetricCurrent(
    totals.freshness.liquidity,
    now,
  );
  // The compact proof recomputes the distinct project union with each expiry.
  // Legacy aggregate-only responses retain their conservative withholding.
  const attributionCurrent =
    (totals.volumePools === 0 || volumeCurrent) &&
    (totals.liquidityPools === 0 || reservesCurrent) &&
    (volumeCurrent || reservesCurrent);
  const copy = metricCopy(metric, request.window);
  const networkNames = useMemo(
    () => new Map(envelope.networks.map((n) => [n.slug, n.name])),
    [envelope.networks],
  );
  const scopeName =
    request.chain === "all"
      ? "All networks"
      : networkNames.get(request.chain) || request.chain;
  const scopeLabel = request.chain === "all" ? "all networks" : scopeName;
  // Re-derived from the ledger only while the trading metric is shown.
  const tradingSlices = useMemo(
    () =>
      metric === "trading" && volumeCurrent
        ? overviewCategoryTrading(publishedEnvelope, now)
        : [],
    [publishedEnvelope, now, volumeCurrent, metric],
  );
  const model = useMemo<ContributorsModel>(
    () => ({
      chain: request.chain,
      windowKey: request.window,
      totals: {
        volumeUsd: volumeCurrent ? totals.volumeUsd : null,
        liquidityUsd: reservesCurrent ? totals.liquidityUsd : null,
        volumePools: volumeCurrent ? totals.volumePools : null,
        liquidityPools: reservesCurrent ? totals.liquidityPools : null,
        activePools: volumeCurrent ? totals.activePools : null,
      },
      networks: envelope.networkTotals.map((row) => {
        const volume = overviewMetricCurrent(
          row.freshness.volume[request.window],
          now,
        );
        const reserves = overviewMetricCurrent(row.freshness.liquidity, now);
        return {
          chain: row.chain,
          name: row.name,
          volumeUsd: volume ? row.volumeUsd : null,
          liquidityUsd: reserves ? row.liquidityUsd : null,
          volumePools: volume ? row.volumePools : null,
          liquidityPools: reserves ? row.liquidityPools : null,
          activePools: volume ? row.activePools : null,
        };
      }),
      categories: {
        volume: volumeCurrent ? envelope.categories.volume : [],
        reserves: reservesCurrent ? envelope.categories.reserves : [],
        trading: tradingSlices,
      },
    }),
    [envelope, now, request, totals, volumeCurrent, reservesCurrent, tradingSlices],
  );
  const breakdown = useMemo(
    () =>
      focus
        ? overviewFocusBreakdown(publishedEnvelope, now, metric, focus)
        : null,
    [focus, publishedEnvelope, now, metric],
  );
  const focusLabel = !focus
    ? null
    : focus.kind === "network"
      ? networkNames.get(focus.id) || focus.id
      : focus.id;
  const scopeTotal = metricValue(model.totals, metric);
  const focusSummary: FocusSummary | null =
    focus && focusLabel
      ? {
          kind: focus.kind === "network" ? "Network" : "Use case",
          label: focusLabel,
          detail: breakdown ? (
            <>
              {formatMetric(metric, breakdown.total.value)} of{" "}
              {formatMetric(metric, scopeTotal)} {copy.measure.toLowerCase()}{" "}
              · {formatPercent(metricShare(breakdown.total.value, scopeTotal))}
            </>
          ) : (
            "Focused portions need the pool-level ledger"
          ),
          actions:
            focus.kind === "network" && request.chain === "all" ? (
              <button
                type="button"
                className="analytics-text-button"
                onClick={() => setChain(focus.id)}
                disabled={disabled}
              >
                View analytics on {focusLabel} <ArrowRight size={14} />
              </button>
            ) : null,
        }
      : null;
  const history = useMemo(
    () => analyticsHistory(envelope.history.points, range, now),
    [envelope.history.points, range, now],
  );
  const validHistory = useMemo(
    () => analyticsHistory(envelope.history.points, "all", now).length,
    [envelope.history.points, now],
  );
  const historyFirst = envelope.history.available && validHistory > 0;
  // A panel whose only message is that there is nothing to chart is left off the
  // page. A network's page keeps its pointer to the all-network series only when
  // that series is known to exist (the page remembers having read it).
  const showHistory = envelope.history.available
    ? validHistory > 0
    : seriesRecorded;
  const measuredNetworks = model.networks.filter(
    (n) => n.volumeUsd !== null || n.liquidityUsd !== null,
  ).length;
  const inventory =
    envelope.inventory?.networks.filter(
      (n) => request.chain === "all" || n.chain === request.chain,
    ) || [];
  const indexed = inventory.length
    ? inventory.reduce((sum, n) => sum + n.hookPoolCount, 0)
    : null;
  // Indexed pool counts are a dated export, not measured at the snapshot.
  const census = STATIC_EDITION ? censusLabel(envelope.inventory) : null;
  const historyPanel = (
    <AnalyticsHistory
      points={history}
      allPoints={validHistory}
      available={envelope.history.available}
      range={range}
      setRange={setRange}
      showAllNetworks={() => setChain("all")}
      metric={metric}
      now={now}
      disabled={disabled}
      kicker={historyFirst ? "02 · What changed" : "What changed"}
    />
  );

  return (
    <section
      className="analytics-workspace analytics-overview"
      aria-label="Hook analytics overview"
    >
      <AnalyticsControlBar
        sections={[
          ["#analytics-overview", "Measured"],
          ...(showHistory
            ? ([["#analytics-history", "Change"]] as const)
            : []),
          ["#analytics-composition", "Contributors"],
          ["#analytics-coverage", "Evidence"],
        ]}
        metric={metric}
        setMetric={setMetric}
        chain={request.chain}
        setChain={setChain}
        networks={envelope.networks}
        windowLabel={`${windows[request.window]} window`}
        focus={focusSummary}
        clearFocus={() => setFocus(null)}
        disabled={disabled}
        actions={
          <>
            {openSources && (
              <button
                type="button"
                className="analytics-text-button"
                onClick={openSources}
              >
                <Info size={14} /> Data sources
              </button>
            )}
            <button
              type="button"
              className="control"
              onClick={openDetails}
              disabled={disabled}
            >
              Explore pools &amp; hooks <ArrowRight size={14} />
            </button>
          </>
        }
      />
      <AnalyticsReadouts
        kicker="01 · At a glance"
        status={
          refreshing ? (
            <>
              <RefreshCw size={14} className="spin" aria-hidden="true" />
              <span>Updating measurements</span>
            </>
          ) : null
        }
        metric={metric}
        setMetric={setMetric}
        disabled={disabled}
        scope={
          <>
            <span className="analytics-coverage-badge">
              Partial coverage · Not total Uniswap volume
            </span>
            <span>
              Hook pools Radar can price · {scopeName} ·{" "}
              {windows[request.window]} window ·{" "}
              {STATIC_EDITION
                ? "measured within 5 minutes of the snapshot"
                : "measured within the last 5 minutes"}
            </span>
          </>
        }
        items={[
          {
            key: "volume",
            primary: true,
            label: <>Trading volume · {windows[request.window]}</>,
            value: formatMoneyCompact(model.totals.volumeUsd),
            exact: formatMetricExact("volume", model.totals.volumeUsd),
            testId: "analytics-volume",
            caption: (
              <Measurement
                proof={totals.freshness.volume[request.window]}
                now={now}
              />
            ),
          },
          {
            key: "reserves",
            label: "Reserves held in pools",
            value: formatMoneyCompact(model.totals.liquidityUsd),
            exact: formatMetricExact("reserves", model.totals.liquidityUsd),
            testId: "analytics-liquidity",
            caption: <Measurement proof={totals.freshness.liquidity} now={now} />,
          },
          {
            key: "trading",
            label: "Pools with trading",
            value: volumeCurrent ? formatCount(totals.activePools) : "—",
            testId: "analytics-active-pools",
            caption: (
              <span className="analytics-metric-caption">
                {volumeCurrent
                  ? `Of ${formatCount(totals.volumePools)} ${totals.volumePools === 1 ? "pool" : "pools"} with current volume`
                  : STATIC_EDITION
                    ? "No current volume measurements"
                    : "Awaiting current volume measurements"}
                {volumeCurrent && totals.volumePools > 0 && (
                  <RatioMeter ratio={totals.activePools / totals.volumePools} />
                )}
              </span>
            ),
          },
          {
            key: "projects",
            // Unnamed hooks are counted one by one beside the named projects.
            label: STATIC_EDITION ? (
              <>Measured projects &amp; unnamed hooks</>
            ) : (
              <>Measured projects &amp; hooks</>
            ),
            value: attributionCurrent
              ? formatCount(totals.attributedProjects)
              : "—",
            testId: "analytics-measured-projects",
            caption: (
              <span className="analytics-metric-caption">
                {formatCount(measuredNetworks)}{" "}
                {measuredNetworks === 1 ? "network" : "networks"} with volume or
                reserve data
              </span>
            ),
          },
        ]}
        composition={
          <AnalyticsComposition
            model={model}
            metric={metric}
            focus={focus}
            setFocus={setFocus}
            disabled={disabled}
          />
        }
        method={
          <details className="analytics-method">
            <summary>
              <span
                className={`status-led ${volumeCurrent || reservesCurrent ? "green" : "amber"}`}
              />
              <span>
                {volumeCurrent || reservesCurrent
                  ? STATIC_EDITION
                    ? "All figures are current as of the snapshot"
                    : "All figures are current"
                  : STATIC_EDITION
                    ? request.chain === "all"
                      ? "No current market data in this snapshot"
                      : `No current market data for ${scopeLabel} in this snapshot`
                    : "Waiting for current market data"}
              </span>
              <span className="analytics-method-summary">
                How these numbers are measured
              </span>
              <ChevronDown size={14} />
            </summary>
            <div className="analytics-method-body">
              <p>
                Volume includes only tracked v4 pools with hooks and current
                measurements. Uniswap v2, v3 and v4 pools without hooks are
                excluded. Each pool is counted once. Missing amounts remain
                unavailable; a measured zero stays zero.
              </p>
              <p>
                Coverage, rolling time windows and USD valuations can differ
                from Uniswap’s figures. A network with volume or reserve data
                may still have unmeasured pools. We have not verified what
                percentage of all hook trading volume is covered.
              </p>
              <p>
                {STATIC_EDITION
                  ? "A measurement counts only if it was less than five minutes old when the snapshot was taken; older ones are left out of the totals and shares. Newer measurements appear in the next snapshot. "
                  : envelope.contributions
                  ? "Each measurement expires five minutes after its source observation. Totals and shares use the current measurements from the latest response. Newly available measurements appear on refresh. "
                  : "Amounts expire five minutes after their source observation. When a contributing measurement expires, its aggregate is withheld until the next evaluation. Shares use the complete measured total. "}
                Reported reserves exclude unmeasured assets and are not
                executable liquidity or protocol TVL.
              </p>
              {STATIC_EDITION ? (
                <p>
                  Publication:{" "}
                  {fullTimeLabel(envelope.publication.generatedAt) ??
                    "time unavailable"}
                  . Evaluated:{" "}
                  {fullTimeLabel(envelope.asOf) ?? "time unavailable"}.
                  Evaluation does not renew source timestamps.
                </p>
              ) : (
                <p>
                  Publication:{" "}
                  {new Date(envelope.publication.generatedAt).toLocaleString()}.
                  Evaluated: {new Date(envelope.asOf).toLocaleString()} (your
                  local time; {formatUtc(Date.parse(envelope.asOf))}).
                  Evaluation does not renew source timestamps.
                </p>
              )}
            </div>
          </details>
        }
      />
      {historyFirst && historyPanel}
      <AnalyticsContributors
        kicker={historyFirst ? "03 · Who contributed" : "02 · Who contributed"}
        model={model}
        metric={metric}
        focus={focus}
        setFocus={setFocus}
        breakdown={breakdown}
        focusLabel={focusLabel}
        scopeLabel={scopeLabel}
        proof={
          metric === "reserves"
            ? totals.freshness.liquidity
            : totals.freshness.volume[request.window]
        }
        now={now}
        disabled={disabled}
      />
      <AnalyticsEvidence
        kicker={historyFirst ? "04 · Evidence" : "03 · Evidence"}
        windowKey={request.window}
        metric={metric}
        now={now}
        samplePools={totals.samplePools}
        freshness={totals.freshness}
        publishedAt={envelope.publication.generatedAt}
        evaluatedAt={envelope.asOf}
        inventory={
          inventory.length
            ? {
                hookPools: indexed,
                hookContracts: inventory.reduce((sum, n) => sum + n.hookCount, 0),
                networks: inventory.length,
                caughtUp: envelope.networkTotals.filter((n) => n.caughtUp).length,
                census,
              }
            : null
        }
        sourceCount={envelope.sources.length}
        openSources={openSources}
        scopeLabel={scopeName}
      >
        <section
          className="analytics-coverage-plate plate"
          aria-labelledby="analytics-coverage-heading"
        >
          <div className="analytics-panel-heading">
            <div>
              <span className="analytics-section-number">
                Measurement coverage
              </span>
              <h3 id="analytics-coverage-heading">The observed sample</h3>
            </div>
            <button
              type="button"
              className="analytics-text-button"
              onClick={openDetails}
            >
              Inspect coverage <ArrowRight size={14} />
            </button>
          </div>
          <div
            className="analytics-footprint-scroll analytics-overview-coverage-scroll"
            tabIndex={0}
            role="region"
            aria-label="Network measurement coverage"
            aria-describedby="analytics-overview-coverage-note"
          >
            <table className="analytics-footprint-table analytics-overview-coverage-table">
              <caption className="sr-only">
                Indexed hook pools and current measurements by network
              </caption>
              <thead>
                <tr>
                  <th scope="col">Network</th>
                  <th scope="col">
                    Indexed hook pools
                    <CensusNote label={census} />
                  </th>
                  <th scope="col">Pools with volume data</th>
                  <th scope="col">Pools with reserve data</th>
                </tr>
              </thead>
              <tbody>
                {envelope.networkTotals.map((n) => (
                  <tr
                    key={n.chain}
                    data-focused={
                      (focus?.kind === "network" && focus.id === n.chain) ||
                      undefined
                    }
                  >
                    <th scope="row">{n.name}</th>
                    <td>{formatCount(n.inventory?.hookPoolCount ?? null)}</td>
                    <td>
                      {overviewMetricCurrent(
                        n.freshness.volume[request.window],
                        now,
                      )
                        ? formatCount(n.volumePools)
                        : "—"}
                    </td>
                    <td>
                      {overviewMetricCurrent(n.freshness.liquidity, now)
                        ? formatCount(n.liquidityPools)
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="analytics-scroll-hint" aria-hidden="true">
            Swipe the table sideways for volume and reserve coverage →
          </p>
          <p
            id="analytics-overview-coverage-note"
            className="analytics-panel-footnote"
          >
            {formatCount(totals.samplePools)}{" "}
            {totals.samplePools === 1 ? "pool" : "pools"} in the market
            observation sample
            {indexed === null
              ? ". Indexed pool counts are unavailable."
              : ` · ${formatCount(indexed)} indexed hook pools in this scope${census ? ` (${census})` : ""}.`}{" "}
            Unmeasured pools, including inactive pools, remain part of the
            indexed population. Counts describe available observations, not
            universal price coverage.
          </p>
        </section>
      </AnalyticsEvidence>
      {showHistory && !historyFirst && historyPanel}
      <section
        className="analytics-step analytics-drill-teaser"
        aria-labelledby="analytics-drill-heading"
      >
        <header className="analytics-step-head">
          <span className="analytics-step-kicker">
            {historyFirst ? "05 · Drill down" : "04 · Drill down"}
          </span>
          <h2 id="analytics-drill-heading">Projects, hooks and pools</h2>
          <p>
            The overview is built from published aggregates. Ranked hooks, the
            reserves-versus-volume distribution, every pool measurement with its
            original clock, and the CSV export load with the complete dataset.
          </p>
        </header>
        <button
          type="button"
          className="primary-button"
          onClick={openDetails}
          disabled={disabled}
        >
          Open projects, hooks and pools <ArrowRight size={15} />
        </button>
      </section>
    </section>
  );
}
