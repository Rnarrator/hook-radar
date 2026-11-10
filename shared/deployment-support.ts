export interface DeploymentSupportEvidence {
  readonly status: "not-published";
  readonly chain: string;
  readonly chainId: number;
  /** Date of a human-readable source review, never a live indexing timestamp. */
  readonly reviewedAt: string;
  readonly label: string;
  readonly description: string;
  readonly sources: readonly {
    readonly label: string;
    readonly url: string;
  }[];
}

/** A chain's presence in hooklist/chains.json only supplies network metadata.
 * It does not establish a deployed v4 PoolManager. These dated source reviews
 * explain that distinction; they never manufacture an empty completed index. */
const reviewedSupport: readonly DeploymentSupportEvidence[] = Object.freeze([
  Object.freeze({
    status: "not-published" as const,
    chain: "zksync",
    chainId: 324,
    reviewedAt: "2026-10-17",
    label: "No published v4 deployment",
    description:
      "Uniswap lists ZKsync as supporting v3. Its official deployment manifest does not publish a v4 PoolManager for this network. Hook registry listings do not establish a canonical v4 deployment.",
    sources: Object.freeze([
      Object.freeze({
        label: "Uniswap network support",
        url: "https://support.uniswap.org/hc/en-us/articles/14569415293325-Networks-on-Uniswap",
      }),
      Object.freeze({
        label: "Official v4 deployments",
        url: "https://developers.uniswap.org/docs/protocols/v4/deployments",
      }),
      Object.freeze({
        label: "Deployment manifest",
        url: "https://developers.uniswap.org/deployments.json",
      }),
    ]),
  }),
]);

/** Present reviewed absence only for the exact network, without overriding a
 * newer canonical index. This is explanatory metadata, not an indexing policy:
 * a future verified deployment must remain free to enter the canonical census. */
export function deploymentSupportForNetwork({
  chain,
  chainId,
  indexedManager,
}: {
  chain: string;
  chainId: number | null;
  indexedManager?: string | null;
}): DeploymentSupportEvidence | null {
  if (
    typeof indexedManager === "string" &&
    /^0x[\da-f]{40}$/i.test(indexedManager) &&
    !/^0x0{40}$/i.test(indexedManager)
  )
    return null;
  return (
    reviewedSupport.find(
      (network) => network.chain === chain && network.chainId === chainId,
    ) || null
  );
}
