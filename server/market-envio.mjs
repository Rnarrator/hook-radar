import { isAddress, isPoolId, ZERO_ADDRESS } from "./model.mjs";
import {
  assessEnvioLiquidity,
  ENVIO_RESERVE_EVIDENCE_VERSION,
} from "./reserve-value.mjs";
import { envioQuoteCoin, ENVIO_QUOTE_ORIGIN } from "./market-envio-prices.mjs";

// Public consumer of the Envio indexer linked by Uniswap's community tooling
// documentation. Its cumulative volume is deliberately not a rolling window.
export const ENVIO_MARKET_ORIGIN = "https://www.v4.xyz";
export const ENVIO_MARKET_SOURCE =
  "https://developers.uniswap.org/docs/community/tooling/v4-community-indexer";
const amount = (value) => {
  if (
    typeof value !== "string" ||
    !/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)
  )
    return null;
  const number = Number(value);
  if (number === 0 && !/^0+(?:\.0+)?(?:e[+-]?\d+)?$/i.test(value)) return null;
  return Number.isFinite(number) && number >= 0 ? number : null;
};
const integer = (value) => Number.isSafeInteger(value) && value >= 0;

export function validateEnvioHeads(value, chains) {
  if (
    !Array.isArray(value?.PoolManager) ||
    value.PoolManager.length > 50 ||
    !Array.isArray(value?.chain_metadata) ||
    value.chain_metadata.length > 50
  )
    throw new Error("Envio indexer heads are unavailable");
  const heads = [];
  for (const chain of chains) {
    const managers = value.PoolManager.filter(
      (row) => row?.chainId === String(chain.chainId),
    );
    const metadata = value.chain_metadata.filter(
      (row) => row?.chain_id === chain.chainId,
    );
    if (!managers.length || !metadata.length) continue;
    if (managers.length !== 1 || metadata.length !== 1)
      throw new Error("Envio indexer returned ambiguous network identities");
    if (
      typeof managers[0].id !== "string" ||
      managers[0].id.toLowerCase() !==
        `${chain.chainId}_${chain.manager.toLowerCase()}` ||
      !integer(metadata[0].latest_processed_block)
    )
      continue;
    heads.push({
      chain: chain.chain,
      chainId: chain.chainId,
      block: metadata[0].latest_processed_block,
    });
  }
  return { heads };
}

export function validateEnvioPools(value, chain) {
  if (!Array.isArray(value?.Pool) || value.Pool.length > 100)
    throw new Error("Envio pool page exceeded its published bound");
  const seen = new Set();
  const pools = [];
  for (const row of value.Pool) {
    const prefix = `${chain.chainId}_`;
    const id =
      typeof row?.id === "string" && row.id.startsWith(prefix)
        ? row.id.slice(prefix.length).toLowerCase()
        : null;
    const tokens = [row?.token0, row?.token1].map((token) =>
      typeof token === "string" && token.startsWith(prefix)
        ? token.slice(prefix.length).toLowerCase()
        : null,
    );
    const usd = amount(row?.totalValueLockedUSD);
    if (
      row?.chainId !== String(chain.chainId) ||
      !isPoolId(id) ||
      !isAddress(row.hooks) ||
      row.hooks.toLowerCase() === ZERO_ADDRESS ||
      !tokens.every(isAddress) ||
      tokens[0] === tokens[1]
    )
      continue;
    if (seen.has(id))
      throw new Error("Envio returned ambiguous pool identities");
    seen.add(id);
    pools.push({
      address: id,
      hookAddress: row.hooks.toLowerCase(),
      tokens,
      name:
        typeof row.name === "string"
          ? row.name.slice(0, 180)
          : "Indexed v4 pool",
      // Untrusted stored USD is audit evidence, never an eligibility gate or
      // a reserve amount. Zero/missing totals can still have real balances
      // that the independent component-quote route can qualify.
      liquidityUsd: usd,
    });
  }
  return { pools };
}

export function validateEnvioBlock(value, chain, block) {
  if (!Array.isArray(value) || value.length !== 3)
    throw new Error("Envio head verification returned an unexpected RPC batch");
  const results = new Map();
  for (const row of value) {
    if (
      !row ||
      row.jsonrpc !== "2.0" ||
      ![1, 2, 3].includes(row.id) ||
      row.error ||
      results.has(row.id)
    )
      throw new Error("Envio head verification returned an invalid RPC result");
    results.set(row.id, row.result);
  }
  const quantity = (raw) =>
    typeof raw === "string" &&
    /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(raw) &&
    integer(Number(raw))
      ? Number(raw)
      : null;
  const header = results.get(3);
  const latest = quantity(results.get(2));
  const timestamp = quantity(header?.timestamp);
  if (
    quantity(results.get(1)) !== chain.chainId ||
    latest === null ||
    latest < block ||
    quantity(header?.number) !== block ||
    timestamp === null ||
    !isPoolId(header?.hash)
  )
    throw new Error(
      "Envio index height could not be verified on the canonical chain",
    );
  return { number: block, hash: header.hash.toLowerCase(), timestamp };
}

export function envioObservationTime({
  head,
  network,
  headsResult,
  poolsResult,
  blockResult,
  now,
  ttlMs,
}) {
  if (
    !head ||
    !network ||
    !integer(head.block) ||
    head.chain !== network.chain ||
    head.chainId !== network.chainId ||
    network.status !== "complete" ||
    !integer(network.scannedToBlock) ||
    !integer(network.targetBlock) ||
    network.scannedToBlock < network.targetBlock ||
    blockResult?.data?.number !== head.block
  )
    return null;
  const clocks = [
    headsResult.updatedAt,
    poolsResult.updatedAt,
    blockResult.updatedAt,
  ].map(Date.parse);
  clocks.push(blockResult.data.timestamp * 1000);
  if (
    clocks.some(
      (clock) => !Number.isFinite(clock) || clock < 0 || clock > now + 60000,
    )
  )
    return null;
  const observedAt = Math.min(...clocks, now);
  return {
    // Independent indexers need not publish the same latest block. The RPC
    // timestamp, not their relative progress, determines observation age.
    // Pool normalization separately proves that the pool existed by this head.
    sourceBlock: head.block,
    updatedAt: new Date(observedAt).toISOString(),
    status:
      headsResult.status === "live" &&
      poolsResult.status === "live" &&
      blockResult.status === "live" &&
      now - observedAt < ttlMs
        ? "live"
        : "cached",
  };
}

export function normalizeEnvioPool(row, chain, structural, evidence) {
  if (
    !structural ||
    structural.chain !== chain.chain ||
    structural.chainId !== chain.chainId ||
    !integer(evidence?.sourceBlock) ||
    !integer(structural.creationBlock) ||
    structural.creationBlock > evidence.sourceBlock ||
    structural.address?.toLowerCase() !== row.address ||
    structural.hookAddress?.toLowerCase() !== row.hookAddress ||
    structural.tokens?.length !== 2 ||
    !structural.tokens.every(
      (token, index) =>
        isAddress(token) && token.toLowerCase() === row.tokens[index],
    )
  )
    return null;
  return Object.freeze({
    id: `${chain.chain}:${row.address}`,
    chain: chain.chain,
    chainId: chain.chainId,
    address: row.address,
    hookAddress: row.hookAddress,
    projectId: null,
    name: row.name,
    url: `${ENVIO_MARKET_ORIGIN}/pool/${chain.chainId}_${row.address}`,
    source: "Envio v4 indexer",
    ...assessEnvioLiquidity(row),
    volumeUsd: Object.freeze({ h1: null, h6: null, h24: null }),
    tokens: Object.freeze([...row.tokens]),
    createdAt: structural.createdAt || null,
    metricUpdatedAt: evidence.updatedAt,
    metricStatus: evidence.status,
    metricProvider: "envio",
  });
}

export function qualifyEnvioPool(pool, detailResult, quoteResult, now, ttlMs) {
  if (!detailResult?.data || !quoteResult?.data) return pool;
  const components = pool.tokens.map((token, index) => {
    const balance = detailResult.data.balances[index];
    const coin = envioQuoteCoin(pool.chain, token);
    const quote = quoteResult.data.quotes[coin];
    return {
      token,
      balance,
      ...(balance > 0 && quote
        ? {
            coin,
            priceUsd: quote.priceUsd,
            ...(quote.provider === "coingecko"
              ? {
                  quoteProvider: "coingecko",
                  quoteChainId: quote.chainId,
                  quotePlatform: quote.platform,
                  quoteAddress: quote.address,
                }
              : { confidence: quote.confidence }),
            quoteUpdatedAt: quote.updatedAt,
            quoteResponseAt: quote.responseAt || quoteResult.updatedAt,
            source:
              quote.source || `${ENVIO_QUOTE_ORIGIN}/prices/current/${coin}`,
          }
        : {}),
    };
  });
  const clocks = [
    pool.metricUpdatedAt,
    detailResult.updatedAt,
    ...components
      .filter((c) => c.balance > 0)
      .flatMap((c) => [c.quoteUpdatedAt, c.quoteResponseAt]),
  ].map(Date.parse);
  if (!components.some((component) => component.balance > 0)) return pool;
  if (clocks.some((c) => !Number.isFinite(c) || c < 0 || c > now + 60000))
    return pool;
  const metricUpdatedAt = new Date(Math.min(...clocks)).toISOString();
  const candidate = {
    ...pool,
    metricUpdatedAt,
    liquidityEvidence: {
      version: ENVIO_RESERVE_EVIDENCE_VERSION,
      provider: "envio",
      qualification: "component-quotes",
      reportedUsd: pool.liquidityEvidence?.reportedUsd ?? null,
      indexObservedAt: pool.metricUpdatedAt,
      balanceObservedAt: detailResult.updatedAt,
      quoteResponseAt: new Date(
        Math.min(
          ...components
            .filter((c) => c.balance > 0)
            .map((c) => Date.parse(c.quoteResponseAt)),
        ),
      ).toISOString(),
      components,
    },
  };
  const assessment = assessEnvioLiquidity(candidate, now);
  if (assessment.liquidityStatus !== "reported") return pool;
  return Object.freeze({
    ...candidate,
    ...assessment,
    metricStatus:
      pool.metricStatus === "live" &&
      detailResult.status === "live" &&
      pool.tokens.every(
        (token, index) =>
          detailResult.data.balances[index] === 0 ||
          (quoteResult.data.quotes[envioQuoteCoin(pool.chain, token)]
            ?.responseStatus || quoteResult.status) === "live",
      ) &&
      now - Date.parse(metricUpdatedAt) < ttlMs
        ? "live"
        : "cached",
  });
}
