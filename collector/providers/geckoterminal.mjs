import { isAddress, isPoolId, ZERO_ADDRESS } from "../../server/model.mjs";
import { assessMarketLiquidity } from "../../server/reserve-value.mjs";
import {
  marketDiscoveryUrl,
  validateMarketDiscovery,
} from "../../server/market-discovery.mjs";
import { dayNumber } from "../../shared/daily-volume.ts";
import {
  DAILY_CANDLES,
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

// Daily candles of one pool (the 7D and 30D volume of the largest pools, see
// collector/daily.mjs). One request answers for one pool:
//
//   /networks/{network}/pools/{poolId}/ohlcv/day?limit=33&currency=usd
//       &include_empty_intervals=true
//
// with the Accept header of the API version the shape below belongs to. Checked
// against the live API on 11 November 2026 (collector/fixtures/daily/): the
// answer is data.attributes.ohlcv_list, newest first, one row
// [unix seconds, open, high, low, close, volume] per UTC day, aligned to UTC
// midnight, the newest row being the day still in progress. A pool younger than
// 33 days gets fewer rows. With include_empty_intervals=true a day without
// trades is a row with volume 0, so the days are contiguous; without it such a
// day is left out and a sparse pool's 33 rows span two months. The answer's meta
// names the pool's two currencies.

/** The Accept header the answer's shape belongs to. */
export const GT_DAILY_ACCEPT = "application/json;version=20230302";

export function geckoOhlcvUrl(chain, poolId) {
  if (typeof poolId !== "string" || !isPoolId(poolId))
    throw new Error("A daily-volume request needs an exact pool ID");
  if (!/^[a-z0-9_-]+$/.test(chain?.gecko || ""))
    throw new Error("No verified market namespace is available for this chain");
  return `https://api.geckoterminal.com/api/v2/networks/${chain.gecko}/pools/${poolId.toLowerCase()}/ohlcv/day?limit=${DAILY_CANDLES}&currency=usd&include_empty_intervals=true`;
}

/** An answer that arrived but cannot be used as a pool's daily volume. */
export class UnreadableOhlcv extends Error {
  constructor(reason) {
    super(reason);
    this.name = "UnreadableOhlcv";
    this.reason = reason;
  }
}

const MAX_DAILY_VOLUME_USD = 1e13;

/** The complete days of one answer, read at `observedAtMs` (the response's own
 * time, never the moment we looked).
 *
 * Returns `{ days, oldest, full, rows }`: `days` is [dayNumber, usd] ascending
 * and holds COMPLETE UTC days only (the day in progress at `observedAtMs` is
 * left out, so a stored day never changes); `oldest` is the first day the
 * answer lists (in progress or not), null for an empty list; `full` says the
 * answer was cut at its row limit (older days exist), so `oldest` is not the
 * start of the pool's history; `rows` is how many rows it listed.
 *
 * Anything that is not exactly the verified shape throws UnreadableOhlcv and
 * the caller keeps what it had: more than 33 rows, a row that is not six
 * entries, a timestamp that is not a UTC midnight, a day after the reading, a
 * repeated or missing day, a volume that is not a plain amount below 1e13 and
 * not negative, or (when the answer names the pool's currencies) a currency
 * that is not the pool's. `expectedTokens` are the pool's two currency
 * addresses; the zero address (native currency) is not compared. */
export function parseOhlcv(value, observedAtMs, expectedTokens = null) {
  const list = value?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list))
    throw new UnreadableOhlcv("the answer has no candle list");
  if (list.length > DAILY_CANDLES)
    throw new UnreadableOhlcv("the answer has more rows than were asked for");
  if (!Number.isFinite(observedAtMs))
    throw new UnreadableOhlcv("the answer has no reading time");
  const today = dayNumber(observedAtMs);
  const rows = [];
  const seen = new Set();
  for (const row of list) {
    if (!Array.isArray(row) || row.length < 6)
      throw new UnreadableOhlcv("a row is not a candle");
    const [seconds, , , , , volume] = row;
    if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds % 86400 !== 0)
      throw new UnreadableOhlcv("a candle does not start at UTC midnight");
    const day = seconds / 86400;
    if (day > today) throw new UnreadableOhlcv("a candle is from the future");
    if (seen.has(day)) throw new UnreadableOhlcv("a day is listed twice");
    if (
      typeof volume !== "number" ||
      !Number.isFinite(volume) ||
      volume < 0 ||
      volume >= MAX_DAILY_VOLUME_USD
    )
      throw new UnreadableOhlcv("a volume is not a plain amount");
    seen.add(day);
    rows.push([day, volume]);
  }
  rows.sort((a, b) => a[0] - b[0]);
  for (let index = 1; index < rows.length; index++)
    if (rows[index][0] - rows[index - 1][0] !== 1)
      throw new UnreadableOhlcv("a day is missing between two candles");
  const named = [value?.meta?.base?.address, value?.meta?.quote?.address]
    .filter((token) => isAddress(token))
    .map((token) => token.toLowerCase());
  if (
    named.length === 2 &&
    expectedTokens?.length === 2 &&
    expectedTokens
      .map((token) => String(token).toLowerCase())
      .filter((token) => token !== ZERO_ADDRESS)
      .some((token) => !named.includes(token))
  )
    throw new UnreadableOhlcv("the answer is for other currencies than the pool's");
  return {
    days: rows.filter(([day]) => day < today),
    oldest: rows.length ? rows[0][0] : null,
    full: rows.length >= DAILY_CANDLES,
    rows: rows.length,
  };
}
