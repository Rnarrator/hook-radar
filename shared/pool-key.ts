import type { PoolKey } from "./types";

const address = (value: unknown): value is string =>
  typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value);

/** Immutable Initialize evidence; the dynamic flag is a mode, never a fee percentage. */
export function isPoolKey(
  value: unknown,
  hookAddress: unknown,
): value is PoolKey {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const key = value as Record<string, unknown>;
  return (
    address(key.currency0) &&
    address(key.currency1) &&
    BigInt(key.currency0) < BigInt(key.currency1) &&
    address(key.hookAddress) &&
    address(hookAddress) &&
    key.hookAddress.toLowerCase() === hookAddress.toLowerCase() &&
    address(key.managerAddress) &&
    !/^0x0{40}$/i.test(key.managerAddress) &&
    typeof key.fee === "number" &&
    Number.isSafeInteger(key.fee) &&
    ((key.fee >= 0 && key.fee <= 1000000) || key.fee === 8388608) &&
    typeof key.tickSpacing === "number" &&
    Number.isSafeInteger(key.tickSpacing) &&
    key.tickSpacing >= 1 &&
    key.tickSpacing <= 32767 &&
    typeof key.creationBlock === "number" &&
    Number.isSafeInteger(key.creationBlock) &&
    key.creationBlock >= 0
  );
}
