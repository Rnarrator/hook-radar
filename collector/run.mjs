#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COLLECTOR_VERSION,
  DISCOVERY_BUDGET_MS,
  DS_BATCH_SIZE,
  FRONTIER_LATEST_START_MS,
  FRONTIER_MAX_REQUESTS,
  GT_FALLBACK_MAX_REQUESTS,
  LAST_SEEN_GRANULARITY_MS,
  MAX_DISCOVERED_MEASURED,
  MAX_MEASURED_POOLS,
  MAX_RESOLVES_PER_RUN,
  MIN_CURRENT_POOLS,
  resolveGaps,
  resolveMaxDiscovery,
  resolveRateLimitCap,
  STATE_MAX_POOLS,
  userAgent,
} from "./config.mjs";
import {
  assembleSnapshot,
  currentPoolCount,
  providerSources,
  validSnapshot,
} from "./assemble.mjs";
import { discoverPools, discoveryChains, discoveryStats } from "./discover.mjs";
import { historyPointFor } from "./history.mjs";
import { createHttpClient } from "./http.mjs";
import {
  byPriority,
  measurementChains,
  planBurst,
  runBurst,
} from "./measure.mjs";
import { createFixtureTransport } from "./offline.mjs";
import { buildOverviewFiles } from "./overview.mjs";
import {
  collectFrontier,
  overlayFrontier,
  skippedFrontier,
  withFrontierNetworks,
} from "./providers/frontier.mjs";
import { discoveryPage } from "./providers/geckoterminal.mjs";
import { assessQuality } from "./quality.mjs";
import { loadRegistry } from "./registry.mjs";
import {
  historyJson,
  poolKey,
  readState,
  writeFileAtomic,
  writeState,
} from "./state.mjs";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const FIXTURES = join(ROOT, "collector", "fixtures");
const RUN_SLOT_MS = 3 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

/** The requests the burst, its fallback and the Frontier step can need for a
 * plan of `maxPools` pools. Batches are rounded up per network, so the plan can
 * need one more request for each network the providers price than maxPools / 30
 * alone. */
export function requestReserve(maxPools) {
  return (
    Math.ceil(maxPools / DS_BATCH_SIZE) +
    measurementChains().length +
    GT_FALLBACK_MAX_REQUESTS +
    FRONTIER_MAX_REQUESTS
  );
}

/** The discovery the request budget still allows once the measurement burst,
 * its fallback and the registry fetches are reserved. */
export function fitDiscovery({ lists, resolves, allowance }) {
  let n = lists;
  let r = resolves;
  while (2 * n + r > allowance && (r > 0 || n > 0)) {
    if (r > 0) r--;
    else n--;
  }
  return { lists: Math.max(0, n), resolves: Math.max(0, r) };
}

/** The priority list as the run uses it: every key on it, and a state record
 * for each pool the state does not hold yet. Such a record is a seeded pool like
 * any other (its identity comes from the live app's census, which the list was
 * made from), first and last seen when the list was exported; the state keeps it
 * from the first run that follows. */
export function priorityPlan(priority, known) {
  const keys = new Set();
  const fresh = [];
  for (const row of priority?.pools ?? []) {
    const key = poolKey(row.chain, row.id);
    keys.add(key);
    if (known.has(key)) continue;
    fresh.push({
      id: row.id,
      chain: row.chain,
      hookAddress: row.hookAddress,
      tokens: [...row.tokens],
      name: row.name,
      createdAt: row.createdAt,
      source: "census",
      firstSeen: priority.exportedAt,
      lastSeen: priority.exportedAt,
    });
  }
  return { keys, fresh };
}

/** The pool records after a successful run: seen pools keep a quiet lastSeen,
 * discovered ones are added, and the oldest are dropped above the state cap. */
export function nextPools({ pools, found, measured, generatedAtMs }) {
  const stamp = iso(generatedAtMs);
  const merged = new Map();
  for (const pool of [...pools, ...found]) {
    const key = poolKey(pool.chain, pool.id);
    if (merged.has(key)) continue;
    const seen = measured.get(key);
    const stale =
      generatedAtMs - Date.parse(pool.lastSeen) >= LAST_SEEN_GRANULARITY_MS;
    const { via: _via, ...rest } = pool;
    // Only DEX Screener and GeckoTerminal tell which of the two prices a pool;
    // a pool Frontier measured keeps what was known before.
    const via =
      seen && seen.metricProvider !== "frontier"
        ? seen.metricProvider
        : pool.via;
    merged.set(key, {
      ...rest,
      ...(via === "geckoterminal" ? { via } : {}),
      createdAt: pool.createdAt ?? seen?.createdAt ?? null,
      lastSeen: seen && stale ? stamp : pool.lastSeen,
    });
  }
  return [...merged.values()].sort(byPriority).slice(0, STATE_MAX_POOLS);
}

function statusDocument({
  snapshot,
  collectionStartedAt,
  burst,
  quality,
  stats,
  discovery,
  state,
  offline,
  plan,
  dropped,
  frontier,
  priority,
}) {
  // The Frontier lane carries the configuration read at the start and the
  // market reads of the Frontier step; each source is credited its own.
  const frontierReads = frontier.requests;
  const requestsBy = {
    registry: stats.registry.requests,
    "frontier-chains":
      stats.frontier.requests -
      (frontierReads["frontier-coins"] ?? 0) -
      (frontierReads["frontier-stats"] ?? 0),
    "frontier-coins": frontierReads["frontier-coins"] ?? 0,
    "frontier-stats": frontierReads["frontier-stats"] ?? 0,
    "frontier-amm-index": frontierReads["frontier-amm-index"] ?? 0,
    dexscreener: stats.dexscreener.requests,
    geckoterminal: stats.geckoterminal.requests,
    v4xyz: stats.v4xyz.requests,
  };
  const total = Object.values(stats).reduce(
    (sum, row) => sum + row.requests,
    0,
  );
  return {
    generatedAt: snapshot.generatedAt,
    collectionStartedAt: iso(collectionStartedAt),
    burstStartedAt: iso(burst.startedAt),
    burstEndedAt: iso(burst.endedAt),
    counts: {
      statePools: state.pools.length,
      plannedPools: plan.planned,
      plannedDiscoveredPools: plan.plannedDiscovered,
      // The pools of launchpad platforms' and named projects' exact hooks
      // (state/priority.json): how many are listed, how many the state did not
      // hold before this run, how many the plan took and how many were measured.
      priorityPools: priority,
      requestedPools: burst.requestedPools,
      answeredPools: burst.answeredPools,
      checkedPools: burst.checkedPools,
      measuredPools: burst.measured.size,
      trackedPools: snapshot.pools.length,
      currentPools: quality.checks.currentPools,
      droppedForCap: dropped,
      projects: snapshot.projects.length,
      deployments: snapshot.summary.indexedDeployments,
      networks: snapshot.coverage.measuredChains.length,
      discoveredPools: discovery.found.length,
      discoveredHookless: discovery.hookless.length,
      fallbackRequests: burst.fallback.requests,
      fallbackMeasured: burst.fallback.measured,
      frontier: {
        coinMarketsListed: frontier.listed,
        poolsSupplied: frontier.supplied,
        poolsAdded: frontier.added,
        poolsReplacingOlderRow: frontier.replaced,
        poolsKeptFromOtherProvider: frontier.kept,
        poolsLeftOutOnMismatch: frontier.skipped.length,
        failure: frontier.failure,
      },
      unsupportedNetworks: [...burst.unsupportedNetworks].sort(),
      rateLimitWaits: Object.fromEntries(
        Object.entries(stats)
          .filter(([, row]) => row.rateLimitWaits)
          .map(([id, row]) => [
            id,
            { times: row.rateLimitWaits, waitedMs: row.rateLimitWaitedMs },
          ]),
      ),
      requests: {
        total,
        ...Object.fromEntries(
          Object.entries(stats).map(([id, row]) => [id, row.requests]),
        ),
      },
      discovery: discovery.stats,
    },
    sources: snapshot.sources.map((source) => ({
      ...source,
      ...(requestsBy[source.id] !== undefined
        ? { requests: requestsBy[source.id] }
        : {}),
    })),
    collectorVersion: COLLECTOR_VERSION,
    previousGeneratedAt: state.updatedAt,
    ...(offline ? { offline: true } : {}),
  };
}

/** One collection run. Returns the outcome; writes files only when it passed
 * the quality gate and `publish` is set. */
export async function runCollector({
  stateDir = join(ROOT, "state"),
  outDir = join(ROOT, "public", "data"),
  stateOutDir = stateDir,
  publish = true,
  offline = false,
  fixturesDir = FIXTURES,
  maxDiscovery = Infinity,
  maxPools = MAX_MEASURED_POOLS + MAX_DISCOVERED_MEASURED,
  minCurrent = MIN_CURRENT_POOLS,
  discoveryBudgetMs = DISCOVERY_BUDGET_MS,
  discoveryPageOverride = null,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  sleep,
  caps = {},
  log = () => {},
} = {}) {
  let transport = null;
  if (offline) {
    transport = await createFixtureTransport(fixturesDir);
    fetchImpl = transport.fetchImpl;
    now = transport.now;
    sleep = transport.sleep;
    discoveryPageOverride ??= transport.manifest.discoveryPage ?? null;
  }
  const collectionStartedAt = now();
  const state = await readState(stateDir);
  const client = createHttpClient({
    fetchImpl,
    now,
    ...(sleep ? { sleep } : {}),
    userAgent: userAgent(env),
    gaps: resolveGaps(env),
    rateLimitCapMs: resolveRateLimitCap(env),
    caps,
    onEvent: (event) =>
      log(
        `${event.ok ? "ok  " : event.code === "cooldown" ? "WAIT" : "FAIL"} ${event.provider} ${event.status ?? event.code ?? ""}`,
      ),
  });

  log("Registry");
  const registry = await loadRegistry({ client, saved: state.registry });

  const chains = discoveryChains();
  const reserve = requestReserve(maxPools);
  const wanted = Math.min(maxDiscovery, chains.length);
  const fit = fitDiscovery({
    lists: wanted,
    resolves: Math.min(
      MAX_RESOLVES_PER_RUN,
      maxDiscovery === Infinity ? MAX_RESOLVES_PER_RUN : maxDiscovery,
    ),
    allowance: client.requestsLeft() - reserve,
  });
  log(`Discovery: ${fit.lists} networks, up to ${fit.resolves} exact lookups`);
  const known = new Set(
    state.pools.map((pool) => poolKey(pool.chain, pool.id)),
  );
  const priority = priorityPlan(state.priority, known);
  for (const pool of priority.fresh) known.add(poolKey(pool.chain, pool.id));
  const discovery = fit.lists
    ? await discoverPools({
        client,
        known,
        hookless: state.hookless,
        page:
          discoveryPageOverride ??
          discoveryPage(Math.floor(collectionStartedAt / RUN_SLOT_MS)),
        maxDiscovery: fit.lists,
        maxResolves: fit.resolves,
        now,
        notAfter: collectionStartedAt + discoveryBudgetMs,
        chains,
      })
    : {
        found: [],
        hookless: [],
        stats: discoveryStats(),
      };
  const pools = [...state.pools, ...priority.fresh, ...discovery.found];

  log(`Measurement burst over ${pools.length} known pools`);
  // Seeded pools, the priority list among them, fill the plan up to
  // MAX_MEASURED_POOLS; discovery has the rest, as before.
  const plan = planBurst(pools, {
    maxPools,
    maxSeeded: Math.min(MAX_MEASURED_POOLS, maxPools),
    protectedKeys: priority.keys,
  });
  const dexBurst = await runBurst({ client, plan, now });

  // Frontier's own figures for the pools of its hooks (three requests). The step
  // never fails the run: a source that does not answer is reported unavailable
  // and the DEX Screener rows of those pools stay. It runs after the burst, so
  // its rows are the newest of the run, and the snapshot time is taken after it.
  log("Frontier pool markets");
  const frontier =
    now() - dexBurst.startedAt > FRONTIER_LATEST_START_MS
      ? skippedFrontier(
          "the measurement burst ran too long to read Frontier inside the five-minute window",
        )
      : await collectFrontier({
          client,
          frontierChains: registry.data.frontier,
          known: new Map(
            pools.map((pool) => [poolKey(pool.chain, pool.id), pool]),
          ),
          now,
        });
  const overlay = overlayFrontier(dexBurst.measured, frontier.pools);
  // The measurements end with Frontier's: that is the snapshot's time.
  const generatedAtMs = Math.max(dexBurst.endedAt, now());
  const burst = {
    ...dexBurst,
    measured: overlay.measured,
    endedAt: generatedAtMs,
    networks: withFrontierNetworks(
      dexBurst.networks,
      frontier.pools,
      dexBurst.requestedKeys,
      new Map(measurementChains().map((chain) => [chain.chain, chain.chainId])),
    ),
  };
  const frontierCounts = {
    listed: frontier.pricedCoins,
    supplied: frontier.pools.length,
    added: overlay.added,
    replaced: overlay.replaced,
    kept: overlay.kept,
    skipped: frontier.skipped,
    failure: frontier.failure,
    requests: frontier.requests,
  };

  const stats = client.stats();
  // The notes name a network as the page does, so they are made once the
  // snapshot's chains are known.
  const sources = (chains) =>
    providerSources({
      stats,
      measured: burst.measured,
      discovery: discovery.stats,
      census: state.census,
      registrySources: registry.sources,
      unsupportedNetworks: burst.unsupportedNetworks,
      frontier: { sources: frontier.sources, ...frontierCounts },
      chains,
    });
  const { snapshot, historyPoints } = assembleSnapshot({
    directoryInputs: {
      registry: registry.data.registry,
      chains: registry.data.chains,
      frontier: registry.data.frontier,
    },
    statePools: pools,
    measured: burst.measured,
    burst,
    census: state.census,
    history: state.history,
    sources,
    generatedAtMs,
  });

  let overviews = [];
  let overviewsValid = true;
  try {
    overviews = await buildOverviewFiles(snapshot, generatedAtMs);
  } catch (error) {
    overviewsValid = false;
    log(`Overview failed: ${error.message}`);
  }
  const quality = assessQuality({
    currentPools: currentPoolCount(snapshot),
    currentVolumePools:
      snapshot.summary.freshness?.volume?.h24?.currentPools ?? 0,
    observedPools: snapshot.pools.length,
    plannedPools: plan.planned,
    requestedPools: burst.requestedPools,
    checkedPools: burst.answeredPools,
    snapshotValid: validSnapshot(snapshot),
    overviewsValid,
    volumeMeasured: historyPointFor(snapshot.summary) !== null,
    minCurrent,
    previousPoint: state.history.at(-1) ?? null,
    generatedAtMs,
    stoppedProviders: Object.entries(stats)
      .filter(([, row]) => row.stopped)
      .map(([id, row]) => `${id} (${row.stopped.reason})`),
    unsupportedNetworks: [...burst.unsupportedNetworks].sort(),
  });
  const status = statusDocument({
    snapshot,
    collectionStartedAt,
    burst,
    quality,
    stats,
    discovery,
    state,
    offline,
    plan,
    dropped: pools.length - plan.planned - plan.unsupported,
    frontier: frontierCounts,
    priority: {
      listed: priority.keys.size,
      addedToState: priority.fresh.length,
      planned: plan.plannedProtected,
      measured: [...plan.protectedKeys].filter((key) => burst.measured.has(key))
        .length,
    },
  });
  const result = {
    ok: quality.ok,
    quality,
    snapshot,
    status,
    overviews,
    historyPoints,
    published: false,
    served: transport?.served,
  };
  if (!quality.ok) return result;

  if (publish) {
    await mkdir(outDir, { recursive: true });
    for (const file of overviews)
      await writeFileAtomic(join(outDir, file.name), file.text);
    await writeFileAtomic(
      join(outDir, "history.json"),
      historyJson(historyPoints),
    );
    await writeFileAtomic(
      join(outDir, "status.json"),
      `${JSON.stringify(status, null, 2)}\n`,
    );
    await writeFileAtomic(
      join(outDir, "snapshot.json"),
      JSON.stringify(snapshot),
    );
    await writeState(stateOutDir, {
      updatedAt: snapshot.generatedAt,
      pools: nextPools({
        pools: state.pools,
        found: [...priority.fresh, ...discovery.found],
        measured: burst.measured,
        generatedAtMs,
      }),
      hookless: new Set([...state.hookless, ...discovery.hookless]),
      history: historyPoints,
      registry: registry.changed || !state.registry ? registry.fetched : null,
    });
    result.published = true;
  }
  return result;
}

const USAGE = `Usage: node collector/run.mjs [options]
  --offline            replay recorded fixtures (collector/fixtures); no network call; requires --out
  --no-publish         collect and validate, write nothing to public/data or state
  --out <dir>          write the data files to <dir> and updated state to <dir>/state
  --state <dir>        read state from <dir> (default state/, or the fixture state with --offline)
  --max-discovery <n>  at most n networks for discovery (0 turns discovery off)
  --max-pools <n>      measure at most n pools
  --min-current <n>    minimum pools with a current 24h volume for the quality gate (below ${MIN_CURRENT_POOLS} only with --offline)
  --verbose            print every request outcome`;

export function parseArguments(argv) {
  const options = { publish: true };
  const number = (name, value, { min = 0 } = {}) => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < min)
      throw new Error(`${name} needs a whole number of at least ${min}.`);
    return parsed;
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${flag} needs a value.`);
      return next;
    };
    if (flag === "--offline") options.offline = true;
    else if (flag === "--no-publish") options.publish = false;
    else if (flag === "--verbose") options.verbose = true;
    else if (flag === "--out") options.out = resolve(value());
    else if (flag === "--state") options.state = resolve(value());
    else if (flag === "--max-discovery")
      options.maxDiscovery = number(flag, value());
    else if (flag === "--max-pools")
      options.maxPools = number(flag, value(), { min: 1 });
    else if (flag === "--min-current")
      options.minCurrent = number(flag, value(), { min: 1 });
    else if (flag === "--help" || flag === "-h") options.help = true;
    else throw new Error(`Unknown option ${flag}.`);
  }
  if (options.offline && !options.out && options.publish)
    throw new Error(
      "--offline writes nothing into public/data: pass --out <dir> (or --no-publish).",
    );
  if (
    options.minCurrent !== undefined &&
    options.minCurrent < MIN_CURRENT_POOLS &&
    !options.offline
  )
    throw new Error(
      `--min-current below ${MIN_CURRENT_POOLS} is only allowed with --offline.`,
    );
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  // The Snapshot workflow sets COLLECTOR_MAX_DISCOVERY for the runs that only
  // measure the pools already known. --max-discovery on the command line wins.
  options.maxDiscovery ??= resolveMaxDiscovery(process.env);
  const outDir = options.out ?? join(ROOT, "public", "data");
  const stateDir =
    options.state ??
    (options.offline ? join(FIXTURES, "state") : join(ROOT, "state"));
  try {
    const result = await runCollector({
      stateDir,
      outDir,
      stateOutDir: options.out ? join(options.out, "state") : stateDir,
      publish: options.publish,
      offline: options.offline,
      maxDiscovery: options.maxDiscovery,
      maxPools: options.maxPools,
      minCurrent:
        options.minCurrent ?? (options.offline ? 20 : MIN_CURRENT_POOLS),
      log: options.verbose ? (line) => console.error(line) : () => {},
    });
    const { checks } = result.quality;
    console.log(
      `${result.ok ? "PASS" : "REFUSED"} · ${checks.currentPools} current pools · ${checks.requestedPools}/${checks.plannedPools} planned pools requested, ${checks.checkedPools} answered · generatedAt ${result.snapshot.generatedAt}${result.published ? ` · written to ${outDir}` : " · nothing written"}`,
    );
    for (const failure of result.quality.failures)
      console.error(`  - ${failure}`);
    if (!result.ok) {
      // A refused run writes no status.json, so what explains it is printed.
      const { requests, unsupportedNetworks, rateLimitWaits } =
        result.status.counts;
      console.error(
        `  requests ${JSON.stringify(requests)} · DEX Screener answered HTTP 400 for ${JSON.stringify(unsupportedNetworks)} · rate-limit waits ${JSON.stringify(rateLimitWaits)}`,
      );
    }
    return result.ok ? 0 : 1;
  } catch (error) {
    console.error(`Collector failed: ${error.message}`);
    return 1;
  }
}

/** Whether this file is the program that was started. Both sides are resolved to
 * their real path, so a start through a symbolic link or a directory junction is
 * the same file; a path that cannot be resolved is compared as it is written. */
export function startedDirectly(
  moduleUrl = import.meta.url,
  entry = process.argv[1],
) {
  if (!entry) return false;
  const real = (path) => {
    try {
      return realpathSync.native(path);
    } catch {
      return resolve(path);
    }
  };
  return real(fileURLToPath(moduleUrl)) === real(entry);
}

if (startedDirectly()) process.exitCode = await main();
