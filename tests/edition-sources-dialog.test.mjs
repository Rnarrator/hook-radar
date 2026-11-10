// The owner's choice that the edition's page has no "Data & sources" dialog, no
// way into it and no provider credit or logo-notices line (src/edition.ts,
// EDITION_SOURCES_DIALOG). The rules here run in Node and read the sources; what
// a visitor sees is asserted in a real browser by
// scripts/edition-sources-dialog-browser.test.mjs, against the edition build and
// against a build with the switch on.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import {
  EDITION_SOURCES_DIALOG,
  FOOTER_CREDITS,
  SOURCES_DIALOG,
  footerCreditsShown,
  sourcesDialogOffered,
} from "../src/edition.ts";

const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );

function sourceFiles(dir) {
  const found = [];
  for (const entry of readdirSync(new URL(`../${dir}`, import.meta.url), {
    withFileTypes: true,
  })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (/\.(?:ts|tsx)$/.test(entry.name)) found.push(path);
  }
  return found;
}

test("the live service always has the dialog; the edition has it only when its owner's switch is on", () => {
  for (const ownerSwitch of [false, true]) {
    assert.equal(sourcesDialogOffered(false, ownerSwitch), true, "live");
    assert.equal(footerCreditsShown(false, ownerSwitch), false, "live footer");
  }
  assert.equal(sourcesDialogOffered(true, false), false);
  assert.equal(footerCreditsShown(true, false), false);
  assert.equal(sourcesDialogOffered(true, true), true);
  assert.equal(footerCreditsShown(true, true), true);
  // Run in Node the build flag is unset, so this is the live service whatever
  // the owner's switch says.
  assert.equal(typeof EDITION_SOURCES_DIALOG, "boolean");
  assert.equal(SOURCES_DIALOG, true);
  assert.equal(FOOTER_CREDITS, false);
});

test("the owner's switch is one line that says what it brings back", () => {
  const edition = read("src/edition.ts");
  const declarations =
    edition.match(/^export const EDITION_SOURCES_DIALOG\b.*$/gm) ?? [];
  // One declaration, on one line, in the form scripts/edition-sources-build.mjs
  // flips to make a build with the dialog.
  assert.equal(declarations.length, 1);
  assert.match(
    declarations[0],
    /^export const EDITION_SOURCES_DIALOG: boolean = (?:false|true);$/,
  );
  const comment = edition.slice(
    edition.lastIndexOf("/**", edition.indexOf(declarations[0])),
    edition.indexOf(declarations[0]),
  );
  for (const named of [
    "status pill",
    "Data details",
    "View data coverage",
    "footer",
    "credit",
    "setting it to true gives the dialog and every way into it\n * back",
  ])
    assert.ok(comment.includes(named), `the comment names ${named}`);
});

test("only one place opens the dialog, and the build without it never has it open", () => {
  const app = read("src/App.tsx");
  assert.equal(
    app.match(/setModal\("sources"\)/g)?.length,
    1,
    'setModal("sources") appears once: in openSources',
  );
  assert.match(
    app,
    /const openSources = SOURCES_DIALOG \? \(\) => setModal\("sources"\) : undefined;/,
  );
  // Whatever asked for it, the dialog is not open in a build without it.
  assert.match(
    app,
    /const modal =\s*requestedModal === "sources" && !SOURCES_DIALOG \? null : requestedModal;/,
  );
  // The dialog's own code is still there, and is only drawn with the switch.
  assert.match(
    app,
    /\{SOURCES_DIALOG && modal === "sources" && \(\s*<Modal title="Data & sources"/,
  );
  // The header pill is one of the controls left out.
  assert.match(
    app,
    /\{openSources && \(\s*<button\s+className=\{`source-status \$\{headerStatus\}`\}\s+data-testid="sources-button"/,
  );
  // "Data details" and "View data coverage" likewise, and the strip's action row
  // is left out when it would be empty.
  assert.match(
    app,
    /\{openSources && \(\s*<button onClick=\{openSources\}>\s*Data details/,
  );
  assert.match(
    app,
    /\{openSources && \(\s*<button onClick=\{openSources\}>\s*View data coverage/,
  );
  assert.match(
    app,
    /\{\(statsToggleShown \|\| openSources\) && \(\s*<div className="coverage-actions">/,
  );
});

test("every control that opens the dialog is left out when it has no way to", () => {
  const guarded = {
    "src/components/Monitor.tsx": 1,
    "src/components/ChainExplorer.tsx": 2,
    "src/components/AnalyticsOverview.tsx": 1,
    "src/components/AnalyticsWorkspace.tsx": 2,
    "src/components/AnalyticsCharts.tsx": 1,
  };
  for (const [path, count] of Object.entries(guarded)) {
    const source = read(path);
    assert.match(source, /openSources\?: \(\) => void;/, `${path}: optional`);
    assert.doesNotMatch(
      source,
      /openSources: \(\) => void;/,
      `${path}: no required opener`,
    );
    const buttons = source.match(/onClick=\{openSources\}/g)?.length ?? 0;
    const guards =
      source.match(/\{openSources && \(|openSources \? \(/g)?.length ?? 0;
    assert.equal(buttons, count, `${path}: its buttons`);
    assert.equal(guards, count, `${path}: each button is guarded`);
  }
  // No other file opens the dialog.
  for (const path of sourceFiles("src")) {
    if (path in guarded || path === "src/App.tsx") continue;
    assert.doesNotMatch(
      read(path),
      /setModal\("sources"\)|onClick=\{openSources\}/,
      path,
    );
  }
  // The Jump palette and the keyboard shortcuts have no entry for it.
  assert.doesNotMatch(read("src/components/CommandPalette.tsx"), /sources/i);
  assert.doesNotMatch(read("src/components/ShortcutsDialog.tsx"), /sources/i);
  // A link or reload cannot ask for it: no part of the address names a dialog.
  assert.doesNotMatch(read("src/navigation.ts"), /modal|sources|dialog/i);
});

test("the footer leaves out the Data & sources button and the credit lines as asked", async () => {
  const footer = read("src/components/SiteFooter.tsx");
  assert.match(footer, /onSources\?: \(\) => void;/);
  assert.match(footer, /\{onSources && <button onClick=\{onSources\}>/);
  assert.doesNotMatch(footer, /STATIC_EDITION && </, "no edition-only credit");
  // Rendered in Node (the live flag): the button follows the prop, and the
  // credit lines are not part of the live footer.
  const compile = async (path, replacements = {}) => {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    let output = ts.transpileModule(source, {
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    for (const [specifier, target] of Object.entries({
      react: import.meta.resolve("react"),
      "react/jsx-runtime": import.meta.resolve("react/jsx-runtime"),
      ...replacements,
    }))
      output = output.replaceAll(
        JSON.stringify(specifier),
        JSON.stringify(target),
      );
    return `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`;
  };
  const stub = (body) =>
    `data:text/javascript;base64,${Buffer.from(body).toString("base64")}`;
  const { SiteFooter } = await import(
    await compile("../src/components/SiteFooter.tsx", {
      "../model": stub("export const inlineTime = () => 'a moment ago';"),
      "../edition": new URL("../src/edition.ts", import.meta.url).href,
      "./Primitives": stub(
        "import { jsx } from " +
          JSON.stringify(import.meta.resolve("react/jsx-runtime")) +
          "; export const External = (p) => jsx('a', { href: p.href, children: p.children });",
      ),
      "./EditionStatus": stub("export const SourceCredit = () => null;"),
      "./CommandPalette": stub(
        "export const paletteShortcutLabel = () => 'Ctrl K';",
      ),
    })
  );
  const without = renderToStaticMarkup(
    createElement(SiteFooter, { updatedAt: "2026-10-28T14:05:00.000Z" }),
  );
  assert.doesNotMatch(without, /Data &amp; sources/);
  assert.match(without, /Suggest a hook/);
  const withButton = renderToStaticMarkup(
    createElement(SiteFooter, {
      updatedAt: "2026-10-28T14:05:00.000Z",
      onSources: () => {},
      onJump: () => {},
      onShortcuts: () => {},
    }),
  );
  assert.match(withButton, /<button>Data &amp; sources<\/button>/);
  assert.match(withButton, /Jump to/);
  assert.match(withButton, /Shortcuts/);
  assert.doesNotMatch(withButton, /third-party-notices|Protocol logos/);
});

test("nothing on the page but the footer's notices line links to the notices file, and the file is still published", () => {
  const linking = sourceFiles("src").filter((path) =>
    /third-party-notices/.test(read(path)),
  );
  assert.deepEqual(linking, ["src/components/SiteFooter.tsx"]);
  // It is still in the public folder, and so in every build.
  assert.ok(read("public/third-party-notices.txt").length > 0);
});

test("the guide does not point to data details when there are none", () => {
  const learn = read("src/components/LearnHooks.tsx");
  assert.match(
    learn,
    /\{SOURCES_DIALOG\s*\? "Use data details to understand what each figure covers\."\s*: "Read the scope label beside a figure to see what it covers\."\}/,
  );
});
