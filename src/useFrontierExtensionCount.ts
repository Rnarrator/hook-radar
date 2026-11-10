import { useEffect, useState } from "react";
import { isFrontierExtensionsResponse, summarizeExtensionCatalog } from "./extensions";
import type { ExtensionCatalogSummary } from "./extensions";

const FRESH_MS = 10 * 60 * 1000;
const RETRY_MS = 60 * 1000;
let known: { value: ExtensionCatalogSummary; at: number } | null = null;
let failedAt = 0;
let inflight: Promise<ExtensionCatalogSummary | null> | null = null;
const listeners = new Set<(value: ExtensionCatalogSummary) => void>();

const fresh = () =>
  known && Date.now() - known.at < FRESH_MS ? known.value : null;

/** Keep a catalog size that some other part of the app has just read from the
 * service (for example the extension explorer), so no second request is made. */
export function rememberFrontierExtensionCount(
  summary: ExtensionCatalogSummary | null,
) {
  if (!summary) return;
  known = { value: summary, at: Date.now() };
  for (const listener of listeners) listener(summary);
}

/** Ask the service for Frontier's extension catalog through one of its hooks
 * (the catalog is the same for every hook; a hook the catalog does not
 * confirm is refused, so the next address is tried). */
async function load(
  addresses: readonly string[],
): Promise<ExtensionCatalogSummary | null> {
  for (const address of addresses) {
    try {
      const response = await fetch(
        `/api/projects/frontier/extensions?hook=${encodeURIComponent(address)}`,
      );
      if (!response.ok) continue;
      const value: unknown = await response.json();
      if (!isFrontierExtensionsResponse(value, address, null)) continue;
      return summarizeExtensionCatalog(value);
    } catch {
      // Unreachable or malformed: leave the count out rather than guess.
    }
  }
  return null;
}

/** How many extension modules Frontier publishes, for display next to its hook
 * count. It reads only Frontier's own catalog: nothing is shown until the
 * service has answered, and nothing is invented if it cannot. With `fetchIt`
 * false it only reuses a count another part of the app has already read, so it
 * never asks the service itself (no reads while saved data is being verified,
 * and opening a drawer alone makes no extra request). */
export function useFrontierExtensionCount(
  addresses: readonly string[],
  fetchIt = true,
): ExtensionCatalogSummary | null {
  const key = addresses.join(",");
  const [value, setValue] = useState<ExtensionCatalogSummary | null>(fresh);
  useEffect(() => {
    listeners.add(setValue);
    return () => {
      listeners.delete(setValue);
    };
  }, []);
  useEffect(() => {
    const current = fresh();
    if (current) setValue(current);
    if (!fetchIt || !key || current) return;
    if (Date.now() - failedAt < RETRY_MS) return;
    inflight ??= load(key.split(",")).finally(() => {
      inflight = null;
    });
    void inflight.then((summary) => {
      if (summary) rememberFrontierExtensionCount(summary);
      else failedAt = Date.now();
    });
  }, [key, fetchIt]);
  return key ? value : null;
}
