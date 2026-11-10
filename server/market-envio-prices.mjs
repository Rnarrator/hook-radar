import { digest, isAddress, ZERO_ADDRESS } from "./model.mjs";

export const ENVIO_QUOTE_ORIGIN = "https://coins.llama.fi";
export const ENVIO_QUOTE_CONFIDENCE = 0.99;
const ETH_NETWORKS = new Set([
  "ethereum",
  "base",
  "unichain",
  "arbitrum",
  "optimism",
  "blast",
  "worldchain",
  "zora",
  "ink",
  "soneium",
  "linea",
  "megaeth",
  "zksync",
  // https://docs.robinhood.com/chain/connecting/ identifies4663 native ETH.
  "robinhood",
]);
const NAMESPACES = { bnb: "bsc", avalanche: "avax" };
// Zero currency is the native asset; nonzero contracts retain their identities.
// POL/137: https://docs.polygon.technology/tools/dApp-development/common-tools/remix/
// MON/143: https://docs.monad.xyz/ai/current-facts
// BNB/56: https://docs.bnbchain.org/bnb-smart-chain/developers/wallet-configuration/
// AVAX/43114: https://build.avax.network/docs/primary-network
// CELO/42220: https://docs.celo.org/learn
// OKB/196: https://web3.okx.com/onchainos/dev-docs/xlayer/developer/build-on-xlayer/network-information
// USDC/5042: https://docs.arc.io/arc/references/connect-to-arc
// Coin IDs match /api/v3/asset_platforms native_coin_id, verified 2026-10-19.
// Arc still requires a timestamped USDC quote; no native asset has a fixed price.
const NATIVE_COINS = new Map([
  ["hyperevm", "hyperliquid"],
  ["polygon", "polygon-ecosystem-token"],
  ["monad", "monad"],
  ["bnb", "binancecoin"],
  ["avalanche", "avalanche-2"],
  ["celo", "celo"],
  ["xlayer", "okb"],
  ["arc", "usd-coin"],
]);
const finite = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const decimal = (value) =>
  typeof value === "string" &&
  /^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value) &&
  finite(Number(value)) &&
  (Number(value) !== 0 || /^0+(?:\.0+)?(?:e[+-]?\d+)?$/i.test(value))
    ? Number(value)
    : null;

export function envioQuoteCoin(chain, token) {
  if (!isAddress(token)) return null;
  const address = token.toLowerCase();
  if (address === ZERO_ADDRESS) {
    const native = ETH_NETWORKS.has(chain)
      ? "ethereum"
      : NATIVE_COINS.get(chain);
    return native ? `coingecko:${native}` : null;
  }
  return `${NAMESPACES[chain] || chain}:${address}`;
}

export function validateEnvioDetail(value, chain, row) {
  if (!Array.isArray(value?.Pool) || value.Pool.length !== 1)
    throw new Error("Exact pool reserve components are unavailable");
  const data = value.Pool[0];
  const prefix = `${chain.chainId}_`;
  if (
    typeof data?.id !== "string" ||
    data.id.toLowerCase() !== `${prefix}${row.address}` ||
    data.chainId !== String(chain.chainId) ||
    typeof data.hooks !== "string" ||
    data.hooks.toLowerCase() !== row.hookAddress ||
    !row.tokens.every(
      (token, index) =>
        typeof data[`token${index}`] === "string" &&
        data[`token${index}`].toLowerCase() === `${prefix}${token}`,
    )
  )
    throw new Error(
      "Reserve component identity does not match the canonical pool",
    );
  const balances = [
    decimal(data.totalValueLockedToken0),
    decimal(data.totalValueLockedToken1),
  ];
  if (balances.some((v) => v === null))
    throw new Error("Complete nonnegative reserve components are unavailable");
  return { balances };
}

export function validateEnvioQuotes(value, coins, now) {
  if (
    !value?.coins ||
    typeof value.coins !== "object" ||
    Array.isArray(value.coins) ||
    Object.keys(value.coins).length > 4
  )
    throw new Error("Unexpected token quote response");
  const quotes = {};
  for (const coin of coins) {
    const row = value.coins[coin];
    if (
      !row ||
      !finite(row.price) ||
      row.price <= 0 ||
      !finite(row.confidence) ||
      row.confidence < ENVIO_QUOTE_CONFIDENCE ||
      row.confidence > 1 ||
      !Number.isSafeInteger(row.timestamp) ||
      row.timestamp < 0 ||
      row.timestamp * 1000 > now + 60000
    )
      continue;
    quotes[coin] = {
      priceUsd: row.price,
      confidence: row.confidence,
      updatedAt: new Date(row.timestamp * 1000).toISOString(),
    };
  }
  return { quotes };
}

const MAX_LIVE_QUOTES = 4096;
const MAX_REUSE_AGE_MS = 60000;
const MAX_QUOTE_AGE_MS = 300000;
const quoteKey = (coin) =>
  typeof coin === "string" &&
  /^(?:coingecko:[a-z0-9-]+|[a-z0-9-]+:0x[0-9a-f]{40})$/.test(coin);
const quoteClock = (quote) =>
  Math.min(Date.parse(quote?.updatedAt), Date.parse(quote?.responseAt));

// Reuse only successful live, validated component proof, never disk fallback.
// Exact provider namespaces keep equal-address tokens on different chains
// separate; authored native coin IDs may share the same original quote.
// The one-minute reuse bound saves duplicate requests without deferring an
// ordinary half-TTL renewal. Both source clocks survive unchanged.
export class EnvioLiveQuotes {
  constructor() {
    this.entries = new Map();
  }
  get(coin, now, ttlMs = MAX_QUOTE_AGE_MS) {
    if (
      !quoteKey(coin) ||
      !Number.isFinite(now) ||
      !Number.isFinite(ttlMs) ||
      ttlMs <= 0
    )
      return null;
    const entry = this.entries.get(coin);
    if (!entry) return null;
    if (
      now < entry.observedAt ||
      now - entry.observedAt >= MAX_REUSE_AGE_MS ||
      now - Date.parse(entry.quote.responseAt) >= MAX_REUSE_AGE_MS ||
      now - quoteClock(entry.quote) >= Math.min(ttlMs, MAX_QUOTE_AGE_MS)
    ) {
      this.entries.delete(coin);
      return null;
    }
    return { ...entry.quote };
  }
  observe(coins, result, now, ttlMs = MAX_QUOTE_AGE_MS) {
    if (
      result?.status !== "live" ||
      !Number.isFinite(now) ||
      !Number.isFinite(ttlMs) ||
      ttlMs <= 0
    )
      return;
    for (const coin of [...new Set(coins)].slice(0, 4)) {
      if (!quoteKey(coin)) continue;
      const quote = result.data?.quotes?.[coin];
      const clocks = [quote?.updatedAt, result.updatedAt].map(Date.parse);
      const source = `${ENVIO_QUOTE_ORIGIN}/prices/current/${coin}`;
      if (
        !quote ||
        !finite(quote.priceUsd) ||
        quote.priceUsd <= 0 ||
        !finite(quote.confidence) ||
        quote.confidence < ENVIO_QUOTE_CONFIDENCE ||
        quote.confidence > 1 ||
        quote.provider !== undefined ||
        (quote.source !== undefined && quote.source !== source) ||
        (quote.responseStatus !== undefined &&
          quote.responseStatus !== "live") ||
        (quote.responseAt !== undefined &&
          quote.responseAt !== result.updatedAt) ||
        clocks.some(
          (at) =>
            !Number.isFinite(at) ||
            at < 0 ||
            at > now ||
            now - at >= Math.min(ttlMs, MAX_QUOTE_AGE_MS),
        )
      )
        continue;
      const candidate = {
        priceUsd: quote.priceUsd,
        confidence: quote.confidence,
        updatedAt: quote.updatedAt,
        responseAt: result.updatedAt,
        responseStatus: "live",
        source,
      };
      const previous = this.get(coin, now, ttlMs);
      if (
        previous &&
        (Date.parse(previous.updatedAt) > Date.parse(candidate.updatedAt) ||
          Date.parse(previous.responseAt) > Date.parse(candidate.responseAt) ||
          (quoteClock(previous) === quoteClock(candidate) &&
            Date.parse(previous.updatedAt) >= Date.parse(candidate.updatedAt)))
      )
        continue;
      this.entries.delete(coin);
      this.entries.set(coin, {
        observedAt: now,
        quote: Object.freeze(candidate),
      });
      while (this.entries.size > MAX_LIVE_QUOTES)
        this.entries.delete(this.entries.keys().next().value);
    }
  }
}

// At most four positive-balance components enter one ordinary Envio turn.
// Missing components still use the existing shared provider permit. Cached
// source responses keep their status and cannot populate the live ledger.
export async function collectEnvioQuotes({
  coins,
  liveQuotes,
  client,
  now,
  ttlMs,
  signal,
}) {
  signal?.throwIfAborted();
  const requested = [...new Set(coins)];
  if (!requested.length) return { quoteResult: null, sourceResult: null };
  if (requested.length > 4 || requested.some((coin) => !quoteKey(coin)))
    throw new Error("Invalid exact component quote identity");
  const startedAt = now();
  const initial = new Map(
    requested.map((coin) => [coin, liveQuotes.get(coin, startedAt, ttlMs)]),
  );
  const missing = requested.filter((coin) => !initial.get(coin));
  const sourceResult = missing.length
    ? await client.fetchJson(
        `market-envio-quotes-${digest(missing.slice().sort())}`,
        `${ENVIO_QUOTE_ORIGIN}/prices/current/${missing.join(",")}`,
        {
          ttlMs: 0,
          timeoutMs: 15000,
          maxBytes: 256 * 1024,
          respectResponseAge: true,
          signal,
          validate: (value) => validateEnvioQuotes(value, missing, now()),
        },
      )
    : null;
  signal?.throwIfAborted();
  if (sourceResult) liveQuotes.observe(missing, sourceResult, now(), ttlMs);
  const quotes = {};
  for (const coin of requested) {
    const currentTime = now();
    const retained =
      liveQuotes.get(coin, currentTime, ttlMs) || initial.get(coin);
    const fetched = sourceResult?.data?.quotes?.[coin];
    // The reuse admission window may end while a missing sibling is fetched.
    // Proof already selected for this turn remains usable only while both
    // original clocks meet the unchanged metric lifetime; it is never re-aged.
    if (
      retained &&
      currentTime >= startedAt &&
      [retained.updatedAt, retained.responseAt].every((clock) => {
        const value = Date.parse(clock);
        return (
          value <= currentTime &&
          currentTime - value < Math.min(ttlMs, MAX_QUOTE_AGE_MS)
        );
      })
    )
      quotes[coin] = retained;
    else if (fetched)
      quotes[coin] = {
        ...fetched,
        responseAt: sourceResult.updatedAt,
        responseStatus: sourceResult.status,
      };
  }
  return {
    sourceResult,
    quoteResult: {
      // Component clocks/status carry their own proof. There is no new
      // collective observation timestamp when this turn needed no HTTP.
      status: sourceResult?.status || "unavailable",
      updatedAt: sourceResult?.updatedAt || null,
      data: { quotes },
    },
  };
}
