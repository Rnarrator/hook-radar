import type { MarketIndexCoverage } from "./types";

export function isMarketCoverage(value: unknown): value is MarketIndexCoverage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const coverage = value as Record<string, unknown>;
  if (
    !(
      coverage.cacheWarning === null ||
      typeof coverage.cacheWarning === "string"
    ) ||
    !Array.isArray(coverage.networks) ||
    coverage.networks.length > 100
  )
    return false;
  const chains = new Set();
  return coverage.networks.every((network) => {
    if (!network || typeof network !== "object" || Array.isArray(network))
      return false;
    const row = network as Record<string, unknown>;
    if (
      typeof row.chain !== "string" ||
      !/^[a-z0-9-]{1,50}$/.test(row.chain) ||
      !Number.isSafeInteger(row.chainId) ||
      Number(row.chainId) <= 0 ||
      chains.has(row.chainId) ||
      ![
        "inventoryPools",
        "checkedPools",
        "measuredPools",
        "pendingPools",
        "missingPools",
        "attemptedPools",
      ].every(
        (field) => Number.isSafeInteger(row[field]) && Number(row[field]) >= 0,
      ) ||
      !["live", "cached", "unavailable"].includes(String(row.status))
    )
      return false;
    chains.add(row.chainId);
    return (
      Number(row.checkedPools) <= Number(row.inventoryPools) &&
      Number(row.measuredPools) <= Number(row.inventoryPools) &&
      Number(row.pendingPools) ===
        Math.max(0, Number(row.inventoryPools) - Number(row.checkedPools)) &&
      Number(row.missingPools) ===
        Math.max(0, Number(row.checkedPools) - Number(row.measuredPools))
    );
  });
}
