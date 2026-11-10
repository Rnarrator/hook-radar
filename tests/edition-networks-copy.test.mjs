// The Networks pages in the Auto Snapshot edition: wording that is true of a
// dated census rather than of the present, times in UTC, and one network total.
// Every helper takes the edition as a parameter, so each is checked with the flag
// on and off; with it off the live wording must be exactly what it always was.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  chainHeadCheckFailed,
  chainHeadCheckLead,
  chainHeadCheckTerm,
  chainIndexState,
  chainMeasurementLead,
  chainMeasurementTitle,
  chainSourceCaption,
  chainSourceFailed,
  chainSourceNote,
  chainStatusTitle,
  chainTime,
} from "../src/chain-network-directory.ts";

const source = (file) =>
  readFileSync(
    fileURLToPath(new URL(`../src/${file}`, import.meta.url)),
    "utf8",
  ).replace(/\r\n/g, "\n");

/** A network row as the page builds it, for a census network. */
const row = (patch = {}, inventory = {}) => ({
  slug: "celo",
  name: "Celo",
  chainId: 42220,
  caughtUp: true,
  headFresh: false,
  deploymentSupport: null,
  inventory: {
    status: "complete",
    scannedToBlock: 81233129,
    targetBlock: 81233129,
    headCheckedAt: "2026-10-27T21:03:40.286Z",
    ...inventory,
  },
  ...patch,
});
// The three errors with which the collector records a failed head check
// (server/pool-census.mjs); celo's record in the real snapshot carries the first.
const HEAD_ERRORS = [
  "Census source head is behind the canonical deployment or saved checkpoint",
  "Census source returned an invalid finalized head",
  "Census head contradicts the saved checkpoint hash",
];
// Errors the collector also records under the status "error", none of which
// says the head check failed.
const OTHER_ERRORS = [
  "Public census step exceeded its deadline",
  "Waiting to save the validated census checkpoint before scanning more history.",
  "Census source returned HTTP 503",
  null,
  undefined,
  "",
];
const celo = row({}, { status: "error", lastError: HEAD_ERRORS[0] });
const erroring = (lastError, patch = {}) =>
  row(patch, { status: "error", lastError });

test("only a recorded head-check error is called a failed head check", () => {
  for (const message of HEAD_ERRORS) {
    assert.equal(chainHeadCheckFailed(erroring(message)), true, message);
    // The collector may follow its message with detail.
    assert.equal(chainHeadCheckFailed(erroring(`${message}: x`)), true);
  }
  for (const message of OTHER_ERRORS)
    assert.equal(chainHeadCheckFailed(erroring(message)), false, `${message}`);
  // The message of another status is not a head-check failure either.
  assert.equal(
    chainHeadCheckFailed(row({}, { lastError: HEAD_ERRORS[0] })),
    false,
  );
  assert.equal(
    chainHeadCheckFailed(
      row({}, { status: "unavailable", lastError: HEAD_ERRORS[0] }),
    ),
    false,
  );
  assert.equal(chainHeadCheckFailed(row({ inventory: null })), false);
});

test("a failed head check is dated to the census in the edition and unchanged live", () => {
  assert.equal(chainSourceFailed(celo), true);
  assert.equal(chainSourceFailed(row()), false);
  assert.equal(chainSourceFailed(row({ inventory: null })), false);

  assert.deepEqual(chainIndexState(celo, false), {
    label: "Index source unavailable",
    state: "waiting",
  });
  assert.deepEqual(chainIndexState(celo, true), {
    label: "Head check failed at census",
    state: "waiting",
  });
  // Any other error is stated as an error, with no cause the data does not give.
  for (const message of OTHER_ERRORS) {
    assert.deepEqual(chainIndexState(erroring(message), true), {
      label: "Index source error at census",
      state: "waiting",
    });
    assert.equal(
      chainIndexState(erroring(message), false).label,
      "Index source unavailable",
    );
  }
  // No source at all is a different fact from a head check that failed.
  const none = row({}, { status: "unavailable" });
  assert.equal(chainIndexState(none, false).label, "Index source unavailable");
  assert.equal(
    chainIndexState(none, true).label,
    "Index source unavailable at census",
  );
  // Nothing else about a network's state moves with this change.
  for (const network of [
    row({ inventory: null }),
    row({ deploymentSupport: { label: "No published deployment" } }),
  ])
    assert.deepEqual(
      chainIndexState(network, true),
      chainIndexState(network, false),
    );
  assert.equal(
    chainIndexState(row({ headFresh: true }), false).state,
    "current",
  );
  assert.equal(
    chainIndexState(row({ headFresh: true }), true).label,
    "Saved pool history",
  );
  assert.equal(
    chainIndexState(row({ caughtUp: false }), true).label,
    "Saved pool history · scan incomplete",
  );
  assert.equal(
    chainIndexState(row({ caughtUp: false }), false).label,
    "Pool history syncing",
  );
});

test("the failure line keeps its live sentence and, in the edition, gives the census time", () => {
  assert.equal(
    chainSourceNote(celo, false),
    "The indexing source is currently unavailable. Saved block evidence remains visible.",
  );
  const edition = chainSourceNote(celo, true);
  // The time is that of the last head check that passed: a failed check does not
  // set it, so it is not the time of the failure.
  assert.equal(
    edition,
    "The indexing source did not pass its head check at the census (its last passing head check was 27 Oct 2026, 21:03 UTC). The saved block range was scanned to its recorded target.",
  );
  assert.doesNotMatch(edition, /currently|right now|today|last checked/i);

  // A scan that stopped short does not claim the target was reached.
  assert.equal(
    chainSourceNote(erroring(HEAD_ERRORS[1], { caughtUp: false }), true),
    "The indexing source did not pass its head check at the census (its last passing head check was 27 Oct 2026, 21:03 UTC). Saved block evidence remains visible.",
  );
  // An unreadable or missing head time is left out, not invented.
  for (const headCheckedAt of [null, undefined, "soon"])
    assert.doesNotMatch(
      chainSourceNote(
        row({}, { status: "error", lastError: HEAD_ERRORS[2], headCheckedAt }),
        true,
      ),
      /last passing|checked \d/,
    );
  // An error that is not a head-check failure is not called one, and no head
  // time is given as its cause.
  for (const message of OTHER_ERRORS) {
    assert.equal(
      chainSourceNote(erroring(message), true),
      "The indexing source reported an error at the census. The saved block range was scanned to its recorded target.",
    );
    assert.equal(
      chainSourceNote(erroring(message, { caughtUp: false }), true),
      "The indexing source reported an error at the census. Saved block evidence remains visible.",
    );
    assert.equal(
      chainSourceNote(erroring(message), false),
      "The indexing source is currently unavailable. Saved block evidence remains visible.",
    );
  }
  assert.equal(
    chainSourceNote(row({}, { status: "unavailable" }), true),
    "The indexing source was unavailable at the census. The saved block range was scanned to its recorded target.",
  );
  // A network that failed nothing has no such line in either edition.
  assert.equal(chainSourceNote(row(), true), null);
  assert.equal(chainSourceNote(row(), false), null);
  assert.equal(chainSourceNote(row({ inventory: null }), true), null);
});

test("a failed network's inventory caption is the edition's alone", () => {
  assert.equal(chainSourceCaption(celo, false), null);
  assert.equal(
    chainSourceCaption(celo, true),
    "Saved inventory · head check failed at census",
  );
  assert.equal(
    chainSourceCaption(row({}, { status: "unavailable" }), true),
    "Saved inventory · index source unavailable at census",
  );
  for (const message of OTHER_ERRORS) {
    assert.equal(
      chainSourceCaption(erroring(message), true),
      "Saved inventory · index source error at census",
    );
    assert.equal(chainSourceCaption(erroring(message), false), null);
  }
  assert.equal(chainSourceCaption(row(), true), null);
  assert.equal(chainSourceCaption(null, true), null);
});

test("the head-check time is called the last passing check after a head failure", () => {
  // Only a passing check sets the time, so beside a failed head check it is not
  // the time of the failure.
  assert.equal(chainHeadCheckLead(celo, true), "Last passing head check");
  assert.equal(chainHeadCheckTerm(celo, true), "Last passing head check");
  // Live wording is what it always was.
  assert.equal(chainHeadCheckLead(celo, false), "Chain head checked");
  assert.equal(chainHeadCheckTerm(celo, false), "Head last checked");
  // A network whose check did not fail, or that failed for another reason, keeps
  // the plain wording: its last head check is the last head check.
  for (const network of [
    row(),
    row({ inventory: null }),
    row({}, { status: "unavailable" }),
    ...OTHER_ERRORS.map((message) => erroring(message)),
  ]) {
    assert.equal(chainHeadCheckLead(network, true), "Chain head checked");
    assert.equal(chainHeadCheckTerm(network, true), "Head last checked");
  }
});

test("a tooltip time is the UTC time in the edition and the visitor's local time live", () => {
  const stamp = "2026-10-27T21:08:12.000Z";
  assert.equal(chainTime(stamp, true), "27 Oct 2026, 21:08 UTC");
  assert.equal(chainTime(stamp, false), new Date(stamp).toLocaleString());
  for (const edition of [true, false])
    for (const empty of [null, undefined, ""])
      assert.equal(chainTime(empty, edition), null);
  assert.equal(chainTime("soon", true), null);

  assert.equal(
    chainMeasurementTitle({ oldestAt: stamp }, true),
    "Oldest contributing measurement: 27 Oct 2026, 21:08 UTC",
  );
  assert.equal(
    chainMeasurementTitle({ oldestAt: stamp }, false),
    `Oldest contributing measurement: ${new Date(stamp).toLocaleString()}`,
  );
  for (const edition of [true, false])
    assert.equal(
      chainMeasurementTitle({ oldestAt: null }, edition),
      "Unavailable measurements are not zero.",
    );

  const scanned = chainStatusTitle(celo, true);
  assert.equal(
    scanned,
    "Scanned to block 81,233,129. Head checked: 27 Oct 2026, 21:03 UTC.",
  );
  assert.equal(
    chainStatusTitle(celo, false),
    `Scanned to block 81,233,129. Head checked: ${new Date("2026-10-27T21:03:40.286Z").toLocaleString()}.`,
  );
  assert.match(
    chainStatusTitle(row({}, { headCheckedAt: null }), true),
    /Head checked: Not checked\.$/,
  );
  assert.equal(
    chainStatusTitle(row({ inventory: null }), true),
    "This network has registry records but no canonical pool index.",
  );
  assert.equal(
    chainStatusTitle(
      row({ deploymentSupport: { label: "x", description: "Not deployed." } }),
      true,
    ),
    "Not deployed.",
  );
});

test("a visitor's time zone cannot move an edition tooltip to another day", () => {
  // 21:08 UTC on the 27th is already the 28th in Bangkok. The edition's text
  // must stay on the 27th, the date beside it on the page.
  const script = `
    import { chainTime } from ${JSON.stringify(new URL("../src/chain-network-directory.ts", import.meta.url).href)};
    const stamp = "2026-10-27T21:08:12.000Z";
    console.log(JSON.stringify({ edition: chainTime(stamp, true), live: chainTime(stamp, false) }));
  `;
  const out = JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, TZ: "Asia/Bangkok" },
      encoding: "utf8",
    }),
  );
  assert.equal(out.edition, "27 Oct 2026, 21:08 UTC");
  // The local rendering is on the 28th: what the edition must not show.
  assert.match(out.live, /28/);
  assert.doesNotMatch(out.edition, /28 Oct|AM|PM|GMT/);
});

test("the oldest measurement is named as such in the edition", () => {
  assert.equal(chainMeasurementLead(false), "updated");
  assert.equal(chainMeasurementLead(true), "oldest measured");
});

// The components pick these up behind the flag; the live text stays beside it.
test("each Networks component uses the edition wording behind STATIC_EDITION", () => {
  const directory = source("components/ChainNetworkDirectory.tsx");
  assert.doesNotMatch(
    directory,
    /new Date\([^)]*\)\.toLocale/,
    "a tooltip formats a time in the visitor's zone",
  );
  assert.match(directory, /chainMeasurementTitle\(/);
  assert.match(directory, /chainStatusTitle\(/);

  const explorer = source("components/ChainExplorer.tsx");
  assert.match(
    explorer,
    /const sourceNote = network \? chainSourceNote\(network\) : null;/,
  );
  assert.match(
    explorer,
    /\{sourceNote && <p className="chains-warning">\{sourceNote\}<\/p>\}/,
  );
  assert.match(explorer, /chainMeasurementLead\(\)/);
  // The head-check time is worded by the helpers, which know whether the check
  // failed; the explorer does not decide it from the status alone.
  assert.match(explorer, /\$\{chainHeadCheckLead\(network\)\}/);
  assert.match(explorer, /<dt>\{chainHeadCheckTerm\(network\)\}<\/dt>/);
  assert.doesNotMatch(
    explorer,
    /status === "error"/,
    "an error status is not a head-check failure",
  );
  assert.doesNotMatch(
    explorer,
    /\bupdated \{/,
    "the live 'updated' stays in the helper",
  );
  // An unknown network is not said to have been removed from a directory.
  assert.match(
    explorer,
    /STATIC_EDITION\s*\?\s*`This link names a network that is not in the \$\{fullTimeLabel\(snapshot\.generatedAt\)/,
  );
  assert.match(explorer, /headingLevel=\{STATIC_EDITION \? 2 : 3\}/);
  assert.match(
    explorer,
    /STATIC_EDITION && census \? ` · \$\{census\}` : ""/,
    "the indexed-network count carries the census date",
  );

  const charts = source("components/ChainCharts.tsx");
  assert.match(
    charts,
    /<CensusNote label=\{composition\.total === null \? null : census\} \/>/,
    "a network with no census has no census tag",
  );
  assert.match(charts, /STATIC_EDITION && chainSourceFailed\(row\)/);
  assert.match(
    charts,
    /chainSourceCaption\(network\) \?\? chainInventoryCaption\(network\)/,
  );

  const masthead = source("components/Masthead.tsx");
  assert.match(
    masthead,
    /STATIC_EDITION \? "Hooks, pools and networks" : "Hooks and pools"/,
    "the masthead date covers the Networks figure",
  );
  assert.match(masthead, /"with indexed pools"/);
  // The live masthead keeps its words.
  assert.match(masthead, /"chains we follow"/);
});
