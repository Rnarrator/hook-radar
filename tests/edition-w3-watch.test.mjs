// The watchlist feed, the Compare tray and the not-carried notices of the Auto
// Snapshot edition (the fixes of the re-audit of 28 October 2026).
//
//  1. A static site served over plain http has no crypto.subtle (and no
//     crypto.randomUUID): the stored comparison of saved projects hashed with
//     crypto.subtle.digest, threw a TypeError there and showed "could not be
//     checked" with a Retry that could never succeed. The edition now falls
//     back to a pure-JavaScript SHA-256 that gives the same 64 hex characters,
//     and saved filters get their id from random bytes. The live page keeps
//     asking the browser.
//  2. "Mark read" moves the focus to the panel's heading before its button
//     leaves, in the edition only.
//  3. The phone tray, and the Forget / Remove buttons of the not-carried
//     notices, are edition-scoped rules in the shared stylesheets.
//
// The same behaviour in a real browser, on a build of the edition, is in
// scripts/static-edition-w3-watch-browser.test.mjs (not under tests/: it cannot
// pass against a live build).
//
//   node --test tests/edition-w3-watch.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { makeSnapshot } from "./fixtures.mjs";
import {
  decodeWatchChanges,
  emptyWatchChanges,
  observeWatchChanges,
  sha256Hex,
  watchBaseline,
} from "../src/watch-changes.ts";
import { putSavedFilter } from "../src/discovery.ts";

const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );

/** Runs `fn` with these members of the global crypto object hidden, the way a
 * page served from a non-secure origin has none of them, and puts them back. */
async function without(names, fn) {
  for (const name of names)
    Object.defineProperty(globalThis.crypto, name, {
      value: undefined,
      configurable: true,
    });
  try {
    return await fn();
  } finally {
    for (const name of names) delete globalThis.crypto[name];
  }
}

/* ── 1. SHA-256 without crypto.subtle ──────────────────────────────────── */

const encoder = new TextEncoder();
const subtleHex = async (bytes) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");

test("the fallback SHA-256 matches the published test vectors", () => {
  assert.equal(
    sha256Hex(encoder.encode("")),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assert.equal(
    sha256Hex(encoder.encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  // The two-block vector of FIPS 180-4.
  assert.equal(
    sha256Hex(
      encoder.encode(
        "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      ),
    ),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
});

test("the fallback equals crypto.subtle for the empty string, 'abc', a multi-block input and a long unicode string", async () => {
  const inputs = [
    "",
    "abc",
    "The quick brown fox jumps over the lazy dog",
    JSON.stringify(
      Array.from({ length: 40 }, (_, i) => [
        `hook-${i}`,
        "base",
        `0x${i.toString(16).padStart(40, "0")}`,
      ]),
    ),
    "héllo wörld — ☃ 😀 日本語 ".repeat(200),
  ];
  for (const text of inputs) {
    const bytes = encoder.encode(text);
    assert.equal(
      sha256Hex(bytes),
      await subtleHex(bytes),
      `input of ${bytes.length} bytes`,
    );
  }
});

test("the fallback agrees at every padding boundary and with a large input", async () => {
  // 55 bytes fit one block with the padding, 56 need a second; 64 is a full block.
  for (const length of [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000]) {
    const bytes = new Uint8Array(length).map((_, i) => (i * 7 + length) & 255);
    assert.equal(sha256Hex(bytes), await subtleHex(bytes), `${length} bytes`);
  }
  const large = new Uint8Array(300_001).map((_, i) => (i * 31 + 5) & 255);
  assert.equal(sha256Hex(large), await subtleHex(large), "300001 bytes");
  assert.match(sha256Hex(large), /^[a-f0-9]{64}$/);
});

const project = () => {
  const p = structuredClone(makeSnapshot().projects[0]);
  p.poolInventory = { poolCount: 20, complete: true, chains: { base: 20 } };
  return p;
};
const FIRST = "2026-10-17T09:00:00.000Z";
const SECOND = "2026-10-18T09:00:00.000Z";

test("in the edition the comparison works with no crypto.subtle and stores the same hashes", async () => {
  const p = project();
  const withSubtle = await watchBaseline(p, FIRST, FIRST, true);
  const withoutSubtle = await without(["subtle"], async () => {
    assert.equal(globalThis.crypto.subtle, undefined, "subtle is hidden");
    return watchBaseline(p, FIRST, FIRST, true);
  });
  // A baseline saved on an https visit and compared on an http one (or the
  // other way round) must not look like a change.
  assert.deepEqual(withoutSubtle, withSubtle);
  for (const key of ["hooks", "properties", "metadata"])
    assert.match(withoutSubtle[key], /^[a-f0-9]{64}$/);

  // A first visit, then a changed snapshot: all without subtle.
  const state = await without(["subtle"], async () => {
    const first = await observeWatchChanges(
      emptyWatchChanges(),
      [p],
      [p.id],
      FIRST,
      FIRST,
      true,
    );
    p.description = "Updated published description";
    return observeWatchChanges(first, [p], [p.id], SECOND, SECOND, true);
  });
  assert.equal(state.changes.length, 1);
  assert.equal(state.changes[0].kind, "metadata");
  assert.match(state.changes[0].id, /^[a-f0-9]{64}$/);
  // The stored form is accepted exactly as one made with crypto.subtle.
  assert.deepEqual(decodeWatchChanges(JSON.stringify(state)), state);

  // The same two observations with crypto.subtle give the identical state.
  const q = project();
  const reference = await observeWatchChanges(
    emptyWatchChanges(),
    [q],
    [q.id],
    FIRST,
    FIRST,
    true,
  );
  q.description = "Updated published description";
  assert.deepEqual(
    await observeWatchChanges(reference, [q], [q.id], SECOND, SECOND, true),
    state,
  );
});

test("a baseline made without subtle compares equal to one made with it, in both directions", async () => {
  const p = project();
  const early = await without(["subtle"], () =>
    observeWatchChanges(emptyWatchChanges(), [p], [p.id], FIRST, FIRST, true),
  );
  // Seen again on a secure origin with the project unchanged: no change.
  const later = await observeWatchChanges(
    early,
    [p],
    [p.id],
    SECOND,
    SECOND,
    true,
  );
  assert.deepEqual(later.changes, []);
  assert.equal(later.baselines[0].sourceAt, SECOND);
});

test("the live page still asks the browser: without crypto.subtle its digest fails as before", async () => {
  const p = project();
  await without(["subtle"], async () => {
    await assert.rejects(
      () => watchBaseline(p, FIRST, FIRST, false),
      TypeError,
    );
    // The default of every caller is the build's flag, which is off in Node.
    await assert.rejects(() => watchBaseline(p, FIRST, FIRST), TypeError);
    await assert.rejects(
      () =>
        observeWatchChanges(
          emptyWatchChanges(),
          [p],
          [p.id],
          FIRST,
          FIRST,
          false,
        ),
      TypeError,
    );
  });
  // With it, the edition and the live page agree on every hash.
  assert.deepEqual(
    await watchBaseline(p, FIRST, FIRST, false),
    await watchBaseline(p, FIRST, FIRST, true),
  );
});

test("the edition takes crypto.subtle when the page has it", async () => {
  const p = project();
  let calls = 0;
  const real = globalThis.crypto.subtle;
  const spy = new Proxy(real, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key !== "digest") return value;
      return (...args) => {
        calls += 1;
        return target.digest(...args);
      };
    },
  });
  Object.defineProperty(globalThis.crypto, "subtle", {
    value: spy,
    configurable: true,
  });
  try {
    await watchBaseline(p, FIRST, FIRST, true);
  } finally {
    delete globalThis.crypto.subtle;
  }
  assert.equal(
    calls,
    3,
    "one crypto.subtle.digest for each of the three hashes",
  );
});

test("every caller of the hash threads the edition flag, so the fallback cannot be skipped", () => {
  const source = read("src/watch-changes.ts");
  assert.match(source, /watchBaseline\(project, sourceAt, now, edition\)/);
  assert.match(
    source,
    /await digest\(\s*\[project\.id, kind, prior\.sourceAt, sourceAt, signature\],\s*edition,\s*\)/,
  );
  // No other direct use of crypto.subtle in the edition's client code.
  for (const path of [
    "src/useWatchChanges.ts",
    "src/components/WatchChangeFeed.tsx",
    "src/components/SavedDiscoveryFilters.tsx",
  ])
    assert.doesNotMatch(read(path), /crypto\.subtle/, path);
});

/* ── Components loaded on their own, as the other edition tests do ─────── */

async function componentModule(
  path,
  replacements = {},
  patch = (code) => code,
) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  let output = ts.transpileModule(source, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  output = output.replace(/^import ["'][^"']+\.css["'];?\s*$/gm, "");
  output = patch(output);
  for (const [specifier, target] of Object.entries({
    "lucide-react": import.meta.resolve("lucide-react"),
    react: import.meta.resolve("react"),
    "react/jsx-runtime": import.meta.resolve("react/jsx-runtime"),
    ...replacements,
  }))
    output = output.replaceAll(
      JSON.stringify(specifier),
      JSON.stringify(target),
    );
  return `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`;
}
const dataModule = (code) =>
  `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const editionUrl = new URL("../src/edition.ts", import.meta.url).href;
const icons = await componentModule("../src/components/Icons.tsx");

/* ── 2. Saved filters get an id on any origin ──────────────────────────── */

const FLAG = 'import.meta.env.VITE_STATIC_EDITION === "1"';
async function savedFilters(editionFlag) {
  const url = await componentModule(
    "../src/components/SavedDiscoveryFilters.tsx",
    {
      "../discovery": new URL("../src/discovery.ts", import.meta.url).href,
      "./Icons": icons,
    },
    (code) => {
      assert.ok(code.includes(FLAG), "the module reads the build's flag");
      return code.replace(FLAG, String(editionFlag));
    },
  );
  return import(url);
}
const editionFilters = await savedFilters(true);
const liveFilters = await savedFilters(false);
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("in the edition a saved view gets an id with no crypto.randomUUID, from random bytes", async () => {
  await without(["randomUUID"], () => {
    assert.equal(globalThis.crypto.randomUUID, undefined);
    const seen = new Set();
    for (let i = 0; i < 100; i++) {
      const id = editionFilters.newSavedFilterId();
      assert.match(id, UUID_V4);
      // The format a saved view's id must have to be stored.
      assert.match(id, /^[a-z0-9-]{1,100}$/);
      seen.add(id);
    }
    assert.equal(seen.size, 100, "no id repeats");
    // And the store accepts it.
    const saved = putSavedFilter([], {
      id: editionFilters.newSavedFilterId(),
      name: "My view",
      filters: {
        search: "",
        chain: "base",
        category: "all",
        property: "all",
        market: "all",
      },
    });
    assert.equal(saved.error, null);
    assert.equal(saved.views.length, 1, "saved");
  });
  assert.equal(typeof globalThis.crypto.randomUUID, "function", "restored");
});

test("with neither randomUUID nor getRandomValues the edition falls back to Math.random", async () => {
  const random = Math.random;
  Math.random = () => 0.5;
  try {
    await without(["randomUUID", "getRandomValues"], () => {
      // Every byte is 128, with the version and variant bits set.
      assert.equal(
        editionFilters.newSavedFilterId(),
        "80808080-8080-4080-8080-808080808080",
      );
    });
  } finally {
    Math.random = random;
  }
  assert.match(editionFilters.newSavedFilterId(), UUID_V4);
});

test("the edition uses crypto.randomUUID when the page has it; the live page always does", async () => {
  assert.match(editionFilters.newSavedFilterId(), UUID_V4);
  assert.match(liveFilters.newSavedFilterId(), UUID_V4);
  const original = globalThis.crypto.randomUUID;
  let calls = 0;
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    value: () => {
      calls += 1;
      return "00000000-0000-4000-8000-000000000000";
    },
    configurable: true,
  });
  try {
    assert.equal(
      editionFilters.newSavedFilterId(),
      "00000000-0000-4000-8000-000000000000",
    );
    assert.equal(
      liveFilters.newSavedFilterId(),
      "00000000-0000-4000-8000-000000000000",
    );
  } finally {
    delete globalThis.crypto.randomUUID;
  }
  assert.equal(calls, 2);
  assert.equal(globalThis.crypto.randomUUID, original);
});

test("the live page does not get the fallback: without randomUUID it fails as before", async () => {
  await without(["randomUUID"], () => {
    assert.throws(() => liveFilters.newSavedFilterId(), TypeError);
  });
});

/* ── 3. The feed's heading is where focus goes after Mark read ─────────── */

const modelUrl = new URL("../src/model.ts", import.meta.url).href;
const feedModule = async (editionFlag) =>
  import(
    await componentModule("../src/components/WatchChangeFeed.tsx", {
      "./Icons": icons,
      "../model": modelUrl,
      "../edition": editionFlag
        ? dataModule(
            `export * from ${JSON.stringify(editionUrl)};\nexport const STATIC_EDITION = true;`,
          )
        : editionUrl,
    })
  );
const editionFeed = (await feedModule(true)).WatchChangeFeed;
const liveFeed = (await feedModule(false)).WatchChangeFeed;
const hex = "a".repeat(64);
const feedProps = {
  changes: [
    {
      id: "b".repeat(64),
      projectId: "alpha",
      name: "Alpha",
      kind: "hooks",
      title: "Hook list changed",
      detail: "1 → 2 indexed contracts.",
      observedAt: "2026-10-28T15:30:00.000Z",
      previousAt: "2026-10-27T18:31:00.000Z",
      sourceAt: "2026-10-28T14:05:00.000Z",
      previousSourceAt: "2026-10-27T18:30:00.000Z",
    },
  ],
  baselines: [
    {
      id: "alpha",
      name: "Alpha",
      hooks: hex,
      properties: hex,
      metadata: hex,
      hookCount: 1,
      poolCount: null,
      poolComplete: false,
      sourceAt: "2026-10-28T14:05:00.000Z",
      startedAt: "2026-10-27T18:30:00.000Z",
      checkedAt: "2026-10-28T15:30:00.000Z",
    },
  ],
  checking: false,
  error: "",
  unread: 1,
  storageAvailable: true,
  total: 1,
  openProject() {},
  markRead() {},
  retry() {},
};

test("the edition's feed heading can take focus (tabindex -1) and the button that leaves has somewhere to hand it; the live heading is untouched", () => {
  const e = renderToStaticMarkup(createElement(editionFeed, feedProps));
  assert.match(
    e,
    /<h2 id="watch-updates-heading" tabindex="-1">What changed<\/h2>/,
  );
  assert.match(e, /Mark read/);
  const l = renderToStaticMarkup(createElement(liveFeed, feedProps));
  assert.match(l, /<h2 id="watch-updates-heading">What changed<\/h2>/);
  assert.doesNotMatch(l, /tabindex/);
});

test("the Mark read handler moves focus only in the edition", () => {
  const source = read("src/components/WatchChangeFeed.tsx");
  assert.match(
    source,
    /markRead\(\);[\s\S]{0,260}if \(STATIC_EDITION\)\s*heading\.current\?\.focus\(\{ preventScroll: true \}\);/,
  );
  assert.match(source, /ref=\{heading\}/);
});

/* ── 4. The stylesheets ────────────────────────────────────────────────── */

const EDITION = ':where(:root[data-edition="snapshot"])';

/** The rules inside the first at-rule whose prelude is `header`. These
 * stylesheets hold plain rules and one level of at-rules. */
function atRule(css, header) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const start = text.indexOf(`${header} {`);
  assert.ok(start >= 0, `${header} is in the stylesheet`);
  let depth = 0;
  let i = text.indexOf("{", start);
  const open = i;
  for (; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    if (text[i] === "}" && --depth === 0) break;
  }
  const rules = [];
  for (const [, selector, body] of text
    .slice(open + 1, i)
    .matchAll(/([^{}]+)\{([^{}]*)\}/g))
    rules.push({
      selectors: selector
        .split(/,(?![^(]*\))/)
        .map((s) => s.replace(/\s+/g, " ").trim()),
      declarations: Object.fromEntries(
        body
          .split(";")
          .map((d) => d.split(/:(.*)/s).map((s) => s?.trim()))
          .filter(([name, value]) => name && value),
      ),
    });
  return rules;
}
const find = (rules, selector) =>
  rules.find((rule) => rule.selectors.includes(selector))?.declarations;

test("the phone tray's label keeps its width and, where one row stops fitting, the buttons take a second row; both are edition-scoped", () => {
  const shell = read("src/design/shell.css");
  const narrow = atRule(shell, "@media (max-width: 28rem)");
  const rules = atRule(shell, "@media (max-width: 25.75rem)");
  assert.ok(narrow.length >= 2 && rules.length >= 3);
  for (const rule of [...narrow, ...rules])
    for (const selector of rule.selectors)
      assert.ok(
        selector.startsWith(`${EDITION} `),
        `${selector} is not scoped to the edition`,
      );
  // The label keeps the width of its text; the free space gives way instead.
  assert.equal(
    find(narrow, `${EDITION} .compare-tray > span`).flex,
    "0 0 auto",
  );
  assert.equal(find(narrow, `${EDITION} .compare-tray`).gap, "var(--s-1)");
  const tray = find(rules, `${EDITION} .compare-tray`);
  assert.equal(tray["flex-wrap"], "wrap");
  assert.equal(find(rules, `${EDITION} .compare-tray > div`).flex, "1 1 100%");
  assert.equal(
    find(rules, `${EDITION} .compare-tray > div > .primary-button`).flex,
    "1 1 auto",
  );
});

test("the tray's markup is what the phone rules address: a label span, then one div of two buttons", () => {
  const app = read("src/App.tsx");
  const tray = app.match(
    /<aside className="compare-tray"[\s\S]*?<\/aside>/,
  )?.[0];
  assert.ok(tray, "the tray is in App.tsx");
  assert.match(
    tray,
    /<span>[\s\S]*<strong>[^<]*selected<\/strong>[\s\S]*<\/span>\s*<div>/,
  );
  assert.match(
    tray,
    /className="control"[\s\S]*Clear[\s\S]*className="primary-button"/,
  );
});

test("Forget and Remove are 44px targets on narrow and touch screens, in the edition only", () => {
  const rules = atRule(
    read("src/components/comparison.css"),
    "@media (max-width: 52rem), (pointer: coarse)",
  );
  const button = find(
    rules,
    `${EDITION} .notice.comparison-not-carried button`,
  );
  assert.ok(button, "the rule exists");
  assert.equal(button["min-height"], "2.75rem");
  assert.match(button.padding, /var\(--s-4\)/);
  // The id beside the button gets a box as tall as the button, so the two stay
  // one row with their tops level (the 19px id would otherwise sit 12px lower).
  const id = find(rules, `${EDITION} .notice.comparison-not-carried code`);
  assert.ok(id, "the id rule exists");
  assert.equal(id["min-height"], "2.75rem");
  assert.equal(id.display, "flex");
  assert.equal(id["align-items"], "center");
  for (const rule of rules)
    for (const selector of rule.selectors)
      assert.ok(selector.startsWith(`${EDITION} `), selector);
  // Both notices carry the class the rule uses, and both hold a plain button.
  for (const path of ["src/App.tsx", "src/components/HookComparison.tsx"])
    assert.match(
      read(path),
      /className="notice (?:orphan-notice )?comparison-not-carried"/,
      path,
    );
});
