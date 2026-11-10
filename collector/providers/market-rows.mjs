import { isAddress } from "../../server/model.mjs";

// Parsing helpers shared by the DEX Screener and GeckoTerminal providers. They
// mirror the live app's market collector: a missing or malformed amount is null,
// never zero, and only a real zero stays zero.

export const timestamp = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  Date.parse(value) >= 0
    ? value
    : null;

export const amount = (value) => {
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

export const windows = (value) =>
  Object.fromEntries(
    ["h1", "h6", "h24"].map((key) => [key, amount(value?.[key])]),
  );

/** Whether a normalised pool row says anything at all: a liquidity figure or one
 * of the three volume windows. A measured zero is a value. A row whose figures
 * are all null is an answer without a measurement: the pool counts as checked,
 * never as measured, and stays out of the snapshot. */
export const hasMarketValue = (pool) =>
  [
    pool?.liquidityUsd,
    pool?.volumeUsd?.h1,
    pool?.volumeUsd?.h6,
    pool?.volumeUsd?.h24,
  ].some((value) => typeof value === "number" && Number.isFinite(value));

export const marketTokens = (row, provider) =>
  (provider === "dexscreener"
    ? [row?.baseToken?.address, row?.quoteToken?.address]
    : [
        row?.relationships?.base_token?.data?.id,
        row?.relationships?.quote_token?.data?.id,
      ].map((value) => value?.slice?.(value.lastIndexOf("_") + 1))
  )
    .filter(isAddress)
    .map((value) => value.toLowerCase());

export const suppliesMarketCurrencies = (row, provider) =>
  provider === "dexscreener"
    ? [row?.baseToken?.address, row?.quoteToken?.address].some(
        (value) => value != null,
      )
    : [
        row?.relationships?.base_token?.data?.id,
        row?.relationships?.quote_token?.data?.id,
      ].some((value) => value != null);

/** The immutable-identity token check both providers share: when the pool's two
 * currencies are known, the provider row must agree on every non-native one. */
export function tokensAgree(row, provider, expected, zeroAddress) {
  const supplied = marketTokens(row, provider);
  return !(
    expected?.length === 2 &&
    (supplied.length || suppliesMarketCurrencies(row, provider)) &&
    (supplied.length !== 2 ||
      expected
        .filter((token) => token !== zeroAddress)
        .some((token) => !supplied.includes(token)))
  );
}
