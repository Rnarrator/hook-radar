import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  documentedImports,
  importsOutsideCollector,
} from "../collector/tools/imports.mjs";

test("collector/IMPORTS.md lists exactly the files outside collector/ that the collector imports", async () => {
  const documented = documentedImports(
    await readFile(
      fileURLToPath(new URL("../collector/IMPORTS.md", import.meta.url)),
      "utf8",
    ),
  );
  const actual = importsOutsideCollector();
  assert.deepEqual(
    documented,
    actual,
    "Regenerate with `node collector/tools/imports.mjs` and update collector/IMPORTS.md.",
  );
});

test("the collector imports nothing from the live server's runtime or storage", () => {
  const outside = importsOutsideCollector();
  for (const forbidden of [
    "server/store.mjs",
    "server/index.mjs",
    "server/http.mjs",
    "server/market-enricher.mjs",
    "server/provider-fetch.mjs",
  ])
    assert.equal(outside.includes(forbidden), false, forbidden);
  assert.ok(outside.every((file) => /^(server|shared|src)\//.test(file)));
});

test("the one provider module of the live app that the collector imports is the stateless Frontier producer, and it reaches nothing of the runtime", async () => {
  // server/providers.mjs holds the live app's own reading of Frontier's market
  // figures. The collector runs it unchanged instead of copying it, so the two
  // cannot drift. It is a set of functions: it imports the directory model and
  // the reserve rules only, never the store, the HTTP server or a cache.
  const outside = importsOutsideCollector();
  assert.ok(outside.includes("server/providers.mjs"));
  const text = await readFile(
    fileURLToPath(new URL("../server/providers.mjs", import.meta.url)),
    "utf8",
  );
  const imports = [...text.matchAll(/from\s+["'](\.[^"']+)["']/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(imports.sort(), ["./model.mjs", "./reserve-value.mjs"]);
  assert.doesNotMatch(text, /\bfrom\s+["']node:(?:fs|net|http|https)/);
});
