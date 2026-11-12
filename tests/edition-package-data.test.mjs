// scripts/check-edition-data.mjs, the last gate before data files are published,
// and the two scripts that call it for the edition build. A snapshot made by an
// offline fixture replay must never reach the site, and data from two runs must
// never be mixed. Everything here runs in temporary folders.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  inspectPublishedData,
  publishBlockers,
  startedDirectly,
} from "../scripts/check-edition-data.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const CHECK = join(repo, "scripts", "check-edition-data.mjs");
const GENERATED_AT = "2026-10-28T14:05:00.000Z";

const live = {
  "snapshot.json": JSON.stringify({ generatedAt: GENERATED_AT, pools: [] }),
  "status.json": JSON.stringify({ generatedAt: GENERATED_AT, counts: {} }),
};

async function folder(t, files) {
  const dir = await mkdtemp(join(tmpdir(), "edition-data-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    if (content === null) continue;
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  return dir;
}

const withStatus = (status) => ({
  ...live,
  "status.json": JSON.stringify({ generatedAt: GENERATED_AT, ...status }),
});

test("a snapshot with a matching, unmarked status passes and reports its time", async (t) => {
  const dir = await folder(t, live);
  const found = await inspectPublishedData(dir);
  assert.deepEqual(found, {
    present: true,
    generatedAt: GENERATED_AT,
    problems: [],
  });
  assert.deepEqual(await publishBlockers(dir), []);
  const marked = await folder(t, withStatus({ offline: false }));
  assert.deepEqual(await publishBlockers(marked), []);
});

test('a status marked "offline" is refused, whatever else it says', async (t) => {
  const dir = await folder(t, withStatus({ offline: true }));
  const found = await inspectPublishedData(dir);
  assert.equal(found.present, true);
  assert.equal(found.problems.length, 1);
  assert.match(found.problems[0], /"offline": true/);
  assert.match(found.problems[0], /fixtures/);
  for (const odd of ["true", 1, null, {}]) {
    const other = await folder(t, withStatus({ offline: odd }));
    assert.match(
      (await publishBlockers(other)).join("\n"),
      /unreadable "offline" marker/,
      JSON.stringify(odd),
    );
  }
});

test("a snapshot with no status next to it, or an unreadable one, is refused", async (t) => {
  const none = await folder(t, { ...live, "status.json": null });
  assert.match(
    (await publishBlockers(none)).join("\n"),
    /status\.json is missing/,
  );
  const broken = await folder(t, { ...live, "status.json": "{ nope" });
  assert.match(
    (await publishBlockers(broken)).join("\n"),
    /status\.json cannot be read: it is not valid JSON/,
  );
  const array = await folder(t, { ...live, "status.json": "[]" });
  assert.match(
    (await publishBlockers(array)).join("\n"),
    /status\.json is not a JSON object/,
  );
});

test("a status and a snapshot from different runs are refused", async (t) => {
  const dir = await folder(t, {
    ...live,
    "status.json": JSON.stringify({ generatedAt: "2026-10-28T11:05:00.000Z" }),
  });
  const [problem, ...rest] = await publishBlockers(dir);
  assert.match(problem, /from different runs/);
  assert.match(problem, /11:05:00/);
  assert.match(problem, /14:05:00/);
  assert.deepEqual(rest, []);
  const absent = await folder(t, { ...live, "status.json": "{}" });
  assert.match((await publishBlockers(absent)).join("\n"), /null/);
});

test("a snapshot that cannot be read or carries no time is refused", async (t) => {
  for (const [content, pattern] of [
    ["not json", /snapshot\.json cannot be read: it is not valid JSON/],
    ["[]", /no valid generatedAt/],
    ["{}", /no valid generatedAt/],
    [JSON.stringify({ generatedAt: "yesterday" }), /no valid generatedAt/],
    [JSON.stringify({ generatedAt: 1761660300000 }), /no valid generatedAt/],
  ]) {
    const dir = await folder(t, { ...live, "snapshot.json": content });
    assert.match((await publishBlockers(dir)).join("\n"), pattern, content);
  }
});

test("without a snapshot nothing is present, and other files are not trusted", async (t) => {
  const empty = await folder(t, {});
  assert.deepEqual(await inspectPublishedData(empty), {
    present: false,
    generatedAt: null,
    problems: [],
  });
  assert.match(
    (await publishBlockers(empty))[0],
    /snapshot\.json is missing \(run `npm run collect` first\)/,
  );
  const gone = join(empty, "no-such-folder");
  assert.equal((await inspectPublishedData(gone)).present, false);

  const hidden = await folder(t, { ".gitkeep": "" });
  assert.deepEqual((await inspectPublishedData(hidden)).problems, []);

  const orphan = await folder(t, {
    "status.json": live["status.json"],
    "history.json": "{}",
  });
  const found = await inspectPublishedData(orphan);
  assert.equal(found.present, false);
  assert.match(found.problems[0], /2 files but no snapshot\.json/);
  const one = await folder(t, { "history.json": "{}" });
  assert.match(
    (await inspectPublishedData(one)).problems[0],
    /a file \(history\.json\) but no snapshot\.json/,
  );
});

const cli = (args) =>
  spawnSync(process.execPath, [CHECK, ...args], { encoding: "utf8" });

test("the command line exits 0 for a live snapshot, 1 for anything else, 2 for bad use", async (t) => {
  const good = cli([await folder(t, live)]);
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /live snapshot generated at 2026-10-28T14:05:00/);

  const offline = cli([await folder(t, withStatus({ offline: true }))]);
  assert.equal(offline.status, 1);
  assert.match(offline.stderr, /is not fit to publish/);
  assert.match(offline.stderr, /"offline": true/);

  const missing = cli([await folder(t, {})]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /snapshot\.json is missing/);

  for (const args of [["a", "b"], ["--help"]]) {
    const usage = cli(args);
    assert.equal(usage.status, 2, args.join(" "));
    assert.match(usage.stderr, /Usage: node scripts\/check-edition-data\.mjs/);
  }
});

// A start through a symlink or a directory junction is still a direct start: the
// gate once compared two spellings of one path, found them different and exited
// 0 without a word, which a green run would have read as "checked".
test("the command line gives the same answers when reached through a symlink or junction", async (t) => {
  const holder = await mkdtemp(join(tmpdir(), "edition-link-"));
  t.after(() => rm(holder, { recursive: true, force: true }));
  const link = join(holder, "scripts-link");
  try {
    symlinkSync(join(repo, "scripts"), link, "junction");
  } catch (error) {
    return t.skip(`links are not permitted here (${error.code})`);
  }
  const viaLink = (args) =>
    spawnSync(
      process.execPath,
      [join(link, "check-edition-data.mjs"), ...args],
      {
        encoding: "utf8",
      },
    );

  const good = viaLink([await folder(t, live)]);
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /live snapshot generated at 2026-10-28T14:05:00/);

  const offline = viaLink([await folder(t, withStatus({ offline: true }))]);
  assert.equal(offline.status, 1, "an offline replay is refused, not ignored");
  assert.match(offline.stderr, /is not fit to publish/);
  assert.match(offline.stderr, /"offline": true/);

  const missing = viaLink([await folder(t, {})]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /snapshot\.json is missing/);

  const usage = viaLink(["a", "b"]);
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /Usage: node scripts\/check-edition-data\.mjs/);
});

test("startedDirectly recognises the script by real path and by name, and not an importer", async (t) => {
  const holder = await mkdtemp(join(tmpdir(), "edition-started-"));
  t.after(() => rm(holder, { recursive: true, force: true }));
  const self = CHECK;
  assert.equal(startedDirectly(self, self), true);
  assert.equal(startedDirectly(undefined, self), false, "no entry script");
  assert.equal(
    startedDirectly(join(repo, "scripts", "build-static-edition.mjs"), self),
    false,
    "the build imports the gate; that is not a direct start",
  );
  assert.equal(
    startedDirectly(join(repo, "tests", "edition-package-data.test.mjs"), self),
    false,
  );
  // A copy or hard link under the same name still runs the gate.
  const copy = join(holder, "check-edition-data.mjs");
  copyFileSync(self, copy);
  assert.equal(startedDirectly(copy, self), true);
  // A path that cannot be resolved falls back to the plain comparison.
  assert.equal(startedDirectly(join(holder, "missing", "x.mjs"), self), false);
});

test("the real collector's offline replay is refused, and its live-shaped output is not", async (t) => {
  const out = await mkdtemp(join(tmpdir(), "edition-offline-"));
  t.after(() => rm(out, { recursive: true, force: true }));
  const replay = spawnSync(
    process.execPath,
    [join(repo, "collector", "run.mjs"), "--offline", "--out", out],
    { encoding: "utf8", timeout: 240_000 },
  );
  assert.equal(replay.status, 0, replay.stderr || replay.stdout);

  const refused = cli([out]);
  assert.equal(refused.status, 1, "an offline replay must not be publishable");
  assert.match(refused.stderr, /"offline": true/);

  // The same files with the marker taken off still agree with each other, which
  // is the shape of a live run's output: only the marker kept this one out.
  const status = JSON.parse(await readFile(join(out, "status.json"), "utf8"));
  assert.equal(status.offline, true);
  delete status.offline;
  await writeFile(join(out, "status.json"), JSON.stringify(status));
  const shaped = cli([out]);
  assert.equal(shaped.status, 0, shaped.stderr);
});

// build-static-edition.mjs finds the repository from its own location, so a copy
// in a temporary folder tree gets its own public/data. A stand-in tsc and vite
// record what they were asked to do.
async function buildTree(t, files) {
  const root = await mkdtemp(join(tmpdir(), "edition-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"), { recursive: true });
  for (const name of ["build-static-edition.mjs", "check-edition-data.mjs"])
    copyFileSync(join(repo, "scripts", name), join(root, "scripts", name));
  // The data check shares the 7D and 30D file's rules with the collector.
  await mkdir(join(root, "shared"), { recursive: true });
  copyFileSync(
    join(repo, "shared", "daily-volume.ts"),
    join(root, "shared", "daily-volume.ts"),
  );
  await writeFile(join(root, "package.json"), "{}");
  const record = `require("fs").appendFileSync(${JSON.stringify(join(root, "calls.log"))}, JSON.stringify([process.argv[1].split(/[\\\\/]/).slice(-2).join("/"), process.argv.slice(2), process.env.VITE_STATIC_EDITION]) + "\\n");`;
  for (const [name, content] of Object.entries({
    "node_modules/typescript/package.json": '{"name":"typescript"}',
    "node_modules/typescript/bin/tsc": record,
    "node_modules/vite/package.json": '{"name":"vite"}',
    "node_modules/vite/bin/vite.js": record,
    ...files,
  })) {
    if (content === null) continue;
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return root;
}

const build = (root, args) =>
  spawnSync(
    process.execPath,
    [join(root, "scripts", "build-static-edition.mjs"), ...args],
    { cwd: root, encoding: "utf8" },
  );

test("--require-data builds only when public/data holds a live snapshot", async (t) => {
  const good = await buildTree(t, {
    "public/data/snapshot.json": live["snapshot.json"],
    "public/data/status.json": live["status.json"],
  });
  const ok = build(good, ["--require-data", "--outDir", "site-mirror"]);
  assert.equal(ok.status, 0, ok.stderr);
  const calls = (await readFile(join(good, "calls.log"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(calls, [
    ["bin/tsc", ["-b"], "1"],
    ["bin/vite.js", ["build", "--outDir", "site-mirror"], "1"],
  ]);

  const replay = await buildTree(t, {
    "public/data/snapshot.json": live["snapshot.json"],
    "public/data/status.json": withStatus({ offline: true })["status.json"],
  });
  const refused = build(replay, ["--require-data"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /public\/data is not fit to publish/);
  assert.match(refused.stderr, /"offline": true/);

  const empty = await buildTree(t, {});
  const missing = build(empty, ["--require-data"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /snapshot\.json is missing/);
  for (const root of [replay, empty])
    await assert.rejects(
      readFile(join(root, "calls.log"), "utf8"),
      { code: "ENOENT" },
      "neither the type check nor the build ran",
    );

  const without = build(empty, ["--outDir", "x"]);
  assert.equal(without.status, 0, "without --require-data nothing is checked");
});
