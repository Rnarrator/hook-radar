import type { Chain, RadarProject } from "../shared/types";
import {
  getLaunchpad,
  launchpadChains,
  launchpadRegistry,
} from "../shared/launchpad-registry.ts";
import type {
  LaunchpadRecord,
  LaunchpadStatus,
} from "../shared/launchpad-registry.ts";

/** The unavailable-metrics note shown on a launchpad platform listing. */
export function launchpadMetricsNote(record: LaunchpadRecord): string {
  const shared = record.paths.find(
    (path) => path.attribution === "shared-protocol",
  );
  if (!shared && record.paths.some((path) => path.perLaunchHooks))
    return "Platform listing. It deploys a separate hook for every launch, so no pool or volume is attributed to it; those pools appear in the directory as unnamed hooks.";
  return shared
    ? `Platform listing. Its Uniswap v4 launches use shared hooks that belong to ${shared.protocolId === "doppler" ? "Doppler" : "another protocol"}, so their pools and volume are counted there and are not repeated here.`
    : "Platform listing. The exact hook contracts it publishes are linked to their directory records; the Launchpads list sums volume only from the hooks it publishes, pool by pool, so a platform-wide total is not claimed.";
}

/** Directory-shaped platform listings derived from the reviewed registry.
 * They carry identity, supported networks and explicitly unavailable metrics:
 * no deployment, pool, zero-valued metric or history is invented. A listing is
 * produced only for networks the directory knows by slug and chain ID. */
export function launchpadListingProjects(
  chains: readonly Pick<Chain, "slug" | "id">[],
): (RadarProject & { entityType: "platform" })[] {
  const known = new Map(chains.map((chain) => [chain.slug, chain.id]));
  return launchpadRegistry.flatMap((record) => {
    const supported = launchpadChains(record).filter((slug) => {
      const path = record.paths.find((candidate) => candidate.chain === slug);
      return path !== undefined && known.get(slug) === path.chainId;
    });
    if (!supported.length) return [];
    return [
      {
        id: record.id,
        entityType: "platform" as const,
        name: record.name,
        description: record.description,
        category: "Launches" as const,
        website: record.website,
        docs: record.docs,
        sourceUrl: record.docs,
        chains: supported,
        deployments: [],
        metrics: {
          poolCount: null,
          liquidityUsd: null,
          volumeUsd: { h1: null, h6: null, h24: null },
          coverage: "unavailable" as const,
          note: launchpadMetricsNote(record),
        },
        history: [],
      },
    ];
  });
}

/** True only for a listing that this registry produced, matched by identity. */
export function launchpadRecordFor(
  project: Pick<RadarProject, "id" | "name" | "entityType" | "docs">,
): LaunchpadRecord | null {
  const record = getLaunchpad(project.id);
  return record &&
    project.entityType === "platform" &&
    project.name === record.name &&
    project.docs === record.docs
    ? record
    : null;
}

export const statusRank: Readonly<Record<LaunchpadStatus, number>> =
  Object.freeze({
    live: 0,
    restricted: 1,
    unverified: 2,
    planned: 3,
    deprecated: 4,
  });

/** Plain-language availability for an ordinary user. */
export function launchpadAvailability(record: LaunchpadRecord): string {
  switch (record.status) {
    case "live":
      return "Launching is available.";
    case "restricted":
      return "Launching is restricted. Read the status note before relying on it.";
    case "deprecated":
      return "This platform is no longer used for new launches.";
    case "planned":
      return "Launching is planned and not yet available.";
    default:
      return "Launching could not be verified. Treat it as unconfirmed.";
  }
}
