import type { RadarSnapshot } from "./types";
import { isPublishedPlatformProject } from "./published-platform-hooks.ts";
export function isDirectoryInfo(
  value: unknown,
  projects: unknown,
): value is NonNullable<RadarSnapshot["directory"]> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Array.isArray(projects)
  )
    return false;
  const v = value as Record<string, unknown>;
  const platformCount = new Set(
    projects.filter(isPublishedPlatformProject).map((project) => project.id),
  ).size;
  return (
    v.mode === "paginated" &&
    [v.totalProjects, v.totalDeployments, v.loadedProjects].every(
      (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0,
    ) &&
    v.loadedProjects === projects.length &&
    Number(v.totalProjects) > projects.length &&
    Number(v.totalDeployments) >= Number(v.totalProjects) - platformCount
  );
}
