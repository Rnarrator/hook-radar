import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { isSnapshot } from "../src/model.ts";
import { isMarketCoverage } from "../shared/market-coverage.ts";
import { officialHooks } from "../shared/official-hooks.ts";
import {
  createDirectory,
  digest,
  projectIdentity,
  validateChains,
} from "../server/model.mjs";
import { assembleSnapshot, marketCoverageFor } from "../collector/assemble.mjs";
import { buildSeed } from "../collector/export-seed.mjs";
import { buildOverviewFiles } from "../collector/overview.mjs";
import { measurementChains } from "../collector/measure.mjs";
import { normalizeDexScreenerPool } from "../collector/providers/dexscreener.mjs";
import { FIXTURES, runCollector } from "../collector/run.mjs";
import { poolKey, readState } from "../collector/state.mjs";
import { blockNetwork, dexRow, statePool } from "../collector/testing.mjs";

blockNetwork();

// What the edition publishes must be true to its sources: a hook is credited to a
// project only when the registry names that hook as the project's (never because
// a name contains a family's letters), a network a source answered is not
// reported as unavailable, and no published file carries a key.

const read = async (...parts) =>
  JSON.parse(await readFile(join(...parts), "utf8"));
const hooklist = await read(FIXTURES, "raw-1.json");
const chainRegistry = validateChains(await read(FIXTURES, "raw-2.json"));
const fixtureState = await readState(join(FIXTURES, "state"));

const PROOF = "ProofLaunchHook";
const proofRow = hooklist.find((row) => row.hook.name === PROOF);

const deployment = (name) => ({
  name,
  description: "",
  chainId: 8453,
  address: "0x0000000000000000000000000000000000000001",
});

/** Names of the registry rows the family rule `id` credits. */
const creditedTo = (id, options) =>
  hooklist
    .filter((row) => projectIdentity(row.hook, options).id === id)
    .map((row) => row.hook.name);

// A family name only counts at the start of a hook's name, or at the start of a
// parenthetical such as "AnyPositionManager (Flaunch vested launch hook)".
const PREFIX_OR_PARENTHETICAL = (family) =>
  new RegExp(`^${family}\\b|\\(${family}\\b`, "i");

test("the recorded hooklist has the hook that the substring rule credits to Flaunch", () => {
  assert.ok(
    proofRow,
    "the fixture hooklist no longer contains ProofLaunchHook",
  );
  assert.equal(
    proofRow.hook.address.toLowerCase(),
    "0x83b1a8f2ffcd2e9898ffe55fe53444943200c8cc",
  );
  // The letters "fLaunch" sit inside "ProofLaunchHook"; nothing else ties it to Flaunch.
  assert.match(PROOF, /flaunch/i);
  assert.doesNotMatch(proofRow.hook.description ?? "", /flaunch/i);
});

test("without the option the live rule is unchanged: ProofLaunchHook is credited to Flaunch", () => {
  assert.equal(projectIdentity(deployment(PROOF)).id, "flaunch");
  assert.equal(projectIdentity(deployment(PROOF), {}).id, "flaunch");
  assert.equal(
    projectIdentity(deployment(PROOF), { strictFamilyNames: false }).id,
    "flaunch",
  );
  const directory = createDirectory(hooklist, chainRegistry);
  const flaunch = directory.projects.find(
    (project) => project.id === "flaunch",
  );
  assert.ok(
    flaunch.deployments.some(
      (d) => d.address === proofRow.hook.address.toLowerCase(),
    ),
  );
});

test("with strictFamilyNames ProofLaunchHook is not Flaunch, and every Flaunch name still is", () => {
  const strict = { strictFamilyNames: true };
  assert.notEqual(projectIdentity(deployment(PROOF), strict).id, "flaunch");
  assert.equal(projectIdentity(deployment(PROOF), strict).name, PROOF);
  for (const name of [
    "Flaunch PositionManager",
    "Flaunch POSM v1",
    "Flaunch POSM v4 (Base)",
    "Flaunch AnyPOSM v1 (Base)",
    "AnyPositionManager (Flaunch vested launch hook)",
    "flaunch positionmanager",
  ])
    assert.equal(projectIdentity(deployment(name), strict).id, "flaunch", name);
  // Other families are unaffected by the option.
  for (const name of ["BunniHook", "ClankerHook", "Frontier FactoryHook"])
    assert.equal(
      projectIdentity(deployment(name), strict).id,
      projectIdentity(deployment(name)).id,
      name,
    );
});

test("on every recorded registry name, strict family names change only ProofLaunchHook", () => {
  const live = hooklist.map((row) => projectIdentity(row.hook).id);
  const strict = hooklist.map(
    (row) => projectIdentity(row.hook, { strictFamilyNames: true }).id,
  );
  const changed = hooklist
    .map((row, index) => [row.hook.name, live[index], strict[index]])
    .filter(([, before, after]) => before !== after);
  assert.ok(changed.length >= 1);
  assert.deepEqual([...new Set(changed.map(([name]) => name))], [PROOF]);
  assert.ok(changed.every(([, before]) => before === "flaunch"));
});

test("every recorded name the strict rule credits to Flaunch or Frontier has the family at its start or in a parenthesis", () => {
  const strict = { strictFamilyNames: true };
  for (const [id, family] of [
    ["flaunch", "flaunch"],
    ["frontier", "frontier"],
  ]) {
    const names = creditedTo(id, strict);
    assert.ok(names.length > 0, id);
    for (const name of names)
      assert.match(name, PREFIX_OR_PARENTHETICAL(family), `${id}: ${name}`);
  }
  // The scan has teeth: the live rule fails it for exactly one recorded name.
  const offenders = creditedTo("flaunch", {}).filter(
    (name) => !PREFIX_OR_PARENTHETICAL("flaunch").test(name),
  );
  assert.deepEqual(offenders, [PROOF]);
});

test("the strict directory keeps ProofLaunchHook out of the Flaunch project", () => {
  const strict = createDirectory(hooklist, chainRegistry, [], [], {
    strictFamilyNames: true,
  });
  const proofAddress = proofRow.hook.address.toLowerCase();
  const owners = strict.projects.filter((project) =>
    project.deployments.some(
      (d) => d.address === proofAddress && d.chainId === proofRow.hook.chainId,
    ),
  );
  assert.equal(owners.length, 1);
  assert.notEqual(owners[0].id, "flaunch");
  assert.equal(owners[0].name, PROOF);
  const flaunch = strict.projects.find((project) => project.id === "flaunch");
  assert.equal(
    flaunch.deployments.length,
    creditedTo("flaunch", { strictFamilyNames: true }).length,
  );
  const live = createDirectory(hooklist, chainRegistry, [], []).projects.find(
    (project) => project.id === "flaunch",
  );
  assert.equal(live.deployments.length, flaunch.deployments.length + 1);
});

test("a pool measured on ProofLaunchHook is not summed into Flaunch", () => {
  const networks = measurementChains();
  const marketChain = (slug) =>
    networks.find((candidate) => candidate.chain === slug);
  // A genuine Flaunch hook on a network that is measured.
  const flaunchRow = hooklist.find(
    (row) =>
      /^Flaunch PositionManager$/.test(row.hook.name) &&
      marketChain(row.hook.chain),
  );
  assert.ok(flaunchRow, "no measured Flaunch hook in the recorded hooklist");
  assert.ok(
    marketChain(proofRow.hook.chain),
    `${proofRow.hook.chain} is not a measured network`,
  );
  const observedAt = Date.parse("2026-10-28T12:00:00.000Z");
  const measured = new Map();
  const statePools = [];
  const burst = { networks: [] };
  [
    [1, proofRow],
    [2, flaunchRow],
  ].forEach(([seed, { hook }]) => {
    const chain = marketChain(hook.chain);
    const pool = statePool(seed, {
      chain: chain.chain,
      hookAddress: hook.address.toLowerCase(),
    });
    statePools.push(pool);
    measured.set(
      poolKey(chain.chain, pool.id),
      normalizeDexScreenerPool(
        dexRow(pool, { volume: { h24: 1000, h6: 300, h1: 50 } }),
        chain,
        pool,
        observedAt,
      ),
    );
    burst.networks.push({
      chain: chain.chain,
      chainId: chain.chainId,
      requested: 1,
      checked: 1,
      measured: 1,
    });
  });
  const { snapshot } = assembleSnapshot({
    directoryInputs: {
      registry: hooklist,
      chains: chainRegistry,
      frontier: [],
    },
    statePools,
    measured,
    burst,
    census: null,
    history: [],
    sources: [],
    generatedAtMs: observedAt + 1000,
  });
  assert.equal(isSnapshot(snapshot), true);
  const owner = (id) =>
    snapshot.pools.find((pool) => pool.address === id)?.projectId;
  // The genuine Flaunch hook's pool is Flaunch's; the other hook's is not.
  assert.equal(owner(statePools[1].id), "flaunch");
  assert.ok(owner(statePools[0].id));
  assert.notEqual(owner(statePools[0].id), "flaunch");
  const flaunch = snapshot.projects.find((project) => project.id === "flaunch");
  assert.equal(flaunch.metrics.poolCount, 1);
  assert.equal(
    flaunch.deployments.some(
      (d) => d.address === proofRow.hook.address.toLowerCase(),
    ),
    false,
  );
});

// ---- coverage ------------------------------------------------------------------

const rowOf = (rows, chain) =>
  rows.find((candidate) => candidate.chain === chain);

function coverageScenario() {
  const census = {
    inventory: {
      networks: [
        { chain: "base", chainId: 8453, hookPoolCount: 1000 },
        { chain: "ethereum", chainId: 1, hookPoolCount: 500 },
        { chain: "zora", chainId: 7777777, hookPoolCount: 11 },
        // Listed before the larger linea on purpose: insertion order and
        // "largest first" must differ, or the ordering is not pinned.
        { chain: "worldchain", chainId: 480, hookPoolCount: 78 },
        { chain: "linea", chainId: 59144, hookPoolCount: 162 },
        { chain: "tempo", chainId: 4217, hookPoolCount: 0 },
      ],
    },
  };
  const burst = {
    networks: [
      {
        chain: "ethereum",
        chainId: 1,
        requested: 60,
        checked: 60,
        measured: 2,
      },
      // Answered for all 30 pools, with nothing usable for any of them.
      { chain: "base", chainId: 8453, requested: 30, checked: 30, measured: 0 },
      // Asked about 11 pools, never answered.
      {
        chain: "zora",
        chainId: 7777777,
        requested: 11,
        checked: 0,
        measured: 0,
      },
      // In the plan, but the burst ended before it was reached.
      {
        chain: "arbitrum",
        chainId: 42161,
        requested: 0,
        checked: 0,
        measured: 0,
      },
    ],
  };
  const statePools = [
    ...Array.from({ length: 60 }, (_, i) => ({ chain: "ethereum", i })),
    ...Array.from({ length: 30 }, (_, i) => ({ chain: "base", i })),
    ...Array.from({ length: 11 }, (_, i) => ({ chain: "zora", i })),
    ...Array.from({ length: 40 }, (_, i) => ({ chain: "arbitrum", i })),
  ];
  const chainIds = new Map([
    ["ethereum", 1],
    ["base", 8453],
    ["zora", 7777777],
    ["linea", 59144],
    ["worldchain", 480],
    ["tempo", 4217],
    ["arbitrum", 42161],
  ]);
  return {
    census,
    burst,
    statePools,
    chainIds,
    measuredByChain: new Map([["ethereum", 2]]),
  };
}

test("a network a source answered is live even when it priced none of the pools asked", () => {
  const coverage = marketCoverageFor(coverageScenario());
  const base = rowOf(coverage.networks, "base");
  assert.equal(base.status, "live");
  assert.equal(base.checkedPools, 30);
  assert.equal(base.measuredPools, 0);
  assert.equal(base.missingPools, 30);
  assert.equal(base.attemptedPools, 30);
  assert.equal(base.pendingPools, 970);
  const ethereum = rowOf(coverage.networks, "ethereum");
  assert.equal(ethereum.status, "live");
  assert.equal(ethereum.measuredPools, 2);
  assert.equal(ethereum.missingPools, 58);
});

test("a network asked about that never answered is unavailable", () => {
  const zora = rowOf(marketCoverageFor(coverageScenario()).networks, "zora");
  assert.equal(zora.status, "unavailable");
  assert.equal(zora.attemptedPools, 11);
  assert.equal(zora.checkedPools, 0);
  assert.equal(zora.pendingPools, 11);
});

test("a measured pool makes its network live even when the other provider's answer was not counted as checked", () => {
  const scenario = coverageScenario();
  scenario.burst.networks[2] = { ...scenario.burst.networks[2], measured: 1 };
  scenario.measuredByChain.set("zora", 1);
  const zora = rowOf(marketCoverageFor(scenario).networks, "zora");
  assert.equal(zora.status, "live");
  assert.equal(zora.checkedPools, 1);
  assert.equal(zora.measuredPools, 1);
});

test("a network the run never asked about is listed as not attempted, so totals are the census's", () => {
  const scenario = coverageScenario();
  const coverage = marketCoverageFor(scenario);
  const listed = coverage.networks.map((network) => network.chain);
  // Requested networks keep their order; the others follow, largest first.
  assert.deepEqual(listed, [
    "ethereum",
    "base",
    "zora",
    "linea",
    "worldchain",
    "arbitrum",
  ]);
  const linea = rowOf(coverage.networks, "linea");
  assert.deepEqual(linea, {
    chain: "linea",
    chainId: 59144,
    inventoryPools: 162,
    checkedPools: 0,
    measuredPools: 0,
    pendingPools: 162,
    missingPools: 0,
    attemptedPools: 0,
    status: "unavailable",
  });
  // The burst planned arbitrum but never reached it: not attempted, with the pools the state holds.
  const arbitrum = rowOf(coverage.networks, "arbitrum");
  assert.equal(arbitrum.attemptedPools, 0);
  assert.equal(arbitrum.inventoryPools, 40);
  assert.equal(arbitrum.status, "unavailable");
  // A census network with no hook pools has no row.
  assert.equal(rowOf(coverage.networks, "tempo"), undefined);
  const total = coverage.networks.reduce(
    (sum, network) => sum + network.inventoryPools,
    0,
  );
  assert.equal(total, 1000 + 500 + 11 + 162 + 78 + 40);
});

test("a network the directory has no chain id for is not given an invented one", () => {
  const scenario = coverageScenario();
  scenario.chainIds.delete("linea");
  const coverage = marketCoverageFor(scenario);
  assert.equal(rowOf(coverage.networks, "linea"), undefined);
});

test("the coverage rows pass the validator the client applies", () => {
  const coverage = marketCoverageFor(coverageScenario());
  assert.equal(isMarketCoverage(coverage), true);
  assert.equal(isMarketCoverage(JSON.parse(JSON.stringify(coverage))), true);
});

// ---- a whole offline run -------------------------------------------------------

const quiet = async (work) => {
  const { log, error } = console;
  console.log = console.error = () => {};
  try {
    return await work();
  } finally {
    console.log = log;
    console.error = error;
  }
};

async function filesUnder(dir) {
  const names = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) names.push(...(await filesUnder(path)));
    else names.push(path);
  }
  return names;
}

const scratch = [];
after(() =>
  Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true }))),
);

/** An offline run into a scratch folder: everything it writes is in `dir`. */
async function offlineRun(stateDir = join(FIXTURES, "state")) {
  const dir = await mkdtemp(join(tmpdir(), "edition-truth-"));
  scratch.push(dir);
  const result = await quiet(() =>
    runCollector({
      offline: true,
      stateDir,
      outDir: dir,
      stateOutDir: join(dir, "state"),
      minCurrent: 20,
    }),
  );
  assert.equal(result.ok, true, result.quality.failures.join("; "));
  return { dir, result };
}
let sharedRun;
const sharedOfflineRun = () => (sharedRun ??= offlineRun());

// A key in a URL (a path or query segment of 20 or more letters, digits, "_" or
// "-" right after /v1/, /v2/, /api/, apikey=, key= or token=), or a token of a
// well-known kind. 0x-prefixed hex addresses and ids are not keys.
const KEY_AFTER =
  /(?:\/v1\/|\/v2\/|\/api\/|apikey=|key=|token=)(?!0x[0-9a-fA-F]+(?![0-9A-Za-z_-]))[A-Za-z0-9_-]{20,}/gi;
const TOKENS = [
  // Built from pieces: this file travels with the edition and is itself scanned
  // for credential-looking text, which a written-out token prefix would trip.
  new RegExp(`${["gh", "p_"].join("")}[A-Za-z0-9]{8,}`, "g"),
  /Bearer [A-Za-z0-9._~+/=-]{8,}/g,
  /\bAKIA[0-9A-Z]{12,}/g,
];
function credentialLooking(text) {
  return [
    ...text.matchAll(KEY_AFTER),
    ...TOKENS.flatMap((pattern) => [...text.matchAll(pattern)]),
  ].map((match) => match[0]);
}

// Sample keys and tokens. These files are published with the edition, so no line
// below holds a complete key, token or keyed URL: each sample is put together at
// run time from fragments that match nothing on their own (and none is a real
// secret, only the right shape).
const HEX_FILLER = "0123456789abcdef".repeat(2);
const NODEREAL = `https://bsc-mainnet.nodereal.io/v1/${HEX_FILLER}`;
const KEYED_PATH = ["https://rpc.example.org", "api", "A1b2C3d4".repeat(3)];
const KEYED_V2 = ["https://rpc.example.org", "v2", "ABCDEFGH".repeat(3)];
const LOWER_KEY = "abcdefgh".repeat(3);

test("the credential scan flags keys and leaves ordinary URLs, addresses and ids alone", () => {
  for (const hit of [
    NODEREAL,
    KEYED_PATH.join("/"),
    KEYED_V2.join("/"),
    `https://rpc.example.org/x?${["api", "key"].join("")}=${LOWER_KEY}`,
    `https://rpc.example.org/x?${["k", "ey"].join("")}=${LOWER_KEY}`,
    `https://rpc.example.org/x?foo=1&${["tok", "en"].join("")}=abc_def-ghi_jkl-mno_pqr`,
    `${"ghp"}_${"A1b2".repeat(9)}`,
    `Authorization: ${"Bear"}er ${"abcdefgh".repeat(2)}`,
    `${"AKIA"}${"IOSFODNN7EXAMPLE"}`,
  ])
    assert.ok(credentialLooking(hit).length > 0, hit);
  const pool = `0x${"ab".repeat(32)}`;
  for (const clean of [
    "https://api.geckoterminal.com/api/v2/networks/base/dexes/uniswap-v4-base/pools?page=1&include=base_token,quote",
    `https://api.geckoterminal.com/api/v2/networks/base/pools/multi/${pool},${pool}`,
    `https://api.dexscreener.com/latest/dex/pairs/base/${pool},${pool}`,
    `https://www.v4.xyz/api/pool/8453_${pool}`,
    `https://rpc.example.org/v1/${pool}`,
    `https://rpc.example.org/api/0x${"cd".repeat(20)}`,
    "https://mainnet.gateway.tenderly.co",
    "https://portal.sqd.dev/datasets/unichain-mainnet/finalized-stream",
    "https://developers.uniswap.org/docs/protocols/v4/deployments",
  ])
    assert.deepEqual(credentialLooking(clean), [], clean);
});

// The edition folder copies these (scripts/make-edition-folder.mjs, TEST_PREFIXES),
// so what they hold is published.
const PUBLISHED_TEST_FILES = [
  ["tests", /^(?:collector|edition)-.*\.mjs$/],
  ["scripts", /^static-edition-.*\.mjs$/],
];

test("no test or script the edition copies holds a credential-looking literal", async () => {
  const root = join(FIXTURES, "..", "..");
  const checked = [];
  for (const [folder, pattern] of PUBLISHED_TEST_FILES)
    for (const name of await readdir(join(root, folder))) {
      if (!pattern.test(name)) continue;
      const file = join(root, folder, name);
      checked.push(name);
      assert.deepEqual(
        credentialLooking(await readFile(file, "utf8")),
        [],
        `${folder}/${name}`,
      );
    }
  assert.ok(checked.includes("edition-collector-truth.test.mjs"));
  assert.ok(checked.length >= 5, checked.join(", "));
});

test("the committed census seeds carry no credential-looking URL", async () => {
  for (const file of [
    join(FIXTURES, "state", "census.json"),
    join(FIXTURES, "..", "..", "state", "census.json"),
  ]) {
    const text = await readFile(file, "utf8");
    assert.deepEqual(credentialLooking(text), [], file);
    assert.equal(/nodereal/i.test(text), false, file);
  }
});

test("no file an offline run writes carries a credential-looking URL", async () => {
  const { dir } = await sharedOfflineRun();
  const files = await filesUnder(dir);
  assert.ok(files.some((file) => file.endsWith("snapshot.json")));
  assert.ok(files.some((file) => file.endsWith("overview-all-h24.json")));
  assert.ok(files.some((file) => file.endsWith("status.json")));
  assert.ok(files.length >= 20);
  for (const file of files) {
    const text = await readFile(file, "utf8");
    assert.deepEqual(credentialLooking(text), [], relative(dir, file));
  }
});

test("a census seed that still carries keyed endpoints is published without them", async () => {
  // An older export: every network record has the address the app read it from.
  const stale = await mkdtemp(join(tmpdir(), "edition-truth-stale-"));
  scratch.push(stale);
  for (const name of ["pools.json", "hookless.json", "history.json"])
    await writeFile(
      join(stale, name),
      await readFile(join(FIXTURES, "state", name)),
    );
  const census = await read(FIXTURES, "state", "census.json");
  for (const network of census.inventory.networks)
    network.sourceUrl =
      network.chain === "bnb" ? NODEREAL : "https://rpc.example.org";
  await writeFile(join(stale, "census.json"), `${JSON.stringify(census)}\n`);
  const { dir } = await offlineRun(stale);
  const files = await filesUnder(dir);
  assert.ok(files.length >= 20);
  for (const file of files) {
    const text = await readFile(file, "utf8");
    assert.deepEqual(credentialLooking(text), [], relative(dir, file));
    assert.equal(text.includes("nodereal"), false, relative(dir, file));
    assert.equal(text.includes("rpc.example.org"), false, relative(dir, file));
  }
  // Nothing else of the census changed: same networks, counts, blocks and times.
  const snapshot = await read(dir, "snapshot.json");
  assert.equal(snapshot.inventory.generatedAt, census.inventory.generatedAt);
  const unnamed = ({ name: _name, sourceUrl: _endpoint, ...network }) =>
    network;
  assert.deepEqual(
    snapshot.inventory.networks.map(unnamed),
    census.inventory.networks.map(unnamed),
  );
});

test("the seed exporter drops the endpoint of every network and changes nothing else", async () => {
  const { result } = await sharedOfflineRun();
  // The app's snapshot, as the exporter reads it: each network says where it was read from.
  const app = structuredClone(result.snapshot);
  for (const network of app.inventory.networks)
    network.sourceUrl =
      network.chain === "bnb" ? NODEREAL : "https://rpc.example.org";
  const { census } = buildSeed(app, { exportedAt: "2026-10-27T21:10:10.592Z" });
  const text = JSON.stringify(census);
  assert.equal(text.includes("sourceUrl"), false);
  assert.equal(text.includes("nodereal"), false);
  assert.deepEqual(
    census.inventory.networks,
    result.snapshot.inventory.networks,
  );
  assert.equal(census.inventory.generatedAt, app.inventory.generatedAt);
  assert.equal(census.inventory.hookPoolCount, app.inventory.hookPoolCount);
});

// ---- names and the census ---------------------------------------------------

test("a network has the directory's name in the snapshot, its census and every overview", async () => {
  const { dir } = await sharedOfflineRun();
  const snapshot = await read(dir, "snapshot.json");
  const names = new Map(
    snapshot.chains.map((chain) => [chain.slug, chain.name]),
  );
  assert.equal(names.get("robinhood"), "Robinhood");
  for (const network of snapshot.inventory.networks)
    assert.equal(network.name, names.get(network.chain), network.chain);
  const overviews = (await readdir(dir)).filter((name) =>
    name.startsWith("overview-"),
  );
  assert.ok(overviews.length > 20);
  for (const name of overviews) {
    const envelope = await read(dir, name);
    for (const network of envelope.networks)
      assert.equal(
        network.name,
        names.get(network.slug) ?? network.slug,
        `${name} ${network.slug}`,
      );
    for (const network of envelope.inventory.networks)
      assert.equal(
        network.name,
        names.get(network.chain),
        `${name} ${network.chain}`,
      );
    for (const network of envelope.networkTotals)
      assert.equal(
        network.name,
        names.get(network.chain),
        `${name} ${network.chain}`,
      );
    assert.equal(
      JSON.stringify(envelope).includes("Robinhood Chain"),
      false,
      name,
    );
  }
  // The census counts and times are exactly the exported ones.
  const census = fixtureState.census.inventory;
  assert.equal(snapshot.inventory.hookPoolCount, census.hookPoolCount);
  assert.equal(snapshot.inventory.generatedAt, census.generatedAt);
  const figures = (network) => [
    network.chain,
    network.hookPoolCount,
    network.updatedAt,
    network.headCheckedAt,
  ];
  assert.deepEqual(
    snapshot.inventory.networks.map(figures),
    census.networks.map(figures),
  );
});

test("the overview builder alone gives a snapshot's networks the directory's names", async () => {
  const { result } = await sharedOfflineRun();
  // A snapshot whose census still uses the census's own name for a network.
  const census = structuredClone(result.snapshot);
  census.inventory.networks.find((n) => n.chain === "robinhood").name =
    "Robinhood Chain";
  const files = await buildOverviewFiles(
    census,
    Date.parse(census.generatedAt),
  );
  assert.ok(files.length > 20);
  for (const file of files)
    assert.equal(
      JSON.stringify(file.envelope).includes("Robinhood Chain"),
      false,
      file.name,
    );
  const all = files.find((file) => file.name === "overview-all-h24.json");
  assert.equal(
    all.envelope.networks.find((n) => n.slug === "robinhood").name,
    "Robinhood",
  );
});

test("the published pricing rows cover every census network with hook pools, and a status means what it says", async () => {
  const { dir, result } = await sharedOfflineRun();
  const { snapshot } = result;
  assert.equal(isMarketCoverage(snapshot.marketCoverage), true);
  const rows = snapshot.marketCoverage.networks;
  const census = fixtureState.census.inventory.networks.filter(
    (network) => network.hookPoolCount > 0,
  );
  for (const network of census)
    assert.ok(
      rowOf(rows, network.chain),
      `${network.chain} has no pricing row`,
    );
  assert.equal(rows.length, census.length);
  assert.equal(
    rows.reduce((sum, network) => sum + network.inventoryPools, 0),
    fixtureState.census.inventory.hookPoolCount,
  );
  for (const network of rows) {
    // "Live" is a source that answered; "unavailable" is one that did not, or was not asked.
    assert.equal(
      network.status,
      network.checkedPools > 0 ? "live" : "unavailable",
      network.chain,
    );
    if (network.attemptedPools === 0) {
      assert.equal(network.checkedPools, 0, network.chain);
      assert.equal(network.measuredPools, 0, network.chain);
      assert.equal(network.pendingPools, network.inventoryPools, network.chain);
    }
  }
  // The recording has networks DEX Screener answered for and networks nobody asked about.
  assert.ok(
    rows.some(
      (network) => network.attemptedPools > 0 && network.status === "live",
    ),
  );
  assert.ok(rows.some((network) => network.attemptedPools === 0));
  // The written file says the same as the snapshot object.
  const written = await read(dir, "snapshot.json");
  assert.deepEqual(written.marketCoverage, snapshot.marketCoverage);
});

// ---- the first-party hook list ---------------------------------------------------

// shared/official-hooks.ts lists the hooks Uniswap Labs publishes. The live
// directory has each of them through a pool its census saw; the edition builds
// its directory from the registry and the pools it measured, so a listed hook
// the registry omits and no measured pool uses would be missing.

const deploymentKey = (chainId, address) =>
  `${chainId}:${address.toLowerCase()}`;
const listedKey = (hook) => deploymentKey(hook.chainId, hook.address);
const keysIn = (projects) =>
  new Set(
    projects.flatMap((project) =>
      project.deployments.map((d) => deploymentKey(d.chainId, d.address)),
    ),
  );
const registryKeys = new Set(
  hooklist.map((row) => deploymentKey(row.hook.chainId, row.hook.address)),
);
// The recorded hooklist omits two of the eleven listed hooks.
const omitted = officialHooks.filter(
  (hook) => !registryKeys.has(listedKey(hook)),
);
const OMITTED_IDS = {
  WETHHook: "hook-9de6f9505baa4102127f",
  WstETHRoutingHook: "hook-478f5afc09e1b5da054b",
};
const officialIdOf = (hook) =>
  `hook-${digest(`${hook.chainId}:${hook.address}`)}`;
const officialChains = Object.fromEntries(
  officialHooks.map((hook) => [hook.chain, { chainId: hook.chainId }]),
);
// What the live directory builds for a hook from one census pool.
const liveProject = (hook) =>
  createDirectory(
    [],
    officialChains,
    [],
    [
      {
        chainId: hook.chainId,
        address: `0x${"ab".repeat(32)}`,
        hookAddress: hook.address,
        fee: 3000,
      },
    ],
  ).projects[0];

test("the recorded hooklist omits exactly the two listed hooks the comparison found missing", () => {
  assert.equal(officialHooks.length, 11);
  assert.deepEqual(
    omitted.map((hook) => [hook.name, hook.chain, hook.address]),
    [
      ["WETHHook", "monad", "0x3fad8a7205f943528915e67cf94fc792c8fce888"],
      [
        "WstETHRoutingHook",
        "ethereum",
        "0x3ac6e14a142251eb3fe739399e0a8da81ed06888",
      ],
    ],
  );
  for (const hook of omitted)
    assert.equal(officialIdOf(hook), OMITTED_IDS[hook.name]);
});

test("without the option a listed hook that no pool uses is not in the directory", () => {
  const before = createDirectory(hooklist, chainRegistry);
  const keys = keysIn(before.projects);
  for (const hook of omitted) assert.equal(keys.has(listedKey(hook)), false);
  assert.deepEqual(
    createDirectory(hooklist, chainRegistry, [], [], {}),
    before,
  );
  assert.deepEqual(
    createDirectory(hooklist, chainRegistry, [], [], {
      includeOfficialHooks: false,
    }),
    before,
  );
});

test("with includeOfficialHooks every listed hook is in the directory, and nothing else changes", () => {
  const before = createDirectory(hooklist, chainRegistry);
  const after = createDirectory(hooklist, chainRegistry, [], [], {
    includeOfficialHooks: true,
  });
  const keys = keysIn(after.projects);
  for (const hook of officialHooks)
    assert.ok(keys.has(listedKey(hook)), hook.name);
  const added = after.projects.filter(
    (project) => !before.projects.some((row) => row.id === project.id),
  );
  assert.deepEqual(
    added.map((project) => project.id).sort(),
    omitted.map(officialIdOf).sort(),
  );
  // Every project that was there is exactly as it was, and the chains are the same.
  assert.deepEqual(
    after.projects.filter((project) => !added.includes(project)),
    before.projects,
  );
  assert.deepEqual(after.chains, before.chains);
});

test("a listed hook added without a pool is the project the live directory builds from a pool of it", () => {
  const { projects } = createDirectory(hooklist, chainRegistry, [], [], {
    includeOfficialHooks: true,
  });
  for (const hook of omitted) {
    const named = projects.find((project) => project.id === officialIdOf(hook));
    assert.ok(named, hook.name);
    assert.deepEqual(named, liveProject(hook));
    assert.equal(named.name, hook.name);
    assert.equal(named.category, hook.category);
    assert.equal(named.description, hook.description);
    assert.equal(named.sourceUrl, hook.sourceUrl);
    assert.equal(named.deployments.length, 1);
    assert.equal(named.deployments[0].discovery, "published");
    assert.equal(named.deployments[0].sourceUrl, hook.sourceUrl);
    assert.equal(named.deployments[0].properties.dynamicFee, false);
    // A directory entry is not a measurement.
    assert.equal(named.metrics.poolCount, null);
    assert.deepEqual(named.metrics.volumeUsd, {
      h1: null,
      h6: null,
      h24: null,
    });
  }
});

test("a listed hook on a network the directory does not carry brings its network with it", () => {
  const { projects, chains } = createDirectory([], {}, [], [], {
    includeOfficialHooks: true,
  });
  assert.equal(projects.length, officialHooks.length);
  const monad = officialHooks.find((hook) => hook.chain === "monad");
  const chain = chains.find((row) => row.id === monad.chainId);
  assert.equal(chain.slug, "monad");
  assert.equal(chain.name, "Monad");
  assert.match(chain.explorer, /^https:\/\//);
});

test("a hook is never named from the list when the directory knows its network by another name", () => {
  const routing = officialHooks.find(
    (hook) => hook.name === "WstETHRoutingHook",
  );
  const { projects } = createDirectory(
    [],
    { renamed: { chainId: 1 } },
    [],
    [],
    {
      includeOfficialHooks: true,
    },
  );
  assert.equal(
    projects.some((project) =>
      project.deployments.some((d) => d.address === routing.address),
    ),
    false,
  );
});

/** A run's inputs: one measured Flaunch pool, so that the snapshot is a valid
 * one, and whatever else the state holds. */
function officialScenario(extraState = []) {
  const networks = measurementChains();
  const flaunchRow = hooklist.find(
    (row) =>
      /^Flaunch PositionManager$/.test(row.hook.name) &&
      networks.find((candidate) => candidate.chain === row.hook.chain),
  );
  const chain = networks.find(
    (candidate) => candidate.chain === flaunchRow.hook.chain,
  );
  const observedAt = Date.parse("2026-10-28T12:00:00.000Z");
  const pool = statePool(1, {
    chain: chain.chain,
    hookAddress: flaunchRow.hook.address.toLowerCase(),
  });
  const measured = new Map([
    [
      poolKey(chain.chain, pool.id),
      normalizeDexScreenerPool(
        dexRow(pool, { volume: { h24: 1000, h6: 300, h1: 50 } }),
        chain,
        pool,
        observedAt,
      ),
    ],
  ]);
  return {
    directoryInputs: {
      registry: hooklist,
      chains: chainRegistry,
      frontier: [],
    },
    statePools: [pool, ...extraState],
    measured,
    burst: {
      networks: [
        {
          chain: chain.chain,
          chainId: chain.chainId,
          requested: 1,
          checked: 1,
          measured: 1,
        },
      ],
    },
    census: null,
    history: [],
    sources: [],
    generatedAtMs: observedAt + 1000,
  };
}
const routingHook = officialHooks.find(
  (hook) => hook.name === "WstETHRoutingHook",
);
const NOT_ESTABLISHED =
  /has not been established, so it is not tagged as dynamic/;

test("the snapshot carries every listed hook, whether or not a pool of it is measured", () => {
  const { snapshot } = assembleSnapshot(officialScenario());
  assert.equal(isSnapshot(snapshot), true);
  const keys = keysIn(snapshot.projects);
  for (const hook of officialHooks)
    assert.ok(keys.has(listedKey(hook)), hook.name);
  // A listed hook is one project per exact deployment, with the id the live app gives it.
  for (const hook of omitted) {
    const named = snapshot.projects.find(
      (project) => project.id === OMITTED_IDS[hook.name],
    );
    assert.ok(named, hook.name);
    assert.equal(named.name, hook.name);
    assert.equal(named.category, hook.category);
    assert.equal(named.description, hook.description);
    assert.equal(named.sourceUrl, hook.sourceUrl);
    assert.deepEqual(named.chains, [hook.chain]);
    assert.equal(named.deployments.length, 1);
    assert.equal(named.deployments[0].id, listedKey(hook));
    assert.equal(named.deployments[0].discovery, "published");
    // No pool of it was measured: nothing is measured for it, and nothing is zero.
    assert.equal(named.metrics.poolCount, null);
    assert.equal(named.metrics.liquidityUsd, null);
    assert.deepEqual(named.metrics.volumeUsd, {
      h1: null,
      h6: null,
      h24: null,
    });
  }
  assert.equal(snapshot.pools.length, 1);
  assert.equal(snapshot.summary.indexedProjects, snapshot.projects.length);
  assert.equal(
    snapshot.summary.indexedDeployments,
    snapshot.projects.reduce(
      (sum, project) => sum + project.deployments.length,
      0,
    ),
  );
});

test("the two added projects are the live directory's, apart from the note that the edition has no fee reading for them", () => {
  const { snapshot } = assembleSnapshot(officialScenario());
  for (const hook of omitted) {
    const named = snapshot.projects.find(
      (project) => project.id === OMITTED_IDS[hook.name],
    );
    const live = liveProject(hook);
    const plain = ({ metrics: _m, history: _h, ...project }) => ({
      ...project,
      deployments: project.deployments.map(
        ({ description: _d, ...deployment }) => deployment,
      ),
    });
    assert.deepEqual(plain(named), plain(live));
    // The project's own description is the list's, word for word.
    assert.equal(named.description, live.description);
    // With no pool of the hook in the state, whether it sets fees dynamically is
    // not known here; the edition says so, as it does for every hook without a reading.
    assert.equal(named.deployments[0].properties.dynamicFee, false);
    assert.ok(named.deployments[0].description.startsWith(hook.description));
    assert.match(named.deployments[0].description, NOT_ESTABLISHED);
  }
});

test("a state pool of a listed hook that was not measured decides whether the hook is tagged as dynamic", () => {
  const unmeasured = (seed, dynamicFee) =>
    statePool(seed, {
      chain: routingHook.chain,
      hookAddress: routingHook.address,
      ...(dynamicFee === undefined ? {} : { dynamicFee }),
    });
  const deploymentOf = (statePools) =>
    assembleSnapshot(officialScenario(statePools)).snapshot.projects.find(
      (project) => project.id === OMITTED_IDS.WstETHRoutingHook,
    ).deployments[0];

  const dynamic = deploymentOf([unmeasured(2, true)]);
  assert.equal(dynamic.properties.dynamicFee, true);
  assert.equal(dynamic.description, routingHook.description);

  const fixed = deploymentOf([unmeasured(3, false)]);
  assert.equal(fixed.properties.dynamicFee, false);
  assert.equal(fixed.description, routingHook.description);

  const unknown = deploymentOf([unmeasured(4)]);
  assert.equal(unknown.properties.dynamicFee, false);
  assert.match(unknown.description, NOT_ESTABLISHED);
});

test("an offline replay of the recorded run publishes all eleven listed hooks", async () => {
  const { dir, result } = await sharedOfflineRun();
  const written = await read(dir, "snapshot.json");
  for (const snapshot of [result.snapshot, written]) {
    assert.equal(isSnapshot(snapshot), true);
    const keys = keysIn(snapshot.projects);
    assert.deepEqual(
      officialHooks.filter((hook) => !keys.has(listedKey(hook))),
      [],
    );
    for (const hook of omitted)
      assert.ok(
        snapshot.projects.some(
          (project) => project.id === OMITTED_IDS[hook.name],
        ),
        hook.name,
      );
  }
});
