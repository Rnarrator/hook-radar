import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isAddress, isPoolId, ZERO_ADDRESS } from "../server/model.mjs";
import {
  DAILY_KEEP_RANK,
  DAILY_STORED_DAYS,
  HISTORY_MAX_POINTS,
  MAX_PRIORITY_POOLS,
} from "./config.mjs";

// The persistent state committed in state/. Every reader validates what it
// reads and every writer is atomic, so a crashed run leaves the old files.

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const isIso = (value) =>
  typeof value === "string" &&
  ISO.test(value) &&
  Number.isFinite(Date.parse(value));
const CHAIN_SLUG = /^[a-z0-9][a-z0-9-]{0,49}$/;
const lower = (value) =>
  typeof value === "string" && value === value.toLowerCase();

export const poolKey = (chain, id) => `${chain}:${id}`;

export function isStatePool(row) {
  return (
    !!row &&
    typeof row === "object" &&
    isPoolId(row.id) &&
    lower(row.id) &&
    typeof row.chain === "string" &&
    CHAIN_SLUG.test(row.chain) &&
    isAddress(row.hookAddress) &&
    lower(row.hookAddress) &&
    row.hookAddress !== ZERO_ADDRESS &&
    Array.isArray(row.tokens) &&
    row.tokens.length === 2 &&
    row.tokens.every((token) => isAddress(token) && lower(token)) &&
    row.tokens[0] !== row.tokens[1] &&
    typeof row.name === "string" &&
    row.name.length <= 180 &&
    (row.createdAt === null || isIso(row.createdAt)) &&
    (row.via === undefined || row.via === "geckoterminal") &&
    (row.dynamicFee === undefined || typeof row.dynamicFee === "boolean") &&
    typeof row.source === "string" &&
    row.source.length > 0 &&
    row.source.length <= 100 &&
    isIso(row.firstSeen) &&
    isIso(row.lastSeen)
  );
}

// The priority list holds plain pool identities and nothing else: the exact
// fields below, each of a fixed shape. A provider's URL, a key, a figure or any
// other field makes the file invalid, so it can be committed to a public
// repository without a look at its contents.
export const PRIORITY_POOL_KEYS = Object.freeze([
  "id",
  "chain",
  "hookAddress",
  "tokens",
  "name",
  "createdAt",
  "projectId",
]);
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,99}$/;
// A pool name is two symbols; anything that looks like an address of a web
// service, a credential or markup is not one. No control character, bracket,
// quote or backslash, and at most 100 characters.
const PLAIN_NAME = /^[^\p{C}<>"'`\\]{1,100}$/u;
const WEB_ADDRESS = /:\/\/|www\./i;

/** Whether a pool name may be written to the priority list. */
export const isPlainPoolName = (name) =>
  typeof name === "string" && PLAIN_NAME.test(name) && !WEB_ADDRESS.test(name);

export function isPriorityPool(row) {
  return (
    !!row &&
    typeof row === "object" &&
    !Array.isArray(row) &&
    Object.keys(row).every((key) => PRIORITY_POOL_KEYS.includes(key)) &&
    PRIORITY_POOL_KEYS.every((key) => key in row) &&
    isPoolId(row.id) &&
    lower(row.id) &&
    typeof row.chain === "string" &&
    CHAIN_SLUG.test(row.chain) &&
    isAddress(row.hookAddress) &&
    lower(row.hookAddress) &&
    row.hookAddress !== ZERO_ADDRESS &&
    Array.isArray(row.tokens) &&
    row.tokens.length === 2 &&
    row.tokens.every((token) => isAddress(token) && lower(token)) &&
    row.tokens[0] !== row.tokens[1] &&
    isPlainPoolName(row.name) &&
    (row.createdAt === null || isIso(row.createdAt)) &&
    typeof row.projectId === "string" &&
    PROJECT_ID.test(row.projectId)
  );
}

const PRIORITY_SELECTION_KEYS = ["snapshotGeneratedAt", "rule", "counts"];

/** The priority file as written: its pools, and how they were chosen. */
export function isPriorityFile(value) {
  const selection = value?.selection;
  return (
    !!value &&
    typeof value === "object" &&
    Object.keys(value).every((key) =>
      ["schemaVersion", "exportedAt", "selection", "pools"].includes(key),
    ) &&
    value.schemaVersion === 1 &&
    isIso(value.exportedAt) &&
    !!selection &&
    typeof selection === "object" &&
    Object.keys(selection).every((key) =>
      PRIORITY_SELECTION_KEYS.includes(key),
    ) &&
    isIso(selection.snapshotGeneratedAt) &&
    typeof selection.rule === "string" &&
    selection.rule.length <= 2000 &&
    !!selection.counts &&
    typeof selection.counts === "object" &&
    Object.values(selection.counts).every(
      (count) => Number.isSafeInteger(count) && count >= 0,
    ) &&
    Array.isArray(value.pools) &&
    value.pools.length <= MAX_PRIORITY_POOLS &&
    value.pools.every(isPriorityPool) &&
    new Set(value.pools.map((row) => poolKey(row.chain, row.id))).size ===
      value.pools.length
  );
}

export function isHistoryPoint(point) {
  return (
    !!point &&
    typeof point.timestamp === "number" &&
    Number.isFinite(point.timestamp) &&
    point.timestamp >= 0 &&
    typeof point.value === "number" &&
    Number.isFinite(point.value) &&
    point.value >= 0 &&
    Number.isSafeInteger(point.pools) &&
    point.pools >= 0
  );
}

export function isHistory(value) {
  return (
    !!value &&
    value.schemaVersion === 1 &&
    Array.isArray(value.points) &&
    value.points.length <= HISTORY_MAX_POINTS &&
    value.points.every(isHistoryPoint) &&
    value.points.every(
      (point, index) =>
        index === 0 || point.timestamp > value.points[index - 1].timestamp,
    )
  );
}

// The daily-volume records (state/daily.json, written by the collector, never by
// hand): for each of the largest pools, the complete UTC days read from
// GeckoTerminal and when. `result` is the last definite answer (null: never
// asked), `attemptedAt` when it came, `fetchedAt` the time the last readable
// answer was true, `bad` how many unreadable answers came in a row, `start`
// the first day GeckoTerminal has for the pool when its whole history was seen.
export const DAILY_RESULTS = Object.freeze([
  "ok",
  "none",
  "missing",
  "unreadable",
]);
const DAILY_RECORD_KEYS = [
  "chain",
  "id",
  "lastRankedAt",
  "attemptedAt",
  "result",
  "fetchedAt",
  "bad",
  "start",
  "days",
];

export function isDailyRecord(row) {
  return (
    !!row &&
    typeof row === "object" &&
    !Array.isArray(row) &&
    Object.keys(row).every((key) => DAILY_RECORD_KEYS.includes(key)) &&
    DAILY_RECORD_KEYS.every((key) => key in row) &&
    isPoolId(row.id) &&
    lower(row.id) &&
    typeof row.chain === "string" &&
    CHAIN_SLUG.test(row.chain) &&
    isIso(row.lastRankedAt) &&
    (row.attemptedAt === null || isIso(row.attemptedAt)) &&
    (row.result === null
      ? row.attemptedAt === null
      : DAILY_RESULTS.includes(row.result) && row.attemptedAt !== null) &&
    (row.fetchedAt === null || isIso(row.fetchedAt)) &&
    Number.isSafeInteger(row.bad) &&
    row.bad >= 0 &&
    row.bad <= 99 &&
    (row.start === null || (Number.isSafeInteger(row.start) && row.start >= 0)) &&
    Array.isArray(row.days) &&
    row.days.length <= DAILY_STORED_DAYS &&
    row.days.every(
      (pair, index) =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        Number.isSafeInteger(pair[0]) &&
        pair[0] >= 0 &&
        typeof pair[1] === "number" &&
        Number.isFinite(pair[1]) &&
        pair[1] >= 0 &&
        pair[1] < 1e13 &&
        (index === 0 || pair[0] > row.days[index - 1][0]),
    )
  );
}

export function isDailyState(value) {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) =>
      ["schemaVersion", "updatedAt", "pools"].includes(key),
    ) &&
    value.schemaVersion === 1 &&
    (value.updatedAt === null || isIso(value.updatedAt)) &&
    Array.isArray(value.pools) &&
    value.pools.length <= DAILY_KEEP_RANK &&
    value.pools.every(isDailyRecord) &&
    new Set(value.pools.map((row) => poolKey(row.chain, row.id))).size ===
      value.pools.length
  );
}

/** The daily-volume state, read on its own so that nothing about this file can
 * fail a run: a missing file is "no daily data yet"; one that cannot be read,
 * is not JSON (conflict markers after a merge, a cut-off write) or has the wrong
 * shape is ignored with a note, and the step starts empty. The next published
 * run writes a good file. */
async function readDailyState(dir) {
  const empty = (note) => ({ records: [], present: note !== null, note });
  let text;
  try {
    text = await readFile(join(dir, "daily.json"), "utf8");
  } catch (error) {
    return error?.code === "ENOENT"
      ? empty(null)
      : empty("state/daily.json could not be read, so the daily volume starts empty.");
  }
  let file;
  try {
    file = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return empty("state/daily.json is not valid JSON, so the daily volume starts empty.");
  }
  if (!isDailyState(file))
    return empty("state/daily.json has an unexpected shape, so the daily volume starts empty.");
  return { records: file.pools, present: true, note: null };
}

export async function writeFileAtomic(path, text) {
  await mkdir(join(path, ".."), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, text);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** One record per line keeps committed state readable and diffs small. */
export function rowsJson(header, key, rows) {
  const head = JSON.stringify(header).slice(0, -1);
  return `${head},${JSON.stringify(key)}:[\n${rows.map((row) => JSON.stringify(row)).join(",\n")}\n]}\n`;
}

async function readJson(dir, name, { required = false } = {}) {
  let text;
  try {
    text = await readFile(join(dir, name), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT" && !required) return null;
    throw new Error(
      error?.code === "ENOENT"
        ? `${name} is missing in ${dir}. Seed the state with collector/export-seed.mjs.`
        : `${name} could not be read.`,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${name} is not valid JSON.`);
  }
}

export async function readState(dir) {
  const poolsFile = await readJson(dir, "pools.json", { required: true });
  if (
    poolsFile?.schemaVersion !== 1 ||
    !Array.isArray(poolsFile.pools) ||
    (poolsFile.updatedAt !== null && !isIso(poolsFile.updatedAt))
  )
    throw new Error("pools.json has an unexpected shape.");
  const bad = poolsFile.pools.findIndex((row) => !isStatePool(row));
  if (bad >= 0) throw new Error(`pools.json row ${bad} is not a valid pool.`);
  const seen = new Set();
  for (const row of poolsFile.pools) {
    const key = poolKey(row.chain, row.id);
    if (seen.has(key)) throw new Error("pools.json contains a duplicate pool.");
    seen.add(key);
  }
  const hooklessFile = await readJson(dir, "hookless.json");
  if (
    hooklessFile &&
    (hooklessFile.schemaVersion !== 1 ||
      !Array.isArray(hooklessFile.pools) ||
      !hooklessFile.pools.every(
        (key) =>
          typeof key === "string" &&
          /^[a-z0-9][a-z0-9-]{0,49}:0x[0-9a-f]{64}$/.test(key),
      ))
  )
    throw new Error("hookless.json has an unexpected shape.");
  const censusFile = await readJson(dir, "census.json");
  if (
    censusFile &&
    (censusFile.schemaVersion !== 1 ||
      !isIso(censusFile.exportedAt) ||
      !censusFile.inventory ||
      !isIso(censusFile.inventory.generatedAt) ||
      !Array.isArray(censusFile.inventory.networks))
  )
    throw new Error("census.json has an unexpected shape.");
  const historyFile = await readJson(dir, "history.json");
  if (historyFile && !isHistory(historyFile))
    throw new Error("history.json has an unexpected shape.");
  const priorityFile = await readJson(dir, "priority.json");
  if (priorityFile && !isPriorityFile(priorityFile))
    throw new Error("priority.json has an unexpected shape.");
  const registryFile = await readJson(dir, "registry.json");
  if (
    registryFile &&
    (registryFile.schemaVersion !== 1 ||
      !registryFile.sources ||
      typeof registryFile.sources !== "object")
  )
    throw new Error("registry.json has an unexpected shape.");
  return {
    updatedAt: poolsFile.updatedAt ?? null,
    pools: poolsFile.pools,
    hookless: new Set(hooklessFile?.pools ?? []),
    census: censusFile,
    history: historyFile?.points ?? [],
    // The pools that are always measured (see config.mjs), or null.
    priority: priorityFile
      ? { exportedAt: priorityFile.exportedAt, pools: priorityFile.pools }
      : null,
    registry: registryFile,
    // The daily-volume records; see readDailyState.
    daily: await readDailyState(dir),
  };
}

const byKey = (a, b) =>
  a.chain === b.chain
    ? a.id < b.id
      ? -1
      : a.id > b.id
        ? 1
        : 0
    : a.chain < b.chain
      ? -1
      : 1;

export const poolsJson = (updatedAt, pools) =>
  rowsJson({ schemaVersion: 1, updatedAt }, "pools", [...pools].sort(byKey));
export const hooklessJson = (updatedAt, keys) =>
  rowsJson({ schemaVersion: 1, updatedAt }, "pools", [...keys].sort());
export const historyJson = (points) =>
  rowsJson({ schemaVersion: 1 }, "points", points);
export const priorityJson = (header, pools) =>
  rowsJson({ schemaVersion: 1, ...header }, "pools", [...pools].sort(byKey));
export const dailyJson = (updatedAt, records) =>
  rowsJson({ schemaVersion: 1, updatedAt }, "pools", [...records].sort(byKey));

/** Write the run's state. Registry is rewritten only when its data changed. */
export async function writeState(
  dir,
  { updatedAt, pools, hookless, history, registry, daily },
) {
  await writeFileAtomic(join(dir, "pools.json"), poolsJson(updatedAt, pools));
  await writeFileAtomic(
    join(dir, "hookless.json"),
    hooklessJson(updatedAt, hookless),
  );
  await writeFileAtomic(join(dir, "history.json"), historyJson(history));
  // Only when there are daily records to keep or an older file to replace.
  if (daily)
    await writeFileAtomic(join(dir, "daily.json"), dailyJson(updatedAt, daily));
  if (registry)
    await writeFileAtomic(
      join(dir, "registry.json"),
      `${JSON.stringify({ schemaVersion: 1, sources: registry })}\n`,
    );
}
