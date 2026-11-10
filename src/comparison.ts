import { evaluationNow } from "./edition.ts";
import type { HookDeployment, Pool, RadarProject } from "../shared/types";
import {
  projectPoolCount,
  poolCountIsObserved,
} from "./project-presentation.ts";
import { measurementProvenance } from "./provenance.ts";
import type { MeasuredMetric } from "./provenance.ts";
import { currentMetricValue } from "../shared/market-freshness.ts";

export const MAX_COMPARISON_PROJECTS = 4;

/** A bounded, shareable selection; never interpolate unchecked IDs into routes. */
export function normalizeComparisonIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const id of value) {
    if (
      typeof id === "string" &&
      /^[a-z0-9][a-z0-9-]{0,99}$/.test(id) &&
      !result.includes(id)
    )
      result.push(id);
    if (result.length === MAX_COMPARISON_PROJECTS) break;
  }
  return result;
}

export type RegistryBoolean =
  | "dynamicFee"
  | "upgradeable"
  | "requiresCustomSwapData"
  | "vanillaSwap"
  | "verifiedSource";

/** Discovered-contract default booleans are not independent registry assessments. */
export function registryDeclaration(
  project: RadarProject,
  property: RegistryBoolean,
) {
  let enabled = 0;
  let known = 0;
  for (const deployment of project.deployments) {
    if (
      deployment.discovery === "onchain" ||
      deployment.discovery === "published" ||
      deployment.properties.swapAccess === "unknown"
    )
      continue;
    known++;
    if (
      property === "verifiedSource"
        ? deployment.verifiedSource
        : deployment.properties[property]
    )
      enabled++;
  }
  return { enabled, known, unknown: project.deployments.length - known };
}

export function declarationLabel(
  value: ReturnType<typeof registryDeclaration>,
) {
  if (!value.known) return "Not classified";
  return `${value.enabled} of ${value.known} classified hooks`;
}

export const COMPARISON_CALLBACKS = [
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
] as const;

/** Missing callback keys remain unknown, rather than silently becoming disabled. */
export function callbackDeclaration(project: RadarProject, callback: string) {
  let enabled = 0;
  let known = 0;
  for (const deployment of project.deployments) {
    if (typeof deployment.flags[callback] !== "boolean") continue;
    known++;
    if (deployment.flags[callback]) enabled++;
  }
  return { enabled, known, unknown: project.deployments.length - known };
}

const accessNames = new Map([
  ["none", "No restriction classified"],
  ["temporal", "Time-gated"],
  ["allowlist", "Allowlist"],
  ["governance", "Admin-controlled"],
  ["other", "Custom rules"],
]);

export function accessDeclarations(project: RadarProject) {
  const counts = new Map<string, number>();
  for (const deployment of project.deployments) {
    const label =
      deployment.discovery === "onchain" || deployment.discovery === "published"
        ? "Not classified"
        : accessNames.get(deployment.properties.swapAccess) || "Not classified";
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts].sort(([a], [b]) => a.localeCompare(b));
}

/** Only add amounts that have real, attributed pool observations behind them. */
export function comparisonMeasurement(
  project: RadarProject,
  pools: Pool[],
  metric: MeasuredMetric,
  chain = "all",
  now = evaluationNow(),
) {
  const observedPools = pools.filter(
    (pool) =>
      pool.projectId === project.id &&
      (chain === "all" || pool.chain === chain),
  );
  // Only the project's own pools are read: the clock check is the costly part.
  const contributing = observedPools.filter((pool) => {
    const amount = currentMetricValue(pool, metric, now);
    return typeof amount === "number" && Number.isFinite(amount) && amount >= 0;
  });
  const sum = contributing.reduce(
    (total, pool) =>
      total +
      (metric === "liquidity" ? pool.liquidityUsd! : pool.volumeUsd[metric]!),
    0,
  );
  return {
    amount: contributing.length && Number.isFinite(sum) ? sum : null,
    pools: contributing,
    observedPools,
    sources: [...new Set(contributing.map((pool) => pool.source))].sort(),
    provenance: measurementProvenance(observedPools, metric, now),
  };
}

export function comparisonPoolCount(project: RadarProject, chain = "all") {
  return {
    value: projectPoolCount(project, chain),
    scope: poolCountIsObserved(project, chain)
      ? "Observed sample"
      : project.poolInventory?.complete
        ? "Indexed total"
        : "Indexed so far",
  };
}

/** Network overlap counts exact chain/address identities, never pool samples. */
export function comparisonNetworkCoverage(projects: RadarProject[]) {
  const networks = [...new Set(projects.flatMap(comparisonNetworks))].sort();
  const rows = networks.map((chain) => ({
    chain,
    counts: projects.map((project) =>
      uniqueComparisonDeployments(
        project.deployments.filter((hook) => hook.chain === chain),
      ),
    ),
  }));
  return {
    rows,
    shared:
      projects.length > 1
        ? rows
            .filter((row) => row.counts.every((value) => value > 0))
            .map((row) => row.chain)
        : [],
  };
}

/** A factual integration cue, with partial knowledge kept visible. */
export function comparisonCapability(
  project: RadarProject,
  property: RegistryBoolean,
) {
  const value = registryDeclaration(project, property);
  return {
    ...value,
    state: !value.known
      ? "unknown"
      : value.enabled
        ? "declared"
        : "not-declared",
    label: !value.known
      ? "Unclassified"
      : !value.enabled
        ? "Not declared"
        : value.enabled === value.known && !value.unknown
          ? "Declared on all hooks"
          : `Declared on ${value.enabled} ${value.enabled === 1 ? "hook" : "hooks"}`,
    detail: !value.known
      ? `${value.unknown} ${value.unknown === 1 ? "hook has" : "hooks have"} no classification`
      : `${value.enabled} of ${value.known} classified${value.unknown ? ` · ${value.unknown} unclassified` : ""}`,
  };
}

/** Evidence browsing stays bounded in the UI while every contract remains searchable. */
export function comparisonDeploymentEvidence(
  project: RadarProject,
  chain = "all",
  query = "",
) {
  const search = query.trim().toLowerCase();
  const unique = new Map<string, HookDeployment>();
  for (const hook of project.deployments) {
    if (chain !== "all" && hook.chain !== chain) continue;
    const key = `${hook.chain}:${hook.address.toLowerCase()}`;
    if (!unique.has(key)) unique.set(key, hook);
  }
  return [...unique.values()]
    .filter(
      (hook) =>
        !search ||
        [hook.address, hook.name, hook.chain].some((value) =>
          value.toLowerCase().includes(search),
        ),
    )
    .sort(
      (a, b) =>
        a.chain.localeCompare(b.chain) ||
        a.address.toLowerCase().localeCompare(b.address.toLowerCase()),
    );
}

export function comparisonNetworks(project: RadarProject) {
  return [...new Set(project.deployments.map((hook) => hook.chain))].sort();
}

/** Plain-language permission labels without removing the exact callback identifier. */
export function callbackLabel(value: string) {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (character) => character.toUpperCase());
}

export function uniqueComparisonDeployments(deployments: HookDeployment[]) {
  return new Set(
    deployments.map((hook) => `${hook.chain}:${hook.address.toLowerCase()}`),
  ).size;
}

export interface CallbackSignature {
  /** Per callback: the share of the project's classified hooks that enable it,
   * or null when no hook reports that callback (unknown, never zero). */
  shares: Record<string, number | null>;
  /** Callbacks every classified hook enables. */
  all: number;
  /** Callbacks only some classified hooks enable. */
  some: number;
  /** Callbacks no classified hook enables. */
  none: number;
  /** Callbacks no hook reports at all. */
  unreported: number;
}

/** The project's callback permissions at a glance, from the same declarations
 * the callback table shows. A missing flag is unreported, not off. */
export function callbackSignature(project: RadarProject): CallbackSignature {
  const shares: Record<string, number | null> = {};
  let all = 0;
  let some = 0;
  let none = 0;
  let unreported = 0;
  for (const callback of COMPARISON_CALLBACKS) {
    const { enabled, known } = callbackDeclaration(project, callback);
    if (!known) {
      shares[callback] = null;
      unreported++;
    } else {
      shares[callback] = enabled / known;
      if (enabled === known) all++;
      else if (enabled > 0) some++;
      else none++;
    }
  }
  return { shares, all, some, none, unreported };
}

export interface HookCapability {
  key: string;
  /** Plain-language sentence for someone who has not read the contracts. */
  text: string;
  /** Classified hooks that enable at least one callback in this group. */
  hooks: number;
}

/** Callbacks grouped by what a reader would care about. A project has a
 * capability when at least one of its classified hooks enables a callback of
 * the group; the sentence says what the permission allows, not what the hook
 * does with it. */
const CAPABILITY_GROUPS: readonly {
  key: string;
  callbacks: readonly string[];
  text: string;
}[] = [
  {
    key: "swap",
    callbacks: ["beforeSwap", "afterSwap"],
    text: "Reacts to trades: it can run its own rules before or after each swap.",
  },
  {
    key: "swap-amounts",
    callbacks: ["beforeSwapReturnsDelta", "afterSwapReturnsDelta"],
    text: "Can change the amounts in a trade, for example to charge its own fee.",
  },
  {
    key: "liquidity",
    callbacks: [
      "beforeAddLiquidity",
      "afterAddLiquidity",
      "beforeRemoveLiquidity",
      "afterRemoveLiquidity",
    ],
    text: "Reacts when people add or remove liquidity.",
  },
  {
    key: "liquidity-amounts",
    callbacks: ["afterAddLiquidityReturnsDelta", "afterRemoveLiquidityReturnsDelta"],
    text: "Can change what liquidity providers pay or receive.",
  },
  {
    key: "create",
    callbacks: ["beforeInitialize", "afterInitialize"],
    text: "Runs when a new pool that uses it is created.",
  },
  {
    key: "donate",
    callbacks: ["beforeDonate", "afterDonate"],
    text: "Reacts to donations made to the pool.",
  },
];

/** What a project's hooks are permitted to do, in plain words, from the same
 * declarations as the callback table. Hooks with no reported flags are not
 * counted either way (they stay unknown, never "cannot"). */
export function hookCapabilities(project: Pick<RadarProject, "deployments">): {
  capabilities: HookCapability[];
  classified: number;
} {
  const classified = project.deployments.filter((deployment) =>
    COMPARISON_CALLBACKS.some(
      (callback) => typeof deployment.flags[callback] === "boolean",
    ),
  ).length;
  const capabilities: HookCapability[] = [];
  for (const group of CAPABILITY_GROUPS) {
    const hooks = project.deployments.filter((deployment) =>
      group.callbacks.some((callback) => deployment.flags[callback] === true),
    ).length;
    if (hooks > 0) capabilities.push({ key: group.key, text: group.text, hooks });
  }
  return { capabilities, classified };
}
