import { poolMatchParts, poolMatchText } from "../pool-search";
import type { SearchMatch } from "../pool-search";

/** The id a row's open button points at as its description. */
export function poolMatchId(projectId: string) {
  return `pool-match-${projectId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/** The line under a project in Discover when one of its measured pools, not its
 * own text, matched the search. Plain text only; a long symbol is cut with an
 * ellipsis and the whole line is in the title. */
export function PoolMatchLine({
  id,
  match,
}: {
  id: string;
  match: Extract<SearchMatch, { via: "pool" }>;
}) {
  const { before, name, after } = poolMatchParts(match);
  return (
    <p className="pool-match" id={id} title={poolMatchText(match)}>
      {before}
      <bdi>{name}</bdi>
      {after}
    </p>
  );
}
