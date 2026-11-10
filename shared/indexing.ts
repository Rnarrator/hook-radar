/** Completeness concerns the proven head; source availability is a separate state. */
export function networkCaughtUp(network: {
  targetBlock: number | null;
  scannedToBlock: number;
}) {
  return (
    network.targetBlock !== null &&
    network.scannedToBlock >= network.targetBlock
  );
}

/** A saved head is historical evidence, not a promise that a source is still current. */
export function networkHeadFresh(
  network: { headCheckedAt?: string | null },
  now = Date.now(),
) {
  if (!network.headCheckedAt || !Number.isFinite(now)) return false;
  const checkedAt = Date.parse(network.headCheckedAt);
  const age = now - checkedAt;
  // Allow the same small clock skew accepted by the snapshot validator.
  return Number.isFinite(checkedAt) && age >= -60000 && age <= 10 * 60 * 1000;
}

/** Progress follows committed blocks, even while a newer head is being scanned. */
export function networkIndexProgress(network: {
  startBlock: number;
  targetBlock: number | null;
  scannedToBlock: number;
}) {
  if (networkCaughtUp(network)) return 100;
  if (network.targetBlock === null || network.targetBlock < network.startBlock)
    return 0;
  return Math.min(
    100,
    Math.max(
      0,
      (100 * (network.scannedToBlock - network.startBlock + 1)) /
        (network.targetBlock - network.startBlock + 1),
    ),
  );
}
