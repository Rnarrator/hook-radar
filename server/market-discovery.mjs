import { isPoolId } from "./model.mjs";

export const MARKET_DISCOVERY_MAX_PAGE = 10;

// Keep Base's first page every third successful discovery turn. Its second
// slot explores the remaining free pages while the third alternates pages 2/3.
// This widens discovery within the existing request budget; known pools still
// renew separately. Other networks retain their three-page rotation.
export function nextMarketDiscoveryPage(chain, turn, rowCount) {
  marketDiscoveryUrl(chain);
  const expanded =
    chain.chain === "base" &&
    chain.chainId === 8453 &&
    chain.gecko === "base" &&
    chain.dex === "uniswap-v4-base";
  const cycle = expanded ? 42 : 3;
  if (
    !Number.isSafeInteger(turn) ||
    turn < 0 ||
    turn >= cycle ||
    !Number.isSafeInteger(rowCount) ||
    rowCount < 0 ||
    rowCount > 20
  )
    throw new Error("Market discovery requires a bounded turn and page size");
  // Resetting Base after an empty deep page would repeatedly visit 1/4 and
  // strand pages 2/3. A short page is not evidence that other pages are empty.
  const nextTurn = !expanded && rowCount < 20 ? 0 : (turn + 1) % cycle;
  const slot = nextTurn % 3;
  const round = Math.floor(nextTurn / 3);
  const page = expanded
    ? slot === 0
      ? 1
      : slot === 1
        ? 4 + (round % (MARKET_DISCOVERY_MAX_PAGE - 3))
        : 2 + (round % 2)
    : nextTurn + 1;
  return { turn: nextTurn, page };
}

// GeckoTerminal's public Top Pools by DEX endpoint returns at most 20 pools.
// This feed finds market candidates; only an independent canonical pool key
// can establish hook identity. The caller must still validate its currencies.
// https://api.geckoterminal.com/docs/v2/swagger.json
export function marketDiscoveryUrl(chain, page = 1) {
  if (
    !chain?.manager ||
    !/^[a-z0-9_-]+$/.test(chain.gecko || "") ||
    !/^uniswap-v4-[a-z0-9-]+$/.test(chain.dex || "") ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > MARKET_DISCOVERY_MAX_PAGE
  )
    throw new Error(
      "Market discovery requires a verified v4 DEX and bounded page",
    );
  return `https://api.geckoterminal.com/api/v2/networks/${chain.gecko}/dexes/${chain.dex}/pools?page=${page}&include=base_token,quote_token,dex&include_composition=true&sort=h24_volume_usd_desc`;
}

export function validateMarketDiscovery(value, chain) {
  marketDiscoveryUrl(chain);
  if (!Array.isArray(value?.data) || value.data.length > 20)
    throw new Error("Market discovery returned an unexpected pool page");
  const seen = new Set();
  const data = [];
  for (const row of value.data) {
    const id = row?.attributes?.address?.toLowerCase?.();
    if (
      row?.type !== "pool" ||
      !isPoolId(id) ||
      row.id !== `${chain.gecko}_${id}` ||
      row.relationships?.dex?.data?.id !== chain.dex
    )
      continue;
    if (seen.has(id))
      throw new Error("Market discovery returned ambiguous pool IDs");
    seen.add(id);
    data.push(row);
  }
  return { data };
}
