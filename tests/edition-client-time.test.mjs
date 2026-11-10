import test from "node:test";
import assert from "node:assert/strict";
import {
  censusHeading,
  censusLabel,
  fullTimeLabel,
  snapshotAge,
  snapshotStatusLine,
  timeLabel,
  utcClock,
  utcDate,
} from "../src/edition.ts";
import { inlineTime, relativeTime } from "../src/model.ts";
import { formatAge, formatOldest, formatSince } from "../src/charts/format.ts";

const generated = Date.parse("2026-10-28T14:05:00.000Z");

test("a time on the snapshot's own day is a bare UTC clock", () => {
  assert.equal(timeLabel("2026-10-28T14:03:07.000Z", generated), "14:03 UTC");
  assert.equal(timeLabel("2026-10-28T00:00:00.000Z", generated), "00:00 UTC");
  assert.equal(timeLabel("2026-10-28T23:59:59.999Z", generated), "23:59 UTC");
});

test("an earlier day gets its date, and a different year gets the year", () => {
  assert.equal(
    timeLabel("2026-10-27T20:11:09.000Z", generated),
    "27 Oct, 20:11 UTC",
  );
  assert.equal(
    timeLabel("2025-12-31T23:59:00.000Z", generated),
    "31 Dec 2025, 23:59 UTC",
  );
});

test("the day is the UTC day, whatever the visitor's time zone", () => {
  // 23:30 UTC on the 27th is already the 28th in Tokyo; it stays the 27th here.
  assert.equal(
    timeLabel("2026-10-27T23:30:00.000Z", generated),
    "27 Oct, 23:30 UTC",
  );
});

test("an unreadable time has no label", () => {
  for (const bad of [null, undefined, "", "soon", Number.NaN])
    assert.equal(timeLabel(bad, generated), null, String(bad));
  assert.equal(fullTimeLabel("nope"), null);
});

test("the full form names date and UTC clock", () => {
  assert.equal(
    fullTimeLabel("2026-10-28T14:05:00.000Z"),
    "28 Oct 2026, 14:05 UTC",
  );
  assert.equal(fullTimeLabel(generated), "28 Oct 2026, 14:05 UTC");
  assert.equal(utcClock(generated), "14:05");
  assert.equal(utcDate(generated), "28 Oct 2026");
});

test("how old the snapshot is is counted by the visitor's clock, in plain units", () => {
  const minute = 60_000;
  const hour = 60 * minute;
  assert.equal(snapshotAge(generated, generated + 20_000), "just now");
  assert.equal(snapshotAge(generated, generated + minute), "1 min ago");
  assert.equal(snapshotAge(generated, generated + 59 * minute), "59 min ago");
  assert.equal(snapshotAge(generated, generated + hour), "1 h ago");
  assert.equal(
    snapshotAge(generated, generated + 3 * hour + 12 * minute),
    "3 h 12 min ago",
  );
  assert.equal(snapshotAge(generated, generated + 26 * hour), "1 d 2 h ago");
  assert.equal(snapshotAge(generated, generated + 48 * hour), "2 d ago");
  // A visitor clock set earlier than the snapshot is not shown as a negative age.
  assert.equal(snapshotAge(generated, generated - hour), "just now");
  assert.equal(snapshotAge("garbage", generated), null);
});

test("the status line states when it was taken and how often it is renewed", () => {
  const line = snapshotStatusLine(
    "2026-10-28T14:05:00.000Z",
    generated + 3_600_000,
  );
  assert.equal(line.taken, "Snapshot taken 28 Oct 2026, 14:05 UTC");
  assert.equal(line.note, "refreshed every few hours");
  assert.equal(line.age, "1 h ago");
  assert.equal(snapshotStatusLine("garbage", generated), null);
});

test("census figures read as dated, from the inventory's own time", () => {
  assert.equal(
    censusLabel({ generatedAt: "2026-10-27T20:11:09.000Z" }),
    "census as of 27 Oct 2026",
  );
  assert.equal(censusLabel(undefined), null);
  assert.equal(censusLabel({ generatedAt: "bad" }), null);
});

test("a census caption is the same label with a capital, and absent when undated", () => {
  assert.equal(
    censusHeading({ generatedAt: "2026-10-27T20:11:09.000Z" }),
    "Census as of 27 Oct 2026",
  );
  // The date is the census's own day in UTC, whatever time zone reads it.
  assert.equal(
    censusHeading({ generatedAt: "2026-10-27T23:59:59.000Z" }),
    "Census as of 27 Oct 2026",
  );
  assert.equal(censusHeading(null), null);
  assert.equal(censusHeading(undefined), null);
  assert.equal(censusHeading({ generatedAt: "bad" }), null);
});

test("outside the edition ages stay relative and unchanged", () => {
  const now = Date.parse("2026-10-28T14:05:00.000Z");
  assert.equal(relativeTime("2026-10-28T14:04:40.000Z", now), "Just now");
  assert.equal(relativeTime("2026-10-28T14:02:00.000Z", now), "3m ago");
  assert.equal(relativeTime("2026-10-28T12:05:00.000Z", now), "2h ago");
  assert.equal(relativeTime("2026-10-26T14:05:00.000Z", now), "2d ago");
  assert.equal(relativeTime(null, now), "Unknown");
  assert.equal(inlineTime("2026-10-28T14:02:00.000Z", now), "3m ago");
  assert.equal(inlineTime("2026-10-28T14:04:40.000Z", now), "just now");
  assert.equal(formatSince(now - 192_000, now), "3m 12s ago");
  assert.equal(formatOldest(now - 192_000, now), "oldest 3m 12s old");
  assert.equal(formatAge(192_000), "3m 12s");
});
