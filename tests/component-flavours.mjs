// Components compiled from source and rendered to markup, in a Node test: once
// as the edition (VITE_STATIC_EDITION=1) and once as the live build (flag
// unset). Source files are transpiled one by one (TypeScript only) and wired with
// a small CommonJS loader; stylesheets are empty; packages come from
// node_modules. The same method as tests/edition-analytics-copy.test.mjs, kept
// here for the tests that need a React context around the component.
//
// `patches` ({ "src/...": [[from, to]] }) rewrites a line of a source file before
// it is compiled: it sets the initial value of a state that only a click reaches
// (the metric, say). A patch that matches nothing throws, so a renamed line
// cannot quietly turn it into a no-op.
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import ts from "typescript";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const projectRequire = createRequire(resolve(root, "package.json"));

export function loadFlavour(edition, patches = {}) {
  const flag = edition ? '"1"' : "undefined";
  const cache = new Map();
  const applied = new Set();
  const local = (from, specifier) => {
    const base = resolve(dirname(from), specifier);
    for (const candidate of [
      base,
      base + ".ts",
      base + ".tsx",
      join(base, "index.ts"),
      join(base, "index.tsx"),
    ])
      if (existsSync(candidate) && statSync(candidate).isFile())
        return candidate;
    throw new Error("cannot resolve " + specifier + " from " + from);
  };
  function load(file) {
    const cached = cache.get(file);
    if (cached) return cached.exports;
    const module = { exports: {} };
    cache.set(file, module);
    let source = readFileSync(file, "utf8")
      .replaceAll("import.meta.env.VITE_STATIC_EDITION", flag)
      .replaceAll("import.meta.env.BASE_URL", '"/"');
    const relative = file.slice(root.length + 1).replaceAll("\\", "/");
    for (const [from, to] of patches[relative] ?? []) {
      assert.ok(
        source.includes(from),
        relative + " no longer contains " + from,
      );
      source = source.replace(from, () => to);
      applied.add(relative);
    }
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
  const at = (path) => load(resolve(root, path));
  const react = projectRequire("react");
  const loaded = {
    createElement: react.createElement,
    renderToStaticMarkup:
      projectRequire("react-dom/server").renderToStaticMarkup,
    freezeEvaluationClock: at("src/edition.ts").freezeEvaluationClock,
    STATIC_EDITION: at("src/edition.ts").STATIC_EDITION,
    DailyViewProvider: at("src/daily-view.ts").DailyViewProvider,
    createDailyLens: at("src/daily.ts").createDailyLens,
    AnalyticsOverview: at("src/components/AnalyticsOverview.tsx")
      .AnalyticsOverview,
    AnalyticsWorkspace: at("src/components/AnalyticsWorkspace.tsx")
      .AnalyticsWorkspace,
  };
  for (const file of Object.keys(patches))
    assert.ok(
      applied.has(file),
      file + " was never loaded, so its patch did nothing",
    );
  return loaded;
}

const decode = (html) =>
  html
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"');

/** The markup, and the text a reader sees (tags removed, spaces collapsed). */
export function renderPage(flavour, name, props, daily = null) {
  const element = flavour.createElement(flavour[name], props);
  const html = flavour.renderToStaticMarkup(
    daily
      ? flavour.createElement(flavour.DailyViewProvider, { value: daily }, element)
      : element,
  );
  return {
    html: decode(html),
    text: decode(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim(),
  };
}
