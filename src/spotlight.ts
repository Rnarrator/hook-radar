import type { Category, RadarProject } from "../shared/types";

export type SpotlightAngle =
  | "launches"
  | "liquidity"
  | "fees"
  | "mev"
  | "orders"
  | "oracles"
  | "access"
  | "other"
  | "extensions";

export interface SpotlightEntry {
  id: string;
  project: RadarProject;
  angle: SpotlightAngle;
  label: string;
  summary: string;
  facts: { label: string; value: string }[];
}

export interface SpotlightOptions {
  /** The caller supplies the same network scope as the directory. */
  chain?: string;
  /** A stable seed, such as the UTC date, refreshes the editorial mix. */
  seed?: string | number;
  limit?: number;
}

const stories: Record<Category, { angle: SpotlightAngle; label: string }> = {
  Launches: {
    angle: "launches",
    label: "Token launches",
  },
  Liquidity: {
    angle: "liquidity",
    label: "Liquidity design",
  },
  Fees: {
    angle: "fees",
    label: "Fee mechanics",
  },
  MEV: {
    angle: "mev",
    label: "MEV design",
  },
  Orders: {
    angle: "orders",
    label: "Order mechanics",
  },
  Oracles: {
    angle: "oracles",
    label: "Oracle design",
  },
  Access: {
    angle: "access",
    label: "Access controls",
  },
  Other: {
    angle: "other",
    label: "Hook design",
  },
};

function hash(text: string): number {
  let value = 2166136261;
  for (let index = 0; index < text.length; index++) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

function hasWebLink(value: string | null): boolean {
  if (!value) return false;
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function summary(description: string): string {
  const text = description.replace(/\s+/g, " ").trim();
  if (text.length <= 240) return text;
  const prefix = text.slice(0, 239);
  const boundary = prefix.lastIndexOf(" ");
  return `${prefix.slice(0, boundary > 160 ? boundary : prefix.length).trimEnd()}…`;
}

function entry(project: RadarProject): SpotlightEntry {
  const deployments = new Set(
    project.deployments.map(
      (deployment) => `${deployment.chain}:${deployment.address.toLowerCase()}`,
    ),
  );
  const networks = new Set(
    project.deployments.map((deployment) => deployment.chain),
  );
  const story = /\bpool extensions?\b/i.test(project.description)
    ? {
        angle: "extensions" as const,
        label: "Pool extensions",
      }
    : stories[project.category];
  return {
    id: project.id,
    project,
    ...story,
    summary: summary(project.description),
    facts: [
      {
        label: deployments.size === 1 ? "hook" : "hooks",
        value: deployments.size.toLocaleString("en-US"),
      },
      {
        label: networks.size === 1 ? "network" : "networks",
        value: networks.size.toLocaleString("en-US"),
      },
    ],
  };
}

/**
 * An editorial mix of real project profiles, separate from directory rankings.
 * Respect the supplied results, cover different use cases before repeating one,
 * and change the mix only when the caller changes its explicit seed or scope.
 * Linked project profiles are more useful entry points than isolated contracts.
 * Fall back to documented registry entries when a scope has no linked profiles.
 * No protocol gets a reserved slot, and dollar metrics never determine selection
 * or imply performance.
 */
export function buildSpotlightEntries(
  projects: readonly RadarProject[],
  { chain = "all", seed = "", limit = 6 }: SpotlightOptions = {},
): SpotlightEntry[] {
  const size = Number.isFinite(limit)
    ? Math.max(0, Math.min(6, Math.floor(limit)))
    : 6;
  if (!size) return [];
  const seedKey = String(seed);
  const unique = new Map<string, RadarProject>();
  for (const project of projects) {
    if (
      unique.has(project.id) ||
      !project.name.trim() ||
      /^0x[a-f\d]{40}$/i.test(project.name.trim()) ||
      !project.description.trim()
    )
      continue;
    const deployments = project.deployments.filter(
      (deployment) => chain === "all" || deployment.chain === chain,
    );
    if (!deployments.some((deployment) => deployment.discovery !== "onchain"))
      continue;
    unique.set(
      project.id,
      chain === "all" ? project : { ...project, deployments, chains: [chain] },
    );
  }
  const profileCompleteness = (project: RadarProject) =>
    Number(hasWebLink(project.website)) + Number(hasWebLink(project.docs));
  const candidates = [...unique.values()];
  const linked = candidates.filter(
    (project) => profileCompleteness(project) > 0,
  );
  const groups = new Map<Category, RadarProject[]>();
  for (const project of linked.length ? linked : candidates) {
    const group = groups.get(project.category) || [];
    group.push(project);
    groups.set(project.category, group);
  }
  for (const group of groups.values())
    group.sort(
      (a, b) =>
        profileCompleteness(b) - profileCompleteness(a) ||
        hash(`${seedKey}\0${a.id}`) - hash(`${seedKey}\0${b.id}`) ||
        a.id.localeCompare(b.id, "en"),
    );
  const categories = [...groups.keys()].sort(
    (a, b) =>
      hash(`${seedKey}\0${a}`) - hash(`${seedKey}\0${b}`) ||
      a.localeCompare(b, "en"),
  );
  const selected: SpotlightEntry[] = [];
  for (let round = 0; selected.length < size; round++) {
    let found = false;
    for (const category of categories) {
      const project = groups.get(category)?.[round];
      if (!project) continue;
      found = true;
      selected.push(entry(project));
      if (selected.length === size) break;
    }
    if (!found) break;
  }
  return selected;
}
