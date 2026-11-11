import {
  analyticsOverviewAsync,
  analyticsOverviewJson,
} from "../server/analytics-overview.mjs";
import { isAnalyticsOverviewEnvelope } from "../shared/analytics-overview.ts";
import { publishedInventory } from "./assemble.mjs";
import { HISTORY_MAX_POINTS } from "./config.mjs";

export const overviewFileName = ({ chain, window }) =>
  `overview-${chain}-${window}.json`;

/** The overview files the page reads: all networks for 1h, 6h and 24h, then
 * each network for 24h. Each is the envelope the live endpoint would serve for
 * that query, built by the project's own analyticsOverviewAsync over the same
 * snapshot, evaluated at the snapshot's own time, with the per-pool
 * contributions the client needs to re-slice locally. Every file is validated
 * after a JSON round trip, exactly as the client will receive it.
 *
 * The envelope names a network by its census record when there is one, and the
 * census calls a network by its own name ("Robinhood Chain"). The overview is
 * built over the snapshot with the directory's names, so a network has the
 * name the Networks page gives it, in every envelope. */
export async function buildOverviewFiles(snapshot, nowMs) {
  const named = snapshot.inventory
    ? {
        ...snapshot,
        inventory: publishedInventory(snapshot.inventory, snapshot.chains),
      }
    : snapshot;
  const build = async (query) => {
    const envelope = await analyticsOverviewAsync(named, query, {
      now: nowMs,
      contributions: true,
      maxHistoryPoints: HISTORY_MAX_POINTS,
    });
    const text = analyticsOverviewJson(envelope, {
      maxHistoryPoints: HISTORY_MAX_POINTS,
    });
    if (
      !isAnalyticsOverviewEnvelope(JSON.parse(text), query, {
        maxHistoryPoints: HISTORY_MAX_POINTS,
      })
    )
      throw new TypeError(
        `The ${overviewFileName(query)} overview did not survive validation.`,
      );
    return { name: overviewFileName(query), query, envelope, text };
  };
  const files = [];
  const all24 = await build({ chain: "all", window: "h24" });
  files.push(all24);
  for (const window of ["h1", "h6"])
    files.push(await build({ chain: "all", window }));
  for (const network of all24.envelope.networks)
    files.push(await build({ chain: network.slug, window: "h24" }));
  return files;
}
