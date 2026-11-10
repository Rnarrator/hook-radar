import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import type {
  ActivityReport,
  ActivitySwap,
  ActivityWindow,
} from "../../shared/activity";
import type { RadarProject, RadarSnapshot } from "../../shared/types";
import type { ActivitySelection } from "../navigation";
import {
  activityDate,
  activityChange,
  activityCsv,
  activityNumber,
  activityCount,
  activityPeak,
  activityBucketCoverage,
  activityIntervalSeconds,
  activityRawAmount,
  comparableActivityPeriods,
  eventFee,
  isActivityReport,
} from "../activity";
import type { ActivityBucketCoverage } from "../activity";
import {
  count,
  filterProjects,
  relativeTime,
  shortAddress,
  isSnapshot,
} from "../model";
import { isDirectoryPage } from "../directory";
import { ProtocolLogo } from "./ProtocolLogo";
import { Empty, External } from "./Primitives";
import {
  ArrowRight,
  Check,
  ChevronDown,
  Copy,
  Crosshair,
  Download,
  History,
  Info,
  RefreshCw,
  Search,
  X,
} from "./Icons";
import "./activity.css";

const WINDOWS: [ActivityWindow, string, string][] = [
  ["h1", "1H", "1 hour"],
  ["h24", "24H", "24 hours"],
  ["d7", "7D", "7 days"],
];
const WINDOW_PHRASE: Record<ActivityWindow, string> = {
  h1: "Last hour",
  h24: "Last 24 hours",
  d7: "Last 7 days",
};
const COVERAGE_LABEL: Record<ActivityBucketCoverage, string> = {
  verified: "Verified",
  partial: "Partial · lower bound",
  unscanned: "Not scanned yet",
};

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

function timeOnly(seconds: number) {
  return new Date(seconds * 1000).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function isoTime(seconds: number) {
  return new Date(seconds * 1000).toISOString();
}

/* ── Recently inspected projects: a per-viewer convenience only. ───────── */
const RECENT_KEY = "hook-radar-activity-recent-v1";
type RecentProject = { id: string; name: string };
function readRecent(): RecentProject[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(value)
      ? value
          .filter(
            (item): item is RecentProject =>
              !!item &&
              typeof item === "object" &&
              typeof item.id === "string" &&
              /^[a-z0-9][a-z0-9-]{0,99}$/.test(item.id) &&
              typeof item.name === "string" &&
              item.name.length > 0 &&
              item.name.length <= 300,
          )
          .slice(0, 5)
      : [];
  } catch {
    return [];
  }
}
function rememberRecent(project: RecentProject) {
  try {
    localStorage.setItem(
      RECENT_KEY,
      JSON.stringify(
        [project, ...readRecent().filter((item) => item.id !== project.id)].slice(
          0,
          5,
        ),
      ),
    );
  } catch {
    /* Storage can be unavailable; recents are optional. */
  }
}

export function ActivityExplorer({
  snapshot,
  projectId,
  onSelectProject,
  onOpenProject,
  scope,
  onScopeChange,
  disabled = false,
}: {
  snapshot: RadarSnapshot;
  projectId: string | null;
  onSelectProject: (id: string) => void;
  onOpenProject: (id: string) => void;
  scope: ActivitySelection;
  onScopeChange: (scope: ActivitySelection) => void;
  disabled?: boolean;
}) {
  const [project, setProject] = useState<RadarProject | null>(null);
  const [projectState, setProjectState] = useState<{
    id: string;
    status: "loading" | "ready" | "error";
  } | null>(null);
  const [projectRetry, setProjectRetry] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(!projectId);
  const [clipboardNotice, setClipboardNotice] = useState("");
  const [reportState, setReportState] = useState<{
    key: string;
    report: ActivityReport;
  } | null>(null);
  const [errorState, setErrorState] = useState<{
    key: string;
    error: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const [compareEnabled, setCompareEnabled] = useState(false);
  const [previousState, setPreviousState] = useState<{
    key: string;
    report?: ActivityReport;
    error?: string;
    loading: boolean;
  } | null>(null);
  const [previousRetry, setPreviousRetry] = useState(0);
  const [poolInput, setPoolInput] = useState(scope.poolId);
  const [poolError, setPoolError] = useState("");
  const [copied, setCopied] = useState("");
  const [inspected, setInspected] = useState<{
    key: string;
    index: number;
  } | null>(null);
  const [eventSelection, setEventSelection] = useState<{
    key: string;
    id: string;
  } | null>(null);
  const mounted = useRef(true);
  const pickerToggle = useRef<HTMLButtonElement>(null);
  const pickerFocusFrame = useRef<number | null>(null);
  const wide = useMediaQuery("(min-width: 70rem)");
  const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const key = JSON.stringify([
    projectId,
    scope.chain,
    scope.window,
    scope.poolId,
    scope.hookAddress,
  ]);
  const report = reportState?.key === key ? reportState.report : null;
  const error = errorState?.key === key ? errorState.error : "";
  const previousKey = `${key}:${report?.windowStart ?? ""}:${report?.comparisonScopeKey ?? ""}`;
  const previous = previousState?.key === previousKey ? previousState : null;
  const comparison =
    compareEnabled &&
    report &&
    !previous?.loading &&
    !previous?.error &&
    previous?.report &&
    comparableActivityPeriods(report, previous.report)
      ? previous.report
      : null;
  const local = snapshot.projects.find((p) => p.id === projectId);
  const chosen = project?.id === projectId ? project : local;
  const fullProject =
    project?.id === projectId ? project : snapshot.directory ? null : local;
  const projectStatus =
    projectState?.id === projectId ? projectState.status : "loading";
  const networkChoices =
    fullProject?.chains || snapshot.chains.map((chain) => chain.slug);
  const networkName = (chain: string) =>
    snapshot.chains.find((item) => item.slug === chain)?.name || chain;
  const unlistedNetwork =
    scope.chain !== "all" && !networkChoices.includes(scope.chain);
  // A hook address can be deployed on several networks. Selecting it while
  // browsing all networks retains that full address scope, not just one chain.
  const hookChoices = new Map<
    string,
    { name: string; address: string; chains: Set<string> }
  >();
  for (const deployment of fullProject?.deployments || []) {
    if (scope.chain !== "all" && deployment.chain !== scope.chain) continue;
    const address = deployment.address.toLowerCase();
    const previous = hookChoices.get(address);
    if (previous) previous.chains.add(deployment.chain);
    else
      hookChoices.set(address, {
        name: deployment.name,
        address,
        chains: new Set([deployment.chain]),
      });
  }
  const unlistedHook =
    !!fullProject && !!scope.hookAddress && !hookChoices.has(scope.hookAddress);
  const selectedHookName = scope.hookAddress
    ? hookChoices.get(scope.hookAddress)?.name
    : undefined;
  const scopeParts = [
    scope.chain === "all" ? "All networks" : networkName(scope.chain),
    scope.poolId
      ? `Pool ${shortAddress(scope.poolId)}`
      : scope.hookAddress
        ? `${selectedHookName || "Hook"} ${shortAddress(scope.hookAddress)}`
        : "All project hooks",
  ];
  const scopeLine = scopeParts.join(" · ");
  const chartIndex =
    inspected?.key === key && report
      ? Math.min(inspected.index, report.buckets.length - 1)
      : null;
  const selectedEventId =
    eventSelection?.key === key ? eventSelection.id : null;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (pickerFocusFrame.current !== null)
        cancelAnimationFrame(pickerFocusFrame.current);
    };
  }, []);
  const selectProject = (id: string) => {
    setPickerOpen(false);
    onSelectProject(id);
    if (pickerFocusFrame.current !== null)
      cancelAnimationFrame(pickerFocusFrame.current);
    pickerFocusFrame.current = requestAnimationFrame(() => {
      pickerFocusFrame.current = null;
      pickerToggle.current?.focus();
    });
  };
  const closePicker = () => {
    setPickerOpen(false);
    pickerToggle.current?.focus();
  };
  useEffect(() => {
    setPoolInput(scope.poolId);
    setPoolError("");
    setPickerOpen(!projectId);
  }, [scope.poolId, projectId]);
  useEffect(() => {
    if (report && report.projectId === projectId)
      rememberRecent({ id: report.projectId, name: report.projectName });
  }, [report?.projectId, report?.projectName, projectId]);
  useEffect(() => {
    if (!projectId || disabled) return;
    const controller = new AbortController();
    let active = true;
    setProjectState({ id: projectId, status: "loading" });
    const timer = setTimeout(() => controller.abort(), 30000);
    fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const value = await response.json();
        if (
          value.id !== projectId ||
          !isSnapshot({
            ...snapshot,
            presentation: undefined,
            directory: undefined,
            projects: [value],
          })
        )
          throw new Error();
        return value as RadarProject;
      })
      .then((value) => {
        if (active && !controller.signal.aborted) {
          setProject(value);
          setProjectState({ id: projectId, status: "ready" });
        }
      })
      .catch(() => {
        if (active) setProjectState({ id: projectId, status: "error" });
      })
      .finally(() => clearTimeout(timer));
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [projectId, disabled, projectRetry, retry]);
  useEffect(() => {
    if (!projectId || disabled) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    let poll: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    async function read() {
      if (document.hidden) {
        poll = setTimeout(() => void read(), 15000);
        return;
      }
      setLoading(true);
      setErrorState(null);
      deadline = setTimeout(() => controller.abort(), 75000);
      try {
        const params = new URLSearchParams({
          chain: scope.chain,
          window: scope.window,
        });
        if (scope.poolId) params.set("pool", scope.poolId);
        if (scope.hookAddress) params.set("hook", scope.hookAddress);
        const response = await fetch(
          `/api/projects/${encodeURIComponent(projectId!)}/activity?${params}`,
          { signal: controller.signal },
        );
        const value = await response.json();
        if (!response.ok)
          throw new Error(
            typeof value.error === "string"
              ? value.error
              : "Activity could not be loaded.",
          );
        if (
          !isActivityReport(value) ||
          value.projectId !== projectId ||
          value.window !== scope.window ||
          value.scope.poolId !== (scope.poolId || null) ||
          value.scope.hookAddress !== (scope.hookAddress || null) ||
          (scope.chain !== "all" &&
            value.networks.some((n) => n.chain !== scope.chain))
        )
          throw new Error(
            "Activity returned an invalid response for this selection. Please retry.",
          );
        if (!active) return;
        setReportState({ key, report: value });
        if (value.refreshing || value.status === "partial")
          poll = setTimeout(() => void read(), value.refreshing ? 5000 : 15000);
      } catch (cause) {
        if (active)
          setErrorState({
            key,
            error: controller.signal.aborted
              ? "The activity request took too long. Retry to resume its saved progress."
              : cause instanceof Error &&
                  !["TypeError", "SyntaxError"].includes(cause.name)
                ? cause.message
                : "Activity could not load. Check your connection and retry.",
          });
      } finally {
        clearTimeout(deadline);
        if (active) setLoading(false);
      }
    }
    void read();
    return () => {
      active = false;
      clearTimeout(poll);
      clearTimeout(deadline);
      controller.abort();
    };
  }, [key, retry, disabled]);

  useEffect(() => {
    if (
      !compareEnabled ||
      !projectId ||
      disabled ||
      !report?.comparisonScopeKey ||
      report?.status !== "complete"
    )
      return;
    const controller = new AbortController();
    let active = true;
    let poll: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const end = report.windowStart;
    async function readPrevious() {
      if (document.hidden) {
        poll = setTimeout(() => void readPrevious(), 15000);
        return;
      }
      setPreviousState((old) => ({
        key: previousKey,
        report: old?.key === previousKey ? old.report : undefined,
        loading: true,
      }));
      deadline = setTimeout(() => controller.abort(), 75000);
      try {
        const params = new URLSearchParams({
          chain: scope.chain,
          window: scope.window,
          before: String(end),
        });
        if (scope.poolId) params.set("pool", scope.poolId);
        if (scope.hookAddress) params.set("hook", scope.hookAddress);
        const response = await fetch(
          `/api/projects/${encodeURIComponent(projectId!)}/activity?${params}`,
          { signal: controller.signal },
        );
        const value = await response.json();
        if (!response.ok)
          throw new Error(
            typeof value.error === "string"
              ? value.error
              : "Previous period could not be loaded.",
          );
        if (
          !isActivityReport(value) ||
          value.requestedEnd !== end ||
          value.projectId !== projectId ||
          value.window !== scope.window ||
          value.scope.poolId !== (scope.poolId || null) ||
          value.scope.hookAddress !== (scope.hookAddress || null) ||
          (scope.chain !== "all" &&
            value.networks.some((n) => n.chain !== scope.chain))
        )
          throw new Error(
            "Previous period returned an invalid response. Retry to resume its scan.",
          );
        if (!active) return;
        setPreviousState({ key: previousKey, report: value, loading: false });
        if (value.refreshing || value.status === "partial")
          poll = setTimeout(
            () => void readPrevious(),
            value.refreshing ? 5000 : 15000,
          );
      } catch {
        if (active)
          setPreviousState((old) => ({
            key: previousKey,
            report: old?.key === previousKey ? old.report : undefined,
            loading: false,
            error:
              "Previous period is unavailable. Your current result is preserved; retry to resume saved progress.",
          }));
      } finally {
        clearTimeout(deadline);
      }
    }
    void readPrevious();
    return () => {
      active = false;
      clearTimeout(poll);
      clearTimeout(deadline);
      controller.abort();
    };
  }, [compareEnabled, previousKey, report?.status, disabled, previousRetry]);

  function patch(value: Partial<ActivitySelection>) {
    onScopeChange({ ...scope, ...value });
  }
  async function copyPool(poolId: string) {
    try {
      await navigator.clipboard.writeText(poolId);
      if (mounted.current) {
        setCopied(poolId);
        setClipboardNotice("Pool ID copied.");
        setTimeout(() => {
          if (mounted.current) setCopied("");
        }, 1800);
      }
    } catch {
      setClipboardNotice(
        "Copy is unavailable in this browser. Select the pool ID in event details to copy it.",
      );
    }
  }
  function exportReport(kind: "json" | "intervals" | "pools" = "json") {
    if (!report) return;
    const blob = new Blob(
      [
        kind === "json"
          ? JSON.stringify(
              { ...report, ...(comparison ? { comparison } : {}) },
              null,
              2,
            )
          : activityCsv(report, kind),
      ],
      {
        type: kind === "json" ? "application/json" : "text/csv;charset=utf-8",
      },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `hook-radar-${report.projectId}-${scope.chain}-${report.windowEnd}-${kind === "json" ? "activity.json" : `${kind}.csv`}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function scopeToPool(chain: string, poolId: string) {
    setPoolError("");
    patch({ chain, poolId, hookAddress: "" });
  }

  const coverage = report ? activityBucketCoverage(report) : [];
  const coverageCounts = {
    verified: coverage.filter((state) => state === "verified").length,
    partial: coverage.filter((state) => state === "partial").length,
    unscanned: coverage.filter((state) => state === "unscanned").length,
  };
  const statusLabel = report
    ? report.refreshing
      ? "Indexing recent blocks"
      : report.stale
        ? "Saved event data"
        : report.status === "complete"
          ? "Selected period indexed"
          : report.status === "unavailable"
            ? "Event source unavailable"
            : "Some blocks still need indexing"
    : "";

  return (
    <section className="activity-workspace" aria-label="Activity explorer">
      {!projectId ? (
        <div className="activity-start">
          <ActivityProjectPicker
            snapshot={snapshot}
            selectedId={null}
            onSelect={selectProject}
            label="Find a project to inspect"
            disabled={disabled}
            disabledMessage="Activity opens after saved history has been checked."
            intro
          />
          <aside className="activity-primer" aria-label="What Activity measures">
            <p className="kicker">What you will see</p>
            <ul>
              <li>
                <span className="activity-type-chip" data-type="swap">
                  Swap
                </span>
                <p>
                  Each trade in the project’s pools, with the exact token
                  amounts and a link to the transaction.
                </p>
              </li>
              <li>
                <span className="activity-type-chip" data-type="liquidity">
                  Liquidity
                </span>
                <p>
                  People adding or removing liquidity (and position updates that
                  move nothing). These are counts, not amounts of money moved.
                </p>
              </li>
              <li>
                <span className="activity-type-chip" data-type="fee">
                  Fee rate
                </span>
                <p>
                  The fee rate each trade paid. It is a rate, not the fees the
                  project has earned.
                </p>
              </li>
            </ul>
            <p className="activity-footnote">
              Counts come from Uniswap’s own onchain records. A transaction is
              not the same as a trader, and the fee rate is not revenue.
            </p>
          </aside>
        </div>
      ) : (
        <>
          <div className="activity-scope">
            <div className="activity-project-heading">
              <div className="activity-project-identity">
                {chosen && <ProtocolLogo project={chosen} />}
                <div>
                  <p className="kicker">Investigating</p>
                  <h2>
                    {chosen?.name || report?.projectName || "Loading project…"}
                  </h2>
                  <p className="activity-scope-line">
                    {scope.poolId
                      ? "Selected pool"
                      : scope.hookAddress
                        ? "Selected hook"
                        : "All project hooks"}{" "}
                    ·{" "}
                    {scope.chain === "all"
                      ? "All networks"
                      : networkName(scope.chain)}{" "}
                    · {WINDOW_PHRASE[scope.window]}
                  </p>
                </div>
              </div>
              <div className="activity-heading-actions">
                <button
                  className="control activity-picker-toggle"
                  ref={pickerToggle}
                  aria-expanded={pickerOpen}
                  aria-controls="activity-project-picker"
                  onClick={() => setPickerOpen((open) => !open)}
                >
                  <ChevronDown size={14} />
                  Change project
                </button>
                <button
                  className="control"
                  onClick={() => onOpenProject(projectId)}
                >
                  Project details <ArrowRight size={14} />
                </button>
              </div>
            </div>
            {pickerOpen && (
              <div
                id="activity-project-picker"
                className="activity-picker-popover"
                onKeyDown={(event) => {
                  if (event.key === "Escape" && !event.defaultPrevented) {
                    event.preventDefault();
                    closePicker();
                  }
                }}
              >
                <ActivityProjectPicker
                  snapshot={snapshot}
                  selectedId={projectId}
                  onSelect={selectProject}
                  label="Change activity project"
                  disabled={disabled}
                  disabledMessage="Activity opens after saved history has been checked."
                />
              </div>
            )}
            <div className="activity-controls">
              <div
                className="window-switch activity-window-switch"
                role="group"
                aria-label="Activity time window"
              >
                {WINDOWS.map(([value, short, label]) => (
                  <button
                    key={value}
                    className={scope.window === value ? "selected" : ""}
                    aria-pressed={scope.window === value}
                    onClick={() => patch({ window: value })}
                  >
                    <span aria-hidden="true">{short}</span>
                    <span className="sr-only">{label}</span>
                  </button>
                ))}
              </div>
              <label className="select-control activity-select">
                <span className="activity-select-label" aria-hidden="true">
                  Network
                </span>
                <span className="sr-only">Activity network</span>
                <select
                  value={scope.chain}
                  onChange={(e) => {
                    setPoolError("");
                    patch({
                      chain: e.target.value,
                      poolId: "",
                      hookAddress: "",
                    });
                  }}
                >
                  <option value="all">All project networks</option>
                  {unlistedNetwork && (
                    <option value={scope.chain}>
                      {networkName(scope.chain)} · not listed
                    </option>
                  )}
                  {networkChoices.map((chain) => (
                    <option key={chain} value={chain}>
                      {networkName(chain)}
                    </option>
                  ))}
                </select>
                <ChevronDown size={14} />
              </label>
              <label className="select-control activity-select activity-hook-select">
                <span className="activity-select-label" aria-hidden="true">
                  Hook
                </span>
                <span className="sr-only">Activity hook</span>
                <select
                  value={scope.hookAddress}
                  disabled={!fullProject || disabled}
                  aria-busy={!disabled && projectStatus === "loading"}
                  onChange={(e) =>
                    patch({ hookAddress: e.target.value, poolId: "" })
                  }
                >
                  {!fullProject ? (
                    <option value={scope.hookAddress}>
                      {scope.hookAddress
                        ? `Selected hook · ${shortAddress(scope.hookAddress)}`
                        : projectStatus === "error"
                          ? "Hook choices unavailable"
                          : "Loading project hooks…"}
                    </option>
                  ) : (
                    <option value="">All project hooks</option>
                  )}
                  {unlistedHook && (
                    <option value={scope.hookAddress}>
                      Selected hook · {shortAddress(scope.hookAddress)} · not
                      listed
                    </option>
                  )}
                  {[...hookChoices.values()].map((hook) => (
                    <option key={hook.address} value={hook.address}>
                      {hook.name} ·{" "}
                      {hook.chains.size > 1
                        ? `${hook.chains.size} networks`
                        : networkName([...hook.chains][0])}{" "}
                      · {shortAddress(hook.address)}
                    </option>
                  ))}
                </select>
                <ChevronDown size={14} />
              </label>
              <div className="activity-control-actions">
                <button
                  className="control"
                  disabled={loading || disabled}
                  onClick={() => setRetry((n) => n + 1)}
                >
                  <RefreshCw
                    size={14}
                    className={loading || report?.refreshing ? "spin" : ""}
                  />
                  {report?.refreshing ? "Indexing" : "Refresh"}
                </button>
                <button
                  className="control"
                  disabled={!report}
                  onClick={() => exportReport()}
                >
                  <Download size={14} />
                  Export report
                </button>
              </div>
            </div>
            <form
              className="activity-pool-form"
              onSubmit={(e) => {
                e.preventDefault();
                const pool = poolInput.trim();
                if (pool && !/^0x[a-f0-9]{64}$/i.test(pool)) {
                  setPoolError(
                    "Enter a 32-byte pool ID: 0x followed by 64 hexadecimal characters.",
                  );
                  return;
                }
                if (pool && scope.chain === "all") {
                  setPoolError("Choose the pool’s network first.");
                  return;
                }
                setPoolError("");
                patch({ poolId: pool.toLowerCase() });
              }}
            >
              <label htmlFor="activity-pool">Inspect a specific pool</label>
              <div>
                <span
                  className={`field activity-pool-field${scope.poolId ? " is-scoped" : ""}`}
                >
                  <input
                    id="activity-pool"
                    value={poolInput}
                    onChange={(e) => setPoolInput(e.target.value)}
                    placeholder="0x… 32-byte pool ID"
                    maxLength={66}
                    spellCheck={false}
                    autoComplete="off"
                    aria-invalid={Boolean(poolError)}
                    aria-describedby={
                      poolError ? "activity-pool-error" : "activity-pool-hint"
                    }
                  />
                  {scope.poolId && (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="Clear activity pool filter"
                      onClick={() => patch({ poolId: "" })}
                    >
                      <X size={14} />
                    </button>
                  )}
                </span>
                <button className="control" type="submit">
                  Apply
                </button>
              </div>
              {poolError ? (
                <p id="activity-pool-error" role="alert">
                  {poolError}
                </p>
              ) : (
                <p id="activity-pool-hint" className="activity-pool-hint">
                  {scope.poolId
                    ? `Scoped to one pool on ${networkName(scope.chain)}.`
                    : "Pick a network first, or choose a pool from the tables below."}
                </p>
              )}
            </form>
          </div>
          {fullProject && (unlistedNetwork || unlistedHook) && (
            <p className="activity-coverage-note" role="status">
              <Info size={14} />
              {unlistedNetwork
                ? `This project has no listed hooks on ${networkName(scope.chain)}. Choose a listed network or all project networks.`
                : "The selected hook is not listed for this project and network. Choose a listed hook or all project hooks."}
            </p>
          )}
          {!disabled && projectStatus === "loading" && (
            <p className="activity-coverage-note is-quiet" role="status">
              <RefreshCw className="spin" size={14} />
              {fullProject
                ? "Updating project details…"
                : "Loading all project hooks…"}
            </p>
          )}
          {!disabled && projectStatus === "error" && (
            <div className="notice error-notice" role="alert">
              <Info size={17} />
              <span>
                {fullProject
                  ? "Project details could not be refreshed. Keeping the last loaded hook choices."
                  : "Project details could not be loaded. Retry to load all hook choices."}
              </span>
              <button onClick={() => setProjectRetry((n) => n + 1)}>
                Retry project details
              </button>
            </div>
          )}
          {clipboardNotice && (
            <p className="activity-clipboard-status" role="status">
              {clipboardNotice}
            </p>
          )}
          {error && (
            <div className="notice error-notice" role="alert">
              <Info size={17} />
              <span>
                {error}
                {report
                  ? " Retaining the last successful result for this selection."
                  : ""}
              </span>
              <button onClick={() => setRetry((n) => n + 1)}>Retry</button>
            </div>
          )}
          {disabled ? (
            <Empty title="Checking saved history">
              Activity opens when the canonical pool inventory is ready.
            </Empty>
          ) : !report && !error ? (
            <ActivityLoading window={scope.window} />
          ) : !report ? (
            <div className="activity-error-frame">
              <p>
                No activity is shown for this selection because the request
                did not return a valid report. Nothing has been inferred.
              </p>
            </div>
          ) : (
            <>
              <div className="activity-statusbar">
                <div
                  className={`activity-status ${report.status}${report.stale ? " stale" : ""}${report.refreshing ? " refreshing" : ""}`}
                  role="status"
                >
                  <span
                    className={`status-led ${report.status === "complete" && !report.stale ? "green" : "amber"}`}
                  />
                  <strong>{statusLabel}</strong>
                  <small>Checked {relativeTime(report.generatedAt)}</small>
                  <span>
                    {activityDate(report.windowStart)} –{" "}
                    {activityDate(report.windowEnd)}
                  </span>
                </div>
                <div className="activity-status-meta">
                  <ActivityCoverageMeter
                    coverage={coverage}
                    counts={coverageCounts}
                    refreshing={report.refreshing}
                  />
                  <p className="activity-timezone">
                    Your local time ({localTimeZone})
                  </p>
                </div>
              </div>
              {report.stale && !report.refreshing && (
                <p className="activity-stale-note">
                  <Info size={14} />
                  Saved result: the covered period ends{" "}
                  {relativeTime(isoTime(report.windowEnd)).toLowerCase()}.
                  Newer blocks are not included; refresh to check again.
                </p>
              )}
              {(report.warning || report.status !== "complete") && (
                <p className="activity-coverage-note">
                  <Info size={14} />
                  {report.warning ||
                    (report.status === "unavailable"
                      ? "The public event source is unavailable. Retry to resume the scan. No activity has been inferred."
                      : "Partial counts are lower bounds. A dash means the scan has not established a count, not that no activity occurred.")}
                </p>
              )}
              <section
                className="activity-readouts plate"
                aria-label="Event counts"
              >
                <div className="activity-readouts-head">
                  <div className="plate-caption">
                    <h3>Event counts</h3>
                    <span className="scope">
                      {scopeLine} · {WINDOW_PHRASE[report.window]} ·{" "}
                      {report.totals
                        ? "exact for the indexed period"
                        : "lower bounds while indexing"}
                    </span>
                  </div>
                  <div className="activity-compare-control">
                    <button
                      className={`control ${compareEnabled ? "selected" : ""}`}
                      aria-pressed={compareEnabled}
                      onClick={() => setCompareEnabled((value) => !value)}
                    >
                      {compareEnabled && <Check size={14} />} Compare previous
                      period
                    </button>
                    <span>
                      {compareEnabled
                        ? "Same scope. Equal periods. Verified events."
                        : "See what changed without changing your selection."}
                    </span>
                  </div>
                </div>
                {compareEnabled && (
                  <div className="activity-comparison-status" role="status">
                    {report.status !== "complete" ? (
                      "The current period needs complete coverage before comparison can begin."
                    ) : !report.comparisonScopeKey ? (
                      "This report does not have a verified comparison scope. Current event counts remain available."
                    ) : comparison ? (
                      <>
                        Compared with {activityDate(comparison.windowStart)} –{" "}
                        {activityDate(comparison.windowEnd)}.
                      </>
                    ) : previous?.error ? (
                      <>
                        {previous.error}{" "}
                        <button
                          className="text-button"
                          onClick={() => setPreviousRetry((n) => n + 1)}
                        >
                          Retry previous period
                        </button>
                      </>
                    ) : previous?.report?.status === "complete" &&
                      !previous.loading ? (
                      "The periods do not share an equal, adjacent window and verified scope. No trend is inferred."
                    ) : previous?.report?.status === "unavailable" ? (
                      <>
                        The previous event source is unavailable. Current
                        results are preserved.{" "}
                        <button
                          className="text-button"
                          onClick={() => setPreviousRetry((n) => n + 1)}
                        >
                          Retry previous period
                        </button>
                      </>
                    ) : (
                      <>
                        <RefreshCw className="spin" size={12} /> Indexing the
                        preceding{" "}
                        {scope.window === "h1"
                          ? "hour"
                          : scope.window === "h24"
                            ? "24 hours"
                            : "7 days"}
                        …{" "}
                        {previous?.report
                          ? `${count(previous.report.observed.swaps)} swaps verified so far.`
                          : "Current results remain available."}
                      </>
                    )}
                  </div>
                )}
                <div className="activity-metrics">
                  {(
                    [
                      [
                        "PoolManager swaps",
                        "swaps",
                        "Recorded Swap events. A transaction can contain several swaps.",
                        "Swap events, not distinct trades.",
                      ],
                      [
                        "Activity transactions",
                        "transactions",
                        "Distinct transaction hashes containing matching swaps or liquidity changes. These are not unique traders.",
                        "Distinct transactions, not traders.",
                      ],
                      [
                        "Pools with swaps",
                        "activePools",
                        "Distinct pools with at least one matching Swap event.",
                        report.scope.totalPools === null ||
                        !report.scope.inventoryComplete
                          ? "Pools with at least one swap."
                          : `Of ${activityCount(report.scope.totalPools, true, "pool")} in the verified scope.`,
                      ],
                      [
                        "LP position updates",
                        "liquidityChanges",
                        "ModifyLiquidity events, including adds, removals and zero-delta pokes. Some custom hooks manage liquidity separately.",
                        "Adds, removals and zero-delta pokes.",
                      ],
                    ] as const
                  ).map(([label, metric, note, definition]) => {
                    const exact = report.totals?.[metric] ?? null;
                    const observed = report.observed[metric];
                    return (
                      <div
                        key={metric}
                        className="readout"
                        data-state={
                          exact !== null
                            ? "exact"
                            : observed > 0
                              ? "lower"
                              : "unknown"
                        }
                      >
                        <span className="readout-label" title={note}>
                          {label}
                          <Info size={12} />
                        </span>
                        <strong className="readout-value">
                          {activityNumber(exact, observed)}
                        </strong>
                        <small>
                          {comparison && report.totals && comparison.totals ? (
                            <span
                              className={`activity-delta ${report.totals[metric] === comparison.totals[metric] ? "unchanged" : "changed"}`}
                            >
                              {
                                activityChange(
                                  report.totals[metric],
                                  comparison.totals[metric],
                                ).label
                              }{" "}
                              <em>vs previous period</em>
                            </span>
                          ) : report.totals ? (
                            "In the selected period"
                          ) : observed > 0 ? (
                            "At least · indexed events"
                          ) : (
                            "Awaiting complete coverage"
                          )}
                        </small>
                        <p className="readout-definition">{definition}</p>
                      </div>
                    );
                  })}
                </div>
              </section>
              <div className="activity-investigation">
                <ActivityTimeline
                  report={report}
                  previous={comparison}
                  coverage={coverage}
                  scopeLine={scopeLine}
                  timeZone={localTimeZone}
                  selected={chartIndex}
                  onSelect={(index) =>
                    setInspected(index === null ? null : { key, index })
                  }
                  eventTimestamp={
                    (
                      report.latestSwaps.find((s) => s.id === selectedEventId) ??
                      (wide ? report.latestSwaps[0] : undefined)
                    )?.timestamp ?? null
                  }
                  onExport={() => exportReport("intervals")}
                />
                <div className="activity-context">
                  <ActivityEventDetails report={report} />
                </div>
              </div>
              <ActivityEventLog
                report={report}
                networkName={networkName}
                selectedId={selectedEventId}
                onSelect={(id) => setEventSelection({ key, id })}
                interval={
                  chartIndex !== null && report.buckets[chartIndex]
                    ? {
                        start: report.buckets[chartIndex].timestamp,
                        end:
                          report.buckets[chartIndex].timestamp +
                          activityIntervalSeconds(report.window),
                      }
                    : null
                }
                wide={wide}
                scopedPool={scope.poolId}
                onScopePool={scopeToPool}
                copied={copied}
                onCopyPool={(id) => void copyPool(id)}
              />
              <section className="panel activity-pools">
                <div className="panel-heading">
                  <div>
                    <h3>Pools in this period</h3>
                    <p>
                      {report.pools.length
                        ? `${activityCount(report.pools.length, true, "pool")} shown, ranked by recorded swaps.${report.status === "complete" ? "" : " Counts are lower bounds while indexing continues."}`
                        : "Pools appear when matching events are found."}
                    </p>
                  </div>
                  <button
                    className="control"
                    onClick={() => exportReport("pools")}
                    disabled={!report.pools.length}
                  >
                    <Download size={14} /> Pools CSV
                  </button>
                </div>
                {report.pools.length ? (
                  <div
                    className="activity-table-scroll"
                    tabIndex={0}
                    role="region"
                    aria-label="Active pool data"
                  >
                    <table>
                      <thead>
                        <tr>
                          <th>Pool / network</th>
                          <th className="num">Swaps</th>
                          <th className="num">Transactions</th>
                          <th className="num">LP updates</th>
                          <th className="num">Event fee</th>
                          <th>Last swap</th>
                          <th>
                            <span className="sr-only">Inspect</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.pools.map((p) => (
                          <tr
                            key={`${p.chain}:${p.poolId}`}
                            className={
                              scope.poolId === p.poolId ? "is-scoped" : ""
                            }
                          >
                            <td>
                              <button
                                className="activity-pool-link"
                                title={`Inspect activity for pool ${p.poolId}`}
                                onClick={() => scopeToPool(p.chain, p.poolId)}
                              >
                                {p.name || shortAddress(p.poolId)}
                              </button>
                              <small>
                                {networkName(p.chain)} ·{" "}
                                <code>{shortAddress(p.poolId)}</code>
                              </small>
                            </td>
                            <td className="num">
                              {activityNumber(
                                report.status === "complete" ? p.swaps : null,
                                p.swaps,
                              )}
                            </td>
                            <td className="num">
                              {activityNumber(
                                report.status === "complete"
                                  ? p.transactions
                                  : null,
                                p.transactions,
                              )}
                            </td>
                            <td
                              className="num"
                              title={
                                p.liquidityAdds == null
                                  ? "Detailed split not retained in this saved report"
                                  : `${activityCount(p.liquidityAdds, report.status === "complete", "add")} · ${activityCount(p.liquidityRemoves, report.status === "complete", "removal")} · ${activityCount(p.liquidityPokes, report.status === "complete", "zero-delta poke")}`
                              }
                            >
                              {activityNumber(
                                report.status === "complete"
                                  ? p.liquidityChanges
                                  : null,
                                p.liquidityChanges,
                              )}
                            </td>
                            <td className="num">
                              {p.minFeePips === null
                                ? "—"
                                : p.minFeePips === p.maxFeePips
                                  ? eventFee(p.minFeePips)
                                  : `${eventFee(p.minFeePips)}–${eventFee(p.maxFeePips!)}`}
                            </td>
                            <td>
                              {p.lastSwapAt
                                ? activityDate(p.lastSwapAt)
                                : "—"}
                            </td>
                            <td>
                              <button
                                className="icon-button"
                                aria-label={`${copied === p.poolId ? "Copied" : "Copy"} pool ID ${p.poolId}`}
                                title={
                                  copied === p.poolId
                                    ? "Pool ID copied"
                                    : "Copy pool ID"
                                }
                                onClick={() => void copyPool(p.poolId)}
                              >
                                {copied === p.poolId ? (
                                  <Check size={14} />
                                ) : (
                                  <Copy size={14} />
                                )}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Empty
                    title={
                      report.status === "complete"
                        ? "No matching pool events"
                        : "No matching events indexed yet"
                    }
                  >
                    {report.status === "complete"
                      ? "This is a measured zero for the selected scope and covered period."
                      : "The source coverage below explains which blocks have been checked."}
                  </Empty>
                )}
              </section>
              <details className="activity-methodology panel">
                <summary>
                  Coverage & methodology <Info size={14} />
                  <span>
                    {
                      report.networks.filter((n) => n.status === "complete")
                        .length
                    }
                    /{report.networks.length}{" "}
                    {report.networks.length === 1 ? "network" : "networks"}{" "}
                    indexed
                  </span>
                </summary>
                <div className="activity-methodology-body">
                  <p>
                    Counts cover canonical PoolManager events for the selected
                    hooks and period. Hook return deltas and external trading
                    can change the economic meaning of a swap. Event fees are
                    not earned fee revenue, and callers are not trader
                    identities.
                  </p>
                  <div
                    className="activity-table-scroll"
                    tabIndex={0}
                    role="region"
                    aria-label="Activity source coverage"
                  >
                    <table>
                      <thead>
                        <tr>
                          <th>Network</th>
                          <th>Blocks indexed</th>
                          <th>State</th>
                          <th>Source</th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.networks.map((n) => {
                          const span =
                            n.fromBlock !== null &&
                            n.toBlock !== null &&
                            n.scannedToBlock !== null &&
                            n.toBlock > n.fromBlock
                              ? Math.max(
                                  0,
                                  Math.min(
                                    1,
                                    (n.scannedToBlock - n.fromBlock) /
                                      (n.toBlock - n.fromBlock),
                                  ),
                                )
                              : null;
                          return (
                            <tr key={n.chain}>
                              <td>
                                {n.name}
                                <small>{n.finality}</small>
                              </td>
                              <td>
                                {n.fromBlock === null ||
                                n.scannedToBlock === null
                                  ? "Not scanned yet"
                                  : `${count(n.fromBlock)}–${count(n.scannedToBlock)}`}
                                <small>
                                  {n.toBlock === null
                                    ? "Target pending"
                                    : `Target ${count(n.toBlock)}`}
                                  {span !== null &&
                                    ` · ${Math.floor(span * 100)}% of target range`}
                                </small>
                                {span !== null && (
                                  <span
                                    className="activity-network-progress"
                                    aria-hidden="true"
                                  >
                                    <i style={{ width: `${span * 100}%` }} />
                                  </span>
                                )}
                              </td>
                              <td>
                                <span
                                  className="activity-network-state"
                                  data-state={n.status}
                                >
                                  {n.status}
                                </span>
                                <small>{n.note}</small>
                              </td>
                              <td>
                                <External href={n.sourceUrl}>
                                  Event source
                                </External>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <p>
                    Inventory:{" "}
                    {report.scope.totalPools === null
                      ? "count pending"
                      : activityCount(report.scope.totalPools, true, "pool")}{" "}
                    ·{" "}
                    {report.scope.inventoryComplete
                      ? "verified project scope"
                      : "inventory scope still being checked"}
                    .{" "}
                    {report.scope.poolId
                      ? "This report is restricted to one pool."
                      : "Project-wide activity is matched to canonical hook ownership."}
                  </p>
                  {report.methodology.notes.map((note, i) => (
                    <p key={i}>{note}</p>
                  ))}
                  <External href={report.methodology.eventSource}>
                    PoolManager event specification
                  </External>
                </div>
              </details>
            </>
          )}
        </>
      )}
    </section>
  );
}

/* ── Project picker: search first, ranked entry points from real data. ── */
type PickerPage = {
  key: string;
  projects: RadarProject[];
  total: number;
  nextOffset: number | null;
};

function ActivityProjectPicker({
  snapshot,
  selectedId,
  onSelect,
  label,
  disabled,
  disabledMessage,
  intro = false,
}: {
  snapshot: RadarSnapshot;
  selectedId: string | null;
  onSelect: (id: string) => void;
  label: string;
  disabled: boolean;
  disabledMessage: string;
  intro?: boolean;
}) {
  const id = useId();
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<PickerPage | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const [recent] = useState(readRecent);
  const list = useRef<HTMLUListElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const query = search.trim();
  const remote = Boolean(snapshot.directory);
  const leaders = !query;
  const pageKey = `${leaders ? "leaders" : "search"}:${query}:${snapshot.generatedAt}`;
  const local = useMemo(
    () =>
      leaders
        ? snapshot.projects
            .filter((p) => (p.metrics.volumeUsd.h24 ?? 0) > 0)
            .sort(
              (a, b) =>
                (b.metrics.volumeUsd.h24 ?? 0) -
                  (a.metrics.volumeUsd.h24 ?? 0) || a.name.localeCompare(b.name),
            )
            .slice(0, 6)
        : filterProjects(snapshot.projects, {
            search: query,
            chain: "all",
            category: "all",
            property: "all",
            market: "all",
          }).sort((a, b) => a.name.localeCompare(b.name)),
    [snapshot.projects, query, leaders],
  );
  const shown = remote
    ? page?.key === pageKey
      ? page.projects
      : []
    : leaders
      ? local
      : local.slice(0, 8 + offset);
  const total = remote
    ? page?.key === pageKey
      ? page.total
      : null
    : local.length;
  const next = remote
    ? page?.key === pageKey
      ? page.nextOffset
      : null
    : !leaders && local.length > shown.length
      ? offset + 8
      : null;

  useEffect(() => {
    if (!remote || disabled) {
      setLoading(false);
      return;
    }
    if (offset > 0 && page?.key !== pageKey) {
      // A new query or publication restarts from the first page so a page
      // from one directory order is never appended to another.
      setOffset(0);
      return;
    }
    const controller = new AbortController();
    let disposed = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    setError("");
    setLoading(true);
    const delay = setTimeout(
      () => {
        deadline = setTimeout(() => controller.abort(), 30000);
        void (async () => {
          try {
            const limit = leaders ? 6 : 8;
            const params = new URLSearchParams(
              leaders
                ? {
                    search: "",
                    market: "active",
                    sort: "volume",
                    direction: "desc",
                    window: "h24",
                    limit: String(limit),
                    offset: "0",
                  }
                : {
                    search: query,
                    market: "all",
                    sort: "name",
                    direction: "asc",
                    limit: String(limit),
                    offset: String(offset),
                  },
            );
            const response = await fetch(`/api/directory?${params}`, {
              signal: controller.signal,
            });
            if (!response.ok)
              throw new Error(
                response.status === 429
                  ? "Too many searches. Try again shortly."
                  : "Projects could not load. Please retry.",
              );
            const value: unknown = await response.json();
            if (
              !isDirectoryPage(value, snapshot) ||
              value.offset !== (leaders ? 0 : offset) ||
              value.projects.length > limit
            )
              throw new Error(
                "The directory returned an unsupported response. Please retry.",
              );
            if (disposed || controller.signal.aborted) return;
            setPage((old) => ({
              key: pageKey,
              total: value.total,
              nextOffset: leaders ? null : value.nextOffset,
              projects:
                !leaders && offset > 0 && old?.key === pageKey
                  ? [
                      ...new Map(
                        [...old.projects, ...value.projects].map((project) => [
                          project.id,
                          project,
                        ]),
                      ).values(),
                    ]
                  : value.projects,
            }));
          } catch (cause) {
            if (!disposed)
              setError(
                controller.signal.aborted
                  ? "Project search took too long. Please retry."
                  : cause instanceof Error &&
                      !["TypeError", "SyntaxError"].includes(cause.name)
                    ? cause.message
                    : "Projects could not load. Check your connection and retry.",
              );
          } finally {
            clearTimeout(deadline);
            if (!disposed) setLoading(false);
          }
        })();
      },
      leaders ? 0 : 200,
    );
    return () => {
      disposed = true;
      clearTimeout(delay);
      clearTimeout(deadline);
      controller.abort();
    };
  }, [remote, pageKey, offset, retry, disabled]);

  const focusResult = (index: number) => {
    const buttons = list.current?.querySelectorAll<HTMLButtonElement>(
      "button.activity-picker-action:not(:disabled)",
    );
    if (!buttons?.length) return;
    buttons[Math.max(0, Math.min(buttons.length - 1, index))]?.focus();
  };
  const onListKey = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    const buttons = [
      ...(list.current?.querySelectorAll<HTMLButtonElement>(
        "button.activity-picker-action:not(:disabled)",
      ) ?? []),
    ];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusResult(at + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (at === 0) input.current?.focus();
      else focusResult(at - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusResult(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusResult(buttons.length - 1);
    }
  };
  // Recents never repeat a project already listed, so every action name is unique.
  const visibleRecent = recent.filter(
    (item) =>
      item.id !== selectedId && !shown.some((project) => project.id === item.id),
  );
  const statusText = disabled
    ? disabledMessage
    : error
      ? error
      : loading
        ? leaders
          ? "Loading the busiest projects…"
          : "Searching the full directory…"
        : leaders
          ? shown.length
            ? `${count(shown.length)} ${shown.length === 1 ? "project" : "projects"} with the highest tracked 24H hook-pool volume. Type to search every project.`
            : "Type a project name, purpose or hook address."
          : shown.length
            ? `${count(shown.length)} ${shown.length === 1 ? "project" : "projects"} shown of ${count(total ?? shown.length)} matching ${total === 1 ? "project" : "projects"}.`
            : "No projects match. Try a project name or exact hook address.";

  return (
    <section
      className={`activity-picker${intro ? " is-intro" : ""}`}
      aria-labelledby={`${id}-label`}
    >
      {intro && (
        <div className="activity-picker-intro">
          <p className="kicker">See a hook at work</p>
          <h2>Pick a project to see what it is doing.</h2>
          <p>
            Search for a hook project by name, purpose or contract address.
            You will see its recent swaps, liquidity changes and fees, and
            exactly how far back we have checked.
          </p>
        </div>
      )}
      <div className="activity-picker-field">
        <label
          htmlFor={`${id}-search`}
          id={`${id}-label`}
          className="activity-picker-label"
        >
          {label}
        </label>
        <div className="search-box activity-picker-search">
          <Search size={18} />
          <input
            id={`${id}-search`}
            ref={input}
            value={search}
            maxLength={300}
            disabled={disabled}
            placeholder="Search a name, purpose or hook address"
            autoComplete="off"
            spellCheck={false}
            aria-describedby={`${id}-status`}
            aria-controls={disabled ? undefined : `${id}-results`}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                focusResult(0);
              } else if (event.key === "Escape" && search) {
                event.preventDefault();
                setSearch("");
                setPage(null);
                setOffset(0);
              }
            }}
            onChange={(event) => {
              if (event.target.value.trim() !== query) {
                setError("");
                setOffset(0);
              }
              setSearch(event.target.value);
            }}
          />
          {search && (
            <button
              type="button"
              className="clear-search"
              aria-label="Clear project search"
              onClick={() => {
                setSearch("");
                setError("");
                setOffset(0);
                input.current?.focus();
              }}
            >
              <X size={14} />
            </button>
          )}
        </div>
        <p
          id={`${id}-status`}
          className={`activity-picker-status${error ? " is-error" : ""}`}
          role="status"
        >
          {statusText}
        </p>
        {!disabled && error && (
          <button
            type="button"
            className="control"
            onClick={() => setRetry((value) => value + 1)}
          >
            <RefreshCw size={14} /> Retry project search
          </button>
        )}
      </div>
      {!disabled && (
        <div className={`activity-picker-body${leaders ? " is-leaders" : ""}`}>
          {leaders && visibleRecent.length > 0 && (
            <div className="activity-picker-group activity-picker-recent">
              <h3 className="kicker">
                <History size={13} /> Recently inspected here
              </h3>
              <ul>
                {visibleRecent.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="activity-recent-action"
                      aria-label={`View activity ${item.name}`}
                      onClick={() => onSelect(item.id)}
                    >
                      <span>{item.name}</span>
                      <ArrowRight size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="activity-picker-group activity-picker-main">
            {leaders && (
              <div className="activity-picker-group-head">
                <h3 className="kicker">
                  Highest tracked 24H hook-pool volume
                </h3>
                <p>
                  Projects with recent tracked trading · Partial coverage · Not
                  total Uniswap volume
                </p>
              </div>
            )}
            <ul
              id={`${id}-results`}
              ref={list}
              className={`activity-picker-results${leaders ? " is-ranked" : ""}`}
              aria-busy={loading}
              aria-label={leaders ? "Projects by tracked 24H volume" : "Matching projects"}
              onKeyDown={onListKey}
            >
              {loading && !shown.length
                ? Array.from({ length: leaders ? 6 : 4 }, (_, i) => (
                    <li key={i} className="activity-picker-skeleton" aria-hidden="true">
                      <span className="skeleton" />
                      <span className="skeleton" />
                    </li>
                  ))
                : shown.map((project, index) => {
                    const current = project.id === selectedId;
                    return (
                      <li key={project.id} className={current ? "is-current" : ""}>
                        {leaders && (
                          <span className="activity-picker-rank" aria-hidden="true">
                            {String(index + 1).padStart(2, "0")}
                          </span>
                        )}
                        <ProtocolLogo project={project} />
                        <div className="activity-picker-name">
                          <strong>{project.name}</strong>
                          <span>
                            <span
                              className="category-tag"
                              data-category={project.category}
                            >
                              {project.category}
                            </span>
                            {count(project.chains.length)}{" "}
                            {project.chains.length === 1 ? "network" : "networks"}
                            {project.entityType === "platform" && " · Platform"}
                          </span>
                        </div>
                        <button
                          type="button"
                          className="activity-picker-action"
                          disabled={current}
                          aria-label={
                            current
                              ? `${project.name} selected`
                              : `View activity ${project.name}`
                          }
                          onClick={() => onSelect(project.id)}
                        >
                          {current ? "Viewing" : "View activity"}
                          {!current && <ArrowRight size={13} />}
                        </button>
                      </li>
                    );
                  })}
            </ul>
            {leaders && !loading && !error && !shown.length && (
              <p className="activity-picker-empty">
                No project has a current tracked 24H hook-pool volume
                measurement right now, so no ranking is shown. Search by name
                or hook address instead.
              </p>
            )}
            {next !== null && !leaders && (
              <button
                type="button"
                className="control activity-picker-more"
                disabled={loading}
                onClick={() => setOffset(next)}
              >
                {loading ? "Loading…" : "Show more projects"}
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function ActivityLoading({ window: span }: { window: ActivityWindow }) {
  const bars = span === "h1" ? 12 : span === "h24" ? 24 : 42;
  return (
    <div className="activity-loading" role="status">
      <div className="activity-loading-head">
        <RefreshCw className="spin" size={16} />
        <div>
          <strong>Reading onchain activity…</strong>
          <p>
            The first request scans recent blocks. Results are cached and
            retain their exact covered period.
          </p>
        </div>
      </div>
      <div className="activity-skeleton" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </div>
      <div className="activity-skeleton-chart" aria-hidden="true">
        {Array.from({ length: bars }, (_, i) => (
          <span key={i} />
        ))}
      </div>
    </div>
  );
}

function ActivityCoverageMeter({
  coverage,
  counts,
  refreshing,
}: {
  coverage: ActivityBucketCoverage[];
  counts: Record<ActivityBucketCoverage, number>;
  refreshing: boolean;
}) {
  if (!coverage.length) return null;
  const parts: string[] = [];
  if (counts.verified)
    parts.push(`${count(counts.verified)} verified`);
  if (counts.partial) parts.push(`${count(counts.partial)} partial`);
  if (counts.unscanned)
    parts.push(`${count(counts.unscanned)} not scanned`);
  return (
    <div className="activity-coverage-meter">
      <span className="activity-coverage-meter-bar" aria-hidden="true">
        {(["verified", "partial", "unscanned"] as const).map((state) =>
          counts[state] ? (
            <i
              key={state}
              data-coverage={state}
              style={{ flexGrow: counts[state] }}
            />
          ) : null,
        )}
      </span>
      <small>
        {coverage.length} intervals: {parts.join(" · ")}
        {refreshing ? " · updating automatically" : ""}
      </small>
    </div>
  );
}

function niceMax(value: number) {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 4, 5, 10]) if (step * power >= value) return step * power;
  return 10 * power;
}

function ActivityTimeline({
  report,
  previous,
  coverage,
  scopeLine,
  timeZone,
  selected,
  onSelect,
  eventTimestamp,
  onExport,
}: {
  report: ActivityReport;
  previous: ActivityReport | null;
  coverage: ActivityBucketCoverage[];
  scopeLine: string;
  timeZone: string;
  selected: number | null;
  onSelect: (index: number | null) => void;
  eventTimestamp: number | null;
  onExport: () => void;
}) {
  const [metric, setMetric] = useState<"swaps" | "liquidityChanges">("swaps");
  const [hover, setHover] = useState<number | null>(null);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const buckets = report.buckets;
  const width = activityIntervalSeconds(report.window);
  const index = hover ?? selected;
  const bucket = index === null ? undefined : buckets[index];
  const prior = index === null ? undefined : previous?.buckets[index];
  const singular = metric === "swaps" ? "swap" : "LP update";
  const peak = activityPeak(previous ? [report, previous] : [report], metric);
  const max = niceMax(peak.observed);
  const ticks =
    peak.observed > 0 ? [max, max / 2, 0].filter(Number.isInteger) : [0];
  const tabStop = selected ?? Math.max(0, buckets.length - 1);
  const eventIndex =
    eventTimestamp === null
      ? -1
      : buckets.findIndex(
          (b) => eventTimestamp >= b.timestamp && eventTimestamp < b.timestamp + width,
        );
  const title = metric === "swaps" ? "Swaps over time" : "LP updates over time";
  const unit = `${metric === "swaps" ? "swaps" : "LP updates"} per ${report.window === "h1" ? "5 min" : "hour"}`;
  const tickEvery =
    report.window === "h1" ? 3 : report.window === "h24" ? 6 : 24;
  const xTicks = buckets
    .map((b, i) => ({ i, timestamp: b.timestamp }))
    .filter(({ i }) => i % tickEvery === 0);
  const tickLabel = (timestamp: number) =>
    report.window === "d7"
      ? new Date(timestamp * 1000).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        })
      : timeOnly(timestamp);
  const allUnscanned = coverage.length > 0 && coverage.every((c) => c === "unscanned");
  const allVerifiedZero =
    coverage.length > 0 &&
    coverage.every((c) => c === "verified") &&
    buckets.every((b) => b[metric] === 0);
  const noCountYet =
    !allUnscanned && peak.observed === 0 && !coverage.some((c) => c === "verified");
  const summaryExact = report.totals !== null;
  const summaryValue = (field: keyof ActivityReport["observed"]) =>
    report.totals?.[field] ?? report.observed[field];
  const step = (from: number, key: string) =>
    key === "ArrowRight"
      ? Math.min(buckets.length - 1, from + 1)
      : key === "ArrowLeft"
        ? Math.max(0, from - 1)
        : key === "Home"
          ? 0
          : key === "End"
            ? buckets.length - 1
            : null;

  return (
    <section
      className="activity-chart plate"
      aria-label={title}
    >
      <div className="activity-chart-head">
        <div className="plate-caption">
          <h3>{title}</h3>
          <span className="scope">
            {report.window === "h1" ? "Five-minute" : "Hourly"} event counts ·{" "}
            {scopeLine} · local time ({timeZone}).{" "}
            {report.totals ? "" : "Unfinished intervals are marked."}
          </span>
        </div>
        <button className="control" onClick={onExport}>
          <Download size={14} /> Intervals CSV
        </button>
      </div>
      <div className="activity-chart-toolbar">
        <div className="window-switch" role="group" aria-label="Chart metric">
          <button
            className={metric === "swaps" ? "selected" : ""}
            aria-pressed={metric === "swaps"}
            onClick={() => setMetric("swaps")}
          >
            Swaps
          </button>
          <button
            className={metric === "liquidityChanges" ? "selected" : ""}
            aria-pressed={metric === "liquidityChanges"}
            onClick={() => setMetric("liquidityChanges")}
          >
            LP updates
          </button>
        </div>
        <div className="activity-chart-legend" data-metric={metric}>
          <span>
            <i className="swatch verified" />
            Verified count
          </span>
          <span>
            <i className="swatch zero" />
            Verified zero
          </span>
          <span>
            <i className="swatch partial" />
            Lower bound
          </span>
          <span>
            <i className="swatch unscanned" />
            Not scanned
          </span>
          {previous && (
            <span>
              <i className="swatch prior" />
              Previous period
            </span>
          )}
          <span className="activity-chart-peak">Peak {peak.display}</span>
        </div>
      </div>
      <div className="activity-chart-inspector">
        <div
          className="activity-chart-readout"
          aria-live="polite"
          aria-atomic="true"
        >
          {bucket ? (
            <>
              <span className="activity-readout-kicker">Interval</span>
              <time dateTime={isoTime(bucket.timestamp)}>
                {activityDate(bucket.timestamp)} –{" "}
                {timeOnly(Math.min(bucket.timestamp + width, report.windowEnd))}
              </time>
              <strong>
                {activityCount(bucket[metric], bucket.complete, singular)}
              </strong>
              {prior && <span>{count(prior[metric])} previous</span>}
              {metric === "liquidityChanges" &&
                (bucket.liquidityAdds != null ? (
                  <span>
                    {activityCount(bucket.liquidityAdds, bucket.complete, "add")}{" "}
                    ·{" "}
                    {activityCount(
                      bucket.liquidityRemoves,
                      bucket.complete,
                      "removal",
                    )}{" "}
                    ·{" "}
                    {activityCount(bucket.liquidityPokes, bucket.complete, "poke")}
                  </span>
                ) : (
                  <span>Split not retained in this saved report</span>
                ))}
              <span
                className="activity-coverage-label"
                data-coverage={coverage[index!]}
              >
                {COVERAGE_LABEL[coverage[index!] ?? "unscanned"]}
              </span>
            </>
          ) : (
            <>
              <span className="activity-readout-kicker">Whole period</span>
              <time dateTime={isoTime(report.windowStart)}>
                {activityDate(report.windowStart)} –{" "}
                {activityDate(report.windowEnd)}
              </time>
              <strong>
                {activityCount(summaryValue(metric), summaryExact, singular)}
              </strong>
              {previous?.totals && (
                <span>{count(previous.totals[metric])} previous</span>
              )}
              {metric === "liquidityChanges" && (
                <span>
                  {activityCount(summaryValue("liquidityAdds"), summaryExact, "add")}{" "}
                  ·{" "}
                  {activityCount(
                    summaryValue("liquidityRemoves"),
                    summaryExact,
                    "removal",
                  )}{" "}
                  ·{" "}
                  {activityCount(summaryValue("liquidityPokes"), summaryExact, "poke")}
                </span>
              )}
            </>
          )}
        </div>
        {selected !== null ? (
          <button
            type="button"
            className="detail-text-action activity-readout-clear"
            onClick={() => {
              onSelect(null);
              setHover(null);
            }}
          >
            <X size={13} /> Whole period
          </button>
        ) : (
          <span className="activity-readout-hint">
            <Crosshair size={13} /> Hover or use arrow keys to inspect
          </span>
        )}
      </div>
      {buckets.length ? (
        <>
          <div
            className={`activity-plot${buckets.length > 48 ? " is-dense" : ""}`}
            style={{ "--bars": buckets.length } as CSSProperties}
          >
            <div className="activity-y-axis" aria-hidden="true">
              <span className="activity-y-unit">{unit}</span>
              {ticks.map((tick) => (
                <span
                  key={tick}
                  className="activity-y-tick"
                  style={{ bottom: `${(tick / max) * 100}%` }}
                >
                  {count(tick)}
                </span>
              ))}
            </div>
            <div className="activity-plot-scroll">
              <div className="activity-plot-area">
                <div className="activity-gridlines" aria-hidden="true">
                  {ticks.map((tick) => (
                    <i key={tick} style={{ bottom: `${(tick / max) * 100}%` }} />
                  ))}
                </div>
                {(allUnscanned || allVerifiedZero || noCountYet) && (
                  <p className="activity-plot-note" aria-hidden="true">
                    {allUnscanned
                      ? "Not scanned yet · no counts established"
                      : allVerifiedZero
                        ? `Verified zero · no ${metric === "swaps" ? "swaps" : "LP updates"} in this period`
                        : "Scan in progress · no count established yet"}
                  </p>
                )}
                <div
                  className={`activity-bars${index !== null ? " is-inspecting" : ""}`}
                  role="group"
                  aria-label="Event intervals. Use left and right arrow keys to inspect."
                  data-metric={metric}
                  onMouseLeave={() => setHover(null)}
                >
                  {buckets.map((b, i) => {
                    const state = coverage[i] ?? "unscanned";
                    const value = b[metric];
                    return (
                      <button
                        type="button"
                        key={b.timestamp}
                        ref={(element) => {
                          refs.current[i] = element;
                        }}
                        tabIndex={i === tabStop ? 0 : -1}
                        data-coverage={state}
                        className={`activity-bar ${b.complete ? "" : "incomplete"} ${i === index ? "active" : ""}${i === eventIndex ? " has-event" : ""}`}
                        aria-label={`${activityDate(b.timestamp)}: ${activityCount(value, b.complete, singular)}${b.complete ? "" : state === "unscanned" ? ", not scanned yet" : ", partial coverage"}${previous ? `; ${count(previous.buckets[i]?.[metric] ?? 0)} in previous period` : ""}${i === eventIndex ? "; contains the selected swap" : ""}`}
                        aria-pressed={i === selected}
                        onFocus={() => {
                          setHover(null);
                          onSelect(i);
                        }}
                        onMouseEnter={() => setHover(i)}
                        onClick={() => onSelect(i)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            event.preventDefault();
                            onSelect(null);
                            setHover(null);
                            return;
                          }
                          const next = step(i, event.key);
                          if (next !== null) {
                            event.preventDefault();
                            setHover(null);
                            refs.current[next]?.focus();
                          }
                        }}
                      >
                        {previous && (
                          <span
                            className="activity-prior-bar"
                            style={{
                              height: `${((previous.buckets[i]?.[metric] ?? 0) / max) * 100}%`,
                            }}
                          />
                        )}
                        {value > 0 ? (
                          <span
                            className="activity-current-bar"
                            style={{
                              height: `${Math.max(1.5, (value / max) * 100)}%`,
                            }}
                          />
                        ) : state === "verified" ? (
                          <span className="activity-zero-mark" />
                        ) : null}
                      </button>
                    );
                  })}
                </div>
                <div className="activity-coverage-lane" aria-hidden="true">
                  {coverage.map((state, i) => (
                    <i key={i} data-coverage={state} />
                  ))}
                </div>
                <div className="activity-axis" aria-hidden="true">
                  {xTicks.map(({ i, timestamp }) => (
                    <span
                      key={timestamp}
                      style={{ left: `${(i / buckets.length) * 100}%` }}
                    >
                      {tickLabel(timestamp)}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
          <p className="activity-chart-hint">
            {buckets.length > 48 && (
              <span className="activity-scroll-hint">
                Scroll the chart sideways to see all {buckets.length} intervals.{" "}
              </span>
            )}
            The coverage strip under the bars shows which intervals are
            verified, partly scanned or not scanned. Bars never join across
            unscanned time.
          </p>
          <details className="activity-data-table">
            <summary>View chart data</summary>
            <div
              className="activity-table-scroll"
              tabIndex={0}
              role="region"
              aria-label="Event intervals"
            >
              <table>
                <thead>
                  <tr>
                    <th>Interval begins</th>
                    <th className="num">Swaps</th>
                    <th className="num">LP adds</th>
                    <th className="num">Removals</th>
                    <th className="num">Pokes</th>
                    <th>Coverage</th>
                  </tr>
                </thead>
                <tbody>
                  {buckets.map((b, i) => (
                    <tr key={b.timestamp}>
                      <td>{activityDate(b.timestamp)}</td>
                      <td className="num">
                        {activityNumber(b.complete ? b.swaps : null, b.swaps)}
                      </td>
                      {(
                        [
                          "liquidityAdds",
                          "liquidityRemoves",
                          "liquidityPokes",
                        ] as const
                      ).map((field) => (
                        <td key={field} className="num">
                          {b[field] == null
                            ? "—"
                            : activityNumber(
                                b.complete ? b[field] : null,
                                b[field],
                              )}
                        </td>
                      ))}
                      <td>{COVERAGE_LABEL[coverage[i] ?? "unscanned"]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      ) : (
        <Empty title="Waiting for event coverage">
          Unscanned blocks are not treated as zero activity.
        </Empty>
      )}
    </section>
  );
}

function ActivityEventDetails({ report }: { report: ActivityReport }) {
  const fees = report.feeRates;
  const peak = Math.max(1, ...(fees?.bands.map((b) => b.swaps) ?? []));
  const complete = report.status === "complete";
  const lp = (
    [
      ["liquidityAdds", "Adds", "Positive liquidity delta", "add"],
      ["liquidityRemoves", "Removals", "Negative liquidity delta", "remove"],
      ["liquidityPokes", "Pokes", "Zero-delta position update", "poke"],
    ] as const
  ).map(([field, label, note, kind]) => ({
    field,
    label,
    note,
    kind,
    exact: report.totals?.[field] ?? null,
    observed: report.observed[field],
  }));
  const lpTotal = report.totals?.liquidityChanges ?? 0;
  return (
    <>
      <section
        className="panel activity-liquidity"
        aria-label="Liquidity event composition"
      >
        <div className="panel-heading">
          <div>
            <h3>
              <span
                className="activity-type-chip"
                data-type="liquidity"
                aria-hidden="true"
              >
                Liquidity
              </span>{" "}
              Liquidity activity
            </h3>
            <p>What LP positions did during this period.</p>
          </div>
        </div>
        {report.totals && lpTotal > 0 && (
          <div className="activity-lp-stack" aria-hidden="true">
            {lp.map((row) =>
              row.exact ? (
                <i
                  key={row.field}
                  data-kind={row.kind}
                  style={{ flexGrow: row.exact }}
                />
              ) : null,
            )}
          </div>
        )}
        <dl>
          {lp.map((row) => (
            <div key={row.field} data-kind={row.kind}>
              <dt>
                {row.label}
                <small>{row.note}</small>
              </dt>
              <dd>{activityNumber(row.exact, row.observed)}</dd>
            </div>
          ))}
        </dl>
        <p className="activity-detail-note">
          Counts describe PoolManager position updates, not capital flows.
          Custom hook liquidity can be managed separately.
        </p>
      </section>
      <section
        className="panel activity-fees"
        aria-label="Swap fee distribution"
      >
        <div className="panel-heading">
          <div>
            <h3>
              <span
                className="activity-type-chip"
                data-type="fee"
                aria-hidden="true"
              >
                Fee rate
              </span>{" "}
              Fees on swaps
            </h3>
            <p>Effective fee rates recorded by Swap events.</p>
          </div>
        </div>
        {fees && fees.swaps > 0 ? (
          <>
            <div className="activity-fee-summary">
              <strong>
                {eventFee(fees.averagePips!)}
                <small>Average per swap event</small>
              </strong>
              <span>
                {fees.minimumPips === fees.maximumPips
                  ? eventFee(fees.minimumPips!)
                  : `${eventFee(fees.minimumPips!)}–${eventFee(fees.maximumPips!)}`}
                <small>Observed range</small>
              </span>
            </div>
            <ul className="activity-fee-bands" aria-label="Swap events by fee band">
              {fees.bands.map((b) => (
                <li key={b.id} className={b.swaps ? "" : "is-empty"}>
                  <span>{b.label}</span>
                  <div aria-hidden="true">
                    <i style={{ width: `${(b.swaps / peak) * 100}%` }} />
                  </div>
                  <strong>
                    {complete ? count(b.swaps) : activityNumber(null, b.swaps)}
                  </strong>
                </li>
              ))}
            </ul>
            <p className="activity-detail-note">
              {complete
                ? `${activityCount(fees.swaps, true, "verified swap")}.`
                : `${activityCount(fees.swaps, true, "swap")} indexed so far; distribution may change.`}{" "}
              Each event has equal weight. This is not earned fee revenue.
            </p>
          </>
        ) : (
          <p className="activity-detail-note">
            {!fees
              ? "This saved report predates fee distribution tracking. Its verified event counts are preserved; detailed rates become available in newly indexed periods."
              : complete
                ? "No swaps in the indexed period, so no fee rates were observed."
                : "Fee rates appear when matching swaps are indexed."}
          </p>
        )}
      </section>
    </>
  );
}

function ActivityEventLog({
  report,
  networkName,
  selectedId,
  onSelect,
  interval,
  wide,
  scopedPool,
  onScopePool,
  copied,
  onCopyPool,
}: {
  report: ActivityReport;
  networkName: (chain: string) => string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  interval: { start: number; end: number } | null;
  wide: boolean;
  scopedPool: string;
  onScopePool: (chain: string, poolId: string) => void;
  copied: string;
  onCopyPool: (poolId: string) => void;
}) {
  const rows = report.latestSwaps;
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const explicit = rows.findIndex((row) => row.id === selectedId);
  const current = explicit >= 0 ? explicit : wide && rows.length ? 0 : -1;
  const tabStop = current >= 0 ? current : 0;
  const selected = current >= 0 ? rows[current] : null;
  const inInterval = (row: ActivitySwap) =>
    !!interval && row.timestamp >= interval.start && row.timestamp < interval.end;
  const intervalCount = interval ? rows.filter(inInterval).length : 0;
  const move = (from: number, key: string) =>
    key === "ArrowDown"
      ? Math.min(rows.length - 1, from + 1)
      : key === "ArrowUp"
        ? Math.max(0, from - 1)
        : key === "Home"
          ? 0
          : key === "End"
            ? rows.length - 1
            : null;
  const detail = selected && (
    <ActivityEventDetail
      swap={selected}
      networkName={networkName}
      scoped={scopedPool === selected.poolId}
      onScopePool={onScopePool}
      copied={copied}
      onCopyPool={onCopyPool}
    />
  );
  return (
    <section className="panel activity-events" aria-label="Latest indexed swaps">
      <div className="panel-heading">
        <div>
          <h3>Latest indexed swaps</h3>
          <p>
            Most recent swaps within the blocks checked so far
            {rows.length ? ` · ${count(rows.length)} listed, newest first (at most 50)` : ""}.
            Liquidity changes are counted above; individual liquidity events
            are not listed.
          </p>
        </div>
        {interval && rows.length > 0 && (
          <p className="activity-events-interval">
            {intervalCount
              ? `${count(intervalCount)} listed ${intervalCount === 1 ? "swap falls" : "swaps fall"} in the inspected interval`
              : "No listed swaps fall in the inspected interval"}
          </p>
        )}
      </div>
      {rows.length ? (
        <div className={`activity-event-layout${wide ? " is-wide" : ""}`}>
          <div className="activity-table-scroll activity-event-scroll">
            <table className="activity-event-table">
              <caption className="sr-only">
                Latest indexed swaps. Use up and down arrow keys on a row to
                move between events; details follow the selected row.
              </caption>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Type</th>
                  <th>Pool</th>
                  <th className="num">Currency deltas (raw units)</th>
                  <th>Fee rate</th>
                  <th>Transaction</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s, i) => {
                  const isSelected = i === current;
                  return [
                    <tr
                      key={s.id}
                      className={`${isSelected ? "is-selected" : ""}${inInterval(s) ? " in-interval" : ""}`}
                      onClick={(event) => {
                        if (
                          (event.target as HTMLElement).closest(
                            "a, button:not(.activity-event-select)",
                          )
                        )
                          return;
                        onSelect(s.id);
                        refs.current[i]?.focus();
                      }}
                    >
                      <td className="activity-event-time">
                        <button
                          type="button"
                          className="activity-event-select"
                          ref={(element) => {
                            refs.current[i] = element;
                          }}
                          tabIndex={i === tabStop ? 0 : -1}
                          aria-current={isSelected ? "true" : undefined}
                          aria-controls={
                            wide ? "activity-event-detail" : undefined
                          }
                          aria-expanded={wide ? undefined : isSelected}
                          onFocus={() => onSelect(s.id)}
                          onClick={() => onSelect(s.id)}
                          onKeyDown={(event) => {
                            const next = move(i, event.key);
                            if (next !== null) {
                              event.preventDefault();
                              refs.current[next]?.focus();
                            }
                          }}
                        >
                          <time dateTime={isoTime(s.timestamp)}>
                            {activityDate(s.timestamp)}
                          </time>
                          <span className="sr-only">
                            {" "}
                            swap in {s.poolName || shortAddress(s.poolId)} on{" "}
                            {networkName(s.chain)}
                          </span>
                          {!wide && (
                            <ChevronDown
                              size={14}
                              className="activity-event-chevron"
                            />
                          )}
                        </button>
                      </td>
                      <td className="activity-event-type">
                        <span className="activity-type-chip" data-type="swap">
                          Swap
                        </span>
                      </td>
                      <td className="activity-event-pool">
                        <span>{s.poolName || shortAddress(s.poolId)}</span>
                        <small>{networkName(s.chain)}</small>
                      </td>
                      <td className="num activity-event-amounts">
                        <span>
                          <abbr title="Currency 0 delta">Δ0</abbr>{" "}
                          {activityRawAmount(s.amount0)}
                        </span>
                        <span>
                          <abbr title="Currency 1 delta">Δ1</abbr>{" "}
                          {activityRawAmount(s.amount1)}
                        </span>
                      </td>
                      <td className="activity-event-fee">
                        <span className="activity-type-chip" data-type="fee">
                          {eventFee(s.feePips)} fee
                        </span>
                      </td>
                      <td className="activity-event-tx">
                        <External href={s.transactionUrl}>
                          {shortAddress(s.transactionHash)}
                        </External>
                      </td>
                    </tr>,
                    !wide && isSelected ? (
                      <tr
                        key={`${s.id}:detail`}
                        className="activity-event-detail-row"
                      >
                        <td colSpan={6}>{detail}</td>
                      </tr>
                    ) : null,
                  ];
                })}
              </tbody>
            </table>
          </div>
          {wide && selected && (
            <aside
              id="activity-event-detail"
              className="activity-event-detail plate"
              aria-label="Selected swap details"
            >
              {detail}
            </aside>
          )}
        </div>
      ) : (
        <p className="activity-no-events">
          {report.status === "complete" && report.totals?.swaps === 0
            ? "No swaps were recorded for this selection."
            : report.status === "complete"
              ? "Individual swap details are not available in this report."
              : "Swaps will appear as matching blocks are indexed."}
        </p>
      )}
    </section>
  );
}

function ActivityEventDetail({
  swap: s,
  networkName,
  scoped,
  onScopePool,
  copied,
  onCopyPool,
}: {
  swap: ActivitySwap;
  networkName: (chain: string) => string;
  scoped: boolean;
  onScopePool: (chain: string, poolId: string) => void;
  copied: string;
  onCopyPool: (poolId: string) => void;
}) {
  return (
    <div className="activity-event-detail-body">
      <div className="activity-event-detail-head">
        <span className="activity-type-chip" data-type="swap">
          Swap
        </span>
        <span className="activity-type-chip" data-type="fee">
          {eventFee(s.feePips)} fee
        </span>
        <h4>{s.poolName || shortAddress(s.poolId)}</h4>
        <p>
          <time dateTime={isoTime(s.timestamp)}>{activityDate(s.timestamp)}</time>{" "}
          · {networkName(s.chain)}
        </p>
      </div>
      <dl>
        <dt>Block time (UTC)</dt>
        <dd>
          <code>{isoTime(s.timestamp).replace("T", " ").replace(".000Z", " UTC")}</code>
        </dd>
        <dt>Currency 0 delta</dt>
        <dd>
          <code className="activity-amount">{activityRawAmount(s.amount0)}</code>{" "}
          raw units
          {s.currency0 && (
            <small>
              <code>{s.currency0}</code>
            </small>
          )}
        </dd>
        <dt>Currency 1 delta</dt>
        <dd>
          <code className="activity-amount">{activityRawAmount(s.amount1)}</code>{" "}
          raw units
          {s.currency1 && (
            <small>
              <code>{s.currency1}</code>
            </small>
          )}
        </dd>
        <dt>Fee rate</dt>
        <dd>
          {eventFee(s.feePips)}
          <small>Effective rate on this Swap event; not earned fee revenue.</small>
        </dd>
        <dt>Transaction</dt>
        <dd>
          <code>{s.transactionHash}</code>
          <External href={s.transactionUrl}>View transaction</External>
        </dd>
        <dt>Pool ID</dt>
        <dd>
          <code>{s.poolId}</code>
          <span className="activity-detail-actions">
            <button
              type="button"
              className="detail-text-action"
              onClick={() => onCopyPool(s.poolId)}
            >
              {copied === s.poolId ? <Check size={13} /> : <Copy size={13} />}
              {copied === s.poolId ? "Copied" : "Copy pool ID"}
            </button>
            <button
              type="button"
              className="detail-text-action"
              disabled={scoped}
              onClick={() => onScopePool(s.chain, s.poolId)}
            >
              <Crosshair size={13} />
              {scoped ? "Already scoped to this pool" : "Inspect this pool"}
            </button>
          </span>
        </dd>
        <dt>Hook</dt>
        <dd>
          <code>{s.hookAddress}</code>
        </dd>
        <dt>Block</dt>
        <dd>
          {count(s.blockNumber)} · log {s.logIndex}
          <small>
            <code>{s.blockHash}</code>
          </small>
        </dd>
        <dt>Caller</dt>
        <dd>
          <code>{s.sender}</code>
          <small>Often a router; not a unique trader identity.</small>
        </dd>
        <dt>Tick after swap</dt>
        <dd>{s.tick.toLocaleString("en-US")}</dd>
      </dl>
    </div>
  );
}
