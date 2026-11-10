import {
  CHAINS_URL,
  FRONTIER_URL,
  REGISTRY_URL,
  validateChains,
  validateFrontier,
  validateRegistry,
} from "../server/model.mjs";
import { MAX_BYTES, PROVIDERS } from "./config.mjs";

// The three public documents the directory is built from. Each is fetched once
// per run; when a fetch fails the last good copy from state/registry.json is
// used and reported as cached, with its own original time.
export const REGISTRY_SOURCES = Object.freeze([
  {
    key: "registry",
    id: "registry",
    provider: "registry",
    name: "Uniswap hook registry",
    url: REGISTRY_URL,
    validate: validateRegistry,
    keep: slimHooklist,
    maxBytes: MAX_BYTES.registry,
    required: true,
  },
  {
    key: "chains",
    id: "chains",
    provider: "registry",
    name: "Uniswap chain registry",
    url: CHAINS_URL,
    validate: validateChains,
    maxBytes: MAX_BYTES.registry,
    required: true,
  },
  {
    key: "frontier",
    id: "frontier-chains",
    provider: "frontier",
    name: "Frontier deployment configuration",
    url: FRONTIER_URL,
    validate: validateFrontier,
    maxBytes: MAX_BYTES.frontier,
    required: false,
  },
]);

const pick = (row, keys) =>
  Object.fromEntries(
    keys.filter((key) => key in row).map((key) => [key, row[key]]),
  );

/** The hooklist rows keep what the directory is built from. Their decoded flags
 * are recomputed from each address, so they are not stored again. */
export function slimHooklist(rows) {
  return rows.map((row) => ({
    hook: pick(row.hook, [
      "address",
      "chain",
      "chainId",
      "name",
      "description",
      "verifiedSource",
      "auditUrl",
    ]),
    ...(row.properties
      ? {
          properties: pick(row.properties, [
            "dynamicFee",
            "upgradeable",
            "requiresCustomSwapData",
            "vanillaSwap",
            "swapAccess",
          ]),
        }
      : {}),
  }));
}

const rowCount = (data) =>
  Array.isArray(data) ? data.length : Object.keys(data ?? {}).length;

/** @returns {{ data: object, sources: object[], fetched: object, changed: boolean }}
 *
 * An answer that passes its validator but has fewer than half the rows of the
 * saved copy (an empty Frontier list, a hooklist cut to a handful of rows) is
 * not used: it is treated like a failed request, so the last good copy stays in
 * use and in `state/registry.json`. If a source has really shrunk by that much,
 * remove its entry from `state/registry.json` to accept the smaller answer. */
export async function loadRegistry({ client, saved = null }) {
  const data = {};
  const sources = [];
  const fetched = {};
  let changed = false;
  for (const source of REGISTRY_SOURCES) {
    const copy = saved?.sources?.[source.key] ?? null;
    let reusable = null;
    try {
      reusable = copy ? source.validate(copy.data) : null;
    } catch {
      reusable = null;
    }
    let live = null;
    let failure = null;
    try {
      const result = await client.getJson(source.provider, source.url, {
        maxBytes: source.maxBytes,
      });
      const checked = source.validate(result.data);
      if (reusable && rowCount(checked) < rowCount(reusable) / 2)
        failure = `answer had too few rows: ${rowCount(checked)} against ${rowCount(reusable)} in the saved copy`;
      else
        live = {
          data: source.keep ? source.keep(checked) : checked,
          observedAt: new Date(result.observedAt).toISOString(),
        };
    } catch (error) {
      failure = `request failed (${error?.code ? `${error.code}` : "invalid"})`;
    }
    if (live) {
      data[source.key] = live.data;
      fetched[source.key] = {
        url: source.url,
        fetchedAt: live.observedAt,
        data: live.data,
      };
      changed ||= JSON.stringify(copy?.data) !== JSON.stringify(live.data);
      sources.push({
        id: source.id,
        name: source.name,
        url: PROVIDERS[source.provider].url,
        status: "live",
        updatedAt: live.observedAt,
        note: `Fetched at the start of this snapshot run from ${source.url}.`,
      });
      continue;
    }
    if (reusable) {
      data[source.key] = reusable;
      fetched[source.key] = copy;
      sources.push({
        id: source.id,
        name: source.name,
        url: PROVIDERS[source.provider].url,
        status: "cached",
        updatedAt: copy.fetchedAt,
        note: `This run's ${failure}; the last good copy, fetched at its own time shown here, is used.`,
      });
      continue;
    }
    if (source.required)
      throw new Error(
        `${source.name} is unavailable and no saved copy exists.`,
      );
    data[source.key] = [];
    sources.push({
      id: source.id,
      name: source.name,
      url: PROVIDERS[source.provider].url,
      status: "unavailable",
      updatedAt: null,
      note: `This run's ${failure} and no saved copy exists. Projects that depend on it are not attributed by it.`,
    });
  }
  return { data, sources, fetched, changed };
}
