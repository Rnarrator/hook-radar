import { isAddress, ZERO_ADDRESS } from "./model.mjs";
import {
  ENVIO_QUOTE_CONFIDENCE,
  envioQuoteCoin,
} from "./market-envio-prices.mjs";

export const COINGECKO_QUOTE_ORIGIN = "https://api.coingecko.com/api/v3";
const NEGATIVE_QUOTE_TTL = 15 * 60 * 1000;
const MAX_NEGATIVE_QUOTES = 4096;
const MAX_LIVE_QUOTES = 4096;
const LIVE_QUOTE_TTL = 5 * 60 * 1000;

// Only a successful, structurally valid response which explicitly omits the
// requested token establishes absence. Errors/malformed prices are retried by
// the normal provider policy. Absence expires after 15 minutes; the next
// eligible discovery turn can retry a newly listed token.
export class CoinGeckoNegativeQuotes {
  constructor() {
    this.entries = new Map();
  }
  key(identity) {
    return `${identity.chainId}:${identity.platform}:${identity.address}`;
  }
  has(identity, now) {
    const key = this.key(identity),
      at = this.entries.get(key);
    if (at === undefined) return false;
    if (now < at || now - at >= NEGATIVE_QUOTE_TTL) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }
  observe(identity, result, now) {
    const key = this.key(identity);
    if (Object.values(result.data?.quotes || {}).length) {
      this.entries.delete(key);
      return;
    }
    const at = Date.parse(result.updatedAt);
    if (
      result.status !== "live" ||
      !result.raw ||
      typeof result.raw !== "object" ||
      Array.isArray(result.raw) ||
      Object.keys(result.raw).length !== 0 ||
      !Number.isFinite(at) ||
      at < 0 ||
      at > now ||
      now - at >= NEGATIVE_QUOTE_TTL
    )
      return;
    this.entries.delete(key);
    this.entries.set(key, at);
    while (this.entries.size > MAX_NEGATIVE_QUOTES)
      this.entries.delete(this.entries.keys().next().value);
  }
}
// Exact chain/platform/native pairs verified against /asset_platforms on 2026-10-19.
// Protocol sources for native currency identities are in market-envio-prices.mjs.
// Native substitution only applies to the zero currency, never symbol lookalikes.
const PLATFORMS = Object.freeze({
  ethereum: [1, "ethereum", "ethereum"],
  base: [8453, "base", "ethereum"],
  unichain: [130, "unichain", "ethereum"],
  arbitrum: [42161, "arbitrum-one", "ethereum"],
  optimism: [10, "optimistic-ethereum", "ethereum"],
  polygon: [137, "polygon-pos", "polygon-ecosystem-token"],
  blast: [81457, "blast", "ethereum"],
  worldchain: [480, "world-chain", "ethereum"],
  avalanche: [43114, "avalanche", "avalanche-2"],
  bnb: [56, "binance-smart-chain", "binancecoin"],
  celo: [42220, "celo", "celo"],
  zora: [7777777, "zora-network", "ethereum"],
  ink: [57073, "ink", "ethereum"],
  soneium: [1868, "soneium", "ethereum"],
  linea: [59144, "linea", "ethereum"],
  monad: [143, "monad", "monad"],
  robinhood: [4663, "robinhood", "ethereum"],
  megaeth: [4326, "megaeth", "ethereum"],
  hyperevm: [999, "hyperevm", "hyperliquid"],
  xlayer: [196, "x-layer", "okb"],
  arc: [5042, "arc", "usd-coin"],
  zksync: [324, "zksync", "ethereum"],
});

export function coinGeckoQuoteIdentity(chain, chainId, token) {
  const entry = PLATFORMS[chain];
  if (!entry || entry[0] !== chainId || !isAddress(token)) return null;
  const address = token.toLowerCase();
  if (address === ZERO_ADDRESS && !entry[2]) return null;
  return {
    chainId: entry[0],
    platform: entry[1],
    address,
    id: address === ZERO_ADDRESS ? entry[2] : address,
    native: address === ZERO_ADDRESS,
  };
}

export function coinGeckoQuoteUrl(identity, ids = [identity.id]) {
  const query = new URLSearchParams({
    [identity.native ? "ids" : "contract_addresses"]: ids.join(","),
    vs_currencies: "usd",
    include_last_updated_at: "true",
    precision: "full",
  });
  return `${COINGECKO_QUOTE_ORIGIN}/simple/${identity.native ? "price" : `token_price/${identity.platform}`}?${query}`;
}

export function validateCoinGeckoQuotes(value, requests, now) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length > 4 ||
    requests.length > 4
  )
    throw new Error("Unexpected CoinGecko quote response");
  const quotes = {};
  for (const { coin, identity } of requests) {
    const row = value[identity.id];
    if (
      !row ||
      typeof row.usd !== "number" ||
      !Number.isFinite(row.usd) ||
      row.usd <= 0 ||
      !Number.isSafeInteger(row.last_updated_at) ||
      row.last_updated_at < 0 ||
      row.last_updated_at * 1000 > now + 60000
    )
      continue;
    quotes[coin] = {
      provider: "coingecko",
      chainId: identity.chainId,
      platform: identity.platform,
      address: identity.address,
      source: coinGeckoQuoteUrl(identity),
      priceUsd: row.usd,
      updatedAt: new Date(row.last_updated_at * 1000).toISOString(),
    };
  }
  return { quotes };
}

function quoteClock(quote) {
  return Math.min(Date.parse(quote?.updatedAt), Date.parse(quote?.responseAt));
}

export function isCurrentComponentQuote(quote, now, ttlMs) {
  const clocks = [Date.parse(quote?.updatedAt), Date.parse(quote?.responseAt)];
  return (
    quote?.responseStatus === "live" &&
    typeof quote.priceUsd === "number" &&
    Number.isFinite(quote.priceUsd) &&
    quote.priceUsd > 0 &&
    (quote.provider === "coingecko" ||
      (typeof quote.confidence === "number" &&
        quote.confidence >= ENVIO_QUOTE_CONFIDENCE &&
        quote.confidence <= 1)) &&
    clocks.every(
      (at) =>
        Number.isFinite(at) && at >= 0 && at <= now + 60000 && now - at < ttlMs,
    )
  );
}

// Usable evidence and renewal eligibility are separate. Waiting until a quote
// expires before requesting its replacement guarantees a gap during paced I/O.
// The original proof stays usable through its unchanged lifetime; an optional
// refresh must still produce independently qualified, newer source evidence.
export function componentQuoteNeedsRefresh(quote, now, ttlMs) {
  return (
    !isCurrentComponentQuote(quote, now, ttlMs) ||
    now - quoteClock(quote) >= Math.min(ttlMs, LIVE_QUOTE_TTL) * 0.5
  );
}

function exactRequest(request) {
  const identity = request?.identity;
  if (!identity) return false;
  const chain = Object.keys(PLATFORMS).find(
    (name) => PLATFORMS[name][0] === identity.chainId,
  );
  const expected = coinGeckoQuoteIdentity(
    chain,
    identity.chainId,
    identity.address,
  );
  return (
    expected &&
    Object.keys(expected).every((key) => expected[key] === identity[key]) &&
    request.coin === envioQuoteCoin(chain, identity.address)
  );
}

// Process-local proof from successful live requests only. Raw SourceClient
// caches (including successful cache hits and error fallbacks) never enter this
// ledger. Reuse keeps both original clocks and still requires current exact
// pool reserves at qualification time; nothing here survives a restart.
export class CoinGeckoLiveQuotes {
  constructor() {
    this.entries = new Map();
  }
  key(identity) {
    // /simple/price identifies the native asset itself, so an exact authored
    // zero-currency mapping may share its original live proof across chains.
    // Contract prices remain chain-bound: wrapped/bridged tokens never use this.
    if (identity.native) return `native:${identity.id}`;
    return `${identity.chainId}:${identity.platform}:${identity.address}`;
  }
  get(request, now, ttlMs = LIVE_QUOTE_TTL) {
    if (!exactRequest(request)) return null;
    const key = this.key(request.identity),
      entry = this.entries.get(key);
    if (!entry) return null;
    if (
      now < entry.observedAt ||
      !isCurrentComponentQuote(
        entry.quote,
        now,
        Math.min(ttlMs, LIVE_QUOTE_TTL),
      )
    ) {
      this.entries.delete(key);
      return null;
    }
    // The stored quote retains the original response's chain binding. A native
    // read only binds that same asset-ID/source proof to the validated target
    // chain; its source URL, price and both original clocks stay unchanged.
    return {
      ...entry.quote,
      ...(request.identity.native
        ? {
            chainId: request.identity.chainId,
            platform: request.identity.platform,
            address: request.identity.address,
          }
        : {}),
    };
  }
  observe(request, result, now, ttlMs = LIVE_QUOTE_TTL) {
    if (!exactRequest(request) || result?.status !== "live") return;
    const quote = result.data?.quotes?.[request.coin],
      identity = request.identity;
    if (
      !quote ||
      quote.provider !== "coingecko" ||
      quote.chainId !== identity.chainId ||
      quote.platform !== identity.platform ||
      quote.address !== identity.address ||
      quote.source !== coinGeckoQuoteUrl(identity) ||
      (quote.responseStatus !== undefined && quote.responseStatus !== "live") ||
      (quote.responseAt !== undefined && quote.responseAt !== result.updatedAt)
    )
      return;
    const candidate = {
      ...quote,
      responseAt: result.updatedAt,
      responseStatus: "live",
    };
    if (
      !isCurrentComponentQuote(
        candidate,
        now,
        Math.min(ttlMs, LIVE_QUOTE_TTL),
      ) ||
      Date.parse(candidate.updatedAt) > now ||
      Date.parse(candidate.responseAt) > now
    )
      return;
    const previous = this.get(request, now, ttlMs);
    if (
      previous &&
      (Date.parse(previous.updatedAt) > Date.parse(candidate.updatedAt) ||
        Date.parse(previous.responseAt) > Date.parse(candidate.responseAt) ||
        (quoteClock(previous) === quoteClock(candidate) &&
          Date.parse(previous.updatedAt) >= Date.parse(candidate.updatedAt)))
    )
      return;
    const key = this.key(identity);
    this.entries.delete(key);
    this.entries.set(key, { observedAt: now, quote: Object.freeze(candidate) });
    while (this.entries.size > MAX_LIVE_QUOTES)
      this.entries.delete(this.entries.keys().next().value);
  }
}

export function reuseCoinGeckoQuotes({
  chain,
  tokens,
  original,
  liveQuotes,
  now,
  ttlMs,
}) {
  const quotes = Object.fromEntries(
    Object.entries(original?.data?.quotes || {}).map(([coin, quote]) => [
      coin,
      {
        ...quote,
        responseAt: quote.responseAt ?? original.updatedAt,
        responseStatus: quote.responseStatus ?? original.status,
      },
    ]),
  );
  for (const token of [...new Set(tokens)].slice(0, 4)) {
    const identity = coinGeckoQuoteIdentity(chain.chain, chain.chainId, token);
    const coin = envioQuoteCoin(chain.chain, token);
    if (!identity || !coin) continue;
    const retained = liveQuotes?.get({ coin, identity }, now, ttlMs);
    if (
      retained &&
      (!isCurrentComponentQuote(quotes[coin], now, ttlMs) ||
        quoteClock(retained) > quoteClock(quotes[coin]))
    )
      quotes[coin] = retained;
  }
  return {
    status: original?.status || "unavailable",
    updatedAt: original?.updatedAt || null,
    data: { quotes },
  };
}

// This supplements selected components, not a second pool-level metric feed.
// Cached responses keep their original response and provider price clocks.
export async function supplementCoinGeckoQuotes({
  chain,
  tokens,
  original,
  client,
  now,
  ttlMs,
  signal,
  canRequest = () => true,
  isRequestRelevant = () => true,
  requestDeadline = () => Infinity,
  negativeQuotes,
  liveQuotes,
}) {
  signal?.throwIfAborted();
  const {
    data: { quotes },
  } = reuseCoinGeckoQuotes({
    chain,
    tokens,
    original,
    liveQuotes,
    now: now(),
    ttlMs,
  });
  const pending = [],
    identities = new Set();
  for (const token of [...new Set(tokens)].slice(0, 4)) {
    const identity = coinGeckoQuoteIdentity(chain.chain, chain.chainId, token);
    const coin = envioQuoteCoin(chain.chain, token);
    if (!identity || !coin || identities.has(coin)) continue;
    identities.add(coin);
    const current = quotes[coin];
    pending.push({
      coin,
      identity,
      initiallyCurrent: isCurrentComponentQuote(current, now(), ttlMs),
    });
  }
  // The public keyless endpoint permits one contract address per request.
  // Keep the four-component bound, existing shared permit and per-token raw
  // cache; a rate limit or cancellation stops the remaining requests.
  // Missing components go first. Revisit initially current components after
  // those paced requests: their original clocks may have expired meanwhile.
  // Every exact identity still gets at most one request in this bounded pass.
  for (const request of pending.sort(
    (a, b) =>
      Number(a.initiallyCurrent) - Number(b.initiallyCurrent) ||
      Number(a.identity.native) - Number(b.identity.native),
  )) {
    signal?.throwIfAborted();
    if (!componentQuoteNeedsRefresh(quotes[request.coin], now(), ttlMs))
      continue;
    if (negativeQuotes?.has(request.identity, now())) continue;
    if (!canRequest()) break;
    // A previous paced request may outlive its pool evidence or reveal an
    // absent component. Skip only this token; another pool may still qualify.
    if (!isRequestRelevant(request, quotes)) continue;
    const deadline = requestDeadline(request, quotes);
    if (
      deadline !== Infinity &&
      (!Number.isFinite(deadline) || deadline <= now())
    )
      continue;
    // This signal belongs only to this consumer. Its deadline starts before
    // cache lookup and provider pacing, so an expired pool cannot dispatch a
    // new request after waiting for a permit. A useful younger same-token pool
    // can supply a later deadline; the caller still owns the global signal.
    const deadlineController = Number.isFinite(deadline)
      ? new AbortController()
      : null;
    const timer = deadlineController
      ? setTimeout(
          () => deadlineController.abort(),
          Math.max(1, Math.ceil(deadline - now())),
        )
      : null;
    const requestSignal = deadlineController
      ? signal
        ? AbortSignal.any([signal, deadlineController.signal])
        : deadlineController.signal
      : signal;
    const { identity } = request;
    const url = coinGeckoQuoteUrl(identity);
    let result;
    try {
      result = await client.fetchJson(
        `market-coingecko-quotes-${identity.native ? "native" : chain.chain}-${identity.id}`,
        url,
        {
          ttlMs: 60000,
          timeoutMs: 20000,
          maxBytes: 64 * 1024,
          respectResponseAge: true,
          signal: requestSignal,
          validate: (value) => validateCoinGeckoQuotes(value, [request], now()),
        },
      );
    } catch (error) {
      if (deadlineController?.signal.aborted && !signal?.aborted) continue;
      throw error;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
    signal?.throwIfAborted();
    if (deadlineController?.signal.aborted || now() >= deadline) continue;
    negativeQuotes?.observe(identity, result, now());
    liveQuotes?.observe(request, result, now(), ttlMs);
    for (const [coin, quote] of Object.entries(result.data?.quotes || {})) {
      const old = quotes[coin];
      const candidate = {
        ...quote,
        responseAt: result.updatedAt,
        responseStatus: result.status,
      };
      const current = isCurrentComponentQuote(candidate, now(), ttlMs);
      const oldCurrent = isCurrentComponentQuote(old, now(), ttlMs);
      if (
        (oldCurrent && !current) ||
        (oldCurrent &&
          (Date.parse(candidate.updatedAt) < Date.parse(old.updatedAt) ||
            Date.parse(candidate.responseAt) < Date.parse(old.responseAt))) ||
        (old &&
          Date.parse(old.updatedAt) >= Date.parse(quote.updatedAt) &&
          !(current && !oldCurrent))
      )
        continue;
      quotes[coin] = candidate;
    }
  }
  return {
    status: original?.status || "unavailable",
    updatedAt: original?.updatedAt || null,
    data: { quotes },
  };
}
