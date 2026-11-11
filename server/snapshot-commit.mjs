import { open, rename } from "node:fs/promises";
import { dirname } from "node:path";

/** The caller has already synced and closed the complete temporary snapshot.
 * POSIX requires syncing the parent directory to persist its replacement name.
 * Windows does not expose portable directory fsync through Node: there we keep
 * the existing synced-file + atomic-rename boundary, without claiming a durable
 * directory entry across power loss. A failure never removes the saved file. */
export async function renamePrimarySnapshot(
  temporary,
  destination,
  {
    platform = process.platform,
    renameFile = rename,
    openDirectory = open,
  } = {},
) {
  await renameFile(temporary, destination);
  if (platform === "win32") return false;
  const directory = await openDirectory(dirname(destination), "r");
  let syncFailed = false;
  try {
    await directory.sync();
  } catch (error) {
    syncFailed = true;
    throw error;
  } finally {
    if (syncFailed) await directory.close().catch(() => {});
    else await directory.close();
  }
  return true;
}
