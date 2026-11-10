/** Source-backed launchpad platforms, reviewed 2026-10-23.
 *
 * Model: launchpad (consumer product) → underlying protocol → exact hooks and
 * pools. A launchpad is a platform listing: it carries identity, status and the
 * exact contracts its own first-party documentation, repository or application
 * publishes. It carries no market total of its own: the Launchpads list sums the measured pools of the exact hooks it publishes, and nothing else. Hooks shared with another protocol
 * (for example Doppler's shared initializer) stay attributed to that protocol,
 * so their pools and volume are counted once, in the protocol's own record.
 *
 * Nothing here is inferred from a name. A hook appears only if a first-party
 * source names that exact address on that chain, or (labelled `on-chain-link`)
 * it is read on chain from a contract a first-party source lists. Name matches in third-party
 * lists are recorded as `unattributed`, never as ownership. Statuses preserve
 * the distinction between live, restricted, deprecated, planned and unverified.
 * Research evidence: work/launchpad-expansion-2026-10-23/research/ (first and
 * second pass) and work/launchpad-wave2-2026-10-23/ (third pass, with the
 * on-chain audit receipt in verification/). */
import { additionalLaunchpadRecords } from "./launchpad-records-additional.ts";
import { wave2LaunchpadRecords } from "./launchpad-records-wave2.ts";
import { coreLaunchpadRecords } from "./launchpad-records-core.ts";
import type {
  LaunchpadHook,
  LaunchpadPath,
  LaunchpadRecord,
  LaunchpadStatus,
  LaunchpadUniswapVersion,
} from "./launchpad-types.ts";

export {
  LAUNCHPAD_REVIEWED_AT,
  POOL_MANAGER,
} from "./launchpad-types.ts";
export type {
  LaunchpadAttribution,
  LaunchpadContract,
  LaunchpadEvidence,
  LaunchpadHook,
  LaunchpadPath,
  LaunchpadPoolKind,
  LaunchpadRecord,
  LaunchpadRelationship,
  LaunchpadStatus,
  LaunchpadUniswapVersion,
} from "./launchpad-types.ts";

export const launchpadRegistry: readonly LaunchpadRecord[] = Object.freeze([
  ...coreLaunchpadRecords,
  ...additionalLaunchpadRecords,
  ...wave2LaunchpadRecords,
]);


const byId = new Map(launchpadRegistry.map((record) => [record.id, record]));

export function getLaunchpad(id: string): LaunchpadRecord | null {
  return byId.get(id) ?? null;
}

export const launchpadStatusLabels: Readonly<Record<LaunchpadStatus, string>> =
  Object.freeze({
    live: "Live",
    restricted: "Restricted",
    deprecated: "Deprecated",
    planned: "Planned",
    unverified: "Unverified",
  });

export const launchpadVersionLabels: Readonly<
  Record<LaunchpadUniswapVersion, string>
> = Object.freeze({
  v4: "Uniswap v4",
  v3: "Uniswap v3",
  "own-curve": "Own bonding curve",
  unknown: "Version unknown",
});

/** Chains where the platform has at least one path that is not merely planned. */
export function launchpadChains(record: LaunchpadRecord): string[] {
  return [
    ...new Set(
      record.paths
        .filter((path) => path.status !== "planned")
        .map((path) => path.chain),
    ),
  ];
}

export interface HookResolution {
  hook: LaunchpadHook;
  path: LaunchpadPath;
  /** The directory project and deployment holding this exact chain+address. */
  project: { id: string; name: string; deploymentCount: number } | null;
}

/** Match each published hook to the directory by exact chain and address, never
 * by name. `deploymentCount > 1` means the family also holds other contracts,
 * so the family's totals must not be presented as the platform's. */
export function resolveLaunchpadHooks(
  record: LaunchpadRecord,
  projects: readonly {
    id: string;
    name: string;
    deployments: readonly { chain: string; address: string }[];
  }[],
): HookResolution[] {
  const index = new Map<string, (typeof projects)[number]>();
  for (const project of projects)
    for (const deployment of project.deployments)
      index.set(
        `${deployment.chain}:${deployment.address.toLowerCase()}`,
        project,
      );
  return record.paths.flatMap((path) =>
    path.hooks.map((hook) => {
      const project = index.get(`${path.chain}:${hook.address}`);
      return {
        hook,
        path,
        project: project
          ? {
              id: project.id,
              name: project.name,
              deploymentCount: project.deployments.length,
            }
          : null,
      };
    }),
  );
}
