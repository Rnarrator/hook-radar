import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  LAUNCHPAD_REVIEWED_AT,
  getLaunchpad,
  launchpadRegistry,
} from "../shared/launchpad-registry.ts";
import {
  NOT_IN_SAMPLE,
  isPlainLeftClick,
  noPricedPoolNote,
  pricedPoolsNote,
  reviewNotesHeading,
  snapshotTakenNote,
  trackedVolumeNote,
} from "../src/edition-platform-copy.ts";

const source = (path) =>
  readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

const sample = (over = {}) => ({
  pools: 0,
  hooksWithPools: 0,
  mappedHooks: 5,
  volumeUsd: null,
  volumePools: 0,
  ...over,
});

// ── PD-06 ──────────────────────────────────────────────────────────────────

test("a platform with no pool in the measured sample says so, not that pools went unpriced", () => {
  const none = sample();
  assert.equal(
    pricedPoolsNote(none, true),
    "None of its pools are in this snapshot’s measured sample",
  );
  assert.equal(
    trackedVolumeNote(none, true),
    "None of its pools are in this snapshot’s measured sample",
  );
  for (const text of [
    pricedPoolsNote(none, true),
    trackedVolumeNote(none, true),
  ]) {
    assert.doesNotMatch(text, /No price|None found|loaded data/);
  }
  assert.equal(NOT_IN_SAMPLE, pricedPoolsNote(none, true));
});

test("pools in the sample with no current price still say no price within five minutes", () => {
  const stale = sample({ pools: 3, hooksWithPools: 2 });
  assert.equal(
    trackedVolumeNote(stale, true),
    "No price within five minutes of the snapshot",
  );
  assert.equal(pricedPoolsNote(stale, true), "On 2 of its 5 published hooks");
});

test("a priced platform keeps its counts in both flavours", () => {
  const priced = sample({
    pools: 12,
    hooksWithPools: 1,
    mappedHooks: 1,
    volumeUsd: 5_580_000,
    volumePools: 9,
  });
  assert.equal(pricedPoolsNote(priced, true), "On 1 of its 1 published hook");
  assert.equal(pricedPoolsNote(priced, false), "On 1 of its 1 published hook");
  assert.equal(
    trackedVolumeNote(priced, true),
    "9 pools priced within 5 minutes of the snapshot",
  );
  assert.equal(
    trackedVolumeNote({ ...priced, volumePools: 1 }, true),
    "1 pool priced within 5 minutes of the snapshot",
  );
  assert.equal(
    trackedVolumeNote(priced, false),
    "9 pools priced in the last 5 minutes",
  );
});

test("the live wording is exactly what it was", () => {
  assert.equal(
    pricedPoolsNote(sample(), false),
    "None found in the loaded data",
  );
  assert.equal(
    trackedVolumeNote(sample(), false),
    "No price under five minutes old",
  );
  assert.equal(
    trackedVolumeNote(sample({ pools: 4, hooksWithPools: 1 }), false),
    "No price under five minutes old",
  );
  assert.equal(
    noPricedPoolNote("5 published hooks", false),
    "No priced pool yet on its 5 published hooks (unpriced, or not found in the index).",
  );
});

// ── NLA-06 ─────────────────────────────────────────────────────────────────

test("the Launchpads row never says an unmeasured platform was not found in the index", () => {
  const text = noPricedPoolNote("5 published hooks", true);
  assert.equal(
    text,
    "None of the pools on its 5 published hooks are in this snapshot’s measured sample.",
  );
  assert.doesNotMatch(text, /index|yet|unpriced/);
  assert.equal(
    noPricedPoolNote("1 published hook", true),
    "None of the pools on its 1 published hook are in this snapshot’s measured sample.",
  );
});

// ── PD-05 / PD-04 / NLA-07 ─────────────────────────────────────────────────

test("the figures are dated in UTC with the day, and only in the edition", () => {
  assert.equal(
    snapshotTakenNote("2026-10-28T00:14:09.000Z", true),
    "Snapshot taken 28 Oct 2026, 00:14 UTC",
  );
  // The day is the UTC day: 23:50 UTC is still the 27th, wherever the visitor is.
  assert.equal(
    snapshotTakenNote(Date.parse("2026-10-27T23:50:00.000Z"), true),
    "Snapshot taken 27 Oct 2026, 23:50 UTC",
  );
  assert.equal(snapshotTakenNote("2026-10-28T00:14:09.000Z", false), null);
});

test("an unusable snapshot time yields no line rather than a made-up one", () => {
  for (const bad of [null, undefined, "", "not a time", Number.NaN])
    assert.equal(snapshotTakenNote(bad, true), null, String(bad));
});

// ── NLA-15 ─────────────────────────────────────────────────────────────────

test("a finding that quotes the live index is headed with its review day", () => {
  const record = getLaunchpad("tokenworks");
  assert.match(record.statusNote, /Radar shows 19 pools/);
  assert.equal(
    reviewNotesHeading(record.statusNote, record.reviewedAt, true),
    "Review notes as of 24 Oct 2026",
  );
  assert.equal(
    reviewNotesHeading(record.statusNote, record.reviewedAt, false),
    null,
  );
});

test("every reviewed note that mentions Radar is headed, and no other is", () => {
  let headed = 0;
  for (const record of launchpadRegistry) {
    const reviewed = record.reviewedAt ?? LAUNCHPAD_REVIEWED_AT;
    const heading = reviewNotesHeading(record.statusNote, reviewed, true);
    if (/\bRadar\b/.test(record.statusNote ?? "")) {
      headed += 1;
      assert.match(
        heading,
        /^Review notes as of \d{1,2} [A-Z][a-z]{2} 2026$/,
        record.id,
      );
    } else assert.equal(heading, null, record.id);
    assert.equal(reviewNotesHeading(record.statusNote, reviewed, false), null);
  }
  // Tokenworks, Unihood, Arcfun and the other notes that quote a pool count.
  assert.ok(headed >= 8, `only ${headed} headed notes`);
});

test("a review day that cannot be read gives no heading", () => {
  assert.equal(reviewNotesHeading("Radar shows 3 pools.", null, true), null);
  assert.equal(reviewNotesHeading("Radar shows 3 pools.", "later", true), null);
  assert.equal(reviewNotesHeading(null, "2026-10-24", true), null);
  assert.equal(
    reviewNotesHeading("Docs say it is live.", "2026-10-24", true),
    null,
  );
});

// ── PD-12 ──────────────────────────────────────────────────────────────────

test("only a plain click on a link is taken over by the page", () => {
  const click = (over = {}) => ({
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    ...over,
  });
  assert.equal(isPlainLeftClick(click()), true);
  for (const over of [
    { button: 1 },
    { button: 2 },
    { metaKey: true },
    { ctrlKey: true },
    { shiftKey: true },
    { altKey: true },
    { defaultPrevented: true },
  ])
    assert.equal(isPlainLeftClick(click(over)), false, JSON.stringify(over));
});

// ── The components use the helpers, behind the flag ────────────────────────

test("the platform drawer takes its words from the helpers and keeps the live link", () => {
  const text = source("components/PlatformDetail.tsx");
  assert.match(text, /pricedPoolsNote\(market\)/);
  assert.match(text, /trackedVolumeNote\(market\)/);
  assert.match(text, /snapshotTakenNote\(evaluationNow\(\)\)/);
  assert.match(text, /reviewNotesHeading\(/);
  // The link keeps its real href; the in-page route is the edition's only.
  assert.match(
    text,
    /href=\{`\/\?project=\$\{encodeURIComponent\(relation\.protocolId\)\}`\}/,
  );
  assert.match(text, /STATIC_EDITION && openProject\s*\?/);
  assert.match(text, /isPlainLeftClick\(event\)/);
  // The tooltip is UTC in the edition and the visitor's locale in the live app.
  assert.match(
    text,
    /STATIC_EDITION\s*\?\s*\(fullTimeLabel\(checkedAt\) \?\? undefined\)\s*:\s*new Date\(checkedAt\)\.toLocaleString\(\)/,
  );
  // The live class list is unchanged; the edition adds one class.
  assert.match(
    text,
    /platform-detail\$\{STATIC_EDITION \? " is-snapshot" : ""\}/,
  );
});

test("the Launchpads list labels the measured count and dates its times in the edition only", () => {
  const text = source("components/ChainProtocolCatalog.tsx");
  assert.match(
    text,
    /STATIC_EDITION \? "Pools in snapshot" : "Pools using hooks"/,
  );
  assert.match(text, /noPricedPoolNote\(hooks\(attribution\.mappedHooks\)\)/);
  assert.match(text, /if \(STATIC_EDITION\)\s+return fullTimeLabel\(value\)/);
  assert.match(text, /reviewNotesHeading\(/);
  // The live lower-bound title is still there for the live app.
  assert.match(text, /"Known lower bound from retained pool evidence"/);
});

test("the tap-target rule applies to the edition's drawer only", () => {
  const css = source("components/platform-detail.css");
  assert.match(
    css,
    /:where\(\.platform-detail\.is-snapshot\) :where\(\.external, \.lp-link\)\s*\{\s*min-height: 1\.5rem;/,
  );
});

test("the tap-target rule has no specificity, so the 44px primary buttons keep their size", () => {
  const css = source("components/platform-detail.css");
  const rule = css.match(
    /(^|\n)([^{}\n]*is-snapshot[^{}]*)\{\s*min-height: 1\.5rem;/,
  );
  assert.ok(rule, "the rule is present");
  // Every part of the selector is inside :where(), which weighs nothing: with
  // them removed nothing is left. A selector such as
  // ".platform-detail.is-snapshot :where(...)" weighs 0,2,0 and, later in the
  // bundle, shrinks ".project-detail .detail-actions-primary > *" (2.75rem).
  const left = rule[2].replace(/:where\([^()]*\)/g, "").trim();
  assert.equal(left, "", `selector weighs something: ${rule[2].trim()}`);
  // The primary buttons still ask for 2.75rem in the sheet that sets them.
  assert.match(
    source("components/project-detail.css"),
    /\.project-detail \.detail-actions-primary > \*\s*\{\s*min-height: 2\.75rem;/,
  );
});

test("the edition's pool-count tooltip says the figure is a floor from the snapshot", () => {
  const text = source("components/ChainProtocolCatalog.tsx");
  assert.match(
    text,
    /STATIC_EDITION\s*\?\s*"At least this many pools were measured in this snapshot"\s*:\s*"Known lower bound from retained pool evidence"/,
  );
});

test("the platform drawer and list name no service path", () => {
  for (const file of [
    "edition-platform-copy.ts",
    "components/PlatformDetail.tsx",
    "components/ChainProtocolCatalog.tsx",
  ])
    assert.doesNotMatch(source(file), /["'`]\/api\b/, file);
});
