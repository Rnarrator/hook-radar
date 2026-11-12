import { isAddress, isPoolId, ZERO_ADDRESS } from "../../server/model.mjs";
import { assessMarketLiquidity } from "../../server/reserve-value.mjs";
import { DS_BATCH_SIZE, MAX_BYTES } from "../config.mjs";
import {
  marketTokens,
  timestamp,
  tokensAgree,
  windows,
} from "./market-rows.mjs";

// DEX Screener's chain ids for the networks Hook Radar measures (the same table
// as the live app's market collector).
export const DS_NETWORKS = Object.freeze({
  ethereum: "ethereum",
  base: "base",
  unichain: "unichain",
  arbitrum: "arbitrum",
  optimism: "optimism",
  polygon: "polygon",
  bnb: "bsc",
  avalanche: "avalanche",
  blast: "blast",
  worldchain: "worldchain",
  celo: "celo",
  zora: "zora",
  ink: "ink",
  soneium: "soneium",
  linea: "linea",
  monad: "monad",
  robinhood: "robinhood",
  megaeth: "megaeth",
  tempo: "tempo",
  arc: "arc",
  xlayer: "xlayer",
  zksync: "zksync",
  hyperevm: "hyperevm",
});

export function dexScreenerUrl(chain, ids) {
  if (!ids.length || ids.length > DS_BATCH_SIZE || !ids.every(isPoolId))
    throw new Error("A market batch must contain 1–30 pool IDs");
  if (!DS_NETWORKS[chain?.chain])
    throw new Error("No verified market namespace is available for this chain");
  return `https://api.dexscreener.com/latest/dex/pairs/${DS_NETWORKS[chain.chain]}/${ids.join(",")}`;
}

/** Why a row that came back is not used. `identity`: it is not one of the pools
 * asked about (or its id is not a pool id). `chain`: it is on another network,
 * another DEX or another Uniswap version. `tokens`: its currencies disagree with
 * the identity we hold. */
export const ROW_REJECTION_REASONS = Object.freeze([
  "identity",
  "chain",
  "tokens",
]);

const providerFailure = (code, message) =>
  Object.assign(new Error(message), { code });

/** The rows of one batch, sorted: those that are exactly a requested Uniswap v4
 * pool on this chain whose currencies agree with the identity we hold
 * (`accepted`), those that are not and why (`rejected`, each `{ id, reason }`;
 * `id` is null when the row names no pool id) and how many came back
 * (`returned`). Same rules as the live collector. A batch of an unexpected shape,
 * or one that names a pool twice, throws (with `code` "shape" or "ambiguous"). */
export function classifyDexScreenerPairs(
  value,
  chain,
  requested,
  structuralById,
) {
  const rows = value?.pairs === null ? [] : value?.pairs;
  if (!Array.isArray(rows) || rows.length > DS_BATCH_SIZE)
    throw providerFailure(
      "shape",
      "Market source returned an unexpected batch shape",
    );
  const wanted = new Set(requested.map((id) => id.toLowerCase()));
  const seen = new Set();
  const accepted = [];
  const rejected = [];
  for (const row of rows) {
    const id = row?.pairAddress?.toLowerCase?.();
    if (!isPoolId(id) || !wanted.has(id)) {
      rejected.push({ id: isPoolId(id) ? id : null, reason: "identity" });
      continue;
    }
    if (
      row.chainId !== DS_NETWORKS[chain.chain] ||
      row.dexId !== "uniswap" ||
      (Array.isArray(row.labels) &&
        row.labels.length &&
        !row.labels.includes("v4"))
    ) {
      rejected.push({ id, reason: "chain" });
      continue;
    }
    const expected = structuralById
      ?.get(id)
      ?.tokens?.filter(isAddress)
      .map((token) => token.toLowerCase());
    if (!tokensAgree(row, "dexscreener", expected, ZERO_ADDRESS)) {
      rejected.push({ id, reason: "tokens" });
      continue;
    }
    if (seen.has(id))
      throw providerFailure(
        "ambiguous",
        "Market source returned ambiguous pool IDs",
      );
    seen.add(id);
    accepted.push(row);
  }
  return { accepted, rejected, returned: rows.length };
}

/** The rows classifyDexScreenerPairs accepts, and nothing else: exactly a
 * requested Uniswap v4 pool on this chain whose currencies agree with the
 * identity we hold. Unreturned ids are unresolved, never zero.
 *
 * FOR THE TESTS. The collector calls classifyDexScreenerPairs (it needs the
 * rejected rows and their reasons); this is that call's `accepted`, so the two
 * cannot differ, and tests/collector-foundation.test.mjs checks that nothing in
 * collector/ calls this one. */
export const acceptDexScreenerPairs = (
  value,
  chain,
  requested,
  structuralById,
) => classifyDexScreenerPairs(value, chain, requested, structuralById).accepted;

/** One measured pool, with the response's own observation time. */
export function normalizeDexScreenerPool(row, chain, structural, observedAt) {
  const address = row.pairAddress.toLowerCase();
  const tokens = structural.tokens?.filter(isAddress).slice(0, 2) ?? [];
  if (!tokens.length) tokens.push(...marketTokens(row, "dexscreener"));
  const createdAt =
    typeof row.pairCreatedAt === "number" &&
    Number.isFinite(row.pairCreatedAt) &&
    row.pairCreatedAt >= 0 &&
    row.pairCreatedAt <= 253402300799000
      ? new Date(row.pairCreatedAt).toISOString()
      : null;
  const name = [row.baseToken?.symbol, row.quoteToken?.symbol]
    .filter((value) => typeof value === "string")
    .join(" / ");
  const { liquidityEvidence: _evidence, ...liquidity } = assessMarketLiquidity(
    row,
    "dexscreener",
  );
  return {
    id: `${chain.chain}:${address}`,
    chain: chain.chain,
    chainId: chain.chainId,
    address,
    hookAddress: structural.hookAddress.toLowerCase(),
    projectId: null,
    name: name ? name.slice(0, 180) : "Indexed v4 pool",
    url: `https://dexscreener.com/${DS_NETWORKS[chain.chain]}/${address}`,
    source: "DEX Screener",
    ...liquidity,
    volumeUsd: windows(row.volume),
    createdAt: timestamp(structural.createdAt) || createdAt,
    tokens: [...tokens],
    metricUpdatedAt: new Date(observedAt).toISOString(),
    metricStatus: "live",
    metricProvider: "dexscreener",
  };
}

export const DS_MAX_BYTES = MAX_BYTES.dexscreener;
