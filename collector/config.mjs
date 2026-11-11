// Every limit and gap of the Auto Snapshot collector. The values are the
// contract of the edition's design (the live project's design contract, which
// is not part of this repository); environment overrides may only make the
// collector slower or smaller, never faster or larger.

export const COLLECTOR_VERSION = "1.0.0";
export const PROJECT_NAME = "HookRadarAutoSnapshot";

// Minimum time between the starts of two requests to the same provider.
export const DS_GAP_MS = 400;
export const GT_GAP_MS = 12000;
export const V4_GAP_MS = 5000;
export const REGISTRY_GAP_MS = 1000;

export const DS_BATCH_SIZE = 30;
export const GT_FALLBACK_BATCH_SIZE = 30;
// The pools of the launchpad platforms and named projects (the priority list)
// that DEX Screener returns nothing for come first, and DEX Screener does not
// index Zora or X Layer at all, so the fallback is six requests (180 pools)
// where it was three. Each takes 12 s, so the six end 72 s after the DEX
// Screener batches do, inside the burst's own deadline.
export const GT_FALLBACK_MAX_REQUESTS = 6;
export const GT_DISCOVERY_PAGE_CYCLE = 5;
// Pools with identity verified by the live app's census (the seed) are measured
// first, up to MAX_MEASURED_POOLS. Pools found by discovery are measured on top
// of them, up to MAX_DISCOVERED_MEASURED, so a discovery can never push a seeded
// pool out of the burst. The whole plan stays inside the 399-request budget.
export const MAX_MEASURED_POOLS = 8000;
export const MAX_DISCOVERED_MEASURED = 500;
// The priority list (state/priority.json): pools of the exact published hooks of
// launchpad platforms and of named projects, chosen once from the live app's
// data. They are always in the measurement plan, ahead of the other seeded
// pools, and they take their places inside MAX_MEASURED_POOLS: the plan is no
// larger and the requests are no more. The list may not hold more than this.
export const MAX_PRIORITY_POOLS = 1500;
export const MAX_RESOLVES_PER_RUN = 40;
export const STATE_MAX_POOLS = 12000;
export const MAX_REQUESTS_PER_RUN = 399;

// Measurements are taken in one burst. No new DEX Screener batch starts after
// BURST_BUDGET_MS and no request of any kind after BURST_DEADLINE_MS. The limit
// is on the moment a request would start, a wait for the provider's gap or its
// Retry-After included, so a stalled provider cannot stretch the burst past the
// five-minute freshness window of the snapshot time (MARKET_MAX_AGE_MS in
// shared/market-freshness.ts is 300000). MIN_CURRENT_SHARE checks the result.
export const BURST_BUDGET_MS = 225000;
export const BURST_DEADLINE_MS = 270000;

// Discovery is slow on purpose (12 s and 5 s gaps), so it gets its own limit: no
// discovery request starts later than this after the run began, a wait for the
// provider's gap or a Retry-After included. At full size discovery (20 pages, 20
// lists, 40 lookups) took about ten minutes in the real run of 28 October 2026,
// so the limit leaves it half as long again; what it cuts is read again by the
// next run. It keeps a provider that sends a Retry-After on every answer from
// stretching the run towards the job's 45 minutes: the burst that follows needs
// under five more.
export const DISCOVERY_BUDGET_MS = 900000;

export const MIN_CURRENT_POOLS = 500;
export const MIN_REQUESTED_SHARE = 0.8;
// Of the pools that carry a measurement, at least this share must be current at
// the snapshot time. A stalled burst or a provider serving old cached copies
// would otherwise publish a snapshot whose totals leave many pools out.
export const MIN_CURRENT_SHARE = 0.9;
// A sample that is far smaller than the one before it is not recorded as if it
// were a collapse in volume. The share compares the pools that carry a current
// 24h volume with those behind the previous history point, when that point is
// recent enough to be the same sample; a point older than the age limit is not
// compared, so a genuinely smaller sample can hold the site back for a day at most.
export const MIN_VOLUME_POOLS_OF_PREVIOUS = 0.6;
export const PREVIOUS_POINT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Uniswap v4 marks a dynamic-fee pool by setting this bit in the fee it is
// initialised with (the same value server/census-hook-directory.mjs tests).
export const DYNAMIC_FEE_FLAG = 0x800000;
export const HISTORY_MAX_POINTS = 672;
export const HISTORY_MIN_SPACING_MS = 300000;
// A pool's lastSeen moves at most once a day so the committed state stays quiet.
export const LAST_SEEN_GRANULARITY_MS = 24 * 60 * 60 * 1000;

export const REQUEST_TIMEOUT_MS = 20000;
export const MAX_RETRY_AFTER_MS = 120000;
export const MAX_CONSECUTIVE_FAILURES = 5;

// After a first HTTP 429 that says how long to wait (a Retry-After header, or
// Cloudflare's "error code: 1015" page) a provider gets one cooldown per run:
// the collector waits the stated time, at most RATE_LIMIT_WAIT_CAP_MS, and sends
// the refused request once more. With no stated time it waits
// RATE_LIMIT_DEFAULT_WAIT_MS. The provider's gap then doubles for the rest of the
// run. A second 429, a wait over the cap, a wait that would end after the time
// allowed for the phase, or a spent request budget stops the provider.
export const RATE_LIMIT_WAIT_CAP_MS = 90000;
export const RATE_LIMIT_DEFAULT_WAIT_MS = 30000;
// The providers the cooldown applies to: the ones whose source notes record it.
export const COOLDOWN_PROVIDERS = Object.freeze([
  "dexscreener",
  "geckoterminal",
  "v4xyz",
]);

// Frontier's own market figures for the pools it launches (the live app reads
// them the same way): one coin listing, one statistics answer for the ETH/USD
// rate and one query to the public AMM index Frontier's configuration names.
// That is three requests, and the plan's request reserve keeps room for them.
export const FRONTIER_MAX_REQUESTS = 3;
// The step runs after the DEX Screener burst and its fallback, and the snapshot
// time is taken after it, so the pools measured first must still be inside the
// five-minute window when it ends. It reads the listing and the statistics one
// after the other (10 s each at most, one second apart) and then the index
// (15 s at most): 36 s in the worst case. It does not start later than this
// after the burst began, which keeps even that case under 300 s.
export const FRONTIER_LATEST_START_MS = 240000;

export const MAX_BYTES = Object.freeze({
  registry: 24 * 1024 * 1024,
  frontier: 2 * 1024 * 1024,
  // coinsPage?limit=100 is about 100 KB; the index answer holds at most 1,000
  // swaps and the day rows of the listed pools, about 0.3 MB.
  frontierMarkets: 2 * 1024 * 1024,
  frontierIndex: 1024 * 1024,
  dexscreener: 4 * 1024 * 1024,
  geckoterminal: 4 * 1024 * 1024,
  v4xyzList: 2 * 1024 * 1024,
  v4xyzDetail: 256 * 1024,
});
// A POST body (the one index query) is small; the client refuses a larger one.
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;

export const PROVIDERS = Object.freeze({
  dexscreener: {
    id: "dexscreener",
    name: "DEX Screener",
    host: "api.dexscreener.com",
    url: "https://docs.dexscreener.com/api/reference",
  },
  geckoterminal: {
    id: "geckoterminal",
    name: "GeckoTerminal",
    host: "api.geckoterminal.com",
    url: "https://www.geckoterminal.com",
  },
  v4xyz: {
    id: "v4xyz",
    name: "v4.xyz indexer",
    host: "www.v4.xyz",
    url: "https://www.v4.xyz",
  },
  registry: {
    id: "registry",
    name: "Uniswap hooklist",
    host: "raw.githubusercontent.com",
    url: "https://github.com/Uniswap/hooklist",
  },
  frontier: {
    id: "frontier",
    name: "Frontier",
    host: "api.frontier.fun",
    url: "https://api.frontier.fun/chains",
  },
  // The public AMM index that Frontier's own configuration (api.frontier.fun
  // /chains, subgraphs.ammV4) names. One POST per run; no key is involved.
  goldsky: {
    id: "goldsky",
    name: "Goldsky (Frontier AMM index)",
    host: "api.goldsky.com",
    url: "https://goldsky.com",
  },
});

const raise = (contract, requested) => {
  const value = Number(requested);
  return Number.isFinite(value) && value > contract
    ? Math.ceil(value)
    : contract;
};

/** Contract gaps, raised (never lowered) by COLLECTOR_*_GAP_MS variables. */
export function resolveGaps(env = process.env) {
  return Object.freeze({
    dexscreener: raise(DS_GAP_MS, env.COLLECTOR_DS_GAP_MS),
    geckoterminal: raise(GT_GAP_MS, env.COLLECTOR_GT_GAP_MS),
    v4xyz: raise(V4_GAP_MS, env.COLLECTOR_V4_GAP_MS),
    registry: REGISTRY_GAP_MS,
    frontier: REGISTRY_GAP_MS,
    goldsky: REGISTRY_GAP_MS,
  });
}

/** The longest rate-limit wait: COLLECTOR_RETRY_AFTER_CAP_MS can lower it and
 * never raise it. 0 turns the cooldown off: a 429 then stops the provider. */
export function resolveRateLimitCap(env = process.env) {
  const requested = Number(env.COLLECTOR_RETRY_AFTER_CAP_MS);
  return env.COLLECTOR_RETRY_AFTER_CAP_MS?.trim() &&
    Number.isFinite(requested) &&
    requested >= 0 &&
    requested < RATE_LIMIT_WAIT_CAP_MS
    ? Math.floor(requested)
    : RATE_LIMIT_WAIT_CAP_MS;
}

/** The repository named in the User-Agent. Absent or malformed means a local run. */
export function userAgent(env = process.env) {
  const repository = env.GITHUB_REPOSITORY;
  return /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/.test(repository || "")
    ? `${PROJECT_NAME}/${COLLECTOR_VERSION} (+https://github.com/${repository})`
    : `${PROJECT_NAME}/${COLLECTOR_VERSION} (local run; no repository configured)`;
}
