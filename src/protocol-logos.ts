import type { RadarProject } from "../shared/types";
import { isOfficialHookFamily } from "../shared/official-hooks.ts";
import {
  isPublishedPlatformProject,
  getPublishedInfrastructureHook,
} from "../shared/published-platform-hooks.ts";
import { getLaunchpad } from "../shared/launchpad-registry.ts";
import { verifiedProtocolFamilies } from "./protocol-identities.ts";

// A public file's path under the build base (the static edition's sub-paths).
export { publicAsset } from "./edition.ts";

export interface ProtocolArtwork {
  protocol: string;
  src: string;
  /** The original file is dark on transparent, or colours itself by the
   * visitor's colour scheme, so it is shown unaltered on a light plate. The
   * manifest (public/protocols/sources.json) records the same value and why. */
  plate?: "light";
}

// Original first-party artwork. Provenance is recorded in public/protocols/sources.json.
// This identifies a directory family; it is not contract ownership verification.
export const protocolArtwork: Readonly<Record<string, ProtocolArtwork>> = {
  "pools-xyz": { protocol: "Pools.xyz", src: "/protocols/pools-xyz.svg" },
  bankr: { protocol: "Bankr", src: "/protocols/bankr.svg" },
  arrows: { protocol: "Arrows", src: "/protocols/arrows.png" },
  "hook-family": { protocol: "Hook.Family", src: "/protocols/hook-family.png" },
  "v4-fun": { protocol: "v4.fun", src: "/protocols/v4-fun.png" },
  "lolpad-fun": { protocol: "lolpad.fun", src: "/protocols/lolpad-fun.png" },
  bags: { protocol: "Bags", src: "/protocols/bags.png" },
  klik: { protocol: "Klik", src: "/protocols/klik.png" },
  solonpad: { protocol: "SolonPad", src: "/protocols/solonpad.svg" },
  pangea: { protocol: "Pangea", src: "/protocols/pangea.png" },
  eulerswap: { protocol: "Euler", src: "/protocols/brand-euler.svg" },
  clanker: { protocol: "Clanker", src: "/protocols/brand-clanker.png" },
  flaunch: { protocol: "Flaunch", src: "/protocols/brand-flaunch.svg" },
  frontier: { protocol: "Frontier", src: "/protocols/brand-frontier.svg" },
  zora: { protocol: "Zora", src: "/protocols/zora.png" },
  bunni: { protocol: "Bunni", src: "/protocols/brand-bunni.svg" },
  angstrom: { protocol: "Angstrom", src: "/protocols/brand-angstrom.svg" },
  doppler: { protocol: "Doppler", src: "/protocols/brand-doppler.svg" },
  arrakis: { protocol: "Arrakis", src: "/protocols/brand-arrakis.png" },
  aegis: { protocol: "Aegis", src: "/protocols/other-aegis.svg" },
  alphix: { protocol: "Alphix", src: "/protocols/alphix.svg" },
  phi: { protocol: "Phi", src: "/protocols/other-phi.png" },
  glue: { protocol: "GlueHook", src: "/protocols/other-gluehook.png" },
  cork: { protocol: "Cork", src: "/protocols/brand-cork.svg" },
  claus: { protocol: "Claus", src: "/protocols/claus.png" },
  vectis: { protocol: "Vectis", src: "/protocols/vectis.svg" },
  unipeg: { protocol: "Unipeg", src: "/protocols/unipeg.png" },
  kyberswap: {
    protocol: "KyberSwap FairFlow",
    src: "/protocols/kyberswap.png",
  },
  fables: { protocol: "Fables", src: "/protocols/fables.svg" },
  hookr: { protocol: "Hookr", src: "/protocols/hookr.svg" },
  pons: { protocol: "pons", src: "/protocols/pons.png" },
  letscash: { protocol: "letscash.fun", src: "/protocols/letscash.png" },
  umia: { protocol: "Umia", src: "/protocols/umia.svg" },
  fwa: { protocol: "Fake World Assets", src: "/protocols/fwa.png" },
  coinbase: { protocol: "Coinbase", src: "/protocols/coinbase.png" },
  slvr: { protocol: "SLVR", src: "/protocols/slvr.png" },
  aztec: { protocol: "Aztec", src: "/protocols/aztec.png" },
  tokenworks: { protocol: "TokenWorks", src: "/protocols/tokenworks.svg" },
  uniswap: { protocol: "Uniswap", src: "/protocols/uniswap.png" },
  arcfun: { protocol: "Arcfun", src: "/protocols/arcfun.png" },
  basestonk: { protocol: "BaseStonk", src: "/protocols/basestonk.png" },
  "bow-fun": { protocol: "Bow.fun", src: "/protocols/bow-fun.png" },
  "gwei-fun": { protocol: "gwei.fun", src: "/protocols/gwei-fun.svg" },
  "long-supply": { protocol: "Long.supply", src: "/protocols/long-supply.png" },
  minara: { protocol: "Minara", src: "/protocols/minara.svg" },
  "pmav-fun": { protocol: "pmav.fun", src: "/protocols/pmav-fun.svg" },
  robinvista: { protocol: "RobinVista", src: "/protocols/robinvista.png" },
  "ubi-fun": { protocol: "ubi.fun", src: "/protocols/ubi-fun.svg" },
  uniderp: { protocol: "Uniderp", src: "/protocols/uniderp.svg" },
  unihood: { protocol: "Unihood", src: "/protocols/unihood.png" },
  bonker: { protocol: "Bonker", src: "/protocols/bonker.svg" },
  robinseed: { protocol: "RobinSeed", src: "/protocols/robinseed.png" },
  "faze-fun": { protocol: "faze.fun", src: "/protocols/faze-fun.png" },
  argus: { protocol: "Argus", src: "/protocols/argus.svg" },
  duckpad: { protocol: "Duckpad", src: "/protocols/duckpad.png" },
  noice: { protocol: "Noice", src: "/protocols/noice.svg", plate: "light" },
  hooke: { protocol: "Hooke", src: "/protocols/hooke.svg", plate: "light" },
};

/** Registry launchpad listing id → artwork key. Platforms without usable
 * first-party artwork (mint.fast, Livo, aka.fun, Long.xyz, ZNS Launchpad;
 * reasons in public/protocols/sources.json) stay neutral. Hookr and Pons reuse
 * the artwork already verified for their hook families. */
const launchpadBrands: Readonly<Record<string, string>> = {
  bankr: "bankr",
  arrows: "arrows",
  "hook-family": "hook-family",
  "v4-fun": "v4-fun",
  "hookr-fun": "hookr",
  "lolpad-fun": "lolpad-fun",
  pons: "pons",
  bags: "bags",
  klik: "klik",
  solonpad: "solonpad",
  pangea: "pangea",
  umia: "umia",
  "arcfun": "arcfun",
  "basestonk": "basestonk",
  "bow-fun": "bow-fun",
  "gwei-fun": "gwei-fun",
  "long-supply": "long-supply",
  "minara": "minara",
  "pmav-fun": "pmav-fun",
  "robinvista": "robinvista",
  "ubi-fun": "ubi-fun",
  "uniderp": "uniderp",
  "unihood": "unihood",
  "letscash-fun": "letscash",
  tokenworks: "tokenworks",
  bonker: "bonker",
  robinseed: "robinseed",
  "faze-fun": "faze-fun",
  argus: "argus",
  duckpad: "duckpad",
  noice: "noice",
  hooke: "hooke",
};

const familyBrands: Readonly<Record<string, { name: string; brand: string }>> =
  {
    eulerswap: { name: "EulerSwap", brand: "eulerswap" },
    clanker: { name: "Clanker", brand: "clanker" },
    flaunch: { name: "Flaunch", brand: "flaunch" },
    frontier: { name: "Frontier", brand: "frontier" },
    zora: { name: "Zora", brand: "zora" },
    bunni: { name: "Bunni", brand: "bunni" },
    angstrom: { name: "Angstrom", brand: "angstrom" },
    doppler: { name: "Doppler", brand: "doppler" },
    arrakis: { name: "Arrakis", brand: "arrakis" },
    alphix: { name: "Alphix", brand: "alphix" },
  };

/** Match every contract to the first-party deployment list, never its name. */
export function isOfficialUniswapHookFamily(
  project: Pick<RadarProject, "deployments">,
) {
  return isOfficialHookFamily(project);
}

/** Reviewed artwork for a complete family or one explicitly scoped contract. */
export function getVerifiedProtocolArtwork(
  project: Pick<RadarProject, "id" | "name" | "description" | "deployments">,
): ProtocolArtwork | null {
  const verified = verifiedProtocolFamilies[project.id];
  if (
    verified &&
    project.name === verified.name &&
    project.deployments.length > 0 &&
    project.deployments.every((deployment) =>
      verified.deployments.some(
        (known) =>
          deployment.chain === known.chain &&
          (deployment.chainId == null ||
            deployment.chainId === known.chainId) &&
          deployment.address.toLowerCase() === known.address,
      ),
    )
  )
    return protocolArtwork[verified.brand];
  return null;
}

export function getProtocolArtwork(
  project: Pick<RadarProject, "id" | "name" | "description" | "deployments">,
): ProtocolArtwork | null {
  if (isPublishedPlatformProject(project)) return protocolArtwork["pools-xyz"];
  // A reviewed launchpad listing: exact id, name, description and no contracts.
  const launchpad = getLaunchpad(project.id);
  if (
    launchpad &&
    project.name === launchpad.name &&
    project.description === launchpad.description &&
    project.deployments.length === 0
  ) {
    const brand = launchpadBrands[launchpad.id];
    return brand ? protocolArtwork[brand] : null;
  }
  const family = familyBrands[project.id];
  if (family && project.name === family.name)
    return protocolArtwork[family.brand];

  const verified = getVerifiedProtocolArtwork(project);
  if (verified) return verified;

  if (
    project.id === "aegis" &&
    project.name === "Aegis" &&
    project.deployments.some(
      (deployment) =>
        deployment.chain === "unichain" &&
        [
          "0xa0b0d2d00fd544d8e0887f1a3cedd6e24baf10cc",
          "0x88c9ff9fc0b22cca42265d3f1d1c2c39e41cdacc",
        ].includes(deployment.address.toLowerCase()),
    )
  )
    return protocolArtwork.aegis;

  if (
    project.id === "hook-5af6ede0232aac0909f1" &&
    project.name === "Cork AMM" &&
    project.deployments.length === 1 &&
    project.deployments[0].chain === "ethereum" &&
    project.deployments[0].address.toLowerCase() ===
      "0x5287e8915445aee78e10190559d8dd21e0e9ea88"
  )
    return protocolArtwork.cork;

  if (
    project.id === "hook-c3df54eb19b885a45bfa" &&
    project.name === "GlueHook" &&
    project.deployments.some((deployment) =>
      [
        "0x03d482cb3ff339c2d29736818d0f72c66dd6a040",
        "0x0f41715dc432692b66a5adf8dcfef6ac407b20c8",
      ].includes(deployment.address.toLowerCase()),
    )
  )
    return protocolArtwork.glue;

  // Phi's official documentation describes PhiEth wrapping and Publiphi pools.
  const phiFamily =
    (project.id === "hook-db5cf245760485085711" &&
      project.name === "PhiEthHooks" &&
      /phieth/i.test(project.description)) ||
    (project.id === "hook-8725c5797bb5e367a877" &&
      project.name === "BoardHook" &&
      /publiphi/i.test(project.description));
  if (
    phiFamily &&
    project.deployments.length > 0 &&
    project.deployments.every((deployment) => deployment.chain === "base")
  )
    return protocolArtwork.phi;

  // Do not brand a same-named clone or a mixed family as an official Labs hook.
  if (isOfficialUniswapHookFamily(project)) return protocolArtwork.uniswap;
  if (
    project.deployments.length > 0 &&
    project.deployments.every((deployment) =>
      getPublishedInfrastructureHook(deployment),
    )
  )
    return protocolArtwork.uniswap;

  return null;
}
