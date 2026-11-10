import type { PoolIndexCoverage, RadarSnapshot } from "../../shared/types";
import {
  networkCaughtUp,
  networkHeadFresh,
  networkIndexProgress,
} from "../../shared/indexing";
import { count, inlineTime } from "../model";
import { ChevronDown } from "./Icons";
import "./coverage.css";

export const indexProgress = networkIndexProgress;

type Network = PoolIndexCoverage["networks"][number];

function explorerCatchingUp(error: string | null | undefined) {
  return /(?:Explorer is catching up to the verified canonical chain head|X Layer explorer: source is catching up to the canonical target)/i.test(
    error || "",
  );
}

function networkLabel(
  network: Network,
  now: number,
  running: boolean,
  savedData: boolean,
) {
  if (savedData)
    return networkCaughtUp(network)
      ? "Saved history indexed"
      : "Saved progress";
  if (networkCaughtUp(network)) {
    if (!running) return "History indexed · saved data";
    if (network.status === "error" || network.status === "unavailable")
      return "History indexed · source retrying";
    return networkHeadFresh(network, now)
      ? "Up to date"
      : "History indexed · checking latest";
  }
  if (!running) return "Scan paused";
  if (explorerCatchingUp(network.lastError)) return "Waiting for explorer";
  if (network.status === "queued") return "Waiting to scan";
  if (network.status === "error") return "Retrying source";
  if (network.status === "unavailable") return "Source unavailable";
  return "Adding pool history";
}

function Timestamp({ value, label }: { value: string; label: string }) {
  return (
    <span>
      {label}{" "}
      <time dateTime={value} title={new Date(value).toLocaleString()}>
        {inlineTime(value)}
      </time>
    </span>
  );
}

export function PoolCoverage({
  snapshot,
  savedData = false,
}: {
  snapshot: RadarSnapshot;
  savedData?: boolean;
}) {
  const inventory = snapshot.inventory;
  if (!inventory) return null;
  const now = Date.now();
  const complete = inventory.networks.filter(networkCaughtUp).length;
  const current = inventory.networks.filter(
    (network) =>
      networkCaughtUp(network) &&
      !savedData &&
      inventory.running &&
      networkHeadFresh(network, now) &&
      network.status !== "error" &&
      network.status !== "unavailable",
  ).length;
  const registryOnly = snapshot.chains.filter(
    (chain) =>
      !inventory.networks.some((network) => network.chainId === chain.id),
  );
  const measuredPools = snapshot.pools.filter((pool) =>
    [pool.liquidityUsd, ...Object.values(pool.volumeUsd)].some(
      (value) =>
        typeof value === "number" && Number.isFinite(value) && value >= 0,
    ),
  ).length;
  const sourceIssues = inventory.networks.filter(
    (network) => network.status === "error" || network.status === "unavailable",
  ).length;
  return (
    <section className="pool-index-coverage" aria-label="Onchain pool coverage">
      <div className="coverage-index-heading">
        <div>
          <h3>
            {savedData ? "Last loaded coverage" : "Searchable pool history"}
          </h3>
          <p>
            Hook pools found onchain, including inactive pools and pools without
            USD pricing. Each network is tracked from its Uniswap v4 deployment
            through the last verified block.
          </p>
        </div>
        <span>
          {count(complete)} / {count(inventory.networks.length)} chains caught
          up
          <small>
            {savedData
              ? "Coverage from the last loaded snapshot"
              : `${count(current)} recently checked and up to date`}
          </small>
        </span>
      </div>
      <div className="coverage-index-totals">
        <span>
          <strong>{count(inventory.hookPoolCount)}</strong> hook pools found
        </span>
        <span>
          <strong>{count(inventory.hookCount)}</strong> hook addresses
        </span>
        <span>
          <strong>{count(measuredPools)}</strong>{" "}
          {measuredPools === 1 ? "pool" : "pools"} with saved USD observations
        </span>
      </div>
      <details className="coverage-network-disclosure">
        <summary>
          <span>Network details</span>
          <span className="coverage-network-count">
            {count(inventory.networks.length)} onchain
            {registryOnly.length > 0 && (
              <> · {count(registryOnly.length)} registry only</>
            )}
          </span>
          {sourceIssues > 0 && (
            <span className="coverage-network-attention">
              {count(sourceIssues)}{" "}
              {savedData || !inventory.running
                ? "with saved source issues"
                : sourceIssues === 1
                  ? "source retrying"
                  : "sources retrying"}
            </span>
          )}
          <ChevronDown size={14} />
        </summary>
        <div className="coverage-network-list">
          {inventory.networks.map((network) => {
            const progress = indexProgress(network);
            const caughtUp = networkCaughtUp(network);
            const remaining =
              network.targetBlock === null
                ? null
                : Math.max(
                    0,
                    network.targetBlock -
                      Math.max(network.startBlock - 1, network.scannedToBlock),
                  );
            const progressLabel = caughtUp
              ? "100%"
              : progress > 0 && progress < 0.1
                ? "<0.1%"
                : `${(Math.floor(progress * 10) / 10).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
            return (
              <article
                key={network.chainId}
                className="coverage-network"
                data-state={savedData ? "saved" : network.status}
                data-current={
                  caughtUp &&
                  !savedData &&
                  inventory.running &&
                  networkHeadFresh(network, now) &&
                  network.status !== "error" &&
                  network.status !== "unavailable"
                }
              >
                <div>
                  <strong>{network.name}</strong>
                  <span>
                    {networkLabel(network, now, inventory.running, savedData)}
                  </span>
                </div>
                <div
                  className="coverage-scan-track"
                  role="progressbar"
                  aria-label={`${network.name} pool scan`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.floor(progress)}
                  aria-valuetext={
                    caughtUp
                      ? "Scanned through the last verified chain head"
                      : remaining === null
                        ? savedData
                          ? "No verified chain head in the saved snapshot"
                          : "Awaiting a verified chain head"
                        : `${progressLabel} indexed; ${count(remaining)} ${remaining === 1 ? "block" : "blocks"} remaining to the last verified head`
                  }
                >
                  <span style={{ width: `${progress}%` }} />
                </div>
                <div className="coverage-network-meta">
                  <span>
                    {network.scannedToBlock < network.startBlock ? (
                      savedData ? (
                        "No saved scan yet"
                      ) : (
                        "Waiting for first scan"
                      )
                    ) : (
                      <>
                        {count(network.hookPoolCount)} hook{" "}
                        {network.hookPoolCount === 1 ? "pool" : "pools"} ·{" "}
                        {count(network.hookCount)}{" "}
                        {network.hookCount === 1 ? "hook" : "hooks"}
                      </>
                    )}
                  </span>
                  <span>
                    {remaining !== null && !caughtUp
                      ? `${progressLabel} · ${count(remaining)} ${remaining === 1 ? "block" : "blocks"} to scan`
                      : network.targetBlock === null
                        ? savedData
                          ? "Head not checked in saved snapshot"
                          : "Head check pending"
                        : "History scan complete"}
                  </span>
                </div>
                <div className="coverage-network-times">
                  {network.headCheckedAt ? (
                    <Timestamp
                      value={network.headCheckedAt}
                      label="Head checked"
                    />
                  ) : (
                    <span>
                      {network.targetBlock === null
                        ? savedData
                          ? "Head not checked in saved snapshot"
                          : "Latest head not checked yet"
                        : "Using a saved scan target"}
                    </span>
                  )}
                  {network.updatedAt && (
                    <Timestamp value={network.updatedAt} label="Indexed" />
                  )}
                </div>
                <p className="coverage-blocks">
                  {network.scannedToBlock < network.startBlock
                    ? `Scan begins at ${count(network.startBlock)} · head `
                    : `Blocks ${count(network.scannedToBlock)} / `}
                  {network.targetBlock === null
                    ? network.scannedToBlock < network.startBlock
                      ? "pending"
                      : "head pending"
                    : count(network.targetBlock)}
                  {network.finality ? ` · ${network.finality}` : ""}
                </p>
                {network.lastError && (
                  <p className="coverage-index-error" title={network.lastError}>
                    {explorerCatchingUp(network.lastError)
                      ? "The explorer is catching up."
                      : /HTTP (?:429|529)|cooling down|rate limit|too many requests/i.test(
                            network.lastError,
                          )
                        ? "Source busy."
                        : "Couldn’t check the source."}{" "}
                    {inventory.running && !savedData
                      ? "Retrying automatically."
                      : "Showing the saved scan."}
                  </p>
                )}
                {network.cacheWarning && (
                  <p className="coverage-index-error">{network.cacheWarning}</p>
                )}
              </article>
            );
          })}
          {registryOnly.map((chain) => (
            <article key={chain.id} className="coverage-network registry-only">
              <div>
                <strong>{chain.name}</strong>
                <span>Registry indexed</span>
              </div>
              <p>
                Registered hook deployments are searchable. A canonical pool
                source has not been established for this network.
              </p>
            </article>
          ))}
        </div>
      </details>
      <p className="coverage-index-note">
        A completed scan includes all pool creation events through the last
        verified chain head. Up to date also requires a successful head check
        within the last 10 minutes. USD pricing is separate; missing prices
        never mean zero activity.
      </p>
    </section>
  );
}
