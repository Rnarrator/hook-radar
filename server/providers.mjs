import {
  digest,
  isAddress,
  isPoolId,
  numberOrNull,
  ZERO_ADDRESS,
} from "./model.mjs";
import { assessMarketLiquidity } from "./reserve-value.mjs";

// Only this producer can establish the private handoff. Public JSON fields,
// display symbols, copied rows and cached snapshots cannot create this proof.
const frontierMarketObservations = new WeakMap();
export function getFrontierMarketObservation(row) {
  return frontierMarketObservations.get(row) || null;
}

function captureFrontierMarketObservation(
  row,
  { coin, indexed, result, graphUrl, measurementSources, now },
) {
  const token = coin.token.toLowerCase();
  const supplied = indexed?.token1?.id;
  const native = indexed?.token0?.id;
  if (
    row.chain !== "robinhood" ||
    row.chainId !== 4663 ||
    token === ZERO_ADDRESS ||
    !isPoolId(row.address) ||
    !isAddress(row.hookAddress) ||
    row.hookAddress === ZERO_ADDRESS ||
    (indexed && native?.toLowerCase() !== ZERO_ADDRESS) ||
    (supplied !== undefined &&
      (!isAddress(supplied) || supplied.toLowerCase() !== token)) ||
    !["live", "cached"].includes(row.metricStatus) ||
    !Number.isFinite(Date.parse(row.metricUpdatedAt)) ||
    Date.parse(row.metricUpdatedAt) < 0 ||
    Date.parse(row.metricUpdatedAt) > nowSeconds(now) * 1000 + 60000 ||
    measurementSources.some(
      (source) =>
        !["live", "cached"].includes(source.status) ||
        !Number.isFinite(Date.parse(source.updatedAt)) ||
        Date.parse(source.updatedAt) < 0 ||
        Date.parse(source.updatedAt) > nowSeconds(now) * 1000 + 60000,
    ) ||
    ![row.liquidityUsd, ...Object.values(row.volumeUsd)].every(
      (value) => value === null || (Number.isFinite(value) && value >= 0),
    ) ||
    ![row.liquidityUsd, ...Object.values(row.volumeUsd)].some(
      (value) => Number.isFinite(value) && value >= 0,
    )
  )
    return;
  const identityUrl = indexed ? graphUrl : row.url;
  const provenance = Object.freeze([
    Object.freeze({
      kind: "identity",
      id: indexed ? "frontier-amm-index" : "frontier-market-attribution",
      url: identityUrl,
      status: result.status,
      observedAt: result.updatedAt || null,
    }),
    ...measurementSources.map((source) =>
      Object.freeze({
        kind: "measurement",
        id: source.sourceId,
        url: source.sourceUrl,
        status: source.status,
        observedAt: source.updatedAt || null,
        retrievedAt: source.retrievedAt || source.updatedAt || null,
      }),
    ),
  ]);
  frontierMarketObservations.set(
    row,
    Object.freeze({
      version: 1,
      id: row.id,
      chain: row.chain,
      chainId: row.chainId,
      address: row.address,
      hookAddress: row.hookAddress,
      tokens: Object.freeze([ZERO_ADDRESS, token]),
      metricProvider: "frontier",
      metricUpdatedAt: row.metricUpdatedAt,
      metricStatus: row.metricStatus,
      liquidityUsd: row.liquidityUsd,
      volumeUsd: Object.freeze({ ...row.volumeUsd }),
      source: row.source,
      url: row.url,
      provenance,
    }),
  );
}

// Read-only public sources. A v4 pool ID alone never establishes hook ownership.
export const INITIALIZE_TOPIC =
  "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";
export const UNISWAP_POOL_INFO_URL =
  "https://liquidity.api.uniswap.org/lp/pool_info";
export const METRIC_CHAINS = [
  {
    chainId: 1,
    chain: "ethereum",
    gecko: "eth",
    dex: "uniswap-v4-ethereum",
    explorer: "https://eth.blockscout.com",
    manager: "0x000000000004444c5dc75cB358380D2e3dE08A90",
  },
  {
    chainId: 8453,
    chain: "base",
    gecko: "base",
    dex: "uniswap-v4-base",
    explorer: "https://base.blockscout.com",
    manager: "0x498581fF718922c3f8e6A244956aF099B2652b2b",
    rpc: "https://base.gateway.tenderly.co",
    blockSeconds: 2,
  },
  {
    chainId: 130,
    chain: "unichain",
    gecko: "unichain",
    dex: "uniswap-v4-unichain",
    explorer: "https://unichain.blockscout.com",
    manager: "0x1F98400000000000000000000000000000000004",
  },
];

const iso = (value) => {
  const time = Number(value);
  return Number.isFinite(time) && time > 0 && time <= 253402300799
    ? new Date(time * 1000).toISOString()
    : null;
};
const source = (id, name, url, result, note = "") => ({
  id,
  name,
  url,
  status: result.status,
  updatedAt: result.updatedAt || null,
  note: [note, result.note].filter(Boolean).join(" "),
});
const emptyWindows = () => ({ h1: null, h6: null, h24: null });
const nowSeconds = (now) =>
  Math.floor(
    (now instanceof Date
      ? now.getTime()
      : typeof now === "number"
        ? now
        : Date.parse(now || new Date().toISOString())) / 1000,
  );

// An explicit amount timestamp can make a fetched observation older, never
// younger than the HTTP response's origin evidence. Keep impossible future
// payload clocks visible to the producer's provenance validation.
function frontierMeasurementTime(result, supplied, now) {
  const published = iso(supplied);
  if (published && Date.parse(published) > nowSeconds(now) * 1000 + 60000)
    return published;
  return (
    [published, result.updatedAt]
      .filter(
        (value) =>
          typeof value === "string" && Number.isFinite(Date.parse(value)),
      )
      .sort()[0] || null
  );
}

export function measurementEvidence(records) {
  const present = records.filter(
    (record) => record && record.status !== "unavailable",
  );
  const timestamps = present
    .map((record) => record.updatedAt)
    .filter(
      (value) =>
        typeof value === "string" && Number.isFinite(Date.parse(value)),
    )
    .sort();
  return {
    metricUpdatedAt: timestamps[0] || null,
    metricStatus:
      !present.length || !timestamps.length
        ? "unavailable"
        : present.some((record) => record.status !== "live")
          ? "cached"
          : "live",
  };
}

export function validateGeckoPools(value) {
  if (!value || !Array.isArray(value.data) || value.data.length > 100)
    throw new Error("GeckoTerminal pool response has an unexpected shape");
  return {
    data: value.data.filter(
      (pool) => pool?.type === "pool" && isPoolId(pool.attributes?.address),
    ),
  };
}

export function validateUniswapPools(value, chainId, requestedIds) {
  if (!value || !Array.isArray(value.pools) || value.pools.length > 20)
    throw new Error("Uniswap pool-key response has an unexpected shape");
  const requested = new Set(requestedIds.map((id) => id.toLowerCase()));
  const pools = value.pools.filter(
    (pool) =>
      pool?.poolProtocol === "V4" &&
      pool.chainId === chainId &&
      isPoolId(pool.poolReferenceIdentifier) &&
      requested.has(pool.poolReferenceIdentifier.toLowerCase()) &&
      isAddress(pool.hookAddress),
  );
  const ids = new Set();
  for (const pool of pools) {
    const id = pool.poolReferenceIdentifier.toLowerCase();
    if (ids.has(id)) throw new Error("Uniswap returned ambiguous pool keys");
    ids.add(id);
  }
  return { ...value, pools };
}

export function initializeUrl(chain, poolId) {
  if (!isPoolId(poolId)) throw new Error("Invalid pool ID");
  const url = new URL("/api", chain.explorer);
  url.search = new URLSearchParams({
    module: "logs",
    action: "getLogs",
    fromBlock: "0",
    toBlock: "latest",
    address: chain.manager,
    topic0: INITIALIZE_TOPIC,
    topic1: poolId.toLowerCase(),
    topic0_1_opr: "and",
  }).toString();
  return url.href;
}

export function decodeInitialize(value, manager, poolId) {
  // SourceClient persists validated values. Check provenance on subsequent reads.
  if (
    value?.kind === "initialize-evidence-v1" &&
    value.manager === manager.toLowerCase() &&
    value.poolId === poolId.toLowerCase() &&
    value.topic0 === INITIALIZE_TOPIC &&
    isAddress(value.hookAddress) &&
    Number.isSafeInteger(value.fee) &&
    value.fee >= 0 &&
    value.fee <= 16777215
  )
    return value;
  if (!value || value.status !== "1" || !Array.isArray(value.result))
    throw new Error("No pool initialization event is available");
  const matches = value.result.filter(
    (log) =>
      log?.address?.toLowerCase() === manager.toLowerCase() &&
      log.topics?.[0]?.toLowerCase() === INITIALIZE_TOPIC &&
      log.topics?.[1]?.toLowerCase() === poolId.toLowerCase(),
  );
  if (
    matches.length !== 1 ||
    !/^0x[0-9a-fA-F]{320}$/.test(matches[0].data || "")
  )
    throw new Error(
      "Pool initialization event cannot be unambiguously decoded",
    );
  const log = matches[0];
  const words = log.data.slice(2).match(/.{64}/g);
  if (
    words[2].slice(0, 24) !== "0".repeat(24) ||
    BigInt(`0x${words[0]}`) > 16777215n
  )
    throw new Error("Initialization event has invalid ABI padding");
  const hookAddress = `0x${words[2].slice(-40)}`.toLowerCase();
  if (!isAddress(hookAddress))
    throw new Error("Initialization event returned an invalid hook");
  return {
    kind: "initialize-evidence-v1",
    manager: manager.toLowerCase(),
    poolId: poolId.toLowerCase(),
    topic0: INITIALIZE_TOPIC,
    hookAddress,
    fee: Number(BigInt(`0x${words[0]}`)),
    createdAt: iso(Number.parseInt(log.timeStamp, 16)),
    transactionHash: /^0x[0-9a-fA-F]{64}$/.test(log.transactionHash || "")
      ? log.transactionHash
      : null,
  };
}

async function mapLimited(values, concurrency, mapper) {
  const result = new Array(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= values.length) return;
        result[index] = await mapper(values[index], index);
      }
    }),
  );
  return result;
}

function pacer(gap = 350, signal) {
  let previous = Promise.resolve();
  let startedAt = 0;
  return async () => {
    const wait = previous;
    let release;
    previous = new Promise((resolve) => {
      release = resolve;
    });
    await wait;
    const remaining = startedAt + gap - Date.now();
    if (remaining > 0 && !signal?.aborted)
      await new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, remaining);
        signal?.addEventListener("abort", done, { once: true });
        if (signal?.aborted) done();
      });
    startedAt = Date.now();
    release();
  };
}

export function validateRpcHead(value) {
  if (
    value?.kind === "rpc-head-v1" &&
    Number.isSafeInteger(value.number) &&
    value.number > 0 &&
    Number.isSafeInteger(value.timestamp) &&
    value.timestamp > 0
  )
    return value;
  if (
    value?.error ||
    !/^0x[0-9a-fA-F]+$/.test(value?.result?.number || "") ||
    !/^0x[0-9a-fA-F]+$/.test(value?.result?.timestamp || "")
  )
    throw new Error("RPC latest block is unavailable");
  const number = Number(BigInt(value.result.number));
  const timestamp = Number(BigInt(value.result.timestamp));
  if (!Number.isSafeInteger(number) || !Number.isSafeInteger(timestamp))
    throw new Error("RPC block values are invalid");
  return { kind: "rpc-head-v1", number, timestamp };
}

export function decodeRpcInitialize(value, manager, poolId) {
  if (value?.kind === "initialize-evidence-v1")
    return decodeInitialize(value, manager, poolId);
  if (value?.error || !Array.isArray(value?.result))
    throw new Error("RPC initialization logs are unavailable");
  return decodeInitialize(
    {
      status: "1",
      result: value.result
        .filter((log) => log.removed !== true)
        .map((log) => ({ ...log, timeStamp: log.blockTimestamp })),
    },
    manager,
    poolId,
  );
}

function rpcOptions(method, params, validate, ttlMs = Infinity) {
  return {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    validate,
    timeoutMs: 12000,
    ttlMs,
  };
}

async function rpcInitialize(fetchJson, chain, pool, head) {
  const poolId = pool.attributes.address.toLowerCase();
  const createdAt = Date.parse(pool.attributes.pool_created_at) / 1000;
  if (
    !head?.data ||
    !Number.isFinite(createdAt) ||
    createdAt > head.data.timestamp
  )
    return {
      status: "unavailable",
      updatedAt: null,
      data: null,
      note: "The creation block could not be narrowed.",
    };
  // Cadence only narrows the search. Ownership still requires an exact matching event.
  const estimate =
    head.data.number -
    Math.floor((head.data.timestamp - createdAt) / chain.blockSeconds);
  if (!Number.isSafeInteger(estimate) || estimate < 0)
    return {
      status: "unavailable",
      updatedAt: null,
      data: null,
      note: "The creation block could not be narrowed.",
    };
  const params = [
    {
      address: chain.manager,
      fromBlock: `0x${Math.max(0, estimate - 128).toString(16)}`,
      toBlock: `0x${Math.min(head.data.number, estimate + 128).toString(16)}`,
      topics: [INITIALIZE_TOPIC, poolId],
    },
  ];
  const options = rpcOptions("eth_getLogs", params, (value) =>
    decodeRpcInitialize(value, chain.manager, poolId),
  );
  const result = await fetchJson(
    `initialize-rpc-${chain.chain}-${poolId}`,
    chain.rpc,
    options,
  );
  if (result.data || !chain.rpcFallback) return result;
  return fetchJson(
    `initialize-rpc-fallback-${chain.chain}-${poolId}`,
    chain.rpcFallback,
    options,
  );
}

function aggregateAttribution(results) {
  const available = results.filter(
    (result) => result.status !== "unavailable" && result.data,
  );
  const failures = [
    ...new Set(
      results
        .filter((result) => result.status === "unavailable")
        .map((result) => result.note)
        .filter(Boolean),
    ),
  ].slice(0, 3);
  return {
    status: !available.length
      ? "unavailable"
      : available.some((result) => result.status === "cached")
        ? "cached"
        : "live",
    updatedAt:
      available
        .map((result) => result.updatedAt)
        .filter(Boolean)
        .sort()[0] || null,
    note: `${available.length}/${results.length} observed pool keys resolved from immutable initialization events.${failures.length ? ` Unresolved: ${failures.join("; ")}` : ""}`,
  };
}

async function collectGecko(fetchJson, signal) {
  const pools = [];
  const sources = [];
  const measuredChains = [];
  let totalObservedPools = 0;
  // Sequential chain requests share GeckoTerminal's small public rate budget.
  for (const chain of METRIC_CHAINS) {
    const url = `https://api.geckoterminal.com/api/v2/networks/${chain.gecko}/dexes/${chain.dex}/pools?page=1&include_composition=true`;
    if (signal?.aborted) {
      sources.push(
        source(`gecko-${chain.chain}`, `GeckoTerminal · ${chain.chain}`, url, {
          status: "unavailable",
          updatedAt: null,
          note: "Refresh deadline reached before this chain could be checked.",
        }),
      );
      continue;
    }
    const result = await fetchJson(`gecko-${chain.chain}`, url, {
      ttlMs: 300000,
      respectResponseAge: true,
      timeoutMs: 12000,
      validate: validateGeckoPools,
      headers: { Accept: "application/json;version=20230203" },
    });
    const observed = result.data?.data || [];
    sources.push(
      source(
        `gecko-${chain.chain}`,
        `GeckoTerminal · ${chain.chain}`,
        url,
        result,
        "Public top-pool sample, up to 20 pools per chain. Rolling 1h/6h/24h USD volume; reported pool reserves in USD. Not ecosystem totals.",
      ),
    );
    totalObservedPools += observed.length;
    if (!observed.length) continue;
    measuredChains.push(chain.chain);
    const requestedIds = observed
      .slice(0, 20)
      .map((pool) => pool.attributes.address.toLowerCase());
    const poolInfo = await fetchJson(
      `uniswap-pool-keys-${chain.chain}-${digest(requestedIds.slice().sort())}`,
      UNISWAP_POOL_INFO_URL,
      {
        method: "POST",
        body: JSON.stringify({
          protocol: "V4",
          chainId: chain.chainId,
          poolReferences: requestedIds.map((referenceIdentifier) => ({
            referenceIdentifier,
            chainId: chain.chainId,
            protocol: "V4",
          })),
        }),
        ttlMs: Infinity,
        timeoutMs: 15000,
        validate: (value) =>
          validateUniswapPools(value, chain.chainId, requestedIds),
      },
    );
    const knownPoolKeys = new Map(
      (poolInfo.data?.pools || []).map((pool) => [
        pool.poolReferenceIdentifier.toLowerCase(),
        pool.hookAddress.toLowerCase(),
      ]),
    );
    const needsFallback = requestedIds.some((id) => !knownPoolKeys.has(id));
    const head =
      needsFallback && chain.rpc
        ? await fetchJson(
            `rpc-head-${chain.chain}`,
            chain.rpc,
            rpcOptions(
              "eth_getBlockByNumber",
              ["latest", false],
              validateRpcHead,
              60000,
            ),
          )
        : null;
    const pace = pacer(350, signal);
    const resolved = await mapLimited(
      observed.slice(0, 20),
      3,
      async (pool) => {
        const poolId = pool.attributes.address.toLowerCase();
        if (knownPoolKeys.has(poolId))
          return {
            pool,
            init: {
              ...poolInfo,
              data: {
                hookAddress: knownPoolKeys.get(poolId),
                createdAt: null,
                evidence: "Uniswap pool_info",
              },
            },
          };
        await pace();
        if (signal?.aborted)
          return {
            pool,
            init: {
              status: "unavailable",
              updatedAt: null,
              data: null,
              note: "Refresh deadline reached before attribution could be checked.",
            },
          };
        const initUrl = initializeUrl(chain, poolId);
        const init = chain.rpc
          ? await rpcInitialize(fetchJson, chain, pool, head)
          : await fetchJson(`initialize-${chain.chain}-${poolId}`, initUrl, {
              ttlMs: Infinity,
              timeoutMs: 12000,
              validate: (data) => decodeInitialize(data, chain.manager, poolId),
            });
        return { pool, init };
      },
    );
    const attribution = aggregateAttribution(resolved.map((row) => row.init));
    sources.push(
      source(
        `initialize-${chain.chain}`,
        `Uniswap · ${chain.chain} pool attribution`,
        "https://developers.uniswap.org/docs/api-reference/pool_info",
        attribution,
        "Exact immutable hook address read from Uniswap pool_info. Public initialization-event lookup is used when the API omits a key. Zero-hook and unresolved pools are excluded.",
      ),
    );
    for (const { pool, init } of resolved) {
      if (!init.data?.hookAddress || init.data.hookAddress === ZERO_ADDRESS)
        continue;
      const attr = pool.attributes;
      const poolId = attr.address.toLowerCase();
      pools.push({
        id: `${chain.chain}:${poolId}`,
        chain: chain.chain,
        chainId: chain.chainId,
        address: poolId,
        name: typeof attr.name === "string" ? attr.name : "Unnamed v4 pool",
        hookAddress: init.data.hookAddress,
        projectId: null,
        url: `https://www.geckoterminal.com/${chain.gecko}/pools/${poolId}`,
        source: "GeckoTerminal",
        ...measurementEvidence([result]),
        ...assessMarketLiquidity({ attributes: attr }, "geckoterminal"),
        volumeUsd: Object.fromEntries(
          ["h1", "h6", "h24"].map((window) => [
            window,
            numberOrNull(attr.volume_usd?.[window]),
          ]),
        ),
        createdAt:
          init.data.createdAt ||
          (typeof attr.pool_created_at === "string"
            ? attr.pool_created_at
            : null),
        tokens: [
          pool.relationships?.base_token?.data?.id,
          pool.relationships?.quote_token?.data?.id,
        ]
          .filter((value) => typeof value === "string")
          .map((value) => value.slice(value.indexOf("_") + 1)),
      });
    }
  }
  return { pools, sources, totalObservedPools, measuredChains };
}

function validateFrontierCoins(value) {
  if (
    !value ||
    !Array.isArray(value.data) ||
    !Number.isSafeInteger(value.total) ||
    value.total < 0
  )
    throw new Error("Frontier coin listing has an unexpected shape");
  return {
    ...value,
    data: value.data.filter(
      (coin) =>
        isAddress(coin?.token) && coin.isLPd === true && isPoolId(coin.lp),
    ),
  };
}
function validateFrontierStats(value) {
  const price = numberOrNull(value?.data?.ethPriceUsd);
  if (!price || price > 1000000)
    throw new Error("Frontier USD conversion price is unavailable");
  return value;
}
function validateGraph(value) {
  if (
    !value ||
    value.errors?.length ||
    !value.data ||
    !Array.isArray(value.data.pools) ||
    !Array.isArray(value.data.swaps)
  )
    throw new Error("Frontier AMM index is unavailable");
  if (value.data._meta?.hasIndexingErrors)
    throw new Error("Frontier AMM index reported indexing errors");
  return value;
}

export function frontierVolumeWindows(swaps, poolId, now, usdRate) {
  if (
    !Array.isArray(swaps) ||
    swaps.length >= 1000 ||
    !isPoolId(poolId) ||
    !Number.isFinite(usdRate) ||
    usdRate <= 0
  )
    return emptyWindows();
  const end = nowSeconds(now);
  if (!Number.isSafeInteger(end) || end <= 0) return emptyWindows();
  const matches = [];
  for (const swap of swaps) {
    // An unidentifiable row could belong to this pool: it cannot prove an
    // empty window. A malformed row for a different exact pool stays scoped
    // to that pool, so one bad market does not discard the other markets.
    if (!isPoolId(swap?.pool?.id)) return emptyWindows();
    if (swap.pool.id.toLowerCase() !== poolId.toLowerCase()) continue;
    if (!isAddress(swap.pool.token0?.id)) return emptyWindows();
    if (swap.pool.token0.id.toLowerCase() === ZERO_ADDRESS) matches.push(swap);
  }
  const observations = [];
  for (const swap of matches) {
    // Graph decimal scalars are signed numbers or decimal strings. JavaScript
    // coercion would turn missing amounts into zero and true/[2] into trades.
    const suppliedAmount = swap.amount0;
    const suppliedTime = swap.timestamp;
    if (
      !(
        typeof suppliedAmount === "number" ||
        (typeof suppliedAmount === "string" &&
          /^[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(suppliedAmount))
      ) ||
      !(
        typeof suppliedTime === "number" ||
        (typeof suppliedTime === "string" && /^\d+$/.test(suppliedTime))
      )
    )
      return emptyWindows();
    const amount = Number(suppliedAmount);
    const timestamp = Number(suppliedTime);
    if (
      !Number.isFinite(amount) ||
      !Number.isSafeInteger(timestamp) ||
      timestamp <= 0
    )
      return emptyWindows();
    observations.push({ amount, timestamp });
  }
  return Object.fromEntries(
    [
      ["h1", 3600],
      ["h6", 21600],
      ["h24", 86400],
    ].map(([window, seconds]) => {
      const value = observations
        .filter(
          (swap) => swap.timestamp >= end - seconds && swap.timestamp <= end,
        )
        .reduce((sum, swap) => sum + Math.abs(swap.amount) * usdRate, 0);
      return [window, Number.isFinite(value) ? value : null];
    }),
  );
}

async function collectFrontier(fetchJson, frontierChains, now, signal) {
  const pools = [];
  const sources = [];
  const projectHistories = {};
  const measuredChains = [];
  let totalObservedPools = 0;
  const chain = frontierChains?.find(
    (candidate) =>
      candidate?.id === 4663 && isAddress(candidate.contracts?.univ4?.hook),
  );
  if (!chain)
    return {
      pools,
      sources,
      projectHistories,
      measuredChains,
      totalObservedPools,
    };
  const coinsUrl = "https://api.frontier.fun/coinsPage?limit=100";
  const statsUrl = "https://api.frontier.fun/coinsStats";
  const [coinResult, statsResult] = await Promise.all([
    fetchJson("frontier-coins", coinsUrl, {
      ttlMs: 60000,
      respectResponseAge: true,
      timeoutMs: 10000,
      validate: validateFrontierCoins,
    }),
    fetchJson("frontier-stats", statsUrl, {
      ttlMs: 60000,
      respectResponseAge: true,
      timeoutMs: 10000,
      validate: validateFrontierStats,
    }),
  ]);
  sources.push(
    source(
      "frontier-coins",
      "Frontier · pooled coin markets",
      coinsUrl,
      coinResult,
      "Only isLPd=true markets are included. Curve-only coins are excluded. At most the first 100 coin rows.",
    ),
  );
  sources.push(
    source(
      "frontier-stats",
      "Frontier · ETH/USD conversion",
      statsUrl,
      statsResult,
      "AMM native-ETH amounts are converted using the current ETH/USD snapshot, not historical execution prices. Curve volume is never counted as v4 volume.",
    ),
  );
  const coins = coinResult.data?.data || [];
  const usdRate = numberOrNull(statsResult.data?.data?.ethPriceUsd);
  if (!coins.length)
    return {
      pools,
      sources,
      projectHistories,
      measuredChains,
      totalObservedPools,
    };
  totalObservedPools += coins.length;
  measuredChains.push(chain.verboseId || "robinhood");
  const graphUrl = chain.subgraphs?.ammV4?.url;
  let graphResult = {
    status: "unavailable",
    updatedAt: null,
    note: "A supported public AMM index was not configured.",
  };
  if (
    typeof graphUrl === "string" &&
    graphUrl.startsWith("https://api.goldsky.com/api/public/") &&
    new URL(graphUrl).hostname === "api.goldsky.com"
  ) {
    const ids = coins.map((coin) => `"${coin.lp.toLowerCase()}"`).join(",");
    const cutoff = nowSeconds(now) - 86400;
    const query = `{ _meta { block { number timestamp } hasIndexingErrors } pools(first:1000,where:{id_in:[${ids}]}) { id hooks createdAtTimestamp liquidity totalValueLockedToken0 totalValueLockedToken1 token0Price token0 { id symbol decimals } token1 { id symbol decimals } poolDayData(first:32,orderBy:date,orderDirection:desc) { date volumeToken0 } } swaps(first:1000,orderBy:timestamp,orderDirection:desc,where:{timestamp_gte:"${cutoff}",pool_in:[${ids}]}) { id timestamp amount0 pool { id token0 { id } } } }`;
    graphResult = await fetchJson("frontier-amm-index", graphUrl, {
      ttlMs: 60000,
      timeoutMs: 15000,
      method: "POST",
      body: JSON.stringify({ query }),
      validate: validateGraph,
    });
  }
  const indexedPools = new Map(
    (graphResult.data?.data?.pools || [])
      .filter((pool) => isPoolId(pool?.id) && isAddress(pool.hooks))
      .map((pool) => [pool.id.toLowerCase(), pool]),
  );
  const indexedAt = Number(graphResult.data?.data?._meta?.block?.timestamp);
  const end = nowSeconds(now);
  // A successful HTTP retrieval does not establish when indexed reserves were observed.
  // Immutable hook keys can still be used if the index omits or corrupts its block time.
  const validIndexTime =
    Number.isSafeInteger(indexedAt) && indexedAt > 0 && indexedAt <= end + 60;
  // An empty result is zero only when the index has actually reached this window.
  const recentSwaps =
    validIndexTime && indexedAt >= end - 300
      ? graphResult.data.data.swaps
      : undefined;
  const indexedEvidence = validIndexTime
    ? {
        ...graphResult,
        updatedAt: iso(indexedAt),
        status: indexedAt < end - 300 ? "cached" : graphResult.status,
      }
    : {
        ...graphResult,
        updatedAt: null,
        status: "unavailable",
        note: "The index block timestamp is missing, invalid or future dated. Reserve amounts and subdaily swaps are unavailable; immutable hook keys remain usable for attribution.",
      };
  if (
    typeof graphUrl === "string" &&
    graphUrl.startsWith("https://api.goldsky.com/api/public/") &&
    new URL(graphUrl).hostname === "api.goldsky.com"
  )
    sources.push(
      source(
        "frontier-amm-index",
        "Goldsky · Frontier AMM index",
        graphUrl,
        graphResult.data ? indexedEvidence : graphResult,
        "Pool hooks, core reserves and native-ETH swap amounts. USD fields in this index have no price feed and are not used. Reserve valuation excludes hook-held assets.",
      ),
    );
  const configs = await mapLimited(coins, 3, async (coin) => {
    const poolId = coin.lp.toLowerCase();
    const indexed = indexedPools.get(poolId);
    if (indexed && indexed.token0?.id?.toLowerCase() === ZERO_ADDRESS)
      return {
        coin,
        indexed,
        hookAddress: indexed.hooks.toLowerCase(),
        result: graphResult,
      };
    if (signal?.aborted)
      return {
        coin,
        indexed: null,
        hookAddress: null,
        result: {
          status: "unavailable",
          updatedAt: null,
          note: "Refresh deadline reached before market attribution could be checked.",
        },
      };
    const url = `https://api.frontier.fun/coins/${coin.token}/extensions`;
    const config = await fetchJson(
      `frontier-config-${coin.token.toLowerCase()}`,
      url,
      {
        ttlMs: 300000,
        timeoutMs: 10000,
        validate: (value) => {
          if (
            value?.chainId !== 4663 ||
            value.poolId?.toLowerCase() !== poolId ||
            !isAddress(value.hook)
          )
            throw new Error("Frontier market hook could not be verified");
          return value;
        },
      },
    );
    return {
      coin,
      indexed: null,
      hookAddress: config.data?.hook?.toLowerCase(),
      result: config,
    };
  });
  if (configs.some((config) => !config.indexed))
    sources.push(
      source(
        "frontier-market-attribution",
        "Frontier · market configurations",
        "https://docs.frontier.fun/developers/api-and-live-feed/#get-coinsaddressextensions",
        aggregateAttribution(configs.map((config) => config.result)),
        "Pool-to-hook addresses are read from the market configuration API when the AMM index is unavailable.",
      ),
    );
  const dayTotals = new Map();
  const publishedHooks = new Set(
    [chain.contracts.univ4.hook, ...(chain.contracts.univ4.legacyHooks || [])]
      .filter(isAddress)
      .map((address) => address.toLowerCase()),
  );
  for (const { coin, indexed, hookAddress, result } of configs) {
    if (!hookAddress || !publishedHooks.has(hookAddress)) continue;
    const poolId = coin.lp.toLowerCase();
    let volumeUsd = emptyWindows();
    let liquidityUsd = null;
    const measurementSources = [];
    if (usdRate) {
      if (recentSwaps) {
        volumeUsd = frontierVolumeWindows(recentSwaps, poolId, now, usdRate);
        if (Object.values(volumeUsd).some((value) => value !== null))
          measurementSources.push({
            ...indexedEvidence,
            sourceId: "frontier-amm-index",
            sourceUrl: graphUrl,
            retrievedAt: graphResult.updatedAt,
          });
      }
      // A documented AMM-only 24h field is a fallback; a mixed curve+AMM field is never used.
      if (volumeUsd.h24 === null && numberOrNull(coin.ammVolume24h) !== null) {
        volumeUsd.h24 = Number(coin.ammVolume24h) * usdRate;
        measurementSources.push({
          ...coinResult,
          sourceId: "frontier-coins",
          sourceUrl: coinsUrl,
          retrievedAt: coinResult.updatedAt,
          updatedAt: frontierMeasurementTime(
            coinResult,
            coin.poolVolume24hAt || coin.volume24hAt,
            now,
          ),
        });
      }
      if (indexed && validIndexTime) {
        const nativeReserve = numberOrNull(indexed.totalValueLockedToken0);
        const coinReserve = numberOrNull(indexed.totalValueLockedToken1);
        const coinNativePrice = numberOrNull(indexed.token0Price);
        if (
          nativeReserve !== null &&
          coinReserve !== null &&
          coinNativePrice !== null
        ) {
          const value =
            (nativeReserve + coinReserve * coinNativePrice) * usdRate;
          if (Number.isFinite(value)) {
            liquidityUsd = value;
            measurementSources.push({
              ...indexedEvidence,
              sourceId: "frontier-amm-index",
              sourceUrl: graphUrl,
              retrievedAt: graphResult.updatedAt,
            });
          }
        }
        for (const day of indexed.poolDayData || [])
          if (
            Number.isSafeInteger(day.date) &&
            numberOrNull(day.volumeToken0) !== null
          )
            dayTotals.set(
              day.date * 1000,
              (dayTotals.get(day.date * 1000) || 0) +
                Number(day.volumeToken0) * usdRate,
            );
      }
      if (measurementSources.length)
        measurementSources.push({
          ...statsResult,
          sourceId: "frontier-stats",
          sourceUrl: statsUrl,
          retrievedAt: statsResult.updatedAt,
          updatedAt: frontierMeasurementTime(
            statsResult,
            statsResult.data?.data?.ethPriceComputedAt,
            now,
          ),
        });
    }
    const row = {
      id: `robinhood:${poolId}`,
      chain: chain.verboseId || "robinhood",
      chainId: chain.id,
      address: poolId,
      name: `${coin.symbol || coin.name} / ETH`,
      hookAddress,
      projectId: null,
      url: `https://api.frontier.fun/coins/${coin.token}/extensions`,
      source:
        "Frontier AMM index/configuration; USD estimates at current ETH/USD",
      ...measurementEvidence(measurementSources),
      liquidityUsd: Number.isFinite(liquidityUsd) ? liquidityUsd : null,
      volumeUsd: Object.freeze(volumeUsd),
      createdAt: iso(
        indexed?.createdAtTimestamp ||
          coin.graduatedAt ||
          (coin.launchKind === "instant" ? coin.createdTimestamp : null),
      ),
      tokens: Object.freeze([
        "ETH",
        typeof coin.symbol === "string" ? coin.symbol : coin.token,
      ]),
    };
    captureFrontierMarketObservation(row, {
      coin,
      indexed,
      result,
      graphUrl,
      measurementSources,
      now,
    });
    pools.push(Object.freeze(row));
  }
  if (dayTotals.size)
    projectHistories.frontier = [...dayTotals.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([timestamp, value]) => ({ timestamp, value }));
  return {
    pools,
    sources,
    projectHistories,
    measuredChains,
    totalObservedPools,
  };
}

/** Bounded Frontier-only refresh; it shares the same private evidence producer. */
export async function collectFrontierMetrics({
  fetchJson,
  frontierChains = [],
  now = Date.now(),
  signal,
}) {
  return collectFrontier(fetchJson, frontierChains, now, signal);
}

export async function collectMetrics({
  fetchJson,
  frontierChains = [],
  now = Date.now(),
  signal,
}) {
  const [gecko, frontier] = await Promise.all([
    collectGecko(fetchJson, signal),
    collectFrontier(fetchJson, frontierChains, now, signal),
  ]);
  return {
    pools: [...gecko.pools, ...frontier.pools],
    sources: [...gecko.sources, ...frontier.sources],
    measuredChains: [
      ...new Set([...gecko.measuredChains, ...frontier.measuredChains]),
    ],
    totalObservedPools: gecko.totalObservedPools + frontier.totalObservedPools,
    projectHistories: frontier.projectHistories,
    history: [],
    notes: [
      "GeckoTerminal covers a top-pool sample on Ethereum, Base and Unichain; it is not a complete pool census. Exact hook addresses come from Uniswap pool_info, with initialization-event fallback.",
      "Frontier coverage is limited to pooled coin markets; USD values use the current ETH price. Native ETH AMM swaps and core reserves are used; bonding curve trades and hook-held assets are excluded.",
    ],
  };
}
