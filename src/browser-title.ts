import type { View } from "./model";

const workspaceTitles: Record<View, string> = {
  overview: "Uniswap v4 hooks",
  analytics: "Hook analytics",
  projects: "Uniswap v4 projects",
  activity: "Hook activity",
  compare: "Compare hooks",
  chains: "Networks & protocols",
  map: "Hooks by use case",
  learn: "Understand v4 hooks",
  watchlist: "Watchlist",
};

/** Plain document-title text; never interpolate registry names into HTML. */
export function browserTitle({
  view,
  projectName,
  projectId,
  chainRole,
}: {
  view: View;
  projectName?: string | null;
  projectId?: string | null;
  /** The Chains view's role filter; Launchpads is its own page for a reader. */
  chainRole?: string | null;
}): string {
  const name = (projectName || "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const label = projectId
    ? name || "Project details"
    : view === "chains" && chainRole === "launchpads"
      ? "Launchpads on Uniswap v4"
      : workspaceTitles[view] || workspaceTitles.overview;
  const bounded = Array.from(label);
  return `${bounded.length > 100 ? bounded.slice(0, 99).join("") + "…" : label} · Hook Radar`;
}
