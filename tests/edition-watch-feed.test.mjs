// The watchlist's "What changed" feed in the Auto Snapshot edition.
//
// The edition compares saved projects with one published snapshot file, so the
// feed has to speak in snapshot times (UTC), not in the moment of the visit or
// the visitor's zone, and it has no reason to look again every 30 seconds. The
// live page keeps its loop, its "checking" state and its local-time text; the
// tests below pin both sides.
//
// The last group drives a real browser against an edition build:
//
//   RADAR_TEST_DIST=dist/test-build \
//     node --test tests/edition-watch-feed.test.mjs
//
// It serves the deterministic TEST data in tests/fixtures/static-data/data
// (RADAR_TEST_DATA may name another snapshot folder, such as a real collection
// run kept outside the repository) through scripts/static-edition-server.mjs,
// which answers every /api path with 404. Without RADAR_TEST_DIST, or with a
// build that is not an edition build, the browser tests are skipped.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { makeSnapshot } from "./fixtures.mjs";
import {
  WATCH_CHANGES_KEY,
  WATCH_RECHECK_MS,
  decodeWatchChanges,
  emptyWatchChanges,
  observeWatchChanges,
  readMark,
  trackedBaselines,
  watchBaseline,
  watchRecheckDelay,
} from "../src/watch-changes.ts";
import { fullTimeLabel, timeLabel, utcDate } from "../src/edition.ts";

const first = "2026-10-17T09:00:00.000Z";
const second = "2026-10-17T09:05:00.000Z";
// The snapshot of the feed tests, the one before it (late on the previous
// UTC day, which is already the next day in Bangkok) and a visit after both.
const SNAP = "2026-10-28T14:05:00.000Z";
const PREV = "2026-10-27T18:30:00.000Z";
const VISIT = "2026-10-28T15:30:00.000Z";

function project() {
  const p = structuredClone(makeSnapshot().projects[0]);
  p.poolInventory = { poolCount: 20, complete: true, chains: { base: 20 } };
  return p;
}
const ORIGINAL_CHANGE_KEYS = [
  "detail",
  "id",
  "kind",
  "name",
  "observedAt",
  "previousAt",
  "projectId",
  "title",
];

/* ── Behaviour of the stored comparison ────────────────────────────────── */

test("the edition never schedules the 30 second re-check; the live page keeps it", () => {
  assert.equal(watchRecheckDelay(true), null);
  assert.equal(watchRecheckDelay(false), 30000);
  assert.equal(WATCH_RECHECK_MS, 30000);
  // The tests run without the build flag, which is the live page.
  assert.equal(watchRecheckDelay(), 30000);
});

test("the hook asks for the delay instead of starting a timer of its own, and does not announce a local comparison", () => {
  const hook = readFileSync(
    new URL("../src/useWatchChanges.ts", import.meta.url),
    "utf8",
  );
  assert.match(hook, /watchRecheckDelay\(\)/);
  assert.match(hook, /if \(delay !== null\)/);
  assert.doesNotMatch(hook, /,\s*30000\s*\)/, "a literal 30 s timer");
  assert.match(hook, /if \(!STATIC_EDITION\) setChecking\(true\)/);
  // The comparison runs again when the page holds a different snapshot. A
  // comment that merely names the dependency list does not count: the browser
  // test below is what proves it, this only guards the line itself.
  const code = hook.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(code, /\},\s*\[watchedKey, enabled, retry, snapshotKey\]\s*\)/);
});

test("stored changes from before snapshot times were kept still decode, and bad times are refused", async () => {
  const p = project();
  const a = await observeWatchChanges(
    emptyWatchChanges(),
    [p],
    [p.id],
    first,
    first,
    false,
  );
  p.description = "Updated published description";
  const b = await observeWatchChanges(a, [p], [p.id], second, second, false);
  assert.equal(b.changes.length, 1);
  assert.deepEqual(Object.keys(b.changes[0]).sort(), ORIGINAL_CHANGE_KEYS);
  // An entry of the old shape is read exactly as stored.
  assert.deepEqual(decodeWatchChanges(JSON.stringify(b)), b);
  // One with the new fields is read back with them.
  const edition = structuredClone(b);
  edition.changes[0].sourceAt = second;
  edition.changes[0].previousSourceAt = first;
  assert.deepEqual(decodeWatchChanges(JSON.stringify(edition)), edition);
  // A time that is not a time is refused, like every other field of an entry.
  for (const field of ["sourceAt", "previousSourceAt"]) {
    const bad = structuredClone(edition);
    bad.changes[0][field] = "yesterday";
    assert.deepEqual(decodeWatchChanges(JSON.stringify(bad)).changes, []);
    bad.changes[0][field] = 5;
    assert.deepEqual(decodeWatchChanges(JSON.stringify(bad)).changes, []);
  }
});

test("in the edition a change carries the two snapshot times; on the live page the stored shape is unchanged", async () => {
  const visit = "2026-10-17T10:00:00.000Z";
  for (const edition of [true, false]) {
    const p = project();
    const a = await observeWatchChanges(
      emptyWatchChanges(),
      [p],
      [p.id],
      first,
      "2026-10-17T09:30:00.000Z",
      edition,
    );
    p.description = "Updated published description";
    const b = await observeWatchChanges(a, [p], [p.id], second, visit, edition);
    assert.equal(b.changes.length, 1);
    const [change] = b.changes;
    assert.equal(change.kind, "metadata");
    // The visit and the earlier check keep their meaning for the unread logic.
    assert.equal(change.observedAt, visit);
    assert.equal(change.previousAt, "2026-10-17T09:30:00.000Z");
    if (edition) {
      assert.equal(change.sourceAt, second);
      assert.equal(change.previousSourceAt, first);
    } else {
      assert.deepEqual(Object.keys(change).sort(), ORIGINAL_CHANGE_KEYS);
    }
  }
});

test("a visitor whose clock is behind the snapshot still records a baseline and its changes in the edition", async () => {
  const behind = "2026-10-17T08:00:00.000Z";
  const p = project();
  // The live page distrusts a source stamped after its own clock.
  assert.deepEqual(
    await observeWatchChanges(
      emptyWatchChanges(),
      [p],
      [p.id],
      first,
      behind,
      false,
    ),
    emptyWatchChanges(),
  );
  const a = await observeWatchChanges(
    emptyWatchChanges(),
    [p],
    [p.id],
    first,
    behind,
    true,
  );
  assert.equal(a.baselines.length, 1);
  assert.equal(a.baselines[0].sourceAt, first);
  // The visit is stamped no earlier than the snapshot it saw.
  assert.equal(a.baselines[0].startedAt, first);
  assert.equal(a.baselines[0].checkedAt, first);
  p.description = "Updated published description";
  const b = await observeWatchChanges(a, [p], [p.id], second, behind, true);
  assert.equal(b.changes.length, 1);
  assert.equal(b.changes[0].observedAt, second);
  assert.equal(b.changes[0].sourceAt, second);
  assert.equal(b.changes[0].previousSourceAt, first);
  assert.equal(b.baselines[0].sourceAt, second);
  // A clock that is correct, or ahead, changes nothing.
  const ahead = "2026-10-17T12:00:00.000Z";
  assert.equal(
    (
      await observeWatchChanges(
        emptyWatchChanges(),
        [project()],
        ["alpha"],
        first,
        ahead,
        true,
      )
    ).baselines[0].checkedAt,
    ahead,
  );
});

test("marking read lands at or after the newest observation, so a visit behind the snapshot is read too", async () => {
  const behind = Date.parse("2026-10-17T08:00:00.000Z");
  const p = project();
  const a = await observeWatchChanges(
    emptyWatchChanges(),
    [p],
    [p.id],
    first,
    new Date(behind).toISOString(),
    true,
  );
  p.description = "Updated published description";
  const b = await observeWatchChanges(
    a,
    [p],
    [p.id],
    second,
    new Date(behind).toISOString(),
    true,
  );
  const unread = (readAt) =>
    b.changes.filter((c) => Date.parse(c.observedAt) > Date.parse(readAt))
      .length;
  assert.equal(
    unread(new Date(behind).toISOString()),
    1,
    "the visitor's own clock would leave it unread",
  );
  assert.equal(unread(readMark(b.changes, behind, true)), 0);
  // The live page reads at the visitor's clock, exactly as it did.
  assert.equal(
    readMark(b.changes, behind, false),
    new Date(behind).toISOString(),
  );
  assert.equal(readMark([], behind, true), new Date(behind).toISOString());
});

test("only saved projects the current snapshot carries count as tracked in the edition", async () => {
  const p = project();
  const q = structuredClone(p);
  q.id = "gone-project";
  q.name = "Gone project";
  const state = await observeWatchChanges(
    emptyWatchChanges(),
    [p, q],
    [p.id, q.id],
    first,
    first,
    true,
  );
  assert.equal(state.baselines.length, 2);
  const watched = new Set([p.id, q.id]);
  assert.deepEqual(
    trackedBaselines(state.baselines, watched, new Set([p.id])).map(
      (b) => b.id,
    ),
    [p.id],
  );
  // The live page, and an edition page with no snapshot yet, count every saved id.
  assert.equal(trackedBaselines(state.baselines, watched).length, 2);
  assert.equal(trackedBaselines(state.baselines, watched, null).length, 2);
  // An id that is no longer saved is never counted.
  assert.deepEqual(
    trackedBaselines(state.baselines, new Set([q.id]), null).map((b) => b.id),
    [q.id],
  );
});

/* ── What the feed says ────────────────────────────────────────────────── */

async function componentModule(path, replacements = {}) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  let output = ts.transpileModule(source, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  output = output.replace(/^import ["'][^"']+\.css["'];?\s*$/gm, "");
  for (const [specifier, target] of Object.entries({
    "lucide-react": import.meta.resolve("lucide-react"),
    react: import.meta.resolve("react"),
    "react/jsx-runtime": import.meta.resolve("react/jsx-runtime"),
    ...replacements,
  }))
    output = output.replaceAll(
      JSON.stringify(specifier),
      JSON.stringify(target),
    );
  return `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`;
}
const dataModule = (code) =>
  `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const editionUrl = new URL("../src/edition.ts", import.meta.url).href;
const modelUrl = new URL("../src/model.ts", import.meta.url).href;
const icons = await componentModule("../src/components/Icons.tsx");
// The same module twice: once as the live page has it (the flag unset, which
// is how plain Node sees src/edition.ts) and once with the flag forced on.
const feedModule = async (editionFlag) =>
  import(
    await componentModule("../src/components/WatchChangeFeed.tsx", {
      "./Icons": icons,
      "../model": modelUrl,
      "../edition": editionFlag
        ? dataModule(
            `export * from ${JSON.stringify(editionUrl)};\nexport const STATIC_EDITION = true;`,
          )
        : editionUrl,
    })
  );
const editionFeed = (await feedModule(true)).WatchChangeFeed;
const liveFeed = (await feedModule(false)).WatchChangeFeed;

const hex = "a".repeat(64);
const baseline = (id, overrides = {}) => ({
  id,
  name: id,
  hooks: hex,
  properties: hex,
  metadata: hex,
  hookCount: 1,
  poolCount: null,
  poolComplete: false,
  sourceAt: SNAP,
  startedAt: PREV,
  checkedAt: VISIT,
  ...overrides,
});
const change = (overrides = {}) => ({
  id: "b".repeat(64),
  projectId: "alpha",
  name: "Alpha",
  kind: "hooks",
  title: "Hook list changed",
  detail: "1 → 2 indexed contracts. Open the project to inspect them.",
  observedAt: VISIT,
  previousAt: "2026-10-27T18:31:00.000Z",
  sourceAt: SNAP,
  previousSourceAt: PREV,
  ...overrides,
});
const feedProps = (overrides = {}) => ({
  changes: [change()],
  baselines: [baseline("alpha"), baseline("beta")],
  checking: false,
  error: "",
  unread: 1,
  storageAvailable: true,
  total: 2,
  openProject() {},
  markRead() {},
  retry() {},
  ...overrides,
});
const render = (component, props) => {
  const html = renderToStaticMarkup(createElement(component, props));
  return {
    html,
    text: html
      .replace(/<[^>]+>/g, " ")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " "),
  };
};
// What a local formatter would print for these moments in en-US.
const LOCAL_STYLE =
  /\b(?:AM|PM)\b|\d{1,2}\/\d{1,2}\/\d{2,4}|\bToday\b|\bYesterday\b/;

test("the edition's footer names the snapshot compared with, not the moment of the visit", () => {
  const { text } = render(editionFeed, feedProps());
  assert.match(
    text,
    /2 of 2 saved projects tracked · Compared with the snapshot taken 28 Oct 2026, 14:05 UTC/,
  );
  assert.doesNotMatch(text, /checked/i);
  assert.doesNotMatch(text, /15:30/, "the visit time is not shown");
  assert.doesNotMatch(text, /Checking/);
  // The newest snapshot among the tracked projects.
  const mixed = render(
    editionFeed,
    feedProps({
      baselines: [
        baseline("alpha", { sourceAt: PREV }),
        baseline("beta", { sourceAt: SNAP }),
      ],
    }),
  ).text;
  assert.match(mixed, /snapshot taken 28 Oct 2026, 14:05 UTC/);
  // Nothing tracked yet: no time is claimed.
  const none = render(
    editionFeed,
    feedProps({ baselines: [], changes: [], unread: 0 }),
  ).text;
  assert.match(none, /0 of 2 saved projects tracked/);
  assert.doesNotMatch(none, /Compared with the snapshot/);
});

test("the edition dates each change by its snapshots in UTC and groups by the snapshot's UTC day", () => {
  const { html, text } = render(editionFeed, feedProps());
  assert.match(
    text,
    /Snapshot of 28 Oct 2026, 14:05 UTC compared with snapshot of 27 Oct 2026, 18:30 UTC\./,
  );
  assert.match(
    html,
    /title="Snapshot of 28 Oct 2026, 14:05 UTC compared with snapshot of 27 Oct 2026, 18:30 UTC\."/,
  );
  assert.match(html, /<time dateTime="2026-10-28T14:05:00\.000Z"/);
  // The short form on the row ends in the snapshot's UTC clock time.
  assert.match(
    html,
    /<time[^>]*><span>(?:28 Oct(?: 2026)?, )?14:05 UTC<\/span><\/time>/,
  );
  assert.match(html, /watch-change-day[^>]*>28 Oct 2026</);
  assert.doesNotMatch(text, LOCAL_STYLE);
  assert.doesNotMatch(text, /15:30/, "the visit time is not shown");
  assert.doesNotMatch(html, /watch-change-clock/);
});

test("the edition shows no local time, whatever zone the visitor is in", () => {
  const zone = process.env.TZ;
  try {
    for (const tz of ["Asia/Bangkok", "America/New_York", "Pacific/Auckland"]) {
      process.env.TZ = tz;
      const { html, text } = render(
        editionFeed,
        feedProps({
          changes: [
            change(),
            // An older entry from the same days, kept from before snapshot times.
            change({
              id: "c".repeat(64),
              sourceAt: undefined,
              previousSourceAt: undefined,
            }),
          ],
          unread: 0,
        }),
      );
      assert.doesNotMatch(text, LOCAL_STYLE, tz);
      assert.doesNotMatch(html, LOCAL_STYLE, tz);
      assert.match(
        text,
        /compared with snapshot of 27 Oct 2026, 18:30 UTC/,
        tz,
      );
    }
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});

test("a change stored without snapshot times is shown as the visit it was, in UTC", () => {
  const legacy = change({
    sourceAt: undefined,
    previousSourceAt: undefined,
  });
  const { html, text } = render(editionFeed, feedProps({ changes: [legacy] }));
  assert.match(
    text,
    /Observed 28 Oct 2026, 15:30 UTC\. Compared with 27 Oct 2026, 18:31 UTC\./,
  );
  assert.match(html, /<time dateTime="2026-10-28T15:30:00\.000Z"/);
  assert.doesNotMatch(text, /Snapshot of/);
  assert.doesNotMatch(text, LOCAL_STYLE);
});

test("the edition describes only what it can detect", () => {
  const { text } = render(editionFeed, feedProps());
  assert.match(
    text,
    /Hook lists, registry declarations and project information for your saved projects\./,
  );
  assert.doesNotMatch(text, /indexed pools/);
});

test("the live page's feed reads exactly as before", () => {
  const zone = process.env.TZ;
  process.env.TZ = "Asia/Bangkok";
  try {
    const props = feedProps();
    const { html, text } = render(liveFeed, props);
    assert.match(text, /2 of 2 saved projects tracked · checked /);
    assert.doesNotMatch(text, /Compared with the snapshot taken/);
    assert.match(
      text,
      /Hook listings, indexed pools and project details for your saved projects\./,
    );
    const exact = (value) => new Date(value).toLocaleString();
    assert.ok(
      text.includes(
        `Observed ${exact(VISIT)}. Compared with ${exact("2026-10-27T18:31:00.000Z")}.`,
      ),
    );
    assert.ok(
      html.includes(
        `title="Observed ${exact(VISIT)}; compared with ${exact("2026-10-27T18:31:00.000Z")}"`,
      ),
    );
    assert.match(html, /<time dateTime="2026-10-28T15:30:00\.000Z"/);
    assert.match(html, /watch-change-clock/);
    assert.match(
      html,
      /watch-change-day[^>]*>(?:Today|Yesterday|[A-Z][a-z]{2} \d)/,
    );
    // A live page that is still checking says so.
    assert.match(
      render(liveFeed, feedProps({ checking: true })).text,
      /Checking for changes…/,
    );
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});

/* ── In a browser, against an edition build ────────────────────────────── */

const DIST = process.env.RADAR_TEST_DIST
  ? resolve(process.env.RADAR_TEST_DIST)
  : null;
const DATA = resolve(
  process.env.RADAR_TEST_DATA || "tests/fixtures/static-data/data",
);
function editionBuild() {
  if (!DIST) return "RADAR_TEST_DIST is not set";
  try {
    const assets = readdirSync(resolve(DIST, "assets")).filter((name) =>
      name.endsWith(".js"),
    );
    const code = assets
      .map((name) => readFileSync(resolve(DIST, "assets", name), "utf8"))
      .join("\n");
    return /Snapshot taken/.test(code) && /snapshot\.json/.test(code)
      ? null
      : "RADAR_TEST_DIST is not an edition build";
  } catch {
    return "RADAR_TEST_DIST cannot be read";
  }
}
const skip = editionBuild() ?? false;
const SIZES = {
  desktop: { width: 1440, height: 1000 },
  phone: { width: 390, height: 844 },
};
const MINUTE = 60_000;
/** How long the browser tests hold crypto.subtle.digest back (see openWatchlist). */
const DIGEST_DELAY_MS = 150;

let browser;
let playwright;
after(async () => {
  await browser?.close();
});

const snapshotFile = () =>
  JSON.parse(readFileSync(resolve(DATA, "snapshot.json"), "utf8"));

/** Two saved projects of the data under test, with a stored comparison point
 * taken from the snapshot before it: one project whose hook list then differed,
 * one that did not change. */
async function seeded({ changed = true } = {}) {
  const snapshot = snapshotFile();
  const generated = Date.parse(snapshot.generatedAt);
  // The snapshot before it was taken late on the previous UTC day, which is
  // already the next day in Bangkok; its stored check came a minute later.
  const day = new Date(generated);
  const previous = Date.UTC(
    day.getUTCFullYear(),
    day.getUTCMonth(),
    day.getUTCDate() - 1,
    18,
    30,
  );
  const rows = snapshot.projects.filter((row) => row.deployments.length > 0);
  const [a, b] = rows;
  const stored = [];
  for (const row of [a, b]) {
    const old = await watchBaseline(
      row,
      new Date(previous).toISOString(),
      new Date(previous + MINUTE).toISOString(),
    );
    if (changed && row === a) {
      old.hooks = "0".repeat(64);
      old.hookCount = Math.max(0, old.hookCount - 1);
    }
    stored.push(old);
  }
  // What a visitor in Bangkok would read for each moment on a local clock.
  const bangkok = (ms) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Bangkok",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(ms);
  return {
    generatedAt: snapshot.generatedAt,
    // The words the page uses for the snapshot and the one before it.
    label: fullTimeLabel(generated),
    previousLabel: fullTimeLabel(previous),
    clock: timeLabel(generated, generated),
    day: utcDate(generated),
    localClocks: [bangkok(generated), bangkok(previous)],
    ids: [a.id, b.id],
    names: [a.name, b.name],
    state: JSON.stringify({
      version: 1,
      baselines: stored,
      changes: [],
      readAt: null,
    }),
    stored,
  };
}

/** The watchlist page of an edition build, as a visitor in `timezoneId` whose
 * clock reads `visit`, with the saved projects and the stored comparison point
 * (when `state` is given) in place before the page first runs. */
async function openWatchlist(
  t,
  {
    size = SIZES.desktop,
    visit,
    ids,
    state = null,
    timezoneId = "Asia/Bangkok",
    extraData = {},
  },
) {
  playwright ??= await import("@playwright/test");
  const { startStaticEditionServer } =
    await import("../scripts/static-edition-server.mjs");
  browser ??= await playwright.chromium.launch({
    headless: true,
    ...(process.env.CHROME_BIN
      ? { executablePath: process.env.CHROME_BIN }
      : process.platform === "win32"
        ? { channel: "chrome" }
        : {}),
  });
  const html = readFileSync(resolve(DIST, "index.html"), "utf8");
  const entry =
    html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/)?.[1] ?? "";
  const mount = process.env.RADAR_TEST_MOUNT
    ? process.env.RADAR_TEST_MOUNT
    : entry.startsWith("./")
      ? "/"
      : entry.replace(/assets\/[^/]+$/, "") || "/";
  const server = await startStaticEditionServer({
    distDir: DIST,
    dataDir: DATA,
    mount,
  });
  for (const [name, body] of Object.entries(extraData))
    server.setData(name, body);
  const context = await browser.newContext({
    viewport: size,
    reducedMotion: "reduce",
    timezoneId,
    locale: "en-US",
  });
  t.after(async () => {
    await context.close();
    await server.close();
  });
  // Written once, before the page first runs; a reload keeps what the page saved.
  await context.addInitScript(
    ([watchKey, changesKey, watched, stored]) => {
      if (sessionStorage.getItem("test-seeded")) return;
      sessionStorage.setItem("test-seeded", "1");
      localStorage.setItem(watchKey, JSON.stringify(watched));
      if (stored) localStorage.setItem(changesKey, stored);
    },
    ["hook-radar-watchlist-v1", WATCH_CHANGES_KEY, ids, state],
  );
  // Whether the footer ever said it was checking, even for an instant. The
  // comparison hashes each project with crypto.subtle.digest, which is so fast
  // that React would batch a wrongly announced "checking" state into the same
  // commit as its end and the observer would never see it. Holding the digest
  // back by DIGEST_DELAY_MS makes any such announcement last long enough to be
  // caught; __digestCalls lets the tests prove the delay was in effect.
  await context.addInitScript((delay) => {
    window.__sawChecking = false;
    window.__digestCalls = 0;
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const realSetTimeout = window.setTimeout.bind(window);
    crypto.subtle.digest = (...args) => {
      window.__digestCalls += 1;
      return new Promise((done, fail) =>
        realSetTimeout(() => digest(...args).then(done, fail), delay),
      );
    };
    new MutationObserver(() => {
      const footer = document.querySelector(".watch-updates footer");
      if (footer && /Checking/.test(footer.textContent))
        window.__sawChecking = true;
    }).observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  }, DIGEST_DELAY_MS);
  const page = await context.newPage();
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  await page.clock.install({ time: new Date(visit) });
  await page.goto(`${server.url}?view=watchlist`);
  const panel = page.locator(".watch-updates");
  await playwright.expect(panel).toBeVisible({ timeout: 30000 });
  return {
    page,
    panel,
    server,
    errors,
    footer: () => panel.locator("footer").innerText(),
    stored: () =>
      page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key) || "null"),
        WATCH_CHANGES_KEY,
      ),
    /** Everything the panel says or hides in a tooltip, in one string. */
    everything: () =>
      panel.evaluate((element) => {
        const parts = [element.textContent];
        for (const node of element.querySelectorAll("[title], [aria-label]"))
          parts.push(
            node.getAttribute("title") ?? "",
            node.getAttribute("aria-label") ?? "",
          );
        return parts.join(" | ").replace(/\s+/g, " ");
      }),
    verify() {
      assert.deepEqual(errors, [], "console and page errors");
      assert.deepEqual(
        server.apiRequests().map((row) => `${row.method} ${row.path}`),
        [],
        "requests to /api",
      );
    },
  };
}

for (const [name, size] of Object.entries(SIZES)) {
  test(
    `browser, ${name}: the feed speaks in UTC snapshot times and stays still while the page stays open`,
    { skip },
    async (t) => {
      const data = await seeded();
      const visit = Date.parse(data.generatedAt) + 2 * MINUTE;
      const f = await openWatchlist(t, {
        size,
        visit,
        ids: data.ids,
        state: data.state,
      });
      await playwright
        .expect(f.panel.locator("footer"))
        .toContainText(`Compared with the snapshot taken ${data.label}`, {
          timeout: 30000,
        });
      const footer = await f.footer();
      assert.match(footer, /2 of 2 saved projects tracked/);
      assert.doesNotMatch(footer, /checked|Checking/i);

      // The change is dated by the two snapshots, in UTC, and sits under the
      // snapshot's UTC day.
      const row = f.panel.locator(".watch-change-list > li").first();
      await playwright.expect(row).toContainText("Hook list");
      await playwright.expect(row).toContainText(data.names[0]);
      const rowTime = (await row.locator("time").innerText()).trim();
      assert.equal(rowTime, data.clock);
      assert.equal(
        await row.locator("time").getAttribute("datetime"),
        data.generatedAt,
      );
      assert.equal(
        (await row.locator(".watch-change-day").textContent()).trim(),
        data.day,
      );
      const expectedCompared = `Snapshot of ${data.label} compared with snapshot of ${data.previousLabel}.`;
      assert.equal(
        await row.locator("time").getAttribute("title"),
        expectedCompared,
      );
      assert.ok(
        (await row.locator("details").textContent()).includes(expectedCompared),
      );
      assert.match(
        await f.panel.locator(".watch-update-description").innerText(),
        /^Hook lists, registry declarations and project information for your saved projects\.$/,
      );

      // No local-zone time anywhere in the panel or its tooltips (this visitor
      // is in Bangkok, where the same moments read differently).
      const before = await f.everything();
      assert.doesNotMatch(
        before,
        /\b(?:AM|PM)\b|\d{1,2}\/\d{1,2}\/\d{2,4}|\bToday\b|\bYesterday\b|\bchecked\b/,
      );
      for (const local of data.localClocks)
        assert.ok(
          !before.includes(local) || data.label.includes(local),
          `the Bangkok clock time ${local} is shown`,
        );
      // The row is the only change: the other saved project did not differ.
      assert.equal(await f.panel.locator(".watch-change-list > li").count(), 1);

      // Seventy seconds go by on the page's own clock: nothing is checked
      // again, so the footer, the rows and the stored times do not move.
      const storedBefore = await f.stored();
      const nowBefore = await f.page.evaluate(() => Date.now());
      await f.page.clock.runFor(70_000);
      await f.page.waitForTimeout(400);
      const nowAfter = await f.page.evaluate(() => Date.now());
      assert.ok(nowAfter - nowBefore >= 70_000, "the page's clock moved on");
      assert.equal(await f.footer(), footer, "the footer is stable");
      assert.equal(await f.everything(), before, "the panel is stable");
      assert.deepEqual(await f.stored(), storedBefore, "nothing was rewritten");
      // The digest was held back, so a wrongly announced check would have
      // stayed on screen long enough to be seen; and it did run.
      assert.ok(
        (await f.page.evaluate(() => window.__digestCalls)) > 0,
        "the comparison went through the delayed digest",
      );
      assert.equal(
        await f.page.evaluate(() => window.__sawChecking),
        false,
        "the footer never announced a check",
      );
      // The stored check time is the first load's (the page's clock started at
      // the visit and had run a few seconds), not a later tick of the clock.
      for (const stored of (await f.stored()).baselines) {
        assert.equal(stored.sourceAt, data.generatedAt);
        const checked = Date.parse(stored.checkedAt);
        assert.ok(
          checked >= visit && checked < visit + 20_000,
          `checkedAt ${stored.checkedAt} is from the first load`,
        );
      }
      assert.equal(
        await f.page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        true,
        "no horizontal scroll",
      );
      f.verify();
      if (process.env.RADAR_TEST_SHOTS)
        await f.page.screenshot({
          path: resolve(process.env.RADAR_TEST_SHOTS, `watch-feed-${name}.png`),
        });
    },
  );
}

test(
  "browser: a visitor whose clock is behind the snapshot still gets a baseline, the change and a working Mark read",
  { skip },
  async (t) => {
    const data = await seeded();
    const behind = Date.parse(data.generatedAt) - 3 * 60 * MINUTE;
    // Saved projects with a stored comparison point from the snapshot before.
    const f = await openWatchlist(t, {
      visit: behind,
      ids: data.ids,
      state: data.state,
    });
    await playwright
      .expect(f.panel.locator("footer"))
      .toContainText(`Compared with the snapshot taken ${data.label}`, {
        timeout: 30000,
      });
    const row = f.panel.locator(".watch-change-list > li").first();
    await playwright.expect(row).toContainText("Hook list");
    assert.equal((await row.locator("time").innerText()).trim(), data.clock);
    const badge = f.panel.locator(".watch-unread");
    await playwright.expect(badge).toHaveText("1 new");
    await f.panel.getByRole("button", { name: /Mark read/ }).click();
    await playwright.expect(badge).toHaveCount(0);
    await playwright
      .expect(f.panel.getByRole("button", { name: /Mark read/ }))
      .toHaveCount(0);
    // And it stays read after a reload.
    await f.page.reload();
    await playwright.expect(f.panel).toBeVisible({ timeout: 30000 });
    await playwright
      .expect(f.panel.locator("footer"))
      .toContainText(`Compared with the snapshot taken ${data.label}`, {
        timeout: 30000,
      });
    await playwright.expect(f.panel.locator(".watch-unread")).toHaveCount(0);
    f.verify();
  },
);

test(
  "browser: the first visit saves a starting point from the snapshot even when the visitor's clock is behind it",
  { skip },
  async (t) => {
    const data = await seeded();
    const behind = Date.parse(data.generatedAt) - 3 * 60 * MINUTE;
    const f = await openWatchlist(t, { visit: behind, ids: data.ids });
    await playwright
      .expect(f.panel.locator("footer"))
      .toContainText(
        `2 of 2 saved projects tracked · Compared with the snapshot taken ${data.label}`,
        { timeout: 30000 },
      );
    const stored = await f.stored();
    assert.equal(stored.baselines.length, 2);
    assert.deepEqual(stored.changes, []);
    f.verify();
  },
);

test(
  "browser: a newer snapshot loaded by a reload is compared again without any timer or request to a service",
  { skip },
  async (t) => {
    const data = await seeded({ changed: false });
    const first = Date.parse(data.generatedAt);
    const f = await openWatchlist(t, {
      visit: first + 2 * MINUTE,
      ids: data.ids,
      state: data.state,
    });
    await playwright
      .expect(f.panel.locator("footer"))
      .toContainText(
        `2 of 2 saved projects tracked · Compared with the snapshot taken ${data.label}`,
        { timeout: 30000 },
      );
    // Nothing differs from the stored comparison point yet.
    assert.equal(await f.panel.locator(".watch-change-list > li").count(), 0);
    assert.equal(await f.panel.locator(".watch-unread").count(), 0);

    // The host now serves a snapshot taken four hours later in which one saved
    // project's description was edited.
    const newer = snapshotFile();
    const newerAt = first + 4 * 60 * MINUTE;
    newer.generatedAt = new Date(newerAt).toISOString();
    const edited = newer.projects.find((row) => row.id === data.ids[0]);
    edited.description = `${edited.description ?? "Project"} (edited in a later snapshot)`;
    f.server.setData("snapshot.json", newer);

    // The page that is open never swaps it in silently (it offers "Reload"
    // once the status file names a later run); the visitor reloads it, and the
    // comparison runs against the newer snapshot. No timer runs the comparison.
    await f.page.reload();

    const newerLabel = fullTimeLabel(newerAt);
    await playwright
      .expect(f.panel.locator("footer"))
      .toContainText(`Compared with the snapshot taken ${newerLabel}`, {
        timeout: 30000,
      });
    assert.doesNotMatch(await f.footer(), /checked|Checking/i);
    const row = f.panel.locator(".watch-change-list > li");
    await playwright.expect(row).toHaveCount(1);
    await playwright.expect(row).toContainText("Project information updated");
    await playwright.expect(row).toContainText(data.names[0]);
    assert.ok(
      (await row.locator("details").textContent()).includes(
        `Snapshot of ${newerLabel} compared with snapshot of ${data.label}.`,
      ),
    );
    assert.equal(
      await row.locator("time").getAttribute("datetime"),
      newer.generatedAt,
    );
    await playwright
      .expect(f.panel.locator(".watch-unread"))
      .toHaveText("1 new");
    // The stored comparison point moved on to the newer snapshot.
    for (const stored of (await f.stored()).baselines)
      assert.equal(stored.sourceAt, newer.generatedAt);
    // The snapshot file was the only thing asked for; /api never was.
    f.verify();
    if (process.env.RADAR_TEST_SHOTS)
      await f.page.screenshot({
        path: resolve(process.env.RADAR_TEST_SHOTS, "watch-feed-newer.png"),
      });
  },
);

test(
  "browser: a saved project the snapshot does not carry is not counted as tracked",
  { skip },
  async (t) => {
    const data = await seeded({ changed: false });
    const gone = {
      ...data.stored[1],
      id: "gone-project",
      name: "Gone project",
    };
    const state = JSON.stringify({
      version: 1,
      baselines: [data.stored[0], gone],
      changes: [],
      readAt: null,
    });
    const f = await openWatchlist(t, {
      visit: Date.parse(data.generatedAt) + 2 * MINUTE,
      ids: [data.ids[0], "gone-project"],
      state,
    });
    await playwright
      .expect(f.panel.locator("footer"))
      .toContainText(
        `1 of 2 saved projects tracked · Compared with the snapshot taken ${data.label}`,
        { timeout: 30000 },
      );
    // The older baseline of the missing project is kept, not erased.
    assert.ok(
      (await f.stored()).baselines.some((b) => b.id === "gone-project"),
    );
    f.verify();
  },
);
