import { useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  HookDeployment,
  FrontierExtensionsResponse,
  FrontierExtension,
  FrontierBoundExtension,
} from "../../shared/types";
import {
  isFrontierExtensionsResponse,
  summarizeExtensionCatalog,
} from "../extensions";
import { rememberFrontierExtensionCount } from "../useFrontierExtensionCount";
import { count, relativeTime, shortAddress } from "../model";
import { External } from "./Primitives";
import {
  ArrowRight,
  ChevronDown,
  ChevronLeft,
  Copy,
  Layers,
  RefreshCw,
} from "./Icons";
import "./extensions.css";

const groupNames = {
  feeCalculator: "Trading fees",
  observer: "After-swap actions",
  feeRecipient: "Fee destination",
} as const;

/** Plain-language role of each stage. Purposes of individual modules come from
 * Frontier's published catalog; these lines only describe the stage itself. */
const stageNotes = {
  feeCalculator: "Fee calculators set the swap fee for this pool.",
  observer: "Contracts this pool calls after each swap.",
  feeRecipient: "Where this pool’s trading fees are sent.",
} as const;
const catalogStageNotes = {
  feeCalculator: "Modules that can set a pool’s swap fee.",
  observer: "Modules a pool can call after each swap.",
  feeRecipient: "Destinations a pool can send its trading fees to.",
} as const;

type CopyAction = (text: string, success: string) => Promise<void>;

function fixedFeeLabel(value: string): string | null {
  const pips = Number(value);
  return Number.isSafeInteger(pips) && pips >= 0 && pips <= 1000000
    ? `${(pips / 10000).toLocaleString(undefined, { maximumFractionDigits: 4 })}%`
    : null;
}

/** Published Frontier modules and exact per-pool configuration stay separate. */
export function HookExtensions({
  deployment,
  networkName,
  copy,
  selection,
  onSelectionChange,
  onSettled,
}: {
  deployment: HookDeployment;
  networkName: string;
  copy: CopyAction;
  selection: string | null;
  onSelectionChange: (poolId: string | null, reveal?: boolean) => void;
  onSettled: (poolId: string) => void;
}) {
  const expanded = selection !== null;
  const selectedPool = selection || "";
  const [result, setResult] = useState<{
    key: string;
    data: FrontierExtensionsResponse;
  } | null>(null);
  const [choices, setChoices] = useState<FrontierExtensionsResponse["pools"]>(
    [],
  );
  const [totalPools, setTotalPools] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [scopeUnavailable, setScopeUnavailable] = useState(false);
  const [retry, setRetry] = useState(0);
  const [settled, setSettled] = useState<{
    key: string;
    flight: object;
  } | null>(null);
  const settledFlight = useRef<object | null>(null);
  const panelId = useId();
  const headingId = useId();
  const selectId = useId();
  const poolSelector = useRef<HTMLSelectElement>(null);
  const hookAddress = deployment.address.toLowerCase();
  const requestKey = `${deployment.chainId}:${hookAddress}:${selectedPool}`;
  const data = result?.key === requestKey ? result.data : null;
  const selectedChoice = choices.find((pool) => pool.poolId === selectedPool);
  const duplicatePoolNames = useMemo(() => {
    const names = new Map<string, number>();
    for (const pool of choices)
      names.set(pool.name, (names.get(pool.name) || 0) + 1);
    return names;
  }, [choices]);
  const availableCount = data?.catalog.filter(
    (extension) => extension.status === "active",
  ).length;
  const catalogNames = useMemo(
    () =>
      new Map(
        data?.catalog.map((extension) => [extension.id, extension.name]) || [],
      ),
    [data?.catalog],
  );

  useEffect(() => {
    setResult(null);
    setChoices([]);
    setTotalPools(0);
    setError("");
    setScopeUnavailable(false);
  }, [hookAddress, deployment.chainId]);

  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    const flight = {};
    settledFlight.current = null;
    let active = true;
    const timer = setTimeout(() => controller.abort(), 30000);
    setLoading(true);
    setSettled(null);
    setError("");
    setScopeUnavailable(false);
    const params = new URLSearchParams({ hook: hookAddress });
    if (selectedPool) params.set("pool", selectedPool);
    void fetch(`/api/projects/frontier/extensions?${params}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          if (response.status === 400) {
            if (active && !selectedPool) {
              setScopeUnavailable(true);
              setResult(null);
              setChoices([]);
              setTotalPools(0);
            }
            throw new Error(
              selectedPool
                ? "This pool couldn’t be matched to Frontier’s public configuration. Choose another pool or try again."
                : "Frontier’s published configuration doesn’t confirm this hook address. You can still explore its contract details.",
            );
          }
          throw new Error(
            "We couldn’t load these extensions. Please try again.",
          );
        }
        const value: unknown = await response.json();
        if (
          !isFrontierExtensionsResponse(
            value,
            hookAddress,
            selectedPool || null,
          )
        )
          throw new Error(
            "The extension data couldn’t be read. Please try again.",
          );
        if (controller.signal.aborted || !active) return;
        rememberFrontierExtensionCount(summarizeExtensionCatalog(value));
        setResult({ key: requestKey, data: value });
        setChoices(value.pools);
        setTotalPools(value.totalPools);
      })
      .catch((failure) => {
        if (!active) return;
        setError(
          controller.signal.aborted
            ? "Loading took longer than expected. Please try again."
            : failure instanceof Error &&
                !["TypeError", "SyntaxError"].includes(failure.name)
              ? failure.message
              : "Extensions could not load. Check your connection and retry.",
        );
      })
      .finally(() => {
        clearTimeout(timer);
        if (active) {
          setLoading(false);
          settledFlight.current = flight;
          setSettled({ key: requestKey, flight });
        }
      });
    return () => {
      active = false;
      settledFlight.current = null;
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    expanded,
    hookAddress,
    selectedPool,
    deployment.chainId,
    requestKey,
    retry,
  ]);

  useEffect(() => {
    if (!expanded || settled?.key !== requestKey) return;
    const frame = requestAnimationFrame(() => {
      if (settledFlight.current === settled.flight) onSettled(selectedPool);
    });
    return () => cancelAnimationFrame(frame);
  }, [expanded, settled, requestKey, selectedPool, onSettled]);

  const unavailable = Boolean(
    data && (selectedPool ? !data.pool : data.catalogStatus === "unavailable"),
  );
  const hasContent = Boolean(
    data && (selectedPool ? data.pool : data.catalog.length),
  );
  const showingPreviousData = Boolean(error && hasContent);
  const configured =
    selectedPool && data?.pool && !unavailable && !scopeUnavailable
      ? data.pool
      : null;
  const moduleCount = configured
    ? configured.feeCalculators.length +
      configured.observers.length +
      (configured.feeRecipient ? 1 : 0)
    : 0;
  const pipelineState = scopeUnavailable
    ? "unlinked"
    : configured
      ? "pool"
      : selectedPool
        ? "pending"
        : "catalog";

  return (
    <section className="hook-extensions" data-expanded={expanded || undefined}>
      <button
        className="extensions-toggle"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => onSelectionChange(expanded ? null : "")}
      >
        <Layers size={16} />
        <span className="extensions-toggle-text">Explore extensions</span>
        {!scopeUnavailable &&
          !selectedPool &&
          availableCount !== undefined &&
          availableCount > 0 && (
            <span className="extension-count">
              {count(availableCount)} available
            </span>
          )}
        <ChevronDown size={15} className={expanded ? "rotate" : ""} />
      </button>
      {expanded && (
        <div
          id={panelId}
          className="extension-panel"
          role="region"
          aria-labelledby={headingId}
          aria-busy={loading}
          data-state={pipelineState}
        >
          <div className="extension-panel-head">
            <h3 id={headingId} className="extension-heading">
              Extensions for {deployment.name || "this hook"}
            </h3>
            <p className="extension-intro">
              {selectedPool && !scopeUnavailable
                ? "The exact modules Frontier publishes for the selected pool."
                : choices.length > 0 && !scopeUnavailable
                  ? "Choose a pool to inspect its configuration, or browse the published catalog."
                  : "Frontier’s published extension catalog."}
            </p>
          </div>
          <ol className="extension-pipeline" aria-label="Configuration path">
            <li className="pipeline-node" data-step="hook">
              <span className="pipeline-label">
                <span aria-hidden="true">1</span> Hook
              </span>
              <span className="pipeline-value">
                {deployment.name || "Hook contract"}
              </span>
              <span className="pipeline-meta">
                <code title={deployment.address}>
                  {shortAddress(deployment.address)}
                </code>
                <span aria-hidden="true"> · </span>
                {networkName}
              </span>
            </li>
            <li
              className="pipeline-node"
              data-step="pool"
              data-active={Boolean(selectedPool) || undefined}
            >
              <span className="pipeline-label">
                <span aria-hidden="true">2</span> Pool
              </span>
              {choices.length > 0 && !scopeUnavailable ? (
                <div className="extension-selector">
                  <label htmlFor={selectId}>View extensions for</label>
                  <div className="select-control">
                    <select
                      id={selectId}
                      ref={poolSelector}
                      value={selectedPool}
                      onChange={(event) =>
                        onSelectionChange(event.target.value, false)
                      }
                    >
                      <option value="">Frontier’s extension catalog</option>
                      {choices.map((pool) => (
                        <option key={pool.poolId} value={pool.poolId}>
                          {(duplicatePoolNames.get(pool.name) || 0) > 1
                            ? `${pool.name} · ${shortAddress(pool.poolId)}`
                            : pool.name}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={14} />
                  </div>
                  {totalPools > choices.length && (
                    <p className="extension-choice-note">
                      Showing {count(choices.length)} of {count(totalPools)}{" "}
                      pool choices for this hook.
                    </p>
                  )}
                </div>
              ) : (
                <span className="pipeline-value pipeline-muted">
                  {scopeUnavailable
                    ? "Not linked to Frontier’s configuration"
                    : loading && !data
                      ? "Checking published pools…"
                      : "No pool choices published"}
                </span>
              )}
              {configured && (
                <button
                  className="extension-pool-identity"
                  title={`Copy pool ID: ${configured.poolId}`}
                  aria-label="Copy pool ID"
                  onClick={() =>
                    void copy(configured.poolId, "Pool ID copied.")
                  }
                >
                  <code>{shortAddress(configured.poolId)}</code>
                  <Copy size={13} />
                </button>
              )}
            </li>
            <li
              className="pipeline-node"
              data-step="modules"
              data-active={Boolean(configured) || undefined}
            >
              <span className="pipeline-label">
                <span aria-hidden="true">3</span> Modules
              </span>
              <span
                className={`pipeline-value ${configured ? "" : "pipeline-muted"}`}
              >
                {configured
                  ? moduleCount
                    ? `${count(moduleCount)} ${moduleCount === 1 ? "module" : "modules"} on this pool`
                    : "No modules on this pool"
                  : scopeUnavailable || unavailable
                    ? "Unavailable"
                    : loading
                      ? "Reading configuration…"
                      : error
                        ? "Not loaded"
                        : selectedPool
                          ? "—"
                          : data
                            ? "Choose a pool to see its modules"
                            : "—"}
              </span>
            </li>
          </ol>
          {loading && (
            <p className="extension-state extension-loading" role="status">
              <RefreshCw size={14} className="spin" />
              {selectedPool
                ? "Loading this pool’s extensions…"
                : "Loading extensions…"}
            </p>
          )}
          {loading && !hasContent && (
            <div className="extension-skeleton" aria-hidden="true">
              {[0, 1, 2].map((value) => (
                <span className="skeleton" key={value} />
              ))}
            </div>
          )}
          {error && (
            <div className="extension-state" role="alert">
              <strong>
                {scopeUnavailable
                  ? "Extensions aren’t linked to this hook"
                  : "Extensions couldn’t be loaded"}
              </strong>
              <p>{error}</p>
              {!scopeUnavailable && (
                <button
                  className="control"
                  disabled={loading}
                  onClick={() => setRetry((value) => value + 1)}
                >
                  <RefreshCw size={14} /> Try again
                </button>
              )}
            </div>
          )}
          {!loading && !error && unavailable && (
            <div className="extension-state" role="status">
              <strong>
                {selectedPool
                  ? "This pool’s configuration is unavailable"
                  : "The extension catalog is unavailable"}
              </strong>
              <p>
                Frontier’s public source couldn’t be reached. Try again shortly.
              </p>
              <button
                className="control"
                disabled={loading}
                onClick={() => setRetry((value) => value + 1)}
              >
                <RefreshCw size={14} /> Try again
              </button>
            </div>
          )}
          {data && !unavailable && !scopeUnavailable && hasContent && (
            <>
              {selectedPool && data.pool ? (
                <>
                  <div className="extension-view-heading">
                    <div className="extension-view-title">
                      <h4>{selectedChoice?.name || "Selected pool"}</h4>
                      <button
                        className="extension-back"
                        onClick={() => {
                          onSelectionChange("", false);
                          poolSelector.current?.focus();
                        }}
                      >
                        <ChevronLeft size={14} /> Browse catalog
                      </button>
                    </div>
                    <p>
                      Enabled for this pool. Extensions run in the order shown
                      within each group.
                    </p>
                  </div>
                  <ConfiguredExtensions
                    config={data.pool}
                    copy={copy}
                    networkName={networkName}
                    explorer={deployment.explorerUrl}
                  />
                </>
              ) : (
                <>
                  <div className="extension-view-heading">
                    <h4>Frontier’s extension catalog</h4>
                    <p>
                      {data.hookGeneration === "legacy"
                        ? "This is an earlier hook. The catalog shows Frontier’s current release; choose a pool to see what it uses."
                        : "Available in Frontier’s current release. Each pool chooses its own extensions."}
                    </p>
                  </div>
                  <p className="extension-catalog-caveat">
                    The catalog lists modules Frontier publishes. It doesn’t
                    show what any pool runs — choose a pool above for its exact
                    configuration.
                  </p>
                  <div className="extension-catalog" data-mode="catalog">
                    {(
                      Object.keys(groupNames) as (keyof typeof groupNames)[]
                    ).map((kind, index) => {
                      const extensions = data.catalog.filter(
                        (extension) => extension.kind === kind,
                      );
                      return extensions.length ? (
                        <section className="extension-group" key={kind}>
                          <span className="extension-stage" aria-hidden="true">
                            {index + 1}
                          </span>
                          <div className="extension-stage-body">
                            <h4 className="extension-group-title">
                              {groupNames[kind]}
                            </h4>
                            <p className="extension-stage-note">
                              {catalogStageNotes[kind]}
                            </p>
                            {extensions.map((extension) => (
                              <ExtensionCard
                                key={extension.id}
                                extension={extension}
                                parentName={
                                  extension.leafOf
                                    ? catalogNames.get(extension.leafOf) ||
                                      extension.leafOf
                                    : undefined
                                }
                                copy={copy}
                                explorer={deployment.explorerUrl}
                              />
                            ))}
                          </div>
                        </section>
                      ) : null;
                    })}
                  </div>
                </>
              )}
            </>
          )}
          {data &&
            !unavailable &&
            !scopeUnavailable &&
            !hasContent &&
            !loading &&
            !error && (
              <div className="extension-state">
                <strong>No extensions listed</strong>
                <p>
                  Frontier’s catalog doesn’t list any modules for this network
                  yet.
                </p>
              </div>
            )}
          {data && !scopeUnavailable && (
            <div
              className="extension-source"
              data-state={
                showingPreviousData || data.status === "cached"
                  ? "stale"
                  : "current"
              }
            >
              <span className="extension-source-time">
                {data.updatedAt ? (
                  <time
                    dateTime={data.updatedAt}
                    title={new Date(data.updatedAt).toLocaleString()}
                  >
                    {showingPreviousData ? "Last loaded" : "Updated"}{" "}
                    {relativeTime(data.updatedAt)}
                  </time>
                ) : (
                  "Update time unavailable"
                )}
                {showingPreviousData
                  ? " · previously loaded data"
                  : data.status === "cached"
                    ? " · saved data"
                    : ""}
              </span>
              <External href={data.sourceUrl}>View source data</External>
              <button
                className="control"
                disabled={loading}
                onClick={() => setRetry((value) => value + 1)}
              >
                <RefreshCw size={14} /> Refresh extensions
              </button>
              {(data.status === "cached" || showingPreviousData) && (
                <p className="extension-cache-note">
                  {showingPreviousData
                    ? "Showing previously loaded data. The latest refresh didn’t complete."
                    : "Showing previously loaded data while Frontier’s source is unavailable."}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ConfiguredExtensions({
  config,
  copy,
  networkName,
  explorer,
}: {
  config: NonNullable<FrontierExtensionsResponse["pool"]>;
  copy: CopyAction;
  networkName: string;
  explorer: string;
}) {
  const detailsId = useId();
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const fixedFee = fixedFeeLabel(config.hookConfig.fixedFee);
  return (
    <div className="extension-catalog" data-mode="pool">
      {(
        [
          [
            "feeCalculator",
            "Trading fees",
            config.feeCalculators,
            "No fee-calculator extensions are listed for this pool.",
          ],
          [
            "observer",
            "After-swap actions",
            config.observers,
            "No after-swap actions are listed for this pool.",
          ],
        ] as const
      ).map(([kind, heading, extensions, empty], index) => (
        <section className="extension-group" key={heading}>
          <span className="extension-stage" aria-hidden="true">
            {index + 1}
          </span>
          <div className="extension-stage-body">
            <h4 className="extension-group-title">{heading}</h4>
            <p className="extension-stage-note">{stageNotes[kind]}</p>
            {extensions.length ? (
              <ol className="extension-sequence">
                {extensions.map((extension, order) => (
                  <li key={`${extension.address}:${order}`}>
                    <ExtensionCard
                      extension={extension}
                      sequence={order + 1}
                      copy={copy}
                      explorer={explorer}
                    />
                    {order < extensions.length - 1 && (
                      <ArrowRight
                        size={14}
                        className="extension-sequence-arrow"
                      />
                    )}
                  </li>
                ))}
              </ol>
            ) : heading === "Trading fees" && fixedFee !== null ? (
              <div className="extension-group-empty extension-fixed-fee">
                <strong>Fixed fee · {fixedFee}</strong>
                <p>
                  This pool uses a fixed fee instead of fee-calculator
                  extensions.
                </p>
              </div>
            ) : (
              <p className="extension-group-empty">{empty}</p>
            )}
          </div>
        </section>
      ))}
      <section className="extension-group">
        <span className="extension-stage" aria-hidden="true">
          3
        </span>
        <div className="extension-stage-body">
          <h4 className="extension-group-title">Fee destination</h4>
          <p className="extension-stage-note">{stageNotes.feeRecipient}</p>
          {config.feeRecipient ? (
            <ExtensionCard
              extension={config.feeRecipient}
              copy={copy}
              explorer={explorer}
            />
          ) : (
            <p className="extension-group-empty">
              No custom fee destination is listed.
            </p>
          )}
        </div>
      </section>
      <div className="extension-config-details">
        <button
          className="detail-disclosure"
          aria-expanded={detailsExpanded}
          aria-controls={detailsId}
          onClick={() => setDetailsExpanded((value) => !value)}
        >
          Pool configuration details{" "}
          <ChevronDown size={14} className={detailsExpanded ? "rotate" : ""} />
        </button>
        {detailsExpanded && (
          <div id={detailsId} className="extension-technical">
            <p className="extension-description">
              Raw values from Frontier’s published configuration for this pool.
            </p>
            <dl>
              <div className="extension-config-field">
                <dt>Network</dt>
                <dd>{networkName}</dd>
              </div>
              <div className="extension-config-field">
                <dt>Pool ID</dt>
                <dd>
                  <code>{config.poolId}</code>
                </dd>
              </div>
              <div className="extension-config-field">
                <dt>Coin address</dt>
                <dd>
                  <code>{config.coinAddress}</code>
                </dd>
              </div>
              {config.protocolFeeRatio !== null && (
                <div className="extension-config-field">
                  <dt>Protocol fee ratio</dt>
                  <dd>{config.protocolFeeRatio}</dd>
                </div>
              )}
              {config.hookConfig &&
                Object.entries(config.hookConfig).map(([key, value]) => (
                  <div className="extension-config-field" key={key}>
                    <dt>{key}</dt>
                    <dd>
                      <code>{String(value)}</code>
                    </dd>
                  </div>
                ))}
            </dl>
          </div>
        )}
      </div>
    </div>
  );
}

function ExtensionCard({
  extension,
  sequence,
  parentName,
  copy,
  explorer,
}: {
  extension: FrontierExtension | FrontierBoundExtension;
  sequence?: number;
  parentName?: string;
  copy: CopyAction;
  explorer: string;
}) {
  const detailsId = useId();
  const [expanded, setExpanded] = useState(false);
  const catalogEntry = "status" in extension ? extension : null;
  const configured = "known" in extension ? extension : null;
  const address = extension.address;
  const explorerUrl = address
    ? explorer.replace(/0x[\da-fA-F]{40}(?:[/?#].*)?$/, address)
    : null;
  const purpose =
    extension.purpose ||
    (configured?.kind === "feeRecipient"
      ? "Trading fees are directed to this payout address."
      : configured?.kind === "observer"
        ? "A custom after-swap contract is enabled for this pool."
        : configured
          ? "A custom fee calculator is enabled for this pool."
          : extension.description);
  const unrecognized =
    configured && !configured.known && configured.kind !== "feeRecipient";
  return (
    <article
      className="extension-card"
      data-status={
        catalogEntry
          ? catalogEntry.status
          : unrecognized
            ? "unrecognized"
            : configured?.kind === "feeRecipient" && !configured.known
              ? "recipient"
              : "configured"
      }
      data-expanded={expanded || undefined}
    >
      <div className="extension-title">
        <h4>
          {sequence !== undefined && (
            <span className="extension-order">{sequence}</span>
          )}
          {extension.name}
        </h4>
        <span className="extension-badges">
          {unrecognized && (
            <span
              className="extension-flag"
              title="This contract address isn’t named in Frontier’s current catalog."
            >
              Not in catalog
            </span>
          )}
          <span
            className={`extension-kind ${catalogEntry?.status === "coming-soon" ? "coming-soon" : ""}`}
          >
            {catalogEntry
              ? catalogEntry.status === "coming-soon"
                ? "Coming soon"
                : "Available"
              : configured?.kind === "feeRecipient" && !configured.known
                ? "Configured"
                : "Enabled"}
          </span>
        </span>
      </div>
      {purpose && <p className="extension-description">{purpose}</p>}
      {catalogEntry?.leafOf && (
        <p className="extension-parent">
          Used with {parentName || catalogEntry.leafOf}
        </p>
      )}
      <div className="extension-card-foot">
        {address && (
          <code className="extension-address" title={address}>
            {shortAddress(address)}
          </code>
        )}
        <button
          className="detail-disclosure"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => setExpanded((value) => !value)}
        >
          Technical details{" "}
          <ChevronDown size={14} className={expanded ? "rotate" : ""} />
        </button>
      </div>
      {expanded && (
        <div id={detailsId} className="extension-technical">
          {catalogEntry?.description &&
            catalogEntry.description !== catalogEntry.purpose && (
              <p className="extension-description">
                {catalogEntry.description}
              </p>
            )}
          {address && (
            <>
              <span className="contract-caption">
                {catalogEntry && catalogEntry.implId !== null
                  ? "Published contract / factory"
                  : "Contract address"}
              </span>
              <div className="address-row">
                <code title={address}>{address}</code>
                <button
                  className="icon-button"
                  aria-label={`Copy ${extension.name} ${shortAddress(address)} address`}
                  onClick={() =>
                    void copy(address, "Extension address copied.")
                  }
                >
                  <Copy size={14} />
                </button>
              </div>
            </>
          )}
          <dl>
            {extension.id && (
              <div className="extension-config-field">
                <dt>Catalog ID</dt>
                <dd>{extension.id}</dd>
              </div>
            )}
            <div className="extension-config-field">
              <dt>Role</dt>
              <dd>{groupNames[extension.kind]}</dd>
            </div>
            {catalogEntry && (
              <>
                <div className="extension-config-field">
                  <dt>Supported roles</dt>
                  <dd>
                    {catalogEntry.roles
                      .map((role) => groupNames[role])
                      .join(", ")}
                  </dd>
                </div>
                <div className="extension-config-field">
                  <dt>Order rank</dt>
                  <dd>{catalogEntry.orderRank}</dd>
                </div>
                <div className="extension-config-field">
                  <dt>Provides base fee</dt>
                  <dd>{catalogEntry.baseFeeProvider ? "Yes" : "No"}</dd>
                </div>
              </>
            )}
            {catalogEntry?.leafOf && (
              <div className="extension-config-field">
                <dt>Parent extension</dt>
                <dd>{catalogEntry.leafOf}</dd>
              </div>
            )}
            {catalogEntry && catalogEntry.implId !== null && (
              <div className="extension-config-field">
                <dt>Implementation ID</dt>
                <dd>
                  <code>{catalogEntry.implId}</code>
                </dd>
              </div>
            )}
            {configured?.rawConfig && (
              <div className="extension-config-field">
                <dt>Raw configuration</dt>
                <dd>
                  <code>
                    {configured.rawConfig.length > 130
                      ? `${configured.rawConfig.slice(0, 66)}…${configured.rawConfig.slice(-64)}`
                      : configured.rawConfig}
                  </code>
                  {configured.rawConfig.length > 130 && (
                    <span className="extension-raw-size">
                      {count((configured.rawConfig.length - 2) / 2)} bytes ·
                      preview
                    </span>
                  )}
                </dd>
              </div>
            )}
          </dl>
          {configured?.rawConfig && (
            <button
              className="control extension-copy-config"
              onClick={() =>
                void copy(configured.rawConfig!, "Raw configuration copied.")
              }
            >
              <Copy size={14} /> Copy raw configuration
            </button>
          )}
          {catalogEntry?.legacyAddresses &&
            catalogEntry.legacyAddresses.length > 0 && (
              <p className="extension-description extension-legacy">
                Earlier contract addresses:{" "}
                {catalogEntry.legacyAddresses.map((value) => (
                  <code key={value}>{value}</code>
                ))}
              </p>
            )}
          {catalogEntry && catalogEntry.legacyImplIds.length > 0 && (
            <p className="extension-description extension-legacy">
              Earlier implementation IDs:{" "}
              {catalogEntry.legacyImplIds.map((value) => (
                <code key={value}>{value}</code>
              ))}
            </p>
          )}
          {unrecognized && (
            <p className="extension-description">
              This contract isn’t named in Frontier’s current catalog.
            </p>
          )}
          <div className="extension-technical-links">
            <External href={extension.docsUrl}>
              {configured && !configured.known
                ? "Extension system docs"
                : "Extension docs"}
            </External>
            <External href={explorerUrl}>View on explorer</External>
          </div>
        </div>
      )}
    </article>
  );
}
