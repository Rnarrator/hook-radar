import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAINS_URL, FRONTIER_URL, REGISTRY_URL } from "../server/model.mjs";
import { METRIC_CHAINS } from "../server/market-chains.mjs";
import { isSnapshot } from "../src/model.ts";
import { DS_NETWORKS } from "../collector/providers/dexscreener.mjs";
import { runCollector } from "../collector/run.mjs";
import { poolsJson, readState } from "../collector/state.mjs";
import {
  blockNetwork,
  address,
  dexRow,
  FakeClock,
  fakeFetch,
  statePool,
} from "../collector/testing.mjs";

blockNetwork();

// One run at the size the scheduled job really has: the seed's 8,000 pools on
// its 14 networks, discovery on all 20 networks, and fake providers that answer
// instantly. Nothing here is published; it checks the budgets, gaps and
// discovery rules on the whole, not on a handful of pools.

const SEED_MIX = {
  robinhood: 4355,
  base: 2283,
  ethereum: 1015,
  arc: 213,
  ink: 49,
  bnb: 22,
  optimism: 16,
  polygon: 11,
  unichain: 11,
  arbitrum: 8,
  avalanche: 6,
  monad: 5,
  xlayer: 5,
  soneium: 1,
};
const chainOf = new Map(METRIC_CHAINS.map((chain) => [chain.chain, chain]));
const geckoOf = new Map(METRIC_CHAINS.map((chain) => [chain.gecko, chain]));
const byChainId = new Map(METRIC_CHAINS.map((chain) => [chain.chainId, chain]));
const dsToChain = new Map(
  Object.entries(DS_NETWORKS).map(([slug, ds]) => [ds, slug]),
);
const DYNAMIC_NAME = "AAA / BBB - 838.8608%";
const FIXED_NAME = "AAA / BBB - 0.3%";

// A seeded hook is dynamic, plainly fixed, or one the seed knew nothing about.
const seedHook = (n) => n % 300;
const seedEvidence = (hook) =>
  hook % 10 === 0 ? true : hook % 50 === 7 ? undefined : false;

function buildWorld() {
  const pools = [];
  let seed = 1;
  for (const [chain, count] of Object.entries(SEED_MIX))
    for (let i = 0; i < count; i++, seed++) {
      const hook = seedHook(seed);
      const evidence = seedEvidence(hook);
      pools.push(
        statePool(seed, {
          chain,
          hookAddress: address(20000 + hook).toLowerCase(),
          tokens: [address(100000 + seed * 2), address(100001 + seed * 2)],
          ...(evidence === undefined ? {} : { dynamicFee: evidence }),
        }),
      );
    }
  const seeded = pools.length;

  // What the indexer and GeckoTerminal will tell discovery, per network.
  const listed = new Map();
  const candidates = new Map();
  const everything = new Map(pools.map((p) => [`${p.chain}:${p.id}`, p]));
  const fresh = [];
  METRIC_CHAINS.forEach((chain, c) => {
    const rows = [];
    for (let k = 0; k < 30; k++) {
      const pool = statePool(200000 + c * 100 + k, {
        chain: chain.chain,
        hookAddress: address(40000 + c * 10 + (k % 10)).toLowerCase(),
        tokens: [address(300000 + c * 100 + k), address(400000 + c * 100 + k)],
        source: "v4.xyz",
      });
      pool.fakeName = k % 5 === 0 ? DYNAMIC_NAME : FIXED_NAME;
      rows.push(pool);
      fresh.push(pool);
      everything.set(`${pool.chain}:${pool.id}`, pool);
    }
    listed.set(chain.chainId, rows);
    const page = [];
    for (let k = 0; k < 20; k++) {
      const pool = statePool(500000 + c * 100 + k, {
        chain: chain.chain,
        hookAddress: address(50000 + c).toLowerCase(),
        tokens: [address(600000 + c * 100 + k), address(700000 + c * 100 + k)],
        source: "v4.xyz",
      });
      pool.fakeName = FIXED_NAME;
      page.push(pool);
      everything.set(`${pool.chain}:${pool.id}`, pool);
    }
    candidates.set(chain.gecko, page);
  });
  return { pools, seeded, listed, candidates, everything, fresh };
}

const indexerRow = (chain, pool) => ({
  id: `${chain.chainId}_${pool.id}`,
  chainId: String(chain.chainId),
  hooks: pool.hookAddress,
  token0: `${chain.chainId}_${pool.tokens[0]}`,
  token1: `${chain.chainId}_${pool.tokens[1]}`,
  name: pool.fakeName,
  totalValueLockedUSD: "100",
});

function providers(world) {
  const resolved = [];
  const dark = (pool) =>
    pool.source === "census" && Number(BigInt(pool.id) % 41n) === 0;
  const answer = (call) => {
    const { url } = call;
    if (url === REGISTRY_URL)
      return {
        body: [
          {
            hook: {
              address: address(9001),
              chain: "base",
              chainId: 8453,
              name: "ListedHook",
              description: "A hook in the hooklist.",
              verifiedSource: true,
            },
            properties: { dynamicFee: false },
          },
        ],
      };
    if (url === CHAINS_URL)
      return { body: { ethereum: { chainId: 1 }, base: { chainId: 8453 } } };
    if (url === FRONTIER_URL) return { body: [] };
    let match =
      /^https:\/\/api\.dexscreener\.com\/latest\/dex\/pairs\/([a-z]+)\/(.+)$/.exec(
        url,
      );
    if (match) {
      const chain = dsToChain.get(match[1]);
      const rows = match[2]
        .split(",")
        .map((id) => world.everything.get(`${chain}:${id}`))
        .filter((pool) => pool && !dark(pool))
        .map((pool, i) =>
          dexRow(pool, {
            volume: { h1: 10 + i, h6: 60 + i, h24: 1000 + i },
            liquidity: { usd: 5000 + i },
          }),
        );
      return { body: { pairs: rows.length ? rows : null } };
    }
    match =
      /^https:\/\/api\.geckoterminal\.com\/api\/v2\/networks\/([a-z0-9_-]+)\/dexes\//.exec(
        url,
      );
    if (match) {
      const chain = geckoOf.get(match[1]);
      return {
        body: {
          data: (world.candidates.get(match[1]) ?? []).map((pool) => ({
            id: `${chain.gecko}_${pool.id}`,
            type: "pool",
            attributes: { address: pool.id, name: "A / B" },
            relationships: { dex: { data: { id: chain.dex } } },
          })),
        },
      };
    }
    if (url.includes("api.geckoterminal.com") && url.includes("/pools/multi/"))
      return { body: { data: [] } };
    match = /^https:\/\/www\.v4\.xyz\/api\/pools\?chainId=(\d+)$/.exec(url);
    if (match) {
      const chain = byChainId.get(Number(match[1]));
      return {
        body: {
          Pool: (world.listed.get(chain.chainId) ?? []).map((pool) =>
            indexerRow(chain, pool),
          ),
        },
      };
    }
    match = /^https:\/\/www\.v4\.xyz\/api\/pool\/(\d+)_(0x[0-9a-f]{64})$/.exec(
      url,
    );
    if (match) {
      const chain = byChainId.get(Number(match[1]));
      resolved.push({ chain: chain.chain, id: match[2] });
      const pool = world.everything.get(`${chain.chain}:${match[2]}`);
      return { body: { Pool: [indexerRow(chain, pool)] } };
    }
    return { status: 404, body: {} };
  };
  return { answer, resolved, dark };
}

const hostOf = (call) => new URL(call.url).hostname;
const gapsOf = (calls, host) => {
  const times = calls
    .filter((call) => hostOf(call) === host)
    .map((call) => call.at)
    .sort((a, b) => a - b);
  return {
    count: times.length,
    gaps: times.slice(1).map((t, i) => t - times[i]),
  };
};

test("a run at full size stays inside the request budget, the gaps and the burst limits", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "collector-fullsize-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const world = buildWorld();
  assert.equal(world.seeded, 8000);
  const stateDir = join(dir, "state");
  await mkdir(stateDir);
  await writeFile(join(stateDir, "pools.json"), poolsJson(null, world.pools));
  const clock = new FakeClock();
  const fake = providers(world);
  const fetchImpl = fakeFetch(clock, fake.answer);
  const result = await runCollector({
    stateDir,
    outDir: join(dir, "data"),
    stateOutDir: stateDir,
    fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
    env: { GITHUB_REPOSITORY: "owner/hook-radar" },
  });
  assert.equal(result.ok, true, result.quality.failures.join("; "));
  assert.equal(result.published, true);
  const { status, snapshot } = result;
  assert.equal(isSnapshot(snapshot), true);

  // The request budget: fewer than 400 in all, and the status says the same.
  assert.ok(
    fetchImpl.calls.length <= 399,
    `${fetchImpl.calls.length} requests`,
  );
  assert.equal(status.counts.requests.total, fetchImpl.calls.length);
  const byHost = (host) => fetchImpl.calls.filter((c) => hostOf(c) === host);
  assert.ok(byHost("api.dexscreener.com").length >= 276);
  assert.equal(byHost("www.v4.xyz").length, 20 + 40);
  assert.equal(
    byHost("api.geckoterminal.com").filter((c) => c.url.includes("/dexes/"))
      .length,
    20,
  );
  assert.ok(
    byHost("api.geckoterminal.com").filter((c) =>
      c.url.includes("/pools/multi/"),
    ).length <= 6,
  );

  // The gaps between request starts, per provider, in the contract's numbers.
  const minimum = {
    "api.dexscreener.com": 400,
    "api.geckoterminal.com": 12000,
    "www.v4.xyz": 5000,
    "raw.githubusercontent.com": 1000,
  };
  for (const [host, gap] of Object.entries(minimum)) {
    const seen = gapsOf(fetchImpl.calls, host);
    assert.ok(seen.count > 1, host);
    assert.ok(
      seen.gaps.every((value) => value >= gap),
      `${host}: shortest gap ${Math.min(...seen.gaps)} ms, needs ${gap}`,
    );
  }

  // Every call names the project and its repository.
  assert.ok(
    fetchImpl.calls.every((call) =>
      call.headers["user-agent"].endsWith(
        "(+https://github.com/owner/hook-radar)",
      ),
    ),
  );

  // Exact lookups: 40, an equal share of two for each of the 20 networks.
  assert.equal(status.counts.discovery.resolvesTried, 40);
  const perChain = new Map();
  for (const row of fake.resolved)
    perChain.set(row.chain, (perChain.get(row.chain) ?? 0) + 1);
  assert.equal(perChain.size, 20);
  assert.ok([...perChain.values()].every((count) => count === 2));

  // The plan: all 8,000 seeded pools, and discovery on top, up to 500.
  assert.equal(status.counts.plannedPools, 8500);
  assert.equal(status.counts.plannedDiscoveredPools, 500);
  const requested = new Set();
  for (const call of byHost("api.dexscreener.com")) {
    const [, ds, ids] = /pairs\/([a-z]+)\/(.+)$/.exec(call.url);
    for (const id of ids.split(","))
      requested.add(`${dsToChain.get(ds)}:${id}`);
  }
  for (const pool of world.pools)
    assert.ok(
      requested.has(`${pool.chain}:${pool.id}`),
      "a seeded pool was dropped",
    );
  assert.equal(requested.size, 8500);

  // The burst ends well inside the page's five minutes.
  const burst =
    Date.parse(status.burstEndedAt) - Date.parse(status.burstStartedAt);
  assert.ok(burst < 225000 + 20000, `${burst} ms`);
  assert.equal(status.generatedAt, status.burstEndedAt);

  // The pools DEX Screener did not know are unresolved, never zero.
  const measured = new Set(
    snapshot.pools.map((p) => `${p.chain}:${p.address}`),
  );
  const darkSeeds = world.pools.filter(fake.dark);
  assert.ok(darkSeeds.length > 100);
  assert.ok(darkSeeds.every((p) => !measured.has(`${p.chain}:${p.id}`)));

  // Dynamic-fee evidence, hook by hook, against what the world says.
  const evidence = new Map();
  const note = (hook, value) => {
    const key = `${hook}`;
    evidence.set(key, evidence.get(key) === true || value);
  };
  for (const pool of world.pools)
    if (typeof pool.dynamicFee === "boolean")
      note(
        `${chainOf.get(pool.chain).chainId}:${pool.hookAddress}`,
        pool.dynamicFee,
      );
  for (const pool of world.fresh)
    if (pool.fakeName === DYNAMIC_NAME)
      note(`${chainOf.get(pool.chain).chainId}:${pool.hookAddress}`, true);
  let dynamic = 0;
  let fixed = 0;
  let unknown = 0;
  for (const project of snapshot.projects)
    for (const deployment of project.deployments) {
      if (deployment.discovery !== "onchain") continue;
      const key = `${deployment.chainId}:${deployment.address}`;
      const known = evidence.get(key);
      assert.equal(deployment.properties.dynamicFee, known === true, key);
      assert.equal(
        /has not been established/.test(deployment.description),
        known === undefined,
        key,
      );
      if (known === true) dynamic++;
      else if (known === false) fixed++;
      else unknown++;
    }
  assert.ok(
    dynamic > 30 && fixed > 200 && unknown > 30,
    `${dynamic}/${fixed}/${unknown}`,
  );

  // What the next run starts from: the seed plus every pool discovery found,
  // each with its evidence (only a dynamic name proves anything).
  const state = await readState(stateDir);
  const found = state.pools.filter((pool) => pool.source === "v4.xyz");
  assert.equal(found.length, 20 * 30 + 40);
  assert.equal(state.pools.length, 8000 + 640);
  const fakeName = new Map(
    [...world.everything.values()].map((pool) => [
      `${pool.chain}:${pool.id}`,
      pool.fakeName,
    ]),
  );
  for (const pool of found)
    assert.equal(
      pool.dynamicFee,
      fakeName.get(`${pool.chain}:${pool.id}`) === DYNAMIC_NAME
        ? true
        : undefined,
    );
  assert.ok(found.some((pool) => pool.dynamicFee === true));
  // Seeded pools keep their evidence, including "checked and fixed".
  const seededNow = new Map(state.pools.map((p) => [`${p.chain}:${p.id}`, p]));
  for (const pool of world.pools)
    assert.equal(
      seededNow.get(`${pool.chain}:${pool.id}`).dynamicFee,
      pool.dynamicFee,
    );
  const file = JSON.parse(
    await readFile(join(dir, "data", "status.json"), "utf8"),
  );
  assert.equal(file.counts.requests.total, fetchImpl.calls.length);
});
