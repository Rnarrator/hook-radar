import { capturedHistoryScope } from "./history-archive-records.mjs";

const HISTORY_LIMIT = 672;
const addressField = (value) =>
  typeof value === "string" && /^0x[\da-f]{40}$/i.test(value);
const timeOf = (point) =>
  point.timestamp < 1e12 ? point.timestamp * 1000 : point.timestamp;
const catalogScope = (snapshot) => ({
  mode: snapshot.directory?.mode || "complete",
  loadedProjects: snapshot.projects.length,
  totalProjects: snapshot.directory?.totalProjects ?? snapshot.projects.length,
});

function indexSnapshot(snapshot) {
  const projects = new Map(),
    chains = new Map(),
    chainIds = new Map(),
    owners = new Map();
  for (const chain of snapshot.chains) {
    const rows = chains.get(chain.slug) || [];
    rows.push(chain);
    chains.set(chain.slug, rows);
    const slugs = chainIds.get(chain.id) || new Set();
    slugs.add(chain.slug);
    chainIds.set(chain.id, slugs);
  }
  for (const project of snapshot.projects) {
    const rows = projects.get(project.id) || [];
    rows.push(project);
    projects.set(project.id, rows);
    for (const deployment of project.deployments) {
      const key = `${deployment.chainId}:${deployment.address.toLowerCase()}`;
      const ids = owners.get(key) || new Set();
      ids.add(project.id);
      owners.set(key, ids);
    }
  }
  return { projects, chains, chainIds, owners };
}

function identityOf(project, index) {
  const keys = new Set(),
    chains = new Set();
  for (const deployment of project.deployments) {
    const chain = index.chains.get(deployment.chain);
    if (
      !addressField(deployment.address) ||
      !Number.isSafeInteger(deployment.chainId) ||
      deployment.chainId <= 0 ||
      chain?.length !== 1 ||
      chain[0].id !== deployment.chainId ||
      index.chainIds.get(deployment.chainId)?.size !== 1
    )
      return { reason: "invalid-chain-identity" };
    const ownerKey = `${deployment.chainId}:${deployment.address.toLowerCase()}`;
    if (index.owners.get(ownerKey)?.size !== 1)
      return { reason: "ambiguous-deployment-owner" };
    const key = JSON.stringify([
      deployment.chain,
      deployment.chainId,
      deployment.address.toLowerCase(),
    ]);
    if (keys.has(key)) return { reason: "duplicate-deployment" };
    keys.add(key);
    chains.add(deployment.chain);
  }
  if (
    !keys.size ||
    project.chains.length !== chains.size ||
    new Set(project.chains).size !== chains.size ||
    project.chains.some((chain) => !chains.has(chain))
  )
    return { reason: "invalid-project-chain-scope" };
  return { key: JSON.stringify([...keys].sort()) };
}

function validPoint(point, capturedAt) {
  if (
    !point ||
    typeof point.timestamp !== "number" ||
    !Number.isFinite(point.timestamp) ||
    point.timestamp <= 0 ||
    typeof point.value !== "number" ||
    !Number.isFinite(point.value) ||
    point.value < 0
  )
    return false;
  const time = timeOf(point);
  return Number.isSafeInteger(time) && time <= capturedAt;
}

/** Restore only recorded project observations from an explicitly selected,
 * previously validated snapshot containing complete individual project rows.
 * Paginated catalogs omit whole projects; their counts and scope stay intact.
 * Ownership ambiguity checks cover the supplied rows, not omitted projects.
 * This is pure: it performs no I/O and
 * never refreshes clocks, computes values, changes project scope, or restores
 * global history. The caller must supply the application's snapshot validator.
 *
 * Exact project IDs and the complete deployment identity set must agree. A
 * normalized timestamp identifies an observation; current observations win.
 * Conflicting original observations are omitted. Every current point is kept,
 * with the newest eligible original points filling the remaining 672 slots.
 * Original timestamps/values are never converted, interpolated or averaged.
 */
export function mergeProjectHistory(
  current,
  original,
  { validateSnapshot } = {},
) {
  if (typeof validateSnapshot !== "function")
    throw new TypeError("History recovery requires the snapshot validator.");
  if (validateSnapshot(current) !== true)
    throw new TypeError("Current snapshot is invalid; history was not merged.");
  if (validateSnapshot(original) !== true)
    throw new TypeError(
      "Original snapshot is invalid; history was not merged.",
    );
  const currentTime = Date.parse(current.generatedAt),
    originalTime = Date.parse(original.generatedAt);
  if (
    !Number.isFinite(currentTime) ||
    !Number.isFinite(originalTime) ||
    originalTime > currentTime
  )
    throw new TypeError("Original snapshot must not be newer than current.");

  const currentIndex = indexSnapshot(current),
    originalIndex = indexSnapshot(original),
    replacements = new Map();
  const report = {
    version: 1,
    historyLimit: HISTORY_LIMIT,
    currentGeneratedAt: current.generatedAt,
    originalGeneratedAt: original.generatedAt,
    currentCatalog: catalogScope(current),
    originalCatalog: catalogScope(original),
    ownershipChecks: "loaded-projects-only",
    currentPoints: current.projects.reduce((n, p) => n + p.history.length, 0),
    originalPoints: original.projects.reduce((n, p) => n + p.history.length, 0),
    restoredProjects: 0,
    restoredPoints: 0,
    skippedProjects: 0,
    skippedOriginalPoints: 0,
    existingPoints: 0,
    currentConflictPoints: 0,
    duplicateOriginalPoints: 0,
    conflictingOriginalPoints: 0,
    invalidOriginalPoints: 0,
    windowExcludedPoints: 0,
    projects: [],
  };
  for (const [id, originals] of originalIndex.projects) {
    const sourcePoints = originals.reduce((n, p) => n + p.history.length, 0);
    if (!sourcePoints) continue;
    const currents = currentIndex.projects.get(id);
    const row = {
      projectId: id,
      originalPoints: sourcePoints,
      restoredPoints: 0,
    };
    const skip = (reason) => {
      row.reason = reason;
      report.skippedProjects++;
      report.skippedOriginalPoints += sourcePoints;
      report.projects.push(row);
    };
    if (!currents) {
      skip("missing-current-project");
      continue;
    }
    if (currents.length !== 1 || originals.length !== 1) {
      skip("duplicate-project-id");
      continue;
    }
    const project = currents[0],
      source = originals[0],
      identity = identityOf(project, currentIndex),
      sourceIdentity = identityOf(source, originalIndex);
    if (identity.reason || sourceIdentity.reason) {
      skip(identity.reason || sourceIdentity.reason);
      continue;
    }
    if (identity.key !== sourceIdentity.key) {
      skip("changed-deployments");
      continue;
    }
    // Do not repair or discard existing observations as a side effect.
    if (
      project.history.length > HISTORY_LIMIT ||
      project.history.some(
        (point, i) =>
          !validPoint(point, currentTime) ||
          (i > 0 && timeOf(project.history[i - 1]) >= timeOf(point)),
      )
    ) {
      skip("ambiguous-current-history");
      continue;
    }
    const currentByTime = new Map(project.history.map((p) => [timeOf(p), p])),
      sourceByTime = new Map();
    const counts = {
      existingPoints: 0,
      currentConflictPoints: 0,
      duplicateOriginalPoints: 0,
      conflictingOriginalPoints: 0,
      invalidOriginalPoints: 0,
      windowExcludedPoints: 0,
    };
    for (const point of source.history) {
      if (!validPoint(point, originalTime)) {
        counts.invalidOriginalPoints++;
        continue;
      }
      const time = timeOf(point),
        present = currentByTime.get(time);
      if (present) {
        if (present.value === point.value) counts.existingPoints++;
        else counts.currentConflictPoints++;
        continue;
      }
      const points = sourceByTime.get(time) || [];
      points.push(point);
      sourceByTime.set(time, points);
    }
    const candidates = [];
    for (const points of sourceByTime.values()) {
      if (points.some((point) => point.value !== points[0].value)) {
        counts.conflictingOriginalPoints += points.length;
        continue;
      }
      candidates.push(points[0]);
      counts.duplicateOriginalPoints += points.length - 1;
    }
    candidates.sort((a, b) => timeOf(a) - timeOf(b));
    const available = HISTORY_LIMIT - project.history.length,
      restored = available ? candidates.slice(-available) : [];
    counts.windowExcludedPoints = candidates.length - restored.length;
    const merged = [...project.history, ...restored].sort(
      (a, b) => timeOf(a) - timeOf(b),
    );
    // The existing persistence validator also requires raw timestamp order.
    // Mixed legacy units cannot justify changing an original timestamp.
    if (
      merged.some(
        (point, i) => i > 0 && merged[i - 1].timestamp >= point.timestamp,
      )
    ) {
      skip("mixed-unit-order");
      continue;
    }
    for (const [key, value] of Object.entries(counts)) report[key] += value;
    Object.assign(row, counts, { restoredPoints: restored.length });
    if (restored.length) {
      replacements.set(project, { ...project, history: merged });
      report.restoredProjects++;
      report.restoredPoints += restored.length;
    }
    report.projects.push(row);
  }
  const snapshot = replacements.size
    ? {
        ...current,
        projects: current.projects.map((p) => replacements.get(p) || p),
      }
    : current;
  if (validateSnapshot(snapshot) !== true)
    throw new TypeError(
      "Recovered snapshot failed validation; no result returned.",
    );
  report.resultPoints = report.currentPoints + report.restoredPoints;
  return { snapshot, report };
}

/** An equal value and clock under a changed publication identity do not retain
 * the original association. This frame is only an archive comparison target;
 * it must never replace the actual recovered publication. Public sources carry
 * no native replacement epoch, so neither side invents that missing evidence. */
export function historyRecoveryArchiveTarget(original, candidate) {
  const sources = new Map(),
    counts = new Map();
  for (const project of original.projects) {
    const rows = sources.get(project.id) || [];
    rows.push(project);
    sources.set(project.id, rows);
  }
  for (const project of candidate.projects)
    counts.set(project.id, (counts.get(project.id) || 0) + 1);
  let changed = false;
  const projects = candidate.projects.map((project) => {
    const rows = sources.get(project.id);
    if (!rows?.some((row) => row.history.length) || !project.history.length)
      return project;
    if (
      rows.length === 1 &&
      counts.get(project.id) === 1 &&
      capturedHistoryScope(original, rows[0]).id ===
        capturedHistoryScope(candidate, project).id
    )
      return project;
    changed = true;
    return { ...project, history: [] };
  });
  const history =
    original.history.length &&
    capturedHistoryScope(original, null).id !==
      capturedHistoryScope(candidate, null).id
      ? []
      : candidate.history;
  return changed || history !== candidate.history
    ? {
        ...candidate,
        projects: changed ? projects : candidate.projects,
        history,
      }
    : candidate;
}
