import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { dayNumber } from "../shared/daily-volume.ts";

// Replays responses recorded by collector/tools/record-fixtures.mjs. Nothing here
// touches the network. Each recorded response keeps its own Date and Age
// headers, and the clock only ever moves forward to the time of a response, so
// every observation time in an offline run is a real recorded one.

// What a provider says when it has nothing for a request that was never
// recorded. Only used by --offline runs, whose output is never published.
const EMPTY = [
  [/^https:\/\/api\.dexscreener\.com\//, { pairs: null }],
  [/^https:\/\/api\.geckoterminal\.com\//, { data: [] }],
  [/^https:\/\/www\.v4\.xyz\//, { Pool: [] }],
];

// The 7D and 30D step asks GeckoTerminal for one pool's daily candles, and the
// recording of the run predates the step, so a replay has none to serve. It is
// answered from the REAL answers recorded on 11 November 2026
// (collector/fixtures/daily/), moved by whole days so that the newest candle is
// the replay's own day in progress, and without the pool identity the answer
// carries (a replay's pools are not those). Which recorded answer a pool gets
// depends only on its id. Offline output is marked as such and is never
// published; these answers exist so that a replay exercises the whole step.
const DAY_CANDLES_URL =
  /^https:\/\/api\.geckoterminal\.com\/api\/v2\/networks\/[a-z0-9_-]+\/pools\/(0x[0-9a-f]{64})\/ohlcv\/day\?/;
const DAILY_REPLAY_ANSWERS = [
  "01-eth-busy.json",
  "04-eth-sparse-empty.json",
  "05-robinhood-frontier.json",
  "08-xlayer.json",
  "10-robinhood-old.json",
];

async function dailyReplay(dir, url, current) {
  const id = DAY_CANDLES_URL.exec(url)?.[1];
  if (!id) return null;
  const name =
    DAILY_REPLAY_ANSWERS[
      [...id].reduce((sum, char) => sum + char.charCodeAt(0), 0) %
        DAILY_REPLAY_ANSWERS.length
    ];
  let recorded;
  try {
    recorded = JSON.parse(await readFile(join(dir, "daily", name), "utf8"));
  } catch {
    return null;
  }
  const body = JSON.parse(recorded.bodyText);
  const list = body.data.attributes.ohlcv_list;
  const shift =
    dayNumber(current) - Math.max(...list.map((row) => row[0] / 86400));
  return {
    data: {
      id: body.data.id,
      type: body.data.type,
      attributes: {
        ohlcv_list: list.map((row) => [row[0] + shift * 86400, ...row.slice(1)]),
      },
    },
  };
}

export async function createFixtureTransport(dir, { missing = "empty" } = {}) {
  const manifest = JSON.parse(
    await readFile(join(dir, "manifest.json"), "utf8"),
  );
  const entries = new Map(manifest.entries.map((entry) => [entry.url, entry]));
  const dates = manifest.entries.map((entry) => Date.parse(entry.date));
  let current = Math.min(...dates);
  const served = [];

  const respond = (status, body, headers = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });

  async function fetchImpl(url) {
    const entry = entries.get(String(url));
    if (!entry) {
      served.push({ url: String(url), recorded: false });
      if (missing === "empty") {
        const replay = await dailyReplay(dir, String(url), current);
        if (replay)
          return respond(200, replay, { date: new Date(current).toUTCString() });
        if (DAY_CANDLES_URL.test(String(url)))
          return respond(404, { errors: [{ status: "404", title: "Not Found" }] });
      }
      const empty = EMPTY.find(([pattern]) => pattern.test(String(url)));
      if (missing === "empty" && empty)
        return respond(200, empty[1], {
          date: new Date(current).toUTCString(),
        });
      return respond(404, { error: "Not recorded" });
    }
    served.push({ url: String(url), recorded: true });
    current = Math.max(current, Date.parse(entry.date) + 200);
    const body = await readFile(join(dir, entry.file), "utf8");
    return new Response(body, {
      status: entry.status,
      headers: {
        "content-type": "application/json",
        date: entry.date,
        ...(entry.age ? { age: String(entry.age) } : {}),
      },
    });
  }

  return {
    manifest,
    fetchImpl,
    now: () => current,
    sleep: async () => {},
    served,
  };
}
