import type { DiscoveryEnvelope } from "../../shared/discovery";
import { count, relativeTime } from "../model";
import { STATIC_EDITION, censusLabel, fullTimeLabel } from "../edition";
import { External } from "./Primitives";

export function DiscoverySources({
  data,
  analytics = false,
}: {
  data: Pick<DiscoveryEnvelope, "sources" | "inventory" | "publication">;
  analytics?: boolean;
}) {
  return (
    <>
      <p>
        {analytics
          ? "Market totals cover measured pools only. Unavailable prices are never counted as zero."
          : "Registry sources and pool-discovery checkpoints for this directory."}{" "}
        Each financial measurement keeps its own source timestamp.
      </p>
      <div className="source-list">
        {data.sources.map((source) => (
          <div key={source.id} className="source-item">
            <div>
              <strong>{source.name}</strong>
              <span className={`tag source-tag ${source.status}`}>
                {source.status === "live"
                  ? "Fetched"
                  : source.status === "cached"
                    ? "Saved"
                    : "Unavailable"}
              </span>
            </div>
            <p>{source.note}</p>
            <div className="source-meta">
              <span title={source.updatedAt || undefined}>
                {source.updatedAt
                  ? `Retrieved ${relativeTime(source.updatedAt)}`
                  : "No successful retrieval"}
              </span>
              <External href={source.url}>View source</External>
            </div>
          </div>
        ))}
      </div>
      {data.inventory && (
        <details className="source-diagnostics">
          <summary>
            {STATIC_EDITION ? "Pool census" : "Pool discovery"} ·{" "}
            {count(data.inventory.networks.length)} networks
            {STATIC_EDITION && censusLabel(data.inventory)
              ? ` · ${censusLabel(data.inventory)}`
              : ""}
          </summary>
          <dl className="methodology-list">
            {data.inventory.networks.map((network) => (
              <div key={network.chain}>
                <dt>{network.name}</dt>
                <dd>
                  {count(network.hookPoolCount)} hook pools · {network.status}
                  <br />
                  {network.scannedToBlock < 0
                    ? "No blocks checked yet"
                    : `Checked through block ${count(network.scannedToBlock)}`}
                  {network.scannedToBlock >= 0 && network.targetBlock !== null
                    ? ` of ${count(network.targetBlock)}`
                    : network.targetBlock === null
                      ? " · current target unavailable"
                      : ""}
                  <br />
                  {network.updatedAt
                    ? `Checkpoint updated ${relativeTime(network.updatedAt)}`
                    : "No successful checkpoint"}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      <p className="snapshot-time">
        {analytics ? "Analytics" : "Directory"} published:{" "}
        {STATIC_EDITION
          ? fullTimeLabel(data.publication.generatedAt)
          : new Date(data.publication.generatedAt).toLocaleString()}
        . Pool discovery does not establish complete fresh pricing coverage.
      </p>
    </>
  );
}
