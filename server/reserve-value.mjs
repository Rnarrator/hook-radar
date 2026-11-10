import {
  envioQuoteCoin,
  ENVIO_QUOTE_CONFIDENCE,
  ENVIO_QUOTE_ORIGIN,
} from "./market-envio-prices.mjs";
import { isAddress } from "./model.mjs";
import {
  coinGeckoQuoteIdentity,
  coinGeckoQuoteUrl,
} from "./market-coingecko-prices.mjs";
export const RESERVE_EVIDENCE_VERSION = 1;
export const ENVIO_RESERVE_EVIDENCE_VERSION = 1;
const COMPOSITION_KEYS = [
  "baseBalance",
  "quoteBalance",
  "basePriceUsd",
  "quotePriceUsd",
  "baseReserveUsd",
  "quoteReserveUsd",
];
const amount = (value) => {
  if (
    typeof value !== "number" &&
    (typeof value !== "string" ||
      !/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value.trim()))
  )
    return null;
  const result = Number(value);
  if (
    result === 0 &&
    typeof value === "string" &&
    !/^0+(?:\.0+)?(?:e[+-]?\d+)?$/i.test(value.trim())
  )
    return null;
  return Number.isFinite(result) && result >= 0 ? result : null;
};
const closeValuation = (left, right) =>
  Number.isFinite(left) &&
  Number.isFinite(right) &&
  Math.abs(left - right) <=
    Math.max(0.02, Math.max(Math.abs(left), Math.abs(right)) * 0.01);

/** The public Envio list reports stored USD totals without component quote
 * clocks. A fresh indexed block cannot refresh those prices. Preserve the raw
 * observation for inspection, but never count it as qualified current USD. */
export function assessEnvioLiquidity(pool, now = Date.now()) {
  const previous = pool?.liquidityEvidence;
  const reportedUsd = amount(
    previous?.provider === "envio" &&
      previous?.version === ENVIO_RESERVE_EVIDENCE_VERSION
      ? previous.reportedUsd
      : pool?.liquidityUsd,
  );
  if (
    previous?.provider === "envio" &&
    previous.version === ENVIO_RESERVE_EVIDENCE_VERSION &&
    previous.qualification === "component-quotes" &&
    Array.isArray(previous.components) &&
    previous.components.length === 2 &&
    Array.isArray(pool.tokens) &&
    pool.tokens.length === 2 &&
    pool.tokens.every(isAddress) &&
    typeof pool.tokens[0] === "string" &&
    typeof pool.tokens[1] === "string" &&
    pool.tokens[0].toLowerCase() !== pool.tokens[1].toLowerCase()
  ) {
    let sum = 0;
    const clocks = [
      previous.indexObservedAt,
      previous.balanceObservedAt,
      previous.quoteResponseAt,
    ].map(Date.parse);
    const valid = previous.components.every((component, index) => {
      if (
        component?.token !== pool.tokens[index] ||
        typeof component.balance !== "number" ||
        !Number.isFinite(component.balance) ||
        component.balance < 0
      )
        return false;
      if (component.balance === 0) return true;
      const coin = envioQuoteCoin(pool.chain, component.token);
      const cg =
        component.quoteProvider === "coingecko"
          ? coinGeckoQuoteIdentity(
              pool.chain,
              component.quoteChainId,
              component.token,
            )
          : null;
      const sourceValid =
        component.quoteProvider === "coingecko"
          ? cg &&
            (pool.chainId === undefined || pool.chainId === cg.chainId) &&
            component.quotePlatform === cg.platform &&
            component.quoteAddress === cg.address &&
            component.source === coinGeckoQuoteUrl(cg) &&
            component.confidence === undefined
          : component.quoteProvider === undefined &&
            component.source ===
              `${ENVIO_QUOTE_ORIGIN}/prices/current/${coin}` &&
            typeof component.confidence === "number" &&
            Number.isFinite(component.confidence) &&
            component.confidence >= ENVIO_QUOTE_CONFIDENCE &&
            component.confidence <= 1;
      if (
        !coin ||
        component.coin !== coin ||
        !sourceValid ||
        typeof component.priceUsd !== "number" ||
        !Number.isFinite(component.priceUsd) ||
        component.priceUsd <= 0
      )
        return false;
      clocks.push(Date.parse(component.quoteUpdatedAt));
      if (component.quoteResponseAt !== undefined)
        clocks.push(Date.parse(component.quoteResponseAt));
      else if (component.quoteProvider === "coingecko") return false;
      const componentUsd = component.balance * component.priceUsd;
      if (!Number.isFinite(componentUsd) || componentUsd === 0) return false;
      sum += componentUsd;
      return Number.isFinite(sum);
    });
    const at = Date.parse(pool.metricUpdatedAt);
    if (
      valid &&
      sum > 0 &&
      clocks.every(
        (clock) => Number.isFinite(clock) && clock >= 0 && clock <= now + 60000,
      ) &&
      at === Math.min(...clocks)
    )
      return {
        liquidityUsd: sum,
        liquidityStatus: "reported",
        liquidityNote: `Indexer-reported token balances valued with complete timestamped ${[...new Set(previous.components.filter((component) => component.balance > 0).map((component) => (component.quoteProvider === "coingecko" ? "CoinGecko" : "DefiLlama")))].join(" / ")} quotes. Both token components are included once; stored USD totals are excluded. Indexer accounting may omit donations. This is not independently verified TVL or executable swap depth.`,
        liquidityEvidence: previous,
        volumeUsd: Object.freeze({ h1: null, h6: null, h24: null }),
      };
  }
  return {
    liquidityUsd: null,
    liquidityStatus: "unverified",
    liquidityNote:
      "Reserve valuation withheld: the indexer’s stored USD total has no complete token-balance and timestamped USD-quote evidence. A recent indexed block does not refresh its token prices. Rolling volume is unavailable.",
    liquidityEvidence: Object.freeze({
      version: ENVIO_RESERVE_EVIDENCE_VERSION,
      provider: "envio",
      qualification: "missing-component-quotes",
      reportedUsd,
    }),
    volumeUsd: Object.freeze({ h1: null, h6: null, h24: null }),
  };
}

function assessReserveEvidence(input) {
  const evidence = Object.freeze({
    version: RESERVE_EVIDENCE_VERSION,
    provider: "geckoterminal",
    reportedUsd: amount(input?.reportedUsd),
    ...Object.fromEntries(
      COMPOSITION_KEYS.map((key) => [key, amount(input?.[key])]),
    ),
  });
  let liquidityUsd = evidence.reportedUsd;
  let liquidityStatus = "reported";
  let liquidityNote =
    "Provider-reported reserve valuation; source composition arithmetic checked. This is not independently verified TVL or executable swap depth.";
  const contradictions = [];
  let componentUnderflow = false;
  if (
    evidence.reportedUsd !== null &&
    evidence.baseReserveUsd !== null &&
    evidence.quoteReserveUsd !== null &&
    !closeValuation(
      evidence.reportedUsd,
      evidence.baseReserveUsd + evidence.quoteReserveUsd,
    )
  )
    contradictions.push(
      "reported total does not match token component valuations",
    );
  for (const side of ["base", "quote"]) {
    const balance = evidence[`${side}Balance`],
      price = evidence[`${side}PriceUsd`],
      reserve = evidence[`${side}ReserveUsd`];
    if (balance > 0 && price > 0 && balance * price === 0) {
      componentUnderflow = true;
      continue;
    }
    if (
      balance !== null &&
      price !== null &&
      reserve !== null &&
      !closeValuation(balance * price, reserve)
    )
      contradictions.push(
        `${side} token balance × USD price does not match its component valuation`,
      );
  }
  if (contradictions.length) {
    liquidityUsd = null;
    liquidityStatus = "inconsistent";
    liquidityNote = `Reserve valuation withheld: ${contradictions.join("; ")}. Trading volume is retained as reported.`;
  } else if (evidence.reportedUsd === null) {
    liquidityUsd = null;
    liquidityStatus = "unavailable";
    liquidityNote =
      "The provider did not supply a usable USD reserve valuation.";
  } else if (componentUnderflow) {
    liquidityUsd = null;
    liquidityStatus = "unverified";
    liquidityNote =
      "Reserve valuation withheld: a positive token balance × USD price is below the supported numeric range, so complete component arithmetic cannot be verified. Trading volume is retained as reported.";
  } else if (COMPOSITION_KEYS.some((key) => evidence[key] === null)) {
    liquidityUsd = null;
    liquidityStatus = "unverified";
    liquidityNote =
      "Reserve valuation withheld: source composition is incomplete, so balance × USD price and component totals cannot be checked. Trading volume is retained as reported.";
  }
  return {
    liquidityUsd,
    liquidityStatus,
    liquidityNote,
    liquidityEvidence: evidence,
  };
}

export function assessMarketLiquidity(row, provider) {
  if (provider === "dexscreener") {
    const liquidityUsd = amount(row?.liquidity?.usd);
    return {
      liquidityUsd,
      liquidityStatus: liquidityUsd === null ? "unavailable" : "reported",
      liquidityNote:
        "Provider-estimated reserve valuation can include one-sided launch inventory valued at its initial token price. It is not verified TVL or executable swap depth.",
      liquidityEvidence: Object.freeze({
        version: RESERVE_EVIDENCE_VERSION,
        provider,
        reportedUsd: liquidityUsd,
      }),
    };
  }
  const attr = row?.attributes;
  return assessReserveEvidence({
    reportedUsd: attr?.reserve_in_usd,
    baseBalance: attr?.base_token_balance,
    quoteBalance: attr?.quote_token_balance,
    basePriceUsd: attr?.base_token_price_usd,
    quotePriceUsd: attr?.quote_token_price_usd,
    baseReserveUsd: attr?.base_token_liquidity_usd,
    quoteReserveUsd: attr?.quote_token_liquidity_usd,
  });
}

// Only an authored provider discriminator, or matching public source identity
// and provider hostname, can opt a cached row into reserve revalidation.
function cachedProvider(pool) {
  if (["geckoterminal", "dexscreener", "envio"].includes(pool?.metricProvider))
    return pool.metricProvider;
  try {
    const url = new URL(pool?.url);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (
      /^Envio v4 indexer(?:;|$)/i.test(pool?.source || "") &&
      ["v4.xyz", "www.v4.xyz"].includes(url.hostname)
    )
      return "envio";
    if (
      /^GeckoTerminal(?:;|$)/i.test(pool?.source || "") &&
      [
        "geckoterminal.com",
        "www.geckoterminal.com",
        "api.geckoterminal.com",
      ].includes(url.hostname)
    )
      return "geckoterminal";
    if (
      /^DEX Screener(?:;|$)/i.test(pool?.source || "") &&
      [
        "dexscreener.com",
        "www.dexscreener.com",
        "api.dexscreener.com",
      ].includes(url.hostname)
    )
      return "dexscreener";
  } catch {
    /* Unknown sources retain their own independent semantics. */
  }
  return null;
}

export function normalizeCachedLiquidity(pool, now = Date.now()) {
  const provider = cachedProvider(pool);
  if (!provider) return pool;
  if (provider === "envio")
    return { ...pool, ...assessEnvioLiquidity(pool, now) };
  const assessment =
    provider === "geckoterminal"
      ? assessReserveEvidence(
          pool.liquidityEvidence?.version === RESERVE_EVIDENCE_VERSION
            ? pool.liquidityEvidence
            : { reportedUsd: pool.liquidityUsd },
        )
      : assessMarketLiquidity(
          { liquidity: { usd: pool.liquidityUsd } },
          "dexscreener",
        );
  return { ...pool, ...assessment };
}
