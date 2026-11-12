import { LANE_GUARD_MIN_HOT_POOLS, MIN_REQUESTED_SHARE } from "./config.mjs";
import { poolKey } from "./state.mjs";

// The lane plan's refusal of a network DEX Screener did not answer for.
//
// The quality gate (collector/quality.mjs, unchanged) refuses a run in which fewer
// than 80% of the planned pools were requested. With the plan that asks about every
// known pool a network that did not answer was a large part of that plan (a
// network is as heavy as its cold pools are many), so the gate refused the run. The
// lane plan plans only the pools that matter and the pools that fell due, so the same
// network is a smaller part of it, and a network that holds a tenth of the priced
// sample can go without an answer and the gate not notice (the full plan refused a Base
// outage; the lane plan, at the usual gaps, published it). Nothing may weaken a gate,
// so a run with the lane plan also refuses here, on the pools that matter:
//
//   DEX Screener did not answer for a network (the burst's `downNetworks`: five
//   batches failed in a row and the rest were not sent, or at least two failed and
//   none was ever answered) that holds at least LANE_GUARD_MIN_HOT_POOLS pools that
//   answered recently (HOT), and fewer than MIN_REQUESTED_SHARE (the gate's 80%) of
//   that network's HOT and NEW pools were answered by a provider.
//
// The condition is an outage of the network, so a batch that fails now and then
// (or a blip that fails a batch of every network at once: that needs more than the
// two the burst's rotation gives one network), a burst that runs out of time (the
// gate's own share covers that) and a network DEX Screener does not index (HTTP 400
// as its first answer, listed in `unsupportedNetworks`) do not refuse. A network too small to hold the HOT pools
// is not judged: its pools are a few percent of the sample at most. The full plan
// is not judged here at all: its gate is what it was.

/** The guard's verdict on a burst of the lane plan.
 *
 * Returns `{ ok, failures, networks }`: `failures` are the sentences a refusal
 * adds to the gate's, `networks` has a row for each network the burst did not
 * get an answer for (`{ chain, hot, hotAndNew, answered, share, refused }`), empty
 * when there was none. `plan` is the run's plan and `burst` what runBurst returned (`downNetworks`,
 * `unsupportedNetworks`, `answeredKeys`); a plan that is not a lane plan is not
 * judged. */
export function laneNetworkGuard({
  plan,
  burst,
  minHotPools = LANE_GUARD_MIN_HOT_POOLS,
  minShare = MIN_REQUESTED_SHARE,
}) {
  if (plan.mode !== "lanes") return { ok: true, failures: [], networks: [] };
  const down = new Set(burst.downNetworks ?? []);
  const unindexed = new Set(burst.unsupportedNetworks ?? []);
  const networks = [];
  const failures = [];
  for (const { chain, pools } of plan.networks) {
    if (!down.has(chain.chain) || unindexed.has(chain.chain)) continue;
    let hot = 0;
    let hotAndNew = 0;
    let answered = 0;
    for (const pool of pools) {
      const key = poolKey(chain.chain, pool.id);
      const lane = plan.laneByKey.get(key);
      if (lane !== "hot" && lane !== "new") continue;
      hotAndNew++;
      if (lane === "hot") hot++;
      if (burst.answeredKeys.has(key)) answered++;
    }
    const share = hotAndNew > 0 ? answered / hotAndNew : 1;
    const refused = hot >= minHotPools && !(share >= minShare);
    networks.push({
      chain: chain.chain,
      hot,
      hotAndNew,
      answered,
      share,
      refused,
    });
    if (refused)
      failures.push(
        `DEX Screener did not answer for ${chain.name ?? chain.chain}: its batches failed (five in a row, or two or more and none answered), so only ${answered} of its ${hotAndNew} pools that answer or are new (${hot} of them answered recently) were answered (${Math.round(share * 100)}%); at least ${Math.round(minShare * 100)}% are required for a network with ${minHotPools} or more such pools. Publishing would leave the network out of the snapshot.`,
      );
  }
  return { ok: failures.length === 0, failures, networks };
}

/** The gate's verdict with the guard's added: `ok` only when both are, the guard's
 * sentences after the gate's, and the guard's rows in `networkGuard`. The gate's own
 * `checks` are untouched. A plan that is not a lane plan has `networkGuard: null`. */
export function withLaneGuard(quality, guard, plan) {
  return {
    ...quality,
    ok: quality.ok && guard.ok,
    failures: [...quality.failures, ...guard.failures],
    networkGuard:
      plan.mode === "lanes"
        ? {
            minHotPools: LANE_GUARD_MIN_HOT_POOLS,
            minShare: MIN_REQUESTED_SHARE,
            networks: guard.networks,
          }
        : null,
  };
}
