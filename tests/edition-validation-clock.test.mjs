// Snapshot validation in the Auto Snapshot edition must not read the visitor's
// clock. The census block of a snapshot carries a head-check time per network;
// the live service rejects one that lies in the future of the viewer's clock.
// A frozen snapshot is opened days later, on devices whose clock may be hours
// or days behind, so there the same rule is judged at the snapshot's own time.
// The edition flag is a build constant, so each validator also takes it as an
// argument and both builds are exercised here.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { futureSkewLimit, isSnapshot, isSnapshotFor } from "../src/model.ts";
import { inventory as isInventory } from "../src/discovery-validation.ts";
import { isTokenMetadataResponse } from "../src/token-metadata.ts";
import { GENERATED_AT } from "./fixtures/static-data/generate.mjs";

const HOUR = 3_600_000;
const MINUTE = 60_000;
const DAY = 24 * HOUR;
const generated = Date.parse(GENERATED_AT);
const iso = (ms) => new Date(ms).toISOString();

const fixture = () =>
  JSON.parse(
    readFileSync(
      new URL("./fixtures/static-data/data/snapshot.json", import.meta.url),
      "utf8",
    ),
  );
/** The fixture snapshot with every census head check set to one time. */
const withHeadCheck = (headCheckedAt) => {
  const snapshot = fixture();
  for (const network of snapshot.inventory.networks)
    network.headCheckedAt = headCheckedAt;
  return snapshot;
};
/** The visitor's clock for the rest of the test: call the result to move it. */
const visitorClock = (t, ms) => {
  let now = ms;
  t.mock.method(Date, "now", () => now);
  return (to) => {
    now = to;
  };
};

test("futureSkewLimit: the edition judges at the snapshot's own time, the live service at the viewer's clock", () => {
  const now = generated - 2 * DAY;
  assert.equal(futureSkewLimit(GENERATED_AT, true, now), generated + MINUTE);
  assert.equal(futureSkewLimit(GENERATED_AT, false, now), now + MINUTE);
  // Without a usable reference the viewer's clock stands in, as on the live service.
  for (const missing of [undefined, null, "", "not a date", 12, {}])
    assert.equal(futureSkewLimit(missing, true, now), now + MINUTE);
  // The flag defaults to the build's (false under Node): the live behaviour.
  assert.equal(futureSkewLimit(GENERATED_AT, undefined, now), now + MINUTE);
});

test("futureSkewLimit does not read the visitor's clock when the edition has a reference", (t) => {
  t.mock.method(Date, "now", () => {
    throw new Error("the visitor's clock was read");
  });
  assert.equal(futureSkewLimit(GENERATED_AT, true), generated + MINUTE);
});

test("edition: a head check three hours before the snapshot is accepted on a clock two days behind", (t) => {
  visitorClock(t, generated - 2 * DAY);
  const snapshot = withHeadCheck(iso(generated - 3 * HOUR));
  assert.equal(isSnapshotFor(snapshot, true), true);
  // The shipped test data (head checks a day before the snapshot) too.
  assert.equal(isSnapshotFor(fixture(), true), true);
});

test("edition: the verdict does not depend on the visitor's clock at all", (t) => {
  const snapshot = withHeadCheck(iso(generated - 3 * HOUR));
  const setClock = visitorClock(t, generated);
  const verdicts = [-100 * DAY, -2 * DAY, -4 * HOUR, 0, 40 * DAY].map(
    (offset) => {
      setClock(generated + offset);
      return isSnapshotFor(snapshot, true);
    },
  );
  assert.deepEqual(verdicts, [true, true, true, true, true]);
  t.mock.method(Date, "now", () => {
    throw new Error("the visitor's clock was read");
  });
  assert.equal(isSnapshotFor(snapshot, true), true);
});

test("edition: a head check after the snapshot's own time is still rejected, with one minute of allowance", (t) => {
  visitorClock(t, generated + 40 * DAY);
  assert.equal(
    isSnapshotFor(withHeadCheck(iso(generated + 2 * MINUTE)), true),
    false,
    "two minutes after generatedAt",
  );
  assert.equal(
    isSnapshotFor(withHeadCheck(iso(generated + MINUTE)), true),
    true,
    "exactly the allowance",
  );
  assert.equal(
    isSnapshotFor(withHeadCheck(iso(generated + MINUTE + 1)), true),
    false,
    "a millisecond past the allowance",
  );
  assert.equal(
    isSnapshotFor(withHeadCheck(iso(generated)), true),
    true,
    "at generatedAt",
  );
});

test("edition: the rest of the validation is unchanged", () => {
  const snapshot = withHeadCheck(iso(generated - HOUR));
  assert.equal(
    isSnapshotFor({ ...snapshot, generatedAt: "nope" }, true),
    false,
  );
  assert.equal(isSnapshotFor({ ...snapshot, schemaVersion: 2 }, true), false);
  assert.equal(
    isSnapshotFor(withHeadCheck("not a time"), true),
    false,
    "an unreadable head check",
  );
  assert.equal(isSnapshotFor(withHeadCheck(1), true), false);
  assert.equal(
    isSnapshotFor(withHeadCheck(null), true),
    true,
    "null is unknown",
  );
  const unset = fixture();
  for (const network of unset.inventory.networks) delete network.headCheckedAt;
  assert.equal(isSnapshotFor(unset, true), true);
  const noCensus = fixture();
  delete noCensus.inventory;
  assert.equal(isSnapshotFor(noCensus, true), true);
});

test("live: a head check in the future of the viewer's clock is still rejected, a past one accepted", (t) => {
  const now = generated + HOUR;
  const setClock = visitorClock(t, now);
  assert.equal(isSnapshotFor(withHeadCheck(iso(now - HOUR)), false), true);
  assert.equal(isSnapshotFor(withHeadCheck(iso(now + MINUTE)), false), true);
  assert.equal(
    isSnapshotFor(withHeadCheck(iso(now + 2 * MINUTE)), false),
    false,
  );
  // The same data on a clock two days behind is rejected, exactly as before.
  setClock(generated - 2 * DAY);
  assert.equal(
    isSnapshotFor(withHeadCheck(iso(generated - 3 * HOUR)), false),
    false,
  );
  assert.equal(isSnapshotFor(fixture(), false), false);
});

test("isSnapshot keeps its signature and, with the flag unset, the live behaviour", (t) => {
  assert.equal(isSnapshot.length, 1);
  const snapshot = withHeadCheck(iso(generated - 3 * HOUR));
  const setClock = visitorClock(t, generated + HOUR);
  assert.equal(isSnapshot(snapshot), isSnapshotFor(snapshot, false));
  assert.equal(isSnapshot(snapshot), true);
  setClock(generated - 2 * DAY);
  assert.equal(isSnapshot(snapshot), isSnapshotFor(snapshot, false));
  assert.equal(isSnapshot(snapshot), false);
  // The shipped test data is a valid snapshot on any later clock, as before.
  setClock(generated);
  assert.equal(isSnapshot(fixture()), true);
});

test("the discovery census block follows the same rule", (t) => {
  const census = (headCheckedAt) => {
    const block = fixture().inventory;
    for (const network of block.networks) network.headCheckedAt = headCheckedAt;
    return block;
  };
  const setClock = visitorClock(t, generated - 2 * DAY);
  const early = census(iso(generated - 3 * HOUR));
  assert.equal(isInventory(early, GENERATED_AT, true), true);
  assert.equal(isInventory(early, GENERATED_AT, false), false);
  assert.equal(isInventory(early), false, "default build flag is unset here");
  assert.equal(
    isInventory(census(iso(generated + 2 * MINUTE)), GENERATED_AT, true),
    false,
  );
  // With no publication time given, the block is judged at its own generatedAt.
  const own = Date.parse(early.generatedAt);
  assert.equal(isInventory(census(iso(own - HOUR)), undefined, true), true);
  assert.equal(isInventory(census(iso(own + MINUTE)), undefined, true), true);
  assert.equal(
    isInventory(census(iso(own + 2 * MINUTE)), undefined, true),
    false,
  );
  setClock(generated + DAY);
  assert.equal(isInventory(early, GENERATED_AT, false), true);
  assert.equal(isInventory(early), true);
});

test("token metadata timestamps follow the same rule", (t) => {
  const response = (updatedAt) => ({
    projectId: "example",
    tokens: [
      {
        chain: "base",
        address: `0x${"2".repeat(40)}`,
        symbol: "TOKEN",
        name: "Token contract name",
        decimals: 18,
        updatedAt,
        status: "cached",
        sourceUrl: "https://mainnet.base.org",
      },
    ],
  });
  const at = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
  const setClock = visitorClock(t, generated - 2 * DAY);
  const early = response(at(generated - 3 * HOUR));
  assert.equal(
    isTokenMetadataResponse(early, "example", GENERATED_AT, true),
    true,
  );
  assert.equal(
    isTokenMetadataResponse(early, "example", GENERATED_AT, false),
    false,
  );
  assert.equal(isTokenMetadataResponse(early, "example"), false);
  assert.equal(
    isTokenMetadataResponse(
      response(at(generated + 2 * MINUTE)),
      "example",
      GENERATED_AT,
      true,
    ),
    false,
  );
  setClock(generated + DAY);
  assert.equal(isTokenMetadataResponse(early, "example"), true);
  assert.equal(
    isTokenMetadataResponse(response(at(generated + 2 * DAY)), "example"),
    false,
  );
});
