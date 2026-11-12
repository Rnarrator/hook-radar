import { useEffect, useId, useMemo, useState } from "react";
import type { WindowKey } from "../../shared/types";
import type { ChainExplorerResult } from "../chains";
import {
  chainChartExact,
  chainInventoryCaption,
  chainNetworkSeries,
  chainPoolComposition,
} from "../chain-chart-data";
import type { ChainChartMetric } from "../chain-chart-data";
import {
  chainIndexState,
  chainSourceCaption,
  chainSourceFailed,
} from "../chain-network-directory";
import { analyticsChartPercent } from "../analytics-chart-data";
import { count, money, windows } from "../model";
import { formatMoneyExact } from "../charts/format";
import { ArrowRight, ChevronDown } from "./Icons";
import "./chain-charts.css";
import { STATIC_EDITION } from "../edition";
import { CensusNote } from "./EditionStatus";
import {
  DAILY_ERROR,
  dailyChartCount,
  dailyChartNone,
  dailyLoadingText,
  spanLabel,
} from "../daily";
import { useDailyView } from "../daily-view";

/** The exact value in a title or an aria-label. The edition reads a USD amount
 * in cents, like the bars of Analytics: the sums behind a network's volume carry
 * float residue past the cent. Counts and every live label are unchanged. */
function exactValue(value: number | null, currency: boolean): string {
  return STATIC_EDITION && currency && value !== null && Number.isFinite(value)
    ? formatMoneyExact(value)
    : chainChartExact(value, currency);
}

interface Props {
  result: ChainExplorerResult;
  windowKey: WindowKey;
  disabled?: boolean;
  onSelectNetwork: (chain: string) => void;
  /** "census as of 27 Oct 2026": dates the pool counts (static edition). */
  census?: string | null;
}

const COLLAPSED_ROWS = 8;
const stateOrder = ["current", "waiting", "registry", "unsupported"];

/** Up to four names; beyond that three and a count: "Celo, Zora, Ink and 2 more". */
function nameList(names: string[]) {
  if (names.length <= 4) return names.join(", ");
  return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}

/** Pool inventory split, drawn as one 100% bar (no donut). Missing or
 * inconsistent inventory is stated rather than drawn. */
function PoolComposition({
  composition,
  caption,
}: {
  composition: ReturnType<typeof chainPoolComposition>;
  caption: string;
}) {
  const measured = composition.valid && (composition.total ?? 0) > 0;
  const hookedShare = measured ? (composition.share ?? 0) : 0;
  return (
    <div className="chain-pool-composition">
      <div className="chain-pool-headline">
        <strong title={chainChartExact(composition.hooked, false)}>
          {composition.hooked === null ? "—" : count(composition.hooked)}
        </strong>
        <span>
          {measured
            ? `hook-enabled pools · ${analyticsChartPercent(composition.share)} of ${count(composition.total)} indexed v4 pools`
            : composition.total === null
              ? "No pool inventory is available for this scope"
              : "Inventory totals are inconsistent; no share is drawn"}
        </span>
      </div>
      <div
        className="chain-pool-bar"
        data-measured={measured}
        role="img"
        aria-label={
          composition.valid
            ? `${count(composition.hooked ?? 0)} hook-enabled pools and ${count(composition.plain ?? 0)} pools without hooks in the indexed inventory`
            : "Pool composition is unavailable"
        }
      >
        {measured && (
          <>
            <span
              className="chain-pool-hooked"
              style={{ width: `${hookedShare * 100}%` }}
            />
            <span className="chain-pool-plain" />
          </>
        )}
      </div>
      <dl className="chain-pool-legend">
        <div>
          <dt>
            <i className="chain-pool-dot" aria-hidden="true" />
            With hooks
          </dt>
          <dd title={chainChartExact(composition.hooked, false)}>
            {composition.hooked === null ? "—" : count(composition.hooked)}
          </dd>
        </div>
        <div>
          <dt>
            <i className="chain-pool-dot plain" aria-hidden="true" />
            Without hooks
          </dt>
          <dd title={chainChartExact(composition.plain, false)}>
            {composition.plain === null ? "—" : count(composition.plain)}
          </dd>
        </div>
        <div className="chain-pool-legend-total">
          <dt>All indexed pools</dt>
          <dd title={chainChartExact(composition.total, false)}>
            {composition.total === null ? "—" : count(composition.total)}
          </dd>
        </div>
      </dl>
      <p className="chain-chart-note">{caption}</p>
    </div>
  );
}

export function ChainCharts({
  result,
  windowKey,
  disabled = false,
  onSelectNetwork,
  census = null,
}: Props) {
  // Edition: with 7D or 30D chosen the volume bars are daily sums over the
  // largest pools (the model is built over the same lens); until the figures
  // are there the chart says so instead of drawing 24H bars under a 7D label.
  const daily = useDailyView();
  const [metric, setMetric] = useState<ChainChartMetric>("volume");
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const rows = useMemo(
    () => chainNetworkSeries(result, metric),
    [result, metric],
  );
  const measured = rows.filter((row) => row.value !== null);
  const largest = measured[0]?.value ?? 0;
  const spanVolume = metric === "volume" && daily.span !== null;
  const spanPending = spanVolume && !daily.lens;
  // Every row unmeasured: one plain statement beats a column of empty bars.
  const allUnmeasured =
    spanPending ||
    (metric !== "pools" && rows.length > 0 && measured.length === 0);
  const visible = expanded ? rows : rows.slice(0, COLLAPSED_ROWS);
  const amount = (value: number | null) =>
    metric === "pools"
      ? value === null
        ? "—"
        : count(value)
      : spanVolume && value !== null
        ? `≥${money(value)}`
        : money(value);
  const composition = chainPoolComposition(result.inventory);
  const network = result.selectedNetwork;
  const hasScope = result.chain === "all" || result.knownChain;
  const states = useMemo(() => {
    const groups = new Map<
      string,
      { label: string; state: string; count: number; names: string[] }
    >();
    for (const row of result.networks) {
      const state = chainIndexState(row);
      const group = groups.get(state.label) || {
        ...state,
        count: 0,
        names: [],
      };
      group.count++;
      // The edition says which networks the census could not check.
      if (STATIC_EDITION && chainSourceFailed(row)) group.names.push(row.name);
      groups.set(state.label, group);
    }
    return [...groups.values()].sort(
      (a, b) =>
        stateOrder.indexOf(a.state) - stateOrder.indexOf(b.state) ||
        b.count - a.count ||
        a.label.localeCompare(b.label),
    );
  }, [result.networks]);
  useEffect(() => setExpanded(false), [metric, result.chain]);

  if (!hasScope) return null;

  const metricName =
    metric === "volume"
      ? daily.span
        ? `Tracked ${spanLabel(daily.span)} hook-pool volume · largest pools only`
        : `Tracked ${windows[windowKey]} hook-pool volume`
      : metric === "reserves"
        ? "Reported reserves"
        : "Indexed hook pools";
  const unit = metric === "pools" ? "pools" : "USD";

  if (result.chain !== "all")
    return (
      <div className="chain-charts single" id="chain-overview">
        <section
          className="chain-chart-panel chain-composition-panel"
          aria-labelledby={`${id}-composition`}
        >
          <header className="chain-chart-heading">
            <div>
              <p className="chain-chart-eyebrow">Onchain inventory</p>
              <h2 id={`${id}-composition`}>Pool composition</h2>
              <CensusNote label={composition.total === null ? null : census} />
            </div>
            <span className="chain-chart-network-name">{network?.name}</span>
          </header>
          <div className="chain-composition-layout">
            <PoolComposition
              composition={composition}
              caption={`${chainSourceCaption(network) ?? chainInventoryCaption(network)}. Inventory includes inactive pools; it does not indicate priced or trading pools.`}
            />
            <dl className="chain-chart-evidence">
              <div>
                <dt>
                  {STATIC_EDITION
                    ? "Hook contracts found (at least)"
                    : "Distinct pool hooks"}
                </dt>
                <dd>
                  {result.inventory.hookCount === null
                    ? "—"
                    : count(result.inventory.hookCount)}
                </dd>
              </div>
              <div>
                <dt>Listed projects</dt>
                <dd>{count(result.totalProtocols)}</dd>
              </div>
              <div>
                <dt>Listed hook contracts</dt>
                <dd>{count(result.hookCount)}</dd>
              </div>
            </dl>
          </div>
        </section>
      </div>
    );

  return (
    <div className="chain-charts" id="chain-overview">
      <section
        className="chain-chart-panel chain-atlas"
        aria-labelledby={`${id}-composition`}
      >
        <header className="chain-chart-heading">
          <div>
            <p className="chain-chart-eyebrow">Compare networks</p>
            <h2 id={`${id}-composition`}>Network comparison</h2>
          </div>
          <div
            className="chain-chart-switch segmented"
            role="group"
            aria-label="Network comparison metric"
          >
            {(
              [
                ["volume", "Tracked volume"],
                ["reserves", "Reserves"],
                ["pools", "Hook pools"],
              ] as const
            ).map(([value, label]) => (
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
        </header>
        <p className="chain-chart-caption">
          <b>{metricName}</b> · All networks ·{" "}
          {spanVolume
            ? dailyChartCount(
                daily.span!,
                count(measured.length),
                count(rows.length),
              )
            : `${count(measured.length)} of ${count(rows.length)} ${metric === "pools" ? "indexed" : "measured"}`}
          {metric === "volume" && (
            <>
              {" · "}
              <span className="chain-chart-flag">
                Partial coverage · Not total Uniswap volume
              </span>
            </>
          )}
        </p>
        {rows.length > 0 && (
          <div className="chain-chart-axis" aria-hidden="true">
            <span className="chain-chart-axis-scale">
              <span>{metric === "pools" ? "0" : "$0"}</span>
              <span>{unit === "USD" ? "USD · linear" : "Pools · linear"}</span>
              <span>{amount(largest)}</span>
            </span>
          </div>
        )}
        {allUnmeasured ? (
          spanPending ? (
          <p className="chain-chart-empty">
            <strong>
              {daily.phase === "error"
                ? DAILY_ERROR
                : dailyLoadingText(daily.span!)}
            </strong>
            The bars are drawn once the figures are there.
          </p>
          ) : (
          spanVolume ? (
          <p className="chain-chart-empty">
            <strong>{`No ${spanLabel(daily.span!)} volume`}</strong>
            None of the {count(rows.length)} networks has a{" "}
            {spanLabel(daily.span!)} figure for any of its largest pools, so no
            bars are drawn. Unavailable is not zero.
          </p>
          ) : (
          <p className="chain-chart-empty">
            <strong>No current measurements</strong>
            None of the {count(rows.length)} networks has a current{" "}
            {metric === "volume" ? "hook-pool volume" : "reserve"} measurement,
            so no bars are drawn. Unavailable is not zero.
          </p>
          ))
        ) : (
        <ol className="chain-chart-networks">
          {visible.map(({ network: row, value, share }, index) => (
            <li key={row.slug}>
              <button
                type="button"
                className="chain-chart-network"
                disabled={disabled}
                onClick={() => onSelectNetwork(row.slug)}
                data-state={
                  value === null ? "unavailable" : value === 0 ? "zero" : "measured"
                }
                aria-label={`View ${row.name} ecosystem: ${exactValue(value, metric !== "pools")} ${metric === "pools" ? "indexed hook pools" : metric === "volume" ? `tracked ${daily.span ? spanLabel(daily.span) : windows[windowKey]} hook-pool volume` : "reserves"}`}
                title={exactValue(value, metric !== "pools")}
              >
                <span className="chain-chart-rank" aria-hidden="true">
                  {value === null ? "—" : String(index + 1).padStart(2, "0")}
                </span>
                <span className="chain-chart-name">{row.name}</span>
                <span className="chain-chart-track" aria-hidden="true">
                  <span
                    style={{
                      width: `${value !== null && largest > 0 ? Math.min(100, (value / largest) * 100) : 0}%`,
                    }}
                  />
                </span>
                <span className="chain-chart-value">
                  <b>{amount(value)}</b>
                  <small>
                    {value === null
                      ? spanVolume
                        ? dailyChartNone(daily.span!)
                        : "not measured"
                      : analyticsChartPercent(share)}
                  </small>
                </span>
                <ArrowRight size={14} />
              </button>
            </li>
          ))}
        </ol>
        )}
        {rows.length === 0 && (
          <p className="chain-chart-empty">
            <strong>No networks available yet</strong>
            Networks appear once the registry or pool index reports one.
          </p>
        )}
        {!allUnmeasured && rows.length > COLLAPSED_ROWS && (
          <button
            type="button"
            className="chain-chart-expand"
            disabled={disabled}
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded
              ? `Show top ${COLLAPSED_ROWS}`
              : `Show all ${count(rows.length)} networks`}
            <ChevronDown size={14} />
          </button>
        )}
        <p className="chain-chart-note">
          {metric === "pools"
            ? STATIC_EDITION
              ? `Share of indexed hook pools${census ? `, ${census}` : ""}. Counts include inactive pools.`
              : "Share of indexed hook pools. Counts include inactive pools and can grow while history syncs."
            : spanVolume
              ? `${count(measured.length)} of ${count(rows.length)} networks have 7D or 30D volume for at least one pool. Each bar is the sum over the largest pools that have it; shares use those sums, and networks without any are not zero.`
              : `${count(measured.length)} of ${count(rows.length)} networks have current ${metric === "volume" ? "hook-pool volume" : "reserve"} measurements. Shares use ${metric === "volume" ? "tracked volume" : "reported reserves"} across those networks; unavailable values are not zero.`}
        </p>
      </section>

      <section
        className="chain-chart-panel chain-evidence-panel"
        aria-labelledby={`${id}-evidence`}
      >
        <header className="chain-chart-heading">
          <div>
            <p className="chain-chart-eyebrow">Data coverage</p>
            <h2 id={`${id}-evidence`}>How complete our data is, by network</h2>
          </div>
        </header>
        <div className="chain-evidence-readout">
          <strong>{count(result.inventory.caughtUpChains)}</strong>
          <span>
            {STATIC_EDITION ? (
              <>
                of {count(result.inventory.indexedNetworks)} indexed networks
                were scanned to their recorded target when the census was taken
                {census && <CensusNote label={census} />}
              </>
            ) : (
              <>
                of {count(result.inventory.indexedNetworks)} indexed networks
                are scanned to their recorded target ·{" "}
                {count(result.inventory.freshChains)} with a recently checked
                head
              </>
            )}
          </span>
        </div>
        {result.networks.length > 0 && (
          <div
            className="chain-evidence-bar"
            role="img"
            aria-label={`Index status across ${count(result.networks.length)} networks: ${states.map((item) => `${count(item.count)} ${item.label.toLowerCase()}${item.names.length ? ` (${nameList(item.names)})` : ""}`).join(", ")}`}
          >
            {states.map((item) => (
              <span
                key={item.label}
                data-state={item.state}
                style={{ flexGrow: item.count }}
              />
            ))}
          </div>
        )}
        <ul className="chain-evidence-legend">
          {states.map((item) => (
            <li key={item.label} data-state={item.state}>
              <i aria-hidden="true" />
              <span>
                {item.label}
                {item.names.length > 0 && ` (${nameList(item.names)})`}
              </span>
              <b>{count(item.count)}</b>
            </li>
          ))}
        </ul>
        <div className="chain-evidence-divider" />
        <p className="chain-chart-eyebrow">Pools across indexed networks</p>
        <CensusNote label={census} />
        <PoolComposition
          composition={composition}
          caption={
            STATIC_EDITION
              ? "Inventory includes inactive pools; it does not indicate priced or trading pools."
              : "Inventory includes inactive pools and can grow while history syncs; it does not indicate priced or trading pools."
          }
        />
      </section>
    </div>
  );
}
