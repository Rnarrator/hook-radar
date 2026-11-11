// Test support for the collector's own tests. Nothing in a run imports this
// file, and nothing here ever reaches published data.

/** Makes the process's own fetch refuse every request. A test file calls this
 * first, so that a test whose guard has regressed fails instead of reaching a
 * real provider: collector tests never use the network. */
export function blockNetwork() {
  globalThis.fetch = async (url) => {
    throw new Error(`A test tried to reach the network: ${url}`);
  };
}

export class FakeClock {
  constructor(start = Date.parse("2026-10-28T12:00:00.000Z")) {
    this.time = start;
    this.sleeps = [];
  }
  now = () => this.time;
  sleep = async (ms) => {
    this.sleeps.push(ms);
    this.time += ms;
  };
  advance(ms) {
    this.time += ms;
  }
}

/** A fetch that answers from a function and records when each request started. */
export function fakeFetch(clock, answer) {
  const calls = [];
  const impl = async (url, options = {}) => {
    const call = {
      url: String(url),
      at: clock.now(),
      headers: options.headers,
      method: options.method ?? "GET",
      body: options.body,
    };
    calls.push(call);
    const reply = await answer(call, calls.length);
    const headers = new Headers({
      "content-type": "application/json",
      date: new Date(clock.now()).toUTCString(),
      ...(reply.headers || {}),
    });
    return new Response(
      reply.body === undefined
        ? "{}"
        : typeof reply.body === "string"
          ? reply.body
          : JSON.stringify(reply.body),
      {
        status: reply.status ?? 200,
        headers,
      },
    );
  };
  impl.calls = calls;
  return impl;
}

let counter = 0;
export const hex = (length, seed) =>
  `0x${(BigInt(seed ?? ++counter) * 0x9e3779b97f4a7c15n).toString(16).padStart(length, "0").slice(-length)}`;
export const poolId = (seed) => hex(64, seed);
export const address = (seed) => hex(40, seed);

/** A hooked pool record as state/pools.json holds it. */
export function statePool(seed, overrides = {}) {
  const at = "2026-10-27T00:00:00.000Z";
  return {
    id: poolId(seed),
    chain: "base",
    hookAddress: address(1000 + (seed % 5)),
    tokens: [address(5000 + seed * 2), address(5001 + seed * 2)].sort(),
    name: `POOL${seed}`,
    createdAt: null,
    source: "census",
    firstSeen: at,
    lastSeen: at,
    ...overrides,
  };
}

/** A DEX Screener row for a state pool, shaped like the provider's. */
export function dexRow(pool, overrides = {}) {
  return {
    chainId: pool.chain === "bnb" ? "bsc" : pool.chain,
    dexId: "uniswap",
    labels: ["v4"],
    pairAddress: pool.id,
    baseToken: { address: pool.tokens[0], symbol: "AAA" },
    quoteToken: { address: pool.tokens[1], symbol: "BBB" },
    volume: { h24: 1000, h6: 300, h1: 50 },
    liquidity: { usd: 25000 },
    pairCreatedAt: Date.parse("2026-09-01T00:00:00.000Z"),
    ...overrides,
  };
}
