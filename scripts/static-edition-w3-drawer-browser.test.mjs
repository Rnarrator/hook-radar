// The project and platform drawers of the Auto Snapshot edition, second pass: the
// scope of the "About this data" note, the "Networks with hooks" figure, a name
// for every control that repeats on a row, focus after the Hooks list's last
// page, the platform drawer's in-page network links and the dated reviewed notes.
// Point it at an edition build (VITE_STATIC_EDITION=1) with RADAR_TEST_DIST; it
// serves that build next to a data folder through
// scripts/static-edition-server.mjs (every /api path is a 404, every request is
// recorded). No production data, no network, no service.
//
//   RADAR_TEST_DIST=dist/test-build \
//     node --test scripts/static-edition-w3-drawer-browser.test.mjs
//
// By default the data is the deterministic TEST data in
// tests/fixtures/static-data/data, reshaped in memory (server.setData) where a
// case needs more hooks or pools. RADAR_TEST_DATA names a real collected
// snapshot instead: the cases that reshape the fixture are skipped and the
// real-data cases run the same rules on the projects that snapshot holds.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { startStaticEditionServer } from "./static-edition-server.mjs";

const DIST = resolve(process.env.RADAR_TEST_DIST || "dist");
const REAL = Boolean(process.env.RADAR_TEST_DATA);
// Why the cases that need the test fixture are skipped on a real snapshot, and
// the cases that need a real snapshot are skipped on the fixture.
const FIXTURE_ONLY =
  REAL &&
  "needs the test fixture's named projects, pools and times (or reshapes it with server.setData); a real snapshot has none of them";
const REAL_ONLY = !REAL && "needs RADAR_TEST_DATA: a real collected snapshot";
const DATA = resolve(
  process.env.RADAR_TEST_DATA || "tests/fixtures/static-data/data",
);
const DESKTOP = { width: 1440, height: 1000 };
const PHONE = { width: 390, height: 844 };

const snapshotFile = JSON.parse(
  readFileSync(resolve(DATA, "snapshot.json"), "utf8"),
);
const chainNames = new Map(
  snapshotFile.chains.map((chain) => [chain.slug, chain.name]),
);
const chainName = (slug) => chainNames.get(slug) ?? slug;

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

async function site(t, { size = DESKTOP, snapshot = null } = {}) {
  const server = await startStaticEditionServer({
    distDir: DIST,
    dataDir: DATA,
    mount: MOUNT,
  });
  if (snapshot) server.setData("snapshot.json", snapshot);
  const context = await browser.newContext({
    viewport: size,
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
    context,
    drawer: page.locator(".drawer"),
    async open(query) {
      await page.goto(`${server.url}${query}`);
      await expect(page.locator(".drawer-body")).toBeVisible({
        timeout: 30000,
      });
    },
    snapshotRequests: () =>
      server
        .dataRequests()
        .filter((row) => row.path.endsWith("/snapshot.json")),
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

/* ── Snapshots reshaped for the cases ────────────────────────────────────── */

const hex = (n, width) => n.toString(16).padStart(width, "0");

/** Alpha with `count` hooks of one name, alternating between Base and Ethereum
 * and all with the address end "0x0000…1888" a mined hook would have, plus one
 * hook on Robinhood Chain, where none of its pools is measured. */
function manyHooks(count = 45) {
  const value = structuredClone(snapshotFile);
  const alpha = value.projects.find((project) => project.id === "alpha");
  const donor = alpha.deployments[0];
  const make = (index, chain, chainId) => {
    const address = `0x0000${hex(index, 4)}${"0".repeat(28)}1888`;
    return {
      ...structuredClone(donor),
      id: `${chainId}:${address}`,
      address,
      chain,
      chainId,
      explorerUrl: `https://example.invalid/address/${address}`,
    };
  };
  alpha.deployments = [
    ...Array.from({ length: count }, (_, index) =>
      index % 2 ? make(index, "ethereum", 1) : make(index, "base", 8453),
    ),
    make(count, "robinhood", 4663),
  ];
  alpha.chains = ["base", "ethereum", "robinhood"];
  return value;
}

/** Alpha with forty-four more measured pools, three of them one pair on one
 * network (the name alone cannot tell them apart) and one id also on Ethereum. */
function manyPools(added = 44) {
  const value = structuredClone(snapshotFile);
  const donor = value.pools.find((row) => row.projectId === "alpha");
  const stamp = (index) => `0x${hex(0x5000 + index, 64)}`;
  const rows = Array.from({ length: added }, (_, index) => ({
    ...structuredClone(donor),
    id: `base:added${index}`,
    address: stamp(index),
    name: index < 3 ? "TWIN / ALPHA" : `T${index} / ALPHA`,
    url: `https://www.geckoterminal.com/base/pools/added${index}`,
    metricUpdatedAt: "2026-10-28T14:04:00.000Z",
    metricStatus: "live",
  }));
  rows.push({
    ...structuredClone(rows[0]),
    id: `ethereum:added0`,
    chain: "ethereum",
  });
  value.pools = [...rows, ...value.pools];
  return value;
}

/** Delta without its one pool, as the collector writes a project the snapshot
 * did not measure: no totals. */
function noMeasuredPool() {
  const value = structuredClone(snapshotFile);
  value.pools = value.pools.filter((row) => row.projectId !== "delta");
  for (const row of value.projects)
    if (row.id === "delta")
      row.metrics = {
        poolCount: null,
        liquidityUsd: null,
        volumeUsd: { h1: null, h6: null, h24: null },
        coverage: "unavailable",
        note: "No exact hook-attributed market metrics are available in the current measured sample.",
      };
  return value;
}

/* ── What the page reads, computed apart from the page's code ────────────── */

const distinct = (values) => [...new Set(values)];
const plural = (n, one, many) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

function expectedFor(snapshot, id) {
  const project = snapshot.projects.find((row) => row.id === id);
  const own = snapshot.pools.filter((row) => row.projectId === id);
  const ownNetworks = distinct(own.map((row) => row.chain));
  const hookNetworks = distinct([
    ...project.chains,
    ...project.deployments.map((hook) => hook.chain),
    ...ownNetworks,
  ]);
  return {
    project,
    own,
    ownNetworks,
    hookNetworks,
    sources: distinct(own.map((row) => row.source)).sort(),
    whole: `The snapshot as a whole measured ${plural(snapshot.pools.length, "pool", "pools")} on ${plural(distinct(snapshot.pools.map((row) => row.chain)).length, "network", "networks")}.`,
  };
}

const names = (page, scope) =>
  page.evaluate((selector) => {
    const root = document.querySelector(selector);
    return [...root.querySelectorAll("button, a[href]")].map((element) => ({
      name: (element.getAttribute("aria-label") ?? element.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim(),
      visible: (element.textContent ?? "").replace(/\s+/g, " ").trim(),
    }));
  }, scope);

function assertDistinctNames(rows, where) {
  const seen = new Map();
  for (const { name, visible } of rows) {
    assert.ok(name, `${where}: a control with no name`);
    // The visible words are part of the name (WCAG 2.5.3, label in name).
    if (visible)
      assert.ok(
        name.toLowerCase().includes(visible.toLowerCase()),
        `${where}: "${name}" does not contain its visible text "${visible}"`,
      );
    seen.set(name, (seen.get(name) ?? 0) + 1);
  }
  const twice = [...seen].filter(([, n]) => n > 1).map(([name]) => name);
  assert.deepEqual(twice, [], `${where}: controls sharing a name`);
}

/** Opens every card's detail and callback disclosures so their controls count. */
async function openEveryDisclosure(page, scope) {
  await page.evaluate((selector) => {
    for (const button of document.querySelectorAll(
      `${selector} button[aria-expanded="false"]`,
    ))
      if (!button.closest(".load-more")) button.click();
  }, scope);
  // The callback toggles appear once the details are open.
  await page.evaluate((selector) => {
    for (const button of document.querySelectorAll(
      `${selector} button[aria-expanded="false"]`,
    ))
      button.click();
  }, scope);
}

/* ── R-1: the note is the project's own ──────────────────────────────────── */

async function checkCoverageNote(s, snapshot, id, where) {
  const want = expectedFor(snapshot, id);
  await s.open(`?project=${id}`);
  await s.drawer.getByRole("button", { name: "About this data" }).click();
  const paragraph = s.drawer.locator("#project-data-details h3 + p").first();
  const text = (await paragraph.textContent()).replace(/\s+/g, " ").trim();
  if (want.own.length) {
    assert.equal(
      text,
      `This project’s totals use its ${plural(want.own.length, "measured pool", "measured pools")} on ${plural(want.ownNetworks.length, "network", "networks")} from ${want.sources.join(", ")}. ${want.whole} Dollar totals use available observations, not ecosystem totals. Unpriced pools remain browsable; missing values are unavailable, never zero.`,
      where,
    );
    // The drawer agrees with itself: the count beside it is the one in the note.
    await expect(
      s.drawer.locator(".readout", { hasText: "Pools measured" }),
    ).toContainText(want.own.length.toLocaleString("en-US"));
  } else {
    assert.equal(
      text,
      `None of this project’s pools were measured in this snapshot, so it has no market totals. ${want.whole} Missing values are unavailable, never zero.`,
      where,
    );
  }
  assert.doesNotMatch(text, /^Observed market data covers/, where);
}

test("About this data states the project's own pools, networks and sources, and the snapshot's sample as context", async (t) => {
  const ids = REAL
    ? ["aegis", "doppler", "eulerswap"]
    : ["alpha", "beta", "gamma"];
  let checked = 0;
  for (const size of [DESKTOP, PHONE]) {
    const s = await site(t, { size });
    for (const id of ids)
      if (snapshotFile.projects.some((row) => row.id === id)) {
        await checkCoverageNote(s, snapshotFile, id, `${id} at ${size.width}`);
        checked += 1;
      }
    s.verify();
  }
  assert.ok(checked >= 2, "projects to check");
});

test("a project with no measured pool says none were measured, on a phone too", async (t) => {
  // The test data measures a pool for every project: Delta's is taken out.
  const value = REAL ? snapshotFile : noMeasuredPool();
  const withPools = new Set(value.pools.map((row) => row.projectId));
  const empty = value.projects.find(
    (row) => row.entityType !== "platform" && !withPools.has(row.id),
  );
  assert.ok(empty, "a project with no measured pool");
  for (const size of [DESKTOP, PHONE]) {
    const s = await site(t, { size, snapshot: REAL ? null : value });
    await checkCoverageNote(s, value, empty.id, `${empty.id} at ${size.width}`);
    s.verify();
  }
});

/* ── R-3: networks with hooks, and where pools were measured ─────────────── */

/** A project whose hooks reach more networks than its measured pools do. */
function widest(snapshot) {
  for (const project of snapshot.projects) {
    if (project.entityType === "platform") continue;
    const want = expectedFor(snapshot, project.id);
    if (
      want.own.length > 0 &&
      want.hookNetworks.length > want.ownNetworks.length
    )
      return want;
  }
  return null;
}

test("the Networks figure counts networks with hooks and says where pools were measured", async (t) => {
  // Alpha, given a hook on a network where none of its pools is measured.
  const value = REAL ? snapshotFile : manyHooks(3);
  const want = widest(value);
  assert.ok(want, "a project whose hooks reach more networks than its pools");
  for (const size of [DESKTOP, PHONE]) {
    const s = await site(t, { size, snapshot: REAL ? null : value });
    await s.open(`?project=${want.project.id}`);
    const figure = s.drawer.locator(".detail-stats .readout").nth(1);
    await expect(figure.locator(".readout-label")).toHaveText(
      "Networks with hooks",
    );
    await expect(figure.locator(".readout-value")).toHaveText(
      String(want.hookNetworks.length),
    );
    const measured = want.ownNetworks
      .map(chainName)
      .sort((a, b) => a.localeCompare(b, "en"));
    const note =
      measured.length <= 2
        ? measured.join(" · ")
        : `${measured.slice(0, 2).join(" · ")} +${measured.length - 2}`;
    await expect(figure.locator(".readout-note")).toHaveText(
      `Measured pools on ${note}`,
    );
    await expect(figure.locator(".readout-note")).toHaveAttribute(
      "title",
      /^Hooks listed on .*\. Measured pools on /,
    );
    // The setup card gives the same scope.
    await expect(s.drawer.locator(".project-setup-heading span")).toHaveText(
      `${want.hookNetworks.length} networks with hooks`,
    );
    // The pool count beside it is still the one "Pools measured".
    await expect(
      s.drawer.locator(".readout", { hasText: "Pools measured" }),
    ).toHaveCount(1);
    s.verify();
  }
});

test("a project with hooks and no measured pool says no pool was measured", async (t) => {
  const value = REAL ? snapshotFile : noMeasuredPool();
  const withPools = new Set(value.pools.map((row) => row.projectId));
  const project = value.projects.find(
    (row) =>
      row.entityType !== "platform" &&
      !withPools.has(row.id) &&
      row.deployments.length > 0,
  );
  assert.ok(project, "a project with hooks and no measured pool");
  const s = await site(t, { snapshot: REAL ? null : value });
  await s.open(`?project=${project.id}`);
  const figure = s.drawer.locator(".detail-stats .readout").nth(1);
  await expect(figure.locator(".readout-label")).toHaveText(
    "Networks with hooks",
  );
  await expect(figure.locator(".readout-note")).toHaveText("No measured pools");
  s.verify();
});
/* ── R-4: every row's controls have a name of their own ──────────────────── */

test(
  "no two controls of the pool list share a name, even for one pair and one id on two networks",
  { skip: FIXTURE_ONLY },
  async (t) => {
    const value = manyPools();
    const s = await site(t, { snapshot: value });
    await s.open("?project=alpha");
    const total = 4 + 44 + 1;
    while (await s.drawer.locator(".load-more").count())
      await s.drawer.locator(".load-more").click();
    await expect(s.drawer.locator(".pool-card")).toHaveCount(total);
    assertDistinctNames(await names(s.page, "#pools-panel"), "pool list");
    // Opened cards add controls of their own: still all different.
    for (const card of await s.drawer.locator(".pool-card").all())
      await card.getByRole("button", { name: /^Details for / }).click();
    assertDistinctNames(
      await names(s.page, "#pools-panel"),
      "pool list, every card open",
    );
    s.verify();
  },
);

test(
  "no two controls of the hook list share a name, for hooks that share a name and an address end",
  { skip: FIXTURE_ONLY },
  async (t) => {
    const s = await site(t, { snapshot: manyHooks() });
    await s.open("?project=alpha&tab=deployments");
    while (await s.drawer.locator(".load-more").count())
      await s.drawer.locator(".load-more").click();
    await expect(s.drawer.locator(".deployment-card")).toHaveCount(46);
    // All forty-six read "AlphaHook 0x0000…1888" in the old words.
    assertDistinctNames(await names(s.page, "#deployment-panel"), "hook list");
    await openEveryDisclosure(s.page, "#deployment-panel");
    assertDistinctNames(
      await names(s.page, "#deployment-panel"),
      "hook list, every card open",
    );
    s.verify();
  },
);

test("a real project's pool and hook lists give every control a name of its own", async (t) => {
  const withPools = new Map();
  for (const row of snapshotFile.pools)
    withPools.set(row.projectId, (withPools.get(row.projectId) ?? 0) + 1);
  const most = (list) =>
    list.sort((a, b) => b.deployments.length - a.deployments.length)[0];
  const projects = snapshotFile.projects.filter(
    (row) => row.entityType !== "platform",
  );
  const manyPoolsId = [...withPools].sort((a, b) => b[1] - a[1])[0][0];
  const manyHooksId = most([...projects]).id;
  for (const size of [DESKTOP, PHONE]) {
    const s = await site(t, { size });
    await s.open(`?project=${manyPoolsId}`);
    while (await s.drawer.locator(".load-more").count())
      await s.drawer.locator(".load-more").click();
    assertDistinctNames(
      await names(s.page, "#pools-panel"),
      `pools of ${manyPoolsId} at ${size.width}`,
    );
    await s.open(`?project=${manyHooksId}&tab=deployments`);
    while (await s.drawer.locator(".load-more").count())
      await s.drawer.locator(".load-more").click();
    assertDistinctNames(
      await names(s.page, "#deployment-panel"),
      `hooks of ${manyHooksId} at ${size.width}`,
    );
    s.verify();
  }
});

test(
  "the Show more buttons say what they list and how many remain",
  { skip: FIXTURE_ONLY },
  async (t) => {
    const s = await site(t, { snapshot: manyHooks() });
    await s.open("?project=alpha");
    // Pools first (alpha has four: no button), then the hooks tab.
    await expect(s.drawer.locator(".load-more")).toHaveCount(0);
    await s.open("?project=alpha&tab=deployments");
    const more = s.drawer.locator(".load-more");
    await expect(more).toHaveAccessibleName(
      "Show 20 more · 26 remaining hooks",
    );
    await expect(more).toContainText("Show 20 more · 26 remaining");
    await more.click();
    await expect(more).toHaveAccessibleName("Show 6 more · 6 remaining hooks");
    await expect(more).toContainText("Show 6 more · 6 remaining");
    s.verify();
  },
);

/* ── PD-11 B: focus after the Hooks list's last page ─────────────────────── */

async function focus(page) {
  return page.evaluate(() => {
    const active = document.activeElement;
    const cards = [...document.querySelectorAll(".deployment-card")];
    return {
      tag: active?.tagName ?? "",
      inDrawer: Boolean(active?.closest(".drawer")),
      card: cards.indexOf(active?.closest(".deployment-card")),
      name: (active?.getAttribute("aria-label") ?? active?.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim(),
    };
  });
}

test(
  "after the last page of the Hooks list focus is on its first new hook, inside the drawer, and Tab goes on from there",
  { skip: FIXTURE_ONLY },
  async (t) => {
    for (const size of [DESKTOP, PHONE]) {
      const s = await site(t, { size, snapshot: manyHooks() });
      await s.open("?project=alpha&tab=deployments");
      const more = s.drawer.locator(".load-more");
      // 46 hooks: 20, 40, then the last 6.
      await more.focus();
      await s.page.keyboard.press("Enter");
      await expect(s.drawer.locator(".deployment-card")).toHaveCount(40);
      // A page that leaves the button keeps focus on it.
      assert.deepEqual(
        await focus(s.page).then(({ tag, inDrawer }) => ({ tag, inDrawer })),
        { tag: "BUTTON", inDrawer: true },
      );
      assert.match((await focus(s.page)).name, /^Show 6 more · 6 remaining/);
      await s.page.keyboard.press("Enter");
      await expect(s.drawer.locator(".deployment-card")).toHaveCount(46);
      await expect(more).toHaveCount(0);
      const landed = await focus(s.page);
      assert.equal(
        landed.inDrawer,
        true,
        `focus left the drawer at ${size.width}`,
      );
      assert.equal(landed.card, 40, "the first hook the last page added");
      assert.notEqual(landed.tag, "BODY");
      // The next Tab stays in the drawer and does not restart at its close button.
      await s.page.keyboard.press("Tab");
      const next = await focus(s.page);
      assert.equal(next.inDrawer, true);
      assert.notEqual(next.name, "Close panel");
      assert.equal(next.card, 40, "the next control of the same card");
      s.verify();
    }
  },
);

test(
  "a real project's Hooks list keeps focus in the drawer after its last page",
  { skip: REAL_ONLY },
  async (t) => {
    const project = snapshotFile.projects
      .filter((row) => row.entityType !== "platform")
      .filter((row) => row.deployments.length > 20)
      .sort((a, b) => a.deployments.length - b.deployments.length)[0];
    assert.ok(project, "a project with more than twenty hooks");
    const s = await site(t);
    await s.open(`?project=${project.id}&tab=deployments`);
    const more = s.drawer.locator(".load-more");
    while (await more.count()) {
      await more.focus();
      await s.page.keyboard.press("Enter");
    }
    const landed = await focus(s.page);
    assert.equal(landed.inDrawer, true);
    assert.equal(landed.card % 20, 0, "a first hook of the last page");
    assert.ok(landed.card >= 20);
    assert.notEqual(landed.tag, "BODY");
    s.verify();
  },
);

/* ── PD-12 B: the platform drawer's network links stay in the page ───────── */

test("a plain click on a supported network opens it inside the page: no reload, no second snapshot, Back returns to the drawer", async (t) => {
  for (const size of [DESKTOP, PHONE]) {
    const s = await site(t, { size });
    await s.open("?project=bankr");
    const link = s.drawer.locator(".platform-network-links a").first();
    await expect(link).toBeVisible();
    const href = await link.getAttribute("href");
    // Still a real link: new tab, copy address, no script.
    assert.match(
      href,
      /\?view=chains&chain_network=[a-z0-9-]+&chain_role=launchpads$/,
    );
    const slug = href.match(/chain_network=([a-z0-9-]+)/)[1];
    await s.page.evaluate(() => {
      window.__keptAlive = "same page";
    });
    const before = s.snapshotRequests().length;
    assert.ok(before >= 1, "the snapshot was read once to show the drawer");

    await link.click();
    await expect(s.page).toHaveURL(
      new RegExp(`view=chains&chain_network=${slug}&chain_role=launchpads`),
    );
    await expect(s.page.locator(".drawer")).toHaveCount(0);
    await expect(s.page.locator("#main h1")).toContainText(/Launchpads/);
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
    // Focus is somewhere on the page, not lost to the document.
    assert.notEqual(
      await s.page.evaluate(() => document.activeElement?.tagName),
      "BODY",
    );

    await s.page.goBack();
    await expect(s.page).toHaveURL(/\?project=bankr/);
    await expect(s.page.locator(".platform-detail h2").first()).toHaveText(
      "Bankr",
    );
    assert.equal(await s.page.evaluate(() => window.__keptAlive), "same page");
    assert.equal(s.snapshotRequests().length, before, "Back asks for nothing");
    s.verify();
  }
});

test("a network link of the platform drawer still opens in a new tab with a modified click, and a keyboard activation stays in the page", async (t) => {
  const s = await site(t);
  await s.open("?project=bankr");
  const link = s.drawer.locator(".platform-network-links a").first();
  const [other] = await Promise.all([
    s.context.waitForEvent("page"),
    link.click({ modifiers: ["Control"] }),
  ]);
  await other.waitForLoadState();
  assert.match(
    other.url(),
    /\?view=chains&chain_network=[a-z0-9-]+&chain_role=launchpads/,
  );
  // The page behind it was not taken over.
  assert.match(s.page.url(), /\?project=bankr/);
  await expect(s.drawer).toHaveCount(1);
  await other.close();
  // Enter on a focused link is a click with no modifier.
  await link.focus();
  const before = s.snapshotRequests().length;
  await s.page.keyboard.press("Enter");
  await expect(s.page).toHaveURL(/chain_role=launchpads/);
  await expect(s.page.locator(".drawer")).toHaveCount(0);
  assert.equal(s.snapshotRequests().length, before);
  s.verify();
});

/* ── NLA-15: what Radar showed on the review day is dated ────────────────── */

test("a line that quotes what Radar showed is dated by the review, and its words are the finding's own", async (t) => {
  for (const size of [DESKTOP, PHONE]) {
    const s = await site(t, { size });
    await s.open("?project=arcfun");
    await s.drawer.locator(".lp-unresolved > summary").click();
    const line = s.drawer.locator(".lp-unresolved li", {
      hasText: "Radar lists only 1 pool for the hook.",
    });
    await expect(line).toHaveCount(1);
    assert.equal(
      (await line.textContent()).replace(/\s+/g, " ").trim(),
      "As reviewed on 24 Oct 2026: Radar lists only 1 pool for the hook.",
    );
    // A line that says nothing about Radar's index is as it was.
    const others = await s.drawer
      .locator(".lp-unresolved li")
      .evaluateAll((rows) =>
        rows
          .map((row) => row.textContent.trim())
          .filter((text) => !/Radar/.test(text)),
      );
    assert.ok(others.length >= 1);
    for (const text of others) assert.doesNotMatch(text, /^As reviewed on/);

    await s.open("?project=unihood");
    const label = s.drawer.locator(".lp-path-title h4", {
      hasText: "16 of 617 listed pairs are in Radar",
    });
    await expect(label).toHaveCount(1);
    assert.equal(
      (await label.textContent()).replace(/\s+/g, " ").trim(),
      "As reviewed on 24 Oct 2026: Per-quote launches (per-quote UnihoodStockHook; 16 of 617 listed pairs are in Radar)",
    );
    // The date is the edition's UTC day, and the label beside it is untouched.
    assert.equal(
      await label.locator(".lp-as-of").textContent(),
      "As reviewed on 24 Oct 2026:",
    );
    // The sibling path that quotes nothing has no date.
    await expect(
      s.drawer.locator(".lp-path-title h4", {
        hasText: "UNIHOOD launches (main factory, global hook)",
      }),
    ).not.toContainText("As reviewed");
    s.verify();
  }
});
