import { categories } from "./model.ts";
import { DAILY_SPAN_KEYS } from "../shared/daily-volume.ts";
import type { DailySpan } from "../shared/daily-volume.ts";
import { STATIC_EDITION } from "./edition.ts";
import type { Filters, PropertyFilter, SortKey, View } from "./model";
import type { WindowKey } from "../shared/types";
import type { ActivityWindow } from "../shared/activity";
export interface ActivitySelection {
  chain: string;
  window: ActivityWindow;
  poolId: string;
  hookAddress: string;
}
export type DetailTab = "deployments" | "pools";
export interface ExtensionSelection {
  chain: "robinhood";
  hookAddress: string;
  poolId: string;
}

function extensionSelection(query: URLSearchParams): ExtensionSelection | null {
  const hook = query.get("extension_hook") || "";
  const pool = query.get("extension_pool") || "";
  if (
    query.get("project") !== "frontier" ||
    query.get("tab") !== "deployments" ||
    query.get("extension_chain") !== "robinhood" ||
    !/^0x[a-f0-9]{40}$/i.test(hook) ||
    /^0x0{40}$/i.test(hook) ||
    (pool !== "" && !/^0x[a-f0-9]{64}$/i.test(pool)) ||
    ["extension_chain", "extension_hook", "extension_pool"].some(
      (key) => query.getAll(key).length > 1,
    )
  )
    return null;
  return {
    chain: "robinhood",
    hookAddress: hook.toLowerCase(),
    poolId: pool.toLowerCase(),
  };
}
export type SortOrder = { key: SortKey; direction: "asc" | "desc" };
export type AnalyticsRange = "d1" | "d7" | "d30" | "all";
export const chainRoleKeys = [
  "all",
  "launchpads",
  "launches",
  "dexes",
  "liquidity",
  "fees",
  "mev",
  "orders",
  "oracles",
  "access",
  "other",
] as const;
export type ChainRoleFilter = (typeof chainRoleKeys)[number];
/** The views that can show 7D and 30D (edition only); every other view shows
 * the plain windows, and a link to one drops the span. */
export const SPAN_VIEWS: readonly View[] = ["overview", "watchlist", "chains"];

export interface NavigationState {
  view: View;
  filters: Filters;
  window: WindowKey;
  /** Edition: 7D or 30D of the largest pools (the address says window=d7 or
   * window=d30; the window beneath stays 24H). Never set by the live app. It is
   * not analytics_range, which is the history chart's own range. */
  span?: DailySpan | null;
  project: string | null;
  detailTab: DetailTab;
  extensionSelection?: ExtensionSelection | null;
  sort: SortOrder;
  comparison?: string[];
  comparisonChain?: string;
  activityProject?: string | null;
  activitySelection?: ActivitySelection;
  analyticsChain?: string;
  analyticsRange?: AnalyticsRange;
  chainNetwork?: string;
  chainSearch?: string;
  chainRole?: ChainRoleFilter;
}

export function parseNavigation(
  search: string,
  edition: boolean = STATIC_EDITION,
): NavigationState {
  const query = new URLSearchParams(search);
  const spanParam = query.get("window") as DailySpan | null;
  const span =
    edition && spanParam && DAILY_SPAN_KEYS.includes(spanParam)
      ? spanParam
      : null;
  const [key, direction] = (query.get("sort") || "").split(":");
  const market =
    query.get("market") === "active"
      ? "active"
      : query.get("market") === "observed"
        ? "observed"
        : query.get("market") === "all"
          ? "all"
          : query.get("market") === "projects"
            ? "projects"
            : query.get("view") === "watchlist"
              ? "all"
              : "projects";
  return {
    view: [
      "overview",
      "analytics",
      "chains",
      "map",
      "learn",
      "watchlist",
      "compare",
      "activity",
    ].includes(query.get("view") || "")
      ? (query.get("view") as View)
      : "overview",
    filters: {
      search: (query.get("q") || "").slice(0, 300),
      chain: query.get("chain") || "all",
      category: categories.includes(
        query.get("category") as (typeof categories)[number],
      )
        ? query.get("category")!
        : "all",
      property: ["dynamic", "verified", "upgradeable", "custom"].includes(
        query.get("property") || "",
      )
        ? (query.get("property") as PropertyFilter)
        : "all",
      market,
    },
    window: ["h1", "h6", "h24"].includes(query.get("window") || "")
      ? (query.get("window") as WindowKey)
      : "h24",
    ...(edition ? { span } : {}),
    project: query.get("project"),
    comparison: [
      ...new Set(
        (query.get("compare") || "")
          .split(",")
          .filter((id) => /^[a-z0-9][a-z0-9-]{0,99}$/.test(id)),
      ),
    ].slice(0, 4),
    comparisonChain: /^[a-z0-9-]{1,50}$/.test(query.get("compareChain") || "")
      ? query.get("compareChain")!
      : "all",
    activityProject: /^[a-z0-9][a-z0-9-]{0,99}$/.test(
      query.get("activity") || "",
    )
      ? query.get("activity")
      : null,
    analyticsChain: /^[a-z0-9-]{1,50}$/.test(query.get("analytics_chain") || "")
      ? query.get("analytics_chain")!
      : "all",
    analyticsRange: ["d1", "d7", "d30", "all"].includes(
      query.get("analytics_range") || "",
    )
      ? (query.get("analytics_range") as AnalyticsRange)
      : "d7",
    chainNetwork: /^[a-z0-9-]{1,50}$/.test(query.get("chain_network") || "")
      ? query.get("chain_network")!
      : "all",
    chainSearch: (query.get("chain_q") || "")
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
      .slice(0, 300),
    chainRole: chainRoleKeys.includes(
      query.get("chain_role") as ChainRoleFilter,
    )
      ? (query.get("chain_role") as ChainRoleFilter)
      : "all",
    activitySelection: {
      chain: /^[a-z0-9-]{1,50}$/.test(query.get("activity_chain") || "")
        ? query.get("activity_chain")!
        : "all",
      window: ["h1", "h24", "d7"].includes(query.get("activity_window") || "")
        ? (query.get("activity_window") as ActivityWindow)
        : "h24",
      poolId: /^0x[a-f0-9]{64}$/i.test(query.get("activity_pool") || "")
        ? query.get("activity_pool")!.toLowerCase()
        : "",
      hookAddress: /^0x[a-f0-9]{40}$/i.test(query.get("activity_hook") || "")
        ? query.get("activity_hook")!.toLowerCase()
        : "",
    },
    detailTab: query.get("tab") === "deployments" ? "deployments" : "pools",
    extensionSelection: extensionSelection(query),
    sort:
      ["name", "deployments", "volume", "liquidity", "pools"].includes(key) &&
      ["asc", "desc"].includes(direction)
        ? {
            key: key as SortKey,
            direction: direction as SortOrder["direction"],
          }
        : {
            key: "volume",
            direction: "desc",
          },
  };
}

export function navigationSearch(
  state: NavigationState,
  edition: boolean = STATIC_EDITION,
) {
  const query = new URLSearchParams();
  if (state.view !== "overview") query.set("view", state.view);
  if (state.comparison?.length)
    query.set(
      "compare",
      [
        ...new Set(
          state.comparison.filter((id) => /^[a-z0-9][a-z0-9-]{0,99}$/.test(id)),
        ),
      ]
        .slice(0, 4)
        .join(","),
    );
  if (
    state.view === "compare" &&
    state.comparisonChain !== "all" &&
    /^[a-z0-9-]{1,50}$/.test(state.comparisonChain || "")
  )
    query.set("compareChain", state.comparisonChain!);
  if (
    state.view === "activity" &&
    state.activityProject &&
    /^[a-z0-9][a-z0-9-]{0,99}$/.test(state.activityProject)
  )
    query.set("activity", state.activityProject);
  if (state.view === "activity" && state.activitySelection) {
    const scope = state.activitySelection;
    if (scope.chain !== "all" && /^[a-z0-9-]{1,50}$/.test(scope.chain))
      query.set("activity_chain", scope.chain);
    if (scope.window !== "h24" && ["h1", "d7"].includes(scope.window))
      query.set("activity_window", scope.window);
    if (/^0x[a-f0-9]{64}$/i.test(scope.poolId))
      query.set("activity_pool", scope.poolId.toLowerCase());
    if (/^0x[a-f0-9]{40}$/i.test(scope.hookAddress))
      query.set("activity_hook", scope.hookAddress.toLowerCase());
  }
  if (state.view === "analytics") {
    if (
      state.analyticsChain !== "all" &&
      /^[a-z0-9-]{1,50}$/.test(state.analyticsChain || "")
    )
      query.set("analytics_chain", state.analyticsChain!);
    if (
      state.analyticsRange !== "d7" &&
      ["d1", "d30", "all"].includes(state.analyticsRange || "")
    )
      query.set("analytics_range", state.analyticsRange!);
  }
  if (state.view === "chains") {
    if (
      state.chainNetwork !== "all" &&
      /^[a-z0-9-]{1,50}$/.test(state.chainNetwork || "")
    )
      query.set("chain_network", state.chainNetwork!);
    if (state.chainSearch)
      query.set(
        "chain_q",
        state.chainSearch
          .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
          .slice(0, 300),
      );
    if (
      state.chainRole &&
      state.chainRole !== "all" &&
      chainRoleKeys.includes(state.chainRole)
    )
      query.set("chain_role", state.chainRole);
  }
  if (state.filters.search) query.set("q", state.filters.search);
  if (state.filters.chain !== "all") query.set("chain", state.filters.chain);
  if (state.filters.category !== "all")
    query.set("category", state.filters.category);
  if (state.filters.property !== "all")
    query.set("property", state.filters.property);
  const defaultMarket = state.view === "watchlist" ? "all" : "projects";
  if (state.filters.market && state.filters.market !== defaultMarket)
    query.set("market", state.filters.market);
  if (
    edition &&
    state.span &&
    DAILY_SPAN_KEYS.includes(state.span) &&
    SPAN_VIEWS.includes(state.view)
  )
    query.set("window", state.span);
  else if (state.window !== "h24") query.set("window", state.window);
  const defaultSort = "volume";
  if (state.sort.key !== defaultSort || state.sort.direction !== "desc")
    query.set("sort", `${state.sort.key}:${state.sort.direction}`);
  if (state.project) {
    query.set("project", state.project);
    if (state.detailTab === "deployments") query.set("tab", "deployments");
    if (
      state.project === "frontier" &&
      state.detailTab === "deployments" &&
      state.extensionSelection
    ) {
      const selection = state.extensionSelection;
      const candidate = new URLSearchParams(query);
      candidate.set("extension_chain", selection.chain);
      candidate.set("extension_hook", selection.hookAddress);
      if (selection.poolId) candidate.set("extension_pool", selection.poolId);
      const valid = extensionSelection(candidate);
      if (valid) {
        query.set("extension_chain", valid.chain);
        query.set("extension_hook", valid.hookAddress);
        if (valid.poolId) query.set("extension_pool", valid.poolId);
      }
    }
  }
  return query.size ? `?${query}` : "";
}

/** Share public filters and project identity without relying on another browser's saved hooks. */
export function publicViewUrl(value: string): string {
  const url = new URL(value);
  if (url.searchParams.get("view") === "watchlist") {
    url.searchParams.delete("view");
    if (!url.searchParams.has("market")) url.searchParams.set("market", "all");
  }
  return url.href;
}
