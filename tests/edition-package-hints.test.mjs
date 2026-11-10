// Hosting readiness of the Auto Snapshot edition: the early snapshot request in
// the built page, the .htaccess the build writes for Apache hosts, the test
// server (the "//" crash, the optional gzip) and the hosting documents.
import assert from "node:assert/strict";
import { request } from "node:http";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { gunzipSync } from "node:zlib";
import { build } from "vite";
import configFactory, {
  EDITION_HTACCESS,
  editionHtml,
  editionPreload,
} from "../vite.config.ts";
import { snapshotUrl } from "../src/edition.ts";
import { startStaticEditionServer } from "../scripts/static-edition-server.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const FLAGS = ["VITE_STATIC_EDITION", "VITE_BASE", "VITE_SITE_URL"];

async function withEnv(values, action) {
  const before = Object.fromEntries(
    FLAGS.map((name) => [name, process.env[name]]),
  );
  for (const name of FLAGS) delete process.env[name];
  Object.assign(process.env, values);
  try {
    return await action();
  } finally {
    for (const name of FLAGS)
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
  }
}

/* ── The early snapshot request ────────────────────────────────────────────── */

// The request is started by a tiny inline script, not a static tag: the page
// does not request the snapshot at start-up for ?view=learn or ?view=analytics,
// and a request nobody takes costs the whole download. It is the page's own
// request (the same cache mode), handed over once through
// window.__hookRadarSnapshot; a <link rel=preload> was a default-mode request
// that a host's max-age answered from its stored copy, so the old snapshot
// stayed on screen even after F5.
const PRELOAD_SCRIPT = /<script>try\{[^<]*\}catch\(e\)\{\}<\/script>/g;
const STATIC_PRELOAD = /<link\b[^>]*\brel="preload"[^>]*>/;

/** The code between the script tags of the hint. */
const scriptCode = (tag) => tag.match(/<script>([\s\S]*)<\/script>/)[1];

/** Runs the head script as a browser would for an address: the requests it
 * started and the window object it left them on. */
function earlyRequests(tag, search, answer = () => Promise.resolve({})) {
  const started = [];
  const window = {};
  runInNewContext(scriptCode(tag), {
    URLSearchParams,
    AbortController,
    location: { search },
    window,
    fetch: (url, init) => {
      started.push({ url, init });
      return answer();
    },
  });
  return { started, window };
}

test("the early request names the snapshot the page requests, with the page's own cache mode, for every base", () => {
  for (const base of ["./", "/repo/", "/", "/a/b/"]) {
    const { started, window } = earlyRequests(editionPreload(base), "");
    assert.equal(started.length, 1, base);
    assert.equal(started[0].url, snapshotUrl(base), base);
    // The page revalidates (src/App.tsx fetchSnapshot): so does the early request.
    assert.equal(started[0].init.cache, "no-cache", base);
    assert.ok(started[0].init.signal instanceof AbortSignal, base);
    const held = window.__hookRadarSnapshot;
    assert.equal(held.url, snapshotUrl(base), base);
    assert.equal(typeof held.promise.then, "function", base);
    assert.equal(typeof held.abort, "function", base);
  }
  assert.equal(snapshotUrl("./"), "./data/snapshot.json");
  assert.equal(snapshotUrl("/repo/"), "/repo/data/snapshot.json");
  assert.equal(snapshotUrl("/"), "/data/snapshot.json");
});

test("the early request can be cancelled, and one nobody takes does not log a rejection", async () => {
  const { started, window } = earlyRequests(editionPreload("./"), "");
  assert.equal(started[0].init.signal.aborted, false);
  window.__hookRadarSnapshot.abort();
  assert.equal(started[0].init.signal.aborted, true, "the page's stall guard");
  const unhandled = [];
  const log = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", log);
  try {
    // A network failure on a request the page never takes (it moved to another
    // view first) must not become an unhandled rejection.
    earlyRequests(editionPreload("./"), "", () =>
      Promise.reject(new TypeError("Failed to fetch")),
    );
    await new Promise((done) => setTimeout(done, 20));
  } finally {
    process.off("unhandledRejection", log);
  }
  assert.deepEqual(unhandled, []);
});

test("the early request stays out of the way when the page does not ask for the snapshot", () => {
  const tag = editionPreload("./");
  // Addresses on which src/App.tsx does not request the snapshot at start-up.
  for (const search of [
    "?view=learn",
    "?view=analytics",
    "?view=analytics&chain=base&window=h24",
    "?chain=base&view=learn",
    "?view=learn&view=chains",
    "?view=%61nalytics",
  ]) {
    const { started, window } = earlyRequests(tag, search);
    assert.deepEqual(started, [], search);
    assert.equal(window.__hookRadarSnapshot, undefined, search);
  }
  // Addresses on which it does, including a project opened from those views.
  for (const search of [
    "",
    "?",
    "?view=overview",
    "?view=chains",
    "?view=compare",
    "?view=watchlist",
    "?view=activity",
    "?view=map",
    "?project=frontier",
    "?view=analytics&project=frontier",
    "?view=learn&project=frontier",
    "?view=learning",
    "?view=analyticsx",
    "?q=view=learn",
    "?xview=analytics",
    "?view=nonsense&view=learn",
  ])
    assert.equal(earlyRequests(tag, search).started.length, 1, search);
  // Never an error on the page, whatever the browser gives it.
  assert.doesNotThrow(() => runInNewContext(scriptCode(tag), { location: {} }));
});

test("src/App.tsx still skips the start-up snapshot request on the addresses the early request skips", () => {
  const source = readFileSync(join(repo, "src", "App.tsx"), "utf8");
  const mount = source.match(
    /useEffect\(\(\) => \{\s*if \(([^{]*)\) \{\s*bulkStarted\.current = true;\s*void fetchSnapshot\(\);/,
  );
  const why =
    "The early request in vite.config.ts (editionPreload) skips ?view=learn and ?view=analytics because the mount effect in src/App.tsx does not request the snapshot there. If that changed, change the script's condition too (a request nobody takes costs the whole download), then update this test.";
  assert.ok(mount, `The mount effect that starts the snapshot moved. ${why}`);
  assert.match(mount[1], /initial\.view !== "learn"/, why);
  assert.match(mount[1], /initial\.view !== "analytics"/, why);
  assert.match(
    readFileSync(join(repo, "src", "navigation.ts"), "utf8"),
    /project: query\.get\("project"\)/,
    "The script reads the project and view parameters the way parseNavigation does.",
  );
});

test("editionHtml adds the early request once, first in the head, only when it is given a base", () => {
  const html = [
    "<head>",
    '    <meta charset="UTF-8" />',
    '    <link rel="icon" href="/favicon.png" />',
    '    <script async src="/early-discovery.js"></script>',
    '    <meta property="og:image" content="/social-card.png" />',
    "  </head>",
  ].join("\n");
  const plain = editionHtml(html, "https://u.github.io/repo/");
  assert.equal(
    plain.match(PRELOAD_SCRIPT),
    null,
    "without a base nothing is added: the earlier behaviour stays",
  );
  for (const base of ["./", "/repo/", "/"]) {
    const hinted = editionHtml(html, "https://u.github.io/repo/", base);
    assert.equal(hinted.match(PRELOAD_SCRIPT)?.length, 1, base);
    assert.doesNotMatch(hinted, STATIC_PRELOAD, "no static link tag any more");
    assert.ok(
      hinted.indexOf("charset") < hinted.indexOf("snapshot.json") &&
        hinted.indexOf("snapshot.json") < hinted.indexOf('rel="icon"'),
      "straight after the character set, in front of everything else",
    );
    assert.ok(hinted.includes(JSON.stringify(snapshotUrl(base))), base);
    // Everything else it does is unchanged.
    assert.equal(
      hinted.replace(editionPreload(base), ""),
      plain,
      "the preload is the only difference",
    );
  }
  // Without a character set it goes right after the opening head tag.
  const bare = ["<head>", "  <title>x</title>", "</head>"].join("\n");
  assert.ok(
    editionHtml(bare, null, "./").startsWith(`<head>\n${editionPreload("./")}`),
  );
  assert.equal(editionHtml("<p>no head</p>", null, "./"), "<p>no head</p>");
  // A one-line head keeps its character set first and stays well formed.
  const oneLine = editionHtml(
    '<head><meta charset="utf-8"><title>x</title></head>',
    null,
    "./",
  );
  assert.match(oneLine, /^<head><meta charset="utf-8">\n/);
  assert.equal(oneLine.match(PRELOAD_SCRIPT)?.length, 1);
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "edition-hints-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "public", "data"), { recursive: true });
  await writeFile(
    join(root, "index.html"),
    [
      "<!doctype html>",
      '<html lang="en">',
      "  <head>",
      '    <meta charset="UTF-8" />',
      "    <title>Fixture</title>",
      '    <script async src="/early-discovery.js"></script>',
      "  </head>",
      '  <body><div id="root"></div><script type="module" src="/src/main.ts"></script></body>',
      "</html>",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "src", "main.ts"),
    'import "./style.css";\nexport const data = "/data/snapshot.json";\n',
  );
  await writeFile(join(root, "src", "style.css"), "body { margin: 0; }\n");
  await writeFile(join(root, "public", "data", "snapshot.json"), "{}");
  await writeFile(
    join(root, "public", "early-discovery.js"),
    "/* live only */",
  );
  return root;
}

async function buildFixture(root, values, out = join(root, "dist")) {
  await withEnv(values, () =>
    build({
      root,
      configFile: join(repo, "vite.config.ts"),
      logLevel: "silent",
      build: { outDir: out, emptyOutDir: true },
    }),
  );
  return { out, html: readFileSync(join(out, "index.html"), "utf8") };
}

test("a built edition page carries one early snapshot request that matches the page's own", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const cases = [
    [{ VITE_STATIC_EDITION: "1" }, "./"],
    [{ VITE_STATIC_EDITION: "1", VITE_BASE: "/hook-radar/" }, "/hook-radar/"],
    [{ VITE_STATIC_EDITION: "1", VITE_BASE: "/" }, "/"],
  ];
  for (const [values, base] of cases) {
    const { html } = await buildFixture(root, values);
    const tags = html.match(PRELOAD_SCRIPT) ?? [];
    assert.equal(tags.length, 1, `${base}: ${tags.join(" ")}`);
    assert.doesNotMatch(html, STATIC_PRELOAD, base);
    assert.deepEqual(
      earlyRequests(tags[0], "").started.map((row) => [
        row.url,
        row.init.cache,
      ]),
      [[snapshotUrl(base), "no-cache"]],
      base,
    );
    assert.deepEqual(
      earlyRequests(tags[0], "?view=analytics").started,
      [],
      base,
    );
    assert.deepEqual(earlyRequests(tags[0], "?view=learn").started, [], base);
    // First in the head, after the character set: a classic script waits for
    // the stylesheets in front of it, so later the request starts late.
    const at = html.indexOf(tags[0]);
    assert.ok(html.indexOf("<head>") < at && at < html.indexOf("</head>"));
    assert.ok(html.indexOf("charset") < at, "after the character set");
    assert.ok(
      html.indexOf("<title>") > at &&
        html.indexOf('rel="stylesheet"') > at &&
        html.indexOf('type="module"') > at,
      "in front of the title, the stylesheet and the page's script",
    );
  }
});

test("the live build gets no early request and no .htaccess", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const live = await buildFixture(root, {});
  assert.equal(live.html.match(PRELOAD_SCRIPT), null);
  assert.equal(live.html.match(STATIC_PRELOAD), null);
  assert.doesNotMatch(live.html, /snapshot\.json/);
  assert.equal(existsSync(join(live.out, ".htaccess")), false);
  assert.match(live.html, /src="\/early-discovery\.js"/);
  const names = (
    await withEnv({}, () =>
      configFactory({ mode: "production", command: "build" }),
    )
  ).plugins
    .flat()
    .map((plugin) => plugin.name);
  assert.ok(
    !names.some((name) => name.startsWith("hook-radar-static-edition")),
  );
});

test("src/App.tsx takes the early snapshot request once, and its own request has the same address and cache mode", () => {
  const source = readFileSync(join(repo, "src", "App.tsx"), "utf8");
  const calls = [
    ...source.matchAll(/fetch\(\s*snapshotUrl\(\)\s*(?:,\s*(\{[^}]*\}))?/g),
  ];
  const why =
    "The early request in vite.config.ts (editionPreload) is the page's first snapshot request: it must have the address and the cache mode of the page's own (`no-cache`: the host revalidates), or a host's max-age keeps an old snapshot on screen. Check in Chrome that snapshot.json is still requested once, then update this test.";
  assert.match(
    source,
    /takeEarlySnapshot\(snapshotUrl\(\), controller\.signal\)/,
    `The first request no longer takes the early one. ${why}`,
  );
  assert.ok(calls.length >= 1, `No fetch(snapshotUrl(), ...) found. ${why}`);
  for (const [, options = ""] of calls) {
    assert.doesNotMatch(options, /\bcredentials\b|\bmode\s*:/, why);
    assert.match(options, /cache: "no-cache"/, why);
  }
  assert.match(
    readFileSync(join(repo, "vite.config.ts"), "utf8"),
    /cache:"no-cache"/,
    why,
  );
  assert.doesNotMatch(
    source,
    /snapshotUrl\([^)]*\)\s*\+|snapshotUrl\([^)]*\)\}\?/,
    `A query string or suffix on the snapshot URL breaks the match. ${why}`,
  );
});

/* ── The .htaccess ─────────────────────────────────────────────────────────── */

test("the .htaccess asks Apache to compress the text types and revalidate the data", () => {
  assert.ok(EDITION_HTACCESS.endsWith("\n"));
  assert.ok(
    !EDITION_HTACCESS.includes("\r"),
    "Apache wants plain line endings",
  );
  const filter = EDITION_HTACCESS.match(
    /^\s*AddOutputFilterByType DEFLATE (.+)$/m,
  );
  assert.ok(filter, "a DEFLATE filter");
  const types = filter[1].split(/\s+/);
  for (const type of [
    "application/json",
    "text/css",
    "application/javascript",
    "image/svg+xml",
  ])
    assert.ok(types.includes(type), type);
  assert.match(
    EDITION_HTACCESS,
    /<IfModule mod_deflate\.c>[\s\S]*AddOutputFilterByType[\s\S]*<\/IfModule>/,
    "a host without the module ignores it instead of failing",
  );
  assert.match(
    EDITION_HTACCESS,
    /<IfModule mod_headers\.c>\s*<FilesMatch "\\\.json\$">\s*Header set Cache-Control "no-cache"\s*<\/FilesMatch>\s*<\/IfModule>/,
  );
  // Every directive sits inside an IfModule block.
  const outside = EDITION_HTACCESS.replace(/<IfModule[\s\S]*?<\/IfModule>/g, "")
    .split("\n")
    .filter((line) => line.trim() && !line.trim().startsWith("#"));
  assert.deepEqual(outside, []);
});

test("the edition build writes the .htaccess, and a file the owner keeps in public/ wins", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const written = await buildFixture(root, { VITE_STATIC_EDITION: "1" });
  assert.equal(
    readFileSync(join(written.out, ".htaccess"), "utf8"),
    EDITION_HTACCESS,
  );
  await writeFile(join(root, "public", ".htaccess"), "# the owner's rules\n");
  const own = await buildFixture(root, { VITE_STATIC_EDITION: "1" });
  assert.equal(
    readFileSync(join(own.out, ".htaccess"), "utf8"),
    "# the owner's rules\n",
  );
});

test("public/ holds no dotfile, so the live build and its release package never see one", (t) => {
  // This guards the live repository's release packager. The edition folder has
  // no packager, and its owner is told to put rules in public/.htaccess.
  if (!existsSync(join(repo, "scripts", "release-package.mjs")))
    return t.skip("only the live repository packages a release");
  const dotfiles = [];
  const visit = (directory, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) dotfiles.push(`${prefix}${entry.name}`);
      if (entry.isDirectory())
        visit(join(directory, entry.name), `${prefix}${entry.name}/`);
    }
  };
  visit(join(repo, "public"));
  assert.deepEqual(dotfiles, []);
});

/* ── The documents ─────────────────────────────────────────────────────────── */

/** A document in the repository (docs/edition/) or in the assembled folder. */
function document(name) {
  const candidates =
    name === "README-START-HERE.md"
      ? [join(repo, "docs", "edition", name), join(repo, "README.md")]
      : [join(repo, "docs", "edition", name), join(repo, "docs", name)];
  const found = candidates.find((path) => existsSync(path));
  return found ? readFileSync(found, "utf8").replace(/\r\n/g, "\n") : null;
}

test("the Namecheap guide shows exactly the .htaccess the build writes", (t) => {
  const text = document("HOSTING-NAMECHEAP.md");
  if (text === null) return t.skip("the document is not here");
  const block = text.match(/```apache\n([\s\S]*?)\n```/)?.[1];
  assert.ok(block, "an apache code block");
  assert.equal(`${block}\n`, EDITION_HTACCESS);
  assert.match(text, /replaced|replaces/);
});

test("every hosting guide has the compression check, and the start guide the two warnings", (t) => {
  const names = [
    "HOSTING-GITHUB-PAGES.md",
    "HOSTING-CLOUDFLARE-PAGES.md",
    "HOSTING-VERCEL.md",
    "HOSTING-NAMECHEAP.md",
  ];
  if (names.some((name) => document(name) === null))
    return t.skip("the documents are not here");
  for (const name of names) {
    const text = document(name);
    assert.match(
      text,
      /curl -H "Accept-Encoding: gzip" -I \S+\/data\/snapshot\.json/,
      name,
    );
    assert.match(text, /Content-Encoding: gzip/, name);
  }
  const start = document("README-START-HERE.md");
  assert.match(start, /from a web address/i);
  assert.match(start, /blank page/i);
  assert.match(start, /SITE_URL/);
  assert.match(start, /VITE_SITE_URL/);
});

/* ── The test server ───────────────────────────────────────────────────────── */

const BIG_JSON = JSON.stringify({
  rows: Array.from({ length: 400 }, (_v, index) => ({ index, name: "hook" })),
});

async function serverFixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "edition-server-"));
  const dist = join(root, "dist");
  const data = join(root, "data");
  await mkdir(dist, { recursive: true });
  await mkdir(data, { recursive: true });
  await writeFile(
    join(dist, "index.html"),
    `<!doctype html><title>x</title>${" ".repeat(2000)}`,
  );
  await writeFile(join(dist, "logo.png"), Buffer.alloc(3000, 7));
  await writeFile(join(data, "snapshot.json"), BIG_JSON);
  const server = await startStaticEditionServer({
    distDir: dist,
    dataDir: data,
    ...options,
  });
  t.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  return server;
}

/** A request with the path exactly as written, which fetch() would tidy up. */
function raw(server, path, { method = "GET", headers = {} } = {}) {
  const { hostname, port } = new URL(server.origin);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: hostname, port, path, method, headers },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("the test server answers 400 to a request path of // and stays up", async (t) => {
  const server = await serverFixture(t);
  for (const path of ["//", "//data/snapshot.json", "//x/y", "/%E0%A4%A"]) {
    const reply = await raw(server, path);
    assert.equal(reply.status, 400, path);
    // It is still serving afterwards.
    assert.equal((await raw(server, "/")).status, 200, `after ${path}`);
  }
  assert.equal((await raw(server, "/data/snapshot.json")).status, 200);
  assert.equal((await raw(server, "/api/anything")).status, 404);
  const refused = server.requests.filter((row) => row.status === 400);
  assert.equal(refused.length, 4, "each refusal is in the request log");
  assert.deepEqual(
    refused.map((row) => row.path),
    ["//", "//data/snapshot.json", "//x/y", "/%E0%A4%A"],
  );
});

test("without the gzip option nothing is compressed, whatever the client accepts", async (t) => {
  const server = await serverFixture(t);
  const reply = await raw(server, "/data/snapshot.json", {
    headers: { "Accept-Encoding": "gzip, br" },
  });
  assert.equal(reply.status, 200);
  assert.equal(reply.headers["content-encoding"], undefined);
  assert.equal(reply.headers.vary, undefined);
  assert.equal(reply.body.toString(), BIG_JSON);
  assert.match(reply.headers.etag, /^"[0-9a-f]{40}"$/);
});

test("with the gzip option text is compressed for clients that accept it, with its own ETag", async (t) => {
  const server = await serverFixture(t, { gzip: true });
  const identity = await raw(server, "/data/snapshot.json");
  assert.equal(identity.headers["content-encoding"], undefined);
  assert.equal(identity.headers.vary, "Accept-Encoding");
  assert.equal(identity.body.toString(), BIG_JSON);

  const zipped = await raw(server, "/data/snapshot.json", {
    headers: { "Accept-Encoding": "gzip, deflate, br" },
  });
  assert.equal(zipped.status, 200);
  assert.equal(zipped.headers["content-encoding"], "gzip");
  assert.equal(zipped.headers.vary, "Accept-Encoding");
  assert.ok(zipped.body.length < identity.body.length / 3, "much smaller");
  assert.equal(Number(zipped.headers["content-length"]), zipped.body.length);
  assert.equal(gunzipSync(zipped.body).toString(), BIG_JSON);
  assert.notEqual(zipped.headers.etag, identity.headers.etag);
  assert.match(zipped.headers.etag, /-gzip"$/);

  // Each representation is revalidated with its own ETag.
  const again = await raw(server, "/data/snapshot.json", {
    headers: {
      "Accept-Encoding": "gzip",
      "If-None-Match": zipped.headers.etag,
    },
  });
  assert.equal(again.status, 304);
  const mixed = await raw(server, "/data/snapshot.json", {
    headers: {
      "Accept-Encoding": "gzip",
      "If-None-Match": identity.headers.etag,
    },
  });
  assert.equal(
    mixed.status,
    200,
    "the plain ETag does not vouch for the compressed body",
  );

  // The page and the stylesheet follow, images and fonts do not.
  const page = await raw(server, "/", {
    headers: { "Accept-Encoding": "gzip" },
  });
  assert.equal(page.headers["content-encoding"], "gzip");
  const image = await raw(server, "/logo.png", {
    headers: { "Accept-Encoding": "gzip" },
  });
  assert.equal(image.headers["content-encoding"], undefined);
  assert.equal(image.headers.vary, undefined);
  assert.equal(image.body.length, 3000);

  // A client that refuses gzip gets the plain body.
  for (const header of ["identity", "gzip;q=0", "br"]) {
    const plain = await raw(server, "/data/snapshot.json", {
      headers: { "Accept-Encoding": header },
    });
    assert.equal(plain.headers["content-encoding"], undefined, header);
    assert.equal(plain.body.toString(), BIG_JSON, header);
  }
  const any = await raw(server, "/data/snapshot.json", {
    headers: { "Accept-Encoding": "*" },
  });
  assert.equal(any.headers["content-encoding"], "gzip");
});

test("replaced data is served in its own compressed form", async (t) => {
  const server = await serverFixture(t, { gzip: true });
  const first = await raw(server, "/data/snapshot.json", {
    headers: { "Accept-Encoding": "gzip" },
  });
  const next = JSON.stringify({
    rows: Array.from({ length: 300 }, () => "other"),
  });
  server.setData("snapshot.json", next);
  const second = await raw(server, "/data/snapshot.json", {
    headers: { "Accept-Encoding": "gzip" },
  });
  assert.equal(gunzipSync(second.body).toString(), next);
  assert.notEqual(second.headers.etag, first.headers.etag);
});
