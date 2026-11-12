// The documents' numbers and promises about the hourly rhythm, held to the code
// and the workflow they describe. A number in a document that no test reads can
// be changed, or can go stale, and the owner has only the document to go by:
// the history cap and the days it covers, the daily ceiling of collecting runs
// and of requests, the retry wait after a failure, the four hours after which
// the page calls a snapshot old, and what the guides say about a run you start
// by hand. Wording that an earlier review asked for is pinned too.
//
// Plain text reads only; nothing is written. The documents are found where they
// live in the source repository (docs/edition/) and in the assembled folder
// (README.md and docs/), so the test travels with the folder. Files are read
// with LF line ends so the checks hold on a Windows checkout (CRLF) too.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { HISTORY_MAX_POINTS, MIN_CURRENT_POOLS } from "../collector/config.mjs";
import { ANALYTICS_OVERVIEW_HISTORY_POINTS } from "../shared/analytics-overview.ts";
import { SNAPSHOT_STALE_AFTER_MS } from "../src/edition.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (path) =>
  readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n");

/** A document of the edition, or null: docs/edition/ in the source repository,
 * docs/ (and README.md at the top) in the assembled folder. */
function doc(name) {
  const candidates =
    name === "README-START-HERE.md"
      ? ["docs/edition/README-START-HERE.md", "README.md"]
      : [`docs/edition/${name}`, `docs/${name}`];
  const found = candidates.find((path) => existsSync(join(root, path)));
  return found ? read(found) : null;
}
const need = (name) => {
  const text = doc(name);
  assert.ok(text, `${name} is part of the edition`);
  return text;
};
/** The design contract lives only in the source repository. */
const design = () =>
  existsSync(join(root, "docs/STATIC-EDITION-DESIGN.md"))
    ? read("docs/STATIC-EDITION-DESIGN.md")
    : null;

const workflow = read(".github/workflows/snapshot.yml");
const number = (text) => Number(String(text).replaceAll(",", ""));
const WORDS = { four: 4, eight: 8 };
const value = (text) => WORDS[text] ?? number(text);

/** Every match of a pattern, which must be there exactly once, as numbers. */
function once(text, pattern, where) {
  const found = [...text.matchAll(pattern)];
  assert.equal(
    found.length,
    1,
    `${where}: expected the sentence ${pattern} once, found ${found.length}`,
  );
  return found[0].slice(1).map(value);
}

// ---- the history cap and its days -------------------------------------------

test("every history length the documents give is the cap, and its days are the cap at one run an hour", () => {
  const CAP = HISTORY_MAX_POINTS;
  const DAYS = CAP / 24;
  // The cap before the hourly schedule was the shared default: 672 points, 84
  // days of runs every three hours.
  const BEFORE = ANALYTICS_OVERVIEW_HISTORY_POINTS;
  assert.equal(CAP, 2016);
  assert.equal(DAYS, 84);
  assert.equal(BEFORE, 672);
  assert.equal((BEFORE * 3) / 24, 84, "the old cap covered the same 84 days");

  const works = need("HOW-IT-WORKS.md");
  const notes = need("COLLECTOR-NOTES.md");
  const contract = design();
  const rows = [
    [
      "HOW-IT-WORKS (the files table)",
      works,
      /At most ([\d,]+) points, newest last \((\d+) days at one run an hour/g,
      [CAP, DAYS],
    ],
    [
      "HOW-IT-WORKS (the state)",
      works,
      /cut to the last ([\d,]+) \((\d+) days at one run an hour\)/g,
      [CAP, DAYS],
    ],
    [
      "COLLECTOR-NOTES (the limits table)",
      notes,
      /`HISTORY_MAX_POINTS` \| ([\d,]+): (\d+) days of hourly runs/g,
      [CAP, DAYS],
    ],
    [
      "COLLECTOR-NOTES (history.json)",
      notes,
      /newest last, at most ([\d,]+) points\./g,
      [CAP],
    ],
    [
      "COLLECTOR-NOTES (the live app's number)",
      notes,
      /the number kept is not \(([\d,]+) here, (\d+) there\)/g,
      [CAP, BEFORE],
    ],
    [
      "COLLECTOR-NOTES (going back to an older collector)",
      notes,
      /the cap was (\d+) \((\d+) days of runs three hours apart\)\. Going back to a collector older than that change needs `state\/history\.json` cut to its last (\d+) points first/g,
      [BEFORE, DAYS, BEFORE],
    ],
  ];
  if (contract)
    rows.push(
      [
        "STATIC-EDITION-DESIGN (the files table)",
        contract,
        /at most ([\d,]+) points \((\d+) days at one run an hour\)/g,
        [CAP, DAYS],
      ],
      [
        "STATIC-EDITION-DESIGN (the state)",
        contract,
        /History is capped \(([\d,]+) points, (\d+) days at one run an hour/g,
        [CAP, DAYS],
      ],
    );
  for (const [where, text, pattern, expected] of rows)
    assert.deepEqual(once(text, pattern, where), expected, where);
  // The cap that the old collector refused is the one the notes warn about:
  // nothing else in the documents is left saying 672 of this edition's history.
  for (const [name, text] of [
    ["HOW-IT-WORKS", works],
    ["the start guide", need("README-START-HERE.md")],
    ["the GitHub Pages guide", need("HOSTING-GITHUB-PAGES.md")],
    ["PROVIDER-TERMS", need("PROVIDER-TERMS.md")],
  ])
    assert.doesNotMatch(text, /\b672\b/, `${name} names the old cap`);
});

// ---- the daily ceiling ------------------------------------------------------

test("the ceiling of collecting runs a day follows from the schedule and the gate, and the request totals from it", () => {
  const minutes = [...workflow.matchAll(/- cron: "(\d+) \* \* \* \*"/g)].map(
    (match) => Number(match[1]),
  );
  assert.ok(minutes.length >= 2, "the schedule has several triggers an hour");
  const minimumAge = Number(/MIN_AGE_MINUTES: "(\d+)"/.exec(workflow)[1]);
  // A collection at one trigger is saved at that moment at the earliest (a run
  // takes time, which only delays it); the next collects at the first trigger
  // at least the minimum age later. The shortest such gap is the fastest rhythm.
  const triggers = [];
  for (let hour = 0; hour < 72; hour += 1)
    for (const minute of minutes) triggers.push(hour * 60 + minute);
  const fastest = Math.min(
    ...triggers
      .filter((start) => start < 24 * 60)
      .map(
        (start) => triggers.find((next) => next >= start + minimumAge) - start,
      ),
  );
  const perDay = Math.floor((24 * 60) / fastest);
  assert.equal(
    fastest,
    60,
    "an hour at the fastest, with 45 minutes and 20-minute triggers",
  );
  // A run that takes longer than the minimum age leaves, between its start and
  // the saving of its state, less than the next trigger needs: the collection
  // then waits for the trigger after that, one step of the grid later.
  const step = Math.min(
    ...minutes.map(
      (minute, index) =>
        (minutes[(index + 1) % minutes.length] - minute + 60) % 60,
    ),
  );
  assert.deepEqual(
    once(
      need("COLLECTOR-NOTES.md"),
      /more than about (\d+) minutes from its start to saving its state[\s\S]*?the trigger (\d+) minutes later:\s+the rhythm is then (\d+) minutes, not (\d+)\./g,
      "COLLECTOR-NOTES (a long run)",
    ),
    [fastest - minimumAge, step, fastest + step, fastest],
  );
  const block = Number(/^\s*block=(\d+)$/m.exec(workflow)[1]);
  const blocksPerDay = 86400 / block;
  assert.equal(blocksPerDay, 8);

  const terms = need("PROVIDER-TERMS.md");
  assert.deepEqual(
    once(terms, /so at most (\d+) runs collect in a day/g, "PROVIDER-TERMS"),
    [perDay],
  );
  const [measureOnly] = once(
    terms,
    /A run that only measures the pools already known makes up to about ([\d,]+) requests/g,
    "PROVIDER-TERMS (a run that measures)",
  );
  const [extra] = once(
    terms,
    /makes up to about ([\d,]+) more \(about [\d,]+ of them to the v4\.xyz indexer\)/g,
    "PROVIDER-TERMS (a run that looks)",
  );
  assert.deepEqual(
    once(
      terms,
      /In a day that is up to about ([\d,]+) requests when a run collects in each hour, plus about ([\d,]+) for the up to (\w+) runs that look for new pools/g,
      "PROVIDER-TERMS (a day)",
    ),
    [perDay * measureOnly, blocksPerDay * extra, blocksPerDay],
  );
  // The Cloudflare guide counts builds from the same ceiling.
  assert.deepEqual(
    once(
      need("HOSTING-CLOUDFLARE-PAGES.md"),
      /about every hour, up to (\d+) times a day and about ([\d,]+) times a month/g,
      "HOSTING-CLOUDFLARE-PAGES",
    ),
    [perDay, 720],
  );
});

test("the wait after a failed run and the four hours after which the page calls a snapshot old are the ones the guides give", () => {
  const retry = Number(
    /RETRY_AFTER_FAILURE_MINUTES: "(\d+)"/.exec(workflow)[1],
  );
  assert.equal(retry, 90);
  const pages = need("HOSTING-GITHUB-PAGES.md");
  assert.deepEqual(
    once(
      pages,
      /holds the next collecting run back until (\d+) minutes after the failure/g,
      "HOSTING-GITHUB-PAGES",
    ),
    [retry],
  );
  assert.deepEqual(
    once(
      need("README-START-HERE.md"),
      /A run is also held back for (\d+) minutes after one that failed/g,
      "the start guide",
    ),
    [retry],
  );
  assert.equal(SNAPSHOT_STALE_AFTER_MS, 4 * 60 * 60_000);
  assert.deepEqual(
    once(
      need("HOSTING-NAMECHEAP.md"),
      /once it is more than (\w+) hours old/g,
      "HOSTING-NAMECHEAP",
    ),
    [SNAPSHOT_STALE_AFTER_MS / 3_600_000],
  );
  assert.deepEqual(
    once(
      need("HOW-IT-WORKS.md"),
      /When the snapshot is more than (\w+) hours old by that clock/g,
      "HOW-IT-WORKS",
    ),
    [SNAPSHOT_STALE_AFTER_MS / 3_600_000],
  );
});

// ---- what the gate has and has not been shown to do -------------------------

test("the notes say what the gate has been seen to do on GitHub and what it has not, and no document says it has been proven there", () => {
  // The proof the gate had was a test that runs its script under bash with a
  // stand-in clock. On 12 November 2026 the public run list of the repository
  // showed two scheduled runs (runs 9 and 10, started 02:48 and 03:08 UTC, 11 and
  // 9 seconds long) in which the job "Is a new snapshot due" was green and
  // "Collect and build" and "Publish to GitHub Pages" were skipped. A run started
  // by hand with force unticked, which is what the external timer sends, has not
  // been seen there. When it has, change this sentence of COLLECTOR-NOTES and this
  // test together, with the date.
  const notes = need("COLLECTOR-NOTES.md");
  assert.match(
    notes,
    /This was the only proof the gate had until 12 November\s+2026, when two scheduled runs of the repository \(runs 9 and 10, started at\s+02:48 and 03:08 UTC\) were seen on GitHub ending at the gate: "Is a new snapshot due"\s+green after a few seconds, "Collect and build" and "Publish to GitHub Pages" skipped\.\s+A run started by hand with "force" unticked has not yet run on GitHub\. Prove it there\s+with one \*\*Run workflow\*\* with "force" unticked/,
  );
  assert.match(
    notes,
    /The behaviour for a call with force unticked has been\s+shown only by the test above, not yet on GitHub\./,
  );
  assert.doesNotMatch(
    notes,
    /it has not\s+yet run on GitHub|Like the rest of the gate/,
    "the claim that no part of the gate had run on GitHub is gone",
  );
  for (const name of [
    "README-START-HERE.md",
    "HOSTING-GITHUB-PAGES.md",
    "HOW-IT-WORKS.md",
    "PROVIDER-TERMS.md",
    "COLLECTOR-NOTES.md",
  ])
    assert.doesNotMatch(
      need(name),
      /gate (?:has|was|is) (?:been )?(?:proved|proven|verified|tested) on GitHub/i,
      name,
    );
});

test("the estimate for a run that only measures is the real run's figures and the live minimum", () => {
  const notes = need("COLLECTOR-NOTES.md");
  const [current, discovered, estimate, minimum] = once(
    notes,
    /\(([\d,]+) pools with a current 24h volume, and (\d+)\s+pools newly found by its discovery\) a run that only measures the known pools would have\s+had about ([\d,]+) against the minimum of ([\d,]+)\./g,
    "COLLECTOR-NOTES (the estimate)",
  );
  assert.equal(current - discovered, estimate);
  assert.equal(minimum, MIN_CURRENT_POOLS);
  assert.match(
    notes,
    /That is an estimate from the published status\s+of that run; the first real run that only measures will confirm it\./,
  );
});

// ---- the wording the review asked for ---------------------------------------

test("the guides do not promise an hour flat, even in their first paragraph", () => {
  const start = need("README-START-HERE.md");
  assert.match(
    start,
    /refresh themselves about every hour when GitHub starts the runs, and less often when GitHub is busy, with nothing of yours switched on/,
  );
  const contract = design();
  if (contract)
    assert.match(
      contract,
      /refresh \*\*by themselves about every hour when GitHub starts the runs\*\*/,
    );
  assert.match(
    need("COLLECTOR-NOTES.md"),
    /job runs about every hour when GitHub starts it\./,
  );
});

test("a run started by hand does not look for new pools unless asked, and the first run's step says so", () => {
  const start = need("README-START-HERE.md");
  const step = start
    .split("\n")
    .find((line) => line.startsWith("6. **Run the Snapshot job once.**"));
  assert.ok(step, "step 6 is there");
  assert.match(
    step,
    /This first run measures the pools the folder already knows and does not look for new pools; to make it do that too, tick \*\*discover\*\* in the same box\./,
  );
  // True of the workflow: the input exists and is off by default.
  assert.match(
    workflow,
    /discover:\n\s+description: "Also look for new pools[^\n]*\n\s+type: boolean\n\s+default: false/,
  );
});

test("the discovery rule is described as at most one run in each block, the same everywhere", () => {
  const names = [
    "README-START-HERE.md",
    "HOSTING-GITHUB-PAGES.md",
    "PROVIDER-TERMS.md",
    "COLLECTOR-NOTES.md",
  ];
  for (const name of names) {
    const text = need(name);
    assert.match(
      text,
      /at most (?:one run in each|once in each) three-hour block/,
      name,
    );
    assert.doesNotMatch(
      text,
      /first collecting run of (?:each|every|the) (?:three-hour )?block/,
      `${name} still promises a search in every block`,
    );
  }
  // The workflow's own comment says the same: a run that begins in one block and
  // ends in the next leaves that next block without a search.
  assert.match(
    workflow,
    /so at most once per block \(a\s+# run that starts in one block and ends in the next leaves that next block\s+# without a search\)/,
  );
  assert.doesNotMatch(
    workflow,
    /once per block even\s+# when some runs never start/,
  );
});

test("a failed publish is described as delaying the next attempt, and the Namecheap route's old-snapshot notice is named", () => {
  assert.match(
    need("HOSTING-GITHUB-PAGES.md"),
    /If only the last job, "Publish to GitHub Pages", fails, the new snapshot is saved but not shown, and the site waits about 90 minutes or more for the next one\./,
  );
  assert.match(
    need("HOSTING-NAMECHEAP.md"),
    /so a run that GitHub starts more than about an hour late makes the page say so\./,
  );
});
