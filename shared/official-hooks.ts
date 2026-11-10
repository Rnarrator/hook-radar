/** Exact mainnet hook deployments published by Uniswap Labs. This is identity
 * evidence only: it supplies no source-verification, audit or access-control
 * assessment. Reviewed against the first-party README on 2026-10-17. */
export const OFFICIAL_HOOKS_SOURCE =
  "https://github.com/Uniswap/v4-hooks-public";

export interface OfficialHook {
  readonly chain: string;
  readonly chainId: number;
  readonly address: string;
  readonly name: string;
  readonly description: string;
  readonly category: "Liquidity" | "Fees";
  readonly website: string;
  readonly docs: string;
  readonly sourceUrl: string;
}

const descriptions = {
  WETHHook:
    "Uniswap Labs hook for exchanging native ETH and WETH at a one-to-one rate without a swap fee.",
  WstETHHook:
    "Uniswap Labs hook for converting between stETH and wstETH using the wrapper's exchange rate.",
  WstETHRoutingHook:
    "Uniswap Labs companion hook that lets the v4 quoter simulate stETH and wstETH wrapping routes.",
  StablePairHook:
    "Uniswap Labs dynamic-fee hook for assets with a shared reference price. The published hook address is its permanent proxy.",
  VolatilePairHook:
    "Uniswap Labs hook for volatile-asset pairs. The published hook address is its permanent proxy; implementation upgrades retain this address.",
} as const;

type OfficialHookName = keyof typeof descriptions;
const deployments: readonly [string, number, string, OfficialHookName][] = [
  ["ethereum", 1, "0x57991106cb7aa27e2771beda0d6522f68524a888", "WETHHook"],
  ["unichain", 130, "0x730b109bad65152c67ecc94eb8b0968603dba888", "WETHHook"],
  ["optimism", 10, "0x480dafdb4d6092ef3217595b75784ec54b52e888", "WETHHook"],
  ["base", 8453, "0xb08211d57032dd10b1974d4b876851a7f7596888", "WETHHook"],
  ["arbitrum", 42161, "0x2a4adf825bd96598487dbb6b2d8d882a4eb86888", "WETHHook"],
  ["monad", 143, "0x3fad8a7205f943528915e67cf94fc792c8fce888", "WETHHook"],
  ["ethereum", 1, "0xcdde8f9c3414a00f804e5c565eed9949ad17e888", "WstETHHook"],
  [
    "ethereum",
    1,
    "0x3ac6e14a142251eb3fe739399e0a8da81ed06888",
    "WstETHRoutingHook",
  ],
  [
    "ethereum",
    1,
    "0x0000113dcf4add69999fad8f20f2b63f979bfcc0",
    "StablePairHook",
  ],
  [
    "arbitrum",
    42161,
    "0x630e9cac0fff557bd3a01daa111ed253c771bcc0",
    "StablePairHook",
  ],
  [
    "ethereum",
    1,
    "0x000022ec4ebd6b12294396e852e4c3876b253cc0",
    "VolatilePairHook",
  ],
];

export const officialHooks: readonly OfficialHook[] = Object.freeze(
  deployments.map(([chain, chainId, address, name]) =>
    Object.freeze({
      chain,
      chainId,
      address,
      name,
      description: descriptions[name],
      category:
        name === "StablePairHook" || name === "VolatilePairHook"
          ? ("Fees" as const)
          : ("Liquidity" as const),
      website: "https://uniswap.org/",
      docs: `${OFFICIAL_HOOKS_SOURCE}#docs`,
      sourceUrl: `${OFFICIAL_HOOKS_SOURCE}#${name.toLowerCase()}`,
    }),
  ),
);

const byDeployment = new Map(
  officialHooks.map((hook) => [`${hook.chain}:${hook.address}`, hook]),
);

/** Slug and address must both match. If a chain ID is provided it must agree as
 * well, so an address reused on a different chain cannot inherit an identity. */
export function getOfficialHook(deployment: {
  chain: string;
  chainId?: number;
  address: string;
}): OfficialHook | null {
  if (
    !deployment ||
    typeof deployment.chain !== "string" ||
    typeof deployment.address !== "string"
  )
    return null;
  const found = byDeployment.get(
    `${deployment.chain}:${deployment.address.toLowerCase()}`,
  );
  return found &&
    (deployment.chainId === undefined || deployment.chainId === found.chainId)
    ? found
    : null;
}

/** Never brand a mixed directory family from one official address. */
export function isOfficialHookFamily(project: {
  deployments: readonly { chain: string; chainId?: number; address: string }[];
}) {
  return (
    project.deployments.length > 0 &&
    project.deployments.every(
      (deployment) => getOfficialHook(deployment) !== null,
    )
  );
}
