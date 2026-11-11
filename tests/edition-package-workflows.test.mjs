// The workflows and package scripts of the Auto Snapshot edition. They cannot be
// run here, so these tests read the files and hold the safeguards in place:
// no deploy after a failed collection, one run at a time, a state-only commit
// marked [skip ci], pinned actions, the FTP variant off by default.
//
// There is no YAML library in this project, so a small parser for the subset the
// workflows use (tests/edition-yaml-subset.mjs) is tested here. It refuses
// anything it does not know (anchors, tags, tabs, flow maps, duplicate keys)
// instead of guessing.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseYaml } from "./edition-yaml-subset.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const workflow = (name) => parseYaml(read(`.github/workflows/${name}`));
const stepsOf = (job) => job.steps;
const indexOfStep = (steps, predicate, label) => {
  const found = steps.findIndex(predicate);
  assert.notEqual(found, -1, `no step: ${label}`);
  return found;
};
// Run on the files about to be published: refuses a missing snapshot, an
// offline fixture replay and data from different runs.
const DATA_CHECK = "node scripts/check-edition-data.mjs dist/data";
// The command of the Collect step. docs/PROVIDER-TERMS.md item 1 tells the
// owner to add `--max-discovery 0` on github.com (this stops every v4.xyz
// request) and to take it out again later, so both lines are the Collect step.
// A test that insisted on the bare command would turn the Checks workflow red
// on the very commit the guide asks for.
const COLLECT_COMMAND = /^node collector\/run\.mjs(?: --max-discovery 0)?$/;
const isCollect = (step) => COLLECT_COMMAND.test(step.run ?? "");
const APPROVED_ACTIONS = new Set([
  "actions/checkout",
  "actions/setup-node",
  "actions/configure-pages",
  "actions/upload-pages-artifact",
  "actions/deploy-pages",
  "SamKirkland/FTP-Deploy-Action",
]);

test("the YAML subset parser reads what the workflows use and refuses what it does not know", () => {
  const parsed = parseYaml(
    [
      "# comment",
      "name: Example",
      "on:",
      "  schedule:",
      '    - cron: "17 */3 * * *" # trailing comment',
      "  workflow_dispatch:",
      "env:",
      "  EMPTY: {}",
      "  LIST: [a, b]",
      "jobs:",
      "  one:",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - name: Run",
      "        if: ${{ vars.X == 'true' }}",
      "        run: |",
      "          echo one",
      "",
      "          # not a comment here",
      "          echo two",
      "      - run: echo ok",
      "      - name: Mapping with dashes",
      "        with:",
      "          node-version: 24",
      "          flag: true",
    ].join("\n"),
  );
  assert.equal(parsed.name, "Example");
  assert.equal(parsed.on.schedule[0].cron, "17 */3 * * *");
  assert.equal(parsed.on.workflow_dispatch, null);
  assert.deepEqual(parsed.env, { EMPTY: {}, LIST: ["a", "b"] });
  const steps = parsed.jobs.one.steps;
  assert.equal(steps[0].uses, "actions/checkout@v4");
  assert.equal(steps[1].if, "${{ vars.X == 'true' }}");
  assert.equal(steps[1].run, "echo one\n\n# not a comment here\necho two\n");
  assert.equal(steps[2].run, "echo ok");
  assert.deepEqual(steps[3].with, { "node-version": 24, flag: true });

  assert.throws(() => parseYaml("a: 1\na: 2\n"), /duplicate key a/);
  assert.throws(() => parseYaml("a: &x 1\n"), /anchor/);
  assert.throws(() => parseYaml("a: {b: 1}\n"), /flow mappings/);
  assert.throws(() => parseYaml("a:\n\tb: 1\n"), /tab/);
  assert.throws(() => parseYaml("a:\n  b: 1\n c: 2\n"), /indentation|expected/);
  assert.throws(() => parseYaml('a: "open\n'), /unterminated/);
});

test("snapshot.yml is triggered three times an hour, by hand, and never overlaps itself", () => {
  const wf = workflow("snapshot.yml");
  // Three triggers an hour because GitHub drops or delays scheduled runs: the
  // gate (tests/edition-gate.test.mjs) lets one of them collect.
  const crons = wf.on.schedule.map((entry) => entry.cron);
  assert.deepEqual(crons, ["7 * * * *", "27 * * * *", "47 * * * *"]);
  const minutes = crons.map((cron) => {
    const match = cron.match(/^(\d{1,2}) \* \* \* \*$/);
    assert.ok(match, `every hour at a fixed minute: ${cron}`);
    return Number(match[1]);
  });
  assert.equal(new Set(minutes).size, 3, "three different minutes");
  for (const minute of minutes)
    assert.ok(
      minute > 0 && minute < 60 && minute % 5 !== 0,
      `an off-peak minute offset, not :00 or a multiple of 5 (${minute})`,
    );
  const spacing = minutes.slice(1).map((minute, i) => minute - minutes[i]);
  assert.deepEqual(spacing, [20, 20], "the triggers are spread over the hour");
  assert.ok(Object.hasOwn(wf.on, "workflow_dispatch"));
  const inputs = wf.on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs).sort(), ["discover", "force"]);
  assert.equal(inputs.force.type, "boolean");
  assert.equal(inputs.force.default, true, "a run started by hand collects");
  assert.equal(inputs.discover.type, "boolean");
  assert.equal(inputs.discover.default, false);
  assert.equal(typeof wf.concurrency.group, "string");
  assert.ok(wf.concurrency.group.length > 0);
  assert.equal(
    wf.concurrency["cancel-in-progress"],
    false,
    "a running collection must not be cancelled half way",
  );
  assert.deepEqual(wf.permissions, { contents: "read" });
});

test("snapshot.yml cannot deploy after a failed collection", () => {
  const wf = workflow("snapshot.yml");
  const { collect, deploy } = wf.jobs;
  assert.ok(collect && deploy);
  assert.deepEqual([deploy.needs].flat(), ["collect"]);
  assert.equal(
    deploy.if,
    undefined,
    "no condition on the deploy job that could bypass a failed collect",
  );
  assert.equal(deploy["continue-on-error"], undefined);
  assert.equal(collect["continue-on-error"], undefined);

  const steps = stepsOf(collect);
  const collectAt = indexOfStep(steps, isCollect, "collector");
  const buildAt = indexOfStep(
    steps,
    (s) => /build:static/.test(s.run ?? ""),
    "static build",
  );
  const saveAt = indexOfStep(
    steps,
    (s) => /git add state/.test(s.run ?? ""),
    "state commit",
  );
  const uploadAt = indexOfStep(
    steps,
    (s) => /^actions\/upload-pages-artifact@/.test(s.uses ?? ""),
    "pages artifact",
  );
  const checkAt = indexOfStep(
    steps,
    (s) => s.run === DATA_CHECK,
    "data check on the built files",
  );
  assert.ok(
    collectAt < buildAt &&
      buildAt < checkAt &&
      checkAt < saveAt &&
      saveAt < uploadAt,
    "collect, build, check the data, save state, upload, in that order",
  );
  for (const step of steps.slice(0, uploadAt + 1)) {
    assert.equal(
      step["continue-on-error"],
      undefined,
      `${step.name ?? step.uses}: must not continue on error`,
    );
    assert.equal(
      step.if,
      undefined,
      `${step.name ?? step.uses}: must not be conditional`,
    );
  }
  assert.match(
    steps[buildAt].run,
    /--require-data/,
    "a build without a snapshot must fail",
  );
  assert.ok(
    deploy.steps.some((s) => /^actions\/deploy-pages@/.test(s.uses ?? "")),
    "the deploy job uses actions/deploy-pages",
  );
  assert.ok(
    !stepsOf(collect).some((s) => /deploy-pages/.test(s.uses ?? "")),
    "only the deploy job deploys",
  );
});

test("every build that can be published insists on a live snapshot", () => {
  for (const name of ["snapshot.yml", "deploy-ftp.yml"]) {
    const builds = Object.values(workflow(name).jobs)
      .flatMap((job) => job.steps)
      .map((step) => step.run ?? "")
      .filter((run) => /build:static/.test(run));
    assert.ok(builds.length >= 1, `${name} builds the site`);
    for (const run of builds)
      assert.match(run, /--require-data/, `${name}: ${run}`);
  }
  const ci = JSON.stringify(workflow("ci.yml"));
  assert.doesNotMatch(
    ci,
    /collector\/run\.mjs(?![^"]*--no-publish)/,
    "the checks workflow never writes collector output into public/data",
  );
});

test("snapshot.yml commits state/ only, as a bot, marked [skip ci]", () => {
  const steps = stepsOf(workflow("snapshot.yml").jobs.collect);
  const save = steps.find((s) => /git add state/.test(s.run ?? ""));
  assert.match(save.run, /\[skip ci\]/);
  assert.match(save.run, /git config user\.name "github-actions\[bot\]"/);
  assert.match(
    save.run,
    /git config user\.email "[^"]*github-actions\[bot\]@users\.noreply\.github\.com"/,
  );
  assert.match(save.run, /git add state\s*$/m);
  assert.doesNotMatch(save.run, /git add (?:-A|--all|\.|public|dist)/);
  assert.match(save.run, /git diff --cached --quiet/, "no empty commits");
  assert.doesNotMatch(
    save.run,
    /--force|-f\b/,
    "state is pushed without force",
  );
});

test("snapshot.yml permissions are narrow and per job", () => {
  const wf = workflow("snapshot.yml");
  assert.equal(wf.jobs.collect.permissions.contents, "write");
  assert.equal(wf.jobs.collect.permissions["id-token"], undefined);
  assert.deepEqual(wf.jobs.deploy.permissions, {
    pages: "write",
    "id-token": "write",
  });
  assert.equal(wf.jobs.deploy.environment.name, "github-pages");
  for (const job of Object.values(wf.jobs))
    assert.ok(job["timeout-minutes"] > 0, "every job has a timeout");
});

test("snapshot.yml uses Node 24, installs from the lockfile and builds with the right base", () => {
  const steps = stepsOf(workflow("snapshot.yml").jobs.collect);
  const setup = steps.find((s) => /^actions\/setup-node@/.test(s.uses ?? ""));
  assert.equal(String(setup.with["node-version"]), "24");
  assert.ok(steps.some((s) => s.run === "npm ci"));
  const site = steps.find((s) => s.id === "site");
  assert.match(site.run, /CNAME/);
  assert.match(site.run, /GITHUB_REPOSITORY/);
  const build = steps.find((s) => /build:static/.test(s.run ?? ""));
  assert.equal(build.env.VITE_BASE, "${{ steps.site.outputs.base }}");
  assert.equal(build.env.VITE_SITE_URL, "${{ steps.site.outputs.url }}");
  const pages = steps.findIndex((s) =>
    /^actions\/configure-pages@/.test(s.uses ?? ""),
  );
  const collect = steps.findIndex(isCollect);
  assert.ok(
    pages !== -1 && collect !== -1 && pages < collect,
    "Pages is checked before any provider is contacted",
  );
});

test("the optional site-branch mirror is off by default and cannot block the deploy", () => {
  const steps = stepsOf(workflow("snapshot.yml").jobs.collect);
  const upload = steps.findIndex((s) =>
    /^actions\/upload-pages-artifact@/.test(s.uses ?? ""),
  );
  const mirror = steps.filter((s, at) => at > upload);
  assert.equal(mirror.length, 2);
  for (const step of mirror) {
    assert.match(step.if, /vars\.PUBLISH_SITE_BRANCH == 'true'/);
    assert.equal(step["continue-on-error"], true);
  }
  const push = mirror[1].run;
  assert.match(
    push,
    /git push --force "https:\/\/x-access-token:\$\{GITHUB_TOKEN\}@github\.com\/\$\{GITHUB_REPOSITORY\}\.git" site\s*$/m,
  );
  assert.equal(mirror[1].env.GITHUB_TOKEN, "${{ secrets.GITHUB_TOKEN }}");
  assert.match(mirror[0].run, /--outDir site-mirror/);
  // The README tells owners to set SITE_URL for Vercel and Cloudflare, which
  // serve this copy: the build has to read it (unset, it is an empty string).
  // The step checks it first (see edition-w3-ops.test.mjs) and hands the build
  // VITE_SITE_URL itself, so a value the build would refuse cannot fail it.
  assert.equal(mirror[0].env.SITE_URL, "${{ vars.SITE_URL }}");
  assert.equal(mirror[0].env.VITE_SITE_URL, undefined);
  assert.match(
    mirror[0].run,
    /VITE_SITE_URL="\$\{site_url\}" npm run build:static -- --require-data --outDir site-mirror/,
  );
  assert.equal(
    mirror[0].env.VITE_BASE,
    undefined,
    "the mirror keeps the relative base",
  );
  assert.match(
    push,
    /cd site-mirror/,
    "the forced push happens in the throwaway folder, never in the repository",
  );
});

test("every action is real, approved and pinned to a version", () => {
  const seen = new Set();
  for (const name of ["snapshot.yml", "ci.yml", "deploy-ftp.yml"]) {
    for (const job of Object.values(workflow(name).jobs))
      for (const step of job.steps ?? [])
        if (step.uses) {
          const match = step.uses.match(
            /^([\w.-]+\/[\w.-]+)@(v\d+(?:\.\d+){0,2}|[0-9a-f]{40})$/,
          );
          assert.ok(match, `${name}: ${step.uses} must be pinned to a version`);
          assert.ok(
            APPROVED_ACTIONS.has(match[1]),
            `${name}: ${match[1]} is not in the approved list`,
          );
          seen.add(step.uses);
        }
  }
  for (const used of [
    "actions/checkout@v4",
    "actions/setup-node@v4",
    "actions/configure-pages@v5",
    "actions/upload-pages-artifact@v3",
    "actions/deploy-pages@v4",
  ])
    assert.ok(seen.has(used), `${used} is used`);
  // The action that receives the FTP password is pinned to a commit, which
  // cannot be moved the way a tag can, with the release it stands for kept as
  // a comment.
  assert.ok(
    [...seen].some((u) =>
      /^SamKirkland\/FTP-Deploy-Action@[0-9a-f]{40}$/.test(u),
    ),
    "the FTP action is pinned to a full commit",
  );
  assert.match(
    read(".github/workflows/deploy-ftp.yml"),
    /^ +uses: SamKirkland\/FTP-Deploy-Action@[0-9a-f]{40} # v\d+\.\d+\.\d+$/m,
  );
});

test("secrets appear only as references, and only the ones each workflow needs", () => {
  const allowed = {
    "snapshot.yml": new Set(["GITHUB_TOKEN"]),
    "ci.yml": new Set(),
    "deploy-ftp.yml": new Set(["FTP_SERVER", "FTP_USERNAME", "FTP_PASSWORD"]),
  };
  for (const [name, names] of Object.entries(allowed)) {
    const used = new Set(
      [
        ...read(`.github/workflows/${name}`).matchAll(
          /secrets\.([A-Za-z0-9_]+)/g,
        ),
      ].map((m) => m[1]),
    );
    assert.deepEqual(
      [...used].sort(),
      [...names].sort(),
      `${name}: secrets referenced`,
    );
    // Built from pieces: this file travels with the edition and is scanned for
    // credential-looking text, which the written-out prefixes would trip.
    assert.doesNotMatch(
      read(`.github/workflows/${name}`),
      new RegExp(
        `(?:${["gh", "p_"].join("")}|${["github", "_pat_"].join("")}|${"-".repeat(5)}BEGIN)`,
      ),
    );
  }
});

test("ci.yml checks pushes and pull requests and publishes nothing", () => {
  const wf = workflow("ci.yml");
  assert.ok(
    Object.hasOwn(wf.on, "push") && Object.hasOwn(wf.on, "pull_request"),
  );
  assert.deepEqual(wf.on.push["branches-ignore"], ["site"]);
  assert.deepEqual(wf.permissions, { contents: "read" });
  const runs = Object.values(wf.jobs).flatMap((job) =>
    job.steps.map((s) => s.run).filter(Boolean),
  );
  for (const command of [
    "npm ci",
    "npm run test:edition",
    "node collector/run.mjs --offline --no-publish",
    "npm run build:static",
  ])
    assert.ok(runs.includes(command), `ci runs ${command}`);
  assert.equal(JSON.stringify(wf).includes("deploy-pages"), false);
  assert.equal(JSON.stringify(wf).includes("secrets."), false);
  for (const job of Object.values(wf.jobs))
    assert.equal(
      job.permissions,
      undefined,
      "no job widens the read-only token",
    );
});

test("deploy-ftp.yml is manual, off by default and uses only repository secrets", () => {
  const wf = workflow("deploy-ftp.yml");
  assert.ok(Object.hasOwn(wf.on, "workflow_dispatch"));
  assert.equal(
    Object.hasOwn(wf.on, "schedule"),
    false,
    "no active schedule until the owner removes the #",
  );
  // The hash sits straight after the two-space indent, so deleting only the #
  // leaves valid YAML (the next test does exactly that).
  assert.match(read(".github/workflows/deploy-ftp.yml"), /^ {2}#schedule:$/m);
  assert.match(
    read(".github/workflows/deploy-ftp.yml"),
    /^ {2}# {2}- cron: "\d+ \*\/3 \* \* \*"$/m,
  );
  assert.equal(wf.on.workflow_dispatch.inputs.dry_run.default, true);
  const job = wf.jobs.deploy;
  assert.equal(job.if, "${{ vars.ENABLE_FTP_DEPLOY == 'true' }}");
  assert.equal(
    wf.concurrency.group,
    workflow("snapshot.yml").concurrency.group,
    "shares the Snapshot concurrency group",
  );
  const steps = stepsOf(job);
  const collect = indexOfStep(steps, isCollect, "collector");
  const upload = indexOfStep(
    steps,
    (s) => /^SamKirkland\/FTP-Deploy-Action@/.test(s.uses ?? ""),
    "ftp upload",
  );
  const build = indexOfStep(
    steps,
    (s) => /build:static -- --require-data/.test(s.run ?? ""),
    "static build",
  );
  const check = indexOfStep(steps, (s) => s.run === DATA_CHECK, "data check");
  assert.ok(
    collect < build && build < check && check < upload,
    "the data is checked after the build and before anything is uploaded",
  );
  for (const step of steps.slice(0, upload + 1))
    assert.equal(step["continue-on-error"], undefined);
  const { with: input } = steps[upload];
  assert.equal(input.server, "${{ secrets.FTP_SERVER }}");
  assert.equal(input.username, "${{ secrets.FTP_USERNAME }}");
  assert.equal(input.password, "${{ secrets.FTP_PASSWORD }}");
  assert.equal(input.protocol, "ftps");
  assert.equal(
    input.security,
    "strict",
    "the action's default, loose, does not verify the server's certificate",
  );
  assert.equal(input["local-dir"], "./dist/");
  assert.match(input["server-dir"], /public_html\/'/);
  assert.match(input["dry-run"], /inputs\.dry_run/);
  assert.match(
    steps.find((s) => /git add state/.test(s.run ?? "")).run,
    /\[skip ci\]/,
  );
});

test("switching on the FTPS schedule as documented gives a valid workflow", () => {
  const source = read(".github/workflows/deploy-ftp.yml").replace(
    /\r\n/g,
    "\n",
  );
  // The documented edit: delete just the # on the two schedule lines.
  const markers = source.match(/^ {2}#(?=schedule:$| {2}- cron:)/gm);
  assert.equal(markers?.length, 2, "two lines carry a marker, not three");
  const switchedOn = source.replace(
    /^( {2})#(?=schedule:$| {2}- cron:)/gm,
    "$1",
  );
  assert.match(switchedOn, /^ {2}schedule:\n {4}- cron: "/m);
  const wf = parseYaml(switchedOn);
  assert.match(wf.on.schedule[0].cron, /^\d+ \*\/3 \* \* \*$/);
  assert.equal(wf.on.schedule.length, 1);
  assert.ok(
    Object.hasOwn(wf.on, "workflow_dispatch"),
    "still runnable by hand",
  );
  assert.deepEqual(
    Object.keys(wf.on),
    ["workflow_dispatch", "schedule"],
    "schedule sits beside workflow_dispatch",
  );
  // Both of the workflow's guards survive the edit.
  assert.equal(wf.jobs.deploy.if, "${{ vars.ENABLE_FTP_DEPLOY == 'true' }}");
  assert.equal(wf.concurrency["cancel-in-progress"], false);
  // And the file's own instructions say two lines, with the finished layout.
  const header = source.slice(0, source.indexOf("\nname:"));
  assert.match(header, /the two schedule lines/);
  assert.doesNotMatch(header, /three schedule lines/);
});

test("the one-line v4.xyz stop in the provider terms, and its way back, leave both publishing workflows valid", () => {
  // The documented edit: on the step "Collect the snapshot", add
  // `--max-discovery 0` to the command (no v4.xyz request is sent after that);
  // the way back takes it out again. Done here on the text of each workflow,
  // then read by the same parser and held to the same order and gates as the
  // unedited file, so the owner's own commit does not turn the Checks
  // workflow red.
  const COLLECT_LINE =
    /^( {8}run: node collector\/run\.mjs)(?: --max-discovery 0)?$/gm;
  const gates = {
    "snapshot.yml": [
      (s) => /^actions\/configure-pages@/.test(s.uses ?? ""),
      isCollect,
      (s) => /build:static -- --require-data/.test(s.run ?? ""),
      (s) => s.run === DATA_CHECK,
      (s) => /git add state/.test(s.run ?? ""),
      (s) => /^actions\/upload-pages-artifact@/.test(s.uses ?? ""),
    ],
    "deploy-ftp.yml": [
      isCollect,
      (s) => /build:static -- --require-data/.test(s.run ?? ""),
      (s) => s.run === DATA_CHECK,
      (s) => /git add state/.test(s.run ?? ""),
      (s) => /^SamKirkland\/FTP-Deploy-Action@/.test(s.uses ?? ""),
    ],
  };
  for (const [name, order] of Object.entries(gates)) {
    const source = read(`.github/workflows/${name}`).replace(/\r\n/g, "\n");
    assert.equal(
      source.match(COLLECT_LINE)?.length,
      1,
      `${name}: one Collect line, with or without the flag`,
    );
    const stopped = source.replace(COLLECT_LINE, "$1 --max-discovery 0");
    const back = stopped.replace(COLLECT_LINE, "$1");
    assert.equal(
      stopped.replace(" --max-discovery 0\n", "\n"),
      back,
      `${name}: the edit changes that one line and the way back undoes it`,
    );
    for (const [text, command] of [
      [stopped, "node collector/run.mjs --max-discovery 0"],
      [back, "node collector/run.mjs"],
    ]) {
      const wf = parseYaml(text);
      const job = name === "snapshot.yml" ? wf.jobs.collect : wf.jobs.deploy;
      const steps = stepsOf(job);
      const where = order.map((predicate, at) =>
        indexOfStep(steps, predicate, `${name} gate ${at + 1}`),
      );
      assert.deepEqual(
        where,
        [...where].sort((a, b) => a - b),
        `${name}: the steps keep their order with "${command}"`,
      );
      assert.equal(steps.filter(isCollect).length, 1);
      assert.equal(steps[where[order.indexOf(isCollect)]].run, command);
      assert.equal(
        steps[where[order.indexOf(isCollect)]].name,
        "Collect the snapshot",
      );
      for (const step of steps.slice(0, where.at(-1) + 1)) {
        assert.equal(step["continue-on-error"], undefined, name);
        assert.equal(step.if, undefined, name);
      }
      if (name === "snapshot.yml")
        assert.deepEqual([wf.jobs.deploy.needs].flat(), ["collect"]);
    }
  }
});

test("package.json has the scripts the workflows call, and they point at real files", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.scripts.collect, "node collector/run.mjs");
  assert.match(
    pkg.scripts["build:static"],
    /^node scripts\/build-static-edition\.mjs$/,
  );
  assert.match(pkg.scripts["test:edition"], /tests\/collector-\*\.test\.mjs/);
  assert.match(pkg.scripts["test:edition"], /tests\/edition-\*\.test\.mjs/);
  assert.ok(pkg.engines?.node);
  assert.ok(existsSync(`${root}scripts/build-static-edition.mjs`));
});

test("dependabot keeps the pinned actions current", () => {
  const config = parseYaml(read(".github/dependabot.yml"));
  assert.equal(config.version, 2);
  assert.equal(config.updates[0]["package-ecosystem"], "github-actions");
});
