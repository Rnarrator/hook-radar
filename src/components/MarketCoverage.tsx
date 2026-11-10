import { useId, useState } from "react";
import type { MarketIndexCoverage, RadarSnapshot } from "../../shared/types";
import { count, inlineTime } from "../model";
import { STATIC_EDITION, censusLabel } from "../edition";
import { pricingAvailabilityByNetwork } from "../pricing-coverage";
import type {
  NetworkPricingAvailability,
  PricingAvailability,
} from "../pricing-coverage";
import { ChevronDown, Info } from "./Icons";
import "./market-coverage.css";

/** A published row. The collector marks `unsupported` on a network the price
 * source answered "not indexed" for (an HTTP 400, which is a reply and not a
 * failure); a snapshot published before that carries no flag. */
type NetworkLookups = MarketIndexCoverage["networks"][number] & {
  unsupported?: boolean;
};

/** A snapshot's pricing checks are one finished pass: a network was not asked,
 * asked and answered, or asked with no result. That is read from the counts,
 * the same ones "checked" is defined by (a source responded). Asked with no
 * result is not called a failure to respond: without the flag the snapshot
 * cannot tell a network the source does not index from one it did not answer. */
function editionLookup(network: NetworkLookups): {
  state: "empty" | "live" | "unavailable";
  label: string;
} {
  if (network.checkedPools > 0)
    return { state: "live", label: "Source responded" };
  if (network.unsupported === true)
    return { state: "empty", label: "Not indexed by the price source" };
  if (!network.attemptedPools)
    return { state: "empty", label: "Not checked in this snapshot" };
  return { state: "unavailable", label: "No pricing results for this network" };
}

function lookupStatus(network: NetworkLookups, savedData: boolean) {
  if (savedData) {
    if (!network.inventoryPools) return "No hook pools in saved checks";
    if (network.status !== "unavailable") return "Saved market data";
    return network.attemptedPools
      ? "Source unavailable at last check"
      : "No saved source check";
  }
  if (!network.inventoryPools) return "No hook pools found";
  if (STATIC_EDITION) return editionLookup(network).label;
  if (network.status === "live") return "Source responding";
  if (network.status === "cached") return "Saved market data";
  return network.attemptedPools
    ? "Source unavailable"
    : "Waiting for first check";
}

/** Successful lookups and available USD data are deliberately separate counts. */
export function MarketCoverage({
  snapshot,
  savedData = false,
  initialNetwork = "all",
}: {
  snapshot: RadarSnapshot;
  savedData?: boolean;
  initialNetwork?: string;
}) {
  const headingId = useId();
  const explanationId = useId();
  const [selectedNetwork, setSelectedNetwork] = useState(initialNetwork);
  const coverage = snapshot.marketCoverage;
  if (!coverage) return null;
  const selected = coverage.networks.find(
    (network) => network.chain === selectedNetwork,
  );
  const networks = selected ? [selected] : coverage.networks;
  const totals = networks.reduce(
    (result, network) => ({
      indexed: result.indexed + network.inventoryPools,
      checked: result.checked + network.checkedPools,
      observed: result.observed + network.measuredPools,
      waiting: result.waiting + network.pendingPools,
      missing: result.missing + network.missingPools,
    }),
    { indexed: 0, checked: 0, observed: 0, waiting: 0, missing: 0 },
  );
  const progress = totals.indexed ? (100 * totals.checked) / totals.indexed : 0;
  // Draw the checked share as its two real parts only when the published
  // counts reconcile exactly; otherwise keep the single checked bar.
  const partitioned =
    totals.indexed > 0 &&
    totals.observed + totals.missing === totals.checked &&
    totals.checked + totals.waiting === totals.indexed;
  // Rounding a large nearly finished index up would hide its remaining lookups.
  const progressLabel =
    progress > 0 && progress < 0.1
      ? "<0.1%"
      : `${(totals.checked < totals.indexed ? Math.floor(progress * 10) / 10 : progress).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
  // The edition checks one fixed sample once per run: nothing is "remaining",
  // and the population is the dated census (never "discovered" by this page).
  // "Checked" means a source responded, so a pool without a check result was
  // either outside the sample (not asked) or asked and never answered: the
  // label has to be true of both.
  const census = STATIC_EDITION ? censusLabel(snapshot.inventory) : null;
  // "Checked" means a source responded, so a network counts only when one did.
  const checkedNetworks = coverage.networks.filter(
    (network) => network.checkedPools > 0,
  ).length;
  // Census networks that have no row here, so the count above is not the
  // census's own total and says so.
  const unlisted = STATIC_EDITION
    ? (snapshot.inventory?.networks ?? []).filter(
        (network) =>
          network.hookPoolCount > 0 &&
          !coverage.networks.some((row) => row.chainId === network.chainId),
      )
    : [];
  const unlistedPools = unlisted.reduce(
    (sum, network) => sum + network.hookPoolCount,
    0,
  );
  const pendingLabel = STATIC_EDITION
    ? "Not checked in this snapshot"
    : "Checks remaining";
  const chainNames = new Map(
    snapshot.chains.map((chain) => [chain.id, chain.name]),
  );
  const pricing = savedData
    ? new Map<string, NetworkPricingAvailability>()
    : pricingAvailabilityByNetwork(snapshot.pools);
  const current = networks.reduce(
    (result, network) => {
      const measured = pricing.get(network.chain);
      if (measured?.volume.current) {
        result.volume += measured.volume.current;
        result.volumeNetworks++;
      }
      if (measured?.reserves.current) {
        result.reserves += measured.reserves.current;
        result.reserveNetworks++;
      }
      return result;
    },
    { volume: 0, reserves: 0, volumeNetworks: 0, reserveNetworks: 0 },
  );

  return (
    <section className="market-coverage" aria-labelledby={headingId}>
      <div className="market-coverage-heading">
        <h3 id={headingId}>
          {savedData ? "Last loaded pricing checks" : "Pricing coverage"}
        </h3>
        <span>
          {savedData
            ? "Saved checks among discovered hook pools"
            : STATIC_EDITION
              ? "Among the hook pools in the census"
              : "Among discovered hook pools"}
        </span>
      </div>
      {coverage.networks.length > 1 && (
        <label className="market-network-select">
          <span>Network</span>
          <select
            aria-label="Pricing network"
            value={selected?.chain || "all"}
            onChange={(event) => setSelectedNetwork(event.target.value)}
          >
            <option value="all">All networks</option>
            {[...coverage.networks]
              .sort((a, b) =>
                (chainNames.get(a.chainId) || a.chain).localeCompare(
                  chainNames.get(b.chainId) || b.chain,
                ),
              )
              .map((network) => (
                <option key={network.chainId} value={network.chain}>
                  {chainNames.get(network.chainId) || network.chain}
                </option>
              ))}
          </select>
          <ChevronDown size={14} />
        </label>
      )}
      {!savedData && coverage.networks.length > 0 && (
        <div className="market-fresh-pricing" aria-label="Fresh pricing">
          <p className="market-fresh-heading">Fresh pricing</p>
          <dl>
            <div>
              <dt>Pools with 24H volume</dt>
              <dd>
                <strong>{count(current.volume)}</strong>
                {!selected && (
                  <span>
                    {count(current.volumeNetworks)} of {count(networks.length)}{" "}
                    {networks.length === 1 ? "network" : "networks"}
                  </span>
                )}
              </dd>
            </div>
            <div>
              <dt>Pools with reported reserves</dt>
              <dd>
                <strong>{count(current.reserves)}</strong>
                {!selected && (
                  <span>
                    {count(current.reserveNetworks)} of {count(networks.length)}{" "}
                    {networks.length === 1 ? "network" : "networks"}
                  </span>
                )}
              </dd>
            </div>
          </dl>
          <p className="market-lookup-explanation">
            Measured within{" "}
            {STATIC_EDITION ? "five minutes of the snapshot" : "the last five minutes"}.
            Older observations stay saved but are excluded from current totals.
            Missing USD values are not zero.
          </p>
        </div>
      )}
      {totals.indexed ? (
        <>
          <div className="market-lookup-progress-copy">
            <p>
              <strong>{count(totals.checked)}</strong>
              <span>
                {" "}
                of {count(totals.indexed)} hook{" "}
                {totals.indexed === 1 ? "pool" : "pools"} checked
                {census ? ` · ${census}` : ""}
              </span>
            </p>
            {!STATIC_EDITION && <span>{progressLabel}</span>}
          </div>
          <div
            className="market-lookup-progress"
            {...(STATIC_EDITION
              ? {
                  // A finished pass over a fixed sample, not progress.
                  role: "img",
                  "aria-label": partitioned
                    ? `Hook pools in the census by check result: ${count(totals.observed)} with market observations, ${count(totals.missing)} checked without usable data, ${count(totals.waiting)} not checked in this snapshot`
                    : `${count(totals.checked)} of ${count(totals.indexed)} hook pools in the census checked`,
                }
              : {
                  role: "progressbar",
                  "aria-label": "Discovered hook pools checked for market data",
                  "aria-valuemin": 0,
                  "aria-valuemax": totals.indexed,
                  "aria-valuenow": totals.checked,
                  "aria-valuetext": `${count(totals.checked)} of ${count(totals.indexed)} discovered hook ${totals.indexed === 1 ? "pool" : "pools"} checked`,
                })}
            aria-describedby={explanationId}
          >
            {partitioned ? (
              <>
                <span
                  data-part="measured"
                  style={{ width: `${(100 * totals.observed) / totals.indexed}%` }}
                />
                <span
                  data-part="missing"
                  style={{ width: `${(100 * totals.missing) / totals.indexed}%` }}
                />
              </>
            ) : (
              <span style={{ width: `${progress}%` }} />
            )}
          </div>
          {partitioned && (
            <ul className="market-lookup-legend" aria-hidden="true">
              <li>
                <i data-part="measured" /> With market observations
              </li>
              <li>
                <i data-part="missing" /> Checked, no usable data
              </li>
              <li>
                <i data-part="pending" /> {pendingLabel}
              </li>
            </ul>
          )}
          <dl className="market-lookup-totals">
            <div>
              <dt>With market observations</dt>
              <dd>{count(totals.observed)}</dd>
            </div>
            <div>
              <dt>No usable market data</dt>
              <dd>{count(totals.missing)}</dd>
            </div>
            <div>
              <dt>{pendingLabel}</dt>
              <dd>{count(totals.waiting)}</dd>
            </div>
          </dl>
          <p className="market-lookup-explanation" id={explanationId}>
            {STATIC_EDITION ? (
              <>
                Checked means a market source responded, even if it had no data
                for that pool. Pools without a check result were either not
                asked about or asked without a response. A response may still be
                missing current USD prices or volume.
                {!selected && checkedNetworks < coverage.networks.length && (
                  <>
                    {" "}
                    Checks were made on {count(checkedNetworks)} of{" "}
                    {count(coverage.networks.length)} networks.
                  </>
                )}
                {!selected && unlisted.length > 0 && (
                  <>
                    {" "}
                    The census also lists {count(unlisted.length)}{" "}
                    {unlisted.length === 1 ? "network" : "networks"} (
                    {count(unlistedPools)} hook{" "}
                    {unlistedPools === 1 ? "pool" : "pools"}) with no pricing
                    check.
                  </>
                )}
              </>
            ) : (
              <>
                Checked means a market source responded, even if it had no data
                for that pool. Remaining checks are awaiting a successful
                response. A response may still be missing current USD prices or
                volume.
                {snapshot.inventory &&
                  !selected &&
                  totals.indexed > snapshot.inventory.hookPoolCount && (
                    <>
                      {" "}
                      Pricing checks include new pools still being added to
                      search.
                    </>
                  )}
              </>
            )}
          </p>
        </>
      ) : (
        <p className="market-lookup-explanation" id={explanationId}>
          {STATIC_EDITION
            ? "No hook pools in the census to check."
            : "Pricing checks begin once hook pools are discovered onchain."}
        </p>
      )}

      {!!coverage.networks.length && (
        <details
          className="market-lookup-networks"
          key={selected?.chain || "all"}
          open={!!selected}
        >
          <summary>
            <span>Pricing checks by network</span>
            <span className="market-network-count">
              {count(networks.length)}{" "}
              {networks.length === 1 ? "network" : "networks"}
            </span>
            <ChevronDown size={16} />
          </summary>
          <ul className="market-network-list">
            {networks.map((network) => (
              <li key={network.chainId}>
                <div className="market-network-heading">
                  <strong>
                    {chainNames.get(network.chainId) || network.chain}
                  </strong>
                  <span
                    data-state={
                      network.inventoryPools
                        ? savedData
                          ? "cached"
                          : STATIC_EDITION
                            ? editionLookup(network).state
                            : network.status
                        : "empty"
                    }
                  >
                    {lookupStatus(network, savedData)}
                  </span>
                </div>
                <dl className="market-network-numbers">
                  <div>
                    <dt>Checked</dt>
                    <dd>
                      <strong>{count(network.checkedPools)}</strong>
                      <span>of {count(network.inventoryPools)}</span>
                    </dd>
                  </div>
                  <div>
                    <dt>With market observations</dt>
                    <dd>
                      <strong>{count(network.measuredPools)}</strong>
                    </dd>
                  </div>
                  <div>
                    <dt>{pendingLabel}</dt>
                    <dd>
                      <strong>{count(network.pendingPools)}</strong>
                    </dd>
                  </div>
                </dl>
                {!savedData && (
                  <dl
                    className="market-network-pricing"
                    aria-label={`${chainNames.get(network.chainId) || network.chain} fresh pricing`}
                  >
                    <div>
                      <dt>Fresh 24H volume</dt>
                      <PricingMetric
                        availability={pricing.get(network.chain)?.volume}
                      />
                    </div>
                    <div>
                      <dt>Fresh reserves</dt>
                      <PricingMetric
                        availability={pricing.get(network.chain)?.reserves}
                      />
                    </div>
                  </dl>
                )}
                {network.missingPools > 0 && (
                  <p className="market-network-missing">
                    {count(network.missingPools)} checked{" "}
                    {network.missingPools === 1 ? "pool has" : "pools have"} no
                    usable market data
                    {STATIC_EDITION ? " in this snapshot" : " yet"}.
                  </p>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      {coverage.cacheWarning && (
        <p
          className="market-lookup-warning"
          role="note"
          aria-label="Pricing history notice"
        >
          <Info size={15} />
          <span>{coverage.cacheWarning}</span>
        </p>
      )}
    </section>
  );
}

function PricingMetric({
  availability,
}: {
  availability?: PricingAvailability;
}) {
  const current = availability?.current || 0;
  const older = availability?.older || 0;
  const unverified = availability?.unverified || 0;
  return (
    <dd>
      <span>
        {count(current)} {current === 1 ? "pool" : "pools"}
      </span>
      {older > 0 && (
        <span className="market-pricing-context">
          {count(older)} older {older === 1 ? "measurement" : "measurements"}{" "}
          excluded
        </span>
      )}
      {unverified > 0 && (
        <span className="market-pricing-context">
          {count(unverified)} unverified{" "}
          {unverified === 1 ? "measurement" : "measurements"} excluded
        </span>
      )}
      {!current && availability?.lastMeasuredAt && (
        <span className="market-pricing-context">
          Last measured{" "}
          <time dateTime={availability.lastMeasuredAt}>
            {inlineTime(availability.lastMeasuredAt)}
          </time>
        </span>
      )}
      {!current && !older && !unverified && (
        <span className="market-pricing-context">No USD measurements</span>
      )}
    </dd>
  );
}
