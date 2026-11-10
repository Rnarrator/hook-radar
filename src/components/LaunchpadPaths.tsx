import { useState } from "react";
import type { Chain } from "../../shared/types";
import {
  launchpadStatusLabels,
  launchpadVersionLabels,
  LAUNCHPAD_REVIEWED_AT,
} from "../../shared/launchpad-registry.ts";
import type {
  LaunchpadPath,
  LaunchpadRecord,
} from "../../shared/launchpad-registry.ts";
import {
  HOOK_PREVIEW,
  hookKey,
  useLaunchpadHookIndex,
} from "../useLaunchpadHookIndex";
import type { HookIndexEntry } from "../useLaunchpadHookIndex";
import { shortAddress } from "../model";
import { evidenceNote } from "../evidence-note";
import { reviewDate } from "../review-date";
import { External } from "./Primitives";
import { ArrowRight, Copy, Info } from "./Icons";
import { PermissionGlyph } from "./PermissionGlyph";
import { enabledCallbacks, flagsFromBits } from "../hook-permissions";
import "./launchpad-paths.css";
import { STATIC_EDITION } from "../edition";
import { reviewedNotePrefix } from "../edition-platform-copy";

/** Uniswap v4 permission flags are the low 14 bits of a hook address. */
export const decodePermissions = (bits: number) =>
  enabledCallbacks(bits).map((item) => item.name);

const sourceLabels = {
  docs: "from the official documentation",
  "official-repo": "from the official repository",
  "status-page": "from the official status page",
  "platform-app": "from the platform's own app",
  "on-chain-link":
    "read on chain from a contract the platform lists; the platform does not name this hook itself",
} as const;

function explorerLink(
  chains: readonly Chain[],
  chain: string,
  address: string,
) {
  const base = chains.find((item) => item.slug === chain)?.explorer;
  if (!base) return null;
  try {
    const url = new URL(`/address/${address}`, base);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function PathStatus({ path }: { path: LaunchpadPath }) {
  return (
    <span className="status-pill" data-status={path.status}>
      <span className="status-dot" aria-hidden="true" />
      {launchpadStatusLabels[path.status]}
    </span>
  );
}

function IndexNote({
  entry,
  openProject,
}: {
  entry: HookIndexEntry | undefined;
  openProject: (id: string, tab?: "deployments" | "pools") => void;
}) {
  // The static edition checks only its own snapshot, which says nothing about
  // a hook it does not list.
  if (STATIC_EDITION && entry?.status !== "indexed") return null;
  if (!entry || entry.status === "loading")
    return <span className="lp-index-note">Checking the directory…</span>;
  if (entry.status === "unavailable")
    return (
      <span className="lp-index-note">
        Directory lookup unavailable. This is not evidence that it is unindexed.
      </span>
    );
  if (entry.status === "not-indexed" || !entry.project)
    return (
      <span className="lp-index-note">
        Not in the directory yet: no pool has been found using this hook.
      </span>
    );
  const { project } = entry;
  return (
    <span className="lp-index-note" data-indexed="true">
      Indexed as{" "}
      <button
        type="button"
        className="lp-link"
        onClick={() => openProject(project.id, "deployments")}
      >
        {project.name}
      </button>
      {project.deploymentCount > 1 && (
        <>
          {" "}
          · that record also holds {project.deploymentCount - 1} other{" "}
          {project.deploymentCount === 2 ? "contract" : "contracts"}, so its
          totals are not this platform's
        </>
      )}
    </span>
  );
}

/** Exact, source-backed contracts per launch path. Nothing here carries market
 * totals; hooks shared with another protocol are counted under that protocol. */
export function LaunchpadPaths({
  record,
  chains,
  openProject,
  copy,
}: {
  record: LaunchpadRecord;
  chains: readonly Chain[];
  openProject: (id: string, tab?: "deployments" | "pools") => void;
  copy: (text: string, success: string) => Promise<void>;
}) {
  // Long hook lists open on request; only shown hooks are looked up.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const index = useLaunchpadHookIndex(record, expanded);
  const chainName = (slug: string) =>
    chains.find((chain) => chain.slug === slug)?.name || slug;
  // The full finding is the Availability card's; a warning here keeps its lead.
  const status = evidenceNote(record.statusNote);
  // A line that quotes what Radar showed on the review day is dated by it (the
  // edition's snapshot cannot confirm it); its own words are not edited.
  const reviewedAt = record.reviewedAt ?? LAUNCHPAD_REVIEWED_AT;
  const asReviewed = (text: string) => {
    const prefix = reviewedNotePrefix(text, reviewedAt);
    return prefix ? (
      <>
        <span className="lp-as-of">{prefix}</span>{" "}
      </>
    ) : null;
  };
  return (
    <section
      className="launchpad-paths"
      aria-labelledby="launchpad-paths-title"
    >
      <div className="platform-section-head">
        <span className="kicker">Published contracts</span>
        <h3 id="launchpad-paths-title">How {record.name} launches</h3>
        <p>
          {record.relationshipNote} Reviewed{" "}
          {reviewDate(record.reviewedAt ?? LAUNCHPAD_REVIEWED_AT)} from the
          platform's own sources and public chain data.
        </p>
      </div>
      {record.status !== "live" && (
        <div className="lp-status-note">
          <Info size={15} />
          <p>
            {status.lead}
            {status.findings.length > 0 && (
              <span className="lp-status-note-more">
                {" "}
                The evidence is listed under Availability.
              </span>
            )}
          </p>
        </div>
      )}
      <ol className="lp-paths">
        {record.paths.map((path) => (
          <li className="lp-path" key={path.id} data-status={path.status}>
            <header>
              <div className="lp-path-title">
                <h4>
                  {asReviewed(path.label)}
                  {path.label}
                </h4>
                <span className="tag">{chainName(path.chain)}</span>
                <span className="tag">
                  {launchpadVersionLabels[path.uniswapVersion]}
                </span>
                <span className="tag" data-kind={path.poolKind}>
                  {path.poolKind === "hooked"
                    ? "Hooked"
                    : path.poolKind === "hookless"
                      ? "No hook"
                      : "Hook unknown"}
                </span>
                <PathStatus path={path} />
              </div>
              <p>{path.summary}</p>
            </header>
            {path.hooks.length > 0 && (
              <ul className="lp-hooks" aria-label={`${path.label} hooks`}>
                {(expanded.has(path.id)
                  ? path.hooks
                  : path.hooks.slice(0, HOOK_PREVIEW)
                ).map((hook) => {
                  const link = explorerLink(chains, path.chain, hook.address);
                  const flags = decodePermissions(hook.permissions);
                  return (
                    <li key={hook.address}>
                      <div className="lp-hook-head">
                        <strong>{hook.name}</strong>
                        {path.attribution === "shared-protocol" && (
                          <span className="tag">
                            Shared · counted under{" "}
                            {path.protocolId === "doppler"
                              ? "Doppler"
                              : path.protocolId}
                          </span>
                        )}
                      </div>
                      <p>{hook.role}</p>
                      <div className="lp-address">
                        <code title={hook.address}>
                          {shortAddress(hook.address)}
                        </code>
                        <button
                          type="button"
                          className="icon-button lp-copy"
                          aria-label={`Copy ${hook.name} address`}
                          onClick={() =>
                            void copy(hook.address, "Hook address copied.")
                          }
                        >
                          <Copy size={14} />
                        </button>
                        {link && <External href={link}>Explorer</External>}
                      </div>
                      <p className="lp-flags">
                        <PermissionGlyph
                          flags={flagsFromBits(hook.permissions)}
                          decorative
                        />
                        <span className="kicker">Permissions</span>{" "}
                        {flags.join(" · ")}
                      </p>
                      <p className="lp-source">
                        Address {sourceLabels[hook.source]}.
                      </p>
                      <IndexNote
                        entry={index.get(hookKey(path.chain, hook.address))}
                        openProject={openProject}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
            {path.hooks.length > HOOK_PREVIEW && (
              <button
                type="button"
                className="lp-more"
                aria-expanded={expanded.has(path.id)}
                onClick={() =>
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(path.id)) next.delete(path.id);
                    else next.add(path.id);
                    return next;
                  })
                }
              >
                {expanded.has(path.id)
                  ? `Show first ${HOOK_PREVIEW} hooks`
                  : `Show all ${path.hooks.length} hooks`}
              </button>
            )}
            {path.contracts.length > 0 && (
              <details className="lp-contracts">
                <summary>
                  Other published contracts ({path.contracts.length})
                </summary>
                <ul>
                  {path.contracts.map((contract) => {
                    const link = explorerLink(
                      chains,
                      path.chain,
                      contract.address,
                    );
                    return (
                      <li key={contract.address}>
                        <strong>{contract.name}</strong>
                        <span>{contract.role}</span>
                        <code title={contract.address}>
                          {shortAddress(contract.address)}
                        </code>
                        {link && <External href={link}>Explorer</External>}
                      </li>
                    );
                  })}
                </ul>
              </details>
            )}
            <ul className="lp-evidence" aria-label={`${path.label} sources`}>
              {path.evidence.map((item) => (
                <li key={item.url}>
                  <span>{item.note}</span>
                  <External href={item.url}>
                    Source<span className="sr-only"> for {path.label}</span>
                  </External>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
      {record.unattributed && record.unattributed.length > 0 && (
        <details className="lp-unattributed">
          <summary>
            Not attributed ({record.unattributed.length})
            <ArrowRight size={14} />
          </summary>
          <p>
            These share a name, timing or code with this platform in a
            third-party list but are not published by it, so Hook Radar does not
            attribute them.
          </p>
          <ul>
            {record.unattributed.map((note) => (
              <li key={note}>
                {asReviewed(note)}
                {note}
              </li>
            ))}
          </ul>
        </details>
      )}
      <details className="lp-unresolved">
        <summary>
          Unresolved ({record.unresolved.length})
          <ArrowRight size={14} />
        </summary>
        <ul>
          {record.unresolved.map((note) => (
            <li key={note}>
              {asReviewed(note)}
              {note}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
