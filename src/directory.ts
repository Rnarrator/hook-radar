import type { DirectoryPage, RadarEvent, RadarSnapshot } from "../shared/types";
import { categories, isSnapshot, safeUrl } from "./model.ts";
import { protocolArtwork } from "./protocol-logos.ts";
const count = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const strings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === "string" && s.length <= 200);
const text = (value: unknown, limit: number): value is string =>
  typeof value === "string" && value.length <= limit;

function isScopedEvent(value: unknown): value is RadarEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return (
    text(event.id, 200) &&
    event.id.length > 0 &&
    typeof event.type === "string" &&
    ["new-project", "new-deployment", "metadata-change", "activity"].includes(
      event.type,
    ) &&
    text(event.title, 400) &&
    text(event.description, 4000) &&
    text(event.timestamp, 40) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(
      event.timestamp,
    ) &&
    Number.isFinite(Date.parse(event.timestamp)) &&
    Date.parse(event.timestamp) >= 0 &&
    (event.projectId === null ||
      (text(event.projectId, 100) && /^[a-z0-9-]+$/.test(event.projectId))) &&
    (event.chain === null || text(event.chain, 100)) &&
    (event.url === null ||
      (text(event.url, 4000) && Boolean(safeUrl(event.url))))
  );
}
export function isDirectoryPage(
  value: unknown,
  snapshot: RadarSnapshot,
): value is DirectoryPage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (
    !count(row.total) ||
    !count(row.offset) ||
    row.offset > row.total ||
    !Array.isArray(row.projects) ||
    row.projects.length > 100 ||
    (row.total > 0 && !row.projects.length) ||
    row.projects.length > row.total - row.offset ||
    !(
      row.nextOffset === null ||
      (count(row.nextOffset) &&
        row.nextOffset === row.offset + row.projects.length &&
        row.nextOffset < row.total)
    ) ||
    (row.nextOffset === null && row.offset + row.projects.length < row.total) ||
    !isSnapshot({
      ...snapshot,
      directory: undefined,
      projects: row.projects,
    }) ||
    new Set(row.projects.map((p) => p.id)).size !== row.projects.length ||
    !strings(row.missingIds) ||
    row.missingIds.length > 2000 ||
    !row.scope ||
    typeof row.scope !== "object" ||
    Array.isArray(row.scope)
  )
    return false;
  const scope = row.scope as Record<string, unknown>;
  if (
    !(scope.poolCount === null || count(scope.poolCount)) ||
    !strings(scope.chains) ||
    scope.chains.length > 100 ||
    !strings(scope.poolIds) ||
    !strings(scope.eventIds)
  )
    return false;
  if (scope.events !== undefined) {
    const eventIds = scope.eventIds;
    if (
      !Array.isArray(scope.events) ||
      scope.events.length > 100 ||
      scope.events.length !== eventIds.length ||
      !scope.events.every(isScopedEvent) ||
      new Set(eventIds).size !== eventIds.length ||
      !scope.events.every((event, index) => event.id === eventIds[index])
    )
      return false;
  }
  const groups = (v: unknown, projects: boolean): boolean =>
    Array.isArray(v) &&
    v.length <= categories.length &&
    new Set(v.map((g) => g?.category)).size === v.length &&
    v.every(
      (g) =>
        g &&
        categories.includes(g.category) &&
        count(g.total) &&
        (!projects ||
          (Array.isArray(g.projects) &&
            g.projects.length <= 6 &&
            g.projects.length <= g.total &&
            g.projects.every(
              (p: Record<string, unknown>) =>
                p &&
                typeof p.id === "string" &&
                /^[a-z0-9-]{1,100}$/.test(p.id) &&
                typeof p.name === "string" &&
                p.name.length <= 400 &&
                typeof p.description === "string" &&
                p.description.length <= 4000 &&
                categories.includes(
                  p.category as (typeof categories)[number],
                ) &&
                strings(p.chains) &&
                p.chains.length <= 100 &&
                count(p.deploymentCount) &&
                p.deploymentCount > 0 &&
                (p.artwork === null ||
                  (typeof p.artwork === "object" &&
                    Object.values(protocolArtwork).some(
                      (a) =>
                        a.protocol ===
                          (p.artwork as Record<string, unknown>).protocol &&
                        a.src === (p.artwork as Record<string, unknown>).src,
                    ))) &&
                (p.fingerprint === null ||
                  (typeof p.fingerprint === "object" &&
                    /^0x[0-9a-f]{40}$/i.test(
                      String(
                        (p.fingerprint as Record<string, unknown>).address,
                      ),
                    ) &&
                    typeof (p.fingerprint as Record<string, unknown>).chain ===
                      "string")),
            ))),
    );
  return groups(row.map, true) && groups(row.landscape, false);
}

export function directorySearch(
  filters: {
    search: string;
    chain: string;
    category: string;
    property: string;
    market?: string;
  },
  sort: { key: string; direction: string },
  window: string,
  ids?: string[],
) {
  const params = new URLSearchParams({
    ...filters,
    market: filters.market || "projects",
    sort: sort.key,
    direction: sort.direction,
    window,
  });
  for (const id of ids || []) params.append("id", id);
  return params;
}
