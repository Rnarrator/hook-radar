// Small leftovers of the Auto Snapshot edition that no other group owned: the
// wording of the pool explorer, the date in an analytics CSV file name, the
// Data notes sentence about the pool count, touch hit areas, the browser-test
// script, the folder assembler's list of tests and the FTP workflow's header.
//
// Components are compiled from source, once as the edition (VITE_STATIC_EDITION=1)
// and once as the live build (flag unset), and rendered to markup, so the
// strings read here are the ones a visitor reads and the live ones are shown
// not to have changed. Plain fixtures; nothing is written anywhere. Style
// sheets are read as text: the browser half of these checks is in
// scripts/static-edition-leftovers-browser.test.mjs. Source files are read with
// LF line ends so the checks hold on a Windows checkout (CRLF) too.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { buildAnalytics } from "../src/analytics.ts";
import { historyExportTimes } from "../src/history-chart.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (path) =>
  readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n");
const snapshot = JSON.parse(
  readFileSync(
    join(root, "tests", "fixtures", "static-data", "data", "snapshot.json"),
    "utf8",
  ),
);
const generated = Date.parse(snapshot.generatedAt);

// The assembler is only in the source repository (its own tests are too); in an
// assembled folder these checks skip. The path is not a static import so the
// folder's import check leaves it alone.
const assembler = await import("../scripts/make-edition-folder.mjs").catch(
  () => null,
);

/* ── Components ───────────────────────────────────────────────────────── */

const projectRequire = createRequire(resolve(root, "package.json"));
const flavours = {};

/** AnalyticsPoolExplorer compiled from source with the flag on or unset: each
 * source file is transpiled (TypeScript only) and wired with a small CommonJS
 * loader; style sheets are empty; packages come from node_modules. */
function loadFlavour(edition) {
  const flag = edition ? '"1"' : "undefined";
  const cache = new Map();
  const local = (from, specifier) => {
    const base = resolve(dirname(from), specifier);
    for (const candidate of [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      join(base, "index.ts"),
      join(base, "index.tsx"),
    ])
      if (existsSync(candidate) && statSync(candidate).isFile())
        return candidate;
    throw new Error(`cannot resolve ${specifier} from ${from}`);
  };
  function load(file) {
    const cached = cache.get(file);
    if (cached) return cached.exports;
    const module = { exports: {} };
    cache.set(file, module);
    const source = readFileSync(file, "utf8")
      .replaceAll("import.meta.env.VITE_STATIC_EDITION", flag)
      .replaceAll("import.meta.env.BASE_URL", '"/"');
    const { outputText } = ts.transpileModule(source, {
      fileName: file,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
    });
    const requireFrom = (specifier) =>
      specifier.startsWith(".")
        ? specifier.endsWith(".css")
          ? {}
          : load(local(file, specifier))
        : projectRequire(specifier);
    new Function("exports", "require", "module", outputText)(
      module.exports,
      requireFrom,
      module,
    );
    return module.exports;
  }
  return {
    createElement: projectRequire("react").createElement,
    renderToStaticMarkup:
      projectRequire("react-dom/server").renderToStaticMarkup,
    AnalyticsPoolExplorer: load(
      resolve(root, "src/components/AnalyticsPoolExplorer.tsx"),
    ).AnalyticsPoolExplorer,
  };
}

before(() => {
  flavours.edition = loadFlavour(true);
  flavours.live = loadFlavour(false);
});

const decode = (html) =>
  html
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"');
const plain = (html) =>
  decode(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();

/** The pool explorer of a scope in which no pool was measured. */
function emptyExplorer(flavour) {
  const m = flavours[flavour];
  const result = {
    ...buildAnalytics(snapshot, {
      chain: "all",
      windowKey: "h24",
      now: generated,
    }),
    pools: [],
  };
  return plain(
    m.renderToStaticMarkup(
      m.createElement(m.AnalyticsPoolExplorer, {
        result,
        windowKey: "h24",
        openProject() {},
      }),
    ),
  );
}

test("the pool explorer's empty states speak of the snapshot, not of a service that will fill them", () => {
  const text = emptyExplorer("edition");
  for (const phrase of [
    "No matching measurements in this snapshot",
    "Select a pool from the measurements in this snapshot.",
    "No pool in this scope has a current volume or reserve measurement in this snapshot.",
  ])
    assert.ok(text.includes(phrase), `the edition lacks "${phrase}"`);
  // Nothing in a frozen snapshot "becomes available" or "appears" later.
  assert.doesNotMatch(text, /\byet\b/i);
  assert.doesNotMatch(text, /become available/i);
  assert.doesNotMatch(text, /appear here when/i);
  assert.doesNotMatch(text, /when .* (?:become|are) available/i);
});

test("the live pool explorer says what it always said", () => {
  const text = emptyExplorer("live");
  for (const phrase of [
    "No matching measurements yet",
    "Select a pool when matching measurements become available.",
    "Pools appear here when current volume or reserve measurements are available.",
  ])
    assert.ok(text.includes(phrase), `the live page lacks "${phrase}"`);
  assert.ok(!text.includes("in this snapshot"));
});

/* ── The analytics CSV file name ──────────────────────────────────────── */

test("the CSV file name takes its date from the day it is made, and live is unchanged", () => {
  const realNow = Date.parse("2026-12-05T09:30:00.000Z");
  assert.notEqual(
    new Date(generated).toISOString().slice(0, 10),
    "2026-12-05",
    "the fixture's snapshot is not dated the day of this check",
  );
  // Edition: `now` is the snapshot's time; the file is dated today.
  assert.equal(
    historyExportTimes(generated, true, realNow).exportedAt.slice(0, 10),
    "2026-12-05",
  );
  // Live: `now` is today's clock, so the name is what it was before.
  assert.equal(
    historyExportTimes(realNow, false, realNow + 1).exportedAt.slice(0, 10),
    new Date(realNow).toISOString().slice(0, 10),
  );
  assert.equal(
    historyExportTimes(generated, false).exportedAt,
    new Date(generated).toISOString(),
  );
  const workspace = read("src/components/AnalyticsWorkspace.tsx");
  assert.match(
    workspace,
    /link\.download = `hook-radar-analytics-\$\{chain\}-\$\{windowKey\}\$\{spanSuffix\}-\$\{historyExportTimes\(now\)\.exportedAt\.slice\(0, 10\)\}\.csv`/,
  );
  // The suffix is empty without a span, so the name is what it was.
  assert.match(
    workspace,
    /const spanSuffix = spanChosen && daily\.lens \? `-\$\{daily\.lens\.span\}` : "";/,
  );
  assert.doesNotMatch(workspace, /new Date\(now\)\.toISOString\(\)\.slice/);
});

/* ── Data notes on the Networks page ──────────────────────────────────── */

test("the Networks Data notes explain the pool count column in the edition only", () => {
  const text = read("src/components/ChainExplorer.tsx");
  assert.match(
    text,
    /A ≥ pool count is a known\s+lower bound\.\s*\{STATIC_EDITION\s*\?\s*" In the project lists the count is the pools measured in this snapshot\."\s*:\s*""\}/,
  );
  // The column the sentence explains is the edition's "Pools in snapshot".
  assert.match(
    read("src/components/ChainProtocolCatalog.tsx"),
    /STATIC_EDITION \? "Pools in snapshot" : "Pools using hooks"/,
  );
});

/* ── Style sheets ─────────────────────────────────────────────────────── */

const TOUCH_QUERY = "@media (max-width: 52rem), (pointer: coarse)";

test("the launchpad drawer's 24px link height is for touch and narrow screens only, like the rest of the edition's", () => {
  const css = read("src/components/platform-detail.css");
  const rule =
    ":where(.platform-detail.is-snapshot) :where(.external, .lp-link)";
  assert.equal(
    css.split(rule).length - 1,
    1,
    "the rule is written once, inside the touch query",
  );
  // Inside the media query, and nowhere at the top level.
  assert.match(
    css,
    new RegExp(
      `${TOUCH_QUERY.replace(/[()]/g, "\\$&")} \\{\\s*${rule.replace(/[().]/g, "\\$&")} \\{\\s*min-height: 1\\.5rem;\\s*\\}\\s*\\}`,
    ),
  );
  // The same query the other 24px rule of the edition uses.
  const compact = read("src/design/compact.css");
  assert.ok(
    compact.includes(
      `${TOUCH_QUERY} {\n  :where(:root[data-edition="snapshot"])`,
    ),
  );
});

test("a composition-bar segment gets a 24px touch hit area, in the edition, on touch and narrow screens, without changing the bar", () => {
  const css = read("src/components/analytics.css");
  const block = css.match(
    /@media \(max-width: 52rem\), \(pointer: coarse\) \{\s*:where\(:root\[data-edition="snapshot"\]\) button\.chart-ribbon-segment \{([^}]*)\}\s*:where\(:root\[data-edition="snapshot"\]\) button\.chart-ribbon-segment::after \{([^}]*)\}/,
  );
  assert.ok(block, "the touch rule for the segments is present");
  assert.match(block[1], /position: relative;/);
  assert.match(block[2], /content: "";/);
  assert.match(block[2], /position: absolute;/);
  // Up to 24px high, and no taller when the bar already is.
  assert.match(
    block[2],
    /inset-block: min\(0px, calc\(\(100% - 1\.5rem\) \/ 2\)\);/,
  );
  // The segment itself is left alone: no height, padding or margin is added.
  assert.doesNotMatch(block[1], /height|padding|margin|border|transform/);
  // Live: nothing outside the edition's root is touched.
  assert.ok(!/(?:^|\n)button\.chart-ribbon-segment::after/.test(css));
});

test("the composition bar's reveal leaves no clip-path on the bar on touch and narrow screens, so the hit area also works when motion is allowed", () => {
  const css = read("src/components/analytics.css");
  const charts = read("src/charts/charts.css");
  // The cause: the live reveal keeps its last keyframe (fill-mode both), and a
  // clip-path clips hit-testing. If charts.css stops doing that, this fix is
  // no longer needed and the check says so.
  assert.match(
    charts,
    /@media \(prefers-reduced-motion: no-preference\) \{[^@]*\.chart-ribbon-bar \{\s*animation: chart-ribbon-reveal 900ms var\(--ease-out\) both;/,
  );
  assert.match(
    charts,
    /@keyframes chart-ribbon-reveal \{[^@]*clip-path: inset\(0 0 0 0 round 4px\);/,
  );
  // The fix sits inside the touch/narrow query of the edition's own root, and
  // not inside :where(), so it outranks the shorthand wherever the sheet lands.
  const start = css.indexOf(
    TOUCH_QUERY +
      ' {\n  :where(:root[data-edition="snapshot"]) button.chart-ribbon-segment {',
  );
  assert.ok(start >= 0, "the touch/narrow block is present");
  const block = css.slice(start, css.indexOf("\n}\n", start));
  assert.match(
    block,
    /\n {2}:root\[data-edition="snapshot"\] \.chart-ribbon-bar \{\s*animation-fill-mode: backwards;\s*\}/,
  );
  // The clip hid the glow; it is off here so the bar looks as it did.
  assert.match(
    block,
    /\n {2}:root\[data-edition="snapshot"\] \.chart-ribbon-segment \{\s*box-shadow: none;\s*\}/,
  );
  // Once, and nowhere else: a desktop and the live page keep the reveal as is.
  assert.equal(css.split("animation-fill-mode").length, 2);
  assert.equal(
    css.split("chart-ribbon-segment {\n    box-shadow: none").length,
    2,
  );
});

test("the not-carried notice in Compare lays its ids out as rows with the Remove button beside each", () => {
  const css = read("src/components/comparison.css");
  for (const part of [
    /\.comparison-not-carried \{\s*align-items: flex-start;\s*\}/,
    /\.comparison-not-carried ul \{\s*display: grid;\s*gap: var\(--s-1\);\s*margin: var\(--s-2\) 0 0;\s*padding: 0;\s*list-style: none;\s*\}/,
    /\.comparison-not-carried li \{\s*display: flex;\s*flex-wrap: wrap;\s*align-items: center;\s*gap: var\(--s-2\) var\(--s-3\);\s*\}/,
    /\.comparison-not-carried button \{\s*margin-left: 0;\s*\}/,
  ])
    assert.match(css, part);
});

/* ── Packaging ────────────────────────────────────────────────────────── */

const packageJson = JSON.parse(read("package.json"));
const BROWSER_TESTS = readdirSync(join(root, "scripts"))
  .filter(
    (name) =>
      /^static-edition-.*\.test\.mjs$/.test(name) ||
      /^edition-.*-browser\.test\.mjs$/.test(name),
  )
  .sort();

test("test:edition-browser runs every browser test of the edition and stops with a clear message without a build", () => {
  const script = packageJson.scripts["test:edition-browser"];
  assert.equal(typeof script, "string", "the script exists");
  const parts = script.match(/^node -e "([^"]+)" && (node --test .+)$/);
  assert.ok(parts, `the script has the shape check && node --test: ${script}`);
  assert.match(parts[2], /scripts\/static-edition-\*\.test\.mjs/);
  assert.match(parts[2], /scripts\/edition-\*-browser\.test\.mjs/);
  assert.match(parts[2], /--test-concurrency=1/);

  // The first half, run as the script runs it.
  const env = { ...process.env };
  delete env.RADAR_TEST_DIST;
  const missing = spawnSync(process.execPath, ["-e", parts[1]], {
    env,
    encoding: "utf8",
  });
  assert.equal(missing.status, 1, "it stops when RADAR_TEST_DIST is missing");
  assert.match(missing.stderr, /RADAR_TEST_DIST is not set/);
  assert.match(missing.stderr, /build:static/);
  const named = spawnSync(process.execPath, ["-e", parts[1]], {
    env: { ...env, RADAR_TEST_DIST: "some/build" },
    encoding: "utf8",
  });
  assert.equal(named.status, 0, "it goes on once a build is named");

  // The other scripts of package.json are as they were.
  assert.match(
    packageJson.scripts["test:edition"],
    /^node --test --test-concurrency=4 tests\/collector-\*\.test\.mjs tests\/edition-\*\.test\.mjs$/,
  );
});

test("the folder's README says how to run the browser tests and that they need RADAR_TEST_DIST", () => {
  // The source repository keeps the edition's README under docs/edition/; the
  // assembler puts it at README.md of the folder (README_SOURCE there), where
  // docs/edition/ does not exist. This test travels, so it reads either.
  const readme = read(
    existsSync(join(root, "docs/edition/README-START-HERE.md"))
      ? "docs/edition/README-START-HERE.md"
      : "README.md",
  );
  assert.match(readme, /npm run test:edition-browser/);
  assert.match(readme, /RADAR_TEST_DIST=<folder> npm run test:edition-browser/);
  assert.match(readme, /npm run build:static -- --outDir <folder>/);
  assert.match(readme, /Without `RADAR_TEST_DIST` the command stops/);
});

test(
  "the assembled folder passes the tests that travel with it",
  { timeout: 300000 },
  async (t) => {
    if (!assembler) return t.skip("needs the source repository");
    // A test that reads a path which exists only in the source repository (the
    // README under docs/edition/, say) passes here and fails in the folder the
    // owner publishes. So the real tree is assembled and its own tests are run
    // from inside the folder, the way `npm run test:edition` runs them there.
    const target = mkdtempSync(join(tmpdir(), "edition-folder-"));
    const modules = join(target, "node_modules");
    t.after(() => {
      // Take the link to node_modules away first so nothing below it is touched.
      try {
        unlinkSync(modules);
      } catch {}
      rmSync(target, { recursive: true, force: true });
    });
    await assembler.assemble({ root, target, allowNoSnapshot: true });
    assert.ok(
      !existsSync(join(target, "docs", "edition")),
      "docs/edition/ is not in the folder: the README is README.md there",
    );
    symlinkSync(join(root, "node_modules"), modules, "junction");

    const names = readdirSync(join(target, "tests"))
      .filter((name) => /^(?:collector|edition)-.*\.test\.mjs$/.test(name))
      .sort();
    assert.ok(
      names.length > 10,
      `the folder carries its tests (${names.length})`,
    );
    assert.ok(names.includes("edition-leftovers.test.mjs"));
    // The browser tests skip without a build; a parent test run must not leak in.
    const env = { ...process.env };
    delete env.RADAR_TEST_DIST;
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(
      process.execPath,
      [
        "--test",
        "--test-concurrency=4",
        ...names.map((name) => `tests/${name}`),
      ],
      { cwd: target, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    const count = (label) =>
      Number(new RegExp(`^ℹ ${label} (\\d+)$`, "m").exec(run.stdout)?.[1]);
    const failed = run.stdout
      .split("\n")
      .filter((line) => /^\s*✖/.test(line))
      .slice(0, 10)
      .join("\n");
    assert.equal(
      run.status,
      0,
      `the folder's own tests fail inside the folder:\n${failed}\n${run.stderr.slice(-2000)}`,
    );
    assert.equal(count("fail"), 0);
    assert.ok(count("pass") > 100, `its tests ran (${count("pass")} passed)`);
  },
);

test("every browser test of the edition reads its build from RADAR_TEST_DIST", () => {
  assert.ok(
    BROWSER_TESTS.some((name) => /^static-edition-/.test(name)) &&
      BROWSER_TESTS.some((name) => /^edition-.*-browser/.test(name)),
    `the edition has its browser tests (${BROWSER_TESTS.join(", ")})`,
  );
  assert.ok(
    BROWSER_TESTS.includes("static-edition-leftovers-browser.test.mjs"),
  );
  for (const name of BROWSER_TESTS)
    assert.match(
      read(`scripts/${name}`),
      /process\.env\.RADAR_TEST_DIST/,
      `${name} is told which build to test`,
    );
});

test("the folder assembler copies every browser test of the edition and the script that runs them", async (t) => {
  if (!assembler) return t.skip("needs the source repository");
  const plan = await assembler.planEdition({
    root,
    allowNoSnapshot: true,
  });
  const copied = new Set(plan.files.keys());
  for (const name of BROWSER_TESTS)
    assert.ok(copied.has(`scripts/${name}`), `scripts/${name} travels`);
  for (const path of [
    "scripts/static-edition-server.mjs",
    "scripts/build-static-edition.mjs",
    "tests/fixtures/static-data/data/snapshot.json",
    "tests/fixtures/static-data/generate.mjs",
    "shared/launchpad-registry.ts",
    "tests/edition-leftovers.test.mjs",
  ])
    assert.ok(copied.has(path), `${path} travels`);
  assert.equal(
    plan.packageJson.scripts["test:edition-browser"],
    packageJson.scripts["test:edition-browser"],
  );
  // A source without the script gets none (the folder never invents one).
  const { "test:edition-browser": _gone, ...scripts } = packageJson.scripts;
  assert.equal(
    assembler.editionPackageJson({ ...packageJson, scripts }).scripts[
      "test:edition-browser"
    ],
    undefined,
  );
});

test("no test of the edition holds credential-looking text, so the credential check needs no allow-list", async (t) => {
  if (!assembler) return t.skip("needs the source repository");
  const files = [
    "tests/edition-collector-truth.test.mjs",
    "tests/edition-package-workflows.test.mjs",
    "tests/edition-leftovers.test.mjs",
  ];
  assert.deepEqual(
    await assembler.credentialProblems(
      files.map((path) => [path, join(root, path)]),
      { allowlist: [] },
    ),
    [],
  );
  // The real tree assembles with no exception at all.
  const plan = await assembler.planEdition({
    root,
    allowNoSnapshot: true,
    credentialAllowlist: [],
  });
  assert.ok(plan.files.size > 100);
  assert.deepEqual(assembler.CREDENTIAL_ALLOWLIST, []);
});

test("recorded fixtures are never given other line ends by a checkout", () => {
  const attributes = read(".gitattributes");
  assert.match(attributes, /^collector\/fixtures\/\*\* -text$/m);
  // The rule is meant for the folder holding the recordings and nothing else.
  assert.ok(existsSync(join(root, "collector", "fixtures", "manifest.json")));
  // git itself agrees, where there is a repository to ask.
  const answer = spawnSync(
    "git",
    ["check-attr", "text", "--", "collector/fixtures/raw-1.json"],
    { cwd: root, encoding: "utf8" },
  );
  if (answer.status === 0 && answer.stdout.trim())
    assert.match(answer.stdout, /text: unset/);
});

test("the FTP workflow's header says it uploads .htaccess and replaces the one in the folder", () => {
  const text = read(".github/workflows/deploy-ftp.yml");
  const header = text.slice(0, text.indexOf("\nname:"));
  assert.ok(header.length > 500, "the header comment is there");
  assert.match(header, /\.htaccess/);
  assert.match(header, /replaced by the first upload/);
  assert.match(header, /public\/\.htaccess/);
  assert.match(header, /docs\/HOSTING-NAMECHEAP\.md/);
});
