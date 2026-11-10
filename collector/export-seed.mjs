#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { isAddress, isPoolId, ZERO_ADDRESS } from "../server/model.mjs";
import { isSnapshot } from "../src/model.ts";
import { MAX_MEASURED_POOLS } from "./config.mjs";
import {
  historyJson,
  hooklessJson,
  isStatePool,
  poolsJson,
  writeFileAtomic,
} from "./state.mjs";

// One-time seeding of state/ from the live Hook Radar app's public API. It
// reads /api/snapshot once (at most three requests in total, and only a server
// error or a dropped connection is retried), keeps the hooked pools with the
// highest 24h volume, and records the census counts exactly as the app
// published them, with the original timestamps and the time of this export. For
// hooks outside the Uniswap hooklist it also keeps the app's answer to "does this
// hook run dynamic LP fees", which the app derives from the census (the fee each
// pool was initialised with) and the edition has no other way to learn.

const gunzipAsync = promisify(gunzip);
const MAX_COMPRESSED = 256 * 1024 * 1024;
const MAX_DECOMPRESSED = 1024 * 1024 * 1024;
export const MAX_ATTEMPTS = 3;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** One GET. Resolves { status, headers, body (Buffer) } without following redirects. */
export function httpGet(url, headers) {
  const target = new URL(url);
  const client = target.protocol === "https:" ? https : http;
  return new Promise((resolveRequest, reject) => {
    const request = client.request(
      target,
      { method: "GET", headers, timeout: 120000 },
      (response) => {
        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > MAX_COMPRESSED) {
            request.destroy(new Error("The response is larger than allowed."));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () =>
          resolveRequest({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
        response.on("error", reject);
      },
    );
    request.on("timeout", () => request.destroy(new Error("Timed out.")));
    request.on("error", reject);
    request.end();
  });
}

/** Fetch /api/snapshot with gzip. Returns { text, raw (the bytes received), attempts }. */
export async function fetchSnapshotText(
  base,
  {
    get = httpGet,
    maxAttempts = MAX_ATTEMPTS,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = {},
) {
  const url = new URL("/api/snapshot", base).href;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await get(url, {
        accept: "application/json",
        "accept-encoding": "gzip",
        "user-agent": "HookRadarAutoSnapshot-seed/1.0 (one-time local export)",
      });
      if (response.status >= 500) {
        lastError = new Error(`The app answered HTTP ${response.status}.`);
        if (attempt < maxAttempts) await sleep(5000);
        continue;
      }
      if (response.status !== 200)
        throw Object.assign(
          new Error(`The app answered HTTP ${response.status}.`),
          {
            final: true,
          },
        );
      const encoding = String(
        response.headers["content-encoding"] || "",
      ).toLowerCase();
      const body =
        encoding === "gzip"
          ? await gunzipAsync(response.body, {
              maxOutputLength: MAX_DECOMPRESSED,
            })
          : encoding === "" || encoding === "identity"
            ? response.body
            : (() => {
                throw Object.assign(
                  new Error(`Unsupported content-encoding ${encoding}.`),
                  { final: true },
                );
              })();
      return {
        text: body.toString("utf8"),
        raw: response.body,
        encoding,
        attempts: attempt,
      };
    } catch (error) {
      if (error.final) throw error;
      lastError = error;
      if (attempt < maxAttempts) await sleep(5000);
    }
  }
  throw lastError ?? new Error("The snapshot could not be fetched.");
}

/** The census without the address of the data service the live app read each
 * network from. Some of those addresses embed an access key, and a seed is
 * committed to a public repository; nothing in the edition uses them. Every
 * other field stays exactly as the app published it. */
export function withoutEndpointUrls(inventory) {
  return {
    ...inventory,
    networks: inventory.networks.map(
      ({ sourceUrl: _endpoint, ...network }) => network,
    ),
  };
}

const volumeOf = (pool) => pool.volumeUsd?.h24;
const descending = (a, b) =>
  a === b
    ? 0
    : a === null || a === undefined
      ? 1
      : b === null || b === undefined
        ? -1
        : b - a;

/** The seed: hooked pools ranked by 24h volume, then liquidity; and the census. */
export function buildSeed(
  snapshot,
  { exportedAt, maxPools = MAX_MEASURED_POOLS },
) {
  if (!isSnapshot(snapshot))
    throw new Error("The response is not a Hook Radar snapshot.");
  if (!snapshot.inventory)
    throw new Error("The snapshot carries no pool census.");
  const hookFees = new Map();
  for (const project of snapshot.projects)
    for (const deployment of project.deployments)
      if (
        deployment.discovery === "onchain" ||
        deployment.discovery === "published"
      )
        hookFees.set(
          `${deployment.chain}:${deployment.address.toLowerCase()}`,
          deployment.properties.dynamicFee === true,
        );
  const skipped = { notHooked: 0, noTokens: 0, duplicate: 0, invalid: 0 };
  const seen = new Set();
  const candidates = [];
  for (const pool of snapshot.pools) {
    if (
      !isPoolId(pool.address) ||
      !isAddress(pool.hookAddress) ||
      pool.hookAddress.toLowerCase() === ZERO_ADDRESS
    ) {
      skipped.notHooked++;
      continue;
    }
    const tokens = Array.isArray(pool.tokens)
      ? pool.tokens.filter(isAddress).map((token) => token.toLowerCase())
      : [];
    if (tokens.length !== 2 || tokens[0] === tokens[1]) {
      skipped.noTokens++;
      continue;
    }
    const key = `${pool.chain}:${pool.address.toLowerCase()}`;
    if (seen.has(key)) {
      skipped.duplicate++;
      continue;
    }
    const hookFee = hookFees.get(
      `${pool.chain}:${pool.hookAddress.toLowerCase()}`,
    );
    const record = {
      id: pool.address.toLowerCase(),
      chain: pool.chain,
      hookAddress: pool.hookAddress.toLowerCase(),
      tokens,
      name: String(pool.name ?? "").slice(0, 180) || "Indexed v4 pool",
      createdAt:
        typeof pool.createdAt === "string" &&
        Number.isFinite(Date.parse(pool.createdAt))
          ? new Date(Date.parse(pool.createdAt)).toISOString()
          : null,
      source: "census",
      ...(pool.metricProvider === "geckoterminal"
        ? { via: "geckoterminal" }
        : {}),
      ...(hookFee === undefined ? {} : { dynamicFee: hookFee }),
      firstSeen: exportedAt,
      lastSeen: exportedAt,
    };
    if (!isStatePool(record)) {
      skipped.invalid++;
      continue;
    }
    seen.add(key);
    candidates.push({
      record,
      volume: volumeOf(pool) ?? null,
      liquidity: pool.liquidityUsd ?? null,
    });
  }
  candidates.sort(
    (a, b) =>
      descending(a.volume, b.volume) ||
      descending(a.liquidity, b.liquidity) ||
      (a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0),
  );
  const pools = candidates.slice(0, maxPools).map((item) => item.record);
  return {
    pools,
    census: {
      schemaVersion: 1,
      exportedAt,
      seed: {
        snapshotGeneratedAt: snapshot.generatedAt,
        poolsInSnapshot: snapshot.pools.length,
        poolsSeeded: pools.length,
        rankedBy: "24h volume, then liquidity",
        skipped,
      },
      inventory: withoutEndpointUrls(snapshot.inventory),
    },
  };
}

function parseArguments(argv) {
  const options = {
    url: "http://127.0.0.1:4173",
    state: resolve("state"),
    maxPools: MAX_MEASURED_POOLS,
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${flag} needs a value.`);
      return next;
    };
    if (flag === "--url") options.url = value();
    else if (flag === "--state") options.state = resolve(value());
    else if (flag === "--max-pools") options.maxPools = Number(value());
    else if (flag === "--save-raw") options.saveRaw = resolve(value());
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
      "--exported-at is for --from-file and needs a past UTC time such as 2026-10-27T21:10:10.592Z.",
    );
  if (!Number.isSafeInteger(options.maxPools) || options.maxPools < 1)
    throw new Error("--max-pools needs a positive whole number.");
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
    let attempts = 0;
    if (options.fromFile) {
      const buffer = await readFile(options.fromFile);
      text = (
        buffer[0] === 0x1f && buffer[1] === 0x8b
          ? await gunzipAsync(buffer, { maxOutputLength: MAX_DECOMPRESSED })
          : buffer
      ).toString("utf8");
    } else {
      const base = new URL(options.url);
      if (!LOOPBACK.has(base.hostname) && !options.allowRemote)
        throw new Error(
          "The seed is read from the local app; pass --allow-remote to read another address.",
        );
      const fetched = await fetchSnapshotText(base);
      text = fetched.text;
      attempts = fetched.attempts;
      if (options.saveRaw) await writeFile(options.saveRaw, fetched.raw);
    }
    // A saved response keeps the time of the request that fetched it.
    const exportedAt = options.exportedAt
      ? new Date(Date.parse(options.exportedAt)).toISOString()
      : new Date().toISOString();
    const seed = buildSeed(JSON.parse(text), {
      exportedAt,
      maxPools: options.maxPools,
    });
    await writeFileAtomic(
      join(options.state, "pools.json"),
      poolsJson(null, seed.pools),
    );
    await writeFileAtomic(
      join(options.state, "hookless.json"),
      hooklessJson(null, []),
    );
    await writeFileAtomic(join(options.state, "history.json"), historyJson([]));
    await writeFileAtomic(
      join(options.state, "census.json"),
      `${JSON.stringify(seed.census)}\n`,
    );
    console.log(
      `Seeded ${seed.pools.length} of ${seed.census.seed.poolsInSnapshot} pools and the census (${seed.census.inventory.networks.length} networks, as of ${seed.census.inventory.generatedAt}) into ${options.state}${attempts ? ` using ${attempts} request${attempts === 1 ? "" : "s"}` : " from a saved response"}.`,
    );
    return 0;
  } catch (error) {
    console.error(`Seed export failed: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main();
