import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { publicMetadata } from "./scripts/public-metadata.ts";

/**
 * Auto Snapshot edition. Every branch below is taken only when the build is
 * started with VITE_STATIC_EDITION=1; with the flag unset the configuration is
 * the live application's, plugin for plugin.
 */

/** "./" (works under any path) unless VITE_BASE names a path such as /repo/. */
export function editionBase(value: string | undefined): string {
  const raw = (value ?? "").trim();
  if (raw === "" || raw === "./") return "./";
  if (raw === "/") return "/";
  const path = `/${raw.replace(/^\/+|\/+$/g, "")}/`;
  const segments = path.split("/").filter(Boolean);
  if (
    !/^\/(?:[A-Za-z0-9._~-]+\/)+$/.test(path) ||
    segments.some((segment) => /^\.+$/.test(segment))
  )
    throw new Error(
      "VITE_BASE must be ./ or a plain path such as /repository-name/",
    );
  return path;
}

/** The public https address of the finished site, used only for share images. */
export function editionSiteUrl(value: string | undefined): string | null {
  if (value === undefined || value === "") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("VITE_SITE_URL must be a valid HTTPS address");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "VITE_SITE_URL must be an HTTPS address without credentials, query or fragment",
    );
  return url.href.endsWith("/") ? url.href : `${url.href}/`;
}

const NOSCRIPT_BLOCK = /(<noscript\b[^>]*>)([\s\S]*?)(<\/noscript\s*>)/;
const ROOT_ELEMENT = /<html\b(?![^>]*\sdata-edition=)([^>]*)>/;

/**
 * The page of the Auto Snapshot edition, from the live index.html. The
 * no-script notice says what this edition shows (a published snapshot, not
 * "current market data"), and the root element carries data-edition="snapshot"
 * so the few stylesheet rules that only the edition wants (phone-width target
 * sizes, wrapping of long source notes) are scoped to it and the live page,
 * which never gets the attribute, renders exactly as before.
 */
export function editionPage(html: string): string {
  return html
    .replace(
      NOSCRIPT_BLOCK,
      (_all, open: string, text: string, close: string) =>
        `${open}${text.replace(
          /display current market\s+data\./,
          "read the latest published snapshot.",
        )}${close}`,
    )
    .replace(ROOT_ELEMENT, '<html$1 data-edition="snapshot">');
}

const EARLY_DISCOVERY_TAG =
  /[ \t]*<script\b[^>]*\bsrc="\/early-discovery\.js"[^>]*>\s*<\/script>[ \t]*\r?\n?/;
const SHARE_IMAGE_TAG =
  /[ \t]*<meta\s+(?:property|name)="(?:og:image(?::[a-z]+)?|twitter:image(?::alt)?)"[^>]*>[ \t]*\r?\n?/g;

/**
 * Starts the snapshot download while the scripts are still loading, and hands
 * the request itself to the page (src/App.tsx fetchSnapshot takes it once, see
 * takeEarlySnapshot in src/edition-data.ts). It is the page's own request, with
 * the page's own cache mode (`no-cache`: the host revalidates). An earlier
 * version added a `<link rel=preload>`, which is a default-mode request: a host
 * that sends `max-age` on /data then answered the page's revalidating fetch
 * from that stored copy, and the old snapshot stayed on screen even after F5.
 *
 * It is a tiny inline script, not a static tag, because the page does not ask
 * for the snapshot at start-up on every address. The mount effect in
 * src/App.tsx skips it for ?view=learn and ?view=analytics (Analytics opens from
 * its own overview file; a project in the address still needs the snapshot), and
 * a request nobody consumes costs the whole download. The script reads the
 * address the way parseNavigation does (URLSearchParams, first value). The
 * request can be cancelled through `abort`, so the page's stall guard ends it as
 * it ends a request of its own; a copy of the promise carries a no-op catch, so
 * a request the page never takes does not log an unhandled rejection.
 *
 * It must be the first element of the head, in front of the stylesheet and the
 * module script: a classic script waits for earlier stylesheets, and placed
 * after them the request starts about 1.5 seconds later on a slow phone.
 */
export function editionPreload(base: string): string {
  const href = JSON.stringify(`${base}data/snapshot.json`);
  const script = [
    "try{",
    'var q=new URLSearchParams(location.search),v=q.get("view");',
    'if(!((v==="learn"||v==="analytics")&&!q.get("project"))){',
    `var u=${href},c=new AbortController(),`,
    'p=fetch(u,{cache:"no-cache",signal:c.signal});',
    "p.catch(function(){});",
    "window.__hookRadarSnapshot={url:u,abort:function(){c.abort()},promise:p}",
    "}",
    "}catch(e){}",
  ].join("");
  return `    <script>${script}</script>\n`;
}

/** The character set declaration, which has to come first in the head. */
const CHARSET_TAG = /<meta\s+charset=[^>]*>[ \t]*\r?\n?/i;

/**
 * Drops the live early request and share images that would point at the wrong
 * host. With `base`, adds the snapshot preload for a site served from there.
 */
export function editionHtml(
  html: string,
  siteUrl: string | null,
  base?: string,
): string {
  const withoutEarly = html.replace(EARLY_DISCOVERY_TAG, "");
  // First in the head, straight after the character set when there is one.
  const hinted =
    base === undefined
      ? withoutEarly
      : CHARSET_TAG.test(withoutEarly)
        ? withoutEarly.replace(
            CHARSET_TAG,
            (charset) =>
              `${charset.endsWith("\n") ? charset : `${charset}\n`}${editionPreload(base)}`,
          )
        : withoutEarly.replace(
            /<head(?:\s[^>]*)?>[ \t]*\r?\n?/i,
            (open) =>
              `${open.endsWith("\n") ? open : `${open}\n`}${editionPreload(base)}`,
          );
  if (siteUrl)
    return hinted.replaceAll(
      'content="/social-card.png"',
      `content="${siteUrl}social-card.png"`,
    );
  if (/property="og:image"\s+content="https:\/\//.test(hinted)) return hinted;
  return hinted.replace(SHARE_IMAGE_TAG, "");
}

/**
 * Root-absolute public file literals in source become base-aware, and so do
 * links back into the app itself ("/?project=x"): at /repo/ they must stay in
 * /repo/ instead of leaving the site for the host's root.
 */
export function editionAssetPaths(
  code: string,
  base: string,
  names: { directories: string[]; files: string[] },
): string {
  const escape = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let out = code.replace(
    /(["'`])\/\?/g,
    (_all, quote: string) => `${quote}${base}?`,
  );
  if (names.directories.length)
    out = out.replace(
      new RegExp(`(["'\`])/(${names.directories.map(escape).join("|")})/`, "g"),
      (_all, quote: string, name: string) => `${quote}${base}${name}/`,
    );
  if (names.files.length)
    out = out.replace(
      new RegExp(`(["'\`])/(${names.files.map(escape).join("|")})\\1`, "g"),
      (_all, quote: string, name: string) => `${quote}${base}${name}${quote}`,
    );
  return out;
}

/** The web app manifest, relative to where the site is served from. */
export function editionManifest(text: string): string {
  const relative = (value: unknown) =>
    typeof value === "string" && value.startsWith("/") ? `.${value}` : value;
  const manifest = JSON.parse(text) as Record<string, unknown>;
  for (const key of ["id", "start_url", "scope"])
    if (key in manifest) manifest[key] = relative(manifest[key]);
  if (Array.isArray(manifest.icons))
    manifest.icons = manifest.icons.map((icon: Record<string, unknown>) => ({
      ...icon,
      src: relative(icon.src),
    }));
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * The .htaccess the build writes next to index.html, for Apache hosts such as
 * Namecheap shared hosting (cPanel). Other hosts ignore it. It is written by the
 * edition build only and not kept under public/, so the live build and its
 * release package never see a dotfile. Compression matters: snapshot.json is
 * about 10 MB as JSON and about 1 MB gzipped.
 */
export const EDITION_HTACCESS = [
  "# Hook Radar, Auto Snapshot edition. Written by the build for Apache hosts",
  "# (cPanel shared hosting). Other hosts ignore this file.",
  "",
  "# Compress text answers; the data file is about ten times smaller that way.",
  "<IfModule mod_deflate.c>",
  "  AddOutputFilterByType DEFLATE application/json text/css application/javascript text/javascript image/svg+xml text/html text/plain application/manifest+json",
  "</IfModule>",
  "",
  "# The data files are renewed every few hours: have the browser ask again before",
  "# it reuses a stored copy. An unchanged file is answered with a short 304.",
  "<IfModule mod_headers.c>",
  '  <FilesMatch "\\.json$">',
  '    Header set Cache-Control "no-cache"',
  "  </FilesMatch>",
  "</IfModule>",
  "",
].join("\n");

/**
 * Files of public/ that nothing in the edition's page references, so the built
 * site does not ship them: the previous identity's font (IBM Plex Mono: the
 * stylesheets use Geist, Geist Mono and Press Start 2P; 272 KB) with its
 * licence text, and the protocol logo manifest and its README (provenance
 * records for the repository, read by its tests, not by the page; 60 KB). They
 * stay in the repository and in the live build. Paths are relative to the
 * output folder; a name ending in "-" is a prefix.
 */
export const EDITION_LEFT_OUT = [
  "fonts/IBMPlexMono-",
  "protocols/sources.json",
  "protocols/README.md",
] as const;

/** The files of `dir` (a built edition) that EDITION_LEFT_OUT names. */
export function editionLeftOutFiles(dir: string): string[] {
  const found: string[] = [];
  for (const rule of EDITION_LEFT_OUT) {
    if (!rule.endsWith("-")) {
      found.push(rule);
      continue;
    }
    const slash = rule.lastIndexOf("/");
    const folder = rule.slice(0, slash);
    const prefix = rule.slice(slash + 1);
    const names = existsSync(join(dir, folder))
      ? readdirSync(join(dir, folder))
      : [];
    for (const name of names)
      if (name.startsWith(prefix)) found.push(`${folder}/${name}`);
  }
  return found;
}

function staticEditionPlugins(base: string, siteUrl: string | null): Plugin[] {
  let publicNames = { directories: ["data"], files: [] as string[] };
  let ownHtaccess = false;
  return [
    {
      name: "hook-radar-static-edition-html-pre",
      transformIndexHtml: {
        order: "pre",
        handler: (html) => editionPage(html.replace(EARLY_DISCOVERY_TAG, "")),
      },
    },
    {
      name: "hook-radar-static-edition-html-post",
      transformIndexHtml: {
        order: "post",
        handler: (html) => editionHtml(html, siteUrl, base),
      },
    },
    {
      name: "hook-radar-static-edition-assets",
      enforce: "pre",
      configResolved(config) {
        if (!config.publicDir || !existsSync(config.publicDir)) return;
        ownHtaccess = existsSync(join(config.publicDir, ".htaccess"));
        const entries = readdirSync(config.publicDir, { withFileTypes: true });
        publicNames = {
          directories: [
            ...new Set([
              "data",
              ...entries.filter((e) => e.isDirectory()).map((e) => e.name),
            ]),
          ],
          files: entries.filter((e) => e.isFile()).map((e) => e.name),
        };
      },
      transform(code, id) {
        if (!/[\\/]src[\\/][^?]+\.(?:ts|tsx)(?:\?.*)?$/.test(id)) return null;
        if (id.includes("node_modules")) return null;
        const next = editionAssetPaths(code, base, publicNames);
        return next === code ? null : { code: next, map: null };
      },
      writeBundle(options) {
        if (!options.dir) return;
        rmSync(join(options.dir, "early-discovery.js"), { force: true });
        for (const file of editionLeftOutFiles(options.dir))
          rmSync(join(options.dir, file), { force: true });
        // A file the owner keeps under public/ wins over the generated one.
        if (!ownHtaccess)
          writeFileSync(join(options.dir, ".htaccess"), EDITION_HTACCESS);
        const manifest = join(options.dir, "site.webmanifest");
        if (existsSync(manifest))
          writeFileSync(
            manifest,
            editionManifest(readFileSync(manifest, "utf8")),
          );
      },
    },
  ];
}

export default defineConfig(({ mode }) => {
  const edition = loadEnv(mode, process.cwd(), "VITE_");
  const staticEdition = edition.VITE_STATIC_EDITION === "1";
  const base = staticEdition ? editionBase(edition.VITE_BASE) : "/";
  const siteUrl = staticEdition ? editionSiteUrl(edition.VITE_SITE_URL) : null;
  return {
    ...(staticEdition ? { base } : {}),
    plugins: [
      react(),
      {
        name: "hook-radar-public-metadata",
        transformIndexHtml() {
          const settings = loadEnv(mode, process.cwd(), "RADAR_PUBLIC_ORIGIN");
          return publicMetadata(settings.RADAR_PUBLIC_ORIGIN);
        },
      },
      ...(staticEdition ? staticEditionPlugins(base, siteUrl) : []),
    ],
    optimizeDeps: { entries: ["index.html"] },
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      watch: {
        ignored: ["**/.radar-cache/**", "**/work/**", "**/test-results/**"],
      },
      proxy: { "/api": "http://127.0.0.1:4174" },
    },
    build: { sourcemap: false, target: "es2022" },
  };
});
