// vite.config.ts in the Auto Snapshot edition: the helpers, the guarantee that
// the live build is untouched when VITE_STATIC_EDITION is unset, and a real
// Vite build of a small fixture site with the flag set and unset.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import configFactory, {
  EDITION_LEFT_OUT,
  editionAssetPaths,
  editionBase,
  editionHtml,
  editionLeftOutFiles,
  editionManifest,
  editionPage,
  editionSiteUrl,
} from "../vite.config.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));
const FLAGS = [
  "VITE_STATIC_EDITION",
  "VITE_BASE",
  "VITE_SITE_URL",
  "RADAR_PUBLIC_ORIGIN",
];

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

const pluginNames = async (values) =>
  withEnv(values, async () => {
    const config = await configFactory({
      mode: "production",
      command: "build",
    });
    return {
      config,
      names: config.plugins.flat().map((plugin) => plugin.name),
    };
  });

test("editionBase is relative unless a plain path is asked for", () => {
  assert.equal(editionBase(undefined), "./");
  assert.equal(editionBase(""), "./");
  assert.equal(editionBase("./"), "./");
  assert.equal(editionBase("/"), "/");
  assert.equal(editionBase("/hook-radar/"), "/hook-radar/");
  assert.equal(editionBase("hook-radar"), "/hook-radar/");
  assert.equal(editionBase("/my.repo_name/"), "/my.repo_name/");
  for (const bad of [
    "/a b/",
    "/../x/",
    "/a/../b/",
    "https://x.test/",
    "/a//b/",
    "/x?y/",
    "/<x>/",
  ])
    assert.throws(() => editionBase(bad), /VITE_BASE/, bad);
});

test("editionSiteUrl accepts only a plain https address", () => {
  assert.equal(editionSiteUrl(undefined), null);
  assert.equal(editionSiteUrl(""), null);
  assert.equal(
    editionSiteUrl("https://u.github.io/repo"),
    "https://u.github.io/repo/",
  );
  assert.equal(editionSiteUrl("https://example.com/"), "https://example.com/");
  for (const bad of [
    "http://example.com/",
    "https://u:p@example.com/",
    "https://example.com/?a=1",
    "https://example.com/#x",
    "nonsense",
  ])
    assert.throws(() => editionSiteUrl(bad), /VITE_SITE_URL/, bad);
});

test("editionHtml removes the early request and fixes or drops share images", () => {
  const html = [
    "<head>",
    '    <link rel="icon" href="/favicon.png" />',
    '    <script async src="/early-discovery.js"></script>',
    '    <meta property="og:image" content="/social-card.png" />',
    '    <meta property="og:image:width" content="1200" />',
    '    <meta name="twitter:image" content="/social-card.png" />',
    '    <meta name="twitter:image:alt" content="Alt" />',
    '    <meta property="og:title" content="Title" />',
    "</head>",
  ].join("\n");
  const withUrl = editionHtml(html, "https://u.github.io/repo/");
  assert.doesNotMatch(withUrl, /early-discovery/);
  assert.match(
    withUrl,
    /<meta property="og:image" content="https:\/\/u\.github\.io\/repo\/social-card\.png" \/>/,
  );
  assert.match(
    withUrl,
    /<meta name="twitter:image" content="https:\/\/u\.github\.io\/repo\/social-card\.png" \/>/,
  );
  assert.match(withUrl, /og:title/);
  const without = editionHtml(html, null);
  assert.doesNotMatch(
    without,
    /early-discovery|og:image|twitter:image|social-card/,
  );
  assert.match(without, /og:title/);
  assert.match(without, /rel="icon"/);
  const absolute = html.replaceAll(
    'content="/social-card.png"',
    'content="https://site.example/social-card.png"',
  );
  assert.match(
    editionHtml(absolute, null),
    /og:image:width/,
    "an absolute image the owner configured is kept whole",
  );
  assert.equal(editionHtml("<head></head>", null), "<head></head>");
});

test("editionPage says what the edition shows and marks the root element, and changes nothing else", () => {
  const source = readFileSync(join(repo, "index.html"), "utf8");
  // The live notice, as it stands in the source (it wraps across two lines).
  assert.match(source, /to search hooks and display current market\s+data\./);
  assert.doesNotMatch(source, /data-edition/);
  const page = editionPage(source);
  assert.match(
    page,
    /<noscript\s*>Hook Radar needs JavaScript to search hooks and read the latest published snapshot\. Enable JavaScript, then reload this page\.<\/noscript\s*>/,
  );
  assert.doesNotMatch(page, /current market/);
  assert.match(
    page,
    /^<!doctype html>\s*<html lang="en" data-edition="snapshot">/,
  );
  // Nothing but those two things differs.
  assert.equal(
    page
      .replace(' data-edition="snapshot"', "")
      .replace(
        "read the latest published snapshot.",
        "display current market data.",
      ),
    source.replace(
      /display current market\s+data\./,
      "display current market data.",
    ),
  );
  // Applying it twice is the same as once; a document without either is left alone.
  assert.equal(editionPage(page), page);
  assert.equal(editionPage("<head></head>"), "<head></head>");
  // Only the notice's wording changes: the same words elsewhere are left alone.
  assert.equal(
    editionPage(
      '<html lang="en"><body><p>display current market data.</p></body></html>',
    ),
    '<html lang="en" data-edition="snapshot"><body><p>display current market data.</p></body></html>',
  );
  // A mark already there is not repeated.
  assert.equal(
    editionPage('<html lang="en" data-edition="snapshot">'),
    '<html lang="en" data-edition="snapshot">',
  );
});

test("editionAssetPaths makes root-absolute public file literals follow the base", () => {
  const names = {
    directories: ["protocols", "fonts", "data"],
    files: ["radar.svg"],
  };
  const code = [
    'const a = { src: "/protocols/zora.png" };',
    "const b = `/data/overview-${chain}-h24.json`;",
    "const c = '/fonts/x.woff2';",
    'const d = "/radar.svg";',
    'const keep = ["/api/snapshot", "/protocolsX/a", "https://x.test/protocols/a", "/radar.svg.map"];',
  ].join("\n");
  assert.equal(
    editionAssetPaths(code, "/hook-radar/", names),
    [
      'const a = { src: "/hook-radar/protocols/zora.png" };',
      "const b = `/hook-radar/data/overview-${chain}-h24.json`;",
      "const c = '/hook-radar/fonts/x.woff2';",
      'const d = "/hook-radar/radar.svg";',
      'const keep = ["/api/snapshot", "/protocolsX/a", "https://x.test/protocols/a", "/radar.svg.map"];',
    ].join("\n"),
  );
  assert.match(
    editionAssetPaths('"/protocols/a.png"', "./", names),
    /^"\.\/protocols\/a\.png"$/,
  );
  assert.equal(
    editionAssetPaths("nothing", "./", { directories: [], files: [] }),
    "nothing",
  );
});

test("editionAssetPaths keeps links back into the app inside the base", () => {
  const none = { directories: [], files: [] };
  const code = [
    'const a = "/?project=bonker";',
    "const b = `/?view=chains&chain_network=${slug}&chain_role=launchpads`;",
    "const c = '/?';",
    'const keep = ["a/?b", "//?x", "https://x.test/?a=1", "x/?"];',
  ].join("\n");
  assert.equal(
    editionAssetPaths(code, "/hook-radar/", none),
    [
      'const a = "/hook-radar/?project=bonker";',
      "const b = `/hook-radar/?view=chains&chain_network=${slug}&chain_role=launchpads`;",
      "const c = '/hook-radar/?';",
      'const keep = ["a/?b", "//?x", "https://x.test/?a=1", "x/?"];',
    ].join("\n"),
  );
  assert.equal(
    editionAssetPaths('"/?project=a"', "./", none),
    '"./?project=a"',
    "a relative build resolves against the page it is on",
  );
  assert.equal(
    editionAssetPaths('"/?project=a"', "/", none),
    '"/?project=a"',
    "at a domain root nothing changes",
  );
});

test("in the real source no literal points at the host's root once the edition rewrite has run", () => {
  const entries = readdirSync(join(repo, "public"), { withFileTypes: true });
  const names = {
    directories: [
      ...new Set([
        "data",
        ...entries.filter((e) => e.isDirectory()).map((e) => e.name),
      ]),
    ],
    files: entries.filter((e) => e.isFile()).map((e) => e.name),
  };
  const escape = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rootLiteral = new RegExp(
    `(["'\`])/(?:\\?|(?:${names.directories.map(escape).join("|")})/|(?:${names.files.map(escape).join("|")})\\1)`,
    "g",
  );
  const stray = [];
  let checked = 0;
  for (const file of readdirSync(join(repo, "src"), { recursive: true })) {
    if (!/\.(?:ts|tsx)$/.test(file)) continue;
    checked += 1;
    const code = editionAssetPaths(
      readFileSync(join(repo, "src", file), "utf8"),
      "/hook-radar/",
      names,
    );
    for (const match of code.matchAll(rootLiteral))
      stray.push(`${file}: ${match[0]}`);
  }
  assert.ok(checked > 50, "the source files were found");
  assert.deepEqual(stray, [], "these would leave the site at a sub-path");
});

test("editionManifest makes the web app manifest relative and keeps everything else", () => {
  const source = readFileSync(join(repo, "public", "site.webmanifest"), "utf8");
  const original = JSON.parse(source);
  const result = JSON.parse(editionManifest(source));
  assert.equal(result.start_url, "./");
  assert.equal(result.scope, "./");
  assert.equal(result.id, "./");
  assert.deepEqual(
    result.icons.map((icon) => icon.src),
    ["./icon-192.png", "./icon-512.png"],
  );
  assert.deepEqual(
    { ...result, id: 0, start_url: 0, scope: 0, icons: 0 },
    { ...original, id: 0, start_url: 0, scope: 0, icons: 0 },
  );
});

test("with the flag unset the configuration is the live application's", async () => {
  const live = await pluginNames({});
  assert.equal(live.config.base, undefined);
  assert.equal(live.config.build.target, "es2022");
  assert.deepEqual(live.config.server.proxy, {
    "/api": "http://127.0.0.1:4174",
  });
  assert.ok(live.names.includes("hook-radar-public-metadata"));
  assert.ok(
    !live.names.some((name) => name.startsWith("hook-radar-static-edition")),
  );
  const zero = await pluginNames({
    VITE_STATIC_EDITION: "0",
    VITE_BASE: "/x/",
  });
  assert.deepEqual(
    zero.names,
    live.names,
    "any value but 1 leaves the live build alone",
  );
  assert.equal(zero.config.base, undefined);
});

test("with the flag set the edition adds its plugins and the chosen base", async () => {
  const relative = await pluginNames({ VITE_STATIC_EDITION: "1" });
  assert.equal(relative.config.base, "./");
  const live = await pluginNames({});
  assert.deepEqual(
    relative.names.filter(
      (name) => !name.startsWith("hook-radar-static-edition"),
    ),
    live.names,
    "the live plugins are all still there, in order",
  );
  assert.equal(
    relative.names.filter((name) =>
      name.startsWith("hook-radar-static-edition"),
    ).length,
    3,
  );
  assert.equal(
    (await pluginNames({ VITE_STATIC_EDITION: "1", VITE_BASE: "/repo/" }))
      .config.base,
    "/repo/",
  );
  await assert.rejects(
    pluginNames({ VITE_STATIC_EDITION: "1", VITE_BASE: "/a b/" }),
    /VITE_BASE/,
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "edition-vite-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "public", "protocols"), { recursive: true });
  await mkdir(join(root, "public", "data"), { recursive: true });
  await writeFile(
    join(root, "index.html"),
    [
      "<!doctype html>",
      '<html lang="en">',
      "  <head>",
      '    <meta charset="UTF-8" />',
      "    <title>Fixture</title>",
      '    <link rel="icon" href="/favicon.png" type="image/png" />',
      '    <link rel="manifest" href="/site.webmanifest" />',
      '    <script async src="/early-discovery.js"></script>',
      "  </head>",
      "  <body>",
      "    <noscript",
      "      >Fixture needs JavaScript to search hooks and display current market",
      "      data. Enable JavaScript, then reload this page.</noscript",
      "    >",
      '    <div id="root"></div><script type="module" src="/src/main.ts"></script>',
      "  </body>",
      "</html>",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "src", "main.ts"),
    [
      "Object.assign(globalThis, {",
      "  fixture: {",
      '    logo: "/protocols/x.svg",',
      '    data: "/data/snapshot.json",',
      '    api: "/api/snapshot",',
      '    chains: "/?view=chains&chain_network=base&chain_role=launchpads",',
      "    project: `/?project=${globalThis.projectId}`,",
      "  },",
      "});",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "public", "protocols", "x.svg"),
    "<svg xmlns='http://www.w3.org/2000/svg'/>",
  );
  await writeFile(join(root, "public", "data", "snapshot.json"), "{}");
  // Files the edition's page never references (see EDITION_LEFT_OUT), beside
  // ones it does (a logo, the pixel face).
  await mkdir(join(root, "public", "fonts"), { recursive: true });
  for (const name of [
    "IBMPlexMono-Regular.ttf",
    "IBMPlexMono-Medium.ttf",
    "IBMPlexMono-OFL.txt",
    "PressStart2P-Regular.ttf",
  ])
    await writeFile(join(root, "public", "fonts", name), "font");
  await writeFile(join(root, "public", "protocols", "sources.json"), "{}");
  await writeFile(join(root, "public", "protocols", "README.md"), "# logos");
  await writeFile(join(root, "public", "favicon.png"), "png");
  await writeFile(
    join(root, "public", "early-discovery.js"),
    "/* live only */",
  );
  await writeFile(
    join(root, "public", "site.webmanifest"),
    readFileSync(join(repo, "public", "site.webmanifest")),
  );
  return root;
}

async function buildFixture(root, values) {
  const out = join(root, "dist");
  await withEnv(values, () =>
    build({
      root,
      configFile: join(repo, "vite.config.ts"),
      logLevel: "silent",
      build: { outDir: out, emptyOutDir: true },
    }),
  );
  const bundle = readdirSync(join(out, "assets")).find((name) =>
    name.endsWith(".js"),
  );
  return {
    out,
    html: readFileSync(join(out, "index.html"), "utf8"),
    js: readFileSync(join(out, "assets", bundle), "utf8"),
    manifest: readFileSync(join(out, "site.webmanifest"), "utf8"),
  };
}

test("a static edition build is relative, drops the live-only pieces and keeps the data", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const site = await buildFixture(root, { VITE_STATIC_EDITION: "1" });
  assert.doesNotMatch(site.html, /early-discovery/);
  assert.equal(existsSync(join(site.out, "early-discovery.js")), false);
  assert.match(site.html, /<html lang="en" data-edition="snapshot">/);
  assert.match(
    site.html,
    /to search hooks and read the latest published snapshot\. Enable JavaScript/,
  );
  assert.doesNotMatch(site.html, /display current market/);
  assert.match(site.html, /src="\.\/assets\/[^"]+\.js"/);
  assert.match(site.html, /href="\.\/favicon\.png"/);
  assert.match(site.html, /href="\.\/site\.webmanifest"/);
  assert.match(site.js, /"\.\/protocols\/x\.svg"/);
  assert.match(site.js, /"\.\/data\/snapshot\.json"/);
  assert.match(
    site.js,
    /"\.\/\?view=chains&chain_network=base&chain_role=launchpads"/,
  );
  assert.match(site.js, /`\.\/\?project=\$\{/);
  assert.match(
    site.js,
    /"\/api\/snapshot"/,
    "only public files are rewritten; /api/ is left for the client to switch off",
  );
  assert.doesNotMatch(
    site.html,
    /og:image/,
    "no share image without a site address",
  );
  assert.deepEqual(
    JSON.parse(site.manifest).icons.map((icon) => icon.src),
    ["./icon-192.png", "./icon-512.png"],
  );
  assert.equal(
    readFileSync(join(site.out, "data", "snapshot.json"), "utf8"),
    "{}",
  );
  assert.ok(existsSync(join(site.out, "protocols", "x.svg")));
});

test("a static edition build leaves out the files its page never references and keeps the rest", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const site = await buildFixture(root, { VITE_STATIC_EDITION: "1" });
  for (const file of [
    "fonts/IBMPlexMono-Regular.ttf",
    "fonts/IBMPlexMono-Medium.ttf",
    "fonts/IBMPlexMono-OFL.txt",
    "protocols/sources.json",
    "protocols/README.md",
  ])
    assert.equal(existsSync(join(site.out, file)), false, `${file} is shipped`);
  // What the page does use stays: the pixel face, a logo, the data.
  for (const file of [
    "fonts/PressStart2P-Regular.ttf",
    "protocols/x.svg",
    "data/snapshot.json",
    "favicon.png",
  ])
    assert.ok(existsSync(join(site.out, file)), `${file} was removed`);
  // The files are named once, and the rule finds exactly them in a built folder.
  assert.deepEqual(
    [...EDITION_LEFT_OUT],
    ["fonts/IBMPlexMono-", "protocols/sources.json", "protocols/README.md"],
  );
  const before = join(root, "dist-rule");
  await mkdir(join(before, "fonts"), { recursive: true });
  await writeFile(join(before, "fonts", "IBMPlexMono-Bold.ttf"), "f");
  await writeFile(join(before, "fonts", "Other.ttf"), "f");
  assert.deepEqual(editionLeftOutFiles(before), [
    "fonts/IBMPlexMono-Bold.ttf",
    "protocols/sources.json",
    "protocols/README.md",
  ]);
  // No fonts folder at all is no error.
  assert.deepEqual(editionLeftOutFiles(join(root, "nowhere")), [
    "protocols/sources.json",
    "protocols/README.md",
  ]);
});

test("a static edition build for a project page carries the repository path and a share image", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const site = await buildFixture(root, {
    VITE_STATIC_EDITION: "1",
    VITE_BASE: "/hook-radar/",
    VITE_SITE_URL: "https://someone.github.io/hook-radar/",
  });
  assert.match(site.html, /src="\/hook-radar\/assets\/[^"]+\.js"/);
  assert.match(site.html, /href="\/hook-radar\/favicon\.png"/);
  assert.match(site.js, /"\/hook-radar\/protocols\/x\.svg"/);
  assert.match(site.js, /"\/hook-radar\/data\/snapshot\.json"/);
  assert.match(
    site.js,
    /"\/hook-radar\/\?view=chains&chain_network=base&chain_role=launchpads"/,
  );
  assert.match(site.js, /`\/hook-radar\/\?project=\$\{/);
  assert.doesNotMatch(
    site.js,
    /["'`]\/\?/,
    "no link leaves the sub-path for the host's root",
  );
  assert.match(
    site.html,
    /og:image" content="https:\/\/someone\.github\.io\/hook-radar\/social-card\.png"/,
  );
  assert.doesNotMatch(site.html, /early-discovery/);
});

test("the same fixture built without the flag is the live build, byte for byte where it matters", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const site = await buildFixture(root, {});
  assert.match(site.html, /src="\/early-discovery\.js"/);
  assert.match(site.html, /<html lang="en">/);
  assert.doesNotMatch(site.html, /data-edition/, "the live root has no mark");
  assert.match(
    site.html,
    /to search hooks and display current market\s+data\./,
    "the live notice keeps its words",
  );
  assert.doesNotMatch(site.html, /latest published snapshot/);
  assert.match(site.html, /src="\/assets\/[^"]+\.js"/);
  assert.match(site.html, /og:image" content="\/social-card\.png"/);
  assert.ok(existsSync(join(site.out, "early-discovery.js")));
  // The live build ships every public file, including the ones the edition
  // leaves out.
  for (const file of [
    "fonts/IBMPlexMono-Regular.ttf",
    "fonts/IBMPlexMono-OFL.txt",
    "protocols/sources.json",
    "protocols/README.md",
  ])
    assert.ok(existsSync(join(site.out, file)), `${file} is missing live`);
  assert.match(site.js, /"\/protocols\/x\.svg"/);
  assert.match(
    site.js,
    /"\/\?view=chains&chain_network=base&chain_role=launchpads"/,
  );
  assert.match(site.js, /`\/\?project=\$\{/);
  assert.equal(
    site.manifest,
    readFileSync(join(repo, "public", "site.webmanifest"), "utf8"),
  );
});
