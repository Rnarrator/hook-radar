import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as config from "../collector/config.mjs";
import { requestReserve } from "../collector/run.mjs";

// What the documents say about 7D and 30D volume is what the code does: the
// numbers come from collector/config.mjs, the files and the request arithmetic
// from the collector, the words about the figures from the truth rules.

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (path) =>
  readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n");
// The documents are in docs/edition/ in the source repository and in docs/ (the
// start guide is README.md) in the assembled folder, so the test travels with it.
const where = (name) =>
  (name === "README-START-HERE.md"
    ? ["docs/edition/README-START-HERE.md", "README.md"]
    : [`docs/edition/${name}`, `docs/${name}`]
  ).find((path) => existsSync(join(root, path)));
const doc = (name) => read(where(name));
const flat = (name) => doc(name).replace(/\s+/g, " ");
const notes = flat("COLLECTOR-NOTES.md");

test("the collector notes give the step's limits as the code has them", () => {
  const row = (name) =>
    new RegExp(`\\| \`${name}\`[^|]*\\| ([^|]+) \\|`).exec(doc("COLLECTOR-NOTES.md"))?.[1];
  assert.equal(
    row("DAILY_JOIN_RANK` / `DAILY_KEEP_RANK` / `DAILY_RANK_GRACE_MS").startsWith(
      `${config.DAILY_JOIN_RANK} / ${config.DAILY_KEEP_RANK} / ${config.DAILY_RANK_GRACE_MS / 86400000} days`,
    ),
    true,
  );
  assert.match(
    row("DAILY_MAX_REQUESTS` / `DAILY_BUDGET_MS` / `DAILY_LATEST_START_MS"),
    new RegExp(`^${config.DAILY_MAX_REQUESTS} requests; none starts later than ${config.DAILY_BUDGET_MS / 1000} s into the step; the step is skipped once the run is ${config.DAILY_LATEST_START_MS / 60000} minutes old`),
  );
  assert.match(
    row("DAILY_CANDLES` / `DAILY_STORED_DAYS"),
    new RegExp(`^${config.DAILY_CANDLES} rows asked for .*; ${config.DAILY_STORED_DAYS} days kept per pool`),
  );
  assert.match(row("DAILY_CHECKPOINT_HOURS"), /^00:00 and 04:00 UTC/);
  assert.deepEqual([...config.DAILY_CHECKPOINT_HOURS], [0, 4]);
  assert.match(
    row("DAILY_READY_SHARE` / `DAILY_MAX_UNREADABLE"),
    new RegExp(`^${config.DAILY_READY_SHARE} of the covered volume .*; two unreadable`),
  );
  assert.equal(config.DAILY_MAX_UNREADABLE, 2);
  assert.match(row("MAX_BYTES.geckoDaily"), new RegExp(`^${config.MAX_BYTES.geckoDaily / 1024} KB`));
});

test("the request arithmetic in the notes is the contract's", () => {
  // 380 requests in the real discovery run of 11 November 2026: 19 left. The
  // ceiling 3 + 306 + 6 + 3 + 80 = 398 leaves 1, and the fake full-size run 388 leaves 11.
  const reserve = requestReserve(8500);
  assert.equal(3 + (reserve - 6 - 3) + 6 + 3 + 80, 398);
  for (const [used, left] of [[380, 19], [388, 11], [398, 1]])
    assert.equal(config.MAX_REQUESTS_PER_RUN - used, left);
  assert.match(notes, /made 380 requests \(DEX Screener 288, GeckoTerminal 26, v4\.xyz 60, registry 2, Frontier 3, Goldsky 1\), so the step could send 19/);
  assert.match(notes, /the documented full-size fake run is 388 \(11 left\)/);
  assert.match(notes, /3 \+ 306 \+ 6 \+ 3 \+ 80, is 398 \(1 left\)/);
  assert.match(notes, /About 125 requests a day in all/);
});

test("the notes name the files the step reads and writes, and the one switch", () => {
  for (const text of ["`state/daily.json`", "`data/daily.json`", "`geckoterminal-daily`", "`counts.daily`", "COLLECTOR_DAILY_MAX_REQUESTS"])
    assert.ok(notes.includes(text), text);
  assert.match(notes, /\| `daily\.json` \| `\{ schemaVersion, updatedAt, pools: \[\.\.\.\] \}`, one record per line, at most 60/);
  assert.match(notes, /Written by the collector only, and only when the records changed; never committed from a worktree/);
  assert.match(notes, /never moves a time the page judges|move no time|cannot delay the burst/);
  // What it does delay is said too: publication, by up to the step's own limit.
  assert.match(notes, /the write phase waits for the step/);
  assert.match(notes, /follow up to about four minutes later \(the step's own 240 s and one last request\)/);
  assert.equal(config.DAILY_BUDGET_MS, 240_000, "the four minutes in the notes are the step's budget");
  assert.match(notes, /ignored with a note in `counts\.daily\.note`/);
  // The code writes what the notes say it writes.
  const state = read("collector/state.mjs");
  assert.match(state, /join\(dir, "daily\.json"\)/);
  assert.match(read("collector/run.mjs"), /join\(outDir, "daily\.json"\)/);
});

test("the other documents say the same, in plain words", () => {
  const how = flat("HOW-IT-WORKS.md");
  assert.match(how, /## 7D and 30D volume/);
  assert.match(how, /sum of a pool's USD volume over the last 7 \(or 30\) \*\*complete UTC days\*\*/);
  assert.match(how, /The day still in progress is never counted/);
  assert.match(how, /marked "at least" \(≥\)/);
  assert.match(how, /A pool without one is a dash, never \$0/);
  assert.match(how, /the five-minute qualification does not apply to it/);
  assert.match(how, /\| `data\/daily\.json` \|/);
  assert.match(how, /about 125 GeckoTerminal requests a day/);
  assert.match(how, /With 7D or 30D chosen, the CSV carries that figure, blank where a row has none, and says "at least" in its column title/);
  assert.match(how, /The JSON is the whole snapshot and does not include 7D or 30D figures/);
  const truth = flat("TRUTH-RULES.md");
  assert.match(truth, /a pool that has no daily figure shows a dash with the reason/);
  assert.match(truth, /the five-minute rule is not applied to it and not changed for the other windows/);
  assert.match(truth, /every total of those figures is marked "at least" \(≥\)/);
  const terms = flat("PROVIDER-TERMS.md");
  assert.match(terms, /at most 20 requests a run and about 125 a day/);
  assert.match(terms, /The attribution question above is still open and covers these figures too/);
  assert.match(terms, /2 of 11 requests spaced 15 to 100 seconds apart were refused with HTTP 429/);
  // The design contract (only in the source repository) and the start guide.
  if (existsSync(join(root, "docs/STATIC-EDITION-DESIGN.md"))) {
    const design = read("docs/STATIC-EDITION-DESIGN.md").replace(/\s+/g, " ");
    assert.match(design, /\| `\/data\/daily\.json` \|/);
    assert.match(design, /\| `state\/daily\.json` \|/);
    assert.match(design, /which is not `analytics_range`/);
  }
  assert.match(flat("README-START-HERE.md"), /the daily volume of the largest pools/);
});

test("the pages avoid the engineering words for what visitors read", () => {
  const visible = [
    flat("HOW-IT-WORKS.md").match(/## 7D and 30D volume.*?## What is sampled/)?.[0],
    flat("TRUTH-RULES.md"),
  ].join(" ");
  for (const word of [/candle/i, /OHLCV/, /checkpoint/i])
    assert.doesNotMatch(visible, word);
});
