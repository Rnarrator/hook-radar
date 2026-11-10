#!/usr/bin/env node
// Records REAL provider responses for the tests and for `run.mjs --offline`.
//
// It makes at most 13 requests, spread over the same code paths a real run uses
// (registry, the v4.xyz lists, one GeckoTerminal page, one exact lookup, five
// DEX Screener batches and one GeckoTerminal fallback), through the same paced
// client, so every gap is honoured. It never retries: a 429 or 403 aborts the
// recording and nothing is written. Run it only on purpose.
//
//   node collector/tools/record-fixtures.mjs [--out collector/fixtures]
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { METRIC_CHAINS } from "../../server/market-chains.mjs";
import { createHttpClient } from "../http.mjs";
import { planBurst, runBurst } from "../measure.mjs";
import { loadRegistry } from "../registry.mjs";
import {
  historyJson,
  hooklessJson,
  poolsJson,
  writeFileAtomic,
} from "../state.mjs";
import {
  marketDiscoveryUrl,
  validateMarketDiscovery,
  GT_MAX_BYTES,
} from "../providers/geckoterminal.mjs";
import {
  poolDetailUrl,
  poolListUrl,
  V4_DETAIL_MAX_BYTES,
  V4_LIST_MAX_BYTES,
  validateEnvioPools,
  validateIndexerPoolIdentity,
} from "../providers/v4xyz.mjs";
import { userAgent } from "../config.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CAPS = {
  registry: 2,
  frontier: 1,
  v4xyz: 3,
  geckoterminal: 2,
  dexscreener: 5,
};
const LIST_CHAINS = ["ethereum", "base"];
const GECKO_CHAIN = "base";
const DISCOVERY_PAGE = 1;

const outArgument = process.argv.indexOf("--out");
const out = resolve(
  outArgument > 0
    ? process.argv[outArgument + 1]
    : join(ROOT, "collector", "fixtures"),
);

const recorded = [];
const recordingFetch = async (url, options) => {
  const response = await fetch(url, options);
  const text = await response.text();
  const date = response.headers.get("date");
  if (response.status === 200 && !date)
    throw new Error("A response without a Date header cannot be a fixture.");
  recorded.push({
    provider: new URL(url).hostname,
    url: String(url),
    status: response.status,
    date,
    age: response.headers.get("age")
      ? Number(response.headers.get("age"))
      : null,
    text,
  });
  return new Response(text, {
    status: response.status,
    headers: response.headers,
  });
};

const client = createHttpClient({
  fetchImpl: recordingFetch,
  userAgent: userAgent(),
  caps: CAPS,
  // No cooldown, unlike a collection run: the first 429 or 403 stops the
  // recording at once instead of waiting and asking again.
  rateLimitCapMs: 0,
});
const bySlug = new Map(METRIC_CHAINS.map((chain) => [chain.chain, chain]));
const startedAt = Date.now();
const stamp = new Date(startedAt).toISOString();

try {
  console.log("registry");
  await loadRegistry({ client, saved: null });

  console.log("indexer lists");
  const pools = [];
  for (const slug of LIST_CHAINS) {
    const chain = bySlug.get(slug);
    const result = await client.getJson("v4xyz", poolListUrl(chain), {
      maxBytes: V4_LIST_MAX_BYTES,
    });
    for (const pool of validateEnvioPools(result.data, chain).pools)
      pools.push({
        id: pool.address,
        chain: slug,
        hookAddress: pool.hookAddress,
        tokens: pool.tokens,
        name: pool.name,
        createdAt: null,
        source: "v4.xyz",
        firstSeen: stamp,
        lastSeen: stamp,
      });
  }
  const known = new Set(pools.map((pool) => `${pool.chain}:${pool.id}`));

  console.log("geckoterminal page and one exact lookup");
  const geckoChain = bySlug.get(GECKO_CHAIN);
  const page = await client.getJson(
    "geckoterminal",
    marketDiscoveryUrl(geckoChain, DISCOVERY_PAGE),
    { maxBytes: GT_MAX_BYTES },
  );
  const candidates = validateMarketDiscovery(page.data, geckoChain).data.map(
    (row) => row.attributes.address.toLowerCase(),
  );
  const target =
    candidates.find((id) => !known.has(`${GECKO_CHAIN}:${id}`)) ??
    candidates[0];
  const planned = [...pools];
  if (target) {
    const detail = await client.getJson(
      "v4xyz",
      poolDetailUrl(geckoChain, target),
      { maxBytes: V4_DETAIL_MAX_BYTES },
    );
    try {
      const identity = validateIndexerPoolIdentity(
        detail.data,
        geckoChain,
        target,
      );
      if (identity.hooked && !known.has(`${GECKO_CHAIN}:${target}`))
        planned.push({
          id: identity.address,
          chain: GECKO_CHAIN,
          hookAddress: identity.hookAddress,
          tokens: identity.tokens,
          name: identity.name,
          createdAt: null,
          source: "v4.xyz",
          firstSeen: stamp,
          lastSeen: new Date(Date.now()).toISOString(),
        });
    } catch {
      /* An unusable answer is still a faithful fixture. */
    }
  }

  console.log("measurement burst");
  const burst = await runBurst({
    client,
    plan: planBurst(planned),
    now: Date.now,
  });

  const stats = client.stats();
  const stopped = Object.entries(stats).filter(([, row]) => row.stopped);
  if (stopped.length)
    throw new Error(
      `Stopped: ${stopped.map(([id, row]) => `${id} ${row.stopped.reason}`).join(", ")}`,
    );
  if (recorded.some((entry) => entry.status !== 200))
    throw new Error("A recorded request did not answer HTTP 200.");

  await rm(out, { recursive: true, force: true });
  await mkdir(join(out, "state"), { recursive: true });
  const entries = [];
  const counters = new Map();
  for (const entry of recorded) {
    const kind = entry.provider.replace(/^(?:api|www)\./, "").split(".")[0];
    const index = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, index);
    const file = `${kind}-${index}.json`;
    await writeFile(join(out, file), entry.text);
    entries.push({
      provider: entry.provider,
      url: entry.url,
      status: entry.status,
      date: entry.date,
      age: entry.age,
      file,
      bytes: Buffer.byteLength(entry.text),
    });
  }
  await writeFile(
    join(out, "manifest.json"),
    `${JSON.stringify(
      {
        recordedAt: stamp,
        requests: stats,
        discoveryPage: DISCOVERY_PAGE,
        burst: {
          dexRequests: burst.dexRequests,
          measured: burst.measured.size,
          fallback: burst.fallback,
        },
        entries,
      },
      null,
      2,
    )}\n`,
  );
  await writeFileAtomic(
    join(out, "state", "pools.json"),
    poolsJson(null, pools),
  );
  await writeFileAtomic(
    join(out, "state", "hookless.json"),
    hooklessJson(null, []),
  );
  await writeFileAtomic(join(out, "state", "history.json"), historyJson([]));
  try {
    const census = await readFile(join(ROOT, "state", "census.json"), "utf8");
    await writeFile(join(out, "state", "census.json"), census);
  } catch {
    console.log(
      "no state/census.json to copy; the fixture state has no census",
    );
  }
  console.log(`Recorded ${entries.length} responses into ${out}`);
  console.log(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(stats).map(([id, row]) => [id, row.requests]),
      ),
    ),
  );
} catch (error) {
  console.error(`Recording aborted, nothing written: ${error.message}`);
  process.exitCode = 1;
}
