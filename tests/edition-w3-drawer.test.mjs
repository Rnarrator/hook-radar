// The project and platform drawers of the Auto Snapshot edition: the scope of
// the "About this data" note, the "Networks" figure, the accessible names of the
// controls that repeat on every row, the platform drawer's in-page links and the
// dated reviewed notes. The helpers take `edition` explicitly (the flag is unset
// in this process), so each is tested in both flavours.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  LAUNCHPAD_REVIEWED_AT,
  launchpadRegistry,
} from "../shared/launchpad-registry.ts";
import {
  navigateInPage,
  reviewedNotePrefix,
} from "../src/edition-platform-copy.ts";
import {
  addressTag,
  hookControlLabels,
  hookRowName,
  networksReadout,
  poolControlLabels,
  poolNetworks,
  projectCoverageNote,
  setupNetworks,
  showMoreLabel,
  tagDigits,
} from "../src/project-presentation.ts";

const source = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const names = {
  arbitrum: "Arbitrum",
  base: "Base",
  ethereum: "Ethereum",
  ink: "Ink",
  robinhood: "Robinhood Chain",
  unichain: "Unichain",
};
const chainName = (slug) => names[slug] ?? slug;

const pool = (chain, source = "DEX Screener") => ({ chain, source });
const many = (chain, n, source) =>
  Array.from({ length: n }, () => pool(chain, source));

/* ── R-1: the project's own coverage, not the snapshot's ─────────────────── */

const WHOLE = [
  ...many("base", 1500),
  ...many("ethereum", 700),
  ...many("ink", 10),
];

test("a project's coverage note counts its own pools, networks and sources, with the snapshot as context", () => {
  const own = [
    ...many("ethereum", 20, "DEX Screener"),
    ...many("ink", 4, "GeckoTerminal"),
    ...many("unichain", 1, "DEX Screener"),
  ];
  const note = projectCoverageNote({
    pools: own,
    snapshotPools: [...WHOLE, ...own],
    edition: true,
  });
  assert.equal(
    note,
    "This project’s totals use its 25 measured pools on 3 networks from DEX Screener, GeckoTerminal. The snapshot as a whole measured 2,235 pools on 4 networks. Dollar totals use available observations, not ecosystem totals. Unpriced pools remain browsable; missing values are unavailable, never zero.",
  );
});

test("the sources are the ones this project's own pools came from", () => {
  const note = projectCoverageNote({
    pools: many("base", 3, "DEX Screener"),
    snapshotPools: [...WHOLE, ...many("base", 3, "DEX Screener")],
    edition: true,
  });
  assert.match(note, / on 1 network from DEX Screener\./);
  assert.doesNotMatch(note, /GeckoTerminal/);
});

test("one pool on one network reads in the singular", () => {
  const note = projectCoverageNote({
    pools: [pool("base")],
    snapshotPools: [pool("base")],
    edition: true,
  });
  assert.match(
    note,
    /^This project’s totals use its 1 measured pool on 1 network from DEX Screener\./,
  );
  assert.match(note, /The snapshot as a whole measured 1 pool on 1 network\./);
});

test("a project with no measured pool says none were measured, and keeps the unknown-is-not-zero sentence", () => {
  const note = projectCoverageNote({
    pools: [],
    snapshotPools: WHOLE,
    edition: true,
  });
  assert.equal(
    note,
    "None of this project’s pools were measured in this snapshot, so it has no market totals. The snapshot as a whole measured 2,210 pools on 3 networks. Missing values are unavailable, never zero.",
  );
  assert.doesNotMatch(note, /This project’s totals use/);
});

test("the note never states the snapshot's totals as the project's own", () => {
  for (const pools of [[], many("base", 2)]) {
    const note = projectCoverageNote({
      pools,
      snapshotPools: WHOLE,
      edition: true,
    });
    // The first sentence is about the project; the snapshot comes second.
    assert.doesNotMatch(note.split(". ")[0], /2,210|measured 2,210/);
    assert.doesNotMatch(note, /^Observed market data covers/);
  }
});

test("a snapshot with no pool of its own names none", () => {
  const note = projectCoverageNote({
    pools: [],
    snapshotPools: [],
    edition: true,
  });
  assert.doesNotMatch(note, /snapshot as a whole/);
});

test("outside the edition the note is left to the live page", () => {
  assert.equal(
    projectCoverageNote({
      pools: many("base", 2),
      snapshotPools: WHOLE,
      edition: false,
    }),
    null,
  );
  // The flag is unset in this process.
  assert.equal(
    projectCoverageNote({ pools: many("base", 2), snapshotPools: WHOLE }),
    null,
  );
});

/* ── R-3: networks with hooks, and where pools were measured ─────────────── */

test("the edition's Networks figure says it counts networks with hooks and where pools were measured", () => {
  const figure = networksReadout({
    networks: ["arbitrum", "ethereum", "robinhood", "base"],
    measuredOn: ["ethereum"],
    chainName,
    edition: true,
  });
  assert.equal(figure.label, "Networks with hooks");
  assert.equal(figure.note, "Measured pools on Ethereum");
  assert.equal(
    figure.title,
    "Hooks listed on Arbitrum, Ethereum, Robinhood Chain, Base. Measured pools on Ethereum",
  );
  // The note never reads as the label of the count beside it.
  assert.doesNotMatch(figure.note, /pools measured/i);
});

test("the Networks note names two measured networks, then counts the rest", () => {
  const note = (measuredOn) =>
    networksReadout({
      networks: ["arbitrum", "base", "ethereum", "ink"],
      measuredOn,
      chainName,
      edition: true,
    }).note;
  assert.equal(
    note(["base", "robinhood"]),
    "Measured pools on Base · Robinhood Chain",
  );
  assert.equal(
    note(["base", "robinhood", "ink"]),
    "Measured pools on Base · Robinhood Chain +1",
  );
});

test("a project with hooks but no measured pool says so rather than listing hook networks as measured", () => {
  const figure = networksReadout({
    networks: ["arbitrum", "bnb", "ethereum", "unichain"],
    measuredOn: [],
    chainName,
    edition: true,
  });
  assert.equal(figure.label, "Networks with hooks");
  assert.equal(figure.note, "No measured pools");
});

test("a project with no network at all lists none", () => {
  const figure = networksReadout({
    networks: [],
    measuredOn: [],
    chainName,
    edition: true,
  });
  assert.equal(figure.title, undefined);
});

test("the live Networks figure keeps its words", () => {
  for (const options of [{ edition: false }, {}]) {
    const figure = networksReadout({
      networks: ["arbitrum", "ethereum", "robinhood", "base"],
      measuredOn: ["ethereum"],
      chainName,
      ...options,
    });
    assert.deepEqual(figure, {
      label: "Networks",
      note: "Arbitrum · Ethereum +2",
      title: "Arbitrum, Ethereum, Robinhood Chain, Base",
    });
  }
  assert.equal(
    networksReadout({ networks: [], measuredOn: [], chainName, edition: false })
      .note,
    "None listed",
  );
});

test("the setup card gives the same scope as the figure", () => {
  const four = ["arbitrum", "ethereum", "robinhood", "base"];
  assert.equal(setupNetworks(four, chainName, true), "4 networks with hooks");
  assert.equal(setupNetworks(four, chainName, false), "4 networks");
  assert.equal(setupNetworks(four, chainName), "4 networks");
  assert.equal(setupNetworks(["base"], chainName, true), "Base");
  assert.equal(setupNetworks(["base"], chainName, false), "Base");
});

test("the networks of a project's pools come in name order, once each", () => {
  assert.deepEqual(
    poolNetworks(
      [pool("robinhood"), pool("base"), pool("robinhood"), pool("arbitrum")],
      chainName,
    ),
    {
      slugs: ["arbitrum", "base", "robinhood"],
      names: ["Arbitrum", "Base", "Robinhood Chain"],
    },
  );
  assert.deepEqual(poolNetworks([], chainName), { slugs: [], names: [] });
});

/* ── R-4: every row's controls have a name of their own ──────────────────── */

const POOL = {
  name: "USDP / WETH",
  address: "0x01c392036ea9c01916309a4c25ead69bb061b79b21afe3892497d462b45e7c26",
  source: "DEX Screener",
};

test("a pool's controls name the pool, keep the visible words and differ between pools", () => {
  const labels = poolControlLabels(POOL, "View pool", "Base", true);
  assert.equal(labels.details, "Details for USDP / WETH 0x01c3…7c26 on Base");
  assert.equal(
    labels.view,
    "View pool USDP / WETH 0x01c3…7c26 on Base, DEX Screener",
  );
  // The visible texts are part of the names (WCAG 2.5.3).
  assert.ok(labels.details.startsWith("Details"));
  assert.ok(labels.view.startsWith("View pool"));
  // The explorer icon has no visible words. Its name (and the hover title the
  // link repeats it as) puts the network last, like the hook cards' names, and
  // never reads "on Base on explorer".
  assert.equal(
    labels.explorerHook,
    "View hook on explorer for USDP / WETH 0x01c3…7c26 on Base",
  );
  assert.equal(
    labels.copyId,
    "Copy pool ID of USDP / WETH 0x01c3…7c26 on Base",
  );
  assert.equal(
    labels.copyHook,
    "Copy hook address of USDP / WETH 0x01c3…7c26 on Base",
  );
  for (const name of Object.values(labels))
    assert.ok(!/ on \S.* on explorer/.test(name), name);
  const other = poolControlLabels(
    { ...POOL, address: `0x01c3${"0".repeat(56)}aaaa` },
    "View pool",
    "Base",
    true,
  );
  assert.notEqual(other.details, labels.details);
  assert.notEqual(other.view, labels.view);
});

test("one pool id on two networks gets two names", () => {
  const a = poolControlLabels(POOL, "View pool", "Ethereum", true);
  const b = poolControlLabels(POOL, "View pool", "Robinhood Chain", true);
  for (const key of Object.keys(a)) assert.notEqual(a[key], b[key], key);
});

test("a pool linked to its hook contract is not said to be 'on' a source", () => {
  const labels = poolControlLabels(
    { ...POOL, source: "Hook contract" },
    "View hook contract",
    "Base",
    true,
  );
  assert.equal(
    labels.view,
    "View hook contract USDP / WETH 0x01c3…7c26 on Base",
  );
});

test("the live page keeps the names it has (the helpers return nothing)", () => {
  assert.equal(poolControlLabels(POOL, "View pool", "Base", false), null);
  assert.equal(poolControlLabels(POOL, "View pool", "Base"), null);
  assert.equal(
    hookControlLabels({ name: "H", address: "0x1" }, "Base", 4, false),
    null,
  );
  assert.equal(hookControlLabels({ name: "H", address: "0x1" }, "Base"), null);
  assert.equal(showMoreLabel("pools", 28, false), undefined);
  assert.equal(showMoreLabel("hooks", 28), undefined);
  const component = source("src/components/ProjectDetail.tsx");
  for (const live of [
    '"Pool details"',
    '`Copy ${deployment.name || "hook"} address ${shortAddress(deployment.address)}`',
    "`Copy ${shortAddress(deployment.address)} address`",
    '"Copy pool hook address"',
    '"View hook on explorer"',
  ])
    assert.ok(component.includes(live), live);
});

test("hook addresses are told apart past their shared zeros and permission bits", () => {
  assert.equal(
    addressTag("0x0000fe59f6a4b8c1d2e3f40516273849a0b11888"),
    "0xfe59…1888",
  );
  // A short significant part is the whole address.
  assert.equal(
    addressTag("0x00000000000000000000000000000000deadbeef"),
    "0x00000000000000000000000000000000deadbeef",
  );
  // The four hooks of one name that "0x0000…1888" cannot tell apart.
  const same = [
    "0x0000aaaa1111111111111111111111111111" + "1888",
    "0x0000bbbb2222222222222222222222222222" + "1888",
  ];
  assert.notEqual(
    hookRowName({ name: "BunniHook", address: same[0] }, "Base"),
    hookRowName({ name: "BunniHook", address: same[1] }, "Base"),
  );
});

test("the tag grows only as far as the project's addresses need", () => {
  const distinct = [
    "0x0000aaaa11111111111111111111111111111888",
    "0x0000bbbb22222222222222222222222222221888",
  ];
  assert.equal(tagDigits(distinct), 4);
  // A shared mined prefix and suffix: the first four digits and the last four
  // are the same, so six are needed.
  const shared = [
    "0x833ab3bc05f63d52ae70397cae64b74c525428a8",
    "0x833accedeba5b4a84a49816f9f1a391c1aad28a8",
  ];
  assert.equal(tagDigits(shared), 6);
  assert.equal(addressTag(shared[0], 4), addressTag(shared[1], 4));
  assert.notEqual(addressTag(shared[0], 6), addressTag(shared[1], 6));
});

test("the tag is the whole address when nothing shorter tells the addresses apart", () => {
  const a = `0x${"1".repeat(19)}aa${"2".repeat(19)}`;
  const b = `0x${"1".repeat(19)}bb${"2".repeat(19)}`;
  assert.equal(tagDigits([a, b]), 20);
  assert.notEqual(addressTag(a, 20), addressTag(b, 20));
  // The same address twice is one address.
  assert.equal(tagDigits([a, a.toUpperCase().replace("0X", "0x")]), 4);
});

test("a hook's controls name the hook, its address end and its network, and keep the visible words", () => {
  const hook = {
    name: "BunniHook",
    address: "0x0000fe59f6a4b8c1d2e3f40516273849a0b11888",
  };
  const labels = hookControlLabels(hook, "Base", 4, true);
  assert.equal(
    labels.copy,
    "Copy BunniHook address 0x0000…1888 on Base (0xfe59…1888)",
  );
  assert.equal(
    labels.explorer,
    "View on explorer for BunniHook 0xfe59…1888 on Base",
  );
  assert.equal(labels.audit, "Audit for BunniHook 0xfe59…1888 on Base");
  assert.equal(
    labels.details,
    "Contract details for BunniHook 0xfe59…1888 on Base",
  );
  assert.equal(labels.source, "Source entry for BunniHook 0xfe59…1888 on Base");
  assert.equal(
    labels.callbacks(1),
    "1 callback flag of BunniHook 0xfe59…1888 on Base",
  );
  assert.equal(
    labels.callbacks(3),
    "3 callback flags of BunniHook 0xfe59…1888 on Base",
  );
  assert.ok(labels.explorer.startsWith("View on explorer"));
  assert.ok(labels.details.startsWith("Contract details"));
  // A hook without a name is still a hook contract.
  assert.match(
    hookControlLabels({ address: hook.address }, "Base", 4, true).details,
    /^Contract details for Hook contract 0xfe59…1888 on Base$/,
  );
});

test("the 'Show more' buttons say what they list and how many remain", () => {
  assert.equal(
    showMoreLabel("pools", 28, true),
    "Show 20 more pools · 28 remaining",
  );
  assert.equal(
    showMoreLabel("pools", 8, true),
    "Show 8 more pools · 8 remaining",
  );
  assert.equal(
    showMoreLabel("pools", 1, true),
    "Show 1 more pool · 1 remaining",
  );
  assert.equal(
    showMoreLabel("hooks", 728, true),
    "Show 20 more · 728 remaining hooks",
  );
  assert.equal(
    showMoreLabel("hooks", 8, true),
    "Show 8 more · 8 remaining hooks",
  );
  // The two lists never share a name, and each name holds the visible text.
  assert.notEqual(
    showMoreLabel("pools", 28, true),
    showMoreLabel("hooks", 28, true),
  );
  assert.ok(
    showMoreLabel("hooks", 40, true).startsWith("Show 20 more · 40 remaining"),
  );
});

/** Every project and pool of a snapshot file, named the way the drawer names
 * them: no two controls of one project's list may share a name. */
function assertUniqueNames(snapshot, where) {
  const chains = new Map(
    snapshot.chains.map((chain) => [chain.slug, chain.name]),
  );
  const nameOf = (slug) => chains.get(slug) ?? slug;
  const pools = new Map();
  for (const row of snapshot.pools)
    (
      pools.get(row.projectId) ??
      pools.set(row.projectId, []).get(row.projectId)
    ).push(row);
  let checked = 0;
  for (const project of snapshot.projects) {
    const digits = tagDigits(project.deployments.map((hook) => hook.address));
    const seen = new Map();
    const note = (key, value, label) => {
      const id = `${key}|${value}`;
      assert.ok(
        !seen.has(id),
        `${where}: ${project.id}: two ${key} controls named "${value}" (${label})`,
      );
      seen.set(id, label);
      checked++;
    };
    for (const hook of project.deployments) {
      const labels = hookControlLabels(hook, nameOf(hook.chain), digits, true);
      for (const key of [
        "copy",
        "explorer",
        "details",
        "source",
        "copyExpanded",
      ])
        note(key, labels[key], hook.id);
    }
    for (const row of pools.get(project.id) ?? []) {
      const labels = poolControlLabels(
        row,
        "View pool",
        nameOf(row.chain),
        true,
      );
      for (const key of [
        "details",
        "view",
        "copyId",
        "copyHook",
        "explorerHook",
      ])
        note(key, labels[key], row.id);
    }
  }
  return checked;
}

test("in the test snapshot no two controls of a project's lists share a name", () => {
  const snapshot = JSON.parse(
    readFileSync(
      new URL("./fixtures/static-data/data/snapshot.json", import.meta.url),
      "utf8",
    ),
  );
  assert.ok(assertUniqueNames(snapshot, "fixture") > 0);
});

test("one name, one pair and one id on two networks never share a control name", () => {
  const hook = (chain, address) => ({
    id: `${chain}:${address}`,
    name: "SameHook",
    chain,
    address,
  });
  const row = (chain) => ({ id: `${chain}:p`, projectId: "p", chain, ...POOL });
  const snapshot = {
    chains: [
      { slug: "base", name: "Base" },
      { slug: "ethereum", name: "Ethereum" },
    ],
    projects: [
      {
        id: "p",
        deployments: [
          hook("base", "0x0000aaaa00000000000000000000000000001888"),
          hook("base", "0x0000bbbb00000000000000000000000000001888"),
          hook("ethereum", "0x0000aaaa00000000000000000000000000001888"),
        ],
      },
    ],
    pools: [
      row("base"),
      row("ethereum"),
      { ...row("base"), id: "base:q", address: `0x01c3${"0".repeat(56)}aaaa` },
    ],
  };
  assert.ok(assertUniqueNames(snapshot, "synthetic") > 0);
});

// The same check on a real collected snapshot when one is named.
const realData = process.env.RADAR_TEST_DATA
  ? resolve(process.env.RADAR_TEST_DATA, "snapshot.json")
  : null;
test(
  "in a real snapshot no two controls of a project's lists share a name",
  {
    skip:
      realData && existsSync(realData) ? false : "RADAR_TEST_DATA is not set",
  },
  () => {
    const snapshot = JSON.parse(readFileSync(realData, "utf8"));
    assert.ok(assertUniqueNames(snapshot, "real data") > 1000);
  },
);

/* ── PD-11 B, PD-12 B: the components use the helpers, behind the flag ───── */

test("the drawer takes its control names from the helpers, and the live names stay as the fallback", () => {
  const text = source("src/components/ProjectDetail.tsx");
  assert.match(
    text,
    /const labels = poolControlLabels\(pool, linkText, networkName\)/,
  );
  assert.match(
    text,
    /const labels = hookControlLabels\(deployment, networkName, digits\)/,
  );
  for (const wiring of [
    /aria-label=\{labels\?\.details \?\? "Pool details"\}/,
    /<NamedExternal href=\{pool\.url\} label=\{labels\?\.view\}>/,
    /label=\{labels\?\.explorer\}/,
    /aria-label=\{labels\?\.details\}/,
    /aria-label=\{showMoreLabel\("hooks", deployments\.length - limit\)\}/,
    /aria-label=\{showMoreLabel\("pools", pools\.length - limit\)\}/,
    /tagDigits\(project\.deployments\.map/,
  ])
    assert.match(text, wiring, String(wiring));
});
test("the Hooks list hands focus to the first hook it adds when its button goes", () => {
  const text = source("src/components/ProjectDetail.tsx");
  assert.match(text, /const focusHookFrom = useRef<number \| null>\(null\)/);
  assert.match(
    text,
    /if \(STATIC_EDITION && deployments\.length - limit <= 20\)\s+focusHookFrom\.current = limit;/,
  );
  assert.match(text, /\[hook, "\.deployment-card"\]/);
  // The pool list's own hand-over is still there.
  assert.match(
    text,
    /if \(STATIC_EDITION && pools\.length - limit <= 20\)\s+focusPoolFrom\.current = limit;/,
  );
});

test("the platform drawer's network links navigate inside the page on a plain click, in the edition only", () => {
  const text = source("src/components/PlatformDetail.tsx");
  assert.match(
    text,
    /href=\{`\/\?view=chains&chain_network=\$\{encodeURIComponent\(slug\)\}&chain_role=launchpads`\}/,
  );
  assert.match(
    text,
    /STATIC_EDITION\s*\?\s*\(event\) => \{\s*if \(!isPlainLeftClick\(event\)\) return;\s*event\.preventDefault\(\);\s*navigateInPage\(event\.currentTarget\.href\);\s*\}\s*:\s*undefined/,
  );
});

test("an in-page link pushes the address and tells the app, which reads it from the address", () => {
  const calls = [];
  const target = {
    history: {
      state: { radar: true },
      pushState: (...args) => calls.push(["push", ...args]),
    },
    dispatchEvent: (event) => calls.push(["dispatch", event.type]),
  };
  navigateInPage(
    "http://x.test/?view=chains&chain_network=base&chain_role=launchpads",
    target,
  );
  assert.deepEqual(calls, [
    [
      "push",
      { radar: true },
      "",
      "http://x.test/?view=chains&chain_network=base&chain_role=launchpads",
    ],
    ["dispatch", "popstate"],
  ]);
});

/* ── NLA-15: what Radar showed on the review day is dated ────────────────── */

test("a line that quotes what Radar showed is read as a note of the review day, its words untouched", () => {
  const reviewed = "2026-10-24";
  assert.equal(
    reviewedNotePrefix("Radar lists only 1 pool for the hook.", reviewed, true),
    "As reviewed on 24 Oct 2026:",
  );
  assert.equal(
    reviewedNotePrefix(
      "Per-quote launches (per-quote UnihoodStockHook; 16 of 617 listed pairs are in Radar)",
      reviewed,
      true,
    ),
    "As reviewed on 24 Oct 2026:",
  );
  assert.equal(
    reviewedNotePrefix(
      "16 Robinhood curve-market hooks are not yet in Radar.",
      reviewed,
      true,
    ),
    "As reviewed on 24 Oct 2026:",
  );
});

test("a line that says nothing about Radar's index, or names the product, is not framed", () => {
  const reviewed = "2026-10-24";
  for (const text of [
    "No docs, audit statement or admin/ownership review.",
    "Hook Radar does not attribute them.",
    "Their volume is not Pangea's, and Hook Radar says so.",
    "",
    null,
    undefined,
  ])
    assert.equal(reviewedNotePrefix(text, reviewed, true), null, String(text));
  // A line that names both is framed for the part that quotes the index.
  assert.equal(
    reviewedNotePrefix(
      "Hook Radar does not attribute these; Radar lists 3.",
      reviewed,
      true,
    ),
    "As reviewed on 24 Oct 2026:",
  );
});

test("the live page and an unreadable review day add nothing", () => {
  assert.equal(
    reviewedNotePrefix("Radar lists 1 pool.", "2026-10-24", false),
    null,
  );
  assert.equal(reviewedNotePrefix("Radar lists 1 pool."), null);
  for (const bad of [null, undefined, "", "later"])
    assert.equal(
      reviewedNotePrefix("Radar lists 1 pool.", bad, true),
      null,
      String(bad),
    );
});

test("Arcfun's and Unihood's lines are the ones the review found, and both are framed", () => {
  const arcfun = launchpadRegistry.find((record) => record.id === "arcfun");
  const unihood = launchpadRegistry.find((record) => record.id === "unihood");
  const day = (record) => record.reviewedAt ?? LAUNCHPAD_REVIEWED_AT;
  assert.ok(
    arcfun.unresolved.includes("Radar lists only 1 pool for the hook."),
  );
  assert.equal(
    reviewedNotePrefix(
      "Radar lists only 1 pool for the hook.",
      day(arcfun),
      true,
    ),
    "As reviewed on 24 Oct 2026:",
  );
  const label = unihood.paths.find((path) =>
    /16 of 617 listed pairs are in Radar/.test(path.label),
  ).label;
  assert.equal(
    reviewedNotePrefix(label, day(unihood), true),
    "As reviewed on 24 Oct 2026:",
  );
});

test("every unresolved or unattributed line and path label that quotes Radar is framed, and no other", () => {
  let framed = 0;
  let plain = 0;
  for (const record of launchpadRegistry) {
    const day = record.reviewedAt ?? LAUNCHPAD_REVIEWED_AT;
    const lines = [
      ...record.unresolved,
      ...(record.unattributed ?? []),
      ...record.paths.map((path) => path.label),
    ];
    for (const line of lines) {
      const prefix = reviewedNotePrefix(line, day, true);
      const quotes = /\bRadar\b/.test(line.replace(/\bHook Radar\b/g, ""));
      assert.equal(prefix !== null, quotes, `${record.id}: ${line}`);
      if (prefix) {
        framed += 1;
        assert.match(prefix, /^As reviewed on \d{1,2} [A-Z][a-z]{2} 2026:$/);
      } else plain += 1;
      assert.equal(reviewedNotePrefix(line, day, false), null);
    }
  }
  assert.ok(framed >= 8, `only ${framed} framed lines`);
  assert.ok(plain > framed, "most lines are not about Radar's index");
});

test("the launchpad component frames the lines in the edition and leaves the live markup alone", () => {
  const text = source("src/components/LaunchpadPaths.tsx");
  assert.match(text, /reviewedNotePrefix\(text, reviewedAt\)/);
  for (const [name, pattern] of [
    ["path label", /\{asReviewed\(path\.label\)\}\s*\{path\.label\}/],
    ["unattributed", /\{asReviewed\(note\)\}\s*\{note\}/],
  ])
    assert.match(text, pattern, name);
  // The finding's own words are rendered as they are written.
  assert.doesNotMatch(text, /note\.replace|label\.replace/);
  // The edition's rule is scoped to the edition's drawer.
  assert.match(
    source("src/components/launchpad-paths.css"),
    /\.platform-detail\.is-snapshot \.lp-as-of/,
  );
});

test("the drawer names no service path", () => {
  for (const file of [
    "src/project-presentation.ts",
    "src/edition-platform-copy.ts",
    "src/components/LaunchpadPaths.tsx",
  ])
    assert.doesNotMatch(source(file), /["'`]\/api\b/, file);
});
