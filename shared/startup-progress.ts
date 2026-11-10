import type { RadarStartupProgress } from "./types";

/** Only public, bounded verification counters cross the startup boundary. */
export function safeStartupProgress(
  value: unknown,
): RadarStartupProgress | null {
  if (!value || typeof value !== "object" || !("phase" in value)) return null;
  if (value.phase === "checking-history" || value.phase === "preparing-radar")
    return Object.freeze({ phase: value.phase });
  if (
    value.phase !== "checking-pools" ||
    !("checkedPools" in value) ||
    !("totalPools" in value) ||
    typeof value.checkedPools !== "number" ||
    typeof value.totalPools !== "number" ||
    !Number.isSafeInteger(value.checkedPools) ||
    !Number.isSafeInteger(value.totalPools) ||
    value.checkedPools < 0 ||
    value.totalPools < value.checkedPools
  )
    return null;
  return Object.freeze({
    phase: "checking-pools",
    checkedPools: value.checkedPools,
    totalPools: value.totalPools,
  });
}
