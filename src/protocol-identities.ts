/** First-party deployment evidence for protocol artwork, reviewed 20 October 2026
 * (ICT). Original sources and exact rules are recorded in protocols/sources.json.
 * These identify artwork only, not safety, an audit or an endorsement. */
export interface VerifiedProtocolFamily {
  readonly name: string;
  readonly brand: string;
  readonly deployments: readonly {
    readonly chain: string;
    readonly chainId: number;
    readonly address: string;
  }[];
}

export const verifiedProtocolFamilies: Readonly<
  Record<string, VerifiedProtocolFamily>
> = {
  "hook-b5c8622fb7bf89767e69": {
    name: "Claus",
    brand: "claus",
    deployments: [
      {
        chain: "ethereum",
        chainId: 1,
        address: "0x37bfb8ac7c960e558657871d41ca70e07e7dbfff",
      },
    ],
  },
  "hook-85a7ef280bfea367afb6": {
    name: "VectisHook",
    brand: "vectis",
    deployments: [
      {
        chain: "robinhood",
        chainId: 4663,
        address: "0x4201ec638f68b59fc2a9fdbeb5abfec834f16800",
      },
    ],
  },
  "hook-9f3ecf78e2c0ffbb51ee": {
    name: "UPeg Hook",
    brand: "unipeg",
    deployments: [
      {
        chain: "ethereum",
        chainId: 1,
        address: "0xe54082dfbf044b6a8f584bdddb90a22d5613c440",
      },
    ],
  },
  "hook-784f15df27ab57584604": {
    name: "UniswapV4KEMHook",
    brand: "kyberswap",
    deployments: [
      {
        chain: "arbitrum",
        chainId: 42161,
        address: "0x4440854b2d02c57a0dc5c58b7a884562d875c0c4",
      },
      {
        chain: "base",
        chainId: 8453,
        address: "0x4440854b2d02c57a0dc5c58b7a884562d875c0c4",
      },
      {
        chain: "bnb",
        chainId: 56,
        address: "0x4440854b2d02c57a0dc5c58b7a884562d875c0c4",
      },
      {
        chain: "ethereum",
        chainId: 1,
        address: "0x4440854b2d02c57a0dc5c58b7a884562d875c0c4",
      },
      {
        chain: "monad",
        chainId: 143,
        address: "0x4445520306c9c70952bdfec28f3989f53d9f80c4",
      },
      {
        chain: "robinhood",
        chainId: 4663,
        address: "0x4445520306c9c70952bdfec28f3989f53d9f80c4",
      },
      {
        chain: "unichain",
        chainId: 130,
        address: "0x444139d6b32c1ad0b00f24a616072f74b2f880c4",
      },
    ],
  },
  "hook-46753a2889dd28d7f9ba": {
    name: "FablesRampETH",
    brand: "fables",
    deployments: [
      {
        chain: "robinhood",
        chainId: 4663,
        address: "0x06a889870c8f83640d6816319f72e2aa579b6080",
      },
      {
        chain: "robinhood",
        chainId: 4663,
        address: "0x594e8e6281edf2d363a0293a50004cf868e7a080",
      },
    ],
  },
  "hook-cd9943f048c9cf55634f": {
    name: "FablesRWA",
    brand: "fables",
    deployments: [
      {
        chain: "robinhood",
        chainId: 4663,
        address: "0x5eb87f69be00df39981622fd60a8de4b7837e080",
      },
      {
        chain: "robinhood",
        chainId: 4663,
        address: "0x70a9a88402989226847ec122043ce5e7ff462080",
      },
      {
        chain: "robinhood",
        chainId: 4663,
        address: "0x79576fbad6e83915630bbb5d5658483f05532080",
      },
      {
        chain: "robinhood",
        chainId: 4663,
        address: "0xa0e8fbff13e24af2b5e61a72800e08a161bde080",
      },
      {
        chain: "robinhood",
        chainId: 4663,
        address: "0xa4570c37590e45f0b06898123d4de16307a32080",
      },
      {
        chain: "robinhood",
        chainId: 4663,
        address: "0xb608a78761f179f7c56f15e7d13921b92f00a080",
      },
    ],
  },
  "hook-bfb5c857a160e2ad17b6": {
    name: "FablesRamp",
    brand: "fables",
    deployments: [
      {
        chain: "robinhood",
        chainId: 4663,
        address: "0x08e52564bad99e05a694b4809f397edca417a080",
      },
    ],
  },
  "hook-c94f7a210769e8bca1d9": {
    name: "FablesRWAETH",
    brand: "fables",
    deployments: [
      {
        chain: "robinhood",
        chainId: 4663,
        address: "0xca89f079af00f752bfd3c345358dc38d4d73e080",
      },
    ],
  },
  "hook-0d21f16c066772d5c444": {
    name: "HookrModularHookV6",
    brand: "hookr",
    deployments: [
      {
        chain: "robinhood",
        chainId: 4663,
        address: "0xb3ca29cf721380cee8b8e4755f3865ebc68fe8cc",
      },
    ],
  },
  "hook-6356b143da0c80c73de3": {
    name: "HookrModularHookV6WthV5",
    brand: "hookr",
    deployments: [
      {
        chain: "robinhood",
        chainId: 4663,
        address: "0xb914f955294799de4b891bd2ea8af628fa1c68cc",
      },
    ],
  },
  "hook-d3a89f69ff33dd42ad66": {
    name: "V2MemeHook",
    brand: "pons",
    deployments: [
      {
        chain: "robinhood",
        chainId: 4663,
        address: "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044",
      },
    ],
  },
  "hook-a2f9ac5336e13b7283b6": {
    name: "CashCatHookV2",
    brand: "letscash",
    deployments: [
      {
        chain: "robinhood",
        chainId: 4663,
        address: "0x75a54357d9c78a2db19004a5fdc76c50f9242aec",
      },
    ],
  },
  "hook-0718f4800ae0cf89eb90": {
    name: "UmiaHook",
    brand: "umia",
    deployments: [
      {
        chain: "base",
        chainId: 8453,
        address: "0x128bedebaa9304db74726efba848a98e7fb53a80",
      },
    ],
  },
  "hook-5c0219d4564a44c578a1": {
    name: "FWATokenHook",
    brand: "fwa",
    deployments: [
      {
        chain: "ethereum",
        chainId: 1,
        address: "0x2c67eba8a50af0db5fba55f725247a75cbda6444",
      },
    ],
  },
  "hook-de7be01aacfc7f7aa086": {
    name: "Coinbase Verified Hook",
    brand: "coinbase",
    deployments: [
      {
        chain: "base",
        chainId: 8453,
        address: "0x5cd525c621afca515bf58631d4733fba7b72aae4",
      },
    ],
  },
  "hook-e08eb20927f96628a999": {
    name: "SlvrHook",
    brand: "slvr",
    deployments: [
      {
        chain: "robinhood",
        chainId: 4663,
        address: "0x64c6103255ccc638febe3619aeb52d2b59d6a0cc",
      },
    ],
  },
  "hook-7070dc9f296e97ae2a7a": {
    name: "VirtualLBPStrategyBasic",
    brand: "aztec",
    deployments: [
      {
        chain: "ethereum",
        chainId: 1,
        address: "0xd53006d1e3110fd319a79aeec4c527a0d265e080",
      },
    ],
  },
  "hook-daebeb56e66e791e7d8c": {
    name: "TokenWorks Hook v2",
    brand: "tokenworks",
    deployments: [
      {
        chain: "ethereum",
        chainId: 1,
        address: "0xbd15e4d324f8d02479a5ff53b52ef4048a79e444",
      },
    ],
  },
  "hook-e26394cebf2e7851fb32": {
    name: "TokenWorks Hook v3",
    brand: "tokenworks",
    deployments: [
      {
        chain: "ethereum",
        chainId: 1,
        address: "0xd6a45df0c82c9a686ab1e58fb28d8fc0cf106444",
      },
    ],
  },
  "hook-0961e788a26e6dc0e45d": {
    name: "TokenWorks Hook v4",
    brand: "tokenworks",
    deployments: [
      {
        chain: "ethereum",
        chainId: 1,
        address: "0xe3c63a9813ac03be0e8618b627cb8170cfa468c4",
      },
    ],
  },
};
