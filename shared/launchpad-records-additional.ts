/** Launchpads found by the second research pass (reviewed 2026-10-23). Each met
 * the bar: a first-party source, a demonstrable Uniswap v4 relationship and at
 * least one exact contract identity confirmed on-chain. See launchpad-registry.ts
 * for the attribution rules every record follows. */
import { poolManager } from "./launchpad-types.ts";
import type { LaunchpadRecord } from "./launchpad-types.ts";

export const additionalLaunchpadRecords: readonly LaunchpadRecord[] = [
  {
    id: "bonker",
    name: "Bonker",
    website: "https://bonker.wtf",
    docs: "https://bonker.wtf/docs",
    description:
      "Bonker is a token launcher on Base, Robinhood Chain and Arc. Each launch creates a Uniswap v4 pool with locked liquidity and creator rewards, started from a bot command or the web app.",
    status: "live",
    statusNote:
      "The site states it is live on Base, Robinhood Chain and Arc, and the factory and hooks have code on all three. Activity on Arc and Robinhood Chain was not measured.",
    relationship: "own-protocol",
    relationshipNote:
      "Bonker's repository says its contracts are a fork of Clanker's v4 contracts. They are separate deployments with their own factories and hooks, so Bonker's pools are not part of Clanker's.",
    paths: [
      {
        id: "base",
        label: "Bonker launches on Base",
        chain: "base",
        chainId: 8453,
        uniswapVersion: "v4",
        poolKind: "hooked",
        status: "live",
        attribution: "platform-hook",
        summary:
          "A shared dynamic-fee hook and a shared static-fee hook, both bound to Bonker's Base factory.",
        hooks: [
          {
            address: "0x963e91a45148b39737b9df10c5b897b55ca9e8cc",
            name: "Dynamic-fee hook",
            role: "Shared hook for dynamic-fee launches",
            permissions: 0x28cc,
            source: "docs",
          },
          {
            address: "0xc9156c1868e122ef5b3e6ed946e1e88ff7da68cc",
            name: "Static-fee hook",
            role: "Shared hook for static-fee launches",
            permissions: 0x28cc,
            source: "docs",
          },
        ],
        contracts: [
          {
            address: "0xd850dace6c3e3b3cf09abb92342fab681013c8cb",
            name: "Factory",
            role: "Deploys tokens and initializes pools",
          },
          poolManager("base"),
        ],
        evidence: [
          {
            url: "https://bonker.wtf/docs/contracts",
            note: "Lists the Base factory, both hooks, lockers and the PoolManager.",
          },
          {
            url: "https://raw.githubusercontent.com/bonker-wtf/contracts/main/README.md",
            note: "States the Clanker-v4 fork lineage and the Base addresses.",
          },
        ],
      },
      {
        id: "robinhood",
        label: "Bonker launches on Robinhood Chain",
        chain: "robinhood",
        chainId: 4663,
        uniswapVersion: "v4",
        poolKind: "hooked",
        status: "live",
        attribution: "platform-hook",
        summary: "The same pair of shared hooks, deployed for Robinhood Chain.",
        hooks: [
          {
            address: "0x79e394e79c54936c7582452736d18890ce1368cc",
            name: "Dynamic-fee hook",
            role: "Shared hook for dynamic-fee launches",
            permissions: 0x28cc,
            source: "docs",
          },
          {
            address: "0xbbf58750eb8cd2d24254b0af9167d6e5857fe8cc",
            name: "Static-fee hook",
            role: "Shared hook for static-fee launches",
            permissions: 0x28cc,
            source: "docs",
          },
        ],
        contracts: [
          {
            address: "0x00615d913372ad8c87a070cd7bb18e1acf9d95f3",
            name: "Factory",
            role: "Deploys tokens and initializes pools",
          },
          poolManager("robinhood"),
        ],
        evidence: [
          {
            url: "https://bonker.wtf/docs/contracts",
            note: "Robinhood Chain table: factory, both hooks, locker and PoolManager.",
          },
        ],
      },
      {
        id: "arc",
        label: "Bonker launches on Arc",
        chain: "arc",
        chainId: 5042,
        uniswapVersion: "v4",
        poolKind: "hooked",
        status: "live",
        attribution: "platform-hook",
        summary: "The same pair of shared hooks, deployed for Arc, paired with USDC.",
        hooks: [
          {
            address: "0xb084c242f382bdae5dfedcd96dc10f16603fe8cc",
            name: "Dynamic-fee hook",
            role: "Shared hook for dynamic-fee launches",
            permissions: 0x28cc,
            source: "docs",
          },
          {
            address: "0x2f26b317abb8a93cd462d2eeaf0574835835e8cc",
            name: "Static-fee hook",
            role: "Shared hook for static-fee launches",
            permissions: 0x28cc,
            source: "docs",
          },
        ],
        contracts: [
          {
            address: "0x04f034649b72e7f4f167bee683797c0c35067528",
            name: "Factory",
            role: "Deploys tokens and initializes pools",
          },
          poolManager("arc"),
        ],
        evidence: [
          {
            url: "https://bonker.wtf/docs/contracts",
            note: "Arc table: factory, both hooks, locker, PoolManager and USDC.",
          },
        ],
      },
    ],
    unresolved: [
      "Which hook variant a new launch uses by default was not established.",
      "Launch activity on Arc and Robinhood Chain is unmeasured.",
      "The Arc factory has a different owner from the Base and Robinhood factories; common control is not shown.",
    ],
  },
  {
    id: "bags",
    name: "Bags",
    website: "https://bags.fm",
    docs: "https://docs.bags.fm/robinhood/overview",
    description:
      "Bags is a launchpad on Robinhood Chain. Tokens start on a Bags bonding curve and graduate into a locked Uniswap v4 pool with one shared Bags hook; creators earn a share of the 2% trading fee.",
    status: "live",
    statusNote:
      "Inferred from published mainnet contracts and 4,446 launches counted by the factory on 2026-10-23; the documentation carries no explicit status label or audit statement.",
    relationship: "own-protocol",
    relationshipNote:
      "Bags owns its factory and its single shared hook. The curve phase is Bags's own contract; only the graduated pool is a Uniswap v4 pool.",
    unattributed: [
      "Radar's BagsV4Hook family also holds 0x2083…6ecc, which Bags does not publish and which is wired to a different factory; it is not attributed.",
    ],
    paths: [
      {
        id: "robinhood",
        label: "Graduated Bags pools on Robinhood Chain",
        chain: "robinhood",
        chainId: 4663,
        uniswapVersion: "v4",
        poolKind: "hooked",
        status: "live",
        attribution: "platform-hook",
        summary:
          "At graduation the remaining supply and the raise go into a locked full-range v4 pool. The hook charges a flat 2% on the ETH leg.",
        hooks: [
          {
            address: "0x2380abf72c17aabab76480244759ac7e2932eecc",
            name: "BagsV4Hook",
            role: "Singleton hook for every Bags pool",
            permissions: 0x2ecc,
            source: "docs",
          },
        ],
        contracts: [
          {
            address: "0xe8cc4431adf8b5a847c113ef0c6af9043219cb37",
            name: "BagsFactory",
            role: "Launch entry point and registry",
          },
          poolManager("robinhood"),
        ],
        evidence: [
          {
            url: "https://docs.bags.fm/robinhood/contracts",
            note: "Names BagsV4Hook as the singleton hook and lists the contracts for chain 4663.",
          },
          {
            url: "https://docs.bags.fm/robinhood/overview",
            note: "Describes the curve-then-v4 flow and the 2% fee.",
          },
        ],
      },
    ],
    unresolved: [
      "No explicit live, beta or audit statement in the documentation.",
      "The creation fee reads zero on-chain against a documented default.",
      "The Robinhood application URL was not confirmed.",
    ],
  },
  {
    id: "klik",
    name: "Klik",
    website: "https://klik.finance",
    docs: "https://klik.finance/docs",
    description:
      "Klik is a launchpad that opens a Uniswap v4 pool for each new token. A shared fee hook sends part of every trade fee to holders or the creator and part to KLIK buybacks.",
    status: "live",
    statusNote:
      "Documentation says the current direct-pair release is deployed on Ethereum mainnet, where the hook and engine have code. The homepage also names Base, but no first-party contract list covers Base or any other chain.",
    relationship: "own-protocol",
    relationshipNote:
      "Klik owns its hook, engine and launch gateway on Ethereum. The gateway can switch to a new engine for future launches, so older tokens may use older hooks.",
    unattributed: [
      "Hooks that third-party guides list for Klik on Base and Robinhood Chain, and Radar's other Klik-named hooks (some with different owners), are not published by Klik and are not attributed.",
    ],
    paths: [
      {
        id: "ethereum",
        label: "Direct-pair release on Ethereum",
        chain: "ethereum",
        chainId: 1,
        uniswapVersion: "v4",
        poolKind: "hooked",
        status: "live",
        attribution: "platform-hook",
        summary:
          "Each token gets a v4 pool with no LP fee. The hook takes a 1% fee on buys and sells and splits it 80/20 between holders or the creator and KLIK.",
        hooks: [
          {
            address: "0xcba49142a75da64a679f32a159f4316f11a7e0cc",
            name: "Dividend hook",
            role: "Fixed shared hook of the current engine",
            permissions: 0x20cc,
            source: "docs",
          },
        ],
        contracts: [
          {
            address: "0xfe4a23bbe27be16955f4d8599c73bac88ef647d1",
            name: "Direct-pair engine",
            role: "Launch engine bound to the hook",
          },
          {
            address: "0xca7af38b09c49a87d8a3936f47972365bf41531c",
            name: "Launch gateway",
            role: "Entry point; names the active engine",
          },
          poolManager("ethereum"),
        ],
        evidence: [
          {
            url: "https://klik.finance/docs",
            note: "Lists the current release's hook, engine and gateway on Ethereum mainnet.",
          },
        ],
      },
      {
        id: "base",
        label: "Base",
        chain: "base",
        chainId: 8453,
        uniswapVersion: "v4",
        poolKind: "unknown",
        status: "unverified",
        attribution: "none",
        summary:
          "The homepage says Klik trades on Ethereum and Base, but publishes no Base contracts, so no Base hook is attributed.",
        hooks: [],
        contracts: [],
        evidence: [
          {
            url: "https://klik.finance/",
            note: "Homepage description: trade tokens on Ethereum and Base.",
          },
        ],
      },
    ],
    unresolved: [
      "No first-party contract list covers Base, Robinhood Chain, Tempo or tokens launched before the current release.",
      "Radar holds the documented Ethereum hook as an unnamed discovered hook.",
    ],
  },
  {
    id: "solonpad",
    name: "SolonPad",
    website: "https://solonpad.fun",
    docs: "https://solonpad.fun/docs",
    description:
      "SolonPad is a launchpad on Arc that launches fixed-supply tokens straight into Uniswap v4 pools, currently without a hook, paired with USDC or tokenized stocks. An earlier version used a hook. It is not available in some jurisdictions.",
    status: "live",
    statusNote:
      "Its changelog says every new coin has launched on version 3.1, a hookless Uniswap v4 pool, since 2026-10-07. Version 3.0 is superseded for new launches. The instant and curve modes could not be verified as still offered. Not available in the US, China, Japan or sanctioned jurisdictions.",
    relationship: "multiple",
    relationshipNote:
      "SolonPad runs several engines. The current default has no hook, so those pools are invisible to a hook directory. Its instant mode uses Uniswap's shared Liquidity Launcher. Its curve mode is source-matched to Pons version 2 but is a separate deployment.",
    unattributed: [
      "The curve mode's hook shares code lineage with Pons's meme hook; the two are separate deployments and are not merged.",
    ],
    paths: [
      {
        id: "v31",
        label: "Version 3.1 (current default)",
        chain: "arc",
        chainId: 5042,
        uniswapVersion: "v4",
        poolKind: "hookless",
        status: "live",
        attribution: "none",
        summary:
          "Hookless Uniswap v4 pools at a 1% fee with standard v4 routing; collected fees are split on-chain.",
        hooks: [],
        contracts: [
          {
            address: "0xa3be3f5bb288ae83ca22a8b6cddd239a97830cbb",
            name: "V31LaunchFactory",
            role: "Creates the token and its hookless v4 pool",
          },
          poolManager("arc"),
        ],
        evidence: [
          {
            url: "https://solonpad.fun/docs/changelog",
            note: "2026-10-07: every new coin launches on version 3.1, a hookless Uniswap v4 pool.",
          },
          {
            url: "https://raw.githubusercontent.com/solonlend/solonpad-skill/main/addresses.json",
            note: "Lists the version 3.1 contracts and states the pools use no hook.",
          },
        ],
      },
      {
        id: "v30",
        label: "Version 3.0 stock-dividend stack",
        chain: "arc",
        chainId: 5042,
        uniswapVersion: "v4",
        poolKind: "hooked",
        status: "deprecated",
        attribution: "platform-hook",
        summary:
          "Superseded for new launches on 2026-10-07; existing coins stay tradable through its router.",
        hooks: [
          {
            address: "0x56071296f4aec96d61715bd906a17a05b75628cc",
            name: "V3QuoteFeeHook",
            role: "Shared quote-fee hook of the version 3.0 stack",
            permissions: 0x28cc,
            source: "official-repo",
          },
        ],
        contracts: [
          {
            address: "0xdcfbd25f034d51af797dd7c5c914f16403b54e10",
            name: "V3LaunchFactory",
            role: "Version 3.0 launch factory",
          },
        ],
        evidence: [
          {
            url: "https://raw.githubusercontent.com/solonlend/solonpad-skill/main/addresses.json",
            note: "Version 3.0 live since 2026-10-03; new launches moved to 3.1 on 2026-10-07.",
          },
        ],
      },
      {
        id: "curve",
        label: "Curve mode",
        chain: "arc",
        chainId: 5042,
        uniswapVersion: "v4",
        poolKind: "hooked",
        status: "unverified",
        attribution: "platform-hook",
        summary:
          "A bonding curve whose graduated pools use a shared meme hook. The changelog is silent on whether it is still offered.",
        hooks: [
          {
            address: "0x9d1a376de8525a2cd622b5c2ce99984f8432e044",
            name: "Curve meme hook",
            role: "Shared hook for graduated curve pools",
            permissions: 0x2044,
            source: "official-repo",
          },
        ],
        contracts: [
          {
            address: "0xd6b86b9b1bb64b941b21aaa6a0e3a673e8405a3b",
            name: "Curve launch factory",
            role: "Creates curve launches",
          },
        ],
        evidence: [
          {
            url: "https://github.com/solonlend/solonpad-skill",
            note: "Documents the curve engine's lineage and lists its addresses.",
          },
        ],
      },
    ],
    unresolved: [
      "Whether the instant (Liquidity Launcher) and curve modes are still offered is unknown.",
      "No volume figures exist: hookless pools are invisible to hook-based indexing.",
      "The operator's identity is not published; the project's X account was locked when read.",
    ],
  },
  {
    id: "umia",
    name: "Umia",
    website: "https://umia.finance",
    docs: "https://umia.finance/docs",
    description:
      "Umia is a curated platform where founders raise funds through a Uniswap continuous clearing auction that seeds a hooked Uniswap v4 pool run by the project's treasury.",
    status: "restricted",
    statusNote:
      "Curated: founders apply to launch. The Base deployment is live with 7 ventures counted on-chain on 2026-10-23. A separate Robinhood Chain deployment is also live: Umia's documentation names Slop Cash as its first venture (read on 2026-11-12).",
    relationship: "multiple",
    relationshipNote:
      "Umia's auction stage is Uniswap's continuous clearing auction, shared Uniswap infrastructure. Umia adds its own hook and liquidity bootstrapper for the v4 spot pool stage.",
    unattributed: [
      "Three further Base hooks that Radar files with Umia's hook are not listed in Umia's documentation and are not attributed.",
    ],
    paths: [
      {
        id: "base",
        label: "Auction, then hooked v4 spot pool on Base",
        chain: "base",
        chainId: 8453,
        uniswapVersion: "v4",
        poolKind: "hooked",
        status: "restricted",
        attribution: "platform-hook",
        summary:
          "After the auction, proceeds seed a v4 pool with Umia's hook attached; the hook feeds a spot price oracle and enforces pool configuration.",
        hooks: [
          {
            address: "0x128bedebaa9304db74726efba848a98e7fb53a80",
            name: "UmiaHook",
            role: "Hook attached to every Umia spot pool",
            permissions: 0x3a80,
            source: "docs",
          },
        ],
        contracts: [
          {
            address: "0x120dbcdd58bb787309573e29159fe6d37a1983f6",
            name: "UmiaHub",
            role: "Central registry; creates ventures",
          },
          poolManager("base"),
        ],
        evidence: [
          {
            url: "https://umia.finance/llms-full.txt",
            note: "Base address table names the UmiaHook attached to every spot pool and describes the curated launch track.",
          },
        ],
      },
      {
        id: "robinhood",
        label: "Separate deployment on Robinhood Chain",
        chain: "robinhood",
        chainId: 4663,
        uniswapVersion: "v4",
        poolKind: "hooked",
        status: "restricted",
        attribution: "platform-hook",
        summary:
          "Umia's documentation names UmiaHookV2 as the hook on every new spot pool on Robinhood Chain and marks the original hook as unused there. Slop Cash is its first venture.",
        hooks: [
          {
            address: "0xbea11b032bfb6d7e20b9fd975c0211ad81a03a80",
            name: "UmiaHookV2",
            role: "Hook attached to every new Umia spot pool on Robinhood Chain",
            permissions: 0x3a80,
            source: "docs",
          },
        ],
        contracts: [
          {
            address: "0x3712aff63d6f0d094b0894f2e1ff4a2637265f04",
            name: "UmiaHub",
            role: "Registry; creates ventures",
          },
          poolManager("robinhood"),
        ],
        evidence: [
          {
            url: "https://umia.finance/docs/contract-addresses/robinhood-chain",
            note: "Lists UmiaHookV2 as attached to every new spot pool, marks the original UmiaHook as legacy with no pool using it, and names Slop Cash as venture #1. Checked on-chain separately on 2026-11-12: the PoolManager's Initialize log for the SLOP / USDG pool names this hook. Pool id 0x18f3778f93a34c08d41a03e6b3a466a37ec0fd1b019e43f622927ba0c339838b, block 111,022,880, transaction 0x25e64d72e0cb87bf260fc49fcf71e750ba6795b179e0cea605e3f7e6f36b0173.",
          },
          {
            url: "https://github.com/umiafinance/protocol/blob/main/src/periphery/UmiaHookV2.sol",
            note: "Umia's source declares before-initialize, after-initialize, before-add-liquidity, before-remove-liquidity and before-swap, the flags in the address bits 0x3a80.",
          },
          {
            url: "https://umia.finance/llms-full.txt",
            note: "States that Robinhood Chain runs its own Umia deployment.",
          },
        ],
      },
    ],
    unresolved: [
      "Radar files UmiaHook under the Oracles use case, not Launches.",
      "UmiaHookV2 is named here from Umia's documentation and source. Who deployed it was not read from the chain.",
      "The original Umia hook, 0x128bedebaa9304db74726efba848a98e7fb53a80, is the live hook on Base. Umia's documentation marks it legacy on Robinhood Chain, where no pool uses it, so it is not listed there.",
      "The number of ventures on the Robinhood Chain deployment was not counted on-chain.",
      "Umia's documentation describes one application process; it does not state separately that Robinhood Chain launches are curated, so that path's status follows the platform.",
      "Whether Umia's liquidity bootstrapper contract is itself used as a hook is not established.",
    ],
  },
  {
    id: "livo",
    name: "Livo",
    website: "https://github.com/LivoLaunchpad/livo-contracts",
    docs: "https://github.com/LivoLaunchpad/livo-contracts#readme",
    description:
      "Livo is a launchpad whose tokens trade on a bonding curve, then graduate into Uniswap v4 with a shared Livo hook or into Uniswap v2. Only its GitHub repository and deployment manifests were found; no official website.",
    status: "unverified",
    statusNote:
      "The contracts and deployment manifests are first-party and verified on-chain, but no official website or documentation site was found and activity was not measured. Its repository was last updated on 2026-10-08.",
    relationship: "own-protocol",
    relationshipNote:
      "Livo owns its launchpad, graduator and hook. Graduation to Uniswap v2 creates a hookless pool; graduation to v4 uses the Livo hook.",
    unattributed: [
      "Four further LivoSwapHook deployments in Radar appear in no Livo manifest; they are not attributed.",
    ],
    paths: [
      {
        id: "ethereum",
        label: "Graduation to Uniswap v4 on Ethereum",
        chain: "ethereum",
        chainId: 1,
        uniswapVersion: "v4",
        poolKind: "hooked",
        status: "unverified",
        attribution: "platform-hook",
        summary:
          "Graduated pools take a 1% LP fee, split between the creator and the Livo treasury, with the position locked. Earlier hook versions remain on-chain.",
        hooks: [
          {
            address: "0x10392843021a1af0abe3b1a21f14673dc05340cc",
            name: "LivoSwapHook (current)",
            role: "Hook of current v4 graduations",
            permissions: 0xcc,
            source: "official-repo",
          },
          {
            address: "0x627fa6f76fa96b10bae1b6fba280a3c9264500cc",
            name: "LivoSwapHook (legacy)",
            role: "Earlier hook version",
            permissions: 0xcc,
            source: "official-repo",
          },
          {
            address: "0x068241d20c59980abeaeded990d2441f05f5c0cc",
            name: "LivoSwapHook (legacy)",
            role: "Earlier hook version",
            permissions: 0xcc,
            source: "official-repo",
          },
        ],
        contracts: [
          {
            address: "0xaa74aa89590e3b50be178ea970e490c173b61110",
            name: "LivoLaunchpad",
            role: "Launch and bonding-curve contract",
          },
          poolManager("ethereum"),
        ],
        evidence: [
          {
            url: "https://github.com/LivoLaunchpad/livo-contracts",
            note: "First-party repository with generated deployment manifests for Ethereum.",
          },
        ],
      },
      {
        id: "robinhood",
        label: "Graduation to Uniswap v4 on Robinhood Chain",
        chain: "robinhood",
        chainId: 4663,
        uniswapVersion: "v4",
        poolKind: "hooked",
        status: "unverified",
        attribution: "platform-hook",
        summary: "The same design deployed on Robinhood Chain.",
        hooks: [
          {
            address: "0xdb1902bc975992828616b0224d9c5ff907e9c0cc",
            name: "LivoSwapHook (current)",
            role: "Hook of current v4 graduations",
            permissions: 0xcc,
            source: "official-repo",
          },
        ],
        contracts: [
          {
            address: "0xfd550c5dc070ea575a06a40f2e18304d85211663",
            name: "LivoLaunchpad",
            role: "Launch and bonding-curve contract",
          },
          poolManager("robinhood"),
        ],
        evidence: [
          {
            url: "https://github.com/LivoLaunchpad/livo-contracts",
            note: "First-party deployment manifest for Robinhood Chain.",
          },
        ],
      },
    ],
    unresolved: [
      "No official website or documentation site was found; the GitHub organisation is unverified.",
      "No getter links the hook to the graduator on-chain; the link rests on the deployment manifest.",
      "Launch activity was not measured; the manifest also says Arc is not deployed.",
    ],
  },
  {
    id: "pangea",
    name: "Pangea",
    website: "https://www.pangea.trade",
    docs: "https://www.pangea.trade/app/docs",
    description:
      "Pangea launches the same token on Ethereum, Base, Robinhood Chain and BNB Chain in plain Uniswap v4 pools without hooks, and on Solana through Meteora. Hook-based launches are described as not yet live.",
    status: "live",
    statusNote:
      "Documentation says standard launches are live on all five chains and the $PANGEA token is live on each. Hook-based launches are described as having trade-offs and are not offered as a standard option.",
    relationship: "own-protocol",
    relationshipNote:
      "Pangea owns its launch factories on each chain. Its standard pools use no hook, so they do not appear in a hook directory.",
    unattributed: [
      "Radar families named Pangea (for example 0x15e5…a8cc, plus separate Base fee hooks) are not corroborated: Pangea's docs say standard launches use no hook and publish no hook address, and Pangea's own bridge rejects the factories those hooks point to. Their volume is not Pangea's.",
    ],
    paths: [
      {
        id: "ethereum",
        label: "Standard launches on Ethereum",
        chain: "ethereum",
        chainId: 1,
        uniswapVersion: "v4",
        poolKind: "hookless",
        status: "live",
        attribution: "none",
        summary: "A plain ETH pool with no hook; the trading fee is set per launch.",
        hooks: [],
        contracts: [
          {
            address: "0x1d583e6ea4aa7c5e167a7e69b07b83dd5b813f53",
            name: "Launch factory",
            role: "Deploys the token and its pool",
          },
          poolManager("ethereum"),
        ],
        evidence: [
          {
            url: "https://www.pangea.trade/app/docs",
            note: "Standard launches are plain pools with no hooks; lists the Ethereum launch factory.",
          },
        ],
      },
      {
        id: "base",
        label: "Standard launches on Base",
        chain: "base",
        chainId: 8453,
        uniswapVersion: "v4",
        poolKind: "hookless",
        status: "live",
        attribution: "none",
        summary: "A plain ETH pool with no hook.",
        hooks: [],
        contracts: [
          {
            address: "0xba4bee425f268f7dc0f7e5457d14320d5a64cd06",
            name: "Launch factory",
            role: "Deploys the token and its pool",
          },
          poolManager("base"),
        ],
        evidence: [
          {
            url: "https://www.pangea.trade/app/docs",
            note: "Lists the Base launch factory.",
          },
        ],
      },
      {
        id: "robinhood",
        label: "Standard launches on Robinhood Chain",
        chain: "robinhood",
        chainId: 4663,
        uniswapVersion: "v4",
        poolKind: "hookless",
        status: "live",
        attribution: "none",
        summary: "A plain ETH pool with no hook.",
        hooks: [],
        contracts: [
          {
            address: "0x8a1f3e1db07048c007f6d9ab924494c77c0dba65",
            name: "Launch factory",
            role: "Deploys the token and its pool",
          },
          poolManager("robinhood"),
        ],
        evidence: [
          {
            url: "https://www.pangea.trade/app/docs",
            note: "Lists the Robinhood Chain launch factory.",
          },
        ],
      },
      {
        id: "bnb",
        label: "Standard launches on BNB Chain",
        chain: "bnb",
        chainId: 56,
        uniswapVersion: "v4",
        poolKind: "hookless",
        status: "live",
        attribution: "none",
        summary: "A plain BNB pool with no hook.",
        hooks: [],
        contracts: [
          {
            address: "0xd1454764e8d87b117a23491e77cafccc50430256",
            name: "Launch factory",
            role: "Deploys the token and its pool",
          },
          poolManager("bnb"),
        ],
        evidence: [
          {
            url: "https://www.pangea.trade/app/docs",
            note: "Lists the BNB Chain launch factory.",
          },
        ],
      },
    ],
    unresolved: [
      "Whether any Pangea launch carries a hook is not established; resolving it needs each launch's pool key.",
      "Pangea's Solana launches use Meteora, not Uniswap, and are outside this directory.",
    ],
  },
] satisfies readonly LaunchpadRecord[];
