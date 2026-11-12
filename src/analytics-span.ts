// 7D and 30D on the Analytics page (edition only).
//
// The Analytics page already holds, with every overview file, the contribution
// ledger: one row for each measured pool with its network, use case and the
// 24H volume read at the snapshot. data/daily.json holds the 7D and 30D volume
// of the largest pools. This module joins the two in the browser: the sum of a
// group of pools is the sum of the daily figures of those of its pools that
// have one, through the same lens (src/daily.ts) Discover and Networks use. It
// is pure: no React, no request, no clock.
//
// Truth rules kept here:
//  - A total over several pools is "at least": only the largest pools have a
//    daily figure. Every figure that leaves this module carries the mark.
//  - A group with no covered pool has no figure (null: a dash), never a zero. A
//    covered pool whose real volume is $0 stays $0.
//  - Shares are shares of the COVERED total, so they add up to 100%.
//  - The coverage figure ("these pools hold 97.1% of tracked 24H volume") is a
//    fact about the covered pools' 24H volume. It is never used to scale or
//    estimate what the uncovered pools did over 7D or 30D.
//  - A daily pool this page cannot place (no current measurement in this
//    snapshot, or a file of another run) is left out and counted, never added.
import type { AnalyticsOverviewEnvelope } from "../shared/analytics-overview.ts";
import {
  MARKET_CLOCK_SKEW_MS,
  MARKET_MAX_AGE_MS,
} from "../shared/market-freshness.ts";
import { roundExactUsd } from "./analytics.ts";
import type { AnalyticsPool } from "./analytics.ts";
import { ledgerCategory, poolCategory } from "./analytics-focus.ts";
import type {
  AnalyticsFocus,
  FocusBreakdown,
  FocusSlice,
  MetricFields,
} from "./analytics-focus.ts";
import { dailyThrough, spanLabel } from "./daily.ts";
import type { DailyLens, DailySpan } from "./daily.ts";
import { formatMoneyCompact, formatMoneyExact } from "./charts/format.ts";
import { fullTimeLabel } from "./edition.ts";

/** One pool as this module needs it: where it sits, and its 24H volume. */
export interface SpanRow {
  chain: string;
  /** `chain:poolId`, as data/daily.json keys it. */
  id: string;
  address: string;
  category: string;
  /** The loaded project's id; null for an unattributed pool and in the overview,
   * whose ledger has no project names. */
  project: string | null;
  /** The 24H volume at the snapshot; null when the pool has none. */
  usd24: number | null;
}

/** How a span value is written, everywhere it appears. One object travels with
 * the model, so no call site formats a lower bound on its own. */
export interface SpanFmt {
  /** "≥$967M", or "—". */
  compact(value: number | null): string;
  /** "≥$966,855,896.64" (a table cell), or "Not available". */
  exact(value: number | null): string;
  /** "at least $966,855,896.64" (a title or an aria label), or "Not available". */
  spoken(value: number | null): string;
}

export const spanFmt: SpanFmt = {
  compact: (value) =>
    value === null || !Number.isFinite(value)
      ? "—"
      : `≥${formatMoneyCompact(value)}`,
  exact: (value) =>
    value === null || !Number.isFinite(value)
      ? "Not available"
      : `≥${formatMoneyExact(value)}`,
  spoken: (value) =>
    value === null || !Number.isFinite(value)
      ? "Not available"
      : `at least ${formatMoneyExact(value)}`,
};

const UNIT_WORDS: Record<string, string> = {
  K: "thousand",
  M: "million",
  B: "billion",
};
/** "$2.31B" read aloud as "$2.31 billion". */
export function spokenCompactUsd(value: number | null): string {
  const text = formatMoneyCompact(value);
  const match = /^(\$[\d.]+)([KMB])$/.exec(text);
  return match ? `${match[1]} ${UNIT_WORDS[match[2]]}` : text;
}

/** What a group of pools adds up to under the span. */
export interface SpanGroup {
  /** The covered pools' sum (at least); null when none is covered. */
  usd: number | null;
  /** Measured pools with a daily figure, and measured pools in the group. */
  covered: number;
  of: number;
  /** Covered pools younger than the span (counted from their launch day). */
  young: number;
  /** The covered pools' 24H volume as a share of the group's 24H volume: a fact
   * about the covered pools, never a way to estimate the rest. Null when the
   * group has no positive 24H volume. */
  share24: number | null;
  /** True when every measured pool of the group is covered. */
  complete: boolean;
}

export interface SpanScope extends SpanGroup {
  span: DailySpan;
  /** "7D" or "30D". */
  label: string;
  /** 7 or 30. */
  width: number;
  /** The last complete day the figures cover, "2026-11-11", and as "11 Nov". */
  through: string;
  throughLabel: string;
  /** Daily pools of this scope the page could not place (no current
   * measurement here): left out of every figure and counted. */
  skipped: number;
  /** The first and last time a covered pool's daily answer was read. */
  firstRead: string | null;
  lastRead: string | null;
  /** The file belongs to another snapshot run than the page's own file. */
  crossRun: boolean;
  networks: ReadonlyMap<string, SpanGroup>;
  categories: ReadonlyMap<string, SpanGroup>;
  /** Projects (the workspace only; empty in the overview). */
  projects: ReadonlyMap<string, SpanGroup>;
  fmt: SpanFmt;
}

/** The model the contributor bars and ribbons draw (the same shape as
 * ContributorsModel in the components), plus the span's own facts. */
export interface SpanModel {
  chain: string;
  windowKey: "h24";
  totals: MetricFields;
  networks: (MetricFields & { chain: string; name: string })[];
  categories: {
    volume: {
      category: string;
      value: number | null;
      share: number | null;
      measuredPools: number;
    }[];
    reserves: [];
    trading: [];
  };
  span: SpanScope;
}

/* ── Rows ────────────────────────────────────────────────────────────────── */

/** The ledger rows that are still current at `now`: the rule of the shared
 * derivation (shared/analytics-contributions.ts), kept equal by a test against
 * analyticsOverviewAt. Null when the response has no ledger (a legacy
 * aggregate-only answer cannot be split without inventing values). */
export function ledgerSpanRows(
  envelope: AnalyticsOverviewEnvelope,
  now: number,
): SpanRow[] | null {
  const ledger = envelope.contributions;
  if (!ledger) return null;
  const at = Math.max(now, Date.parse(envelope.asOf));
  const rows: SpanRow[] = [];
  for (const row of ledger.rows) {
    const observed = Date.parse(row[3]);
    if (!(observed + MARKET_MAX_AGE_MS > at && observed <= at + MARKET_CLOCK_SKEW_MS))
      continue;
    rows.push({
      chain: row[0],
      id: `${row[0]}:${row[1]}`,
      address: row[1],
      category: ledgerCategory(envelope, row),
      project: null,
      usd24: row[6],
    });
  }
  return rows;
}

/** The workspace's pool rows (freshness-checked already) as span rows. The
 * window beneath a span is always 24H, so `volumeUsd` is the 24H volume. */
export function workspaceSpanRows(
  pools: readonly Pick<AnalyticsPool, "pool" | "project" | "volumeUsd">[],
): SpanRow[] {
  return pools.map((row) => ({
    chain: row.pool.chain,
    id: row.pool.id,
    address: row.pool.address,
    category: poolCategory(row),
    project: row.project?.id ?? null,
    usd24: row.volumeUsd,
  }));
}

/* ── Sums ────────────────────────────────────────────────────────────────── */

class Accumulator {
  usd: number | null = null;
  covered = 0;
  of = 0;
  young = 0;
  usd24 = 0;
  covered24 = 0;
}

/** A group no pool belongs to: nothing covered, nothing measured. */
export const NO_SPAN_GROUP: SpanGroup = Object.freeze({
  usd: null,
  covered: 0,
  of: 0,
  young: 0,
  share24: null,
  complete: false,
});

function finish(group: Accumulator | undefined): SpanGroup {
  if (!group) return NO_SPAN_GROUP;
  const share =
    group.usd24 > 0 && Number.isFinite(group.usd24)
      ? Math.min(1, group.covered24 / group.usd24)
      : null;
  return {
    usd: group.usd === null ? null : roundExactUsd(group.usd),
    covered: group.covered,
    of: group.of,
    young: group.young,
    share24: share,
    complete: group.of > 0 && group.covered === group.of,
  };
}

function summed(
  rows: readonly SpanRow[],
  lens: DailyLens,
  keep: (row: SpanRow) => boolean = () => true,
) {
  const total = new Accumulator();
  const networks = new Map<string, Accumulator>();
  const categories = new Map<string, Accumulator>();
  const projects = new Map<string, Accumulator>();
  let first: string | null = null;
  let last: string | null = null;
  const placed = new Set<string>();
  const add = (map: Map<string, Accumulator>, key: string) => {
    let group = map.get(key);
    if (!group) map.set(key, (group = new Accumulator()));
    return group;
  };
  for (const row of rows) {
    if (row.usd24 === null || !Number.isFinite(row.usd24) || row.usd24 < 0) continue;
    if (!keep(row)) continue;
    placed.add(`${row.chain}:${String(row.address).toLowerCase()}`);
    const groups = [
      total,
      add(networks, row.chain),
      add(categories, row.category),
      ...(row.project ? [add(projects, row.project)] : []),
    ];
    const figure = lens.pool(row);
    for (const group of groups) {
      group.of++;
      group.usd24 += row.usd24;
    }
    if (!figure) continue;
    for (const group of groups) {
      group.covered++;
      group.covered24 += row.usd24;
      group.usd = (group.usd ?? 0) + figure.usd;
      if (figure.days !== null) group.young++;
    }
    if (first === null || figure.at < first) first = figure.at;
    if (last === null || figure.at > last) last = figure.at;
  }
  return { total, networks, categories, projects, first, last, placed };
}

const finishAll = (map: Map<string, Accumulator>) =>
  new Map([...map].map(([key, group]) => [key, finish(group)] as const));

/** The span's totals for a scope: the whole of it, each network, each use case
 * and (in the workspace) each project. `chain` is the scope's network ("all" or
 * a slug): a daily pool of another network is out of scope, not "left out".
 * `hostAt` is the publication time of the file the page is drawn from; a daily
 * file of another run is accepted but flagged. */
export function buildSpanScope({
  rows,
  lens,
  chain = "all",
  hostAt = null,
}: {
  rows: readonly SpanRow[];
  lens: DailyLens;
  chain?: string;
  hostAt?: string | null;
}): SpanScope {
  const sums = summed(rows, lens);
  const inScope = (id: string) => chain === "all" || id.split(":")[0] === chain;
  const skipped = lens.ids.filter(
    (id) => inScope(id) && !sums.placed.has(id),
  ).length;
  const label = spanLabel(lens.span);
  const host = hostAt === null ? null : Date.parse(hostAt);
  const run = Date.parse(lens.runAt);
  return {
    ...finish(sums.total),
    span: lens.span,
    label,
    width: lens.width,
    through: lens.through,
    throughLabel: dailyThrough(lens),
    skipped,
    firstRead: sums.first,
    lastRead: sums.last,
    crossRun:
      host !== null && Number.isFinite(host) && Number.isFinite(run)
        ? host !== run
        : false,
    networks: finishAll(sums.networks),
    categories: finishAll(sums.categories),
    projects: finishAll(sums.projects),
    fmt: spanFmt,
  };
}

const bySum = (
  a: { value: number | null; name: string },
  b: { value: number | null; name: string },
) =>
  (a.value === null ? 1 : 0) - (b.value === null ? 1 : 0) ||
  (b.value ?? 0) - (a.value ?? 0) ||
  a.name.localeCompare(b.name);

/** The model the bars and ribbons draw for the volume metric under a span. It
 * has no reserves, no pools-with-trading and no active-pool count: a span says
 * nothing about them, and the page keeps its 24H model for those metrics. */
export function buildSpanModel({
  rows,
  lens,
  chain = "all",
  networkNames = new Map(),
  hostAt = null,
}: {
  rows: readonly SpanRow[];
  lens: DailyLens;
  chain?: string;
  networkNames?: ReadonlyMap<string, string>;
  hostAt?: string | null;
}): SpanModel {
  const scope = buildSpanScope({ rows, lens, chain, hostAt });
  const total = scope.usd;
  const networks = [...scope.networks].map(([slug, group]) => ({
    chain: slug,
    name: networkNames.get(slug) ?? slug,
    volumeUsd: group.usd,
    liquidityUsd: null,
    volumePools: group.covered,
    liquidityPools: null,
    activePools: null,
  }));
  networks.sort((a, b) =>
    bySum(
      { value: a.volumeUsd, name: a.name },
      { value: b.volumeUsd, name: b.name },
    ),
  );
  const volume = [...scope.categories]
    .map(([category, group]) => ({
      category,
      value: group.usd,
      share:
        group.usd !== null && total !== null && total > 0
          ? group.usd / total
          : null,
      measuredPools: group.covered,
    }))
    .sort((a, b) =>
      bySum(
        { value: a.value, name: a.category },
        { value: b.value, name: b.category },
      ),
    );
  return {
    chain,
    windowKey: "h24",
    totals: {
      volumeUsd: total,
      liquidityUsd: null,
      volumePools: scope.covered,
      liquidityPools: null,
      activePools: null,
    },
    networks,
    categories: { volume, reserves: [], trading: [] },
    span: scope,
  };
}

const slice = (group: SpanGroup | undefined): FocusSlice => ({
  value: group?.usd ?? null,
  pools: group?.covered ?? 0,
});

/** What the bars show of a focused network, use case or project under the span:
 * the focused portion of every other bar, from the same rows and daily figures
 * as the totals, so a focused total equals its own bar. */
export function spanFocusBreakdown(
  rows: readonly SpanRow[],
  lens: DailyLens,
  focus: AnalyticsFocus,
): FocusBreakdown {
  const keep = (row: SpanRow) =>
    focus.kind === "network"
      ? row.chain === focus.id
      : focus.kind === "category"
        ? row.category === focus.id
        : row.project === focus.id;
  const sums = summed(rows, lens, keep);
  const view = (map: Map<string, Accumulator>) =>
    new Map([...map].map(([key, group]) => [key, slice(finish(group))] as const));
  return {
    focus,
    metric: "volume",
    total: slice(finish(sums.total)),
    networks: view(sums.networks),
    categories: view(sums.categories),
    projects: view(sums.projects),
  };
}

/** One pool's, or one set of pools', figure through the lens: what the pool
 * table and the ranked projects use. */
export function spanGroupOf(
  rows: readonly SpanRow[],
  lens: DailyLens,
  keep: (row: SpanRow) => boolean,
): SpanGroup {
  return finish(summed(rows, lens, keep).total);
}

/* ── Words ───────────────────────────────────────────────────────────────── */

/** A coverage share, floored to a tenth of a percent so it never claims more
 * than is true, and never "100%" while a measured pool is left out. */
export function coveragePercent(
  share: number | null,
  complete: boolean,
): string | null {
  if (share === null || !Number.isFinite(share) || share < 0) return null;
  let tenths = Math.floor(share * 1000 + 1e-9);
  if (!complete && tenths >= 1000) tenths = 999;
  if (tenths === 0 && share > 0) return "<0.1%";
  return `${(tenths / 10).toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
}

const count = (value: number) => value.toLocaleString("en-US");
const poolWord = (n: number) => (n === 1 ? "pool" : "pools");

/** The scope line under a span: what is shown, where it runs to, and how much of
 * the tracked 24H volume the covered pools hold. Both numbers it sets side by
 * side say 24H. */
export function spanScopeLine(scope: SpanScope, scopeName: string): string {
  const head = `Largest hook pools only · ${scopeName} · ${scope.label} through ${scope.throughLabel}`;
  if (scope.covered === 0) return `${head} · No pool here has ${scope.label} data`;
  const held = coveragePercent(scope.share24, scope.complete);
  if (held === null) return head;
  return `${head} · ${count(scope.covered)} ${scope.covered === 1 ? "pool holds" : "pools hold"} ${held} of tracked 24H volume`;
}

/** The first tile's caption: how many of the measured pools have a figure. */
export function spanTileCaption(scope: SpanScope): string {
  if (scope.covered === 0) return `No pool here has ${scope.label} data`;
  return `${count(scope.covered)} of ${count(scope.of)} ${poolWord(scope.of)} · through ${scope.throughLabel}`;
}

/** The first tile's tooltip. The exact figure comes first, spoken as a lower
 * bound; the rest says what it is. */
export function spanTileTitle(scope: SpanScope): string {
  if (scope.usd === null)
    return `No pool here has ${scope.label} volume: only the largest pools do.`;
  const parts = [
    `At least ${formatMoneyExact(scope.usd)}.`,
    `The last ${scope.width} full days (UTC) through ${scope.throughLabel}, largest pools only.`,
    ...spanFactSentences(scope),
  ];
  return parts.filter(Boolean).join(" ");
}

/** What the tile's tooltip says about the covered pools beyond the window: the
 * pools younger than the span, when the answers were read, the daily pools this
 * snapshot has no measurement for, and where the 24H figure can come from. One
 * list feeds the tooltip and the Data notes, so a touch screen, which has no
 * tooltip, reads the same facts. */
function spanFactSentences(scope: SpanScope): string[] {
  return [
    scope.young > 0
      ? `${count(scope.young)} of the ${count(scope.covered)} ${poolWord(scope.covered)} ${scope.young === 1 ? "is" : "are"} younger than ${scope.width} days and ${scope.young === 1 ? "counts" : "count"} from the launch day.`
      : "",
    scope.firstRead && scope.lastRead
      ? scope.firstRead === scope.lastRead
        ? `Read from GeckoTerminal on ${fullTimeLabel(scope.firstRead)}.`
        : `Read from GeckoTerminal ${fullTimeLabel(scope.firstRead)} to ${fullTimeLabel(scope.lastRead)}.`
      : "",
    scope.skipped > 0
      ? `${count(scope.skipped)} more ${poolWord(scope.skipped)} with daily data ${scope.skipped === 1 ? "is" : "are"} not in this snapshot's current measurements and ${scope.skipped === 1 ? "is" : "are"} left out.`
      : "",
    "The 24H figure can come from another provider.",
  ].filter(Boolean);
}

/** The Data notes' second paragraph while a span is chosen: the first tile's
 * exact figure (the tile shows it rounded, and its tooltip, which a phone
 * cannot open, holds it) and the same facts about the covered pools. Null when
 * no pool here has a figure. */
export function spanDetailNote(scope: SpanScope): string | null {
  if (scope.usd === null) return null;
  return [
    `The ${scope.label} total is at least ${formatMoneyExact(scope.usd)}.`,
    ...spanFactSentences(scope),
  ].join(" ");
}

/** What a screen reader hears for the first tile's figure. */
export function spanTileSpoken(scope: SpanScope): string {
  return scope.usd === null
    ? `No ${scope.label} volume: ${spanTileCaption(scope)}`
    : `at least ${spokenCompactUsd(scope.usd)}, ${scope.label} through ${scope.throughLabel}`;
}

/** The sentence a bar's tooltip adds under a span: how much of the row's own 24H
 * volume the covered pools hold. Never a way to scale the 7D figure. */
export function spanRowCoverage(group: SpanGroup): string | null {
  const held = coveragePercent(group.share24, group.complete);
  return group.covered === 0 || held === null
    ? null
    : `The ${count(group.covered)} covered ${poolWord(group.covered)} ${group.covered === 1 ? "holds" : "hold"} ${held} of its tracked 24H volume.`;
}

/** The sublabel of a network or use-case bar: how many pools have a figure. */
export function spanRowPools(group: SpanGroup): string {
  return group.covered === 0
    ? `None of ${count(group.of)} ${poolWord(group.of)} covered`
    : `${count(group.covered)} of ${count(group.of)} ${poolWord(group.of)} covered`;
}

export const spanEmptyTitle = (label: string, scopeName: string) =>
  `No ${label} volume for ${scopeName}`;
export const spanEmptyText = (label: string, whole: boolean) =>
  `${whole ? "None of the pools here is" : "None of its pools is"} among the largest, so there is no ${label} figure. Missing values are never shown as zero.`;

/** The method note's paragraph while a span is chosen (collapsed Data notes). */
export function spanMethodNote(scope: SpanScope): string {
  const held = coveragePercent(scope.share24, scope.complete);
  const pools = `${count(scope.covered)} ${poolWord(scope.covered)}`;
  return `7D and 30D add up each pool's daily volume over full UTC days, from GeckoTerminal, for the largest pools only${
    held !== null && scope.covered > 0
      ? `: the ${pools} here ${scope.covered === 1 ? "holds" : "hold"} ${held} of tracked 24H volume`
      : ""
  }. A completed day does not age, so the five-minute rule is not applied; the figure is dated by its last day. Totals are at least that much, and a pool younger than the span counts from its launch day. Use cases come from the same pool-to-project links as the 24H view. Reserves, pools with trading and the evidence below stay at the snapshot's 24H measurements.`;
}

export const spanSummaryLine = (scope: SpanScope) =>
  `As of the snapshot · ${scope.label} through ${scope.throughLabel}`;
