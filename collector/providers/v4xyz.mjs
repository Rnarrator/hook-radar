import { isAddress, isPoolId, ZERO_ADDRESS } from "../../server/model.mjs";
import {
  ENVIO_MARKET_ORIGIN,
  validateEnvioPools,
} from "../../server/market-envio.mjs";
import { DYNAMIC_FEE_FLAG, MAX_BYTES } from "../config.mjs";

export { validateEnvioPools };
export const V4_LIST_MAX_BYTES = MAX_BYTES.v4xyzList;
export const V4_DETAIL_MAX_BYTES = MAX_BYTES.v4xyzDetail;

// The v4.xyz paths are undocumented. They are read only for pool identity (which
// hook a pool uses, which two currencies it holds), never for money amounts.
export const poolListUrl = (chain) =>
  `${ENVIO_MARKET_ORIGIN}/api/pools?chainId=${chain.chainId}`;

export function poolDetailUrl(chain, id) {
  if (!isPoolId(id)) throw new Error("A pool id must be 32 bytes");
  return `${ENVIO_MARKET_ORIGIN}/api/pool/${chain.chainId}_${id.toLowerCase()}`;
}

/** The exact-pool answer, checked the way the live collector checks it
 * (server/market-envio-prices.mjs validateEnvioDetail): the id, chain and both
 * currencies must carry this chain's prefix. Returns the pool's identity, or
 * `hooked: false` for a pool with the zero hook. Anything else throws. */
export function validateIndexerPoolIdentity(value, chain, id) {
  if (!Array.isArray(value?.Pool) || value.Pool.length !== 1)
    throw new Error("The indexer returned no exact pool.");
  const row = value.Pool[0];
  const prefix = `${chain.chainId}_`;
  const wanted = id.toLowerCase();
  const tokens = [row?.token0, row?.token1].map((token) =>
    typeof token === "string" && token.toLowerCase().startsWith(prefix)
      ? token.slice(prefix.length).toLowerCase()
      : null,
  );
  if (
    typeof row?.id !== "string" ||
    row.id.toLowerCase() !== `${prefix}${wanted}` ||
    row.chainId !== String(chain.chainId) ||
    typeof row.hooks !== "string" ||
    !isAddress(row.hooks) ||
    !tokens.every(isAddress) ||
    tokens[0] === tokens[1]
  )
    throw new Error("The indexer's pool identity does not match the request.");
  const hookAddress = row.hooks.toLowerCase();
  return {
    address: wanted,
    hooked: hookAddress !== ZERO_ADDRESS,
    hookAddress,
    tokens,
    name:
      typeof row.name === "string" && row.name
        ? row.name.slice(0, 180)
        : "Indexed v4 pool",
  };
}

/** The LP fee a pool was initialised with, as the indexer prints it at the end of
 * the pool name ("A / B - 0.3%": percent of each swap, up to four decimals), in
 * the hundredths of a basis point v4 uses (0.3% is 3000). Null when the name
 * carries no fee or one v4 cannot have. The indexer's `feeTier` field is not
 * this: for a dynamic-fee pool it holds the fee currently charged (recorded
 * answer: feeTier "0" beside the name "... - 838.8608%"). */
export function initialFeeFromName(name) {
  const match = /\s-\s(\d{1,3}(?:\.\d{1,4})?)%$/.exec(
    typeof name === "string" ? name : "",
  );
  if (!match) return null;
  const fee = Math.round(Number(match[1]) * 10000);
  return fee === DYNAMIC_FEE_FLAG || (fee >= 0 && fee <= 1000000) ? fee : null;
}

/** True when the name shows the dynamic-fee flag; otherwise unknown (undefined).
 * A fixed-fee pool says nothing about the other pools of its hook, and a hook
 * counts as dynamic when any of its pools is. */
export const dynamicFeeEvidence = (name) =>
  initialFeeFromName(name) === DYNAMIC_FEE_FLAG ? true : undefined;
