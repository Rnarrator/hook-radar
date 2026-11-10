/** Pieces that exist only in the Auto Snapshot edition: the dated status line,
 * the dated pool census, the collection run and the source credit. Nothing here
 * is rendered by the live build. */
import { Fragment, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { PoolIndexCoverage, RadarSnapshot } from "../../shared/types";
import {
  RELOAD_HINT,
  STATIC_EDITION,
  censusHeading,
  creditedSources,
  fullTimeLabel,
  parseRunTimes,
  runTimesFor,
  snapshotStatusLine,
  statusUrl,
} from "../edition";
import type { RunTimes } from "../edition";
import { count } from "../model";
import { ChevronDown } from "./Icons";
import { External } from "./Primitives";
import "./coverage.css";
import "./edition.css";

/** When this snapshot was taken, how often it is renewed and how old it is by
 * the visitor's clock (display only: freshness is judged at the snapshot's own
 * time). Stands where the live page shows its "Data status". A snapshot older
 * than the schedule explains says so in the signal colour instead of repeating
 * the rhythm.
 *
 * `newerAt` is the time of a later published run, once the status file has named
 * one (see edition-status-probe.ts): the line then offers "Reload" and the page
 * on screen is left as it is. `checked` is whether the status file has been read
 * at all. Until it has, a snapshot old enough to be called late tells the visitor
 * to reload, since the page cannot know whether the site holds a newer one; once
 * it has and names nothing newer, the site itself is late and a reload would not
 * help, so the hint goes. */
export function SnapshotLine({
  generatedAt,
  newerAt = null,
  checked = false,
  className = "",
}: {
  generatedAt: string;
  newerAt?: string | null;
  checked?: boolean;
  className?: string;
}) {
  const [visitorNow, setVisitorNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setVisitorNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const line = snapshotStatusLine(generatedAt, visitorNow);
  if (!line) return null;
  const newerTaken = newerAt ? fullTimeLabel(newerAt) : null;
  const classes = ["snapshot-line", line.stale && "is-stale", className]
    .filter(Boolean)
    .join(" ");
  return (
    <p className={classes} data-testid="snapshot-line">
      <span
        className={line.stale ? "status-led" : "status-led amber"}
        aria-hidden="true"
      />
      <span className="snapshot-line-text">
        {line.stale ? (
          <>
            <strong>{line.staleText}</strong> Figures are from{" "}
            <time dateTime={generatedAt}>{line.takenAt}</time>.
            {newerTaken === null && !checked && ` ${RELOAD_HINT}`}
          </>
        ) : (
          <>
            <strong>
              <time dateTime={generatedAt}>{line.taken}</time>
            </strong>
            {line.note && (
              <span className="snapshot-line-note"> · {line.note}</span>
            )}
            {line.age && (
              <span className="snapshot-line-age"> · {line.age}</span>
            )}
          </>
        )}
        {/* Always in the page, so that a screen reader announces the sentence
            when it appears. The data on screen is never swapped silently. */}
        <span className="snapshot-line-newer" role="status">
          {newerTaken !== null && (
            <>
              A newer snapshot is available (taken{" "}
              <time dateTime={newerAt ?? undefined}>{newerTaken}</time>).{" "}
              <button
                type="button"
                className="control snapshot-reload"
                data-testid="snapshot-reload"
                onClick={() => window.location.reload()}
              >
                Reload
              </button>
            </>
          )}
        </span>
      </span>
    </p>
  );
}

/** "census as of 27 Oct 2026" beside a figure that comes from the census (hooks
 * found, pools using a hook), so it is never read as measured at the snapshot's
 * time. Renders nothing on the live site or when the census has no date. */
export function CensusNote({
  label,
  className = "",
}: {
  label: string | null | undefined;
  className?: string;
}) {
  if (!STATIC_EDITION || !label) return null;
  return (
    <small
      className={`census-note ${className}`.trim()}
      data-testid="census-note"
    >
      {label.charAt(0).toUpperCase() + label.slice(1)}
    </small>
  );
}

/** The hook census, shown as what it is: counts from Hook Radar's own index of
 * PoolManager events, dated by the times that travel with them and not renewed
 * by each snapshot. */
export function EditionCensus({ snapshot }: { snapshot: RadarSnapshot }) {
  const inventory: PoolIndexCoverage | undefined = snapshot.inventory;
  if (!inventory) return null;
  const label = censusHeading(inventory);
  // Every pool the snapshot holds was measured (a provider answered for it,
  // even with no value): the same number as the Pools card and the coverage
  // figures, not a count of pools with a value.
  const measuredPools = snapshot.pools.length;
  return (
    <section className="pool-index-coverage" aria-label="Onchain pool census">
      <div className="coverage-index-heading">
        <div>
          <h3>Pool census</h3>
          <p>
            Hook pools found onchain, including inactive pools and pools without
            USD pricing. These counts come from Hook Radar&rsquo;s own index of
            PoolManager events and keep their own as-of date; each snapshot
            measures prices for a sample of these pools.
          </p>
        </div>
        <span>
          {label ?? "Census"}
          <small>As of {fullTimeLabel(inventory.generatedAt)}</small>
        </span>
      </div>
      <div className="coverage-index-totals">
        <span>
          <strong>{count(inventory.hookPoolCount)}</strong> hook pools found
        </span>
        <span>
          <strong>{count(inventory.hookCount)}</strong> hook addresses
        </span>
        <span>
          <strong>{count(measuredPools)}</strong>{" "}
          {measuredPools === 1 ? "pool" : "pools"} measured in this snapshot
        </span>
      </div>
      <details className="coverage-network-disclosure">
        <summary>
          <span>Network details</span>
          <span className="coverage-network-count">
            {count(inventory.networks.length)} onchain
          </span>
          <ChevronDown size={14} />
        </summary>
        <div className="coverage-network-list">
          {inventory.networks.map((network) => (
            <article key={network.chainId} className="coverage-network">
              <div>
                <strong>{network.name}</strong>
                <span>
                  {count(network.hookPoolCount)} hook{" "}
                  {network.hookPoolCount === 1 ? "pool" : "pools"} ·{" "}
                  {count(network.hookCount)}{" "}
                  {network.hookCount === 1 ? "hook" : "hooks"}
                </span>
              </div>
              <div className="coverage-network-times">
                {network.updatedAt ? (
                  <span>
                    Counted{" "}
                    <time dateTime={network.updatedAt}>
                      {fullTimeLabel(network.updatedAt)}
                    </time>
                  </span>
                ) : (
                  <span>Count time unavailable</span>
                )}
                {network.headCheckedAt && (
                  <span>
                    Chain head checked{" "}
                    <time dateTime={network.headCheckedAt}>
                      {fullTimeLabel(network.headCheckedAt)}
                    </time>
                  </span>
                )}
              </div>
              <p className="coverage-blocks">
                {network.scannedToBlock < network.startBlock
                  ? "No scan recorded"
                  : `Scanned to block ${count(network.scannedToBlock)}`}
                {network.targetBlock !== null &&
                network.scannedToBlock < network.targetBlock
                  ? ` of ${count(network.targetBlock)} (scan not complete at export)`
                  : ""}
              </p>
            </article>
          ))}
        </div>
      </details>
      <p className="coverage-index-note">
        A census count is not renewed by a snapshot, so it can trail the chain.
        USD pricing is separate; a missing price never means zero activity.
      </p>
    </section>
  );
}

/** The collection run's times, shown only when they belong to the snapshot on
 * the page (see runTimesFor). */
export function EditionRunTimes({
  run,
  snapshotAt,
}: {
  run: RunTimes | null;
  snapshotAt?: string;
}) {
  const shown = runTimesFor(run, snapshotAt);
  if (!shown) return null;
  return (
    <dl className="edition-run" aria-label="Collection run">
      {shown.collectionStartedAt && (
        <div>
          <dt>Collection started</dt>
          <dd>{fullTimeLabel(shown.collectionStartedAt)}</dd>
        </div>
      )}
      {shown.burstStartedAt && shown.burstEndedAt && (
        <div>
          <dt>Measurements taken</dt>
          <dd>
            {fullTimeLabel(shown.burstStartedAt)} to{" "}
            {fullTimeLabel(shown.burstEndedAt)}
          </dd>
        </div>
      )}
      {shown.previousGeneratedAt && (
        <div>
          <dt>Previous snapshot</dt>
          <dd>{fullTimeLabel(shown.previousGeneratedAt)}</dd>
        </div>
      )}
    </dl>
  );
}

/** Reads the published status file when it opens. `snapshotAt` is the time of
 * the snapshot on the page: a tab that outlives a deploy would otherwise show
 * the new run's measurement times under the old snapshot's date. */
export function EditionRun({ snapshotAt }: { snapshotAt?: string }) {
  const [run, setRun] = useState<RunTimes | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(statusUrl(), {
          signal: controller.signal,
          cache: "no-cache",
        });
        if (response.ok) setRun(parseRunTimes(await response.json()));
      } catch {
        // The run times are an extra; the snapshot stands without them.
      }
    })();
    return () => controller.abort();
  }, []);
  return <EditionRunTimes run={run} snapshotAt={snapshotAt} />;
}

/** The linked credit that the data services ask for, near the data. It is built
 * from the sources the snapshot on the page names (the Data & sources cards), so
 * it credits a service only when that run's list names it and it supplied
 * something: DEX Screener measures, GeckoTerminal finds pools and stands in for
 * a pool DEX Screener did not return, and the names and links are those of the
 * cards. A page that loads no snapshot (the guide) passes no list and credits
 * nothing; its footer keeps the "Data & sources" button. */
export function SourceCredit({
  sources,
}: {
  sources?: readonly { id?: unknown; status?: unknown }[] | null;
}) {
  const credited = creditedSources(sources);
  if (!credited) return null;
  const sentences: ReactNode[] = [];
  if (credited.dexscreener && credited.geckoterminal)
    sentences.push(
      <>
        Prices from{" "}
        <External href="https://dexscreener.com">DEX Screener</External>, with{" "}
        <External href="https://www.geckoterminal.com">GeckoTerminal</External>{" "}
        for pool discovery and as a fallback.
      </>,
    );
  else if (credited.dexscreener)
    sentences.push(
      <>
        Prices from{" "}
        <External href="https://dexscreener.com">DEX Screener</External>.
      </>,
    );
  else if (credited.geckoterminal)
    sentences.push(
      <>
        Prices and pool discovery from{" "}
        <External href="https://www.geckoterminal.com">GeckoTerminal</External>.
      </>,
    );
  if (credited.registry)
    sentences.push(
      <>
        Hooks from the{" "}
        <External href="https://github.com/Uniswap/hooklist">
          Uniswap hooklist
        </External>
        .
      </>,
    );
  if (credited.v4xyz)
    sentences.push(
      <>
        Hook and pool identities from the{" "}
        <External href="https://www.v4.xyz">v4.xyz indexer</External>.
      </>,
    );
  if (credited.frontier)
    sentences.push(
      <>
        Deployment configuration from{" "}
        <External href="https://api.frontier.fun/chains">Frontier</External>.
      </>,
    );
  if (credited.census)
    sentences.push(
      <>
        The pool census is Hook Radar&rsquo;s own index of PoolManager events.
      </>,
    );
  if (!sentences.length) return null;
  return (
    <p className="footer-credit" data-testid="source-credit">
      {sentences.map((sentence, index) => (
        <Fragment key={index}>
          {index > 0 && " "}
          {sentence}
        </Fragment>
      ))}
    </p>
  );
}
