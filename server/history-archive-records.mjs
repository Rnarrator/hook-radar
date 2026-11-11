import { createHash } from "node:crypto";

export const HISTORY_ARCHIVE_WINDOW = 672;
export const HISTORY_ARCHIVE_BATCH = 1000;
export const HISTORY_ARCHIVE_WRITE_BYTES = 2 * 1024 * 1024;
export const HISTORY_ARCHIVE_PAGE = 200;
export const HISTORY_ARCHIVE_MAX_BYTES = 4 * 1024 ** 3;
export const HISTORY_ARCHIVE_DISK_RESERVE = 4 * 1024 ** 3;
const SHA = /^[a-f0-9]{64}$/;
const PROJECT = /^[a-z0-9-]{1,100}$/;
const ADDRESS = /^0x[a-f0-9]{40}$/;
const CHAIN = /^[a-z0-9-]{1,50}$/;
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
export const historyDigest = (value) =>
  createHash("sha256").update(value).digest("hex");
export const historyEntity = (projectId) =>
  projectId === null ? "@global" : projectId;
export const historyPointKey = (point) =>
  JSON.stringify([point.timestamp, point.value]);
const date = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const keys = (value, required, optional = []) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every(
    (key) => required.includes(key) || optional.includes(key),
  );

export function validateHistoryScope(scope) {
  if (
    !keys(
      scope,
      ["id", "kind", "identity", "capturedAt", "historicalOwnershipVerified"],
      ["sourceSha256"],
    ) ||
    typeof scope.id !== "string" ||
    !SHA.test(scope.id) ||
    !["published-window", "captured-public-legacy"].includes(scope.kind) ||
    !date(scope.capturedAt) ||
    scope.historicalOwnershipVerified !== false ||
    !keys(scope.identity, ["projectId", "deployments", "namespaces"]) ||
    !(
      scope.identity.projectId === null ||
      (typeof scope.identity.projectId === "string" &&
        PROJECT.test(scope.identity.projectId))
    ) ||
    !Array.isArray(scope.identity.deployments) ||
    scope.identity.deployments.length > 10000 ||
    !Array.isArray(scope.identity.namespaces) ||
    scope.identity.namespaces.length > 100 ||
    (scope.kind === "captured-public-legacy"
      ? typeof scope.sourceSha256 !== "string" || !SHA.test(scope.sourceSha256)
      : scope.sourceSha256 !== undefined)
  )
    throw new TypeError("Invalid historical capture scope.");
  let previous = "";
  for (const row of scope.identity.deployments) {
    if (
      !keys(row, ["chain", "chainId", "address"]) ||
      typeof row.chain !== "string" ||
      !CHAIN.test(row.chain) ||
      !integer(row.chainId) ||
      row.chainId < 1 ||
      typeof row.address !== "string" ||
      !ADDRESS.test(row.address)
    )
      throw new TypeError("Invalid historical deployment identity.");
    const key = JSON.stringify([row.chain, row.chainId, row.address]);
    if (key <= previous)
      throw new TypeError(
        "Historical deployment identities must be unique and ordered.",
      );
    previous = key;
  }
  previous = "";
  for (const row of scope.identity.namespaces) {
    if (
      !keys(row, ["chain", "chainId", "manager", "replacementEpoch"]) ||
      typeof row.chain !== "string" ||
      !CHAIN.test(row.chain) ||
      !integer(row.chainId) ||
      row.chainId < 1 ||
      !(
        row.manager === null ||
        (typeof row.manager === "string" && ADDRESS.test(row.manager))
      ) ||
      !(row.replacementEpoch === null || integer(row.replacementEpoch))
    )
      throw new TypeError("Invalid historical canonical scope.");
    if (row.chain <= previous)
      throw new TypeError("Historical namespaces must be unique and ordered.");
    previous = row.chain;
  }
  const identity = JSON.stringify([
    1,
    scope.kind,
    scope.identity,
    scope.sourceSha256 || null,
  ]);
  if (
    historyDigest(identity) !== scope.id ||
    Buffer.byteLength(JSON.stringify(scope)) > 128 * 1024
  )
    throw new TypeError("Historical scope digest or size is invalid.");
  return scope;
}

/** Identity is the publication's association, not retroactive ownership proof. */
export function capturedHistoryScope(snapshot, project, joined) {
  const deployments = project
    ? project.deployments
        .map((row) => ({
          chain: row.chain,
          chainId: row.chainId,
          address: row.address.toLowerCase(),
        }))
        .sort((a, b) => {
          const x = JSON.stringify([a.chain, a.chainId, a.address]);
          const y = JSON.stringify([b.chain, b.chainId, b.address]);
          return x < y ? -1 : x > y ? 1 : 0;
        })
    : [];
  const selected = project
    ? new Set(deployments.map((row) => row.chain))
    : null;
  const networks = snapshot.inventory?.networks || [];
  const heads = new Map((joined?.heads || []).map((row) => [row.chain, row]));
  const namespaces = snapshot.chains
    .filter((chain) => !selected || selected.has(chain.slug))
    .map((chain) => ({
      chain: chain.slug,
      chainId: chain.id,
      manager:
        networks
          .find((network) => network.chain === chain.slug)
          ?.manager?.toLowerCase() || null,
      replacementEpoch: heads.get(chain.slug)?.replacementEpoch ?? null,
    }))
    .sort((a, b) => (a.chain < b.chain ? -1 : a.chain > b.chain ? 1 : 0));
  const identity = { projectId: project?.id || null, deployments, namespaces };
  return validateHistoryScope({
    id: historyDigest(JSON.stringify([1, "published-window", identity, null])),
    kind: "published-window",
    identity,
    capturedAt: snapshot.generatedAt,
    historicalOwnershipVerified: false,
  });
}

export function validateHistoryPoint(point, scope, capturedAt) {
  if (
    !keys(point, ["timestamp", "value"]) ||
    typeof point.timestamp !== "number" ||
    !Number.isFinite(point.timestamp) ||
    point.timestamp < 0 ||
    typeof point.value !== "number" ||
    !Number.isFinite(point.value) ||
    point.value < 0 ||
    !date(capturedAt) ||
    (point.timestamp < 1e12 ? point.timestamp * 1000 : point.timestamp) >
      Date.parse(capturedAt) + 60000
  )
    throw new TypeError("Invalid original historical observation.");
  const id = historyDigest(
    JSON.stringify([scope.id, point.timestamp, point.value]),
  );
  return {
    id,
    timestamp: point.timestamp,
    value: point.value,
    scopeId: scope.id,
    capturedAt,
  };
}

export function validateHistoryBatches(batches) {
  if (
    !Array.isArray(batches) ||
    !batches.length ||
    batches.length > HISTORY_ARCHIVE_BATCH
  )
    throw new RangeError("Invalid historical archive batches.");
  let count = 0;
  for (const batch of batches) {
    validateHistoryScope(batch?.scope);
    if (
      batch.scope.kind !== "published-window" ||
      !Array.isArray(batch.points) ||
      !batch.points.length ||
      (count += batch.points.length) > HISTORY_ARCHIVE_BATCH
    )
      throw new RangeError("Invalid historical archive batch.");
    batch.points.forEach((point) =>
      validateHistoryPoint(point, batch.scope, batch.capturedAt),
    );
  }
  if (Buffer.byteLength(JSON.stringify(batches)) > HISTORY_ARCHIVE_WRITE_BYTES)
    throw new RangeError("Historical archive batch is too large.");
  return batches;
}

/** Only points already present in a completed publication may enter this path. */
export function* removedHistorySteps(previous, candidate, joined) {
  if (!previous || previous === candidate) return;
  // The hot window must retain both an observation and its published
  // association. Native replacement epochs are not exposed in public frames;
  // compare their public semantics without inventing a candidate epoch, while
  // preserving the actual previous epoch in any archived scope below.
  const sameNamespaces =
    (previous.chains === candidate.chains &&
      previous.inventory?.networks === candidate.inventory?.networks) ||
    capturedHistoryScope(previous, null).id ===
      capturedHistoryScope(candidate, null).id;
  const sharedProjects = previous.projects === candidate.projects;
  const next = new Map();
  let work = 0;
  if (!sharedProjects)
    for (const project of candidate.projects) {
      if (++work % 512 === 0) yield null;
      next.set(project.id, project);
    }
  for (
    let index = sharedProjects && sameNamespaces ? previous.projects.length : 0;
    index <= previous.projects.length;
    index++
  ) {
    const project = previous.projects[index] || null;
    if (++work % 128 === 0) yield null;
    const old = project ? project.history : previous.history;
    if (!old?.length) continue;
    const nextProject = project
      ? sharedProjects
        ? project
        : next.get(project.id)
      : null;
    const sameIdentity = project
      ? Boolean(nextProject) &&
        ((sameNamespaces && project.deployments === nextProject.deployments) ||
          capturedHistoryScope(previous, project).id ===
            capturedHistoryScope(candidate, nextProject).id)
      : sameNamespaces;
    const current = sameIdentity
      ? project
        ? nextProject.history
        : candidate.history
      : [];
    if (old === current) continue;
    // Valid public histories are strictly ordered by their original timestamp.
    // Compare in linear time without serializing every point or allocating a
    // Set per project; keep a cooperative bound even when all672 points change.
    const points = [];
    let cursor = 0;
    for (const point of old) {
      while (
        cursor < current.length &&
        current[cursor].timestamp < point.timestamp
      ) {
        cursor++;
        if (++work % 256 === 0) yield null;
      }
      if (
        current[cursor]?.timestamp !== point.timestamp ||
        current[cursor]?.value !== point.value
      )
        points.push(point);
      if (++work % 256 === 0) yield null;
    }
    if (!points.length) continue;
    const scope = capturedHistoryScope(previous, project, joined);
    for (
      let offset = 0;
      offset < points.length;
      offset += HISTORY_ARCHIVE_BATCH
    )
      yield {
        scope,
        capturedAt: previous.generatedAt,
        points: points.slice(offset, offset + HISTORY_ARCHIVE_BATCH),
      };
  }
}

export function parseHistoryQuery(projectId, params) {
  if (
    !(
      projectId === null ||
      (typeof projectId === "string" && PROJECT.test(projectId))
    ) ||
    [...params.keys()].some(
      (key) =>
        !["limit", "before", "scope"].includes(key) ||
        params.getAll(key).length !== 1,
    )
  )
    throw new RangeError("Choose a valid archived history query.");
  const limit = params.has("limit") ? Number(params.get("limit")) : 100;
  const scope = params.get("scope");
  const cursor = params.get("before");
  if (
    !integer(limit) ||
    limit < 1 ||
    limit > HISTORY_ARCHIVE_PAGE ||
    (params.has("limit") && !/^[1-9][0-9]{0,2}$/.test(params.get("limit"))) ||
    (scope !== null && !SHA.test(scope)) ||
    (cursor !== null && !/^[A-Za-z0-9_-]{1,1024}$/.test(cursor))
  )
    throw new RangeError("Choose a valid archived history page.");
  let boundary = null;
  if (cursor !== null) {
    try {
      boundary = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    } catch {
      throw new RangeError("The history cursor is invalid.");
    }
    if (
      !keys(boundary, ["version", "entity", "scope", "watermark", "before"]) ||
      boundary.version !== 1 ||
      boundary.entity !== historyEntity(projectId) ||
      boundary.scope !== scope ||
      !integer(boundary.watermark) ||
      !integer(boundary.before) ||
      boundary.before < 1 ||
      boundary.before > boundary.watermark + 1
    )
      throw new RangeError("The history cursor does not match this scope.");
  }
  return { projectId, limit, scope, boundary };
}

export function safeHistoryArchiveReason(error) {
  const known = new Set([
    "disk-reserve",
    "storage-limit",
    "ownership",
    "integrity",
    "write-failed",
    "worker-unavailable",
  ]);
  return known.has(error?.archiveReason) ? error.archiveReason : "write-failed";
}
