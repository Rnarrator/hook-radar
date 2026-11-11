import { useId } from "react";
import type { Chain, RadarProject } from "../../shared/types";
import { publicViewUrl } from "../navigation";
import { evidenceNote } from "../evidence-note";
import { count, inlineTime, money } from "../model";
import { STATIC_EDITION, evaluationNow, fullTimeLabel } from "../edition";
import {
  isPlainLeftClick,
  lowerBoundMark,
  navigateInPage,
  pricedPoolsNote,
  reviewNotesHeading,
  snapshotTakenNote,
  trackedVolumeNote,
} from "../edition-platform-copy";
import { ProtocolLogo } from "./ProtocolLogo";
import { External } from "./Primitives";
import { LaunchpadPaths } from "./LaunchpadPaths";
import {
  LAUNCHPAD_REVIEWED_AT,
  type LaunchpadRecord,
} from "../../shared/launchpad-registry.ts";
import { ArrowRight, Copy, Info, Network, Star } from "./Icons";
import "./platform-detail.css";

/** Availability of a listed platform or of one platform → protocol link. */
export type PlatformStatus =
  "live" | "restricted" | "deprecated" | "planned" | "unverified";

/** A source-backed link from a launch platform to the protocol (and, through
 * that protocol's own page, the hooks and pools) a launch settles into. A
 * relationship never attributes individual hook contracts or pools to the
 * platform, and it carries no total of its own beyond the measured pools of its own exact hooks (shown in the Launchpads list). */
export interface PlatformRelationship {
  /** Display name of the underlying protocol, e.g. a launch protocol. */
  protocolName: string;
  /** Hook Radar project id when the protocol has its own listing. */
  protocolId?: string | null;
  /** Network slug the relationship applies to. */
  chain: string;
  status: PlatformStatus;
  /** Public document that establishes the relationship. */
  evidenceUrl?: string | null;
  note?: string | null;
}

/** Checked availability of the platform itself. Absent ⇒ "unverified". */
export interface PlatformAvailability {
  status: PlatformStatus;
  /** The finding, as written: its first sentence leads and the rest is listed. */
  note?: string | null;
  /** Who reviewed it and when, shown on its own line (for example
   * "Reviewed from first-party sources on Oct 23, 2026."). */
  reviewed?: string | null;
  evidenceUrl?: string | null;
  /** ISO time of the check that established the status. */
  checkedAt?: string | null;
}

const statusLabels: Record<PlatformStatus, string> = {
  live: "Live",
  restricted: "Restricted",
  deprecated: "Deprecated",
  planned: "Planned",
  unverified: "Unverified",
};

const statusDescriptions: Record<PlatformStatus, string> = {
  live: "The platform's own pages offer launching and trading.",
  restricted: "Available with restrictions, such as region or access limits.",
  deprecated: "No longer used for new launches.",
  planned: "Announced but not yet available.",
  unverified: "Current availability hasn’t been checked by Hook Radar.",
};

export function StatusPill({ status }: { status: PlatformStatus }) {
  return (
    <span
      className="status-pill"
      data-status={status}
      title={statusDescriptions[status]}
    >
      <span className="status-dot" aria-hidden="true" />
      {statusLabels[status]}
    </span>
  );
}

/** Measured pools on the exact hooks a platform publishes, as the Launchpads
 * list derives them (same pass, same five-minute rule). */
export interface PlatformMarket {
  mappedHooks: number;
  hooksWithPools: number;
  /** Pools with a price measurement found on those hooks in the loaded data. */
  pools: number;
  volumeUsd: number | null;
  volumePools: number;
  windowLabel: string;
}

/** Platform membership and observed hook ownership are different facts. */
export function PlatformDetail({
  project,
  chains,
  watchlisted,
  toggleWatch,
  copy,
  relationships,
  availability,
  launchpad,
  market = null,
  marketPending = false,
  openProject,
  canWatch = true,
}: {
  project: RadarProject;
  chains: Chain[];
  watchlisted: boolean;
  toggleWatch: () => void;
  copy: (text: string, success: string) => Promise<void>;
  relationships?: PlatformRelationship[];
  availability?: PlatformAvailability;
  /** Reviewed registry record: exact, source-backed contracts per launch path. */
  launchpad?: LaunchpadRecord | null;
  /** Measured pools of its own exact hooks, when the loaded data has them. */
  market?: PlatformMarket | null;
  /** The full snapshot has not arrived yet, so the figures are still to come. */
  marketPending?: boolean;
  openProject?: (id: string, tab?: "deployments" | "pools") => void;
  /** Reviewed listings have no service-side identity to watch yet. */
  canWatch?: boolean;
}) {
  const statusHeadingId = useId();
  const chainName = (slug: string) =>
    chains.find((chain) => chain.slug === slug)?.name || slug;
  const status = availability?.status ?? "unverified";
  const finding = evidenceNote(availability?.note);
  const linked = relationships?.length ? relationships : null;
  // A reviewed launchpad may publish its own hook addresses (listed below) or
  // document hookless pools; only an unresolved listing has nothing to show.
  const ownHooks = Boolean(
    launchpad?.paths.some(
      (path) => path.attribution === "platform-hook" && path.hooks.length > 0,
    ),
  );
  const perLaunch = Boolean(
    launchpad &&
    !ownHooks &&
    launchpad.paths.some((path) => path.perLaunchHooks),
  );
  const measuring = !market && marketPending && ownHooks;
  const hooklessOnly = Boolean(
    launchpad &&
    !ownHooks &&
    launchpad.paths.length > 0 &&
    launchpad.paths.every((path) => path.poolKind === "hookless"),
  );
  const protocols = linked
    ? [...new Set(linked.map((relation) => relation.protocolName))]
    : [];
  const checkedAt =
    availability?.checkedAt &&
    Number.isFinite(Date.parse(availability.checkedAt))
      ? availability.checkedAt
      : null;
  // A finding that quotes the live index's own pool count is dated by its review.
  const reviewNotes = reviewNotesHeading(
    availability?.note,
    launchpad ? (launchpad.reviewedAt ?? LAUNCHPAD_REVIEWED_AT) : null,
  );
  // The measured figures are the snapshot's; a drawer can cover the page's own
  // dated line, so the figures carry their date. The edition's clock is frozen
  // at the snapshot's time once it has loaded (the figures need it).
  const snapshotTaken = market ? snapshotTakenNote(evaluationNow()) : null;
  return (
    <div
      className={`drawer-body project-detail platform-detail${STATIC_EDITION ? " is-snapshot" : ""}`}
    >
      <header className="detail-hero">
        <ProtocolLogo project={project} large />
        <div className="detail-hero-text">
          <div className="project-heading-meta">
            <span className="category-tag" data-category={project.category}>
              {project.category}
            </span>
            <span className="project-origin">Platform listing</span>
            <StatusPill status={status} />
          </div>
          <h2>{project.name}</h2>
          <p>{project.description}</p>
        </div>
      </header>
      <div className="detail-actions">
        <div className="detail-actions-primary">
          <External className="project-website" href={project.website}>
            Open website
          </External>
          {canWatch && (
            <button
              className={`control watch-project ${watchlisted ? "selected" : ""}`}
              aria-pressed={watchlisted}
              onClick={toggleWatch}
            >
              <Star size={16} fill={watchlisted ? "currentColor" : "none"} />
              {watchlisted ? "Watching" : "Watch project"}
            </button>
          )}
        </div>
        <div
          className="detail-actions-secondary"
          role="group"
          aria-label="Platform tools"
        >
          <External className="detail-text-action" href={project.docs}>
            Launch guide
          </External>
          <button
            className="detail-text-action"
            onClick={() =>
              void copy(publicViewUrl(location.href), "Project link copied.")
            }
          >
            <Copy size={15} />
            Copy link
          </button>
        </div>
      </div>
      <section
        className="platform-status plate"
        aria-labelledby={statusHeadingId}
      >
        <div className="platform-availability">
          <h3 id={statusHeadingId} className="kicker">
            Availability
          </h3>
          <div className="platform-availability-state" data-status={status}>
            <span className="status-dot" aria-hidden="true" />
            <strong className="readout-value">{statusLabels[status]}</strong>
          </div>
          <p className="platform-availability-description">
            {statusDescriptions[status]}
          </p>
          {finding.lead ? (
            <>
              {reviewNotes && (
                <p className="platform-availability-asof">{reviewNotes}</p>
              )}
              <p className="platform-availability-lead">{finding.lead}</p>
              {finding.findings.length > 0 && (
                <ul className="platform-availability-findings">
                  {finding.findings.map((sentence) => (
                    <li key={sentence}>{sentence}</li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p className="platform-availability-lead">
              Listed from the platform’s published documentation. A listing
              records what the platform says it supports; it is not a live
              availability check.
            </p>
          )}
          {availability?.reviewed && (
            <p className="platform-availability-reviewed">
              {availability.reviewed}
            </p>
          )}
          {(checkedAt || availability?.evidenceUrl) && (
            <p className="platform-availability-source">
              {checkedAt && (
                <>
                  Checked{" "}
                  <time
                    dateTime={checkedAt}
                    title={
                      STATIC_EDITION
                        ? (fullTimeLabel(checkedAt) ?? undefined)
                        : new Date(checkedAt).toLocaleString()
                    }
                  >
                    {inlineTime(checkedAt)}
                  </time>
                </>
              )}
              <External href={availability?.evidenceUrl}>
                Availability evidence
              </External>
            </p>
          )}
        </div>
        <div
          className="platform-market"
          role="group"
          aria-label="Platform market data"
        >
          <div className="readout">
            <span className="readout-label">
              {market || measuring
                ? "Priced pools on its hooks"
                : "Attributed pools"}
            </span>
            <strong
              className="readout-value"
              data-unavailable={market && market.pools > 0 ? undefined : "true"}
            >
              {market && market.pools > 0 ? `≥${count(market.pools)}` : "—"}
            </strong>
            <span className="readout-note">
              {market
                ? pricedPoolsNote(market)
                : measuring
                  ? "Loading measurements"
                  : "Not attributed"}
            </span>
          </div>
          <div className="readout">
            <span className="readout-label">
              {market
                ? `Tracked ${market.windowLabel} volume`
                : "Tracked volume"}
            </span>
            <strong
              className="readout-value"
              data-unavailable={
                market && market.volumeUsd !== null ? undefined : "true"
              }
            >
              {market
                ? `${lowerBoundMark(market.pools > 0 ? market.pools : null, false, market.volumeUsd)}${money(market.volumeUsd)}`
                : "—"}
            </strong>
            <span className="readout-note">
              {market
                ? trackedVolumeNote(market)
                : measuring
                  ? "Loading measurements"
                  : "Not attributed"}
            </span>
          </div>
          <p className="platform-market-note">
            {market
              ? "Only the pools of the hooks this platform publishes are counted, never a platform-wide total."
              : project.metrics.note ||
                "Market data stays unavailable until pools are attributed to this platform."}{" "}
            Unavailable is not zero.
            {snapshotTaken && ` ${snapshotTaken}.`}
          </p>
        </div>
      </section>
      <section
        className="platform-relationships"
        aria-labelledby="platform-attribution-title"
      >
        <div className="platform-section-head">
          <span className="kicker">Launch path</span>
          <h3 id="platform-attribution-title">
            {linked
              ? "Launchpad relationships"
              : ownHooks
                ? "Launch path and published hooks"
                : perLaunch
                  ? "A separate hook for every launch"
                  : hooklessOnly
                    ? "No hook to attribute"
                    : "Hook attribution is not yet established"}
          </h3>
        </div>
        <ol
          className="platform-route"
          aria-label="Launchpad to protocol to hooks and pools"
        >
          <li className="platform-route-node" data-known="true">
            <span className="platform-route-label">Launchpad</span>
            <strong>{project.name}</strong>
            <span className="platform-route-note">Documented listing</span>
          </li>
          <li
            className="platform-route-node"
            data-known={linked ? "true" : "false"}
          >
            <span className="platform-route-label">Underlying protocol</span>
            <strong>
              {linked
                ? protocols.length > 2
                  ? `${protocols.slice(0, 2).join(", ")} +${protocols.length - 2}`
                  : protocols.join(", ")
                : ownHooks
                  ? "Its own hooks"
                  : perLaunch
                    ? "Its own portals"
                    : hooklessOnly
                      ? "None (hookless pools)"
                      : "Not attributed"}
            </strong>
            <span className="platform-route-note">
              {linked
                ? `${linked.length} source-backed ${linked.length === 1 ? "link" : "links"}`
                : ownHooks
                  ? "Exact addresses listed below"
                  : perLaunch
                    ? "Contracts listed below"
                    : hooklessOnly
                      ? "Documented by the platform"
                      : "No source links a protocol yet"}
            </span>
          </li>
          <li className="platform-route-node" data-known="false">
            <span className="platform-route-label">Hooks &amp; pools</span>
            <strong>
              {linked
                ? "On each protocol’s page"
                : ownHooks
                  ? "Resolved by exact address"
                  : perLaunch
                    ? "One hook per launch"
                    : "Not attributed"}
            </strong>
            <span className="platform-route-note">
              {ownHooks
                ? "Figures cover only these hooks"
                : perLaunch
                  ? "Not listed individually"
                  : "Never inferred from the platform"}
            </span>
          </li>
        </ol>
        {linked ? (
          <>
            <p className="platform-relationship-caveat">
              <Info size={15} />
              <span>
                A relationship links the launchpad to a protocol. It does not
                make individual hooks or pools — or their volume — part of{" "}
                {project.name}.
              </span>
            </p>
            <ul className="platform-relationship-list">
              {linked.map((relation, index) => (
                <li
                  className="platform-relationship"
                  key={`${relation.protocolName}:${relation.chain}:${index}`}
                >
                  <div className="platform-relationship-head">
                    <strong>{relation.protocolName}</strong>
                    <span className="tag">{chainName(relation.chain)}</span>
                    <StatusPill status={relation.status} />
                  </div>
                  {relation.note && <p>{relation.note}</p>}
                  <div className="platform-relationship-links">
                    {relation.protocolId && (
                      <a
                        className="detail-disclosure"
                        href={`/?project=${encodeURIComponent(relation.protocolId)}`}
                        onClick={
                          // A plain click stays inside the page (the snapshot is
                          // already loaded); a new-tab click keeps the real link.
                          STATIC_EDITION && openProject
                            ? (event) => {
                                if (!isPlainLeftClick(event)) return;
                                event.preventDefault();
                                openProject(relation.protocolId!);
                              }
                            : undefined
                        }
                      >
                        Open {relation.protocolName} hooks and pools
                        <ArrowRight size={14} />
                      </a>
                    )}
                    <External href={relation.evidenceUrl}>Evidence</External>
                  </div>
                </li>
              ))}
            </ul>
            <External href={project.sourceUrl}>Platform documentation</External>
          </>
        ) : (
          <div className="platform-attribution">
            <p>
              Launches can create pools with or without hooks. Shared Uniswap
              Liquidity Launcher contracts alone do not identify a pool as a{" "}
              {project.name} launch.
            </p>
            {ownHooks ? (
              <p>
                {project.name}’s own hook contracts are listed below with their
                sources and checked against the directory by exact network and
                address. Figures cover only those hooks; nothing is inferred
                from a platform name.
              </p>
            ) : perLaunch ? (
              <p>
                {project.name} deploys a separate hook for every launch, so no
                single hook address can be published. Its launch contracts are
                listed below, and its pools appear in the directory as unnamed
                hooks. Pool counts and volume stay unavailable rather than being
                sampled from a few launches.
              </p>
            ) : hooklessOnly ? (
              <p>
                {project.name} documents hookless Uniswap pools, so there is no
                hook contract to attribute and hook-based indexing cannot see
                them. Its trading volume and pool count remain unavailable.
              </p>
            ) : (
              <p>
                We have not linked verified hook deployments or market totals to
                this platform. Its trading volume and pool count remain
                unavailable.
              </p>
            )}
            <External href={project.sourceUrl}>Platform documentation</External>
          </div>
        )}
      </section>
      {launchpad && openProject && (
        <LaunchpadPaths
          record={launchpad}
          chains={chains}
          openProject={openProject}
          copy={copy}
        />
      )}
      <section
        className="platform-networks"
        aria-labelledby="platform-networks-title"
      >
        <div className="platform-section-head">
          <span className="kicker">
            <Network size={14} /> Coverage
          </span>
          <h3 id="platform-networks-title">Supported networks</h3>
          <p>
            Launch and trade on the networks supported by the platform. Open a
            network to see its launchpads and verified hook protocols.
          </p>
        </div>
        <ul className="platform-network-links">
          {project.chains.map((slug) => {
            const statuses = [
              ...new Set(
                (linked || [])
                  .filter((relation) => relation.chain === slug)
                  .map((relation) => relation.status),
              ),
            ];
            return (
              <li key={slug}>
                <a
                  href={`/?view=chains&chain_network=${encodeURIComponent(slug)}&chain_role=launchpads`}
                  onClick={
                    // A plain click stays inside the page, which already holds
                    // the snapshot; a new-tab click keeps the real link.
                    STATIC_EDITION
                      ? (event) => {
                          if (!isPlainLeftClick(event)) return;
                          event.preventDefault();
                          navigateInPage(event.currentTarget.href);
                        }
                      : undefined
                  }
                >
                  <span>{chainName(slug)}</span>
                  <ArrowRight size={16} />
                </a>
                {statuses.map((value) => (
                  <StatusPill key={value} status={value} />
                ))}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
