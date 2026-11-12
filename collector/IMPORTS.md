# Files outside `collector/` that the collector imports

Packaging copies exactly these (plus `collector/`, `state/` and `public/data/`).
The list is the transitive closure of the imports of `collector/run.mjs`,
`collector/export-seed.mjs`, `collector/export-priority.mjs` and `collector/tools/*.mjs`. It is computed, not
guessed: `node collector/tools/imports.mjs` prints it, `node collector/tools/imports.mjs --check`
compares it with this file, and `tests/collector-imports.test.mjs` fails when the
two differ. When another change adds or removes an import, regenerate with the
first command and update the lines below.

Several of these are Node-importable TypeScript (`.ts`) modules; Node 24 runs
them directly (type stripping), so no build step is involved.

## Imported directly by the collector

- `server/model.mjs`: `createDirectory`, `attributePools`, `applyMetrics`, the registry URLs and validators, address and pool-id checks.
- `server/analytics-overview.mjs`: `analyticsOverviewAsync` and `analyticsOverviewJson`, which build and bound the overview files.
- `server/market-chains.mjs`: the verified Uniswap v4 networks (manager, GeckoTerminal slug and DEX id).
- `server/market-discovery.mjs`: the GeckoTerminal top-pools URL and page validator.
- `server/market-envio.mjs`: `validateEnvioPools`, the v4.xyz pool-list validator.
- `server/providers.mjs`: `collectFrontierMetrics` and `getFrontierMarketObservation`, the live app's own code for Frontier's pool figures, run unchanged by `collector/providers/frontier.mjs`. The module is stateless and imports only `model.mjs` and `reserve-value.mjs`; its GeckoTerminal and Uniswap helpers are imported with it and never called by the collector.
- `server/reserve-value.mjs`: `assessMarketLiquidity`, the reserve valuation rules.
- `server/source-json.mjs`: JSON parsing that refuses a nonzero number rounded to zero.
- `shared/daily-volume.ts`: the 7D and 30D file's shape and run rules (`validateDailyShape`, `dailyRunProblem`) and the UTC day arithmetic; the page and the data gate read the same module.
- `shared/market-freshness.ts`: the five-minute qualification, `aggregateCurrentMarkets`, `marketMeasurementState`.
- `shared/analytics-overview.ts`: the overview envelope validators.
- `src/model.ts`: `isSnapshot`, the validator the client applies to a snapshot.

## Imported by those modules

- `server/binary-key-index.mjs`: via `census-packed-store.mjs`.
- `server/census-hook-directory.mjs`: via `model.mjs`.
- `server/census-limits.mjs`: via `census-packed-store.mjs`.
- `server/census-packed-store.mjs`: via `census-hook-directory.mjs`.
- `server/cooperative-turn.mjs`: via `cooperative.mjs`.
- `server/cooperative.mjs`: via `model.mjs` and `analytics-overview.mjs`.
- `server/market-coingecko-prices.mjs`: via `reserve-value.mjs` (imported, not called: this edition does not use CoinGecko prices).
- `server/market-envio-prices.mjs`: via `market-envio.mjs` and `reserve-value.mjs` (imported, not called: this edition does not use DefiLlama prices).
- `shared/analytics-contributions.ts`: via `shared/analytics-overview.ts`.
- `shared/directory.ts`: via `src/model.ts`.
- `shared/indexing.ts`: via `shared/analytics-contributions.ts` and `src/analytics.ts`.
- `shared/launchpad-records-additional.ts`: via `shared/launchpad-registry.ts`.
- `shared/launchpad-records-core.ts`: via `shared/launchpad-registry.ts`.
- `shared/launchpad-records-wave2.ts`: via `shared/launchpad-registry.ts`.
- `shared/launchpad-registry.ts`: via `collector/export-priority.mjs`, the one-time export of the priority list (the exact hooks the reviewed launchpad platforms publish). A collection run does not use it.
- `shared/launchpad-types.ts`: via `shared/launchpad-registry.ts`.
- `shared/market-coverage.ts`: via `src/model.ts`.
- `shared/official-hooks.ts`: via `model.mjs`.
- `shared/pool-key.ts`: via `src/model.ts`.
- `shared/published-platform-hooks.ts`: via `model.mjs` and `src/model.ts`.
- `shared/types.ts`: types, erased at run time, but imported by several of the above.
- `src/analytics-chart-data.ts`: via `server/analytics-overview.mjs`.
- `src/analytics.ts`: via `server/analytics-overview.mjs`.
- `src/edition.ts`: via `src/model.ts` and `src/analytics.ts`; inert in Node (no bundler flag, the visitor clock is not read).
- `src/pool-search.ts`: via `src/model.ts`; the page's search by token, pair and pool, plain text matching that the collector does not call.

## Used only by the tests

These are not needed to run the collector. `tests/collector-providers.test.mjs`
compares the collector's acceptance rules with the live collector's own when the
live app's market collector (and what it imports) is present, and skips those
checks when it is not, so a packaged copy without the full server still passes.

- Test-only: the live app's market collector and everything it imports. It is
  not part of this repository.
