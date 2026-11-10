import {
  MIN_CURRENT_POOLS,
  MIN_CURRENT_SHARE,
  MIN_REQUESTED_SHARE,
  MIN_VOLUME_POOLS_OF_PREVIOUS,
  PREVIOUS_POINT_MAX_AGE_MS,
} from "./config.mjs";

/** The minimum-quality gate. A run that fails it publishes nothing, so the site
 * keeps its last good, still-dated snapshot.
 *
 * - at least `minCurrent` pools carry a current 24h volume (a measured zero is a
 *   volume), so the headline figure rests on a real sample and not on pools that
 *   only carry a liquidity figure;
 * - at least 80% of the planned pools were actually requested, so a provider
 *   that stopped us (HTTP 429/403) or a burst that ran out of time cannot
 *   publish a thin sample as if it were the usual one;
 * - at least 80% of the pools that were requested were answered (by either
 *   provider; an answer for a pool that was never requested does not count, and
 *   the count cannot exceed the pools requested), so a provider that fails on and
 *   off (HTTP 5xx on every other batch, a malformed answer) cannot pass because
 *   its failures were not consecutive;
 * - at least 90% of the pools that carry a measurement are current at the
 *   snapshot time, so a burst that stalled, or a provider that served old cached
 *   copies, cannot publish totals that leave a large part of the sample out;
 * - at least one pool carries a current 24h volume, so the history point and
 *   the headline figure exist;
 * - at least 60% as many pools carry a current 24h volume as in the previous
 *   history point, when that point is less than a day old, so a sample that
 *   shrank to a fraction is not recorded as a collapse in volume;
 * - the snapshot and every overview file passed the validators the live
 *   client uses. */
export function assessQuality({
  currentPools,
  currentVolumePools = 0,
  observedPools = currentPools,
  plannedPools,
  requestedPools,
  checkedPools = 0,
  snapshotValid,
  overviewsValid,
  volumeMeasured = true,
  minCurrent = MIN_CURRENT_POOLS,
  minShare = MIN_REQUESTED_SHARE,
  minCurrentShare = MIN_CURRENT_SHARE,
  minPreviousShare = MIN_VOLUME_POOLS_OF_PREVIOUS,
  previousPoint = null,
  generatedAtMs = null,
  stoppedProviders = [],
  unsupportedNetworks = [],
}) {
  const failures = [];
  const percent = (share) => Math.round(share * 100);
  const stopNote = stoppedProviders.length
    ? `. Stopped for this run: ${stoppedProviders.join(", ")}`
    : "";
  const unindexedNote = unsupportedNetworks.length
    ? ` Networks DEX Screener answered HTTP 400 for: ${unsupportedNetworks.join(", ")}.`
    : "";
  if (!snapshotValid)
    failures.push("The snapshot did not pass the client validator.");
  if (!overviewsValid)
    failures.push("An analytics overview file did not pass its validator.");
  if (!volumeMeasured) failures.push("No pool carries a current 24h volume.");
  if (!(currentVolumePools >= minCurrent))
    failures.push(
      `Only ${currentVolumePools} pools carry a current 24h volume; at least ${minCurrent} are required.`,
    );
  const share = plannedPools > 0 ? requestedPools / plannedPools : 0;
  if (!(share >= minShare))
    failures.push(
      `Only ${requestedPools} of ${plannedPools} planned pools were requested (${percent(share)}%); at least ${percent(minShare)}% are required${stopNote}.${unindexedNote}`,
    );
  // The pools answered are counted among the pools requested: an answer for a
  // pool that was never asked about cannot make up for one that went unanswered.
  const answeredPools = Math.min(checkedPools, requestedPools);
  const answeredShare = requestedPools > 0 ? answeredPools / requestedPools : 0;
  if (requestedPools > 0 && !(answeredShare >= minShare))
    failures.push(
      `Only ${answeredPools} of ${requestedPools} requested pools were answered (${percent(answeredShare)}%); at least ${percent(minShare)}% are required${stopNote}.${unindexedNote}`,
    );
  const currentShare = observedPools > 0 ? currentPools / observedPools : 0;
  if (observedPools > 0 && !(currentShare >= minCurrentShare))
    failures.push(
      `Only ${currentPools} of ${observedPools} measured pools are current at the snapshot time (${percent(currentShare)}%); at least ${percent(minCurrentShare)}% are required. The measurements were spread over too long a time, or a provider served old copies.`,
    );
  // The comparison only makes sense against a recent, well-formed point: with
  // none, or an old one, a genuinely smaller sample is never held back.
  const previousPools = previousPoint?.pools;
  const previousAge = generatedAtMs - previousPoint?.timestamp;
  const comparable =
    Number.isFinite(previousPools) &&
    previousPools > 0 &&
    Number.isFinite(generatedAtMs) &&
    Number.isFinite(previousAge) &&
    previousAge <= PREVIOUS_POINT_MAX_AGE_MS;
  const previousRatio = comparable ? currentVolumePools / previousPools : null;
  if (comparable && !(previousRatio >= minPreviousShare))
    failures.push(
      `Only ${currentVolumePools} pools carry a current 24h volume, ${percent(previousRatio)}% of the ${previousPools} behind the previous snapshot's volume (${new Date(previousPoint.timestamp).toISOString()}); at least ${percent(minPreviousShare)}% are required, so a thin sample is not recorded as a fall in volume. The next run compares again; after a day without a point nothing is compared.`,
    );
  return {
    ok: failures.length === 0,
    failures,
    checks: {
      currentPools,
      currentVolumePools,
      observedPools,
      plannedPools,
      requestedPools,
      checkedPools: answeredPools,
      share,
      answeredShare,
      currentShare,
      previousPools: comparable ? previousPools : null,
      previousRatio,
      minCurrent,
      minShare,
      minCurrentShare,
      minPreviousShare,
    },
  };
}
