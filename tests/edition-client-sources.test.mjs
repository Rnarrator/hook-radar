import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { providerSources } from "../collector/assemble.mjs";

// Read as text with LF line ends: a Windows checkout (autocrlf) holds CRLF, and
// several patterns below match across a line break.
const source = (path) =>
  readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );

test("the edition's own modules name no absolute data or service path", () => {
  for (const file of [
    "edition.ts",
    "edition-data.ts",
    "components/EditionStatus.tsx",
  ]) {
    const text = source(file);
    assert.doesNotMatch(text, /["'`]\/api\b/, `${file} mentions an /api path`);
    assert.doesNotMatch(
      text,
      /["'`]\/data\//,
      `${file} writes an absolute /data path instead of using the build base`,
    );
  }
});

// Every request the page can still make to the live service sits behind the
// flag; this lists them so a new one cannot slip in unguarded and unnoticed.
test("each remaining /api request in the interface is one the edition switches off", () => {
  const guarded = {
    "App.tsx": [
      "/api/directory",
      "/api/projects/",
      "/api/refresh",
      "/api/snapshot",
      "/api/startup-snapshot",
      "/api/directory/export.csv",
      "/api/snapshot/export.json",
    ],
    "useAnalyticsOverview.ts": ["/api/analytics/overview"],
    "useCollectionProgress.ts": ["/api/health"],
    "useDiscoveryBootstrap.ts": ["/api/discovery"],
    "useFrontierExtensionCount.ts": ["/api/projects/frontier/extensions"],
    "useLaunchpadHookIndex.ts": ["/api/discovery"],
    "useProjectView.ts": ["/api/ready", "/api/projects/"],
    "useWatchChanges.ts": ["/api/directory"],
    "components/ActivityExplorer.tsx": ["/api/projects/", "/api/directory"],
    "components/ArchivedHistory.tsx": ["/api/projects/"],
    "components/HookComparison.tsx": ["/api/directory", "/api/projects/"],
    "components/HookExtensions.tsx": ["/api/projects/frontier/extensions"],
    "components/ProjectDetail.tsx": ["/api/projects/"],
  };
  const found = {};
  for (const file of Object.keys(guarded)) {
    const text = source(file);
    found[file] = [...new Set([...text.matchAll(/["'`](\/api\/[a-z/.-]*)/g)].map((m) => m[1]))];
    for (const path of found[file])
      assert.ok(
        guarded[file].some((known) => path.startsWith(known)),
        `${file}: ${path} is not one of the known, guarded requests`,
      );
  }
  // No other file reaches the service.
  const others = [
    "components/Monitor.tsx",
    "components/ChainExplorer.tsx",
    "components/AnalyticsOverview.tsx",
    "components/AnalyticsWorkspace.tsx",
    "components/LaunchpadPaths.tsx",
    "components/PlatformDetail.tsx",
    "components/CommandPalette.tsx",
    "components/SiteFooter.tsx",
  ];
  for (const file of others)
    assert.doesNotMatch(source(file), /["'`]\/api\//, `${file} has an /api path`);
});

test("the pieces that call the service check the flag before they call", () => {
  const guard = [
    ["useAnalyticsOverview.ts", /STATIC_EDITION\s*\?\s*overviewUrl/],
    ["useWatchChanges.ts", /STATIC_EDITION\s*\?\s*\[\]/],
    ["components/ProjectDetail.tsx", /STATIC_EDITION \|\|\s*checkingHistory/],
    ["components/HookComparison.tsx", /checkingHistory \|\| STATIC_EDITION/],
    ["components/ProjectDetail.tsx", /!STATIC_EDITION && familyArtwork/],
    ["components/ProjectDetail.tsx", /!STATIC_EDITION && \(\s*<ArchivedHistory/],
    ["App.tsx", /!STATIC_EDITION && !snapshot && !serviceStarting/],
    ["App.tsx", /STATIC_EDITION \|\| \(shellLayout/],
    ["App.tsx", /STATIC_EDITION\s*\?\s*await fetch\(snapshotUrl\(\)/],
    ["useLaunchpadHookIndex.ts", /STATIC_EDITION\s*\?\s*useSnapshotHookIndex/],
  ];
  for (const [file, pattern] of guard)
    assert.match(source(file), pattern, `${file} lost its edition guard`);
});

// The credit sits on every page, so it must say what each provider did: the
// collector writes one source per provider actually used, and the census is
// Hook Radar's own index, not the indexer's.
test("the footer credit names each provider for what the collector says it did", () => {
  const at = Date.parse("2026-10-28T13:50:00.000Z");
  const lane = () => ({
    requests: 3,
    succeeded: 3,
    firstRequestAt: at,
    lastRequestAt: at + 60_000,
    stopped: null,
  });
  const sources = providerSources({
    stats: { dexscreener: lane(), geckoterminal: lane(), v4xyz: lane() },
    measured: new Map([
      ["a", { metricProvider: "dexscreener", metricUpdatedAt: "2026-10-28T14:00:00.000Z" }],
      ["b", { metricProvider: "geckoterminal", metricUpdatedAt: "2026-10-28T14:01:00.000Z" }],
    ]),
    discovery: { geckoPages: 2, indexerLists: 3, indexerListed: 10, resolvesTried: 4 },
    census: {
      exportedAt: "2026-10-28T10:00:00.000Z",
      inventory: { generatedAt: "2026-10-27T20:11:09.000Z" },
    },
    registrySources: [
      { id: "registry", name: "Uniswap hooklist", url: "https://github.com/Uniswap/hooklist" },
    ],
  });
  const byId = Object.fromEntries(sources.map((row) => [row.id, row]));

  const text = source("components/EditionStatus.tsx");
  const credit = text
    .slice(text.indexOf("export function SourceCredit"))
    .replace(/<[^>]+>/g, " ")
    .replace(/\{" "\}/g, " ")
    .replace(/&rsquo;/g, "\u2019")
    .replace(/\s+/g, " ")
    .replace(/ ([.,])/g, "$1");

  // Each source id the collector writes, and the words the credit uses for it.
  const credited = {
    dexscreener:
      "Prices from DEX Screener, with GeckoTerminal for pool discovery and as a fallback.",
    geckoterminal:
      "Prices from DEX Screener, with GeckoTerminal for pool discovery and as a fallback.",
    registry: "Hooks from the Uniswap hooklist.",
    v4xyz: "Hook and pool identities from the v4.xyz indexer.",
    census: "The pool census is Hook Radar\u2019s own index of PoolManager events.",
  };
  for (const id of Object.keys(byId))
    assert.ok(credited[id], `the credit does not cover the "${id}" source`);
  for (const [id, words] of Object.entries(credited)) {
    assert.ok(byId[id], `the collector no longer writes a "${id}" source`);
    assert.ok(credit.includes(words), `the credit lacks "${words}"`);
  }

  // What the collector itself says each of those two does.
  assert.match(byId.v4xyz.note, /^Pool identity only/);
  assert.match(byId.v4xyz.note, /supplies no amounts/);
  assert.match(byId.census.note, /^Hook Radar's index of PoolManager events/);
  assert.match(byId.census.note, /does not refresh it/);

  // The indexer is never credited with the census or with market data.
  assert.doesNotMatch(credit, /census from/i);
  assert.doesNotMatch(credit, /Envio v4 indexer[^.]*census/i);
  assert.doesNotMatch(credit, /market data[^.]*Envio/i);
});

// A figure from the census is dated where it is shown, never left to read as
// measured at the snapshot's time. Each page that prints one passes the date on.
test("each page that prints a census count dates it", () => {
  const dated = [
    ["components/ChainExplorer.tsx", /censusLabel\(snapshot\.inventory\)/, /<CensusNote label=\{census\}/],
    ["components/ChainCharts.tsx", /census = null/, /<CensusNote label=\{census\}/],
    ["components/ChainNetworkDirectory.tsx", /census = null/, /<CensusNote label=\{census\}/],
    ["components/AnalyticsOverview.tsx", /censusLabel\(envelope\.inventory\)/, /<CensusNote label=\{census\}/],
    ["components/AnalyticsWorkspace.tsx", /censusLabel\(snapshot\.inventory\)/, /<CensusNote label=\{census\}/],
  ];
  for (const [file, derived, shown] of dated) {
    const text = source(file);
    assert.match(text, derived, `${file} does not take the census date`);
    assert.match(text, shown, `${file} does not print the census date`);
  }
  // Both analytics pages hand the date to the evidence statement, which in the
  // edition does not say a network "caught up" (nothing is being scanned).
  assert.match(source("components/AnalyticsOverview.tsx"), /\n\s+census,\n/);
  assert.match(source("components/AnalyticsWorkspace.tsx"), /\n\s+census,\n/);
  assert.match(
    source("components/AnalyticsCharts.tsx"),
    /STATIC_EDITION \? "scanned to their recorded target" : "caught up"/,
  );
});

// The five-minute rule is applied at the snapshot's time, so no sentence of the
// edition may read it against the present. Each such phrase must have an
// edition wording beside it; the live wording stays as it is for the live site.
test("copy that reads the five-minute rule against the present has an edition wording", () => {
  const phrases = [
    /last (?:5|five) minutes/gi,
    /right now/gi,
    /figures are current(?! as of the snapshot)/gi,
    /Waiting for current market data/gi,
    /(?:under|less than|younger than) (?:5|five) minutes/gi,
    /awaiting refresh/gi,
  ];
  // The Activity page is switched off in the edition; the other two are
  // comments, not copy.
  const notShown = new Set([
    "components/ActivityExplorer.tsx",
    "components/CommandPalette.tsx",
    "refresh-policy.ts",
  ]);
  const root = fileURLToPath(new URL("../src/", import.meta.url));
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(join(dir, entry.name))
        : /\.tsx?$/.test(entry.name)
          ? [join(dir, entry.name)]
          : [],
    );
  const unguarded = [];
  for (const file of walk(root)) {
    const name = relative(root, file).replaceAll("\\", "/");
    if (notShown.has(name)) continue;
    const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    for (const phrase of phrases)
      for (const match of text.matchAll(phrase)) {
        const near = text.slice(Math.max(0, match.index - 400), match.index + 400);
        if (!near.includes("STATIC_EDITION"))
          unguarded.push(
            `${name}:${text.slice(0, match.index).split("\n").length} "${match[0]}"`,
          );
      }
  }
  assert.deepEqual(unguarded, [], "live wording with no edition wording beside it");
});
