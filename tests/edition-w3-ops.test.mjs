// The workflows, hosting guides and data gate as an owner meets them: what a
// workflow may commit, what the custom-domain check does with a misnamed file,
// and what the Vercel, Cloudflare and Namecheap guides tell the owner to do.
// Everything reads files that travel with the edition; nothing needs a network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const lf = (text) => text.replace(/\r\n/g, "\n");
const read = (path) => lf(readFileSync(join(root, path), "utf8"));
const WORKFLOWS = ["snapshot.yml", "deploy-ftp.yml", "ci.yml"];

/** A hosting guide: docs/edition/ in the repository, docs/ in the folder. */
function guide(name) {
  const found = [
    join(root, "docs", "edition", name),
    join(root, "docs", name),
  ].find((path) => existsSync(path));
  return found ? lf(readFileSync(found, "utf8")) : null;
}

/** The lines of the step that holds line `at`, from its "- name:" to the next. */
function stepAround(lines, at) {
  let from = at;
  while (from > 0 && !/^ {6}- /.test(lines[from])) from -= 1;
  let to = at + 1;
  while (to < lines.length && !/^ {6}- |^ {2}\S/.test(lines[to])) to += 1;
  return lines.slice(from, to).join("\n");
}

/** The script of the `run: |` block of the step with this id. */
function stepScript(source, id) {
  const lines = lf(source).split("\n");
  const at = lines.findIndex((line) => line.trim() === `id: ${id}`);
  assert.notEqual(at, -1, `a step with id ${id}`);
  const run = lines.findIndex((line, i) => i > at && /^\s+run: \|$/.test(line));
  assert.notEqual(run, -1, `step ${id} has a run block`);
  const indent = lines[run + 1].search(/\S/);
  const body = [];
  for (let i = run + 1; i < lines.length; i += 1) {
    if (lines[i].trim() !== "" && lines[i].search(/\S/) < indent) break;
    body.push(lines[i].slice(indent));
  }
  return body.join("\n");
}

/* ── What the workflows commit ─────────────────────────────────────────────── */

test("no workflow commits anything but state/ to the repository", () => {
  for (const name of WORKFLOWS) {
    const lines = read(`.github/workflows/${name}`).split("\n");
    let adds = 0;
    lines.forEach((line, at) => {
      if (/^\s*#/.test(line)) return;
      const mirror = /cd site-mirror/.test(stepAround(lines, at));
      if (/\bgit add\b/.test(line)) {
        if (mirror) {
          // The site branch is built in a throwaway folder with its own
          // repository (git init), never in the checkout.
          assert.match(stepAround(lines, at), /git init/, `${name}: ${line}`);
          assert.equal(line.trim(), "git add -A", `${name}: ${line}`);
        } else {
          adds += 1;
          assert.equal(line.trim(), "git add state", `${name}:${at + 1}`);
        }
      }
      if (/\bgit commit\b/.test(line))
        assert.doesNotMatch(
          line,
          /git commit\s+(?:-\w*a\w*|--all)\b/,
          `${name}: a commit that stages by itself`,
        );
      if (/\bgit push\b/.test(line)) {
        if (mirror)
          assert.match(line, /^\s*git push --force "https:\/\/x-access-token:/);
        else
          assert.equal(
            line
              .replace(/^\s*if /, "")
              .replace(/; then$/, "")
              .trim(),
            'git push origin "HEAD:${GITHUB_REF_NAME}"',
            `${name}: only the current branch is pushed, without force`,
          );
      }
      assert.doesNotMatch(
        line,
        /\bgit (?:rm|mv|checkout -- |reset --hard|clean)\b|\brm -rf? (?:\.\/)?(?:public|state|src)\b/,
        `${name}: ${line.trim()}`,
      );
    });
    if (name === "ci.yml")
      assert.equal(
        lines.some((line) => /\bgit (?:add|commit|push)\b/.test(line)),
        false,
        "the checks workflow commits nothing",
      );
    else assert.equal(adds, 1, `${name} has one state commit`);
  }
});

test("the collector runs before any build or commit in both publishing workflows", () => {
  for (const name of ["snapshot.yml", "deploy-ftp.yml"]) {
    const text = read(`.github/workflows/${name}`);
    // With or without the documented v4.xyz stop (PROVIDER-TERMS.md item 1).
    const collector = text.search(
      /^ +run: node collector\/run\.mjs(?: --max-discovery 0)?$/m,
    );
    assert.notEqual(collector, -1, `${name}: the collect step line is intact`);
    for (const later of [
      /build:static -- --require-data/,
      /git add state/,
      /check-edition-data/,
    ])
      assert.ok(text.search(later) > collector, `${name}: ${later}`);
  }
  // Without public/data in the repository the checks workflow still builds:
  // the offline replay writes nothing (--no-publish), and the build without
  // --require-data produces the page with no data folder.
  const ci = read(".github/workflows/ci.yml");
  assert.ok(
    ci.indexOf("node collector/run.mjs --offline --no-publish") <
      ci.indexOf("npm run build:static"),
    "ci builds after the offline collector",
  );
});

/* ── The custom-domain check in the Snapshot workflow ──────────────────────── */

let bashFound;
function findBash() {
  if (bashFound === undefined) bashFound = lookForBash() ?? null;
  return bashFound ?? undefined;
}

function lookForBash() {
  const candidates =
    process.platform === "win32"
      ? [
          join(
            process.env.ProgramFiles ?? "C:\\Program Files",
            "Git",
            "bin",
            "bash.exe",
          ),
          join(
            process.env["ProgramFiles(x86)"] ?? "",
            "Git",
            "bin",
            "bash.exe",
          ),
        ].filter((path) => existsSync(path))
      : ["bash"];
  return candidates.find((bash) => {
    const probe = spawnSync(bash, ["-c", "echo ok"], { encoding: "utf8" });
    return probe.status === 0 && probe.stdout.trim() === "ok";
  });
}

async function runSiteStep(t, files, repository = "Alice/hook-radar") {
  const bash = findBash();
  if (!bash) return t.skip("no bash here to run the workflow's shell step");
  const dir = await mkdtemp(join(tmpdir(), "edition-site-step-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  const result = spawnSync(
    bash,
    ["-c", stepScript(read(".github/workflows/snapshot.yml"), "site")],
    {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_REPOSITORY: repository,
        GITHUB_REPOSITORY_OWNER: repository.split("/")[0],
        GITHUB_OUTPUT: "github-output.txt",
      },
    },
  );
  const output = await readFile(join(dir, "github-output.txt"), "utf8").catch(
    () => "",
  );
  return { ...result, output: lf(output) };
}

test("the site step works out the base and address, with or without a custom domain", async (t) => {
  const plain = await runSiteStep(t, { "public/logo.svg": "x" });
  if (!plain) return;
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(
    plain.output,
    "base=/hook-radar/\nurl=https://alice.github.io/hook-radar/\n",
  );

  const userSite = await runSiteStep(t, {}, "Alice/alice.github.io");
  assert.equal(userSite.status, 0, userSite.stderr);
  assert.equal(userSite.output, "base=/\nurl=https://alice.github.io/\n");

  // A file made on Windows ends its lines with CR LF and may have capitals.
  const domain = await runSiteStep(t, {
    "public/CNAME": "WWW.Example.com\r\n",
  });
  assert.equal(domain.status, 0, domain.stderr);
  assert.equal(domain.output, "base=./\nurl=https://www.example.com/\n");

  const atRoot = await runSiteStep(t, { CNAME: "example.org\n" });
  assert.equal(atRoot.output, "base=./\nurl=https://example.org/\n");

  const bad = await runSiteStep(t, { "public/CNAME": "https://x.com/a_b!\n" });
  assert.notEqual(bad.status, 0);
  assert.match(
    bad.stdout,
    /::error::public\/CNAME must contain one domain name/,
  );
});

// Windows and macOS folders do not tell CNAME and cname apart, so a file named
// only with other capitals cannot be told from the right one there (the runner
// is Linux, where it can).
function caseSensitiveTemp() {
  const probe = mkdtempSync(join(tmpdir(), "edition-case-"));
  try {
    writeFileSync(join(probe, "a"), "");
    return !existsSync(join(probe, "A"));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

test("a misnamed custom-domain file stops the run instead of building for the wrong address", async (t) => {
  for (const name of [
    "public/CNAME.txt",
    "public/Cname.TXT",
    "CNAME.txt",
    ...(caseSensitiveTemp() ? ["public/cname", "cname"] : []),
  ]) {
    const result = await runSiteStep(t, { [name]: "www.example.com\n" });
    if (!result) return;
    assert.equal(result.status, 1, `${name} must stop the run`);
    assert.match(result.stdout, /::error::/, name);
    assert.match(result.stdout, /exactly public\/CNAME/, name);
    assert.match(result.stdout, /no \.txt/, name);
    assert.equal(result.output, "", `${name}: nothing was decided`);
  }
  // The right file wins over a stray one, and unrelated files are left alone.
  const both = await runSiteStep(t, {
    "public/CNAME": "www.example.com\n",
    "public/CNAME.txt": "old\n",
  });
  assert.equal(both.status, 0, both.stderr);
  assert.match(both.output, /^base=\.\/$/m);
  const others = await runSiteStep(t, {
    "public/cname-notes.md": "x",
    "README.md": "x",
  });
  assert.equal(others.status, 0, others.stderr);
  assert.match(others.output, /^base=\/hook-radar\/$/m);
});

/* ── The Snapshot mirror and the hosting guides ────────────────────────────── */

/** Runs the mirror build step with a stand-in npm that records what it saw. */
async function runMirrorStep(t, siteUrl) {
  const bash = findBash();
  if (!bash) return t.skip("no bash here to run the workflow's shell step");
  const dir = await mkdtemp(join(tmpdir(), "edition-mirror-step-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "bin"));
  await writeFile(
    join(dir, "bin", "npm"),
    '#!/bin/sh\nprintf \'VITE_SITE_URL=[%s]\\nARGS=[%s]\\n\' "${VITE_SITE_URL-unset}" "$*" > npm-called.txt\n',
    { mode: 0o755 },
  );
  const pathKey =
    Object.keys(process.env).find((key) => key.toLowerCase() === "path") ??
    "PATH";
  const result = spawnSync(
    bash,
    ["-c", stepScript(read(".github/workflows/snapshot.yml"), "mirror-build")],
    {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        // Node is on the path, as setup-node makes it on the runner.
        [pathKey]: [
          join(dir, "bin"),
          dirname(process.execPath),
          process.env[pathKey],
        ].join(delimiter),
        // An unset repository variable reads as an empty string.
        SITE_URL: siteUrl,
      },
    },
  );
  const called = await readFile(join(dir, "npm-called.txt"), "utf8").catch(
    () => "",
  );
  return { ...result, called: lf(called) };
}

test("a SITE_URL the build would refuse is left out with a warning, and the site branch still updates", async (t) => {
  const used = async (siteUrl) => {
    const result = await runMirrorStep(t, siteUrl);
    if (!result) return null;
    assert.equal(result.status, 0, `${siteUrl}: ${result.stderr}`);
    assert.match(
      result.called,
      /ARGS=\[run build:static -- --require-data --outDir site-mirror\]/,
      `${siteUrl}: the build runs`,
    );
    return {
      url: /^VITE_SITE_URL=\[(.*)\]$/m.exec(result.called)?.[1],
      warned: /::warning::/.test(result.stdout),
      stdout: result.stdout,
    };
  };

  const unset = await used("");
  if (!unset) return;
  assert.deepEqual([unset.url, unset.warned], ["", false], "unset: no picture");

  const good = ["https://my-radar.vercel.app/", "https://my-radar.vercel.app"];
  for (const siteUrl of good) {
    const result = await used(siteUrl);
    assert.deepEqual([result.url, result.warned], [siteUrl, false], siteUrl);
  }

  // The typed-without-https:// case that began this, and the other values the
  // build itself refuses.
  const refused = [
    "my-radar.vercel.app",
    "http://my-radar.vercel.app/",
    "https://",
    "https://user:secret@my-radar.vercel.app/",
    "https://my-radar.vercel.app/?a=1",
    "https://my-radar.vercel.app/#top",
  ];
  for (const siteUrl of refused) {
    const result = await used(siteUrl);
    assert.equal(result.url, "", `${siteUrl}: the picture is left out`);
    assert.ok(result.warned, `${siteUrl}: a warning is shown`);
    assert.match(result.stdout, /::warning::[^\n]*SITE_URL/, siteUrl);
    assert.match(result.stdout, /starts with https:\/\//, siteUrl);
    assert.doesNotMatch(
      result.stdout,
      /secret/,
      `${siteUrl}: the value is not echoed into the log`,
    );
  }

  // The step must agree with the rule the build applies, so a change to one
  // cannot silently leave the other behind.
  let editionSiteUrl;
  try {
    ({ editionSiteUrl } = await import("../vite.config.ts"));
  } catch {
    return; // the build configuration is not importable here
  }
  for (const siteUrl of [...good, ...refused]) {
    const result = await used(siteUrl);
    let accepted = true;
    try {
      editionSiteUrl(siteUrl);
    } catch {
      accepted = false;
    }
    assert.equal(
      result.warned,
      !accepted,
      `${siteUrl}: the step and vite.config.ts agree`,
    );
  }
});

test("the Vercel and Cloudflare guides say what must be true first and where SITE_URL goes", (t) => {
  const vercel = guide("HOSTING-VERCEL.md");
  const cloudflare = guide("HOSTING-CLOUDFLARE-PAGES.md");
  if (!vercel || !cloudflare) return t.skip("the guides are not here");
  for (const [name, text] of [
    ["Vercel", vercel],
    ["Cloudflare", cloudflare],
  ]) {
    const setUp = text.indexOf("\n## Set up");
    assert.notEqual(setUp, -1, name);
    const before = text.slice(0, setUp);
    assert.match(
      before,
      /Do the steps in README\.md first: a public repository, GitHub Pages set to Source: GitHub Actions, and one green Snapshot run\. The Snapshot job checks that Pages is on before it collects anything\./,
      name,
    );
    assert.match(before, /leave GitHub Pages switched on/, name);
    assert.doesNotMatch(
      text.slice(setUp),
      /Leave GitHub Pages switched on/,
      `${name}: the paragraph moved above the steps`,
    );
    assert.match(text, /build of the main branch would produce/, name);
    assert.match(text, /`SITE_URL`/, `${name}: SITE_URL`);
    assert.match(
      text,
      new RegExp(`must be the ${name} address`),
      `${name}: SITE_URL is the address of this host`,
    );
    assert.match(
      text,
      /must start with `https:\/\/`: if it does not, the run still updates the `site` branch but leaves the picture out, and shows a warning that names `SITE_URL`/,
      `${name}: SITE_URL must start with https://, and what happens if not`,
    );
    assert.doesNotMatch(text, /README step|step \d+ of the README/i, name);
  }
  assert.match(
    vercel,
    /most likely if the repository is private; keep it public/,
  );
  assert.doesNotMatch(
    cloudflare,
    /Hobby/,
    "the Vercel Hobby private-repository point is not for the Cloudflare page",
  );
  assert.match(
    cloudflare,
    /Cloudflare Pages allows 25 MiB per file; `snapshot\.json` is about 10 MB today and could reach about 21 MB/,
  );
});

test("the Vercel guide sets the production branch where Vercel has it, after the first deploy", (t) => {
  const text = guide("HOSTING-VERCEL.md");
  if (!text) return t.skip("the guide is not here");
  assert.doesNotMatch(text, /Project Settings, Git/);
  const steps = text.slice(
    text.indexOf("\n## Set up"),
    text.indexOf("\n## Compression"),
  );
  const at = (pattern) => steps.search(pattern);
  assert.ok(at(/Press \*\*Deploy\*\*/) > -1);
  assert.ok(
    at(/Press \*\*Deploy\*\*/) < at(/Ignore that first deployment/) &&
      at(/Ignore that first deployment/) <
        at(/Settings, Environments, Production, Branch Tracking/) &&
      at(/Branch Tracking/) < at(/Run workflow\*\* again/),
    "import and Deploy, ignore the first deployment, change the branch, run Snapshot again",
  );
  assert.match(steps, /takes `main` as its production branch/);
  assert.match(steps, /Create Deployment/);
  assert.match(
    steps,
    /up to about an hour later \(longer if GitHub starts it late\)/,
  );
  assert.match(text, /written from Vercel's documentation/);
});

test("the Namecheap guide makes the custom-domain file on github.com and tells the dedicated account its folder", (t) => {
  const text = guide("HOSTING-NAMECHEAP.md");
  if (!text) return t.skip("the guide is not here");
  assert.match(
    text,
    /On github\.com open your repository, press \*\*Add file\*\*, \*\*Create new file\*\*, type `public\/CNAME` as the name \(exactly these letters, capitals included, no `\.txt`\)/,
  );
  assert.match(
    text,
    /Do not make this file in Notepad or File Explorer on Windows/,
  );
  assert.match(text, /`CNAME\.txt`/);
  assert.doesNotMatch(text, /commit and push it with GitHub Desktop/);

  assert.match(text, /set it to `\.\/`; this is required for that route/);
  assert.match(text, /public_html\/radar\/public_html\//);
  assert.match(text, /and set `FTP_SERVER_DIR` to `\.\/`/);
  assert.match(
    text,
    /server directory in the log must be the folder where `index\.html` should appear/,
  );
  // The default in the workflow is the one the guide says suits the main account.
  assert.match(
    read(".github/workflows/deploy-ftp.yml"),
    /FTP_SERVER_DIR \|\| 'public_html\/'/,
  );
});

test("the FTPS guide and the workflow header describe the same two-line schedule edit", (t) => {
  const text = guide("HOSTING-NAMECHEAP.md");
  if (!text) return t.skip("the guide is not here");
  assert.doesNotMatch(text, /three `schedule` lines/);
  assert.match(
    text,
    /the two lines `  #schedule:` and `  #  - cron: "47 \*\/3 \* \* \*"`/,
  );
  // Shown indented under its list item (three spaces), two and four more.
  assert.match(
    text,
    / {3}```text\n {5}schedule:\n {7}- cron: "47 \*\/3 \* \* \*"\n {3}```/,
  );
  assert.match(text, /pencil icon/);
  const workflow = read(".github/workflows/deploy-ftp.yml");
  assert.match(workflow, /^ {2}#schedule:$/m);
  assert.match(workflow, /^ {2}# {2}- cron: "47 \*\/3 \* \* \*"$/m);
  const header = workflow.slice(0, workflow.indexOf("\nname:"));
  assert.match(header, /set it to \.\/ \(dot, slash\)/);
  assert.match(header, /public_html\/radar\/public_html\//);
  assert.match(header, /one level too deep/);
});

test("the FTPS guide names the workflow that saves state on this route, and says what it is that is unset", (t) => {
  const text = guide("HOSTING-NAMECHEAP.md");
  if (!text) return t.skip("the guide is not here");
  const workflow = read(".github/workflows/deploy-ftp.yml");
  const snapshot = read(".github/workflows/snapshot.yml");
  // Step 5 of the guide switches Snapshot off, so the commits to state/ that
  // step 7 warns about come from the FTPS workflow's own "Save state" step.
  assert.match(text, /Turn the Snapshot workflow off/);
  assert.match(workflow, /- name: Save state/);
  assert.match(workflow, /^name: Deploy to Namecheap by FTPS$/m);
  assert.match(
    snapshot,
    /- name: Save state/,
    "the other route saves state too",
  );
  const step7 = text.slice(text.indexOf("7. **Automatic refreshes.**"));
  assert.match(
    step7,
    /the "Deploy to Namecheap by FTPS" workflow saves its memory \(the `state` folder\) to the repository every few hours/,
  );
  assert.doesNotMatch(step7, /the Snapshot job saves its memory/);
  // "If you set neither" had no referent for a novice: both places now say which
  // variable, on which account, and what happens.
  const header = workflow.slice(0, workflow.indexOf("\nname:"));
  for (const [name, source] of [
    ["the guide", text],
    ["the workflow header", header],
  ]) {
    assert.doesNotMatch(source, /set\s+neither/, name);
  }
  assert.match(
    text,
    /If you leave `FTP_SERVER_DIR` unset on the dedicated account, the files land one level too deep \(for example `public_html\/radar\/public_html\/`\)/,
  );
  assert.match(
    header.replace(/\n#\s+/g, " "),
    /if you leave FTP_SERVER_DIR unset on the dedicated account, the files land one level too deep \(for example public_html\/radar\/public_html\/\)/,
  );
});

test("the Pages check comes before the collector in Snapshot, as the Vercel and Cloudflare guides say", () => {
  const lines = read(".github/workflows/snapshot.yml").split("\n");
  const at = (pattern) => lines.findIndex((line) => pattern.test(line));
  const pagesCheck = at(/uses: actions\/configure-pages@/);
  const collector = at(/run: node collector\/run\.mjs/);
  assert.ok(pagesCheck > -1 && collector > -1);
  assert.ok(
    pagesCheck < collector,
    "Pages is checked before anything is collected",
  );
  // It is not the first thing the job does (checkout, Node and install come
  // first), which is why the guides say "before it collects anything".
  assert.ok(pagesCheck > at(/uses: actions\/checkout@/));
  for (const name of ["HOSTING-VERCEL.md", "HOSTING-CLOUDFLARE-PAGES.md"]) {
    const text = guide(name);
    if (!text) continue;
    assert.doesNotMatch(text, /before it does anything else/, name);
    assert.match(
      text,
      /checks that Pages is on before it collects anything/,
      name,
    );
  }
});
