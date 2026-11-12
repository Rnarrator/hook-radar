// The owner's three edits to the Auto Snapshot edition's page, in a real browser.
//
//   E1  No "Data & sources" dialog and no way into it: no header status pill, no
//       "Data details", "View data coverage", "Data sources" or "Sources &
//       coverage details" button, no footer button, on any page.
//   E2  No provider credit and no logo-notices line in any footer.
//   E3  The guide ("Learn") is the last tab, after Watchlist: in the header, in
//       the phone's bottom tab bar and in the Jump list.
//
// All three hang on one switch, EDITION_SOURCES_DIALOG in src/edition.ts. This
// file asserts the page with it off (the edition as shipped), and, on a build of
// the same source with it on (scripts/edition-sources-build.mjs), that the one
// line brings the dialog, every way into it and the credits back. A build made
// WITHOUT the edition flag (RADAR_TEST_LIVE_DIST) must still show the pill, the
// dialog, the live footer and the old order.
//
// Like the other static-edition browser checks it builds nothing: point it at an
// edition build (VITE_STATIC_EDITION=1) with RADAR_TEST_DIST. By default the data
// is the deterministic TEST data in tests/fixtures/static-data/data;
// RADAR_TEST_DATA names another data folder (the real collector output, say) and
// the pages are derived from that folder's own files, so the same checks run on
// either. The server (scripts/static-edition-server.mjs) answers every /api path
// with 404 and records every request. No production data, no network, no service.
//
//   RADAR_TEST_DIST=<edition build> node --test scripts/edition-sources-dialog-browser.test.mjs
//   RADAR_TEST_DIST=<build> RADAR_TEST_LIVE_DIST=<flagless build> \
//     RADAR_TEST_DATA=<real data folder> \
//     node --test scripts/edition-sources-dialog-browser.test.mjs
//
// If the owner brings the dialog back (the switch set to true in src/edition.ts)
// the tests of its absence are skipped, with that reason, and the tests of the
// restored page run on the build under test as well.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test, { after, before } from "node:test";
import { chromium, expect } from "@playwright/test";
import { startStaticEditionServer } from "./static-edition-server.mjs";
import {
  ownerShowsSources,
  sourcesDialogDist,
} from "./edition-sources-build.mjs";

const DIST = resolve(process.env.RADAR_TEST_DIST || "dist");
const LIVE = process.env.RADAR_TEST_LIVE_DIST
  ? resolve(process.env.RADAR_TEST_LIVE_DIST)
  : null;
const DATA = resolve(
  process.env.RADAR_TEST_DATA || "tests/fixtures/static-data/data",
);
const builtPage = readFileSync(resolve(DIST, "index.html"), "utf8");
if (!/<html[^>]*\sdata-edition="snapshot"/.test(builtPage))
  throw new Error(
    `${DIST} is not an edition build: its index.html has no data-edition="snapshot" on the root element. Build with VITE_STATIC_EDITION=1 and name it in RADAR_TEST_DIST.`,
  );
const SOURCES_DIST = await sourcesDialogDist();

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const SIZES = { desktop: DESKTOP, phone: PHONE };
const MINUTE = 60_000;

const SHIPPED = ownerShowsSources()
  ? "EDITION_SOURCES_DIALOG is true in src/edition.ts: the page has the dialog, and the tests of the restored page run instead"
  : false;

const read = (name) => JSON.parse(readFileSync(resolve(DATA, name), "utf8"));
const snapshot = read("snapshot.json");
const generated = Date.parse(snapshot.generatedAt);
const IDENTIFIER = /^[a-z0-9][a-z0-9-]{0,99}$/;
const named = snapshot.projects.filter(
  (project) => project.entityType !== "platform" && IDENTIFIER.test(project.id),
);
const [first, second] = named;
assert(first && second, "the data holds two named projects");
const network =
  snapshot.chains.find((chain) => chain.slug === "base") ?? snapshot.chains[0];
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

/** A build served next to the data, with the visitor's clock fixed. `saved`
 * seeds the watchlist; `data` replaces named data files (null: not found). */
async function site(
  t,
  {
    size = DESKTOP,
    dist = DIST,
    saved = null,
    data = {},
    allow = () => false,
  } = {},
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
  await context.clock.setFixedTime(generated + 2 * MINUTE);
  if (saved)
    await context.addInitScript(
      ([key, ids]) => localStorage.setItem(key, JSON.stringify(ids)),
      [SAVED, saved],
    );
  const page = await context.newPage();
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !allow(message))
      errors.push(`console: ${message.text()}`);
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
    /** The page threw nothing and asked no service. */
    verify() {
      assert.deepEqual(errors, [], "console and page errors");
      assert.deepEqual(server.apiRequests(), [], "requests to /api");
    },
  };
}

/** Wait for what a page shows when it has loaded: the snapshot's dated line, or
 * (the guide, which loads no snapshot) its heading, or (an Analytics link to a
 * network the snapshot published no file for) its way back to all networks. */
async function loaded(page, kind = "snapshot") {
  if (kind === "snapshot")
    await expect(page.getByTestId("snapshot-line")).toBeVisible({
      timeout: 60000,
    });
  else if (kind === "unpublished")
    await expect(
      page.getByRole("button", { name: "All networks" }),
    ).toBeVisible({ timeout: 60000 });
  else
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({
      timeout: 60000,
    });
  await page.waitForTimeout(500);
}

const flat = (text) => text.replace(/\s+/g, " ").trim();

/** The names of every button and link on the page, as a reader hears them. */
const controls = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("button, a[href], [role=button]")].map(
      (element) =>
        (element.getAttribute("aria-label") || element.textContent || "")
          .replace(/\s+/g, " ")
          .trim(),
    ),
  );

// What each control of the dialog and of the credits says.
const SOURCES_CONTROL =
  /data\s*(?:&|and)\s*sources|data details|data coverage|data sources|sources\s*(?:&|and)\s*coverage|coverage and sources|open sources/i;
// Words that point to those controls or credit a provider, anywhere in the text
// of the page (closed disclosures included).
const SOURCES_WORDS =
  /Data (?:&|and) sources|Data details|View data (?:coverage|sources)|Check coverage and sources|Sources (?:&|and) coverage details|Open sources and coverage/i;
const CREDIT_WORDS =
  /Prices from DEX Screener|for pool discovery and as a fallback|Hooks from the Uniswap hooklist|Hook and pool identities from|Deployment configuration from Frontier|Hook Radar.s own index of PoolManager events|Protocol logos belong to their owners|Third-party notices/i;

/** The page, whole: its text (closed disclosures included), every control and
 * the footer. */
const surface = (page) =>
  page.evaluate(() => {
    const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT"]);
    const text = [];
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    for (let node = walker.nextNode(); node; node = walker.nextNode())
      if (node.parentElement && !skip.has(node.parentElement.tagName))
        text.push(node.textContent);
    const attributes = [];
    for (const element of document.querySelectorAll("[title], [aria-label]"))
      for (const name of ["title", "aria-label"]) {
        const value = element.getAttribute(name);
        if (value) attributes.push(value);
      }
    return {
      text: text.join(" ").replace(/\s+/g, " "),
      attributes: attributes.join(" | ").replace(/\s+/g, " "),
    };
  });

/** Every page type of the edition, and what it takes to have loaded. Each also
 * has a footer to read, except where noted. `saved` seeds the watchlist. */
const PAGES = [
  ["Discover", "", "snapshot"],
  ["By use case", "?view=map", "snapshot"],
  ["Networks", "?view=chains", "snapshot"],
  ["One network", `?view=chains&chain_network=${network.slug}`, "snapshot"],
  ["Launchpads", "?view=chains&chain_role=launchpads", "snapshot"],
  ["Analytics overview", "?view=analytics", "snapshot"],
  [
    "Analytics, one network",
    `?view=analytics&analytics_chain=${network.slug}`,
    "snapshot",
  ],
  [
    "Analytics workspace",
    `?view=analytics&analytics_chain=${network.slug}&window=h1`,
    "snapshot",
  ],
  ["Projects", "?view=projects", "snapshot"],
  ["Compare", `?view=compare&compare=${first.id},${second.id}`, "snapshot"],
  ["Watchlist, empty", "?view=watchlist", "snapshot"],
  ["Watchlist, saved", "?view=watchlist", "snapshot", [first.id]],
  ["Learn", "?view=learn", "heading"],
  ["A project's page", `?project=${first.id}`, "snapshot"],
  ["A launchpad's page", "?project=bags", "snapshot"],
  [
    "A project the snapshot does not carry",
    "?project=not-a-project-of-this-snapshot",
    "snapshot",
  ],
  [
    "A network the snapshot does not carry",
    "?view=chains&chain_network=not-a-network",
    "snapshot",
  ],
  [
    "Analytics for a network with no file",
    "?view=analytics&analytics_chain=not-a-network",
    "unpublished",
  ],
];

/** The page has no way into the data dialog, no credit and no notices. */
async function assertNoSourcesOrCredits(page, where) {
  await expect(page.getByTestId("sources-button"), where).toHaveCount(0);
  await expect(page.locator(".source-status"), where).toHaveCount(0);
  // (A project's page is itself a dialog: it is the data dialog that is absent.)
  await expect(
    page.getByRole("dialog", { name: /Data (?:&|and) sources/ }),
    where,
  ).toHaveCount(0);
  await expect(page.getByTestId("sources-modal"), where).toHaveCount(0);
  await expect(page.locator(".source-item"), where).toHaveCount(0);
  const names = await controls(page);
  assert.deepEqual(
    names.filter((name) => SOURCES_CONTROL.test(name)),
    [],
    `${where}: a control that leads to the data dialog`,
  );
  const { text, attributes } = await surface(page);
  for (const [kind, value] of [
    ["text", text],
    ["a title or aria-label", attributes],
  ]) {
    assert.equal(
      value.match(SOURCES_WORDS)?.[0] ?? null,
      null,
      `${where}: ${kind} points to the data dialog`,
    );
    assert.equal(
      value.match(CREDIT_WORDS)?.[0] ?? null,
      null,
      `${where}: ${kind} credits a provider or the logos`,
    );
  }
  // Nothing links to the notices file, and the credit line is not there.
  await expect(
    page.locator("a[href*='third-party-notices']"),
    where,
  ).toHaveCount(0);
  await expect(
    page.locator(
      ".footer-credit, [data-testid='source-credit'], [data-testid='third-party-notices']",
    ),
    where,
  ).toHaveCount(0);
}

/* ── E1: no Data & sources ─────────────────────────────────────────────── */

for (const [sizeName, size] of Object.entries(SIZES))
  test(
    `[${sizeName}] E1: no page has the data dialog, a way into it, a credit or a notices line`,
    { skip: SHIPPED },
    async (t) => {
      for (const [name, query, kind, saved] of PAGES) {
        // A network the snapshot published no overview file for answers 404
        // for that file, by design; every other page must be silent.
        const s = await site(t, {
          size,
          saved,
          allow:
            kind === "unpublished"
              ? (message) => /404/.test(message.text())
              : undefined,
        });
        await s.goto(query);
        await loaded(s.page, kind);
        await assertNoSourcesOrCredits(s.page, `${name} at ${size.width}px`);
        // The pages with disclosures say nothing different once they are open.
        for (const summary of await s.page.locator("details > summary").all())
          if (await summary.isVisible())
            await summary.click({ timeout: 2000 }).catch(() => {});
        await assertNoSourcesOrCredits(
          s.page,
          `${name} at ${size.width}px, disclosures open`,
        );
        s.verify();
      }
    },
  );

for (const [sizeName, size] of Object.entries(SIZES))
  test(
    `[${sizeName}] E1: a failed snapshot or overview leaves no way into the dialog either`,
    { skip: SHIPPED },
    async (t) => {
      // Discover with no snapshot: the page that says it could not load the radar.
      const lost = await site(t, {
        size,
        data: { "snapshot.json": null },
        allow: () => true,
      });
      await lost.goto("");
      await expect(
        lost.page.getByRole("button", { name: /retry|try again/i }).first(),
      ).toBeVisible({ timeout: 60000 });
      await assertNoSourcesOrCredits(
        lost.page,
        `no snapshot at ${size.width}px`,
      );
      // Analytics with no overview file: its own failure screen.
      const noOverview = await site(t, {
        size,
        data: { "overview-all-h24.json": null },
        allow: () => true,
      });
      await noOverview.goto("?view=analytics");
      await expect(
        noOverview.page
          .getByRole("button", { name: /retry|open full analytics/i })
          .first(),
      ).toBeVisible({ timeout: 60000 });
      await assertNoSourcesOrCredits(
        noOverview.page,
        `no overview at ${size.width}px`,
      );
    },
  );

test(
  "E1: a link or reload that asks for the dialog is ignored, and no key opens it",
  { skip: SHIPPED },
  async (t) => {
    const s = await site(t);
    for (const query of [
      "?modal=sources",
      "?dialog=sources",
      "?sources=1",
      "?view=sources",
      "?view=analytics&modal=sources",
      "#sources",
      "#data-sources",
    ]) {
      await s.goto(query);
      await loaded(s.page);
      await expect(s.page.getByRole("dialog"), query).toHaveCount(0);
      await expect(s.page.getByRole("heading", { level: 1 })).toBeVisible();
      await s.page.reload();
      await loaded(s.page);
      await expect(s.page.getByRole("dialog"), query).toHaveCount(0);
      await expect(s.page.getByTestId("sources-button"), query).toHaveCount(0);
    }
    // The Jump list has no entry for it, however it is asked for.
    await s.goto("");
    await loaded(s.page);
    for (const query of [
      "sources",
      "data sources",
      "data details",
      "coverage",
    ]) {
      await s.page.keyboard.press("Control+k");
      const palette = s.page.getByRole("dialog");
      await expect(palette).toBeVisible();
      await s.page.keyboard.type(query);
      await s.page.waitForTimeout(150);
      const options = await palette
        .getByRole("option")
        .allInnerTexts()
        .then((list) => list.map(flat));
      // (The last option searches the directory for what was typed, and so
      // repeats it; it is not a page.)
      for (const option of options.filter(
        (text) => !text.startsWith("Search Discover for"),
      ))
        assert.doesNotMatch(
          option,
          /Data (?:&|and) sources|Data details|data coverage/i,
          `"${query}" lists ${option}`,
        );
      await s.page.keyboard.press("Escape");
      await expect(s.page.getByRole("dialog")).toHaveCount(0);
    }
    // "?" opens the keyboard list, which has nothing to say about it.
    await s.page.keyboard.press("?");
    const shortcuts = s.page.getByRole("dialog");
    await expect(shortcuts).toBeVisible();
    await expect(shortcuts).toContainText("Keyboard shortcuts");
    assert.doesNotMatch(flat(await shortcuts.innerText()), /sources|coverage/i);
    await s.page.keyboard.press("Escape");
    s.verify();
  },
);

test(
  "E1: what stays: the snapshot line, the scope labels, About these numbers and the footer's other items",
  { skip: SHIPPED },
  async (t) => {
    const s = await site(t);
    await s.goto("");
    await loaded(s.page);
    const line = flat(await s.page.getByTestId("snapshot-line").innerText());
    assert.match(
      line,
      /Snapshot taken \d{1,2} [A-Z][a-z]{2} \d{4}, \d\d:\d\d UTC/,
    );
    // The figure's own scope label, and the disclosure that explains the numbers
    // (without the button that opened the dialog).
    const toggle = s.page.locator(".mobile-stats-toggle");
    if (await toggle.isVisible()) await toggle.click();
    const stats = s.page.locator("#ecosystem-stats");
    await expect(stats).toContainText(
      "Partial coverage · Not total Uniswap volume",
    );
    const notes = s.page.locator(".overview-data-notes");
    await expect(notes.locator("summary")).toContainText("About these numbers");
    await notes.locator("summary").click();
    await expect(notes).toContainText("not total Uniswap volume");
    await expect(notes.locator("button")).toHaveCount(0);
    // The footer: the snapshot's time, the version, Jump, Shortcuts, Suggest a hook.
    const footer = s.page.locator("footer.footer");
    await expect(footer).toContainText("Snapshot taken");
    await expect(footer).toContainText("RADAR / V1.0");
    await expect(footer.getByRole("button", { name: /Jump to/ })).toBeVisible();
    await expect(
      footer.getByRole("button", { name: /Shortcuts/ }),
    ).toBeVisible();
    await expect(
      footer.getByRole("link", { name: "Suggest a hook" }),
    ).toHaveAttribute("href", "https://github.com/Uniswap/hooklist");
    // The file the notices line linked to is still published, though nothing
    // on the page links to it.
    const published = await s.page.request.get(
      `${s.server.url}third-party-notices.txt`,
    );
    assert.equal(published.status(), 200);
    // The Analytics pages keep their scope badge and their "How these numbers are
    // measured" notes.
    await s.goto("?view=analytics");
    await loaded(s.page);
    await expect(
      s.page.locator(".analytics-coverage-badge").first(),
    ).toContainText("Partial coverage · Not total Uniswap volume");
    // The guide's sentence no longer points to "data details".
    await s.goto("?view=learn");
    await loaded(s.page, "heading");
    await expect(s.page.locator(".learn-data-note")).toContainText(
      "Read the scope label beside a figure to see what it covers.",
    );
    await expect(s.page.locator(".learn-data-note")).not.toContainText(
      "data details",
    );
    s.verify();
  },
);

for (const [sizeName, size] of Object.entries(SIZES))
  test(
    `[${sizeName}] E1: the header has no status pill and still lines up`,
    { skip: SHIPPED },
    async (t) => {
      const s = await site(t, { size });
      await s.goto("");
      await loaded(s.page);
      const header = s.page.locator("header.topbar");
      await expect(header.getByRole("button", { name: /Data/ })).toHaveCount(0);
      assert.doesNotMatch(
        flat(await header.innerText()),
        /Data (?:&|and) sources/,
      );
      const boxes = await s.page.evaluate(() => {
        const rect = (selector) => {
          const el = document.querySelector(selector);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return {
            left: r.left,
            right: r.right,
            top: r.top,
            bottom: r.bottom,
            shown: style.display !== "none" && r.width > 0,
          };
        };
        return {
          brand: rect(".topbar .brand"),
          nav: rect(".topbar nav"),
          jump: rect(".topbar .palette-trigger"),
          header: rect(".topbar"),
          viewport: innerWidth,
          scroll: document.documentElement.scrollWidth,
          children: [...document.querySelector(".topbar").children].map(
            (el) => el.tagName.toLowerCase() + "." + el.className,
          ),
        };
      });
      assert.ok(boxes.scroll <= boxes.viewport + 1, "no sideways scroll");
      assert.ok(
        boxes.brand.shown && boxes.jump.shown,
        "brand and Jump are shown",
      );
      // Brand, then (on a desktop) the tabs, then Jump at the right edge: nothing
      // overlaps and nothing is pushed out of the viewport.
      assert.ok(boxes.brand.right <= boxes.jump.left, "brand clears Jump");
      assert.ok(
        boxes.jump.right <= boxes.viewport,
        "Jump is inside the viewport",
      );
      // Jump closes the row at the right with the same gutter the brand has at
      // the left: no gap where the pill was, no drift toward the middle.
      const margin = boxes.viewport - boxes.jump.right;
      assert.ok(
        Math.abs(margin - boxes.brand.left) <= 2,
        `Jump is ${margin}px from the right edge, the brand ${boxes.brand.left}px from the left`,
      );
      if (sizeName === "desktop") {
        assert.ok(boxes.brand.right <= boxes.nav.left, "brand clears the tabs");
        assert.ok(boxes.nav.right <= boxes.jump.left, "the tabs clear Jump");
      }
      assert.ok(
        boxes.children.every((child) => !/source-status/.test(child)),
        boxes.children.join(", "),
      );
      s.verify();
    },
  );

for (const [sizeName, size] of Object.entries(SIZES))
  test(
    `[${sizeName}] E1: the coverage strip keeps no empty row where its buttons were`,
    { skip: SHIPPED },
    async (t) => {
      // Discover keeps its Stats toggle, and nothing else in the action row.
      const s = await site(t, { size });
      await s.goto("");
      await loaded(s.page);
      const actions = s.page.locator(".coverage-strip .coverage-actions");
      await expect(actions).toHaveCount(1);
      // (The toggle is hidden by style on a desktop, so read the text, not what
      // is shown.)
      assert.deepEqual(
        (await actions.locator("button").allTextContents())
          .map(flat)
          .map((text) =>
            /Stats|ecosystem stats/i.test(text) ? "stats" : text,
          ),
        ["stats"],
      );
      // The workspaces that carry their own figures have no action row at all.
      for (const query of [
        "?view=analytics&analytics_chain=" + network.slug + "&window=h1",
        "?view=chains",
        "?view=compare",
      ]) {
        await s.goto(query);
        await loaded(s.page);
        await expect(
          s.page.locator(".coverage-strip .coverage-actions"),
          query,
        ).toHaveCount(0);
      }
      s.verify();
    },
  );

/* ── E2: no credit, no notices, in any footer ─────────────────────────── */

test(
  "E2: every page's footer has the same plain items and neither paragraph",
  { skip: SHIPPED },
  async (t) => {
    const s = await site(t);
    for (const [name, query, kind, saved] of PAGES) {
      // Not the saved watchlist (needs its own visitor) and not the network the
      // snapshot published no file for (its 404 is by design; E1 covers it).
      if (saved || kind === "unpublished") continue;
      await s.goto(query);
      await loaded(s.page, kind);
      const footers = s.page.locator("footer.footer");
      const count = await footers.count();
      if (!count) {
        // Pages that stop at an error or an empty state draw no footer.
        continue;
      }
      for (let i = 0; i < count; i += 1) {
        const text = flat(await footers.nth(i).innerText());
        assert.doesNotMatch(text, /Data (?:&|and) sources/, `${name}: ${text}`);
        assert.doesNotMatch(
          text,
          /Protocol logos|Third-party notices|Prices from|DEX Screener|GeckoTerminal|hooklist|v4\.xyz|PoolManager/,
          `${name}: ${text}`,
        );
        assert.match(text, /RADAR \/ V1\.0/);
        assert.match(text, /Suggest a hook/);
        assert.equal(
          await footers.nth(i).locator("p").count(),
          0,
          `${name}: the footer has no paragraph`,
        );
      }
    }
    s.verify();
  },
);

/* ── E3: Learn is the last tab ─────────────────────────────────────────── */

const TABS = [
  "Discover",
  "Analytics",
  "Projects",
  "Networks",
  "By use case",
  "Compare",
  "Watchlist",
  "Learn",
];

/** The tabs by the order of the page, with where each sits. */
const tabs = (page) =>
  page.evaluate(() =>
    [
      ...document.querySelectorAll("nav[aria-label='Main navigation'] button"),
    ].map((button) => {
      const r = button.getBoundingClientRect();
      return {
        label: button.textContent.replace(/\s+/g, " ").trim(),
        testid: button.getAttribute("data-testid"),
        current: button.getAttribute("aria-current") === "page",
        left: r.left,
        right: r.right,
        top: r.top,
      };
    }),
  );

for (const [sizeName, size] of Object.entries(SIZES))
  test(`[${sizeName}] E3: the tabs are ${TABS.join(", ")}, in the page's order and as they are laid out`, async (t) => {
    const s = await site(t, { size });
    await s.goto("");
    await loaded(s.page);
    const all = await tabs(s.page);
    assert.deepEqual(
      all.map((tab) => tab.label),
      TABS,
    );
    assert.deepEqual(
      all.map((tab) => tab.testid),
      [
        "view-overview",
        "view-analytics",
        "view-projects",
        "view-chains",
        "view-map",
        "view-compare",
        "view-watchlist",
        "view-learn",
      ],
    );
    // The order a reader sees is the order the page has: left to right.
    for (let i = 1; i < all.length; i += 1)
      assert.ok(all[i].left >= all[i - 1].right - 1, `${all[i].label} follows`);
    assert.equal(all.filter((tab) => tab.current).length, 1);
    assert.equal(all.find((tab) => tab.current).label, "Discover");
    // Focus walks the tabs in that order, then reaches Jump.
    await s.page.evaluate(() => document.querySelector(".brand").focus());
    const walked = [];
    for (let i = 0; i < 9; i += 1) {
      await s.page.keyboard.press("Tab");
      walked.push(
        await s.page.evaluate(
          () => document.activeElement?.getAttribute("data-testid") ?? "",
        ),
      );
    }
    assert.deepEqual(walked, [
      "view-overview",
      "view-analytics",
      "view-projects",
      "view-chains",
      "view-map",
      "view-compare",
      "view-watchlist",
      "view-learn",
      "palette-button",
    ]);
    s.verify();
  });

for (const [sizeName, size] of Object.entries(SIZES))
  test(`[${sizeName}] E3: with Learn selected its tab is the last one, current, underlined, in view and focusable`, async (t) => {
    const s = await site(t, { size });
    await s.goto("?view=learn");
    await loaded(s.page, "heading");
    await expect(s.page.getByTestId("view-learn")).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(s.page.getByRole("heading", { level: 1 })).toHaveText(
      "Understand v4 hooks",
    );
    await s.page.waitForTimeout(400);
    const all = await tabs(s.page);
    assert.equal(all.at(-1).label, "Learn");
    assert.ok(all.at(-1).current);
    // The whole tab is in the viewport (the phone's bar scrolls to it).
    assert.ok(all.at(-1).left >= 0, `Learn starts at ${all.at(-1).left}`);
    assert.ok(
      all.at(-1).right <= size.width + 1,
      `Learn ends at ${all.at(-1).right} of ${size.width}`,
    );
    if (sizeName === "phone") {
      const scrolled = await s.page.evaluate(
        () =>
          document.querySelector("nav[aria-label='Main navigation']")
            .scrollLeft,
      );
      assert.ok(scrolled > 0, "the tab bar scrolled to the last tab");
    }
    // The underline sits under the label: on a desktop the one indicator that
    // travels (positioned from the active button), on a phone the active
    // button's own mark.
    const mark = await s.page.evaluate(() => {
      const nav = document.querySelector("nav[aria-label='Main navigation']");
      const active = nav.querySelector("[aria-current='page']");
      const button = active.getBoundingClientRect();
      const phone = getComputedStyle(nav).position === "fixed";
      const target = phone ? active : nav;
      const style = getComputedStyle(target, "::after");
      const own = nav.getBoundingClientRect();
      const left = phone
        ? button.left + parseFloat(style.left)
        : own.left + parseFloat(style.left);
      return {
        phone,
        content: style.content,
        height: parseFloat(style.height),
        left,
        width: parseFloat(style.width),
        button: { left: button.left, right: button.right },
        background: style.backgroundColor,
        ink: nav.dataset.ink ?? null,
      };
    });
    assert.notEqual(mark.content, "none", "the current-tab mark is drawn");
    assert.ok(mark.height >= 2, `the mark is ${mark.height}px high`);
    assert.ok(mark.width > 8, `the mark is ${mark.width}px wide`);
    assert.ok(
      mark.left >= mark.button.left - 1 &&
        mark.left + mark.width <= mark.button.right + 1,
      `the mark (${mark.left}, ${mark.width}) is under the Learn tab (${mark.button.left}-${mark.button.right})`,
    );
    assert.notEqual(mark.background, "rgba(0, 0, 0, 0)");
    if (!mark.phone) assert.equal(mark.ink, "ready");
    // Keyboard focus on the last tab shows a ring that is not clipped.
    await s.page.getByTestId("view-watchlist").focus();
    await s.page.keyboard.press("Tab");
    const focus = await s.page.evaluate(() => {
      const el = document.activeElement;
      const style = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        testid: el.getAttribute("data-testid"),
        outline: style.outlineStyle,
        width: parseFloat(style.outlineWidth),
        inView: r.left >= 0 && r.right <= innerWidth + 1,
      };
    });
    assert.equal(focus.testid, "view-learn");
    assert.notEqual(focus.outline, "none");
    assert.ok(focus.width > 0);
    assert.ok(focus.inView, "the focused tab is in view");
    s.verify();
  });

test("E3: on a phone Learn scrolls into view when it is chosen from the bar, and Discover when the bar is walked back", async (t) => {
  const s = await site(t, { size: PHONE });
  await s.goto("");
  await loaded(s.page);
  const nav = s.page.locator("nav[aria-label='Main navigation']");
  // Discover is on screen and Learn is not yet (seven tabs are wider than the bar).
  let all = await tabs(s.page);
  assert.ok(all[0].left >= 0);
  assert.ok(all.at(-1).right > PHONE.width, "Learn starts off screen");
  await nav.evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
  await s.page.getByTestId("view-learn").click();
  await expect(s.page.getByRole("heading", { level: 1 })).toHaveText(
    "Understand v4 hooks",
  );
  all = await tabs(s.page);
  assert.ok(all.at(-1).current && all.at(-1).right <= PHONE.width + 1);
  await s.page.getByTestId("view-overview").click();
  await expect(s.page.getByTestId("view-overview")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await s.page.waitForTimeout(400);
  all = await tabs(s.page);
  assert.ok(all[0].current && all[0].left >= 0, "Discover is back in view");
  // A link to Learn still works, and so does Back.
  await s.goto("?view=learn");
  await loaded(s.page, "heading");
  await s.page.goBack();
  s.verify();
});

test("E3: the Jump list follows the same order, and Learn is still found by name", async (t) => {
  const s = await site(t);
  await s.goto("");
  await loaded(s.page);
  await s.page.keyboard.press("Control+k");
  const palette = s.page.getByRole("dialog");
  await expect(palette).toBeVisible();
  const pages = (await palette.getByRole("option").allInnerTexts()).map(flat);
  const order = TABS.map((label) =>
    pages.findIndex((option) => option.startsWith(label)),
  );
  assert.ok(
    order.every((index) => index >= 0),
    pages.join(" | "),
  );
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
    `the Jump list is in the tabs' order: ${pages.join(" | ")}`,
  );
  await s.page.keyboard.type("learn");
  await expect(palette.getByRole("option").first()).toContainText("Learn");
  await s.page.keyboard.press("Enter");
  await expect(s.page.getByRole("heading", { level: 1 })).toHaveText(
    "Understand v4 hooks",
  );
  await expect(s.page.getByTestId("view-learn")).toHaveAttribute(
    "aria-current",
    "page",
  );
  s.verify();
});

/* ── The switch on: one line brings it all back ────────────────────────── */

for (const [sizeName, size] of Object.entries(SIZES))
  test(`[${sizeName}] with the switch on, the pill, the dialog, the buttons and the footer credits are back, and Learn is still last`, async (t) => {
    const s = await site(t, { size, dist: SOURCES_DIST });
    await s.goto("");
    await loaded(s.page);
    // The header pill, and the dialog it opens.
    const pill = s.page.getByTestId("sources-button");
    await expect(pill).toBeVisible();
    if (sizeName === "desktop")
      await expect(pill).toContainText("Data & sources");
    await pill.click();
    await expect(s.page.getByRole("dialog")).toContainText("Data coverage");
    await s.page.keyboard.press("Escape");
    // Discover: "Data details", and "View data coverage" in About these numbers.
    await expect(
      s.page.getByRole("button", { name: /Data details/ }),
    ).toBeVisible();
    await s.page.locator(".overview-data-notes summary").click();
    await s.page.getByRole("button", { name: /View data coverage/ }).click();
    await expect(s.page.getByRole("dialog")).toBeVisible();
    await s.page.keyboard.press("Escape");
    // The footer: its button, the provider credit and the notices line.
    const footer = s.page.locator("footer.footer");
    await expect(
      footer.getByRole("button", { name: "Data & sources" }),
    ).toBeVisible();
    await expect(s.page.getByTestId("source-credit")).toContainText(
      "Prices from",
    );
    await expect(s.page.getByTestId("third-party-notices")).toContainText(
      "Protocol logos belong to their owners.",
    );
    await expect(
      s.page.getByTestId("third-party-notices").getByRole("link", {
        name: "Third-party notices",
      }),
    ).toHaveAttribute("href", /third-party-notices\.txt$/);
    // Analytics and Networks have their own way in.
    await s.goto("?view=analytics");
    await loaded(s.page);
    await expect(
      s.page.getByRole("button", { name: /Data sources/ }).first(),
    ).toBeVisible();
    await expect(
      s.page.getByRole("button", { name: /Open sources and coverage details/ }),
    ).toBeVisible();
    await s.goto(`?view=analytics&analytics_chain=${network.slug}&window=h1`);
    await loaded(s.page);
    await expect(
      s.page.getByRole("button", { name: /Data sources/ }).first(),
    ).toBeVisible();
    await s.page.locator(".analytics-method summary").click();
    await expect(
      s.page.getByRole("button", { name: /Check coverage and sources/ }),
    ).toBeVisible();
    await s.goto("?view=chains");
    await loaded(s.page);
    await expect(
      s.page.getByRole("button", { name: /Data sources/ }).first(),
    ).toBeVisible();
    await s.page.locator(".chains-method summary").click();
    await s.page.getByRole("button", { name: /View data sources/ }).click();
    await expect(s.page.getByRole("dialog")).toBeVisible();
    await s.page.keyboard.press("Escape");
    // The guide points to data details again, and is still the last tab.
    await s.goto("?view=learn");
    await loaded(s.page, "heading");
    await expect(s.page.locator(".learn-data-note")).toContainText(
      "Use data details to understand what each figure covers.",
    );
    assert.deepEqual(
      (await tabs(s.page)).map((tab) => tab.label),
      TABS,
    );
    s.verify();
  });

/* ── A build without the edition flag is the live page, as before ──────── */

const LIVE_ORDER = [
  "Discover",
  "Learn",
  "Analytics",
  "Networks",
  "By use case",
  "Activity",
  "Compare",
  "Watchlist",
];

for (const [sizeName, size] of Object.entries(SIZES))
  test(
    `[${sizeName}] a build without the edition flag keeps the pill, the dialog, the live footer and the old tab order`,
    {
      skip: LIVE
        ? false
        : "set RADAR_TEST_LIVE_DIST to a build made without VITE_STATIC_EDITION",
    },
    async (t) => {
      const s = await site(t, { size, dist: LIVE, allow: () => true });
      await s.page.goto(`${s.server.url}?view=learn`);
      await expect(s.page.getByRole("heading", { level: 1 })).toHaveText(
        "Understand v4 hooks",
        { timeout: 60000 },
      );
      await s.page.waitForTimeout(500);
      const html = readFileSync(resolve(LIVE, "index.html"), "utf8");
      assert.doesNotMatch(html, /data-edition/, "the live root has no mark");
      // The tabs: the old order, Activity included.
      assert.deepEqual(
        (await tabs(s.page)).map((tab) => tab.label),
        LIVE_ORDER,
      );
      // The pill is in the header and opens the dialog.
      const pill = s.page
        .locator("header.topbar")
        .getByTestId("sources-button");
      await expect(pill).toBeVisible();
      await pill.click();
      const dialog = s.page.getByRole("dialog", { name: "Data & sources" });
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveAccessibleName("Data & sources");
      await s.page.keyboard.press("Escape");
      await expect(s.page.getByRole("dialog")).toHaveCount(0);
      // The footer: the button, and neither the edition's credit nor its notices.
      const footer = s.page.locator("footer.footer");
      await expect(
        footer.getByRole("button", { name: "Data & sources" }),
      ).toBeVisible();
      await expect(footer.locator(".footer-credit")).toHaveCount(0);
      await expect(s.page.getByTestId("source-credit")).toHaveCount(0);
      await expect(s.page.getByTestId("third-party-notices")).toHaveCount(0);
      await footer.getByRole("button", { name: "Data & sources" }).click();
      await expect(s.page.getByRole("dialog")).toBeVisible();
      await s.page.keyboard.press("Escape");
      // The guide's own sentence is the live one.
      await expect(s.page.locator(".learn-data-note")).toContainText(
        "Use data details to understand what each figure covers.",
      );
      // The Jump list keeps Learn second, and Activity.
      await s.page.keyboard.press("Control+k");
      const palette = s.page.getByRole("dialog");
      await expect(palette).toBeVisible();
      const options = (await palette.getByRole("option").allInnerTexts()).map(
        flat,
      );
      const pages = LIVE_ORDER.map((label) =>
        options.findIndex((option) => option.startsWith(label)),
      );
      assert.ok(
        pages.every((index) => index >= 0),
        options.join(" | "),
      );
      assert.deepEqual(
        pages,
        [...pages].sort((a, b) => a - b),
      );
      // The Projects page is the edition's alone: no tab, no Jump entry, and a
      // link to it lands on Discover.
      assert.equal(
        options.some((option) => option.startsWith("Projects")),
        false,
        options.join(" | "),
      );
      await s.page.keyboard.press("Escape");
      await s.page.goto(`${s.server.url}?view=projects`);
      await expect(s.page.getByRole("heading", { level: 1 })).toHaveText(
        "Uniswap v4 hooks",
        { timeout: 60000 },
      );
      await expect(s.page.getByTestId("view-projects")).toHaveCount(0);
    },
  );
