// The owner's documents of the Auto Snapshot edition: the start guide, the
// provider terms, the GitHub Pages guide's troubleshooting table and the design
// contract's sentence about the live build. These are instructions for a
// person who is not a developer, so the checks read them against the real
// workflows (step names, the Collect line, the variable names) and pin what
// the review of the finished edition asked to be said.
//
// Plain text reads only; nothing is written. The documents are found where they
// live in the source repository (docs/edition/) and in the assembled folder
// (README.md and docs/), so the test travels with the folder. Files are read
// with LF line ends so the checks hold on a Windows checkout (CRLF) too.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
const start = () => need("README-START-HERE.md");

/** The text of one `## ` section of a document. */
function section(text, heading) {
  const from = text.indexOf(`\n## ${heading}`);
  assert.notEqual(from, -1, `the section "${heading}" exists`);
  const to = text.indexOf("\n## ", from + 4);
  return text.slice(from, to === -1 ? undefined : to);
}

/** The numbered steps of the start guide, each one line: [{ number, title, text }]. */
function steps(text) {
  return section(text, "Publish it: about 10 minutes of your time")
    .split("\n")
    .flatMap((line) => {
      const head = /^(\d+)\. \*\*(.+?)\*\*/.exec(line);
      return head
        ? [{ number: Number(head[1]), title: head[2], text: line }]
        : [];
    });
}

const snapshotYml = () => read(".github/workflows/snapshot.yml");
const ftpYml = () => read(".github/workflows/deploy-ftp.yml");

/* ── The start guide: the first screen and the order of the steps ────────── */

test("the start guide says what to do before it describes the edition", () => {
  const text = start();
  const what = text.indexOf("**What to do**");
  const describe = text.indexOf("Hook Radar is a website");
  assert.ok(what > 0, "a What to do block is there");
  assert.ok(what < describe, "it comes before the description");
  const block = text.slice(what, describe);
  // Put the folder on GitHub, choose a licence and make the repository public
  // (Pages needs a public repository and a reader who uses only these lines
  // must not end with a private one), set Pages to GitHub Actions, press Run
  // workflow.
  assert.match(
    block,
    /Put this folder on GitHub as a repository, choose a licence and make it public, set GitHub Pages to \*\*GitHub Actions\*\*/,
  );
  assert.match(block, /GitHub Pages to \*\*GitHub Actions\*\*/);
  assert.match(block, /press \*\*Run workflow\*\*/);
  // The effort is the owner's 10 minutes; the first run needs about 15 more.
  assert.match(block, /about 10 minutes of your own time/);
  assert.match(block, /about 15 minutes/);
  assert.ok(
    block.split("\n").filter((line) => line.startsWith("- ")).length === 2,
    "two lines, not a page",
  );
});

test("the steps are numbered in a working order: private, licence, public, Pages, first run", () => {
  const list = steps(start());
  assert.deepEqual(
    list.map((step) => step.number),
    list.map((_step, index) => index + 1),
    "the numbers run 1, 2, 3 without a gap or a repeat",
  );
  const at = (pattern) => list.findIndex((step) => pattern.test(step.title));
  const order = [
    at(/Add this folder/),
    at(/Publish the repository, private/),
    at(/licence/i),
    at(/public/i),
    at(/Pages/),
    at(/Run the Snapshot job/),
    at(/Wait/),
    at(/Open the site/),
  ];
  assert.ok(
    order.every((index) => index >= 0),
    `every step is there: ${order}`,
  );
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
    "they come in that order",
  );
  assert.equal(list.length, 8);
  // The repository is published private, because the licence comes first.
  const publish = list[order[1]].text;
  assert.match(publish, /make sure \*\*"Keep this code private"\*\* is ticked/);
  assert.doesNotMatch(start(), /untick "Keep this code private"/i);
  // The route that starts from an empty repository keeps its warning.
  assert.match(
    publish,
    /do not tick "Add a README", "\.gitignore" or a licence/,
  );
});

test("the licence step does not choose a licence for the owner and says what a licence cannot cover", () => {
  const step = steps(start()).find((item) => /licence/i.test(item.title));
  assert.ok(step, "there is a licence step");
  assert.match(
    step.text,
    /press \*\*Add file\*\*, \*\*Create new file\*\*, name it `LICENSE` and use the licence template picker, then press \*\*Review and submit\*\* and \*\*Commit changes\*\*; without one nobody may legally reuse your code\./,
  );
  // The picker only fills the file in: the step must say to commit it, or
  // step 4 publishes a repository without a LICENSE.
  assert.ok(
    step.text.indexOf("Review and submit") >
      step.text.indexOf("licence template picker") &&
      step.text.indexOf("Commit changes") >
        step.text.indexOf("Review and submit"),
    "the picker, then Review and submit, then Commit changes",
  );
  assert.match(
    step.text,
    /The data and the logos on the site are not yours to licence: see \[docs\/PROVIDER-TERMS\.md\]\(docs\/PROVIDER-TERMS\.md\)\./,
  );
  // No licence is named, so nothing is chosen on the owner's behalf.
  assert.doesNotMatch(step.text, /\b(?:MIT|Apache|GPL|BSD|ISC|Unlicense)\b/);
  // The page the step points to says the licence covers the code only.
  assert.match(
    need("PROVIDER-TERMS.md"),
    /Whatever licence you choose for the code .* covers your code only: the data stays under the providers' terms and the logos belong to their owners\./,
  );
});

test("the first commit's identity is explained before the repository is made public, and who can change it", () => {
  const publish = steps(start()).find((item) =>
    /Publish the repository/.test(item.title),
  ).text;
  // The folder is delivered without a Git history: the first commit is made in
  // GitHub Desktop, with the identity set there.
  assert.match(
    publish,
    /The first commit carries the name and e-mail address from GitHub Desktop's settings \(File, Options, Git\)\. GitHub shows them publicly once the repository is public;/,
  );
  assert.match(publish, /GitHub no-reply address/);
  // A folder assembled with --init-git has a commit already; who can choose its
  // identity, and with which options, in one short parenthesis.
  assert.match(
    publish,
    /whoever assembled it can choose its identity with `--author-name` and `--author-email`/,
  );
  const first = steps(start())[0].text;
  assert.match(first, /press \*\*create a repository\*\*/);
  assert.match(first, /Commit to main/);
});

test("the repository is made public in Settings, General, Danger Zone before Pages is switched on", () => {
  const step = steps(start()).find((item) => /public/i.test(item.title));
  assert.match(
    step.text,
    /Settings, then General, scroll down to the Danger Zone, press \*\*Change visibility\*\* and choose to make the repository public/,
  );
  assert.match(step.text, /Pages needs a public repository/);
  // The Pages guide agrees with the order instead of saying "public" alone.
  assert.match(
    need("HOSTING-GITHUB-PAGES.md"),
    /root README, which publishes it private first so that you can add a licence, then makes it public\)/,
  );
});

test("the names the guide gives are the names the workflow has", () => {
  const text = start();
  const workflow = snapshotYml();
  for (const name of [
    "Snapshot",
    "Is a new snapshot due",
    "Collect and build",
    "Publish to GitHub Pages",
    "Check that GitHub Pages is switched on",
    "Collect the snapshot",
  ])
    assert.match(
      workflow,
      new RegExp(`^\\s*(?:- )?name: ${name}$`, "m"),
      `snapshot.yml has "${name}"`,
    );
  assert.match(text, /"Collect and build", then "Publish to GitHub Pages"/);
  assert.match(text, /"Check that GitHub Pages is switched on"/);
  assert.match(
    text,
    /all three jobs \("Is a new snapshot due", "Collect and build", then "Publish to GitHub Pages"\)/,
  );
  assert.doesNotMatch(text, /both jobs|both steps/);
  // The numbers the guide quotes.
  assert.match(workflow, /timeout-minutes: 45/);
  assert.match(text, /exceeds 45 minutes/);
  for (const minute of [7, 27, 47])
    assert.match(workflow, new RegExp(`cron: "${minute} \\* \\* \\* \\*"`));
  assert.match(text, /\(at 7, 27 and 47 minutes past, UTC\)/);
  assert.doesNotMatch(text, /17 minutes past 00:00, 03:00, 06:00/);
});

test("the guide says what the first run needs and how often the job really runs", () => {
  const text = start();
  assert.match(
    text,
    /The first run takes about 15 minutes, because the collector pauses between requests/,
  );
  assert.match(
    text,
    /GitHub is asked to start the Snapshot job three times an hour/,
  );
  assert.match(text, /So the site is refreshed about every hour/);
  assert.match(
    text,
    /GitHub may start a scheduled run late, or not at all, when it is busy, so the site can be older than an hour/,
  );
  assert.doesNotMatch(text, /a few minutes late/);
  // A red cross on the first run is explained, not left as a surprise.
  assert.match(
    text,
    /If a job shows a red cross instead, nothing was published and there is no site yet: see "How you find out" below\./,
  );
  assert.match(text, /\*\*How you find out\.\*\*/);
});

test("the v4.xyz note comes before Pages is switched on, because from then on the schedule asks v4.xyz by itself", () => {
  const list = steps(start());
  const pages = list.find((item) => /Pages/.test(item.title));
  const run = list.find((item) => /Run the Snapshot job/.test(item.title));
  assert.match(
    pages.text,
    /^5\. \*\*Switch on GitHub Pages\.\*\* One note first: once Pages is on, the job also starts by itself within the hour, not only when you press Run workflow, and it asks the v4\.xyz indexer, whose two paths are not a documented public API\. See \[docs\/PROVIDER-TERMS\.md\]\(docs\/PROVIDER-TERMS\.md\) item 1\. If you want to wait for the v4\.xyz maintainers' answer, make the one-line edit there before you switch Pages on\. Then, in the repository on github\.com, open Settings, then Pages\./,
  );
  // The note is not left for the step after Pages: by then a scheduled run may
  // already have asked v4.xyz.
  assert.doesNotMatch(run.text, /v4\.xyz|PROVIDER-TERMS|one-line edit/);
  assert.match(
    run.text,
    /^6\. \*\*Run the Snapshot job once\.\*\* Open the Actions tab,/,
  );
  // The claim is true of the workflow: it has a schedule, the Pages check is
  // the only gate before the Collect step, and Collect itself is not
  // conditional, so once Pages is on the next scheduled run collects.
  const workflow = snapshotYml();
  assert.match(workflow, /^on:\n {2}schedule:\n/m);
  const between = workflow.slice(
    workflow.indexOf("name: Check that GitHub Pages is switched on"),
    workflow.indexOf("- name: Collect the snapshot"),
  );
  assert.doesNotMatch(
    between,
    /^\s+if:/m,
    "no condition between the Pages check and the Collect step",
  );
  const terms = need("PROVIDER-TERMS.md");
  const item = terms.slice(terms.indexOf("\n1. **Ask the v4.xyz maintainers"));
  // The provider terms say the same thing at the same time: before Pages.
  assert.match(
    item,
    /Make it before you switch on GitHub Pages, because once Pages is on the job also starts by itself within the hour, not only when you press Run workflow\./,
  );
  assert.ok(
    item.indexOf("Make it before you switch on GitHub Pages") <
      item.indexOf("--max-discovery 0"),
    "the timing comes before the edit",
  );
  assert.match(
    item,
    /On github\.com open `\.github\/workflows\/snapshot\.yml`, press the pencil icon, change the line `run: node collector\/run\.mjs` \(the step named "Collect the snapshot"\) to `run: node collector\/run\.mjs --max-discovery 0`, and commit\./,
  );
  // The edit has a way back, and says what the site does until it is made.
  assert.match(
    item,
    /When they agree, open the same file, press the pencil icon, change the line back to `run: node collector\/run\.mjs` and commit; until you do, the site does not learn new pools\./,
  );
  assert.match(item, /This stops all discovery and every v4\.xyz request\./);
  assert.match(
    item,
    /The site keeps measuring the pools it already knows through DEX Screener but stops learning new ones/,
  );
  // No contact is invented: the maintainers are reached from their own site
  // (the page no longer has a dialog that lists it).
  assert.match(item, /start from www\.v4\.xyz and ask in writing/);
  assert.doesNotMatch(item, /Data and sources dialog/);
  assert.doesNotMatch(terms, /[\w.+-]+@[\w-]+\.\w+/, "no e-mail address");
  // The edit is real: the Collect line is the bare command in both workflows
  // (or the command with the flag, once the owner has made the edit: the
  // checks must stay green on the owner's own commit), and the collector
  // knows the flag (0 turns discovery off).
  for (const [name, text] of [
    ["snapshot.yml", snapshotYml()],
    ["deploy-ftp.yml", ftpYml()],
  ]) {
    const collect = text.match(
      /- name: Collect the snapshot\n(?:\s+#.*\n|\s+env:\n|\s+COLLECTOR_MAX_DISCOVERY: .*\n)*\s+run: (.+)\n/,
    );
    assert.ok(collect, `${name} has the Collect step`);
    assert.match(
      collect[1],
      /^node collector\/run\.mjs(?: --max-discovery 0)?$/,
      name,
    );
  }
  assert.match(
    read("collector/run.mjs"),
    /--max-discovery <n>\s+at most n networks for discovery \(0 turns discovery off\)/,
  );
  assert.match(
    item,
    /The FTPS route has the same Collect line in `deploy-ftp\.yml`; make the edit there before its first run\./,
  );
  // Both documents agree on when to settle it.
  assert.match(terms, /before you announce the site/);
  assert.doesNotMatch(terms, /before you make the site public/);
  assert.match(start(), /Before you tell people about the site, read/);
});

/** The edit item 1 of the provider terms tells the owner to make, read from
 * the words of the document: the line to change, what it becomes and the line
 * to put back. */
function documentedStop() {
  const terms = need("PROVIDER-TERMS.md");
  const item = terms.slice(terms.indexOf("\n1. **Ask the v4.xyz maintainers"));
  const edit =
    /change the line `(run: node collector\/run\.mjs)` \(the step named "Collect the snapshot"\) to `(run: node collector\/run\.mjs --max-discovery 0)`/.exec(
      item,
    );
  const back = /change the line back to `(run: node collector\/run\.mjs)`/.exec(
    item,
  );
  assert.ok(edit && back, "item 1 names the line, the edit and the way back");
  return { from: edit[1], to: edit[2], back: back[1] };
}

test("the one-line v4.xyz edit can be made on both workflows and undone, and no step changes place", () => {
  const { from, to, back } = documentedStop();
  assert.equal(back, from, "the way back restores the line the edit changed");
  // Step names in the order they run, up to the last gate before anything is
  // published. The Pages check comes before Collect in the Pages workflow.
  const order = {
    "snapshot.yml": [
      "Check that GitHub Pages is switched on",
      "Collect the snapshot",
      "Build the site",
      "Check that the data is a live snapshot",
      "Save state",
      "Upload the site",
    ],
    "deploy-ftp.yml": [
      "Collect the snapshot",
      "Build the site",
      "Check that the data is a live snapshot",
      "Save state",
      "Upload by FTPS",
    ],
  };
  for (const [name, text] of [
    ["snapshot.yml", snapshotYml()],
    ["deploy-ftp.yml", ftpYml()],
  ]) {
    // Whether or not the owner has made the edit yet, start from the file
    // without it.
    const original = text.replace(`${to}\n`, `${from}\n`);
    const line = new RegExp(`^ {8}${from.replace(/\./g, "\\.")}$`, "gm");
    assert.equal(
      original.match(line)?.length,
      1,
      `${name}: the line the guide names is there exactly once`,
    );
    const edited = original.replace(line, `        ${to}`);
    // One line differs, and it is the Collect step's.
    const before = original.split("\n");
    const after = edited.split("\n");
    assert.equal(after.length, before.length);
    const changed = after.flatMap((l, at) => (l === before[at] ? [] : [at]));
    assert.equal(changed.length, 1, `${name}: one line changes`);
    const head = after.lastIndexOf(
      "      - name: Collect the snapshot",
      changed[0],
    );
    assert.ok(
      head !== -1 &&
        after
          .slice(head + 1, changed[0])
          .every((l) => /^\s+(?:#|env:|COLLECTOR_MAX_DISCOVERY:)/.test(l)),
      `${name}: the changed line belongs to the Collect step`,
    );
    // The way back restores the file, byte for byte.
    assert.equal(edited.replace(`${to}\n`, `${from}\n`), original, name);
    // Every step keeps its place and nothing is added or made conditional.
    for (const file of [original, edited]) {
      const names = [...file.matchAll(/^ +- name: (.+)$/gm)].map((m) => m[1]);
      const at = order[name].map((step) => names.indexOf(step));
      assert.ok(
        at.every((i) => i >= 0),
        `${name}: ${at}`,
      );
      assert.deepEqual(
        at,
        [...at].sort((a, b) => a - b),
        name,
      );
      const gated = file.slice(
        file.indexOf(`- name: ${order[name][0]}`),
        file.indexOf(`- name: ${order[name].at(-1)}`),
      );
      assert.doesNotMatch(gated, /^\s+(?:if|continue-on-error):/m, name);
    }
  }
});

test("--max-discovery 0, as the guide's edit writes it, stops every v4.xyz request and leaves the measuring alone", async () => {
  const { to } = documentedStop();
  const flags = to.replace(/^run: node collector\/run\.mjs ?/, "").split(" ");
  assert.deepEqual(flags, ["--max-discovery", "0"]);
  const { FIXTURES, main, runCollector } = await import("../collector/run.mjs");

  // The command line, as the workflow runs it (offline replay, nothing
  // written), reading the verbose log: one line per request outcome. A direct
  // use of the network would be recorded, and refused.
  async function viaCommandLine(extra) {
    const lines = [];
    const reached = [];
    const { log, error } = console;
    const realFetch = globalThis.fetch;
    console.log = () => {};
    console.error = (...args) => lines.push(args.join(" "));
    globalThis.fetch = (url) => {
      reached.push(String(url));
      throw new Error("The network was used during an offline run.");
    };
    try {
      await main(["--offline", "--no-publish", "--verbose", ...extra]);
    } finally {
      console.log = log;
      console.error = error;
      globalThis.fetch = realFetch;
    }
    const requests = (provider) =>
      lines.filter((l) =>
        new RegExp(`^(?:ok  |FAIL|WAIT) ${provider}\\b`).test(l),
      ).length;
    return { lines, reached, requests };
  }
  const off = await viaCommandLine(flags);
  const on = await viaCommandLine([]);
  assert.deepEqual(off.reached, [], "nothing bypassed the collector's client");
  assert.deepEqual(on.reached, []);
  assert.ok(off.lines.includes("Discovery: 0 networks, up to 0 exact lookups"));
  assert.equal(off.requests("v4xyz"), 0, "the flag: no request to v4.xyz");
  // The control: the same run without the flag does ask v4.xyz, so the count
  // above is not an empty log.
  assert.ok(on.lines.some((l) => /^Discovery: [1-9]\d* networks/.test(l)));
  assert.ok(on.requests("v4xyz") > 0, "without the flag v4.xyz is asked");
  // The pools already known are still measured through DEX Screener.
  assert.ok(off.requests("dexscreener") > 0);
  assert.ok(off.requests("registry") > 0);

  // The same from the other side: the addresses the replay was asked for, and
  // the collector's own count of requests per provider in status.json.
  async function viaRunCollector(options) {
    const result = await runCollector({
      offline: true,
      publish: false,
      stateDir: join(FIXTURES, "state"),
      ...options,
    });
    const hosts = result.served.map((entry) => new URL(entry.url).hostname);
    return {
      v4xyz: hosts.filter((host) => host === "www.v4.xyz").length,
      dex: hosts.filter((host) => host === "api.dexscreener.com").length,
      counted: result.status.counts.requests.v4xyz,
    };
  }
  const stopped = await viaRunCollector({ maxDiscovery: 0 });
  const running = await viaRunCollector({});
  assert.deepEqual(
    { v4xyz: stopped.v4xyz, counted: stopped.counted },
    { v4xyz: 0, counted: 0 },
  );
  assert.ok(stopped.dex > 0);
  assert.ok(running.v4xyz > 0 && running.counted === running.v4xyz);
});

test("the provider terms state no limit or term of a provider as a fact the project could not source", () => {
  const terms = need("PROVIDER-TERMS.md");
  // DEX Screener: to check, never quoted.
  assert.doesNotMatch(terms, /bar reselling/i);
  assert.doesNotMatch(terms, /Access can be ended/i);
  assert.doesNotMatch(terms, /can end access at any time/i);
  assert.match(
    terms,
    /Not verified by the project\. Check DEX Screener's current terms: what they say about reselling or republishing its data, about showing figures derived from it on a public site, and about ending access/,
  );
  assert.match(
    terms,
    /\*\*Read DEX Screener's current terms\.\*\* Check what they say about showing figures derived from its data on a public site, about reselling or republishing data, and about ending access\./,
  );
  // GeckoTerminal: the collector's own rate, the free tier to check, the
  // attribution wording to check and not asserted.
  assert.match(
    terms,
    /Check which attribution wording GeckoTerminal and CoinGecko ask for\. About 5 requests a minute is what this collector stays under; CoinGecko's own pages say paid plans raise the free tier, so check the current limits/,
  );
  assert.doesNotMatch(terms, /not designed for scheduled polling/);
  assert.doesNotMatch(terms, /Data provided by GeckoTerminal/);
  assert.doesNotMatch(terms, /Asks for attribution/);
  // The design contract says the same, so the two documents do not disagree.
  const design = doc("STATIC-EDITION-DESIGN.md");
  if (design) {
    assert.doesNotMatch(design, /documented keyless limit/);
    assert.doesNotMatch(design, /DEX Screener can end access any time/);
    assert.match(
      design,
      /the collector stays under about 5 a minute; check CoinGecko's current limits/,
    );
  }
});

test("the shutdown instructions work for the route the owner is on", () => {
  const terms = need("PROVIDER-TERMS.md");
  const stop = section(terms, "If a provider asks you to stop");
  assert.match(
    stop,
    /Disable the Snapshot workflow \(Actions, Snapshot, the three dots, Disable workflow\)/,
  );
  assert.match(stop, /"Deploy to Namecheap by FTPS"/);
  assert.match(stop, /`ENABLE_FTP_DEPLOY`/);
  assert.match(ftpYml(), /name: Deploy to Namecheap by FTPS/);
  assert.match(ftpYml(), /if: \$\{\{ vars\.ENABLE_FTP_DEPLOY == 'true' \}\}/);
  assert.match(
    stop,
    /make the one-line edit in item 1 above before you enable the workflow again, and change the line back only when they agree\./,
  );
  assert.doesNotMatch(stop, /remove that provider from the collector/);
  assert.doesNotMatch(terms, /remove that provider from the collector/);
});

/* ── What GitHub does, said as far as it is known ────────────────────────── */

test("no document promises that the job's own commits keep scheduled runs alive", () => {
  const text = start();
  assert.match(
    text,
    /GitHub can switch scheduled jobs off in a public repository after a long time without activity\. If the runs ever stop, open the Actions tab and press \*\*Enable workflow\*\* on Snapshot\./,
  );
  const guide = need("HOSTING-GITHUB-PAGES.md");
  assert.match(
    guide,
    /\| Runs stop appearing\s+\| GitHub can switch scheduled jobs off in a public repository after a long time without activity\. Actions, Snapshot, \*\*Enable workflow\*\*/,
  );
  for (const [name, body] of [
    ["the start guide", text],
    ["the GitHub Pages guide", guide],
    ["the provider terms", need("PROVIDER-TERMS.md")],
    ["the design contract", doc("STATIC-EDITION-DESIGN.md") ?? ""],
  ]) {
    assert.doesNotMatch(body, /60 days|60-day|sixty days/i, name);
    assert.doesNotMatch(
      body,
      /keeps? (?:the )?(?:timer|schedule|workflow) (?:alive|active|running)/i,
      name,
    );
  }
});

test("the 404 row says a run that did not succeed leaves no site", () => {
  assert.match(
    need("HOSTING-GITHUB-PAGES.md"),
    /\| The site address shows GitHub's 404 page\s+\| The first run has not finished or did not succeed \(a red cross on the run\), or Pages is not set to GitHub Actions\. Until one run is green there is no site to show\s+\|/,
  );
  // The start guide's line about the last good snapshot is about later runs.
  const after = section(start(), "What happens after that");
  assert.match(
    after,
    /\*\*If a refresh fails\.\*\* The site is \*\*not\*\* updated\. It keeps showing the last good snapshot/,
  );
});

test("the guide tells a first-time GitHub Desktop user to pull before pushing", () => {
  const after = section(start(), "What happens after that");
  assert.match(
    after,
    /Because the job saves its memory to the repository about every hour, GitHub Desktop will often show Fetch origin or Pull origin\. If you change a file on your computer, press Pull origin first, then Push origin\./,
  );
  // It sits beside the bullet that says the job commits state/.
  assert.ok(
    after.indexOf("Update snapshot state [skip ci]") <
      after.indexOf("GitHub Desktop will often show"),
  );
  assert.match(
    snapshotYml(),
    /git commit -m "Update snapshot state \[skip ci\]"/,
  );
});

test("the costs paragraph names the Pages rule and its soft bandwidth limit", () => {
  assert.match(
    section(start(), "What it costs"),
    /GitHub Pages is for sites like this one, not for running a business or shop; if you ever add ads or sell something, check GitHub's Pages limits page \(it also has a soft 100 GB per month bandwidth limit\) or move to another host\./,
  );
  // The provider terms do not grow a decisions box for it.
  assert.doesNotMatch(need("PROVIDER-TERMS.md"), /Your decisions/i);
});

/* ── Link previews and the data folder ───────────────────────────────────── */

test("link previews are an optional last section, and SITE_URL is true for the routes it names", () => {
  const text = start();
  const headings = [...text.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
  assert.equal(headings.at(-1), "Optional: link previews");
  assert.ok(
    !text
      .slice(0, text.indexOf("## Optional: link previews"))
      .includes("Link previews"),
    "the detail is not in the main flow",
  );
  const optional = section(text, "Optional: link previews");
  assert.match(
    optional,
    /Vercel or Cloudflare address, or the address of your FTPS site/,
  );
  assert.match(optional, /`SITE_URL`/);
  assert.match(optional, /`VITE_SITE_URL`/);
  assert.match(
    optional,
    /the GitHub Pages address \(and a custom domain's address\) by itself/,
  );
  // The claim holds: the GitHub Pages build works the address out, the copy
  // for Vercel and Cloudflare and the FTPS build read the variable.
  const workflow = snapshotYml();
  assert.match(
    workflow,
    /VITE_SITE_URL: \$\{\{ steps\.site\.outputs\.url \}\}/,
  );
  // The mirror step reads the variable and hands it to the build as
  // VITE_SITE_URL (after the same check the build applies, so a value typed
  // without https:// leaves the picture out instead of stopping the step).
  const mirror = workflow.slice(
    workflow.indexOf("- name: Mirror build for other hosts"),
    workflow.indexOf("- name: Mirror to the site branch"),
  );
  assert.match(mirror, /env:\n\s+SITE_URL: \$\{\{ vars\.SITE_URL \}\}/);
  assert.match(
    mirror,
    /VITE_SITE_URL="\$\{site_url\}" npm run build:static -- --require-data --outDir site-mirror/,
  );
  assert.match(ftpYml(), /VITE_SITE_URL: \$\{\{ vars\.SITE_URL \}\}/);
});

test("the start guide keeps the words the other checks look for", () => {
  const text = start();
  assert.match(text, /from a web address/i);
  assert.match(text, /blank page/i);
  assert.match(text, /SITE_URL/);
  assert.match(text, /VITE_SITE_URL/);
});

test("the local preview address is the one the preview prints, not a fixed 4173", () => {
  const text = start();
  assert.doesNotMatch(text, /http:\/\/127\.0\.0\.1:4173/);
  assert.match(
    text,
    /npm run preview {10}look at dist\/: open the address it prints, which is not necessarily 4173/,
  );
});

test("public/data is described as written by every run, kept out of Git and present in the delivered folder", () => {
  const text = start();
  assert.match(
    text,
    /`public\/data\/` is where every run writes the snapshot files\. It is kept out of Git: the folder as delivered contains the first snapshot, so a local preview works, but a copy cloned from GitHub has none until a Snapshot run has produced it \(or you run `npm run collect`\)\./,
  );
  assert.doesNotMatch(text, /holds the last snapshot the collector wrote/);
  const design = doc("STATIC-EDITION-DESIGN.md");
  if (design) {
    assert.match(
      design,
      /the folder's `\.gitignore` keeps `public\/data\/` out of Git/,
    );
    assert.match(
      design,
      /`public\/data\/` is written by every run and never committed/,
    );
  }
  // The workflow commits state/ only, which is what the documents say.
  assert.match(snapshotYml(), /git add state\n/);
  assert.doesNotMatch(snapshotYml(), /git add [^\n]*public/);
});

/* ── The design contract's sentence about the live build ─────────────────── */

test("the design contract does not promise a byte-identical live build", (t) => {
  const design = doc("STATIC-EDITION-DESIGN.md");
  if (!design) return t.skip("the design contract is not in this folder");
  assert.doesNotMatch(design, /every behaviour, test and byte/);
  // "Unchanged" for the tests would be literally false: the live tests that
  // load a component which now imports src/edition.ts gained a module-loader
  // mapping (no assertion changed).
  assert.doesNotMatch(design, /every live test passes unchanged/);
  assert.doesNotMatch(design, /must pass unchanged/);
  assert.match(
    design,
    /With the flag unset the live build behaves exactly as before and every live test passes\. The flag-unset build is not byte-identical to a build made before the edition existed: it carries dead edition code, because `src\/edition\.ts` reads the flag at run time and the bundler therefore keeps the branches it gates/,
  );
  assert.match(
    design,
    /must pass with the flag unset and no assertion changed \(a live test may only gain a module-loader mapping for a module the edition added\)/,
  );
  assert.match(
    design,
    /every behaviour is today's: the edition's branches are never taken/,
  );
  assert.doesNotMatch(design, /every code path is exactly today's/);
});

test("the documents promise the schedule in the same words: about every hour, when GitHub starts the run", () => {
  // The start guide says the site is refreshed about every hour and that GitHub
  // may start a run late or not at all; the GitHub Pages guide says the same
  // in short. No guide promises the old three-hour rhythm, and none promises an
  // hour flat.
  const guide = need("HOSTING-GITHUB-PAGES.md");
  assert.match(
    guide,
    /After that GitHub starts it by itself three times an hour and it collects about once an hour\. GitHub may start a run late, or not at all, when it is busy\./,
  );
  const documents = [
    ["the start guide", start()],
    ["the GitHub Pages guide", guide],
    ["the provider terms", need("PROVIDER-TERMS.md")],
    ["how it works", need("HOW-IT-WORKS.md")],
    ["the collector notes", need("COLLECTOR-NOTES.md")],
    ["the Vercel guide", need("HOSTING-VERCEL.md")],
  ];
  for (const [name, body] of documents) {
    assert.doesNotMatch(
      body,
      /every (?:three|3) hours|within three hours|up to three hours/i,
      `${name} still promises the old rhythm`,
    );
    for (const match of body.matchAll(/every hour/gi))
      assert.equal(
        body.slice(match.index - 6, match.index),
        "about ",
        `${name}: "${body.slice(match.index - 24, match.index + 24)}" promises an hour without "about"`,
      );
  }
  const workflow = snapshotYml();
  for (const minute of [7, 27, 47])
    assert.match(workflow, new RegExp(`cron: "${minute} \\* \\* \\* \\*"`));
  assert.doesNotMatch(workflow, /cron: "17 \*\/3/);
});

test("the start guide says state/ is the job's, and what to upload by hand", () => {
  const after = section(start(), "What happens after that");
  assert.match(
    after,
    /\*\*Updating the repository by hand\.\*\* The `state` folder is written by the job, not by you\. When you upload a newer version of this folder, upload only `state\/priority\.json` from it\. Never replace `state\/pools\.json`, `state\/history\.json`, `state\/hookless\.json`, `state\/registry\.json` or `state\/daily\.json`/,
  );
  // The five files the sentence forbids are the ones the collector rewrites
  // (after every run, or when the daily-volume records change), and the one it
  // allows is never written by the collector.
  const collector = read("collector/state.mjs");
  const writer = collector.slice(
    collector.indexOf("export async function writeState"),
  );
  for (const file of [
    "pools.json",
    "history.json",
    "hookless.json",
    "registry.json",
    "daily.json",
  ])
    assert.ok(writer.includes(file), `the collector writes ${file}`);
  assert.ok(
    !writer.includes("priority.json"),
    "the collector never writes priority.json",
  );
});

test("the design contract says Vercel and Cloudflare Pages serve the site branch, not a build of main", (t) => {
  const design = doc("STATIC-EDITION-DESIGN.md");
  if (!design) return t.skip("the design contract is not in this folder");
  assert.doesNotMatch(design, /build command and output directory/);
  assert.match(
    design,
    /Vercel and Cloudflare Pages, which serve the finished copy of the site that the workflow keeps on a `site` branch when the repository variable `PUBLISH_SITE_BRANCH` is `true` \(the host's build command stays empty, because a build of `main` would have no data: `public\/data\/` is never committed\)/,
  );
  // True of the guides and the workflow it is written from.
  const vercel = need("HOSTING-VERCEL.md");
  assert.match(vercel, /Leave the Build Command empty/);
  assert.match(
    vercel,
    /A Vercel build of the main branch would produce the page with no snapshot behind it/,
  );
  assert.match(
    need("HOSTING-CLOUDFLARE-PAGES.md"),
    /Leave the \*\*Build command\*\* empty/,
  );
  assert.match(snapshotYml(), /vars\.PUBLISH_SITE_BRANCH == 'true'/);
});

/* ── Every document points at something that exists ──────────────────────── */

test("every relative link in the start guide leads to a document of the edition", () => {
  const text = start();
  const links = [...text.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)].map(
    (match) => match[1],
  );
  assert.ok(links.length >= 8, `the guide has links (${links.length})`);
  for (const link of links) {
    if (/^https:\/\//.test(link)) continue;
    assert.doesNotMatch(
      link,
      /^[a-z]+:/,
      `${link} is a relative link or https`,
    );
    const name = link.replace(/^docs\//, "");
    assert.ok(
      existsSync(join(root, "docs", "edition", name)) ||
        existsSync(join(root, "docs", name)),
      `${link} exists`,
    );
  }
});

test("the guide's own cross-references name sections that exist, and no document sends the reader to a step number of the guide", () => {
  const text = start();
  for (const heading of ["What it costs", "For people who work on the code"])
    assert.match(text, new RegExp(`^## ${heading}$`, "m"), heading);
  for (const name of [
    "COLLECTOR-NOTES.md",
    "HOSTING-CLOUDFLARE-PAGES.md",
    "HOSTING-GITHUB-PAGES.md",
    "HOSTING-NAMECHEAP.md",
    "HOSTING-VERCEL.md",
    "HOW-IT-WORKS.md",
    "PROVIDER-TERMS.md",
    "TRUTH-RULES.md",
  ]) {
    const body = doc(name);
    if (body === null) continue;
    assert.doesNotMatch(
      body,
      /(?:start-here guide|start guide|README)[^.\n]{0,40}\bstep \d+|\bstep \d+ of the (?:start|README)/i,
      `${name} does not point at a numbered step of the start guide`,
    );
  }
});

test("the documents say plainly that the page has no provider credit and no Data and sources dialog, whose responsibility the credit is, and the one line that brings them back", () => {
  const terms = need("PROVIDER-TERMS.md");
  const credit = section(
    terms,
    "Credit on the page: your choice, and your responsibility",
  ).replace(/\s+/g, " ");
  assert.match(
    credit,
    /At your choice, the page of this edition shows \*\*no provider credit and no Data and sources dialog\*\*/,
  );
  assert.match(credit, /GeckoTerminal's terms ask for a visible credit link/);
  assert.match(
    credit,
    /The terms of the other providers must be read for what they ask/,
  );
  assert.match(
    credit,
    /You are responsible for whatever attribution the providers require/,
  );
  // The line named is the line in the source, and it is the one switch.
  assert.match(
    credit,
    /`export const EDITION_SOURCES_DIALOG: boolean = false;` becomes `export const EDITION_SOURCES_DIALOG: boolean = true;`/,
  );
  assert.match(
    read("src/edition.ts"),
    /^export const EDITION_SOURCES_DIALOG: boolean = (?:false|true);$/m,
  );
  // The notices file is still published; nothing on the page links to it.
  assert.match(credit, /`\/third-party-notices\.txt`/);
  assert.ok(existsSync(join(root, "public", "third-party-notices.txt")));
  // No document still says the page names its providers or has the dialog.
  for (const name of [
    "PROVIDER-TERMS.md",
    "HOW-IT-WORKS.md",
    "README-START-HERE.md",
    "TRUTH-RULES.md",
    "COLLECTOR-NOTES.md",
    "HOSTING-CLOUDFLARE-PAGES.md",
    "HOSTING-GITHUB-PAGES.md",
    "HOSTING-NAMECHEAP.md",
    "HOSTING-VERCEL.md",
  ]) {
    const body = doc(name);
    if (body === null) continue;
    const flat = body.replace(/\s+/g, " ");
    assert.doesNotMatch(
      flat,
      /dialog and the footer of the site name every provider|The provider names and links must be visible|confirm that what the site shows \(the Data and sources dialog/,
      name,
    );
    // Every sentence that mentions the dialog says it is switched off, or how
    // to bring it back.
    for (const sentence of flat.split(/(?<=[.!?])\s+/))
      if (/Data (?:and|&) sources/.test(sentence))
        assert.match(
          sentence,
          /switched off|no Data and sources|no dialog|brings the dialog|bring the dialog|at the owner's choice|At your choice|Credit on the page|the credit/i,
          `${name}: "${sentence}"`,
        );
  }
  // The start guide's list of what visitors see does not name it, and puts the
  // guide last among the tabs.
  const seen = section(start(), "What visitors see");
  const list = seen.split("\n").find((line) => line.startsWith("The full"));
  assert.ok(list, "the list of what visitors see");
  assert.doesNotMatch(list, /Data and sources|Data & sources/);
  assert.match(list, /Compare, Watchlist and, last of the tabs, Learn/);
  assert.match(
    seen,
    /no provider credit and no dialog that lists the data sources/,
  );
  assert.match(
    seen,
    /One line in `src\/edition\.ts` brings the dialog and the credits back/,
  );
});
