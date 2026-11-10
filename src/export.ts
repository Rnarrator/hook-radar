import type { Pool, RadarProject, WindowKey } from "../shared/types";
import { csvCell, windows } from "./model.ts";
import { measurementProvenance } from "./provenance.ts";
import { comparisonMeasurement } from "./comparison.ts";

/** What a file says about itself when it comes from a dated snapshot (the
 * Auto Snapshot edition): the time its figures are from and what its rows
 * cover. Without it the file is exactly what the live page writes. */
export interface ProjectCsvContext {
  /** The snapshot's own generatedAt, as published. */
  snapshotAt: string;
  /** What the rows cover, in words; repeated on every row. */
  scope: string;
}

/** A dated snapshot's file shows amounts to the cent: a sum of cent-valued
 * pools can carry binary-float noise (21010437.029999997). A missing amount
 * stays missing. Without a context the value is written as before. */
function cents<T extends number | null>(
  amount: T,
  context: ProjectCsvContext | undefined,
): T | number {
  return context && typeof amount === "number"
    ? Math.round(amount * 100) / 100
    : amount;
}

export function projectCsv(
  projects: RadarProject[],
  pools: Pool[],
  window: WindowKey,
  chain = "all",
  context?: ProjectCsvContext,
) {
  const rows: unknown[][] = [
    [
      "Directory ID",
      "Project",
      "Purpose",
      "Category",
      "Chains",
      "Indexed deployments",
      "Deployment addresses",
      context
        ? `Observed ${windows[window]} volume USD at snapshot`
        : `Current observed ${windows[window]} volume USD`,
      context
        ? "Reported reserve valuation USD at snapshot"
        : "Current reported reserve valuation USD",
      "Metric coverage",
      "Volume oldest measurement ISO",
      "Volume cached pools",
      "Reserves oldest measurement ISO",
      "Reserves cached pools",
      "Volume older pools excluded",
      "Volume latest recorded measurement ISO",
      "Reserves older pools excluded",
      "Reserves latest recorded measurement ISO",
      "Source",
      // After the live columns, so each one keeps its place.
      ...(context ? ["Snapshot time (UTC)", "Scope"] : []),
    ],
  ];
  for (const project of projects) {
    const contributors = pools.filter(
      (pool) =>
        pool.projectId === project.id &&
        (chain === "all" || pool.chain === chain),
    );
    const volume = measurementProvenance(contributors, window),
      liquidity = measurementProvenance(contributors, "liquidity");
    rows.push([
      project.id,
      project.name,
      project.description,
      project.category,
      project.chains.join("; "),
      project.deployments.length,
      project.deployments
        .map((deployment) => `${deployment.chain}:${deployment.address}`)
        .join("; "),
      cents(
        comparisonMeasurement(project, contributors, window, chain).amount,
        context,
      ),
      cents(
        comparisonMeasurement(project, contributors, "liquidity", chain).amount,
        context,
      ),
      project.metrics.coverage,
      volume.oldestAt,
      volume.cachedPoolCount,
      liquidity.oldestAt,
      liquidity.cachedPoolCount,
      volume.stalePoolCount,
      volume.latestObservedAt,
      liquidity.stalePoolCount,
      liquidity.latestObservedAt,
      project.sourceUrl,
      ...(context ? [context.snapshotAt, context.scope] : []),
    ]);
  }
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}
