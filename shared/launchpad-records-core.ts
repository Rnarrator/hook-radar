/** Launchpads researched first (reviewed 2026-10-23). See launchpad-registry.ts for the
 * attribution rules every record here follows. */
import { poolManager } from "./launchpad-types.ts";
import type { LaunchpadRecord } from "./launchpad-types.ts";

export const coreLaunchpadRecords: readonly LaunchpadRecord[] = [
  {
    id: "bankr",
    name: "Bankr",
    website: "https://bankr.bot",
    docs: "https://docs.bankr.bot/token-launching/overview/",
    description:
      "Bankr is a chat, web and command-line wallet that can launch a token on Base, Robinhood Chain, Arbitrum or Arc from one request. Its Uniswap v4 launches run on Doppler's shared hooks; Arc launches use a separate Uniswap v3 pool.",
    status: "live",
    statusNote:
      "Bankr's public launch feed showed 50 deployed launches in about 5.6 hours on 2026-10-23: 49 on Base and 1 on Robinhood Chain, all through Doppler. Arbitrum and Arc launches are documented but none was observed.",
    relationship: "multiple",
    relationshipNote:
      "Two different launch engines sit behind Bankr. The default engine is Doppler (Uniswap v4, shared hook). The second, Bankr Launch v3, is Bankr's own Uniswap v3 launcher with no hook. Not every Bankr launch is a v4 launch.",
    unattributed: [
      "0x9982538f41f2ae29ddb9d3d9307010052984fdbb appears in every sampled Bankr/Doppler launch as a fee-schedule module. It is not a v4 hook and Bankr does not name it, so it is not attributed.",
    ],
    paths: [
      {
        id: "doppler-base",
        label: "Doppler launch on Base",
        chain: "base",
        chainId: 8453,
        uniswapVersion: "v4",
        poolKind: "hooked",
        status: "live",
        attribution: "shared-protocol",
        protocolId: "doppler",
        summary:
          "Uniswap v4 pools whose hook is Doppler's shared initializer. Bankr adds its own fee settings; the hook and its pools belong to Doppler.",
        hooks: [
          {
            address: "0xbdf938149ac6a781f94faa0ed45e6a0e984c6544",
            name: "Doppler hook initializer",
            role: "Shared hook of Doppler launches, including Bankr's",
            permissions: 0x2544,
            source: "docs",
          },
        ],
        contracts: [poolManager("base")],
        evidence: [
          {
            url: "https://docs.bankr.bot/token-launching/overview/",
            note: "Doppler is the default provider: Uniswap v4 pool with a hook that applies Bankr's fee.",
          },
          {
            url: "https://docs.doppler.lol/reference/contract-addresses.md",
            note: "Doppler publishes this initializer address for Base.",
          },
          {
            url: "https://api.bankr.bot/token-launches",
            note: "Public launch feed: recent launches are Doppler launches on Base; pool Initialize events show this hook.",
          },
        ],
      },
      {
        id: "doppler-robinhood",
        label: "Doppler launch on Robinhood Chain",
        chain: "robinhood",
        chainId: 4663,
        uniswapVersion: "v4",
        poolKind: "hooked",
        status: "live",
        attribution: "shared-protocol",
        protocolId: "doppler",
        summary:
          "Same engine as Base: Doppler's shared initializer is the pool hook, with stock-paired quotes supported.",
        hooks: [
          {
            address: "0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544",
            name: "Doppler hook initializer",
            role: "Shared hook of Doppler launches, including Bankr's",
            permissions: 0x2544,
            source: "docs",
          },
        ],
        contracts: [poolManager("robinhood")],
        evidence: [
          {
            url: "https://docs.bankr.bot/token-launching/overview/",
            note: "Robinhood Chain is the default chain for chat, social and API launches.",
          },
          {
            url: "https://docs.doppler.lol/reference/contract-addresses.md",
            note: "Doppler publishes this initializer address for Robinhood Chain.",
          },
        ],
      },
      {
        id: "doppler-arbitrum",
        label: "Doppler launch on Arbitrum",
        chain: "arbitrum",
        chainId: 42161,
        uniswapVersion: "v4",
        poolKind: "hooked",
        status: "unverified",
        attribution: "shared-protocol",
        protocolId: "doppler",
        summary:
          "Documented as WETH-paired. Bankr may serve an Arbitrum launch through its Uniswap v3 engine instead; no Bankr launch was observed on Arbitrum.",
        hooks: [
          {
            address: "0xaa7f809bb3752f715fa2e418230667c382a56544",
            name: "Doppler hook initializer",
            role: "Doppler's published Arbitrum initializer; Bankr usage not observed",
            permissions: 0x2544,
            source: "docs",
          },
        ],
        contracts: [],
        evidence: [
          {
            url: "https://docs.bankr.bot/token-launching/overview/",
            note: "Arbitrum is a launch chain; launches may use Bankr Launch v3 during rollout.",
          },
        ],
      },
      {
        id: "v3-arc",
        label: "Bankr Launch v3 on Arc",
        chain: "arc",
        chainId: 5042,
        uniswapVersion: "v3",
        poolKind: "hookless",
        status: "unverified",
        attribution: "none",
        summary:
          "One Uniswap v3 pool at the 1% fee tier quoted in USDC. No hook, so no v4 hook pool. Bankr publishes no contract addresses for it.",
        hooks: [],
        contracts: [],
        evidence: [
          {
            url: "https://docs.bankr.bot/token-launching/overview/",
            note: "Arc launches run on Bankr Launch v3: a single Uniswap v3 pool quoted in native USDC.",
          },
        ],
      },
      {
        id: "v3-arbitrum",
        label: "Bankr Launch v3 on Arbitrum",
        chain: "arbitrum",
        chainId: 42161,
        uniswapVersion: "v3",
        poolKind: "hookless",
        status: "unverified",
        attribution: "none",
        summary:
          "During rollout an Arbitrum launch that names no provider may be served by Bankr's Uniswap v3 engine. Each token records which path it took.",
        hooks: [],
        contracts: [],
        evidence: [
          {
            url: "https://docs.bankr.bot/token-launching/overview/",
            note: "While v3 rolls out on Arbitrum, an unspecified launch may use v3.",
          },
        ],
      },
    ],
    unresolved: [
      "Bankr publishes no hook, factory or v3 contract addresses; the Doppler addresses come from Doppler's documentation and on-chain pool events.",
      "Bankr-only pool counts cannot be separated from Doppler's, so no Bankr totals are shown.",
      "No Arbitrum or Arc launch was observed; those paths rest on documentation.",
    ],
  },
  {
    id: "arrows",
    name: "Arrows",
    website: "https://arrows.lol",
    docs: "https://arrows.lol/docs",
    description:
      "Arrows is a token launchpad on Robinhood Chain. Each new coin gets locked Uniswap v4 liquidity and a shared hook that can use trading fees to buy back or support the coin.",
    status: "unverified",
    statusNote:
      "The site and documentation are up, but on 2026-10-23 the shared Arrows hook had initialized no pools and the instant and bonding-curve factories had received no create calls. Only the stock-quoted path had launches (two, last on 2026-09-15). The Arc path is documented as not yet configured.",
    relationship: "own-protocol",
    relationshipNote:
      "Arrows publishes and owns its hooks and factories. The Uniswap v4 PoolManager is shared Uniswap infrastructure.",
    unattributed: [
      "Radar's RobinArrow hook (0x81785af3…e0cc) is a different token's hook; nothing links it to Arrows.",
    ],
    paths: [
      {
        id: "instant-bonding-robinhood",
        label: "Instant and bonding-curve launches on Robinhood Chain",
        chain: "robinhood",
        chainId: 4663,
        uniswapVersion: "v4",
        poolKind: "hooked",
        status: "unverified",
        attribution: "platform-hook",
        summary:
          "Instant launches open a locked v4 pool at creation; bonding launches trade on a curve and migrate into a locked v4 pool. Both attach the shared Arrow hook. No pool used it at review.",
        hooks: [
          {
            address: "0xd79ff803530dc19fae0092249eb891305392aecc",
            name: "Arrow V4 hook",
            role: "Shared hook for instant and bonding launches (per-coin pot, buybacks, locked liquidity)",
            permissions: 0x2ecc,
            source: "docs",
          },
        ],
        contracts: [
          {
            address: "0xc23fd00230ec8249a09d1484c09942ddf6f0dbfc",
            name: "ArrowInstantFactory",
            role: "Instant launch factory",
          },
          {
            address: "0xf10b1a7aadcfc7b3440eb6cc8f022c861e17c4b4",
            name: "ArrowFactory",
            role: "Bonding-curve factory",
          },
          poolManager("robinhood"),
        ],
        evidence: [
          {
            url: "https://arrows.lol/docs",
            note: "Documents the launch types, the shared Arrow v4 hook and the Robinhood Chain contract list.",
          },
        ],
      },
      {
        id: "equity-robinhood",
        label: "Stock-quoted launches on Robinhood Chain",
        chain: "robinhood",
        chainId: 4663,
        uniswapVersion: "v4",
        poolKind: "hooked",
        status: "unverified",
        attribution: "platform-hook",
        summary:
          "A parallel Uniswap v4 path for coins quoted in Robinhood stock tokens. Two launches were observed.",
        hooks: [
          {
            address: "0x490b3bac657ab693f8a41e861e0292a24d5468cc",
            name: "Arrows equity hook",
            role: "Hook for coins quoted in Robinhood stock tokens",
            permissions: 0x28cc,
            source: "docs",
          },
        ],
        contracts: [
          {
            address: "0xab63e3181b471b20cc0b91437011d139f0c89614",
            name: "Equity factory",
            role: "Creates stock-quoted tokens",
          },
        ],
        evidence: [
          {
            url: "https://arrows.lol/docs",
            note: "Equity create is documented as a parallel Uniswap v4 path.",
          },
        ],
      },
      {
        id: "arc",
        label: "Arc",
        chain: "arc",
        chainId: 5042,
        uniswapVersion: "v4",
        poolKind: "unknown",
        status: "planned",
        attribution: "none",
        summary:
          "Documentation says the Arc factories are not configured yet. No addresses are published.",
        hooks: [],
        contracts: [],
        evidence: [
          {
            url: "https://arrows.lol/docs",
            note: "States that Arc Uniswap v4 factories are not configured yet.",
          },
        ],
      },
    ],
    unresolved: [
      "The shared Arrow hook's source is not verified on the Robinhood Chain explorer.",
      "No operator, organisation or repository is named; the contracts have a single externally owned owner.",
      "Whether the instant and bonding paths are in active use is unknown: they had no activity at review.",
    ],
  },
  {
    id: "hook-family",
    name: "Hook.Family",
    website: "https://www.hook.family",
    docs: "https://www.hook.family/docs",
    description:
      "Hook.Family is a launchpad on Robinhood Chain where each new fixed-supply token gets a locked Uniswap v4 ETH pool. A shared hook charges the swap fee and shares it with the token's creator.",
    status: "live",
    statusNote:
      "Live but quiet: 99 launches exist on-chain, matching the site's count, the newest on 2026-08-10, and its own analytics showed no launches in the last 24 hours on 2026-10-23.",
    relationship: "own-protocol",
    relationshipNote:
      "Hook.Family deploys its own launcher and fee hook. The hook's source is also deployed by other operators at other addresses, so Radar's matching hook family covers more than Hook.Family.",
    paths: [
      {
        id: "robinhood",
        label: "Token launches on Robinhood Chain",
        chain: "robinhood",
        chainId: 4663,
        uniswapVersion: "v4",
        poolKind: "hooked",
        status: "live",
        attribution: "platform-hook",
        summary:
          "Pool fee is zero; the hook charges a directional buy/sell fee and splits it between the creator's reward vault and the launcher.",
        hooks: [
          {
            address: "0xd7d69905657ff6551d086ca0eb1d606a948f20cc",
            name: "EthCreatorFeeHookV3",
            role: "Fixed shared fee hook for every Hook.Family launch",
            permissions: 0x20cc,
            source: "docs",
          },
        ],
        contracts: [
          {
            address: "0xf767c3077c9e61a410e79d35f5e04e4ee1a022d5",
            name: "MemeLaunchV2",
            role: "Launcher: mints the token, opens the pool, locks liquidity",
          },
          poolManager("robinhood"),
        ],
        evidence: [
          {
            url: "https://www.hook.family/docs",
            note: "Documents the launch flow, fee hook and Robinhood Chain contract list.",
          },
        ],
      },
    ],
    unresolved: [
      "Radar's EthCreatorFeeHookV3 family mixes five deployments by different operators; only the Hook.Family address is attributed.",
      "Operator identity (Hook Labs, LLC per the site) is not linked to any other listed platform.",
    ],
  },
  {
    id: "v4-fun",
    name: "v4.fun",
    website: "https://v4.fun",
    docs: "https://v4.fun/docs",
    description:
      "v4.fun is a token launchpad on Robinhood Chain where creators launch a fixed-supply token against ETH in a Uniswap v4 pool, with fees and optional launch-rate rules enforced by a hook.",
    status: "live",
    statusNote:
      "Markets trade on-chain, but v4.fun's own status page reported its program registry as not answering on 2026-10-23 and shows no current-generation engine hook address.",
    relationship: "own-protocol",
    relationshipNote:
      "The engine hook is published by v4.fun's status page. Radar indexes it under the hooklist name AgenEngineHookV2, which that list assigns; v4.fun's own code uses different identifiers.",
    unattributed: [
      "ProgrammableLaunchFeeHook (0x720e…6080) has no first-party link to v4.fun and behaves differently from its documented design.",
      "Other AgenEngineHookV2 deployments in Radar (for example 0xa5b4…78cc) are not published by v4.fun.",
    ],
    paths: [
      {
        id: "robinhood",
        label: "Classic and programmable launches on Robinhood Chain",
        chain: "robinhood",
        chainId: 4663,
        uniswapVersion: "v4",
        poolKind: "hooked",
        status: "live",
        attribution: "platform-hook",
        summary:
          "Liquidity is locked and the Uniswap LP fee is zero. The hook takes a dynamic fee from the ETH leg and applies launch-rate windows and trade bounds.",
        hooks: [
          {
            address: "0xcf57aa494e8b99e6d9c5098e55f04b73eed278cc",
            name: "Engine hook, generation one",
            role: "Per-market fee engine and launch rules",
            permissions: 0x38cc,
            source: "status-page",
          },
        ],
        contracts: [poolManager("robinhood")],
        evidence: [
          {
            url: "https://v4.fun/status",
            note: "Publishes the engine hook address on chain 4663.",
          },
          {
            url: "https://v4.fun/docs",
            note: "Launch deploys a fixed-supply token and a Uniswap v4 ETH pool; the hook takes the fee.",
          },
          {
            url: "https://v4.fun/launch/programmable",
            note: "Programmable launches use hook rules configured by the creator.",
          },
        ],
      },
    ],
    unresolved: [
      "Whether classic and programmable launches share one hook address is not stated.",
      "No team, repository, deployer or audit is published.",
      "The v4.fun launch factory is not published; the hook's factory was not confirmed as v4.fun's.",
    ],
  },
  {
    id: "hookr-fun",
    name: "Hookr.fun",
    website: "https://hookr.fun",
    docs: "https://hookr.fun/docs",
    description:
      "Hookr is a launchpad and hook builder on Robinhood Chain. A token can open in up to eight Uniswap v4 pools at once, each running creator-chosen hook blocks such as anti-snipe limits, dynamic fees and auto-burn.",
    status: "live",
    statusNote:
      "The current release, one shared hook for every new pool, has been live since 2026-10-07. Earlier hooks still run their existing pools but are not used for new ones. Hookr's repository states the contracts are unaudited.",
    relationship: "own-protocol",
    relationshipNote:
      "Hookr publishes every hook generation in its own repository. Radar indexes the older generations under the name HookrHook and the current root only as an unnamed hook.",
    unattributed: [
      "0x5a0a05d0…28cc (in Radar's HookrModularHookV6) and 0x65d144ea…a8cc (HookrModularHookV4) appear in no Hookr deployment record and use different supporting contracts; they are not attributed.",
    ],
    paths: [
      {
        id: "current",
        label: "Current release: shared hook on Robinhood Chain",
        chain: "robinhood",
        chainId: 4663,
        uniswapVersion: "v4",
        poolKind: "hooked",
        status: "live",
        attribution: "platform-hook",
        summary:
          "Every pool of the current release runs on one shared hook that freezes each pool's hook-block terms at launch.",
        hooks: [
          {
            address: "0x89c9fb50d1f03192230ffb1c279bb6e7d3fe6acc",
            name: "HookrRoot",
            role: "Shared hook of the current release",
            permissions: 0x2acc,
            source: "official-repo",
          },
        ],
        contracts: [
          {
            address: "0x1cf2748a6670572425eabf9ab9e5bc4eb2eb8ef4",
            name: "HookrLauncher",
            role: "Launches one to eight pools per transaction",
          },
          poolManager("robinhood"),
        ],
        evidence: [
          {
            url: "https://github.com/Hookr-fun/hookr-contracts/blob/main/hookr-1/README.md",
            note: "Names HookrRoot and its permission bits as the shared hook.",
          },
          {
            url: "https://hookr.fun/updates",
            note: "Announces the current release, live since 7 October 2026.",
          },
        ],
      },
      {
        id: "modular-v2",
        label: "Modular roots (superseded for new pools)",
        chain: "robinhood",
        chainId: 4663,
        uniswapVersion: "v4",
        poolKind: "hooked",
        status: "deprecated",
        attribution: "platform-hook",
        summary:
          "The second-generation modular roots keep running the pools opened on them but are no longer used to open new pools.",
        hooks: [
          {
            address: "0xb3ca29cf721380cee8b8e4755f3865ebc68fe8cc",
            name: "HookrModularHookV6",
            role: "Default modular root",
            permissions: 0x28cc,
            source: "official-repo",
          },
          {
            address: "0xb914f955294799de4b891bd2ea8af628fa1c68cc",
            name: "HookrModularHookV6WthV5",
            role: "Arbitrage-recapture root",
            permissions: 0x28cc,
            source: "official-repo",
          },
          {
            address: "0xc7c516cd5546bcb2592fe3f8aa91c2a4ba3768cc",
            name: "Recapture root (superseded)",
            role: "First recapture root",
            permissions: 0x28cc,
            source: "official-repo",
          },
          {
            address: "0xa99902a2922014bbe2bf2dcf15742ac5104828cc",
            name: "Recapture root (superseded)",
            role: "Superseded recapture root",
            permissions: 0x28cc,
            source: "official-repo",
          },
          {
            address: "0xe5429db8f63912e632e86733905667aaeb6ea8cc",
            name: "Recapture root (superseded)",
            role: "Superseded recapture root",
            permissions: 0x28cc,
            source: "official-repo",
          },
        ],
        contracts: [],
        evidence: [
          {
            url: "https://hookr.fun/docs/previous-releases",
            note: "New pools open on the shared hook, never on the modular roots.",
          },
          {
            url: "https://raw.githubusercontent.com/Hookr-fun/hookr-contracts/main/deployments/robinhood-4663.v2.json",
            note: "Lists the default, recapture and superseded roots.",
          },
        ],
      },
      {
        id: "generations-3-5",
        label: "Launch generations 3 to 5 (legacy)",
        chain: "robinhood",
        chainId: 4663,
        uniswapVersion: "v4",
        poolKind: "hooked",
        status: "deprecated",
        attribution: "platform-hook",
        summary:
          "Earlier launch generations, still on-chain with their pools running. The current release opens new pools on a different hook.",
        hooks: [
          {
            address: "0xd0005624da88a688bcab3dbfb4d1cb23d32ca0cc",
            name: "HookrHook, generation 3",
            role: "Ten-tranche bonding-curve launches",
            permissions: 0x20cc,
            source: "official-repo",
          },
          {
            address: "0xa0f267571847ce91318798578a1bcc77d77c28cc",
            name: "HookrHook, generation 4",
            role: "Bonding-curve and instant-pool launches",
            permissions: 0x28cc,
            source: "official-repo",
          },
          {
            address: "0xe7c3461a4c762ff9db4f91bee3cf8deaafc2e8cc",
            name: "HookrHook, generation 5",
            role: "Instant-pool and auction launches",
            permissions: 0x28cc,
            source: "official-repo",
          },
        ],
        contracts: [],
        evidence: [
          {
            url: "https://raw.githubusercontent.com/Hookr-fun/hookr-contracts/main/legacy/README.md",
            note: "Every generation that went live is still on-chain; pools keep running on it.",
          },
        ],
      },
    ],
    unresolved: [
      "No team is named on the site; its official X account is @hookrfun only.",
      "The explorer's source verification was not reproduced independently.",
    ],
  },
  {
    id: "lolpad-fun",
    name: "lolpad.fun",
    website: "https://lolpad.fun",
    docs: "https://lolpad.fun/docs/",
    description:
      "lolpad is a meme-token launchpad on Arc. A new token first trades on lolpad's own bonding curve, then graduates into a Uniswap v4 pool with locked liquidity and a 1% fee hook.",
    status: "live",
    statusNote:
      "Documentation says lolpad has been in production on Arc mainnet since 2026-09-16 and its contracts have code on-chain. Pool counts and activity are unverified, and no audit is published.",
    relationship: "own-protocol",
    relationshipNote:
      "lolpad owns its curve, factory and hook. Only the post-graduation pool is a Uniswap v4 pool; the bonding-curve phase is lolpad's own contract.",
    unattributed: [
      "Radar's Arc TokenLaunchpad hook (0xa790…e000) is a different hook with different permissions and no lolpad contracts; it is not lolpad's.",
    ],
    paths: [
      {
        id: "bonding-curve",
        label: "Bonding-curve phase on Arc",
        chain: "arc",
        chainId: 5042,
        uniswapVersion: "own-curve",
        poolKind: "hookless",
        status: "live",
        attribution: "none",
        summary:
          "Before graduation a token trades on lolpad's own bonding-curve contract, not a Uniswap pool.",
        hooks: [],
        contracts: [
          {
            address: "0x3cc00950be0159967f712147933c1b9abe7bd362",
            name: "TokenFactory",
            role: "Creates each token and its bonding curve",
          },
        ],
        evidence: [
          {
            url: "https://lolpad.fun/docs/",
            note: "Tokens launch on a bonding curve and graduate to a Uniswap v4 pool.",
          },
          {
            url: "https://lolpad.fun/docs/reference/deployed-addresses.html",
            note: "Arc mainnet contract list.",
          },
        ],
      },
      {
        id: "graduated",
        label: "Graduated pool on Arc",
        chain: "arc",
        chainId: 5042,
        uniswapVersion: "v4",
        poolKind: "hooked",
        status: "live",
        attribution: "platform-hook",
        summary:
          "Graduation opens a Uniswap v4 pool with permanently locked liquidity. The hook gates initialization to graduating tokens and sweeps a flat 1% fee.",
        hooks: [
          {
            address: "0xe253dba17a96892d9e26d37438289ee54a1ce044",
            name: "LaunchpadHook",
            role: "Gates pool creation to graduating tokens; takes a 1% swap fee",
            permissions: 0x2044,
            source: "docs",
          },
        ],
        contracts: [
          {
            address: "0x28878a56941ff26c445c200a0c62ae59492893ba",
            name: "LpLocker",
            role: "Permanently locks graduated liquidity",
          },
          poolManager("arc"),
        ],
        evidence: [
          {
            url: "https://lolpad.fun/docs/contracts/launchpad-hook.html",
            note: "Documents the LaunchpadHook address, permissions and 1% fee on Arc mainnet.",
          },
        ],
      },
    ],
    unresolved: [
      "Radar holds the real hook only as an unverified discovered hook.",
      "No audit, team or repository is published in the documentation read.",
      "A separate Arc testnet deployment exists; it is not indexed and is not listed.",
    ],
  },
  {
    id: "pons",
    name: "Pons",
    website: "https://ponsfamily.com/launchpad",
    docs: "https://docs.ponsfamily.com/v2",
    description:
      "Pons is a memecoin launchpad on Robinhood Chain. Version 2 tokens trade on a bonding curve and graduate into a Uniswap v4 pool with permanently locked liquidity; version 1 launched straight into Uniswap v3 pools.",
    status: "restricted",
    statusNote:
      "Pons's version 2 documentation says public launches are closed to whitelisted creators, that audits are in progress and that the contracts are unaudited. On 2026-10-23 the factory's on-chain gate reported launches open and 640 launches from 532 deployers appeared in about 14.5 hours, so the documentation may be out of date. Treat access as restricted until Pons says otherwise.",
    relationship: "own-protocol",
    relationshipNote:
      "Pons owns its factory and one shared hook per factory stack. Version 1 is a separate, hookless Uniswap v3 design.",
    unattributed: [
      "Six more Robinhood Chain and one Arc hook that Radar names PonsV2MemeHook are not published in Pons's documentation; each is bound to a different factory and owner, so they are not attributed.",
      "NoMistakesHookV1 and PonsD09EHook mention Pons only in third-party hook-list text.",
    ],
    paths: [
      {
        id: "v2-current",
        label: "Version 2: bonding curve, then Uniswap v4",
        chain: "robinhood",
        chainId: 4663,
        uniswapVersion: "v4",
        poolKind: "hooked",
        status: "restricted",
        attribution: "platform-hook",
        summary:
          "The pool exists only after the curve graduates. One shared hook per factory stack collects the fee.",
        hooks: [
          {
            address: "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044",
            name: "Meme hook (indexed as V2MemeHook)",
            role: "Fixed shared hook of the current stack",
            permissions: 0x2044,
            source: "docs",
          },
          {
            address: "0x332f85e7e323214b2d55286414b059ebb1f2a044",
            name: "Meme hook, earlier stack (indexed as PonsV2MemeHook)",
            role: "Earlier stack; the Pons app lists a version 2 token under this address",
            permissions: 0x2044,
            source: "platform-app",
          },
        ],
        contracts: [
          {
            address: "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e",
            name: "Launch factory",
            role: "Deploys every launch and drives graduation",
          },
          poolManager("robinhood"),
        ],
        evidence: [
          {
            url: "https://docs.ponsfamily.com/v2",
            note: "Describes the curve-then-v4 design, lists the contracts and states that public launches are closed.",
          },
          {
            url: "https://ponsfamily.com/launchpad",
            note: "The app lists a version 2 token whose factory field is the earlier-stack hook.",
          },
        ],
      },
      {
        id: "v1",
        label: "Version 1: Uniswap v3 pool",
        chain: "robinhood",
        chainId: 4663,
        uniswapVersion: "v3",
        poolKind: "hookless",
        status: "deprecated",
        attribution: "none",
        summary:
          "Tokens launched straight into a Uniswap v3 WETH pool. The documentation says version 1 keeps operating for existing tokens; no new launches were seen in about twelve days, so this is marked deprecated on inference.",
        hooks: [],
        contracts: [
          {
            address: "0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb",
            name: "Version 1 factory",
            role: "Deploys the token and its Uniswap v3 pool",
          },
        ],
        evidence: [
          {
            url: "https://docs.ponsfamily.com/",
            note: "Version 1 tokens launch directly into Uniswap v3.",
          },
        ],
      },
    ],
    unresolved: [
      "Whether public version 2 launches are open is contradicted between documentation and the on-chain gate.",
      "Version 1's deprecated status is inferred from missing launches, not stated by Pons.",
      "The explorer's source verification was not reproduced independently.",
    ],
  },
  {
    id: "mint-fast",
    name: "mint.fast",
    website: "https://mint.fast",
    docs: "https://docs.mint.fast",
    description:
      "mint.fast is described by an archived copy of its home page as a memecoin launchpad on Robinhood Chain. Its live site and documentation were unreachable at review, and no contract is attributed to it.",
    status: "unverified",
    statusNote:
      "mint.fast and its documentation returned an origin error on 2026-10-23. The only first-party content recovered is an archived home page from 2026-07-18 reading “Coming soon”.",
    relationship: "unresolved",
    relationshipNote:
      "Radar indexes three hooks named MintFastHook, each tied to its own launchpad contract. The link between those contracts and the mint.fast domain rests on the name and timing only, so none is attributed.",
    unattributed: [
      "MintFastHook deployments 0x61dd…60cc, 0x84eb…20cc and 0xf2a8…c0cc on Robinhood Chain match the name only; no first-party source publishes an address.",
    ],
    paths: [
      {
        id: "robinhood",
        label: "Robinhood Chain",
        chain: "robinhood",
        chainId: 4663,
        uniswapVersion: "unknown",
        poolKind: "unknown",
        status: "unverified",
        attribution: "none",
        summary:
          "Per the archived page, a memecoin launchpad on Robinhood Chain. Launch mechanics, hooks and status could not be confirmed.",
        hooks: [],
        contracts: [],
        evidence: [
          {
            url: "https://web.archive.org/web/20260718210245/https://mint.fast/",
            note: "Archived first-party home page: “Launch, discover and trade the next wave of memecoins on Robinhood Chain.”",
          },
        ],
      },
    ],
    unresolved: [
      "Live site and documentation unreachable; no first-party documentation was retrieved.",
      "No first-party source links the domain to any on-chain contract.",
      "Current status is unknown; the last on-chain launchpad event seen was 2026-09-08.",
    ],
  },
] satisfies readonly LaunchpadRecord[];
