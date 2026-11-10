import type { RadarProject } from "./types.ts";

/** First-party platform information is separate from hook ownership. Pools.xyz
 * can launch hookless markets; CCA and Liquidity Launcher are shared tools. */
export const POOLS_PLATFORM_SOURCE =
  "https://support.uniswap.org/hc/en-us/articles/47943121516685-Launching-and-trading-tokens-on-pools-xyz";
export const LIQUIDITY_LAUNCHER_SOURCE =
  "https://github.com/Uniswap/liquidity-launcher/blob/266c18786c58822b72a7a9490f4e319294df0548/README.md";

export const publishedPlatforms = Object.freeze([
  Object.freeze({
    id: "pools-xyz",
    entityType: "platform" as const,
    name: "Pools.xyz",
    description:
      "Uniswap Labs token launchpad with instant launches and crowd auctions. Markets settle into Uniswap v4 with locked liquidity; a launch may use a hookless pool.",
    category: "Launches" as const,
    website: "https://pools.xyz/",
    docs: POOLS_PLATFORM_SOURCE,
    sourceUrl: POOLS_PLATFORM_SOURCE,
    networks: Object.freeze([
      Object.freeze({ chain: "robinhood", chainId: 4663 }),
      Object.freeze({ chain: "arc", chainId: 5042 }),
    ]),
    metricsNote:
      "Platform listing. Hook deployments and market metrics have not been linked to Pools.xyz; shared Liquidity Launcher contracts do not establish platform ownership.",
  }),
]);

/** No deployment, pool, zero-valued metric or history is inferred from a
 * platform's supported networks. Callers opt in to these distinct listings. */
export function createPublishedPlatformProjects(
  chains: Readonly<Record<string, { chainId: number }>>,
): (RadarProject & { entityType: "platform" })[] {
  return publishedPlatforms.flatMap((platform) => {
    const supported = platform.networks
      .filter((network) => chains[network.chain]?.chainId === network.chainId)
      .map((network) => network.chain);
    if (!supported.length) return [];
    return [
      {
        id: platform.id,
        entityType: platform.entityType,
        name: platform.name,
        description: platform.description,
        category: platform.category,
        website: platform.website,
        docs: platform.docs,
        sourceUrl: platform.sourceUrl,
        chains: supported,
        deployments: [],
        metrics: {
          poolCount: null,
          liquidityUsd: null,
          volumeUsd: { h1: null, h6: null, h24: null },
          coverage: "unavailable",
          note: platform.metricsNote,
        },
        history: [],
      },
    ];
  });
}

/** The empty-deployment exception is limited to our exact, source-backed
 * platform listing. It never legitimizes an empty or renamed hook family. */
export function isPublishedPlatformProject(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<RadarProject> & { entityType?: unknown };
  const platform = publishedPlatforms.find((entry) => entry.id === row.id);
  return Boolean(
    platform &&
    row.entityType === "platform" &&
    row.name === platform.name &&
    row.description === platform.description &&
    row.category === platform.category &&
    row.website === platform.website &&
    row.docs === platform.docs &&
    row.sourceUrl === platform.sourceUrl &&
    Array.isArray(row.chains) &&
    row.chains.length > 0 &&
    new Set(row.chains).size === row.chains.length &&
    row.chains.every((chain) =>
      platform.networks.some((network) => network.chain === chain),
    ) &&
    Array.isArray(row.deployments) &&
    row.deployments.length === 0 &&
    row.metrics?.poolCount === null &&
    row.metrics.liquidityUsd === null &&
    row.metrics.volumeUsd?.h1 === null &&
    row.metrics.volumeUsd.h6 === null &&
    row.metrics.volumeUsd.h24 === null &&
    row.metrics.coverage === "unavailable" &&
    row.metrics.note === platform.metricsNote &&
    row.metrics.freshness === undefined &&
    row.poolInventory === undefined &&
    (row.history === undefined ||
      (Array.isArray(row.history) && row.history.length === 0)) &&
    (row.historyPointCount === undefined || row.historyPointCount === 0),
  );
}

type InfrastructureKind = "LBPStrategy" | "InitializerHook";
export interface PublishedInfrastructureHook {
  readonly chain: string;
  readonly chainId: number;
  readonly address: string;
  readonly name: string;
  readonly description: string;
  readonly category: "Launches";
  readonly website: string;
  readonly docs: string;
  readonly sourceUrl: string;
}

// Mainnet v3.3.0 hooks in the pinned first-party deployment table. Factories,
// InstantLaunchStrategy, fee recipients and testnets are deliberately excluded.
const deployments: readonly [string, number, string, InfrastructureKind][] = [
  ["ethereum", 1, "0x2eef0e2a9a652d755accad95a24541a98b5ca000", "LBPStrategy"],
  ["base", 8453, "0xf10124b01e9fa88b0a2ef3fa95a53b3310446000", "LBPStrategy"],
  [
    "unichain",
    130,
    "0x48f55e7e8ac229aa4e2f3f2d44aa9284d86da000",
    "LBPStrategy",
  ],
  [
    "arbitrum",
    42161,
    "0xc80f3f4497cd9ae41bf8cb5c8809620182b6e000",
    "LBPStrategy",
  ],
  [
    "robinhood",
    4663,
    "0xbf1ab81f7d534b2cc0da76fcf4d541322bb0e000",
    "LBPStrategy",
  ],
  [
    "avalanche",
    43114,
    "0x7575c9488ab7913e7749b9f5e02789355699e000",
    "LBPStrategy",
  ],
  ["xlayer", 196, "0xde758d7b3202b7f4f842e8313fc04bf19c6be000", "LBPStrategy"],
  ["ink", 57073, "0x0cb98d78be96d5119e49664a9f24fda22f83e000", "LBPStrategy"],
  ["arc", 5042, "0x542bcda1015485ef0b1cd11b835dc58df5102000", "LBPStrategy"],
  [
    "ethereum",
    1,
    "0xcdf73dedde5e8c2fdc9c01c18607e0b40380e000",
    "InitializerHook",
  ],
  [
    "unichain",
    130,
    "0xf44ba9c854ec0ad6a899864bdff560aad4002000",
    "InitializerHook",
  ],
  [
    "robinhood",
    4663,
    "0x5fb5229fba341dfe5a7e6a14d4809d6cf887a000",
    "InitializerHook",
  ],
  [
    "avalanche",
    43114,
    "0x602bd3e53b5e80f732b0859e90564cfcacb52000",
    "InitializerHook",
  ],
  [
    "xlayer",
    196,
    "0xcaf0443a5f171dc1dd5574ee50dd2c45274da000",
    "InitializerHook",
  ],
  [
    "ink",
    57073,
    "0x47afdd2d8591275e9df688fcacb8cf5c772ee000",
    "InitializerHook",
  ],
  [
    "arc",
    5042,
    "0x0a2bf52da5d72fd1b1cdb21abd4bd8672b512000",
    "InitializerHook",
  ],
];

export const publishedInfrastructureHooks: readonly PublishedInfrastructureHook[] =
  Object.freeze(
    deployments.map(([chain, chainId, address, kind]) =>
      Object.freeze({
        chain,
        chainId,
        address,
        name: `Liquidity Launcher ${kind}`,
        description:
          kind === "LBPStrategy"
            ? "Uniswap Liquidity Launcher migration strategy. It can act as a fallback initialization hook when the intended hookless pool already exists. Shared infrastructure, not an exclusive Pools.xyz deployment."
            : "Uniswap Liquidity Launcher hook that restricts pool initialization to its published LBPStrategy. Shared infrastructure, not an exclusive Pools.xyz deployment.",
        category: "Launches" as const,
        website: "https://uniswap.org/",
        docs: "https://github.com/Uniswap/liquidity-launcher/blob/266c18786c58822b72a7a9490f4e319294df0548/docs/DeploymentGuide.md#lbp-hook-requirement",
        sourceUrl: `${LIQUIDITY_LAUNCHER_SOURCE}#${kind.toLowerCase()}`,
      }),
    ),
  );

const byDeployment = new Map(
  publishedInfrastructureHooks.map((hook) => [
    `${hook.chain}:${hook.address}`,
    hook,
  ]),
);

/** A name or same address on another network is not identity evidence. */
export function getPublishedInfrastructureHook(deployment: {
  chain: string;
  chainId?: number;
  address: string;
}): PublishedInfrastructureHook | null {
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
