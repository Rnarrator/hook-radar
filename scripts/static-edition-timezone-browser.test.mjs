// The Auto Snapshot edition for visitors in two very different time zones. A
// snapshot is a dated, frozen file: every time on the page is a UTC time, and
// the page reads the same wherever the visitor sits. A time written in the
// visitor's own zone ("10:05 PM", "GMT+7", "10/28/2026") would put the same
// measurement at two different moments for two readers, and a page that says
// "Times shown in Asia/Bangkok" would be the live service's wording on a file.
//
// It visits Discover (the Categories, Market activity and History tabs, the
// last with a recorded series of its own, a point selected so the readout is
// read too), Compare, the Watchlist (with saved baselines and recorded changes
// seeded in local storage), a project drawer (Pools and Hooks tabs), a platform
// drawer, Networks, one network, Analytics (the overview, its recorded history,
// the network evidence and the workspace), Launchpads, By use case, Learn and
// the Data & sources and Share dialogs, in Asia/Bangkok (UTC+7) and
// America/New_York (UTC-4 or UTC-5, by the snapshot's date), at 1440 and 390 px,
// with the visitor's clock fixed. It reads every text node (closed disclosures
// included), the page title and every title / aria-label / aria-valuetext / alt
// / placeholder, and it fails when
//
//   * a text or attribute has a local-time shape (a 12-hour clock with AM/PM, a
//     GMT offset, a numeric month/day/year date), or names the visitor's zone;
//   * a page reads differently in the two zones (a 24-hour local clock or a
//     local weekday would pass the shapes above and still differ).
//
// Like scripts/static-edition-browser.test.mjs it builds nothing: point it at an
// edition build (VITE_STATIC_EDITION=1) with RADAR_TEST_DIST. It serves that
// build next to the deterministic TEST data in tests/fixtures/static-data/data
// (or, with RADAR_TEST_DATA, any folder holding the collector's published
// files, such as a real collected snapshot) through
// scripts/static-edition-server.mjs, which answers every /api path with 404.
// Nothing is written and no network is used. The Data & sources pages are read
// on a second build of the same source with the dialog's switch on, because the
// edition itself has no dialog (scripts/edition-sources-build.mjs).
//
//   RADAR_TEST_DIST=dist/test-build \
//     node --test scripts/static-edition-timezone-browser.test.mjs
//   RADAR_TEST_DIST=... RADAR_TEST_DATA=<folder of published files> \
//     node --test scripts/static-edition-timezone-browser.test.mjs
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { startStaticEditionServer } from "./static-edition-server.mjs";
import { sourcesDialogDist } from "./edition-sources-build.mjs";

const DIST = resolve(process.env.RADAR_TEST_DIST || "dist");
// The Data & sources dialog is hidden in the edition (its owner's choice,
// EDITION_SOURCES_DIALOG in src/edition.ts); its pages are read on a build of the
// same source with the switch on (scripts/edition-sources-build.mjs).
const SOURCES_DIST = await sourcesDialogDist();
const DATA = resolve(
  process.env.RADAR_TEST_DATA || "tests/fixtures/static-data/data",
);
const HOUR = 60 * 60_000;
const DESKTOP = { width: 1440, height: 1000 };
const PHONE = { width: 390, height: 844 };

/** A zone's UTC offset in minutes at a moment, as Date#getTimezoneOffset reports
 * it (UTC minus local, so Bangkok is -420), worked out from the zone's own
 * calendar so it follows daylight saving: New York is 240 until the first Sunday
 * of November and 300 after it, and a collected snapshot can be of either. */
function offsetAt(timeZone, ms) {
  const second = Math.floor(ms / 1000) * 1000;
  const part = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    })
      .formatToParts(second)
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, Number(value)]),
  );
  const asIfUtc = Date.UTC(
    part.year,
    part.month - 1,
    part.day,
    part.hour,
    part.minute,
    part.second,
  );
  return (second - asIfUtc) / 60_000;
}

// The shapes of a time in the visitor's zone, as the plan for this check gives
// them. Never loosened: a hit is a product defect, not a reason to edit this.
const LOCAL_TIME =
  /\d{1,2}:\d{2}(:\d{2})?\s?[AP]M|GMT[+-]\d|\b\d{1,2}\/\d{1,2}\/\d{4}/;
// Naming the visitor's zone is as local as writing a time in it: the live page's
// "Times shown in Asia/Bangkok", a long name, an abbreviation or a UTC offset.
const ZONE_NAME =
  /Asia\/Bangkok|America\/New_York|Indochina|Eastern (?:Standard|Daylight)|\b(?:ICT|EDT|EST)\b|\bUTC[+-]\d|\bTimes shown in\b/;

const snapshot = JSON.parse(
  readFileSync(resolve(DATA, "snapshot.json"), "utf8"),
);
const GENERATED_AT = snapshot.generatedAt;
const generated = Date.parse(GENERATED_AT);
// Five hours after the snapshot: an age that reads "5 h ago" on the snapshot
// line, inside the twelve hours the edition treats as on schedule.
const VISITOR_NOW = generated + 5 * HOUR;
const REAL = Boolean(process.env.RADAR_TEST_DATA);

const ZONES = ["Asia/Bangkok", "America/New_York"].map((zone) => [
  zone,
  // What the browser must report in that zone at the visitor's fixed time.
  offsetAt(zone, VISITOR_NOW),
]);
// The offsets above come from the zones' own calendars, so a snapshot of either
// side of New York's clock change (1 November 2026) is expected at the right
// one: check the derivation itself on days whose offsets are known.
assert.equal(
  offsetAt("America/New_York", Date.parse("2026-10-28T14:05:00Z")),
  240,
);
assert.equal(
  offsetAt("America/New_York", Date.parse("2026-11-05T14:05:00Z")),
  300,
);
assert.equal(
  offsetAt("America/New_York", Date.parse("2026-11-01T05:59:59Z")),
  240,
);
assert.equal(
  offsetAt("America/New_York", Date.parse("2026-11-01T06:00:00Z")),
  300,
);
assert.equal(
  offsetAt("Asia/Bangkok", Date.parse("2026-11-05T14:05:00.789Z")),
  -420,
);
// Two zones at the same offset would prove nothing about a page that differs
// between them.
assert.notEqual(ZONES[0][1], ZONES[1][1], "the two zones differ in offset");
assert.equal(ZONES[0][1], -420, "Bangkok is UTC+7 all year");
assert.ok(
  [240, 300].includes(ZONES[1][1]),
  `New York is UTC-4 or UTC-5 (got ${ZONES[1][1]})`,
);

// What to open, read from the data being served so the same test runs on the
// fixture and on a real collection: the named projects with the most measured
// pools, one with hooks and no measured pool, a network and the platforms.
const poolsOf = new Map();
for (const pool of snapshot.pools)
  if (pool.projectId)
    poolsOf.set(pool.projectId, (poolsOf.get(pool.projectId) ?? 0) + 1);
const hooked = snapshot.projects.filter(
  (project) => project.entityType === undefined && project.deployments?.length,
);
const withPools = hooked.filter((project) => poolsOf.get(project.id));
const named = withPools.filter((project) => !/^hook-/.test(project.id));
const [first, second] = (named.length >= 2 ? named : withPools).sort(
  (a, b) => poolsOf.get(b.id) - poolsOf.get(a.id),
);
const unmeasured = hooked.find((project) => !poolsOf.get(project.id));
const network =
  snapshot.chains.find((chain) => chain.slug === "base") ?? snapshot.chains[0];
// Launchpad platforms come from the reviewed registry; "tokenworks" has pools
// in a real collection, "bags" has none in the fixture. A platform the snapshot
// itself names (entityType "platform") is a third kind of drawer.
const platforms = [
  "bags",
  "tokenworks",
  ...snapshot.projects
    .filter((project) => project.entityType === "platform")
    .map((project) => project.id),
];
assert.ok(first && second, "the data holds two projects with hooks and pools");

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

const sha = (letter) => letter.repeat(64);
const iso = (ms) => new Date(ms).toISOString();

/** What a returning visitor has saved: two projects, a baseline for each taken
 * at an earlier snapshot (so the page records changes against it), and recorded
 * changes, one in the shape an older visit stored (no snapshot times). */
function savedState() {
  const baseline = (project) => ({
    id: project.id,
    name: project.name,
    hooks: sha("a"),
    properties: sha("b"),
    metadata: sha("c"),
    hookCount: 1,
    poolCount: 1,
    poolComplete: true,
    sourceAt: iso(generated - 6 * HOUR),
    startedAt: iso(generated - 30 * HOUR),
    checkedAt: iso(generated - 5 * HOUR),
  });
  const change = (project, letter, kind, title, detail, extra) => ({
    id: sha(letter),
    projectId: project.id,
    name: project.name,
    kind,
    title,
    detail,
    observedAt: iso(generated - 3 * HOUR),
    previousAt: iso(generated - 9 * HOUR),
    ...extra,
  });
  return {
    "hook-radar-watchlist-v1": JSON.stringify([first.id, second.id]),
    "hook-radar-watch-changes-v1": JSON.stringify({
      version: 1,
      baselines: [baseline(first), baseline(second)],
      changes: [
        change(
          first,
          "d",
          "hooks",
          "Hook list changed",
          "1 → 2 indexed contracts.",
          {
            sourceAt: iso(generated - 3 * HOUR),
            previousSourceAt: iso(generated - 9 * HOUR),
          },
        ),
        change(
          second,
          "e",
          "metadata",
          "Project information updated",
          "The published name, description, category or reference links changed.",
          {},
        ),
      ],
      readAt: null,
    }),
  };
}

/** A page on the edition in a visitor's time zone with the clock fixed. */
async function visitor(t, timezoneId, size, dist = DIST) {
  const server = await startStaticEditionServer({
    distDir: dist,
    dataDir: DATA,
  });
  const context = await browser.newContext({
    viewport: size,
    timezoneId,
    reducedMotion: "reduce",
  });
  await context.clock.setFixedTime(VISITOR_NOW);
  await context.addInitScript((entries) => {
    for (const [key, value] of Object.entries(entries))
      localStorage.setItem(key, value);
  }, savedState());
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
  };
}

/** The attributes a visitor can be read: a tooltip, a name, a description, and a
 * slider's spoken value (the History chart reads a time aloud there). */
const READ_ATTRIBUTES = [
  "title",
  "aria-label",
  "aria-valuetext",
  "alt",
  "placeholder",
];

/** Everything a visitor can read or hear: every text node (a closed disclosure
 * included), the page title, and every title, aria-label, aria-valuetext, alt
 * and placeholder. */
const everything = (page) =>
  page.evaluate((names) => {
    const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT"]);
    const text = [];
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (parent && !skip.has(parent.tagName)) text.push(node.textContent);
    }
    const attributes = [document.title];
    for (const element of document.querySelectorAll(
      names.map((name) => `[${name}]`).join(","),
    ))
      for (const name of names) {
        const value = element.getAttribute(name);
        if (value) attributes.push(value);
      }
    const flat = (parts) => parts.join(" | ").replace(/\s+/g, " ");
    return { text: flat(text), attributes: flat(attributes) };
  }, READ_ATTRIBUTES);

const settle = async (page) => {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(500);
};

// The recorded history is whatever the collection holds (a real one may have a
// single point, and the chart needs two), so the History pages serve a series
// of their own, as scripts/static-edition-history-browser.test.mjs does: runs
// three hours apart, the newest just before the snapshot. 12 runs span 33 hours
// (a phone's axis names dates); 5 runs span 12 (it names clocks).
const LAST_RUN = generated - 3 * 60_000;
const series = (hoursBefore) => ({
  schemaVersion: 1,
  points: hoursBefore
    .map((hours, index) => ({
      timestamp: LAST_RUN - hours * HOUR,
      value: 3000 + index * 125,
      pools: 10,
    }))
    .sort((a, b) => a.timestamp - b.timestamp),
});
const DAYS_OF_RUNS = series(
  Array.from({ length: 12 }, (_, index) => index * 3),
);
const HOURS_OF_RUNS = series([12, 9, 6, 3, 0]);
const readFile = (name) => {
  try {
    return readFileSync(resolve(DATA, name), "utf8");
  } catch {
    return null; // the file is not published: the server answers 404 again
  }
};
const PUBLISHED = {
  "history.json": readFile("history.json"),
  "snapshot.json": readFile("snapshot.json"),
};

/** Show a page with this recorded series, then put the published files back. */
async function withHistory(s, history, show) {
  // A snapshot carries a copy of the history it was built with, which the page
  // falls back to when the file holds none.
  s.server.setData("history.json", history);
  s.server.setData("snapshot.json", { ...snapshot, history: [] });
  try {
    await show();
  } finally {
    for (const [name, text] of Object.entries(PUBLISHED))
      s.server.setData(name, text);
  }
}

/** Discover's Ecosystem insights panel (folded away on a phone), one tab. */
async function openInsightsTab(page, name) {
  await expect(page.locator("#monitor-history-tab")).toHaveCount(1, {
    timeout: 30000,
  });
  const toggle = page.locator(".mobile-monitor-toggle");
  if (await toggle.isVisible()) await toggle.click();
  await page.getByRole("tab", { name }).click();
}

/** The History tab on a series, with an earlier observation picked by keyboard
 * so the readout above the plot (and the slider's spoken value) is read too. */
const historyTab = (history) => async (page, s) => {
  await withHistory(s, history, async () => {
    await s.goto("");
    await expect(page.getByTestId("snapshot-line")).toBeVisible({
      timeout: 30000,
    });
    await openInsightsTab(page, "History");
    const chart = page.locator(".observations-chart");
    await expect(chart).toBeVisible({ timeout: 30000 });
    await chart.getByRole("slider", { name: "Explore volume history" }).focus();
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowRight");
    await settle(page);
  });
};
const opened = async (page, query, s) => {
  await s.goto(query);
  await expect(page.getByTestId("snapshot-line")).toBeVisible({
    timeout: 30000,
  });
  await settle(page);
};

/** The pages, each a name and what it takes to show it. */
const pages = [
  [
    "Discover",
    async (page, s, phone) => {
      await s.goto("");
      await expect(page.getByTestId("snapshot-line")).toBeVisible({
        timeout: 30000,
      });
      await expect(
        page.locator(phone ? ".mobile-projects article" : "tbody tr").first(),
      ).toBeVisible({ timeout: 30000 });
      await settle(page);
    },
  ],
  [
    "Discover, Market activity tab",
    async (page, s) => {
      await opened(page, "", s);
      await openInsightsTab(page, "Market activity");
      await settle(page);
    },
  ],
  ["Discover, History tab, 33 h of runs", historyTab(DAYS_OF_RUNS)],
  ["Discover, History tab, 12 h of runs", historyTab(HOURS_OF_RUNS)],
  [
    "Analytics, recorded history",
    async (page, s) => {
      await withHistory(s, DAYS_OF_RUNS, async () => {
        await s.goto("?view=analytics");
        await expect(page.locator("#analytics-history")).toContainText(
          "12 of 12 observations",
          { timeout: 30000 },
        );
        await settle(page);
      });
    },
  ],
  [
    "Compare",
    (page, s) =>
      opened(page, `?view=compare&compare=${first.id},${second.id}`, s),
  ],
  [
    "Watchlist",
    async (page, s) => {
      await opened(page, "?view=watchlist", s);
      await expect(page.locator(".watch-updates")).toBeVisible({
        timeout: 30000,
      });
      // A recorded change, opened: its own times sit in the disclosure.
      const view = page.locator(".watch-change details summary").first();
      if (await view.count()) await view.click();
      await settle(page);
    },
  ],
  ["Project drawer", (page, s) => opened(page, `?project=${first.id}`, s)],
  [
    "Project drawer, Pools tab, a pool opened",
    async (page, s) => {
      await opened(page, `?project=${first.id}&tab=pools`, s);
      const card = page
        .locator(".project-detail .pool-card button[aria-expanded]")
        .first();
      if (await card.count()) await card.click();
      await settle(page);
    },
  ],
  [
    "Project drawer, Hooks tab",
    (page, s) => opened(page, `?project=${first.id}&tab=deployments`, s),
  ],
  ...(unmeasured
    ? [
        [
          "Project drawer, no measured pool",
          (page, s) => opened(page, `?project=${unmeasured.id}`, s),
        ],
      ]
    : []),
  ...platforms.map((id) => [
    `Platform drawer (${id})`,
    (page, s) => opened(page, `?project=${id}`, s),
  ]),
  ["Networks", (page, s) => opened(page, "?view=chains", s)],
  [
    "One network",
    async (page, s) => {
      await opened(page, `?view=chains&chain_network=${network.slug}`, s);
      const details = page.locator(".chains-index-details summary");
      if (await details.count()) await details.click();
      await settle(page);
    },
  ],
  ["Analytics overview", (page, s) => opened(page, "?view=analytics", s)],
  [
    "Analytics, one network",
    (page, s) =>
      opened(page, `?view=analytics&analytics_chain=${network.slug}`, s),
  ],
  [
    "Analytics workspace",
    (page, s) =>
      opened(
        page,
        `?view=analytics&analytics_chain=${network.slug}&window=h1`,
        s,
      ),
  ],
  [
    "Launchpads",
    (page, s) => opened(page, "?view=chains&chain_role=launchpads", s),
  ],
  ["By use case", (page, s) => opened(page, "?view=map", s)],
  [
    "Learn",
    async (page, s) => {
      await s.goto("?view=learn");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        "Understand v4 hooks",
        { timeout: 30000 },
      );
      await settle(page);
    },
  ],
  [
    "Data & sources",
    async (page, s) => {
      await opened(page, "", s);
      await page.getByTestId("sources-button").click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await settle(page);
    },
    "dialog",
  ],
  [
    "Data & sources on a network",
    async (page, s) => {
      await opened(page, `?view=chains&chain_network=${network.slug}`, s);
      await page.getByTestId("sources-button").click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await settle(page);
    },
    "dialog",
  ],
  [
    "Share dialog",
    async (page, s) => {
      await opened(page, "", s);
      await page.getByTestId("share-button").click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await settle(page);
    },
  ],
];

/** Where a matched string sits: the whole text or title, aria-label, alt or
 * placeholder value that holds it, and the element with its ancestors. */
const locate = (page, needle) =>
  page.evaluate(
    ([needle, names]) => {
      const path = (element) => {
        const parts = [];
        for (
          let e = element;
          e && e !== document.body && parts.length < 5;
          e = e.parentElement
        )
          parts.push(
            e.tagName.toLowerCase() +
              (typeof e.className === "string" && e.className.trim()
                ? "." + e.className.trim().split(/\s+/).join(".")
                : ""),
          );
        return parts.join(" < ");
      };
      const squash = (value) => (value ?? "").replace(/\s+/g, " ");
      for (const element of document.querySelectorAll("*"))
        for (const name of names)
          if (squash(element.getAttribute(name)).includes(needle))
            return {
              value: squash(element.getAttribute(name)),
              where: `[${name}] ${path(element)}`,
            };
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
      );
      for (let node = walker.nextNode(); node; node = walker.nextNode())
        if (squash(node.textContent).includes(needle))
          return {
            value: squash(node.textContent).trim(),
            where: path(node.parentElement),
          };
      return { value: needle, where: "(spans several elements)" };
    },
    [needle, READ_ATTRIBUTES],
  );

// What each page read as, by size and page, for the comparison between zones.
const read = new Map();

const label = REAL ? "real data" : "fixture data";

for (const [zone, offset] of ZONES)
  test(`${label}: no page shows a time in the visitor's zone (${zone})`, async (t) => {
    // One line per distinct string and where it sits, with the pages it is on.
    const hits = new Map();
    for (const size of [DESKTOP, PHONE]) {
      const s = await visitor(t, zone, size);
      // The pages that need the dialog are read on the build that has it.
      const withDialog = await visitor(t, zone, size, SOURCES_DIST);
      for (const [name, show, needs] of pages) {
        const v = needs === "dialog" ? withDialog : s;
        await show(v.page, v, size === PHONE);
        // The browser really is in the zone asked for, or nothing here proves anything.
        const actual = await v.page.evaluate(() => ({
          zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          offset: new Date(Date.now()).getTimezoneOffset(),
        }));
        assert.deepEqual(actual, { zone, offset }, `${name}: the zone in use`);
        const { text, attributes } = await everything(v.page);
        for (const [shape, pattern] of [
          ["a local-time shape", LOCAL_TIME],
          ["the visitor's zone named", ZONE_NAME],
        ])
          for (const [kind, value] of [
            ["text", text],
            ["a title or aria-label", attributes],
          ]) {
            for (const found of value.matchAll(
              new RegExp(pattern.source, "g"),
            )) {
              const at = await locate(v.page, found[0]);
              const key = `${shape} "${found[0]}" in ${kind}: "${at.value.slice(0, 140)}", in ${at.where}`;
              hits.set(key, [
                ...(hits.get(key) ?? []),
                `${size.width}px ${name}`,
              ]);
            }
          }
        read.set(`${size.width}px, ${name}`, {
          ...read.get(`${size.width}px, ${name}`),
          [zone]: { text, attributes },
        });
        assert.ok(
          text.length > 40,
          `${zone}, ${size.width}px, ${name}: the page has text`,
        );
      }
      s.verify();
      withDialog.verify();
    }
    assert.deepEqual(
      [...hits].map(
        ([hit, on]) => `${hit} (${on.length} page views: ${on.join("; ")})`,
      ),
      [],
    );
  });

/** The segments of a flattened text that differ between two zones. */
function segmentDifferences(a, b) {
  const x = a.split(" | ");
  const y = b.split(" | ");
  const out =
    x.length === y.length ? [] : [`${x.length} segments against ${y.length}`];
  for (let i = 0; i < Math.min(x.length, y.length); i++)
    if (x[i] !== y[i])
      out.push(`"${x[i].slice(0, 120)}" against "${y[i].slice(0, 120)}"`);
  return out;
}

test(`${label}: every page reads the same in both zones`, () => {
  assert.ok(read.size > 0, "the zones were read");
  const differences = new Map();
  for (const [page, byZone] of read) {
    const [a, b] = ZONES.map(([zone]) => byZone[zone]);
    const found =
      !a || !b
        ? ["not read in both zones"]
        : [
            ...segmentDifferences(a.text, b.text).map((d) => `text ${d}`),
            ...segmentDifferences(a.attributes, b.attributes).map(
              (d) => `title or aria-label ${d}`,
            ),
          ];
    for (const difference of found)
      differences.set(difference, [
        ...(differences.get(difference) ?? []),
        page,
      ]);
  }
  assert.deepEqual(
    [...differences].map(
      ([d, on]) =>
        `${ZONES[0][0]} against ${ZONES[1][0]}: ${d} (${on.length} page views: ${on.join("; ")})`,
    ),
    [],
  );
});
