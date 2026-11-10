import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isAddress, isPoolId, ZERO_ADDRESS } from "../server/model.mjs";
import { HISTORY_MAX_POINTS } from "./config.mjs";

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
    registry: registryFile,
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

/** Write the run's state. Registry is rewritten only when its data changed. */
export async function writeState(
  dir,
  { updatedAt, pools, hookless, history, registry },
) {
  await writeFileAtomic(join(dir, "pools.json"), poolsJson(updatedAt, pools));
  await writeFileAtomic(
    join(dir, "hookless.json"),
    hooklessJson(updatedAt, hookless),
  );
  await writeFileAtomic(join(dir, "history.json"), historyJson(history));
  if (registry)
    await writeFileAtomic(
      join(dir, "registry.json"),
      `${JSON.stringify({ schemaVersion: 1, sources: registry })}\n`,
    );
}
