import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStaticEditionServer } from "../scripts/static-edition-server.mjs";

const dataDir = new URL("./fixtures/static-data/data", import.meta.url)
  .pathname.replace(/^\/([A-Za-z]:)/, "$1");

function makeDist() {
  const dist = mkdtempSync(join(tmpdir(), "edition-dist-"));
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>x</title>");
  writeFileSync(join(dist, "assets", "app-abc.js"), "export {}");
  writeFileSync(join(tmpdir(), "edition-secret.txt"), "secret");
  return dist;
}

test("it serves the page, the assets and the data files like a static host", async (t) => {
  const dist = makeDist();
  const server = await startStaticEditionServer({ distDir: dist, dataDir });
  t.after(async () => {
    await server.close();
    rmSync(dist, { recursive: true, force: true });
  });
  const page = await fetch(`${server.origin}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  const asset = await fetch(`${server.origin}/assets/app-abc.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("cache-control"), /immutable/);
  const snapshot = await fetch(`${server.origin}/data/snapshot.json`);
  assert.equal(snapshot.status, 200);
  assert.equal((await snapshot.json()).schemaVersion, 1);
  const etag = snapshot.headers.get("etag");
  const again = await fetch(`${server.origin}/data/snapshot.json`, {
    headers: { "If-None-Match": etag },
  });
  assert.equal(again.status, 304);
  assert.equal((await fetch(`${server.origin}/data/missing.json`)).status, 404);
  assert.equal((await fetch(`${server.origin}/nothing.js`)).status, 404);
});

test("every service path is a recorded 404 and nothing else is", async (t) => {
  const dist = makeDist();
  const server = await startStaticEditionServer({ distDir: dist, dataDir });
  t.after(async () => {
    await server.close();
    rmSync(dist, { recursive: true, force: true });
  });
  await fetch(`${server.origin}/data/snapshot.json`);
  assert.deepEqual(server.apiRequests(), []);
  for (const path of [
    "/api/snapshot",
    "/api/discovery?search=",
    "/api/analytics/overview?chain=all&window=h24",
    "/api/projects/alpha/view",
  ]) {
    const response = await fetch(`${server.origin}${path}`);
    assert.equal(response.status, 404, path);
    assert.match(response.headers.get("content-type"), /application\/json/);
  }
  const post = await fetch(`${server.origin}/api/refresh`, { method: "POST" });
  assert.equal(post.status, 404);
  assert.equal(server.apiRequests().length, 5);
  assert.equal(server.apiRequests().at(-1).method, "POST");
  assert.equal(server.dataRequests().length, 1);
  assert.equal(server.requests.length, 6);
});

test("a path cannot climb out of the dist or the data folder", async (t) => {
  const dist = makeDist();
  const server = await startStaticEditionServer({ distDir: dist, dataDir });
  t.after(async () => {
    await server.close();
    rmSync(dist, { recursive: true, force: true });
  });
  for (const path of [
    "/../edition-secret.txt",
    "/%2e%2e/edition-secret.txt",
    "/assets/..%2f..%2fedition-secret.txt",
    "/data/..%2f..%2f..%2fpackage.json",
    "/data/%2e%2e/%2e%2e/package.json",
  ]) {
    const response = await fetch(`${server.origin}${path}`);
    assert.equal(response.status, 404, path);
  }
});

test("under a sub-path the site answers there and nowhere else", async (t) => {
  const dist = makeDist();
  const server = await startStaticEditionServer({
    distDir: dist,
    dataDir,
    mount: "/repo/",
  });
  t.after(async () => {
    await server.close();
    rmSync(dist, { recursive: true, force: true });
  });
  assert.equal(server.url, `${server.origin}/repo/`);
  assert.equal((await fetch(`${server.origin}/repo/`)).status, 200);
  assert.equal((await fetch(`${server.origin}/repo/index.html`)).status, 200);
  assert.equal((await fetch(`${server.origin}/repo/data/history.json`)).status, 200);
  assert.equal((await fetch(`${server.origin}/`)).status, 404);
  assert.equal((await fetch(`${server.origin}/data/history.json`)).status, 404);
});

test("a test can replace or remove one data file", async (t) => {
  const dist = makeDist();
  const server = await startStaticEditionServer({ distDir: dist, dataDir });
  t.after(async () => {
    await server.close();
    rmSync(dist, { recursive: true, force: true });
  });
  server.setData("history.json", { schemaVersion: 1, points: [] });
  assert.deepEqual(
    await (await fetch(`${server.origin}/data/history.json`)).json(),
    { schemaVersion: 1, points: [] },
  );
  server.setData("history.json", null);
  assert.equal((await fetch(`${server.origin}/data/history.json`)).status, 404);
});
