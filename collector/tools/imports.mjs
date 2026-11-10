#!/usr/bin/env node
// Lists every file outside collector/ that the collector imports, directly or
// through other modules, so packaging can copy exactly those. collector/IMPORTS.md
// is checked against this list by tests/collector-imports.test.mjs.
//
//   node collector/tools/imports.mjs           print the list
//   node collector/tools/imports.mjs --check   fail when IMPORTS.md differs
import { readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const ENTRY_POINTS = [
  "collector/run.mjs",
  "collector/export-seed.mjs",
  "collector/tools/record-fixtures.mjs",
  "collector/tools/imports.mjs",
];

const SPECIFIER =
  /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\sfrom\s+)?["'](\.{1,2}\/[^"']+)["']|import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;
const SUFFIXES = ["", ".ts", ".mjs", ".js", ".tsx", "/index.ts", "/index.mjs"];

const isFile = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

function resolveSpecifier(from, specifier) {
  const base = resolve(dirname(from), specifier);
  for (const suffix of SUFFIXES)
    if (isFile(`${base}${suffix}`)) return `${base}${suffix}`;
  throw new Error(`Cannot resolve ${specifier} from ${relative(ROOT, from)}`);
}

/** Every local module reachable from the entry points, as repo-relative paths. */
export function importClosure(entries = ENTRY_POINTS, root = ROOT) {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(SPECIFIER))
      visit(resolveSpecifier(file, match[1] || match[2]));
  };
  for (const entry of entries) visit(resolve(root, entry));
  return [...seen]
    .map((file) => relative(root, file).replaceAll("\\", "/"))
    .sort();
}

export const importsOutsideCollector = (entries, root) =>
  importClosure(entries, root).filter((file) => !file.startsWith("collector/"));

/** The paths IMPORTS.md lists, in backticks at the start of a bullet. */
export function documentedImports(markdown) {
  return [...markdown.matchAll(/^- `([^`]+)`/gm)]
    .map((match) => match[1])
    .sort();
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const files = importsOutsideCollector();
  if (process.argv.includes("--check")) {
    const documented = documentedImports(
      readFileSync(resolve(ROOT, "collector", "IMPORTS.md"), "utf8"),
    );
    const missing = files.filter((file) => !documented.includes(file));
    const extra = documented.filter((file) => !files.includes(file));
    if (missing.length || extra.length) {
      console.error(
        `IMPORTS.md is out of date. Missing: ${missing.join(", ") || "none"}. Not imported: ${extra.join(", ") || "none"}.`,
      );
      process.exitCode = 1;
    } else console.log(`IMPORTS.md lists all ${files.length} imported files.`);
  } else console.log(files.join("\n"));
}
