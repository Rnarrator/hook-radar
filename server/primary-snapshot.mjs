import { lstat, open } from "node:fs/promises";
import { freemem } from "node:os";
import { getHeapStatistics } from "node:v8";
import { createHash } from "node:crypto";

export const PRIMARY_SNAPSHOT_MAX_BYTES = 128 * 1024 * 1024;
const MEMORY_RESERVE = 512 * 1024 * 1024;
const same = (a, b) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs;
const failure = (code, message, cause) =>
  Object.assign(new Error(message, cause ? { cause } : undefined), { code });
const heapHeadroom = () => {
  const heap = getHeapStatistics();
  return heap.heap_size_limit - heap.used_heap_size;
};

/** A present but unreadable full snapshot is not an empty history. Capacity,
 * memory, I/O and replacement failures must stop initialization before a fresh
 * bootstrap can overwrite the recorded observations. Only a missing file may
 * bootstrap; present malformed content is preserved. Domain validation stays in store. */
export async function readPrimarySnapshot(
  path,
  {
    signal,
    availableMemory = freemem,
    availableHeap = heapHeadroom,
    expectedSha256,
  } = {},
) {
  signal?.throwIfAborted();
  if (
    expectedSha256 !== undefined &&
    (typeof expectedSha256 !== "string" ||
      !/^[a-f0-9]{64}$/i.test(expectedSha256))
  )
    throw failure(
      "RADAR_SNAPSHOT_HASH_INVALID",
      "Recovery source requires a SHA-256 digest.",
    );
  let atPath;
  try {
    atPath = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw failure(
      "RADAR_SNAPSHOT_READ_FAILED",
      "Saved snapshot could not be inspected; the existing file is preserved.",
      error,
    );
  }
  signal?.throwIfAborted();
  if (!atPath.isFile() || atPath.isSymbolicLink())
    throw failure(
      "RADAR_SNAPSHOT_UNSAFE_FILE",
      "Saved snapshot is not a regular file; it is preserved for recovery.",
    );
  if (atPath.size > PRIMARY_SNAPSHOT_MAX_BYTES)
    throw failure(
      "RADAR_SNAPSHOT_TOO_LARGE",
      "Saved snapshot exceeds the 128 MiB recovery limit; it is preserved for recovery.",
    );
  const required = MEMORY_RESERVE + atPath.size * 8;
  let physical, heap;
  try {
    physical = availableMemory();
    heap = availableHeap();
  } catch (error) {
    throw failure(
      "RADAR_SNAPSHOT_MEMORY",
      "Saved snapshot memory capacity could not be established; the existing file is preserved.",
      error,
    );
  }
  if (
    !Number.isFinite(physical) ||
    !Number.isFinite(heap) ||
    physical < required ||
    heap < required
  )
    throw failure(
      "RADAR_SNAPSHOT_MEMORY",
      "Saved snapshot needs more memory to recover safely; it is preserved. Retry when memory is available.",
    );
  let file;
  try {
    file = await open(path, "r");
    const before = await file.stat();
    if (!before.isFile() || !same(before, atPath))
      throw failure(
        "RADAR_SNAPSHOT_CHANGED",
        "Saved snapshot changed during recovery; the existing file is preserved.",
      );
    signal?.throwIfAborted();
    const buffer = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(
        buffer,
        offset,
        Math.min(65536, buffer.length - offset),
        offset,
      );
      signal?.throwIfAborted();
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (
      offset !== before.size ||
      !same(before, await file.stat()) ||
      !same(before, await lstat(path))
    )
      throw failure(
        "RADAR_SNAPSHOT_CHANGED",
        "Saved snapshot changed during recovery; the existing file is preserved.",
      );
    signal?.throwIfAborted();
    if (
      expectedSha256 !== undefined &&
      createHash("sha256").update(buffer.subarray(0, offset)).digest("hex") !==
        expectedSha256.toLowerCase()
    )
      throw failure(
        "RADAR_SNAPSHOT_HASH_MISMATCH",
        "Recovery source does not match its recorded SHA-256 digest; saved data is unchanged.",
      );
    let decoded;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, offset),
      );
    } catch (error) {
      if (error?.code === "ERR_ENCODING_INVALID_ENCODED_DATA")
        throw failure(
          "RADAR_SNAPSHOT_INVALID",
          "Saved snapshot is not valid UTF-8; the existing file is preserved for recovery.",
          error,
        );
      throw error;
    }
    try {
      const snapshot = JSON.parse(decoded);
      // null is reserved for ENOENT, never a present file's decoded contents.
      if (snapshot === null)
        throw failure(
          "RADAR_SNAPSHOT_INVALID",
          "Saved snapshot is null; the existing file is preserved for recovery.",
        );
      return snapshot;
    } catch (error) {
      if (error instanceof SyntaxError)
        throw failure(
          "RADAR_SNAPSHOT_INVALID",
          "Saved snapshot is not valid JSON; the existing file is preserved for recovery.",
          error,
        );
      throw error;
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error?.code?.startsWith("RADAR_SNAPSHOT_")) throw error;
    throw failure(
      "RADAR_SNAPSHOT_READ_FAILED",
      "Saved snapshot could not be read safely; the existing file is preserved.",
      error,
    );
  } finally {
    await file?.close().catch(() => {});
  }
}
