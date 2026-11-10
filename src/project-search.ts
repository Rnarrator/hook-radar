import type { HookDeployment } from "../shared/types";

/** Match the identifiers a person can see in a hook card or network menu. */
export function matchesHookSearch(
  hook: HookDeployment,
  query: string,
  networkName: string,
): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const text = [hook.name, hook.address, hook.chain, networkName, hook.chainId]
    .join(" ")
    .toLowerCase();
  return terms.every((term) => text.includes(term));
}
