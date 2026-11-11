import { mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runCooperatively } from "./cooperative.mjs";
import { snapshotJsonChunks } from "./snapshot-json.mjs";

export const STARTUP_SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;
export const STARTUP_VIEW_FILENAME = "startup-view.json";

function* presentationSteps(snapshot) {
  const projects = [];
  for (const project of snapshot.projects) {
    // Per-project histories are restored by the primary snapshot and full
    // exports, but are not rendered by the saved UI. Global history remains.
    projects.push({ ...project, history: [] });
    if (projects.length % 256 === 0) yield;
  }
  return { ...snapshot, projects };
}

export function compactStartupView(snapshot, options = {}) {
  return runCooperatively(presentationSteps(snapshot), options);
}

/** Optional presentation only. A failed write never replaces the last complete
 * view, authorizes canonical reads, or changes primary snapshot persistence. */
export async function writeStartupView({
  cacheDir,
  snapshot,
  validate,
  signal,
}) {
  let temporary;
  let file;
  try {
    signal?.throwIfAborted();
    if (typeof validate !== "function" || !validate(snapshot)) return false;
    const presentation = await compactStartupView(snapshot, { signal });
    signal?.throwIfAborted();
    await mkdir(cacheDir, { recursive: true });
    const target = join(cacheDir, STARTUP_VIEW_FILENAME);
    temporary = `${target}.${randomUUID()}.tmp`;
    file = await open(temporary, "wx");
    let bytes = 0;
    for await (const chunk of snapshotJsonChunks(presentation, { signal })) {
      bytes += chunk.length;
      if (bytes > STARTUP_SNAPSHOT_MAX_BYTES) return false;
      await file.writeFile(chunk);
    }
    signal?.throwIfAborted();
    await file.sync();
    await file.close();
    file = null;
    signal?.throwIfAborted();
    await rename(temporary, target);
    return true;
  } catch {
    return false;
  } finally {
    await file?.close().catch(() => {});
    if (temporary) await unlink(temporary).catch(() => {});
  }
}
