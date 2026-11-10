import { isAddress, isPoolId, ZERO_ADDRESS } from "../../server/model.mjs";
import { assessMarketLiquidity } from "../../server/reserve-value.mjs";
import {
  marketDiscoveryUrl,
  validateMarketDiscovery,
} from "../../server/market-discovery.mjs";
import {
  GT_DISCOVERY_PAGE_CYCLE,
  GT_FALLBACK_BATCH_SIZE,
  MAX_BYTES,
} from "../config.mjs";
import {
  marketTokens,
  timestamp,
  tokensAgree,
  windows,
} from "./market-rows.mjs";

export { marketDiscoveryUrl, validateMarketDiscovery };
export const GT_MAX_BYTES = MAX_BYTES.geckoterminal;

/** The top-pools page this run reads: the page rotates every run so repeated
 * runs walk down the volume ranking instead of re-reading page one. */
export function discoveryPage(runIndex) {
  return 1 + (Math.abs(Math.trunc(runIndex)) % GT_DISCOVERY_PAGE_CYCLE);
}

export function geckoMultiUrl(chain, ids) {
  if (
    !ids.length ||
    ids.length > GT_FALLBACK_BATCH_SIZE ||
    !ids.every(isPoolId)
  )
    throw new Error("A market batch must contain 1–30 pool IDs");
  if (!/^[a-z0-9_-]+$/.test(chain?.gecko || ""))
    throw new Error("No verified market namespace is available for this chain");
  return `https://api.geckoterminal.com/api/v2/networks/${chain.gecko}/pools/multi/${ids.join(",")}?include=base_token,quote_token,dex&include_composition=true`;
}

/** Fallback rows: an exact requested pool on this chain's Uniswap v4 DEX whose
 * currencies agree with the identity we hold. Same rules as the live collector. */
export function acceptGeckoPools(value, chain, requested, structuralById) {
  const rows = value?.data;
  if (!Array.isArray(rows) || rows.length > GT_FALLBACK_BATCH_SIZE)
    throw new Error("Market source returned an unexpected batch shape");
  const wanted = new Set(requested.map((id) => id.toLowerCase()));
  const seen = new Set();
  const accepted = [];
  for (const row of rows) {
    const id = row?.attributes?.address?.toLowerCase?.();
    if (!isPoolId(id) || !wanted.has(id)) continue;
    if (row.type !== "pool" || row.id !== `${chain.gecko}_${id}`) continue;
    const dex = row.relationships?.dex?.data?.id;
    if (
      typeof dex === "string" &&
      (chain.dex ? dex !== chain.dex : !dex.startsWith("uniswap-v4"))
    )
      continue;
    const expected = structuralById
      ?.get(id)
      ?.tokens?.filter(isAddress)
      .map((token) => token.toLowerCase());
    if (!tokensAgree(row, "geckoterminal", expected, ZERO_ADDRESS)) continue;
    if (seen.has(id))
      throw new Error("Market source returned ambiguous pool IDs");
    seen.add(id);
    accepted.push(row);
  }
  return accepted;
}

export function normalizeGeckoPool(row, chain, structural, observedAt) {
  const attr = row.attributes;
  const address = attr.address.toLowerCase();
  const tokens = structural.tokens?.filter(isAddress).slice(0, 2) ?? [];
  if (!tokens.length) tokens.push(...marketTokens(row, "geckoterminal"));
  const { liquidityEvidence: _evidence, ...liquidity } = assessMarketLiquidity(
    row,
    "geckoterminal",
  );
  return {
    id: `${chain.chain}:${address}`,
    chain: chain.chain,
    chainId: chain.chainId,
    address,
    hookAddress: structural.hookAddress.toLowerCase(),
    projectId: null,
    name:
      typeof attr.name === "string" && attr.name
        ? attr.name.slice(0, 180)
        : "Indexed v4 pool",
    url: `https://www.geckoterminal.com/${chain.gecko}/pools/${address}`,
    source: "GeckoTerminal",
    ...liquidity,
    volumeUsd: windows(attr.volume_usd),
    createdAt:
      timestamp(structural.createdAt) || timestamp(attr.pool_created_at),
    tokens: [...tokens],
    metricUpdatedAt: new Date(observedAt).toISOString(),
    metricStatus: "live",
    metricProvider: "geckoterminal",
  };
}
