import { useId, useState, type ReactNode } from "react";
import type { RadarEvent, SourceStatus } from "../../shared/types";
import { relativeTime, safeUrl } from "../model";
import { ChevronDown, Radio, RefreshCw } from "./Icons";
import "./registry-updates.css";
import { STATIC_EDITION, fullTimeLabel } from "../edition";

export function RegistryUpdates({
  events,
  scopedEvents,
  loading,
  scopedLoading,
  error,
  scopedError,
  scopedSyncing,
  registry,
  now,
  recovering,
  watchlist,
  onRefresh,
  onRetryScope,
  onOpen,
  chainName,
  children,
}: {
  events: RadarEvent[];
  scopedEvents: RadarEvent[];
  loading: boolean;
  scopedLoading: boolean;
  error: string;
  scopedError: string;
  scopedSyncing: boolean;
  registry?: SourceStatus;
  now: number;
  recovering: boolean;
  watchlist: boolean;
  onRefresh: () => void;
  onRetryScope: () => void;
  onOpen: (event: RadarEvent) => void;
  chainName: (slug: string) => string;
  children?: ReactNode;
}) {
  const id = useId();
  const [scope, setScope] = useState<"all" | "view">("all");
  const [limit, setLimit] = useState(4);
  const inView = scope === "view";
  const items = inView ? scopedEvents : events;
  const busy = inView ? scopedLoading : loading;
  const failure = inView ? scopedError || error : error;
  const syncing = inView && scopedSyncing;
  const retry = inView ? onRetryScope : onRefresh;
  const registryDate =
    registry?.updatedAt && Number.isFinite(Date.parse(registry.updatedAt))
      ? registry.updatedAt
      : null;
  const changeScope = (value: "all" | "view") => {
    setScope(value);
    setLimit(4);
  };
  // The snapshot's collector records no registry changes, so the feed could never
  // fill: only the page's own shortcut (the children) is left.
  if (STATIC_EDITION && events.length === 0 && scopedEvents.length === 0)
    return children ? (
      <div className="registry-updates registry-shortcut">{children}</div>
    ) : null;
  return (
    <section
      className="panel signal-panel registry-updates"
      aria-labelledby={`${id}-title`}
    >
      <div className="panel-heading">
        <div>
          <span className="registry-kicker">
            Directory · observed changes
          </span>
          <h2 id={`${id}-title`}>Latest hook updates</h2>
        </div>
        {!STATIC_EDITION && (
          <button
            className="registry-refresh icon-button"
            aria-label="Refresh hook updates"
            title="Refresh hook updates"
            disabled={busy || recovering}
            onClick={retry}
          >
            <RefreshCw size={16} />
          </button>
        )}
      </div>
      <fieldset className="registry-scope segmented">
        <legend className="sr-only">Update scope</legend>
        {(
          [
            ["all", "All updates"],
            ["view", "This view"],
          ] as const
        ).map(([value, label]) => (
          <label key={value}>
            <input
              type="radio"
              name={`${id}-scope`}
              value={value}
              checked={scope === value}
              onChange={() => changeScope(value)}
            />
            <span>{label}</span>
          </label>
        ))}
      </fieldset>
      <p className="registry-scope-note">
        {inView
          ? watchlist
            ? "Your saved projects and selected filters"
            : "Your current discovery filters"
          : "Across all hooks and networks"}
      </p>
      {items.length > 0 ? (
        <>
          {(failure || busy || syncing || recovering) && (
            <p className="registry-feedback" role="status">
              {recovering
                ? "Showing saved updates during recovery."
                : failure
                  ? "Couldn’t refresh. Showing saved updates."
                  : syncing
                    ? "Some updates are still syncing."
                    : "Updating…"}
              {failure && !recovering && (
                <button onClick={retry} disabled={busy}>
                  Retry updates
                </button>
              )}
            </p>
          )}
          <div
            className="signal-events"
            role="region"
            aria-label="Hook updates"
            tabIndex={0}
          >
            {items.slice(0, limit).map((event) => (
              <button
                key={event.id}
                className="signal-event"
                onClick={() => onOpen(event)}
                disabled={!event.projectId && !safeUrl(event.url)}
              >
                <span
                  className={`event-dot ${event.type === "new-deployment" ? "teal" : ""}`}
                  aria-hidden="true"
                />
                <span className="signal-copy">
                  <span className="registry-event-meta">
                    <span>
                      {event.type === "new-project"
                        ? "Discovery"
                        : event.type === "new-deployment"
                          ? "Hook added"
                          : event.type === "metadata-change"
                            ? "Project update"
                            : "Update"}
                    </span>
                    {event.chain && <span>{chainName(event.chain)}</span>}
                  </span>
                  <strong>{event.title}</strong>
                  <small>{event.description}</small>
                </span>
                <time
                  dateTime={event.timestamp}
                  title={`Observed ${STATIC_EDITION ? (fullTimeLabel(event.timestamp) ?? "an unknown time") : new Date(event.timestamp).toLocaleString()}`}
                >
                  {relativeTime(event.timestamp, now)}
                </time>
              </button>
            ))}
          </div>
          {items.length > 4 && (
            <button
              className="registry-more"
              aria-expanded={limit > 4}
              onClick={() =>
                setLimit((value) => (value >= items.length ? 4 : value + 4))
              }
            >
              {limit >= items.length
                ? "Show fewer updates"
                : "Show more updates"}{" "}
              <ChevronDown size={14} />
              {items.length > limit && <span>{items.length - limit} more</span>}
            </button>
          )}
        </>
      ) : (
        <div className="quiet-feed" role="status">
          <Radio size={22} />
          <strong>
            {recovering
              ? "Updates resume after recovery"
              : busy
                ? "Loading updates…"
                : failure
                  ? "Updates couldn’t load"
                  : syncing
                    ? "Updates are syncing"
                    : inView
                      ? "No updates in this view"
                      : "No updates recorded yet"}
          </strong>
          <p>
            {recovering
              ? "Your saved data is available while the service starts."
              : busy
                ? "Checking the latest recorded changes."
                : failure
                  ? "The feed couldn’t refresh. Try again to load the latest recorded changes."
                  : syncing
                    ? "The directory has newer updates. Refresh to load them."
                    : inView
                      ? "No recorded updates match your current filters or saved projects."
                      : "New hooks and project changes will appear here when detected."}
          </p>
          {!busy &&
            !recovering &&
            (failure || syncing ? (
              <button className="registry-empty-action" onClick={retry}>
                Retry updates
              </button>
            ) : (
              inView && (
                <button
                  className="registry-empty-action"
                  onClick={() => changeScope("all")}
                >
                  See all updates
                </button>
              )
            ))}
        </div>
      )}
      <div className="registry-footnote">
        <span>Observed changes, not deployment dates.</span>
        {registryDate && (
          <span
            title={
              STATIC_EDITION
                ? (fullTimeLabel(registryDate) ?? undefined)
                : new Date(registryDate).toLocaleString()
            }
          >
            Registry {registry?.status === "live" ? "checked" : "saved"}{" "}
            {relativeTime(registryDate, now)}
          </span>
        )}
      </div>
      {children}
    </section>
  );
}
