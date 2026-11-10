import { createHash } from "node:crypto";
import { aggregateCurrentMarketsSteps } from "../shared/market-freshness.ts";
import { getOfficialHook, officialHooks } from "../shared/official-hooks.ts";
import {
  createPublishedPlatformProjects,
  getPublishedInfrastructureHook,
} from "../shared/published-platform-hooks.ts";
import { directoryDynamicFees } from "./census-hook-directory.mjs";
import {
  runSynchronously,
  runCooperatively,
  cooperativeSortSteps,
} from "./cooperative.mjs";

export const REGISTRY_URL =
  "https://raw.githubusercontent.com/Uniswap/hooklist/main/hooklist.json";
export const CHAINS_URL =
  "https://raw.githubusercontent.com/Uniswap/hooklist/main/chains.json";
export const FRONTIER_URL = "https://api.frontier.fun/chains";
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const isAddress = (value) =>
  typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
export const isPoolId = (value) =>
  typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
export const cleanText = (value, max = 2000) =>
  typeof value === "string"
    ? value
        .replace(
          /&(amp|lt|gt|quot|apos|nbsp|#(?:\d{1,7}|x[0-9a-f]{1,6}));/gi,
          (literal, entity) => {
            const names = {
              amp: "&",
              lt: "<",
              gt: ">",
              quot: '"',
              apos: "'",
              nbsp: " ",
            };
            if (entity[0] !== "#")
              return names[entity.toLowerCase()] || literal;
            const number =
              entity[1].toLowerCase() === "x"
                ? parseInt(entity.slice(2), 16)
                : Number(entity.slice(1));
            return number > 0 &&
              number <= 0x10ffff &&
              !(number >= 0xd800 && number <= 0xdfff)
              ? String.fromCodePoint(number)
              : literal;
          },
        )
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
        .trim()
        .slice(0, max)
    : "";
export function safeUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export function numberOrNull(value) {
  if (
    typeof value !== "number" &&
    (typeof value !== "string" ||
      !/^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))
  )
    return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}
export const digest = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex")
    .slice(0, 20);
const FLAG_NAMES = [
  "beforeInitialize",
  "afterInitialize",
  "beforeAddLiquidity",
  "afterAddLiquidity",
  "beforeRemoveLiquidity",
  "afterRemoveLiquidity",
  "beforeSwap",
  "afterSwap",
  "beforeDonate",
  "afterDonate",
  "beforeSwapReturnsDelta",
  "afterSwapReturnsDelta",
  "afterAddLiquidityReturnsDelta",
  "afterRemoveLiquidityReturnsDelta",
];
const decodedFlags = new Map();
const EMPTY_HISTORY = Object.freeze([]);
const UNAVAILABLE_METRICS = Object.freeze({
  poolCount: null,
  liquidityUsd: null,
  volumeUsd: Object.freeze({ h1: null, h6: null, h24: null }),
  coverage: "unavailable",
  note: "No exact hook-attributed market metrics are available in the current measured sample.",
});
const discoveredProperties = [false, true].map((dynamicFee) =>
  Object.freeze({
    dynamicFee,
    upgradeable: false,
    requiresCustomSwapData: false,
    vanillaSwap: false,
    swapAccess: "unknown",
  }),
);
export function decodeFlags(address) {
  if (!isAddress(address)) throw new Error("Invalid hook address");
  const bits = Number(BigInt(address) & 16383n);
  if (decodedFlags.has(bits)) return decodedFlags.get(bits);
  const result = Object.freeze(
    Object.fromEntries(
      FLAG_NAMES.map((flag, index) => [
        flag,
        (bits & (1 << (13 - index))) !== 0,
      ]),
    ),
  );
  decodedFlags.set(bits, result);
  return result;
}

const CHAIN_INFO = {
  ethereum: ["Ethereum", "https://etherscan.io"],
  unichain: ["Unichain", "https://uniscan.xyz"],
  base: ["Base", "https://basescan.org"],
  arbitrum: ["Arbitrum", "https://arbiscan.io"],
  optimism: ["Optimism", "https://optimistic.etherscan.io"],
  polygon: ["Polygon", "https://polygonscan.com"],
  blast: ["Blast", "https://blastscan.io"],
  worldchain: ["World Chain", "https://worldscan.org"],
  avalanche: ["Avalanche", "https://snowtrace.io"],
  bnb: ["BNB Chain", "https://bscscan.com"],
  celo: ["Celo", "https://celoscan.io"],
  zora: ["Zora", "https://explorer.zora.energy"],
  ink: ["Ink", "https://explorer.inkonchain.com"],
  soneium: ["Soneium", "https://soneium.blockscout.com"],
  linea: ["Linea", "https://lineascan.build"],
  monad: ["Monad", "https://monadscan.com"],
  robinhood: ["Robinhood", "https://robinhoodchain.blockscout.com"],
  megaeth: ["MegaETH", "https://megaeth.blockscout.com"],
  arc: ["Arc", "https://explorer.arc.io"],
  tempo: ["Tempo", "https://explore.tempo.xyz"],
  xlayer: ["X Layer", "https://www.oklink.com/xlayer"],
  zksync: ["ZKsync", "https://explorer.zksync.io"],
  hyperevm: ["HyperEVM", "https://hyperevmscan.io"],
};

// Group only identifiable contract families. Anonymous names never imply a shared builder.
const PROJECTS = [
  {
    id: "frontier",
    name: "Frontier",
    match: /frontier/i,
    category: "Launches",
    description:
      "Configurable token markets with dynamic fees and ordered pool extensions.",
    website: "https://frontier.fun",
    docs: "https://docs.frontier.fun",
  },
  {
    id: "clanker",
    name: "Clanker",
    match: /^clanker(?:\b|hook)/i,
    category: "Launches",
    description:
      "Token launch markets with static and dynamic fee hook implementations.",
    website: "https://clanker.world",
    docs: "https://docs.clanker.world",
  },
  {
    id: "flaunch",
    name: "Flaunch",
    match: /flaunch/i,
    // Used when createDirectory is asked for strictFamilyNames (the static
    // edition's collector). Every recorded Flaunch deployment is named
    // "Flaunch …" or "AnyPositionManager (Flaunch …)"; the unanchored rule above
    // also matches the "fLaunch" inside the unrelated "ProofLaunchHook".
    strictMatch: /\bflaunch/i,
    category: "Launches",
    description:
      "Hook-powered token launches with configurable market and fee mechanics.",
    website: "https://flaunch.gg",
    docs: "https://docs.flaunch.gg",
  },
  {
    id: "zora",
    name: "Zora",
    match: /^zora(?:\b|v4|hook)/i,
    category: "Launches",
    description: "Creator and content coin markets on Uniswap v4.",
    website: "https://zora.co",
    docs: "https://docs.zora.co",
  },
  {
    id: "bunni",
    name: "Bunni",
    match: /^bunni/i,
    category: "Liquidity",
    description: "Programmable liquidity distribution and custom swap logic.",
    website: "https://bunni.xyz",
    docs: "https://docs.bunni.xyz",
  },
  {
    id: "eulerswap",
    name: "EulerSwap",
    match: /^eulerswap/i,
    category: "Liquidity",
    description: "Swap liquidity integrated with Euler lending vaults.",
    website: "https://www.euler.finance",
    docs: "https://docs.euler.finance",
  },
  {
    id: "angstrom",
    name: "Angstrom",
    match: /^angstrom/i,
    category: "MEV",
    description:
      "Auction and order sequencing mechanics for MEV-aware trading.",
    website: "https://sorellalabs.xyz",
    docs: "https://docs.angstrom.so",
  },
  {
    id: "doppler",
    name: "Doppler",
    match:
      /^(doppler|uniswapv4(?:scheduled)?multicurveinitializerhook|decaymulticurveinitializerhook|uniswapv4migratorhook)/i,
    category: "Launches",
    description: "Hook-based token launches and liquidity initialization.",
    website: "https://www.doppler.lol",
    docs: "https://docs.doppler.lol",
  },
  {
    id: "arrakis",
    name: "Arrakis",
    match: /^arrakis/i,
    category: "Liquidity",
    description: "Private hook integrations for managed liquidity strategies.",
    website: "https://arrakis.finance",
    docs: "https://docs.arrakis.finance",
  },
  {
    id: "aegis",
    name: "Aegis",
    match: /^aegis/i,
    category: "Fees",
    description: "Adaptive fee implementations for Uniswap v4 markets.",
    website: null,
    docs: null,
  },
  {
    id: "alphix",
    name: "Alphix",
    match: /^alphix/i,
    category: "Fees",
    description: "Dynamic fee and liquidity integrations.",
    website: null,
    docs: null,
  },
  {
    id: "coala",
    name: "Coala",
    match: /^coala/i,
    category: "Liquidity",
    description: "Multi-chain hook implementations.",
    website: null,
    docs: null,
  },
];
const GENERIC =
  /^(?:hook|customhook|dynamicfee(?:hook(?:v\d+)?)?|feehook(?:v\d+)?|defaultHook|testhook|basehookmock|counter|noOp|swap|swaphook|launchhook(?:v\d+)?|erc1967proxy(?: hook)?|transparentupgradeableproxy(?: hook)?|beaconproxy(?: hook)?|publictransparentupgradeableproxy)$/i;
const GENERIC_WORDS = new Set(
  "hook hooks fee fees tax taxes limit order orders swap swaps uniswap uni v test custom default static dynamic adaptive volatility asymmetric decay timed time before after initialize returns delta access control whitelist allowlist blacklist blocklist permissioned pool pools initializer initialization factory mock counter noop no op launch launchpad token tokens creator protocol owner quote asset proxy transparent upgradeable erc1967 beacon public minimal simple universal curve bonding migrator migrate liquidity position manager posm twamm dca oracle twap atomic async auth guard slippage trading priority gas jit lvr mev burn buyback constant product sum combined configurable external lending strategy stable stablecoin principal protection wrap wrapper auto".split(
    " ",
  ),
);
function genericContractName(name) {
  if (GENERIC.test(name)) return true;
  const words = name
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter(Boolean);
  return (
    words.length > 0 &&
    words.every(
      (word) => GENERIC_WORDS.has(word) || /^(?:v?\d+|erc\d+)$/.test(word),
    )
  );
}
export function projectIdentity(
  deployment,
  { strictFamilyNames = false } = {},
) {
  // A published name enriches a previously anonymous, exact onchain identity.
  // Keep its chain/address digest stable for saved links and pool ownership.
  if (["onchain", "published"].includes(deployment.discovery)) {
    const published =
      getOfficialHook(deployment) || getPublishedInfrastructureHook(deployment);
    if (published)
      return {
        id: `hook-${digest(`${deployment.chainId}:${deployment.address.toLowerCase()}`)}`,
        name: published.name,
        category: published.category,
        description: published.description,
        website: published.website,
        docs: published.docs,
      };
  }
  const known = PROJECTS.find((project) =>
    (strictFamilyNames && project.strictMatch
      ? project.strictMatch
      : project.match
    ).test(deployment.name),
  );
  if (known) return known;
  const normalized = deployment.name
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const unique =
    deployment.discovery === "onchain" || genericContractName(normalized)
      ? `${deployment.chainId}:${deployment.address}`
      : normalized.toLowerCase();
  return {
    id: `hook-${digest(unique)}`,
    name: normalized || `Hook ${deployment.address.slice(0, 8)}`,
    category: inferCategory(`${deployment.name} ${deployment.description}`),
    description:
      deployment.description ||
      "Registry deployment. No project description has been published.",
    website: null,
    docs: null,
  };
}
function inferCategory(text) {
  text = text.replace(/([a-z])([A-Z])/g, "$1 $2");
  if (/launch|creator|bonding curve|graduat|token factory/i.test(text))
    return "Launches";
  if (/limit order|twamm|dca|order book/i.test(text)) return "Orders";
  if (/oracle|twap|price feed/i.test(text)) return "Oracles";
  if (/mev|auction|lvr|arbitrage/i.test(text)) return "MEV";
  const accessText = text.replace(
    /\b(?:no|without)\s+(?:\w+\s+){0,2}(?:access\s+control|allowlist|whitelist|blacklist|blocklist|(?:swap|trading)\s+restrictions?)\b/gi,
    "",
  );
  if (
    /\b(?:allowlist|whitelist|blacklist|blocklist)(?:ed|ing)?\b|\bpermissioned\s+(?:swaps?|pools?|trading|markets?)\b|\baccess\s+control(?:led)?\b|\brestrict(?:ed|s)?\s+(?:swaps?|trading|access)\b|\bauthorized\s+(?:callers?|senders?|traders?|users?)\b/i.test(
      accessText,
    )
  )
    return "Access";
  if (/liquidity|yield|vault|rebalanc|lending/i.test(text)) return "Liquidity";
  if (/fee|tax|volatility/i.test(text)) return "Fees";
  return "Other";
}

export function validateRegistry(data) {
  if (!Array.isArray(data) || data.length < 1 || data.length > 50000)
    throw new Error("Registry is empty or has an unexpected shape");
  const valid = data.filter(
    (row) =>
      row &&
      isAddress(row.hook?.address) &&
      row.hook.address.toLowerCase() !== ZERO_ADDRESS &&
      Number.isSafeInteger(row.hook.chainId) &&
      row.hook.chainId > 0 &&
      typeof row.hook.chain === "string",
  );
  if (valid.length < data.length * 0.9)
    throw new Error("Registry contained too many invalid deployments");
  return valid.length === data.length ? data : valid;
}
export function validateChains(data) {
  if (!data || Array.isArray(data) || typeof data !== "object")
    throw new Error("Chain registry has an unexpected shape");
  const entries = Object.entries(data).filter(
    ([slug, row]) =>
      /^[a-z0-9-]{1,40}$/.test(slug) &&
      Number.isSafeInteger(row?.chainId) &&
      row.chainId > 0,
  );
  if (!entries.length) throw new Error("No valid chains found");
  return Object.fromEntries(entries);
}
export function validateFrontier(data) {
  if (!Array.isArray(data))
    throw new Error("Frontier chain registry has an unexpected shape");
  return data.filter(
    (chain) =>
      Number.isSafeInteger(chain?.id) &&
      isAddress(chain?.contracts?.univ4?.hook),
  );
}

export function* createDirectorySteps(
  registry,
  chainData,
  frontierChains = [],
  discoveredPools = [],
  {
    includePlatforms = false,
    strictFamilyNames = false,
    includeOfficialHooks = false,
  } = {},
) {
  let operations = 0;
  const chainMap = new Map(
    Object.entries(chainData).map(([slug, row]) => {
      const info = CHAIN_INFO[slug] || [
        slug.replace(
          /(^|-)([a-z])/g,
          (_m, separator, character) =>
            `${separator ? " " : ""}${character.toUpperCase()}`,
        ),
        "",
      ];
      return [
        row.chainId,
        { id: row.chainId, slug, name: info[0], explorer: info[1] },
      ];
    }),
  );
  for (const row of frontierChains)
    if (!chainMap.has(row.id))
      chainMap.set(row.id, {
        id: row.id,
        slug: cleanText(row.verboseId, 40),
        name: cleanText(row.name, 80),
        explorer: safeUrl(row.explorers?.[0]) || "",
      });
  const deployments = new Map();
  const frontierDeploymentIds = new Set();
  for (const row of registry) {
    if (++operations % 1024 === 0) yield;
    const hook = row.hook;
    const chain = chainMap.get(hook.chainId) || {
      id: hook.chainId,
      slug: hook.chain,
      name: hook.chain,
      explorer: "",
    };
    if (!chainMap.has(chain.id)) chainMap.set(chain.id, chain);
    const address = hook.address.toLowerCase();
    const id = `${hook.chainId}:${address}`;
    const name = cleanText(hook.name, 180) || `Hook ${address.slice(0, 10)}`;
    deployments.set(id, {
      id,
      address,
      chain: chain.slug,
      chainId: chain.id,
      name,
      description: cleanText(hook.description),
      verifiedSource: hook.verifiedSource === true,
      flags: decodeFlags(address),
      properties: {
        dynamicFee: row.properties?.dynamicFee === true,
        upgradeable: row.properties?.upgradeable === true,
        requiresCustomSwapData: row.properties?.requiresCustomSwapData === true,
        vanillaSwap: row.properties?.vanillaSwap === true,
        swapAccess: cleanText(row.properties?.swapAccess, 60) || "unknown",
      },
      auditUrl: safeUrl(hook.auditUrl),
      sourceUrl: REGISTRY_URL,
      explorerUrl: chain.explorer
        ? `${chain.explorer}/address/${address}`
        : `https://sourcify.dev/#/lookup/${address}?chainId=${chain.id}`,
    });
  }
  // Current platform addresses are explicit configuration evidence, not an audit claim.
  for (const chain of frontierChains) {
    const current = chainMap.get(chain.id);
    for (const address of [
      chain.contracts.univ4.hook,
      ...(Array.isArray(chain.contracts.univ4.legacyHooks)
        ? chain.contracts.univ4.legacyHooks
        : []),
    ].filter(isAddress)) {
      const lower = address.toLowerCase();
      const id = `${chain.id}:${lower}`;
      frontierDeploymentIds.add(id);
      if (!deployments.has(id))
        deployments.set(id, {
          id,
          address: lower,
          chain: current.slug,
          chainId: chain.id,
          name: "Frontier Hook",
          description:
            "Hook deployment identified by Frontier’s published chain configuration. Configuration metadata is not an independent audit.",
          verifiedSource: false,
          flags: decodeFlags(lower),
          properties: {
            dynamicFee: chain.contracts.univ4.pool?.fee === 8388608,
            upgradeable: false,
            requiresCustomSwapData: false,
            vanillaSwap: false,
            swapAccess: "unknown",
          },
          auditUrl: null,
          sourceUrl: FRONTIER_URL,
          explorerUrl: `${current.explorer}/address/${lower}`,
        });
    }
  }
  // Census discoveries retain their chain/address identity. A documented exact
  // deployment can supply its name without changing unknown control metadata.
  for (const pool of discoveredPools) {
    if (++operations % 1024 === 0) yield;
    if (
      !isAddress(pool?.hookAddress) ||
      pool.hookAddress.toLowerCase() === ZERO_ADDRESS ||
      !isPoolId(pool.address)
    )
      continue;
    const chain = chainMap.get(pool.chainId);
    if (!chain) continue;
    const address = pool.hookAddress.toLowerCase();
    const id = `${pool.chainId}:${address}`;
    if (deployments.has(id)) {
      const existing = deployments.get(id);
      if (
        ["onchain", "published"].includes(existing.discovery) &&
        directoryDynamicFees(pool)
      )
        existing.properties = discoveredProperties[1];
      continue;
    }
    const deploymentKey = {
      chain: chain.slug,
      chainId: chain.id,
      address,
    };
    const published =
      getOfficialHook(deploymentKey) ||
      getPublishedInfrastructureHook(deploymentKey);
    deployments.set(id, {
      id,
      address,
      chain: chain.slug,
      chainId: chain.id,
      name:
        published?.name || `Hook ${address.slice(0, 10)}…${address.slice(-6)}`,
      description:
        published?.description ||
        "Discovered from a PoolManager initialization event. Project identity and contract source have not been verified.",
      verifiedSource: false,
      discovery: published ? "published" : "onchain",
      flags: decodeFlags(address),
      properties: discoveredProperties[Number(directoryDynamicFees(pool))],
      auditUrl: null,
      sourceUrl:
        published?.sourceUrl ||
        safeUrl(pool.sourceUrl) ||
        "https://developers.uniswap.org/docs/protocols/v4/deployments",
      explorerUrl: chain.explorer
        ? `${chain.explorer}/address/${address}`
        : `https://sourcify.dev/#/lookup/${address}?chainId=${chain.id}`,
    });
  }
  // The first-party list names these exact deployments. The live directory
  // reaches each through a pool its census saw; a caller that sees only the
  // pools it measured (the static edition's collector) asks for them here, so a
  // listed hook is in the directory whether or not a pool of it is known. The
  // deployment is the one a pool would have created, and nothing is known about
  // its fee settings, so it is not tagged as dynamic. A hook already present, or
  // on a network the directory names differently, is left as it is.
  if (includeOfficialHooks)
    for (const hook of officialHooks) {
      if (++operations % 1024 === 0) yield;
      const address = hook.address.toLowerCase();
      const id = `${hook.chainId}:${address}`;
      if (deployments.has(id)) continue;
      if (!chainMap.has(hook.chainId)) {
        const info = CHAIN_INFO[hook.chain];
        chainMap.set(hook.chainId, {
          id: hook.chainId,
          slug: hook.chain,
          name: info?.[0] ?? hook.chain,
          explorer: info?.[1] ?? "",
        });
      }
      const chain = chainMap.get(hook.chainId);
      const published = getOfficialHook({
        chain: chain.slug,
        chainId: chain.id,
        address,
      });
      if (!published) continue;
      deployments.set(id, {
        id,
        address,
        chain: chain.slug,
        chainId: chain.id,
        name: published.name,
        description: published.description,
        verifiedSource: false,
        discovery: "published",
        flags: decodeFlags(address),
        properties: discoveredProperties[0],
        auditUrl: null,
        sourceUrl: published.sourceUrl,
        explorerUrl: chain.explorer
          ? `${chain.explorer}/address/${address}`
          : `https://sourcify.dev/#/lookup/${address}?chainId=${chain.id}`,
      });
    }
  const projects = new Map();
  for (const deployment of deployments.values()) {
    if (++operations % 1024 === 0) yield;
    const identity = frontierDeploymentIds.has(deployment.id)
      ? PROJECTS[0]
      : projectIdentity(deployment, { strictFamilyNames });
    if (!projects.has(identity.id))
      projects.set(identity.id, {
        id: identity.id,
        name: identity.name,
        description: identity.description,
        category: identity.category,
        website: identity.website,
        docs: identity.docs,
        sourceUrl: deployment.sourceUrl,
        deployments: [],
        chains: [],
        metrics: UNAVAILABLE_METRICS,
        history: EMPTY_HISTORY,
      });
    const project = projects.get(identity.id);
    project.deployments.push(deployment);
    if (!project.chains.includes(deployment.chain))
      project.chains.push(deployment.chain);
  }
  if (includePlatforms)
    for (const platform of createPublishedPlatformProjects(
      Object.fromEntries(
        [...chainMap.values()].map((chain) => [
          chain.slug,
          { chainId: chain.id },
        ]),
      ),
    ))
      if (!projects.has(platform.id)) projects.set(platform.id, platform);
  const knownIds = new Set(PROJECTS.map((project) => project.id));
  return {
    chains: [...chainMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
    projects: yield* cooperativeSortSteps(
      [...projects.values()],
      (a, b) =>
        Number(knownIds.has(b.id)) - Number(knownIds.has(a.id)) ||
        a.name.localeCompare(b.name),
    ),
  };
}

export function createDirectory(...args) {
  return runSynchronously(createDirectorySteps(...args));
}
export function createDirectoryAsync(...args) {
  return runCooperatively(createDirectorySteps(...args));
}

export function* attributePoolsSteps(pools, projects, { ownershipCache } = {}) {
  let operations = 0;
  const eligible = [];
  const keys = [];
  const wanted = new Set();
  for (const pool of pools) {
    if (++operations % 1024 === 0) yield;
    if (!(
      pool &&
      isAddress(pool.hookAddress) &&
      pool.hookAddress.toLowerCase() !== ZERO_ADDRESS &&
      (isPoolId(pool.address) || isAddress(pool.address))
    ))
      continue;
    const key = `${pool.chainId}:${pool.hookAddress.toLowerCase()}`;
    eligible.push(pool);
    keys.push(key);
    wanted.add(key);
  }
  const cachedOwners = ownershipCache
    ? yield* ownershipCache.lookupSteps(projects, wanted)
    : null;
  const owners = cachedOwners || new Map();
  if (!cachedOwners) {
    const capture = ownershipCache?.begin(projects, wanted);
    for (const project of projects) {
      const deployments = project.deployments;
      ownershipCache?.project(capture, project.id, deployments);
      for (const deployment of deployments) {
        if (++operations % 1024 === 0) yield;
        const key = `${deployment.chainId}:${deployment.address.toLowerCase()}`;
        // Preserve the complete ordered deployment scan, including its reads and
        // last-owner precedence. Unobserved hooks need no retained Map entry.
        const projectId = project.id;
        const chain = deployment.chain;
        ownershipCache?.deployment(
          capture,
          deployment.chainId,
          deployment.address,
          chain,
        );
        if (wanted.has(key)) owners.set(key, { projectId, chain });
      }
    }
    ownershipCache?.commit(capture, owners);
  }
  const seen = new Set();
  return eligible
    .map((pool, index) => {
      const owner = owners.get(keys[index]);
      return {
        ...pool,
        hookAddress: pool.hookAddress.toLowerCase(),
        projectId: owner?.projectId || null,
        chain: owner?.chain || pool.chain,
      };
    })
    .filter((pool) => {
      const key = `${pool.chain}:${pool.address.toLowerCase()}`;
      if (!pool.projectId || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(({ chainId, ...pool }) => ({
      ...pool,
      id:
        cleanText(pool.id, 180) ||
        `${pool.chain}:${pool.address.toLowerCase()}`,
      address: pool.address.toLowerCase(),
      source: cleanText(pool.source, 400) || "Public metric source",
      createdAt:
        typeof pool.createdAt === "string" &&
        Number.isFinite(Date.parse(pool.createdAt)) &&
        Date.parse(pool.createdAt) <= Date.now() + 60000
          ? new Date(Date.parse(pool.createdAt)).toISOString()
          : null,
      url: safeUrl(pool.url) || REGISTRY_URL,
      name: cleanText(pool.name, 180) || "Unnamed pool",
      tokens: Array.isArray(pool.tokens)
        ? pool.tokens
            .map((token) => cleanText(token, isAddress(token) ? 42 : 40))
            .slice(0, 8)
        : [],
      liquidityUsd: numberOrNull(pool.liquidityUsd),
      volumeUsd: Object.fromEntries(
        ["h1", "h6", "h24"].map((window) => [
          window,
          numberOrNull(pool.volumeUsd?.[window]),
        ]),
      ),
    }));
}
export function attributePools(...args) {
  return runSynchronously(attributePoolsSteps(...args));
}
export function attributePoolsAsync(...args) {
  return runCooperatively(attributePoolsSteps(...args));
}

export function* applyMetricsSteps(
  projects,
  pools,
  note = "Partial sample of pools with independently resolved hook addresses. Untracked pools are excluded.",
  now = Date.now(),
) {
  const byProject = new Map();
  let work = 0;
  for (const pool of pools) {
    if (++work % 256 === 0) yield;
    if (!byProject.has(pool.projectId)) byProject.set(pool.projectId, []);
    byProject.get(pool.projectId).push(pool);
  }
  for (const project of projects) {
    if (++work % 512 === 0) yield;
    const measured = byProject.get(project.id);
    if (!measured?.length) continue;
    project.metrics = {
      poolCount: measured.length,
      ...(yield* aggregateCurrentMarketsSteps(measured, now)),
      coverage: "partial",
      note,
    };
  }
}
export function applyMetrics(...args) {
  return runSynchronously(applyMetricsSteps(...args));
}
export function nullableSum(values) {
  const numeric = values.filter(
    (value) => typeof value === "number" && Number.isFinite(value),
  );
  const total = numeric.length
    ? numeric.reduce((sum, value) => sum + value, 0)
    : null;
  return total === null || Number.isFinite(total) ? total : null;
}
export function* registryEventsSteps(previous, projects, timestamp) {
  if (!previous?.projects?.length)
    return [
      {
        id: `baseline-${timestamp}`,
        type: "metadata-change",
        title: "Directory baseline observed",
        description:
          "Hook Radar recorded its initial directory snapshot. Deployment dates are not inferred from this first observation.",
        timestamp,
        projectId: null,
        chain: null,
        url: REGISTRY_URL,
      },
    ];
  const oldProjects = new Map();
  let operations = 0;
  const events = [];
  const seen = new Set();
  const addEvent = (event) => {
    if (events.length >= 100 || seen.has(event.id)) return;
    seen.add(event.id);
    events.push(event);
  };
  const oldDeployments = new Map();
  for (const project of previous.projects) {
    oldProjects.set(project.id, project);
    for (const deployment of project.deployments) {
      if (++operations % 1024 === 0) yield;
      oldDeployments.set(deployment.id, { deployment, projectId: project.id });
    }
  }
  for (const project of projects) {
    if (++operations % 1024 === 0) yield;
    if (events.length >= 100) break;
    const old = oldProjects.get(project.id);
    const regrouped = project.deployments.filter(
      (deployment) =>
        oldDeployments.has(deployment.id) &&
        oldDeployments.get(deployment.id).projectId !== project.id,
    );
    if (regrouped.length)
      addEvent({
        id: digest(`group:${project.id}:${timestamp}`),
        type: "metadata-change",
        title: `${project.name}: attribution updated`,
        description: `${regrouped.length} existing deployment${regrouped.length === 1 ? "" : "s"} grouped under this project by Radar’s attribution rules. These contracts were already observed; no new deployment is implied.`,
        timestamp,
        projectId: project.id,
        chain: project.chains[0] || null,
        url: project.sourceUrl,
      });
    if (
      !old &&
      project.deployments.some(
        (deployment) => !oldDeployments.has(deployment.id),
      )
    )
      addEvent({
        id: digest(`new:${project.id}:${timestamp}`),
        type: "new-project",
        title: `${project.name} ${project.deployments.every((deployment) => deployment.discovery === "onchain") ? "discovered onchain" : project.deployments.some((deployment) => deployment.discovery === "published") && project.deployments.every((deployment) => deployment.discovery !== undefined) ? "documented in a published source" : "entered the registry"}`,
        description:
          "First observed by this Radar instance. This is not a deployment timestamp.",
        timestamp,
        projectId: project.id,
        chain: project.chains[0] || null,
        url: project.sourceUrl,
      });
    else {
      for (const deployment of project.deployments) {
        if (events.length >= 100) break;
        const prior = oldDeployments.get(deployment.id)?.deployment;
        if (!prior)
          addEvent({
            id: digest(`deploy:${deployment.id}:${timestamp}`),
            type: "new-deployment",
            title: `${project.name}: deployment added`,
            description: `${deployment.name} (${deployment.address.slice(0, 10)}…${deployment.address.slice(-6)}) was first observed ${deployment.discovery === "onchain" ? "from PoolManager events" : deployment.discovery === "published" ? "with identity from its published deployment list" : "in the registry"} on ${deployment.chain}.`,
            timestamp,
            projectId: project.id,
            chain: deployment.chain,
            url: deployment.explorerUrl,
          });
        else if (
          prior.description !== deployment.description ||
          prior.name !== deployment.name ||
          prior.verifiedSource !== deployment.verifiedSource ||
          prior.auditUrl !== deployment.auditUrl ||
          prior.discovery !== deployment.discovery ||
          [
            "dynamicFee",
            "upgradeable",
            "requiresCustomSwapData",
            "vanillaSwap",
            "swapAccess",
          ].some(
            (key) => prior.properties?.[key] !== deployment.properties?.[key],
          )
        )
          addEvent({
            id: digest(`metadata:${deployment.id}:${timestamp}`),
            type: "metadata-change",
            title: `${project.name}: metadata updated`,
            description:
              deployment.discovery === "published"
                ? prior.discovery === "onchain"
                  ? "An existing onchain hook was named from its published deployment list. Its identity and pool associations are unchanged; no new deployment is implied."
                  : "Metadata from the published deployment source changed. This does not establish source verification or an audit."
                : "Published registry description, name, declared properties, source verification metadata, or audit link changed.",
            timestamp,
            projectId: project.id,
            chain: deployment.chain,
            url: deployment.sourceUrl,
          });
      }
    }
  }
  for (const event of previous.events || []) {
    if (events.length >= 100) break;
    addEvent(event);
  }
  return events;
}
export function registryEvents(...args) {
  return runSynchronously(registryEventsSteps(...args));
}
export function registryEventsAsync(...args) {
  return runCooperatively(registryEventsSteps(...args));
}

export function appendHistory(previous = [], value, timestamp) {
  if (value === null || !Number.isFinite(value))
    return previous.length <= 672 ? previous : previous.slice(-672);
  const last = previous.at(-1);
  if (last && timestamp - last.timestamp < 300000)
    return previous.length <= 672 ? previous : previous.slice(-672);
  return [...previous, { timestamp, value }].slice(-672);
}
