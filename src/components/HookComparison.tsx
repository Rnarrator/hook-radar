import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import type { Pool, RadarProject, RadarSnapshot } from "../../shared/types";
import {
  filterProjects,
  count,
  money,
  isSnapshot,
  STATIC_EDITION,
} from "../model";
import { isDirectoryPage } from "../directory";
import { selectProjects } from "../scope";
import {
  MAX_COMPARISON_PROJECTS,
  COMPARISON_CALLBACKS,
  normalizeComparisonIds,
  comparisonPoolCount,
  comparisonNetworks,
  comparisonMeasurement,
  registryDeclaration,
  declarationLabel,
  accessDeclarations,
  callbackDeclaration,
  callbackLabel,
  callbackSignature,
  uniqueComparisonDeployments,
  comparisonNetworkCoverage,
  comparisonCapability,
  comparisonDeploymentEvidence,
} from "../comparison";
import type { RegistryBoolean } from "../comparison";
import { MetricMeasurement } from "../MarketProvenance";
import {
  ArrowRight,
  ChevronDown,
  Search,
  X,
  RefreshCw,
  Network,
  Copy,
  Check,
  Info,
  Plus,
} from "./Icons";
import { ProtocolLogo } from "./ProtocolLogo";
import { CallbackSignature } from "./CallbackSignature";
import { PermissionGlyphKey } from "./PermissionGlyph";
import { External } from "./Primitives";
import "./comparison.css";

type PickerResult = {
  key: string;
  generation: string;
  projects: RadarProject[];
  total: number;
  nextOffset: number | null;
};

/** The static edition holds only the projects its snapshot carries, yet a link
 * may name others. Those are kept apart, so they never get a column, never use
 * one of the four places and can be named to the visitor and removed. Ids the
 * link format rejects (uppercase, bad characters) and repeats are ignored. */
export function partitionComparisonIds(
  ids: readonly string[],
  carried: { has(id: string): boolean },
): { selection: string[]; notCarried: string[] } {
  const selection: string[] = [];
  const notCarried: string[] = [];
  const seen = new Set<string>();
  for (const value of ids) {
    const [id] = normalizeComparisonIds([value]);
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    if (!carried.has(id)) notCarried.push(id);
    else if (selection.length < MAX_COMPARISON_PROJECTS) selection.push(id);
  }
  return { selection, notCarried };
}

/** Why a metric cell has no figure in the edition: the snapshot holds no pool
 * of the project, its pools were measured but the provider gave no value, or a
 * reserve figure came and Hook Radar withheld it. */
function unmeasuredReason(pools: Pool[], metric: "h24" | "liquidity") {
  if (!STATIC_EDITION) return "No fresh measurements";
  if (!pools.length) return "Not measured in this snapshot";
  const reported = pools.some((pool) => {
    const value =
      metric === "liquidity" ? pool.liquidityUsd : pool.volumeUsd[metric];
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
  });
  // A value that exists but is older than five minutes at the snapshot's time
  // is what "fresh" refers to; a value that never came is not that.
  if (reported) return "No fresh measurements";
  // A reserve total can have come and been withheld because its composition did
  // not check out or could not be checked. "Not reported" would say the
  // opposite. Volume has no such status and keeps its wording.
  if (
    metric === "liquidity" &&
    pools.some(
      (pool) =>
        pool.liquidityStatus === "inconsistent" ||
        pool.liquidityStatus === "unverified",
    )
  )
    return "Withheld: the reported figure could not be verified";
  return "Not reported by the provider";
}

/** Search the entire directory, including families outside the initial snapshot. */
export function ProjectPicker({
  snapshot,
  selectedIds = [],
  onSelect,
  label = "Add a project",
  disabled = false,
  actionLabel = "Add",
  disabledMessage = "Four projects selected. Remove one to add another.",
  allowPlatforms = true,
}: {
  snapshot: RadarSnapshot;
  selectedIds?: string[];
  onSelect: (id: string) => void;
  label?: string;
  disabled?: boolean;
  actionLabel?: string;
  disabledMessage?: string;
  allowPlatforms?: boolean;
}) {
  const id = useId();
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<PickerResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const query = search.trim();
  const key = query;
  const remote = Boolean(snapshot.directory);
  const local = useMemo(
    () =>
      filterProjects(snapshot.projects, {
        search: query,
        chain: "all",
        category: "all",
        property: "all",
        market: "all",
      }).sort((a, b) => a.name.localeCompare(b.name)),
    [snapshot.projects, query],
  );
  const shown = remote
    ? result?.key === key
      ? result.projects
      : []
    : local.slice(0, 8 + offset);
  const total = remote
    ? result?.key === key
      ? result.total
      : null
    : local.length;
  const next = remote
    ? result?.key === key
      ? result.nextOffset
      : null
    : local.length > shown.length
      ? offset + 8
      : null;

  useEffect(() => {
    if (!remote || disabled) {
      setLoading(false);
      return;
    }
    if (offset > 0 && result?.key !== key) {
      setOffset(0);
      return;
    }
    const controller = new AbortController();
    const refresh =
      result?.key === key && result.generation !== snapshot.generatedAt;
    let disposed = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    setError("");
    setLoading(true);
    const delay = setTimeout(() => {
      deadline = setTimeout(() => controller.abort(), 30000);
      void (async () => {
        try {
          // Refresh the expanded prefix atomically: a new publication may
          // reorder or remove projects, so appending a refreshed last page
          // would keep omitted identities and mix different directory orders.
          const projects: RadarProject[] = [];
          let requestOffset = refresh ? 0 : offset;
          let total = 0;
          let nextOffset: number | null = null;
          do {
            const limit = refresh
              ? Math.min(100, offset + 8 - requestOffset)
              : 8;
            const params = new URLSearchParams({
              search: query,
              market: "all",
              sort: "name",
              direction: "asc",
              limit: String(limit),
              offset: String(requestOffset),
            });
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
              value.offset !== requestOffset ||
              value.projects.length > limit
            )
              throw new Error(
                "The directory returned an unsupported response. Please retry.",
              );
            if (disposed || controller.signal.aborted) return;
            projects.push(...value.projects);
            total = value.total;
            nextOffset = value.nextOffset;
            if (!refresh || nextOffset === null || nextOffset >= offset + 8)
              break;
            requestOffset = nextOffset;
          } while (true);
          if (disposed || controller.signal.aborted) return;
          setResult((previous) => ({
            key,
            generation: snapshot.generatedAt,
            total,
            nextOffset,
            projects:
              !refresh && offset > 0 && previous?.key === key
                ? [
                    ...new Map(
                      [...previous.projects, ...projects].map((project) => [
                        project.id,
                        project,
                      ]),
                    ).values(),
                  ]
                : [
                    ...new Map(
                      projects.map((project) => [project.id, project]),
                    ).values(),
                  ],
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
    }, 200);
    return () => {
      disposed = true;
      clearTimeout(delay);
      clearTimeout(deadline);
      controller.abort();
    };
  }, [remote, key, snapshot.generatedAt, offset, retry, disabled]);

  return (
    <section className="comparison-picker" aria-labelledby={`${id}-label`}>
      <div className="comparison-picker-heading">
        <label htmlFor={`${id}-search`} id={`${id}-label`}>
          {label}
        </label>
        {total !== null && !disabled && (
          <span>
            {count(total)} {query ? "matches" : "projects"}
          </span>
        )}
      </div>
      <div className="comparison-search">
        <Search size={17} />
        <input
          id={`${id}-search`}
          value={search}
          maxLength={300}
          disabled={disabled}
          placeholder="Search a name, purpose or hook address"
          autoComplete="off"
          aria-describedby={`${id}-status`}
          onChange={(event) => {
            if (event.target.value.trim() !== query) {
              setResult(null);
              setError("");
              setOffset(0);
            }
            setSearch(event.target.value);
          }}
        />
        {search && (
          <button
            type="button"
            className="icon-button"
            aria-label="Clear project search"
            onClick={() => {
              if (query) {
                setResult(null);
                setError("");
                setOffset(0);
              }
              setSearch("");
              document.getElementById(`${id}-search`)?.focus();
            }}
          >
            <X size={14} />
          </button>
        )}
      </div>
      <p
        id={`${id}-status`}
        className={`comparison-picker-status${!disabled && !error && !loading && shown.length ? " sr-only" : ""}`}
        role="status"
      >
        {disabled
          ? disabledMessage
          : error
            ? error
            : loading
              ? STATIC_EDITION
                ? "Searching this snapshot…"
                : "Searching the full directory…"
              : shown.length
                ? `${count(shown.length)} ${shown.length === 1 ? "project" : "projects"} shown of ${count(total ?? shown.length)} matching ${total === 1 ? "project" : "projects"}.`
                : STATIC_EDITION
                  ? "Nothing in this snapshot matches. It carries registry-named projects and projects with a measured pool, so other hooks are not included."
                  : "No projects match. Try a project name or exact hook address."}
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
      {!disabled && (
        <ul className="comparison-search-results" aria-busy={loading}>
          {shown.map((project) => (
            <li key={project.id}>
              <ProtocolLogo project={project} />
              <div>
                <strong>{project.name}</strong>
                <span>
                  {project.category} · {count(project.chains.length)}{" "}
                  {project.chains.length === 1 ? "network" : "networks"}
                </span>
              </div>
              <button
                type="button"
                className={`comparison-add ${selectedIds.includes(project.id) ? "is-added" : ""}`}
                disabled={
                  selectedIds.includes(project.id) ||
                  (!allowPlatforms && project.entityType === "platform")
                }
                aria-label={
                  !allowPlatforms && project.entityType === "platform"
                    ? `${project.name}: hook comparison unavailable`
                    : selectedIds.includes(project.id)
                      ? `${project.name} selected`
                      : `${actionLabel} ${project.name}`
                }
                onClick={() => onSelect(project.id)}
              >
                {!allowPlatforms && project.entityType === "platform"
                  ? "Platform only"
                  : selectedIds.includes(project.id)
                    ? "Added"
                    : actionLabel}{" "}
                {!selectedIds.includes(project.id) && <ArrowRight size={13} />}
              </button>
            </li>
          ))}
        </ul>
      )}
      {!disabled && !error && next !== null && (
        <button
          type="button"
          className="comparison-more control"
          disabled={loading}
          onClick={() => setOffset(next)}
        >
          {loading ? "Loading…" : "Show more projects"}
        </button>
      )}
    </section>
  );
}

/** Desktop column metrics (rem); keep in step with --cmp-label and --cmp-col. */
const COLUMN_LABEL_REM = 13.5;
const COLUMN_MIN_REM = 13;

type LoadedProject = {
  generation: string;
  project: RadarProject | null;
  error: string;
  loading: boolean;
};
type ComparisonRow = {
  key: string;
  label: string;
  /** Rows sharing a group render inside one labelled row group. */
  group?: string;
  /** Exact protocol identifier shown beneath a plain-language label. */
  code?: string;
  note?: string;
  /** A key for the row's cells, shown beneath the note. */
  legend?: ReactNode;
  value: (project: RadarProject) => ReactNode;
  signature: (project: RadarProject) => string;
};

export function HookComparison({
  ids,
  onChange,
  snapshot,
  onOpenProject,
  onClose,
  onActivity,
  network = "all",
  onNetworkChange,
  checkingHistory = false,
}: {
  ids: string[];
  onChange: (ids: string[]) => void;
  snapshot: RadarSnapshot;
  onOpenProject: (id: string) => void;
  onClose?: () => void;
  onActivity?: (id: string, network?: string) => void;
  network?: string;
  onNetworkChange?: (network: string) => void;
  checkingHistory?: boolean;
}) {
  const projectMap = useMemo(
    () => new Map(snapshot.projects.map((project) => [project.id, project])),
    [snapshot.projects],
  );
  // Live: every valid id is a column. Edition: ids the snapshot lacks are set
  // aside (the project fetch is off there, so a column would never load).
  const { selection, notCarried } = STATIC_EDITION
    ? partitionComparisonIds(ids, projectMap)
    : { selection: normalizeComparisonIds(ids), notCarried: [] as string[] };
  const selectionKey = selection.join(",");
  const latestIds = useRef(selection);
  latestIds.current = selection;
  const latestNotCarried = useRef(notCarried);
  latestNotCarried.current = notCarried;
  const [loaded, setLoaded] = useState<Record<string, LoadedProject>>({});
  const [retry, setRetry] = useState(0);
  const [differences, setDifferences] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [localNetwork, setLocalNetwork] = useState(network);
  const [contractQuery, setContractQuery] = useState("");
  const [contractLimits, setContractLimits] = useState<Record<string, number>>(
    {},
  );
  const [copiedContract, setCopiedContract] = useState("");
  const networkId = useId();
  const contractSearchId = useId();
  const [pickerOpen, setPickerOpen] = useState(selection.length < 2);
  const previousCount = useRef(selection.length);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const addressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pickerFocusFrame = useRef<number | null>(null);
  const root = useRef<HTMLElement>(null);
  // Columns align with the matrix only when every column fits without scrolling.
  const [layout, setLayout] = useState<"columns" | "stacked">("columns");
  const [scrollable, setScrollable] = useState(false);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const update = () => {
      const rem =
        parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const columns = Math.max(2, selection.length);
      setLayout(
        element.clientWidth >=
          rem * (COLUMN_LABEL_REM + columns * COLUMN_MIN_REM)
          ? "columns"
          : "stacked",
      );
      const scroller = element.querySelector<HTMLElement>(
        '[aria-label="Hook project comparison"]',
      );
      setScrollable(
        Boolean(scroller && scroller.scrollWidth > scroller.clientWidth + 1),
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [selection.length]);
  // Each project's pools, grouped once per pool list (a freshness tick rebuilds
  // the snapshot but keeps its pools): every measured row reads only its own.
  const poolsByProject = useMemo(() => {
    const groups = new Map<string, Pool[]>();
    for (const pool of snapshot.pools) {
      if (!pool.projectId) continue;
      const rows = groups.get(pool.projectId);
      if (rows) rows.push(pool);
      else groups.set(pool.projectId, [pool]);
    }
    return groups;
  }, [snapshot.pools]);
  const chainName = (slug: string) =>
    snapshot.chains.find((network) => network.slug === slug)?.name || slug;
  const currentLoaded = (id: string) => loaded[id];
  const chosen = selection.map((id) =>
    snapshot.directory
      ? currentLoaded(id)?.project || null
      : projectMap.get(id) || currentLoaded(id)?.project || null,
  );
  const allLoaded = chosen.every(Boolean);
  const hasPlatforms = chosen.some(
    (project) => project?.entityType === "platform",
  );
  // While the selected projects' details load, the two sections that follow
  // them are not drawn yet. Holding their height keeps the matrix below from
  // jumping down when they arrive; a failed load does not hold anything.
  const reserveSections =
    selection.length > 0 &&
    !allLoaded &&
    !checkingHistory &&
    !selection.some((id) => Boolean(currentLoaded(id)?.error));
  const ready = chosen.filter(
    (project): project is RadarProject => project !== null,
  );
  const missing = selection.filter(
    (id) => snapshot.directory || !projectMap.has(id),
  );
  const missingKey = missing.join(",");
  const networkCoverage = comparisonNetworkCoverage(ready);
  const requestedNetwork = onNetworkChange ? network : localNetwork;
  const effectiveNetwork =
    requestedNetwork === "all" ||
    checkingHistory ||
    !allLoaded ||
    networkCoverage.rows.some((row) => row.chain === requestedNetwork)
      ? requestedNetwork
      : "all";
  useEffect(() => {
    setCopyError("");
  }, [selectionKey, effectiveNetwork]);
  const scopedChosen = chosen.map((project) =>
    project
      ? selectProjects([project], snapshot.pools, {
          chain: effectiveNetwork,
          search: "",
          category: "all",
          property: "all",
          market: "all",
        })[0] || null
      : null,
  );
  const changeNetwork = (value: string) => {
    setLocalNetwork(value);
    onNetworkChange?.(value);
    setContractLimits({});
    setAnnouncement(
      value === "all"
        ? "Comparing all deployment networks."
        : `Comparison scoped to ${chainName(value)}.`,
    );
  };
  useEffect(() => {
    if (
      selection.length &&
      allLoaded &&
      requestedNetwork !== effectiveNetwork
    ) {
      setLocalNetwork("all");
      onNetworkChange?.("all");
    }
  }, [
    allLoaded,
    selection.length,
    requestedNetwork,
    effectiveNetwork,
    onNetworkChange,
  ]);

  useEffect(() => {
    // The static edition has no service to ask for a project outside its snapshot.
    if (checkingHistory || STATIC_EDITION) return;
    const controller = new AbortController();
    let disposed = false;
    const targets = missing.filter(
      (id) =>
        !loaded[id]?.project ||
        loaded[id]?.generation !== snapshot.generatedAt ||
        loaded[id]?.error,
    );
    setLoaded((previous) =>
      Object.fromEntries(
        missing.map((id) => [
          id,
          !targets.includes(id)
            ? previous[id]
            : {
                generation: previous[id]?.generation || snapshot.generatedAt,
                project: previous[id]?.project || null,
                loading: true,
                error: "",
              },
        ]),
      ),
    );
    const deadline = setTimeout(() => controller.abort(), 30000);
    void Promise.all(
      targets.map(async (id) => {
        try {
          const response = await fetch(
            `/api/projects/${encodeURIComponent(id)}`,
            { signal: controller.signal },
          );
          if (!response.ok)
            throw new Error(
              response.status === 404
                ? "This project is no longer in the directory."
                : "Project details could not load. Please retry.",
            );
          const value: unknown = await response.json();
          if (
            !isSnapshot({
              ...snapshot,
              presentation: undefined,
              directory: undefined,
              projects: [value],
            }) ||
            (value as RadarProject).id !== id
          )
            throw new Error(
              "Project details returned an unsupported response.",
            );
          if (!disposed && !controller.signal.aborted)
            setLoaded((previous) => ({
              ...previous,
              [id]: {
                generation: snapshot.generatedAt,
                project: value as RadarProject,
                loading: false,
                error: "",
              },
            }));
        } catch (cause) {
          if (!disposed)
            setLoaded((previous) => ({
              ...previous,
              [id]: {
                generation: snapshot.generatedAt,
                project: previous[id]?.project || null,
                loading: false,
                error: controller.signal.aborted
                  ? "Project details took too long. Please retry."
                  : cause instanceof Error &&
                      !["TypeError", "SyntaxError"].includes(cause.name)
                    ? cause.message
                    : "Project details could not load. Check your connection and retry.",
              },
            }));
        }
      }),
    ).finally(() => clearTimeout(deadline));
    return () => {
      disposed = true;
      clearTimeout(deadline);
      controller.abort();
    };
  }, [missingKey, snapshot.generatedAt, retry, checkingHistory]);
  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
      if (addressTimer.current) clearTimeout(addressTimer.current);
      if (pickerFocusFrame.current !== null)
        cancelAnimationFrame(pickerFocusFrame.current);
    },
    [],
  );

  const change = (next: string[], message: string) => {
    const normalized = normalizeComparisonIds(next);
    latestIds.current = normalized;
    // Ids the snapshot does not carry stay in the link until the visitor
    // removes them (always none on the live site).
    onChange(
      latestNotCarried.current.length
        ? [...normalized, ...latestNotCarried.current]
        : normalized,
    );
    setAnnouncement(message);
    setCopied(false);
  };
  const removeNotCarried = (id: string) => {
    latestNotCarried.current = latestNotCarried.current.filter(
      (value) => value !== id,
    );
    onChange([...latestIds.current, ...latestNotCarried.current]);
    setAnnouncement("Project removed from the link.");
    setCopied(false);
    if (pickerFocusFrame.current !== null)
      cancelAnimationFrame(pickerFocusFrame.current);
    pickerFocusFrame.current = requestAnimationFrame(() => {
      pickerFocusFrame.current = null;
      // Another unlisted id keeps the visitor in the list; otherwise the line is gone.
      const next = root.current?.querySelector<HTMLElement>(
        ".comparison-not-carried button",
      );
      if (next) next.focus();
      else focusPicker();
    });
  };
  useEffect(() => {
    if (selection.length < 2) setPickerOpen(true);
    else if (previousCount.current < 2) setPickerOpen(false);
    previousCount.current = selection.length;
  }, [selection.length]);
  const focusPicker = () => {
    if (pickerFocusFrame.current !== null)
      cancelAnimationFrame(pickerFocusFrame.current);
    pickerFocusFrame.current = requestAnimationFrame(() => {
      pickerFocusFrame.current = null;
      const picker = root.current?.querySelector<HTMLDetailsElement>(
        ".comparison-picker-disclosure",
      );
      const target =
        picker?.open && latestIds.current.length < MAX_COMPARISON_PROJECTS
          ? picker.querySelector<HTMLInputElement>(".comparison-search input")
          : picker?.querySelector<HTMLElement>("summary");
      target?.focus();
    });
  };
  const add = (id: string) => {
    if (
      latestIds.current.includes(id) ||
      latestIds.current.length >= MAX_COMPARISON_PROJECTS
    )
      return;
    const next = [...latestIds.current, id];
    if (next.length === 2) setPickerOpen(false);
    change(next, "Project added to comparison.");
    focusPicker();
  };
  const remove = (id: string) => {
    const next = latestIds.current.filter((value) => value !== id);
    if (next.length < 2) setPickerOpen(true);
    change(next, "Project removed from comparison.");
    focusPicker();
  };
  const copyLink = async () => {
    setCopyError("");
    setCopied(false);
    setCopiedContract("");
    setAnnouncement("");
    if (copyTimer.current) clearTimeout(copyTimer.current);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("view", "compare");
      url.searchParams.delete("project");
      url.searchParams.delete("tab");
      if (effectiveNetwork === "all") url.searchParams.delete("compareChain");
      else url.searchParams.set("compareChain", effectiveNetwork);
      if (selection.length)
        url.searchParams.set("compare", selection.join(","));
      else url.searchParams.delete("compare");
      await navigator.clipboard.writeText(url.href);
      setCopied(true);
      setAnnouncement("Comparison link copied.");
      copyTimer.current = setTimeout(() => setCopied(false), 2400);
    } catch {
      setCopyError(
        "Link could not be copied. Copy the address from your browser.",
      );
      setAnnouncement("");
    }
  };
  const copyAddress = async (key: string, address: string) => {
    setCopyError("");
    setCopied(false);
    setCopiedContract("");
    setAnnouncement("");
    if (addressTimer.current) clearTimeout(addressTimer.current);
    try {
      await navigator.clipboard.writeText(address);
      setCopiedContract(key);
      setAnnouncement("Hook contract address copied.");
      addressTimer.current = setTimeout(() => setCopiedContract(""), 2400);
    } catch {
      setCopyError(
        "Address could not be copied. Select the contract address to copy it.",
      );
      setAnnouncement("");
    }
  };
  const comparable = allLoaded && ready.length > 1;
  const sharedNetworks = new Set(comparable ? networkCoverage.shared : []);
  const scopeName =
    effectiveNetwork === "all" ? "All networks" : chainName(effectiveNetwork);
  /** Proportion of this project's own hook versions; never a cross-project ranking. */
  const meter = (enabled: number, known: number, unknown: number) => (
    <span className="comparison-meter" aria-hidden="true">
      {enabled > 0 && <i className="is-on" style={{ flexGrow: enabled }} />}
      {known - enabled > 0 && (
        <i className="is-off" style={{ flexGrow: known - enabled }} />
      )}
      {unknown > 0 && (
        <i className="is-unknown" style={{ flexGrow: unknown }} />
      )}
    </span>
  );
  const declaration =
    (property: RegistryBoolean) => (project: RadarProject) => {
      const value = registryDeclaration(project, property);
      return (
        <div
          className="comparison-declaration"
          data-state={
            !value.known
              ? "unknown"
              : value.enabled
                ? "declared"
                : "not-declared"
          }
        >
          {meter(value.enabled, value.known, value.unknown)}
          <span>{declarationLabel(value)}</span>
          {value.unknown > 0 && (
            <small>{count(value.unknown)} not classified</small>
          )}
        </div>
      );
    };
  const measurement =
    (metric: "h24" | "liquidity") => (project: RadarProject) => {
      const measured = comparisonMeasurement(
        project,
        poolsByProject.get(project.id) ?? [],
        metric,
        effectiveNetwork,
      );
      const reason =
        measured.amount === null
          ? unmeasuredReason(measured.observedPools, metric)
          : "";
      return (
        <div
          className={`comparison-reading${measured.amount === null ? " is-unavailable" : ""}`}
        >
          <strong
            className="comparison-amount"
            title={
              measured.amount === null
                ? STATIC_EDITION
                  ? reason
                  : "Not measured in this scope"
                : measured.amount.toLocaleString("en-US", {
                    style: "currency",
                    currency: "USD",
                  })
            }
          >
            {money(measured.amount)}
          </strong>
          <small>
            {measured.amount === null
              ? reason
              : `${count(measured.pools.length)} current ${measured.pools.length === 1 ? "pool" : "pools"} · measured subset`}
          </small>
          <MetricMeasurement
            pools={measured.observedPools}
            metric={metric}
            compact
          />
          {measured.sources.length > 0 && (
            <small className="comparison-source">
              {measured.sources.join(" · ")}
            </small>
          )}
        </div>
      );
    };
  const rows: ComparisonRow[] = [
    {
      key: "category",
      group: "Identity",
      label: "Purpose",
      value: (project) => (
        <span className="comparison-purpose" data-category={project.category}>
          {project.category}
        </span>
      ),
      signature: (project) => project.category,
    },
    {
      key: "networks",
      group: "Identity",
      label: "Networks",
      note: sharedNetworks.size
        ? "A dot marks a network every selected project uses."
        : undefined,
      value: (project) => (
        <div className="comparison-networks">
          {comparisonNetworks(project).map((network) => (
            <span
              key={network}
              className={sharedNetworks.has(network) ? "is-shared" : undefined}
              title={
                sharedNetworks.has(network)
                  ? `${chainName(network)} · used by every selected project`
                  : undefined
              }
            >
              {chainName(network)}
              {sharedNetworks.has(network) && (
                <span className="sr-only"> (shared)</span>
              )}
            </span>
          ))}
        </div>
      ),
      signature: (project) => comparisonNetworks(project).join(","),
    },
    {
      key: "hooks",
      group: "Deployments",
      label: "Hook contracts",
      note: "Unique addresses per network.",
      value: (project) => (
        <span className="comparison-figure">
          {count(uniqueComparisonDeployments(project.deployments))}
        </span>
      ),
      signature: (project) =>
        String(uniqueComparisonDeployments(project.deployments)),
    },
    {
      key: "pools",
      group: "Deployments",
      label: "Pools",
      note: "Pool creation is not trading activity.",
      value: (project) => {
        const pools = comparisonPoolCount(project, effectiveNetwork);
        return (
          <>
            <strong className="comparison-figure">{count(pools.value)}</strong>
            <small>{pools.scope}</small>
          </>
        );
      },
      signature: (project) =>
        JSON.stringify(comparisonPoolCount(project, effectiveNetwork)),
    },
    {
      key: "signature",
      group: "Capabilities",
      label: "Callback signature",
      note: "Which of the 14 v4 permission flags each project's classified hooks enable. Exact counts are under Callback permissions.",
      legend: <PermissionGlyphKey />,
      value: (project) => (
        <CallbackSignature project={project} className="comparison-signature" />
      ),
      signature: (project) =>
        JSON.stringify(callbackSignature(project).shares),
    },
    {
      key: "volume",
      group: "Measured markets",
      label: "24h volume",
      note: "Only attributed pools with measured USD values. Coverage can differ.",
      value: measurement("h24"),
      signature: (project) =>
        JSON.stringify(
          comparisonMeasurement(
            project,
            poolsByProject.get(project.id) ?? [],
            "h24",
            effectiveNetwork,
          ),
        ),
    },
    {
      key: "reserves",
      group: "Measured markets",
      label: "Pool reserves",
      note: "Provider valuations, not executable depth or protocol TVL.",
      value: measurement("liquidity"),
      signature: (project) =>
        JSON.stringify(
          comparisonMeasurement(
            project,
            poolsByProject.get(project.id) ?? [],
            "liquidity",
            effectiveNetwork,
          ),
        ),
    },
    ...(
      [
        ["dynamicFee", "Dynamic LP fees"],
        ["upgradeable", "Upgradeable"],
        ["requiresCustomSwapData", "Custom swap data"],
        ["verifiedSource", "Source verification"],
      ] as [RegistryBoolean, string][]
    ).map(([key, label]) => ({
      key,
      group: "Registry declarations",
      label,
      note:
        key === "verifiedSource"
          ? "Registry declarations; not an audit or safety rating."
          : "Registry classifications; individual hook configurations can differ.",
      value: declaration(key),
      signature: (project: RadarProject) =>
        JSON.stringify(registryDeclaration(project, key)),
    })),
    {
      key: "access",
      group: "Registry declarations",
      label: "Trading access",
      note: "Declared rules, not a guarantee of current access.",
      value: (project) => (
        <ul className="comparison-access">
          {accessDeclarations(project).map(([label, total]) => (
            <li key={label}>
              <span>{label}</span>
              <small>
                {count(total)} {total === 1 ? "hook" : "hooks"}
              </small>
            </li>
          ))}
        </ul>
      ),
      signature: (project) => JSON.stringify(accessDeclarations(project)),
    },
  ];
  const rowDiffers = (row: ComparisonRow, allNetworks: boolean) =>
    comparable &&
    new Set(
      selection.map((_, index) => {
        const project = allNetworks ? chosen[index] : scopedChosen[index];
        return project ? row.signature(project) : "no-deployment";
      }),
    ).size > 1;
  const visibleRows =
    differences && comparable
      ? rows.filter((row) => rowDiffers(row, false))
      : rows;
  const callbackGroup = (callback: string) =>
    /ReturnsDelta$/.test(callback)
      ? "Amount-adjusting flags"
      : /Initialize$/.test(callback)
        ? "Create pool"
        : /AddLiquidity$/.test(callback)
          ? "Add liquidity"
          : /RemoveLiquidity$/.test(callback)
            ? "Remove liquidity"
            : /Swap$/.test(callback)
              ? "Swap"
              : "Donate";
  const table = (
    items: ComparisonRow[],
    caption: string,
    allNetworks = false,
  ) => {
    const sections: { group?: string; rows: ComparisonRow[] }[] = [];
    for (const row of items) {
      const last = sections.at(-1);
      if (last && last.group === row.group) last.rows.push(row);
      else sections.push({ group: row.group, rows: [row] });
    }
    return (
      <div
        className="comparison-scroll"
        role="region"
        aria-label={caption}
        tabIndex={0}
      >
        <table className="comparison-table">
          <colgroup>
            <col className="comparison-field-column" />
            {selection.map((id) => (
              <col key={id} />
            ))}
          </colgroup>
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              <th scope="col">
                {allNetworks || effectiveNetwork === "all"
                  ? "All networks"
                  : chainName(effectiveNetwork)}
              </th>
              {selection.map((id, index) => {
                const project = chosen[index];
                return (
                  <th scope="col" key={id}>
                    {project ? (
                      <span className="comparison-column-head">
                        <ProtocolLogo project={project} />
                        <span>{project.name}</span>
                      </span>
                    ) : (
                      id
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          {sections.map((section, sectionIndex) => (
            <tbody
              key={section.group || sectionIndex}
              aria-label={section.group}
            >
              {section.rows.map((row, rowIndex) => {
                // Identical rows recede; differing rows keep full contrast.
                const same = comparable && !rowDiffers(row, allNetworks);
                return (
                  <tr
                    key={row.key}
                    className={
                      section.group && rowIndex === 0
                        ? "comparison-group-start"
                        : undefined
                    }
                    data-same={same || undefined}
                  >
                    <th scope="row">
                      {section.group && rowIndex === 0 && (
                        <span
                          className="comparison-group-label"
                          aria-hidden="true"
                        >
                          {section.group}
                        </span>
                      )}
                      <span className="comparison-row-label">{row.label}</span>
                      {row.code && (
                        <code className="comparison-row-code">{row.code}</code>
                      )}
                      {same && (
                        <span className="comparison-same-tag">
                          Same in every column
                        </span>
                      )}
                      {row.note && <small>{row.note}</small>}
                      {row.legend}
                    </th>
                    {selection.map((id, index) => (
                      <td key={id} data-project={chosen[index]?.name || id}>
                        {chosen[index] &&
                        (allNetworks || scopedChosen[index]) ? (
                          <div className="comparison-cell">
                            {row.value(
                              (allNetworks
                                ? chosen[index]
                                : scopedChosen[index])!,
                            )}
                          </div>
                        ) : chosen[index] ? (
                          <span className="comparison-unavailable">
                            No deployment on {chainName(effectiveNetwork)}
                          </span>
                        ) : (
                          <span className="comparison-unavailable">
                            {checkingHistory
                              ? "Waiting for verification"
                              : currentLoaded(id)?.error
                                ? "Unavailable"
                                : "Loading…"}
                          </span>
                        )}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          ))}
        </table>
      </div>
    );
  };

  return (
    <section
      className="hook-comparison"
      style={
        {
          "--cmp-count": Math.max(1, selection.length),
        } as React.CSSProperties
      }
      data-count={selection.length}
      data-layout={layout}
      ref={root}
      data-testid="hook-comparison"
      aria-labelledby="comparison-title"
    >
      <header className="comparison-heading">
        <div>
          <span className="kicker">
            {selection.length
              ? `${selection.length} of ${MAX_COMPARISON_PROJECTS} columns · ${scopeName}`
              : "Side by side · up to four projects"}
          </span>
          <h2 id="comparison-title">
            {selection.length
              ? "Selected projects"
              : "Choose projects to compare"}
            {selection.length > 0 && (
              <span className="comparison-selection-count">
                {selection.length} / {MAX_COMPARISON_PROJECTS}
              </span>
            )}
          </h2>
        </div>
        {(selection.length > 0 || onClose) && (
          <div className="comparison-header-actions">
            {selection.length > 0 && (
              <button className="control" type="button" onClick={copyLink}>
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? "Link copied" : "Copy comparison link"}
              </button>
            )}
            {onClose && (
              <button className="control" type="button" onClick={onClose}>
                Back to discovery
              </button>
            )}
          </div>
        )}
      </header>
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      {copyError && (
        <div className="notice error-notice comparison-copy-error" role="alert">
          <Info size={16} />
          <span>{copyError}</span>
        </div>
      )}
      {checkingHistory && (
        <div className="notice comparison-history-notice" role="status">
          <Info size={16} />
          <span>
            Checking saved history. Previously loaded project details remain
            available. Other details load automatically when verification
            finishes.
          </span>
        </div>
      )}
      {notCarried.length > 0 && (
        <div className="notice comparison-not-carried" role="status">
          <Info size={16} />
          <div>
            <p>
              This link names {count(notCarried.length)}{" "}
              {notCarried.length === 1 ? "project" : "projects"} this snapshot
              does not carry (it carries registry-named projects and projects
              with at least one measured pool):
            </p>
            <ul>
              {notCarried.map((id) => (
                <li key={id}>
                  <code>{id}</code>{" "}
                  <button
                    type="button"
                    aria-label={`Remove ${id} from this link`}
                    onClick={() => removeNotCarried(id)}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      <div className="comparison-workspace">
        <details
          className="comparison-picker-disclosure"
          open={pickerOpen}
          onToggle={(event) => setPickerOpen(event.currentTarget.open)}
        >
          <summary>
            <span className="comparison-picker-summary-icon" aria-hidden="true">
              <Plus size={15} />
            </span>
            <span className="comparison-picker-summary-label">
              {selection.length >= MAX_COMPARISON_PROJECTS
                ? "Four projects selected"
                : selection.length < 2
                  ? "Find projects"
                  : "Add a project"}
            </span>
            <span className="comparison-picker-summary-meta">
              {selection.length >= MAX_COMPARISON_PROJECTS
                ? "Remove a column to add another"
                : `${MAX_COMPARISON_PROJECTS - selection.length} of ${MAX_COMPARISON_PROJECTS} columns open`}
            </span>
            <ChevronDown size={16} className="comparison-disclosure-chevron" />
          </summary>
          <ProjectPicker
            allowPlatforms={false}
            snapshot={snapshot}
            selectedIds={selection}
            onSelect={add}
            disabled={
              selection.length >= MAX_COMPARISON_PROJECTS ||
              (checkingHistory && Boolean(snapshot.directory))
            }
            disabledMessage={
              selection.length >= MAX_COMPARISON_PROJECTS
                ? "Four projects selected. Remove one to add another."
                : "Project search opens automatically after saved history is checked."
            }
            label="Search projects"
          />
        </details>
        {selection.length === 0 && (
          <div className="comparison-empty-guide">
            <ol>
              <li>
                <span className="comparison-step" aria-hidden="true">
                  01
                </span>
                <strong>
                  {STATIC_EDITION
                    ? "Search this snapshot"
                    : "Search the full directory"}
                </strong>
                <p>
                  Find a project by name, purpose or exact hook address.
                  Platform entries are listed but cannot be added.
                </p>
              </li>
              <li>
                <span className="comparison-step" aria-hidden="true">
                  02
                </span>
                <strong>Add two to four projects</strong>
                <p>
                  Each project becomes a column. The selection lives in the page
                  address, so Back, reload and shared links keep it.
                </p>
              </li>
              <li>
                <span className="comparison-step" aria-hidden="true">
                  03
                </span>
                <strong>Narrow to one network</strong>
                <p>
                  Compare contracts, declarations and measured pools in the same
                  environment. Nothing here ranks projects.
                </p>
              </li>
            </ol>
            <p className="comparison-empty-contents">
              <span className="kicker">You will see</span>
              <span>Identity</span>
              <span>Deployments</span>
              <span>Measured markets</span>
              <span>Registry declarations</span>
              <span>Callback permissions</span>
              <span>Exact contracts</span>
            </p>
          </div>
        )}
        {selection.length > 0 && (
          <div className="comparison-columns">
            <div className="comparison-corner">
              {!hasPlatforms && (
                <div className="comparison-scope">
                  <label htmlFor={networkId}>
                    <Network size={15} />
                    Compare on
                  </label>
                  <div className="select-control">
                    <select
                      id={networkId}
                      value={effectiveNetwork}
                      disabled={!allLoaded}
                      onChange={(event) => changeNetwork(event.target.value)}
                    >
                      <option value="all">All networks</option>
                      {effectiveNetwork !== "all" &&
                        !networkCoverage.rows.some(
                          ({ chain }) => chain === effectiveNetwork,
                        ) && (
                          <option value={effectiveNetwork}>
                            {chainName(effectiveNetwork)} · waiting for details
                          </option>
                        )}
                      {networkCoverage.rows.map(({ chain }) => (
                        <option key={chain} value={chain}>
                          {chainName(chain)}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={15} />
                  </div>
                  <p>
                    {effectiveNetwork === "all"
                      ? "Includes every hook version. Narrow to one network to compare integration details."
                      : `Contracts, permissions and measured pools on ${chainName(effectiveNetwork)} only.`}
                  </p>
                </div>
              )}
            </div>
            <div
              className="comparison-selection"
              role="group"
              aria-label="Selected projects"
            >
              {selection.map((id, index) => {
                const project = chosen[index];
                const refreshing = Boolean(
                  !checkingHistory &&
                  project &&
                  missing.includes(id) &&
                  (currentLoaded(id)?.loading ||
                    currentLoaded(id)?.generation !== snapshot.generatedAt),
                );
                const refreshError =
                  !checkingHistory && project && currentLoaded(id)?.error;
                return (
                  <article
                    key={id}
                    className="comparison-project"
                    aria-busy={
                      !checkingHistory && !project && !currentLoaded(id)?.error
                    }
                  >
                    <div className="comparison-project-top">
                      {project ? (
                        <ProtocolLogo project={project} large />
                      ) : (
                        <span
                          className="comparison-project-pending"
                          aria-hidden="true"
                        />
                      )}
                      <button
                        type="button"
                        className="comparison-remove icon-button"
                        aria-label={`Remove ${project?.name || id} from comparison`}
                        onClick={() => remove(id)}
                      >
                        <X size={15} />
                      </button>
                    </div>
                    {project ? (
                      <>
                        <span
                          className="comparison-project-category"
                          data-category={project.category}
                        >
                          {project.category}
                        </span>
                        <h3>{project.name}</h3>
                        <p className="comparison-project-description">
                          {project.description}
                        </p>
                        {project.entityType === "platform" && (
                          <p className="comparison-refresh-note" role="status">
                            This platform has no linked hook deployments to
                            compare. Remove it to continue comparing hooks.
                          </p>
                        )}
                        {refreshError ? (
                          <div
                            className="comparison-refresh-note"
                            role="status"
                          >
                            <span>
                              Couldn’t refresh. Showing the last loaded project
                              details.
                            </span>
                            <button
                              type="button"
                              onClick={() => setRetry((value) => value + 1)}
                            >
                              Retry refresh
                            </button>
                          </div>
                        ) : refreshing ? (
                          <div
                            className="comparison-refresh-note"
                            role="status"
                          >
                            Updating project details…
                          </div>
                        ) : null}
                        <div className="comparison-project-links">
                          <button
                            type="button"
                            onClick={() => onOpenProject(project.id)}
                          >
                            {project.entityType === "platform"
                              ? "View platform"
                              : "Explore hooks"}{" "}
                            <ArrowRight size={13} />
                          </button>
                          {onActivity && project.entityType !== "platform" && (
                            <button
                              type="button"
                              onClick={() =>
                                onActivity(project.id, effectiveNetwork)
                              }
                            >
                              View activity <ArrowRight size={13} />
                            </button>
                          )}
                          <External href={project.website}>Website</External>
                          <External href={project.sourceUrl}>Source</External>
                        </div>
                      </>
                    ) : (
                      <>
                        <h3>{id}</h3>
                        <p role="status" className="comparison-project-status">
                          {checkingHistory
                            ? "Project details open automatically after saved history is checked."
                            : currentLoaded(id)?.error ||
                              "Loading project details…"}
                        </p>
                        {!checkingHistory && currentLoaded(id)?.error && (
                          <button
                            type="button"
                            className="control"
                            onClick={() => setRetry((value) => value + 1)}
                          >
                            Retry details
                          </button>
                        )}
                      </>
                    )}
                  </article>
                );
              })}
              {selection.length === 1 && (
                <p className="comparison-next">
                  Add another project to start comparing.
                </p>
              )}
            </div>
          </div>
        )}
      </div>
      {selection.length > 0 && !hasPlatforms && (
        <>
          {reserveSections && (
            <div className="comparison-reserve" aria-hidden="true" />
          )}
          {allLoaded && (
            <section
              className="comparison-integration comparison-band"
              aria-labelledby="comparison-integration-title"
            >
              <div className="comparison-band-label">
                <h3 id="comparison-integration-title">Before you integrate</h3>
                <p>
                  Registry declarations for the selected scope. Individual
                  versions can differ.
                </p>
              </div>
              <div className="comparison-integration-grid comparison-band-columns">
                {selection.map((id, index) => (
                  <article key={id}>
                    <strong className="comparison-band-name">
                      {chosen[index]?.name}
                    </strong>
                    {scopedChosen[index] ? (
                      (
                        [
                          ["requiresCustomSwapData", "Custom swap data"],
                          ["upgradeable", "Upgradeable contracts"],
                        ] as [RegistryBoolean, string][]
                      ).map(([property, label]) => {
                        const value = comparisonCapability(
                          scopedChosen[index]!,
                          property,
                        );
                        return (
                          <div
                            key={property}
                            className={`comparison-capability ${value.state}`}
                          >
                            <span>{label}</span>
                            <b>
                              {meter(value.enabled, value.known, value.unknown)}
                              {value.label}
                            </b>
                            <small>{value.detail}</small>
                          </div>
                        );
                      })
                    ) : (
                      <p className="comparison-unavailable">
                        No deployment on {chainName(effectiveNetwork)}
                      </p>
                    )}
                  </article>
                ))}
              </div>
            </section>
          )}
          {comparable && (
            <section
              className="comparison-network-summary"
              aria-labelledby="comparison-network-title"
            >
              <div className="comparison-band">
                <div className="comparison-band-label">
                  <span className="comparison-eyebrow kicker">
                    Network availability
                  </span>
                  <h3 id="comparison-network-title">
                    {networkCoverage.shared.length
                      ? `Shared on ${networkCoverage.shared.map(chainName).join(", ")}`
                      : "No shared deployment network"}
                  </h3>
                </div>
                <p className="comparison-band-copy">
                  {networkCoverage.shared.length
                    ? "Shared networks let you compare hooks in the same environment. Contract counts include every version."
                    : "These projects run on different networks. A missing deployment is shown explicitly below."}
                </p>
              </div>
              <details className="comparison-network-matrix comparison-disclosure">
                <summary>
                  Network availability{" "}
                  <span>{count(networkCoverage.rows.length)} networks</span>
                  <ChevronDown
                    size={16}
                    className="comparison-disclosure-chevron"
                  />
                </summary>
                {table(
                  networkCoverage.rows.map(({ chain }) => ({
                    key: chain,
                    label: chainName(chain),
                    value: (project) => {
                      const total = uniqueComparisonDeployments(
                        project.deployments.filter(
                          (hook) => hook.chain === chain,
                        ),
                      );
                      return total ? (
                        <span className="comparison-network-present">
                          <Check size={13} />
                          {count(total)} {total === 1 ? "hook" : "hooks"}
                        </span>
                      ) : (
                        <span className="comparison-unavailable">
                          No deployment
                        </span>
                      );
                    },
                    signature: (project) =>
                      String(
                        uniqueComparisonDeployments(
                          project.deployments.filter(
                            (hook) => hook.chain === chain,
                          ),
                        ),
                      ),
                  })),
                  "Deployment network availability comparison",
                  true,
                )}
              </details>
            </section>
          )}
          <div className="comparison-matrix-heading">
            <div>
              <h3>At a glance</h3>
              <p>
                {scopeName} · {count(selection.length)}{" "}
                {selection.length === 1 ? "project" : "projects"}
                {comparable
                  ? ` · ${count(rows.filter((row) => rowDiffers(row, false)).length)} of ${count(rows.length)} rows differ`
                  : ""}{" "}
                · each measured cell keeps its own pools, source and measurement
                time.
              </p>
            </div>
            <label className="comparison-toggle">
              <input
                type="checkbox"
                checked={differences}
                onChange={(event) => setDifferences(event.target.checked)}
                disabled={selection.length < 2 || !allLoaded}
              />
              <span className="comparison-toggle-track" aria-hidden="true" />
              Show differences only
            </label>
          </div>
          <ul className="comparison-legend" aria-label="How to read the matrix">
            <li>
              <i className="is-on" aria-hidden="true" /> Declared
            </li>
            <li>
              <i className="is-off" aria-hidden="true" /> Not declared
            </li>
            <li>
              <i className="is-unknown" aria-hidden="true" /> Not classified
            </li>
            {comparable && (
              <li>
                <span className="comparison-same-tag" aria-hidden="true">
                  Same
                </span>{" "}
                Identical in every column, dimmed. Differences stay bright; no
                column is ranked.
              </li>
            )}
            <li>
              <span className="comparison-legend-dash" aria-hidden="true">
                —
              </span>{" "}
              Not measured; a measured zero shows $0.
            </li>
          </ul>
          {scrollable && (
            <p className="comparison-scroll-hint">
              Scroll sideways to see every column. Row labels stay pinned.
            </p>
          )}
          {visibleRows.length ? (
            table(visibleRows, "Hook project comparison")
          ) : (
            <p className="comparison-same">
              These projects have the same values for the fields above. Turn off
              “Show differences only” to see them.
            </p>
          )}
          <details className="comparison-callbacks comparison-disclosure">
            <summary>
              Callback permissions{" "}
              <span>Exact hooks into the pool lifecycle</span>
              <ChevronDown
                size={16}
                className="comparison-disclosure-chevron"
              />
            </summary>
            {table(
              COMPARISON_CALLBACKS.map((callback) => ({
                key: callback,
                group: callbackGroup(callback),
                label: callbackLabel(callback),
                code: callback,
                value: (project) => {
                  const value = callbackDeclaration(project, callback);
                  return (
                    <div
                      className="comparison-declaration"
                      data-state={
                        !value.known
                          ? "unknown"
                          : value.enabled
                            ? "declared"
                            : "not-declared"
                      }
                    >
                      {meter(value.enabled, value.known, value.unknown)}
                      <span>
                        {value.known
                          ? `${count(value.enabled)} of ${count(value.known)} hooks`
                          : "Unknown"}
                      </span>
                      {value.unknown > 0 && (
                        <small>{count(value.unknown)} unknown</small>
                      )}
                    </div>
                  );
                },
                signature: (project) =>
                  JSON.stringify(callbackDeclaration(project, callback)),
              })),
              "Hook callback permission comparison",
            )}
            <p>
              Enabled permissions describe where a hook can execute. They do not
              describe safety or prove that a callback is called in every
              transaction.
            </p>
          </details>
          <details className="comparison-contracts comparison-disclosure">
            <summary>
              Inspect the exact contracts{" "}
              <span>Addresses, sources and enabled callbacks</span>
              <ChevronDown
                size={16}
                className="comparison-disclosure-chevron"
              />
            </summary>
            <div className="comparison-contract-content comparison-band">
              <div className="comparison-band-label">
                <label htmlFor={contractSearchId}>Find a contract</label>
                <div className="comparison-search">
                  <Search size={16} />
                  <input
                    id={contractSearchId}
                    value={contractQuery}
                    maxLength={200}
                    placeholder="Name, address or network"
                    onChange={(event) => {
                      setContractQuery(event.target.value);
                      setContractLimits({});
                    }}
                  />
                  {contractQuery && (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="Clear contract search"
                      onClick={() => setContractQuery("")}
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
                <p>
                  {effectiveNetwork === "all"
                    ? "Unique chain and address pairs across every network."
                    : `Unique hook addresses on ${scopeName}.`}
                </p>
              </div>
              <div className="comparison-contract-grid comparison-band-columns">
                {selection.map((id, index) => {
                  const project = chosen[index];
                  if (!project)
                    return (
                      <section key={id}>
                        <h4>{id}</h4>
                        <p>Project details are not available yet.</p>
                      </section>
                    );
                  const contracts = comparisonDeploymentEvidence(
                    project,
                    effectiveNetwork,
                    contractQuery,
                  );
                  const limit = contractLimits[id] || 5;
                  return (
                    <section key={id}>
                      <h4>{project.name}</h4>
                      <p className="comparison-contract-count">
                        {count(contracts.length)}{" "}
                        {contractQuery ? "matching" : "unique"}{" "}
                        {contracts.length === 1 ? "contract" : "contracts"}
                      </p>
                      {!contracts.length && (
                        <p className="comparison-unavailable">
                          {contractQuery
                            ? "No contracts match this search."
                            : "No deployments in this network scope."}
                        </p>
                      )}
                      <ol>
                        {contracts.slice(0, limit).map((hook) => {
                          const key = `${id}:${hook.chain}:${hook.address}`;
                          const enabled = COMPARISON_CALLBACKS.filter(
                            (callback) => hook.flags[callback] === true,
                          );
                          const known = COMPARISON_CALLBACKS.filter(
                            (callback) =>
                              typeof hook.flags[callback] === "boolean",
                          );
                          return (
                            <li key={key}>
                              <span className="comparison-contract-chain">
                                {chainName(hook.chain)} ·{" "}
                                {hook.discovery === "onchain"
                                  ? "Onchain discovery"
                                  : hook.discovery === "published"
                                    ? "Published deployment"
                                    : "Registry entry"}
                              </span>
                              <strong>{hook.name}</strong>
                              <div className="comparison-contract-address">
                                <code>{hook.address}</code>
                                <button
                                  className="icon-button"
                                  type="button"
                                  onClick={() =>
                                    void copyAddress(key, hook.address)
                                  }
                                  aria-label={`Copy ${hook.name} address on ${chainName(hook.chain)}`}
                                >
                                  {copiedContract === key ? (
                                    <Check size={14} />
                                  ) : (
                                    <Copy size={14} />
                                  )}
                                </button>
                              </div>
                              <div className="comparison-contract-links">
                                <External href={hook.explorerUrl}>
                                  Explorer
                                </External>
                                <External href={hook.sourceUrl}>
                                  Source
                                </External>
                                {hook.auditUrl && (
                                  <External href={hook.auditUrl}>
                                    Published audit
                                  </External>
                                )}
                              </div>
                              <details>
                                <summary>
                                  {known.length
                                    ? `${enabled.length} enabled ${enabled.length === 1 ? "callback" : "callbacks"}`
                                    : "Callback permissions unavailable"}
                                  <ChevronDown size={13} />
                                </summary>
                                <div className="comparison-contract-flags">
                                  {enabled.map((callback) => (
                                    <code key={callback}>{callback}</code>
                                  ))}
                                  {!enabled.length && (
                                    <span>
                                      No enabled callbacks in the available
                                      metadata.
                                    </span>
                                  )}
                                  {known.length <
                                    COMPARISON_CALLBACKS.length && (
                                    <span>
                                      {COMPARISON_CALLBACKS.length -
                                        known.length}{" "}
                                      callback permissions unknown
                                    </span>
                                  )}
                                </div>
                              </details>
                            </li>
                          );
                        })}
                      </ol>
                      {contracts.length > limit && (
                        <button
                          type="button"
                          className="control"
                          onClick={() =>
                            setContractLimits((previous) => ({
                              ...previous,
                              [id]: limit + 5,
                            }))
                          }
                        >
                          Show more {project.name} contracts
                        </button>
                      )}
                    </section>
                  );
                })}
              </div>
            </div>
          </details>
          <details className="comparison-methodology comparison-disclosure">
            <summary>
              Where these comparisons come from
              <ChevronDown
                size={16}
                className="comparison-disclosure-chevron"
              />
            </summary>
            <div>
              <p>
                {STATIC_EDITION
                  ? "Pool counts are the pools measured in this snapshot (an observed sample, labelled as such)."
                  : "Pool totals come from indexed initialization events when available. An observed sample is labeled explicitly."}{" "}
                Neither pool counts nor contract counts measure adoption.
              </p>
              <p>
                USD amounts sum actual attributed pool measurements. Pools
                without prices are excluded; zero stays zero, missing stays
                missing. Each cell shows its contributing pools, source and{" "}
                {STATIC_EDITION
                  ? "the UTC time of its oldest measurement"
                  : "original measurement age"}
                . Different coverage and measurement times can make rankings
                misleading.
              </p>
              <p>
                Hook properties and source verification are registry or
                published configuration declarations. Newly discovered contracts
                remain unclassified. Verification is not an audit, endorsement
                or safety rating. Open a project to inspect its individual
                deployments.
              </p>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
