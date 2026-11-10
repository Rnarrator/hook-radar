// The platform drawers and the Launchpads list of the Auto Snapshot edition in a
// real browser. Like scripts/static-edition-browser.test.mjs it builds nothing:
// point it at an edition build (VITE_STATIC_EDITION=1) with RADAR_TEST_DIST and
// it serves that build next to a data folder through
// scripts/static-edition-server.mjs (every /api path is a 404, every request is
// recorded). The visitor's time zone is UTC+7 so that a tooltip in local time
// cannot pass for UTC.
//
//   RADAR_TEST_DIST=<build> node --test scripts/edition-platform-browser.test.mjs
//
// By default the data is the deterministic TEST data in
// tests/fixtures/static-data/data (a Doppler project is added to its snapshot
// in memory, because the launchpad pages link to it). RADAR_TEST_DATA names
// another folder, such as a real collected snapshot; the cases that need pools
// on a platform's own hooks, or a platform whose hooks have none, then choose
// their subject from that data instead of naming a platform (each is
// skipped, with the reason, when the snapshot holds no such platform).
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { startStaticEditionServer } from "./static-edition-server.mjs";
import { fullTimeLabel } from "../src/edition.ts";
import {
  getLaunchpad,
  launchpadRegistry,
} from "../shared/launchpad-registry.ts";

const DIST = resolve(process.env.RADAR_TEST_DIST || "dist");
const DATA = resolve(
  process.env.RADAR_TEST_DATA || "tests/fixtures/static-data/data",
);
const REAL = Boolean(process.env.RADAR_TEST_DATA);
const DESKTOP = { width: 1440, height: 1000 };
const PHONE = { width: 390, height: 844 };

const snapshotFile = JSON.parse(
  readFileSync(resolve(DATA, "snapshot.json"), "utf8"),
);
const generatedAt = snapshotFile.generatedAt;
const SNAPSHOT_TAKEN = `Snapshot taken ${fullTimeLabel(generatedAt)}`;
const NOT_IN_SAMPLE =
  "None of its pools are in this snapshot’s measured sample";

/** The snapshot as served: with a Doppler project when the data has none, so
 * the "Open Doppler hooks and pools" link has somewhere to go. Test data only. */
function servedSnapshot() {
  if (snapshotFile.projects.some((project) => project.id === "doppler"))
    return null;
  const donor = structuredClone(
    snapshotFile.projects.find((project) => project.id === "gamma") ??
      snapshotFile.projects[0],
  );
  const hex = (n) => `0x${n.toString(16).padStart(40, "d")}`;
  const doppler = {
    ...donor,
    id: "doppler",
    name: "Doppler",
    deployments: donor.deployments.map((hook, index) => ({
      ...hook,
      id: `${hook.chain}:${hex(index + 1)}`,
      address: hex(index + 1),
      name: `Doppler${index + 1}`,
    })),
  };
  return { ...snapshotFile, projects: [...snapshotFile.projects, doppler] };
}

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

async function site(t, { size = DESKTOP, timezoneId = "Asia/Bangkok" } = {}) {
  const server = await startStaticEditionServer({
    distDir: DIST,
    dataDir: DATA,
  });
  const served = servedSnapshot();
  if (served) server.setData("snapshot.json", served);
  const context = await browser.newContext({
    viewport: size,
    timezoneId,
    reducedMotion: "reduce",
  });
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
    goto: (query = "") => page.goto(`${server.url}${query}`),
    verify() {
      assert.deepEqual(errors, [], "console and page errors");
      assert.deepEqual(
        server.apiRequests().map((row) => `${row.method} ${row.path}`),
        [],
        "requests to /api",
      );
    },
    snapshotRequests: () =>
      server
        .dataRequests()
        .filter((row) => row.path.endsWith("/snapshot.json")),
  };
}

const drawerText = (page) => page.locator(".platform-detail").innerText();

/** "chain:address" of the hook of every pool in the snapshot being read. */
const measuredHooks = new Set(
  snapshotFile.pools.map(
    (pool) => `${pool.chain}:${(pool.hookAddress ?? "").toLowerCase()}`,
  ),
);

/** The exact hooks a platform publishes as its own, as "chain:address". */
function ownHooks(record) {
  return record.paths
    .filter((path) => path.attribution === "platform-hook")
    .flatMap((path) =>
      path.hooks.map((hook) => `${path.chain}:${hook.address.toLowerCase()}`),
    );
}

/** The platforms whose own exact hooks have a pool in the snapshot being read
 * (which platforms those are changes with every collected snapshot). */
function platformsWithPools(limit = 3) {
  return launchpadRegistry
    .filter((record) => ownHooks(record).some((key) => measuredHooks.has(key)))
    .map((record) => record.id)
    .slice(0, limit);
}

/** The platforms that publish exact hooks of their own, none of which has a
 * pool in the snapshot being read. The test data's snapshot holds no pool on
 * any platform's hook, so Arrows and Bags are such platforms there; a real
 * snapshot is asked instead, because a platform that had no pool in one
 * collection can have one in the next. A platform the snapshot itself publishes
 * as a project is left out: its drawer is the project's, not the registry's. */
function platformsWithoutPools(limit = 2) {
  const published = new Set(snapshotFile.projects.map((project) => project.id));
  const subjects = REAL
    ? launchpadRegistry.filter((record) => {
        const own = ownHooks(record);
        return (
          own.length > 0 &&
          !own.some((key) => measuredHooks.has(key)) &&
          !published.has(record.id)
        );
      })
    : [getLaunchpad("arrows"), getLaunchpad("bags")];
  return subjects.slice(0, limit).map(({ id, name }) => ({ id, name }));
}

const NO_POOLED_PLATFORM_SKIP =
  "no platform that publishes exact hooks has a pool in this snapshot";
const NO_POOL_SKIP =
  "every platform that publishes exact hooks has a pool in this snapshot";

test("a platform with no pool in the sample says so, and dates the figures, at 1440 and 390 px", async (t) => {
  // Platforms that publish exact hooks, none of whose pools is in the sample:
  // Arrows and Bags in the test data, whatever the snapshot holds otherwise.
  const platforms = platformsWithoutPools();
  if (platforms.length === 0) return t.skip(NO_POOL_SKIP);
  for (const size of [DESKTOP, PHONE])
    for (const { id } of platforms) {
      const s = await site(t, { size });
      await s.goto(`?project=${id}`);
      await expect(s.page.locator(".platform-market-note")).toContainText(
        SNAPSHOT_TAKEN,
        { timeout: 30000 },
      );
      const text = await drawerText(s.page);
      const where = `${id} at ${size.width}`;
      const notes = await s.page
        .locator(".platform-market .readout-note")
        .allInnerTexts();
      assert.deepEqual(notes, [NOT_IN_SAMPLE, NOT_IN_SAMPLE], where);
      assert.doesNotMatch(text, /None found in the loaded data/, where);
      assert.doesNotMatch(text, /No price within five minutes/, where);
      assert.match(
        text,
        new RegExp(
          `Snapshot taken ${fullTimeLabel(generatedAt).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.`,
        ),
        where,
      );
      // The sentence is in the drawer itself, which covers the page's own line.
      const covered = await s.page.evaluate(() => {
        const drawer = document.querySelector(".platform-detail");
        const note = document.querySelector(".platform-market-note");
        return drawer.contains(note);
      });
      assert.equal(covered, true, where);
      s.verify();
    }
});

test("a note that quotes the live index's pool count is dated by its review, unedited", async (t) => {
  const s = await site(t);
  await s.goto("?project=tokenworks");
  const asOf = s.page.locator(".platform-availability-asof");
  await expect(asOf).toHaveText("Review notes as of 24 Oct 2026", {
    timeout: 30000,
  });
  // It sits directly above the finding it dates, and the finding is verbatim.
  const lead = await s.page
    .locator(".platform-availability-asof + .platform-availability-lead")
    .innerText();
  assert.match(
    lead,
    /Radar shows 19 pools on the current hook with small 24h volume\.$/,
  );
  // A finding with nothing quoted from the live index carries no such heading.
  await s.goto("?project=arrows");
  await expect(s.page.locator(".platform-availability-lead")).toBeVisible();
  assert.equal(await s.page.locator(".platform-availability-asof").count(), 0);
  s.verify();
});

// Only a real collected snapshot has pools on a platform's own exact hooks.
test(
  "a platform with pools in the sample keeps its counts and says how they were priced",
  {
    skip: REAL
      ? false
      : "needs RADAR_TEST_DATA with pools on a platform's hooks",
  },
  async (t) => {
    const ids = platformsWithPools();
    // A real snapshot can hold no pool on any platform's own hooks; the case
    // then has no subject, and says so instead of failing.
    if (ids.length === 0) return t.skip(NO_POOLED_PLATFORM_SKIP);
    for (const size of [DESKTOP, PHONE])
      for (const id of ids) {
        const s = await site(t, { size });
        await s.goto(`?project=${id}`);
        await expect(s.page.locator(".platform-market-note")).toContainText(
          SNAPSHOT_TAKEN,
          { timeout: 30000 },
        );
        const where = `${id} at ${size.width}`;
        const values = await s.page
          .locator(".platform-market .readout-value")
          .allInnerTexts();
        const notes = await s.page
          .locator(".platform-market .readout-note")
          .allInnerTexts();
        assert.match(values[0], /^≥\d/, where);
        assert.match(notes[0], /^On \d+ of its \d+ published hooks?$/, where);
        // Priced pools: a count and the five-minute rule at the snapshot's own
        // time; pools that exist but are not current say that instead.
        assert.match(
          notes[1],
          /^(\d[\d,]* pools? priced within 5 minutes of the snapshot|No price within five minutes of the snapshot)$/,
          where,
        );
        assert.notEqual(notes[1], NOT_IN_SAMPLE, where);
        s.verify();
      }
  },
);

test("a link to a protocol opens it inside the page: Back and Forward work and the snapshot is not fetched again", async (t) => {
  for (const size of [DESKTOP, PHONE]) {
    const s = await site(t, { size });
    await s.goto("?project=bankr");
    // Bankr has one relationship per network; the first will do.
    const link = s.page
      .getByRole("link", { name: /Open Doppler hooks and pools/ })
      .first();
    await expect(link).toBeVisible({ timeout: 30000 });
    await expect(s.page.locator(".platform-market-note")).toBeVisible();
    // The link is still a real link (new tab, copy address, no script).
    assert.match(await link.getAttribute("href"), /\?project=doppler$/);
    await s.page.evaluate(() => {
      window.__keptAlive = "same page";
    });
    const before = s.snapshotRequests().length;
    assert.ok(before >= 1, "the snapshot was read once to show the drawer");

    await link.click();
    await expect(s.page).toHaveURL(/\?project=doppler/);
    await expect(s.page.locator(".drawer-body h2").first()).toHaveText(
      "Doppler",
    );
    assert.equal(
      await s.page.evaluate(() => window.__keptAlive),
      "same page",
      "no page load",
    );
    assert.equal(
      s.snapshotRequests().length,
      before,
      "no second snapshot request",
    );

    await s.page.goBack();
    await expect(s.page).toHaveURL(/\?project=bankr/);
    await expect(s.page.locator(".platform-detail h2").first()).toHaveText(
      "Bankr",
    );
    assert.equal(
      await s.page.evaluate(() => window.__keptAlive),
      "same page",
      "Back stays in the page",
    );

    await s.page.goForward();
    await expect(s.page).toHaveURL(/\?project=doppler/);
    await expect(s.page.locator(".drawer-body h2").first()).toHaveText(
      "Doppler",
    );
    assert.equal(
      await s.page.evaluate(() => window.__keptAlive),
      "same page",
      "Forward stays in the page",
    );
    assert.equal(
      s.snapshotRequests().length,
      before,
      "still one snapshot request",
    );
    s.verify();
  }
});

test("the links that stand alone in a platform drawer are at least 24px tall on a phone, and the primary button keeps its 44px on both sizes", async (t) => {
  for (const [size, id] of [PHONE, DESKTOP].flatMap((size) =>
    ["bankr", "tokenworks", "arrows"].map((id) => [size, id]),
  )) {
    const s = await site(t, { size });
    await s.goto(`?project=${id}`);
    await expect(
      s.page.locator(".platform-detail .platform-market-note"),
    ).toBeVisible({
      timeout: 30000,
    });
    await expect(s.page.locator(".launchpad-paths")).toBeVisible();
    const targets = await s.page.evaluate(() =>
      [
        ...document.querySelectorAll(
          ".platform-detail .external, .platform-detail .lp-link",
        ),
      ]
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => ({
          text: element.textContent.trim().slice(0, 40),
          height: element.getBoundingClientRect().height,
        })),
    );
    assert.ok(targets.length >= 3, `${id}: only ${targets.length} links found`);
    // The 24px floor is for touch and narrow screens (platform-detail.css, the
    // same query as design/compact.css); a desktop keeps the links' own size,
    // which static-edition-small-fixes-browser.test.mjs checks.
    const small =
      size === PHONE ? targets.filter((target) => target.height < 23.5) : [];
    assert.deepEqual(small, [], `${id}: links under 24px tall`);
    assert.ok(
      targets.some((target) =>
        /Availability evidence|Explorer|Source/.test(target.text),
      ),
      `${id}: the named controls were measured`,
    );
    // The 24px floor must not shrink a control that is already larger: the
    // primary "Open website" button asks for 2.75rem (44px) in project-detail.css
    // and keeps it, both as a minimum and as a rendered height.
    const primary = await s.page.evaluate(() => {
      const button = document.querySelector(
        ".platform-detail .detail-actions-primary .project-website",
      );
      if (!button) return null;
      const style = getComputedStyle(button);
      return {
        minHeight: Number.parseFloat(style.minHeight),
        height: button.getBoundingClientRect().height,
      };
    });
    const where = `${id} at ${size.width}`;
    assert.ok(primary, `${where}: the primary website button`);
    assert.ok(
      primary.minHeight >= 44,
      `${where}: min-height ${primary.minHeight}`,
    );
    assert.ok(primary.height >= 43.5, `${where}: height ${primary.height}`);
    s.verify();
  }
});

test("the Launchpads list counts pools in the snapshot, not pools found in an index", async (t) => {
  for (const size of [DESKTOP, PHONE]) {
    const s = await site(t, { size });
    await s.goto("?view=chains&chain_role=launchpads");
    await expect(
      s.page.locator("#chains-projects .chains-protocol").first(),
    ).toBeVisible({
      timeout: 30000,
    });
    const labels = await s.page.locator(".chains-protocol dt").allInnerTexts();
    assert.ok(
      labels.some((label) => /^pools in snapshot$/i.test(label.trim())),
    );
    assert.ok(!labels.some((label) => /pools using hooks/i.test(label)));
    // A count that was measured is a floor, and says so as a tooltip. Frontier
    // has one in the test data and in a real snapshot; the sentence is exact.
    const counts = await s.page.evaluate(() =>
      [...document.querySelectorAll(".chains-protocol")].flatMap((element) => {
        const dd = [...element.querySelectorAll("dl > div")]
          .find((group) =>
            /^pools in snapshot$/i.test(
              group.querySelector("dt")?.textContent.trim() ?? "",
            ),
          )
          ?.querySelector("dd");
        const text = dd?.textContent.trim() ?? "";
        return text.startsWith("≥")
          ? [
              {
                name: element.getAttribute("aria-label"),
                text,
                title: dd.getAttribute("title"),
              },
            ]
          : [];
      }),
    );
    assert.ok(counts.length >= 1, "a row with a measured pool count");
    for (const { name, text, title } of counts)
      assert.equal(
        title,
        "At least this many pools were measured in this snapshot",
        `${name}: tooltip of ${text}`,
      );
    s.verify();
  }
});

test("a platform whose hooks have no pool in the sample is listed with a dash and says why", async (t) => {
  // Arrows in the test data; in a real snapshot, the first platform that
  // publishes exact hooks and has no pool among them.
  const [platform] = platformsWithoutPools(1);
  if (!platform) return t.skip(NO_POOL_SKIP);
  for (const size of [DESKTOP, PHONE]) {
    const s = await site(t, { size });
    await s.goto("?view=chains&chain_role=launchpads");
    await expect(
      s.page.locator("#chains-projects .chains-protocol").first(),
    ).toBeVisible({
      timeout: 30000,
    });
    await s.page.fill('input[aria-label="Find a protocol"]', platform.name);
    const row = s.page.locator(
      `.chains-protocol[aria-label=${JSON.stringify(platform.name)}]`,
    );
    await expect(row).toBeVisible();
    const note = await row.locator(".chains-protocol-attribution").innerText();
    assert.match(
      note,
      /^None of the pools on its \d+ published hooks? are in this snapshot’s measured sample\.$/,
      platform.id,
    );
    assert.doesNotMatch(note, /index|yet|unpriced/, platform.id);
    // Its count is not a measurement, so it is a dash with no tooltip.
    const unmeasured = row
      .locator("dl > div")
      .filter({ hasText: /pools in snapshot/i })
      .locator("dd");
    await expect(unmeasured).toHaveText("—");
    assert.equal(await unmeasured.getAttribute("title"), null, platform.id);
    // The list is whole again once the search is cleared.
    await s.page.fill('input[aria-label="Find a protocol"]', "");
    await expect(s.page.locator(".chains-protocol")).not.toHaveCount(1);
    s.verify();
  }
});

test("notes quoting the live index are dated in the Launchpads list too", async (t) => {
  const s = await site(t);
  await s.goto("?view=chains&chain_role=launchpads");
  await expect(
    s.page.locator("#chains-projects .chains-protocol").first(),
  ).toBeVisible({
    timeout: 30000,
  });
  await s.page.fill('input[aria-label="Find a protocol"]', "TokenWorks");
  const row = s.page.locator('.chains-protocol[aria-label^="TokenWorks"]');
  await expect(row).toBeVisible();
  const chip = await row
    .locator(".chain-launchpad-status")
    .getAttribute("title");
  assert.match(chip, /^Review notes as of 24 Oct 2026: .*Radar shows 19 pools/);
  await row.locator("details.chains-protocol-sources > summary").click();
  const status = await row.locator(".chain-launchpad-status-note").innerText();
  assert.match(
    status.replace(/\s+/g, " "),
    /Operating status Live · Review notes as of 24 Oct 2026: .*Radar shows 19 pools/,
  );
  s.verify();
});

test("measurement times in the list read in UTC whatever the visitor's zone", async (t) => {
  for (const timezoneId of ["Asia/Bangkok", "America/Los_Angeles"]) {
    const s = await site(t, { timezoneId });
    await s.goto("?view=chains");
    await expect(
      s.page.locator("#chains-projects .chains-protocol").first(),
    ).toBeVisible({
      timeout: 30000,
    });
    await s.page.evaluate(() =>
      document
        .querySelectorAll(".chains-protocol details")
        .forEach((d) => (d.open = true)),
    );
    const times = await s.page.evaluate(() =>
      [
        ...document.querySelectorAll(
          "#chains-projects .chains-measurement time",
        ),
      ].map((time) => ({
        text: time.innerText.replace(/\s+/g, " ").trim(),
        title: time.title,
        stamp: time.dateTime,
      })),
    );
    assert.ok(times.length > 0, "the list shows at least one measurement time");
    for (const { text, title, stamp } of times) {
      const utc = fullTimeLabel(stamp);
      assert.equal(title, utc, `${timezoneId}: tooltip of ${stamp}`);
      assert.match(
        text,
        new RegExp(`: ${utc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
        `${timezoneId}: text of ${stamp}`,
      );
      assert.doesNotMatch(
        `${text} ${title}`,
        /\b(?:AM|PM|GMT)\b|\(\d/,
        timezoneId,
      );
    }
    s.verify();
  }
});
