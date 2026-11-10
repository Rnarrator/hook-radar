// A visitor whose device clock is behind the snapshot, in a real browser. The
// snapshot's validators used to compare its census head-check times with the
// visitor's clock, so a clock more than a few hours behind got "The latest data
// couldn't be read" with a Retry that could never succeed. The edition judges a
// frozen snapshot at its own time, so the same files must open on any clock.
//
// Like scripts/static-edition-browser.test.mjs it builds nothing: point it at an
// edition build (VITE_STATIC_EDITION=1) with RADAR_TEST_DIST. It serves that
// build next to the deterministic TEST data in tests/fixtures/static-data/data
// (or, with RADAR_TEST_DATA, any folder holding the collector's published
// files) through scripts/static-edition-server.mjs, which answers every /api
// path with 404. Nothing is written and no network is used.
//
//   RADAR_TEST_DIST=dist/test-build \
//     node --test scripts/static-edition-clock-browser.test.mjs
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { startStaticEditionServer } from "./static-edition-server.mjs";

const DIST = resolve(process.env.RADAR_TEST_DIST || "dist");
const DATA = resolve(
  process.env.RADAR_TEST_DATA || "tests/fixtures/static-data/data",
);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const DESKTOP = { width: 1440, height: 1000 };
const PHONE = { width: 390, height: 844 };

const snapshotFixture = JSON.parse(
  readFileSync(resolve(DATA, "snapshot.json"), "utf8"),
);
const GENERATED_AT = snapshotFixture.generatedAt;
const generated = Date.parse(GENERATED_AT);
// Two projects the snapshot lists with hooks, for the Compare and drawer links.
const [first, second] = snapshotFixture.projects.filter(
  (project) => project.entityType === undefined && project.deployments.length,
);
// The earliest census head check: the old rule failed a clock this much behind.
const earliestHeadCheck = Math.min(
  ...snapshotFixture.inventory.networks
    .map((network) => Date.parse(network.headCheckedAt))
    .filter(Number.isFinite),
);

// How the build under test is meant to be served.
const html = readFileSync(resolve(DIST, "index.html"), "utf8");
const entry =
  html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/)?.[1] ?? "";
const builtMount = entry.startsWith("./")
  ? "/"
  : entry.replace(/assets\/[^/]+$/, "") || "/";
const MOUNT = process.env.RADAR_TEST_MOUNT || builtMount;

let browser;
before(async () => {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_BIN
      ? { executablePath: process.env.CHROME_BIN }
      : process.platform === "win32"
        ? { channel: "chrome" }
        : {}),
  });
});
after(async () => {
  await browser?.close();
});

/** A page on the edition with the visitor's clock fixed at `visitorNow`, and
 * watchers that turn every console error, page error and failed request into a
 * failure. */
async function site(
  t,
  { size = DESKTOP, visitorNow = generated, data = {} } = {},
) {
  const server = await startStaticEditionServer({
    distDir: DIST,
    dataDir: DATA,
    mount: MOUNT,
  });
  for (const [name, body] of Object.entries(data)) server.setData(name, body);
  const context = await browser.newContext({
    viewport: size,
    reducedMotion: "reduce",
  });
  await context.clock.setFixedTime(visitorNow);
  const page = await context.newPage();
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) => {
    if (request.failure()?.errorText !== "net::ERR_ABORTED")
      errors.push(`requestfailed: ${request.url()}`);
  });
  t.after(async () => {
    await context.close();
    await server.close();
  });
  return {
    page,
    server,
    goto: (query = "") => page.goto(`${server.url}${query}`),
    /** No error was logged, no service was asked and no request failed. */
    verify() {
      assert.deepEqual(errors, [], "console and page errors");
      assert.deepEqual(
        server.apiRequests().map((row) => `${row.method} ${row.path}`),
        [],
        "requests to /api",
      );
      assert.equal(
        server.requests.filter((row) => row.status >= 400).length,
        0,
        `no request failed: ${server.requests
          .filter((row) => row.status >= 400)
          .map((row) => `${row.status} ${row.path}`)
          .join(", ")}`,
      );
    },
  };
}

const READ_FAILURE = /couldn[’']t be read|couldn[’']t load the radar/i;

/** The page shows the snapshot's data and none of the unreadable-data states. */
async function showsData(page, { phone = false } = {}) {
  await expect(page.getByTestId("snapshot-line")).toBeVisible({
    timeout: 30000,
  });
  await expect(
    page.locator(phone ? ".mobile-projects article" : "tbody tr").first(),
  ).toBeVisible({ timeout: 30000 });
  await expect(page.locator(".error-notice, [role=alert]")).toHaveCount(0);
  const text = await page.evaluate(() => document.body.innerText);
  assert.doesNotMatch(text, READ_FAILURE);
}

test("the test data would have failed the old rule on these clocks", () => {
  assert.ok(first && second, "two projects with hooks in the data");
  assert.ok(
    generated - earliestHeadCheck > 3 * HOUR - 10 * MINUTE,
    "the earliest census head check is hours before the snapshot",
  );
});

test("Discover opens on a clock hours, days or months behind the snapshot, at 1440 and 390 px", async (t) => {
  const behind = [4 * HOUR, 2 * DAY, 100 * DAY];
  assert.ok(
    behind.some((gap) => gap > generated - earliestHeadCheck + MINUTE),
    "at least one clock is earlier than the earliest head check",
  );
  for (const gap of behind) {
    const s = await site(t, { visitorNow: generated - gap });
    await s.goto();
    await showsData(s.page);
    await expect(s.page.getByTestId("snapshot-line")).toContainText(
      "Snapshot taken",
    );
    // The census block (the part that used to be refused) reaches the screen.
    await expect(s.page.getByText(/census as of/i).first()).toBeVisible();
    s.verify();
  }
  const phone = await site(t, { size: PHONE, visitorNow: generated - 2 * DAY });
  await phone.goto();
  await showsData(phone.page, { phone: true });
  phone.verify();
});

test("Compare, the project drawer, Networks and the Watchlist open on a clock two days behind", async (t) => {
  for (const size of [DESKTOP, PHONE]) {
    const s = await site(t, { size, visitorNow: generated - 2 * DAY });
    await s.goto(`?view=compare&compare=${first.id},${second.id}`);
    await expect(s.page.getByRole("main")).toContainText(first.name, {
      timeout: 30000,
    });
    await expect(s.page.getByRole("main")).toContainText(second.name);
    await expect(s.page.getByTestId("snapshot-line")).toBeVisible();
    await expect(s.page.locator(".error-notice, [role=alert]")).toHaveCount(0);

    await s.goto(`?project=${first.id}`);
    await expect(s.page.locator(".project-detail")).toContainText(first.name, {
      timeout: 30000,
    });
    await expect(s.page.locator(".error-notice, [role=alert]")).toHaveCount(0);

    for (const view of ["chains", "map", "watchlist", "analytics"]) {
      await s.goto(`?view=${view}`);
      await expect(s.page.getByTestId("snapshot-line")).toBeVisible({
        timeout: 30000,
      });
      await expect(s.page.locator(".error-notice, [role=alert]")).toHaveCount(
        0,
      );
      const text = await s.page.evaluate(() => document.body.innerText);
      assert.doesNotMatch(text, READ_FAILURE, view);
    }
    s.verify();
  }
});

test("a visitor with a clock ahead of the snapshot is unaffected", async (t) => {
  const s = await site(t, { visitorNow: generated + 40 * DAY });
  await s.goto();
  await showsData(s.page);
  s.verify();
});

test("a census head check later than the snapshot's own time is still refused", async (t) => {
  const snapshot = structuredClone(snapshotFixture);
  snapshot.inventory.networks[0].headCheckedAt = new Date(
    generated + 2 * MINUTE,
  ).toISOString();
  // Whatever the visitor's clock says, the file contradicts itself.
  for (const visitorNow of [generated - 2 * DAY, generated + DAY]) {
    const s = await site(t, {
      visitorNow,
      data: { "snapshot.json": snapshot },
    });
    await s.goto();
    await expect(s.page.locator("body")).toContainText(READ_FAILURE, {
      timeout: 30000,
    });
    await expect(s.page.locator("tbody tr")).toHaveCount(0);
  }
});
