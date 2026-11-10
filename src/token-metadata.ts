import type {
  Pool,
  TokenMetadata,
  TokenMetadataResponse,
} from "../shared/types";
import { STATIC_EDITION, futureSkewLimit } from "./model.ts";

export const nativeCurrencyAddress =
  "0x0000000000000000000000000000000000000000";
export const tokenMetadataKey = (chain: string, address: string) =>
  `${chain}:${address.toLowerCase()}`;

const address = (value: unknown): value is string =>
  typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value);
const text = (value: unknown, max: number) =>
  value === null ||
  (typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= max &&
    !/[\u0000-\u001f\u007f]/.test(value));
const timestamp = (value: unknown, latest: number) =>
  value === null ||
  (typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    Date.parse(value) >= 0 &&
    Date.parse(value) <= latest);
const sourceUrl = (value: unknown, unavailable: boolean) => {
  if (value === "" && unavailable) return true;
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
};

/** Identity binding to requested currencies happens separately, after shape validation.
 * In the static edition `publishedAt` (the publication's generatedAt) stands in
 * for the viewer's clock when a timestamp is checked against the future. */
export function isTokenMetadataResponse(
  value: unknown,
  projectId: string,
  publishedAt?: unknown,
  edition: boolean = STATIC_EDITION,
): value is TokenMetadataResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const latest = futureSkewLimit(publishedAt, edition);
  const row = value as Record<string, unknown>;
  if (
    row.projectId !== projectId ||
    !Array.isArray(row.tokens) ||
    row.tokens.length > 100
  )
    return false;
  const identities = new Set<string>();
  return row.tokens.every((token: unknown) => {
    if (!token || typeof token !== "object" || Array.isArray(token))
      return false;
    const item = token as Record<string, unknown>;
    if (
      typeof item.chain !== "string" ||
      !/^[a-z0-9-]{1,50}$/.test(item.chain) ||
      !address(item.address) ||
      !text(item.symbol, 128) ||
      !text(item.name, 256) ||
      !(
        item.decimals === null ||
        (typeof item.decimals === "number" &&
          Number.isInteger(item.decimals) &&
          item.decimals >= 0 &&
          item.decimals <= 255)
      ) ||
      !["live", "cached", "unavailable"].includes(String(item.status)) ||
      !timestamp(item.updatedAt, latest) ||
      (item.status !== "unavailable" && item.updatedAt === null) ||
      !sourceUrl(item.sourceUrl, item.status === "unavailable")
    )
      return false;
    const key = tokenMetadataKey(item.chain, item.address);
    if (identities.has(key)) return false;
    identities.add(key);
    return true;
  });
}

export function poolCurrencyAddresses(pool: Pool): string[] {
  return pool.poolKey
    ? [pool.poolKey.currency0, pool.poolKey.currency1]
    : pool.tokens.filter(address).slice(0, 2);
}

export function poolNameWithMetadata(
  pool: Pool,
  metadata: ReadonlyMap<string, TokenMetadata>,
): string {
  const currencies = poolCurrencyAddresses(pool);
  if (currencies.length !== 2) return pool.name;
  const fallbackName = currencies
    .map((currency) =>
      currency.toLowerCase() === nativeCurrencyAddress
        ? "Native"
        : `${currency.slice(0, 6)}…${currency.slice(-4)}`,
    )
    .join(" / ");
  if (
    pool.name.trim().toLowerCase() !== fallbackName.toLowerCase() &&
    pool.name !== "Indexed v4 pool"
  )
    return pool.name;
  return currencies
    .map((currency) => {
      if (currency.toLowerCase() === nativeCurrencyAddress) return "Native";
      const token = metadata.get(tokenMetadataKey(pool.chain, currency));
      return token && token.status !== "unavailable"
        ? token.symbol ||
            token.name ||
            `${currency.slice(0, 6)}…${currency.slice(-4)}`
        : `${currency.slice(0, 6)}…${currency.slice(-4)}`;
    })
    .join(" / ");
}
