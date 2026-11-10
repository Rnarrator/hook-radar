import type { Filters } from "./model";

export const SAVED_FILTERS_KEY = "hook-radar-saved-filters-v1";
export const MAX_SAVED_FILTERS = 8;
export const MAX_SAVED_FILTER_NAME = 48;
export interface SavedFilterView {
  id: string;
  name: string;
  filters: Filters;
}

const properties = ["all", "dynamic", "verified", "upgradeable", "custom"];
const markets = ["projects", "all", "observed", "active"];
const controls = /[\u0000-\u001f\u007f-\u009f]/;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Saved filters retain explicit scope; unknown fields never become filters. */
export function normalizeDiscoveryFilters(value: unknown): Filters | null {
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) =>
        !["search", "chain", "category", "property", "market"].includes(key),
    ) ||
    typeof value.search !== "string" ||
    value.search.length > 300 ||
    controls.test(value.search) ||
    typeof value.chain !== "string" ||
    !/^[a-z0-9-]{1,50}$/.test(value.chain) ||
    typeof value.category !== "string" ||
    !discoveryCategories.some(
      (category) => category.value === value.category,
    ) ||
    typeof value.property !== "string" ||
    !properties.includes(value.property) ||
    (value.market !== undefined &&
      (typeof value.market !== "string" || !markets.includes(value.market)))
  )
    return null;
  return {
    search: value.search,
    chain: value.chain,
    category: value.category,
    property: value.property as Filters["property"],
    market: (value.market || "projects") as NonNullable<Filters["market"]>,
  };
}

export function sameDiscoveryFilters(a: Filters, b: Filters) {
  return (
    a.search === b.search &&
    a.chain === b.chain &&
    a.category === b.category &&
    a.property === b.property &&
    (a.market || "projects") === (b.market || "projects")
  );
}

export function savedFilterName(value: unknown): string | null {
  if (typeof value !== "string" || controls.test(value)) return null;
  const name = value.trim();
  return name && name.length <= MAX_SAVED_FILTER_NAME ? name : null;
}

export function decodeSavedFilters(raw: string | null): {
  views: SavedFilterView[];
  corrupt: boolean;
} {
  if (raw === null) return { views: [], corrupt: false };
  if (raw.length > 65536) return { views: [], corrupt: true };
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !object(value) ||
      value.version !== 1 ||
      !Array.isArray(value.views) ||
      value.views.length > MAX_SAVED_FILTERS
    )
      return { views: [], corrupt: true };
    const views: SavedFilterView[] = [];
    let corrupt = false;
    for (const row of value.views) {
      const filters = object(row)
        ? normalizeDiscoveryFilters(row.filters)
        : null;
      const name = object(row) ? savedFilterName(row.name) : null;
      if (
        !object(row) ||
        typeof row.id !== "string" ||
        !/^[a-z0-9-]{1,100}$/.test(row.id) ||
        !filters ||
        !name ||
        views.some(
          (view) =>
            view.id === row.id ||
            view.name.toLowerCase() === name.toLowerCase() ||
            sameDiscoveryFilters(view.filters, filters),
        )
      ) {
        corrupt = true;
        continue;
      }
      views.push({ id: row.id, name, filters });
    }
    return { views, corrupt };
  } catch {
    return { views: [], corrupt: true };
  }
}

export function encodeSavedFilters(views: SavedFilterView[]) {
  return JSON.stringify({ version: 1, views });
}

export function putSavedFilter(
  views: SavedFilterView[],
  input: { id: string; name: string; filters: Filters; replaceId?: string },
): { views: SavedFilterView[]; error: string | null } {
  const name = savedFilterName(input.name);
  const filters = normalizeDiscoveryFilters(input.filters);
  if (!name)
    return {
      views,
      error: `Use a name between 1 and ${MAX_SAVED_FILTER_NAME} characters.`,
    };
  if (!filters || !/^[a-z0-9-]{1,100}$/.test(input.id))
    return {
      views,
      error:
        "These filters could not be saved. Clear invalid filters and try again.",
    };
  if (input.replaceId && !views.some((view) => view.id === input.replaceId))
    return { views, error: "This saved filter was removed in another tab." };
  if (views.some((view) => view.id === input.id && view.id !== input.replaceId))
    return {
      views,
      error: "This saved filter already exists. Try saving again.",
    };
  if (
    views.some(
      (view) =>
        view.id !== input.replaceId &&
        view.name.toLowerCase() === name.toLowerCase(),
    )
  )
    return { views, error: "A saved filter already uses this name." };
  if (
    views.some(
      (view) =>
        view.id !== input.replaceId &&
        sameDiscoveryFilters(view.filters, filters),
    )
  )
    return {
      views,
      error:
        "These filters are already saved. Rename the existing view instead.",
    };
  if (!input.replaceId && views.length >= MAX_SAVED_FILTERS)
    return {
      views,
      error: `You can save up to ${MAX_SAVED_FILTERS} filter views. Remove one to save another.`,
    };
  const next = { id: input.replaceId || input.id, name, filters };
  return {
    views: input.replaceId
      ? views.map((view) => (view.id === input.replaceId ? next : view))
      : [...views, next],
    error: null,
  };
}

export function discoveryFilterSummary(filters: Filters): string[] {
  const networkNames: Record<string, string> = {
    all: "All networks",
    bnb: "BNB Chain",
    hyperevm: "HyperEVM",
    megaeth: "MegaETH",
    world: "World Chain",
    "world-chain": "World Chain",
    xlayer: "X Layer",
    "x-layer": "X Layer",
  };
  const parts = [
    Object.hasOwn(networkNames, filters.chain)
      ? networkNames[filters.chain]
      : filters.chain.replace(
          /(^|-)([a-z])/g,
          (_, separator, letter) =>
            `${separator ? " " : ""}${letter.toUpperCase()}`,
        ),
  ];
  if (filters.category !== "all")
    parts.push(
      discoveryCategories.find(
        (category) => category.value === filters.category,
      )?.label || filters.category,
    );
  if (filters.property !== "all")
    parts.push(
      (
        {
          dynamic: "Dynamic fees",
          verified: "Verified source",
          upgradeable: "Upgradeable",
          custom: "Custom swap data",
        } as const
      )[filters.property],
    );
  parts.push(
    filters.market === "all"
      ? "All hooks"
      : filters.market === "active"
        ? "Recent trading"
        : filters.market === "observed"
          ? "With market data"
          : "Projects",
  );
  if (filters.search) parts.push(`Search: ${filters.search}`);
  return parts;
}

export function defaultSavedFilterName(filters: Filters) {
  return (
    discoveryFilterSummary(filters)
      .filter((part) => part !== "All networks" && part !== "Projects")
      .join(" · ")
      .slice(0, MAX_SAVED_FILTER_NAME) || "All projects"
  );
}

export const discoveryCategories = [
  {
    value: "all",
    label: "All use cases",
    detail: "Browse every project category.",
  },
  {
    value: "Launches",
    label: "Token launches",
    detail: "Token launches, auctions and launch fees.",
  },
  {
    value: "Liquidity",
    label: "Liquidity",
    detail: "Liquidity management and pool rebalancing.",
  },
  {
    value: "Fees",
    label: "Fees",
    detail: "Adaptive fees and fee distribution.",
  },
  {
    value: "MEV",
    label: "MEV protection",
    detail: "MEV auctions and mechanisms designed to protect LPs.",
  },
  {
    value: "Orders",
    label: "Orders",
    detail: "Limit orders and other order execution strategies.",
  },
  {
    value: "Oracles",
    label: "Oracles",
    detail: "Price feeds and onchain price observations.",
  },
  {
    value: "Access",
    label: "Access",
    detail: "Swap restrictions and permissioned pools.",
  },
  { value: "Other", label: "Other", detail: "Other hook use cases." },
] as const;

/** Feature shortcuts change only their own dimension of the directory. */
export function discoveryDynamicFeePatch(filters: Filters): Partial<Filters> {
  return { property: filters.property === "dynamic" ? "all" : "dynamic" };
}
