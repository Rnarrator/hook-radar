import type {
  Chain,
  Pool,
  PoolIndexCoverage,
  RadarProject,
  RadarSnapshot,
} from "./types";

/** One project's complete published observations, independent of ecosystem analytics. */
export interface ProjectView {
  schemaVersion: 1;
  presentation: { profile: "project"; version: 1 };
  ready: true;
  generatedAt: string;
  status: RadarSnapshot["status"];
  project: RadarProject;
  pools: Pool[];
  chains: Chain[];
  inventory?: PoolIndexCoverage;
}

export type ProjectContext = Pick<
  ProjectView,
  "pools" | "chains" | "inventory"
>;
export const PROJECT_VIEW_MAX_BYTES = 32 * 1024 * 1024;
