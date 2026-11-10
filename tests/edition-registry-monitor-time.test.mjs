// Every time the Auto Snapshot edition writes is a UTC time. A snapshot is a
// dated, frozen file, so a tooltip that said "10/27/2026, 4:00:00 PM" in a
// visitor's zone would put the same observation at two moments for two readers.
// Two screens still wrote times with the visitor's locale after the rest of the
// page had moved to UTC:
//
//  1. the "Latest hook updates" panel: each update's tooltip ("Observed ...")
//     and the registry footnote's tooltip;
//  2. Discover's History chart: its readout, its axis and the slider's spoken
//     value used a 12-hour clock ("02:05 PM UTC").
//
// The panel is rendered here from the real component, with the flag set and
// unset, while the process sits in other time zones. The chart is not exported,
// so its edition helpers are tested directly and the chart itself is read in a
// real browser, in two zones, by scripts/static-edition-timezone-browser.test.mjs.
// The live page keeps the visitor's locale throughout.
//
// The component is transpiled and imported here (as tests/edition-tooltips-utc
// does) rather than loaded through a Vite server: this file runs beside the
// others, and a second Vite server in the same folder at the same time can stall.
//
//   node --test tests/edition-registry-monitor-time.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { shortTimeLabel, utcDayMonth } from "../src/edition.ts";

const href = (path) => new URL(path, import.meta.url).href;

/** A component module with its imports pointed at the given modules. */
async function componentModule(path, replacements) {
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

const dataModule = (code) =>
  `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;

// Plain Node has no bundler environment, so the real edition module reads the
// flag as off. The edition variant is the same module with the flag turned on.
const editionOn = dataModule(
  `export * from ${JSON.stringify(href("../src/edition.ts"))};\nexport const STATIC_EDITION = true;\n`,
);
// The three icons the panel draws; what they draw is not under test.
const icons = dataModule(
  "export const ChevronDown = () => null;\nexport const Radio = () => null;\nexport const RefreshCw = () => null;\n",
);

async function registryUpdates(edition) {
  const module = await import(
    await componentModule("../src/components/RegistryUpdates.tsx", {
      "../edition": edition ? editionOn : href("../src/edition.ts"),
      "../model": href("../src/model.ts"),
      "./Icons": icons,
    })
  );
  return module.RegistryUpdates;
}

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

// 27 Oct 09:00 UTC is 16:00 in Bangkok and 05:00 in New York, and 00:05 UTC on
// the 28th is still the 27th in New York: the cases a local time gets wrong.
const ZONES = ["Asia/Bangkok", "America/New_York", "Pacific/Kiritimati", "UTC"];

const event = (timestamp) => ({
  id: "event-1",
  type: "new-deployment",
  title: "Gamma deployment listed",
  description: "A Base deployment was added to the registry.",
  timestamp,
  projectId: "gamma",
  chain: "base",
  url: null,
});

const render = (RegistryUpdates, { timestamp, updatedAt }) =>
  renderToStaticMarkup(
    createElement(RegistryUpdates, {
      events: [event(timestamp)],
      scopedEvents: [],
      loading: false,
      scopedLoading: false,
      error: "",
      scopedError: "",
      scopedSyncing: false,
      registry: {
        id: "registry",
        name: "Uniswap hook registry",
        url: "https://github.com/Uniswap/hooklist",
        note: "",
        status: "live",
        updatedAt,
      },
      now: Date.parse("2026-10-28T00:14:11.000Z"),
      recovering: false,
      watchlist: false,
      onRefresh() {},
      onRetryScope() {},
      onOpen() {},
      chainName: (slug) => slug,
    }),
  );

/** Every title="..." in the markup, in order. */
const titles = (html) =>
  [...html.matchAll(/ title="([^"]*)"/g)].map((match) => match[1]);

const edition = await registryUpdates(true);
const live = await registryUpdates(false);

test("edition: a hook update's tooltip and the registry footnote's name their time in UTC, in every zone", () => {
  for (const zone of ZONES)
    inZone(zone, () => {
      const html = render(edition, {
        timestamp: "2026-10-27T09:00:00.000Z",
        updatedAt: "2026-10-28T00:05:00.000Z",
      });
      assert.deepEqual(
        titles(html),
        ["Observed 27 Oct 2026, 09:00 UTC", "28 Oct 2026, 00:05 UTC"],
        zone,
      );
      // Nothing in the panel is in a local shape: no 12-hour clock, no m/d/yyyy date.
      assert.doesNotMatch(
        html,
        /\d{1,2}:\d{2}(:\d{2})?\s?[AP]M|\b\d{1,2}\/\d{1,2}\/\d{4}/,
        zone,
      );
      // The machine-readable time is untouched.
      assert.match(html, /dateTime="2026-10-27T09:00:00.000Z"/);
    });
});

test("edition: a time that cannot be read says so instead of printing a null or an invalid date", () => {
  const html = render(edition, {
    timestamp: "not a time",
    updatedAt: "2026-10-28T00:05:00.000Z",
  });
  assert.equal(titles(html)[0], "Observed an unknown time");
  assert.doesNotMatch(html, /Invalid Date|Observed null|Observed undefined/);
});

test("live: the tooltips keep the visitor's own locale and zone", () => {
  const timestamp = "2026-10-27T09:00:00.000Z";
  const updatedAt = "2026-10-28T00:05:00.000Z";
  const seen = new Set();
  for (const zone of ZONES)
    inZone(zone, () => {
      // The live panel also titles its refresh button; the two times are the last.
      const [observed, registry] = titles(
        render(live, { timestamp, updatedAt }),
      ).slice(-2);
      assert.equal(
        observed,
        `Observed ${new Date(timestamp).toLocaleString()}`,
      );
      assert.equal(registry, new Date(updatedAt).toLocaleString());
      seen.add(observed);
    });
  // It really does follow the zone, so the edition's sameness above means something.
  assert.ok(seen.size > 1, "the live tooltip differs between zones");
});

test("the chart's date label is the UTC day and a 24-hour UTC clock", () => {
  assert.equal(shortTimeLabel("2026-10-28T14:05:00.000Z"), "28 Oct, 14:05 UTC");
  assert.equal(
    shortTimeLabel(Date.parse("2026-10-27T02:05:00Z")),
    "27 Oct, 02:05 UTC",
  );
  // Midnight is 00:00, never "12:00 AM" or "24:00".
  assert.equal(shortTimeLabel("2026-11-02T00:00:00.000Z"), "2 Nov, 00:00 UTC");
  assert.equal(shortTimeLabel("2026-12-31T23:59:59.999Z"), "31 Dec, 23:59 UTC");
  // The date is always there (unlike timeLabel, which drops it on the
  // reference day): a chart's two ends can be a day apart.
  assert.notEqual(shortTimeLabel("2026-10-28T14:05:00.000Z"), "14:05 UTC");
  for (const bad of [null, undefined, "", "soon", Number.NaN])
    assert.equal(shortTimeLabel(bad), null, String(bad));
  // Whatever the process's zone.
  for (const zone of ZONES)
    inZone(zone, () =>
      assert.equal(
        shortTimeLabel("2026-10-27T23:30:00.000Z"),
        "27 Oct, 23:30 UTC",
        zone,
      ),
    );
});

test("the day-and-month label is the UTC day, whatever the visitor's zone", () => {
  for (const zone of ZONES)
    inZone(zone, () => {
      // 23:30 UTC on the 27th is already the 28th in Tokyo and Bangkok.
      assert.equal(utcDayMonth(Date.parse("2026-10-27T23:30:00Z")), "27 Oct");
      assert.equal(utcDayMonth(Date.parse("2026-01-01T00:00:00Z")), "1 Jan");
    });
});

test("the live chart keeps its locale formats; only the edition's branches are new", async () => {
  const source = (
    await readFile(
      new URL("../src/components/Monitor.tsx", import.meta.url),
      "utf8",
    )
  ).replace(/\r\n/g, "\n");
  // The 12-hour formats are still there for the live page ...
  assert.match(source, /timeZoneName: "short"/);
  assert.match(source, /\.toLocaleTimeString\("en-US"/);
  // ... and each is the live arm of a STATIC_EDITION conditional.
  assert.match(
    source,
    /const date = \(timestamp: number\) =>\s+STATIC_EDITION\s+\?[^]*?shortTimeLabel\([^]*?:\s+new Date\(/,
  );
  assert.match(
    source,
    /\? STATIC_EDITION\s+\? `\$\{utcClock\([^]*?\)\} UTC`\s+: new Date\(/,
  );
  assert.match(source, /utcDayMonth\(/);
});
