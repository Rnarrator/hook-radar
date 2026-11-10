import type {
  Chain,
  HookDeployment,
  PoolIndexCoverage,
  SourceStatus,
} from "../shared/types";
import { isMarketFreshness } from "../shared/market-freshness.ts";
import { isPublishedPlatformProject } from "../shared/published-platform-hooks.ts";
import {
  STATIC_EDITION,
  categories,
  futureSkewLimit,
  safeUrl,
} from "./model.ts";
import { protocolArtwork } from "./protocol-logos.ts";
import {
  DISCOVERY_PROFILE,
  discoveryQueryKey,
  type DiscoveryEnvelope,
  type DiscoveryPage,
  type DiscoveryProject,
  type DiscoveryQuery,
} from "../shared/discovery.ts";

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const text = (v: unknown, limit = 4000): v is string =>
  typeof v === "string" && v.length <= limit;
const slug = (v: unknown): v is string =>
  text(v, 100) && /^[a-z0-9][a-z0-9-]{0,99}$/.test(v);
const strings = (v: unknown, limit = 100): v is string[] =>
  Array.isArray(v) && v.length <= limit && v.every((s) => text(s, 200));
const date = (v: unknown): v is string =>
  text(v, 40) &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  Date.parse(v) >= 0;
const optionalDate = (v: unknown) => v === null || date(v);
const optionalText = (v: unknown, limit = 4000) => v === null || text(v, limit);
const metric = (v: unknown) =>
  v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0);
const address = (v: unknown) => text(v, 42) && /^0x[0-9a-f]{40}$/i.test(v);
const exactKeys = (v: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(v).every((key) => allowed.includes(key));

export function isDiscoveryQuery(value: unknown): value is DiscoveryQuery {
  if (
    !object(value) ||
    !exactKeys(value, [
      "search",
      "chain",
      "category",
      "property",
      "market",
      "sort",
      "direction",
      "window",
      "offset",
      "limit",
      "saved",
      "ids",
    ]) ||
    !text(value.search, 300) ||
    /[\u0000-\u001f\u007f-\u009f]/.test(value.search) ||
    value.search !== value.search.trim().toLowerCase() ||
    !slug(value.chain) ||
    !["all", ...categories].includes(value.category as never) ||
    !["all", "dynamic", "verified", "upgradeable", "custom"].includes(
      String(value.property),
    ) ||
    !["projects", "all", "observed", "active"].includes(String(value.market)) ||
    !["name", "deployments", "volume", "liquidity", "pools"].includes(
      String(value.sort),
    ) ||
    !["asc", "desc"].includes(String(value.direction)) ||
    !["h1", "h6", "h24"].includes(String(value.window)) ||
    !count(value.offset) ||
    !count(value.limit) ||
    value.limit < 1 ||
    value.limit > 100 ||
    typeof value.saved !== "boolean" ||
    !Array.isArray(value.ids) ||
    value.ids.length > 2000 ||
    !value.ids.every(slug) ||
    new Set(value.ids).size !== value.ids.length ||
    (!value.saved && value.ids.length !== 0)
  )
    return false;
  const ids = value.ids as string[];
  return ids.every((id, i) => i === 0 || ids[i - 1] < id);
}

/** Same normalization as the existing bounded GET/POST directory contract. */
export function discoveryQueryFromParams(
  params: URLSearchParams,
): DiscoveryQuery | null {
  if (!(params instanceof URLSearchParams)) return null;
  const defaults: DiscoveryQuery = {
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
    ids: [],
  };
  const value: Record<string, unknown> = { ...defaults };
  for (const key of new Set(params.keys())) {
    if (key === "id") {
      if (params.getAll(key).length > 2000) return null;
      value.ids = [...new Set(params.getAll(key))].sort();
      value.saved = true;
      continue;
    }
    if (
      key === "ids" ||
      !Object.hasOwn(defaults, key) ||
      params.getAll(key).length !== 1
    )
      return null;
    const item = params.get(key)!;
    if (key === "offset" || key === "limit") {
      if (!/^\d+$/.test(item)) return null;
      value[key] = Number(item);
    } else if (key === "saved") {
      if (item !== "1") return null;
      value.saved = true;
    } else value[key] = item;
  }
  // Reject raw overlong/control-containing searches before normalization,
  // matching parseDirectoryParams rather than making invalid input disappear.
  if (
    !text(value.search, 300) ||
    /[\u0000-\u001f\u007f-\u009f]/.test(value.search)
  )
    return null;
  value.search = value.search.trim().toLowerCase();
  return isDiscoveryQuery(value) ? value : null;
}

function deployment(v: unknown): v is HookDeployment {
  return (
    object(v) &&
    ["id", "name", "description", "sourceUrl", "explorerUrl"].every((k) =>
      text(v[k]),
    ) &&
    address(v.address) &&
    slug(v.chain) &&
    count(v.chainId) &&
    v.chainId > 0 &&
    typeof v.verifiedSource === "boolean" &&
    object(v.flags) &&
    Object.keys(v.flags).length <= 32 &&
    Object.values(v.flags).every((flag) => typeof flag === "boolean") &&
    object(v.properties) &&
    [
      "dynamicFee",
      "upgradeable",
      "requiresCustomSwapData",
      "vanillaSwap",
    ].every(
      (k) => typeof (v.properties as Record<string, unknown>)[k] === "boolean",
    ) &&
    text(v.properties.swapAccess, 100) &&
    optionalText(v.auditUrl) &&
    (v.discovery === undefined ||
      ["onchain", "published"].includes(String(v.discovery)))
  );
}

/** Validate an actual directory row; never manufacture a RadarSnapshot shell. */
export function isDiscoveryProject(v: unknown): v is DiscoveryProject {
  if (
    !object(v) ||
    (v.entityType !== undefined && !isPublishedPlatformProject(v)) ||
    !slug(v.id) ||
    !text(v.name, 400) ||
    !text(v.description) ||
    !text(v.sourceUrl) ||
    !categories.includes(v.category as never) ||
    !optionalText(v.website) ||
    !optionalText(v.docs) ||
    !strings(v.chains) ||
    !v.chains.every(slug) ||
    !Array.isArray(v.deployments) ||
    !v.deployments.every(deployment) ||
    Object.hasOwn(v, "history") ||
    !count(v.historyPointCount) ||
    !object(v.metrics) ||
    !metric(v.metrics.poolCount) ||
    !metric(v.metrics.liquidityUsd) ||
    !object(v.metrics.volumeUsd) ||
    !["h1", "h6", "h24"].every((k) =>
      metric(
        (v.metrics as Record<string, Record<string, unknown>>).volumeUsd[k],
      ),
    ) ||
    !["measured", "partial", "unavailable"].includes(
      String(v.metrics.coverage),
    ) ||
    !text(v.metrics.note) ||
    (v.metrics.freshness !== undefined &&
      !isMarketFreshness(v.metrics.freshness))
  )
    return false;
  const inventory = v.poolInventory;
  return (
    inventory === undefined ||
    (object(inventory) &&
      count(inventory.poolCount) &&
      typeof inventory.complete === "boolean" &&
      object(inventory.chains) &&
      Object.keys(inventory.chains).every(slug) &&
      Object.values(inventory.chains).every(count) &&
      (inventory.replacementToken === undefined ||
        (text(inventory.replacementToken, 64) &&
          /^[a-f0-9]{64}$/.test(inventory.replacementToken))))
  );
}

export function chain(v: unknown): v is Chain {
  return (
    object(v) &&
    count(v.id) &&
    v.id > 0 &&
    slug(v.slug) &&
    text(v.name, 200) &&
    v.name.trim().length > 0 &&
    text(v.explorer, 2048) &&
    !!safeUrl(v.explorer)
  );
}
function source(v: unknown): v is SourceStatus {
  return (
    object(v) &&
    text(v.id, 200) &&
    text(v.name, 400) &&
    text(v.url) &&
    text(v.note) &&
    optionalDate(v.updatedAt) &&
    ["live", "cached", "unavailable"].includes(String(v.status))
  );
}
/** The census block of a publication. A head check is judged against the time
 * of the publication that carries it (its own generatedAt when none is given)
 * in the static edition, and against the viewer's clock on the live service. */
export function inventory(
  v: unknown,
  publishedAt?: unknown,
  edition: boolean = STATIC_EDITION,
): v is PoolIndexCoverage {
  const headCheckLimit = futureSkewLimit(
    publishedAt ?? (object(v) ? v.generatedAt : undefined),
    edition,
  );
  return (
    object(v) &&
    date(v.generatedAt) &&
    typeof v.running === "boolean" &&
    [v.poolCount, v.hookPoolCount, v.hookCount].every(count) &&
    Array.isArray(v.networks) &&
    v.networks.length <= 100 &&
    v.networks.every(
      (n) =>
        object(n) &&
        slug(n.chain) &&
        count(n.chainId) &&
        n.chainId > 0 &&
        text(n.name, 200) &&
        address(n.manager) &&
        count(n.startBlock) &&
        Number.isSafeInteger(n.scannedToBlock) &&
        Number(n.scannedToBlock) >= -1 &&
        (n.targetBlock === null || count(n.targetBlock)) &&
        ["queued", "scanning", "complete", "unavailable", "error"].includes(
          String(n.status),
        ) &&
        [n.poolCount, n.hookPoolCount, n.hookCount].every(count) &&
        optionalText(n.dataset) &&
        optionalDate(n.updatedAt) &&
        (n.headCheckedAt === undefined ||
          n.headCheckedAt === null ||
          (date(n.headCheckedAt) &&
            Date.parse(n.headCheckedAt) <= headCheckLimit)) &&
        optionalText(n.lastError) &&
        (n.cacheWarning === undefined || optionalText(n.cacheWarning)) &&
        (n.finality === undefined ||
          ["finalized", "confirmed"].includes(String(n.finality))),
    ) &&
    new Set(v.networks.map((n) => n.chain)).size === v.networks.length
  );
}
function event(v: unknown): boolean {
  return (
    object(v) &&
    text(v.id, 200) &&
    v.id.length > 0 &&
    ["new-project", "new-deployment", "metadata-change", "activity"].includes(
      String(v.type),
    ) &&
    text(v.title, 400) &&
    text(v.description) &&
    date(v.timestamp) &&
    (v.projectId === null || slug(v.projectId)) &&
    (v.chain === null || slug(v.chain)) &&
    (v.url === null || (text(v.url) && !!safeUrl(v.url)))
  );
}
function groups(v: unknown, map: boolean): boolean {
  return (
    Array.isArray(v) &&
    v.length <= categories.length &&
    new Set(v.map((g) => g?.category)).size === v.length &&
    v.every(
      (g) =>
        object(g) &&
        categories.includes(g.category as never) &&
        count(g.total) &&
        (!map ||
          (Array.isArray(g.projects) &&
            g.projects.length <= 6 &&
            g.projects.length <= g.total &&
            g.projects.every(
              (p) =>
                object(p) &&
                slug(p.id) &&
                text(p.name, 400) &&
                text(p.description) &&
                categories.includes(p.category as never) &&
                strings(p.chains) &&
                p.chains.every(slug) &&
                count(p.deploymentCount) &&
                p.deploymentCount > 0 &&
                (p.artwork === null ||
                  (object(p.artwork) &&
                    Object.values(protocolArtwork).some(
                      (art) =>
                        art.protocol ===
                          (p.artwork as Record<string, unknown>).protocol &&
                        art.src === (p.artwork as Record<string, unknown>).src,
                    ))) &&
                (p.fingerprint === null ||
                  (object(p.fingerprint) &&
                    address(p.fingerprint.address) &&
                    slug(p.fingerprint.chain))),
            ))),
    )
  );
}

export function isDiscoveryPage(
  value: unknown,
  request: DiscoveryQuery,
): value is DiscoveryPage {
  if (
    !object(value) ||
    !count(value.total) ||
    !count(value.offset) ||
    value.offset > value.total ||
    !Array.isArray(value.projects) ||
    value.projects.length > request.limit ||
    !value.projects.every(isDiscoveryProject) ||
    (value.total > 0 && value.projects.length === 0) ||
    value.projects.length > value.total - value.offset ||
    !(
      value.nextOffset === null ||
      (count(value.nextOffset) &&
        value.nextOffset === value.offset + value.projects.length &&
        value.nextOffset < value.total)
    ) ||
    (value.nextOffset === null &&
      value.offset + value.projects.length < value.total) ||
    new Set(value.projects.map((p) => p.id)).size !== value.projects.length ||
    !strings(value.missingIds, 2000) ||
    value.missingIds.some((id) => !request.ids.includes(id)) ||
    new Set(value.missingIds).size !== value.missingIds.length ||
    !object(value.scope) ||
    Object.hasOwn(value.scope, "poolIds") ||
    !(value.scope.poolCount === null || count(value.scope.poolCount)) ||
    !strings(value.scope.chains) ||
    !value.scope.chains.every(slug) ||
    !strings(value.scope.eventIds, 100) ||
    !Array.isArray(value.scope.events) ||
    value.scope.events.length > 100 ||
    !value.scope.events.every(event) ||
    value.scope.events.length !== value.scope.eventIds.length ||
    !value.scope.events.every(
      (e, i) =>
        (e as Record<string, unknown>).id ===
        (value.scope as Record<string, unknown[]>).eventIds[i],
    ) ||
    new Set(value.scope.eventIds).size !== value.scope.eventIds.length ||
    !groups(value.map, true) ||
    !groups(value.landscape, false)
  )
    return false;
  // The existing directory clamps a vanished page to its final populated page.
  const expectedOffset =
    request.offset >= value.total
      ? value.total
        ? Math.floor((value.total - 1) / request.limit) * request.limit
        : 0
      : request.offset;
  return (
    value.offset === expectedOffset &&
    !value.projects.some((p) => (value.missingIds as string[]).includes(p.id))
  );
}

export function isDiscoveryEnvelope(
  value: unknown,
  expected?: DiscoveryQuery,
): value is DiscoveryEnvelope {
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    value.ready !== true ||
    !exactKeys(value, [
      "schemaVersion",
      "presentation",
      "ready",
      "publication",
      "request",
      "chains",
      "sources",
      "inventory",
      "page",
    ]) ||
    !object(value.presentation) ||
    !exactKeys(value.presentation, Object.keys(DISCOVERY_PROFILE)) ||
    !Object.entries(DISCOVERY_PROFILE).every(
      ([key, item]) =>
        (value.presentation as Record<string, unknown>)[key] === item,
    ) ||
    !object(value.publication) ||
    !exactKeys(value.publication, ["id", "generatedAt", "status"]) ||
    !text(value.publication.id, 100) ||
    !/^[a-f0-9]{32}:[1-9]\d{0,14}$/.test(value.publication.id) ||
    !date(value.publication.generatedAt) ||
    !["live", "partial", "cached", "offline"].includes(
      String(value.publication.status),
    ) ||
    !isDiscoveryQuery(value.request) ||
    (expected !== undefined &&
      (!isDiscoveryQuery(expected) ||
        discoveryQueryKey(value.request) !== discoveryQueryKey(expected))) ||
    !Array.isArray(value.chains) ||
    value.chains.length > 100 ||
    !value.chains.every(chain) ||
    new Set(value.chains.map((c) => c.id)).size !== value.chains.length ||
    new Set(value.chains.map((c) => c.slug)).size !== value.chains.length ||
    !Array.isArray(value.sources) ||
    value.sources.length > 256 ||
    !value.sources.every(source) ||
    (value.inventory !== undefined &&
      !inventory(value.inventory, value.publication.generatedAt))
  )
    return false;
  return isDiscoveryPage(value.page, value.request);
}
