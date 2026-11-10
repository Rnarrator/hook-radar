import { HISTORY_MAX_POINTS, HISTORY_MIN_SPACING_MS } from "./config.mjs";

/** A recorded sum, to the cent. Adding many provider figures in floating point
 * leaves residue far below a cent (339226102.0600004), which is not a figure
 * anybody measured. Only sums are rounded, here and in the snapshot's summary;
 * a pool's own figures are kept exactly as the provider gave them. A value that
 * is not a finite number, or too large for cents to be exact, is returned as it
 * is, and so is a sum below half a cent: a figure above zero never becomes a
 * measured zero. */
export function roundCents(value) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    Math.abs(value) >= 1e13
  )
    return value;
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 && value !== 0 ? value : rounded;
}

/** The point one successful run adds: the tracked network-wide 24h volume over
 * the pools that were current, stamped with the oldest measurement behind it.
 * Null when no pool had a current 24h volume - then nothing is recorded. */
export function historyPointFor(summary) {
  const proof = summary.freshness?.volume?.h24;
  const value = summary.volumeUsd?.h24;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    !proof ||
    proof.currentPools < 1 ||
    typeof proof.oldestAt !== "string"
  )
    return null;
  const timestamp = Date.parse(proof.oldestAt);
  return Number.isFinite(timestamp)
    ? { timestamp, value: roundCents(value), pools: proof.currentPools }
    : null;
}

/** Newest last, strictly increasing, at least five minutes apart, capped. */
export function appendHistoryPoint(points, point) {
  const kept =
    points.length <= HISTORY_MAX_POINTS
      ? points
      : points.slice(-HISTORY_MAX_POINTS);
  const last = kept.at(-1);
  if (
    !point ||
    (last && point.timestamp - last.timestamp < HISTORY_MIN_SPACING_MS)
  )
    return kept;
  return [...kept, point].slice(-HISTORY_MAX_POINTS);
}

/** The chart series the snapshot carries: timestamp and value only. */
export const seriesOf = (points) =>
  points.map(({ timestamp, value }) => ({ timestamp, value }));
