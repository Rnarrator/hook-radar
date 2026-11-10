/** The response public/early-discovery.js started before the bundle loaded. */
interface EarlyDiscovery {
  url: string;
  at: number;
  response: Promise<Response>;
}

export interface EarlyDiscoveryHolder {
  __radarEarlyDiscovery?: EarlyDiscovery;
}

/** Older than this and the page is asked again: it may have waited behind a
 * startup check, and a discovery page is only ever shown fresh. */
export const EARLY_DISCOVERY_MAX_AGE_MS = 15_000;

/**
 * The early response for exactly this request, once, or null. A different URL,
 * an aged response, a failed request or a second ask all return null, and the
 * caller makes its own request.
 */
export async function takeEarlyDiscovery(
  url: string,
  holder: EarlyDiscoveryHolder = window as unknown as EarlyDiscoveryHolder,
  now: number = Date.now(),
): Promise<Response | null> {
  const early = holder.__radarEarlyDiscovery;
  if (!early) return null;
  delete holder.__radarEarlyDiscovery;
  if (early.url !== url || now - early.at > EARLY_DISCOVERY_MAX_AGE_MS)
    return null;
  try {
    return await early.response;
  } catch {
    return null;
  }
}
