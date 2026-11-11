import { isAbsolute } from "node:path";
import { readPrimarySnapshot } from "./primary-snapshot.mjs";
import {
  mergeProjectHistory,
  historyRecoveryArchiveTarget,
} from "./history-recovery.mjs";

export function configuredHistoryRecovery(env = process.env) {
  const file = env.RADAR_HISTORY_RECOVERY_FILE;
  const sha256 = env.RADAR_HISTORY_RECOVERY_SHA256;
  if (file === undefined && sha256 === undefined) return null;
  if (
    typeof file !== "string" ||
    !isAbsolute(file) ||
    typeof sha256 !== "string" ||
    !/^[a-f0-9]{64}$/i.test(sha256)
  )
    throw new Error(
      "History recovery requires an absolute RADAR_HISTORY_RECOVERY_FILE and its exact RADAR_HISTORY_RECOVERY_SHA256 digest.",
    );
  return Object.freeze({ file, sha256: sha256.toLowerCase() });
}

/** An explicit, read-only source of historical observations. Saving the merged
 * frame remains the normal store's responsibility. Never replace live state
 * with the older source or infer new prices from historical observations. */
export async function recoverProjectHistory(
  current,
  source,
  { signal, validateSnapshot, normalizeSnapshot = (value) => value } = {},
) {
  const config = configuredHistoryRecovery({
    RADAR_HISTORY_RECOVERY_FILE: source?.file,
    RADAR_HISTORY_RECOVERY_SHA256: source?.sha256,
  });
  if (!config) throw new Error("History recovery source is missing.");
  const captured = await readPrimarySnapshot(config.file, {
    signal,
    expectedSha256: config.sha256,
  });
  signal?.throwIfAborted();
  if (typeof normalizeSnapshot !== "function")
    throw new TypeError("History recovery normalization must be a function.");
  // The pinned bytes are verified before this explicit, schema-only migration.
  // The normalizer must preserve original observations and source clocks.
  const original = captured === null ? null : normalizeSnapshot(captured);
  signal?.throwIfAborted();
  if (
    !original ||
    typeof validateSnapshot !== "function" ||
    !validateSnapshot(original)
  )
    throw new Error(
      "History recovery source is missing or invalid; saved data is unchanged.",
    );
  const result = mergeProjectHistory(current, original, { validateSnapshot });
  signal?.throwIfAborted();
  return {
    ...result,
    // Private startup input for durable archival before the recovered frame is
    // published. Never serialize the complete source into the health report.
    sourceSnapshot: original,
    archiveTarget: historyRecoveryArchiveTarget(original, result.snapshot),
    report: { ...result.report, sourceSha256: config.sha256 },
  };
}
