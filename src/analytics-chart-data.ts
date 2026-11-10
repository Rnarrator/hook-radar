import type { AnalyticsResult } from "./analytics";

export type AnalyticsChartMetric = "volume" | "reserves";

export interface AnalyticsCategorySlice {
  category: string;
  value: number | null;
  share: number | null;
  measuredPools: number;
  color: string;
}

const categoryColors: Record<string, string> = {
  Launches: "#f566b1",
  Liquidity: "#b29af4",
  Fees: "#7bc6cf",
  MEV: "#e5b575",
  Orders: "#dc8a8e",
  Oracles: "#99bde4",
  Access: "#b3c78b",
  Other: "#ba94ba",
  Unattributed: "#8c899f",
};

const networkColors = ["#f566b1", "#b29af4", "#7bc6cf", "#e5b575", "#99bde4"];

/** Chart series colors identify the same network across sort/filter changes.
 * They are data colors, never substitutes for a network's brand artwork. */
export function analyticsNetworkColor(chain: string): string {
  let hash = 0;
  for (const character of chain)
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return networkColors[hash % networkColors.length];
}

export function analyticsChartShare(
  value: number | null,
  total: number | null,
) {
  if (
    value === null ||
    !Number.isFinite(value) ||
    value < 0 ||
    total === null ||
    !Number.isFinite(total) ||
    total <= 0
  )
    return null;
  const share = value / total;
  return Number.isFinite(share) ? share : null;
}

/** Consume buildAnalytics' already deduplicated and freshness-checked rows.
 * Every measured pool contributes once; missing values stay distinct from 0.
 * Shares use the scope's measured total, never a renormalized visible subset. */
export function analyticsCategorySlices(
  result: Pick<AnalyticsResult, "pools" | "totals">,
  metric: AnalyticsChartMetric,
): AnalyticsCategorySlice[] {
  const groups = new Map<string, { sum: number; measuredPools: number }>();
  const field = metric === "volume" ? "volumeUsd" : "liquidityUsd";
  const total = result.totals[field];
  for (const row of result.pools) {
    const category = row.project?.category || "Unattributed";
    let group = groups.get(category);
    if (!group) {
      group = { sum: 0, measuredPools: 0 };
      groups.set(category, group);
    }
    const value = row[field];
    if (value !== null && Number.isFinite(value) && value >= 0) {
      group.sum += value;
      group.measuredPools++;
    }
  }
  return [...groups]
    .map(([category, group]) => {
      const value =
        group.measuredPools > 0 && Number.isFinite(group.sum)
          ? group.sum
          : null;
      return {
        category,
        value,
        share: analyticsChartShare(value, total),
        measuredPools: group.measuredPools,
        color: categoryColors[category] || categoryColors.Other,
      };
    })
    .sort((a, b) => {
      if (a.value === null && b.value !== null) return 1;
      if (b.value === null && a.value !== null) return -1;
      return (
        (b.value ?? 0) - (a.value ?? 0) || a.category.localeCompare(b.category)
      );
    });
}

export function analyticsChartPercent(share: number | null): string {
  if (share === null || !Number.isFinite(share)) return "—";
  if (share > 0 && share < 0.001) return "<0.1%";
  if (share < 1 && Number((share * 100).toFixed(1)) >= 100) return "99.9%";
  return `${(share * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
}

export function analyticsChartExactMoney(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "Not available";
  if ((value > 0 && value < 0.000001) || value >= 1e15)
    return `$${value.toExponential()}`;
  if (value > 0 && value < 0.01)
    return value.toLocaleString(undefined, {
      style: "currency",
      currency: "USD",
      maximumSignificantDigits: 8,
    });
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}
