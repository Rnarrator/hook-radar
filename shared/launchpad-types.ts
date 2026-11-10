/** Source-backed launchpad platforms, reviewed 2026-10-23.
 *
 * Model: launchpad (consumer product) → underlying protocol → exact hooks and
 * pools. A launchpad is a platform listing: it carries identity, status and the
 * exact contracts its own first-party documentation or application publishes.
 * It carries no market total of its own: the Launchpads list sums the measured pools of the exact hooks it publishes, and nothing else. Hooks shared with another protocol (for
 * example Doppler's shared initializer) stay attributed to that protocol, so
 * their pools and volume are counted once, in the protocol's own record.
 *
 * Nothing here is inferred from a name. A hook appears only if a first-party
 * source (docs, official repository, status page or the platform's own app)
 * names that exact address on that chain. Name matches in third-party lists are
 * recorded as `unattributed`, never as ownership. Statuses preserve the
 * distinction between live, restricted, deprecated, planned and unverified.
 * Research evidence: work/launchpad-expansion-2026-10-23/research/. */

export const LAUNCHPAD_REVIEWED_AT = "2026-10-23";

export type LaunchpadStatus =
  "live" | "restricted" | "deprecated" | "planned" | "unverified";
export type LaunchpadPoolKind = "hooked" | "hookless" | "unknown";
export type LaunchpadUniswapVersion = "v4" | "v3" | "own-curve" | "unknown";
export type LaunchpadRelationship =
  "own-protocol" | "built-on-shared-protocol" | "multiple" | "unresolved";
/** `platform-hook`: the platform's own published hook. `shared-protocol`:
 * infrastructure used by many launchers, counted under the protocol. `none`:
 * this path creates no Uniswap v4 hook pool. */
export type LaunchpadAttribution = "platform-hook" | "shared-protocol" | "none";

export interface LaunchpadEvidence {
  readonly url: string;
  readonly note: string;
}

export interface LaunchpadHook {
  readonly address: string; // lowercase 0x…
  readonly name: string;
  readonly role: string;
  /** Uniswap v4 permission flags: the low 14 bits of the hook address. */
  readonly permissions: number;
  /** Where the exact address comes from. `on-chain-link`: the platform does not
   * name this hook itself; it is read on chain from a contract the platform
   * does list (for example a factory's hookAddress() or a launcher's hook). */
  readonly source:
    | "docs"
    | "official-repo"
    | "status-page"
    | "platform-app"
    | "on-chain-link";
}

export interface LaunchpadContract {
  readonly address: string;
  readonly name: string;
  readonly role: string;
}

export interface LaunchpadPath {
  readonly id: string;
  readonly label: string;
  readonly chain: string;
  readonly chainId: number;
  readonly uniswapVersion: LaunchpadUniswapVersion;
  readonly poolKind: LaunchpadPoolKind;
  readonly status: LaunchpadStatus;
  readonly attribution: LaunchpadAttribution;
  /** The platform deploys a separate hook for every launch (its docs say so),
   * so no single hook address can be published and none is listed here. Pools
   * and volume stay unattributed rather than sampled from a few launches. */
  readonly perLaunchHooks?: boolean;
  /** Radar project id of the shared protocol the hooks belong to. */
  readonly protocolId?: string;
  readonly summary: string;
  readonly hooks: readonly LaunchpadHook[];
  /** Launch factories/launchers the platform publishes for this path. */
  readonly contracts: readonly LaunchpadContract[];
  readonly evidence: readonly LaunchpadEvidence[];
}

export interface LaunchpadRecord {
  readonly id: string;
  readonly name: string;
  readonly website: string;
  readonly docs: string;
  readonly description: string;
  readonly status: LaunchpadStatus;
  readonly statusNote: string;
  /** Review date when it differs from LAUNCHPAD_REVIEWED_AT (later additions). */
  readonly reviewedAt?: string;
  readonly relationship: LaunchpadRelationship;
  /** Plain-language relationship to underlying protocols. */
  readonly relationshipNote: string;
  /** Third-party name matches that are deliberately NOT attributed. */
  readonly unattributed?: readonly string[];
  readonly paths: readonly LaunchpadPath[];
  readonly unresolved: readonly string[];
}

export const POOL_MANAGER = {
  ethereum: "0x000000000004444c5dc75cb358380d2e3de08a90",
  base: "0x498581ff718922c3f8e6a244956af099b2652b2b",
  robinhood: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  arc: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  bnb: "0x28e2ea090877bf75740558f6bfb36a5ffee9e9df",
} as const;

export const poolManager = (
  chain: keyof typeof POOL_MANAGER,
): LaunchpadContract => ({
  address: POOL_MANAGER[chain],
  name: "Uniswap v4 PoolManager",
  role: "Shared Uniswap infrastructure; not owned by the platform",
});
