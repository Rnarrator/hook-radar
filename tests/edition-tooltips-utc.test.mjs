import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { aggregateCurrentMarkets } from "../shared/market-freshness.ts";
import { makeSnapshot, testProjects } from "./fixtures.mjs";

// The tooltips of the shared measurement lines (Discover, Compare, Watchlist and
// the project drawer all use them) name every time in UTC in the edition, beside
// the UTC labels they explain, whatever zone the visitor's browser is in. The
// live page keeps the visitor's locale and its "Amount expires at" wording.

const href = (path) => new URL(path, import.meta.url).href;

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

// Plain Node has no bundler environment, so the real edition module reads the
// flag as off. The edition variant is the same module with the flag turned on.
const editionOn = `data:text/javascript;base64,${Buffer.from(
  `export * from ${JSON.stringify(href("../src/edition.ts"))};\nexport const STATIC_EDITION = true;\n`,
).toString("base64")}`;

async function load(edition) {
  const editionModule = edition ? editionOn : href("../src/edition.ts");
  const model = href("../src/model.ts");
  const provenance = await componentModule("../src/MarketProvenance.tsx", {
    "./model": model,
    "./edition": editionModule,
    "./provenance": href("../src/provenance.ts"),
  });
  const proof = await componentModule(
    "../src/components/ProjectMetricProof.tsx",
    {
      "../../shared/market-freshness": href("../shared/market-freshness.ts"),
      "../edition": editionModule,
      "../model": model,
      "../MarketProvenance": provenance,
    },
  );
  return { ...(await import(provenance)), ...(await import(proof)) };
}
const edition = await load(true);
const live = await load(false);

/** Run `body` with the process in another time zone, and prove it took effect. */
function inZone(timeZone, body) {
  const before = process.env.TZ;
  process.env.TZ = timeZone;
  try {
    assert.equal(
      new Intl.DateTimeFormat().resolvedOptions().timeZone,
      timeZone,
      `the process did not switch to ${timeZone}`,
    );
    return body();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

// 28 Oct 00:10 UTC is still the 27th in New York and already past 07:00 in
// Bangkok: the cases an unlabelled local time gets wrong.
const zones = [
  "America/New_York",
  "Asia/Bangkok",
  "Pacific/Kiritimati",
  "America/Los_Angeles",
  "UTC",
];
const oldest = "2026-10-28T00:10:38.000Z";
const label = "28 Oct 2026, 00:10 UTC";
// What a reader in a time zone sees when no zone is named and no UTC is said.
const localeShape =
  /\d{1,2}\/\d{1,2}\/\d{4}|\d{1,2}:\d{2}:\d{2}|\b[AP]M\b|GMT[+-]/;

const provenance = (extra = {}) => ({
  poolCount: 345,
  oldestAt: oldest,
  cachedPoolCount: 0,
  unknownTimestampCount: 0,
  unknownStatusCount: 0,
  observedPoolCount: 345,
  stalePoolCount: 0,
  latestObservedAt: "2026-10-28T00:12:28.000Z",
  ...extra,
});

/** The title as the live page built it before this change, copied verbatim, so
 * the unset-flag output is shown to be unchanged rather than assumed. */
function legacyTitle(p, metric) {
  const exact = p.oldestAt ? new Date(p.oldestAt).toLocaleString() : null;
  return [
    exact
      ? `Oldest current pool measurement: ${exact}.`
      : "No current measurements are available.",
    `${p.poolCount} current ${p.poolCount === 1 ? "pool" : "pools"}. Only observations younger than five minutes contribute to current totals; source clocks allow one minute of skew. Rolling windows retain their original observation endpoints.`,
    p.stalePoolCount
      ? `${p.stalePoolCount} older ${p.stalePoolCount === 1 ? "observation is" : "observations are"} excluded from current totals and rankings.`
      : "",
    p.cachedPoolCount
      ? `${p.cachedPoolCount} cached; these amounts retain their original measurement time.`
      : "",
    p.unknownTimestampCount && p.oldestAt
      ? `${p.unknownTimestampCount} measurement ${p.unknownTimestampCount === 1 ? "timestamp" : "timestamps"} unavailable; freshness is incomplete.`
      : "",
    p.unknownStatusCount
      ? `${p.unknownStatusCount} ${p.unknownStatusCount === 1 ? "pool has" : "pools have"} unknown freshness status.`
      : "",
    metric === "liquidity"
      ? "Provider reserve valuations can include one-sided token inventory priced at the last trade. They do not measure executable depth or protocol TVL."
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

test("edition: the measurement tooltip names its time in UTC in any visitor zone", () => {
  for (const zone of zones)
    inZone(zone, () => {
      const title = edition.measurementTitle(provenance(), "h24", true);
      assert.ok(
        title.startsWith(`Oldest current pool measurement: ${label}. `),
        `${zone}: ${title}`,
      );
      assert.doesNotMatch(title, localeShape, zone);
      assert.match(
        title,
        /younger than five minutes when the snapshot was taken/,
      );
    });
});

test("edition: the tooltip is word for word the same in every zone", () => {
  const titles = zones.map((zone) =>
    inZone(zone, () =>
      edition.measurementTitle(
        provenance({ cachedPoolCount: 2, stalePoolCount: 1 }),
        "liquidity",
        true,
      ),
    ),
  );
  assert.equal(new Set(titles).size, 1);
  assert.match(
    titles[0],
    /^Oldest current pool measurement: 28 Oct 2026, 00:10 UTC\./,
  );
  assert.match(titles[0], /2 cached; these amounts retain/);
  assert.match(titles[0], /1 older observation is excluded/);
  assert.match(titles[0], /do not measure executable depth/);
});

test("edition: no current measurement says so and invents no time", () => {
  const title = edition.measurementTitle(
    provenance({ poolCount: 0, oldestAt: null, stalePoolCount: 3 }),
    "h24",
    true,
  );
  assert.ok(title.startsWith("No current measurements are available. "));
  assert.doesNotMatch(title, /UTC|Invalid Date/);
});

test("edition: a time that cannot be read is shown as received, never as Invalid Date", () => {
  assert.equal(edition.tooltipTime("garbage", true), "garbage");
  assert.equal(edition.tooltipTime(oldest, true), label);
});

test("live: with the flag unset the tooltip is the visitor's locale time, unchanged", () => {
  const cases = [
    [provenance(), "h24"],
    [provenance({ cachedPoolCount: 1, stalePoolCount: 2 }), "liquidity"],
    [
      provenance({
        poolCount: 1,
        unknownTimestampCount: 2,
        unknownStatusCount: 1,
      }),
      "h1",
    ],
    [provenance({ poolCount: 0, oldestAt: null }), "h6"],
  ];
  for (const zone of zones)
    inZone(zone, () => {
      for (const [p, metric] of cases) {
        assert.equal(live.measurementTitle(p, metric), legacyTitle(p, metric));
        assert.equal(
          live.measurementTitle(p, metric, false),
          legacyTitle(p, metric),
        );
      }
      assert.equal(live.tooltipTime(oldest), new Date(oldest).toLocaleString());
    });
  inZone("America/New_York", () => {
    assert.match(
      live.measurementTitle(provenance(), "h24"),
      /^Oldest current pool measurement: 10\/27\/2026, 8:10:38 PM\. 345 current pools\. Only observations younger than five minutes contribute/,
    );
  });
});

test("edition: a directory row's proof says the amount was counted as current at the snapshot, with no expiry time", () => {
  const expires = "2026-10-28T00:15:38.000Z";
  for (const zone of zones)
    inZone(zone, () => {
      const current = edition.metricProofTitle(true, oldest, expires, true);
      assert.equal(
        current,
        "Oldest contributing measurement: 28 Oct 2026, 00:10 UTC. Counted as current at the snapshot time. Complete pool provenance opens with project details.",
        zone,
      );
      assert.doesNotMatch(current, /expires|00:15/);
      assert.doesNotMatch(current, localeShape, zone);
      const old = edition.metricProofTitle(false, oldest, expires, true);
      assert.equal(
        old,
        "Last observed at 28 Oct 2026, 00:10 UTC. The current amount is unavailable; an old measurement is not a zero.",
        zone,
      );
      assert.doesNotMatch(old, localeShape, zone);
    });
});

test("live: a directory row's proof keeps the visitor's locale time and 'Amount expires at'", () => {
  const expires = "2026-10-28T00:15:38.000Z";
  inZone("America/New_York", () => {
    assert.equal(
      live.metricProofTitle(true, oldest, expires),
      "Oldest contributing measurement: 10/27/2026, 8:10:38 PM. Amount expires at 10/27/2026, 8:15:38 PM. Complete pool provenance opens with project details.",
    );
    assert.equal(
      live.metricProofTitle(false, oldest, expires),
      "Last observed at 10/27/2026, 8:10:38 PM. The current amount is unavailable; an old measurement is not a zero.",
    );
  });
  inZone("Asia/Bangkok", () => {
    assert.equal(
      live.metricProofTitle(true, oldest, expires, false),
      "Oldest contributing measurement: 10/28/2026, 7:10:38 AM. Amount expires at 10/28/2026, 7:15:38 AM. Complete pool provenance opens with project details.",
    );
  });
});

// The rendered components, as Discover, Compare, Watchlist and the drawer mount
// them: the title attribute that a visitor hovers is what has to be in UTC.
const titleOf = (html) => {
  const titles = [...html.matchAll(/ title="([^"]*)"/g)].map((m) => m[1]);
  assert.equal(titles.length, 1, html);
  return titles[0];
};
const snapshotTime = Date.parse("2026-10-28T00:12:00.000Z");
const measuredPool = () => ({
  ...makeSnapshot().pools[0],
  metricUpdatedAt: oldest,
  metricStatus: "live",
  liquidityUsd: 10000,
  volumeUsd: { h1: 100, h6: 600, h24: 2400 },
});

test("the rendered measurement line carries a UTC tooltip in the edition and a locale one live", () => {
  mock.timers.enable({ apis: ["Date"], now: snapshotTime });
  try {
    const pools = [measuredPool()];
    for (const zone of zones)
      inZone(zone, () => {
        const html = renderToStaticMarkup(
          createElement(edition.MetricMeasurement, {
            pools,
            metric: "h24",
            compact: true,
          }),
        );
        assert.ok(
          titleOf(html).startsWith(
            `Oldest current pool measurement: ${label}. 1 current pool. `,
          ),
          `${zone}: ${titleOf(html)}`,
        );
        assert.doesNotMatch(titleOf(html), localeShape, zone);
      });
    inZone("America/New_York", () => {
      const html = renderToStaticMarkup(
        createElement(live.MetricMeasurement, {
          pools,
          metric: "h24",
          compact: true,
        }),
      );
      assert.ok(
        titleOf(html).startsWith(
          "Oldest current pool measurement: 10/27/2026, 8:10:38 PM. 1 current pool. ",
        ),
        titleOf(html),
      );
    });
  } finally {
    mock.timers.reset();
  }
});

test("the market strip's two tooltips (volume and reserves) are both in UTC", () => {
  mock.timers.enable({ apis: ["Date"], now: snapshotTime });
  try {
    inZone("America/New_York", () => {
      const html = renderToStaticMarkup(
        createElement(edition.MarketProvenanceStrip, {
          pools: [
            measuredPool(),
            {
              ...measuredPool(),
              id: "base:other",
              metricUpdatedAt: "2026-10-28T00:11:10.000Z",
              volumeUsd: { h1: null, h6: null, h24: null },
            },
          ],
          windowKey: "h24",
        }),
      );
      const titles = [...html.matchAll(/ title="([^"]*)"/g)].map((m) => m[1]);
      assert.equal(titles.length, 2, html);
      assert.ok(
        titles[0].startsWith(`Oldest current pool measurement: ${label}. `),
        titles[0],
      );
      assert.ok(
        titles[1].startsWith(
          "Oldest current pool measurement: 28 Oct 2026, 00:10 UTC. ",
        ),
        titles[1],
      );
      for (const title of titles) assert.doesNotMatch(title, localeShape);
    });
  } finally {
    mock.timers.reset();
  }
});

test("the rendered directory-row proof drops the expiry in the edition and keeps it live", () => {
  mock.timers.enable({ apis: ["Date"], now: snapshotTime });
  try {
    const pools = [measuredPool()];
    const aggregate = aggregateCurrentMarkets(pools, snapshotTime);
    const project = {
      ...testProjects[0],
      metrics: {
        ...testProjects[0].metrics,
        liquidityUsd: aggregate.liquidityUsd,
        volumeUsd: aggregate.volumeUsd,
        freshness: aggregate.freshness,
      },
    };
    inZone("America/New_York", () => {
      const inEdition = renderToStaticMarkup(
        createElement(edition.ProjectMetricProof, {
          project,
          metric: "h24",
          now: snapshotTime,
        }),
      );
      assert.equal(
        titleOf(inEdition),
        "Oldest contributing measurement: 28 Oct 2026, 00:10 UTC. Counted as current at the snapshot time. Complete pool provenance opens with project details.",
      );
      const inLive = renderToStaticMarkup(
        createElement(live.ProjectMetricProof, {
          project,
          metric: "h24",
          now: snapshotTime,
        }),
      );
      assert.match(
        titleOf(inLive),
        /^Oldest contributing measurement: 10\/27\/2026, 8:10:38 PM\. Amount expires at 10\/27\/2026, 8:15:38 PM\. /,
      );
      // Past the old expiry the line falls back to the last observation.
      const lapsed = renderToStaticMarkup(
        createElement(edition.ProjectMetricProof, {
          project,
          metric: "h24",
          now: snapshotTime + 10 * 60_000,
        }),
      );
      assert.equal(
        titleOf(lapsed),
        "Last observed at 28 Oct 2026, 00:10 UTC. The current amount is unavailable; an old measurement is not a zero.",
      );
    });
  } finally {
    mock.timers.reset();
  }
});
