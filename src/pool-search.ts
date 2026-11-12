import type { Pool } from "../shared/types";

/* Search by token, pair, pool id and pool address.
 *
 * A project row counts the pools whose `projectId` is the project (the edition's
 * collector computes the project's pool count and totals from exactly those), so
 * the index below is built from the same field: a pool that matches a search is
 * always one the row counts. Everything here is plain text matching. Nothing is
 * rendered as markup and nothing throws on odd input. */

/** One measured pool, as the search sees it. */
export interface PoolSearchEntry {
  /** The pool's pair text as the page shows it ("USDC / USDT"), without hidden
   * format characters. */
  readonly name: string;
  /** Network short name, as `Filters.chain` carries it. */
  readonly chain: string;
  /** Network display name, falling back to the short name. */
  readonly chainName: string;
  /** Pair text and network, folded, with spaces removed ("usdc/usdt|ethereum"):
   * a symbol written with spaces between its letters still matches. */
  readonly text: string;
  /** Pool id, pool address and token addresses, folded. Matched by 6 or more
   * characters only, so a short word never lands inside an address. */
  readonly ids: string;
}

/** Project id to the measured pools that belong to it, largest reserves first. */
export type PoolSearchIndex = ReadonlyMap<string, readonly PoolSearchEntry[]>;

/** Fewest characters of an address or id that search looks for inside one. */
export const MIN_ADDRESS_FRAGMENT = 6;

const FORMAT = /\p{Cf}/gu;
const HIDDEN = /[\p{Cc}\p{Cf}]/gu;
const SPACES = /\s+/gu;
const PAIR_SEPARATORS = /[/,\-]+/u;
/** The tugrik sign (U+20AE), which Tether's USDT0 token uses for its T. Unicode
 * leaves it as it is, so it is read as the letter. Other look-alike symbols are
 * not folded. */
const TUGRIK = /\u20AE/gu;

/** Text for comparing: compatibility forms folded (full-width letters, ligatures,
 * hair spaces), format characters such as zero-width joiners and direction marks
 * removed, the tugrik sign read as "t", lower case, one plain space between
 * words. */
export function foldSearchText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(FORMAT, "")
    .replace(TUGRIK, "t")
    .toLowerCase()
    .replace(SPACES, " ")
    .trim();
}

const characters = (text: string) => Array.from(text).length;

/** The words of a search. A pair is split on "/", "-" and "," and then on
 * spaces. A symbol typed with spaces between its letters ("u s o e", the way a
 * few pools spell theirs) is one word, so a run of single letters between two
 * such separators is joined; "x / y" stays two words. */
export function searchTerms(query: string): string[] {
  const terms: string[] = [];
  for (const half of foldSearchText(query).split(PAIR_SEPARATORS)) {
    let run: string[] = [];
    const flush = () => {
      if (run.length) terms.push(run.join(""));
      run = [];
    };
    for (const word of half.split(" ").filter(Boolean)) {
      if (characters(word) === 1) run.push(word);
      else {
        flush();
        terms.push(word);
      }
    }
    flush();
  }
  return terms;
}

/** What the page shows of a pool's name: no hidden control or format characters
 * (a direction override must not reorder the sentence around it), one plain
 * space between words. */
export function displayPoolName(name: string, fallback: string): string {
  const shown = name.replace(HIDDEN, "").replace(SPACES, " ").trim();
  return characters(shown) > 80
    ? `${Array.from(shown).slice(0, 80).join("")}…`
    : shown || fallback;
}

const byReserves = (a: Pool, b: Pool) =>
  (b.liquidityUsd ?? -1) - (a.liquidityUsd ?? -1);

function indexPools(
  pools: readonly Pool[],
  chainNames?: ReadonlyMap<string, string>,
): PoolSearchIndex {
  const index = new Map<string, PoolSearchEntry[]>();
  // Array.prototype.sort is stable: equal reserves keep the snapshot's order.
  for (const pool of [...pools].sort(byReserves)) {
    if (!pool.projectId) continue;
    const chainName = chainNames?.get(pool.chain) ?? String(pool.chain ?? "");
    const name = displayPoolName(
      String(pool.name ?? ""),
      String(pool.id ?? "").slice(-8),
    );
    const entry: PoolSearchEntry = {
      name,
      chain: pool.chain,
      chainName,
      text: [
        foldSearchText(String(pool.name ?? "")).replace(/ /g, ""),
        foldSearchText(String(pool.chain ?? "")).replace(/ /g, ""),
        foldSearchText(chainName).replace(/ /g, ""),
      ].join("|"),
      ids: foldSearchText(
        [
          pool.id,
          pool.address,
          ...(Array.isArray(pool.tokens) ? pool.tokens : []),
        ]
          .filter((value): value is string => typeof value === "string")
          .join(" "),
      ),
    };
    const list = index.get(pool.projectId);
    if (list) list.push(entry);
    else index.set(pool.projectId, [entry]);
  }
  return index;
}

const indexes = new WeakMap<
  readonly Pool[],
  {
    chainNames: ReadonlyMap<string, string> | undefined;
    index: PoolSearchIndex;
  }
>();

/** The pool index of one snapshot, built once: asking again with the same pools
 * array (and network names) returns the same index. */
export function buildPoolSearchIndex(
  pools: readonly Pool[],
  chainNames?: ReadonlyMap<string, string>,
): PoolSearchIndex {
  const known = indexes.get(pools);
  if (known && known.chainNames === chainNames) return known.index;
  const index = indexPools(pools, chainNames);
  indexes.set(pools, { chainNames, index });
  return index;
}

/** How many pools the search covers: those of the given projects (all when none
 * are named), on one network when `chain` is not "all". */
export function poolSearchCount(
  index: PoolSearchIndex,
  projectIds?: Iterable<string>,
  chain = "all",
): number {
  let total = 0;
  const lists = projectIds
    ? [...projectIds].map((id) => index.get(id) ?? [])
    : [...index.values()];
  for (const list of lists)
    total +=
      chain === "all"
        ? list.length
        : list.filter((entry) => entry.chain === chain).length;
  return total;
}

function poolHasTerm(entry: PoolSearchEntry, term: string) {
  return (
    entry.text.includes(term) ||
    (characters(term) >= MIN_ADDRESS_FRAGMENT && entry.ids.includes(term))
  );
}

/** Why a project is listed for a search. */
export type SearchMatch =
  | { via: "project" }
  | {
      via: "pool";
      /** The pool the row names: the one with the largest reserves among the
       * best matches. */
      pool: PoolSearchEntry;
      /** How many other pools of the project match in the same way. */
      more: number;
    };

/** Decide whether a project matches a search through its own text or through one
 * of its measured pools. The caller has already tried the whole search as plain
 * text; this reads it word by word.
 *
 * - `fields`: the project's folded text (name, use case, hook names, addresses).
 * - `network`: for each word, whether it names a network the page knows (it may
 *   be one word of a longer name, "x layer"), whether or not the project runs
 *   there.
 * - `ownNetwork`: whether the word at an index names a network the project runs
 *   on.
 * - `pools`: the project's measured pools in scope (one network when the page
 *   has one selected).
 *
 * Every word must match the project's text or a pool; the words the project's
 * text does not hold must all be found in ONE pool, so "usdc usdt" names a pair
 * and not two different pools. A network word is not matched against the
 * project's text at all: the project must run on that network, or the pool
 * must be on it. */
export function matchSearchTerms(
  terms: readonly string[],
  fields: readonly string[],
  network: readonly boolean[],
  ownNetwork: (index: number) => boolean,
  pools: readonly PoolSearchEntry[],
): SearchMatch | null {
  if (!terms.length) return null;
  // A network word is never found in the project's text: "based on tick
  // movement" holds "base", and a hook called GammaBase says nothing of a pool.
  // It is met by a network the project runs on, or by a pool on that network:
  // "usdc base" is a USDC pool on Base, not a project that mentions Base.
  const outside: number[] = [];
  terms.forEach((term, index) => {
    if (
      network[index] === true ||
      !fields.some((field) => field.includes(term))
    )
      outside.push(index);
  });
  if (!outside.length) return { via: "project" };
  // A word that names no network at all cannot name one the project runs on.
  if (outside.every((index) => network[index] === true && ownNetwork(index)))
    return { via: "project" };
  const wanted = outside.map((index) => terms[index]);
  let best: PoolSearchEntry | null = null;
  let first: PoolSearchEntry | null = null;
  let whole = 0;
  let partial = 0;
  for (const entry of pools) {
    if (!wanted.every((term) => poolHasTerm(entry, term))) continue;
    if (terms.every((term) => poolHasTerm(entry, term))) {
      whole++;
      best ??= entry;
    } else {
      partial++;
      first ??= entry;
    }
  }
  if (best) return { via: "pool", pool: best, more: whole - 1 };
  if (first) return { via: "pool", pool: first, more: partial - 1 };
  return null;
}

/** Fewest edits that turn one text into the other (insert, delete, replace, or
 * swap two neighbouring characters), or `limit + 1` once it is above `limit`. */
function editDistance(a: string[], b: string[], limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    rows.push(new Array<number>(b.length + 1).fill(0));
    rows[i][0] = i;
  }
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const same = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + same,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        value = Math.min(value, rows[i - 2][j - 2] + 1);
      rows[i][j] = value;
    }
  }
  return rows[a.length][b.length];
}

/** Fewest characters of a search that earns a "Did you mean" suggestion. */
export const MIN_SUGGESTION_LENGTH = 4;

/** One project name close to a search that found nothing, or null. The name must
 * be one edit away from a search of up to 7 characters, or two edits away from a
 * longer one, and must be the only closest name: a tie, or a name that is just
 * as near as another, suggests nothing. Names are compared whole, so a word
 * inside a longer name is never offered. */
export function suggestName(
  query: string,
  names: Iterable<string>,
): string | null {
  const wanted = Array.from(foldSearchText(query));
  if (wanted.length < MIN_SUGGESTION_LENGTH) return null;
  const limit = wanted.length <= 7 ? 1 : 2;
  let nearest = Infinity;
  const nearestNames = new Map<string, string>();
  for (const name of names) {
    const folded = foldSearchText(name);
    if (!folded) continue;
    const distance = editDistance(wanted, Array.from(folded), limit);
    if (distance < 1 || distance > limit || distance > nearest) continue;
    if (distance < nearest) {
      nearest = distance;
      nearestNames.clear();
    }
    // Two projects with the same name are one suggestion: choosing it finds both.
    if (!nearestNames.has(folded)) nearestNames.set(folded, name);
  }
  return nearestNames.size === 1 ? [...nearestNames.values()][0] : null;
}

/** The second line of the empty state: what a token, pair or pool search looked
 * through. `covered` is the pools of the projects in the current view, `all`
 * every pool the search can read, and `network` the display name of the one
 * network the page has selected, if any. Null when there is nothing to say. */
export function poolSearchCoverage(
  covered: number,
  all: number,
  network?: string | null,
): string | null {
  if (covered < 1) return null;
  const pools = `${covered.toLocaleString("en-US")} ${covered === 1 ? "pool" : "pools"}`;
  const place = network ? ` on ${displayPoolName(network, "")}` : "";
  return `Token, pair and pool search covers the ${pools} measured${place} in this snapshot${
    covered < all ? " for the projects in this view" : ""
  }.`;
}

/** A pool match as a row says it: "Matched pool USDC / USDT on Ethereum and 2
 * more pools". The pool's name is its own part so the page can isolate it from
 * the sentence (a symbol may be written right to left). */
export function poolMatchParts(match: Extract<SearchMatch, { via: "pool" }>) {
  return {
    before: "Matched pool ",
    name: match.pool.name,
    after: ` on ${match.pool.chainName}${
      match.more > 0
        ? ` and ${match.more} more ${match.more === 1 ? "pool" : "pools"}`
        : ""
    }`,
  };
}

export function poolMatchText(match: Extract<SearchMatch, { via: "pool" }>) {
  const { before, name, after } = poolMatchParts(match);
  return before + name + after;
}
