import { useId, useMemo, useRef, useState } from "react";
import type { ChainNetwork } from "../chains";
import type { MetricFreshness, WindowKey } from "../../shared/types";
import {
  chainIndexState,
  chainMeasurementTitle,
  chainStatusTitle,
  selectNetworkRows,
  type NetworkSort,
} from "../chain-network-directory";
import { count, money, windows } from "../model";
import { formatMoneyExact } from "../charts/format";
import { STATIC_EDITION } from "../edition";
import { ArrowRight, ChevronDown, Search, X } from "./Icons";
import { Empty } from "./Primitives";
import { CensusNote } from "./EditionStatus";
import "./chain-network-directory.css";

const COLLAPSED_ROWS = 8;

// The edition reads an exact amount in cents, as every other figure of the
// page does: the sums behind these rows carry float residue past the cent.
const exactAmount = (value: number | null) =>
  value === null
    ? "No current measurement"
    : STATIC_EDITION
      ? formatMoneyExact(value)
      : value.toLocaleString(undefined, {
          style: "currency",
          currency: "USD",
          maximumSignificantDigits: 17,
        });
function measurementNote(freshness: MetricFreshness) {
  if (freshness.currentPools)
    return `${count(freshness.currentPools)} current ${freshness.currentPools === 1 ? "pool" : "pools"}`;
  return freshness.stalePools
    ? "Measurements expired"
    : freshness.unknownPools
      ? "Freshness unavailable"
      : "No measurements available";
}

export function ChainNetworkDirectory({
  networks,
  windowKey,
  disabled,
  onSelectNetwork,
  census = null,
}: {
  networks: ChainNetwork[];
  windowKey: WindowKey;
  disabled?: boolean;
  onSelectNetwork: (chain: string) => void;
  /** "census as of 27 Oct 2026": dates the pool counts (static edition). */
  census?: string | null;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<NetworkSort>("projects");
  const [expanded, setExpanded] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const searchId = useId();
  const rows = useMemo(
    () => selectNetworkRows(networks, query, sort),
    [networks, query, sort],
  );
  const visible =
    expanded || query.trim() ? rows : rows.slice(0, COLLAPSED_ROWS);
  const clear = () => {
    setQuery("");
    input.current?.focus();
  };
  return (
    <section
      className="chains-network-index"
      id="chains-networks"
      aria-labelledby="chains-networks-title"
    >
      <div className="chains-section-heading">
        <div>
          <p className="chains-section-kicker">Network ledger</p>
          <h2 id="chains-networks-title" tabIndex={-1}>
            Networks <span>{count(networks.length)}</span>
          </h2>
          <p>
            Every network with registry, deployment or pool-index evidence.
            Open one for its profile, protocols and markets.
            {census && <> Hook pool counts are from the {census}.</>}
          </p>
        </div>
        <span className="chains-network-result-count" role="status">
          {query.trim()
            ? `${count(rows.length)} of ${count(networks.length)} networks`
            : `${count(networks.filter((row) => row.inventory).length)} with indexed pools`}
        </span>
      </div>
      <div className="chain-directory-controls">
        <div className="chains-search chain-network-search">
          <Search size={16} />
          <label className="sr-only" htmlFor={searchId}>
            Find a network
          </label>
          <input
            id={searchId}
            ref={input}
            aria-label="Find a network"
            type="search"
            value={query}
            maxLength={160}
            placeholder="Search network or chain ID"
            onChange={(event) =>
              setQuery(
                event.target.value
                  .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
                  .slice(0, 160),
              )
            }
            disabled={disabled}
          />
          {query && (
            <button
              aria-label="Clear network search"
              onClick={clear}
              disabled={disabled}
            >
              <X size={16} />
            </button>
          )}
        </div>
        <label className="select-control chain-network-sort">
          <span className="sr-only">Sort networks</span>
          <select
            aria-label="Sort networks"
            value={sort}
            onChange={(event) => setSort(event.target.value as NetworkSort)}
            disabled={disabled}
          >
            <option value="projects">Most listed projects</option>
            <option value="pools">Most hook pools</option>
            <option value="volume">Highest tracked volume</option>
            <option value="reserves">Highest reserves</option>
            <option value="name">Name A–Z</option>
          </select>
          <ChevronDown size={14} />
        </label>
      </div>
      {visible.length ? (
        <>
          <div
            className="chains-network-table chain-directory-table"
            role="table"
            aria-label="Network overview"
          >
            <div className="chains-network-table-head" role="row">
              <span
                role="columnheader"
                aria-sort={sort === "name" ? "ascending" : undefined}
              >
                Network
              </span>
              <span
                role="columnheader"
                aria-sort={sort === "projects" ? "descending" : undefined}
              >
                Listed projects
              </span>
              <span
                role="columnheader"
                aria-sort={sort === "pools" ? "descending" : undefined}
              >
                Hook pools indexed
                <CensusNote label={census} />
              </span>
              <span
                role="columnheader"
                aria-sort={sort === "volume" ? "descending" : undefined}
              >
                Tracked {windows[windowKey]} volume
              </span>
              <span
                role="columnheader"
                aria-sort={sort === "reserves" ? "descending" : undefined}
              >
                Reported reserves
              </span>
            </div>
            {visible.map((row) => {
              const state = chainIndexState(row);
              return (
                <div
                  className="chains-network-row"
                  role="row"
                  key={row.slug}
                  data-state={state.state}
                >
                  <span role="cell">
                    <button
                      aria-label={`Explore ${row.name}`}
                      onClick={() => onSelectNetwork(row.slug)}
                      disabled={disabled}
                    >
                      <span className="chains-network-identity">
                        <span className="chains-network-name">{row.name}</span>
                        <small>
                          {row.chainId !== null
                            ? `Chain ID ${row.chainId}`
                            : "Registry network"}
                        </small>
                        <span
                          className={`chains-network-status ${state.state}`}
                          title={chainStatusTitle(row)}
                        >
                          <span
                            className={`chains-status-dot ${state.state}`}
                            aria-hidden="true"
                          />
                          {state.label}
                        </span>
                      </span>
                      <ArrowRight size={15} />
                    </button>
                  </span>
                  <span role="cell" data-label="Listed projects">
                    {count(row.protocolCount)}
                  </span>
                  <span role="cell" data-label="Hook pools indexed">
                    {count(row.inventory?.hookPoolCount)}
                  </span>
                  <span
                    role="cell"
                    data-label={`Tracked ${windows[windowKey]} volume`}
                  >
                    <span
                      className="chains-network-amount"
                      title={exactAmount(row.volumeUsd)}
                    >
                      {money(row.volumeUsd)}
                    </span>
                    <span
                      className="chains-network-measurement"
                      title={chainMeasurementTitle(
                        row.freshness.volume[windowKey],
                      )}
                    >
                      {measurementNote(row.freshness.volume[windowKey])}
                    </span>
                  </span>
                  <span role="cell" data-label="Reported reserves">
                    <span
                      className="chains-network-amount"
                      title={exactAmount(row.liquidityUsd)}
                    >
                      {money(row.liquidityUsd)}
                    </span>
                    <span
                      className="chains-network-measurement"
                      title={chainMeasurementTitle(row.freshness.liquidity)}
                    >
                      {measurementNote(row.freshness.liquidity)}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
          {!query.trim() && rows.length > COLLAPSED_ROWS && (
            <button
              className="chains-reveal"
              aria-expanded={expanded}
              aria-label={
                expanded ? "Show fewer networks" : "Show all networks"
              }
              onClick={() => setExpanded(!expanded)}
              disabled={disabled}
            >
              {expanded ? "Show fewer networks" : "Show all networks"}
              <span>
                {expanded
                  ? `${rows.length} networks`
                  : `${rows.length - COLLAPSED_ROWS} more`}
              </span>
              <ChevronDown size={14} />
            </button>
          )}
        </>
      ) : (
        <Empty
          title="No matching networks"
          icon={<Search size={27} />}
          action={
            <button className="control" onClick={clear} disabled={disabled}>
              Reset network search
            </button>
          }
        >
          Search by network name or numeric chain ID.
        </Empty>
      )}
      <p className="chain-directory-note">
        Network measurements include named projects and other discovered hooks.
        Missing prices stay unavailable.
      </p>
    </section>
  );
}
