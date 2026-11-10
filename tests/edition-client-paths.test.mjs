import test from "node:test";
import assert from "node:assert/strict";
import {
  STATIC_EDITION,
  baseOf,
  dataUrl,
  historyUrl,
  overviewFile,
  overviewUrl,
  publicAsset,
  snapshotUrl,
  statusUrl,
} from "../src/edition.ts";

test("the edition flag is off outside a flagged build", () => {
  assert.equal(STATIC_EDITION, false);
});

test("the build base always ends in a slash and an empty base is relative", () => {
  assert.equal(baseOf("/"), "/");
  assert.equal(baseOf("/repo/"), "/repo/");
  assert.equal(baseOf("/repo"), "/repo/");
  assert.equal(baseOf("./"), "./");
  assert.equal(baseOf(""), "./");
});

test("data files sit under the build base, at a domain root or a sub-path", () => {
  assert.equal(dataUrl("snapshot.json", "/"), "/data/snapshot.json");
  assert.equal(dataUrl("snapshot.json", "/repo/"), "/repo/data/snapshot.json");
  assert.equal(dataUrl("snapshot.json", "/repo"), "/repo/data/snapshot.json");
  assert.equal(dataUrl("snapshot.json", "./"), "./data/snapshot.json");
  assert.equal(snapshotUrl("/repo/"), "/repo/data/snapshot.json");
  assert.equal(historyUrl("/repo/"), "/repo/data/history.json");
  assert.equal(statusUrl("./"), "./data/status.json");
});

test("an overview file exists for every network at 24 hours and for all networks at every window", () => {
  for (const window of ["h1", "h6", "h24"])
    assert.equal(
      overviewFile({ chain: "all", window }),
      `overview-all-${window}.json`,
    );
  assert.equal(
    overviewFile({ chain: "base", window: "h24" }),
    "overview-base-h24.json",
  );
  assert.equal(
    overviewUrl({ chain: "base", window: "h24" }, "/repo/"),
    "/repo/data/overview-base-h24.json",
  );
});

test("no file is named for a combination the snapshot does not publish", () => {
  assert.equal(overviewFile({ chain: "base", window: "h1" }), null);
  assert.equal(overviewFile({ chain: "base", window: "h6" }), null);
  assert.equal(overviewFile({ chain: "all", window: "h12" }), null);
  assert.equal(overviewUrl({ chain: "base", window: "h1" }, "/"), null);
});

test("a network name can never steer the path elsewhere", () => {
  for (const chain of [
    "../secret",
    "base/../x",
    "Base",
    "base.json",
    "",
    "a b",
    "x".repeat(101),
  ])
    assert.equal(overviewFile({ chain, window: "h24" }), null, chain);
});

test("public files follow the base without being prefixed twice", () => {
  assert.equal(publicAsset("/protocols/a.svg", "/"), "/protocols/a.svg");
  assert.equal(
    publicAsset("/protocols/a.svg", "/repo/"),
    "/repo/protocols/a.svg",
  );
  assert.equal(
    publicAsset("/repo/protocols/a.svg", "/repo/"),
    "/repo/protocols/a.svg",
  );
  assert.equal(publicAsset("/protocols/a.svg", "./"), "./protocols/a.svg");
  assert.equal(publicAsset("./protocols/a.svg", "/repo/"), "./protocols/a.svg");
  assert.equal(
    publicAsset("https://example.com/a.png", "/repo/"),
    "https://example.com/a.png",
  );
  assert.equal(
    publicAsset("//cdn.example.com/a.png", "/repo/"),
    "//cdn.example.com/a.png",
  );
});

test("outside the edition a public file path is left exactly as written", () => {
  assert.equal(publicAsset("/protocols/a.svg"), "/protocols/a.svg");
});
