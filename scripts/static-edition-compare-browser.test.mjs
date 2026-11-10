// Compare, the picker and the palette in the Auto Snapshot edition, in a real
// browser. It builds nothing: point it at an edition build (VITE_STATIC_EDITION=1)
// with RADAR_TEST_DIST. By default the data is the deterministic TEST data in
// tests/fixtures/static-data/data; RADAR_TEST_DATA names another data folder (the
// real collector output, say) and every expectation is then derived from that
// folder's own snapshot.json, so the same checks run on either. The server
// (scripts/static-edition-server.mjs) answers every /api path with 404 and
// records every request. No production data, no network, no service.
//
//   RADAR_TEST_DIST=dist/test-build \
//     node --test scripts/static-edition-compare-browser.test.mjs
//   RADAR_TEST_DIST=<build> RADAR_TEST_DATA=<real data folder> \
//     node --test scripts/static-edition-compare-browser.test.mjs
//
// A link that names a project the snapshot lacks only reaches Compare when the
// app (src/App.tsx) does two things: it keeps such ids in its selection, so the
// address and Compare still have them, and it counts only the projects the
// snapshot carries, so the nav badge, the selection tray and the four-place
// limit on the Add buttons leave them out. The checks on that flow FAIL when the
// build under test drops the ids first, and the two on the counts FAIL when it
// keeps them but counts them (that is the regression they guard). To run the
// rest against a build that is known to still drop them, set
// RADAR_EXPECT_UNKNOWN_IDS_DROPPED=1: those checks are then skipped, and still
// run if the build does keep the ids.
//
//   RADAR_EXPECT_UNKNOWN_IDS_DROPPED=1 RADAR_TEST_DIST=<build> \
//     node --test scripts/static-edition-compare-browser.test.mjs
//
// Not covered, and a known limit: src/navigation.ts cuts a link to four ids
// whatever they are, before Compare sees it, so a link that names an unlisted
// id together with four carried projects loses the last of them. Only a
// hand-edited link gets there.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { startStaticEditionServer } from "./static-edition-server.mjs";
import {
  currentMetricValue,
  observedMetricValue,
} from "../shared/market-freshness.ts";

const DIST = resolve(process.env.RADAR_TEST_DIST || "dist");
const DATA = resolve(
  process.env.RADAR_TEST_DATA || "tests/fixtures/static-data/data",
);
const SIZES = {
  desktop: { width: 1440, height: 1000 },
  phone: { width: 390, height: 844 },
};
const MINUTE = 60_000;

const snapshot = JSON.parse(
  readFileSync(resolve(DATA, "snapshot.json"), "utf8"),
);
const generated = Date.parse(snapshot.generatedAt);
const IDENTIFIER = /^[a-z0-9][a-z0-9-]{0,99}$/;
// Hooks a visitor can compare: not a platform, and an id a link can carry.
const comparable = snapshot.projects.filter(
  (project) => project.entityType !== "platform" && IDENTIFIER.test(project.id),
);

const html = readFileSync(resolve(DIST, "index.html"), "utf8");
const entry =
  html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/)?.[1] ?? "";
const MOUNT =
  process.env.RADAR_TEST_MOUNT ||
  (entry.startsWith("./") ? "/" : entry.replace(/assets\/[^/]+$/, "") || "/");

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

/** A page on the edition with the visitor's clock fixed, and watchers that turn
 * every console error, page error and service request into a failure. */
async function site(t, size = SIZES.desktop) {
  const server = await startStaticEditionServer({
    distDir: DIST,
    dataDir: DATA,
    mount: MOUNT,
  });
  const context = await browser.newContext({
    viewport: size,
    reducedMotion: "reduce",
  });
  await context.clock.setFixedTime(generated + 2 * MINUTE);
  const page = await context.newPage();
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  t.after(async () => {
    await context.close();
    await server.close();
  });
  return {
    page,
    server,
    goto: async (query) => {
      await page.goto(`${server.url}${query}`);
      await expect(page.getByTestId("hook-comparison")).toBeVisible({
        timeout: 30000,
      });
    },
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

const compareIds = (page) =>
  new URL(page.url()).searchParams.get("compare")?.split(",") ?? [];
const noSideScroll = (page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth <=
      document.documentElement.clientWidth + 1,
  );
const focusInPicker = (page) =>
  page.evaluate(
    () =>
      document.activeElement?.closest(".comparison-picker-disclosure") !== null,
  );

// ── What an empty metric cell says ──────────────────────────────────────────

const METRICS = [
  ["24h volume", "h24"],
  ["Pool reserves", "liquidity"],
];
const EXPECTED = {
  none: "Not measured in this snapshot",
  unreported: "Not reported by the provider",
  stale: "No fresh measurements",
};

/** What the snapshot itself says about a metric of one project in one scope,
 * by the project's own freshness rule at the snapshot's own time. */
function classify(project, chain, metric) {
  const pools = snapshot.pools.filter(
    (pool) =>
      pool.projectId === project.id &&
      (chain === "all" || pool.chain === chain),
  );
  if (!pools.length) return "none";
  if (
    pools.some((pool) => currentMetricValue(pool, metric, generated) !== null)
  )
    return "measured";
  return pools.some((pool) => observedMetricValue(pool, metric) !== null)
    ? "stale"
    : "unreported";
}
const found = { none: null, unreported: null, stale: null };
for (const project of comparable) {
  for (const chain of [
    "all",
    ...new Set(project.deployments.map((d) => d.chain)),
  ])
    for (const [label, metric] of METRICS) {
      const kind = classify(project, chain, metric);
      if (kind !== "measured" && !found[kind])
        found[kind] = { id: project.id, chain, label, metric };
    }
}

const metricCell = (page, label) =>
  page
    .locator('[aria-label="Hook project comparison"] tbody tr')
    .filter({
      has: page.getByRole("rowheader", { name: new RegExp(`^${label}`) }),
    })
    .first()
    .locator("td")
    .first();

const WHEN = {
  none: "the snapshot holds no pool of the project",
  unreported: "its pools were measured but no value was reported",
  stale: "its value is older than five minutes at the snapshot's time",
};
for (const [sizeName, size] of Object.entries(SIZES))
  for (const kind of Object.keys(EXPECTED))
    test(`[${sizeName}] an empty metric cell says "${EXPECTED[kind]}" when ${WHEN[kind]}`, async (t) => {
      let sample = found[kind];
      let served = null;
      if (!sample && kind === "none") {
        // The test data has no project without a pool: take one project's pools
        // out of the snapshot the server hands this page (in memory only).
        const victim = comparable.find((project) =>
          snapshot.pools.some((pool) => pool.projectId === project.id),
        );
        served = {
          ...snapshot,
          pools: snapshot.pools.filter((pool) => pool.projectId !== victim.id),
        };
        sample = { id: victim.id, chain: "all", label: "24h volume" };
      }
      if (!sample)
        return t.skip(`no project in ${DATA} has a "${kind}" metric cell`);
      const s = await site(t, size);
      if (served) s.server.setData("snapshot.json", served);
      await s.goto(
        `?view=compare&compare=${sample.id}${
          sample.chain === "all" ? "" : `&compareChain=${sample.chain}`
        }`,
      );
      const cell = metricCell(s.page, sample.label);
      await expect(cell).toContainText(EXPECTED[kind]);
      // The cell shows a dash: a missing value is never drawn as a number.
      await expect(cell).not.toContainText("$");
      for (const other of Object.keys(EXPECTED).filter((key) => key !== kind))
        await expect(cell).not.toContainText(EXPECTED[other]);
      s.verify();
    });

for (const [sizeName, size] of Object.entries(SIZES))
  test(`[${sizeName}] a reserve figure Hook Radar withheld says "Withheld", never "Not reported"`, async (t) => {
    // The collector can leave a pool with no reserve value because the
    // provider's total did not check out (liquidityStatus "inconsistent" or
    // "unverified"). The data here has none, so one project's pools are given
    // that state in the snapshot this page is served (in memory only).
    const victim = comparable.find((project) =>
      snapshot.pools.some((pool) => pool.projectId === project.id),
    );
    assert(victim, "the data has a comparable project with pools");
    const status = (pool) =>
      pool.projectId === victim.id
        ? {
            ...pool,
            liquidityUsd: null,
            liquidityStatus: "inconsistent",
            liquidityNote:
              "Reserve valuation withheld: reported total does not match token component valuations.",
          }
        : pool;
    const s = await site(t, size);
    s.server.setData("snapshot.json", {
      ...snapshot,
      pools: snapshot.pools.map(status),
    });
    await s.goto(`?view=compare&compare=${victim.id}`);
    const cell = metricCell(s.page, "Pool reserves");
    await expect(cell).toContainText(
      "Withheld: the reported figure could not be verified",
    );
    await expect(cell).not.toContainText("$");
    await expect(cell).not.toContainText(/Not reported|Not measured|No fresh/);
    s.verify();
  });

test("a measured value keeps its figure and its pool count", async (t) => {
  const sample = comparable
    .map((project) => ({
      project,
      metric: METRICS.find(
        ([, metric]) => classify(project, "all", metric) === "measured",
      ),
    }))
    .find((entry) => entry.metric);
  if (!sample) return t.skip("no project has a measured metric");
  const s = await site(t);
  await s.goto(`?view=compare&compare=${sample.project.id}`);
  const cell = metricCell(s.page, sample.metric[0]);
  await expect(cell).toContainText("$");
  await expect(cell).toContainText(/current pools?/);
  await expect(cell).not.toContainText(/Not measured|Not reported|No fresh/);
  s.verify();
});

// ── The picker and the palette name the snapshot ────────────────────────────

const ABSENT_ADDRESS = "0x1111111111111111111111111111111111111111";
assert(
  !snapshot.projects.some((project) =>
    project.deployments.some(
      (hook) => hook.address.toLowerCase() === ABSENT_ADDRESS,
    ),
  ),
  "the address used to look for an absent hook is in the data",
);

for (const [sizeName, size] of Object.entries(SIZES))
  test(`[${sizeName}] the picker searches this snapshot and says what it carries when nothing matches`, async (t) => {
    const s = await site(t, size);
    await s.goto("?view=compare");
    const guide = s.page.locator(".comparison-empty-guide");
    await expect(guide).toContainText("Search this snapshot");
    await expect(guide).not.toContainText("Search the full directory");
    await expect(s.page.getByRole("main")).not.toContainText("full directory");
    await s.page
      .locator(".comparison-search input")
      .first()
      .fill(ABSENT_ADDRESS);
    const status = s.page.locator(".comparison-picker-status");
    await expect(status).toHaveText(
      "Nothing in this snapshot matches. It carries registry-named projects and projects with a measured pool, so other hooks are not included.",
    );
    await expect(status).not.toContainText("No projects match");
    s.verify();
  });

test("the palette's address search says it looks in this snapshot", async (t) => {
  const s = await site(t);
  await s.goto("?view=compare");
  await s.page.keyboard.press("Control+k");
  const palette = s.page.getByRole("dialog");
  await expect(palette).toBeVisible();
  await s.page.keyboard.type(ABSENT_ADDRESS);
  const search = palette
    .getByRole("option")
    .filter({ hasText: "Search Discover for" });
  await expect(search).toContainText("Look for the hook in this snapshot");
  await expect(palette).not.toContainText("in the directory");
  await s.page.keyboard.press("Escape");
  s.verify();
});

// ── A link that names a project the snapshot does not carry ─────────────────

const [first, second] = comparable.filter((project) =>
  snapshot.pools.some((pool) => pool.projectId === project.id),
);
const UNKNOWN = "hook-0000000000000000zzzz";
const SECOND_UNKNOWN = "hook-1111111111111111yyyy";
const LINE = ".comparison-not-carried";

const EXPECT_DROPPED = process.env.RADAR_EXPECT_UNKNOWN_IDS_DROPPED === "1";
const SKIP =
  "this build drops ids the snapshot does not carry before Compare sees them (RADAR_EXPECT_UNKNOWN_IDS_DROPPED=1)";

/** Open a link. A build that drops an id it does not carry fails the check,
 * unless the run says that is expected: then this returns false and the check
 * skips itself. */
async function openLink(s, ids) {
  await s.goto(`?view=compare&compare=${ids.join(",")}`);
  await s.page.waitForTimeout(600);
  const kept = ids.every((id) => compareIds(s.page).includes(id));
  if (!kept && !EXPECT_DROPPED)
    assert.fail(
      `the address lost an id the snapshot does not carry (${compareIds(s.page).join(",") || "none left"}): ` +
        "the app drops it before Compare can name it. Set RADAR_EXPECT_UNKNOWN_IDS_DROPPED=1 only for a build that is meant to.",
    );
  return kept;
}

for (const [sizeName, size] of Object.entries(SIZES))
  test(`[${sizeName}] a link naming a missing project shows the others, says so and removes it on request`, async (t) => {
    assert(first && second, "the data has two comparable projects with pools");
    const s = await site(t, size);
    if (!(await openLink(s, [first.id, UNKNOWN, second.id])))
      return t.skip(SKIP);
    const main = s.page.getByRole("main");
    const line = s.page.locator(LINE);
    await expect(line).toContainText(
      "This link names 1 project this snapshot does not carry (it carries registry-named projects and projects with at least one measured pool):",
    );
    await expect(line).toContainText(UNKNOWN);
    // Two columns, never a third that waits for a service that is not there.
    await expect(s.page.getByTestId("hook-comparison")).toHaveAttribute(
      "data-count",
      "2",
    );
    await expect(main).not.toContainText("Loading project details");
    await expect(
      s.page.locator('.comparison-selection [aria-busy="true"]'),
    ).toHaveCount(0);
    await expect(
      s.page.getByRole("button", {
        name: `Remove ${first.name} from comparison`,
      }),
    ).toBeVisible();
    // The address is left alone until the visitor removes the id.
    assert.deepEqual(compareIds(s.page), [first.id, UNKNOWN, second.id]);
    if (sizeName === "phone") assert(await noSideScroll(s.page), "side scroll");
    await s.page
      .getByRole("button", { name: `Remove ${UNKNOWN} from this link` })
      .click();
    await expect(line).toHaveCount(0);
    await expect(s.page.getByTestId("hook-comparison")).toHaveAttribute(
      "data-count",
      "2",
    );
    await expect.poll(() => compareIds(s.page)).toEqual([first.id, second.id]);
    await expect.poll(() => focusInPicker(s.page)).toBe(true);
    s.verify();
  });

test("a link naming only missing projects leaves the empty picker and removes them one by one", async (t) => {
  const s = await site(t);
  if (!(await openLink(s, [UNKNOWN, SECOND_UNKNOWN]))) return t.skip(SKIP);
  await expect(s.page.getByRole("heading", { level: 2 })).toHaveText(
    "Choose projects to compare",
  );
  await expect(s.page.locator(LINE)).toContainText(
    "This link names 2 projects this snapshot does not carry",
  );
  await expect(
    s.page.locator(".comparison-search input").first(),
  ).toBeVisible();
  await expect(s.page.locator(".comparison-empty-guide")).toBeVisible();
  await expect(s.page.locator("table")).toHaveCount(0);
  await expect(s.page.getByRole("main")).not.toContainText(
    "Loading project details",
  );
  await s.page
    .getByRole("button", { name: `Remove ${UNKNOWN} from this link` })
    .click();
  await expect(s.page.locator(LINE)).toContainText("This link names 1 project");
  // Focus stays in the list while it has an entry left.
  await expect
    .poll(() =>
      s.page.evaluate(
        () =>
          document.activeElement?.closest(".comparison-not-carried") !== null,
      ),
    )
    .toBe(true);
  await s.page
    .getByRole("button", { name: `Remove ${SECOND_UNKNOWN} from this link` })
    .click();
  await expect(s.page.locator(LINE)).toHaveCount(0);
  await expect.poll(() => compareIds(s.page)).toEqual([]);
  await expect.poll(() => focusInPicker(s.page)).toBe(true);
  s.verify();
});

test("adding a project keeps a missing one listed until the visitor removes it", async (t) => {
  const s = await site(t);
  if (!(await openLink(s, [first.id, UNKNOWN]))) return t.skip(SKIP);
  await s.page.locator(".comparison-search input").first().fill(second.name);
  await s.page
    .getByRole("button", { name: `Add ${second.name}`, exact: true })
    .click();
  await expect(s.page.getByTestId("hook-comparison")).toHaveAttribute(
    "data-count",
    "2",
  );
  await expect(s.page.locator(LINE)).toContainText(UNKNOWN);
  await expect
    .poll(() => compareIds(s.page))
    .toEqual([first.id, second.id, UNKNOWN]);
  s.verify();
});

test("[phone] a long unbroken id wraps inside the notice, so its sentence stays readable", async (t) => {
  assert(first && second, "the data has two comparable projects with pools");
  const long = "x".repeat(100); // the longest id a link can carry
  const s = await site(t, SIZES.phone);
  if (!(await openLink(s, [first.id, long, second.id]))) return t.skip(SKIP);
  const inside = () =>
    s.page.evaluate(() => {
      const notice = document
        .querySelector(".comparison-not-carried")
        .getBoundingClientRect();
      return [
        ...document.querySelectorAll(
          ".comparison-not-carried > div, .comparison-not-carried p, .comparison-not-carried code",
        ),
      ].every((part) => part.getBoundingClientRect().right <= notice.right + 1);
    });
  for (const width of [390, 320]) {
    await s.page.setViewportSize({ width, height: 700 });
    await expect(s.page.locator(LINE)).toContainText(long);
    assert(
      await inside(),
      `the notice's text runs past its edge at ${width}px`,
    );
    assert(await noSideScroll(s.page), `side scroll at ${width}px`);
  }
  s.verify();
});

for (const [sizeName, size] of Object.entries(SIZES))
  test(`[${sizeName}] the notice keeps its icon beside the sentence and each id in a row with its Remove button, without a list indent`, async (t) => {
    assert(first && second, "the data has two comparable projects with pools");
    const s = await site(t, size);
    if (!(await openLink(s, [first.id, UNKNOWN, SECOND_UNKNOWN, second.id])))
      return t.skip(SKIP);
    await expect(s.page.locator(`${LINE} li`)).toHaveCount(2);
    const layout = await s.page.evaluate(() => {
      const notice = document.querySelector(".comparison-not-carried");
      const box = (element) => element.getBoundingClientRect();
      const sentence = notice.querySelector("p");
      const icon = box(notice.querySelector(":scope > svg"));
      const firstLine =
        box(sentence).top +
        parseFloat(getComputedStyle(sentence).lineHeight) / 2;
      return {
        marker: getComputedStyle(notice.querySelector("ul")).listStyleType,
        // How far the icon's centre is from the middle of the sentence's first line.
        iconOffset: icon.top + icon.height / 2 - firstLine,
        rows: [...notice.querySelectorAll("li")].map((item) => {
          const id = box(item.querySelector("code"));
          const button = box(item.querySelector("button"));
          const beside = button.top < id.bottom && button.bottom > id.top;
          return {
            // The id starts where the sentence starts.
            indent: id.left - box(sentence).left,
            // Beside the id, close to it; or, when the row is too narrow, under it.
            place: beside ? button.left - id.right : button.left - id.left,
            beside,
          };
        }),
      };
    });
    assert.equal(layout.marker, "none", "the ids are bulleted");
    assert(
      Math.abs(layout.iconOffset) <= 3,
      `the icon is ${layout.iconOffset.toFixed(1)}px off the sentence's first line`,
    );
    for (const row of layout.rows) {
      assert(Math.abs(row.indent) <= 1, `an id is indented ${row.indent}px`);
      if (row.beside)
        assert(row.place <= 24, `Remove is ${row.place}px from its id`);
      else
        assert(
          Math.abs(row.place) <= 1,
          "a wrapped Remove is not under its id",
        );
    }
    s.verify();
  });

// ── Ids that are set aside are not selected projects ────────────────────────
// They stay in the state so the address keeps them, so every count and limit
// outside Compare has to leave them out: the nav badge, the selection tray and
// the four-place limit on the Add buttons. These live in src/App.tsx, not in
// Compare: when they fail, the app counts ids the snapshot does not carry.
const COUNTED =
  "the app counts ids the snapshot does not carry (src/App.tsx must count only the projects the snapshot carries; Compare itself already sets them aside)";

test("the Compare badge and the selection tray count the projects the snapshot carries", async (t) => {
  const s = await site(t);
  if (!(await openLink(s, [first.id, UNKNOWN, SECOND_UNKNOWN, second.id])))
    return t.skip(SKIP);
  await expect(
    s.page.getByTestId("view-compare").locator(".nav-count"),
    `the nav badge: ${COUNTED}`,
  ).toHaveText("2");
  await s.page.getByTestId("view-overview").click();
  await expect(
    s.page.locator(".compare-tray"),
    `the selection tray: ${COUNTED}`,
  ).toContainText("2 selected");
  s.verify();
});

test("a project can still be added from Discover while ids the snapshot lacks fill the address", async (t) => {
  const s = await site(t);
  // One carried and three set aside: three of the four places are still free.
  if (
    !(await openLink(s, [
      first.id,
      UNKNOWN,
      SECOND_UNKNOWN,
      "hook-2222222222222222xxxx",
    ]))
  )
    return t.skip(SKIP);
  await s.page.getByTestId("view-overview").click();
  // Any card that is not selected yet (the selected one says "Remove").
  const add = s.page
    .getByRole("button", { name: /^Add .+ to comparison$/ })
    .first();
  await expect(add).toBeVisible({ timeout: 30000 });
  await add.click();
  await expect(
    s.page.locator(".compare-tray"),
    `Add did nothing: ${COUNTED}`,
  ).toContainText("2 selected");
  s.verify();
});
