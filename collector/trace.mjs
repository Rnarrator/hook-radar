import { measurementChains } from "./measure.mjs";
import { poolKey } from "./state.mjs";

// `node collector/run.mjs --trace chain:id,chain:id` says, for each pool named,
// what this run did with it: not asked (and why), answered with no market value,
// rejected (and why) or measured. It exists to find out why a pool the page
// should price is silent, on a person's own computer. It only observes: it asks
// no request, keeps no figure and writes no file, and it refuses to run under
// GitHub Actions so that the hourly job can never carry it.

export const TRACE_MAX_POOLS = 50;
const TRACE_KEY = /^([a-z0-9][a-z0-9-]{0,49}):(0x[0-9a-fA-F]{64})$/;

/** The pools of a `--trace` value (`chain:0x<64 hex>`, comma separated) as
 * chain:id keys with the id in lower case. */
export function parseTraceList(text) {
  const keys = new Set();
  for (const part of String(text ?? "").split(",")) {
    const item = part.trim();
    if (!item) continue;
    const match = TRACE_KEY.exec(item);
    if (!match)
      throw new Error(
        `--trace needs pool keys written chain:0x<64 hex digits>, separated by commas; "${item.slice(0, 80)}" is not one.`,
      );
    keys.add(poolKey(match[1], match[2].toLowerCase()));
  }
  if (!keys.size) throw new Error("--trace needs at least one pool key.");
  if (keys.size > TRACE_MAX_POOLS)
    throw new Error(`--trace takes at most ${TRACE_MAX_POOLS} pools.`);
  return keys;
}

/** The trace is for a person's own computer. GitHub sets GITHUB_ACTIONS in every
 * job it runs, and a run there refuses it. */
export function assertTraceAllowed(env = process.env) {
  if (env?.GITHUB_ACTIONS)
    throw new Error(
      "--trace is for runs on your own computer. It refuses to run under GitHub Actions (GITHUB_ACTIONS is set).",
    );
}

const PROVIDER_NAME = {
  dexscreener: "DEX Screener",
  geckoterminal: "GeckoTerminal",
  frontier: "Frontier",
};

const REJECTION_TEXT = {
  identity: "the row is not for this pool id",
  chain: "the row is for another network, DEX or Uniswap version",
  tokens: "the row's currencies disagree with the pool's identity",
};

// A figure the provider gave, or the words for one it did not (null is not zero).
const usd = (value) =>
  typeof value === "number" ? `${value} USD` : "not reported";

/** What one provider did with a pool it was asked about. */
function describeAnswer(entry) {
  if (entry.outcome === "value") return "returned a row with a market value";
  if (entry.outcome === "no-value")
    return "returned a row with no liquidity and no volume";
  if (entry.outcome === "no-row")
    return "answered the batch but returned no row for this pool";
  if (entry.outcome === "rejected")
    return `returned a row and it was rejected: ${REJECTION_TEXT[entry.reason] ?? entry.reason}`;
  return `its batch failed (${entry.reason})`;
}

/** Why a known pool on a network DEX Screener is asked about was not in the plan.
 * With the lane plan it says which lane the pool is in and whether it was not
 * due or was cut by the batch ceiling. */
function notPlanned(plan, key) {
  const lane = plan.mode === "lanes" ? plan.laneByKey?.get(key) : null;
  if (!lane)
    return `not asked: left out of this run's plan (the plan holds ${plan.planned} pools)`;
  if (plan.trimmedKeys?.has(key))
    return `not asked: it was due (lane ${lane}) and the plan's batch ceiling of ${plan.maxBatches} cut it; it is asked at its next turn`;
  return `not asked: its lane (${lane}) was not due in this run, and the plan holds ${plan.planned} pools`;
}

/** What each pool named did in this run.
 *
 * `outcome` is one of `measured`, `rejected`, `no-market-value`, `not-answered`
 * (asked, and the batch failed) or `not-asked`. `dexscreener` and `geckoterminal`
 * say what each of them did with the pool, in words. Everything here is read from
 * the run that just ended: nothing is asked again. */
export function traceReport({
  keys,
  pools,
  plan,
  burst,
  chains = measurementChains(),
}) {
  const known = new Map(
    pools.map((pool) => [poolKey(pool.chain, pool.id), pool]),
  );
  const eligible = new Map(chains.map((chain) => [chain.chain, chain]));
  const planned = new Set(
    plan.networks.flatMap(({ chain, pools: rows }) =>
      rows.map((pool) => poolKey(chain.chain, pool.id)),
    ),
  );
  return [...keys].map((key) => {
    const pool = known.get(key);
    if (!pool)
      return {
        key,
        outcome: "not-asked",
        summary: "not a pool this run knows",
        dexscreener:
          "not asked: the pool is not in the state, the priority list or this run's discovery",
        geckoterminal: "not asked: the pool is not known",
      };
    const entry = burst.trace?.get(key) ?? {};
    const final = burst.measured.get(key) ?? null;
    const chain = eligible.get(pool.chain);

    let dexscreener;
    if (entry.dexscreener) dexscreener = describeAnswer(entry.dexscreener);
    else if (!chain)
      dexscreener = `not asked: DEX Screener has no market namespace for the network ${pool.chain}`;
    else if (!planned.has(key))
      dexscreener = notPlanned(plan, key);
    else
      dexscreener =
        "not asked: the pool was in the plan, but its batch was never sent (the burst ran out of time, the provider was stopped, or its network was left after repeated failures)";

    let geckoterminal;
    if (entry.geckoterminal)
      geckoterminal = describeAnswer(entry.geckoterminal);
    else if (entry.dexscreener?.outcome === "value")
      geckoterminal = "not asked: DEX Screener measured it";
    else if (!chain?.gecko)
      geckoterminal = `not asked: no GeckoTerminal network is known for ${pool.chain}`;
    else if (plan.mode === "lanes")
      // The lane plan's fallback takes pools from every network, not only from the
      // plan: the pools GeckoTerminal priced last time first, then a rotation.
      geckoterminal =
        "not asked: the pool was not among those of this run's few GeckoTerminal requests (the pools it priced last time, then a rotation over every network)";
    else if (!planned.has(key))
      geckoterminal = "not asked: the pool was not in this run's plan";
    else
      geckoterminal =
        "not asked: the pool was not among those of this run's few fallback requests";

    const answers = [entry.dexscreener, entry.geckoterminal].filter(Boolean);
    let outcome;
    let summary;
    if (final) {
      outcome = "measured";
      summary = `measured by ${PROVIDER_NAME[final.metricProvider] ?? final.metricProvider}: liquidity ${usd(final.liquidityUsd)}, 24h volume ${usd(final.volumeUsd?.h24)}, observed ${final.metricUpdatedAt}`;
    } else if (answers.some(({ outcome: o }) => o === "rejected")) {
      outcome = "rejected";
      const rejection = answers.find(({ outcome: o }) => o === "rejected");
      summary = `a row came back and was rejected: ${REJECTION_TEXT[rejection.reason] ?? rejection.reason}`;
    } else if (
      answers.some(({ outcome: o }) => o === "no-value" || o === "no-row")
    ) {
      outcome = "no-market-value";
      summary = answers.some(({ outcome: o }) => o === "no-value")
        ? "answered with a row that has no liquidity and no volume"
        : "answered, but returned no row for this pool";
    } else if (answers.some(({ outcome: o }) => o === "failed")) {
      outcome = "not-answered";
      summary = "asked, but the batch failed";
    } else {
      outcome = "not-asked";
      summary = "no provider was asked about it in this run";
    }
    return { key, outcome, summary, dexscreener, geckoterminal };
  });
}

/** The report as lines of text for the terminal. */
export function formatTrace(report) {
  const lines = [
    `Trace of ${report.length} pool${report.length === 1 ? "" : "s"}:`,
  ];
  for (const row of report) {
    lines.push(`  ${row.key}`);
    lines.push(`    ${row.outcome}: ${row.summary}`);
    lines.push(`    DEX Screener: ${row.dexscreener}`);
    lines.push(`    GeckoTerminal: ${row.geckoterminal}`);
  }
  return lines;
}
