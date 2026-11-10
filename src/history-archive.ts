export interface ArchivedObservation {
  id: string;
  timestamp: number;
  value: number;
  scopeId: string;
  capturedAt: string;
}
export interface HistoryArchiveScope {
  id: string;
  kind: "published-window" | "captured-public-legacy";
  identity: {
    projectId: string | null;
    deployments: { chain: string; chainId: number; address: string }[];
    namespaces: {
      chain: string;
      chainId: number;
      manager: string | null;
      replacementEpoch: number | null;
    }[];
  };
  capturedAt: string;
  historicalOwnershipVerified: false;
  sourceSha256?: string;
}
export interface HistoryArchivePage {
  schemaVersion: 1;
  kind: "history-archive";
  projectId: string | null;
  metric: "volumeUsd.h24";
  displayWindowLimit: 672;
  points: ArchivedObservation[];
  scopes: HistoryArchiveScope[];
  nextCursor: string | null;
  total: number;
  watermark: number;
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const hash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const natural = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const iso = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const chain = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,99}$/.test(value);
const address = (value: unknown): value is string =>
  typeof value === "string" && /^0x[a-f0-9]{40}$/i.test(value);

/** Legacy seconds are converted only for display, never in the stored/exported record. */
export const observationTime = (timestamp: number) =>
  timestamp < 1e12 ? timestamp * 1000 : timestamp;

export function isHistoryArchivePage(
  value: unknown,
  projectId: string | null,
  limit = 25,
): value is HistoryArchivePage {
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== "history-archive" ||
    value.projectId !== projectId ||
    value.metric !== "volumeUsd.h24" ||
    value.displayWindowLimit !== 672 ||
    !natural(value.watermark) ||
    !natural(value.total) ||
    value.total > value.watermark ||
    !Array.isArray(value.points) ||
    value.points.length > limit ||
    value.total < value.points.length ||
    !Array.isArray(value.scopes) ||
    value.scopes.length > value.points.length ||
    (value.nextCursor !== null &&
      (typeof value.nextCursor !== "string" ||
        !/^[A-Za-z0-9_-]{1,1024}$/.test(value.nextCursor) ||
        !value.points.length))
  )
    return false;
  const scopes = new Set<string>();
  for (const scope of value.scopes) {
    if (
      !record(scope) ||
      !hash(scope.id) ||
      scopes.has(scope.id) ||
      !["published-window", "captured-public-legacy"].includes(
        String(scope.kind),
      ) ||
      scope.historicalOwnershipVerified !== false ||
      !iso(scope.capturedAt) ||
      (scope.kind === "captured-public-legacy"
        ? !hash(scope.sourceSha256)
        : scope.sourceSha256 !== undefined) ||
      !record(scope.identity) ||
      scope.identity.projectId !== projectId ||
      !Array.isArray(scope.identity.deployments) ||
      !scope.identity.deployments.every(
        (row: unknown) =>
          record(row) &&
          chain(row.chain) &&
          natural(row.chainId) &&
          row.chainId > 0 &&
          address(row.address),
      ) ||
      !Array.isArray(scope.identity.namespaces) ||
      !scope.identity.namespaces.every(
        (row: unknown) =>
          record(row) &&
          chain(row.chain) &&
          natural(row.chainId) &&
          row.chainId > 0 &&
          (row.manager === null || address(row.manager)) &&
          (row.replacementEpoch === null || natural(row.replacementEpoch)),
      )
    )
      return false;
    scopes.add(scope.id);
  }
  const ids = new Set<string>();
  for (const point of value.points) {
    if (
      !record(point) ||
      !hash(point.id) ||
      ids.has(point.id) ||
      !hash(point.scopeId) ||
      !scopes.has(point.scopeId) ||
      typeof point.timestamp !== "number" ||
      !Number.isFinite(point.timestamp) ||
      point.timestamp < 0 ||
      !Number.isFinite(new Date(observationTime(point.timestamp)).getTime()) ||
      typeof point.value !== "number" ||
      !Number.isFinite(point.value) ||
      point.value < 0 ||
      !iso(point.capturedAt) ||
      observationTime(point.timestamp) > Date.parse(point.capturedAt) + 60000
    )
      return false;
    ids.add(point.id);
  }
  return true;
}

/** This page only: retain raw timestamp units, exact numbers and capture provenance. */
export function historyArchiveCsv(page: HistoryArchivePage) {
  const scopes = new Map(page.scopes.map((scope) => [scope.id, scope]));
  const cell = (value: string | number) =>
    `"${String(value).replaceAll('"', '""')}"`;
  return (
    [
      [
        "project_id",
        "observation_id",
        "observed_at_utc",
        "original_timestamp",
        "volume_usd_h24",
        "scope_id",
        "scope_kind",
        "archived_at",
        "historical_ownership_verified",
        "capture_source_sha256",
        "page_watermark",
      ],
      ...page.points.map((point) => [
        page.projectId || "",
        point.id,
        new Date(observationTime(point.timestamp)).toISOString(),
        point.timestamp,
        point.value,
        point.scopeId,
        scopes.get(point.scopeId)?.kind || "",
        point.capturedAt,
        "false",
        scopes.get(point.scopeId)?.sourceSha256 || "",
        page.watermark,
      ]),
    ]
      .map((row) => row.map(cell).join(","))
      .join("\r\n") + "\r\n"
  );
}
