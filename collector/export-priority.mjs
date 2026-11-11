#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { isAddress, isPoolId, ZERO_ADDRESS } from "../server/model.mjs";
import { launchpadRegistry } from "../shared/launchpad-registry.ts";
import { isSnapshot } from "../src/model.ts";
import { MAX_PRIORITY_POOLS } from "./config.mjs";
import { fetchSnapshotText } from "./export-seed.mjs";
import {
  isPlainPoolName,
  isPriorityFile,
  isPriorityPool,
  poolKey,
  priorityJson,
  writeFileAtomic,
} from "./state.mjs";

// One-time export of the priority list (state/priority.json) from the live Hook
// Radar app's published snapshot, the way export-seed.mjs exports the seed: it
// reads the snapshot once (a saved response or the local app), keeps a handful of
// plain identity fields of the pools it selects and nothing else, and says how
// it chose. It reads no provider URL, key or figure into the file: the record of
// a pool is its id, network, hook, two currencies, name, creation time and the
// project or platform it was selected for (a label for the reader; ownership is
// still decided from the exact hook at every snapshot, never from this file).
//
// Which pools:
//  - every pool of a hook that a reviewed launchpad platform publishes as its
//    own (platform-hook paths of shared/launchpad-registry.ts), and every pool of
//    a hook that a named project (not one of the unnamed on-chain hook projects)
//    deploys, that carried a measurement taken at most a day before the
//    snapshot: pools that are probably still trading;
//  - for the four protocols many launchers share (Doppler, Clanker, Zora and
//    Flaunch), whose pool counts run into the millions, the 50 pools with the
//    highest 24h volume among those measured at most a week before. They carry
//    nearly all of those protocols' volume.
// A pool is listed once. The list is never larger than MAX_PRIORITY_POOLS.

const gunzipAsync = promisify(gunzip);
const MAX_DECOMPRESSED = 1024 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
export const RECENT_PLATFORM_MS = DAY_MS;
export const RECENT_SHARED_MS = 7 * DAY_MS;
export const SHARED_PROTOCOLS = Object.freeze([
  "doppler",
  "clanker",
  "zora",
  "flaunch",
]);
export const SHARED_TOP = 50;

export const SELECTION_RULE =
  "Pools of the exact hooks that reviewed launchpad platforms publish as their own, and of the hooks that named projects deploy, measured at most 24 hours before the live snapshot; for Doppler, Clanker, Zora and Flaunch the 50 pools with the highest 24h volume among those measured at most 7 days before it. Chosen once from the live Hook Radar's published snapshot; the pool's project is a label for the reader, ownership is decided from the exact hook.";

const lower = (value) => String(value).toLowerCase();
const hookKey = (chain, address) => `${chain}:${lower(address)}`;
const measured = (pool) =>
  [pool.liquidityUsd, pool.volumeUsd?.h24].some(
    (value) => typeof value === "number" && Number.isFinite(value),
  );

/** Which entities own which hooks: the platform-hook paths of the reviewed
 * launchpad registry, and the deployments of the snapshot's named projects (the
 * unnamed on-chain hook projects, whose ids start with "hook-", are not named
 * projects). A hook can be listed under more than one entity. */
export function hookOwners(snapshot, registry = launchpadRegistry) {
  const owners = new Map();
  const add = (chain, address, id) => {
    const key = hookKey(chain, address);
    if (!owners.has(key)) owners.set(key, new Set());
    owners.get(key).add(id);
  };
  for (const record of registry)
    for (const path of record.paths)
      if (path.attribution === "platform-hook")
        for (const hook of path.hooks) add(path.chain, hook.address, record.id);
  for (const project of snapshot.projects)
    if (!/^hook-/.test(project.id))
      for (const deployment of project.deployments)
        add(deployment.chain, deployment.address, project.id);
  return owners;
}

/** The priority list from a live snapshot. Returns the records and how they were
 * chosen. A pool that cannot be a state record (a missing currency, a non-hook
 * pool) is left out and counted. */
export function buildPriority(
  snapshot,
  { exportedAt, registry = launchpadRegistry, shared = SHARED_PROTOCOLS },
) {
  if (!isSnapshot(snapshot))
    throw new Error("The response is not a Hook Radar snapshot.");
  const at = Date.parse(snapshot.generatedAt);
  const owners = hookOwners(snapshot, registry);
  const sharedIds = new Set(shared);
  const skipped = { notAnIdentity: 0, noMeasurement: 0 };
  const rows = [];
  for (const pool of snapshot.pools) {
    const entities = owners.get(hookKey(pool.chain, pool.hookAddress ?? ""));
    if (!entities) continue;
    const tokens = Array.isArray(pool.tokens)
      ? pool.tokens.filter(isAddress).map(lower)
      : [];
    if (
      !isPoolId(pool.address) ||
      !isAddress(pool.hookAddress) ||
      lower(pool.hookAddress) === ZERO_ADDRESS ||
      tokens.length !== 2 ||
      tokens[0] === tokens[1]
    ) {
      skipped.notAnIdentity++;
      continue;
    }
    if (!measured(pool)) {
      skipped.noMeasurement++;
      continue;
    }
    const age = at - Date.parse(pool.metricUpdatedAt ?? "");
    if (!Number.isFinite(age) || age < 0) {
      skipped.noMeasurement++;
      continue;
    }
    rows.push({ pool, tokens, entities: [...entities].sort(), age });
  }
  const own = rows.filter(
    (row) => !row.entities.every((id) => sharedIds.has(id)),
  );
  const chosen = new Map();
  const take = (row, projectId) => {
    const key = poolKey(row.pool.chain, lower(row.pool.address));
    if (chosen.has(key)) return;
    chosen.set(key, {
      id: lower(row.pool.address),
      chain: row.pool.chain,
      hookAddress: lower(row.pool.hookAddress),
      tokens: row.tokens,
      name: plainName(row.pool.name),
      createdAt:
        typeof row.pool.createdAt === "string" &&
        Number.isFinite(Date.parse(row.pool.createdAt))
          ? new Date(Date.parse(row.pool.createdAt)).toISOString()
          : null,
      projectId,
    });
  };
  const counts = {};
  for (const row of own.filter(
    (candidate) => candidate.age <= RECENT_PLATFORM_MS,
  )) {
    const owner = row.entities.find((id) => !sharedIds.has(id));
    take(row, owner);
    counts[owner] = (counts[owner] ?? 0) + 1;
  }
  for (const id of shared) {
    const top = rows
      .filter((row) => row.entities.includes(id) && row.age <= RECENT_SHARED_MS)
      .sort(
        (a, b) =>
          (b.pool.volumeUsd?.h24 ?? 0) - (a.pool.volumeUsd?.h24 ?? 0) ||
          (lower(a.pool.address) < lower(b.pool.address) ? -1 : 1),
      )
      .slice(0, SHARED_TOP);
    for (const row of top) {
      take(row, id);
      counts[id] = (counts[id] ?? 0) + 1;
    }
  }
  const pools = [...chosen.values()].sort((a, b) =>
    a.chain === b.chain ? (a.id < b.id ? -1 : 1) : a.chain < b.chain ? -1 : 1,
  );
  if (pools.length > MAX_PRIORITY_POOLS)
    throw new Error(
      `The selection holds ${pools.length} pools, more than the ${MAX_PRIORITY_POOLS} the priority list may hold.`,
    );
  const invalid = pools.filter((row) => !isPriorityPool(row));
  if (invalid.length)
    throw new Error(`${invalid.length} selected pools are not valid records.`);
  const file = {
    schemaVersion: 1,
    exportedAt,
    selection: {
      snapshotGeneratedAt: snapshot.generatedAt,
      rule: SELECTION_RULE,
      counts: { pools: pools.length, ...sorted(counts), ...prefixed(skipped) },
    },
    pools,
  };
  return { file, pools, skipped, counts };
}

const sorted = (counts) =>
  Object.fromEntries(
    Object.entries(counts)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([id, count]) => [`for ${id}`, count]),
  );
const prefixed = (skipped) =>
  Object.fromEntries(
    Object.entries(skipped).map(([name, count]) => [
      `left out: ${name}`,
      count,
    ]),
  );

/** A pool name a state record may hold: two symbols, no markup or web address;
 * anything else is the generic name the seed uses. */
function plainName(name) {
  const text = String(name ?? "")
    .replace(/\p{C}/gu, "")
    .trim()
    .slice(0, 100);
  return isPlainPoolName(text) ? text : "Indexed v4 pool";
}

export const priorityFileText = (file) =>
  priorityJson(
    { exportedAt: file.exportedAt, selection: file.selection },
    file.pools,
  );

function parseArguments(argv) {
  const options = { url: "http://127.0.0.1:4173", state: resolve("state") };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${flag} needs a value.`);
      return next;
    };
    if (flag === "--url") options.url = value();
    else if (flag === "--state") options.state = resolve(value());
    else if (flag === "--from-file") options.fromFile = resolve(value());
    else if (flag === "--exported-at") options.exportedAt = value();
    else if (flag === "--allow-remote") options.allowRemote = true;
    else throw new Error(`Unknown option ${flag}.`);
  }
  if (
    options.exportedAt !== undefined &&
    (!options.fromFile ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(
        options.exportedAt,
      ) ||
      Date.parse(options.exportedAt) > Date.now())
  )
    throw new Error(
      "--exported-at is for --from-file and needs a past UTC time such as 2026-10-31T18:32:52.350Z.",
    );
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  try {
    let text;
    if (options.fromFile) {
      const buffer = await readFile(options.fromFile);
      text = (
        buffer[0] === 0x1f && buffer[1] === 0x8b
          ? await gunzipAsync(buffer, { maxOutputLength: MAX_DECOMPRESSED })
          : buffer
      ).toString("utf8");
    } else {
      const base = new URL(options.url);
      if (
        !["127.0.0.1", "localhost", "[::1]", "::1"].includes(base.hostname) &&
        !options.allowRemote
      )
        throw new Error(
          "The list is read from the local app; pass --allow-remote to read another address.",
        );
      text = (await fetchSnapshotText(base)).text;
    }
    const exportedAt = options.exportedAt
      ? new Date(Date.parse(options.exportedAt)).toISOString()
      : new Date().toISOString();
    const { file, pools, skipped } = buildPriority(JSON.parse(text), {
      exportedAt,
    });
    const written = priorityFileText(file);
    if (!isPriorityFile(JSON.parse(written)))
      throw new Error("The priority file did not pass its own check.");
    await writeFileAtomic(join(options.state, "priority.json"), written);
    console.log(
      `Wrote ${pools.length} pools to ${join(options.state, "priority.json")} (snapshot of ${file.selection.snapshotGeneratedAt}); left out ${JSON.stringify(skipped)}.`,
    );
    return 0;
  } catch (error) {
    console.error(`Priority export failed: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main();
