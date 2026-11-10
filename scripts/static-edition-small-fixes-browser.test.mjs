// The small presentation fixes of the Auto Snapshot edition, in a real browser:
// no dead "Latest hook updates" panel, long source notes that wrap inside Data
// & sources, and phone tap targets (the retry beside an error, the small text
// links and summaries, the select fields). The component and stylesheet checks
// that need no browser are in tests/edition-small-fixes.test.mjs.
//
// Like scripts/static-edition-browser.test.mjs it builds nothing: point it at
// an edition build (VITE_STATIC_EDITION=1) with RADAR_TEST_DIST. It serves that
// build next to deterministic TEST data (tests/fixtures/static-data/data, or the
// folder RADAR_TEST_DATA names, such as a real snapshot) through
// scripts/static-edition-server.mjs, which answers every /api path with 404 and
// records every request. No production data, no network, no service.
//
//   RADAR_TEST_DIST=<edition build> node --test scripts/static-edition-small-fixes-browser.test.mjs
//
// It lives here, not under tests/, because `npm test` runs every tests/*.test.mjs
// with RADAR_TEST_DIST pointing at the live build when someone is testing the
// live interface, and an edition-only check cannot pass against that.
// RADAR_TEST_LIVE_DIST may name a build made WITHOUT the flag: one more test
// then proves that build takes none of the edition's presentation changes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test, { after, before } from "node:test";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { startStaticEditionServer } from "./static-edition-server.mjs";
import { getLaunchpad } from "../shared/launchpad-registry.ts";

const DIST = resolve(process.env.RADAR_TEST_DIST || "dist");
const LIVE = process.env.RADAR_TEST_LIVE_DIST
  ? resolve(process.env.RADAR_TEST_LIVE_DIST)
  : null;
const DATA = resolve(
  process.env.RADAR_TEST_DATA || "tests/fixtures/static-data/data",
);

// A live build never reaches the end of a wait for the edition's own page:
// say so at once instead of after thirty seconds per test.
const builtPage = readFileSync(resolve(DIST, "index.html"), "utf8");
if (!/<html[^>]*\sdata-edition="snapshot"/.test(builtPage))
  throw new Error(
    `${DIST} is not an edition build: its index.html has no data-edition="snapshot" on the root element. Build with VITE_STATIC_EDITION=1 and name it in RADAR_TEST_DIST.`,
  );

const DESKTOP = { width: 1440, height: 1000 };
const PHONE = { width: 390, height: 844 };
const SAVED = "hook-radar-watchlist-v1";

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

const snapshot = () =>
  JSON.parse(readFileSync(resolve(DATA, "snapshot.json"), "utf8"));

/** The build served next to the data, with the visitor on a phone or a desktop.
 * `data` replaces named data files (null: not found). */
async function site(
  t,
  { size = PHONE, data = {}, saved = null, dist = DIST } = {},
) {
  const server = await startStaticEditionServer({
    distDir: dist,
    dataDir: DATA,
    mount: "/",
  });
  for (const [name, body] of Object.entries(data)) server.setData(name, body);
  const context = await browser.newContext({
    viewport: size,
    reducedMotion: "reduce",
    ...(size.width < 600 ? { hasTouch: true, isMobile: true } : {}),
  });
  if (saved)
    await context.addInitScript(
      ([key, ids]) => localStorage.setItem(key, JSON.stringify(ids)),
      [SAVED, saved],
    );
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  t.after(async () => {
    await context.close();
    await server.close();
  });
  const ready = async () => {
    await expect(page.getByTestId("snapshot-line")).toBeVisible({
      timeout: 30000,
    });
    await page.waitForTimeout(600);
  };
  return {
    page,
    server,
    errors,
    ready,
    goto: (query = "") => page.goto(`${server.url}${query}`),
    /** The page asked no service and threw nothing. */
    verify() {
      assert.deepEqual(errors, [], "page errors");
      assert.deepEqual(server.apiRequests(), [], "requests to /api");
    },
  };
}

const box = (page, selector) =>
  page
    .locator(selector)
    .first()
    .evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return {
        top: rect.top,
        width: rect.width,
        height: rect.height,
      };
    });

/** A project of the snapshot under test, to save in the watchlist. */
const aProject = () => snapshot().projects[0].id;

/** A hook-update event, to show the panel comes back. */
const event = {
  id: "event-1",
  type: "new-deployment",
  title: "Gamma deployment listed",
  description: "A Base deployment was added to the registry.",
  timestamp: "2026-10-27T09:00:00.000Z",
  projectId: null,
  chain: null,
  url: null,
};

test("with no recorded updates the page has no updates panel and keeps the watchlist shortcut", async (t) => {
  const withoutEvents = { ...snapshot(), events: [] };
  for (const viewport of [DESKTOP, PHONE]) {
    const s = await site(t, {
      size: viewport,
      data: { "snapshot.json": withoutEvents },
      saved: [aProject()],
    });
    const phone = viewport === PHONE;
    // Discover: the monitor plate, and nothing of the feed.
    await s.goto();
    await s.ready();
    if (phone) await s.page.locator(".mobile-monitor-toggle").click();
    await expect(s.page.locator(".monitor-panel")).toBeVisible();
    await expect(s.page.locator(".registry-updates")).toHaveCount(0);
    const body = await s.page.locator("body").innerText();
    for (const text of [
      "Latest hook updates",
      "No updates recorded yet",
      "will appear here when detected",
      "Observed changes, not deployment dates",
    ])
      assert.equal(body.includes(text), false, `"${text}" is not on the page`);
    if (!phone) {
      // The plate takes the whole row instead of leaving a column empty.
      const row = await box(s.page, ".monitor-row");
      const plate = await box(s.page, ".monitor-panel");
      assert.ok(
        Math.abs(row.width - plate.width) <= 1,
        `the plate fills the row (${plate.width} of ${row.width})`,
      );
    }
    // The watchlist: the shortcut is there, the feed is not.
    await s.goto("?view=watchlist");
    await s.ready();
    if (phone) await s.page.locator(".mobile-monitor-toggle").click();
    const callout = s.page.locator(".watch-callout");
    await expect(callout).toBeVisible();
    await expect(callout).toContainText("1 project on your watchlist");
    await expect(s.page.locator(".registry-updates h2")).toHaveCount(0);
    assert.equal(
      (await s.page.locator("body").innerText()).includes(
        "Latest hook updates",
      ),
      false,
    );
    if (!phone) {
      // Beside the plate, the shortcut starts level with its top edge: it does
      // not hang below it by the margin it had inside the panel.
      const shortcut = await box(s.page, ".watch-callout");
      const plate = await box(s.page, ".monitor-panel");
      assert.ok(
        Math.abs(shortcut.top - plate.top) <= 1,
        `the shortcut starts at ${shortcut.top}px, the plate at ${plate.top}px`,
      );
    }
    await callout.click();
    await expect(s.page).toHaveURL(/\/(\?|$)/);
    await expect(s.page.getByTestId("view-overview")).toBeVisible();
    s.verify();
  }
});

test("a recorded update brings the panel back, unchanged", async (t) => {
  const withEvent = { ...snapshot(), events: [event] };
  const s = await site(t, {
    size: DESKTOP,
    data: { "snapshot.json": withEvent },
  });
  await s.goto();
  await s.ready();
  const panel = s.page.locator(".registry-updates");
  await expect(panel).toBeVisible();
  await expect(panel.locator("h2")).toHaveText("Latest hook updates");
  await expect(panel).toContainText("Gamma deployment listed");
  await expect(panel.getByRole("radio", { name: "All updates" })).toBeChecked();
  await expect(panel.getByRole("radio", { name: "This view" })).toBeVisible();
  s.verify();
});

test("Data & sources wraps long addresses inside the dialog on a phone", async (t) => {
  const long =
    "Fetched at the start of this snapshot run from https://raw.githubusercontent.com/Uniswap/hooklist/main/an-unbroken-path-that-is-far-longer-than-a-phone-is-wide-0123456789abcdef0123456789abcdef.json.";
  const base = snapshot();
  const data = {
    ...base,
    sources: base.sources.map((source, index) =>
      index === 0 ? { ...source, note: long } : source,
    ),
  };
  for (const viewport of [PHONE, DESKTOP]) {
    const s = await site(t, {
      size: viewport,
      data: { "snapshot.json": data },
    });
    await s.goto();
    await s.ready();
    await s.page.getByTestId("sources-button").click();
    const dialog = s.page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("an-unbroken-path");
    const measured = await dialog.evaluate((node) => {
      const own = node.getBoundingClientRect();
      return {
        scroll: node.scrollWidth,
        client: node.clientWidth,
        page: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
        items: [...node.querySelectorAll(".source-item")].map((item) => {
          const list = item.parentElement.getBoundingClientRect();
          const rect = item.getBoundingClientRect();
          const note = item.querySelector("p");
          return {
            name: item.querySelector("strong")?.textContent,
            outside: Math.max(
              0,
              rect.right - list.right,
              list.left - rect.left,
            ),
            noteOverflow: note.scrollWidth - note.clientWidth,
            noteOutside: Math.max(
              0,
              note.getBoundingClientRect().right - own.right,
            ),
          };
        }),
      };
    });
    const where = `at ${viewport.width}px`;
    assert.ok(measured.items.length >= 1, `sources are listed ${where}`);
    for (const item of measured.items) {
      assert.ok(item.outside <= 1, `${item.name} stays in its list ${where}`);
      assert.ok(item.noteOverflow <= 0, `${item.name}'s note fits ${where}`);
      assert.ok(
        item.noteOutside <= 0,
        `${item.name}'s note is inside the dialog ${where}`,
      );
    }
    assert.ok(
      measured.scroll <= measured.client + 1,
      `the dialog does not scroll sideways ${where}`,
    );
    assert.ok(
      measured.page <= measured.viewport,
      `the page does not scroll sideways ${where}`,
    );
    s.verify();
  }
});

test("the small links and the About these numbers line are at least 24px high on a phone", async (t) => {
  const s = await site(t, { size: PHONE });
  await s.goto();
  await s.ready();
  const summary = s.page.locator(".overview-data-notes summary").first();
  assert.ok((await box(s.page, ".overview-data-notes summary")).height >= 24);
  await summary.click();
  const coverage = s.page.locator(".overview-data-notes button").first();
  await expect(coverage).toBeVisible();
  assert.ok((await box(s.page, ".overview-data-notes button")).height >= 24);
  await s.page.getByTestId("sources-button").click();
  await expect(s.page.getByRole("dialog")).toBeVisible();
  const links = s.page.locator(".source-meta a.external");
  const count = await links.count();
  assert.ok(count >= 1, "the sources have links");
  for (let index = 0; index < count; index += 1) {
    const height = await links
      .nth(index)
      .evaluate((el) => el.getBoundingClientRect().height);
    assert.ok(
      height >= 24,
      `View source link ${index + 1} is ${height}px high`,
    );
  }
  s.verify();
});

test("on a desktop the small links keep their size", async (t) => {
  const s = await site(t, { size: DESKTOP });
  await s.goto();
  await s.ready();
  assert.ok((await box(s.page, ".overview-data-notes summary")).height < 24);
  await s.page.getByTestId("sources-button").click();
  await expect(s.page.getByRole("dialog")).toBeVisible();
  assert.ok((await box(s.page, ".source-meta a.external")).height < 24);
  s.verify();
});

/** The launchpad drawer for Bags with its first hook also listed in the
 * snapshot, so that every kind of small link and summary the drawer has is on
 * screen: the hook's explorer link, the other contracts' (opened), the evidence
 * sources, the availability source, the "Indexed as" button and the three
 * disclosure summaries. The deployment is TEST data added to the snapshot the
 * test serves; nothing is written anywhere else. */
function withBagsIndexed() {
  const bags = getLaunchpad("bags");
  const path = bags.paths.find((item) => item.hooks.length > 0);
  const hook = path.hooks[0];
  const data = snapshot();
  const project = data.projects[0];
  project.deployments.push({
    ...project.deployments[0],
    id: `${path.chain}:${hook.address}`,
    address: hook.address,
    chain: path.chain,
  });
  return data;
}

const DRAWER_TARGETS = {
  "explorer link of a hook": ".lp-address .external",
  "explorer link of another contract": ".lp-contracts li .external",
  "evidence source": ".lp-evidence .external",
  "availability source": ".platform-availability-source .external",
  "indexed-as button": ".lp-link",
  "other contracts summary": ".lp-contracts > summary",
  "not attributed summary": ".lp-unattributed > summary",
  "unresolved summary": ".lp-unresolved > summary",
};

test("the launchpad drawer's small links and summaries are at least 24px high on a phone, and keep their size on a desktop", async (t) => {
  for (const viewport of [PHONE, DESKTOP]) {
    const s = await site(t, {
      size: viewport,
      data: { "snapshot.json": withBagsIndexed() },
    });
    await s.goto("?project=bags");
    const drawer = s.page.locator(".launchpad-paths");
    await expect(drawer).toBeVisible({ timeout: 30000 });
    await expect(drawer.locator(".lp-link")).toBeVisible({ timeout: 30000 });
    // The contracts, attributed and unresolved notes are closed until opened:
    // open them so every link inside is laid out.
    await s.page
      .locator(
        "details.lp-contracts, details.lp-unattributed, details.lp-unresolved",
      )
      .evaluateAll((all) => all.forEach((details) => (details.open = true)));
    await s.page.waitForTimeout(300);
    for (const [name, selector] of Object.entries(DRAWER_TARGETS)) {
      const heights = await s.page
        .locator(selector)
        .evaluateAll((all) =>
          all.map((el) => el.getBoundingClientRect().height),
        );
      assert.ok(heights.length >= 1, `the drawer has a ${name} (${selector})`);
      for (const height of heights)
        if (viewport === PHONE)
          assert.ok(height >= 24, `the ${name} is ${height}px high on a phone`);
        else
          assert.ok(
            height < 24,
            `the ${name} is ${height}px high on a desktop (it keeps its size)`,
          );
    }
    assert.ok(
      (await s.page.evaluate(() => document.documentElement.scrollWidth)) <=
        viewport.width,
      "no sideways scroll",
    );
    s.verify();
  }
});

test("Retry beside a load error is a 44px target on a phone and unchanged on a desktop", async (t) => {
  for (const [name, query, data, retry] of [
    ["the snapshot", "", { "snapshot.json": null }, /^Retry$/],
    [
      "the analytics overview",
      "?view=analytics",
      { "overview-all-h24.json": null },
      /^Retry analytics$/,
    ],
  ]) {
    for (const viewport of [PHONE, DESKTOP]) {
      const s = await site(t, { size: viewport, data });
      await s.goto(query);
      const button = s.page
        .locator(".error-notice")
        .getByRole("button", { name: retry });
      await expect(button).toBeVisible({ timeout: 30000 });
      const { height } = await box(
        s.page,
        `.error-notice button:text-matches("${retry.source}")`,
      );
      if (viewport === PHONE)
        assert.ok(height >= 44, `Retry for ${name} is ${height}px on a phone`);
      else
        assert.ok(height < 40, `Retry for ${name} is ${height}px on a desktop`);
      assert.ok(
        (await s.page.evaluate(() => document.documentElement.scrollWidth)) <=
          viewport.width,
        `${name}: no sideways scroll`,
      );
    }
  }
});

test("a select field answers a tap over its whole height on a phone", async (t) => {
  const s = await site(t, { size: PHONE });
  await s.goto("?view=analytics");
  await s.ready();
  const field = await box(s.page, ".analytics-network-select");
  const select = await box(s.page, ".analytics-network-select select");
  assert.ok(
    select.height >= 40,
    `the select is ${select.height}px of a ${field.height}px field`,
  );
  s.verify();
});

test("no serious accessibility violation on the changed pages at phone width", async (t) => {
  const s = await site(t, { size: PHONE, saved: [aProject()] });
  const serious = (result) =>
    result.violations.filter((violation) =>
      ["serious", "critical"].includes(violation.impact),
    );
  const tags = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
  for (const query of ["", "?view=watchlist"]) {
    await s.goto(query);
    await s.ready();
    const result = await new AxeBuilder({ page: s.page })
      .withTags(tags)
      .analyze();
    assert.deepEqual(
      serious(result).map(
        (violation) =>
          `${violation.id}: ${violation.nodes[0].target.join(" ")}`,
      ),
      [],
      `page ${query || "/"}`,
    );
  }
  await s.goto();
  await s.ready();
  await s.page.getByTestId("sources-button").click();
  await expect(s.page.getByRole("dialog")).toBeVisible();
  const dialog = await new AxeBuilder({ page: s.page })
    .withTags(tags)
    .analyze();
  assert.deepEqual(
    serious(dialog).map((violation) => violation.id),
    [],
    "Data & sources",
  );
  s.verify();
});

/* ── The edition's stylesheet rules apply to the edition, and only to it ── */

/** What the shared stylesheets do to one stand-in of each kind of element the
 * edition's presentation rules reach. The stand-ins are added to the page being
 * looked at, so the answer is the real cascade of the build under test. */
function probeStyles(page) {
  return page.evaluate(() => {
    const host = document.createElement("div");
    host.innerHTML = [
      '<div class="notice error-notice"><button>Retry</button></div>',
      '<label class="select-control"><select><option>x</option></select></label>',
      '<details class="lp-contracts" open><summary>More</summary></details>',
      '<div class="source-list"><div class="source-item"><div><strong>a</strong></div><p>b</p></div></div>',
    ].join("");
    document.body.append(host);
    const style = (selector) => getComputedStyle(host.querySelector(selector));
    const answer = {
      edition: document.documentElement.getAttribute("data-edition"),
      retryMinHeight: style(".error-notice button").minHeight,
      selectAlignSelf: style(".select-control select").alignSelf,
      summaryMinHeight: style(".lp-contracts > summary").minHeight,
      noteWrap: style(".source-item p").overflowWrap,
      itemMinWidth: style(".source-item").minWidth,
    };
    host.remove();
    return answer;
  });
}

test("the edition's presentation rules are on in the edition build", async (t) => {
  const phone = await site(t, { size: PHONE });
  await phone.goto();
  await phone.ready();
  assert.deepEqual(await probeStyles(phone.page), {
    edition: "snapshot",
    retryMinHeight: "44px",
    selectAlignSelf: "stretch",
    summaryMinHeight: "24px",
    noteWrap: "anywhere",
    itemMinWidth: "0px",
  });
  // On a desktop the touch sizes do not apply; the wrapping of long notes does.
  const desktop = await site(t, { size: DESKTOP });
  await desktop.goto();
  await desktop.ready();
  const answer = await probeStyles(desktop.page);
  assert.equal(answer.edition, "snapshot");
  assert.notEqual(answer.retryMinHeight, "44px");
  assert.notEqual(answer.selectAlignSelf, "stretch");
  assert.notEqual(answer.summaryMinHeight, "24px");
  assert.equal(answer.noteWrap, "anywhere");
});

test(
  "a build without the edition flag takes none of them",
  {
    skip: LIVE
      ? false
      : "set RADAR_TEST_LIVE_DIST to a build made without VITE_STATIC_EDITION",
  },
  async (t) => {
    const html = readFileSync(resolve(LIVE, "index.html"), "utf8");
    assert.doesNotMatch(html, /data-edition/, "the live root has no mark");
    assert.match(html, /display current market\s+data\./);
    // No service answers, so the live page shows its error notice: it is the
    // live page's own presentation that is measured.
    for (const viewport of [PHONE, DESKTOP]) {
      const s = await site(t, { size: viewport, dist: LIVE });
      await s.page.goto(s.server.url);
      await expect(s.page.locator(".error-notice button").first()).toBeVisible({
        timeout: 30000,
      });
      const answer = await probeStyles(s.page);
      assert.equal(answer.edition, null);
      assert.notEqual(answer.retryMinHeight, "44px");
      assert.notEqual(answer.selectAlignSelf, "stretch");
      assert.notEqual(answer.summaryMinHeight, "24px");
      assert.notEqual(answer.noteWrap, "anywhere");
      assert.notEqual(answer.itemMinWidth, "0px");
      const retry = await box(s.page, ".error-notice button");
      assert.ok(
        retry.height < 40,
        `the live Retry is ${retry.height}px high at ${viewport.width}px`,
      );
    }
  },
);
