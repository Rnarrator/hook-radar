import type { FrontierExtensionsResponse } from "../shared/types";

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const text = (value: unknown) =>
  typeof value === "string" && value.length <= 12000;
const address = (value: unknown): value is string =>
  typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value);
const poolId = (value: unknown): value is string =>
  typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
const status = (value: unknown) =>
  ["live", "cached", "unavailable"].includes(String(value));
const kind = (value: unknown) =>
  ["feeCalculator", "observer", "feeRecipient"].includes(String(value));
const date = (value: unknown) =>
  value === null ||
  (typeof value === "string" && Number.isFinite(Date.parse(value)));
const nullableText = (value: unknown) => value === null || text(value);
const roles = (value: unknown) =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.length <= 3 &&
  new Set(value).size === value.length &&
  value.every(kind);
const hex = (value: unknown) =>
  value === null ||
  (typeof value === "string" &&
    value.length <= 131074 &&
    /^0x(?:[0-9a-f]{2})*$/i.test(value));
const bound = (value: unknown) =>
  record(value) &&
  address(value.address) &&
  typeof value.known === "boolean" &&
  nullableText(value.id) &&
  [value.name, value.purpose, value.description, value.docsUrl].every(text) &&
  kind(value.kind) &&
  roles(value.roles) &&
  hex(value.rawConfig);
const decimal = (value: unknown) =>
  typeof value === "string" && /^\d{1,78}$/.test(value);

/** Validate the exact requested scope before exposing third-party configuration to the UI. */
export function isFrontierExtensionsResponse(
  value: unknown,
  hookAddress: string,
  requestedPool?: string | null,
): value is FrontierExtensionsResponse {
  if (
    !record(value) ||
    value.projectId !== "frontier" ||
    value.chainId !== 4663 ||
    !address(value.hookAddress) ||
    value.hookAddress.toLowerCase() !== hookAddress.toLowerCase() ||
    !["current", "legacy"].includes(String(value.hookGeneration)) ||
    !status(value.status) ||
    !date(value.updatedAt) ||
    !status(value.catalogStatus) ||
    !date(value.catalogUpdatedAt) ||
    ![value.sourceUrl, value.docsUrl, value.note].every(text) ||
    !Number.isSafeInteger(value.totalPools) ||
    Number(value.totalPools) < 0 ||
    typeof value.poolsTruncated !== "boolean" ||
    !Array.isArray(value.pools) ||
    value.pools.length > 1000 ||
    value.pools.length > Number(value.totalPools) ||
    !value.pools.every(
      (choice) =>
        record(choice) &&
        poolId(choice.poolId) &&
        address(choice.coinAddress) &&
        text(choice.name) &&
        address(choice.hookAddress) &&
        choice.hookAddress.toLowerCase() === hookAddress.toLowerCase(),
    ) ||
    !Array.isArray(value.catalog) ||
    value.catalog.length > 512 ||
    !value.catalog.every(
      (item) =>
        record(item) &&
        [
          item.id,
          item.name,
          item.purpose,
          item.description,
          item.docsUrl,
        ].every(text) &&
        kind(item.kind) &&
        roles(item.roles) &&
        ["active", "coming-soon"].includes(String(item.status)) &&
        (item.address === null || address(item.address)) &&
        Array.isArray(item.legacyAddresses) &&
        item.legacyAddresses.length <= 64 &&
        item.legacyAddresses.every(address) &&
        (item.implId === null || poolId(item.implId)) &&
        Array.isArray(item.legacyImplIds) &&
        item.legacyImplIds.length <= 64 &&
        item.legacyImplIds.every(poolId) &&
        typeof item.orderRank === "number" &&
        Number.isSafeInteger(item.orderRank) &&
        item.orderRank >= 0 &&
        item.orderRank <= 100000 &&
        typeof item.baseFeeProvider === "boolean" &&
        nullableText(item.leafOf),
    )
  )
    return false;
  if (value.pool === null)
    return !requestedPool || value.status === "unavailable";
  if (
    !record(value.pool) ||
    !requestedPool ||
    !poolId(value.pool.poolId) ||
    value.pool.poolId.toLowerCase() !== requestedPool.toLowerCase() ||
    !address(value.pool.coinAddress) ||
    !Array.isArray(value.pool.feeCalculators) ||
    value.pool.feeCalculators.length > 4 ||
    !value.pool.feeCalculators.every(bound) ||
    !Array.isArray(value.pool.observers) ||
    value.pool.observers.length > 4 ||
    !value.pool.observers.every(bound) ||
    !(value.pool.feeRecipient === null || bound(value.pool.feeRecipient)) ||
    !record(value.pool.hookConfig) ||
    !(
      value.pool.protocolFeeRatio === null ||
      decimal(value.pool.protocolFeeRatio)
    )
  )
    return false;
  const config = value.pool.hookConfig;
  if (
    ![
      "lpShareBps",
      "fixedFee",
      "sniperWindow",
      "communityFeeRatio",
      "registeredAtTimestamp",
    ].every((key) => decimal(config[key])) ||
    !address(config.stakingVault)
  )
    return false;
  return value.pools.some(
    (choice) =>
      choice.poolId.toLowerCase() === requestedPool.toLowerCase() &&
      choice.coinAddress.toLowerCase() ===
        (value.pool as { coinAddress: string }).coinAddress.toLowerCase(),
  );
}

export interface ExtensionCatalogSummary {
  /** Every module in Frontier's published catalog. */
  total: number;
  /** Modules marked active (the rest are announced but not yet available). */
  available: number;
  updatedAt: string | null;
}

/** The size of Frontier's extension catalog, from a validated response. An
 * unavailable or empty catalog yields nothing rather than a count of zero. */
export function summarizeExtensionCatalog(
  value: Pick<FrontierExtensionsResponse, "catalog" | "catalogStatus" | "catalogUpdatedAt">,
): ExtensionCatalogSummary | null {
  if (value.catalogStatus === "unavailable" || value.catalog.length === 0)
    return null;
  return {
    total: value.catalog.length,
    available: value.catalog.filter((item) => item.status === "active").length,
    updatedAt: value.catalogUpdatedAt,
  };
}
