// The external timer of the Auto Snapshot edition (docs/EXTERNAL-TRIGGER.md): the
// Cloudflare Worker script that asks GitHub to start the Snapshot workflow every
// 20 minutes, and the guide that tells the owner to paste it. GitHub's own
// schedule is best effort (it started no run for 9 h 25 min, 17:07 UTC on 11 Nov to
// 02:32 UTC on 12 Nov 2026, the public run list of the repository shows);
// the timer only asks, and the gate in snapshot.yml decides (tests/edition-gate.test.mjs).
//
// Nothing here contacts GitHub or Cloudflare: the Worker is imported and run with
// a stand-in for fetch, and the guide is read as text. The files are found where
// they live in the source repository (docs/edition/) and in the assembled folder
// (docs/), so the test travels with the folder. Files are read with LF line ends
// so the checks hold on a Windows checkout (CRLF) too.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

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

const WORKER_PATH = [
  "docs/edition/trigger-worker.js",
  "docs/trigger-worker.js",
].find((path) => existsSync(join(root, path)));
assert.ok(WORKER_PATH, "the timer's Worker script is part of the edition");
const workerSource = read(WORKER_PATH);
const guide = need("EXTERNAL-TRIGGER.md");
const workflow = read(".github/workflows/snapshot.yml");

const TOKEN = "test-token-0123456789-abcdefghijklmnopqrstuvwxyz";
const ENDPOINT_PATH =
  "/repos/Rnarrator/hook-radar/actions/workflows/snapshot.yml/dispatches";
const BODY = '{"ref":"main","inputs":{"force":"false","discover":"false"}}';

const worker = (await import(pathToFileURL(join(root, WORKER_PATH)).href))
  .default;

/** Runs the Worker's timer handler with a stand-in for fetch and a recording
 * console. `answer` makes the Response (or throws). */
async function fire(env, answer = () => new Response(null, { status: 204 })) {
  const calls = [];
  const logs = [];
  const realFetch = globalThis.fetch;
  const levels = ["log", "info", "warn", "error", "debug"];
  const realConsole = Object.fromEntries(
    levels.map((level) => [level, console[level]]),
  );
  for (const level of levels)
    console[level] = (...args) => logs.push(args.map(String).join(" "));
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return answer(url, init);
  };
  let error = null;
  try {
    await worker.scheduled({ cron: "*/20 * * * *" }, env, {
      waitUntil() {},
    });
  } catch (caught) {
    error = caught;
  } finally {
    globalThis.fetch = realFetch;
    for (const level of levels) console[level] = realConsole[level];
  }
  return { calls, logs, error };
}

// ---- the Worker ---------------------------------------------------------------

test("the timer asks GitHub once, with the request the guide describes", async () => {
  const { calls, logs, error } = await fire({
    HOOK_RADAR_DISPATCH_TOKEN: TOKEN,
  });
  assert.equal(error, null);
  assert.equal(calls.length, 1, "one request per timer call");
  const [{ url, init }] = calls;
  assert.equal(url, `https://api.github.com${ENDPOINT_PATH}`);
  assert.equal(init.method, "POST");
  const headers = new Headers(init.headers);
  assert.equal(headers.get("authorization"), `Bearer ${TOKEN}`);
  assert.equal(headers.get("accept"), "application/vnd.github+json");
  assert.match(headers.get("x-github-api-version"), /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(
    headers.get("user-agent"),
    "GitHub refuses a request with no User-Agent",
  );
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(init.body, BODY);
  // The inputs are the strings "false", not booleans and not left out: left out,
  // force falls back to its default (true) and every call would collect.
  const sent = JSON.parse(init.body);
  assert.deepEqual(sent, {
    ref: "main",
    inputs: { force: "false", discover: "false" },
  });
  assert.ok(init.signal instanceof AbortSignal, "a hung request ends");
  assert.ok(
    logs.some((line) => line.includes("GitHub answered HTTP 204.")),
    "the status is logged",
  );
  assert.ok(
    logs.every((line) => !line.includes(TOKEN)),
    "the token is never logged",
  );
});

test("every 2xx answer is a success; any other stops with an error that shows the status and never the token", async () => {
  for (const status of [200, 201, 202, 204]) {
    const result = await fire({ HOOK_RADAR_DISPATCH_TOKEN: TOKEN }, () =>
      status === 204
        ? new Response(null, { status })
        : new Response('{"workflow_run_id":1}', { status }),
    );
    assert.equal(result.error, null, `HTTP ${status}`);
    assert.ok(result.logs.some((line) => line.includes(`HTTP ${status}.`)));
  }
  const refusals = {
    401: '{"message":"Bad credentials","status":"401"}',
    403: '{"message":"Resource not accessible by personal access token"}',
    404: '{"message":"Not Found"}',
    422: '{"message":"Workflow does not have workflow_dispatch trigger"}',
    500: "",
  };
  for (const [status, text] of Object.entries(refusals)) {
    // Even a body that echoes the token back must not reach a log or the error.
    const body = `${text} ${TOKEN}`;
    const result = await fire(
      { HOOK_RADAR_DISPATCH_TOKEN: TOKEN },
      () => new Response(body, { status: Number(status) }),
    );
    assert.ok(result.error instanceof Error, `HTTP ${status} is an error`);
    assert.match(result.error.message, new RegExp(`HTTP ${status}\\b`));
    assert.ok(!result.error.message.includes(TOKEN), `HTTP ${status}`);
    assert.ok(result.logs.every((line) => !line.includes(TOKEN)));
    assert.ok(result.logs.some((line) => line.includes(`HTTP ${status}.`)));
    if (text)
      assert.ok(result.error.message.includes(JSON.parse(text).message));
  }
});

test("a network failure or a timeout stops with an error and never shows the token", async () => {
  for (const failure of [
    new TypeError(`fetch failed: ${TOKEN}`),
    new DOMException("The operation timed out.", "TimeoutError"),
  ]) {
    const result = await fire({ HOOK_RADAR_DISPATCH_TOKEN: TOKEN }, () => {
      throw failure;
    });
    assert.ok(result.error instanceof Error);
    assert.match(result.error.message, /^GitHub could not be reached/);
    assert.ok(!result.error.message.includes(TOKEN));
    assert.ok(result.logs.every((line) => !line.includes(TOKEN)));
  }
});

test("without the secret nothing is sent, and the error names the secret", async () => {
  for (const env of [
    {},
    { HOOK_RADAR_DISPATCH_TOKEN: "" },
    { HOOK_RADAR_DISPATCH_TOKEN: "   " },
    { HOOK_RADAR_DISPATCH_TOKEN: 12345 },
    { HOOK_RADAR_DISPATCH_TOKEN: undefined },
  ]) {
    const result = await fire(env);
    assert.equal(result.calls.length, 0, JSON.stringify(env));
    assert.match(
      result.error.message,
      /The secret HOOK_RADAR_DISPATCH_TOKEN is not set/,
    );
  }
});

test("the timer handler waits for GitHub's answer before it ends", async () => {
  let answered = false;
  const result = await fire({ HOOK_RADAR_DISPATCH_TOKEN: TOKEN }, async () => {
    await new Promise((done) => setTimeout(done, 30));
    answered = true;
    return new Response(null, { status: 204 });
  });
  assert.equal(result.error, null);
  assert.equal(answered, true);
});

test("a visit to the Worker's own address shows a line of text and asks nobody", async () => {
  let asked = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    asked += 1;
    return new Response(null, { status: 204 });
  };
  try {
    const response = await worker.fetch(new Request("https://example.test/"));
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Hook Radar timer/);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(asked, 0);
});

test("the script and the guide hold no token and no key", () => {
  // The shapes GitHub's tokens start with are built from pieces so that this
  // file does not carry them either.
  const shapes = [
    ["github", "_pat_"].join(""),
    ["gh", "p_"].join(""),
    ["gh", "s_"].join(""),
  ];
  for (const [name, text] of [
    ["the script", workerSource],
    ["the guide", guide],
  ]) {
    for (const shape of shapes)
      assert.ok(!text.includes(shape), `${name} holds ${shape}`);
    assert.doesNotMatch(text, /Bearer [A-Za-z0-9._~+/=-]{20,}/, name);
    assert.doesNotMatch(
      text,
      /(?:apikey|api_key|key|token|secret)=[A-Za-z0-9_-]{20,}/i,
      name,
    );
  }
  // The script reads the token from the secret and from nowhere else.
  assert.match(workerSource, /env\.HOOK_RADAR_DISPATCH_TOKEN/);
  assert.doesNotMatch(workerSource, /process\.env|import\s/);
});

// ---- the guide ------------------------------------------------------------------

test("the guide quotes the Worker script in full, and says where the file is", () => {
  const blocks = [...guide.matchAll(/^```js\n([\s\S]*?)^```$/gm)].map(
    (match) => match[1],
  );
  assert.equal(blocks.length, 1, "one script in the guide");
  assert.equal(blocks[0].trimEnd(), workerSource.trimEnd());
  assert.match(guide, /`docs\/trigger-worker\.js`/);
});

test("the guide's numbers, names and words are the script's and the workflow's", () => {
  // Every 20 minutes, UTC: the cron expression, in the guide and in the script.
  assert.ok(guide.includes("`*/20 * * * *`"));
  assert.ok(workerSource.includes("*/20 * * * *"));
  assert.match(guide, /every 20 minutes/);
  assert.match(workerSource, /every 20 minutes/);
  // The endpoint, the body and the version the script really sends.
  assert.ok(
    guide.includes(`\`POST ${ENDPOINT_PATH}\``),
    "the guide names the endpoint",
  );
  assert.ok(guide.includes(`\`${BODY}\``), "the guide names the body");
  assert.ok(
    guide.split(BODY).length - 1 >= 2,
    "the body is given for Route A and for Route B",
  );
  const version = /const API_VERSION = "(\d{4}-\d{2}-\d{2})"/.exec(
    workerSource,
  )[1];
  assert.equal(version, "2022-11-28");
  assert.ok(guide.includes(`\`${version}\``));
  assert.match(workerSource, /const REPOSITORY = "Rnarrator\/hook-radar"/);
  assert.match(workerSource, /const WORKFLOW_FILE = "snapshot\.yml"/);
  assert.match(workerSource, /const BRANCH = "main"/);
  // The secret's name, the token's permission and its reach.
  assert.ok(guide.includes("`HOOK_RADAR_DISPATCH_TOKEN`"));
  assert.match(
    guide,
    /find \*\*Actions\*\* and set it to \*\*Read and write\*\*/,
  );
  assert.match(guide, /\*\*Only select repositories\*\*/);
  assert.match(guide, /fine-grained token limited to this one repository/);
  assert.match(
    workerSource,
    /fine-grained GitHub\n\/\/ token limited to this one repository, with only the Actions permission set to\n\/\/ Read and write/,
  );
  // The workflow's own numbers, which the guide quotes.
  const minimum = /MIN_AGE_MINUTES: "(\d+)"/.exec(workflow)[1];
  const back = /RETRY_AFTER_FAILURE_MINUTES: "(\d+)"/.exec(workflow)[1];
  assert.equal(minimum, "45");
  assert.equal(back, "90");
  assert.match(guide, new RegExp(`under ${minimum} minutes old`));
  assert.match(guide, new RegExp(`held back for ${back} minutes`));
  assert.match(guide, /at most one run in each three-hour block/);
  // The workflow has what the call relies on: the trigger, the inputs and the
  // default that makes the two "false" lines matter.
  assert.match(workflow, /^ {2}workflow_dispatch:$/m);
  assert.match(
    workflow,
    /force:\n\s+description: "Collect now[^\n]*\n\s+type: boolean\n\s+default: true/,
  );
  assert.match(
    workflow,
    /discover:\n\s+description: "Also look for new pools[^\n]*\n\s+type: boolean\n\s+default: false/,
  );
  assert.match(guide, /the default of `force` is "true"/);
});

test("the guide says what the timer does and does not do, and how to rotate, check and switch it off", () => {
  for (const heading of [
    "Why this exists",
    "What the timer does, and what it does not do",
    "What it costs, and what it can reach",
    "Route A (recommended): a Cloudflare Worker",
    "Route B (alternative): cron-job.org",
    "How to check that it works",
    "Rotate or revoke the token",
    "Switch it off",
    "If it stops working",
  ])
    assert.match(
      guide,
      new RegExp(`^## ${heading.replace(/[()]/g, "\\$&")}$`, "m"),
      heading,
    );
  assert.match(guide, /\*\*It only asks\.\*\*/);
  assert.match(guide, /\*\*The first job decides\.\*\*/);
  assert.match(guide, /"Nothing to do"/);
  assert.match(guide, /best-effort basis/);
  assert.match(guide, /9 hours 25 minutes/);
  assert.match(guide, /\*\*It does not make the site refresh faster\.\*\*/);
  assert.match(guide, /\*\*It does not fix a collection that fails\.\*\*/);
  assert.match(guide, /Cost: nothing\./);
  assert.match(guide, /`workflow_dispatch`/);
  assert.match(guide, /\*\*Delete\*\* to the right of the old one/);
  // It says that a call with force unticked has not yet been seen on GitHub, as
  // the notes do, and that only scheduled runs have (two, on 12 November 2026).
  assert.match(guide, /first time such a call is handled on GitHub itself/);
  assert.match(
    guide,
    /only scheduled runs have been seen stopping at "Nothing to do" so far \(two, on 12 November 2026\)/,
  );
  // No promise of more than the gate and GitHub can keep.
  assert.doesNotMatch(guide, /guarantee/i);
  for (const match of guide.matchAll(/every hour/gi))
    assert.equal(
      guide.slice(match.index - 6, match.index),
      "about ",
      "an hour is never promised without 'about'",
    );
});

test("Route A's silence is said plainly, with the exact path to the failure view and a monthly check that starts on GitHub", () => {
  // Route A sends no alert, so a token that expires stops the timer without a
  // word: the guide says so in the summary, among the limits and in the check.
  assert.match(
    guide,
    /Route A sends no alert when it stops, for example when its token runs out/,
  );
  assert.match(guide, /\*\*It does not tell you when it stops\.\*\*/);
  assert.match(guide, /Route A as set up here sends no alert/);
  assert.match(guide, /fail or stop without a word/);
  // Route B has the alert; it is named as the difference.
  assert.match(guide, /Route B can e-mail you when a call fails/);
  assert.match(guide, /ask to be told when the job fails/);
  // The path to the past Cron events is given where the owner looks for it: the
  // first check, the monthly check and the troubleshooting lead-in. The logs
  // are named separately, with their 3 days.
  assert.equal(
    guide.split("**Settings**, **Trigger Events**, **View events**").length - 1,
    3,
    "the path to the failure view is given in the three places that need it",
  );
  assert.match(guide, /last 100 calls of the Cron Trigger/);
  assert.match(guide, /\*\*Observability\*\*, \*\*Logs\*\*/);
  assert.match(guide, /free plan keeps Workers Logs for 3 days/);
  // The monthly check starts on GitHub, so it does not rest on Cloudflare's menus.
  assert.match(guide, /^## Check it once a month$/m);
  const monthly = guide
    .split(/^## Check it once a month$/m)[1]
    .split(/^## /m)[0];
  assert.match(monthly, /\*\*Actions\*\*, then \*\*Snapshot\*\*/);
  assert.match(monthly, /\*\*Event\*\* filter[^\n]*`workflow_dispatch`/);
  assert.match(monthly, /well under an hour old/);
  assert.match(monthly, /Run workflow\*\* is listed here too/);
  assert.match(monthly, /read its expiry date/);
  assert.match(monthly, /Cloudflare keeps its logs for only 3 days/);
  // The rotation points at the check and says that nothing warns of the expiry.
  assert.match(guide, /the reminder you set, and the monthly check/);
  assert.match(guide, /In Route A nothing warns you when it expires/);
});

test("the guide says what a leaked token can start, what a failed first job and a replaced manual run look like, and the hosting guide makes no claim about a disabled workflow", () => {
  // Actions: Read and write also dispatches any workflow with a manual trigger.
  // deploy-ftp.yml is one, and Snapshot's own inputs let a caller force a
  // collection and a search for new pools.
  assert.match(
    guide,
    /It can also start any workflow of the repository that has a manual trigger, not only this one: it can start Snapshot with \*\*force\*\* and \*\*discover\*\* both ticked/,
  );
  assert.match(guide, /about 60 extra requests to the v4\.xyz indexer/);
  assert.match(guide, /optional `deploy-ftp\.yml` workflow/);
  assert.match(workflow, /about 60 extra requests to the v4\.xyz indexer/);
  assert.ok(
    existsSync(join(root, ".github/workflows/deploy-ftp.yml")),
    "the workflow the guide names is part of the edition",
  );
  assert.match(
    read(".github/workflows/deploy-ftp.yml"),
    /^ {2}workflow_dispatch:$/m,
    "and it has a manual trigger",
  );
  const revoke = guide.split("**Revoke at once**")[1].split(/^## /m)[0];
  assert.match(revoke, /look for runs you did not expect/);
  assert.match(revoke, /\*\*force\*\* and \*\*discover\*\* ticked/);
  assert.match(
    revoke,
    /another workflow of the repository that has a manual trigger/,
  );
  // The back-off counts a failed first job too, and the timer doubles the first
  // jobs (three scheduled starts and three timer calls an hour).
  assert.match(
    guide,
    /A run counts as failed when any of its jobs failed, the first job included/,
  );
  assert.match(guide, /up to 90 minutes/);
  assert.match(
    guide,
    /about twice as many first jobs a day as the schedule alone/,
  );
  // A manual run that a newer call replaced says "cancelled": press it again.
  assert.match(
    guide,
    /If your own \*\*Run workflow\*\* shows "cancelled", a newer call took its place while a collection was running: wait for that collection to finish, then press \*\*Run workflow\*\* again/,
  );
  // GitHub's documentation does not say that a disabled workflow accepts a
  // dispatch, so no document offers the timer as a way round "Enable workflow".
  assert.match(
    need("HOSTING-GITHUB-PAGES.md"),
    /\*\*Enable workflow\*\*\. The external timer of \[EXTERNAL-TRIGGER\.md\]\(EXTERNAL-TRIGGER\.md\) does not depend on GitHub's scheduler/,
  );
  for (const name of [
    "HOSTING-GITHUB-PAGES.md",
    "README-START-HERE.md",
    "HOW-IT-WORKS.md",
    "PROVIDER-TERMS.md",
    "COLLECTOR-NOTES.md",
    "EXTERNAL-TRIGGER.md",
  ])
    assert.doesNotMatch(
      need(name),
      /another way to keep runs coming|timer[^.\n]{0,60}keeps? (?:the )?(?:workflow|schedule) (?:alive|active|running)/i,
      name,
    );
});

test("every relative link of the guide leads to a document of the edition", () => {
  const links = [...guide.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)].map(
    (match) => match[1],
  );
  assert.ok(links.length >= 1);
  for (const link of links) {
    if (/^https:\/\//.test(link)) continue;
    assert.doesNotMatch(link, /^[a-z]+:/, `${link} is relative or https`);
    assert.ok(
      existsSync(join(root, "docs", "edition", link)) ||
        existsSync(join(root, "docs", link)),
      `${link} exists`,
    );
  }
});

test("the other documents say GitHub's schedule is best effort, name the timer and link to its guide", () => {
  const start = need("README-START-HERE.md");
  assert.match(
    start,
    /\[docs\/EXTERNAL-TRIGGER\.md\]\(docs\/EXTERNAL-TRIGGER\.md\)/,
  );
  assert.match(start, /GitHub's own schedule is best effort/);
  assert.match(
    start,
    /external timer that asks GitHub for a run every 20 minutes/,
  );
  assert.match(
    start,
    /^## Make the refresh dependable: optional, about 15 minutes$/m,
  );
  assert.match(start, /`docs\/trigger-worker\.js`/);
  // The first paragraph's promise is unchanged: the timer is optional.
  assert.match(
    start,
    /refresh themselves about every hour when GitHub starts the runs, and less often when GitHub is busy, with nothing of yours switched on/,
  );

  const works = need("HOW-IT-WORKS.md");
  assert.match(
    works,
    /^## How a run starts, and what makes the hour dependable$/m,
  );
  assert.match(works, /GitHub's own schedule is \*\*best effort\*\*/);
  assert.match(works, /\[EXTERNAL-TRIGGER\.md\]\(EXTERNAL-TRIGGER\.md\)/);
  assert.match(works, /every 20 minutes/);

  const notes = need("COLLECTOR-NOTES.md");
  assert.match(notes, /GitHub's own schedule is best effort/);
  assert.match(notes, /`docs\/EXTERNAL-TRIGGER\.md`/);
  assert.match(notes, /`"force":"false"` and `"discover":"false"`/);

  assert.match(
    need("HOSTING-GITHUB-PAGES.md"),
    /\[EXTERNAL-TRIGGER\.md\]\(EXTERNAL-TRIGGER\.md\)/,
  );
  const terms = need("PROVIDER-TERMS.md");
  assert.equal(
    terms.split("[EXTERNAL-TRIGGER.md](EXTERNAL-TRIGGER.md)").length - 1,
    2,
    "the daily figures and the way to stop both name the timer",
  );
  assert.match(
    terms,
    /switch it off too, so that nothing is left running unattended/,
  );
});
