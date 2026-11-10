import { useRef } from "react";
import { ArrowRight, Check, ChevronDown, RefreshCw, Star } from "./Icons";
import type { WatchBaseline, WatchChange } from "../watch-changes";
import { inlineTime, relativeTime } from "../model";
import { STATIC_EDITION, fullTimeLabel, timeLabel, utcDate } from "../edition";
import "./watch-change-feed.css";

const kindLabels: Record<WatchChange["kind"], string> = {
  hooks: "Hook list",
  properties: "Declarations",
  metadata: "Project info",
  pools: "Pool inventory",
};

const exact = (value: string) => new Date(value).toLocaleString();

/** Calendar day of the browser observation (not of any onchain event). */
function observedDay(value: string, now = Date.now()) {
  const date = new Date(value);
  const today = new Date(now);
  const start = (input: Date) =>
    new Date(input.getFullYear(), input.getMonth(), input.getDate()).getTime();
  const days = Math.round((start(today) - start(date)) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

function clock(value: string) {
  return new Date(value).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/* The static edition dates a change by the snapshots it was seen between, in
   UTC, never by the visit in the visitor's own zone. An entry stored before
   snapshot times were kept has only its visit, which is shown as that (still in
   UTC). */
const editionTime = (change: WatchChange) =>
  change.sourceAt ?? change.observedAt;

/** The calendar day a change is grouped under. */
const dayOf = (change: WatchChange) =>
  STATIC_EDITION
    ? utcDate(Date.parse(editionTime(change)))
    : observedDay(change.observedAt);

/** Which two points in time the change lies between, in words. */
function comparedText(change: WatchChange) {
  if (!STATIC_EDITION)
    return `Observed ${exact(change.observedAt)}. Compared with ${exact(change.previousAt)}.`;
  return change.sourceAt && change.previousSourceAt
    ? `Snapshot of ${fullTimeLabel(change.sourceAt)} compared with snapshot of ${fullTimeLabel(change.previousSourceAt)}.`
    : `Observed ${fullTimeLabel(change.observedAt)}. Compared with ${fullTimeLabel(change.previousAt)}.`;
}

export function WatchChangeFeed({
  changes,
  baselines,
  checking,
  error,
  unread,
  storageAvailable,
  total,
  openProject,
  markRead,
  retry,
}: {
  changes: WatchChange[];
  baselines: WatchBaseline[];
  checking: boolean;
  error: string;
  unread: number;
  storageAvailable: boolean;
  total: number;
  openProject: (id: string) => void;
  markRead: () => void;
  retry: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  // The edition compares saved projects with published snapshots, so what it
  // states is the snapshot compared with, never the moment of the visit.
  const latest = baselines
    .map((b) => (STATIC_EDITION ? b.sourceAt : b.checkedAt))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  // Changes are newest first and unread means "observed after the last read",
  // so the unread ones are exactly the leading items.
  const item = (change: WatchChange, index: number, compact = false) => {
    const isUnread = index < unread;
    const day = dayOf(change);
    const previous = index > 0 ? changes[index - 1] : null;
    const showDay = !previous || dayOf(previous) !== day || index === 8;
    return (
      <li
        key={change.id}
        className={`watch-change${isUnread ? " is-unread" : ""}`}
      >
        {showDay && (
          <span className="watch-change-day" aria-hidden="true">
            {day}
          </span>
        )}
        <button
          type="button"
          className="watch-change-open"
          onClick={() => openProject(change.projectId)}
        >
          <span
            className={`watch-change-marker ${change.kind}`}
            aria-hidden="true"
          />
          <span className="watch-change-copy">
            <span className="watch-change-meta">
              <span>{kindLabels[change.kind]}</span>
              {isUnread && <span className="watch-change-new">New</span>}
            </span>
            <strong>{change.name}</strong>
            <span>{change.title}</span>
          </span>
          <time
            dateTime={STATIC_EDITION ? editionTime(change) : change.observedAt}
            title={
              STATIC_EDITION
                ? comparedText(change)
                : `Observed ${exact(change.observedAt)}; compared with ${exact(change.previousAt)}`
            }
          >
            {STATIC_EDITION ? (
              <span>{timeLabel(editionTime(change))}</span>
            ) : (
              <>
                <span>{relativeTime(change.observedAt)}</span>
                <span className="watch-change-clock">
                  {clock(change.observedAt)}
                </span>
              </>
            )}
          </time>
          <ArrowRight size={15} />
        </button>
        {compact ? (
          <p className="watch-change-detail">{change.detail}</p>
        ) : (
          <details>
            <summary>
              View change <ChevronDown size={12} />
            </summary>
            <p>{change.detail}</p>
            <p>{comparedText(change)}</p>
          </details>
        )}
      </li>
    );
  };
  return (
    <section className="watch-updates" aria-labelledby="watch-updates-heading">
      <div className="watch-update-rail">
        <header>
          <span className="watch-update-eyebrow">
            <Star size={13} /> Watchlist updates
          </span>
          <div className="watch-title-row">
            <h2
              id="watch-updates-heading"
              ref={heading}
              tabIndex={STATIC_EDITION ? -1 : undefined}
            >
              What changed
            </h2>
            {unread > 0 && (
              <span
                className="watch-unread"
                role="status"
                aria-label={`${unread} unread updates`}
              >
                {unread} new
              </span>
            )}
          </div>
          <p className="watch-update-description">
            {STATIC_EDITION
              ? "Hook lists, registry declarations and project information for your saved projects."
              : "Hook listings, indexed pools and project details for your saved projects."}
          </p>
          <div className="watch-update-actions">
            {unread > 0 && (
              <button
                type="button"
                className="control"
                onClick={() => {
                  markRead();
                  // The button leaves with the last unread update, and the
                  // focus it holds would be dropped to the page. In the
                  // edition it moves to the panel's heading first.
                  if (STATIC_EDITION)
                    heading.current?.focus({ preventScroll: true });
                }}
              >
                <Check size={14} /> Mark read
              </button>
            )}
          </div>
        </header>
        <footer aria-live="polite">
          <span>
            <span
              className={`status-led ${checking ? "amber" : error ? "amber" : baselines.length ? "green" : ""}`}
              aria-hidden="true"
            />
            {checking
              ? "Checking for changes…"
              : `${baselines.length} of ${total} saved projects tracked`}
            {!checking && latest
              ? STATIC_EDITION
                ? ` · Compared with the snapshot taken ${fullTimeLabel(latest)}`
                : ` · checked ${inlineTime(latest)}`
              : ""}
          </span>
          <span>
            {storageAvailable
              ? "Saved in this browser"
              : "Session only · browser storage unavailable"}
          </span>
        </footer>
      </div>
      <div className="watch-update-body">
        {error && (
          <div className="watch-update-error notice" role="status">
            <span>{error}</span>
            <button type="button" className="control" onClick={retry}>
              <RefreshCw size={14} /> Retry
            </button>
          </div>
        )}
        {changes.length ? (
          <ol className="watch-change-list">
            {changes.slice(0, 8).map((change, index) => item(change, index))}
          </ol>
        ) : (
          <div className="watch-update-empty">
            <span
              className="watch-empty-mark"
              data-state={error || !baselines.length ? "pending" : "ready"}
              aria-hidden="true"
            />
            <div>
              <strong>
                {error && !baselines.length
                  ? "Updates are temporarily unavailable"
                  : checking && !baselines.length
                    ? "Checking your projects…"
                    : "No changes observed yet"}
              </strong>
              <p>
                {baselines.length
                  ? "Your starting point is saved. Future changes will appear here."
                  : "Your first successful check saves a starting point. Future changes will appear here."}
              </p>
              <p className="watch-update-scope">
                Changes are compared in this browser between published
                snapshots. They record when a change was observed, not when it
                happened onchain.
              </p>
            </div>
          </div>
        )}
        {changes.length > 8 && (
          <details className="watch-older">
            <summary>
              Earlier updates · {changes.length - 8} <ChevronDown size={13} />
            </summary>
            <ol className="watch-change-list">
              {changes
                .slice(8)
                .map((change, index) => item(change, index + 8, true))}
            </ol>
          </details>
        )}
      </div>
    </section>
  );
}
