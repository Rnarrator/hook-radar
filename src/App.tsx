import { ProtocolLogo } from "./components/ProtocolLogo";
import { ProjectMetricProof } from "./components/ProjectMetricProof";
import { DiscoverySources } from "./components/DiscoverySources";
import { useDiscoveryBootstrap } from "./useDiscoveryBootstrap";
import {
  LIVE_REFRESH_MS,
  catchUpDue,
  refreshInterval,
  snapshotNeed,
} from "./refresh-policy";
import { useProjectView } from "./useProjectView";
import { useAnalyticsOverview } from "./useAnalyticsOverview";
import type { DiscoveryEnvelope, DiscoveryPage } from "../shared/discovery";
import {
  lazy,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import {
  Activity,
  ArrowDown,
  ArrowLeftRight,
  BookOpen,
  ChartLine,
  Compass,
  GitCompareArrows,
  Orbit,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Code2,
  Download,
  Filter,
  Info,
  Logo,
  Layers,
  Network,
  Radio,
  RefreshCw,
  Search,
  Star,
  X,
} from "./components/Icons";
import type {
  DirectoryPage,
  Pool,
  RadarProject,
  RadarSnapshot,
  WindowKey,
  RadarStartupProgress,
} from "../shared/types";
import { safeStartupProgress } from "../shared/startup-progress";
import { decodeSnapshotResponse } from "../shared/snapshot-transport";
import { DASHBOARD_SNAPSHOT_ACCEPT } from "../shared/dashboard-profile";
import { analyticsOverviewExpiresAt } from "../shared/analytics-overview";
import { useCollectionProgress } from "./useCollectionProgress";
import { collectionProgressCopy } from "./collection-progress";
import { directorySearch, isDirectoryPage } from "./directory";
import {
  categories,
  count,
  isSnapshot,
  money,
  readWatchlist,
  relativeTime,
  safeUrl,
  projectComparator,
  windows,
} from "./model";
import type { Filters, PropertyFilter, SortKey, View } from "./model";
import { navigationSearch, parseNavigation, publicViewUrl } from "./navigation";
import type {
  AnalyticsRange,
  ChainRoleFilter,
  DetailTab,
  ExtensionSelection,
  SortOrder,
} from "./navigation";
import { selectProjects } from "./scope";
import { projectCsv } from "./export";
import { flashCopied } from "./copy-feedback";
import { useMediaQuery } from "./use-media-query";
import { measurementProvenance } from "./provenance";
import { useFrontierExtensionCount } from "./useFrontierExtensionCount";
import type { ExtensionCatalogSummary } from "./extensions";
import { buildChains, launchpadRegistry as platformStatusEntries } from "./chains";
import { LoadingPlates } from "./components/LoadingPlates";
import { External, Empty, Modal } from "./components/Primitives";
import {
  CommandPalette,
  isPaletteShortcut,
  paletteShortcutLabel,
} from "./components/CommandPalette";
import type { PaletteCommand } from "./components/CommandPalette";
// Keep view styles eager and in their original cascade order. Loading a
// workspace later must not override the shared responsive design system.
import "./components/extensions.css";
import "./components/project-detail.css";
import { Monitor } from "./components/Monitor";
import {
  HookSpotlight,
  SpotlightPlaceholder,
} from "./components/HookSpotlight";
import { MastheadFigures } from "./components/Masthead";
import { EcosystemMap } from "./components/EcosystemMap";
import { SiteFooter } from "./components/SiteFooter";
import {
  LAUNCHPAD_REVIEWED_AT,
  getLaunchpad,
} from "../shared/launchpad-registry.ts";
import { launchpadListingProjects } from "./launchpads";
import type {
  PlatformAvailability,
  PlatformMarket,
  PlatformRelationship,
} from "./components/PlatformDetail";
import { RadarInstrument } from "./components/RadarInstrument";
import { RegistryUpdates } from "./components/RegistryUpdates";
import { buildSpotlightEntries } from "./spotlight";
import "./components/coverage.css";
import { DiscoveryGuide } from "./components/DiscoveryGuide";
import "./components/comparison.css";
import "./components/activity.css";
import "./components/analytics.css";
import "./components/chains.css";
import { WatchChangeFeed } from "./components/WatchChangeFeed";
import { useWatchChanges } from "./useWatchChanges";
import {
  aggregateCurrentMarkets,
  expireProjectMetrics,
  refreshMarketSnapshot,
} from "../shared/market-freshness";
import "./components/market-coverage.css";
import { networkCaughtUp, networkHeadFresh } from "../shared/indexing";
import { coverageSummary } from "./coverage-summary";
import { reviewDate } from "./review-date";
import { ShortcutsDialog } from "./components/ShortcutsDialog";
import { prefersLessData } from "./data-saver";
import { duplicateFamilyNames } from "./provenance";
import {
  projectPoolCount,
  projectHookCount,
  poolCountIsObserved,
} from "./project-presentation";
import {
  FamilyFingerprint,
  MarketProvenanceStrip,
  MetricMeasurement,
} from "./MarketProvenance";
import { WorkspaceBoundary } from "./components/WorkspaceBoundary";
import { browserTitle } from "./browser-title";
import {
  EXPORT_FILES_NOTE,
  LIST_HOLDS,
  NO_MATCH_IN_SNAPSHOT,
  NO_POOLS_MEASURED,
  PROJECT_NOT_CARRIED,
  SOURCES_DIALOG,
  STATIC_EDITION,
  censusLabel,
  editionNavigation,
  editionViews,
  evaluationNow,
  exportScope,
  filtersNote,
  freezeEvaluationClock,
  fullTimeLabel,
  isOlderPublication,
  knownNetwork,
  listNoun,
  listScopeLabel,
  networkMenu,
  networksFigureNote,
  noPoolsOnNetwork,
  openingDetailTab,
  overviewFile,
  poolsFigureNote,
  prepareEditionSnapshot,
  projectsFigureNote,
  recentTradingCaption,
  snapshotFileName,
  snapshotUrl,
  unmeasuredCardNote,
  viewPublicationAt,
  watchlistScopeNote,
} from "./edition";
import {
  editionDirectory,
  loadRecordedHistory,
  takeEarlySnapshot,
} from "./edition-data";
import { useNewerPublication } from "./edition-status-probe";
import {
  NOT_PUBLISHED_TITLE,
  PUBLISHING_NOTE,
  RECONNECT_LIMIT,
  SAVED_LIST_MAX,
  SAVED_NAMES_KEY,
  SAVED_NONE_IN_SNAPSHOT,
  carriedFirst,
  createStallGuard,
  parseSavedNames,
  readJsonBody,
  reconcileStep,
  rememberSavedNames,
  savedExportNote,
  savedNotInSnapshot,
  savedNotInSnapshotNotice,
  snapshotFailureMessage,
  snapshotUrlFor,
} from "./edition-shell";
import type { SavedNames } from "./edition-shell";
import {
  EditionCensus,
  EditionRun,
  SnapshotLine,
} from "./components/EditionStatus";

const ProjectDetail = lazy(() =>
  import("./components/ProjectDetail").then((module) => ({
    default: module.ProjectDetail,
  })),
);
const PlatformDetail = lazy(() =>
  import("./components/PlatformDetail").then((module) => ({
    default: module.PlatformDetail,
  })),
);
const PoolCoverage = lazy(() =>
  import("./components/PoolCoverage").then((module) => ({
    default: module.PoolCoverage,
  })),
);
const HookComparison = lazy(() =>
  import("./components/HookComparison").then((module) => ({
    default: module.HookComparison,
  })),
);
const ActivityExplorer = lazy(() =>
  import("./components/ActivityExplorer").then((module) => ({
    default: module.ActivityExplorer,
  })),
);
const AnalyticsWorkspace = lazy(() =>
  import("./components/AnalyticsWorkspace").then((module) => ({
    default: module.AnalyticsWorkspace,
  })),
);
const AnalyticsOverview = lazy(() =>
  import("./components/AnalyticsOverview").then((module) => ({
    default: module.AnalyticsOverview,
  })),
);
const ChainExplorer = lazy(() =>
  import("./components/ChainExplorer").then((module) => ({
    default: module.ChainExplorer,
  })),
);
const MarketCoverage = lazy(() =>
  import("./components/MarketCoverage").then((module) => ({
    default: module.MarketCoverage,
  })),
);
const LearnHooks = lazy(() =>
  import("./components/LearnHooks").then((module) => ({
    default: module.LearnHooks,
  })),
);

const defaultFilters: Filters = {
  search: "",
  chain: "all",
  category: "all",
  property: "all",
  market: "projects",
};
const PAGE_SIZE = 25;
const NO_POOLS: Pool[] = [];
const NO_ADDRESSES: string[] = [];
/** Frontier's published extension modules, as text and hover explanation. */
function extensionCountText(summary: ExtensionCatalogSummary) {
  const soon = summary.total - summary.available;
  return {
    label: `${summary.total} ${summary.total === 1 ? "extension" : "extensions"}`,
    title: `Frontier's own catalog lists ${summary.total} extension modules: ${summary.available} available now${soon > 0 ? `, ${soon} coming soon` : ""}. Extensions are modules its hooks run for each pool; they are not separate hooks.`,
  };
}
/** The header status pill on a phone: the long messages in fewer words, so the
 * pill is never cut off mid-word (its title and the sources dialog keep the
 * full wording). */
const SHORT_STATUS: Readonly<Record<string, string>> = {
  "Pool history current": "History current",
  "Analytics unavailable": "Unavailable",
  "Data unavailable": "Unavailable",
  "Checking saved data": "Checking data",
  "Finding more pools": "Finding pools",
  "Sources connected": "Connected",
  "Data connected": "Connected",
};
function getInitialState() {
  return editionNavigation(parseNavigation(location.search));
}
const reviewDay = reviewDate;

/** Registry status as the platform drawer's availability readout. */
function registryAvailability(
  record: NonNullable<ReturnType<typeof getLaunchpad>>,
): PlatformAvailability {
  return {
    status: record.status,
    // A source review, not a live check: the date has its own line.
    note: record.statusNote,
    reviewed: `Reviewed from first-party sources on ${reviewDay(record.reviewedAt ?? LAUNCHPAD_REVIEWED_AT)}.`,
    evidenceUrl: record.docs,
  };
}

/** The operating status the launchpad catalog shows for a platform listing that
 * is not a reviewed registry record (for example Pools.xyz), as the drawer's
 * availability readout, so the catalog chip and the drawer never disagree. */
function platformAvailabilityFor(
  project: Pick<RadarProject, "id" | "entityType">,
): PlatformAvailability | undefined {
  if (project.entityType !== "platform") return undefined;
  const entry = Object.hasOwn(platformStatusEntries, project.id)
    ? platformStatusEntries[project.id]
    : undefined;
  if (!entry?.status || entry.status === "unverified") return undefined;
  return {
    status: entry.status,
    note: entry.statusNote,
    reviewed: `Reviewed from the platform's own pages on ${reviewDay(entry.reviewedAt)}.`,
    // No checkedAt: a review date is not a time-of-day check, and the review
    // line already carries the date.
    evidenceUrl: entry.statusSourceUrl,
  };
}

/** Launchpad to protocol links. Only shared protocols appear here; exact hooks
 * are listed separately and are never attributed to the platform's totals. */
function registryRelationships(
  record: NonNullable<ReturnType<typeof getLaunchpad>>,
): PlatformRelationship[] | undefined {
  const links = record.paths
    .filter((path) => path.attribution === "shared-protocol" && path.protocolId)
    .map((path) => ({
      protocolName:
        path.protocolId === "doppler" ? "Doppler" : path.protocolId!,
      protocolId: path.protocolId,
      chain: path.chain,
      status: path.status,
      evidenceUrl: path.evidence[0]?.url ?? null,
      note: path.summary,
    }));
  return links.length ? links : undefined;
}

/** A listing whose networks this directory does not know still opens. */
function launchpadFallbackProject(
  record: NonNullable<ReturnType<typeof getLaunchpad>>,
): RadarProject {
  return {
    id: record.id,
    entityType: "platform",
    name: record.name,
    description: record.description,
    category: "Launches",
    website: record.website,
    docs: record.docs,
    sourceUrl: record.docs,
    deployments: [],
    chains: [],
    metrics: {
      poolCount: null,
      liquidityUsd: null,
      volumeUsd: { h1: null, h6: null, h24: null },
      coverage: "unavailable",
      note: "Platform listing. Its networks are not indexed by this directory.",
    },
    history: [],
  };
}

/** Edition: the names of saved projects, from a storage key of their own (the
 * watchlist key holds ids and is written only by the visitor's own choices). */
function readSavedNames(): SavedNames {
  if (!STATIC_EDITION) return {};
  try {
    return parseSavedNames(localStorage.getItem(SAVED_NAMES_KEY));
  } catch {
    return {};
  }
}
function storeSavedNames(names: SavedNames) {
  try {
    localStorage.setItem(SAVED_NAMES_KEY, JSON.stringify(names));
  } catch {
    // Names are a convenience: the watchlist does not depend on them.
  }
}

/** Icons appear only in the phone dock; desktop navigation is text. */
function NavIcon({ view }: { view: View }) {
  const icons: Record<View, typeof Compass> = {
    overview: Compass,
    analytics: ChartLine,
    chains: Network,
    map: Orbit,
    learn: BookOpen,
    activity: Activity,
    compare: GitCompareArrows,
    watchlist: Star,
  };
  const Icon = icons[view];
  return <Icon className="nav-icon" size={20} />;
}
export default function App() {
  const initial = useMemo(getInitialState, []);
  const [sourceSnapshot, setSnapshot] = useState<RadarSnapshot | null>(null);
  const [visitorNow, setNow] = useState(Date.now());
  // The static edition judges the snapshot at its own publication time, so an
  // overview file loaded beside it (newer, older, from another run) never
  // changes how the snapshot's figures are read; the live page uses the clock.
  const snapshotTime = sourceSnapshot
    ? Date.parse(sourceSnapshot.generatedAt)
    : NaN;
  const now = STATIC_EDITION
    ? Number.isFinite(snapshotTime)
      ? snapshotTime
      : evaluationNow()
    : visitorNow;
  // The directory is a table above this width and a list of cards below it
  // (see discover.css); only the layout in use is rendered.
  const narrowList = useMediaQuery("(max-width: 52rem)");
  // Narrow phones only: the tight bar just above the dock layout keeps the full
  // wording and ellipsises it (compact.css), so one label reads the same on every
  // laptop width.
  const phoneHeader = useMediaQuery("(max-width: 30rem)");
  const snapshot = useMemo(
    () => (sourceSnapshot ? refreshMarketSnapshot(sourceSnapshot, now) : null),
    [sourceSnapshot, now],
  );
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [serviceStarting, setServiceStarting] = useState(false);
  const [startupTakingLonger, setStartupTakingLonger] = useState(false);
  const [startupProgress, setStartupProgress] =
    useState<RadarStartupProgress | null>(null);
  const [connectionFailures, setConnectionFailures] = useState(0);
  const [view, setViewState] = useState<View>(initial.view);
  const [comparison, setComparison] = useState<string[]>(
    initial.comparison || [],
  );
  // Edition: ids a link names that the snapshot does not carry stay in the
  // address (Compare lists them), but they are not selected projects, so the
  // badge, the tray and the four places leave them out.
  const carriedComparison = useMemo(() => {
    if (!STATIC_EDITION || !sourceSnapshot) return comparison;
    const known = new Set(sourceSnapshot.projects.map((project) => project.id));
    return comparison.filter((id) => known.has(id));
  }, [comparison, sourceSnapshot]);
  const [comparisonChain, setComparisonChain] = useState(
    initial.comparisonChain || "all",
  );
  const [activityProject, setActivityProject] = useState<string | null>(
    initial.activityProject || null,
  );
  const [activitySelection, setActivitySelection] = useState(
    initial.activitySelection!,
  );
  const [analyticsChain, setAnalyticsChain] = useState(
    initial.analyticsChain || "all",
  );
  const [analyticsRange, setAnalyticsRange] = useState<AnalyticsRange>(
    initial.analyticsRange || "d7",
  );
  const [chainNetwork, setChainNetwork] = useState(
    initial.chainNetwork || "all",
  );
  const [chainSearch, setChainSearch] = useState(initial.chainSearch || "");
  const [chainRole, setChainRole] = useState<ChainRoleFilter>(
    initial.chainRole || "all",
  );
  const [filters, setFilters] = useState<Filters>(initial.filters);
  const [windowKey, setWindow] = useState<WindowKey>(initial.window);
  const [sort, setSort] = useState<SortOrder>(initial.sort);
  const [selectedTab, setSelectedTab] = useState<DetailTab>(initial.detailTab);
  const [selectedExtension, setSelectedExtension] =
    useState<ExtensionSelection | null>(initial.extensionSelection || null);
  const [page, setPage] = useState(1);
  const [showFilters, setShowFilters] = useState(
    initial.filters.property !== "all",
  );
  const [mobileMonitorOpen, setMobileMonitorOpen] = useState(false);
  const [mobileStatsOpen, setMobileStatsOpen] = useState(false);
  const [watchlist, setWatchlist] = useState<string[]>(readWatchlist);
  // Edition: the name each saved project had when a snapshot last carried it,
  // so a saved project that drops out of a snapshot is still named.
  const [savedNames, setSavedNames] = useState<SavedNames>(readSavedNames);
  const [selectedId, setSelectedIdState] = useState<string | null>(
    initial.project,
  );
  const [requestedModal, setModal] = useState<
    "sources" | "share" | "shortcuts" | null
  >(null);
  // A build without the Data & sources dialog (the edition, by its owner's
  // choice: EDITION_SOURCES_DIALOG) never has it open, whatever asked for it.
  const modal =
    requestedModal === "sources" && !SOURCES_DIALOG ? null : requestedModal;
  // The one way into the dialog; undefined where the build has none, and every
  // control that would open it is then left out.
  const openSources = SOURCES_DIALOG ? () => setModal("sources") : undefined;
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [toastTone, setToastTone] = useState<"success" | "info" | "error">(
    "success",
  );
  const [discoveryContext, setDiscoveryContext] = useState<{
    key: string;
    data: DiscoveryEnvelope;
  } | null>(null);
  const [discoveryRecoveryRevision, setDiscoveryRecoveryRevision] = useState(0);
  // The lightweight discovery layout is fed by a service the static edition
  // does not have: its pages always use the snapshot's own rows.
  const [discoveryShell, setDiscoveryShell] = useState(
    !STATIC_EDITION &&
      ["overview", "map", "watchlist"].includes(initial.view) &&
      !initial.project,
  );
  const bulkStarted = useRef(false);
  // A visitor whose browser asks for less data gets the small discovery page; the
  // full snapshot (several MB) is loaded when they ask for it or open a view
  // that is built from it. Decided once per page load.
  const [savingData] = useState(prefersLessData);
  // When the full snapshot and the discovery page were last confirmed current.
  const lastSnapshotAt = useRef<number | null>(null);
  const lastDiscoveryAt = useRef<number | null>(null);
  const discoverySeen = useRef<DiscoveryEnvelope | null>(null);
  const [discoveryRefresh, setDiscoveryRefresh] = useState(0);
  const [directoryResult, setDirectoryResult] = useState<{
    key: string;
    data: DirectoryPage;
  } | null>(null);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [directoryError, setDirectoryError] = useState("");
  const [directoryRetry, setDirectoryRetry] = useState(0);
  const [hydratedProject, setHydratedProject] = useState<RadarProject | null>(
    null,
  );
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [detailRetry, setDetailRetry] = useState(0);
  const [analyticsExpanded, setAnalyticsExpanded] = useState(false);
  const [analyticsRetry, setAnalyticsRetry] = useState(0);
  // The static edition opens Analytics from its published overview whenever a
  // file exists for the chosen network and window; the snapshot, once loaded,
  // serves the full view behind "Open full analytics".
  const analyticsLite = STATIC_EDITION
    ? view === "analytics" &&
      !analyticsExpanded &&
      !selectedId &&
      overviewFile({ chain: analyticsChain, window: windowKey }) !== null
    : view === "analytics" && !snapshot && !analyticsExpanded && !selectedId;
  // Edition: the run an overview file is asked for under its own address, when
  // an edge may be holding the old one (see the reconcile effect below).
  const [overviewRunWanted, setOverviewRunWanted] = useState<string | null>(
    null,
  );
  const overview = useAnalyticsOverview(
    analyticsLite,
    { chain: analyticsChain, window: windowKey },
    analyticsRetry,
    overviewRunWanted,
  );
  // Each page is judged at the publication it is drawn from: the overview for
  // the lightweight Analytics page, the snapshot for every other page. Set
  // here, in the render, so that everything below (which reads the clock by
  // default) sees the time of the right file.
  if (STATIC_EDITION)
    freezeEvaluationClock(
      viewPublicationAt({
        lite: analyticsLite,
        snapshotAt: sourceSnapshot?.generatedAt,
        overviewAt: overview.data?.publication.generatedAt,
      }),
    );
  const overviewTime = overview.data
    ? Date.parse(overview.data.publication.generatedAt)
    : NaN;
  const overviewNow =
    STATIC_EDITION && Number.isFinite(overviewTime) ? overviewTime : now;
  // Edition: a small status check says when the site holds a later run than the
  // file this page is drawn from (never on the guide, which loads no data).
  const { newerAt: newerPublication, checked: publicationChecked } =
    useNewerPublication(
      analyticsLite
        ? overview.data?.publication.generatedAt
        : sourceSnapshot?.generatedAt,
      STATIC_EDITION && view !== "learn",
    );
  function retryOverview() {
    setOverviewRunWanted(null);
    setAnalyticsRetry((n) => n + 1);
  }
  // Whether the all-network history series has points, remembered across a
  // switch to one network (whose envelope does not carry it).
  const [analyticsSeries, setAnalyticsSeries] = useState(false);
  useEffect(() => {
    const history = overview.data?.history;
    if (history?.available) setAnalyticsSeries(history.points.length > 0);
  }, [overview.data]);
  // A reviewed launchpad listing has no service-side record yet: its drawer is
  // built from the registry. A project the service publishes always wins.
  const registryRecord =
    selectedId &&
    !snapshot?.projects.some((project) => project.id === selectedId)
      ? getLaunchpad(selectedId)
      : null;
  // The platform drawer shows the same measured pools of its own exact hooks as
  // the Launchpads list (one cached derivation per snapshot, window and clock).
  const registryMarket = useMemo<PlatformMarket | null>(() => {
    if (!registryRecord || !snapshot) return null;
    const row = buildChains(snapshot, {
      role: "launchpads",
      windowKey,
      now,
    }).protocols.find((item) => item.project.id === registryRecord.id);
    const attribution = row?.attribution;
    if (!row || !attribution || attribution.mappedHooks === 0) return null;
    return {
      mappedHooks: attribution.mappedHooks,
      hooksWithPools: attribution.hooksWithPools,
      pools: row.observedPools,
      volumeUsd: row.volumeUsd,
      volumePools: row.volumePools,
      windowLabel: windows[windowKey],
    };
  }, [registryRecord, snapshot, windowKey, now]);
  const fastDetails = useProjectView(
    registryRecord ? null : selectedId,
    !STATIC_EDITION && !snapshot && !serviceStarting,
    detailRetry,
  );
  const [exporting, setExporting] = useState(false);
  const requestRef = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const navigationRef = useRef<HTMLElement>(null);
  const directoryHeadingRef = useRef<HTMLHeadingElement>(null);
  const viewHeadingRef = useRef<HTMLHeadingElement>(null);
  const pendingViewFocus = useRef<View | null>(null);
  // Edition: a Retry that was pressed, and whether its request has started. The
  // button stays where it is while the request runs; when the request succeeds
  // the error notice (and the button) goes, and focus moves to the page's
  // heading instead of dropping to the top of the document.
  const retryFocus = useRef<"pressed" | "busy" | null>(null);
  useEffect(() => {
    if (!STATIC_EDITION || retryFocus.current === null) return;
    const busy = analyticsLite ? overview.loading : loading || refreshing;
    if (retryFocus.current === "pressed") {
      if (busy) retryFocus.current = "busy";
      return;
    }
    if (busy) return;
    retryFocus.current = null;
    if (!(analyticsLite ? overview.error : error))
      viewHeadingRef.current?.focus({ preventScroll: true });
  }, [
    analyticsLite,
    overview.loading,
    overview.error,
    loading,
    refreshing,
    error,
  ]);
  const requestAbortRef = useRef<AbortController | null>(null);
  const startupViewAttempted = useRef(false);
  const responseEtagRef = useRef<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Files from two runs are never mixed (a deploy can land between the two
  // requests, or an edge can still hold the old file). The older one is asked
  // for again under the newer run's address, up to three times; if it still
  // does not match, the page says a newer snapshot is still being published and
  // each page stays judged at its own file's time.
  const overviewRun = overview.data?.publication.generatedAt ?? null;
  const reconcileTries = useRef({ pair: "", used: 0 });
  const [publishingLate, setPublishingLate] = useState(false);
  // Counts the snapshot requests that have finished, so the effect below looks
  // again at what each one brought.
  const [snapshotFetches, setSnapshotFetches] = useState(0);
  useEffect(() => {
    if (!STATIC_EDITION || !overviewRun || !sourceSnapshot) return;
    // A request on its way settles first; this runs again when it has.
    if (overview.loading || requestRef.current) return;
    const pair = `${overviewRun}|${sourceSnapshot.generatedAt}`;
    if (reconcileTries.current.pair !== pair)
      reconcileTries.current = { pair, used: 0 };
    const step = reconcileStep(
      overviewRun,
      sourceSnapshot.generatedAt,
      reconcileTries.current.used,
    );
    setPublishingLate(step === "late");
    if (step === "settled" || step === "late") {
      // The files are as alike as they will get: the next request for the
      // overview goes to its plain address again.
      setOverviewRunWanted(null);
      return;
    }
    // The overview is read only while Analytics is open; it is asked for again
    // when that page is.
    if (step === "reload-overview" && !analyticsLite) return;
    const timer = setTimeout(() => {
      reconcileTries.current.used += 1;
      if (step === "reload-snapshot")
        void fetchSnapshot(false, true, overviewRun);
      else {
        setOverviewRunWanted(sourceSnapshot.generatedAt);
        setAnalyticsRetry((n) => n + 1);
      }
    }, reconcileTries.current.used * 1000);
    return () => clearTimeout(timer);
  }, [
    overviewRun,
    sourceSnapshot,
    overview.loading,
    overview.error,
    snapshotFetches,
    analyticsLite,
  ]);
  const discoveryView =
    view === "overview" || view === "map" || view === "watchlist";
  const directoryParams = directorySearch(
    filters,
    sort,
    windowKey,
    view === "watchlist" ? watchlist : undefined,
  );
  directoryParams.set("offset", String((page - 1) * PAGE_SIZE));
  directoryParams.set("limit", String(PAGE_SIZE));
  // An empty watchlist is a scope, not an unfiltered request.
  if (view === "watchlist") directoryParams.set("saved", "1");
  const directoryKey = directoryParams.toString();
  // Discover, the map and the watchlist read their rows, coverage and status
  // from the small discovery page, which is refreshed on its own. The full
  // snapshot is not what these layouts are built from (see refresh-policy.ts).
  const discoveryFeeding = discoveryView && discoveryShell;
  const discovery = useDiscoveryBootstrap({
    // A saved presentation held under the startup gate is never promoted by a
    // canonical read: the page waits for a validated ordinary snapshot first.
    enabled:
      discoveryFeeding && !selectedId && !(serviceStarting && sourceSnapshot),
    query: directoryKey,
    retry: directoryRetry,
    recoveryRevision: discoveryRecoveryRevision,
    refreshKey: discoveryRefresh,
  });
  useEffect(() => {
    if (discovery.status === "ready" && discovery.key === directoryKey) {
      // Only a page that arrived counts as a confirmation, not a re-run caused
      // by paging.
      if (discoverySeen.current !== discovery.data) {
        discoverySeen.current = discovery.data;
        lastDiscoveryAt.current = Date.now();
      }
      setDiscoveryContext({ key: discovery.key, data: discovery.data });
      setPage((current) =>
        current === page
          ? Math.floor(discovery.data.page.offset / PAGE_SIZE) + 1
          : current,
      );
    } else if (discovery.status === "recovering") {
      setDiscoveryContext(null);
      setServiceStarting(true);
      setStartupProgress(discovery.progress);
    }
  }, [discovery, directoryKey, page]);
  // Each visit to Discover, the map or the watchlist opens the lightweight
  // layout; "Full overview" is a choice made for that visit only. Decided
  // while rendering, so the first frame of a visit is already the right layout
  // and no full-layout request starts for it.
  const [shellView, setShellView] = useState(discoveryView);
  if (shellView !== discoveryView) {
    setShellView(discoveryView);
    setDiscoveryShell(discoveryView && !STATIC_EDITION);
  }
  useEffect(() => {
    if (!STATIC_EDITION && discoveryView && !sourceSnapshot)
      setDiscoveryShell(true);
  }, [discoveryView, sourceSnapshot]);
  // The service finished starting: ask the discovery page again, since a
  // refresh that met the startup gate is not repeated on its own.
  const wasStarting = useRef(serviceStarting);
  useEffect(() => {
    if (wasStarting.current && !serviceStarting)
      setDiscoveryRecoveryRevision((value) => value + 1);
    wasStarting.current = serviceStarting;
  }, [serviceStarting]);
  const directoryStarting = serviceStarting && !discoveryContext;
  // The layout actually on screen: rows from the discovery page, no polling of
  // the full snapshot unless something shown needs it.
  const shellLayout = discoveryFeeding && discoveryContext !== null;
  const need = snapshotNeed({
    view,
    detailOpen: Boolean(selectedId) || modal === "sources",
    discoveryShell: shellLayout,
    savedCount: watchlist.length,
  });
  // Indexing progress asks the service's health report every 15 seconds while
  // any network is catching up (about 100 KB each). Only the full layout and
  // the Data & sources panel draw it, so the light layout does not ask.
  const collectionProgress = useCollectionProgress(
    STATIC_EDITION || (shellLayout && modal !== "sources")
      ? undefined
      : snapshot?.inventory,
  );
  const needRef = useRef(need);
  needRef.current = need;
  const shellRef = useRef(shellLayout && !selectedId);
  shellRef.current = shellLayout && !selectedId;
  const useDirectory = Boolean(
    discoveryView &&
    !directoryStarting &&
    (snapshot?.directory || discoveryContext) &&
    (filters.market === "all" || view === "watchlist" || discoveryContext),
  );
  const discoveryRows =
    discoveryContext?.key === directoryKey ? discoveryContext.data.page : null;
  const rawRemote: DirectoryPage | DiscoveryPage | null = !useDirectory
    ? null
    : shellLayout
      ? discoveryRows
      : directoryResult?.key === directoryKey
        ? directoryResult.data
        : discoveryRows;
  // The discovery page feeds the list in the light layout, and before any
  // snapshot exists. If it fails while the snapshot is there, the full layout
  // (the directory page) takes over without reporting the lighter failure.
  const discoveryDrives = discoveryFeeding && (shellLayout || !sourceSnapshot);
  const directoryBusy =
    directoryLoading || (discoveryDrives && discovery.status === "loading");
  const directoryFailure =
    directoryError ||
    (discoveryDrives && discovery.status === "error" ? discovery.message : "");
  const deferredPoolMembership = Boolean(
    rawRemote && !("poolIds" in rawRemote.scope),
  );
  const remote = useMemo(
    () =>
      rawRemote
        ? {
            ...rawRemote,
            projects: rawRemote.projects.map((project) =>
              expireProjectMetrics(project, now),
            ),
          }
        : null,
    [rawRemote, now],
  );
  const watchChanges = useWatchChanges(
    sourceSnapshot,
    watchlist,
    !serviceStarting && !error && !loading,
  );
  useEffect(() => {
    if (!useDirectory || !snapshot || shellLayout) {
      setDirectoryLoading(false);
      setDirectoryError("");
      return;
    }
    const controller = new AbortController();
    setDirectoryLoading(true);
    setDirectoryError("");
    const deadline = setTimeout(() => controller.abort(), 30000);
    const delay = setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(
            directoryKey.length > 6000
              ? "/api/directory"
              : `/api/directory?${directoryKey}`,
            {
              signal: controller.signal,
              ...(directoryKey.length > 6000
                ? {
                    method: "POST",
                    headers: {
                      "Content-Type":
                        "application/x-www-form-urlencoded;charset=UTF-8",
                    },
                    body: directoryKey,
                  }
                : {}),
            },
          );
          if (!response.ok)
            throw new Error(
              response.status === 429
                ? "Too many searches. Try again shortly."
                : "The hook directory could not load. Please retry.",
            );
          const value: unknown = await response.json();
          if (!isDirectoryPage(value, snapshot))
            throw new Error(
              "The hook directory returned an unsupported response.",
            );
          if (controller.signal.aborted) return;
          setDirectoryResult({ key: directoryKey, data: value });
          // A response may finish in the same turn as a newer page selection.
          // Only clamp the page that this request actually acknowledged.
          setPage((current) =>
            current === page
              ? Math.floor(value.offset / PAGE_SIZE) + 1
              : current,
          );
        } catch (cause) {
          if (!controller.signal.aborted || !disposed)
            setDirectoryError(
              controller.signal.aborted
                ? "The hook directory took too long. Please retry."
                : cause instanceof Error &&
                    !["TypeError", "SyntaxError"].includes(cause.name)
                  ? cause.message
                  : "The hook directory could not load. Check your connection and retry.",
            );
        } finally {
          clearTimeout(deadline);
          if (!disposed) setDirectoryLoading(false);
        }
      })();
    }, 180);
    let disposed = false;
    return () => {
      disposed = true;
      clearTimeout(delay);
      clearTimeout(deadline);
      controller.abort();
    };
  }, [
    useDirectory,
    shellLayout,
    directoryKey,
    sourceSnapshot,
    directoryRetry,
    page,
  ]);
  // The hydration below re-runs with every published frame (it keeps a complete
  // project paired with the latest snapshot; the Frontier navigation suite
  // depends on it). A project the service reported missing is remembered, so a
  // rebuilt frame never clears its error or asks for it again: it stays missing
  // until the person retries.
  const missingDetail = useRef<{
    id: string;
    retry: number;
    source: RadarSnapshot | null;
  } | null>(null);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const sourceRef = useRef(sourceSnapshot);
  sourceRef.current = sourceSnapshot;
  const directoryMode = Boolean(snapshot?.directory);
  const inSnapshot = Boolean(
    selectedId && snapshot?.projects.some((p) => p.id === selectedId),
  );
  useEffect(() => {
    setHydratedProject((previous) =>
      previous?.id === selectedId ? previous : null,
    );
    // A project the service reported missing is asked about again only when a
    // newly published snapshot arrives (and then quietly, keeping its message
    // on screen), never because the derived frame was rebuilt by the clock.
    const miss = missingDetail.current;
    const wasMissing = miss?.id === selectedId && miss.retry === detailRetry;
    const sameFrame = wasMissing && miss.source === sourceRef.current;
    if (!wasMissing) setDetailError("");
    const frame = snapshotRef.current;
    if (
      !selectedId ||
      registryRecord ||
      serviceStarting ||
      !directoryMode ||
      !frame ||
      inSnapshot
    ) {
      setDetailLoading(false);
      return;
    }
    if (sameFrame) {
      setDetailLoading(false);
      return;
    }
    const controller = new AbortController();
    let disposed = false;
    if (!wasMissing) setDetailLoading(true);
    const deadline = setTimeout(() => controller.abort(), 30000);
    void (async () => {
      try {
        const response = await fetch(
          `/api/projects/${encodeURIComponent(selectedId)}`,
          { signal: controller.signal },
        );
        if (response.status === 404) {
          missingDetail.current = {
            id: selectedId,
            retry: detailRetry,
            source: sourceRef.current,
          };
          throw new Error("This project is no longer in the directory.");
        }
        if (!response.ok)
          throw new Error("Hook details could not load. Please retry.");
        const value: unknown = await response.json();
        if (
          !isSnapshot({
            ...frame,
            presentation: undefined,
            directory: undefined,
            projects: [value],
          }) ||
          (value as RadarProject).id !== selectedId
        )
          throw new Error("Hook details returned an unsupported response.");
        if (!disposed) {
          missingDetail.current = null;
          setDetailError("");
          setHydratedProject(value as RadarProject);
        }
      } catch (cause) {
        if (!disposed)
          setDetailError(
            controller.signal.aborted
              ? "Hook details took too long. Please retry."
              : cause instanceof Error &&
                  !["TypeError", "SyntaxError"].includes(cause.name)
                ? cause.message
                : "Hook details could not load. Check your connection and retry.",
          );
      } finally {
        clearTimeout(deadline);
        if (!disposed) setDetailLoading(false);
      }
    })();
    return () => {
      disposed = true;
      clearTimeout(deadline);
      controller.abort();
    };
  }, [
    selectedId,
    snapshot,
    directoryMode,
    inSnapshot,
    detailRetry,
    serviceStarting,
    registryRecord,
  ]);

  function navigationUrl(
    nextView = view,
    nextProject = selectedId,
    nextTab = selectedTab,
    analyticsScope = { chain: analyticsChain, range: analyticsRange },
    chainScope = {
      network: chainNetwork,
      search: chainSearch,
      role: chainRole,
    },
    extensionScope = nextProject === selectedId ? selectedExtension : null,
  ) {
    return (
      location.pathname +
      navigationSearch({
        view: nextView,
        filters,
        window: windowKey,
        project: nextProject,
        detailTab: nextTab,
        extensionSelection: extensionScope,
        sort,
        comparison,
        comparisonChain,
        activityProject,
        activitySelection,
        analyticsChain: analyticsScope.chain,
        analyticsRange: analyticsScope.range,
        chainNetwork: chainScope.network,
        chainSearch: chainScope.search,
        chainRole: chainScope.role,
      }) +
      location.hash
    );
  }
  function changeChainNetwork(network: string) {
    if (network === chainNetwork) return;
    history.pushState(
      { radar: true },
      "",
      navigationUrl(view, selectedId, selectedTab, undefined, {
        network,
        search: chainSearch,
        role: chainRole,
      }),
    );
    setChainNetwork(network);
  }
  function changeChainRole(role: ChainRoleFilter) {
    if (role === chainRole) return;
    history.pushState(
      { radar: true },
      "",
      navigationUrl(view, selectedId, selectedTab, undefined, {
        network: chainNetwork,
        search: chainSearch,
        role,
      }),
    );
    setChainRole(role);
  }
  function openChainAnalytics(chain: string) {
    pendingViewFocus.current = "analytics";
    setSelectedIdState(null);
    history.pushState(
      { radar: true },
      "",
      navigationUrl("analytics", null, selectedTab, {
        chain,
        range: analyticsRange,
      }),
    );
    setAnalyticsChain(chain);
    setViewState("analytics");
  }
  function openLaunchpads() {
    const scope = {
      network: filters.chain,
      search: "",
      role: "launchpads" as const,
    };
    pendingViewFocus.current = "chains";
    // Keep Discover's filters intact for Back, but start a clean protocol search.
    history.pushState(
      { radar: true },
      "",
      navigationUrl("chains", null, selectedTab, undefined, scope, null).split(
        "#",
      )[0],
    );
    setSelectedIdState(null);
    setSelectedExtension(null);
    setChainNetwork(scope.network);
    setChainSearch("");
    setChainRole("launchpads");
    setViewState("chains");
  }
  function openChain(chain: string) {
    pendingViewFocus.current = "chains";
    setSelectedIdState(null);
    setSelectedExtension(null);
    history.pushState(
      { radar: true },
      "",
      navigationUrl("chains", null, selectedTab, undefined, {
        network: chain,
        search: "",
        role: "all",
      }, null).split("#")[0],
    );
    setChainNetwork(chain);
    setChainSearch("");
    setChainRole("all");
    setViewState("chains");
  }
  function runPaletteCommand(command: PaletteCommand) {
    switch (command.type) {
      case "view":
        setView(command.view);
        break;
      case "network":
        openChain(command.chain);
        break;
      case "launchpads":
        openLaunchpads();
        break;
      case "platform":
      case "project":
        setSelectedId(command.id);
        break;
      case "search": {
        // Directory search lives on Discover. A search from the palette is a
        // fresh intent, so it starts from the default filters, not the old ones.
        const address = /^0x[a-fA-F0-9]{40}$/.test(command.query.trim());
        setFilters({
          ...defaultFilters,
          search: command.query,
          market: address ? "all" : "projects",
        });
        setView("overview");
        break;
      }
      case "refresh":
        if (analyticsLite) setAnalyticsRetry((n) => n + 1);
        else void fetchSnapshot(true);
        break;
      case "copy-link":
        void copy(shareLink, "View link copied.");
        break;
      case "copy-address":
        void copy(command.address, "Hook address copied.");
        break;
    }
  }
  function changeAnalyticsChain(chain: string) {
    if (chain === analyticsChain) return;
    history.pushState(
      { radar: true },
      "",
      navigationUrl(view, selectedId, selectedTab, {
        chain,
        range: analyticsRange,
      }),
    );
    setAnalyticsChain(chain);
  }
  // Edition: the "All networks" button of an Analytics page with no figures is
  // replaced as soon as the all-networks page starts to load, which would drop
  // keyboard focus to the document. Focus moves to the page's heading first.
  function showAllAnalyticsNetworks() {
    if (analyticsChain === "all") return;
    if (STATIC_EDITION) viewHeadingRef.current?.focus({ preventScroll: true });
    changeAnalyticsChain("all");
  }
  function changeAnalyticsRange(range: AnalyticsRange) {
    if (range === analyticsRange) return;
    history.pushState(
      { radar: true },
      "",
      navigationUrl(view, selectedId, selectedTab, {
        chain: analyticsChain,
        range,
      }),
    );
    setAnalyticsRange(range);
  }
  function setView(next: View) {
    if (next === view) return;
    pendingViewFocus.current = next;
    if (next === "watchlist" && filters.market === "projects")
      setFilters((previous) => ({ ...previous, market: "all" }));
    history.pushState({ radar: true }, "", navigationUrl(next));
    setViewState(next);
  }
  function openActivity(
    id: string | null = activityProject,
    chain = "all",
    poolScope?: { poolId: string; hookAddress: string },
  ) {
    pendingViewFocus.current = "activity";
    const nextActivitySelection = {
      chain,
      window: "h24" as const,
      poolId: poolScope?.poolId || "",
      hookAddress: poolScope?.hookAddress || "",
    };
    setSelectedIdState(null);
    setActivityProject(id);
    setActivitySelection(nextActivitySelection);
    setViewState("activity");
    history.pushState(
      { radar: true },
      "",
      location.pathname +
        navigationSearch({
          view: "activity",
          filters,
          window: windowKey,
          project: null,
          detailTab: selectedTab,
          sort,
          comparison,
          comparisonChain,
          activityProject: id,
          activitySelection: nextActivitySelection,
        }),
    );
  }
  function toggleComparison(id: string) {
    if (carriedComparison.includes(id))
      setComparison((ids) => ids.filter((value) => value !== id));
    else if (carriedComparison.length < 4)
      setComparison((ids) => {
        const next = [...ids, id];
        // The address keeps four ids: the ones the snapshot lacks go last, and
        // the state is cut to the same four so an id the address has dropped
        // does not linger in Compare's notice.
        return STATIC_EDITION && sourceSnapshot
          ? carriedFirst(
              next,
              new Set(sourceSnapshot.projects.map((project) => project.id)),
            ).slice(0, 4)
          : next;
      });
    else
      notify("Compare up to four projects. Remove one to add another.", "info");
  }
  /** Edition: a hook project the snapshot carries without one measured pool
   * opens on its Hooks tab; the Pools tab would only be empty. */
  function openingTab(id: string): DetailTab {
    if (!STATIC_EDITION || !snapshot) return "pools";
    return openingDetailTab(
      snapshot.projects.find((item) => item.id === id),
      snapshot.pools.some((pool) => pool.projectId === id),
    );
  }
  function setSelectedId(next: string | null, requestedTab?: DetailTab) {
    if (next === selectedId) return;
    const nextTab: DetailTab =
      requestedTab ?? (next ? openingTab(next) : "pools");
    if (next) {
      setModal(null);
      setSelectedTab(nextTab);
      setSelectedExtension(null);
    }
    if (next) {
      history.pushState(
        { radar: true, radarProjectOpened: true },
        "",
        navigationUrl(view, next, nextTab),
      );
      setSelectedIdState(next);
    } else if (history.state?.radarProjectOpened) history.back();
    else setSelectedIdState(null);
  }
  function changeExtensionSelection(next: ExtensionSelection | null) {
    history.pushState(
      { radar: true },
      "",
      navigationUrl(
        view,
        selectedId,
        "deployments",
        undefined,
        undefined,
        next,
      ),
    );
    setSelectedTab("deployments");
    setSelectedExtension(next);
  }
  function changeDetailTab(next: DetailTab) {
    setSelectedTab(next);
    if (next !== "deployments") setSelectedExtension(null);
  }
  function notify(
    message: string,
    tone: "success" | "info" | "error" = "success",
  ) {
    setToastTone(tone);
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 4200);
  }
  async function fetchSnapshot(
    manual = false,
    quiet = false,
    /** Edition: the run the file should belong to (see the reconcile effect). */
    newerThan?: string,
  ) {
    if (requestRef.current) return;
    requestRef.current = true;
    if (manual) setRefreshing(true);
    else if (!quiet) setLoading(true);
    const controller = new AbortController();
    requestAbortRef.current = controller;
    // The live page gives the whole download 90 s. The edition gives up on a
    // download that has stopped, however long the file takes on a slow link.
    const stall = STATIC_EDITION
      ? createStallGuard(() => controller.abort())
      : null;
    const timer = stall
      ? undefined
      : setTimeout(() => controller.abort(), 90000);
    try {
      // The recorded history is read beside the snapshot, not after it.
      const recorded = STATIC_EDITION
        ? loadRecordedHistory(controller.signal)
        : null;
      // The static edition reads the one published file; the host revalidates
      // it. No service is asked and nothing is refreshed on request. The first
      // plain request takes the request the page started before its scripts
      // loaded (the head script in vite.config.ts: the same address, the same
      // `no-cache` mode, so a host's `max-age` cannot keep an old snapshot on
      // screen); every retry or later request makes its own, and a repeat that
      // wants a given run is asked for under that run's address.
      const early =
        STATIC_EDITION && !newerThan
          ? takeEarlySnapshot(snapshotUrl(), controller.signal)
          : null;
      const response = early
        ? await early
        : STATIC_EDITION && newerThan
          ? await fetch(snapshotUrlFor(newerThan), {
              signal: controller.signal,
              cache: "no-cache",
            })
          : STATIC_EDITION
            ? await fetch(snapshotUrl(), {
                signal: controller.signal,
                cache: "no-cache",
              })
            : await fetch(manual ? "/api/refresh" : "/api/snapshot", {
                method: manual ? "POST" : "GET",
                signal: controller.signal,
                headers: {
                  Accept: DASHBOARD_SNAPSHOT_ACCEPT,
                  ...(!manual && responseEtagRef.current
                    ? { "If-None-Match": responseEtagRef.current }
                    : {}),
                },
              });
      if (response.status === 304 && responseEtagRef.current) {
        lastSnapshotAt.current = Date.now();
        setNow(evaluationNow());
        setError("");
        setServiceStarting(false);
        setStartupProgress(null);
        setConnectionFailures(0);
        return;
      }
      if (response.status === 503) {
        const failure: unknown = await response.json().catch(() => null);
        if (
          failure !== null &&
          typeof failure === "object" &&
          "code" in failure &&
          failure.code === "RADAR_STARTING"
        ) {
          setServiceStarting(true);
          setDiscoveryContext(null);
          setDirectoryResult(null);
          setDiscoveryRecoveryRevision((value) => value + 1);
          setStartupProgress(
            safeStartupProgress(
              "startupProgress" in failure ? failure.startupProgress : null,
            ),
          );
          setError("");
          setConnectionFailures(0);
          if (!snapshot && !startupViewAttempted.current) {
            startupViewAttempted.current = true;
            try {
              const saved = await fetch("/api/startup-snapshot", {
                signal: controller.signal,
                headers: { Accept: DASHBOARD_SNAPSHOT_ACCEPT },
              });
              if (
                saved.ok &&
                saved.headers.get("X-Radar-Starting") === "true"
              ) {
                const presentation: unknown = decodeSnapshotResponse(
                  await saved.json(),
                );
                if (
                  isSnapshot(presentation) &&
                  presentation.status === "cached"
                ) {
                  setNow(evaluationNow());
                  setSnapshot(presentation);
                }
              }
            } catch {
              // Optional saved presentation never weakens the ordinary recovery gate.
            }
          }
          return;
        }
      }
      if (!response.ok)
        throw new Error(
          STATIC_EDITION
            ? snapshotFailureMessage({
                kind: "status",
                status: response.status,
              })
            : response.status === 429
              ? "Refresh is cooling down. Try again shortly."
              : response.status >= 500
                ? "The data service is temporarily unavailable. Please retry."
                : "We couldn’t load the latest data. Please retry.",
        );
      const refreshPending =
        manual &&
        (response.status === 202 ||
          response.headers.get("X-Radar-Refreshing") === "true");
      const refreshPendingMessage =
        "Refresh is running in the background. Your view will update automatically.";
      const etag = response.headers.get("ETag");
      if (etag && etag === responseEtagRef.current) {
        lastSnapshotAt.current = Date.now();
        setNow(evaluationNow());
        setError("");
        setServiceStarting(false);
        setStartupProgress(null);
        setConnectionFailures(0);
        if (manual)
          notify(
            refreshPending
              ? refreshPendingMessage
              : "No newer snapshot is available.",
            refreshPending ? "info" : "success",
          );
        return;
      }
      const data: unknown = decodeSnapshotResponse(
        STATIC_EDITION
          ? await readJsonBody(response, stall?.touch)
          : await response.json(),
      );
      if (!isSnapshot(data))
        throw new Error(
          STATIC_EDITION
            ? snapshotFailureMessage({ kind: "unreadable" })
            : "The latest data couldn’t be read. Please retry.",
        );
      // The static edition reads its recorded history and project directory
      // alongside the snapshot, and judges freshness at the snapshot's own time
      // (set where the page renders).
      let shown: RadarSnapshot = data;
      if (STATIC_EDITION) {
        // A host or edge may still answer with an older run than the one on
        // screen: the page never goes back in time.
        const held = sourceRef.current;
        if (held && isOlderPublication(data.generatedAt, held.generatedAt)) {
          lastSnapshotAt.current = Date.now();
          setError("");
          setConnectionFailures(0);
          if (manual) notify("No newer snapshot is available.");
          return;
        }
        shown = prepareEditionSnapshot(data, await recorded);
        editionDirectory.set(shown.projects);
      }
      responseEtagRef.current = etag;
      lastSnapshotAt.current = Date.now();
      setNow(evaluationNow());
      setError("");
      setServiceStarting(false);
      setStartupProgress(null);
      setConnectionFailures(0);
      setSnapshot(shown);
      if (manual)
        notify(
          STATIC_EDITION
            ? "Snapshot loaded."
            : refreshPending
              ? refreshPendingMessage
              : data.status === "live"
                ? "Radar updated. Latest sources loaded."
                : "Snapshot updated. Some sources have limited coverage.",
          refreshPending ? "info" : "success",
        );
    } catch (cause) {
      if (controller.signal.aborted && requestAbortRef.current !== controller)
        return;
      // Once recovery is observed, a failed request cannot verify saved data.
      // Only an ordinary validated snapshot or its matching ETag releases it.
      setStartupProgress(null);
      setError(
        cause instanceof TypeError
          ? STATIC_EDITION
            ? snapshotFailureMessage({ kind: "network" })
            : "We couldn’t reach the data service. Check your connection and try again."
          : cause instanceof SyntaxError
            ? STATIC_EDITION
              ? snapshotFailureMessage({ kind: "unreadable" })
              : "The latest data couldn’t be read. Please retry."
            : cause instanceof Error && cause.name !== "AbortError"
              ? cause.message
              : STATIC_EDITION
                ? snapshotFailureMessage({ kind: "stalled" })
                : "The data service took too long. Please retry.",
      );
      setConnectionFailures((previous) => previous + 1);
    } finally {
      stall?.stop();
      clearTimeout(timer);
      if (requestAbortRef.current === controller) {
        requestRef.current = false;
        setLoading(false);
        setRefreshing(false);
        if (STATIC_EDITION) setSnapshotFetches((count) => count + 1);
      }
    }
  }
  useEffect(() => {
    if (
      !discoveryShell &&
      initial.view !== "learn" &&
      initial.view !== "analytics"
    ) {
      bulkStarted.current = true;
      void fetchSnapshot();
    }
    const interval = setInterval(() => setNow(evaluationNow()), 60000);
    return () => {
      clearInterval(interval);
      if (toastTimer.current) clearTimeout(toastTimer.current);
      requestAbortRef.current?.abort();
      requestAbortRef.current = null;
      requestRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (bulkStarted.current || (view === "learn" && !selectedId)) return;
    if (analyticsLite && !overview.recovering) return;
    const start = () => {
      if (bulkStarted.current) return;
      bulkStarted.current = true;
      void fetchSnapshot();
    };
    // Deep views and errors must never be stranded behind discovery. An empty
    // valid directory is ready too. Successful discovery paints before bulk I/O.
    // The edition has no discovery page to wait for: from the lightweight
    // Analytics page (which loads no snapshot), Discover would wait for ever.
    if (
      STATIC_EDITION ||
      !discoveryView ||
      selectedId ||
      discovery.status === "error" ||
      discovery.status === "recovering"
    ) {
      start();
      return;
    }
    if (!discoveryContext) return;
    if (savingData && need === "none") {
      setLoading(false);
      return;
    }
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(start);
    });
    // A background tab may suspend animation frames. Full views still acquire
    // their real snapshot without requiring another navigation or user action.
    const fallback = setTimeout(start, 1000);
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
      clearTimeout(fallback);
    };
  }, [
    view,
    discoveryView,
    selectedId,
    discovery.status,
    discoveryContext,
    analyticsLite,
    overview.recovering,
    savingData,
    need,
  ]);
  // Edition: Data & sources names the snapshot's own sources. Opened from the
  // guide, which loads nothing, it starts the snapshot instead of waiting for
  // one that nothing asks for. The lightweight Analytics page has its sources
  // in its overview file, on screen or on its way.
  const sourcesNeedSnapshot =
    STATIC_EDITION &&
    modal === "sources" &&
    !sourceSnapshot &&
    !(analyticsLite && (overview.data || overview.loading));
  useEffect(() => {
    if (!sourcesNeedSnapshot) return;
    bulkStarted.current = true;
    void fetchSnapshot();
  }, [sourcesNeedSnapshot]);
  useEffect(() => {
    if (!overview.data) return;
    setNow(evaluationNow());
  }, [overview.data]);
  useEffect(() => {
    // The snapshot's clock does not run: nothing expires while it is open.
    if (STATIC_EDITION) return;
    const freshness = [
      snapshot?.summary.freshness,
      overview.data?.totals.freshness,
      ...(overview.data?.networkTotals.map((network) => network.freshness) ||
        []),
      ...[
        ...(snapshot?.projects || []),
        ...(rawRemote?.projects || []),
        ...(hydratedProject ? [hydratedProject] : []),
        ...(fastDetails.data ? [fastDetails.data.project] : []),
      ].map((project) => project.metrics.freshness),
    ];
    // Compact overview contributions retain each original deadline, including
    // later expiries within a network whose first measurement already expired.
    let nextExpiry = overview.data
      ? (analyticsOverviewExpiresAt(overview.data, now) ?? Infinity)
      : Infinity;
    for (const proof of freshness) {
      // Partial rows retain their original aggregate proof. Its first expiry
      // can be past while another metric still has its own current deadline.
      for (const value of [
        proof?.liquidity?.expiresAt,
        proof?.volume?.h1?.expiresAt,
        proof?.volume?.h6?.expiresAt,
        proof?.volume?.h24?.expiresAt,
      ]) {
        const at = typeof value === "string" ? Date.parse(value) : NaN;
        if (at > now && at < nextExpiry) nextExpiry = at;
      }
    }
    if (!Number.isFinite(nextExpiry)) return;
    // A hidden tab shows nothing: skip the rebuild. Becoming visible sets the
    // clock again (the visibility handler below), which also re-arms this timer.
    const timer = setTimeout(
      () => {
        if (!document.hidden) setNow(evaluationNow());
      },
      Math.max(0, nextExpiry - Date.now() + 1),
    );
    return () => clearTimeout(timer);
  }, [
    snapshot,
    rawRemote,
    hydratedProject,
    fastDetails.data,
    overview.data,
    now,
  ]);
  useEffect(() => {
    const updateClock = () => {
      if (!document.hidden && view !== "learn") {
        const at = Date.now();
        setNow(STATIC_EDITION ? evaluationNow() : at);
        // Back in the foreground: ask again only for what is on screen and has
        // been left longer than its refresh policy allows. The edition asks for
        // nothing here: a small status check offers a newer snapshot instead
        // (useNewerPublication), and the data on screen is never swapped
        // silently.
        if (
          !STATIC_EDITION &&
          bulkStarted.current &&
          catchUpDue(lastSnapshotAt.current, at, needRef.current)
        )
          void fetchSnapshot(false, true);
        if (shellRef.current && catchUpDue(lastDiscoveryAt.current, at, "live"))
          setDiscoveryRefresh((value) => value + 1);
      }
    };
    document.addEventListener("visibilitychange", updateClock);
    window.addEventListener("focus", updateClock);
    return () => {
      document.removeEventListener("visibilitychange", updateClock);
      window.removeEventListener("focus", updateClock);
    };
  }, [view]);
  // The full snapshot is repeated only while the screen is built from it, at
  // the pace its need justifies (refresh-policy.ts). Opening such a screen
  // refreshes a snapshot that was left to age.
  const snapshotEvery = STATIC_EDITION
    ? null
    : refreshInterval(need, Boolean(error));
  useEffect(() => {
    if (!snapshot || serviceStarting || snapshotEvery === null) return;
    const interval = setInterval(() => {
      if (document.visibilityState === "visible")
        void fetchSnapshot(false, true);
    }, snapshotEvery);
    return () => clearInterval(interval);
  }, [
    snapshot?.status,
    snapshot?.inventory?.running,
    serviceStarting,
    snapshotEvery,
  ]);
  useEffect(() => {
    if (
      STATIC_EDITION ||
      !bulkStarted.current ||
      serviceStarting ||
      document.visibilityState !== "visible"
    )
      return;
    if (catchUpDue(lastSnapshotAt.current, Date.now(), need))
      void fetchSnapshot(false, true);
  }, [need]);
  // The discovery page behind Discover, the map and the watchlist (37 KB) is
  // asked again at the same live pace; a hidden tab does not ask.
  useEffect(() => {
    if (!shellLayout || serviceStarting) return;
    const interval = setInterval(() => {
      if (document.visibilityState === "visible")
        setDiscoveryRefresh((value) => value + 1);
    }, LIVE_REFRESH_MS);
    return () => clearInterval(interval);
  }, [shellLayout, serviceStarting]);
  useEffect(() => {
    if (
      view === "learn" ||
      loading ||
      (!serviceStarting && (snapshot || !error)) ||
      (STATIC_EDITION && connectionFailures > RECONNECT_LIMIT)
    )
      return;
    const reconnect = () => {
      if (document.visibilityState === "visible")
        void fetchSnapshot(false, true);
    };
    const timer = setInterval(
      reconnect,
      serviceStarting
        ? 5000
        : Math.min(
            30000,
            3000 * 2 ** Math.min(Math.max(0, connectionFailures - 1), 4),
          ),
    );
    window.addEventListener("online", reconnect);
    document.addEventListener("visibilitychange", reconnect);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", reconnect);
      document.removeEventListener("visibilitychange", reconnect);
    };
  }, [snapshot, error, loading, connectionFailures, serviceStarting, view]);
  useEffect(() => {
    setStartupTakingLonger(false);
    if (!serviceStarting || snapshot) return;
    const timer = setTimeout(() => setStartupTakingLonger(true), 30000);
    return () => clearTimeout(timer);
  }, [serviceStarting, snapshot]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (
        event.key === "/" &&
        !event.defaultPrevented &&
        !event.isComposing &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !(
          event.target instanceof Element &&
          event.target.closest("input, textarea, select, [role='textbox']")
        ) &&
        !(
          event.target instanceof HTMLElement && event.target.isContentEditable
        ) &&
        !selectedId &&
        !modal
      ) {
        const searchTarget =
          searchRef.current ||
          document.querySelector<HTMLInputElement>(
            "#main .comparison-search input",
          );
        if (searchTarget) {
          event.preventDefault();
          searchTarget.focus();
        }
      }
    };
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, [selectedId, modal]);
  useEffect(() => {
    // "?" lists the shortcuts, from anywhere except a text field or a dialog.
    const listener = (event: KeyboardEvent) => {
      if (
        event.key === "?" &&
        !event.defaultPrevented &&
        !event.isComposing &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !(
          event.target instanceof Element &&
          event.target.closest("input, textarea, select, [role='textbox']")
        ) &&
        !(
          event.target instanceof HTMLElement && event.target.isContentEditable
        ) &&
        !selectedId &&
        !modal &&
        !paletteOpen
      ) {
        event.preventDefault();
        setModal("shortcuts");
      }
    };
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, [selectedId, modal, paletteOpen]);
  useEffect(() => {
    // Ctrl or ⌘ + K opens the jump palette from anywhere except over a dialog.
    const listener = (event: KeyboardEvent) => {
      if (isPaletteShortcut(event) && !selectedId && !modal) {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, [selectedId, modal]);
  useEffect(() => {
    history.replaceState(history.state || { radar: true }, "", navigationUrl());
  }, [
    filters,
    view,
    windowKey,
    selectedId,
    selectedTab,
    selectedExtension,
    sort,
    comparison,
    comparisonChain,
    activityProject,
    activitySelection,
    analyticsChain,
    analyticsRange,
    chainNetwork,
    chainSearch,
    chainRole,
  ]);
  useEffect(() => {
    const listener = () => {
      pendingViewFocus.current = null;
      const state = getInitialState();
      const closingOverlay =
        Boolean(selectedId) && !state.project && state.view === view;
      setModal(null);
      // Back and Forward must not leave the palette open over another page.
      setPaletteOpen(false);
      setFilters(state.filters);
      setViewState(state.view);
      setWindow(state.window);
      setSelectedIdState(state.project);
      setSelectedTab(state.detailTab);
      setSelectedExtension(state.extensionSelection || null);
      setSort(state.sort);
      // Closing a project overlay must preserve comparison edits made inside it.
      setComparison(selectedId ? comparison : state.comparison || []);
      setComparisonChain(
        selectedId ? comparisonChain : state.comparisonChain || "all",
      );
      // Shared URLs describe only the active workspace. Closing its drawer
      // must not reset selections in other workspaces to absent URL defaults.
      if (!closingOverlay || state.view === "activity") {
        setActivityProject(state.activityProject || null);
        setActivitySelection(state.activitySelection!);
      }
      if (!closingOverlay || state.view === "analytics") {
        setAnalyticsChain(state.analyticsChain || "all");
        setAnalyticsRange(state.analyticsRange || "d7");
      }
      if (!closingOverlay || state.view === "chains") {
        setChainNetwork(state.chainNetwork || "all");
        setChainSearch(state.chainSearch || "");
        setChainRole(state.chainRole || "all");
      }
    };
    window.addEventListener("popstate", listener);
    return () => window.removeEventListener("popstate", listener);
  }, [selectedId, comparison, comparisonChain, view]);
  useEffect(() => {
    const navigation = navigationRef.current;
    const active = navigation?.querySelector<HTMLElement>(
      '[aria-current="page"]',
    );
    if (!navigation || !active) return;
    // Keep the current destination visible in the compact, scrollable navigation.
    const reveal = () =>
      navigation.scrollTo({
        left:
          active.offsetLeft - (navigation.clientWidth - active.clientWidth) / 2,
        behavior: "instant",
      });
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(navigation);
    return () => observer.disconnect();
  }, [view]);
  useEffect(() => {
    // The desktop indicator is one element that travels to the current
    // destination; its position follows the active button, badges and fonts.
    const navigation = navigationRef.current;
    if (!navigation) return;
    const place = () => {
      const active = navigation.querySelector<HTMLElement>(
        '[aria-current="page"]',
      );
      if (!active) {
        delete navigation.dataset.ink;
        return;
      }
      navigation.style.setProperty("--ink-x", `${active.offsetLeft}px`);
      navigation.style.setProperty("--ink-w", `${active.offsetWidth}px`);
      navigation.dataset.ink = "ready";
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(navigation);
    void document.fonts?.ready.then(place);
    return () => observer.disconnect();
  }, [view, carriedComparison.length, watchlist.length]);
  useEffect(() => {
    if (pendingViewFocus.current !== view || selectedId) return;
    pendingViewFocus.current = null;
    viewHeadingRef.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [view, selectedId]);
  useEffect(() => {
    setPage(1);
  }, [
    filters.search,
    filters.chain,
    filters.category,
    filters.property,
    filters.market,
    sort.key,
    sort.direction,
    view,
    windowKey,
  ]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === "hook-radar-watchlist-v1" || event.key === null)
        setWatchlist(readWatchlist());
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  // Edition: the names of saved projects follow what the snapshots carry, so a
  // saved project that later drops out of one can still be named. Only this
  // key is written here; the watchlist itself changes only by the visitor.
  useEffect(() => {
    if (!STATIC_EDITION || !sourceSnapshot) return;
    const next = rememberSavedNames(
      savedNames,
      watchlist,
      sourceSnapshot.projects,
    );
    if (next === savedNames) return;
    setSavedNames(next);
    storeSavedNames(next);
  }, [sourceSnapshot, watchlist, savedNames]);
  const savedFocus = useRef<"heading" | "empty" | null>(null);
  const emptyActionRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const target = savedFocus.current;
    if (!target) return;
    savedFocus.current = null;
    (target === "empty" ? emptyActionRef : directoryHeadingRef).current?.focus({
      preventScroll: true,
    });
  }, [watchlist]);

  // A pasted hook address opens "All hooks" (a hook with no project is only
  // there). That switch is the page's, not the visitor's: when the search goes
  // back to words, the list goes back to the projects they were browsing.
  const marketAutoSwitched = useRef(false);
  function updateFilter(key: keyof Filters, value: string) {
    if (key === "market") marketAutoSwitched.current = false;
    let market: Filters["market"] | undefined;
    if (key === "search") {
      const isAddress = /^0x[a-fA-F0-9]{40}$/.test(value.trim());
      if (isAddress && filters.market === "projects") {
        market = "all";
        marketAutoSwitched.current = true;
      } else if (!isAddress && marketAutoSwitched.current) {
        market = filters.market === "all" ? "projects" : undefined;
        marketAutoSwitched.current = false;
      }
    }
    setFilters((previous) => ({
      ...previous,
      [key]: value,
      ...(market ? { market } : {}),
    }));
  }
  function clearSearch() {
    updateFilter("search", "");
    searchRef.current?.focus();
  }
  function resetFilters(nextView: View = view) {
    setFilters({
      ...defaultFilters,
      market: nextView === "watchlist" ? "all" : "projects",
    });
  }
  function changePage(nextPage: number) {
    setPage(nextPage);
    directoryHeadingRef.current?.focus({ preventScroll: true });
    document.getElementById("project-index")?.scrollIntoView({
      block: "start",
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
  }
  function toggleWatch(id: string) {
    const updated = watchlist.includes(id)
      ? watchlist.filter((item) => item !== id)
      : [...watchlist, id];
    // Edition: a row leaves the Watchlist when it is un-starred or forgotten,
    // and focus goes with it; it lands on the list's heading, or on the empty
    // state's button when that was the last one.
    if (
      STATIC_EDITION &&
      view === "watchlist" &&
      !selectedId &&
      !updated.includes(id)
    )
      savedFocus.current = updated.length === 0 ? "empty" : "heading";
    setWatchlist(updated);
    try {
      localStorage.setItem("hook-radar-watchlist-v1", JSON.stringify(updated));
      notify(
        updated.includes(id)
          ? "Project added to your watchlist."
          : "Project removed from your watchlist.",
      );
    } catch {
      notify(
        "Watchlist changed for this session. Browser storage is unavailable.",
        "info",
      );
    }
  }
  async function copy(text: string, success: string) {
    try {
      await navigator.clipboard.writeText(text);
      notify(success);
      flashCopied(document.activeElement);
    } catch {
      notify(
        "Clipboard unavailable. Select and copy the address or link directly.",
        "error",
      );
    }
  }
  function download(content: string, filename: string, type: string) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify(`${filename} downloaded.`);
  }
  async function serverDownload(path: string, filename: string) {
    if (exporting) return;
    setExporting(true);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const [endpoint, query = ""] = path.split("?", 2);
    const useBody = query.length > 6000;
    try {
      const response = await fetch(useBody ? endpoint : path, {
        method: useBody ? "POST" : "HEAD",
        signal: controller.signal,
        ...(useBody
          ? {
              headers: {
                "Content-Type":
                  "application/x-www-form-urlencoded;charset=UTF-8",
                "X-Radar-Prepare": "1",
              },
              body: query,
            }
          : {}),
      });
      if (!response.ok)
        throw new Error("The export could not be prepared. Please retry.");
      if (useBody) {
        const form = document.createElement("form");
        form.method = "POST";
        form.action = endpoint;
        form.hidden = true;
        for (const [name, value] of new URLSearchParams(query)) {
          const input = document.createElement("input");
          input.type = "hidden";
          input.name = name;
          input.value = value;
          form.append(input);
        }
        document.body.append(form);
        form.submit();
        form.remove();
      } else {
        const anchor = document.createElement("a");
        anchor.href = path;
        anchor.download = filename;
        anchor.click();
      }
      notify("Download started. Large inventories can take a moment.");
    } catch (cause) {
      notify(
        cause instanceof TypeError || cause instanceof SyntaxError
          ? "The download could not start. Check your connection and retry."
          : cause instanceof Error && cause.name !== "AbortError"
            ? cause.message
            : "The export took too long. Please retry.",
        "error",
      );
    } finally {
      clearTimeout(timer);
      setExporting(false);
    }
  }

  const projects = snapshot?.projects || [];
  // "base" or "uni" finds the projects that run on that network.
  const chainNames = useMemo(
    () => new Map((snapshot?.chains || []).map((c) => [c.slug, c.name])),
    [snapshot?.chains],
  );
  const localFiltered = useMemo(
    () =>
      !discoveryView
        ? []
        : selectProjects(
            projects,
            snapshot?.pools || [],
            {
              ...filters,
              market: filters.market,
            },
            undefined,
            now,
            windowKey,
            chainNames,
          ).filter(
            (project) => view !== "watchlist" || watchlist.includes(project.id),
          ),
    [
      projects,
      filters,
      view,
      watchlist,
      snapshot,
      now,
      windowKey,
      discoveryView,
      chainNames,
    ],
  );
  const filtered = useDirectory ? remote?.projects || [] : localFiltered;
  const duplicateNames = useMemo(() => {
    const projectIds = new Set(projects.map((project) => project.id));
    return duplicateFamilyNames([
      ...projects,
      ...filtered.filter((project) => !projectIds.has(project.id)),
    ]);
  }, [projects, filtered]);
  const sorted = useMemo(
    () =>
      useDirectory
        ? filtered
        : [...filtered].sort(
            projectComparator(sort.key, sort.direction, windowKey, (project) =>
              projectPoolCount(project, filters.chain),
            ),
          ),
    [filtered, sort, windowKey, useDirectory, filters.chain],
  );
  const resultCount = useDirectory ? (remote?.total ?? null) : sorted.length;
  const pages =
    useDirectory && !remote
      ? Math.max(page, 1)
      : Math.max(1, Math.ceil((resultCount || 0) / PAGE_SIZE));
  const tablePage = useMemo(
    () =>
      useDirectory
        ? sorted
        : sorted.slice(
            (Math.min(page, pages) - 1) * PAGE_SIZE,
            Math.min(page, pages) * PAGE_SIZE,
          ),
    [useDirectory, sorted, page, pages],
  );
  useEffect(() => {
    if (discoveryView) setPage((previous) => Math.min(previous, pages));
  }, [pages, discoveryView]);
  const activeFilterCount = Object.entries(filters).filter(([key, value]) =>
    key === "search"
      ? !!value.trim()
      : key === "market"
        ? false
        : value !== "all",
  ).length;
  const publishedSelected = projects.find(
    (project) => project.id === selectedId,
  );
  const completeSelected =
    hydratedProject?.id === selectedId
      ? hydratedProject
      : !serviceStarting
        ? fastDetails.data?.project
        : undefined;
  // A deferred dashboard row must not replace an already complete detail view.
  // Keep the complete view and its observations paired; present rows stay lazy.
  const selectedSource =
    publishedSelected &&
    (Array.isArray(publishedSelected.history) || !completeSelected)
      ? publishedSelected
      : completeSelected;
  const selected = selectedSource
    ? expireProjectMetrics(selectedSource, now)
    : null;
  const selectedContext =
    selectedSource && selectedSource === fastDetails.data?.project
      ? fastDetails.data
      : snapshot || fastDetails.data;
  const selectedLoading = snapshot
    ? detailLoading
    : STATIC_EDITION
      ? loading
      : fastDetails.loading;
  const selectedError = snapshot
    ? detailError
    : STATIC_EDITION
      ? error
      : fastDetails.error;
  useEffect(() => {
    document.title = browserTitle({
      view,
      projectId: selectedId,
      // Edition: a reviewed launchpad is not a snapshot project (its drawer is
      // built from the registry), so its own name stands in the tab and in the
      // history entry instead of "Project details".
      projectName:
        (STATIC_EDITION ? registryRecord?.name : undefined) ??
        (selected?.id === selectedId ? selected.name : undefined),
      chainRole,
    });
  }, [view, selectedId, selected?.name, registryRecord?.name, chainRole]);
  const spotlightEntries = useMemo(
    () =>
      view === "overview"
        ? buildSpotlightEntries(localFiltered, {
            chain: filters.chain,
            seed: new Date().toISOString().slice(0, 10),
          })
        : [],
    [view, localFiltered, filters.chain],
  );
  const spotlight = spotlightEntries.length > 0;
  const scopedPools = useMemo(() => {
    if (!discoveryView) return [];
    if (useDirectory) {
      const ids = new Set<string>(
        remote &&
          "poolIds" in remote.scope &&
          Array.isArray(remote.scope.poolIds)
          ? remote.scope.poolIds
          : [],
      );
      return (snapshot?.pools || []).filter((pool) => ids.has(pool.id));
    }
    const ids = new Set(filtered.map((project) => project.id));
    // Edition: Recent trading lists only the projects with positive volume, so
    // its pools are those projects' pools too; otherwise the volume total counts
    // pools (and a pool count) outside the listed rows.
    const narrow =
      activeFilterCount > 0 ||
      filters.market === "projects" ||
      filters.market === "observed" ||
      (STATIC_EDITION && filters.market === "active") ||
      view === "watchlist";
    return (snapshot?.pools || []).filter(
      (pool) =>
        (filters.chain === "all" || pool.chain === filters.chain) &&
        (!narrow || (pool.projectId !== null && ids.has(pool.projectId))),
    );
  }, [
    snapshot,
    filtered,
    filters.chain,
    activeFilterCount,
    view,
    useDirectory,
    remote,
    discoveryView,
  ]);
  // Each visible row's own pools, grouped in one pass: the rows used to filter
  // every scoped pool four times each, on every render.
  const pagePools = useMemo(() => {
    const byProject = new Map<string, Pool[]>();
    if (deferredPoolMembership) return byProject;
    const visible = new Set(tablePage.map((project) => project.id));
    for (const pool of scopedPools) {
      if (!pool.projectId || !visible.has(pool.projectId)) continue;
      const rows = byProject.get(pool.projectId);
      if (rows) rows.push(pool);
      else byProject.set(pool.projectId, [pool]);
    }
    return byProject;
  }, [scopedPools, tablePage, deferredPoolMembership]);
  const frontierRow = tablePage.find((project) => project.id === "frontier");
  // Only once the service is ready and no drawer is open: the catalog is read
  // for the list, never while saved data is still being verified.
  const frontierExtensions = useFrontierExtensionCount(
    frontierRow
      ? frontierRow.deployments
          .filter((hook) => hook.chainId === 4663)
          .map((hook) => hook.address)
      : NO_ADDRESSES,
    !STATIC_EDITION && !serviceStarting && Boolean(snapshot) && !selectedId,
  );
  const scopeMarkets = useMemo(() => {
    // Filters only remove pools, so a scope with every pool of the frame is the
    // set refreshMarketSnapshot has just aggregated at this same clock.
    const frame = snapshot?.summary;
    if (
      snapshot &&
      frame?.freshness &&
      scopedPools.length === snapshot.pools.length
    )
      return { volumeUsd: frame.volumeUsd, freshness: frame.freshness };
    return aggregateCurrentMarkets(scopedPools, now);
  }, [snapshot, scopedPools, now]);
  const scopeVolume = scopeMarkets.volumeUsd[windowKey];
  const scopeVolumeCount =
    scopeMarkets.freshness.volume[windowKey].currentPools;
  const scopedPoolCount = useDirectory
    ? (remote?.scope.poolCount ?? null)
    : filtered.reduce(
        (total, project) =>
          total + (projectPoolCount(project, filters.chain) ?? 0),
        0,
      );
  const chainName = (slug: string) =>
    (snapshot?.chains || discoveryContext?.data.chains)?.find(
      (chain) => chain.slug === slug,
    )?.name || slug;
  const familyIds = new Set(filtered.map((project) => project.id));
  const inventoryIds = new Set(projects.map((project) => project.id));
  const unavailableWatchIds = serviceStarting
    ? []
    : useDirectory
      ? remote?.missingIds || []
      : savedNotInSnapshot(watchlist, inventoryIds);
  // Edition: the market and trading scopes count only pools the snapshot
  // measured, so their networks are the networks of those pools, not every
  // network the listed projects are deployed on (20 beside market data on 7).
  const scopedMeasuredScope =
    STATIC_EDITION &&
    (filters.market === "observed" || filters.market === "active");
  const scopedDeploymentChains = useDirectory
    ? remote?.scope.chains || []
    : scopedMeasuredScope
      ? [...new Set(scopedPools.map((pool) => pool.chain))]
      : [
          ...new Set(
            filtered.flatMap((project) =>
              project.deployments.map((deployment) => deployment.chain),
            ),
          ),
        ];
  // Edition: every saved project is outside the snapshot, so no filter or
  // search is what keeps the list empty.
  const savedOutsideSnapshot =
    STATIC_EDITION &&
    view === "watchlist" &&
    watchlist.length > 0 &&
    unavailableWatchIds.length === watchlist.length;
  function removeUnavailableWatches() {
    const updated = watchlist.filter((id) => !unavailableWatchIds.includes(id));
    setWatchlist(updated);
    try {
      localStorage.setItem("hook-radar-watchlist-v1", JSON.stringify(updated));
      notify("Unavailable saved entries removed.");
    } catch {
      notify(
        "Saved entries removed for this session. Browser storage is unavailable.",
        "info",
      );
    }
  }
  const feedEvents = snapshot?.events || [];
  const scopedEvents = useDirectory
    ? (remote?.scope.events ??
      feedEvents.filter((event) => remote?.scope.eventIds.includes(event.id)))
    : feedEvents.filter(
        (event) =>
          (filters.chain === "all" || event.chain === filters.chain) &&
          (!(
            activeFilterCount ||
            view === "watchlist" ||
            filters.market !== "all"
          ) ||
            (!!event.projectId && familyIds.has(event.projectId))),
      );
  const feedEventIds = new Set(feedEvents.map((event) => event.id));
  const scopedFeedSyncing = Boolean(
    useDirectory &&
    remote &&
    !remote.scope.events &&
    remote.scope.eventIds.some((id) => !feedEventIds.has(id)),
  );
  const deploymentChains = [
    ...new Set([
      ...(discoveryContext?.data.chains.map((chain) => chain.slug) || []),
      ...(snapshot?.inventory?.networks
        .filter((n) => n.hookCount > 0)
        .map((n) => n.chain) || []),
      ...new Set(projects.flatMap((project) => project.chains)),
    ]),
  ].sort();
  // Edition: the menu also offers the network the address names when the
  // snapshot lists it though no project is deployed there, so the menu, the chip
  // and the list agree (networkMenu).
  const networkOptions =
    STATIC_EDITION && sourceSnapshot
      ? networkMenu(deploymentChains, filters.chain, sourceSnapshot.chains)
      : deploymentChains;
  // Edition: a network in the address that the snapshot does not know (a typo,
  // a network that was never listed) is not a filter: it is dropped, as an
  // unknown category, sort, window or scope is, so the network menu, the chip and
  // the list agree. Before the first paint, so the empty list never shows.
  useLayoutEffect(() => {
    if (
      STATIC_EDITION &&
      sourceSnapshot &&
      filters.chain !== "all" &&
      !knownNetwork(filters.chain, sourceSnapshot.chains, deploymentChains)
    )
      setFilters((previous) =>
        previous.chain === filters.chain
          ? { ...previous, chain: "all" }
          : previous,
      );
  }, [sourceSnapshot, filters.chain, deploymentChains.join(",")]);
  // Edition: a network the snapshot knows but measured no pool on says so,
  // where a scope that counts only measured pools would otherwise read as
  // "nothing matches".
  const noMeasuredPoolsOnNetwork =
    STATIC_EDITION &&
    Boolean(snapshot) &&
    filters.chain !== "all" &&
    (filters.market === "observed" || filters.market === "active") &&
    !snapshot!.pools.some((pool) => pool.chain === filters.chain);
  // Where the page is built from the discovery page, its status and coverage
  // are that page's own; the snapshot held beside it is not refreshed there and
  // is never read for them.
  const shellFeed =
    shellLayout && discoveryContext ? discoveryContext.data : null;
  const coverage = shellFeed ? shellFeed.inventory : snapshot?.inventory;
  const status = serviceStarting
    ? "loading"
    : shellFeed
      ? discovery.status === "error" || error
        ? "cached"
        : shellFeed.publication.status
      : error && snapshot
        ? "cached"
        : snapshot?.status ||
          overview.data?.publication.status ||
          discoveryContext?.data.publication.status ||
          "loading";
  const indexScanning = coverage?.networks.some(
    (network) => network.status === "queued" || network.status === "scanning",
  );
  const indexComplete = Boolean(
    coverage?.networks.length && coverage.networks.every(networkCaughtUp),
  );
  const savedCoverage =
    serviceStarting || status === "cached" || status === "offline";
  const indexCurrent = Boolean(
    indexComplete &&
    coverage?.running &&
    coverage?.networks.every(
      (network) =>
        networkHeadFresh(network) &&
        network.status !== "error" &&
        network.status !== "unavailable",
    ),
  );
  const headerStatus =
    indexCurrent && !savedCoverage && !error
      ? "live"
      : coverage && status === "live"
        ? "partial"
        : status;
  const setCategory = (category: string) => updateFilter("category", category);
  const closeSelected = useMemo(() => () => setSelectedId(null), [selectedId]);
  const closeModal = useMemo(() => () => setModal(null), []);
  const closePalette = useMemo(() => () => setPaletteOpen(false), []);
  const shareLink = publicViewUrl(location.href);
  const listingChains = snapshot?.chains || discoveryContext?.data.chains || [];
  const inventoryFigures = coverage ?? discoveryContext?.data.inventory;
  // The directory page total is only the named-project count for the default,
  // unfiltered Projects scope; any other query (search, network, use case,
  // all hooks, watchlist) is a different, filtered number.
  const request = discoveryContext?.data.request;
  const namedDirectoryTotal =
    request &&
    request.market === "projects" &&
    request.search === "" &&
    request.chain === "all" &&
    request.category === "all" &&
    request.property === "all" &&
    !request.saved &&
    request.ids.length === 0
      ? discoveryContext.data.page.total
      : null;
  const mastheadTotals = {
    // Named public projects only; the full directory also holds unnamed hooks.
    projects:
      namedDirectoryTotal ??
      (snapshot
        ? snapshot.projects.filter(
            (project) =>
              project.entityType === "platform" ||
              project.deployments.some(
                (deployment) => deployment.discovery !== "onchain",
              ),
          ).length
        : null),
    hooks: inventoryFigures?.hookCount ?? null,
    pools: inventoryFigures?.hookPoolCount ?? null,
    networks: inventoryFigures?.networks.length ?? null,
  };
  function chooseCategory(category: string) {
    updateFilter("category", category);
    setView("overview");
    setTimeout(
      () =>
        document.getElementById("project-index")?.scrollIntoView({
          behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "auto"
            : "smooth",
          block: "start",
        }),
      50,
    );
  }
  function changeSort(key: SortKey) {
    setSort((previous) => ({
      key,
      direction:
        previous.key === key
          ? previous.direction === "desc"
            ? "asc"
            : "desc"
          : key === "name"
            ? "asc"
            : "desc",
    }));
  }
  function sortLabel(key: SortKey, label: string, help?: string) {
    return (
      <button onClick={() => changeSort(key)} title={help}>
        {label}
        {sort.key === key ? (
          sort.direction === "desc" ? (
            <ArrowDown size={12} />
          ) : (
            <ArrowUp size={12} />
          )
        ) : null}
      </button>
    );
  }

  const discoveryDirectory = (
    <section id="project-index" className="projects-section">
      {view === "watchlist" &&
        unavailableWatchIds.length > 0 &&
        (STATIC_EDITION ? (
          // A saved project the snapshot does not carry stays saved: only the
          // visitor's own Forget, per entry, removes one.
          <div
            className="notice orphan-notice comparison-not-carried"
            role="status"
          >
            <Info size={16} />
            <div>
              <p>{savedNotInSnapshotNotice(unavailableWatchIds.length)}</p>
              <ul>
                {unavailableWatchIds.slice(0, SAVED_LIST_MAX).map((id) => (
                  <li key={id}>
                    {savedNames[id] && <strong>{savedNames[id]}</strong>}{" "}
                    <code>{id}</code>{" "}
                    <button
                      type="button"
                      aria-label={`Forget ${savedNames[id] ?? id}`}
                      onClick={() => toggleWatch(id)}
                    >
                      Forget
                    </button>
                  </li>
                ))}
              </ul>
              {unavailableWatchIds.length > SAVED_LIST_MAX && (
                <p>
                  And {count(unavailableWatchIds.length - SAVED_LIST_MAX)} more.
                </p>
              )}
            </div>
          </div>
        ) : (
          <div className="notice orphan-notice" role="status">
            <Info size={16} />
            <span>
              {unavailableWatchIds.length} saved{" "}
              {unavailableWatchIds.length === 1 ? "entry is" : "entries are"}{" "}
              unavailable in the current registry.
            </span>
            <button className="control" onClick={removeUnavailableWatches}>
              Remove unavailable
            </button>
          </div>
        ))}
      {!(view === "watchlist" && watchlist.length === 0) && (
        <>
          <div className="table-tools">
            <div>
              <h2 ref={directoryHeadingRef} tabIndex={-1}>
                {view === "watchlist"
                  ? "Saved projects"
                  : view === "map"
                    ? "Find a project"
                    : "Browse hooks"}
              </h2>
              <span role="status" aria-live="polite" aria-atomic="true">
                {useDirectory && !remote && directoryFailure ? (
                  "Results unavailable"
                ) : (
                  <>
                    {useDirectory && !remote ? "Finding" : count(resultCount)}{" "}
                    {filters.market === "projects"
                      ? resultCount === 1
                        ? "project"
                        : "projects"
                      : resultCount === 1
                        ? "hook family"
                        : "hook families"}
                    {activeFilterCount ? " matching filters" : ""}
                  </>
                )}
              </span>
            </div>
            <div className="table-controls" data-expanded={showFilters}>
              <div className="search-box">
                <Search size={16} />
                <input
                  data-testid="search-input"
                  ref={searchRef}
                  value={filters.search}
                  onChange={(event) =>
                    updateFilter("search", event.target.value)
                  }
                  placeholder={
                    phoneHeader
                      ? "Search projects, networks"
                      : "Search projects, networks or hook addresses"
                  }
                  aria-label="Search projects"
                  maxLength={300}
                />
                {filters.search ? (
                  <button
                    className="clear-search"
                    aria-label="Clear search"
                    onClick={clearSearch}
                  >
                    <X size={15} />
                  </button>
                ) : (
                  <kbd>/</kbd>
                )}
              </div>
              <button
                className={`control filter-button ${showFilters ? "selected" : ""}`}
                aria-expanded={showFilters}
                onClick={() => setShowFilters(!showFilters)}
              >
                <Filter size={15} />
                Filters
                {activeFilterCount ? (
                  <span className="filter-count">{activeFilterCount}</span>
                ) : null}
              </button>
              <label className="select-control">
                <span className="sr-only">Filter by chain</span>
                <select
                  value={filters.chain}
                  onChange={(event) =>
                    updateFilter("chain", event.target.value)
                  }
                >
                  <option value="all">All networks</option>
                  {networkOptions.map((chain) => (
                    <option key={chain} value={chain}>
                      {chainName(chain)}
                    </option>
                  ))}
                </select>
                <ChevronDown size={14} />
              </label>
              {view !== "overview" && (
              <label className="select-control category-select">
                <span className="sr-only">Filter by category</span>
                <select
                  value={filters.category}
                  onChange={(event) =>
                    updateFilter("category", event.target.value)
                  }
                >
                  <option value="all">All categories</option>
                  {categories.map((category) => (
                    <option key={category}>{category}</option>
                  ))}
                </select>
                <ChevronDown size={14} />
              </label>
              )}
            </div>
          </div>
          {view === "overview" && (
            <DiscoveryGuide
              filters={filters}
              onLaunchpads={openLaunchpads}
              onChoose={(patch) =>
                setFilters((previous) => ({
                  ...previous,
                  ...patch,
                }))
              }
              disabled={directoryStarting}
            />
          )}
          <div className="index-scope">
            <div
              className="index-scope-switch"
              role="group"
              aria-label="Directory coverage"
            >
              <button
                aria-pressed={filters.market === "projects"}
                onClick={() => updateFilter("market", "projects")}
              >
                Projects
              </button>
              <button
                aria-pressed={filters.market === "all"}
                disabled={directoryStarting}
                title={
                  directoryStarting
                    ? "The full hook directory opens after saved history is checked."
                    : undefined
                }
                onClick={() => updateFilter("market", "all")}
              >
                All hooks
              </button>
              <button
                aria-pressed={filters.market === "observed"}
                aria-label="With market data"
                onClick={() => {
                  updateFilter("market", "observed");
                  setSort({ key: "volume", direction: "desc" });
                }}
              >
                <span className="market-label-desktop">With market data</span>
                <span className="market-label-mobile" aria-hidden="true">
                  Market data
                </span>
              </button>
              <button
                aria-pressed={filters.market === "active"}
                disabled={directoryStarting}
                title={`Positive ${windows[windowKey]} trading volume from pool measurements less than five minutes old${STATIC_EDITION ? " when the snapshot was taken" : ""}. This does not establish organic demand or profitability.`}
                onClick={() => {
                  updateFilter("market", "active");
                  setSort({ key: "volume", direction: "desc" });
                }}
              >
                Recent trading
              </button>
            </div>
            {view !== "map" && (
              <div className="mobile-sort directory-sort">
                <label>
                  Sort projects
                  <select
                    value={`${sort.key}:${sort.direction}`}
                    onChange={(event) => {
                      const [key, direction] = event.target.value.split(":");
                      setSort({
                        key: key as SortKey,
                        direction: direction as "asc" | "desc",
                      });
                    }}
                  >
                    <option value="pools:desc">Most pools</option>
                    <option value="pools:asc">Fewest pools</option>
                    <option value="deployments:desc">
                      Most hook contracts
                    </option>
                    <option value="deployments:asc">
                      Fewest hook contracts
                    </option>
                    <option value="volume:desc">Highest trading volume</option>
                    <option value="volume:asc">Lowest trading volume</option>
                    <option value="liquidity:desc">
                      Highest reported reserves
                    </option>
                    <option value="liquidity:asc">
                      Lowest reported reserves
                    </option>
                    <option value="name:asc">Name A–Z</option>
                    <option value="name:desc">Name Z–A</option>
                  </select>
                </label>
              </div>
            )}
            <span className="index-scope-note">
              {directoryStarting
                ? "Browsing loaded saved projects only. Full search opens after verification."
                : filters.market === "active"
                  ? STATIC_EDITION
                    ? recentTradingCaption(windows[windowKey])
                    : `Positive ${windows[windowKey]} volume · measurements under 5m old`
                  : filters.market === "observed"
                    ? "Pools with current prices or trading measurements"
                    : filters.market === "all"
                      ? STATIC_EDITION
                        ? LIST_HOLDS
                        : "Every discovered hook, including unnamed contracts"
                      : "Named projects and their hook contracts"}
            </span>
          </div>
          {(filters.market === "active" || filters.market === "observed") && (
            <div className="market-view-summary">
              <span>
                <strong>
                  {deferredPoolMembership
                    ? "Original measurement clocks"
                    : `${count(scopeVolumeCount)} measured ${scopeVolumeCount === 1 ? "pool" : "pools"}`}
                </strong>{" "}
                · older observations excluded from current figures
              </span>
              {!STATIC_EDITION && (
                <button onClick={() => openActivity(null)}>
                  View onchain activity <ArrowRight size={13} />
                </button>
              )}
            </div>
          )}
          {showFilters && (
            <div className="advanced-filters">
              <span>Hook features</span>
              {(
                [
                  ["all", "Any"],
                  ["dynamic", "Dynamic fees"],
                  ["verified", "Verified source"],
                  ["upgradeable", "Upgradeable"],
                  ["custom", "Custom swap data"],
                ] as [PropertyFilter, string][]
              ).map(([value, label]) => (
                <button
                  className={filters.property === value ? "active" : ""}
                  aria-pressed={filters.property === value}
                  onClick={() => updateFilter("property", value)}
                  key={value}
                >
                  {label}
                </button>
              ))}
              <p>
                Features listed for at least one hook on your selected network.
              </p>
            </div>
          )}
          {activeFilterCount > 0 && (
            <div className="active-filters">
              <span>Filters</span>
              {filters.search && (
                <button
                  aria-label={`Remove search filter: ${filters.search}`}
                  onClick={clearSearch}
                >
                  “
                  {filters.search.length > 28
                    ? `${filters.search.slice(0, 28)}…`
                    : filters.search}
                  ” <X size={12} />
                </button>
              )}
              {filters.chain !== "all" && (
                <button
                  aria-label={`Remove network filter: ${chainName(filters.chain)}`}
                  onClick={() => updateFilter("chain", "all")}
                >
                  {chainName(filters.chain)}
                  <X size={12} />
                </button>
              )}
              {filters.category !== "all" && (
                <button
                  aria-label={`Remove category filter: ${filters.category}`}
                  onClick={() => updateFilter("category", "all")}
                >
                  {filters.category}
                  <X size={12} />
                </button>
              )}
              {filters.property !== "all" && (
                <button
                  aria-label="Remove hook feature filter"
                  onClick={() => updateFilter("property", "all")}
                >
                  {
                    {
                      dynamic: "Dynamic fees",
                      verified: "Verified source",
                      upgradeable: "Upgradeable",
                      custom: "Custom swap data",
                    }[filters.property]
                  }
                  <X size={12} />
                </button>
              )}
              {filters.market === "observed" && (
                <button onClick={() => updateFilter("market", "all")}>
                  With market data
                  <X size={12} />
                </button>
              )}
              <button className="clear-all" onClick={() => resetFilters()}>
                Clear all
              </button>
            </div>
          )}
        </>
      )}
      {useDirectory && directoryFailure && (
        <div className="notice error-notice" role="alert">
          <Info size={17} />
          <span>
            {directoryFailure}
            {remote ? " Showing the last successful results." : ""}
          </span>
          <button
            onClick={() => setDirectoryRetry((n) => n + 1)}
            disabled={directoryBusy}
          >
            Retry
          </button>
        </div>
      )}
      {useDirectory && !remote && (directoryBusy || !directoryFailure) ? (
        <div className="directory-loading" role="status" aria-live="polite">
          <RefreshCw size={18} className="spin" /> Finding matching hooks…
        </div>
      ) : useDirectory && !remote && directoryFailure ? null : view ===
        "map" ? (
        <EcosystemMap
          projects={filtered}
          remoteGroups={remote?.map}
          duplicateNames={duplicateNames}
          openProject={setSelectedId}
          chooseCategory={chooseCategory}
        />
      ) : !filtered.length ? (
        <Empty
          headingLevel={view === "watchlist" ? 2 : 3}
          icon={
            view === "watchlist" && !watchlist.length ? (
              <Star size={27} />
            ) : (
              <Search size={27} />
            )
          }
          title={
            view === "watchlist" && !watchlist.length
              ? "Your watchlist is empty"
              : view === "watchlist" &&
                  unavailableWatchIds.length === watchlist.length
                ? STATIC_EDITION
                  ? "Saved projects are not in this snapshot"
                  : "Saved entries unavailable"
                : filters.market === "active"
                  ? "No recent volume measured in this view"
                  : "No matching projects"
          }
          action={
            <button
              ref={emptyActionRef}
              className="primary-button"
              onClick={() => {
                // Filters cannot bring back a saved project the snapshot does
                // not carry: the way on is to browse what it does carry.
                const leave =
                  view === "watchlist" &&
                  (!watchlist.length || savedOutsideSnapshot);
                resetFilters(leave ? "overview" : view);
                if (leave) setView("overview");
              }}
            >
              {view === "watchlist" && !watchlist.length
                ? "Explore projects"
                : savedOutsideSnapshot
                  ? "Browse projects"
                  : "Clear filters"}
              <ArrowRight size={15} />
            </button>
          }
        >
          {view === "watchlist" && !watchlist.length
            ? "Star a project to save it here. Your watchlist is stored in this browser."
            : savedOutsideSnapshot
              ? SAVED_NONE_IN_SNAPSHOT
              : noMeasuredPoolsOnNetwork
                ? noPoolsOnNetwork(chainName(filters.chain))
                : filters.market === "active"
                ? `This view requires positive ${windows[windowKey]} volume from measurements less than five minutes old${STATIC_EDITION ? " when the snapshot was taken" : ""}. Missing measurements are not treated as zero. Try another network or browse Projects.`
                : STATIC_EDITION && view !== "watchlist"
                  ? NO_MATCH_IN_SNAPSHOT
                  : "Try a different name, address, chain or category."}
        </Empty>
      ) : (
        <>
          {!narrowList && (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th className="star-column">
                    <span className="sr-only">Watchlist</span>
                  </th>
                  <th
                    aria-sort={
                      sort.key === "name"
                        ? sort.direction === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                  >
                    {sortLabel("name", "Project")}
                  </th>
                  <th>Use case</th>
                  <th>Networks</th>
                  <th
                    className="numeric"
                    aria-sort={
                      sort.key === "pools"
                        ? sort.direction === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                  >
                    {sortLabel(
                      "pools",
                      "Pools",
                      STATIC_EDITION
                        ? "A pool is one trading pair that uses a hook. This counts the pools measured for the project’s hooks in this snapshot."
                        : "A pool is one trading pair that uses a hook. This counts the pools found for the project’s hooks.",
                    )}
                  </th>
                  <th
                    className="numeric"
                    aria-sort={
                      sort.key === "volume"
                        ? sort.direction === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                  >
                    {sortLabel(
                      "volume",
                      `${windows[windowKey]} VOLUME`,
                      STATIC_EDITION
                        ? "How much was traded in these pools over the selected time, from measurements under five minutes old when the snapshot was taken."
                        : "How much was traded in these pools over the selected time, from measurements under five minutes old.",
                    )}
                  </th>
                  <th
                    className="numeric"
                    aria-sort={
                      sort.key === "liquidity"
                        ? sort.direction === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                  >
                    {sortLabel(
                      "liquidity",
                      "Reported reserves",
                      "The value of the tokens held in these pools, as estimated by price providers. Not total value locked.",
                    )}
                  </th>
                  <th>
                    <span className="sr-only">Details</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {tablePage.map((project) => (
                  <tr key={project.id}>
                    <td className="star-column">
                      <button
                        data-testid={`watch-${project.id}`}
                        className={`star-button ${watchlist.includes(project.id) ? "saved" : ""}`}
                        aria-label={`${watchlist.includes(project.id) ? "Remove" : "Add"} ${project.name} ${watchlist.includes(project.id) ? "from" : "to"} watchlist`}
                        aria-pressed={watchlist.includes(project.id)}
                        onClick={() => toggleWatch(project.id)}
                      >
                        <Star size={16} />
                      </button>
                    </td>
                    <td>
                      <button
                        className="project-identity"
                        data-testid={`project-${project.id}`}
                        aria-label={`Open ${project.name}`}
                        onClick={() => setSelectedId(project.id)}
                      >
                        <ProtocolLogo project={project} />
                        <span>
                          <strong>{project.name}</strong>
                          {duplicateNames.has(
                            project.name.trim().toLowerCase(),
                          ) && <FamilyFingerprint project={project} />}
                          <small>
                            {project.description || "A Uniswap v4 hook"}
                          </small>
                        </span>
                      </button>
                    </td>
                    <td>
                      <button
                        className={`category-tag cat-${project.category.toLowerCase()}`}
                        data-category={project.category}
                        onClick={() => setCategory(project.category)}
                      >
                        {project.category}
                      </button>
                    </td>
                    <td>
                      <span
                        className="chain-list"
                        title={project.chains.map(chainName).join(", ")}
                      >
                        <span className="tiny-square" />
                        {chainName(project.chains[0]) || "Unknown"}
                        {project.chains.length > 1 && (
                          <small>+{project.chains.length - 1}</small>
                        )}
                      </span>
                    </td>
                    <td className="numeric deployment-count">
                      <span
                        title={
                          poolCountIsObserved(project, filters.chain)
                            ? "Pools with market observations; the full pool count is unavailable."
                            : "Pool count from indexed onchain history for the selected network."
                        }
                      >
                        {count(projectPoolCount(project, filters.chain))}
                        {poolCountIsObserved(project, filters.chain) &&
                          projectPoolCount(project, filters.chain) !== null && (
                            <span className="pool-count-kind">observed</span>
                          )}
                      </span>
                      <span className="pool-contract-count">
                        {project.entityType === "platform" ? (
                          "Platform"
                        ) : (
                          <>
                            {count(projectHookCount(project, filters.chain))}{" "}
                            {projectHookCount(project, filters.chain) === 1
                              ? "hook"
                              : "hooks"}
                          </>
                        )}
                        {project.id === "frontier" && frontierExtensions && (
                          <span
                            className="pool-extension-count"
                            title={extensionCountText(frontierExtensions).title}
                          >
                            {extensionCountText(frontierExtensions).label}
                          </span>
                        )}
                      </span>
                    </td>
                    <td
                      className="numeric observed-number"
                      title={STATIC_EDITION ? undefined : project.metrics.note}
                    >
                      {money(project.metrics.volumeUsd[windowKey])}
                      {deferredPoolMembership ? (
                        <ProjectMetricProof
                          project={project}
                          metric={windowKey}
                          now={now}
                        />
                      ) : (
                        <MetricMeasurement
                          pools={pagePools.get(project.id) ?? NO_POOLS}
                          metric={windowKey}
                          compact
                          awaitingTotal={
                            project.metrics.volumeUsd[windowKey] === null
                          }
                        />
                      )}
                    </td>
                    <td
                      className="numeric observed-number"
                      title={STATIC_EDITION ? undefined : project.metrics.note}
                    >
                      {money(project.metrics.liquidityUsd)}
                      {deferredPoolMembership ? (
                        <ProjectMetricProof
                          project={project}
                          metric="liquidity"
                          now={now}
                        />
                      ) : (
                        <MetricMeasurement
                          pools={pagePools.get(project.id) ?? NO_POOLS}
                          metric="liquidity"
                          compact
                          awaitingTotal={project.metrics.liquidityUsd === null}
                        />
                      )}
                    </td>
                    <td>
                      <div className="row-research-actions">
                        {project.entityType !== "platform" && (
                          <button
                            className={`icon-button ${comparison.includes(project.id) ? "selected" : ""}`}
                            aria-label={`${comparison.includes(project.id) ? "Remove" : "Add"} ${project.name} ${comparison.includes(project.id) ? "from" : "to"} comparison`}
                            aria-pressed={comparison.includes(project.id)}
                            title="Compare project"
                            onClick={() => toggleComparison(project.id)}
                          >
                            <ArrowLeftRight size={16} />
                          </button>
                        )}
                        <button
                          className="icon-button row-details"
                          aria-label={`View ${project.name} details`}
                          onClick={() => setSelectedId(project.id)}
                        >
                          <ArrowRight size={17} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}
          {narrowList && (
          <div className="mobile-projects">
            {tablePage.map((project) => (
              <article className="mobile-project" key={project.id}>
                <div>
                  <button
                    className="project-identity"
                    data-testid={`project-${project.id}`}
                    aria-label={`Open ${project.name}`}
                    onClick={() => setSelectedId(project.id)}
                  >
                    <ProtocolLogo project={project} />
                    <span>
                      <strong>{project.name}</strong>
                      {duplicateNames.has(
                        project.name.trim().toLowerCase(),
                      ) && <FamilyFingerprint project={project} />}
                      <small>
                        {project.description || "A Uniswap v4 hook"}
                      </small>
                    </span>
                  </button>
                  <button
                    data-testid={`watch-${project.id}`}
                    className={`star-button ${watchlist.includes(project.id) ? "saved" : ""}`}
                    aria-label={`${watchlist.includes(project.id) ? "Remove" : "Add"} ${project.name} ${watchlist.includes(project.id) ? "from" : "to"} watchlist`}
                    aria-pressed={watchlist.includes(project.id)}
                    onClick={() => toggleWatch(project.id)}
                  >
                    <Star size={18} />
                  </button>
                </div>
                <div className="mobile-project-meta">
                  <span className="category-tag" data-category={project.category}>
                    {project.category}
                  </span>
                  <span>
                    {chainName(project.chains[0])}
                    {project.chains.length > 1
                      ? ` +${project.chains.length - 1}`
                      : ""}
                  </span>
                  <span>
                    {project.entityType === "platform" ? (
                      "Platform"
                    ) : (
                      <>
                        {count(projectHookCount(project, filters.chain))}{" "}
                        {projectHookCount(project, filters.chain) === 1
                          ? "hook"
                          : "hooks"}
                      </>
                    )}
                  </span>
                  {project.id === "frontier" && frontierExtensions && (
                    <span title={extensionCountText(frontierExtensions).title}>
                      {extensionCountText(frontierExtensions).label}
                    </span>
                  )}
                  <span className="mobile-pool-count">
                    {projectPoolCount(project, filters.chain) === null
                      ? STATIC_EDITION
                        ? NO_POOLS_MEASURED
                        : "Pool count unavailable"
                      : `${count(projectPoolCount(project, filters.chain))} ${poolCountIsObserved(project, filters.chain) ? "observed " : ""}${projectPoolCount(project, filters.chain) === 1 ? "pool" : "pools"}`}
                  </span>
                </div>
                {project.entityType !== "platform" && (
                  <div className="project-research-actions">
                    <button
                      className={
                        comparison.includes(project.id) ? "selected" : ""
                      }
                      aria-pressed={comparison.includes(project.id)}
                      aria-label={`${comparison.includes(project.id) ? "Remove" : "Add"} ${project.name} ${comparison.includes(project.id) ? "from" : "to"} comparison`}
                      onClick={() => toggleComparison(project.id)}
                    >
                      <ArrowLeftRight size={14} />
                      {comparison.includes(project.id) ? "Selected" : "Compare"}
                    </button>
                    {!STATIC_EDITION && (
                      <button
                        aria-label={`View ${project.name} activity`}
                        onClick={() => openActivity(project.id)}
                      >
                        <Radio size={14} />
                        Activity
                      </button>
                    )}
                  </div>
                )}
                <div
                  className={`mobile-project-bottom ${project.metrics.volumeUsd[windowKey] === null && project.metrics.liquidityUsd === null ? "unmeasured" : ""}`}
                >
                  {project.metrics.volumeUsd[windowKey] === null &&
                  project.metrics.liquidityUsd === null ? (
                    <span className="unmeasured-note">
                      {STATIC_EDITION
                        ? // The snapshot measured a sample: nothing is pending.
                          unmeasuredCardNote(
                            (pagePools.get(project.id) ?? NO_POOLS).length,
                            filters.chain === "all"
                              ? null
                              : chainName(filters.chain),
                          )
                        : !deferredPoolMembership &&
                            measurementProvenance(
                              pagePools.get(project.id) ?? NO_POOLS,
                              windowKey,
                            ).poolCount > 0
                          ? "Totals are refreshing"
                          : "Market data isn’t available yet"}
                    </span>
                  ) : (
                    <>
                      <span>
                        {windows[windowKey]} tracked volume
                        <strong>
                          {money(project.metrics.volumeUsd[windowKey])}
                        </strong>
                        {deferredPoolMembership ? (
                          <ProjectMetricProof
                            project={project}
                            metric={windowKey}
                            now={now}
                          />
                        ) : (
                          <MetricMeasurement
                            pools={pagePools.get(project.id) ?? NO_POOLS}
                            metric={windowKey}
                            compact
                            awaitingTotal={
                              project.metrics.volumeUsd[windowKey] === null
                            }
                          />
                        )}
                      </span>
                      <span>
                        Reported reserves
                        <strong>{money(project.metrics.liquidityUsd)}</strong>
                        {deferredPoolMembership ? (
                          <ProjectMetricProof
                            project={project}
                            metric="liquidity"
                            now={now}
                          />
                        ) : (
                          <MetricMeasurement
                            pools={pagePools.get(project.id) ?? NO_POOLS}
                            metric="liquidity"
                            compact
                            awaitingTotal={project.metrics.liquidityUsd === null}
                          />
                        )}
                      </span>
                    </>
                  )}
                  <button onClick={() => setSelectedId(project.id)}>
                    Explore
                    <ArrowRight size={16} />
                  </button>
                </div>
              </article>
            ))}
          </div>
          )}
          <div className="table-footer">
            <p>
              {count((page - 1) * PAGE_SIZE + 1)}–
              {count(Math.min(page * PAGE_SIZE, resultCount || 0))} of{" "}
              {count(resultCount)}{" "}
              {STATIC_EDITION
                ? listNoun(filters.market, resultCount)
                : filters.market === "all"
                  ? resultCount === 1
                    ? "entry"
                    : "entries"
                  : resultCount === 1
                    ? "project"
                    : "projects"}
              <span>“—” means data is unavailable, not zero.</span>
            </p>
            <div className="pagination">
              <button
                className="icon-button"
                aria-label="Previous page"
                disabled={page <= 1 || (directoryBusy && !remote)}
                onClick={() => changePage(Math.max(1, page - 1))}
              >
                <ChevronLeft size={17} />
              </button>
              <span aria-live="polite" aria-atomic="true">
                Page {page} / {pages}
              </span>
              <button
                className="icon-button"
                aria-label="Next page"
                disabled={page >= pages || (directoryBusy && !remote)}
                onClick={() => changePage(Math.min(pages, page + 1))}
              >
                <ChevronRight size={17} />
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );

  // Where the strip offers the ecosystem Stats toggle (the lists, not the
  // workspaces that carry their own figures).
  const statsToggleShown =
    view !== "compare" &&
    view !== "activity" &&
    view !== "analytics" &&
    view !== "chains" &&
    !(view === "watchlist" && watchlist.length === 0);

  const statusLabel = STATIC_EDITION
    ? "Data & sources"
    : error && !snapshot && !serviceStarting
              ? discoveryContext
                ? "Analytics unavailable"
                : "Data unavailable"
              : serviceStarting && !discoveryContext
                ? "Checking saved data"
                : status === "cached"
                  ? "Saved data"
                  : status === "offline"
                    ? "Offline"
                    : coverage
                      ? indexComplete
                        ? indexCurrent
                          ? "Pool history current"
                          : "History indexed"
                        : indexScanning && coverage.running
                          ? "Finding more pools"
                          : "Data status"
                      : discoveryContext
                        ? "Directory ready"
                        : status === "live"
                          ? "Sources connected"
                          : status === "partial"
                            ? "Data connected"
                            : view === "learn"
                              ? "Data status"
                              : "Connecting";

  return (
    <>
      <div
        className={`application-shell ${carriedComparison.length && view !== "compare" ? "has-comparison" : ""} ${view === "learn" ? "learn-shell" : ""}`}
      >
        <a
          className="skip-link"
          href="#main"
          onClick={(event) => {
            // Move focus without leaving "#main" in the address, which would
            // otherwise end up in every link copied from this view.
            event.preventDefault();
            const main = document.getElementById("main");
            main?.focus();
            main?.scrollIntoView({ block: "start" });
          }}
        >
          {view === "learn" ? "Skip to guide" : "Skip to dashboard"}
        </a>
        <header className="topbar">
          <button
            className="brand"
            aria-label="Hook Radar overview"
            onClick={() => {
              setView("overview");
              resetFilters("overview");
            }}
          >
            <Logo />
            <span>
              <strong>
                Hook <em>Radar</em>
              </strong>
              <small>Uniswap v4 observatory</small>
            </span>
          </button>
          <nav ref={navigationRef} aria-label="Main navigation">
            {editionViews(
              [
                "overview",
                "learn",
                "analytics",
                "chains",
                "map",
                "activity",
                "compare",
                "watchlist",
              ] as View[],
            ).map((item) => (
              <button
                key={item}
                data-testid={`view-${item}`}
                className={view === item ? "active" : ""}
                aria-current={view === item ? "page" : undefined}
                onClick={() => setView(item)}
              >
                <NavIcon view={item} />
                {item === "overview" ? (
                  "Discover"
                ) : item === "analytics" ? (
                  "Analytics"
                ) : item === "learn" ? (
                  "Learn"
                ) : item === "activity" ? (
                  "Activity"
                ) : item === "compare" ? (
                  <>
                    Compare
                    {carriedComparison.length > 0 && (
                      <span className="nav-count">
                        {carriedComparison.length}
                      </span>
                    )}
                  </>
                ) : item === "chains" ? (
                  "Networks"
                ) : item === "map" ? (
                  "By use case"
                ) : (
                  <>
                    Watchlist
                    {watchlist.length > 0 && (
                      <span className="nav-count">{watchlist.length}</span>
                    )}
                    {watchChanges.unread > 0 && (
                      <span
                        className="watch-nav-update"
                        title={`${watchChanges.unread} unread watchlist updates`}
                      >
                        <span className="sr-only">
                          {watchChanges.unread} new updates
                        </span>
                      </span>
                    )}
                  </>
                )}
              </button>
            ))}
          </nav>
          <button
            type="button"
            className="palette-trigger"
            data-testid="palette-button"
            aria-label="Jump to a page, network, launchpad or project"
            aria-keyshortcuts="Control+K Meta+K"
            onClick={() => setPaletteOpen(true)}
          >
            <Search size={15} />
            <span>Jump to</span>
            <kbd aria-hidden="true">{paletteShortcutLabel()}</kbd>
          </button>
          {openSources && (
            <button
              className={`source-status ${headerStatus}`}
              data-testid="sources-button"
              onClick={openSources}
            >
              <span className="status-led" />
              <span className="source-status-label" title={statusLabel}>
                {phoneHeader ? (SHORT_STATUS[statusLabel] ?? statusLabel) : statusLabel}
              </span>
              <Info size={13} />
            </button>
          )}
        </header>
        <main id="main" tabIndex={-1}>
          <section
            className={`titlebar${view === "overview" ? " masthead" : ""}`}
          >
            <div className="titlebar-copy">
              {view === "overview" && (
                <p className="kicker">Uniswap v4 · hook observatory</p>
              )}
              <h1 ref={viewHeadingRef} tabIndex={-1}>
                {view === "learn"
                  ? "Understand v4 hooks"
                  : view === "watchlist"
                    ? "Your watchlist"
                    : view === "map"
                      ? "Explore by use case"
                      : view === "compare"
                        ? "Compare hooks"
                        : view === "analytics"
                          ? "Hook analytics"
                          : view === "chains"
                            ? chainRole === "launchpads"
                              ? "Launchpads on Uniswap v4"
                              : "Explore by network"
                            : view === "activity"
                              ? "Hook activity"
                              : "Uniswap v4 hooks"}
              </h1>
              {view !== "overview" && view !== "learn" && (
                <p>
                  {view === "watchlist"
                    ? "Your projects, their latest observations and what changed."
                    : view === "compare"
                      ? "Put hooks side by side: what they can do, where they run and how they trade."
                      : view === "analytics"
                        ? "How much the tracked hooks trade and hold, by network and by use case."
                        : view === "chains"
                          ? chainRole === "launchpads"
                            ? "What each launch platform offers, where it runs, and the hooks and pools it builds on."
                            : "See which hooks and protocols run on each network, and how much they trade."
                          : view === "activity"
                            ? "See what a hook is doing: its recent swaps, liquidity changes and fees."
                            : "Hook projects grouped by what they do: launching tokens, setting fees, managing liquidity and more."}
                </p>
              )}
              {view === "overview" && (
                <>
                  <p className="masthead-lede">
                    Hooks are add-ons that give Uniswap v4 pools extra
                    abilities, such as custom fees, limit orders or token
                    launches. Browse them here, see how much they trade and what
                    each one can do.{" "}
                    <button
                      type="button"
                      className="text-link"
                      onClick={() => setView("learn")}
                    >
                      New to hooks? Start here
                      <ArrowRight size={13} />
                    </button>
                  </p>
                  <p className="masthead-lede masthead-lede-short">
                    Hooks are add-ons that give Uniswap v4 pools extra
                    abilities.{" "}
                    <button
                      type="button"
                      className="text-link"
                      onClick={() => setView("learn")}
                    >
                      New to hooks? Start here
                      <ArrowRight size={13} />
                    </button>
                  </p>
                </>
              )}
              {view === "overview" && (
                <MastheadFigures
                  {...mastheadTotals}
                  census={
                    STATIC_EDITION
                      ? censusLabel(inventoryFigures, snapshot?.generatedAt)
                      : null
                  }
                />
              )}
            </div>
            {view === "overview" && (
              <div className="masthead-instrument">
                <RadarInstrument />
              </div>
            )}
            <div className="title-controls">
              {view === "learn" ? (
                <button
                  type="button"
                  className="control"
                  onClick={() =>
                    void copy(
                      new URL("?view=learn", location.href).href,
                      "Guide link copied.",
                    )
                  }
                >
                  <Copy size={15} /> Copy guide link
                </button>
              ) : (
                <>
                  {view !== "compare" && view !== "activity" && (
                    <div
                      className="window-switch"
                      role="group"
                      aria-label="Volume time window"
                    >
                      {(Object.keys(windows) as WindowKey[]).map((key) => (
                        <button
                          key={key}
                          className={windowKey === key ? "selected" : ""}
                          aria-pressed={windowKey === key}
                          onClick={() => setWindow(key)}
                        >
                          {windows[key]}
                        </button>
                      ))}
                    </div>
                  )}
                  {view !== "activity" && !STATIC_EDITION && (
                    <button
                      className="control refresh-button"
                      data-testid="refresh-button"
                      disabled={
                        analyticsLite
                          ? overview.loading
                          : refreshing || loading || serviceStarting
                      }
                      title={
                        loading && discoveryContext
                          ? "Analytics are still loading. Directory search remains available."
                          : undefined
                      }
                      onClick={() =>
                        analyticsLite
                          ? setAnalyticsRetry((n) => n + 1)
                          : void fetchSnapshot(true).then(() =>
                              // The page behind Discover is asked too.
                              setDiscoveryRefresh((value) => value + 1),
                            )
                      }
                      aria-label={
                        refreshing ? "Refreshing data" : "Refresh data"
                      }
                    >
                      <RefreshCw
                        className={refreshing ? "spin" : ""}
                        size={16}
                      />
                      <span>{refreshing ? "Refreshing" : "Refresh"}</span>
                    </button>
                  )}
                  <button
                    className="control share-button"
                    data-testid="share-button"
                    onClick={() =>
                      snapshot
                        ? setModal("share")
                        : void copy(shareLink, "View link copied.")
                    }
                    disabled={!snapshot && !discoveryContext && !overview.data}
                  >
                    {!snapshot ||
                    view === "compare" ||
                    view === "activity" ||
                    view === "analytics" ||
                    view === "chains"
                      ? "Share view"
                      : "Share & export"}
                    {!snapshot ||
                    view === "compare" ||
                    view === "activity" ||
                    view === "analytics" ||
                    view === "chains" ? (
                      <Copy size={15} />
                    ) : (
                      <Download size={15} />
                    )}
                  </button>
                </>
              )}
            </div>
          </section>
          {error && view !== "learn" && (
            <div role="alert" className="notice error-notice">
              <Info size={17} />
              <span>
                {error}
                {snapshot ? " Showing the last successful snapshot." : ""}
              </span>
              {/* The edition keeps the button where it is while the request
                  runs (aria-disabled, "Retrying…"): a disabled button drops
                  keyboard focus to the top of the page. */}
              <button
                onClick={() => {
                  if (STATIC_EDITION) retryFocus.current = "pressed";
                  void fetchSnapshot(!!snapshot);
                }}
                disabled={STATIC_EDITION ? undefined : refreshing || loading}
                aria-disabled={
                  STATIC_EDITION && (refreshing || loading) ? true : undefined
                }
              >
                {STATIC_EDITION && (refreshing || loading)
                  ? "Retrying…"
                  : "Retry"}
              </button>
            </div>
          )}
          {STATIC_EDITION && publishingLate && view !== "learn" && (
            <div role="status" className="notice orphan-notice">
              <Info size={16} />
              <span>{PUBLISHING_NOTE}</span>
            </div>
          )}
          {serviceStarting && snapshot && view !== "learn" && (
            <div role="status" className="notice">
              <RefreshCw size={17} />
              <span>
                Checking saved data. You can keep browsing the last loaded
                snapshot from {new Date(snapshot.generatedAt).toLocaleString()}.
                Only loaded saved projects are shown; the full hook directory
                and pool lists open when verification finishes.
                {startupProgress?.phase === "checking-pools" &&
                startupProgress.totalPools ? (
                  <span aria-live="off">
                    {` ${count(startupProgress.checkedPools || 0)} of ${count(startupProgress.totalPools)} saved pools checked.`}
                  </span>
                ) : (
                  " We’ll reconnect automatically when it’s ready."
                )}
              </span>
            </div>
          )}
          {view === "learn" ? (
            <WorkspaceBoundary key="learn" label="Guide">
              <LearnHooks
                onExplore={(category) => {
                  setFilters({
                    ...defaultFilters,
                    category:
                      category &&
                      categories.includes(
                        category as (typeof categories)[number],
                      )
                        ? category
                        : "all",
                  });
                  setSelectedIdState(null);
                  setView("overview");
                }}
              />
              <SiteFooter
                onSources={openSources}
                onJump={() => setPaletteOpen(true)}
                onShortcuts={() => setModal("shortcuts")}
              />
            </WorkspaceBoundary>
          ) : analyticsLite && !serviceStarting ? (
            <>
              {STATIC_EDITION && overview.data && (
                <SnapshotLine
                  generatedAt={overview.data.publication.generatedAt}
                  newerAt={newerPublication}
                  checked={publicationChecked}
                />
              )}
              {overview.error && (
                <div className="notice error-notice" role="alert">
                  <Info size={17} />
                  <span>{overview.error}</span>
                  {/* The edition keeps the button where it is while the request
                      runs (aria-disabled, "Retrying…"), so keyboard focus is not
                      dropped to the top of the page. */}
                  <button
                    className="control"
                    onClick={() => {
                      if (STATIC_EDITION) {
                        if (overview.loading) return;
                        retryFocus.current = "pressed";
                      }
                      retryOverview();
                    }}
                    disabled={STATIC_EDITION ? undefined : overview.loading}
                    aria-disabled={
                      STATIC_EDITION && overview.loading ? true : undefined
                    }
                  >
                    {STATIC_EDITION && overview.loading
                      ? "Retrying…"
                      : "Retry analytics"}
                  </button>
                </div>
              )}
              {overview.data ? (
                <WorkspaceBoundary
                  key="analytics-overview"
                  label="Analytics overview"
                  page
                >
                  <AnalyticsOverview
                    envelope={overview.data}
                    now={overviewNow}
                    range={analyticsRange}
                    setRange={changeAnalyticsRange}
                    setChain={changeAnalyticsChain}
                    openSources={openSources}
                    openDetails={() => setAnalyticsExpanded(true)}
                    seriesRecorded={analyticsSeries}
                    refreshing={overview.loading}
                  />
                </WorkspaceBoundary>
              ) : overview.notPublished ? (
                // The link names a network this snapshot has no analytics for:
                // asking again cannot change that, so there is no Retry. The
                // page's h1 is above it, so this is a level-2 heading.
                <Empty
                  headingLevel={2}
                  title={NOT_PUBLISHED_TITLE}
                  action={
                    <button
                      className="primary-button"
                      onClick={showAllAnalyticsNetworks}
                    >
                      All networks
                    </button>
                  }
                >
                  Show all networks to see what this snapshot measured.
                </Empty>
              ) : (
                <Empty
                  headingLevel={STATIC_EDITION ? 2 : 3}
                  title={
                    overview.loading
                      ? "Loading analytics…"
                      : "Analytics unavailable"
                  }
                  action={
                    !overview.loading ? (
                      <div className="drawer-state-actions">
                        {/* Already on All networks, the button would do
                            nothing (no request, the same text). */}
                        {(!STATIC_EDITION || analyticsChain !== "all") && (
                          <button
                            className="control"
                            onClick={showAllAnalyticsNetworks}
                          >
                            All networks
                          </button>
                        )}
                        <button
                          className="primary-button"
                          onClick={() => setAnalyticsExpanded(true)}
                        >
                          Open full analytics
                        </button>
                      </div>
                    ) : undefined
                  }
                >
                  {STATIC_EDITION
                    ? "Hook volume, reserves and network distribution from the snapshot."
                    : "Current measurements, network distribution and market history."}
                </Empty>
              )}
              {/* Not while the first figures are on their way: the page grows
                  below it and the footer would jump into view. */}
              {(overview.data || !overview.loading) && (
                <SiteFooter
                  sources={overview.data?.sources}
                  onSources={openSources}
                  onJump={() => setPaletteOpen(true)}
                  onShortcuts={() => setModal("shortcuts")}
                />
              )}
            </>
          ) : discoveryView &&
            discoveryShell &&
            discoveryContext &&
            !directoryStarting ? (
            <>
              <div className="coverage-strip discovery-bootstrap" role="status">
                <span>
                  <span
                    className={`status-led ${headerStatus === "live" ? "green" : "amber"}`}
                  />
                  {coverage ? (
                    <>
                      <strong>Data status</strong>
                      <span className="coverage-description">
                        {`${coverageSummary(coverage, { serviceStarting, savedCoverage }).long} · updated ${relativeTime(discoveryContext.data.publication.generatedAt).toLowerCase()}`}
                      </span>
                      <span className="coverage-mobile-description">
                        {
                          coverageSummary(coverage, {
                            serviceStarting,
                            savedCoverage,
                          }).short
                        }
                      </span>
                    </>
                  ) : (
                    <>
                      <strong>Hook directory</strong>
                      <span className="coverage-description">
                        {`Published ${relativeTime(discoveryContext.data.publication.generatedAt).toLowerCase()}`}
                      </span>
                      <span className="coverage-mobile-description">
                        {`Published ${relativeTime(discoveryContext.data.publication.generatedAt).toLowerCase()}`}
                      </span>
                    </>
                  )}
                </span>
                <div className="coverage-actions">
                  {snapshot ? (
                    <>
                      {/* An empty watchlist has no list to show in full. */}
                      {!(view === "watchlist" && watchlist.length === 0) && (
                        <button onClick={() => setDiscoveryShell(false)}>
                          Full overview <Layers size={13} />
                        </button>
                      )}
                      <button onClick={() => setView("analytics")}>
                        Open analytics <ArrowRight size={13} />
                      </button>
                    </>
                  ) : error && !loading ? (
                    <button onClick={() => void fetchSnapshot()}>
                      Retry analytics <RefreshCw size={13} />
                    </button>
                  ) : savingData && !loading ? (
                    <button
                      title="Your browser asked for less data, so the full analytics (a large download) load only when you ask."
                      onClick={() => {
                        bulkStarted.current = true;
                        void fetchSnapshot();
                      }}
                    >
                      Load analytics <Download size={13} />
                    </button>
                  ) : (
                    <span>
                      <RefreshCw size={14} className="spin" /> Analytics
                      loading…
                    </span>
                  )}
                </div>
              </div>
              {view === "overview" &&
                (snapshot && spotlight ? (
                  <HookSpotlight
                    entries={spotlightEntries}
                    chains={snapshot.chains}
                    openProject={setSelectedId}
                    suspended={Boolean(selectedId || modal)}
                  />
                ) : !snapshot && loading ? (
                  <SpotlightPlaceholder />
                ) : null)}
              {/* Shown before the full snapshot too (it reads the browser's saved
                  baselines): the full layout renders it above the list, so adding
                  it only at hydration pushed the list and its page buttons down
                  by the panel's height while a visitor was using them. */}
              {view === "watchlist" && watchlist.length > 0 && (
                <WatchChangeFeed
                  {...watchChanges}
                  total={watchlist.length}
                  openProject={setSelectedId}
                />
              )}
              {discoveryDirectory}
              <SiteFooter
                updatedAt={discoveryContext.data.publication.generatedAt}
                sources={snapshot?.sources}
                onSources={openSources}
                onJump={() => setPaletteOpen(true)}
                onShortcuts={() => setModal("shortcuts")}
              />
            </>
          ) : (loading || serviceStarting) && !snapshot ? (
            <div className="loading-screen" role="status">
              <Logo />
              <h2>
                {serviceStarting
                  ? startupProgress?.phase === "checking-pools"
                    ? "Checking saved pools"
                    : startupProgress?.phase === "preparing-radar"
                      ? view === "analytics"
                        ? "Opening analytics"
                        : view === "chains"
                          ? "Opening chain explorer"
                          : "Opening hook directory"
                      : "Checking saved data"
                  : view === "analytics"
                    ? "Loading analytics"
                    : view === "chains"
                      ? "Loading chain explorer"
                      : "Loading hook directory"}
              </h2>
              <p>
                {serviceStarting
                  ? startupTakingLonger
                    ? "Large saved histories can take several minutes to verify. This page opens automatically when the check finishes."
                    : `Verifying saved pool history. ${view === "analytics" ? "Analytics" : view === "chains" ? "The chain explorer" : "The directory"} opens automatically when checks finish.`
                  : STATIC_EDITION
                    ? // A published file is downloaded; nothing is measured here.
                      "Loading the latest published snapshot…"
                    : view === "analytics"
                      ? "Fetching market measurements and network coverage…"
                      : view === "chains"
                        ? "Fetching networks, protocols and market measurements…"
                        : "Finding hooks and their pools…"}
              </p>
              {startupProgress?.phase === "checking-pools" &&
              startupProgress.totalPools !== undefined &&
              startupProgress.totalPools > 0 ? (
                <p className="startup-progress-count" aria-live="off">
                  {count(startupProgress.checkedPools || 0)} of{" "}
                  {count(startupProgress.totalPools)} saved pools verified
                </p>
              ) : null}
              <span
                className="loading-track"
                data-determinate={
                  startupProgress?.phase === "checking-pools" &&
                  Boolean(startupProgress.totalPools)
                }
                {...(startupProgress?.phase === "checking-pools" &&
                startupProgress.totalPools
                  ? {
                      role: "progressbar",
                      "aria-label": "Saved pools verified",
                      "aria-valuemin": 0,
                      "aria-valuemax": startupProgress.totalPools,
                      "aria-valuenow": startupProgress.checkedPools || 0,
                      "aria-live": "off" as const,
                    }
                  : { "aria-hidden": true })}
              >
                <span
                  style={
                    startupProgress?.phase === "checking-pools" &&
                    startupProgress.totalPools
                      ? {
                          width: `${(100 * (startupProgress.checkedPools || 0)) / startupProgress.totalPools}%`,
                        }
                      : undefined
                  }
                />
              </span>
              <LoadingPlates view={view} />
            </div>
          ) : !snapshot ? (
            <section className="panel">
              <Empty
                title="We couldn’t load the radar"
                action={
                  // The notice above carries the one Retry button.
                  STATIC_EDITION && error ? undefined : (
                    <button
                      className="primary-button"
                      onClick={() => void fetchSnapshot()}
                    >
                      Try again <RefreshCw size={15} />
                    </button>
                  )
                }
              >
                {STATIC_EDITION
                  ? connectionFailures > RECONNECT_LIMIT
                    ? "This page has stopped trying by itself; use Retry when you are ready. Your saved watchlist stays in this browser."
                    : "This page tries again by itself. Your saved watchlist stays in this browser."
                  : "We’ll reconnect automatically. Your saved watchlist is safe."}
              </Empty>
            </section>
          ) : (
            <>
              <div className="coverage-strip">
                {STATIC_EDITION ? (
                  <SnapshotLine
                    generatedAt={snapshot.generatedAt}
                    newerAt={newerPublication}
                    checked={publicationChecked}
                  />
                ) : (
                <span>
                  <span
                    className={`status-led ${headerStatus === "live" ? "green" : "amber"}`}
                  />
                  <strong>
                    {snapshot.inventory
                      ? "Data status"
                      : snapshot.pools.length
                        ? "Available market data"
                        : "Hook directory"}
                  </strong>
                  <span className="coverage-description">
                    {snapshot.inventory
                      ? coverageSummary(snapshot.inventory, {
                          serviceStarting,
                          savedCoverage,
                        }).long
                      : snapshot.pools.length
                        ? `${snapshot.coverage.measuredChains.length} measured ${snapshot.coverage.measuredChains.length === 1 ? "network" : "networks"} · market coverage is partial`
                        : "Market measurements unavailable · deployment registry remains searchable"}
                  </span>
                  {snapshot.inventory && (
                    <span className="coverage-mobile-description">
                      {
                        coverageSummary(snapshot.inventory, {
                          serviceStarting,
                          savedCoverage,
                        }).short
                      }
                    </span>
                  )}
                </span>
                )}
                {/* No empty row of actions where the page has neither the Stats
                    toggle nor the data dialog to offer. */}
                {(statsToggleShown || openSources) && (
                  <div className="coverage-actions">
                    {statsToggleShown && (
                      <button
                        className="mobile-stats-toggle"
                        aria-expanded={mobileStatsOpen}
                        aria-controls="ecosystem-stats"
                        aria-label={
                          mobileStatsOpen
                            ? "Hide ecosystem stats"
                            : "View ecosystem stats"
                        }
                        onClick={() => setMobileStatsOpen(!mobileStatsOpen)}
                      >
                        <span className="stats-label-full">
                          {mobileStatsOpen
                            ? "Hide ecosystem stats"
                            : "View ecosystem stats"}
                        </span>
                        <span
                          className="stats-label-compact"
                          aria-hidden="true"
                        >
                          Stats
                        </span>
                        <ChevronDown size={14} />
                      </button>
                    )}
                    {openSources && (
                      <button onClick={openSources}>
                        Data details <ArrowRight size={13} />
                      </button>
                    )}
                  </div>
                )}
              </div>
              {!serviceStarting &&
                !error &&
                status !== "offline" &&
                collectionProgress && (
                  <p className="collection-progress-note" role="note">
                    {collectionProgressCopy(collectionProgress)}
                  </p>
                )}
              {view === "chains" ? (
                <WorkspaceBoundary key="chains" label="Chains" page>
                  <ChainExplorer
                    snapshot={snapshot}
                    windowKey={windowKey}
                    now={now}
                    chain={chainNetwork}
                    setChain={changeChainNetwork}
                    search={chainSearch}
                    setSearch={setChainSearch}
                    role={chainRole}
                    setRole={changeChainRole}
                    openProject={setSelectedId}
                    inspectActivity={STATIC_EDITION ? undefined : openActivity}
                    openAnalytics={openChainAnalytics}
                    browseHooks={(chain) => {
                      setFilters({ ...defaultFilters, chain, market: "all" });
                      setView("overview");
                    }}
                    openSources={openSources}
                    disabled={serviceStarting}
                  />
                </WorkspaceBoundary>
              ) : view === "analytics" ? (
                <WorkspaceBoundary key="analytics" label="Analytics" page>
                  <AnalyticsWorkspace
                    snapshot={snapshot}
                    windowKey={windowKey}
                    now={now}
                    chain={analyticsChain}
                    setChain={changeAnalyticsChain}
                    range={analyticsRange}
                    setRange={changeAnalyticsRange}
                    openProject={setSelectedId}
                    inspectActivity={STATIC_EDITION ? undefined : openActivity}
                    browseHooks={(chain) => {
                      setFilters({ ...defaultFilters, chain, market: "all" });
                      setView("overview");
                    }}
                    openSources={openSources}
                    disabled={serviceStarting}
                  />
                </WorkspaceBoundary>
              ) : view === "compare" ? (
                <WorkspaceBoundary key="compare" label="Comparison" page>
                  <HookComparison
                    ids={comparison}
                    onChange={setComparison}
                    network={comparisonChain}
                    onNetworkChange={setComparisonChain}
                    snapshot={snapshot}
                    onOpenProject={setSelectedId}
                    onActivity={STATIC_EDITION ? undefined : openActivity}
                    checkingHistory={serviceStarting}
                  />
                </WorkspaceBoundary>
              ) : view === "activity" ? (
                <WorkspaceBoundary key="activity" label="Activity" page>
                  <ActivityExplorer
                    snapshot={snapshot}
                    projectId={activityProject}
                    onSelectProject={(id) => {
                      setActivityProject(id);
                      setActivitySelection({
                        chain: "all",
                        window: "h24",
                        poolId: "",
                        hookAddress: "",
                      });
                    }}
                    onOpenProject={setSelectedId}
                    scope={activitySelection}
                    onScopeChange={setActivitySelection}
                    disabled={serviceStarting}
                  />
                </WorkspaceBoundary>
              ) : (
                <>
                  {view === "watchlist" && watchlist.length > 0 && (
                    <WatchChangeFeed
                      {...watchChanges}
                      total={watchlist.length}
                      openProject={setSelectedId}
                    />
                  )}
                  {!(view === "watchlist" && watchlist.length === 0) && (
                    <>
                      <section
                        id="ecosystem-stats"
                        data-mobile-open={mobileStatsOpen}
                        className="metrics"
                        aria-label="Dashboard statistics"
                      >
                        <Metric
                          label={
                            !serviceStarting && filters.market === "all"
                              ? "Directory entries"
                              : "Projects"
                          }
                          value={count(resultCount)}
                          note={
                            serviceStarting
                              ? "Loaded saved projects only"
                              : activeFilterCount || view === "watchlist"
                                ? "Matching this view"
                                : STATIC_EDITION
                                  ? projectsFigureNote(filters.market)
                                  : filters.market === "all"
                                    ? "Named projects and unnamed hooks"
                                    : "Named projects in this view"
                          }
                          icon={<Code2 size={16} />}
                        />
                        <Metric
                          label="Pools"
                          value={
                            STATIC_EDITION || snapshot.inventory
                              ? count(scopedPoolCount)
                              : "—"
                          }
                          note={
                            STATIC_EDITION
                              ? poolsFigureNote(
                                  scopedPoolCount,
                                  snapshot.pools.length,
                                )
                              : snapshot.inventory
                              ? filters.market === "all" &&
                                !activeFilterCount &&
                                view !== "watchlist"
                                ? "Hook pools discovered so far"
                                : filters.market === "projects" &&
                                    !activeFilterCount &&
                                    view !== "watchlist"
                                  ? "Pools for these projects"
                                  : "Pools in this view"
                              : "Pool discovery unavailable"
                          }
                          icon={<Layers size={16} />}
                        />
                        <Metric
                          label={`Tracked hook volume · ${windows[windowKey]}`}
                          value={money(scopeVolume)}
                          note={
                            useDirectory && !remote
                              ? "Finding matching pools…"
                              : deferredPoolMembership
                                ? "Loading scoped market measurements…"
                                : `${count(scopeVolumeCount)} ${scopeVolumeCount === 1 ? "pool" : "pools"} with current volume data`
                          }
                          icon={<ArrowLeftRight size={16} />}
                          scope="Partial coverage · Not total Uniswap volume"
                          detail={
                            !deferredPoolMembership && (
                              <MetricMeasurement
                                pools={scopedPools}
                                metric={windowKey}
                                compact
                              />
                            )
                          }
                        />
                        <Metric
                          label="Networks"
                          value={
                            useDirectory && !remote
                              ? "—"
                              : count(scopedDeploymentChains.length)
                          }
                          note={
                            STATIC_EDITION
                              ? networksFigureNote({
                                  measuredScope: scopedMeasuredScope,
                                  measuredNetworks: new Set(
                                    scopedPools.map((pool) => pool.chain),
                                  ).size,
                                })
                              : scopedMeasuredScope
                                ? "Networks with measured pools in this view"
                                : "Networks in this view"
                          }
                          icon={<Network size={16} />}
                        />
                      </section>
                      <details className="overview-data-notes">
                        <summary>
                          About these numbers <Info size={13} />
                          <span className="overview-scope">
                            {STATIC_EDITION
                              ? listScopeLabel(view, filters.market)
                              : view === "watchlist"
                                ? "Your watchlist"
                                : filters.market === "all"
                                  ? "All hooks"
                                  : filters.market === "observed"
                                    ? "With market data"
                                    : "Named projects"}
                            {" · "}
                            {filters.chain === "all"
                              ? "All networks"
                              : chainName(filters.chain)}
                          </span>
                        </summary>
                        <p>
                          These totals follow your selected projects, networks
                          and filters. Trading volume covers tracked v4 hook
                          pools with measurements, not total Uniswap volume.
                          Each pool’s volume window ends at its own measurement
                          time, so saved values can describe earlier activity.{" "}
                          {STATIC_EDITION
                            ? "Pool counts are the pools measured in this snapshot; the hook and pool census is dated separately."
                            : snapshot.inventory
                            ? serviceStarting
                              ? "These are the last loaded counts while saved history is being checked."
                              : savedCoverage
                                ? "These counts come from the last loaded snapshot."
                                : collectionProgress
                                  ? "Search is catching up with the collected pool history."
                                  : indexComplete
                                    ? indexCurrent
                                      ? "Pool discovery is caught up to recently verified chain heads."
                                      : "Indexed history is saved; current chain heads are being checked."
                                    : "More pool history is being added to search."
                            : "Pool discovery is unavailable."}{" "}
                          Reserve estimates are shown on individual projects and
                          pools.
                        </p>
                        {deferredPoolMembership ? (
                          <p role="status">Pool measurements are loading.</p>
                        ) : (
                          <MarketProvenanceStrip
                            pools={scopedPools}
                            windowKey={windowKey}
                          />
                        )}
                        {openSources && (
                          <button onClick={openSources}>
                            View data coverage <ArrowRight size={13} />
                          </button>
                        )}
                      </details>
                    </>
                  )}
                  {spotlight && (
                    <HookSpotlight
                      entries={spotlightEntries}
                      chains={snapshot.chains}
                      openProject={setSelectedId}
                      suspended={Boolean(selectedId || modal)}
                    />
                  )}
                  {discoveryDirectory}
                  {!(view === "watchlist" && watchlist.length === 0) && (
                    <>
                      {view !== "map" && (
                        <>
                          <button
                            className="mobile-monitor-toggle"
                            aria-expanded={mobileMonitorOpen}
                            aria-controls="ecosystem-monitor"
                            onClick={() =>
                              setMobileMonitorOpen(!mobileMonitorOpen)
                            }
                          >
                            <span>
                              <Network size={16} /> Ecosystem insights
                            </span>
                            <span>
                              {mobileMonitorOpen ? "Hide" : "Show"}{" "}
                              <ChevronDown size={16} />
                            </span>
                          </button>
                          <section
                            id="ecosystem-monitor"
                            className="monitor-row"
                            data-mobile-open={mobileMonitorOpen}
                          >
                            <Monitor
                              snapshot={snapshot}
                              categoryCounts={remote?.landscape}
                              landscape={selectProjects(
                                projects,
                                snapshot.pools,
                                {
                                  ...filters,
                                  category: "all",
                                },
                                undefined,
                                now,
                                windowKey,
                              ).filter(
                                (project) =>
                                  view !== "watchlist" ||
                                  watchlist.includes(project.id),
                              )}
                              projects={useDirectory ? localFiltered : filtered}
                              category={filters.category}
                              setCategory={setCategory}
                              windowKey={windowKey}
                              filtered={
                                activeFilterCount > 0 || view === "watchlist"
                              }
                              // Edition: the counts are of the rows the page
                              // lists, so another market scope narrows them
                              // too (History stays tied to `filtered`).
                              narrowed={
                                STATIC_EDITION && filters.market !== "projects"
                              }
                              openProject={(id) => setSelectedId(id, "pools")}
                              openSources={openSources}
                              onClearScope={() => {
                                resetFilters("overview");
                                setView("overview");
                              }}
                            />
                            <RegistryUpdates
                              events={feedEvents}
                              scopedEvents={scopedEvents}
                              loading={loading || refreshing}
                              scopedLoading={
                                useDirectory
                                  ? directoryLoading ||
                                    (!remote && !directoryError)
                                  : loading || refreshing
                              }
                              error={error}
                              scopedError={useDirectory ? directoryError : ""}
                              scopedSyncing={scopedFeedSyncing}
                              registry={snapshot.sources.find(
                                (source) => source.id === "registry",
                              )}
                              now={now}
                              recovering={serviceStarting}
                              watchlist={view === "watchlist"}
                              chainName={chainName}
                              onRefresh={() => void fetchSnapshot()}
                              onRetryScope={() => {
                                if (useDirectory)
                                  setDirectoryRetry((value) => value + 1);
                                if (!useDirectory || scopedFeedSyncing || error)
                                  void fetchSnapshot();
                              }}
                              onOpen={(event) => {
                                if (event.projectId)
                                  setSelectedId(event.projectId);
                                else if (safeUrl(event.url))
                                  window.open(
                                    safeUrl(event.url),
                                    "_blank",
                                    "noopener,noreferrer",
                                  );
                              }}
                            >
                              {!spotlight && (
                                <button
                                  className="watch-callout"
                                  onClick={() => {
                                    setView(
                                      view === "watchlist"
                                        ? "overview"
                                        : "watchlist",
                                    );
                                    resetFilters(
                                      view === "watchlist"
                                        ? "overview"
                                        : "watchlist",
                                    );
                                  }}
                                >
                                  <span className="eyebrow">▪ WATCHLIST</span>
                                  <span>
                                    {watchlist.length
                                      ? `${watchlist.length} ${watchlist.length === 1 ? "project" : "projects"} on your watchlist`
                                      : "Save projects for quick access."}
                                  </span>
                                  <strong>
                                    {view === "watchlist"
                                      ? "Explore projects"
                                      : "Open watchlist"}{" "}
                                    <ArrowRight size={13} />
                                  </strong>
                                </button>
                              )}
                            </RegistryUpdates>
                          </section>
                        </>
                      )}
                    </>
                  )}
                </>
              )}
              <SiteFooter
                updatedAt={snapshot.generatedAt}
                sources={snapshot.sources}
                onSources={openSources}
                onJump={() => setPaletteOpen(true)}
                onShortcuts={() => setModal("shortcuts")}
              />
            </>
          )}
        </main>
        {carriedComparison.length > 0 && view !== "compare" && (
          <aside className="compare-tray" aria-label="Comparison selection">
            <span>
              <ArrowLeftRight size={17} />
              <strong>{carriedComparison.length} selected</strong>
              <small>Compare up to 4 projects</small>
            </span>
            <div>
              <button className="control" onClick={() => setComparison([])}>
                Clear
              </button>
              <button
                className="primary-button"
                onClick={() => {
                  setSelectedIdState(null);
                  setView("compare");
                }}
              >
                Compare projects <ArrowRight size={15} />
              </button>
            </div>
          </aside>
        )}
      </div>
      {selectedId && registryRecord ? (
        <Modal title="Project details" onClose={closeSelected} drawer>
          <WorkspaceBoundary key={selectedId} label="Project details">
            <PlatformDetail
              project={
                launchpadListingProjects(listingChains).find(
                  (listing) => listing.id === selectedId,
                ) ?? launchpadFallbackProject(registryRecord)
              }
              chains={listingChains}
              watchlisted={false}
              canWatch={false}
              toggleWatch={() => undefined}
              copy={copy}
              availability={registryAvailability(registryRecord)}
              relationships={registryRelationships(registryRecord)}
              launchpad={registryRecord}
              market={registryMarket}
              marketPending={!snapshot}
              openProject={(id, tab) => setSelectedId(id, tab)}
            />
          </WorkspaceBoundary>
        </Modal>
      ) : (
        selectedId &&
        (selected && selectedContext ? (
          <Modal title="Project details" onClose={closeSelected} drawer>
            <WorkspaceBoundary key={selectedId} label="Project details">
              <ProjectDetail
                project={selected}
                duplicateName={duplicateNames.has(
                  selected.name.trim().toLowerCase(),
                )}
                snapshot={selectedContext}
                platformAvailability={platformAvailabilityFor(selected)}
                initialChain={view === "chains" ? chainNetwork : "all"}
                checkingHistory={serviceStarting}
                savedContext={
                  serviceStarting ||
                  (snapshot
                    ? Boolean(error) || status === "offline"
                    : fastDetails.data?.status === "offline")
                }
                refreshPoolHistory={
                  snapshot
                    ? () => fetchSnapshot(false, true)
                    : async () => {
                        setDetailRetry((n) => n + 1);
                      }
                }
                watchlisted={watchlist.includes(selected.id)}
                toggleWatch={() => toggleWatch(selected.id)}
                copy={copy}
                windowKey={windowKey}
                tab={selectedTab}
                setTab={changeDetailTab}
                extensionSelection={selectedExtension}
                onExtensionSelection={changeExtensionSelection}
                onCompare={() => toggleComparison(selected.id)}
                compared={comparison.includes(selected.id)}
                onActivity={
                  STATIC_EDITION
                    ? undefined
                    : (chain, poolScope) =>
                        openActivity(selected.id, chain, poolScope)
                }
              />
            </WorkspaceBoundary>
          </Modal>
        ) : (
          <Modal title="Project details" onClose={closeSelected} drawer>
            <Empty
              title={
                serviceStarting
                  ? "Checking saved project details"
                  : selectedLoading || (snapshot?.directory && !selectedError)
                    ? "Loading hook details…"
                    : selectedError
                      ? "Hook details unavailable"
                      : "Project not in this snapshot"
              }
              action={
                selectedError ? (
                  <div className="drawer-state-actions">
                    <button
                      className="primary-button"
                      onClick={() =>
                        STATIC_EDITION && !snapshot
                          ? void fetchSnapshot()
                          : setDetailRetry((n) => n + 1)
                      }
                    >
                      {/* In the edition what failed is the snapshot, not details. */}
                      {STATIC_EDITION ? "Try again" : "Retry details"}
                    </button>
                    {!snapshot && !STATIC_EDITION && (
                      <button
                        className="control"
                        onClick={() => void fetchSnapshot()}
                      >
                        Load full dashboard
                      </button>
                    )}
                    <button className="control" onClick={closeSelected}>
                      Back to radar
                    </button>
                  </div>
                ) : selectedLoading ? undefined : (
                  <button className="primary-button" onClick={closeSelected}>
                    Back to radar
                  </button>
                )
              }
            >
              {serviceStarting
                ? "This project is outside the loaded saved view. Its full details open automatically after verification."
                : selectedLoading || (snapshot?.directory && !selectedError)
                  ? "Loading the indexed contracts and pools for this hook."
                  : selectedError ||
                    (STATIC_EDITION
                      ? PROJECT_NOT_CARRIED
                      : "This shared link may refer to a project that has been removed or renamed in the registry.")}
            </Empty>
          </Modal>
        ))
      )}
      {SOURCES_DIALOG && modal === "sources" && (
        <Modal title="Data & sources" onClose={closeModal}>
          <div className="modal-body">
            <h2>Data coverage</h2>
            <p className="intro-copy">
              {STATIC_EDITION && snapshot ? (
                `This page is a snapshot taken ${fullTimeLabel(snapshot.generatedAt) ?? "at an unknown time"}. It was collected from the public data services below; nothing is fetched while you read. Prices are measured for a sample of hook pools, and each figure keeps the time it was measured. Hook and pool counts come from a dated census.`
              ) : serviceStarting && !snapshot && !discoveryContext ? (
                "The radar is checking its saved pool history before opening the dashboard. Source details appear when the check finishes."
              ) : snapshot?.inventory ? (
                "Radar finds pools onchain across Uniswap v4 networks and connects them to the public hook registry. Pool discovery and market data are tracked separately, so unpriced pools stay searchable."
              ) : (
                <>
                  Radar combines the public Uniswap hook registry with an
                  observed pool sample. The registry describes deployments;
                  market sources measure only the pools they return.
                </>
              )}
            </p>
            {STATIC_EDITION && snapshot && (
              <EditionRun snapshotAt={snapshot.generatedAt} />
            )}
            {serviceStarting &&
              !snapshot &&
              !discoveryContext &&
              startupProgress && (
                <p className="collection-progress-note" role="status">
                  {startupProgress.phase === "checking-pools"
                    ? "Checking saved pools"
                    : startupProgress.phase === "preparing-radar"
                      ? "Opening hook directory"
                      : "Checking saved pool history"}
                  {startupProgress.phase === "checking-pools" &&
                    Boolean(startupProgress.totalPools) && (
                      <span aria-live="off">
                        {` · ${count(startupProgress.checkedPools || 0)} of ${count(startupProgress.totalPools)} verified`}
                      </span>
                    )}
                </p>
              )}
            {snapshot ? (
              <>
                {!serviceStarting &&
                  !error &&
                  status !== "offline" &&
                  collectionProgress && (
                    <p className="collection-progress-note" role="note">
                      {collectionProgressCopy(collectionProgress)}
                    </p>
                  )}
                <WorkspaceBoundary label="Data coverage">
                  <MarketCoverage
                    snapshot={snapshot}
                    initialNetwork={
                      view === "chains"
                        ? chainNetwork
                        : view === "overview"
                          ? filters.chain
                          : "all"
                    }
                    savedData={
                      serviceStarting || Boolean(error) || status === "offline"
                    }
                  />
                  {STATIC_EDITION ? (
                    // The census is an export with its own date, not a scan
                    // this page follows.
                    <EditionCensus snapshot={snapshot} />
                  ) : (
                    <PoolCoverage snapshot={snapshot} savedData={savedCoverage} />
                  )}
                </WorkspaceBoundary>
                <div className="methodology-stats">
                  <div>
                    <strong>
                      {count(snapshot.coverage.registryDeployments)}
                    </strong>
                    <span>registry deployments</span>
                  </div>
                  <div>
                    <strong>
                      {count(snapshot.coverage.totalObservedPools)}
                    </strong>
                    <span>pools in the market sample</span>
                  </div>
                  <div>
                    <strong>{count(snapshot.coverage.attributedPools)}</strong>
                    <span>sample pools linked to projects</span>
                  </div>
                </div>
                <details
                  className="source-diagnostics"
                  open={STATIC_EDITION ? true : undefined}
                >
                  <summary>
                    <span>Sources & methodology</span>
                    <span>{count(snapshot.sources.length)} sources</span>
                    <ChevronDown size={16} />
                  </summary>
                  <div className="source-list">
                    {snapshot.sources.map((source) => {
                      const displayStatus =
                        source.status === "live" &&
                        (serviceStarting ||
                          Boolean(error) ||
                          status === "offline")
                          ? "cached"
                          : source.status;
                      return (
                        <div key={source.id} className="source-item">
                          <div>
                            <strong>{source.name}</strong>
                            <span className={`tag source-tag ${displayStatus}`}>
                              {displayStatus === "live"
                                ? "Fetched"
                                : displayStatus === "cached"
                                  ? "Saved"
                                  : "Unavailable"}
                            </span>
                          </div>
                          <p>{source.note}</p>
                          <div className="source-meta">
                            <span>
                              {source.updatedAt
                                ? `Retrieved ${relativeTime(source.updatedAt)}`
                                : "No successful retrieval"}
                            </span>
                            {/* Edition: the census is Hook Radar's own index
                                of PoolManager events, not a page the link
                                could show, so it has no link. Each other
                                link names its source for a screen reader
                                that lists links (the visible text stays). */}
                            {STATIC_EDITION && source.id === "census" ? null : (
                              <External href={source.url}>
                                View source
                                {STATIC_EDITION && (
                                  <span className="sr-only">
                                    {` for ${source.name}`}
                                  </span>
                                )}
                              </External>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <dl className="methodology-list">
                    <div>
                      <dt>Project grouping</dt>
                      <dd>
                        Recognizable deployments are grouped by registry names
                        and explicit family rules. Names alone do not verify
                        common ownership. Generic contract-pattern names remain
                        separate; verify affiliation in deployment sources.
                      </dd>
                    </div>
                    <div>
                      <dt>Observed metrics</dt>
                      <dd>
                        USD volume and reported reserve values sum only the
                        available observed pools, with exact hook address
                        attribution where available. They are a sample, not
                        total ecosystem volume or TVL. Missing values stay
                        unavailable.
                      </dd>
                    </div>
                    <div>
                      <dt>Recorded history</dt>
                      <dd>
                        {STATIC_EDITION
                          ? "One point of tracked 24-hour volume is recorded for each successful collection run, from the pools measured in that run. Nothing is estimated or filled in."
                          : "A network-wide volume point is saved only when every contributing pool has a fresh measurement, so partial price coverage can leave that series empty. Nothing is estimated or filled in. Individual projects keep their own archived observations, listed in their details."}
                      </dd>
                    </div>
                    <div>
                      <dt>Categories & properties</dt>
                      <dd>
                        Categories are inferred from registry descriptions and
                        curated family rules. Callback permissions are decoded
                        from the deployment address; other properties come from
                        registry declarations. Verified source refers to source
                        availability, not an audit or security guarantee.
                      </dd>
                    </div>
                    <div>
                      <dt>Registry updates</dt>
                      <dd>
                        {STATIC_EDITION ? (
                          "This edition does not track registry changes."
                        ) : (
                          <>
                            New projects, deployments and metadata changes are
                            detected by comparing successful registry snapshots.
                            The first snapshot establishes the baseline.
                          </>
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>Watchlist & sharing</dt>
                      <dd>
                        Your watchlist is saved on this browser. Shared URLs
                        include filters and the selected project, but never your
                        watchlist. CSV and JSON exports contain the current
                        snapshot and its source metadata.
                      </dd>
                    </div>
                  </dl>
                </details>
                <p className="snapshot-time">
                  Snapshot generated:{" "}
                  {STATIC_EDITION
                    ? `${fullTimeLabel(snapshot.generatedAt)} · Times in this edition are UTC.`
                    : `${new Date(snapshot.generatedAt).toLocaleString()} · Times shown in ${Intl.DateTimeFormat().resolvedOptions().timeZone}.`}
                </p>
              </>
            ) : analyticsLite && overview.data ? (
              <DiscoverySources
                analytics
                data={{
                  sources: overview.data.sources,
                  inventory: overview.data.inventory || undefined,
                  publication: overview.data.publication,
                }}
              />
            ) : discoveryContext ? (
              <DiscoverySources data={discoveryContext.data} />
            ) : STATIC_EDITION ? (
              // Opened where no snapshot is loaded (the guide loads none): the
              // snapshot is on its way, or its failure is named here.
              error ? (
                <div className="notice error-notice" role="alert">
                  <Info size={17} />
                  <span>{error}</span>
                  <button
                    className="control"
                    onClick={() => void fetchSnapshot()}
                    disabled={loading}
                  >
                    Retry
                  </button>
                </div>
              ) : (
                <p role="status">Loading the snapshot to list its sources…</p>
              )
            ) : (
              <p>
                Source status becomes available when the first snapshot loads.
              </p>
            )}
          </div>
        </Modal>
      )}
      {modal === "share" && snapshot && (
        <Modal
          title={
            view === "compare" ||
            view === "activity" ||
            view === "analytics" ||
            view === "chains"
              ? "Share view"
              : "Share & export"
          }
          onClose={closeModal}
        >
          <div className="modal-body">
            <h2>Share this view</h2>
            <p className="intro-copy">
              {view === "compare"
                ? "Share these selected projects and their comparison."
                : view === "activity"
                  ? "Share the selected project, event window and pool filters. Event data can be exported from the activity report."
                  : view === "analytics"
                    ? "Share the selected network, volume window and history range. Export the measured dataset from the analytics view."
                    : view === "chains"
                      ? "Share this network, protocol category and search."
                      : "Share the current filters and project, or download CSV and JSON data."}
            </p>
            <label className="share-url">
              Current view
              <input
                readOnly
                value={shareLink}
                onFocus={(event) => event.target.select()}
              />
            </label>
            {["127.0.0.1", "localhost", "[::1]"].includes(
              location.hostname,
            ) && (
              <p className="local-share-note">
                Local address · available on this computer only.
              </p>
            )}
            <div className="export-actions">
              <button
                className="primary-button"
                onClick={() =>
                  void copy(
                    shareLink,
                    view === "compare"
                      ? "Comparison link copied."
                      : view === "activity"
                        ? "Activity link copied."
                        : "View link copied.",
                  )
                }
              >
                <Copy size={16} />
                Copy view link
              </button>
              {view !== "compare" &&
                view !== "activity" &&
                view !== "analytics" &&
                view !== "chains" && (
                  <>
                    <button
                      className="control"
                      disabled={exporting || serviceStarting}
                      onClick={() =>
                        snapshot.directory || snapshot.presentation
                          ? void serverDownload(
                              "/api/snapshot/export.json",
                              "hook-radar-snapshot.json",
                            )
                          : download(
                              JSON.stringify(
                                {
                                  ...snapshot,
                                  exportedView: {
                                    filters,
                                    window: windowKey,
                                    view,
                                    sort,
                                    projectIds: sorted.map(
                                      (project) => project.id,
                                    ),
                                    ...(STATIC_EDITION && view === "watchlist"
                                      ? {
                                          savedNotInSnapshot: {
                                            count: unavailableWatchIds.length,
                                            ids: unavailableWatchIds,
                                          },
                                        }
                                      : {}),
                                  },
                                },
                                null,
                                2,
                              ),
                              snapshotFileName(
                                "hook-radar-snapshot.json",
                                snapshot.generatedAt,
                              ),
                              "application/json",
                            )
                      }
                    >
                      <Download size={16} />
                      {/* The file is the whole snapshot whatever the view. */}
                      {STATIC_EDITION
                        ? "Download JSON (full snapshot)"
                        : "Download JSON"}
                    </button>
                    <button
                      className="control"
                      disabled={
                        exporting ||
                        serviceStarting ||
                        (useDirectory && !remote)
                      }
                      onClick={() => {
                        if (snapshot.directory) {
                          const params = directorySearch(
                            filters,
                            sort,
                            windowKey,
                            view === "watchlist" ? watchlist : undefined,
                          );
                          if (view === "watchlist") params.set("saved", "1");
                          void serverDownload(
                            `/api/directory/export.csv?${params}`,
                            "hook-radar-projects.csv",
                          );
                          return;
                        }
                        download(
                          projectCsv(
                            sorted,
                            snapshot.pools,
                            windowKey,
                            filters.chain,
                            // The edition's file carries the snapshot's time
                            // and what the rows cover, as the page does.
                            STATIC_EDITION
                              ? {
                                  snapshotAt: snapshot.generatedAt,
                                  scope: exportScope({
                                    list: listScopeLabel(view, filters.market),
                                    network:
                                      filters.chain === "all"
                                        ? "All networks"
                                        : chainName(filters.chain),
                                    notes: [
                                      watchlistScopeNote(view, filters.market),
                                      filtersNote(filters),
                                      view === "watchlist" &&
                                        unavailableWatchIds.length > 0 &&
                                        savedExportNote(
                                          unavailableWatchIds.length,
                                        ),
                                    ],
                                  }),
                                }
                              : undefined,
                          ),
                          snapshotFileName(
                            "hook-radar-projects.csv",
                            snapshot.generatedAt,
                          ),
                          "text/csv;charset=utf-8",
                        );
                      }}
                    >
                      <Download size={16} />
                      Download CSV
                    </button>
                  </>
                )}
            </div>
            {view !== "compare" &&
              view !== "activity" &&
              view !== "analytics" &&
              view !== "chains" && (
                <div className="notice">
                  <Info size={16} />
                  <span>
                    CSV contains {count(resultCount)}{" "}
                    {STATIC_EDITION
                      ? listNoun(filters.market, resultCount)
                      : filters.market === "all"
                        ? resultCount === 1
                          ? "entry"
                          : "entries"
                        : resultCount === 1
                          ? "project"
                          : "projects"}{" "}
                    in this view, across all pages
                    {STATIC_EDITION
                      ? ", each row with the snapshot time and its scope. "
                      : ". "}
                    {view === "watchlist"
                      ? "Watchlists stay local; the shared link opens these filters in the public index. "
                      : ""}{" "}
                    {STATIC_EDITION &&
                    view === "watchlist" &&
                    unavailableWatchIds.length > 0
                      ? `${savedExportNote(unavailableWatchIds.length)} `
                      : ""}
                    {STATIC_EDITION
                      ? EXPORT_FILES_NOTE
                      : "Blank metrics mean unavailable data. JSON includes source freshness and the observed pool sample."}
                  </span>
                </div>
              )}
          </div>
        </Modal>
      )}
      {modal === "shortcuts" && <ShortcutsDialog onClose={closeModal} />}
      {paletteOpen && (
        <CommandPalette
          view={view}
          projects={projects}
          networks={[
            ...new Set([
              ...deploymentChains,
              ...listingChains.map((chain) => chain.slug),
            ]),
          ].map((id) => ({ id, name: chainName(id) }))}
          canRefresh={
            !STATIC_EDITION &&
            view !== "activity" &&
            !(analyticsLite
              ? overview.loading
              : refreshing || loading || serviceStarting)
          }
          onClose={closePalette}
          onRun={runPaletteCommand}
        />
      )}
      <div
        className={`toast ${toast ? "visible" : ""}`}
        data-tone={toastTone}
        role="status"
        aria-live="polite"
      >
        {toastTone === "success" ? <Check size={16} /> : <Info size={16} />}
        {toast}
      </div>
    </>
  );
}

function Metric({
  label,
  value,
  note,
  icon,
  detail,
  scope,
}: {
  label: string;
  value: string;
  note: string;
  icon?: ReactNode;
  detail?: ReactNode;
  /** A scope qualifier that must stay visible next to the figure. */
  scope?: string;
}) {
  return (
    <article className="metric">
      <div className="metric-label">
        {label}
        {icon}
      </div>
      <strong className={`metric-value ${value.length > 8 ? "smaller" : ""}`}>
        {value}
      </strong>
      <p>{note}</p>
      {scope && <p className="metric-scope">{scope}</p>}
      {detail && <div className="metric-detail">{detail}</div>}
    </article>
  );
}
