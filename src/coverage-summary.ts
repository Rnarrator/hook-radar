import type { PoolIndexCoverage } from "../shared/types";
import { networkCaughtUp } from "../shared/indexing.ts";
import { count } from "./model.ts";

export interface CoverageSummaryOptions {
  /** The service is verifying saved data; coverage is last loaded, not current. */
  serviceStarting: boolean;
  /** The figures are saved, cached or offline rather than freshly published. */
  savedCoverage: boolean;
}

/** One plain sentence about how complete the pool search is, in a long form for
 * wide screens and a short one for phones. The full and the light layouts show
 * the same words, so a visitor sees one status wherever they are. */
export function coverageSummary(
  inventory: PoolIndexCoverage,
  { serviceStarting, savedCoverage }: CoverageSummaryOptions,
): { long: string; short: string } {
  const caughtUp = inventory.networks.filter(networkCaughtUp).length;
  const total = inventory.networks.length;
  const current = `${caughtUp} of ${total} networks up to date`;
  return {
    long: serviceStarting
      ? `Last loaded: ${count(inventory.hookPoolCount)} hook pools · checking current coverage`
      : savedCoverage
        ? `Last loaded: ${count(inventory.hookPoolCount)} hook pools · saved coverage`
        : `${current}${caughtUp === total ? "" : " · still searching"}`,
    short: serviceStarting
      ? "Checking saved history"
      : savedCoverage
        ? "Saved pool history"
        : current,
  };
}
