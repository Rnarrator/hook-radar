import type { Pool, PoolPage } from "../shared/types";
import { isPoolKey } from "../shared/pool-key.ts";

/** Prioritize useful market information within a page without changing its cursor or membership. */
export function marketDataFirst(pools: Pool[]): Pool[] {
  const known = (pool: Pool) =>
    pool.liquidityUsd !== null ||
    Object.values(pool.volumeUsd).some((value) => value !== null);
  return [...pools].sort((a, b) => Number(known(b)) - Number(known(a)));
}

export function isPoolPage(
  value: unknown,
  projectId: string,
  scope: { chain?: string; limit?: number } = {},
): value is PoolPage {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  const amount = (n: unknown) =>
    n === null || (typeof n === "number" && Number.isFinite(n) && n >= 0);
  return (
    row.projectId === projectId &&
    (row.replacementToken === undefined ||
      (typeof row.replacementToken === "string" &&
        /^[a-f0-9]{64}$/.test(row.replacementToken))) &&
    Number.isSafeInteger(row.total) &&
    Number(row.total) >= 0 &&
    Number.isSafeInteger(row.offset) &&
    Number(row.offset) >= 0 &&
    (row.nextOffset === null ||
      (Number.isSafeInteger(row.nextOffset) &&
        Number(row.nextOffset) > Number(row.offset))) &&
    (row.nextCursor === undefined ||
      row.nextCursor === null ||
      (typeof row.nextCursor === "string" &&
        /^[a-z0-9-]{1,50}:0x[\da-f]{64}$/.test(row.nextCursor))) &&
    Array.isArray(row.pools) &&
    row.pools.length <= (scope.limit ?? 100) &&
    row.pools.length <= Number(row.total) &&
    new Set(row.pools.map((pool) => pool?.id)).size === row.pools.length &&
    row.pools.every(
      (pool) =>
        pool &&
        typeof pool === "object" &&
        typeof pool.id === "string" &&
        pool.projectId === projectId &&
        typeof pool.chain === "string" &&
        /^[a-z0-9-]{1,50}$/.test(pool.chain) &&
        (!scope.chain || scope.chain === "all" || pool.chain === scope.chain) &&
        /^0x[\da-fA-F]{64}$/.test(pool.address) &&
        pool.id === `${pool.chain}:${pool.address.toLowerCase()}` &&
        /^0x[\da-fA-F]{40}$/.test(pool.hookAddress) &&
        (pool.poolKey === undefined ||
          isPoolKey(pool.poolKey, pool.hookAddress)) &&
        typeof pool.name === "string" &&
        typeof pool.url === "string" &&
        pool.url.startsWith("https://") &&
        typeof pool.source === "string" &&
        (pool.liquidityStatus === undefined ||
          ["reported", "inconsistent", "unverified", "unavailable"].includes(
            pool.liquidityStatus,
          )) &&
        (pool.liquidityNote === undefined ||
          (typeof pool.liquidityNote === "string" &&
            pool.liquidityNote.length <= 500)) &&
        Array.isArray(pool.tokens) &&
        pool.tokens.every((token: unknown) => typeof token === "string") &&
        amount(pool.liquidityUsd) &&
        pool.volumeUsd &&
        ["h1", "h6", "h24"].every((key) => amount(pool.volumeUsd[key])),
    )
  );
}
