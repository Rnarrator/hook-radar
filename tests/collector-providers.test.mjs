import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { MARKET_CHAINS } from "../server/market-chains.mjs";
import { ZERO_ADDRESS } from "../server/model.mjs";
import {
  acceptDexScreenerPairs,
  dexScreenerUrl,
  normalizeDexScreenerPool,
} from "../collector/providers/dexscreener.mjs";
import {
  acceptGeckoPools,
  discoveryPage,
  geckoMultiUrl,
  normalizeGeckoPool,
} from "../collector/providers/geckoterminal.mjs";
import {
  dynamicFeeEvidence,
  initialFeeFromName,
  poolDetailUrl,
  poolListUrl,
  validateEnvioPools,
  validateIndexerPoolIdentity,
} from "../collector/providers/v4xyz.mjs";
import { address, dexRow, poolId, statePool } from "../collector/testing.mjs";

// The parity checks compare against the live collector itself. A packaged copy
// that carries only the modules the collector imports skips them.
const live = await import("../server/market-enricher.mjs").catch(() => null);
const parity = {
  skip: live ? false : "server/market-enricher.mjs is not part of this copy",
};
const { marketBatchUrl, normalizeMarketPool, validateMarketBatch } = live ?? {};

const base = MARKET_CHAINS.find((chain) => chain.chain === "base");
const structural = (pools) => new Map(pools.map((pool) => [pool.id, pool]));
const geckoRow = (pool, overrides = {}) => ({
  id: `${base.gecko}_${pool.id}`,
  type: "pool",
  attributes: {
    address: pool.id,
    name: "AAA / BBB 0.3%",
    pool_created_at: "2026-09-01T00:00:00Z",
    reserve_in_usd: "1000.5",
    volume_usd: { h1: "10", h6: "60", h24: "240" },
    base_token_balance: "1",
    quote_token_balance: "1",
    base_token_price_usd: "500",
    quote_token_price_usd: "500.5",
    base_token_liquidity_usd: "500",
    quote_token_liquidity_usd: "500.5",
  },
  relationships: {
    dex: { data: { id: base.dex } },
    base_token: { data: { id: `${base.gecko}_${pool.tokens[0]}` } },
    quote_token: { data: { id: `${base.gecko}_${pool.tokens[1]}` } },
  },
  ...overrides,
});

const pools = [1, 2, 3, 4, 5].map((seed) => statePool(seed));

test("DEX Screener URLs are exact-id batches of at most 30 on the provider's chain id", () => {
  const ids = pools.map((pool) => pool.id);
  assert.equal(
    dexScreenerUrl(base, ids),
    `https://api.dexscreener.com/latest/dex/pairs/base/${ids.join(",")}`,
  );
  const bnb = MARKET_CHAINS.find((chain) => chain.chain === "bnb");
  assert.match(dexScreenerUrl(bnb, ids.slice(0, 1)), /\/pairs\/bsc\//);
  assert.throws(() => dexScreenerUrl(base, []));
  assert.throws(() =>
    dexScreenerUrl(
      base,
      Array.from({ length: 31 }, (_, i) => poolId(100 + i)),
    ),
  );
  assert.throws(() => dexScreenerUrl(base, ["0x1234"]));
  assert.throws(() => dexScreenerUrl({ chain: "nowhere" }, ids));
});

test("GeckoTerminal fallback URLs are exact-id batches of at most 30", () => {
  const ids = pools.map((pool) => pool.id);
  assert.match(
    geckoMultiUrl(base, ids),
    /^https:\/\/api\.geckoterminal\.com\/api\/v2\/networks\/base\/pools\/multi\/0x/,
  );
  assert.throws(() =>
    geckoMultiUrl(
      base,
      Array.from({ length: 31 }, (_, i) => poolId(200 + i)),
    ),
  );
});

test("request URLs are the live collector's", parity, () => {
  const ids = pools.map((pool) => pool.id);
  assert.equal(
    dexScreenerUrl(base, ids),
    marketBatchUrl("dexscreener", base, ids),
  );
  assert.equal(
    geckoMultiUrl(base, ids),
    marketBatchUrl("geckoterminal", base, ids),
  );
});

test("the discovery page rotates through the cycle and stays in range", () => {
  const pages = Array.from({ length: 12 }, (_, run) => discoveryPage(run));
  assert.deepEqual(pages.slice(0, 6), [1, 2, 3, 4, 5, 1]);
  assert.ok(pages.every((page) => page >= 1 && page <= 10));
});

test("DEX Screener acceptance: only exact requested Uniswap v4 pools on this chain", () => {
  const [a, b, c, d, e] = pools;
  const requested = pools.map((pool) => pool.id);
  const wrongChain = dexRow(b, { chainId: "ethereum" });
  const notUniswap = dexRow(c, { dexId: "sushiswap" });
  const notV4 = dexRow(d, { labels: ["v3"] });
  const unlabelled = dexRow(e, { labels: undefined });
  const unrequested = dexRow(statePool(99));
  const upper = dexRow(a, {
    pairAddress: a.id.toUpperCase().replace("0X", "0x"),
  });
  const accepted = acceptDexScreenerPairs(
    { pairs: [upper, wrongChain, notUniswap, notV4, unlabelled, unrequested] },
    base,
    requested,
    structural(pools),
  );
  assert.deepEqual(
    accepted.map((row) => row.pairAddress.toLowerCase()).sort(),
    [a.id, e.id].sort(),
  );
});

test("DEX Screener acceptance: a row whose currencies disagree with our identity is dropped", () => {
  const [a, b, c] = pools;
  const swapped = dexRow(a, {
    baseToken: { address: a.tokens[1], symbol: "X" },
    quoteToken: { address: a.tokens[0], symbol: "Y" },
  });
  const stranger = dexRow(b, {
    baseToken: { address: address(777), symbol: "X" },
  });
  const missing = dexRow(c, { baseToken: undefined, quoteToken: undefined });
  const accepted = acceptDexScreenerPairs(
    { pairs: [swapped, stranger, missing] },
    base,
    [a.id, b.id, c.id],
    structural(pools),
  );
  // The live rule compares the set of non-native currencies, not their order, so
  // a swapped pair agrees; a stranger is refused; a row naming no currencies
  // cannot disagree and is kept.
  assert.deepEqual(
    accepted.map((row) => row.pairAddress),
    [a.id, c.id],
  );
});

test("DEX Screener acceptance: a native currency may be represented by its wrapped form", () => {
  const native = statePool(40, { tokens: [ZERO_ADDRESS, address(41)] });
  const row = dexRow(native, {
    baseToken: { address: address(900), symbol: "WETH" },
    quoteToken: { address: native.tokens[1], symbol: "Z" },
  });
  const accepted = acceptDexScreenerPairs(
    { pairs: [row] },
    base,
    [native.id],
    structural([native]),
  );
  assert.equal(accepted.length, 1);
});

test("DEX Screener acceptance: shape errors and ambiguity are errors, an empty answer is not", () => {
  const [a] = pools;
  assert.deepEqual(
    acceptDexScreenerPairs({ pairs: null }, base, [a.id], structural(pools)),
    [],
  );
  assert.deepEqual(
    acceptDexScreenerPairs({ pairs: [] }, base, [a.id], structural(pools)),
    [],
  );
  assert.throws(() =>
    acceptDexScreenerPairs({}, base, [a.id], structural(pools)),
  );
  assert.throws(() =>
    acceptDexScreenerPairs({ pairs: {} }, base, [a.id], structural(pools)),
  );
  assert.throws(() =>
    acceptDexScreenerPairs(
      { pairs: Array.from({ length: 31 }, () => dexRow(a)) },
      base,
      [a.id],
      structural(pools),
    ),
  );
  assert.throws(
    () =>
      acceptDexScreenerPairs(
        { pairs: [dexRow(a), dexRow(a)] },
        base,
        [a.id],
        structural(pools),
      ),
    /ambiguous/,
  );
});

test(
  "DEX Screener acceptance is identical to the live collector's for every case above",
  parity,
  () => {
    const [a, b, c, d, e] = pools;
    const cases = [
      { pairs: [dexRow(a), dexRow(b)] },
      {
        pairs: [
          dexRow(a, { chainId: "ethereum" }),
          dexRow(b, { dexId: "pancake" }),
        ],
      },
      {
        pairs: [
          dexRow(c, { labels: ["v3"] }),
          dexRow(d, { labels: [] }),
          dexRow(e, { labels: ["v4", "hook"] }),
        ],
      },
      { pairs: [dexRow(a, { baseToken: { address: address(901) } })] },
      { pairs: [dexRow(statePool(77))] },
      { pairs: null },
      { pairs: [] },
    ];
    const requested = pools.map((pool) => pool.id);
    for (const value of cases)
      assert.deepEqual(
        acceptDexScreenerPairs(value, base, requested, structural(pools)),
        validateMarketBatch(
          value,
          "dexscreener",
          base,
          requested,
          structural(pools),
        ).pairs,
      );
  },
);

test("GeckoTerminal fallback acceptance mirrors the live rules", () => {
  const [a, b, c, d] = pools;
  const requested = pools.map((pool) => pool.id);
  const value = {
    data: [
      geckoRow(a),
      geckoRow(b, { type: "token" }),
      geckoRow(c, { id: "base_0xdeadbeef" }),
      geckoRow(d, {
        relationships: { dex: { data: { id: "uniswap-v3-base" } } },
      }),
      geckoRow(statePool(88)),
    ],
  };
  const accepted = acceptGeckoPools(value, base, requested, structural(pools));
  assert.deepEqual(
    accepted.map((row) => row.attributes.address),
    [a.id],
  );
  const mismatch = {
    data: [
      geckoRow(b, {
        relationships: {
          dex: { data: { id: base.dex } },
          base_token: { data: { id: `base_${address(999)}` } },
          quote_token: { data: { id: `base_${b.tokens[1]}` } },
        },
      }),
    ],
  };
  assert.deepEqual(
    acceptGeckoPools(mismatch, base, requested, structural(pools)),
    [],
  );
  assert.throws(
    () =>
      acceptGeckoPools(
        { data: [geckoRow(a), geckoRow(a)] },
        base,
        requested,
        structural(pools),
      ),
    /ambiguous/,
  );
  assert.throws(() => acceptGeckoPools({}, base, requested, structural(pools)));
});

test(
  "GeckoTerminal fallback acceptance is identical to the live collector's",
  parity,
  () => {
    const [a, b, c, d] = pools;
    const requested = pools.map((pool) => pool.id);
    const cases = [
      {
        data: [
          geckoRow(a),
          geckoRow(b, { type: "token" }),
          geckoRow(c, { id: "base_0xdeadbeef" }),
          geckoRow(d, {
            relationships: { dex: { data: { id: "uniswap-v3-base" } } },
          }),
          geckoRow(statePool(88)),
        ],
      },
      {
        data: [
          geckoRow(b, {
            relationships: {
              dex: { data: { id: base.dex } },
              base_token: { data: { id: `base_${address(999)}` } },
              quote_token: { data: { id: `base_${b.tokens[1]}` } },
            },
          }),
        ],
      },
      { data: [] },
    ];
    for (const value of cases)
      assert.deepEqual(
        acceptGeckoPools(value, base, requested, structural(pools)),
        validateMarketBatch(
          value,
          "geckoterminal",
          base,
          requested,
          structural(pools),
        ).data,
      );
  },
);

test(
  "a DEX Screener pool is normalized like the live collector's, minus bulky evidence",
  parity,
  () => {
    const [a] = pools;
    const observedAt = Date.parse("2026-10-28T12:03:04.000Z");
    const row = dexRow(a);
    const mine = normalizeDexScreenerPool(row, base, a, observedAt);
    const liveRow = normalizeMarketPool(
      row,
      "dexscreener",
      base,
      { ...a, address: a.id },
      {
        updatedAt: new Date(observedAt).toISOString(),
        status: "live",
      },
    );
    const { liquidityEvidence, ...liveRest } = liveRow;
    assert.ok(liquidityEvidence);
    assert.deepEqual(mine, JSON.parse(JSON.stringify(liveRest)));
    assert.equal(mine.metricUpdatedAt, "2026-10-28T12:03:04.000Z");
    assert.equal(mine.metricStatus, "live");
    assert.equal("liquidityEvidence" in mine, false);
  },
);

test(
  "a GeckoTerminal fallback pool is normalized like the live collector's",
  parity,
  () => {
    const [a] = pools;
    const observedAt = Date.parse("2026-10-28T12:03:04.000Z");
    const row = geckoRow(a);
    const mine = normalizeGeckoPool(row, base, a, observedAt);
    const liveRow = normalizeMarketPool(
      row,
      "geckoterminal",
      base,
      { ...a, address: a.id },
      {
        updatedAt: new Date(observedAt).toISOString(),
        status: "live",
      },
    );
    const { liquidityEvidence, ...liveRest } = liveRow;
    assert.deepEqual(mine, JSON.parse(JSON.stringify(liveRest)));
    assert.equal(mine.source, "GeckoTerminal");
  },
);

test("an unavailable amount is null and a measured zero stays zero", () => {
  const [a] = pools;
  const at = Date.parse("2026-10-28T12:00:00.000Z");
  const unknown = normalizeDexScreenerPool(
    dexRow(a, { volume: { h24: null, h6: "n/a" }, liquidity: undefined }),
    base,
    a,
    at,
  );
  assert.deepEqual(unknown.volumeUsd, { h1: null, h6: null, h24: null });
  assert.equal(unknown.liquidityUsd, null);
  assert.equal(unknown.liquidityStatus, "unavailable");
  const zero = normalizeDexScreenerPool(
    dexRow(a, {
      volume: { h24: 0, h6: "0", h1: "0.0" },
      liquidity: { usd: 0 },
    }),
    base,
    a,
    at,
  );
  assert.deepEqual(zero.volumeUsd, { h1: 0, h6: 0, h24: 0 });
  assert.equal(zero.liquidityUsd, 0);
  assert.equal(zero.liquidityStatus, "reported");
  const negative = normalizeDexScreenerPool(
    dexRow(a, {
      volume: { h24: -5, h6: "-1", h1: Number.NaN },
      liquidity: { usd: -1 },
    }),
    base,
    a,
    at,
  );
  assert.deepEqual(negative.volumeUsd, { h1: null, h6: null, h24: null });
  assert.equal(negative.liquidityUsd, null);
});

test("a nonzero string that rounds to zero is not a measured zero", () => {
  const [a] = pools;
  const row = normalizeDexScreenerPool(
    dexRow(a, { volume: { h24: "1e-400", h6: "0.000", h1: "5" } }),
    base,
    a,
    Date.now(),
  );
  assert.equal(row.volumeUsd.h24, null);
  assert.equal(row.volumeUsd.h6, 0);
  assert.equal(row.volumeUsd.h1, 5);
});

test("the indexer's exact-pool answer is checked against the id and the chain", () => {
  const id = poolId(500);
  const hook = address(3000);
  const detail = (overrides = {}) => ({
    Pool: [
      {
        id: `8453_${id}`,
        chainId: "8453",
        hooks: hook,
        token0: `8453_${address(10)}`,
        token1: `8453_${address(11)}`,
        name: "AAA/BBB",
        ...overrides,
      },
    ],
  });
  const identity = validateIndexerPoolIdentity(detail(), base, id);
  assert.deepEqual(identity, {
    address: id,
    hooked: true,
    hookAddress: hook.toLowerCase(),
    tokens: [address(10), address(11)],
    name: "AAA/BBB",
  });
  assert.equal(
    validateIndexerPoolIdentity(detail({ hooks: ZERO_ADDRESS }), base, id)
      .hooked,
    false,
  );
  for (const bad of [
    { Pool: [] },
    { Pool: [detail().Pool[0], detail().Pool[0]] },
    detail({ id: `1_${id}` }),
    detail({ id: `8453_${poolId(501)}` }),
    detail({ chainId: "1" }),
    detail({ hooks: "0x123" }),
    detail({ token0: address(10) }),
    detail({ token1: `8453_${address(10)}` }),
    {},
  ])
    assert.throws(() => validateIndexerPoolIdentity(bad, base, id));
  assert.equal(poolListUrl(base), "https://www.v4.xyz/api/pools?chainId=8453");
  assert.equal(
    poolDetailUrl(base, id.toUpperCase().replace("0X", "0x")),
    `https://www.v4.xyz/api/pool/8453_${id}`,
  );
  assert.throws(() => poolDetailUrl(base, "0x12"));
});

test("the initial LP fee is read from the end of the indexer's pool name, nowhere else", () => {
  assert.equal(initialFeeFromName("WETH / SARP - 0.3%"), 3000);
  assert.equal(initialFeeFromName("A / B - 0.0001%"), 1);
  assert.equal(initialFeeFromName("A / B - 100%"), 1000000);
  assert.equal(initialFeeFromName("A / B - 0%"), 0);
  assert.equal(initialFeeFromName("BSW / USAD - 838.8608%"), 8388608);
  for (const unreadable of [
    "Indexed v4 pool",
    "ETH / USDC",
    "A / B - 0.3",
    "A / B - 0.30001%",
    "A / B - 100.0001%",
    "A / B - 500%",
    "A / B - 838.8609%",
    "A / B - 0.3% extra",
    "A - 5% / B",
    "",
    null,
    undefined,
    3000,
  ])
    assert.equal(initialFeeFromName(unreadable), null, String(unreadable));
});

test("only the dynamic-fee flag counts as evidence; a fixed fee proves nothing about the hook", () => {
  assert.equal(dynamicFeeEvidence("BSW / USAD - 838.8608%"), true);
  assert.equal(dynamicFeeEvidence("WETH / SARP - 0.3%"), undefined);
  assert.equal(dynamicFeeEvidence("A / B - 0%"), undefined);
  assert.equal(dynamicFeeEvidence("Indexed v4 pool"), undefined);
});

test("on the recorded indexer answers, every dynamic-looking name is a hook the live app tags dynamic", async () => {
  // The three recordings are real v4.xyz answers (27 October 2026). The exact
  // answer shows why the name is used and feeTier is not: the pool is dynamic
  // (838.8608% is 0x800000 in hundredths of a basis point) and feeTier is "0".
  const read = async (name) =>
    JSON.parse(
      await readFile(
        new URL(`../collector/fixtures/${name}.json`, import.meta.url),
        "utf8",
      ),
    );
  const exact = (await read("v4-3")).Pool[0];
  assert.equal(exact.feeTier, "0");
  assert.equal(dynamicFeeEvidence(exact.name), true);
  const ethereum = MARKET_CHAINS.find((chain) => chain.chain === "ethereum");
  const lists = [
    [ethereum, await read("v4-1")],
    [base, await read("v4-2")],
  ];
  let dynamic = 0;
  let fixed = 0;
  for (const [chain, answer] of lists) {
    const { pools } = validateEnvioPools(answer, chain);
    assert.ok(pools.length > 0);
    for (const pool of pools) {
      assert.notEqual(initialFeeFromName(pool.name), null, pool.name);
      if (dynamicFeeEvidence(pool.name)) dynamic++;
      else fixed++;
    }
  }
  assert.equal(dynamic, 26, "the recorded lists hold 26 dynamic-fee pools");
  assert.ok(fixed > 0);
});
