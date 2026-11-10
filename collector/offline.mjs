import { readFile } from "node:fs/promises";
import { join } from "node:path";

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
