import type { MetricFreshness } from "../shared/types";
import { inventoryHeadCheckFailed } from "./analytics.ts";
import type { ChainNetwork } from "./chains.ts";
import { STATIC_EDITION, fullTimeLabel } from "./edition.ts";
import { count } from "./model.ts";

export type NetworkSort = "projects" | "pools" | "volume" | "reserves" | "name";

function amount(row: ChainNetwork, sort: NetworkSort): number | null {
  const value =
    sort === "projects"
      ? row.protocolCount
      : sort === "pools"
        ? row.inventory?.hookPoolCount
        : sort === "reserves"
          ? row.liquidityUsd
          : row.volumeUsd;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/** Operates on already freshness-qualified network rows, never raw pool values. */
export function selectNetworkRows(
  networks: readonly ChainNetwork[],
  search: string,
  sort: NetworkSort,
): ChainNetwork[] {
  const needle = search.trim().toLowerCase().slice(0, 160);
  return networks
    .filter(
      (row) =>
        !needle ||
        [
          row.name,
          row.slug,
          row.chainId === null ? "" : String(row.chainId),
        ].some((value) => value.toLowerCase().includes(needle)),
    )
    .sort((a, b) => {
      const alphabetical =
        a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug);
      if (sort === "name") return alphabetical;
      const av = amount(a, sort),
        bv = amount(b, sort);
      return av === bv
        ? alphabetical
        : av === null
          ? 1
          : bv === null
            ? -1
            : bv - av;
    });
}

/** The census recorded a failure for this network (an error in its index source,
 * or no source at all). Its saved block range is still shown. */
export function chainSourceFailed(network: ChainNetwork): boolean {
  return (
    !!network.inventory &&
    ["error", "unavailable"].includes(network.inventory.status)
  );
}

/** The census says it was the head check that failed, by the error it recorded
 * (the messages are listed beside the analytics export, which reads them too). */
export function chainHeadCheckFailed(network: ChainNetwork): boolean {
  return inventoryHeadCheckFailed(network.inventory);
}

export function chainIndexState(
  network: ChainNetwork,
  edition: boolean = STATIC_EDITION,
) {
  if (network.deploymentSupport)
    return { label: network.deploymentSupport.label, state: "unsupported" };
  if (!network.inventory)
    return { label: "Registry listings", state: "registry" };
  if (chainSourceFailed(network))
    // The edition states a failure as it stood at the census, not as a fact
    // about the source today.
    return {
      label: !edition
        ? "Index source unavailable"
        : chainHeadCheckFailed(network)
          ? "Head check failed at census"
          : network.inventory.status === "error"
            ? "Index source error at census"
            : "Index source unavailable at census",
      state: "waiting",
    };
  // The edition does not sync: its pool history is a dated export.
  if (edition)
    return network.caughtUp
      ? { label: "Saved pool history", state: "waiting" }
      : { label: "Saved pool history · scan incomplete", state: "waiting" };
  if (!network.caughtUp)
    return { label: "Pool history syncing", state: "waiting" };
  return network.headFresh
    ? { label: "Pool history current", state: "current" }
    : { label: "Saved pool history", state: "waiting" };
}

/** The line under a network's coverage details when its index source failed.
 * The edition dates it: the failure is a fact of the census, and says whether
 * the saved block range still reached its recorded target. It names the head
 * check only where the census recorded a head-check error; the time it gives is
 * the last head check that passed, because a failed check does not set it. */
export function chainSourceNote(
  network: ChainNetwork,
  edition: boolean = STATIC_EDITION,
): string | null {
  if (!network.inventory || !chainSourceFailed(network)) return null;
  if (!edition)
    return "The indexing source is currently unavailable. Saved block evidence remains visible.";
  const passed = fullTimeLabel(network.inventory.headCheckedAt);
  const lead = chainHeadCheckFailed(network)
    ? `The indexing source did not pass its head check at the census${passed ? ` (its last passing head check was ${passed})` : ""}.`
    : network.inventory.status === "error"
      ? "The indexing source reported an error at the census."
      : "The indexing source was unavailable at the census.";
  return `${lead} ${
    network.caughtUp
      ? "The saved block range was scanned to its recorded target."
      : "Saved block evidence remains visible."
  }`;
}

/** The edition's caption for a failed network's pool inventory, or null where
 * the usual caption applies. */
export function chainSourceCaption(
  network: ChainNetwork | null,
  edition: boolean = STATIC_EDITION,
): string | null {
  if (!edition || !network?.inventory || !chainSourceFailed(network))
    return null;
  return chainHeadCheckFailed(network)
    ? "Saved inventory · head check failed at census"
    : network.inventory.status === "error"
      ? "Saved inventory · index source error at census"
      : "Saved inventory · index source unavailable at census";
}

/** What the head-check time of a network is called in the edition. After a
 * failed head check the time is that of the last check that passed. */
export function chainHeadCheckLead(
  network: ChainNetwork,
  edition: boolean = STATIC_EDITION,
): string {
  return edition && chainHeadCheckFailed(network)
    ? "Last passing head check"
    : "Chain head checked";
}

/** The same time as a term of the Data coverage list. */
export function chainHeadCheckTerm(
  network: ChainNetwork,
  edition: boolean = STATIC_EDITION,
): string {
  return edition && chainHeadCheckFailed(network)
    ? "Last passing head check"
    : "Head last checked";
}

/** A time in a tooltip. The edition keeps to UTC, the clock the snapshot keeps;
 * the visitor's own zone would disagree with the dates beside it. */
export function chainTime(
  value: string | null | undefined,
  edition: boolean = STATIC_EDITION,
): string | null {
  if (!value) return null;
  return edition ? fullTimeLabel(value) : new Date(value).toLocaleString();
}

/** The tooltip on a network's volume or reserves note. */
export function chainMeasurementTitle(
  freshness: Pick<MetricFreshness, "oldestAt">,
  edition: boolean = STATIC_EDITION,
): string {
  return freshness.oldestAt
    ? `Oldest contributing measurement: ${chainTime(freshness.oldestAt, edition) ?? "time unavailable"}`
    : "Unavailable measurements are not zero.";
}

/** The tooltip on a network's status in the ledger. */
export function chainStatusTitle(
  network: ChainNetwork,
  edition: boolean = STATIC_EDITION,
): string {
  if (network.deploymentSupport?.description)
    return network.deploymentSupport.description;
  if (!network.inventory)
    return "This network has registry records but no canonical pool index.";
  return `Scanned to block ${count(network.inventory.scannedToBlock)}. Head checked: ${chainTime(network.inventory.headCheckedAt, edition) ?? "Not checked"}.`;
}

/** What the oldest-measurement time in a readout is called. The edition shows
 * it as the oldest measurement, not as when the figure was updated. */
export function chainMeasurementLead(
  edition: boolean = STATIC_EDITION,
): string {
  return edition ? "oldest measured" : "updated";
}
