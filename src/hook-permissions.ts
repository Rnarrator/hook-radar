/** Uniswap v4 hook permissions.
 *
 * A v4 hook declares which callbacks PoolManager may call by the low 14 bits of
 * its own address, so the permissions can be read from an address without any
 * network request. The order below is bit 13 down to bit 0, as in v4-core's
 * `Hooks.sol`. */

export type CallbackKind = "before" | "after" | "delta";

export interface HookCallback {
  readonly name: string;
  /** Bit position inside the low 14 bits of the address. */
  readonly bit: number;
  readonly mask: number;
  readonly kind: CallbackKind;
  /** Plain-language effect, for people who have not read the contracts. */
  readonly summary: string;
}

const callback = (
  name: string,
  bit: number,
  kind: CallbackKind,
  summary: string,
): HookCallback => ({ name, bit, mask: 1 << bit, kind, summary });

export const HOOK_CALLBACKS: readonly HookCallback[] = [
  callback("beforeInitialize", 13, "before", "Runs before a pool that uses this hook is created."),
  callback("afterInitialize", 12, "after", "Runs right after a pool that uses this hook is created."),
  callback("beforeAddLiquidity", 11, "before", "Runs before liquidity is added."),
  callback("afterAddLiquidity", 10, "after", "Runs after liquidity is added."),
  callback("beforeRemoveLiquidity", 9, "before", "Runs before liquidity is removed."),
  callback("afterRemoveLiquidity", 8, "after", "Runs after liquidity is removed."),
  callback("beforeSwap", 7, "before", "Runs before each swap."),
  callback("afterSwap", 6, "after", "Runs after each swap."),
  callback("beforeDonate", 5, "before", "Runs before a donation to the pool."),
  callback("afterDonate", 4, "after", "Runs after a donation to the pool."),
  callback("beforeSwapReturnsDelta", 3, "delta", "Lets beforeSwap change the amounts a swap exchanges."),
  callback("afterSwapReturnsDelta", 2, "delta", "Lets afterSwap adjust the amount of the swap's unspecified token."),
  callback("afterAddLiquidityReturnsDelta", 1, "delta", "Lets afterAddLiquidity change what the provider pays."),
  callback("afterRemoveLiquidityReturnsDelta", 0, "delta", "Lets afterRemoveLiquidity change what the provider receives."),
];

/** All 14 flag bits. */
export const HOOK_PERMISSION_MASK = 0x3fff;

const callbackByName = new Map(HOOK_CALLBACKS.map((item) => [item.name, item]));
export const hookCallback = (name: string) => callbackByName.get(name);

/** A 20-byte hex address, normalised to lower case, or null. */
export function parseHookAddress(input: string): string | null {
  const text = input.trim();
  return /^0x[0-9a-fA-F]{40}$/.test(text) ? text.toLowerCase() : null;
}

/** The 14 permission bits of a well-formed address. */
export function hookPermissionBits(address: string): number {
  const parsed = parseHookAddress(address);
  if (!parsed) throw new Error("Not a 20-byte hex address.");
  return parseInt(parsed.slice(-4), 16) & HOOK_PERMISSION_MASK;
}

export function enabledCallbacks(bits: number): HookCallback[] {
  return HOOK_CALLBACKS.filter((item) => (bits & item.mask) !== 0);
}

/** Flag record in the shape the directory publishes. */
export function flagsFromBits(bits: number): Record<string, boolean> {
  return Object.fromEntries(
    HOOK_CALLBACKS.map((item) => [item.name, (bits & item.mask) !== 0]),
  );
}

const ZERO_ADDRESS = "0x" + "0".repeat(40);

/** v4-core refuses to use a hook address that breaks these rules
 * (`Hooks.isValidHookAddress`). Pass the address when it is known: the zero
 * address means "no hook", which v4 accepts only with a static fee. */
export function hookAddressIssues(bits: number, address?: string): string[] {
  if (address && address.toLowerCase() === ZERO_ADDRESS)
    return [
      "This is the zero address, which means no hook. v4 accepts it only for a pool with a static fee.",
    ];
  const issues: string[] = [];
  const has = (name: string) => (bits & (hookCallback(name)?.mask ?? 0)) !== 0;
  const needs: readonly [string, string][] = [
    ["beforeSwapReturnsDelta", "beforeSwap"],
    ["afterSwapReturnsDelta", "afterSwap"],
    ["afterAddLiquidityReturnsDelta", "afterAddLiquidity"],
    ["afterRemoveLiquidityReturnsDelta", "afterRemoveLiquidity"],
  ];
  for (const [flag, base] of needs)
    if (has(flag) && !has(base))
      issues.push(`${flag} is set without ${base}, which v4 rejects.`);
  if ((bits & HOOK_PERMISSION_MASK) === 0)
    issues.push(
      "No callbacks are enabled. v4 accepts such a hook only in a pool that uses a dynamic fee.",
    );
  return issues;
}
