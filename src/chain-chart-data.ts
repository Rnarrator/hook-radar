import type { ChainExplorerResult, ChainNetwork } from "./chains";
import { analyticsChartShare } from "./analytics-chart-data.ts";
import { STATIC_EDITION } from "./edition.ts";

export type ChainChartMetric = "volume" | "reserves" | "pools";

function nonnegative(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/** These values have already passed buildChains' current-measurement gate.
 * Missing measurements stay missing, even beside a measured zero. */
export function chainNetworkSeries(
  result: Pick<ChainExplorerResult, "networks" | "totals">,
  metric: ChainChartMetric,
) {
  const rows = result.networks.map((network) => ({
    network,
    value: nonnegative(
      metric === "pools"
        ? network.inventory?.hookPoolCount
        : metric === "volume"
          ? network.volumeUsd
          : network.liquidityUsd,
    ),
  }));
  const total =
    metric === "pools"
      ? rows.some((row) => row.value !== null)
        ? nonnegative(rows.reduce((sum, row) => sum + (row.value ?? 0), 0))
        : null
      : nonnegative(
          metric === "volume"
            ? result.totals.volumeUsd
            : result.totals.liquidityUsd,
        );
  return rows
    .map((row) => ({ ...row, share: analyticsChartShare(row.value, total) }))
    .sort((a, b) => {
      if (a.value === null && b.value !== null) return 1;
      if (a.value !== null && b.value === null) return -1;
      return (
        (b.value ?? 0) - (a.value ?? 0) ||
        a.network.name.localeCompare(b.network.name) ||
        a.network.slug.localeCompare(b.network.slug)
      );
    });
}

/** Inventory is historical pool discovery, not economic pricing coverage.
 * Reject inconsistent totals rather than drawing a misleading full circle. */
export function chainPoolComposition(
  inventory: Pick<
    ChainExplorerResult["inventory"],
    "poolCount" | "hookPoolCount"
  >,
) {
  const total = nonnegative(inventory.poolCount);
  const hooked = nonnegative(inventory.hookPoolCount);
  if (
    total === null ||
    hooked === null ||
    !Number.isInteger(total) ||
    !Number.isInteger(hooked) ||
    hooked > total
  )
    return { total, hooked, plain: null, share: null, valid: false };
  return {
    total,
    hooked,
    plain: total - hooked,
    share: analyticsChartShare(hooked, total),
    valid: true,
  };
}

export function chainInventoryCaption(network: ChainNetwork | null): string {
  if (!network?.inventory) return "No pool inventory available";
  if (["error", "unavailable"].includes(network.inventory.status))
    return "Saved inventory · index source is unavailable";
  // The edition never syncs: its inventory is a dated export.
  if (STATIC_EDITION)
    return network.caughtUp
      ? "Saved inventory · scanned to its recorded target"
      : "Saved inventory · the scan had not reached its target";
  if (network.caughtUp && network.headFresh)
    return "Indexed through the latest checked chain head";
  if (network.caughtUp) return "Saved inventory · chain head needs a refresh";
  return "Pool history is still syncing · counts can grow";
}

export function chainChartExact(
  value: number | null,
  currency: boolean,
): string {
  if (value === null || !Number.isFinite(value)) return "Not available";
  return value.toLocaleString(undefined, {
    ...(currency ? { style: "currency", currency: "USD" } : {}),
    maximumSignificantDigits: 17,
  });
}
