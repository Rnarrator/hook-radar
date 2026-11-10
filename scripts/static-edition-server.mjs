// A tiny static file server for testing the Auto Snapshot edition. It serves a
// built `dist` and a data folder (as `/data/`), the way GitHub Pages or any
// static host would, and nothing else: every `/api` path answers 404 JSON, and
// every request is recorded so a test can prove the page never asked a service.
//
//   node scripts/static-edition-server.mjs --dist <dir> --data <dir> [--port 4180] [--mount /repo/] [--gzip] [--data-max-age 14400]
//
// --gzip compresses text answers for clients that accept it, the way GitHub
// Pages, Cloudflare Pages and Vercel do; without it nothing is compressed, like
// a shared host that has not switched compression on. Use it to measure load
// times as a visitor of a real host would see them.
//
// --data-max-age <seconds> (the `cacheControl` option, a header value) makes every
// /data answer storable by the browser for that long, as a host or CDN that sets
// a time to live does ("public, max-age=14400"). Without it /data always
// revalidates, like the build's .htaccess asks of an Apache host.
//
// No packages. Never serves production data: the data folder is whatever the
// caller names (the tests use tests/fixtures/static-data/data).
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
};

const normalizeMount = (mount) => {
  const value = `/${String(mount || "/").replace(/^\/+|\/+$/g, "")}/`;
  return value === "//" ? "/" : value;
};

// What a CDN compresses: text. Images and fonts are already compact.
const COMPRESSIBLE =
  /^(?:text\/|application\/(?:json|manifest\+json)|image\/svg\+xml)/;

/** True when the Accept-Encoding header allows gzip (and does not say q=0). */
const acceptsGzip = (header) =>
  String(header || "")
    .split(",")
    .some((part) => {
      const [name, ...params] = part.trim().toLowerCase().split(";");
      if (name.trim() !== "gzip" && name.trim() !== "*") return false;
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      return q === undefined || Number(q.slice(2)) > 0;
    });

/** @returns {Promise<{origin:string,url:string,mount:string,requests:object[],apiRequests:()=>object[],dataRequests:()=>object[],setData:(name:string,body:string|object|null)=>void,close:()=>Promise<void>}>} */
export async function startStaticEditionServer({
  distDir,
  dataDir,
  mount = "/",
  port = 0,
  host = "127.0.0.1",
  gzip = false,
  cacheControl = null,
} = {}) {
  if (!distDir) throw new Error("startStaticEditionServer needs a distDir");
  const dist = resolve(distDir);
  const data = dataDir ? resolve(dataDir) : null;
  const base = normalizeMount(mount);
  const requests = [];
  // name -> string | object (served instead of the file) | null (not found)
  const overrides = new Map();

  const send = (res, status, headers, body, record) => {
    record.status = status;
    res.writeHead(status, headers);
    res.end(body);
  };
  const within = (root, path) => {
    const full = resolve(root, `.${sep}${normalize(path)}`);
    return full === root || full.startsWith(root + sep) ? full : null;
  };

  // gzip bodies by the identity body's hash, so a large file is compressed once.
  const compressed = new Map();

  const server = createServer(async (req, res) => {
    let url;
    try {
      // "//" and "//host/x" are network-path references, not paths of this site.
      if (req.url.startsWith("//")) throw new TypeError("not an absolute path");
      url = new URL(req.url, "http://static-host");
    } catch {
      const bad = {
        method: req.method,
        path: String(req.url),
        query: "",
        at: Date.now(),
        status: 0,
      };
      requests.push(bad);
      return send(
        res,
        400,
        { "Content-Type": "text/plain" },
        "Bad request",
        bad,
      );
    }
    const record = {
      method: req.method,
      path: url.pathname,
      query: url.search,
      at: Date.now(),
      status: 0,
    };
    requests.push(record);
    try {
      let path;
      try {
        path = decodeURIComponent(url.pathname);
      } catch {
        return send(
          res,
          400,
          { "Content-Type": "text/plain" },
          "Bad request",
          record,
        );
      }
      if (/(^|\/)api(\/|$)/.test(path))
        return send(
          res,
          404,
          { "Content-Type": "application/json" },
          JSON.stringify({ error: "This static host has no service." }),
          record,
        );
      if (req.method !== "GET" && req.method !== "HEAD")
        return send(res, 405, { Allow: "GET, HEAD" }, "", record);
      // The mount is where the site lives (a project page sits under /repo/).
      const bare = path.endsWith("/") ? path : `${path}/`;
      if (!path.startsWith(base) && bare !== base)
        return send(
          res,
          404,
          { "Content-Type": "text/plain" },
          "Not found",
          record,
        );
      let relative = path.slice(base.length - 1).replace(/^\/+/, "");
      if (relative === "" || relative.endsWith("/")) relative += "index.html";

      let body;
      let type;
      if (relative.startsWith("data/")) {
        const name = relative.slice("data/".length);
        if (overrides.has(name)) {
          const value = overrides.get(name);
          if (value === null)
            return send(
              res,
              404,
              { "Content-Type": "text/plain" },
              "Not found",
              record,
            );
          body = Buffer.from(
            typeof value === "string" ? value : JSON.stringify(value),
          );
        } else {
          const file = data ? within(data, name) : null;
          if (!file || !(await stat(file).catch(() => null))?.isFile())
            return send(
              res,
              404,
              { "Content-Type": "text/plain" },
              "Not found",
              record,
            );
          body = await readFile(file);
        }
        type = TYPES[extname(relative)] || "application/octet-stream";
      } else {
        const file = within(dist, relative);
        if (!file || !(await stat(file).catch(() => null))?.isFile())
          return send(
            res,
            404,
            { "Content-Type": "text/plain" },
            "Not found",
            record,
          );
        body = await readFile(file);
        type = TYPES[extname(file)] || "application/octet-stream";
      }
      const hash = createHash("sha1").update(body).digest("hex");
      let etag = `"${hash}"`;
      const headers = {
        "Content-Type": type,
        ETag: etag,
        "Cache-Control": relative.startsWith("assets/")
          ? "public, max-age=31536000, immutable"
          : relative.startsWith("data/") && cacheControl
            ? cacheControl
            : "public, max-age=0, must-revalidate",
      };
      if (gzip && COMPRESSIBLE.test(type)) {
        headers.Vary = "Accept-Encoding";
        if (acceptsGzip(req.headers["accept-encoding"])) {
          if (!compressed.has(hash)) compressed.set(hash, gzipSync(body));
          body = compressed.get(hash);
          headers["Content-Encoding"] = "gzip";
          // A compressed body is another representation: it has its own ETag.
          etag = headers.ETag = `"${hash}-gzip"`;
        }
      }
      if (req.headers["if-none-match"] === etag)
        return send(res, 304, headers, "", record);
      send(
        res,
        200,
        { ...headers, "Content-Length": body.length },
        req.method === "HEAD" ? "" : body,
        record,
      );
    } catch (error) {
      send(
        res,
        500,
        { "Content-Type": "text/plain" },
        String(error?.message || error),
        record,
      );
    }
  });
  await new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(port, host, done);
  });
  const origin = `http://${host}:${server.address().port}`;
  const isApi = (row) => /(^|\/)api(\/|$)/.test(row.path);
  return {
    origin,
    url: `${origin}${base}`,
    mount: base,
    requests,
    apiRequests: () => requests.filter(isApi),
    dataRequests: () =>
      requests.filter((row) => row.path.startsWith(`${base}data/`)),
    setData(name, body) {
      overrides.set(name, body);
    },
    close: () =>
      new Promise((done) => {
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const at = args.indexOf(`--${name}`);
    return at >= 0 ? args[at + 1] : fallback;
  };
  const running = await startStaticEditionServer({
    distDir: option("dist", "dist"),
    dataDir: option("data", join("tests", "fixtures", "static-data", "data")),
    mount: option("mount", "/"),
    port: Number(option("port", 4180)),
    gzip: args.includes("--gzip"),
    cacheControl: option("data-max-age")
      ? `public, max-age=${Number(option("data-max-age"))}`
      : null,
  });
  console.log(`Serving the static edition at ${running.url}`);
}
