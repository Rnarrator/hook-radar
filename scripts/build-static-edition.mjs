// Builds the Auto Snapshot edition: the same type check and Vite build as the
// live application, with VITE_STATIC_EDITION=1 set the same way on Windows,
// macOS and Linux. Other arguments go to `vite build` (for example --outDir).
//
//   node scripts/build-static-edition.mjs [--require-data] [vite build options]
//
// --require-data stops before building unless public/data holds a real
// snapshot (see scripts/check-edition-data.mjs): one that is missing, or that
// came from an offline fixture replay, never becomes a site by accident.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publishBlockers } from "./check-edition-data.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const args = process.argv.slice(2);
const requireData = args.includes("--require-data");
const viteArgs = args.filter((arg) => arg !== "--require-data");

if (requireData) {
  const blockers = await publishBlockers(join(root, "public", "data"));
  if (blockers.length) {
    console.error("public/data is not fit to publish (--require-data):");
    for (const problem of blockers) console.error(`  - ${problem}`);
    console.error("Run `npm run collect`, or build without --require-data.");
    process.exit(1);
  }
}

const env = { ...process.env, VITE_STATIC_EDITION: "1" };
const run = (label, script, scriptArgs) => {
  const result = spawnSync(process.execPath, [script, ...scriptArgs], {
    cwd: root,
    env,
    stdio: "inherit",
  });
  if (result.error || result.status !== 0) {
    console.error(
      `${label} failed${result.error ? `: ${result.error.message}` : ""}.`,
    );
    process.exit(result.status || 1);
  }
};

run("Type check", require.resolve("typescript/bin/tsc"), ["-b"]);
run(
  "Static edition build",
  join(dirname(require.resolve("vite/package.json")), "bin", "vite.js"),
  ["build", ...viteArgs],
);
