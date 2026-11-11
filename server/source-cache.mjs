import { open, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

/** Check the file before allocation and read only the captured, bounded prefix. */
export async function boundedJson(path, maxBytes, parseJson = JSON.parse) {
  let handle;
  try {
    handle = await open(path, "r");
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxBytes) return null;
    const buffer = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (
      offset !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    )
      return null;
    return parseJson(buffer.subarray(0, offset).toString("utf8"));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export class SourceCache {
  constructor({
    directory,
    maxEntries = 256,
    maxBytes = 64 * 1024 * 1024,
    maxDiskEntries = 2048,
    maxDiskBytes = 128 * 1024 * 1024,
  } = {}) {
    for (const value of [maxEntries, maxBytes, maxDiskEntries, maxDiskBytes])
      if (!Number.isSafeInteger(value) || value < 1)
        throw new RangeError("Invalid source cache budget.");
    Object.assign(this, {
      directory,
      maxEntries,
      maxBytes,
      maxDiskEntries,
      maxDiskBytes,
    });
    this.memory = new Map();
    this.sizes = new Map();
    this.bytes = 0;
    this.prunePending = null;
  }
  remove(id) {
    this.memory.delete(id);
    this.bytes -= this.sizes.get(id) || 0;
    this.sizes.delete(id);
  }
  retain(id, row) {
    this.remove(id);
    const bytes = Buffer.byteLength(JSON.stringify(row));
    if (bytes > this.maxBytes) return;
    this.memory.set(id, row);
    this.sizes.set(id, bytes);
    this.bytes += bytes;
    while (this.memory.size > this.maxEntries || this.bytes > this.maxBytes)
      this.remove(this.memory.keys().next().value);
  }
  prune(protectedFiles = new Set()) {
    if (this.prunePending) return this.prunePending;
    const job = this._prune(protectedFiles).finally(() => {
      this.prunePending = null;
    });
    this.prunePending = job;
    return job;
  }
  async _prune(protectedFiles) {
    let entries;
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch {
      return { files: 0, bytes: 0, removed: 0 };
    }
    const rows = [];
    let bytes = 0;
    for (const entry of entries) {
      // Only our exact hashed cache filenames are eligible, never journals or foreign files.
      if (!entry.isFile() || !/^[a-f0-9]{20}\.json$/.test(entry.name)) continue;
      const path = join(this.directory, entry.name);
      try {
        const metadata = await stat(path);
        if (!metadata.isFile()) continue;
        rows.push({
          path,
          name: entry.name,
          bytes: metadata.size,
          modified: metadata.mtimeMs,
        });
        bytes += metadata.size;
      } catch {
        /* A concurrent write can replace an expendable source cache. */
      }
    }
    rows.sort(
      (a, b) => a.modified - b.modified || a.name.localeCompare(b.name),
    );
    let files = rows.length,
      removed = 0;
    for (const row of rows) {
      if (files <= this.maxDiskEntries && bytes <= this.maxDiskBytes) break;
      if (protectedFiles.has(row.name)) continue;
      try {
        const current = await stat(row.path);
        if (current.mtimeMs !== row.modified || current.size !== row.bytes)
          continue;
        await unlink(row.path);
        bytes -= row.bytes;
        files--;
        removed++;
      } catch {
        /* Read-only disks retain data; reads remain available. */
      }
    }
    return { files, bytes, removed };
  }
}
