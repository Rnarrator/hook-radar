import type { ChainProtocol } from "./chains.ts";

export type ChainCatalogSort =
  "volume" | "reserves" | "hooks" | "pools" | "name";
export const CHAIN_CATALOG_PAGE_SIZE = 12;

function measurement(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 ? value : null;
}

/** A pool confirms usage, but does not fill absent deployment metadata. */
export function catalogHookCount(row: ChainProtocol): number | null {
  // A reviewed platform's count is the hooks its own sources publish; any other
  // platform listing carries identity only.
  if (row.project.entityType === "platform")
    return row.attribution && row.attribution.mappedHooks > 0
      ? row.attribution.mappedHooks
      : null;
  return row.hookCount === 0 && row.poolCount !== null && row.poolCount > 0
    ? null
    : measurement(row.hookCount);
}

function descending(left: number | null, right: number | null) {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return right - left;
}

/** Sorting only uses the freshness-filtered chain model, never raw pool USD. */
export function sortChainCatalog(
  rows: readonly ChainProtocol[],
  sort: ChainCatalogSort = "volume",
): ChainProtocol[] {
  const value = (row: ChainProtocol) => {
    if (sort === "reserves") return measurement(row.liquidityUsd);
    if (sort === "pools") return measurement(row.poolCount);
    if (sort === "hooks") return catalogHookCount(row);
    return measurement(row.volumeUsd);
  };
  return [...rows].sort(
    (left, right) =>
      (sort === "name" ? 0 : descending(value(left), value(right))) ||
      left.project.name.localeCompare(right.project.name) ||
      left.project.id.localeCompare(right.project.id),
  );
}

export function chainCatalogPage(length: number, requestedPage: number) {
  const pages = Math.max(1, Math.ceil(length / CHAIN_CATALOG_PAGE_SIZE));
  const page = Math.max(0, Math.min(pages - 1, Math.floor(requestedPage) || 0));
  return {
    page,
    pages,
    start: page * CHAIN_CATALOG_PAGE_SIZE,
    end: Math.min(length, (page + 1) * CHAIN_CATALOG_PAGE_SIZE),
  };
}

/** Move one project to the front of an already ordered list, leaving every
 * other row in its order. Used for the single pinned launchpad: the pin is a
 * labelled editorial placement, never a rank. Absent or already first: no change. */
export function pinChainProtocol(
  rows: readonly ChainProtocol[],
  id: string,
): ChainProtocol[] {
  const index = rows.findIndex((row) => row.project.id === id);
  return index > 0
    ? [rows[index], ...rows.slice(0, index), ...rows.slice(index + 1)]
    : [...rows];
}
