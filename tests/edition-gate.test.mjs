// The first job of .github/workflows/snapshot.yml, "Is a new snapshot due",
// decides whether a trigger collects. It cannot run on GitHub from here, so this
// test takes its script out of the workflow file (the text GitHub would run, not
// a copy) and runs it under bash the way the runner does (`bash -e`), with a
// stand-in for `date` (the clock), a stand-in for `gh` (the list of earlier runs)
// and state files written for each case. The gate contacts no data provider; the
// stand-in for `gh` records every call so the tests can say when GitHub is asked.
//
// Without bash and GNU date (a bare Windows shell) the script tests are skipped
// and the workflow-shape tests still run. GitHub's own Linux runner, and the
// Checks workflow, have both.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { poolsJson } from "../collector/state.mjs";
import { parseYaml } from "./edition-yaml-subset.mjs";

const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const workflow = parseYaml(read(".github/workflows/snapshot.yml"));
const gate = workflow.jobs.gate;
const decide = gate.steps.find((step) => step.id === "decide");
const script = decide.run;
const MIN_AGE_MINUTES = Number(decide.env.MIN_AGE_MINUTES);
const RETRY_AFTER_FAILURE_MINUTES = Number(
  decide.env.RETRY_AFTER_FAILURE_MINUTES,
);

// ---- the workflow's shape ---------------------------------------------------

test("the gate is the first job, costs little and contacts no data provider", () => {
  assert.deepEqual(Object.keys(workflow.jobs), ["gate", "collect", "deploy"]);
  assert.equal(gate.name, "Is a new snapshot due");
  assert.equal(gate["timeout-minutes"], 3);
  assert.deepEqual(gate.permissions, { contents: "read", actions: "read" });
  assert.deepEqual(gate.outputs, {
    due: "${{ steps.decide.outputs.due }}",
    max_discovery: "${{ steps.decide.outputs.max_discovery }}",
  });
  assert.equal(gate["continue-on-error"], undefined);
  assert.equal(gate.needs, undefined);

  const [checkout, node, ...rest] = gate.steps;
  assert.match(checkout.uses, /^actions\/checkout@v4$/);
  assert.equal(checkout.with.ref, "${{ github.ref_name }}");
  assert.equal(
    checkout.with["sparse-checkout"],
    "state",
    "only state/ is needed to read the saved time",
  );
  assert.match(node.uses, /^actions\/setup-node@v4$/);
  assert.equal(String(node.with["node-version"]), "24");
  assert.equal(
    node.with.cache,
    undefined,
    "no package cache: nothing is installed",
  );
  assert.deepEqual(
    rest.map((step) => step.id),
    ["decide"],
  );

  // Nothing in the gate can reach a data provider: it never installs, builds or
  // starts the collector, and the script names no provider host or fetch tool.
  const code = script
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
  const everything =
    JSON.stringify({
      ...gate,
      steps: gate.steps.map((step) => ({ ...step, run: undefined })),
    }) + code;
  assert.doesNotMatch(everything, /collector\/|npm |npx |curl|wget|fetch\(/);
  for (const host of [
    "dexscreener",
    "geckoterminal",
    "v4.xyz",
    "frontier.fun",
    "goldsky",
    "raw.githubusercontent",
  ])
    assert.ok(!code.includes(host), `the gate names ${host}`);
  // The only network call of the script is GitHub's own API through gh.
  assert.deepEqual(
    [...script.matchAll(/\bgh api\b/g)].length > 0,
    true,
    "the failure check asks GitHub which runs failed",
  );
});

test("collect waits for the gate, checks out the branch tip and deploy still needs only collect", () => {
  const { collect, deploy } = workflow.jobs;
  assert.deepEqual([collect.needs].flat(), ["gate"]);
  assert.equal(collect.if, "${{ needs.gate.outputs.due == 'true' }}");
  assert.deepEqual(
    [deploy.needs].flat(),
    ["collect"],
    "a skipped collect skips deploy; deploy needs only collect",
  );
  assert.equal(deploy.if, undefined);
  assert.equal(collect.steps[0].uses, "actions/checkout@v4");
  assert.equal(collect.steps[0].with.ref, "${{ github.ref_name }}");
  const collectStep = collect.steps.find(
    (step) => step.name === "Collect the snapshot",
  );
  assert.equal(collectStep.run, "node collector/run.mjs");
  assert.deepEqual(collectStep.env, {
    COLLECTOR_MAX_DISCOVERY: "${{ needs.gate.outputs.max_discovery }}",
    // The way back to the plan that asks about every known pool: a repository
    // variable the owner can set without editing the workflow. Unset it is empty
    // and changes nothing.
    COLLECTOR_FULL_PLAN: "${{ vars.COLLECTOR_FULL_PLAN }}",
    // The way back from the retry of a failed DEX Screener batch: a repository
    // variable that can only lower the 8 (0 switches the retry off). Unset it is
    // empty and changes nothing.
    COLLECTOR_RETRY_MAX_BATCHES: "${{ vars.COLLECTOR_RETRY_MAX_BATCHES }}",
    // The way back from the 7D and 30D step: a repository variable that can only
    // lower its 20 requests (0 switches the step off). Unset it is empty and changes
    // nothing.
    COLLECTOR_DAILY_MAX_REQUESTS: "${{ vars.COLLECTOR_DAILY_MAX_REQUESTS }}",
  });
});

test("the minimum age and the failure back-off are the ones the plan names", () => {
  assert.equal(MIN_AGE_MINUTES, 45);
  assert.equal(RETRY_AFTER_FAILURE_MINUTES, 90);
  assert.ok(
    RETRY_AFTER_FAILURE_MINUTES >= 2 * MIN_AGE_MINUTES,
    "a refused run waits at least twice the normal guard",
  );
  assert.equal(
    decide.env.FORCE,
    "${{ github.event_name == 'workflow_dispatch' && inputs.force }}",
  );
  assert.equal(
    decide.env.DISCOVER,
    "${{ github.event_name == 'workflow_dispatch' && inputs.discover }}",
  );
});

test("the inputs of a run started by hand say what an unticked force means", () => {
  const { inputs } = workflow.on.workflow_dispatch;
  assert.deepEqual(Object.keys(inputs).sort(), ["discover", "force"]);
  // Defaults unchanged: the Run workflow button collects at once and looks only
  // at the pools already known. An external timer must send both as "false".
  assert.equal(inputs.force.type, "boolean");
  assert.equal(inputs.force.default, true);
  assert.match(
    inputs.force.description,
    /^Collect now even if the last snapshot is under 45 minutes old\. Untick it to be treated like a scheduled run/,
  );
  assert.equal(inputs.discover.type, "boolean");
  assert.equal(inputs.discover.default, false);
  assert.match(inputs.discover.description, /^Also look for new pools/);
  assert.match(inputs.discover.description, /three-hour rule/);
  // The comments that open the workflow name the external timer and its guide.
  const text = read(".github/workflows/snapshot.yml");
  assert.match(text, /GitHub's own schedule is best effort/);
  assert.match(text, /docs\/EXTERNAL-TRIGGER\.md/);
});

// ---- running the script -----------------------------------------------------

function findBash() {
  const candidates = [
    process.env.GATE_TEST_BASH,
    "bash",
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
  ].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(
      candidate,
      ["-c", 'date -u -d "2026-01-01T00:00:00Z" +%s; command -v date'],
      { encoding: "utf8", timeout: 20000 },
    );
    if (probe.status !== 0) continue;
    const [epoch, realDate] = probe.stdout.trim().split(/\r?\n/);
    if (epoch === "1767225600" && realDate)
      return { bash: candidate, realDate };
  }
  return null;
}
const found = findBash();
const skip = found ? false : "bash with GNU date is not available";

const FAKE_DATE = (realDate) => `#!/bin/bash
# The clock of the test: the one form the gate uses for "now" is answered from
# FAKE_NOW; everything else (parsing a time with -d) is the real date.
if [ "$#" -eq 2 ] && [ "$1" = "-u" ] && [ "$2" = "+%s" ]; then
  echo "\${FAKE_NOW}"
  exit 0
fi
exec ${realDate} "$@"
`;
const FAKE_GH = `#!/bin/bash
# The list of earlier runs: FAKE_GH_FAILURE and FAKE_GH_TIMED_OUT are the times
# the newest failed and timed-out runs were last updated; FAKE_GH_MODE=error is
# GitHub not answering. Every call is recorded.
echo "$*" >> gh-calls.log
if [ "\${FAKE_GH_MODE:-ok}" = "error" ]; then
  echo "HTTP 502: bad gateway" >&2
  exit 1
fi
case "$2" in
  *status=failure*) [ -n "\${FAKE_GH_FAILURE:-}" ] && printf '%s\\n' "\${FAKE_GH_FAILURE}" ;;
  *status=timed_out*) [ -n "\${FAKE_GH_TIMED_OUT:-}" ] && printf '%s\\n' "\${FAKE_GH_TIMED_OUT}" ;;
esac
exit 0
`;

const iso = (ms) => new Date(ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse("2026-11-11T14:20:00.000Z");

/** Run the gate once. `state` is the text of state/pools.json (undefined: no
 * file); `ago`-style times are given as absolute milliseconds. */
function runGate({
  now = NOW,
  state,
  event = "schedule",
  force = false,
  discover = false,
  failure = null,
  timedOut = null,
  gh = "ok",
}) {
  const dir = mkdtempSync(join(tmpdir(), "hook-radar-gate-"));
  try {
    mkdirSync(join(dir, "bin"));
    mkdirSync(join(dir, "state"));
    if (state !== undefined)
      writeFileSync(join(dir, "state", "pools.json"), state);
    writeFileSync(join(dir, "bin", "date"), FAKE_DATE(found.realDate));
    writeFileSync(join(dir, "bin", "gh"), FAKE_GH);
    writeFileSync(join(dir, "gate.sh"), script);
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (/^path$/i.test(key)) delete env[key];
    Object.assign(env, {
      PATH: [join(dir, "bin"), dirname(process.execPath), process.env.PATH]
        .filter(Boolean)
        .join(delimiter),
      GITHUB_OUTPUT: "out.txt",
      GITHUB_STEP_SUMMARY: "summary.txt",
      GITHUB_EVENT_NAME: event,
      GITHUB_REPOSITORY: "owner/hook-radar",
      GH_TOKEN: "not-a-token",
      FORCE: String(force),
      DISCOVER: String(discover),
      MIN_AGE_MINUTES: decide.env.MIN_AGE_MINUTES,
      RETRY_AFTER_FAILURE_MINUTES: decide.env.RETRY_AFTER_FAILURE_MINUTES,
      FAKE_NOW: String(Math.floor(now / 1000)),
      FAKE_GH_MODE: gh,
      FAKE_GH_FAILURE: failure === null ? "" : iso(failure),
      FAKE_GH_TIMED_OUT: timedOut === null ? "" : iso(timedOut),
    });
    const run = spawnSync(found.bash, ["-e", "gate.sh"], {
      cwd: dir,
      env,
      encoding: "utf8",
      timeout: 60000,
    });
    const slurp = (name) =>
      existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : "";
    const lines = slurp("out.txt").split(/\r?\n/).filter(Boolean);
    const outputs = {};
    const keys = [];
    for (const line of lines) {
      const at = line.indexOf("=");
      keys.push(line.slice(0, at));
      outputs[line.slice(0, at)] = line.slice(at + 1);
    }
    const result = {
      status: run.status,
      stdout: run.stdout,
      stderr: run.stderr,
      outputs,
      keys,
      summary: slurp("summary.txt"),
      ghCalls: slurp("gh-calls.log").split(/\r?\n/).filter(Boolean),
    };
    assert.equal(
      run.status,
      0,
      `the gate script must end successfully\n${run.stdout}\n${run.stderr}`,
    );
    // Both outputs are written exactly once, whatever the path through the script.
    assert.deepEqual([...keys].sort(), ["due", "max_discovery"]);
    // What is printed is what the run summary receives.
    assert.equal(
      result.summary.trim().split(/\r?\n/).join("\n"),
      run.stdout.trim().split(/\r?\n/).join("\n"),
    );
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const savedAt = (updatedAt, extra = {}) =>
  poolsJson(updatedAt, [
    {
      id: "0x0000000000000000000000000000000000000000000000000000000000000001",
      chain: "base",
      hookAddress: "0x0000000000000000000000000000000000000001",
      tokens: [
        "0x0000000000000000000000000000000000000000",
        "0x0000000000000000000000000000000000000002",
      ],
      name: "ETH / TEST",
      createdAt: "2026-10-01T00:00:00.000Z",
      source: "census",
      via: "geckoterminal",
      firstSeen: "2026-10-27T21:10:10.592Z",
      lastSeen: "2026-10-27T21:10:10.592Z",
      ...extra,
    },
  ]);
const ageOf = (minutes, seconds = 0) =>
  iso(NOW - minutes * MIN - seconds * 1000);

// ---- the saved time ---------------------------------------------------------

test(
  "a snapshot under 45 minutes old: nothing to do, no GitHub call",
  { skip },
  () => {
    for (const [minutes, seconds] of [
      [0, 0],
      [1, 0],
      [10, 0],
      [44, 0],
      [44, 59],
    ]) {
      const result = runGate({ state: savedAt(ageOf(minutes, seconds)) });
      assert.equal(result.outputs.due, "false", `${minutes} min ${seconds} s`);
      assert.match(
        result.summary,
        new RegExp(
          `^Nothing to do: the last snapshot is ${minutes} minutes old`,
        ),
      );
      assert.deepEqual(
        result.ghCalls,
        [],
        "a skip for age asks GitHub nothing",
      );
    }
  },
);

test("from 45 minutes on, a new snapshot is collected", { skip }, () => {
  for (const minutes of [45, 46, 59, 61, 8 * 60 + 28, 3 * 24 * 60]) {
    const result = runGate({ state: savedAt(ageOf(minutes)) });
    assert.equal(result.outputs.due, "true", `${minutes} min`);
    assert.match(
      result.summary,
      new RegExp(`^Collecting: the last snapshot is ${minutes} minutes old`),
    );
  }
});

test(
  "a saved time that is missing, null, empty, not a date or impossible means collect",
  { skip },
  () => {
    const cases = {
      "no state file": undefined,
      "an empty file": "",
      "text that is not JSON": "this is not json",
      "a file cut short": `{"schemaVersion":1,"updatedAt":"${ageOf(90)}","pools":[\n{"id":"0x01"`,
      "an array instead of an object": "[]",
      "the seed (updatedAt null)": savedAt(null),
      "no updatedAt at all": '{"schemaVersion":1,"pools":[]}\n',
      "an empty text": savedAt(""),
      "a number": savedAt(1794378287),
      words: savedAt("yesterday"),
      "a date without the Z": savedAt("2026-11-11T13:00:00"),
      "a date with another zone": savedAt("2026-11-11T13:00:00+07:00"),
      "a date that does not exist": savedAt("2026-02-30T13:00:00.000Z"),
      "an hour that does not exist": savedAt("2026-11-11T25:00:00.000Z"),
    };
    for (const [label, state] of Object.entries(cases)) {
      const result = runGate({ state });
      assert.equal(result.outputs.due, "true", label);
      assert.match(
        result.summary,
        /^Collecting: the saved time of the last snapshot cannot be read/,
        label,
      );
    }
  },
);

test(
  "an empty saved time at twenty past midnight is not read as midnight",
  { skip },
  () => {
    // GNU date -d "" means 00:00 today: at 00:20 UTC that would be a snapshot 20
    // minutes old and the gate would skip a collection that is due.
    const now = Date.parse("2026-11-12T00:20:00.000Z");
    const result = runGate({ now, state: savedAt("") });
    assert.equal(result.outputs.due, "true");
    assert.match(result.summary, /cannot be read/);
    assert.doesNotMatch(result.summary, /minutes old/);
  },
);

test("a saved time in the future means collect", { skip }, () => {
  for (const ahead of [1 * MIN, 2 * HOUR, 40 * 24 * HOUR]) {
    const result = runGate({ state: savedAt(iso(NOW + ahead)) });
    assert.equal(result.outputs.due, "true", `${ahead / MIN} min ahead`);
    assert.match(
      result.summary,
      /^Collecting: the saved time of the last snapshot is in the future/,
    );
  }
});

test(
  "the time is read as JSON: spaces, line ends, key order and a pool named updatedAt cannot fool it",
  { skip },
  () => {
    const fresh = ageOf(10);
    const old = ageOf(60);
    const layouts = {
      "as the collector writes it": (stamp) => savedAt(stamp),
      "pretty-printed with two spaces": (stamp) =>
        JSON.stringify(
          {
            schemaVersion: 1,
            updatedAt: stamp,
            pools: [{ id: "0x01", name: "A" }],
          },
          null,
          2,
        ) + "\n",
      "pretty-printed with tabs": (stamp) =>
        JSON.stringify(
          { schemaVersion: 1, updatedAt: stamp, pools: [{ id: "0x01" }] },
          null,
          "\t",
        ),
      "with spaces after the colons": (stamp) =>
        `{"schemaVersion": 1, "updatedAt": "${stamp}", "pools": []}`,
      "with Windows line ends": (stamp) =>
        savedAt(stamp).replaceAll("\n", "\r\n"),
      "pretty-printed with Windows line ends": (stamp) =>
        JSON.stringify(
          { schemaVersion: 1, updatedAt: stamp, pools: [] },
          null,
          2,
        ).replaceAll("\n", "\r\n"),
      "with a byte order mark": (stamp) => `\uFEFF${savedAt(stamp)}`,
      "with the time after the pools": (stamp) =>
        JSON.stringify({
          pools: [{ id: "0x01" }],
          schemaVersion: 1,
          updatedAt: stamp,
        }),
      "with a pool whose name holds a newer updatedAt": (stamp) =>
        JSON.stringify({
          pools: [
            {
              id: "0x01",
              name: `x "updatedAt":"${ageOf(1)}" y`,
              updatedAt: ageOf(2),
            },
          ],
          schemaVersion: 1,
          updatedAt: stamp,
        }),
      "with whole seconds only": (stamp) =>
        savedAt(stamp.replace(/\.\d+Z$/, "Z")),
    };
    for (const [label, layout] of Object.entries(layouts)) {
      const skipped = runGate({ state: layout(fresh) });
      assert.equal(skipped.outputs.due, "false", `${label}: fresh`);
      assert.match(
        skipped.summary,
        /the last snapshot is 10 minutes old/,
        label,
      );
      const collected = runGate({ state: layout(old) });
      assert.equal(collected.outputs.due, "true", `${label}: old`);
      assert.match(
        collected.summary,
        /the last snapshot is 60 minutes old/,
        label,
      );
    }
  },
);

// ---- a run started by hand --------------------------------------------------

test(
  "a run started by hand with force ticked always collects",
  { skip },
  () => {
    const refused = runGate({
      state: savedAt(ageOf(5)),
      event: "workflow_dispatch",
      force: true,
      failure: NOW - 5 * MIN,
    });
    assert.equal(refused.outputs.due, "true");
    assert.match(
      refused.summary,
      /^Collecting: started by hand with force ticked/,
    );
    assert.deepEqual(refused.ghCalls, [], "force asks GitHub nothing");
    for (const state of [undefined, savedAt(null), savedAt(iso(NOW + HOUR))]) {
      const result = runGate({
        state,
        event: "workflow_dispatch",
        force: true,
      });
      assert.equal(result.outputs.due, "true");
    }
  },
);

test(
  "a run started by hand with force unticked follows the rule",
  { skip },
  () => {
    const fresh = runGate({
      state: savedAt(ageOf(20)),
      event: "workflow_dispatch",
      force: false,
    });
    assert.equal(fresh.outputs.due, "false");
    assert.match(
      fresh.summary,
      /^Nothing to do: the last snapshot is 20 minutes old/,
    );
    const due = runGate({
      state: savedAt(ageOf(50)),
      event: "workflow_dispatch",
      force: false,
    });
    assert.equal(due.outputs.due, "true");
    assert.match(
      due.summary,
      /^Collecting: the last snapshot is 50 minutes old/,
    );
  },
);

// ---- after a failed run -----------------------------------------------------

test(
  "a refused run is not repeated at once: 90 minutes of back-off",
  { skip },
  () => {
    const state = savedAt(ageOf(300));
    for (const minutes of [0, 1, 30, 89]) {
      const result = runGate({ state, failure: NOW - minutes * MIN });
      assert.equal(result.outputs.due, "false", `failed ${minutes} min ago`);
      assert.match(
        result.summary,
        new RegExp(
          `^Nothing to do: the last run failed ${minutes} minutes ago`,
        ),
      );
      assert.equal(result.ghCalls.length, 2, "both outcomes are asked about");
    }
    for (const minutes of [90, 91, 100, 600]) {
      const result = runGate({ state, failure: NOW - minutes * MIN });
      assert.equal(result.outputs.due, "true", `failed ${minutes} min ago`);
      assert.match(
        result.summary,
        /^Collecting: the last snapshot is 300 minutes old/,
      );
    }
  },
);

test(
  "a run that ran out of time counts as a failure; the newest of the two counts",
  { skip },
  () => {
    const state = savedAt(ageOf(300));
    const stalled = runGate({ state, timedOut: NOW - 20 * MIN });
    assert.equal(stalled.outputs.due, "false");
    assert.match(stalled.summary, /failed 20 minutes ago/);
    const both = runGate({
      state,
      failure: NOW - 200 * MIN,
      timedOut: NOW - 95 * MIN,
    });
    assert.equal(both.outputs.due, "true");
    const newest = runGate({
      state,
      failure: NOW - 10 * MIN,
      timedOut: NOW - 95 * MIN,
    });
    assert.equal(newest.outputs.due, "false");
    assert.match(newest.summary, /failed 10 minutes ago/);
  },
);

test(
  "when GitHub cannot be asked, or answers nonsense, the gate collects",
  { skip },
  () => {
    const state = savedAt(ageOf(120));
    const down = runGate({ state, gh: "error" });
    assert.equal(down.outputs.due, "true");
    assert.match(
      down.summary,
      /^Collecting: the last snapshot is 120 minutes old/,
    );
    assert.equal(down.ghCalls.length, 2);
    const nonsense = runGate({ state, failure: null, timedOut: null });
    assert.equal(nonsense.outputs.due, "true");
  },
);

test(
  "a failure that the saved snapshot already followed is not a reason to wait",
  { skip },
  () => {
    // A run failed 80 minutes ago, a later run succeeded and saved a snapshot 50
    // minutes ago: collecting works again, so the back-off no longer applies.
    const result = runGate({
      state: savedAt(ageOf(50)),
      failure: NOW - 80 * MIN,
    });
    assert.equal(result.outputs.due, "true");
    assert.match(
      result.summary,
      /^Collecting: the last snapshot is 50 minutes old/,
    );
    // A failure after the saved snapshot still waits.
    const after = runGate({
      state: savedAt(ageOf(70)),
      failure: NOW - 60 * MIN,
    });
    assert.equal(after.outputs.due, "false");
  },
);

test(
  "the back-off also holds when the saved time cannot be read",
  { skip },
  () => {
    const waiting = runGate({ state: savedAt(null), failure: NOW - 30 * MIN });
    assert.equal(waiting.outputs.due, "false");
    assert.match(
      waiting.summary,
      /^Nothing to do: the last run failed 30 minutes ago/,
    );
    const retry = runGate({ state: savedAt(null), failure: NOW - 100 * MIN });
    assert.equal(retry.outputs.due, "true");
    assert.match(retry.summary, /cannot be read/);
  },
);

// ---- looking for new pools --------------------------------------------------

const BLOCK = 3 * HOUR;
const discovers = (result) => {
  assert.ok(
    result.outputs.max_discovery === "" || result.outputs.max_discovery === "0",
    `max_discovery is empty (look for new pools) or 0, not ${result.outputs.max_discovery}`,
  );
  return result.outputs.max_discovery === "";
};

test(
  "a scheduled run looks for new pools once per three-hour block of the UTC day",
  { skip },
  () => {
    const cases = [
      // [now, saved, looks for new pools, why]
      [
        "2026-11-11T03:07:00Z",
        "2026-11-11T02:20:00Z",
        true,
        "the first run of a new block",
      ],
      [
        "2026-11-11T03:50:00Z",
        "2026-11-11T02:59:59Z",
        true,
        "saved one second before the block began",
      ],
      [
        "2026-11-11T04:07:00Z",
        "2026-11-11T02:20:00Z",
        true,
        "the first run of the block was lost: the hour of the day would say no",
      ],
      [
        "2026-11-11T04:07:00Z",
        "2026-11-11T03:12:00Z",
        false,
        "the second run of a block",
      ],
      [
        "2026-11-11T05:59:59Z",
        "2026-11-11T05:10:00Z",
        false,
        "the last second of a block, saved in the same block",
      ],
      [
        "2026-11-11T06:00:00Z",
        "2026-11-11T05:10:00Z",
        true,
        "the first second of the next block",
      ],
      [
        "2026-11-11T09:07:00Z",
        "2026-11-11T08:10:00Z",
        true,
        "saved in the block before",
      ],
      [
        "2026-11-11T11:50:00Z",
        "2026-11-11T09:10:00Z",
        false,
        "saved in the same block",
      ],
      [
        "2026-11-11T14:07:00Z",
        "2026-11-11T02:20:00Z",
        true,
        "several blocks have passed",
      ],
      ["2026-11-12T00:20:00Z", "2026-11-11T23:10:00Z", true, "across midnight"],
      [
        "2026-11-12T00:20:00Z",
        "2026-11-12T00:05:00Z",
        false,
        "just after midnight, saved in the same block",
      ],
    ];
    for (const [nowText, savedText, expected, label] of cases) {
      const result = runGate({
        now: Date.parse(nowText),
        state: savedAt(iso(Date.parse(savedText))),
      });
      // Where the age alone would skip the run, the output still states the
      // decision the next collecting run will use.
      assert.equal(
        discovers(result),
        expected,
        `${label}: now ${nowText}, saved ${savedText}`,
      );
    }
    // The same rule from the arithmetic, so a table error cannot hide a rule error.
    for (let hour = 0; hour < 24; hour += 1)
      for (const savedMinutesAgo of [50, 130, 190, 400]) {
        const now =
          Date.parse("2026-11-11T00:00:00.000Z") + hour * HOUR + 7 * MIN;
        const saved = now - savedMinutesAgo * MIN;
        const result = runGate({ now, state: savedAt(iso(saved)) });
        assert.equal(
          discovers(result),
          Math.floor(saved / BLOCK) !== Math.floor(now / BLOCK),
          `now ${iso(now)}, saved ${iso(saved)}`,
        );
      }
  },
);

test(
  "a scheduled run with a saved time that cannot be read looks for new pools",
  { skip },
  () => {
    for (const state of [
      undefined,
      savedAt(null),
      savedAt(iso(NOW + HOUR)),
      "x",
    ]) {
      const result = runGate({ state });
      assert.equal(result.outputs.due, "true");
      assert.equal(discovers(result), true);
      assert.match(result.summary, /This run also looks for new pools\./);
    }
  },
);

test(
  "a scheduled run that does not look for new pools says it measures the known pools",
  { skip },
  () => {
    const now = Date.parse("2026-11-11T04:07:00Z");
    const result = runGate({ now, state: savedAt(iso(now - 55 * MIN)) });
    assert.equal(result.outputs.due, "true");
    assert.equal(result.outputs.max_discovery, "0");
    assert.match(result.summary, /This run measures the pools already known\./);
  },
);

test(
  "a run started by hand with force ticked looks for new pools only when discover is ticked",
  { skip },
  () => {
    // An old snapshot in an earlier block: a scheduled run would look for new
    // pools; a run started by hand with force ticked does not unless asked.
    const state = savedAt(ageOf(400));
    const plain = runGate({ state, event: "workflow_dispatch", force: true });
    assert.equal(plain.outputs.due, "true");
    assert.equal(plain.outputs.max_discovery, "0");
    assert.match(plain.summary, /This run measures the pools already known\./);
    const asked = runGate({
      state,
      event: "workflow_dispatch",
      force: true,
      discover: true,
    });
    assert.equal(asked.outputs.due, "true");
    assert.equal(asked.outputs.max_discovery, "");
    assert.match(asked.summary, /This run also looks for new pools\./);
    // A saved time that cannot be read changes nothing for force ticked.
    const unreadable = runGate({
      state: savedAt(null),
      event: "workflow_dispatch",
      force: true,
    });
    assert.equal(unreadable.outputs.max_discovery, "0");
    // The rule of the age still applies to an unforced run that asks for discovery.
    const fresh = runGate({
      state: savedAt(ageOf(10)),
      event: "workflow_dispatch",
      force: false,
      discover: true,
    });
    assert.equal(fresh.outputs.due, "false");
  },
);

// ---- an external timer: a call with force unticked is a scheduled run -------
//
// The recommended way to keep the rhythm (docs/EXTERNAL-TRIGGER.md) is a free
// timer outside GitHub that calls the workflow_dispatch API every 20 minutes with
// force and discover both "false". Such a run must behave exactly like a
// scheduled one: the same 45 minutes, the same 90 minutes after a failure, the
// same three-hour block rule for new pools, and a collection when the saved time
// cannot be read. A call with force ticked or with discover ticked keeps its
// meaning (the tests above).

const byTimer = { event: "workflow_dispatch", force: false, discover: false };

test(
  "a call with force unticked at under 45 minutes: nothing to do, and GitHub is not asked",
  { skip },
  () => {
    for (const [minutes, seconds] of [
      [10, 0],
      [44, 59],
    ]) {
      const result = runGate({
        ...byTimer,
        state: savedAt(ageOf(minutes, seconds)),
      });
      assert.equal(result.outputs.due, "false", `${minutes} min ${seconds} s`);
      assert.match(
        result.summary,
        new RegExp(
          `^Nothing to do: the last snapshot is ${minutes} minutes old \\(a new one is collected from 45 minutes\\)`,
        ),
      );
      assert.deepEqual(result.ghCalls, []);
    }
  },
);

test(
  "a call with force unticked from 45 minutes on collects, and is not described as started by hand",
  { skip },
  () => {
    for (const minutes of [45, 50, 8 * 60 + 28]) {
      const result = runGate({ ...byTimer, state: savedAt(ageOf(minutes)) });
      assert.equal(result.outputs.due, "true", `${minutes} min`);
      assert.match(
        result.summary,
        new RegExp(`^Collecting: the last snapshot is ${minutes} minutes old`),
      );
      assert.doesNotMatch(result.summary, /started by hand/);
    }
  },
);

test(
  "a call with force unticked is held back for 90 minutes after a failed run",
  { skip },
  () => {
    const state = savedAt(ageOf(300));
    for (const minutes of [30, 89]) {
      const waiting = runGate({
        ...byTimer,
        state,
        failure: NOW - minutes * MIN,
      });
      assert.equal(waiting.outputs.due, "false", `failed ${minutes} min ago`);
      assert.match(
        waiting.summary,
        new RegExp(
          `^Nothing to do: the last run failed ${minutes} minutes ago`,
        ),
      );
      assert.equal(waiting.ghCalls.length, 2, "both outcomes are asked about");
    }
    const retry = runGate({ ...byTimer, state, failure: NOW - 90 * MIN });
    assert.equal(retry.outputs.due, "true");
    assert.match(
      retry.summary,
      /^Collecting: the last snapshot is 300 minutes old/,
    );
    const stalled = runGate({ ...byTimer, state, timedOut: NOW - 20 * MIN });
    assert.equal(stalled.outputs.due, "false");
    assert.match(stalled.summary, /failed 20 minutes ago/);
    // A failure that a later snapshot has followed no longer counts.
    const followed = runGate({
      ...byTimer,
      state: savedAt(ageOf(50)),
      failure: NOW - 80 * MIN,
    });
    assert.equal(followed.outputs.due, "true");
    // Force ticked ignores the back-off, as it always did.
    const forced = runGate({
      ...byTimer,
      force: true,
      state,
      failure: NOW - 30 * MIN,
    });
    assert.equal(forced.outputs.due, "true");
    assert.deepEqual(forced.ghCalls, []);
  },
);

test(
  "a call with force unticked looks for new pools by the three-hour block rule, with discover unticked",
  { skip },
  () => {
    const cases = [
      // [now, saved, looks for new pools, why]
      [
        "2026-11-11T03:50:00Z",
        "2026-11-11T02:59:59Z",
        true,
        "saved one second before the block began",
      ],
      [
        "2026-11-11T04:07:00Z",
        "2026-11-11T03:12:00Z",
        false,
        "the second run of a block",
      ],
      [
        "2026-11-11T05:59:59Z",
        "2026-11-11T05:10:00Z",
        false,
        "the last second of a block, saved in the same block",
      ],
      [
        "2026-11-11T06:00:00Z",
        "2026-11-11T05:10:00Z",
        true,
        "the first second of the next block",
      ],
      [
        "2026-11-11T11:50:00Z",
        "2026-11-11T09:10:00Z",
        false,
        "saved in the same block, hours before",
      ],
      [
        "2026-11-11T14:07:00Z",
        "2026-11-11T02:20:00Z",
        true,
        "several blocks have passed",
      ],
      ["2026-11-12T00:20:00Z", "2026-11-11T23:10:00Z", true, "across midnight"],
    ];
    for (const [nowText, savedText, expected, label] of cases) {
      const result = runGate({
        ...byTimer,
        now: Date.parse(nowText),
        state: savedAt(iso(Date.parse(savedText))),
      });
      assert.equal(
        discovers(result),
        expected,
        `${label}: now ${nowText}, saved ${savedText}`,
      );
      // The words a scheduled run uses, when the run collects.
      if (result.outputs.due === "true")
        assert.match(
          result.summary,
          expected
            ? /This run also looks for new pools\./
            : /This run measures the pools already known\./,
          label,
        );
    }
  },
);

test(
  "a call with discover ticked looks for new pools whatever the block rule says, and still obeys the age",
  { skip },
  () => {
    // 50 minutes old and saved in the same block as now (13:30 and 14:20): the
    // block rule alone would not look for new pools.
    const state = savedAt(ageOf(50));
    const plain = runGate({ ...byTimer, state });
    assert.equal(plain.outputs.due, "true");
    assert.equal(plain.outputs.max_discovery, "0");
    const asked = runGate({ ...byTimer, discover: true, state });
    assert.equal(asked.outputs.due, "true");
    assert.equal(asked.outputs.max_discovery, "");
    assert.match(
      asked.summary,
      /^Collecting: the last snapshot is 50 minutes old/,
    );
    const fresh = runGate({
      ...byTimer,
      discover: true,
      state: savedAt(ageOf(10)),
    });
    assert.equal(fresh.outputs.due, "false");
    const both = runGate({
      ...byTimer,
      force: true,
      discover: true,
      state: savedAt(ageOf(10)),
    });
    assert.equal(both.outputs.due, "true");
    assert.equal(both.outputs.max_discovery, "");
  },
);

test(
  "a call with force unticked collects when the saved time cannot be read, and also looks for new pools",
  { skip },
  () => {
    for (const state of [
      undefined,
      savedAt(null),
      savedAt(iso(NOW + HOUR)),
      "x",
    ]) {
      const result = runGate({ ...byTimer, state });
      assert.equal(result.outputs.due, "true");
      assert.equal(discovers(result), true);
      assert.match(
        result.summary,
        /^Collecting: the saved time of the last snapshot/,
      );
      assert.match(result.summary, /This run also looks for new pools\./);
    }
    // The back-off holds here too.
    const waiting = runGate({
      ...byTimer,
      state: savedAt(null),
      failure: NOW - 30 * MIN,
    });
    assert.equal(waiting.outputs.due, "false");
  },
);

test(
  "a call with force unticked is in every case exactly a scheduled run: the same decision, words, outputs and GitHub calls",
  { skip },
  () => {
    const noon = Date.parse("2026-11-11T12:20:00.000Z");
    const scenarios = {
      "10 minutes old": { state: savedAt(ageOf(10)) },
      "50 minutes old, saved in the same block": {
        state: savedAt(ageOf(50)),
      },
      "50 minutes old, saved in the block before": {
        now: noon,
        state: savedAt(iso(noon - 50 * MIN)),
      },
      "300 minutes old after a failure 30 minutes ago": {
        state: savedAt(ageOf(300)),
        failure: NOW - 30 * MIN,
      },
      "300 minutes old after a failure 100 minutes ago": {
        state: savedAt(ageOf(300)),
        failure: NOW - 100 * MIN,
      },
      "GitHub cannot be asked": { state: savedAt(ageOf(120)), gh: "error" },
      "an unreadable saved time": { state: savedAt("yesterday") },
    };
    for (const [label, scenario] of Object.entries(scenarios)) {
      const scheduled = runGate({ ...scenario, event: "schedule" });
      const timer = runGate({ ...scenario, ...byTimer });
      assert.deepEqual(timer.outputs, scheduled.outputs, `${label}: outputs`);
      assert.equal(timer.summary, scheduled.summary, `${label}: summary`);
      assert.deepEqual(timer.ghCalls, scheduled.ghCalls, `${label}: GitHub`);
    }
  },
);
