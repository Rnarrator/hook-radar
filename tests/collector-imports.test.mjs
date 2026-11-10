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
    "server/providers.mjs",
    "server/provider-fetch.mjs",
  ])
    assert.equal(outside.includes(forbidden), false, forbidden);
  assert.ok(outside.every((file) => /^(server|shared|src)\//.test(file)));
});
