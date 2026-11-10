// Small presentation fixes of the Auto Snapshot edition.
//
//  1. The hook-update feed. The collector records no registry changes, so in the
//     edition the "Latest hook updates" panel could never fill. With the flag
//     set and no events it is not rendered (only the page's own watchlist
//     shortcut, which stood inside it, is); with events, or with the flag
//     unset, it is exactly the live panel. Rendered here from the real
//     component, once per flavour (Vite loads it with the flag set and unset).
//  2. The phone-width polish in the shared stylesheets: long addresses in the
//     source notes wrap inside Data & sources, error retries and the small text
//     links reach their target sizes. Every one of those rules is scoped to the
//     edition (the root element carries data-edition="snapshot" only in an
//     edition build), so the live page renders as before; the stylesheet guards
//     below read the rules themselves.
//
// The same fixes in a real browser (edition build, 390 and 1440 px, fixture or
// real data) are in scripts/static-edition-small-fixes-browser.test.mjs. It is
// not under tests/ because it cannot pass against a live build, and `npm test`
// runs every file here whatever RADAR_TEST_DIST names. The mark and the
// no-script wording the build adds are covered in
// tests/edition-package-vite.test.mjs.
//
//   node --test tests/edition-small-fixes.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const repo = fileURLToPath(new URL("..", import.meta.url));
const read = (path) =>
  readFileSync(resolve(repo, path), "utf8").replace(/\r\n/g, "\n");

/* ── 1. The feed panel, rendered from the component ─────────────────────── */

/** RegistryUpdates as Vite loads it with VITE_STATIC_EDITION set (or not). */
async function registryUpdates(edition) {
  const before = process.env.VITE_STATIC_EDITION;
  if (edition) process.env.VITE_STATIC_EDITION = "1";
  else delete process.env.VITE_STATIC_EDITION;
  const server = await createServer({
    root: repo,
    configFile: false,
    envFile: false,
    logLevel: "silent",
    appType: "custom",
    plugins: [react()],
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true, hmr: false, watch: null },
  });
  try {
    const module = await server.ssrLoadModule(
      "/src/components/RegistryUpdates.tsx",
    );
    const { STATIC_EDITION } = await server.ssrLoadModule("/src/edition.ts");
    assert.equal(STATIC_EDITION, edition, "the flag the component sees");
    return module.RegistryUpdates;
  } finally {
    await server.close();
    if (before === undefined) delete process.env.VITE_STATIC_EDITION;
    else process.env.VITE_STATIC_EDITION = before;
  }
}

const event = {
  id: "event-1",
  type: "new-deployment",
  title: "Gamma deployment listed",
  description: "A Base deployment was added to the registry.",
  timestamp: "2026-10-27T09:00:00.000Z",
  projectId: "gamma",
  chain: "base",
  url: null,
};

const shortcut = createElement(
  "button",
  { className: "watch-callout" },
  "Open watchlist",
);

const render = (RegistryUpdates, props = {}) =>
  renderToStaticMarkup(
    createElement(
      RegistryUpdates,
      {
        events: [],
        scopedEvents: [],
        loading: false,
        scopedLoading: false,
        error: "",
        scopedError: "",
        scopedSyncing: false,
        registry: {
          id: "registry",
          name: "Uniswap hook registry",
          url: "https://github.com/Uniswap/hooklist",
          note: "",
          status: "live",
          updatedAt: "2026-10-28T00:05:00.000Z",
        },
        now: Date.parse("2026-10-28T00:14:11.000Z"),
        recovering: false,
        watchlist: false,
        onRefresh() {},
        onRetryScope() {},
        onOpen() {},
        chainName: (slug) => slug,
        ...props,
      },
      props.children,
    ),
  );

const PANEL_TEXT = [
  "Latest hook updates",
  "Update scope",
  "No updates recorded yet",
  "will appear here when detected",
  "Observed changes, not deployment dates",
];

test("edition: with no recorded updates the panel is not rendered, only the watchlist shortcut", async () => {
  const RegistryUpdates = await registryUpdates(true);
  // Nothing to show and nothing inside: nothing at all.
  assert.equal(render(RegistryUpdates), "");
  assert.equal(render(RegistryUpdates, { children: false }), "");
  // The shortcut that lived inside the panel stays, on its own.
  const html = render(RegistryUpdates, { children: shortcut });
  assert.match(html, /<button class="watch-callout">Open watchlist<\/button>/);
  for (const text of PANEL_TEXT)
    assert.equal(html.includes(text), false, `"${text}" is not shown`);
  assert.equal(html.includes("<section"), false, "no panel section");
  assert.equal(html.includes("registry-scope"), false, "no scope toggle");
  assert.equal(html.includes("quiet-feed"), false, "no empty state");
  // The shortcut keeps the class its styles hang from.
  assert.match(html, /class="registry-updates registry-shortcut"/);
});

test("edition: once an event exists the panel is the live panel, toggle included", async () => {
  const RegistryUpdates = await registryUpdates(true);
  for (const props of [
    { events: [event], scopedEvents: [event] },
    { events: [event], scopedEvents: [] },
  ]) {
    const html = render(RegistryUpdates, { ...props, children: shortcut });
    assert.match(html, /<section class="panel signal-panel registry-updates"/);
    assert.match(html, /Latest hook updates/);
    assert.match(html, /Update scope/);
    assert.match(html, /All updates/);
    assert.match(html, /This view/);
    assert.match(html, /Hook added/);
    assert.match(html, /Gamma deployment listed/);
    assert.match(html, /Observed changes, not deployment dates\./);
    // The shortcut sits at the foot of the panel, as before.
    assert.match(html, /Open watchlist<\/button><\/section>$/);
  }
  // An event in the view's own list alone keeps the panel too (it opens on the
  // list of all updates, which is empty, as in the live page).
  const viewOnly = render(RegistryUpdates, {
    events: [],
    scopedEvents: [event],
    children: shortcut,
  });
  assert.match(
    viewOnly,
    /<section class="panel signal-panel registry-updates"/,
  );
  assert.match(viewOnly, /Latest hook updates/);
  // The refresh control stays off in the edition, with or without events.
  assert.equal(
    render(RegistryUpdates, { events: [event] }).includes(
      "Refresh hook updates",
    ),
    false,
  );
});

test("live: the panel renders as it always did, empty or not", async () => {
  const RegistryUpdates = await registryUpdates(false);
  const empty = render(RegistryUpdates, { children: shortcut });
  assert.match(empty, /<section class="panel signal-panel registry-updates"/);
  for (const text of PANEL_TEXT)
    assert.equal(empty.includes(text), true, `"${text}" is shown`);
  assert.match(empty, /aria-label="Refresh hook updates"/);
  assert.match(empty, /Open watchlist<\/button><\/section>$/);
  assert.equal(empty.includes("registry-shortcut"), false);
  // Without a shortcut it is still the panel.
  assert.match(render(RegistryUpdates), /Latest hook updates/);
  // And with events.
  const full = render(RegistryUpdates, {
    events: [event],
    scopedEvents: [event],
  });
  assert.match(full, /Gamma deployment listed/);
  assert.match(full, /aria-label="Refresh hook updates"/);
});

/* ── 2. The stylesheets ─────────────────────────────────────────────────── */

/** The selector that makes a rule the edition's: the root element carries the
 * mark in an edition build only, and :where() keeps the specificity of the
 * selector that follows. */
const EDITION = ':where(:root[data-edition="snapshot"])';
const TOUCH = "@media (max-width: 52rem), (pointer: coarse)";

const tidy = (text) =>
  text
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .trim();

/** Splits at the commas (or other separator) that are not inside brackets,
 * parentheses or quotes. */
function splitTop(text, separator) {
  const parts = [];
  let depth = 0;
  let quote = "";
  let current = "";
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth -= 1;
    else if (char === separator && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/** Every rule of a stylesheet: its selectors (a list is split at top-level
 * commas), the at-rules it sits in, and its own declarations. No packages:
 * these stylesheets hold plain rules and one level of at-rules, no nesting. */
function rulesOf(path) {
  const css = read(path).replace(/\/\*[\s\S]*?\*\//g, "");
  const found = [];
  const atRules = [];
  let prelude = "";
  let quote = "";
  let parens = 0;
  for (let index = 0; index < css.length; index += 1) {
    const char = css[index];
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "(") parens += 1;
    else if (char === ")") parens -= 1;
    else if (char === "{" && parens === 0) {
      const head = tidy(prelude);
      prelude = "";
      if (head.startsWith("@")) {
        atRules.push(head);
        continue;
      }
      let close = index + 1;
      while (close < css.length && css[close] !== "}") close += 1;
      const declarations = {};
      for (const declaration of splitTop(css.slice(index + 1, close), ";")) {
        const colon = declaration.indexOf(":");
        if (colon > 0)
          declarations[declaration.slice(0, colon).trim()] = tidy(
            declaration.slice(colon + 1),
          );
      }
      found.push({
        selectors: splitTop(head, ",").map(tidy),
        media: atRules.join(" "),
        declarations,
      });
      index = close;
      continue;
    } else if (char === "}" && parens === 0) {
      atRules.pop();
      prelude = "";
      continue;
    }
    prelude += char;
  }
  return found;
}

/** The selectors, ending in `target`, of rules that set `property`. */
const setting = (rules, target, property) =>
  rules.flatMap((rule) =>
    property in rule.declarations
      ? rule.selectors
          .filter((selector) => selector.endsWith(target))
          .map((selector) => ({ selector, rule }))
      : [],
  );

// Each presentation rule of this fix: where it lives, what it sets, and in
// which media query.
const SCOPED = [
  [
    "src/design/components.css",
    ".notice.error-notice button",
    "min-height",
    "2.75rem",
    TOUCH,
  ],
  [
    "src/design/components.css",
    ".select-control select",
    "align-self",
    "stretch",
    TOUCH,
  ],
  [
    "src/design/dialogs.css",
    ".source-list",
    "grid-template-columns",
    "minmax(0, 1fr)",
    "",
  ],
  ["src/design/dialogs.css", ".source-item", "min-width", "0", ""],
  [
    "src/design/dialogs.css",
    ".source-item > div:first-child",
    "min-width",
    "0",
    "",
  ],
  ["src/design/dialogs.css", ".source-item p", "min-width", "0", ""],
  ["src/design/dialogs.css", ".source-item p", "overflow-wrap", "anywhere", ""],
  [
    "src/design/compact.css",
    ".monitor-row:not(:has(.registry-updates))",
    "grid-template-columns",
    "minmax(0, 1fr)",
    "",
  ],
];

test("stylesheets: every presentation rule of the edition is scoped to the edition, so the live page is untouched", () => {
  for (const [path, target, property, value, media] of SCOPED) {
    const hits = setting(rulesOf(path), target, property);
    const label = `${target} { ${property} } in ${path}`;
    assert.ok(hits.length >= 1, `${label} exists`);
    for (const { selector, rule } of hits) {
      assert.equal(selector, `${EDITION} ${target}`, `${label} is scoped`);
      assert.equal(rule.declarations[property], value, label);
      assert.equal(rule.media, media, `${label} is in the right media query`);
    }
  }
  // The rules the live page already had were left as they were.
  const dialogs = rulesOf("src/design/dialogs.css");
  const base = (selector) =>
    dialogs.find((rule) => rule.selectors.includes(selector))?.declarations;
  assert.ok(base(".source-item p"), "the live .source-item p rule is there");
  assert.equal(base(".source-item p")["overflow-wrap"], undefined);
  assert.equal(base(".source-item p")["min-width"], undefined);
  assert.equal(base(".source-list")["grid-template-columns"], undefined);
});

test("stylesheets: all eleven small links, summaries and link buttons are sized for touch, for the edition only", () => {
  const wanted = [
    ".overview-data-notes summary",
    ".overview-data-notes button",
    ".source-meta .external",
    ".platform-availability-source .external",
    ".lp-address .external",
    ".lp-evidence .external",
    ".lp-contracts li .external",
    ".lp-link",
    ".lp-contracts > summary",
    ".lp-unattributed > summary",
    ".lp-unresolved > summary",
  ];
  const sized = rulesOf("src/design/compact.css").filter(
    (rule) => rule.declarations["min-height"] === "1.5rem",
  );
  assert.equal(sized.length, 1, "one rule sizes them");
  assert.equal(sized[0].media, TOUCH, "on touch screens and phone widths only");
  assert.equal(sized[0].selectors.length, 1);
  const [selector] = sized[0].selectors;
  const open = `${EDITION} :where(`;
  assert.ok(selector.startsWith(open), "scoped to the edition");
  assert.ok(selector.endsWith(")"));
  const listed = selector
    .slice(open.length, -1)
    .split(",")
    .map((item) => item.trim());
  assert.deepEqual([...listed].sort(), [...wanted].sort());
  // Everything is inside :where(), so the rule adds no specificity: a rule
  // that already sizes one of these larger still wins.
  assert.equal(
    selector.replace(/:where\((?:[^()]|\([^()]*\))*\)/g, "").trim(),
    "",
  );
});

test("stylesheets: the watchlist shortcut sits level with the plate", () => {
  const rule = rulesOf("src/design/compact.css").find((item) =>
    item.selectors.includes(
      ".registry-updates.registry-shortcut .watch-callout",
    ),
  );
  assert.ok(rule, "the rule exists");
  assert.equal(rule.declarations["margin-top"], "0");
  assert.equal(rule.media, "");
});
