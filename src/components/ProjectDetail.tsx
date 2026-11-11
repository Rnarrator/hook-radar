import { ProtocolLogo } from "./ProtocolLogo";
import { PlatformDetail } from "./PlatformDetail";
import type {
  PlatformAvailability,
  PlatformRelationship,
} from "./PlatformDetail";
import type { ComponentProps } from "react";
import { useEffect, useState, useMemo, useId, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type {
  HookDeployment,
  RadarProject,
  RadarSnapshot,
  WindowKey,
  Pool,
  TokenMetadata,
} from "../../shared/types";
import type { ProjectContext } from "../../shared/project-view";
import type { DetailTab, ExtensionSelection } from "../navigation";
import { publicViewUrl } from "../navigation";
import {
  count,
  money,
  relativeTime,
  safeUrl,
  shortAddress,
  windows,
} from "../model";
import { FamilyFingerprint, MetricMeasurement } from "../MarketProvenance";
import { measurementProvenance } from "../provenance";
import { External, Empty } from "./Primitives";
import { isPoolPage, marketDataFirst } from "../pool-page";
import { networkCaughtUp } from "../../shared/indexing";
import {
  currentMetricValue,
  isMarketFreshness,
  marketMeasurementState,
  observedMetricValue,
} from "../../shared/market-freshness";
import type { MetricFreshness } from "../../shared/types";
import { isProjectHistoryUpdating } from "../project-history";
import {
  getProtocolArtwork,
  getVerifiedProtocolArtwork,
} from "../protocol-logos";
import type { ProtocolArtwork } from "../protocol-logos";
import { matchesHookSearch } from "../project-search";
import {
  discoverySummary,
  emptyPoolsCopy,
  hookControlLabels,
  measuredNetworks,
  networksReadout,
  orderedPools,
  poolControlLabels,
  poolNetworks,
  poolWording,
  projectCoverageNote,
  projectIdentity,
  projectInspection,
  projectPoolCount,
  setupNetworks,
  showMoreLabel,
  tagDigits,
} from "../project-presentation";
import { HookExtensions } from "./HookExtensions";
import { ArchivedHistory } from "./ArchivedHistory";
import { PermissionGlyph, PermissionGlyphKey } from "./PermissionGlyph";
import { CallbackSignature } from "./CallbackSignature";
import { callbackSignature, hookCapabilities } from "../comparison";
import { useFrontierExtensionCount } from "../useFrontierExtensionCount";
import {
  isTokenMetadataResponse,
  nativeCurrencyAddress,
  poolCurrencyAddresses,
  poolNameWithMetadata,
  tokenMetadataKey,
} from "../token-metadata";
import "./project-detail.css";
import {
  STATIC_EDITION,
  censusHeading,
  evaluationNow,
  fullTimeLabel,
} from "../edition";
import {
  Info,
  Star,
  Copy,
  ChevronDown,
  Search,
  Code2,
  RefreshCw,
  Layers,
  ArrowRight,
  ExternalLink,
  X,
} from "./Icons";

export type { PlatformAvailability, PlatformRelationship };

export function ProjectDetail({
  platformRelationships,
  platformAvailability,
  ...props
}: ComponentProps<typeof HookProjectDetail> & {
  /** Source-backed launchpad → protocol → hooks/pools links (lead-supplied). */
  platformRelationships?: PlatformRelationship[];
  /** Checked availability of a platform listing; absent means unverified. */
  platformAvailability?: PlatformAvailability;
}) {
  return props.project.entityType === "platform" ? (
    <PlatformDetail
      project={props.project}
      chains={props.snapshot.chains}
      watchlisted={props.watchlisted}
      toggleWatch={props.toggleWatch}
      copy={props.copy}
      relationships={platformRelationships}
      availability={platformAvailability}
    />
  ) : (
    <HookProjectDetail {...props} />
  );
}

function HookProjectDetail({
  project,
  duplicateName,
  snapshot,
  watchlisted,
  toggleWatch,
  copy,
  windowKey,
  tab,
  setTab,
  checkingHistory = false,
  savedContext = false,
  refreshPoolHistory,
  onCompare,
  compared = false,
  onActivity,
  initialChain = "all",
  extensionSelection = null,
  onExtensionSelection,
}: {
  project: RadarProject;
  duplicateName: boolean;
  /** The edition passes the whole snapshot, so the drawer can say when it was
   * taken and which networks it measured. */
  snapshot: ProjectContext &
    Partial<Pick<RadarSnapshot, "generatedAt" | "marketCoverage" | "coverage">>;
  watchlisted: boolean;
  toggleWatch: () => void;
  copy: (text: string, success: string) => Promise<void>;
  windowKey: WindowKey;
  tab: DetailTab;
  setTab: (tab: DetailTab) => void;
  checkingHistory?: boolean;
  savedContext?: boolean;
  refreshPoolHistory?: () => Promise<void>;
  onCompare?: () => void;
  compared?: boolean;
  onActivity?: (
    chain: string,
    scope?: { poolId: string; hookAddress: string },
  ) => void;
  initialChain?: string;
  extensionSelection?: ExtensionSelection | null;
  onExtensionSelection?: (selection: ExtensionSelection | null) => void;
}) {
  const detailRoot = useRef<HTMLDivElement>(null);
  const [rechecking, setRechecking] = useState(false);
  // The snapshot edition's Retry has run at least once since the notice appeared;
  // while the notice is still up afterwards, that retry failed too.
  const [recheckTried, setRecheckTried] = useState(false);
  // Set when a "Show more pools" or "Show more" (hooks) click will remove its
  // own button.
  const focusPoolFrom = useRef<number | null>(null);
  const focusHookFrom = useRef<number | null>(null);
  const localExtensionChoice = useRef<string | null>(null);
  const pendingExtensionLanding = useRef<{
    key: string;
    scrollTop: number | null;
  } | null>(null);
  function exploreTab(next: DetailTab, extensions = false) {
    if (extensions) {
      const eligible = project.deployments.find(
        (deployment) => deployment.chainId === 4663,
      );
      if (eligible) {
        openExtensions(eligible);
        return;
      }
    }
    setTab(next);
    requestAnimationFrame(() => {
      const target =
        (extensions &&
          detailRoot.current?.querySelector<HTMLButtonElement>(
            ".extensions-toggle",
          )) ||
        detailRoot.current?.querySelector<HTMLButtonElement>(
          next === "deployments" ? "#deployment-tab" : "#pool-tab",
        );
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: "nearest" });
    });
  }
  function handleTabKey(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? "pools"
        : event.key === "End"
          ? "deployments"
          : tab === "deployments"
            ? "pools"
            : "deployments";
    setTab(next);
    event.currentTarget.parentElement
      ?.querySelector<HTMLButtonElement>(
        next === "deployments" ? "#deployment-tab" : "#pool-tab",
      )
      ?.focus();
  }

  const [chain, setChain] = useState(initialChain);
  const [search, setSearch] = useState("");
  const hookSearchInput = useRef<HTMLInputElement>(null);
  const projectNetworkSelect = useRef<HTMLSelectElement>(null);
  const [poolSearch, setPoolSearch] = useState("");
  const [poolQuery, setPoolQuery] = useState("");
  const poolSearchInput = useRef<HTMLInputElement>(null);
  const [limit, setLimit] = useState(20);
  useEffect(() => {
    const pool = focusPoolFrom.current;
    const hook = focusHookFrom.current;
    focusPoolFrom.current = null;
    focusHookFrom.current = null;
    for (const [first, card] of [
      [pool, ".pool-card"],
      [hook, ".deployment-card"],
    ] as const) {
      if (first === null) continue;
      const cards = detailRoot.current?.querySelectorAll(card);
      cards?.[first]?.querySelector<HTMLElement>("a[href], button")?.focus();
    }
  }, [limit]);
  const [indexedPools, setIndexedPools] = useState<Pool[]>([]);
  const [poolTotal, setPoolTotal] = useState<number | null>(null);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [requestCursor, setRequestCursor] = useState<string | null>(null);
  const [poolLoading, setPoolLoading] = useState(false);
  const [poolError, setPoolError] = useState("");
  const [poolSaving, setPoolSaving] = useState(false);
  const [poolRestartNeeded, setPoolRestartNeeded] = useState(false);
  const [poolGenerationMismatch, setPoolGenerationMismatch] = useState(false);
  const [poolRecovering, setPoolRecovering] = useState(false);
  const [requestOffset, setRequestOffset] = useState(0);
  const [poolRetry, setPoolRetry] = useState(0);
  const replacementToken = project.poolInventory?.replacementToken;
  const poolScope = `${project.id}:${chain}:${replacementToken || ""}`;
  const [poolRequestScope, setPoolRequestScope] = useState(poolScope);
  const poolScopeChanged = poolRequestScope !== poolScope;
  const poolViewError = poolScopeChanged ? "" : poolError;
  const poolViewSaving = !poolScopeChanged && poolSaving;
  const currentPoolScope = useRef(poolScope);
  currentPoolScope.current = poolScope;
  const indexedReplacementToken = useRef<string | undefined>(undefined);
  const [dataExpanded, setDataExpanded] = useState(false);
  const [controlsExpanded, setControlsExpanded] = useState(false);
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const controlDetailsId = useId();
  const overviewHeadingId = useId();
  const [tokenMetadataCache, setTokenMetadataCache] = useState(
    () =>
      new Map<string, { metadata: TokenMetadata | null; checkedAt: number }>(),
  );
  const [tokenNamesLoading, setTokenNamesLoading] = useState(false);
  const [tokenNamesErrorScope, setTokenNamesErrorScope] = useState("");
  const discovered =
    project.deployments.length > 0 &&
    project.deployments.every(
      (deployment) => deployment.discovery === "onchain",
    );
  // A hook found in the census is only as current as the census; the edition
  // says when that was.
  const census = STATIC_EDITION ? censusHeading(snapshot.inventory) : null;
  const identity = projectIdentity(project, { census });
  const publishedIdentity = project.deployments.some(
    (deployment) => deployment.discovery === "published",
  );
  const inspection = projectInspection(project);
  const controlsSignature = callbackSignature(project);
  const abilities = hookCapabilities(project);
  const setupPoolCount = projectPoolCount(project);
  const familyArtwork = getProtocolArtwork(project);
  const verifiedProtocolName = getVerifiedProtocolArtwork(project)?.protocol;
  // Frontier's extension catalog is read from a live service the static edition
  // does not have.
  const hasExtensions =
    !STATIC_EDITION && familyArtwork?.protocol === "Frontier";
  const canExploreExtensions =
    hasExtensions && project.deployments.some((hook) => hook.chainId === 4663);
  // The drawer only reuses a catalog the list already read or the explorer has
  // loaded; opening a drawer never asks the service on its own.
  const frontierExtensions = useFrontierExtensionCount(
    canExploreExtensions
      ? project.deployments
          .filter((hook) => hook.chainId === 4663)
          .map((hook) => hook.address)
      : [],
    false,
  );
  const selectedExtensionHook =
    extensionSelection &&
    project.deployments.find(
      (hook) =>
        hook.chainId === 4663 &&
        hook.chain === extensionSelection.chain &&
        hook.address.toLowerCase() === extensionSelection.hookAddress,
    );
  function focusExtensions(hookAddress: string) {
    const body = detailRoot.current;
    const target = body?.querySelector<HTMLButtonElement>(
      `[data-hook-address="${hookAddress}"] .extensions-toggle`,
    );
    if (!body || !target) return;
    target.focus({ preventScroll: true });
    const tabsHeight =
      body.querySelector(".detail-tabs")?.getBoundingClientRect().height || 0;
    body.scrollTo({
      top:
        body.scrollTop +
        target.getBoundingClientRect().top -
        body.getBoundingClientRect().top -
        tabsHeight -
        12,
      behavior: "instant",
    });
  }
  function beginExtensionLanding(hookAddress: string, poolId: string) {
    const pending = {
      key: `${hookAddress}:${poolId}`,
      scrollTop: null as number | null,
    };
    pendingExtensionLanding.current = pending;
    return requestAnimationFrame(() => {
      if (pendingExtensionLanding.current !== pending) return;
      focusExtensions(hookAddress);
      pending.scrollTop = detailRoot.current?.scrollTop ?? null;
    });
  }
  function completeExtensionLanding(hookAddress: string, poolId: string) {
    const pending = pendingExtensionLanding.current;
    const body = detailRoot.current;
    if (!body || !pending || pending.key !== `${hookAddress}:${poolId}`) return;
    if (pending.scrollTop === null) return;
    pendingExtensionLanding.current = null;
    const target = body.querySelector(
      `[data-hook-address="${hookAddress}"] .extensions-toggle`,
    );
    // A slow response may expand content after the initial scroll was clamped.
    // Complete that navigation once, unless the user has moved elsewhere.
    if (
      Math.abs(body.scrollTop - pending.scrollTop) <= 1 &&
      document.activeElement === target
    )
      focusExtensions(hookAddress);
  }
  function openExtensions(
    deployment: HookDeployment,
    poolId = "",
    reveal = true,
  ) {
    if (!hasExtensions || deployment.chainId !== 4663 || !onExtensionSelection)
      return;
    setChain(deployment.chain);
    setSearch("");
    setLimit(Math.max(20, project.deployments.indexOf(deployment) + 1));
    localExtensionChoice.current = reveal
      ? null
      : `${deployment.address.toLowerCase()}:${poolId.toLowerCase()}`;
    pendingExtensionLanding.current = null;
    onExtensionSelection({
      chain: "robinhood",
      hookAddress: deployment.address.toLowerCase(),
      poolId: poolId.toLowerCase(),
    });
    if (reveal)
      beginExtensionLanding(
        deployment.address.toLowerCase(),
        poolId.toLowerCase(),
      );
  }
  useEffect(() => {
    if (!extensionSelection || !selectedExtensionHook) {
      pendingExtensionLanding.current = null;
      return;
    }
    setChain(selectedExtensionHook.chain);
    setSearch("");
    setLimit(
      Math.max(20, project.deployments.indexOf(selectedExtensionHook) + 1),
    );
    const choice = `${extensionSelection.hookAddress}:${extensionSelection.poolId}`;
    if (localExtensionChoice.current === choice) {
      localExtensionChoice.current = null;
      pendingExtensionLanding.current = null;
      return;
    }
    localExtensionChoice.current = null;
    const frame = beginExtensionLanding(
      extensionSelection.hookAddress,
      extensionSelection.poolId,
    );
    return () => cancelAnimationFrame(frame);
  }, [
    extensionSelection?.chain,
    extensionSelection?.hookAddress,
    extensionSelection?.poolId,
    Boolean(selectedExtensionHook),
  ]);
  const chainName = (slug: string) =>
    snapshot.chains.find((network) => network.slug === slug)?.name || slug;
  const chainExplorer = (slug: string) =>
    snapshot.chains.find((network) => network.slug === slug)?.explorer;
  const deployments = project.deployments.filter(
    (deployment) =>
      (chain === "all" || deployment.chain === chain) &&
      matchesHookSearch(deployment, search, chainName(deployment.chain)),
  );
  const hookFiltersActive = chain !== "all" || Boolean(search.trim());
  // How much of an address the edition's per-hook control names carry, enough to
  // tell every hook of this project apart.
  const hookTagDigits = useMemo(
    () =>
      STATIC_EDITION
        ? tagDigits(project.deployments.map((hook) => hook.address))
        : 4,
    [project.deployments],
  );
  const allProjectPools = useMemo(
    () => snapshot.pools.filter((pool) => pool.projectId === project.id),
    [snapshot.pools, project.id],
  );
  const hasUnlistedChainHooks =
    chain !== "all" &&
    !search.trim() &&
    !deployments.length &&
    ((project.poolInventory?.chains[chain] || 0) > 0 ||
      allProjectPools.some((pool) => pool.chain === chain));
  const projectNetworks = useMemo(
    () => [
      ...new Set([
        ...project.chains,
        ...project.deployments.map((hook) => hook.chain),
        ...allProjectPools.map((pool) => pool.chain),
        ...Object.entries(project.poolInventory?.chains || {})
          .filter(([, pools]) => pools > 0)
          .map(([network]) => network),
      ]),
    ],
    [
      project.chains,
      project.deployments,
      project.poolInventory,
      allProjectPools,
    ],
  );
  const pricedPoolCount = allProjectPools.filter((pool) =>
    [
      currentMetricValue(pool, windowKey, evaluationNow()),
      currentMetricValue(pool, "liquidity", evaluationNow()),
    ].some((value) => value !== null),
  ).length;
  const hasSavedUsdObservations = allProjectPools.some((pool) =>
    [
      observedMetricValue(pool, windowKey),
      observedMetricValue(pool, "liquidity"),
    ].some((value) => value !== null),
  );
  const tokenMetadata = useMemo(
    () =>
      new Map(
        [...tokenMetadataCache].flatMap(([key, entry]) =>
          entry.metadata ? [[key, entry.metadata] as const] : [],
        ),
      ),
    [tokenMetadataCache],
  );
  // The edition lists the largest pools first; the live list keeps its order.
  const rankedProjectPools = useMemo(
    () => orderedPools(allProjectPools, windowKey, evaluationNow()),
    [allProjectPools, windowKey],
  );
  const measuredPools = rankedProjectPools.filter(
    (pool) =>
      (chain === "all" || pool.chain === chain) &&
      (!poolQuery ||
        [
          pool.name,
          poolNameWithMetadata(pool, tokenMetadata),
          pool.address,
          pool.hookAddress || "",
          ...pool.tokens,
        ].some((value) =>
          value.toLowerCase().includes(poolQuery.toLowerCase()),
        )),
  );
  const poolSearchPending = poolSearch.trim() !== poolQuery;
  // A new scope has no accepted page before its request effect starts. Keep
  // that interval busy instead of briefly presenting an unverified empty list.
  const poolViewLoading =
    poolLoading ||
    Boolean(
      project.poolInventory &&
      (poolScopeChanged ||
        (poolTotal === null &&
          !poolViewError &&
          !poolViewSaving &&
          !poolRestartNeeded)),
    );
  const scopeComplete =
    chain === "all"
      ? project.poolInventory?.complete
      : snapshot.inventory?.networks.some(
          (network) => network.chain === chain && networkCaughtUp(network),
        );
  const historyContext = savedContext || checkingHistory;
  // Once the check works again the notice is gone, and a later failure is a new one.
  useEffect(() => {
    if (!historyContext) setRecheckTried(false);
  }, [historyContext]);
  const historyUpdating = isProjectHistoryUpdating(
    snapshot.inventory,
    project.chains,
    {
      savedContext: historyContext,
      chain,
    },
  );
  const projectHistoryUpdating = isProjectHistoryUpdating(
    snapshot.inventory,
    project.chains,
    {
      savedContext: historyContext,
    },
  );
  const scopedPoolCount =
    (poolScopeChanged ? null : poolTotal) ??
    (chain === "all"
      ? project.poolInventory?.poolCount || 0
      : project.poolInventory?.chains[chain] || 0);
  const prices = useMemo(
    () =>
      new Map(
        allProjectPools.map((pool) => [
          `${pool.chain}:${pool.address.toLowerCase()}`,
          pool,
        ]),
      ),
    [allProjectPools],
  );
  const pools = project.poolInventory
    ? (poolScopeChanged ? [] : indexedPools).map((pool) => {
        const newer = prices.get(`${pool.chain}:${pool.address.toLowerCase()}`);
        return newer &&
          (Date.parse(newer.metricUpdatedAt || "") || 0) >=
            (Date.parse(pool.metricUpdatedAt || "") || 0)
          ? {
              ...newer,
              poolKey: pool.poolKey || newer.poolKey,
              createdAt: pool.poolKey ? pool.createdAt : newer.createdAt,
              hookAddress: pool.poolKey
                ? pool.poolKey.hookAddress
                : newer.hookAddress,
              tokens: pool.poolKey
                ? [pool.poolKey.currency0, pool.poolKey.currency1]
                : newer.tokens,
            }
          : pool;
      })
    : measuredPools;
  const tokenNamesScope = `${project.id}:${pools.map((pool) => pool.id).join(",")}`;
  const metadataPoolIds = new Set<string>();
  const metadataPools = pools.filter((pool) => {
    const scopedId = `${pool.chain}:${pool.address.toLowerCase()}`;
    if (
      !pool.poolKey ||
      metadataPoolIds.size >= 50 ||
      metadataPoolIds.has(scopedId) ||
      !/^0x[\da-f]{64}$/i.test(pool.address)
    )
      return false;
    const unresolved = poolCurrencyAddresses(pool).some((address) => {
      if (address.toLowerCase() === nativeCurrencyAddress) return false;
      const cached = tokenMetadataCache.get(
        tokenMetadataKey(pool.chain, address),
      );
      return (
        !cached || (!cached.metadata && Date.now() - cached.checkedAt >= 60000)
      );
    });
    if (!unresolved) return false;
    metadataPoolIds.add(scopedId);
    return true;
  });
  const metadataRequestKey = metadataPools
    .map((pool) => `${pool.id}:${poolCurrencyAddresses(pool).join(",")}`)
    .join("|");
  useEffect(() => {
    if (
      STATIC_EDITION ||
      checkingHistory ||
      tab !== "pools" ||
      !metadataPools.length
    ) {
      setTokenNamesLoading(false);
      return;
    }
    const controller = new AbortController();
    let active = true;
    const timer = setTimeout(() => controller.abort(), 15000);
    const params = new URLSearchParams();
    for (const id of metadataPoolIds) params.append("pool", id);
    const requested = new Set(
      metadataPools.flatMap((pool) =>
        poolCurrencyAddresses(pool)
          .filter((address) => address.toLowerCase() !== nativeCurrencyAddress)
          .map((address) => tokenMetadataKey(pool.chain, address)),
      ),
    );
    const visible = new Set(
      pools.flatMap((pool) =>
        poolCurrencyAddresses(pool).map((address) =>
          tokenMetadataKey(pool.chain, address),
        ),
      ),
    );
    setTokenNamesLoading(true);
    setTokenNamesErrorScope("");
    const cacheResult = (rows: TokenMetadata[]) => {
      if (!active || controller.signal.aborted) return;
      const accepted = new Map(
        rows
          .filter((token) =>
            requested.has(tokenMetadataKey(token.chain, token.address)),
          )
          .map((token) => [
            tokenMetadataKey(token.chain, token.address),
            token,
          ]),
      );
      setTokenMetadataCache((previous) => {
        const next = new Map(previous);
        for (const key of requested) {
          const token = accepted.get(key);
          next.set(key, {
            metadata:
              token && token.status !== "unavailable"
                ? token
                : previous.get(key)?.metadata || null,
            checkedAt: Date.now(),
          });
        }
        for (const key of next.keys()) {
          if (next.size <= 2000) break;
          if (!visible.has(key)) next.delete(key);
        }
        return next;
      });
    };
    void fetch(
      `/api/projects/${encodeURIComponent(project.id)}/token-metadata?${params}`,
      {
        signal: controller.signal,
      },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error("Token metadata unavailable");
        const value: unknown = await response.json();
        if (!isTokenMetadataResponse(value, project.id))
          throw new Error("Invalid token metadata");
        cacheResult(value.tokens);
      })
      .catch(() => {
        if (!active) return;
        // Missing names never erase pool identities, market data, or pagination.
        if (!controller.signal.aborted) cacheResult([]);
        else {
          setTokenMetadataCache((previous) => {
            const next = new Map(previous);
            for (const key of requested)
              next.set(key, {
                metadata: previous.get(key)?.metadata || null,
                checkedAt: Date.now(),
              });
            return next;
          });
        }
        setTokenNamesErrorScope(tokenNamesScope);
      })
      .finally(() => {
        clearTimeout(timer);
        if (active) setTokenNamesLoading(false);
      });
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [project.id, tab, metadataRequestKey, checkingHistory]);
  useEffect(() => {
    setPoolRequestScope(poolScope);
    indexedReplacementToken.current = undefined;
    setIndexedPools([]);
    setPoolTotal(null);
    setNextOffset(null);
    setNextCursor(null);
    setRequestCursor(null);
    setRequestOffset(0);
    setPoolError("");
    setPoolRestartNeeded(false);
    setPoolGenerationMismatch(false);
    setPoolRecovering(false);
  }, [project.id, chain, replacementToken]);
  useEffect(() => {
    const next = poolSearch.trim();
    if (next === poolQuery) return;
    const timer = setTimeout(() => {
      setPoolQuery(next);
      setIndexedPools([]);
      setPoolTotal(null);
      setNextOffset(null);
      setNextCursor(null);
      setRequestCursor(null);
      setRequestOffset(0);
      setPoolError("");
      setPoolRestartNeeded(false);
      setPoolGenerationMismatch(false);
      if (tab === "pools" && project.poolInventory) setPoolLoading(true);
    }, 200);
    return () => clearTimeout(timer);
  }, [project.id, poolSearch, poolQuery, tab, Boolean(project.poolInventory)]);
  useEffect(() => {
    if (
      STATIC_EDITION ||
      checkingHistory ||
      poolScopeChanged ||
      tab !== "pools" ||
      !project.poolInventory
    ) {
      setPoolLoading(false);
      setPoolSaving(false);
      return;
    }
    let active = true;
    let controller: AbortController | null = null;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let nextAttemptAt = 0;
    let pausedForVisibility = false;
    setPoolSaving(false);
    const schedule = (wait: number) => {
      nextAttemptAt = Date.now() + wait;
      clearTimeout(retry);
      if (active && document.visibilityState !== "hidden")
        retry = setTimeout(load, wait);
    };
    const load = () => {
      if (!active || controller || document.visibilityState === "hidden")
        return;
      pausedForVisibility = false;
      nextAttemptAt = Date.now() + 5000;
      const current = new AbortController();
      controller = current;
      timeout = setTimeout(() => current.abort(), 15000);
      setPoolLoading(true);
      setPoolError("");
      setPoolRestartNeeded(false);
      void fetch(
        `/api/projects/${encodeURIComponent(project.id)}/pools?chain=${encodeURIComponent(chain)}&offset=${requestOffset}&limit=50${requestCursor ? `&after=${encodeURIComponent(requestCursor)}` : ""}${poolQuery ? `&q=${encodeURIComponent(poolQuery)}` : ""}`,
        { signal: current.signal },
      )
        .then(async (response) => {
          if (!response.ok) {
            if (response.status === 503) {
              const value: unknown = await response.json().catch(() => null);
              if (
                value &&
                typeof value === "object" &&
                "code" in value &&
                value.code === "POOL_HISTORY_SAVING"
              ) {
                if (
                  !active ||
                  current.signal.aborted ||
                  currentPoolScope.current !== poolScope
                )
                  return;
                setPoolSaving(true);
                const seconds = Number(response.headers.get("Retry-After"));
                schedule(
                  Number.isFinite(seconds)
                    ? Math.min(60000, Math.max(5000, seconds * 1000))
                    : 5000,
                );
                return;
              }
            }
            const needsRestart =
              response.status === 409 ||
              (response.status === 400 &&
                (requestCursor !== null || requestOffset > 0));
            if (active && !current.signal.aborted)
              setPoolRestartNeeded(needsRestart);
            if (
              active &&
              !current.signal.aborted &&
              currentPoolScope.current === poolScope &&
              response.status === 409 &&
              replacementToken !== undefined
            )
              setPoolGenerationMismatch(true);
            throw new Error(
              needsRestart
                ? "The pool list has changed. Reload it to continue with your current filters."
                : response.status === 400
                  ? "These pools couldn’t be opened. Try another search or network."
                  : "We couldn’t load these pools. Please try again.",
            );
          }
          const value: unknown = await response.json();
          if (!isPoolPage(value, project.id, { chain, limit: 50 }))
            throw new Error(
              "The pool data couldn’t be read. Please try again.",
            );
          if (
            !active ||
            current.signal.aborted ||
            currentPoolScope.current !== poolScope
          )
            return;
          if (
            (replacementToken !== undefined &&
              value.replacementToken !== replacementToken) ||
            (requestOffset > 0 &&
              indexedReplacementToken.current !== value.replacementToken)
          ) {
            setIndexedPools([]);
            setPoolTotal(null);
            setNextOffset(null);
            setNextCursor(null);
            setPoolRestartNeeded(true);
            setPoolGenerationMismatch(true);
            throw new Error(
              "The pool list has changed. Reload it to continue with your current filters.",
            );
          }
          setPoolSaving(false);
          setPoolGenerationMismatch(false);
          indexedReplacementToken.current = value.replacementToken;
          setIndexedPools((previous) =>
            requestOffset === 0
              ? marketDataFirst(value.pools)
              : [
                  ...new Map(
                    [...previous, ...marketDataFirst(value.pools)].map(
                      (pool) => [pool.id, pool],
                    ),
                  ).values(),
                ],
          );
          setPoolTotal(value.total);
          setNextOffset(value.nextOffset);
          setNextCursor(value.nextCursor || null);
        })
        .catch((error) => {
          if (
            active &&
            currentPoolScope.current === poolScope &&
            !pausedForVisibility &&
            document.visibilityState !== "hidden"
          ) {
            setPoolSaving(false);
            setPoolError(
              controller?.signal.aborted
                ? "Loading took longer than expected. Please try again."
                : error instanceof Error &&
                    !["TypeError", "SyntaxError"].includes(error.name)
                  ? error.message
                  : "Pools could not load. Check your connection and retry.",
            );
          }
        })
        .finally(() => {
          clearTimeout(timeout);
          if (controller === current) controller = null;
          if (active) {
            setPoolLoading(false);
            if (pausedForVisibility && document.visibilityState !== "hidden")
              schedule(Math.max(0, nextAttemptAt - Date.now()));
          }
        });
    };
    const visibility = () => {
      clearTimeout(retry);
      if (document.visibilityState === "hidden") {
        pausedForVisibility = true;
        controller?.abort();
        setPoolLoading(false);
      } else if (!controller) {
        schedule(Math.max(0, nextAttemptAt - Date.now()));
      }
    };
    document.addEventListener("visibilitychange", visibility);
    load();
    return () => {
      active = false;
      clearTimeout(timeout);
      clearTimeout(retry);
      controller?.abort();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [
    project.id,
    checkingHistory,
    chain,
    tab,
    requestOffset,
    requestCursor,
    poolRetry,
    poolQuery,
    replacementToken,
    poolRequestScope,
    Boolean(project.poolInventory),
    requestOffset === 0 ? project.poolInventory?.poolCount : null,
  ]);
  useEffect(() => {
    setChain(initialChain);
    setSearch("");
    setPoolSearch("");
    setPoolQuery("");
    setLimit(20);
    setDataExpanded(false);
    setControlsExpanded(false);
    setSummaryExpanded(false);
    setTokenMetadataCache(new Map());
    setTokenNamesErrorScope("");
  }, [project.id, initialChain]);
  useEffect(() => {
    setLimit(20);
  }, [search, poolQuery, chain, tab]);

  // Presentation-only derivations. They never alter a measured amount: a
  // missing measurement stays "—" and is labelled, a measured zero stays $0.
  const summary = projectSummary(project, discovered, census);
  const longSummary = summary.length > 220;
  const volumeObserved =
    measurementProvenance(allProjectPools, windowKey).observedPoolCount > 0;
  const reservesObserved =
    measurementProvenance(allProjectPools, "liquidity").observedPoolCount > 0;
  // A project total expires as a whole when its oldest contributing
  // observation ages out, even while newer pool readings remain current.
  // Say so instead of leaving "—" beside a current pool count.
  const freshnessProof = isMarketFreshness(project.metrics.freshness)
    ? project.metrics.freshness
    : null;
  const totalExpired = (row: MetricFreshness | undefined, amount: unknown) =>
    amount === null &&
    Boolean(row?.expiresAt) &&
    Date.parse(row!.expiresAt!) <= evaluationNow() &&
    (row?.observedPools || 0) > 0;
  const volumeTotalExpired = totalExpired(
    freshnessProof?.volume[windowKey],
    project.metrics.volumeUsd[windowKey],
  );
  const reservesTotalExpired = totalExpired(
    freshnessProof?.liquidity,
    project.metrics.liquidityUsd,
  );
  const wording = poolWording();
  const poolOrder = wording.listOrder(windows[windowKey]);
  const setupPools = wording.setupCount(
    setupPoolCount,
    setupPoolCount === null
      ? "—"
      : new Intl.NumberFormat("en-US", {
          notation: "compact",
          maximumFractionDigits: 1,
        }).format(setupPoolCount),
  );
  const emptyPools = emptyPoolsCopy({
    chain,
    measured: STATIC_EDITION ? measuredNetworks(snapshot) : null,
    chainName,
  });
  const snapshotTaken = STATIC_EDITION
    ? fullTimeLabel(snapshot.generatedAt)
    : null;
  const poolsFoundText = count(setupPoolCount);
  const networksText = count(projectNetworks.length);
  const volumeText = money(project.metrics.volumeUsd[windowKey]);
  const reservesText = money(project.metrics.liquidityUsd);
  const poolCountNote = project.poolInventory
    ? project.poolInventory.complete
      ? "Search complete"
      : projectHistoryUpdating
        ? "Still searching"
        : "Search incomplete"
    : wording.countNote(setupPoolCount);
  const networksFigure = networksReadout({
    networks: projectNetworks,
    measuredOn: STATIC_EDITION
      ? poolNetworks(allProjectPools, chainName).slugs
      : [],
    chainName,
  });
  // The snapshot's note counts every pool it measured; the edition scopes it to
  // this project's own.
  const coverageNote =
    projectCoverageNote({
      pools: allProjectPools,
      snapshotPools: snapshot.pools,
      projectId: project.id,
    }) ??
    (project.metrics.note ||
      "Market totals include pools with available price data. Pools without a price are still listed, with a dash instead of a USD value.");
  const visiblePools = project.poolInventory ? pools : pools.slice(0, limit);
  const controlFindings = [
    inspection.dynamicFee && "dynamic fees",
    inspection.upgradeable && "upgradeable",
    inspection.restricted && "access rules",
    inspection.customData && "custom swap data",
  ].filter(Boolean) as string[];

  return (
    <div
      ref={detailRoot}
      className="drawer-body project-detail"
      data-edition={STATIC_EDITION ? "snapshot" : undefined}
    >
      <header className="detail-hero">
        <ProtocolLogo project={project} large />
        <div className="detail-hero-text">
          <div className="project-heading-meta">
            <span className="category-tag" data-category={project.category}>
              {project.category}
            </span>
            <button
              className="project-origin"
              title={identity.description}
              aria-expanded={dataExpanded}
              aria-controls="project-data-details"
              onClick={() => setDataExpanded((value) => !value)}
            >
              <span className="project-origin-label">Source</span>
              {identity.label}
              <Info size={13} />
            </button>
          </div>
          {verifiedProtocolName && verifiedProtocolName !== project.name && (
            <span className="project-protocol-name">
              {verifiedProtocolName}
            </span>
          )}
          <h2>{project.name}</h2>
          {duplicateName && <FamilyFingerprint project={project} />}
          <p
            className="detail-summary"
            data-clamped={longSummary && !summaryExpanded ? "true" : undefined}
          >
            {summary}
          </p>
          {longSummary && (
            <button
              className="detail-summary-toggle"
              aria-expanded={summaryExpanded}
              onClick={() => setSummaryExpanded((value) => !value)}
            >
              {summaryExpanded ? "Show less" : "Read full description"}
            </button>
          )}
        </div>
      </header>
      {historyContext && (
        <div
          className="notice detail-service-notice"
          role="status"
          aria-atomic="true"
          data-testid="project-service-notice"
        >
          {checkingHistory ? (
            <RefreshCw size={17} aria-hidden="true" />
          ) : (
            <Info size={17} aria-hidden="true" />
          )}
          {STATIC_EDITION && !checkingHistory ? (
            <>
              <span>
                <strong>
                  {recheckTried && !rechecking
                    ? "Still couldn’t check for a newer snapshot"
                    : "Couldn’t check for a newer snapshot"}
                </strong>
                {snapshotTaken
                  ? `Showing the snapshot taken ${snapshotTaken}.`
                  : "Showing the last loaded snapshot."}
              </span>
              {refreshPoolHistory && (
                // aria-disabled, not disabled: a disabled button gives up
                // keyboard focus, and the visitor would not know the retry ran.
                <button
                  className="control"
                  aria-disabled={rechecking || undefined}
                  onClick={() => {
                    if (rechecking) return;
                    setRechecking(true);
                    void refreshPoolHistory()
                      .catch(() => undefined)
                      .finally(() => {
                        setRechecking(false);
                        setRecheckTried(true);
                      });
                  }}
                >
                  {rechecking ? "Checking…" : "Retry"}
                </button>
              )}
            </>
          ) : (
            <span>
              <strong>
                {checkingHistory
                  ? "Checking saved data"
                  : "Updates unavailable"}
              </strong>
              Showing the last loaded project. Updates resume automatically.
            </span>
          )}
        </div>
      )}
      <div className="detail-actions">
        <div className="detail-actions-primary">
          <External className="project-website" href={project.website}>
            Open website
          </External>
          <button
            className={`control watch-project ${watchlisted ? "selected" : ""}`}
            aria-pressed={watchlisted}
            onClick={toggleWatch}
          >
            <Star size={16} fill={watchlisted ? "currentColor" : "none"} />
            {watchlisted ? "Watching" : "Watch project"}
          </button>
        </div>
        <div
          className="detail-actions-secondary"
          role="group"
          aria-label="Project tools"
        >
          <External className="detail-text-action" href={project.docs}>
            Docs
          </External>
          {onCompare && (
            <button
              className={`detail-text-action ${compared ? "selected" : ""}`}
              aria-pressed={compared}
              onClick={onCompare}
            >
              {compared ? "Added to comparison" : "Compare"}
            </button>
          )}
          {onActivity && (
            <button
              className="detail-text-action"
              aria-label="View activity"
              onClick={() => onActivity(chain)}
            >
              <span className="action-long">View activity</span>
              <span className="action-short">Activity</span>
            </button>
          )}
          <button
            className="detail-text-action"
            onClick={() =>
              void copy(publicViewUrl(location.href), "Project link copied.")
            }
          >
            <Copy size={15} />
            <span className="action-label">Copy link</span>
          </button>
        </div>
      </div>
      <section
        className="detail-overview plate"
        aria-labelledby={overviewHeadingId}
      >
        <div className="detail-overview-head">
          <div className="detail-overview-title">
            <h3 id={overviewHeadingId} className="kicker">
              Project totals
            </h3>
            <span className="detail-scope">
              All networks · {windows[windowKey]}
              <span className="detail-scope-window"> window</span>
            </span>
          </div>
          <button
            className="detail-disclosure"
            aria-expanded={dataExpanded}
            aria-controls="project-data-details"
            onClick={() => setDataExpanded((value) => !value)}
          >
            About this data
            <ChevronDown size={14} className={dataExpanded ? "rotate" : ""} />
          </button>
        </div>
        <div
          className="detail-stats"
          role="group"
          aria-label="Project overview"
        >
          <div className="readout" data-kind="census">
            <span className="readout-label">{wording.readoutLabel}</span>
            <strong
              className="readout-value"
              data-size={readoutSize(poolsFoundText)}
              data-unavailable={setupPoolCount === null || undefined}
            >
              {poolsFoundText}
            </strong>
            <span className="readout-note">{poolCountNote}</span>
          </div>
          <div className="readout" data-kind="census">
            <span className="readout-label">{networksFigure.label}</span>
            <strong
              className="readout-value"
              data-size={readoutSize(networksText)}
            >
              {networksText}
            </strong>
            <span className="readout-note" title={networksFigure.title}>
              {networksFigure.note}
            </span>
          </div>
          <div className="readout" data-kind="market">
            <span className="readout-label">{windows[windowKey]} volume</span>
            <strong
              className="readout-value"
              data-size={readoutSize(volumeText, true)}
              data-unavailable={
                project.metrics.volumeUsd[windowKey] === null || undefined
              }
            >
              {volumeText}
            </strong>
            <span className="readout-note">
              {volumeTotalExpired && (
                <span className="readout-expired">
                  Total expired
                  <span className="readout-expired-hint">
                    {" "}
                    · {STATIC_EDITION ? "awaiting the next snapshot" : "awaiting refresh"}
                  </span>
                </span>
              )}
              {volumeObserved ? (
                <MetricMeasurement
                  pools={allProjectPools}
                  metric={windowKey}
                  compact
                />
              ) : (
                "Not measured"
              )}
            </span>
          </div>
          <div className="readout" data-kind="market">
            <span
              className="readout-label"
              title="Provider estimates for priced pools. These may include one-sided token inventory and do not measure tradable depth or protocol TVL."
            >
              Reported reserves <Info size={12} />
            </span>
            <strong
              className="readout-value"
              data-size={readoutSize(reservesText, true)}
              data-unavailable={
                project.metrics.liquidityUsd === null || undefined
              }
            >
              {reservesText}
            </strong>
            <span className="readout-note">
              {reservesTotalExpired && (
                <span className="readout-expired">
                  Total expired
                  <span className="readout-expired-hint">
                    {" "}
                    · {STATIC_EDITION ? "awaiting the next snapshot" : "awaiting refresh"}
                  </span>
                </span>
              )}
              {reservesObserved ? (
                <MetricMeasurement
                  pools={allProjectPools}
                  metric="liquidity"
                  compact
                />
              ) : (
                "Not measured"
              )}
            </span>
          </div>
        </div>
        <div className="detail-data-caption">
          <span
            className="detail-freshness"
            data-state={
              pricedPoolCount
                ? "current"
                : hasSavedUsdObservations
                  ? "stale"
                  : "none"
            }
          >
            {pricedPoolCount
              ? `${STATIC_EDITION ? "Current market data in this snapshot" : "Fresh market data"}: ${count(pricedPoolCount)} ${pricedPoolCount === 1 ? "pool" : "pools"}.`
              : hasSavedUsdObservations
                ? `No ${STATIC_EDITION ? "current" : "fresh"} USD data${STATIC_EDITION ? " in this snapshot" : ""}. Saved observations stay in pool details.`
                : STATIC_EDITION
                  ? "No USD measurements in this snapshot for this project."
                  : "No USD measurements available for this project yet."}
          </span>
          {snapshotTaken && (
            <span
              className="detail-snapshot-time"
              data-testid="drawer-snapshot-time"
            >
              Snapshot taken {snapshotTaken}
            </span>
          )}
          <span className="detail-coverage-note">
            <span className="detail-coverage-label">
              Tracked hook-pool volume ·{" "}
            </span>
            Partial coverage · Not total Uniswap volume
          </span>
        </div>
        {dataExpanded && (
          <div id="project-data-details" className="detail-data-panel">
            <div>
              <h3>Market coverage</h3>
              <p>{coverageNote}</p>
              <p>
                Reported reserves are provider estimates, not executable trading
                depth or protocol TVL. Each measurement keeps its original
                update time. Only observations less than five minutes old
                {STATIC_EDITION ? " when the snapshot was taken" : ""}{" "}
                contribute to current USD totals; older values stay available in
                pool details.
              </p>
              {project.poolInventory && !project.poolInventory.complete && (
                <p>
                  {projectHistoryUpdating
                    ? "We’re still checking earlier blocks on this project’s networks. Newly found pools appear automatically."
                    : historyContext
                      ? "The last loaded pool history is incomplete for this project’s networks."
                      : "Pool history is incomplete for this project’s networks."}
                </p>
              )}
            </div>
            <div>
              <h3>Project identity</h3>
              <p>{identity.description}</p>
              {!discovered && (
                <p>
                  A shared project name or official artwork does not establish
                  common ownership of every listed contract.
                </p>
              )}
              {project.description && project.description !== summary && (
                <p>
                  <strong>
                    {publishedIdentity
                      ? "Published description:"
                      : "Registry description:"}
                  </strong>{" "}
                  {project.description}
                </p>
              )}
              <External href={project.sourceUrl}>
                {discovered
                  ? "View discovery source"
                  : publishedIdentity
                    ? "View identity source"
                    : "View registry entry"}
              </External>
            </div>
          </div>
        )}
      </section>
      <div className="detail-dossier">
        <section
          className="project-controls"
          aria-label="Published contract controls"
        >
          <button
            className="project-controls-toggle dossier-toggle"
            aria-expanded={controlsExpanded}
            aria-controls={controlDetailsId}
            onClick={() => setControlsExpanded((value) => !value)}
          >
            <Code2 size={16} />
            <span className="dossier-title">
              Trading &amp; contract controls
            </span>
            {inspection.classified > 0 && (
              <PermissionGlyph
                className="project-controls-glyph"
                shares={controlsSignature.shares}
                decorative
              />
            )}
            <span className="project-controls-source">
              {inspection.classified ? "From the public listing" : "Not classified"}
            </span>
            <ChevronDown
              size={15}
              className={controlsExpanded ? "rotate" : ""}
            />
          </button>
          {controlsExpanded && (
            <div id={controlDetailsId} className="project-controls-panel">
              {inspection.classified > 0 ? (
                <>
                  <p>
                    Declared for {count(inspection.classified)} of{" "}
                    {count(project.deployments.length)} hooks. Confirm current
                    behavior in the contract before using it.
                  </p>
                  {abilities.capabilities.length > 0 && (
                    <div className="project-controls-abilities">
                      <span className="readout-label">What its hooks can do</span>
                      <ul>
                        {abilities.capabilities.map((item) => (
                          <li key={item.key}>
                            {item.text}
                            {abilities.classified > 1 && (
                              <small>
                                {item.hooks === abilities.classified
                                  ? " All hooks."
                                  : ` ${count(item.hooks)} of ${count(abilities.classified)} hooks.`}
                              </small>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <dl>
                    <div data-flagged={inspection.dynamicFee > 0 || undefined}>
                      <dt>Dynamic fees</dt>
                      <dd>
                        {inspection.dynamicFee
                          ? `${count(inspection.dynamicFee)} ${inspection.dynamicFee === 1 ? "hook" : "hooks"}`
                          : "None declared"}
                      </dd>
                    </div>
                    <div data-flagged={inspection.upgradeable > 0 || undefined}>
                      <dt>Upgradeable contracts</dt>
                      <dd>
                        {inspection.upgradeable
                          ? `${count(inspection.upgradeable)} ${inspection.upgradeable === 1 ? "hook" : "hooks"}`
                          : "None declared"}
                      </dd>
                    </div>
                    <div data-flagged={inspection.customData > 0 || undefined}>
                      <dt>Custom swap inputs</dt>
                      <dd>
                        {inspection.customData
                          ? `${count(inspection.customData)} ${inspection.customData === 1 ? "hook" : "hooks"} require data`
                          : "None declared"}
                      </dd>
                    </div>
                    <div data-flagged={inspection.restricted > 0 || undefined}>
                      <dt>Trading restrictions</dt>
                      <dd>
                        {inspection.restricted
                          ? `${count(inspection.restricted)} ${inspection.restricted === 1 ? "hook" : "hooks"} with access rules`
                          : "None declared"}
                      </dd>
                    </div>
                  </dl>
                  {controlFindings.length > 0 && (
                    <p className="project-controls-summary">
                      Declared in the listing: {controlFindings.join(", ")}.
                    </p>
                  )}
                  <div className="project-controls-signature">
                    <span className="readout-label">Callback signature</span>
                    <CallbackSignature project={project} />
                    <PermissionGlyphKey />
                  </div>
                </>
              ) : (
                <p>
                  These controls haven’t been classified in the public registry.
                  An unclassified contract can still change fees or restrict
                  trading; inspect its source and current configuration.
                </p>
              )}
              <p className="project-evidence-note">
                {inspection.unknown > 0 &&
                  `${count(inspection.unknown)} ${inspection.unknown === 1 ? "hook is" : "hooks are"} unclassified. `}
                {inspection.classified > 0 &&
                  `${count(inspection.verifiedSource)} of ${count(inspection.classified)} classified hooks are marked source-verified in the listing. `}
                {inspection.auditLinks > 0
                  ? `${count(inspection.auditLinks)} ${inspection.auditLinks === 1 ? "hook has an audit link" : "hooks have audit links"}.`
                  : "No audit links are provided in this listing."}
              </p>
              <button
                className="detail-disclosure"
                onClick={() => exploreTab("deployments")}
              >
                Inspect hooks and source links <ArrowRight size={14} />
              </button>
            </div>
          )}
        </section>
        {!STATIC_EDITION && (
          <ArchivedHistory
            key={project.id}
            projectId={project.id}
            unavailable={historyContext}
          />
        )}
      </div>
      <div className="detail-tabs" role="tablist" aria-label="Project data">
        <button
          id="pool-tab"
          role="tab"
          tabIndex={tab === "pools" ? 0 : -1}
          onKeyDown={handleTabKey}
          aria-selected={tab === "pools"}
          aria-controls="pools-panel"
          className={tab === "pools" ? "active" : ""}
          onClick={() => setTab("pools")}
        >
          Pools{" "}
          <span>
            {wording.tabFigure(
              projectPoolCount(project),
              count(projectPoolCount(project)),
            )}
          </span>
        </button>
        <button
          id="deployment-tab"
          role="tab"
          tabIndex={tab === "deployments" ? 0 : -1}
          onKeyDown={handleTabKey}
          aria-selected={tab === "deployments"}
          aria-controls="deployment-panel"
          className={tab === "deployments" ? "active" : ""}
          onClick={() => setTab("deployments")}
        >
          Hooks <span>{count(project.deployments.length)}</span>
        </button>
      </div>
      <section className="project-setup" aria-label="Project setup">
        <div className="project-setup-heading">
          <h3>Explore the setup</h3>
          <span>{setupNetworks(projectNetworks, chainName)}</span>
        </div>
        <div
          className={`project-structure ${canExploreExtensions ? "has-extensions" : ""}`}
        >
          <button
            onClick={() => exploreTab("deployments")}
            className={tab === "deployments" ? "current" : ""}
            aria-label={`Explore ${count(project.deployments.length)} hook contracts`}
          >
            <span className="setup-step" aria-hidden="true">
              01
            </span>
            <span className="setup-value">
              <strong>{count(project.deployments.length)}</strong>{" "}
              {project.deployments.length === 1 ? "hook" : "hooks"}
            </span>
            <small>Trading logic</small>
          </button>
          <ArrowRight size={16} className="setup-arrow" />
          <button
            onClick={() => exploreTab("pools")}
            className={tab === "pools" ? "current" : ""}
            aria-label="Explore pools using these hooks"
          >
            <span className="setup-step" aria-hidden="true">
              02
            </span>
            <span className="setup-value">
              <strong
                title={
                  // "None" needs no "—" tooltip; the live figure keeps its own.
                  STATIC_EDITION && setupPoolCount === null
                    ? undefined
                    : count(setupPoolCount)
                }
              >
                {setupPools.figure}
              </strong>{" "}
              {setupPools.unit}
            </span>
            <small>Markets using these hooks</small>
          </button>
          {canExploreExtensions && (
            <>
              <ArrowRight size={16} className="setup-arrow" />
              <button
                onClick={() => exploreTab("deployments", true)}
                aria-label="Explore pool extensions in Frontier hooks"
              >
                <span className="setup-step" aria-hidden="true">
                  03
                </span>
                <span className="setup-value">
                  <Layers size={15} />{" "}
                  {frontierExtensions
                    ? `${frontierExtensions.total} extensions`
                    : "Extensions"}
                </span>
                <small>Configured for each pool</small>
              </button>
            </>
          )}
        </div>
      </section>
      <div className="detail-filters" data-tab={tab}>
        <label className="select-control">
          <span className="sr-only">Filter project by network</span>
          <select
            ref={projectNetworkSelect}
            value={chain}
            title="Filter the pool and hook lists by network"
            onChange={(event) => setChain(event.target.value)}
          >
            <option value="all">All networks</option>
            {projectNetworks.map((value) => (
              <option key={value} value={value}>
                {chainName(value)}
              </option>
            ))}
          </select>
          <ChevronDown size={14} />
        </label>
        {tab === "pools" && (
          <div className="search-box pool-search-control">
            <Search size={15} />
            <input
              type="search"
              ref={poolSearchInput}
              value={poolSearch}
              onChange={(event) =>
                setPoolSearch(
                  event.target.value.replace(/[\u0000-\u001f\u007f]/g, ""),
                )
              }
              placeholder="Pool, token or address"
              aria-label="Search pools"
              maxLength={200}
            />
            {poolSearch && (
              <button
                className="clear-search"
                aria-label="Clear pool search"
                onClick={() => {
                  setPoolSearch("");
                  poolSearchInput.current?.focus();
                }}
              >
                <X size={14} />
              </button>
            )}
          </div>
        )}
        {tab === "deployments" && (
          <div className="search-box">
            <Search size={15} />
            <input
              type="search"
              ref={hookSearchInput}
              value={search}
              onChange={(event) =>
                setSearch(
                  event.target.value.replace(/[\u0000-\u001f\u007f]/g, ""),
                )
              }
              placeholder="Find a hook or address"
              aria-label="Search hooks"
              maxLength={200}
            />
            {search && (
              <button
                className="clear-search"
                aria-label="Clear hook search"
                onClick={() => {
                  setSearch("");
                  hookSearchInput.current?.focus();
                }}
              >
                <X size={14} />
              </button>
            )}
          </div>
        )}
        {tab === "pools" && project.poolInventory && (
          <button
            className="control detail-refresh"
            disabled={poolViewLoading || checkingHistory}
            onClick={() => {
              setRequestOffset(0);
              setRequestCursor(null);
              setPoolRetry((value) => value + 1);
              setTokenMetadataCache(
                (previous) =>
                  new Map([...previous].filter(([, entry]) => entry.metadata)),
              );
            }}
          >
            <RefreshCw size={15} className={poolLoading ? "spin" : ""} />
            <span className="detail-refresh-label">Refresh pool list</span>
          </button>
        )}
      </div>
      {tab === "deployments" ? (
        <div
          id="deployment-panel"
          role="tabpanel"
          aria-labelledby="deployment-tab"
          className="deployment-list"
        >
          {hasExtensions && (
            <div className="hooks-extension-guide">
              <ol className="extension-route" aria-label="Extension workflow">
                <li>Hook</li>
                <li>Pool</li>
                <li>Modules</li>
              </ol>
              <p>
                {checkingHistory
                  ? "Extensions reopen automatically when saved data verification finishes."
                  : "Pool-specific fees, swap actions and fee destinations."}
              </p>
            </div>
          )}
          {extensionSelection && !selectedExtensionHook && (
            <div className="notice error-notice" role="alert">
              This extension link does not match a listed Frontier hook on
              Robinhood. Choose a listed hook to inspect its configuration.
            </div>
          )}
          {hookFiltersActive && (
            <div className="detail-filter-summary" role="status">
              <span>
                {count(deployments.length)} of{" "}
                {count(project.deployments.length)}{" "}
                {project.deployments.length === 1 ? "hook" : "hooks"}
                {chain !== "all" ? ` · ${chainName(chain)}` : ""}
              </span>
              <button
                onClick={() => {
                  setChain("all");
                  setSearch("");
                  hookSearchInput.current?.focus();
                }}
              >
                Clear filters <X size={13} />
              </button>
            </div>
          )}
          {deployments
            .slice(
              0,
              Math.max(
                limit,
                deployments.findIndex(
                  (hook) => hook.id === selectedExtensionHook?.id,
                ) + 1,
              ),
            )
            .map((deployment) => (
              <Deployment
                key={deployment.id}
                deployment={deployment}
                copy={copy}
                networkName={chainName(deployment.chain)}
                tagDigits={hookTagDigits}
                hasExtensions={hasExtensions && !checkingHistory}
                extensionSelection={
                  selectedExtensionHook?.id === deployment.id
                    ? (extensionSelection?.poolId ?? null)
                    : null
                }
                onExtensionSelection={(poolId, reveal) => {
                  if (poolId === null) onExtensionSelection?.(null);
                  else openExtensions(deployment, poolId, reveal);
                }}
                onExtensionSettled={(poolId) =>
                  completeExtensionLanding(
                    deployment.address.toLowerCase(),
                    poolId,
                  )
                }
                logoProject={project}
                artwork={
                  familyArtwork
                    ? null
                    : getVerifiedProtocolArtwork({
                        ...project,
                        deployments: [deployment],
                      })
                }
              />
            ))}
          {!deployments.length && (
            <Empty
              icon={
                hasUnlistedChainHooks ? (
                  <Layers size={27} />
                ) : (
                  <Search size={27} />
                )
              }
              title={
                hasUnlistedChainHooks
                  ? `No hook listing on ${chainName(chain)}`
                  : "No hooks match your search"
              }
              action={
                hasUnlistedChainHooks ? (
                  <button
                    className="control"
                    onClick={() => exploreTab("pools")}
                  >
                    View {chainName(chain)} pools <ArrowRight size={14} />
                  </button>
                ) : hookFiltersActive ? (
                  <button
                    className="control"
                    onClick={() => {
                      setChain("all");
                      setSearch("");
                      hookSearchInput.current?.focus();
                    }}
                  >
                    Show all hooks
                  </button>
                ) : undefined
              }
            >
              {hasUnlistedChainHooks
                ? "Pool evidence is available on this network. Open a pool to inspect its hook address and creation details."
                : "Try another name, address, or network."}
            </Empty>
          )}
          {deployments.length > limit && (
            <div className="list-footer">
              <p
                className="pool-list-progress"
                role={STATIC_EDITION ? "status" : undefined}
              >
                Showing <strong>{count(limit)}</strong> of{" "}
                {count(deployments.length)} hooks
              </p>
              <button
                className="load-more control"
                aria-label={showMoreLabel("hooks", deployments.length - limit)}
                onClick={() => {
                  // The last page removes this button: hand focus to the first
                  // hook it adds, or it falls to the page.
                  if (STATIC_EDITION && deployments.length - limit <= 20)
                    focusHookFrom.current = limit;
                  setLimit(limit + 20);
                }}
              >
                Show {Math.min(20, deployments.length - limit)} more ·{" "}
                {count(deployments.length - limit)} remaining
                <ChevronDown size={16} />
              </button>
            </div>
          )}
        </div>
      ) : (
        <div
          id="pools-panel"
          role="tabpanel"
          aria-labelledby="pool-tab"
          aria-busy={poolViewLoading && !poolViewSaving}
          className="pool-list"
        >
          {checkingHistory ? (
            <Empty title="Checking saved pool history">
              Pool lists open automatically after verification. You can browse
              the project’s saved hooks now.
            </Empty>
          ) : (
            <>
              {(chain !== "all" || Boolean(poolSearch.trim())) && (
                <div className="detail-filter-summary pool-filter-summary">
                  <span>
                    {chain === "all" ? "All networks" : chainName(chain)}
                    {poolSearch.trim() ? " · Search applied" : ""}
                  </span>
                  <button
                    onClick={() => {
                      setChain("all");
                      setPoolSearch("");
                      poolSearchInput.current?.focus();
                    }}
                  >
                    Clear filters <X size={13} />
                  </button>
                </div>
              )}
              {project.poolInventory && (
                <p className="index-pool-note">
                  {poolSearchPending ||
                  (poolQuery &&
                    poolViewLoading &&
                    (poolScopeChanged || poolTotal === null))
                    ? "Searching pools…"
                    : poolQuery
                      ? poolTotal === null
                        ? "Search results unavailable"
                        : `${count(poolTotal)} ${poolTotal === 1 ? "pool matches" : "pools match"} your search${chain === "all" ? "" : ` on ${chainName(chain)}`}`
                      : scopedPoolCount > 0
                        ? `${count(scopedPoolCount)} ${scopedPoolCount === 1 ? "pool" : "pools"} found${chain === "all" ? "" : ` on ${chainName(chain)}`}`
                        : scopeComplete
                          ? "No pools found on this network"
                          : historyUpdating
                            ? "Checking for pools"
                            : historyContext
                              ? "No pools in saved history"
                              : "No pools in loaded history"}
                  {!scopeComplete && !poolSearchPending && (
                    <span>
                      {historyUpdating
                        ? " · More may appear as indexing continues."
                        : " · History is incomplete."}
                    </span>
                  )}
                </p>
              )}
              {poolViewSaving && (
                <p className="index-pool-note" role="status">
                  Saving new pool history. This list will update automatically.
                </p>
              )}
              {poolViewError && (
                <div className="notice error-notice" role="alert">
                  <span>{poolViewError}</span>
                  <button
                    className="control"
                    disabled={poolRecovering}
                    onClick={() => {
                      if (poolGenerationMismatch && refreshPoolHistory) {
                        const recoveringScope = poolScope;
                        setPoolRecovering(true);
                        // Project hydration may follow the snapshot response.
                        // Its actual token change admits the new first page.
                        void refreshPoolHistory()
                          .catch(() => {
                            if (currentPoolScope.current === recoveringScope)
                              setPoolError(
                                "We couldn’t update the pool history. Please try again.",
                              );
                          })
                          .finally(() => {
                            if (currentPoolScope.current === recoveringScope)
                              setPoolRecovering(false);
                          });
                        return;
                      }
                      if (poolRestartNeeded) {
                        setIndexedPools([]);
                        setPoolTotal(null);
                        setNextOffset(null);
                        setNextCursor(null);
                        setRequestOffset(0);
                        setRequestCursor(null);
                      }
                      setPoolRetry((value) => value + 1);
                    }}
                  >
                    {poolRecovering
                      ? "Updating pool history…"
                      : poolGenerationMismatch && refreshPoolHistory
                        ? "Update pool history"
                        : poolRestartNeeded
                          ? "Reload pool list"
                          : "Try again"}
                  </button>
                </div>
              )}
              {poolViewLoading && !poolViewSaving && (
                <p role="status" className="index-pool-note">
                  Loading pools…
                </p>
              )}
              {tokenNamesLoading && !poolViewLoading && (
                <p className="pool-names-status" role="status">
                  Looking up token names…
                </p>
              )}
              {!tokenNamesLoading &&
                tokenNamesErrorScope === tokenNamesScope &&
                pools.length > 0 && (
                  <p className="pool-names-status">
                    Some token names couldn’t load. You can still identify
                    tokens by their addresses.
                  </p>
                )}
              {(visiblePools.length > 0 ||
                (poolViewLoading && !poolViewSaving)) && (
                <div className="pool-table-head" aria-hidden="true">
                  <span>Pool</span>
                  <span>Network</span>
                  <span>{windows[windowKey]} volume</span>
                  <span>Reserves</span>
                  <span>Created</span>
                </div>
              )}
              {poolViewLoading && !poolViewSaving && !pools.length && (
                <div className="pool-skeletons" aria-hidden="true">
                  {[0, 1, 2, 3].map((value) => (
                    <div className="pool-skeleton" key={value}>
                      <span className="skeleton" />
                      <span className="skeleton" />
                      <span className="skeleton" />
                      <span className="skeleton" />
                    </div>
                  ))}
                </div>
              )}
              {visiblePools.map((pool) => (
                <PoolCard
                  key={pool.id}
                  pool={pool}
                  networkName={chainName(pool.chain)}
                  explorer={chainExplorer(pool.chain)}
                  selected={Boolean(
                    selectedExtensionHook &&
                    extensionSelection?.poolId &&
                    extensionSelection.poolId === pool.address.toLowerCase() &&
                    pool.hookAddress?.toLowerCase() ===
                      extensionSelection.hookAddress,
                  )}
                  windowKey={windowKey}
                  copy={copy}
                  tokenMetadata={tokenMetadata}
                  onExtensions={
                    hasExtensions &&
                    pool.chain === "robinhood" &&
                    project.deployments.some(
                      (hook) =>
                        hook.chainId === 4663 &&
                        hook.address.toLowerCase() ===
                          pool.hookAddress?.toLowerCase(),
                    )
                      ? () =>
                          openExtensions(
                            project.deployments.find(
                              (hook) =>
                                hook.chainId === 4663 &&
                                hook.address.toLowerCase() ===
                                  pool.hookAddress?.toLowerCase(),
                            )!,
                            pool.address,
                          )
                      : undefined
                  }
                  onActivity={
                    hasExtensions && onActivity
                      ? () =>
                          onActivity(pool.chain, {
                            poolId: pool.address,
                            hookAddress: pool.hookAddress || "",
                          })
                      : undefined
                  }
                />
              ))}
              {!pools.length &&
                !poolViewLoading &&
                !poolSearchPending &&
                !poolViewError &&
                !poolViewSaving && (
                  <Empty
                    title={
                      poolQuery
                        ? "No pools match your search"
                        : project.poolInventory
                          ? scopeComplete
                            ? "No pools found"
                            : historyUpdating
                              ? "Finding pools"
                              : historyContext
                                ? "No pools in saved history"
                                : "No pools in loaded history"
                          : emptyPools.title
                    }
                    action={
                      poolQuery ? (
                        <button
                          className="control"
                          onClick={() => {
                            setPoolSearch("");
                            poolSearchInput.current?.focus();
                          }}
                        >
                          Clear search
                        </button>
                      ) : chain !== "all" ? (
                        <button
                          className="control"
                          onClick={() => {
                            setChain("all");
                            projectNetworkSelect.current?.focus();
                          }}
                        >
                          Show all networks
                        </button>
                      ) : (
                        <button
                          className="control"
                          onClick={() => exploreTab("deployments")}
                        >
                          Explore hooks <ArrowRight size={14} />
                        </button>
                      )
                    }
                  >
                    {poolQuery
                      ? "Try a pool name, exact pool ID, token address, or another network."
                      : project.poolInventory
                        ? scopeComplete
                          ? chain === "all"
                            ? "No pools were found for these hooks in the blocks checked so far."
                            : "Try another network or explore the project’s hooks."
                          : historyUpdating
                            ? "We’re checking earlier blocks. Pools appear here automatically when found."
                            : historyContext
                              ? "No pools were found in the saved blocks. The saved history is incomplete."
                              : "No pools were found in the checked blocks. This history is incomplete."
                        : emptyPools.body}
                  </Empty>
                )}
              {(pools.length > 0 ||
                (project.poolInventory &&
                  !poolScopeChanged &&
                  nextOffset !== null)) && (
                <div className="list-footer">
                  {pools.length > 0 &&
                    !poolViewLoading &&
                    !poolSearchPending &&
                    !poolViewSaving &&
                    !poolViewError && (
                      <p className="pool-list-progress" role="status">
                        Showing{" "}
                        <strong>
                          {count(
                            project.poolInventory
                              ? pools.length
                              : Math.min(limit, pools.length),
                          )}
                        </strong>{" "}
                        of{" "}
                        {count(
                          project.poolInventory ? poolTotal : pools.length,
                        )}{" "}
                        {wording.listUnit(
                          Boolean(poolQuery),
                          project.poolInventory ? poolTotal : pools.length,
                        )}
                        {!project.poolInventory &&
                          pools.length > 1 &&
                          poolOrder &&
                          ` · ${poolOrder}`}
                      </p>
                    )}
                  {project.poolInventory &&
                    !poolScopeChanged &&
                    nextOffset !== null && (
                      <button
                        className="load-more control"
                        aria-busy={poolLoading}
                        disabled={
                          poolLoading || poolViewSaving || poolRestartNeeded
                        }
                        onClick={() => {
                          setRequestOffset(nextOffset);
                          setRequestCursor(nextCursor);
                        }}
                      >
                        {poolViewSaving
                          ? "Saving pool history…"
                          : "Show more pools"}
                        {!poolViewSaving &&
                          (poolLoading ? (
                            <RefreshCw size={16} className="spin" />
                          ) : (
                            <ChevronDown size={16} />
                          ))}
                      </button>
                    )}
                  {!project.poolInventory && pools.length > limit && (
                    <button
                      className="load-more control"
                      aria-label={showMoreLabel("pools", pools.length - limit)}
                      onClick={() => {
                        // The last page removes this button: hand focus to the
                        // first pool it adds, or it falls to the page.
                        if (STATIC_EDITION && pools.length - limit <= 20)
                          focusPoolFrom.current = limit;
                        setLimit(limit + 20);
                      }}
                    >
                      Show {Math.min(20, pools.length - limit)} more{" "}
                      {pools.length - limit === 1 ? "pool" : "pools"}
                      <ChevronDown size={16} />
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Display-face figures shrink with their character count so a census of
 * millions never overflows a readout column. The value itself is unchanged. */
/** The pixel face is about 0.56em wide per character, so the figure steps down
 * with its length to stay on one line in its column. The volume and reserves
 * columns are wider than the census ones, so they step down two characters later. */
function readoutSize(
  text: string,
  wide = false,
): "m" | "s" | "xs" | "xxs" | undefined {
  const length = text.length - (wide ? 2 : 0);
  return length >= 10
    ? "xxs"
    : length >= 8
      ? "xs"
      : length === 7
        ? "s"
        : length >= 5
          ? "m"
          : undefined;
}

/** Explorer address page, only for a real (non-native) 20-byte address. */
function explorerAddressUrl(explorer: string | undefined, address: string) {
  const base = safeUrl(explorer);
  if (
    !base ||
    !/^0x[a-f\d]{40}$/i.test(address) ||
    address.toLowerCase() === nativeCurrencyAddress
  )
    return undefined;
  return new URL(`address/${address}`, `${base.replace(/\/$/, "")}/`).href;
}

// Registry classifications are metadata, not verified live access guarantees.
const swapAccessLabels: ReadonlyMap<string, string> = new Map([
  ["temporal", "Time-gated trading"],
  ["allowlist", "Allowlist required"],
  ["governance", "Admin-controlled trading"],
  ["other", "Custom access rules"],
]);

function Deployment({
  deployment,
  copy,
  networkName,
  tagDigits: digits,
  hasExtensions,
  logoProject,
  artwork,
  extensionSelection,
  onExtensionSelection,
  onExtensionSettled,
}: {
  deployment: HookDeployment;
  copy: (text: string, success: string) => Promise<void>;
  networkName: string;
  /** Digits of the address the edition's control names carry. */
  tagDigits: number;
  hasExtensions: boolean;
  logoProject: Pick<RadarProject, "id" | "name" | "description">;
  artwork: ProtocolArtwork | null;
  extensionSelection: string | null;
  onExtensionSelection: (poolId: string | null, reveal?: boolean) => void;
  onExtensionSettled: (poolId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [callbacksExpanded, setCallbacksExpanded] = useState(false);
  const detailsId = useId();
  const callbacksId = useId();
  const enabled = Object.entries(deployment.flags)
    .filter(([, value]) => value)
    .map(([flag]) => flag);
  // Match the registry's access classifications without exposing its raw enums.
  // "none" means no access control, not that swapping is unavailable.
  const accessLabel = swapAccessLabels.get(deployment.properties.swapAccess);
  const classified =
    deployment.discovery !== "onchain" &&
    deployment.discovery !== "published" &&
    deployment.properties.swapAccess !== "unknown";
  const hasChips =
    classified &&
    (deployment.verifiedSource ||
      deployment.properties.dynamicFee ||
      deployment.properties.upgradeable ||
      deployment.properties.requiresCustomSwapData ||
      Boolean(accessLabel));
  const extensionsAvailable = hasExtensions && deployment.chainId === 4663;
  // The snapshot edition names each control for its own hook: a project can list
  // dozens of hooks with one name, and every card has the same buttons.
  const labels = hookControlLabels(deployment, networkName, digits);
  return (
    <article
      className="deployment-card"
      data-expanded={expanded}
      data-extensions={extensionSelection !== null || undefined}
      data-hook-address={deployment.address.toLowerCase()}
    >
      <div className="deployment-top">
        <div className="deployment-identity">
          <strong>{deployment.name || "Hook contract"}</strong>
          <span className="tag">{networkName}</span>
          {artwork && (
            <div className="deployment-protocol">
              <ProtocolLogo
                project={{ ...logoProject, deployments: [deployment] }}
                artwork={artwork}
              />
              <span>{artwork.protocol}</span>
            </div>
          )}
        </div>
        <div className="deployment-tools">
          <PermissionGlyph flags={deployment.flags} />
          <button
            className="hook-address-copy"
            title={`Copy hook address: ${deployment.address}`}
            aria-label={
              labels?.copy ??
              `Copy ${deployment.name || "hook"} address ${shortAddress(deployment.address)}`
            }
            onClick={() =>
              void copy(deployment.address, "Hook address copied.")
            }
          >
            <code>{shortAddress(deployment.address)}</code>
            <Copy size={14} />
          </button>
        </div>
      </div>
      <div className="deployment-foot">
        <div className="deployment-meta">
          {hasChips && (
            <div className="deployment-properties">
              {deployment.verifiedSource && (
                <span
                  className="property-chip verified"
                  title="The public listing marks this contract’s source as verified. Check its explorer for the published code; this is not a safety assessment."
                >
                  <Code2 size={13} />
                  Source verified
                </span>
              )}
              {deployment.properties.dynamicFee && (
                <span
                  className="property-chip"
                  title="Dynamic fees are declared in the public listing. Check the contract for its current fee rules."
                >
                  Dynamic fee
                </span>
              )}
              {deployment.properties.upgradeable && (
                <span
                  className="property-chip attention"
                  title="Upgradeability is declared in the public listing. Inspect the contract for its current owner and upgrade permissions."
                >
                  Upgradeable
                </span>
              )}
              {deployment.properties.requiresCustomSwapData && (
                <span
                  className="property-chip attention"
                  title="The registry reports that swaps need encoded hook data. A swap with empty hook data may fail or behave differently."
                >
                  Custom swap data
                </span>
              )}
              {accessLabel && (
                <span
                  className="property-chip attention"
                  title="Trading access classification from the public hook registry. Check the contract for its current rules."
                >
                  {accessLabel}
                </span>
              )}
            </div>
          )}
          <p className="deployment-metadata-note">
            {classified
              ? "Controls from published metadata"
              : "Contract controls not classified"}
          </p>
        </div>
        <div className="deployment-links">
          <NamedExternal href={deployment.explorerUrl} label={labels?.explorer}>
            View on explorer
          </NamedExternal>
          {deployment.auditUrl && (
            <NamedExternal href={deployment.auditUrl} label={labels?.audit}>
              Audit
            </NamedExternal>
          )}
          <button
            className="detail-disclosure"
            aria-label={labels?.details}
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={() => setExpanded(!expanded)}
          >
            Contract details
            <ChevronDown size={14} className={expanded ? "rotate" : ""} />
          </button>
        </div>
      </div>
      {expanded && (
        <div id={detailsId} className="contract-detail-panel">
          {deployment.description && (
            <p className="deployment-description">{deployment.description}</p>
          )}
          <span className="contract-caption">Contract address</span>
          <div className="address-row">
            <code title={deployment.address}>{deployment.address}</code>
            <button
              className="icon-button"
              aria-label={
                labels?.copyExpanded ??
                `Copy ${shortAddress(deployment.address)} address`
              }
              onClick={() =>
                void copy(deployment.address, "Hook address copied.")
              }
            >
              <Copy size={15} />
            </button>
          </div>
          {classified && deployment.properties.requiresCustomSwapData && (
            <p className="deployment-description">
              Swaps require custom hook data.
            </p>
          )}
          <div className="deployment-links">
            <NamedExternal href={deployment.sourceUrl} label={labels?.source}>
              Source entry
            </NamedExternal>
            <button
              className="detail-disclosure"
              aria-label={labels?.callbacks(enabled.length)}
              aria-expanded={callbacksExpanded}
              aria-controls={callbacksId}
              onClick={() => setCallbacksExpanded((value) => !value)}
            >
              {enabled.length} callback{" "}
              {enabled.length === 1 ? "flag" : "flags"}
              <ChevronDown
                size={14}
                className={callbacksExpanded ? "rotate" : ""}
              />
            </button>
          </div>
          {callbacksExpanded && (
            <div id={callbacksId} className="callback-panel">
              {enabled.length ? (
                <div className="callback-flags">
                  {enabled.map((flag) => (
                    <code key={flag}>{flag}</code>
                  ))}
                </div>
              ) : (
                <p>No callback flags encoded in this address.</p>
              )}
              <p>
                Permissions are decoded from the contract address. They do not
                describe all behavior or establish safety.
              </p>
            </div>
          )}
        </div>
      )}
      {extensionsAvailable && (
        <HookExtensions
          deployment={deployment}
          networkName={networkName}
          copy={copy}
          selection={extensionSelection}
          onSelectionChange={onExtensionSelection}
          onSettled={onExtensionSettled}
        />
      )}
    </article>
  );
}

function PoolCard({
  pool,
  networkName,
  explorer,
  selected = false,
  windowKey,
  copy,
  tokenMetadata,
  onExtensions,
  onActivity,
}: {
  pool: Pool;
  networkName: string;
  explorer: string | undefined;
  selected?: boolean;
  windowKey: WindowKey;
  copy: (text: string, success: string) => Promise<void>;
  tokenMetadata: ReadonlyMap<string, TokenMetadata>;
  onExtensions?: () => void;
  onActivity?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const volume = currentMetricValue(pool, windowKey, evaluationNow());
  const liquidity = currentMetricValue(pool, "liquidity", evaluationNow());
  const hasPrice = volume !== null || liquidity !== null;
  const recordedVolume = observedMetricValue(pool, windowKey);
  const recordedLiquidity = observedMetricValue(pool, "liquidity");
  const hasRecordedPrice =
    recordedVolume !== null || recordedLiquidity !== null;
  const measurementState = marketMeasurementState(pool, evaluationNow());
  const reserveUnavailable = ["inconsistent", "unverified"].includes(
    pool.liquidityStatus || "",
  );
  const sourceDataLink = pool.url.startsWith("https://api.frontier.fun/");
  const linkText = sourceDataLink
    ? "View source data"
    : pool.source === "Hook contract"
      ? "View hook contract"
      : "View pool";
  // The snapshot edition names each control for its own pool: a project can have
  // hundreds, and several can share one pair.
  const labels = poolControlLabels(pool, linkText, networkName);
  const created =
    pool.createdAt && Number.isFinite(Date.parse(pool.createdAt))
      ? pool.createdAt
      : null;
  return (
    <article
      className="pool-card"
      data-expanded={expanded}
      data-priced={hasPrice || undefined}
      data-selected={selected || undefined}
      data-pool-id={pool.address.toLowerCase()}
    >
      <div className="pool-row">
        <div className="pool-identity">
          <strong>{poolNameWithMetadata(pool, tokenMetadata)}</strong>
          <span className="pool-identity-meta">
            {selected && (
              <span
                className="pool-selected-mark"
                title="This pool is selected in the hook’s extensions view."
              >
                Selected
              </span>
            )}
            <span className="pool-id" title={pool.address}>
              {shortAddress(pool.address)}
            </span>
            {pool.poolKey && (
              <span className="pool-configuration-summary">
                {pool.poolKey.fee === 0x800000
                  ? "Dynamic LP fee"
                  : `${formatPoolFee(pool.poolKey.fee)} LP fee`}
                <span aria-hidden="true"> · </span>
                Tick spacing {count(pool.poolKey.tickSpacing)}
              </span>
            )}
          </span>
        </div>
        <span className="tag pool-network">{networkName}</span>
        <span className="pool-metric" data-empty={volume === null || undefined}>
          <span className="pool-metric-label">{windows[windowKey]} volume</span>
          <span className="pool-metric-value">{money(volume)}</span>
        </span>
        <span
          className="pool-metric"
          data-empty={liquidity === null || undefined}
          title={
            pool.liquidityNote ||
            "Provider reserve estimates may include one-sided token inventory. This is not tradable depth or protocol TVL."
          }
        >
          <span className="pool-metric-label">Reported reserves</span>
          <span className="pool-metric-value">{money(liquidity)}</span>
        </span>
        <span className="pool-metric pool-age">
          <span className="pool-metric-label">Created</span>
          <span className="pool-metric-value">
            {created ? (
              <time dateTime={created} title={timeDetail(created)}>
                {relativeTime(created)}
              </time>
            ) : pool.poolKey ? (
              <span
                className="pool-block"
                title={`Created at block ${count(pool.poolKey.creationBlock)}. Creation time unavailable.`}
              >
                #{count(pool.poolKey.creationBlock)}
              </span>
            ) : (
              <span title="Creation time unavailable">—</span>
            )}
          </span>
        </span>
      </div>
      <div className="pool-row-foot">
        <div className="pool-row-status">
          {!hasPrice && (
            <p
              className="pool-measured"
              data-state={hasRecordedPrice ? "stale" : "none"}
            >
              {hasRecordedPrice
                ? measurementState === "stale"
                  ? "Older observation · excluded from current totals."
                  : "Observation age unconfirmed · excluded from current totals."
                : STATIC_EDITION
                  ? "No price data in this snapshot."
                  : "Price data isn’t available yet."}
            </p>
          )}
          {hasPrice && pool.metricUpdatedAt && (
            <p
              className="pool-measured"
              data-state={pool.metricStatus === "cached" ? "cached" : "current"}
              title={timeDetail(pool.metricUpdatedAt)}
            >
              Updated {relativeTime(pool.metricUpdatedAt)}
              {pool.metricStatus === "cached" ? " · saved data" : ""}
            </p>
          )}
          {reserveUnavailable && (
            <p
              className="pool-measured reserve-unavailable"
              title={pool.liquidityNote}
            >
              Reserve estimate unavailable.
            </p>
          )}
        </div>
        <div className="pool-card-actions">
          {onExtensions && (
            <button
              className="detail-disclosure pool-extensions-action"
              aria-label="View hook & extensions"
              onClick={onExtensions}
            >
              <Layers size={14} />
              Hook &amp; extensions <ArrowRight size={14} />
            </button>
          )}
          {onActivity && (
            <button
              className="detail-disclosure"
              aria-label="View pool activity"
              onClick={onActivity}
            >
              Activity <ArrowRight size={14} />
            </button>
          )}
          <NamedExternal href={pool.url} label={labels?.view}>
            {linkText}
          </NamedExternal>
          <button
            className="detail-disclosure"
            aria-label={labels?.details ?? "Pool details"}
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={() => setExpanded((value) => !value)}
          >
            Details
            <ChevronDown size={14} className={expanded ? "rotate" : ""} />
          </button>
        </div>
      </div>
      {expanded && (
        <div id={detailsId} className="pool-detail-panel">
          {!hasPrice && hasRecordedPrice && (
            <div className="pool-recorded-observation">
              <span className="contract-caption">
                Last recorded observation
              </span>
              <dl>
                <div>
                  <dt>{windows[windowKey]} volume</dt>
                  <dd>{money(recordedVolume)}</dd>
                </div>
                <div>
                  <dt>Reported reserves</dt>
                  <dd>{money(recordedLiquidity)}</dd>
                </div>
              </dl>
              <p className="pool-measured">
                {pool.metricUpdatedAt &&
                Number.isFinite(Date.parse(pool.metricUpdatedAt)) ? (
                  <time dateTime={pool.metricUpdatedAt}>
                    {timeDetail(pool.metricUpdatedAt) ?? "Time unavailable"}
                  </time>
                ) : (
                  "Measurement time unavailable"
                )}
                {" · Historical observation, excluded from current totals."}
              </p>
            </div>
          )}
          <span className="contract-caption">Pool ID</span>
          <div className="address-row pool-key-id">
            <code>
              <HexIdentity value={pool.address} />
            </code>
            <button
              className="icon-button"
              aria-label={
                labels?.copyId ?? `Copy pool ${shortAddress(pool.address)} ID`
              }
              onClick={() => void copy(pool.address, "Pool ID copied.")}
            >
              <Copy size={15} />
            </button>
          </div>
          {pool.poolKey && (
            <PoolKeyDetails
              pool={pool}
              copy={copy}
              explorer={explorer}
              tokenMetadata={tokenMetadata}
            />
          )}
          {!pool.poolKey && pool.hookAddress && (
            <div className="pool-key-address">
              <span className="contract-caption">Hook used by this pool</span>
              <div className="address-row">
                <code>
                  <HexIdentity value={pool.hookAddress} />
                </code>
                <button
                  className="icon-button"
                  aria-label={labels?.copyHook ?? "Copy pool hook address"}
                  onClick={() =>
                    void copy(pool.hookAddress!, "Hook address copied.")
                  }
                >
                  <Copy size={15} />
                </button>
                <ExplorerLink
                  href={explorerAddressUrl(explorer, pool.hookAddress)}
                  label={labels?.explorerHook ?? "View hook on explorer"}
                />
              </div>
            </div>
          )}
          <p className="pool-measured pool-source">
            Source: {pool.source}
            {!pool.metricUpdatedAt ? " · update time unavailable" : ""}
          </p>
          {reserveUnavailable && pool.liquidityNote && (
            <p className="pool-measured">{pool.liquidityNote}</p>
          )}
        </div>
      )}
    </article>
  );
}

/** An external link; with a label, the edition's name for the row it belongs to.
 * The visible text stays what it was, and is part of the name. */
function NamedExternal({
  href,
  label,
  children,
}: {
  href: string | null | undefined;
  label: string | undefined;
  children: string;
}) {
  const url = safeUrl(href);
  if (!label || !url) return <External href={href}>{children}</External>;
  return (
    <a
      className="external"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
    >
      {children}
      <ExternalLink size={13} />
    </a>
  );
}

function ExplorerLink({
  href,
  label,
}: {
  href: string | undefined;
  label: string;
}) {
  return href ? (
    <a
      className="icon-button explorer-link"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      title={label}
    >
      <ExternalLink size={15} />
    </a>
  ) : null;
}

/** A measurement or creation time for a tooltip or a detail line. The live page
 * writes it in the visitor's own zone; the edition writes it in labelled UTC,
 * like every other time on its pages. */
function timeDetail(value: string): string | undefined {
  return STATIC_EDITION
    ? (fullTimeLabel(value) ?? undefined)
    : new Date(value).toLocaleString();
}

function formatPoolFee(fee: number): string {
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(fee / 10000)}%`;
}

function PoolKeyDetails({
  pool,
  copy,
  explorer,
  tokenMetadata,
}: {
  pool: Pool;
  copy: (text: string, success: string) => Promise<void>;
  explorer: string | undefined;
  tokenMetadata: ReadonlyMap<string, TokenMetadata>;
}) {
  const key = pool.poolKey!;
  const dynamic = key.fee === 0x800000;
  return (
    <section className="pool-key-details" aria-label="Pool configuration">
      <h3>Pool configuration</h3>
      <p>
        From PoolManager initialization. These settings identify this pool and
        are fixed at creation.
        {dynamic && " Its dynamic LP fee can change from swap to swap."}
      </p>
      <dl className="pool-key-values">
        <div>
          <dt>LP fee {dynamic ? "mode" : "rate"}</dt>
          <dd>{dynamic ? "Dynamic" : formatPoolFee(key.fee)}</dd>
        </div>
        <div>
          <dt>Tick spacing</dt>
          <dd>{count(key.tickSpacing)}</dd>
        </div>
        <div>
          <dt>Created at block</dt>
          <dd>
            {count(key.creationBlock)}
            <button
              className="icon-button"
              aria-label="Copy creation block"
              onClick={() =>
                void copy(String(key.creationBlock), "Creation block copied.")
              }
            >
              <Copy size={14} />
            </button>
          </dd>
        </div>
        {pool.createdAt && (
          <div>
            <dt>Created</dt>
            <dd>
              <time dateTime={pool.createdAt}>
                {timeDetail(pool.createdAt) ?? "Time unavailable"}
              </time>
            </dd>
          </div>
        )}
      </dl>
      <div className="pool-key-addresses">
        {[
          ["Currency 0", key.currency0],
          ["Currency 1", key.currency1],
          ["Hook", key.hookAddress],
          ["PoolManager", key.managerAddress],
        ].map(([label, address]) => {
          const token = label.startsWith("Currency")
            ? tokenMetadata.get(tokenMetadataKey(pool.chain, address))
            : undefined;
          return (
            <div key={label} className="pool-key-address">
              <span className="contract-caption">
                {label}
                {label.startsWith("Currency") &&
                  address === "0x0000000000000000000000000000000000000000" &&
                  " · native currency"}
                {token?.symbol && ` · ${token.symbol}`}
              </span>
              <div className="address-row">
                <code>
                  <HexIdentity value={address} />
                </code>
                <button
                  className="icon-button"
                  aria-label={`Copy ${label} address`}
                  onClick={() => void copy(address, `${label} address copied.`)}
                >
                  <Copy size={14} />
                </button>
                <ExplorerLink
                  href={explorerAddressUrl(explorer, address)}
                  label={`View ${label} on explorer`}
                />
              </div>
              {token && (
                <p
                  className="pool-token-metadata"
                  title={`Token contract metadata${token.updatedAt ? ` · checked ${timeDetail(token.updatedAt) ?? "at an unknown time"}` : ""}${token.status === "cached" ? " · saved data" : ""}`}
                >
                  {token.name && <span>{token.name}</span>}
                  {token.decimals !== null && (
                    <span>{token.decimals} decimals</span>
                  )}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function HexIdentity({ value }: { value: string }) {
  const chunks = value.match(/.{1,22}/g) || [value];
  return (
    <>
      {chunks.map((chunk, index) => (
        <span key={index}>
          {index > 0 && <wbr />}
          {chunk}
        </span>
      ))}
    </>
  );
}

function projectSummary(
  project: RadarProject,
  discovered: boolean,
  census: string | null,
): string {
  const protocol = getProtocolArtwork(project)?.protocol;
  // Summaries only apply to the same contextual identities used for original artwork.
  // Keep the full registry wording available in About this data.
  const summaries: Record<string, string> = {
    Frontier:
      "Token launches with customizable trading fees and pool extensions.",
    Euler: "Trading liquidity connected to Euler lending markets.",
    Clanker: "Token launches with trading fees that adapt to market activity.",
    Flaunch:
      "Token launches with trading fees that support the token’s market.",
    Angstrom:
      "Trading with auctions designed to reduce the impact of MEV on liquidity providers.",
    Doppler: "Token launches through onchain auctions and liquidity pools.",
    Arrakis: "Automated liquidity management for Uniswap pools.",
  };
  if (protocol && summaries[protocol]) return summaries[protocol];
  if (discovered) return discoverySummary(project, { census });
  return project.description || "Uniswap v4 pools and hook contracts.";
}
