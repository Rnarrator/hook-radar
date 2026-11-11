import { categories, projectComparator } from "../src/model.ts";
import { projectPoolScopeSteps, selectProjects } from "../src/scope.ts";
import { getProtocolArtwork } from "../src/protocol-logos.ts";
import {
  refreshMarketSnapshot,
  refreshMarketSnapshotSteps,
} from "../shared/market-freshness.ts";
import {
  runSynchronously,
  runCooperatively,
  cooperativeSortSteps,
} from "./cooperative.mjs";

const snapshots = new WeakMap();
const projectIndexes = new WeakMap();
const poolIndexes = new WeakMap();
const leanSnapshots = new WeakMap();
const leanSelections = new WeakMap();
const indexFlights = new WeakMap();
const freshnessFlights = new WeakMap();
const leanFlights = new WeakMap();
const catalogStructures = new WeakMap();
const recentCatalogs = [];
const STRUCTURE_CHUNK_SIZE = 1024;
const defaults = Object.freeze({
  search: "",
  chain: "all",
  category: "all",
  property: "all",
  market: "all",
  sort: "volume",
  direction: "desc",
  window: "h24",
  offset: 0,
  limit: 25,
  saved: false,
});
const scalarParams = Object.keys(defaults);
const allowedParams = new Set([...scalarParams, "id"]);
const slug = /^[a-z0-9][a-z0-9-]{0,99}$/;
const controls = /[\u0000-\u001f\u007f-\u009f]/;
const measured = (pool) =>
  pool.liquidityUsd !== null ||
  Object.values(pool.volumeUsd).some((value) => value !== null);
const compareIds = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function boundedCache(cache, key, value, size) {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > size) cache.delete(cache.keys().next().value);
  return value;
}

function validatedOptions(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options))
    throw new RangeError("Invalid directory options.");
  for (const key of Object.keys(options))
    if (!scalarParams.includes(key) && key !== "ids")
      throw new RangeError("Unknown directory option.");
  const value = { ...defaults, ...options };
  if (
    typeof value.search !== "string" ||
    value.search.length > 300 ||
    controls.test(value.search)
  )
    throw new RangeError("Directory search must be at most 300 characters.");
  if (typeof value.chain !== "string" || !slug.test(value.chain))
    throw new RangeError("Invalid directory network.");
  const choices = {
    category: ["all", ...categories],
    property: ["all", "dynamic", "verified", "upgradeable", "custom"],
    market: ["projects", "all", "observed", "active"],
    sort: ["name", "deployments", "volume", "liquidity", "pools"],
    direction: ["asc", "desc"],
    window: ["h1", "h6", "h24"],
  };
  for (const [key, values] of Object.entries(choices))
    if (!values.includes(value[key]))
      throw new RangeError("Invalid directory " + key + ".");
  if (!Number.isSafeInteger(value.offset) || value.offset < 0)
    throw new RangeError("Invalid directory page offset.");
  if (
    !Number.isSafeInteger(value.limit) ||
    value.limit < 1 ||
    value.limit > 100
  )
    throw new RangeError("Directory page size must be between 1 and 100.");
  if (typeof value.saved !== "boolean")
    throw new RangeError("Invalid saved directory scope.");
  if (value.ids !== undefined) {
    if (
      !Array.isArray(value.ids) ||
      value.ids.length > 2000 ||
      value.ids.some((id) => typeof id !== "string" || !slug.test(id))
    )
      throw new RangeError("Invalid saved project IDs.");
    value.ids = [...new Set(value.ids)].sort();
    value.saved = true;
  } else if (value.saved) value.ids = [];
  // Equivalent searches share their result, including empty whitespace input.
  value.search = value.search.trim().toLowerCase();
  return value;
}

/** Parse only bounded directory filters. Repeated id fields represent a watchlist. */
export function parseDirectoryParams(params) {
  if (!(params instanceof URLSearchParams))
    throw new RangeError("Invalid directory query.");
  const values = {};
  for (const key of new Set(params.keys())) {
    if (!allowedParams.has(key))
      throw new RangeError("Unknown directory query parameter.");
    const entries = params.getAll(key);
    if (key === "id") {
      values.ids = entries;
      continue;
    }
    if (entries.length !== 1)
      throw new RangeError("Duplicate directory query parameter.");
    const entry = entries[0];
    if (key === "offset" || key === "limit") {
      if (!/^\d+$/.test(entry))
        throw new RangeError("Invalid directory pagination.");
      values[key] = Number(entry);
    } else if (key === "saved") {
      if (entry !== "1") throw new RangeError("Invalid saved directory scope.");
      values.saved = true;
    } else values[key] = entry;
  }
  return validatedOptions(values);
}

function* indexSteps(snapshot) {
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    !Array.isArray(snapshot.projects)
  )
    throw new TypeError("A directory snapshot is required.");
  let cached = snapshots.get(snapshot);
  if (cached) return cached;
  let projectIndex = projectIndexes.get(snapshot.projects);
  if (!projectIndex) {
    projectIndex = {
      projects: snapshot.projects,
      lookups: new Map(),
      bodies: new WeakMap(),
    };
    projectIndexes.set(snapshot.projects, projectIndex);
  }
  let poolIndex = poolIndexes.get(snapshot.pools);
  if (!poolIndex) {
    const pricedProjects = new Set();
    const poolsByProject = new Map();
    let operations = 0;
    for (const pool of snapshot.pools) {
      if (pool.projectId !== null) {
        const list = poolsByProject.get(pool.projectId) || [];
        list.push(pool);
        poolsByProject.set(pool.projectId, list);
        if (measured(pool)) pricedProjects.add(pool.projectId);
      }
      if (++operations % 1024 === 0) yield;
    }
    poolIndex = poolIndexes.get(snapshot.pools) || {
      pricedProjects,
      poolsByProject,
    };
    poolIndexes.set(snapshot.pools, poolIndex);
  }
  const { projects } = projectIndex;
  const { pricedProjects, poolsByProject } = poolIndex;
  const body = projectIndex.bodies.get(snapshot.pools);
  // A freshness check may return a new wrapper around the same immutable
  // directory evidence. Source status/generatedAt changes do not change its
  // pages. Keep one body per array pair, guarded by every additional input
  // used by selection; a new market proof still invalidates exact-time scopes.
  if (
    body &&
    body.events === snapshot.events &&
    body.hasInventory === Boolean(snapshot.inventory) &&
    body.freshness === snapshot.summary?.freshness
  ) {
    snapshots.set(snapshot, body.value);
    return body.value;
  }
  cached = snapshots.get(snapshot) || {
    projects,
    projectIndex,
    pricedProjects,
    poolsByProject,
    selections: new Map(),
    pages: new Map(),
    selectionFlights: new Map(),
    pageFlights: new Map(),
    lean: null,
  };
  snapshots.set(snapshot, cached);
  projectIndex.bodies.set(snapshot.pools, {
    events: snapshot.events,
    hasInventory: Boolean(snapshot.inventory),
    freshness: snapshot.summary?.freshness,
    value: cached,
  });
  return cached;
}

/** Browsing needs a few complete families for artwork, or a bounded watchlist.
 * Keep only those identities instead of allocating a Map of the whole census
 * for every market publication. Scan to the end to retain last-ID precedence. */
function* projectLookupSteps(index, ids, retainPositions) {
  const unique = [...new Set(ids)].sort();
  const key = JSON.stringify(unique);
  const prior = index.lookups.get(key);
  if (prior) {
    if (retainPositions)
      for (const [id, position] of prior.positions)
        retainPositions.set(id, position);
    return prior.found;
  }
  const wanted = new Set(unique);
  const found = new Map();
  const positions = new Map();
  if (wanted.size) {
    let work = 0;
    for (let position = 0; position < index.projects.length; position++) {
      const project = index.projects[position];
      if (wanted.has(project.id)) {
        found.set(project.id, project);
        positions.set(project.id, position);
      }
      if (++work % 1024 === 0) yield;
    }
  }
  const completed =
    index.lookups.get(key) ||
    boundedCache(index.lookups, key, { found, positions }, 4);
  if (retainPositions)
    for (const [id, position] of completed.positions)
      retainPositions.set(id, position);
  return completed.found;
}

/** Keep market observations, registered projects and recorded project history. */
export function* leanSnapshotSteps(snapshot) {
  const cached = leanSnapshots.get(snapshot);
  if (cached) return cached;
  const { directory: priorDirectory, ...snapshotFields } = snapshot;
  let choices = leanSelections.get(snapshot.projects);
  if (!choices) {
    choices = new WeakMap();
    leanSelections.set(snapshot.projects, choices);
  }
  let selection = choices.get(snapshot.pools);
  if (!selection) {
    const pricedProjects = new Set();
    let work = 0;
    for (const pool of snapshot.pools) {
      if (++work % 512 === 0) yield;
      if (measured(pool)) pricedProjects.add(pool.projectId);
    }
    const projects = [];
    let totalDeployments = 0;
    for (const project of snapshot.projects) {
      if (++work % 512 === 0) yield;
      totalDeployments += project.deployments.length;
      if (
        project.entityType === "platform" ||
        pricedProjects.has(project.id) ||
        project.history?.length > 0 ||
        project.deployments.some(
          (deployment) => deployment.discovery !== "onchain",
        )
      )
        projects.push(project);
    }
    selection = {
      projects,
      directory:
        projects.length === snapshot.projects.length
          ? null
          : {
              mode: "paginated",
              totalProjects: snapshot.projects.length,
              totalDeployments,
              loadedProjects: projects.length,
            },
    };
    selection = choices.get(snapshot.pools) || selection;
    choices.set(snapshot.pools, selection);
  }
  const value = selection.directory
    ? {
        ...snapshotFields,
        projects: selection.projects,
        directory: selection.directory,
      }
    : priorDirectory === undefined
      ? snapshot
      : snapshotFields;
  const published = leanSnapshots.get(snapshot);
  if (published) return published;
  leanSnapshots.set(snapshot, value);
  return value;
}

export function leanSnapshot(snapshot) {
  return runSynchronously(leanSnapshotSteps(snapshot));
}

/** A cancelled reader stops waiting; concurrent readers share one complete
 * projection. No incomplete lean selection or freshness frame is cached. */
export async function leanSnapshotAsync(snapshot, runtime = {}) {
  runtime.signal?.throwIfAborted();
  const cached = leanSnapshots.get(snapshot);
  if (cached) return cached;
  let pending = leanFlights.get(snapshot);
  if (!pending) {
    pending = runCooperatively(leanSnapshotSteps(snapshot), {
      budgetMs: runtime.budgetMs,
    });
    leanFlights.set(snapshot, pending);
    pending
      .finally(() => {
        if (leanFlights.get(snapshot) === pending) leanFlights.delete(snapshot);
      })
      .catch(() => {});
  }
  return waitForResult(pending, runtime.signal);
}

export async function refreshSnapshotAsync(snapshot, runtime = {}) {
  runtime.signal?.throwIfAborted();
  const now = runtime.now?.() ?? Date.now();
  let lanes = freshnessFlights.get(snapshot.projects);
  if (!lanes) {
    lanes = new WeakMap();
    freshnessFlights.set(snapshot.projects, lanes);
  }
  // Publications can change source status without changing immutable market
  // inputs. Share the expensive traversal, including follow-up expiry work,
  // but always evaluate the caller's own wrapper and exact captured clock.
  for (;;) {
    runtime.signal?.throwIfAborted();
    const existing = lanes.get(snapshot.pools);
    if (existing) {
      if (runtime.priority === "interactive") existing.priority = "interactive";
      await waitForResult(existing.promise, runtime.signal);
      continue;
    }
    const steps = refreshMarketSnapshotSteps(snapshot, now);
    const began = runtime.timings ? performance.now() : 0;
    const first = steps.next();
    // A completed cache check does not own a shared traversal. Include the
    // private first slice only when this reader starts actual cooperative work.
    if (first.done) return first.value;
    const initial = runtime.timings
      ? { activeMs: performance.now() - began, steps: 1 }
      : undefined;
    const flight = { priority: runtime.priority, promise: null };
    const pending = runDirectoryWork(
      steps,
      {
        ...runtime,
        priority: () => flight.priority,
      },
      "freshness",
      initial,
    );
    flight.promise = pending;
    lanes.set(snapshot.pools, flight);
    pending
      .finally(() => {
        if (lanes.get(snapshot.pools) === flight) lanes.delete(snapshot.pools);
      })
      .catch(() => {});
    const value = await waitForResult(pending, runtime.signal);
    runtime.signal?.throwIfAborted();
    return value;
  }
}

function recordDirectoryWork(target, stage, timings) {
  const bounded = (value) =>
    Number.isFinite(value) ? Math.max(0, Math.min(value, 3600000)) : 0;
  for (const [suffix, duration] of [
    ["active", timings.activeMs],
    ["wait", (timings.queueMs || 0) + (timings.promiseMs || 0)],
  ]) {
    const key = `${stage}_${suffix}`;
    target[key] = bounded(bounded(target[key]) + bounded(duration));
  }
}

function runDirectoryWork(steps, runtime, stage, initial) {
  if (!runtime.timings)
    return runCooperatively(steps, {
      budgetMs: runtime.budgetMs,
      priority: runtime.priority,
    });
  const timings = initial || {};
  return runCooperatively(steps, {
    budgetMs: runtime.budgetMs,
    priority: runtime.priority,
    timings,
  }).finally(() => recordDirectoryWork(runtime.timings, stage, timings));
}

function selectionKey(options) {
  const { search, chain, category, property, market, ids, saved } = options;
  return JSON.stringify([
    search,
    chain,
    category,
    property,
    market,
    saved,
    ids,
    options.market === "active" ? options.window : null,
  ]);
}

function scopedPoolCount(project, chain) {
  const inventory = project.poolInventory;
  if (!inventory) return project.metrics.poolCount;
  if (chain === "all") return inventory.poolCount;
  // A complete inventory establishes an omitted chain as empty. An incomplete
  // inventory without this chain's count can still use its observed sample.
  return (
    inventory.chains[chain] ??
    (inventory.complete ? 0 : project.metrics.poolCount)
  );
}

function directoryComparator(sort, direction, window, chain = "all") {
  const compare = projectComparator(
    sort,
    direction,
    window,
    sort === "pools" ? (project) => scopedPoolCount(project, chain) : undefined,
  );
  return (a, b) => compare(a, b) || compareIds(a, b);
}

function keepTopSix(top, project, compare, retain) {
  if (top.length === 6 && compare(project, top[5]) >= 0) return;
  let position = 0;
  while (position < top.length && compare(top[position], project) <= 0)
    position++;
  top.splice(position, 0, retain ? retain(project) : project);
  if (top.length > 6) top.pop();
}

function catalogLeader(project) {
  // A reused chunk needs only rank and map metadata. Do not pin a retired
  // project's financial evidence or history through this structural summary.
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    category: project.category,
    entityType: project.entityType,
    chains: project.chains,
    deployments: project.deployments,
  };
}

function sameCatalogStructure(before, current) {
  return (
    before === current ||
    (before &&
      current &&
      before.id === current.id &&
      before.name === current.name &&
      before.description === current.description &&
      before.category === current.category &&
      before.entityType === current.entityType &&
      before.chains === current.chains &&
      before.deployments === current.deployments &&
      Object.is(
        scopedPoolCount(before, "all"),
        scopedPoolCount(current, "all"),
      ))
  );
}

/** Published rows and nested metadata are immutable. Price publications replace
 * measured families without changing that metadata. Check every used field
 * before reusing a chunk, never financial ordering or old page rows. At most
 * two weak prior catalogs are consulted; retired arrays are not kept alive. */
function* catalogStructureSteps(projects) {
  const existing = catalogStructures.get(projects);
  if (existing) return existing;
  const previous = recentCatalogs
    .map((reference) => reference.deref())
    .filter(Boolean)
    .map((rows) => catalogStructures.get(rows))
    .filter(Boolean);
  const compare = directoryComparator("deployments", "desc", "h24");
  const chunks = [];
  const chains = new Set();
  const counts = new Map(categories.map((name) => [name, 0]));
  const groups = new Map(
    categories.map((name) => [name, { total: 0, projects: [] }]),
  );
  let poolCount = 0;
  let exactCount = true;
  for (let begin = 0; begin < projects.length; begin += STRUCTURE_CHUNK_SIZE) {
    const end = Math.min(projects.length, begin + STRUCTURE_CHUNK_SIZE);
    let chunk;
    for (const prior of previous) {
      const candidate = prior.chunks[begin / STRUCTURE_CHUNK_SIZE];
      if (!candidate || candidate.end !== end) continue;
      let same = true;
      for (let index = begin; index < end; index++)
        if (!sameCatalogStructure(prior.projects[index], projects[index])) {
          same = false;
          break;
        }
      if (same) {
        chunk = candidate;
        break;
      }
    }
    if (!chunk) {
      chunk = {
        end,
        chains: new Set(),
        counts: new Map(categories.map((name) => [name, 0])),
        groups: new Map(categories.map((name) => [name, []])),
        poolCount: 0,
        exactCount: true,
      };
      for (let index = begin; index < end; index++) {
        const project = projects[index];
        chunk.counts.set(
          project.category,
          chunk.counts.get(project.category) + 1,
        );
        for (const deployment of project.deployments)
          chunk.chains.add(deployment.chain);
        if (project.entityType === "platform")
          for (const chain of project.chains) chunk.chains.add(chain);
        const amount = scopedPoolCount(project, "all") || 0;
        chunk.poolCount += amount;
        chunk.exactCount &&=
          Number.isSafeInteger(amount) && Number.isSafeInteger(chunk.poolCount);
        keepTopSix(
          chunk.groups.get(project.category),
          project,
          compare,
          catalogLeader,
        );
      }
    }
    chunks.push(chunk);
    poolCount += chunk.poolCount;
    exactCount &&= chunk.exactCount && Number.isSafeInteger(poolCount);
    for (const chain of chunk.chains) chains.add(chain);
    for (const name of categories) {
      const count = chunk.counts.get(name);
      counts.set(name, counts.get(name) + count);
      const group = groups.get(name);
      group.total += count;
      for (const project of chunk.groups.get(name))
        keepTopSix(group.projects, project, compare);
    }
    yield;
  }
  // Real census counts are integers. Preserve the original summation order for
  // unusual imported values instead of changing floating-point rounding.
  if (!exactCount) {
    poolCount = 0;
    let work = 0;
    for (const project of projects) {
      poolCount += scopedPoolCount(project, "all") || 0;
      if (++work % STRUCTURE_CHUNK_SIZE === 0) yield;
    }
  }
  // Identical chunks prove the complete ordered identity sequence as well as
  // every map-ranking field. Reuse only bounded positions, never prior family
  // objects: current metadata still decides artwork, including last-ID wins.
  const sameStructure = previous.find(
    (prior) =>
      prior.projects.length === projects.length &&
      prior.chunks.length === chunks.length &&
      chunks.every((chunk, index) => chunk === prior.chunks[index]),
  );
  const value = {
    projects,
    chunks,
    chains,
    counts,
    groups,
    poolCount,
    artworkPositions: sameStructure?.artworkPositions,
  };
  catalogStructures.set(projects, value);
  recentCatalogs.unshift(new WeakRef(projects));
  recentCatalogs.length = Math.min(recentCatalogs.length, 2);
  return value;
}

function* selectionSteps(snapshot, cached, options) {
  const { search, chain, category, property, market, ids, saved } = options;
  const key = selectionKey(options);
  const prior = cached.selections.get(key);
  if (prior) return prior;
  const savedLookup = saved
    ? yield* projectLookupSteps(cached.projectIndex, ids)
    : null;
  const candidates = saved
    ? ids.map((id) => savedLookup.get(id)).filter(Boolean)
    : cached.projects;
  const candidatePools = saved
    ? ids.flatMap((id) => cached.poolsByProject.get(id) || [])
    : snapshot.pools;
  // Prepare the scoped market lookup once for the entire selection. Rebuilding
  // it inside each project chunk multiplies work by the directory's size.
  const poolScope =
    chain !== "all" || market === "observed" || market === "active"
      ? yield* projectPoolScopeSteps(candidatePools, chain)
      : undefined;
  const unrestricted =
    !search &&
    chain === "all" &&
    category === "all" &&
    property === "all" &&
    market === "all" &&
    !saved;
  const matches = unrestricted ? candidates : [];
  const idsInScope = unrestricted ? null : new Set();
  let chainsInScope = new Set();
  let poolCount = snapshot.inventory ? 0 : null;
  let landscapeCounts = new Map(categories.map((name) => [name, 0]));
  let groups = new Map(
    categories.map((name) => [name, { total: 0, projects: [] }]),
  );
  const mapCompare = directoryComparator("deployments", "desc", "h24");
  let structure;
  if (unrestricted) {
    structure = yield* catalogStructureSteps(candidates);
    chainsInScope = structure.chains;
    landscapeCounts = structure.counts;
    groups = structure.groups;
    poolCount = snapshot.inventory ? structure.poolCount : null;
  } else
    for (let offset = 0; offset < candidates.length; offset += 1024) {
      const scoped = selectProjects(
        candidates.slice(offset, offset + 1024),
        candidatePools,
        {
          search,
          chain,
          category: "all",
          property,
          market,
        },
        poolScope,
        poolScope?.evaluatedAt ?? Date.now(),
        options.window,
      );
      for (const project of scoped) {
        landscapeCounts.set(
          project.category,
          landscapeCounts.get(project.category) + 1,
        );
        if (category !== "all" && project.category !== category) continue;
        matches.push(project);
        idsInScope.add(project.id);
        for (const deployment of project.deployments)
          chainsInScope.add(deployment.chain);
        if (project.entityType === "platform")
          for (const chain of project.chains) chainsInScope.add(chain);
        if (poolCount !== null) {
          const amount = scopedPoolCount(project, chain);
          poolCount += amount || 0;
        }
        const group = groups.get(project.category);
        group.total++;
        keepTopSix(group.projects, project, mapCompare);
      }
      yield;
    }
  const narrowed = Boolean(
    search ||
    chain !== "all" ||
    category !== "all" ||
    property !== "all" ||
    market !== "all" ||
    saved,
  );
  const poolIds = [];
  let operations = 0;
  for (const pool of snapshot.pools) {
    if (
      (chain === "all" || pool.chain === chain) &&
      (!narrowed || (pool.projectId !== null && idsInScope.has(pool.projectId)))
    )
      poolIds.push(pool.id);
    if (++operations % 1024 === 0) yield;
  }
  const eventIds = [];
  const events = [];
  for (const event of snapshot.events) {
    if (
      (chain === "all" || event.chain === chain) &&
      (!narrowed ||
        (event.projectId !== null && idsInScope.has(event.projectId)))
    ) {
      eventIds.push(event.id);
      events.push(event);
    }
    if (++operations % 1024 === 0) yield;
  }
  const chains = [...chainsInScope].sort();
  let fullFamilies = savedLookup;
  if (!fullFamilies && structure?.artworkPositions)
    fullFamilies = new Map(
      [...structure.artworkPositions].map(([id, position]) => [
        id,
        candidates[position],
      ]),
    );
  if (!fullFamilies) {
    const positions = structure ? new Map() : undefined;
    fullFamilies = yield* projectLookupSteps(
      cached.projectIndex,
      [...groups.values()].flatMap((group) =>
        group.projects.map((project) => project.id),
      ),
      positions,
    );
    if (structure) structure.artworkPositions = positions;
  }
  const value = {
    matches,
    // Send the scoped records from this generation. Joining these IDs against
    // a separately refreshed dashboard can hide real updates during churn.
    scope: { poolCount, chains, poolIds, eventIds, events },
    landscape: categories.map((name) => ({
      category: name,
      total: landscapeCounts.get(name),
    })),
    map: categories
      .map((name) => {
        const group = groups.get(name);
        return {
          category: name,
          total: group.total,
          projects: group.projects.map((project) => ({
            id: project.id,
            name: project.name,
            description: project.description,
            category: project.category,
            chains: project.chains,
            deploymentCount: project.deployments.length,
            // Artwork is checked against the whole verified directory family;
            // a network filter must not brand an otherwise mixed family.
            artwork: getProtocolArtwork(fullFamilies.get(project.id)),
            fingerprint: project.deployments.length
              ? {
                  address: project.deployments[0].address,
                  chain: project.deployments[0].chain,
                }
              : null,
          })),
        };
      })
      .filter((group) => group.total > 0),
    missingIds: saved ? ids.filter((id) => !savedLookup.has(id)) : [],
    orders: new Map(),
    orderFlights: new Map(),
    prefixes: new Map(),
    prefixFlights: new Map(),
  };
  return (
    cached.selections.get(key) || boundedCache(cached.selections, key, value, 4)
  );
}

function orderKey(options) {
  return JSON.stringify([options.sort, options.direction, options.window]);
}
function* orderedProjectSteps(selected, options) {
  const key = orderKey(options);
  let ordered = selected.orders.get(key);
  if (!ordered) {
    const values = [];
    for (let index = 0; index < selected.matches.length; index++) {
      values.push(selected.matches[index]);
      if ((index + 1) % 1024 === 0) yield;
    }
    ordered = yield* cooperativeSortSteps(
      values,
      directoryComparator(
        options.sort,
        options.direction,
        options.window,
        options.chain,
      ),
    );
    ordered =
      selected.orders.get(key) ||
      boundedCache(selected.orders, key, ordered, 4);
  }
  return ordered;
}

const PAGE_PREFIX_LIMIT = 1000;
function pagePrefixLength(selected, options) {
  const total = selected.matches.length;
  const last = total
    ? Math.floor((total - 1) / options.limit) * options.limit
    : 0;
  const offset = options.offset >= total ? last : options.offset;
  return Math.min(total, offset + options.limit);
}

/** A first page needs an exact ordered prefix, not a sort of every family.
 * Keep the worst retained row at the heap root, then sort only the prefix.
 * Distant pages and exports continue to use the complete cooperative order. */
function* orderedPrefixSteps(selected, options, length) {
  const key = orderKey(options);
  const complete = selected.orders.get(key);
  if (complete) return complete;
  const previous = selected.prefixes.get(key);
  if (previous?.length >= length) return previous;
  const compare = directoryComparator(
    options.sort,
    options.direction,
    options.window,
    options.chain,
  );
  const heap = [];
  let work = 0;
  for (const project of selected.matches) {
    if (++work % 512 === 0) yield;
    if (heap.length < length) {
      let position = heap.length;
      heap.push(project);
      while (position) {
        const parent = (position - 1) >>> 1;
        if (compare(heap[parent], project) >= 0) break;
        heap[position] = heap[parent];
        position = parent;
      }
      heap[position] = project;
    } else if (length && compare(project, heap[0]) < 0) {
      let position = 0;
      while (position * 2 + 1 < heap.length) {
        let child = position * 2 + 1;
        if (
          child + 1 < heap.length &&
          compare(heap[child], heap[child + 1]) < 0
        )
          child++;
        if (compare(project, heap[child]) >= 0) break;
        heap[position] = heap[child];
        position = child;
      }
      heap[position] = project;
    }
  }
  const ordered = yield* cooperativeSortSteps(heap, compare);
  const published = selected.prefixes.get(key);
  return published?.length >= length
    ? published
    : boundedCache(selected.prefixes, key, ordered, 4);
}

/** Full matching projects for streamed exports; pagination never truncates this array. */
export function selectDirectory(snapshot, input = {}) {
  snapshot = refreshMarketSnapshot(snapshot);
  const options = validatedOptions(input);
  const cached = runSynchronously(indexSteps(snapshot));
  return runSynchronously(
    orderedProjectSteps(
      runSynchronously(selectionSteps(snapshot, cached, options)),
      options,
    ),
  );
}

/** Paginate the complete server directory without sending its entire inventory. */
export function directoryPage(snapshot, input = {}) {
  snapshot = refreshMarketSnapshot(snapshot);
  const options = validatedOptions(input);
  const cached = runSynchronously(indexSteps(snapshot));
  const pageKey = JSON.stringify(options);
  const existing = cached.pages.get(pageKey);
  if (existing) return existing;
  const selected = runSynchronously(selectionSteps(snapshot, cached, options));
  const ordered = runSynchronously(orderedProjectSteps(selected, options));
  return makePage(cached, selected, ordered, options, pageKey);
}

function makePage(cached, selected, ordered, options, pageKey) {
  const existing = cached.pages.get(pageKey);
  if (existing) return existing;
  const total = selected.matches.length;
  const lastPage = total
    ? Math.floor((total - 1) / options.limit) * options.limit
    : 0;
  const offset = options.offset >= total ? lastPage : options.offset;
  const projects = ordered.slice(offset, offset + options.limit);
  return boundedCache(
    cached.pages,
    pageKey,
    {
      projects,
      total,
      offset,
      nextOffset:
        offset + projects.length < total ? offset + projects.length : null,
      scope: selected.scope,
      map: selected.map,
      landscape: selected.landscape,
      missingIds: selected.missingIds,
    },
    16,
  );
}

function waitForResult(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", aborted))
      .catch(() => {});
  });
}

// A disconnected caller stops waiting; a shared complete cache build still
// serves other readers. Waiting requests do not start work after cancellation.
function sharedFlight(flights, key, maximum, operation, signal) {
  const reserve = async () => {
    signal?.throwIfAborted();
    let existing = flights.get(key);
    if (existing) return existing;
    while (flights.size >= maximum) {
      await waitForResult(
        Promise.race(
          [...flights.values()].map((flight) => flight.catch(() => {})),
        ),
        signal,
      );
      signal?.throwIfAborted();
      existing = flights.get(key);
      if (existing) return existing;
    }
    const pending = Promise.resolve().then(operation);
    flights.set(key, pending);
    pending
      .finally(() => {
        if (flights.get(key) === pending) flights.delete(key);
      })
      .catch(() => {});
    return pending;
  };
  return waitForResult(reserve(), signal);
}

async function indexAsync(snapshot, runtime) {
  const existing = snapshots.get(snapshot);
  if (existing) return existing;
  let flights = indexFlights.get(snapshot);
  if (!flights) {
    flights = new Map();
    indexFlights.set(snapshot, flights);
  }
  return sharedFlight(
    flights,
    "index",
    1,
    () => runDirectoryWork(indexSteps(snapshot), runtime, "index"),
    runtime.signal,
  );
}

async function selectionAsync(snapshot, cached, options, runtime) {
  const key = selectionKey(options);
  const existing = cached.selections.get(key);
  if (existing) return existing;
  return sharedFlight(
    cached.selectionFlights,
    key,
    4,
    () =>
      runDirectoryWork(
        selectionSteps(snapshot, cached, options),
        runtime,
        "selection",
      ),
    runtime.signal,
  );
}

async function orderedProjectsAsync(selected, options, runtime) {
  const key = orderKey(options);
  const existing = selected.orders.get(key);
  if (existing) return existing;
  return sharedFlight(
    selected.orderFlights,
    key,
    4,
    () =>
      runDirectoryWork(
        orderedProjectSteps(selected, options),
        runtime,
        "ordering",
      ),
    runtime.signal,
  );
}

async function pageProjectsAsync(selected, options, runtime) {
  const length = pagePrefixLength(selected, options);
  if (length > PAGE_PREFIX_LIMIT)
    return orderedProjectsAsync(selected, options, runtime);
  const key = orderKey(options);
  for (;;) {
    const complete = selected.orders.get(key);
    if (complete) return complete;
    const prefix = selected.prefixes.get(key);
    if (prefix?.length >= length) return prefix;
    const result = await sharedFlight(
      selected.prefixFlights,
      key,
      4,
      () =>
        runDirectoryWork(
          orderedPrefixSteps(selected, options, length),
          runtime,
          "ordering",
        ),
      runtime.signal,
    );
    if (result.length >= length) return result;
  }
}

/** Full matching export rows, assembled without blocking unrelated requests. */
export async function selectDirectoryAsync(snapshot, input = {}, runtime = {}) {
  snapshot = await refreshSnapshotAsync(snapshot, runtime);
  runtime.signal?.throwIfAborted();
  const options = validatedOptions(input);
  const cached = await indexAsync(snapshot, runtime);
  const selected = await selectionAsync(snapshot, cached, options, runtime);
  runtime.signal?.throwIfAborted();
  return orderedProjectsAsync(selected, options, runtime);
}

/** Complete directory page; identical concurrent readers share private work. */
export async function directoryPageAsync(snapshot, input = {}, runtime = {}) {
  let began = performance.now();
  snapshot = await refreshSnapshotAsync(snapshot, runtime);
  if (runtime.timings) runtime.timings.freshness = performance.now() - began;
  runtime.signal?.throwIfAborted();
  const options = validatedOptions(input);
  began = performance.now();
  const cached = await indexAsync(snapshot, runtime);
  if (runtime.timings) runtime.timings.index = performance.now() - began;
  const pageKey = JSON.stringify(options);
  const existing = cached.pages.get(pageKey);
  if (existing) return existing;
  return sharedFlight(
    cached.pageFlights,
    pageKey,
    16,
    async () => {
      const selectedAt = performance.now();
      const selected = await selectionAsync(snapshot, cached, options, {
        budgetMs: runtime.budgetMs,
        priority: runtime.priority,
        timings: runtime.timings,
      });
      if (runtime.timings)
        runtime.timings.selection = performance.now() - selectedAt;
      const orderedAt = performance.now();
      const ordered = await pageProjectsAsync(selected, options, {
        budgetMs: runtime.budgetMs,
        priority: runtime.priority,
        timings: runtime.timings,
      });
      if (runtime.timings)
        runtime.timings.ordering = performance.now() - orderedAt;
      return makePage(cached, selected, ordered, options, pageKey);
    },
    runtime.signal,
  );
}
