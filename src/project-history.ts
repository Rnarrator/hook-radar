import type { PoolIndexCoverage } from "../shared/types";
import { networkCaughtUp } from "../shared/indexing.ts";

/** Incomplete saved coverage alone cannot establish that a scan is running. */
export function isProjectHistoryUpdating(
  inventory: Pick<PoolIndexCoverage, "running" | "networks"> | undefined,
  projectChains: readonly string[],
  { savedContext = false, chain = "all" } = {},
): boolean {
  return Boolean(
    !savedContext &&
    inventory?.running &&
    inventory.networks.some(
      (network) =>
        projectChains.includes(network.chain) &&
        (chain === "all" || network.chain === chain) &&
        network.targetBlock !== null &&
        !networkCaughtUp(network) &&
        (network.status === "queued" || network.status === "scanning"),
    ),
  );
}
