// The last gate before data files are published: they must be a snapshot from a
// live collection, never the output of an offline fixture replay.
//
//   node scripts/check-edition-data.mjs [dataDir]      (default: public/data)
//
// The collector writes status.json before snapshot.json and marks a replay of
// recorded fixtures with "offline": true there (snapshot.json carries no such
// marker). So a folder passes only when status.json exists, is not marked
// offline, and names the same generatedAt as snapshot.json. Files from two
// different runs, or a snapshot with no status next to it, are refused too.
//
// daily.json (the 7D and 30D volume of the largest pools) is optional, and
// snapshot.json says whether it exists: it names the file as a source
// (geckoterminal-daily) exactly when the file is there. A file that is not valid,
// that belongs to another run, or that counts a day that was not complete is
// refused (the rules are shared/daily-volume.ts, which the collector applies
// before it writes the file and the page applies when it reads it).
import { realpathSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DAILY_FILE_NAME,
  DAILY_SOURCE_ID,
  dailyRunProblem,
  validateDailyShape,
} from "../shared/daily-volume.ts";

async function readJson(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { missing: true };
    return { error: error.message };
  }
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: "it is not valid JSON" };
  }
}

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const hasTime = (value) =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

/**
 * Looks at the data folder. `present` says whether snapshot.json exists at all;
 * `problems` lists everything that makes the folder unfit to publish (a missing
 * snapshot is for the caller to decide on, except that other files without one
 * are always a problem, because nothing then vouches for where they came from).
 */
export async function inspectPublishedData(dataDir) {
  const problems = [];
  const snapshot = await readJson(join(dataDir, "snapshot.json"));
  if (snapshot.missing) {
    const others = (await readdir(dataDir).catch(() => [])).filter(
      (name) => !name.startsWith("."),
    );
    if (others.length)
      problems.push(
        `the folder holds ${others.length === 1 ? `a file (${others[0]})` : `${others.length} files`} but no snapshot.json, so nothing confirms where they came from`,
      );
    return { present: false, generatedAt: null, problems };
  }

  let generatedAt = null;
  if (snapshot.error)
    problems.push(`snapshot.json cannot be read: ${snapshot.error}`);
  else if (!isObject(snapshot.value) || !hasTime(snapshot.value.generatedAt))
    problems.push("snapshot.json has no valid generatedAt time");
  else generatedAt = snapshot.value.generatedAt;

  const status = await readJson(join(dataDir, "status.json"));
  if (status.missing)
    problems.push(
      "status.json is missing, so nothing confirms the snapshot came from a live collection",
    );
  else if (status.error)
    problems.push(`status.json cannot be read: ${status.error}`);
  else if (!isObject(status.value))
    problems.push("status.json is not a JSON object");
  else {
    if (status.value.offline === true)
      problems.push(
        'status.json says "offline": true: this is a replay of recorded test fixtures, not live data',
      );
    else if (
      status.value.offline !== undefined &&
      status.value.offline !== false
    )
      problems.push('status.json has an unreadable "offline" marker');
    if (generatedAt !== null && status.value.generatedAt !== generatedAt)
      problems.push(
        `status.json generatedAt (${JSON.stringify(status.value.generatedAt ?? null)}) is not snapshot.json generatedAt (${JSON.stringify(generatedAt)}): the files are from different runs`,
      );
  }
  problems.push(
    ...(await dailyProblems(dataDir, snapshot.value, generatedAt)),
  );
  return { present: true, generatedAt, problems };
}

/** What is wrong with daily.json next to the snapshot, if anything. */
async function dailyProblems(dataDir, snapshot, generatedAt) {
  const sources = Array.isArray(snapshot?.sources) ? snapshot.sources : [];
  const named = sources.filter((source) => source?.id === DAILY_SOURCE_ID);
  const daily = await readJson(join(dataDir, DAILY_FILE_NAME));
  if (daily.missing)
    return named.length
      ? [
          `snapshot.json names the daily volume as a source but ${DAILY_FILE_NAME} is missing`,
        ]
      : [];
  if (daily.error)
    return [`${DAILY_FILE_NAME} cannot be read: ${daily.error}`];
  const shape = validateDailyShape(daily.value);
  if (!shape.ok) return [`${DAILY_FILE_NAME} is not valid: ${shape.reason}`];
  if (generatedAt === null) return [];
  const problem = dailyRunProblem(shape.file, {
    generatedAt,
    sources: sources.filter((source) => source && typeof source.id === "string"),
  });
  return problem ? [`${DAILY_FILE_NAME}: ${problem}`] : [];
}

const blockersOf = ({ present, problems }) =>
  present
    ? problems
    : ["snapshot.json is missing (run `npm run collect` first)", ...problems];

/** Every reason the folder may not be published; empty when it is fit. A missing snapshot counts. */
export async function publishBlockers(dataDir) {
  return blockersOf(await inspectPublishedData(dataDir));
}

export async function main(argv) {
  if (argv.length > 1 || argv[0]?.startsWith("-")) {
    console.error("Usage: node scripts/check-edition-data.mjs [dataDir]");
    return 2;
  }
  const dataDir = resolve(
    argv[0] ??
      join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data"),
  );
  const found = await inspectPublishedData(dataDir);
  const { generatedAt } = found;
  const blockers = blockersOf(found);
  if (blockers.length) {
    console.error(`${dataDir} is not fit to publish:`);
    for (const problem of blockers) console.error(`  - ${problem}`);
    return 1;
  }
  console.log(`${dataDir}: live snapshot generated at ${generatedAt}`);
  return 0;
}

/**
 * Whether this file is the script the process was started with. The paths are
 * compared as real paths, so a start through a symlink or a directory junction
 * counts as a direct start: this gate must never go quiet and exit 0 because
 * two spellings of one path differ. It fails closed: a path that cannot be
 * resolved falls back to the plain comparison, a process started with a file of
 * this name (a copy or a hard link) counts too, and so does Node's own
 * entry-point flag (24.2 and later). Only a script of another name, such as the
 * build or a test importing this module, is not a direct start.
 */
export function startedDirectly(
  entry = process.argv[1],
  self = fileURLToPath(import.meta.url),
) {
  if (import.meta.main === true) return true;
  if (!entry) return false;
  const real = (path) => {
    try {
      return realpathSync.native(path);
    } catch {
      return resolve(path);
    }
  };
  return (
    real(entry).toLowerCase() === real(self).toLowerCase() ||
    basename(entry).toLowerCase() === basename(self).toLowerCase()
  );
}

if (startedDirectly()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    },
  );
}
