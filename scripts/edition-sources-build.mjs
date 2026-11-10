// An edition build with EDITION_SOURCES_DIALOG set to true, made from the same
// source without editing it, for the browser tests of what the Data & sources
// dialog says and of the claim that one line in src/edition.ts brings the
// dialog, every way into it and the footer credits back.
//
// The shipped edition hides all of that (the owner's choice), so its own build
// has no dialog to open. A test that needs the dialog asks for this build:
//
//   import { sourcesDialogDist } from "./edition-sources-build.mjs";
//   const SOURCES_DIST = await sourcesDialogDist();
//
// The build goes to a folder under the system temp directory named after a hash
// of the sources, so every test file of one run (and later runs, until the code
// changes) reuses it. RADAR_TEST_SOURCES_DIST names a build made this way
// elsewhere. The switch is flipped by a Vite transform of src/edition.ts, which
// fails loudly when the line it flips is not found, never by a copy of the code.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EDITION_SOURCE = join(root, "src", "edition.ts");
const OFF = "export const EDITION_SOURCES_DIALOG: boolean = false;";
const ON = "export const EDITION_SOURCES_DIALOG: boolean = true;";
const MARKER = ".sources-dialog-build-complete";

/** Whether src/edition.ts itself already has the dialog switched on: the
 * owner's choice was reversed, and the edition's own build has it. */
export function ownerShowsSources() {
  return readFileSync(EDITION_SOURCE, "utf8").includes(ON);
}

function filesUnder(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(path));
    else found.push(path);
  }
  return found.sort();
}

/** A hash of everything the build is made from (not the published data). */
function sourceHash() {
  const hash = createHash("sha256");
  const inputs = [
    ...filesUnder(join(root, "src")),
    join(root, "index.html"),
    join(root, "vite.config.ts"),
    join(root, "package.json"),
    join(root, "scripts", "public-metadata.ts"),
  ];
  for (const path of inputs) {
    hash.update(path.slice(root.length));
    hash.update(readFileSync(path).toString("utf8").replace(/\r\n/g, "\n"));
  }
  for (const path of filesUnder(join(root, "public")).filter(
    (file) => !/[\\/]data[\\/]/.test(file),
  )) {
    hash.update(`${path.slice(root.length)}:${statSync(path).size}`);
  }
  return hash.digest("hex").slice(0, 16);
}

/** The folder of an edition build whose dialog switch is on. Built once per
 * change of the sources. */
export async function sourcesDialogDist() {
  if (process.env.RADAR_TEST_SOURCES_DIST)
    return resolve(process.env.RADAR_TEST_SOURCES_DIST);
  const outDir = join(tmpdir(), `hook-radar-sources-dialog-${sourceHash()}`);
  if (existsSync(join(outDir, MARKER))) return outDir;
  mkdirSync(outDir, { recursive: true });
  const { build } = await import("vite");
  const previous = {
    VITE_STATIC_EDITION: process.env.VITE_STATIC_EDITION,
    VITE_BASE: process.env.VITE_BASE,
    VITE_SITE_URL: process.env.VITE_SITE_URL,
  };
  process.env.VITE_STATIC_EDITION = "1";
  process.env.VITE_BASE = "./";
  delete process.env.VITE_SITE_URL;
  try {
    await build({
      root,
      configFile: join(root, "vite.config.ts"),
      logLevel: "error",
      plugins: [
        {
          name: "edition-sources-dialog-on",
          enforce: "pre",
          transform(code, id) {
            if (!/[\\/]src[\\/]edition\.ts(?:\?.*)?$/.test(id)) return null;
            const normal = code.replace(/\r\n/g, "\n");
            // Already on (the owner brought the dialog back): nothing to flip.
            if (normal.includes(ON)) return null;
            if (!normal.includes(OFF))
              throw new Error(
                `src/edition.ts has no line "${OFF}" to switch on: the switch was renamed or reworded.`,
              );
            return { code: normal.replace(OFF, ON), map: null };
          },
        },
      ],
      build: { outDir, emptyOutDir: true },
    });
  } finally {
    for (const [name, value] of Object.entries(previous))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
  writeFileSync(join(outDir, MARKER), new Date().toISOString());
  return outDir;
}
