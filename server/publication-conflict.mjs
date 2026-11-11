const STAGES = new Set(["overlay-rebase", "archive-fence"]);
const FAILURE_CODES = new Map([
  ["RADAR_MARKET_OVERLAY_BUSY", "publication-changed"],
  ["RADAR_SNAPSHOT_TOO_LARGE", "snapshot-limit"],
  ["RADAR_HISTORY_ARCHIVE", "history-archive"],
  ["RADAR_SHUTTING_DOWN", "shutdown"],
  ["POOL_INDEX_BUSY", "index-busy"],
  ["POOL_INDEX_TIMEOUT", "index-timeout"],
  ["POOL_INDEX_BEHIND", "index-behind"],
  ["POOL_INDEX_WORKER_STOPPED", "index-unavailable"],
  ["POOL_INDEX_UNAVAILABLE", "index-unavailable"],
  ["POOL_INDEX_CORRUPT", "index-integrity"],
  ["POOL_INDEX_FORK", "canonical-change"],
  ["POOL_INDEX_REPLACED", "canonical-change"],
  ["POOL_INDEX_CAPACITY", "storage-limit"],
  ["ERR_SQLITE_ERROR", "storage-error"],
  ["ENOSPC", "disk-full"],
  ["EACCES", "permission-denied"],
  ["EPERM", "permission-denied"],
  ["ETIMEDOUT", "timeout"],
]);

export function safePublicationFailure(error) {
  // Capture the code once. Messages, causes, stacks and getters stay private.
  let code;
  try {
    if (error && typeof error === "object")
      code = Object.getOwnPropertyDescriptor(error, "code")?.value;
  } catch {
    // Diagnostic proxies cannot change error handling.
  }
  return typeof code === "string" && FAILURE_CODES.has(code)
    ? {
        code,
        reason: FAILURE_CODES.get(code),
        ...publicationConflictDiagnostic(error, code),
      }
    : { code: null, reason: "unknown" };
}

/** Revalidate only the bounded stored diagnostic, never a source error. */
export function safeRefreshFailureRecord(value) {
  try {
    if (!value || typeof value !== "object") return null;
    const own = (key) => Object.getOwnPropertyDescriptor(value, key)?.value;
    const active = own("active");
    const occurrences = own("occurrences");
    if (
      typeof active !== "boolean" ||
      !Number.isSafeInteger(occurrences) ||
      occurrences < 1 ||
      occurrences > 2147483647
    )
      return null;
    const clock = (key) => {
      const at = own(key);
      if (at === null) return null;
      if (typeof at !== "string" || at.length > 32) return undefined;
      const parsed = Date.parse(at);
      return Number.isFinite(parsed) &&
        parsed >= 0 &&
        new Date(parsed).toISOString() === at
        ? at
        : undefined;
    };
    const firstRecordedAt = clock("firstRecordedAt");
    const lastRecordedAt = clock("lastRecordedAt");
    const resolvedAt = clock("resolvedAt");
    if (
      [firstRecordedAt, lastRecordedAt, resolvedAt].includes(undefined) ||
      (active && resolvedAt !== null)
    )
      return null;
    const code = own("code");
    const fields =
      typeof code === "string" && FAILURE_CODES.has(code)
        ? { code, reason: FAILURE_CODES.get(code) }
        : { code: null, reason: "unknown" };
    if (code === "RADAR_MARKET_OVERLAY_BUSY") {
      const stage = own("stage");
      const snapshot = own("observedSnapshotConflict");
      const revision = own("observedOverlayRevisionConflict");
      const canonical = own("observedCanonicalConflict");
      if (
        STAGES.has(stage) &&
        [snapshot, revision, canonical].every(
          (flag) => typeof flag === "boolean",
        ) &&
        (snapshot || revision || canonical)
      )
        Object.assign(fields, {
          stage,
          observedSnapshotConflict: snapshot,
          observedOverlayRevisionConflict: revision,
          observedCanonicalConflict: canonical,
        });
    }
    return {
      ...fields,
      active,
      resolvedAt,
      firstRecordedAt,
      lastRecordedAt,
      occurrences,
    };
  } catch {
    return null;
  }
}

/** Optional, bounded diagnostics for an already classified publication error.
 * False means not observed rejecting, including guards skipped by short circuit.
 * The caller supplies its captured code so a stateful proxy is never read twice.
 */
export function publicationConflictDiagnostic(error, code) {
  if (code !== "RADAR_MARKET_OVERLAY_BUSY") return {};
  try {
    if (!error || typeof error !== "object") return {};
    const stage = Object.getOwnPropertyDescriptor(
      error,
      "publicationStage",
    )?.value;
    const mask = Object.getOwnPropertyDescriptor(
      error,
      "publicationConflictMask",
    )?.value;
    if (
      !STAGES.has(stage) ||
      !Number.isSafeInteger(mask) ||
      mask < 1 ||
      mask > 7
    )
      return {};
    return {
      stage,
      observedSnapshotConflict: Boolean(mask & 1),
      observedOverlayRevisionConflict: Boolean(mask & 2),
      observedCanonicalConflict: Boolean(mask & 4),
    };
  } catch {
    return {};
  }
}
