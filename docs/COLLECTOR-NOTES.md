# Collector notes

The collector is what makes the Auto Snapshot edition refresh by itself. It is a
Node 24 program (`collector/`, ES modules, no new dependencies) that a scheduled
job runs about every hour when GitHub starts it. It reads public data services, builds the data files
the page loads (`public/data/*.json`), and updates a small amount of committed
state (`state/`). It never runs on a visitor's machine and the site never calls
a data service.

This file is the reference for people who run, review or package it. The
contract it follows is the live project's design contract for this edition,
which is not part of this repository; the numbers are in
`collector/config.mjs` and are pinned by `tests/collector-contract.test.mjs`.

## What a run does

`node collector/run.mjs`

1. **Registry.** Fetch the Uniswap hooklist and the Uniswap chain registry
   (GitHub raw files) and Frontier's public deployment configuration, once each.
   If a fetch fails the last good copy in `state/registry.json` is used and the
   source is reported as cached with its own time. The directory (projects,
   deployments, chains) is then built by the project's own `createDirectory`.
2. **Discovery (slow and polite).** The Snapshot workflow starts a run that looks for new pools at most once in each three-hour block of the UTC day (the first collecting run that finds the last snapshot saved in an earlier block); the runs between only measure the pools already known (`COLLECTOR_MAX_DISCOVERY=0`, below). A snapshot made without looking says so: its GeckoTerminal source reads "pages read: 0; this run did not look for new pools" and it has no v4.xyz source. In a run that looks, for each of the 20 networks with a verified
   v4 PoolManager and a GeckoTerminal v4 DEX:
   - one GeckoTerminal top-pools page (`sort=h24_volume_usd_desc`), at least
     12 s after the previous GeckoTerminal request. The page number follows the
     three-hour block of the UTC day the run starts in (1 to 5), so successive
     discovery runs walk down the ranking;
   - one v4.xyz indexer pool list (`/api/pools?chainId=`), at least 5 s apart,
     for hook identities in bulk;
   - pool ids from the GeckoTerminal page that are in neither `state/pools.json`
     nor `state/hookless.json` are resolved through the indexer's exact-pool
     endpoint (`/api/pool/{chainId}_{poolId}`), at most 40 per run. The 40 are
     shared equally between the 20 networks (two each). The pages arrive one
     network at a time, so each network is served its share as its page comes
     in and cannot spend what a later network is owed; the remainder of an uneven
     split goes to a different set of networks each run (it follows the page
     number), and a share a network cannot use (no new candidate, or its page
     failed) is handed out afterwards, one lookup per network in turn. A pool the
     indexer says has the zero hook goes to `state/hookless.json` and is never
     looked up again. A pool the indexer cannot answer is simply not added.
   Discovery never produces a measurement. A newly found pool is added to state
   and priced by the burst below. It also records what the indexer's pool name
   says about the hook's LP fee (see "Dynamic LP fees" below).
   Discovery has its own time limit, `DISCOVERY_BUDGET_MS` (15 minutes from the
   start of the run): no discovery request starts after it, a wait for the
   provider's gap or a `Retry-After` included. Full-size discovery (20 pages, 20
   lists, 40 lookups) took about ten minutes in the real run of 28 October 2026
   (`collectionStartedAt` to `burstStartedAt` in its `status.json`), so the limit
   only cuts a run in which a provider is slow or keeps asking to be waited for
   (an indexer that answers every list with `Retry-After: 110` would otherwise
   stretch the simulated run of `tests/edition-w3-collector.test.mjs`, 20 lists,
   to 2,099 s, 35 minutes of the job's 45). What it cuts
   is read again by the next run, and `counts.discovery.cutShort` in
   `status.json` says it happened.
3. **Measurement burst.** The pools in state are grouped per network and sent to
   DEX Screener as exact-id batches of 30 (`/latest/dex/pairs/{network}/{id,id,...}`),
   at least 400 ms between request starts. Which pools: the **priority list**
   (`state/priority.json`, below) first, then the other seeded pools (at most 8,000
   seeded pools in all, the priority list among them, most recently seen first),
   then the pools discovery found, in what is left of 8,500 and at most 500. A
   newly discovered pool therefore never pushes a seeded pool out of the burst
   (all seeded pools share one `lastSeen` at first, so a single cut by recency
   would drop them in id order). The priority list takes places inside the 8,000,
   so the plan is no larger and a run no longer: it displaces the seeded pools that
   went longest unanswered. A listed pool the state does not hold yet is added to
   it (source `census`, first and last seen when the list was exported) and kept
   from the first run that follows. Rows are accepted only under the live collector's
   rules (the pair address is a requested id, `dexId` is `uniswap`, labels, if
   any, include `v4`, the two currencies agree with the identity we hold). Ids
   not returned are unresolved, never zero. Right after, at most six
   GeckoTerminal `/pools/multi/` requests (up to 30 ids each, 180 in all) try the
   unresolved pools, at least 12 s apart, under the same rules. Priority-list
   pools GeckoTerminal measured last time come first, then the rest of the
   priority list, then other pools GeckoTerminal measured last time (the live app's
   GeckoTerminal-measured pools carry that hint from the seed), then the plan's
   order (the largest network's unresolved pools in id order). A pool is taken only
   when it fits one of the six requests: a network with no open batch once the
   limit is reached gets none, so no request goes to a few low-ranked pools while
   higher-ranked ones wait. The cap was three; it is six because the pools of
   platforms' own hooks that DEX Screener cannot price (it does not index Zora or
   X Layer, and returns nothing for many Arbitrum, Polygon and Monad pools) come
   first, and each request is 12 s: the six end about 72 s after the DEX Screener
   batches do.
   A pool measured by DEX Screener is never also taken from GeckoTerminal, and
   two providers' figures for one pool are never combined. A row that carries no
   figure at all (no liquidity and no volume in any window, every one null) is an
   answer and not a measurement: the pool counts as checked and as missing, it is
   not published, and every count in `status.json` agrees with the pools the
   snapshot holds. A measured zero is a figure and is kept.
   The DEX Screener batches go breadth-first: one batch for each network in turn,
   the largest network first, then the next batch for each. A burst that runs out
   of time, or is stopped, thins every network instead of leaving the ones at
   the end of the list unasked. A network whose batches fail five times in a row
   is left for the next run, and an HTTP 400 as a network's first answer still
   skips the rest of that network (below). DEX Screener answers
   HTTP 400 for a network it does not index: when that is its first answer for a
   network, the network's other batches are not sent, the network is recorded
   (below), and its pools stay unresolved for the fallback to consider like any
   other unresolved pool.
   **Frontier's own figures.** After the batches and the fallback, one more step
   (three requests, `collector/providers/frontier.mjs`) reads Frontier's pooled
   coin markets (`/coinsPage?limit=100`, only `isLPd` markets, at most the first 100
   rows), its statistics (`/coinsStats`, for the ETH/USD rate) and, with the pool
   ids from the listing, one POST to the public AMM index that Frontier's
   configuration names (`subgraphs.ammV4`, on `api.goldsky.com`). The reading is the
   live app's own: `collectFrontierMetrics` in `server/providers.mjs` is imported
   and run unchanged, over a `fetchJson` that goes through the collector's paced
   client (host-locked, one second apart, size limits, a truthful User-Agent). What
   it produces is what the live app's Frontier rows are: the 24h volume of a pool's
   native-ETH swaps (the index's swaps for the 1h, 6h and 24h windows when the
   index head is under five minutes old and fewer than 1,000 swaps came back;
   otherwise the listing's AMM-only 24h volume, with the 1h and 6h windows
   unavailable), core reserves from the index (the hook's own holdings excluded),
   both at the statistics' current ETH/USD rate, each pool's measurement time the
   oldest of its sources' times. Bonding-curve volume and curve ETH are never
   counted. Each row has `metricProvider: "frontier"`, the live source label
   ("Frontier AMM index/configuration; USD estimates at current ETH/USD") and the
   live evidence of each figure (`metricProvenance`). A pool the state knows keeps
   its name and creation time and cannot be moved to another hook or other
   currencies (the row is left out and counted). A pool the state does not know
   is taken on the index's word for its hook address, checked against Frontier's
   published hook list: the edition has no census for a pool newer than its
   export, so it cannot check the pool's identity further. This is a weaker check
   than the live app's, which applies a Frontier row only to a pool already in its
   snapshot and requires the row to agree with its PoolManager census (the pool
   id, hook and currencies). The hook address is still an exact on-chain address,
   never a name, and attributing the pool to a project still needs the registry's
   own evidence. Where DEX Screener or GeckoTerminal
   measured the same pool, the newer measurement replaces the older whole, as in
   the live app, and the two are never combined; `counts.frontier` says how many
   rows were supplied, added, replaced an older row or were kept from another
   provider. The step never fails the run: a source that does not answer, is
   refused (a 429 or 403 stops that host for the run), is too large or invalid is
   named `unavailable` in `sources` with the reason, and the pools of Frontier's hooks
   keep the figures the other providers returned. The live app's fallback, one
   configuration request per coin when the index is down, is not made: the
   edition would pay up to ten requests for what DEX Screener already returns. The
   step does not start later than 240 s into the burst (`FRONTIER_LATEST_START_MS`),
   which keeps its worst case (10 s, 1 s and 10 s for the first two reads, 15 s for
   the index) inside the five minutes; then it is skipped and said so. The
   snapshot's time is taken after it.
4. **Daily volume (7D and 30D).** The last step of the collection, after the burst,
   its fallback and Frontier, with the snapshot's time already fixed
   (`collector/daily.mjs`). Providers report 1h, 6h and 24h volume only, so a
   longer window needs the daily answer of each pool: one GeckoTerminal request
   per pool, `/networks/{network}/pools/{poolId}/ohlcv/day?limit=33&currency=usd&include_empty_intervals=true`,
   asked with `Accept: application/json;version=20230302` (the one header a caller
   can change: `accept` in the client is allow-listed to JSON and a dated
   version). Only the largest pools are read: a pool **joins** when it ranks 40th
   or better by its current 24h volume in this run and **stays** while it ranks
   60th or better (so a pool near the line does not drop in and out of the totals),
   at most 60 records; a pool that is not measured in a run keeps its record for
   three days. The top 40 held about 95 percent of the tracked 24h volume on
   11 November 2026; about 26 of 333 projects with trading had a pool among them,
   so most projects have no 7D or 30D figure and show a dash, said plainly on the
   page.
   A figure is the sum of the pool's USD volume over the last 7 (30) **complete**
   UTC days. The answer's newest candle is the day still in progress; it is dropped
   at the answer's own time (the response's `Date` minus its `Age`, never the
   moment we looked), so a stored day never changes. That is why a pool needs
   reading only twice a day, at the first run after 00:00 UTC (the new day) and the
   first after 04:00 UTC (what the provider adds afterwards; 04:00 and not 03:00
   because a discovery run, the first of each three-hour block, has the fewest
   requests to spare). About 125 requests a day in all, so about 20 of 24 hourly
   runs send none. A pool GeckoTerminal does not know (HTTP 404) or has no data for
   is asked once a day.
   The step runs only in a run that will be published, is skipped when the run is
   already 30 minutes old, when GeckoTerminal was stopped earlier in it, when the
   request budget is spent, or when the run would not pass the quality gate (the
   gate runs after assembly, so what it can already tell is asked first). It spends
   only what the 399 requests still allow: at most 20 requests, none starting later
   than 240 s into the step (the lane's own gap of 12 s, doubled after the one
   cooldown, decides how many fit; a cooldown's second try counts as a request), one
   at a time, largest pools first. It cannot delay the burst (it starts after it),
   and the snapshot's time, `state/pools.json`'s `updatedAt` and the workflow's
   45-minute rule are what they were (`tests/collector-daily-run.test.mjs` pins
   that). What it does move is publication: the write phase waits for the step, so
   on a run that sends requests (a few a day, the first after 00:00 and after
   04:00 UTC) `snapshot.json`, `daily.json` and the deploy follow up to about four
   minutes later (the step's own 240 s and one last request). The snapshot's time
   stays the time the measurements were taken; a run without requests publishes
   when it did before. It never fails a run: an answer that is wrong in any way
   is a note, the days already on file are kept, and the records are published as
   they were.
   - **Reading an answer.** It must be at most 33 rows, each `[seconds, open, high,
     low, close, volume]` at a UTC midnight, newest first (sorted again here),
     contiguous (with `include_empty_intervals=true` a quiet day is a row with
     volume 0; without it quiet days are left out and 33 rows can span two months, so
     an answer with a missing day is refused), with no day after the reading, no
     repeated day, and every volume a plain amount from 0 to under 1e13. Where the
     answer names the pool's two currencies they must be the pool's own (the native
     currency is not compared). Anything else is unreadable: the stored days stay.
     An answer that is HTTP 200 and unreadable is an answer: the pool is not asked
     again until the next checkpoint, and does not count toward the step's own
     five-failures-in-a-row stop (only network errors, timeouts and 5xx do). A pool
     unreadable twice in a row is out of the file until it reads again.
   - **Which day the figures end on.** The dataset ends on the snapshot's newest
     complete UTC day once pools holding 90 percent of the covered volume (their
     current 24h volume as the weight) have been read after that day ended, and one
     day earlier until then, so no total mixes two end days and nothing older than
     one day behind the newest complete day is ever published. A pool with no data,
     unknown to GeckoTerminal, or unreadable twice is not covered: it leaves both
     sides of that share and the file.
   - **Young pools.** A pool younger than the span carries `n7`/`n30`, the UTC
     days it was live (its creation day, or its first day at GeckoTerminal if
     earlier, to the end day), and the page says "since launch". A pool whose
     history was cut at the 33-row limit is never young. A day inside the window
     that is missing from a pool's days means no figure for that pool, never a zero.
   - **Request arithmetic.** The real discovery run of 11 November 2026 made 380
     requests (DEX Screener 288, GeckoTerminal 26, v4.xyz 60, registry 2, Frontier 3,
     Goldsky 1), so the step could send 19; the documented full-size fake run is 388
     (11 left); the ceiling of a discovery run, 3 + 306 + 6 + 3 + 80, is 398 (1 left).
     A run without discovery makes about 300, so a checkpoint run sends 20 of the 99
     left and the others none. The worst discovery run (900 s of discovery, the 270 s
     burst deadline, 36 s of Frontier, 240 s and one last request of the step) is
     about 24 minutes of the job's 45. `COLLECTOR_DAILY_MAX_REQUESTS` can lower the
     20 and `0` switches the step off (below).
   - **What it writes.** `state/daily.json` (below) when the records changed, and
     `data/daily.json` with one source row, `geckoterminal-daily`, in
     `snapshot.json`: the row is how the already-loaded page knows to offer 7D and
     30D without a request of its own. `status.json` has `counts.daily`
     (`selected`, `due`, `requested`, `read`, `noData`, `missing`,
     `unreadable`, `failed`, `revisedDays`, `through`, `published`,
     `covered`, `readyShare`, and why it `stopped` or was `skipped`).
     `counts.requests` keeps the lane's total (GeckoTerminal's number includes the
     step's); `counts.daily.requested` is the step's share, and in `sources` the
     `geckoterminal` row shows the measurement phase and `geckoterminal-daily` the
     step's requests. The market notes describe the measurement phase only.
5. **Assemble.** The directory is built with the project's own `createDirectory`,
   asked for `strictFamilyNames` and `includeOfficialHooks` (see "Choices to know
   about"). Pools are attributed
   with the project's own `attributePools`
   (exact registry evidence only), `applyMetrics` aggregates per project, and the
   snapshot is built (`summary`, `coverage`, `sources`, `chains`, `inventory`,
   `marketCoverage`). The snapshot holds the registry-named projects, the
   published platforms and any project with at least one measured pool, and no
   `directory` field, so the client filters locally. Its `generatedAt` is the
   moment the burst ended (Frontier's step included) and freshness is evaluated at
   that moment. The coverage text names Frontier's public AMM index when pools
   carry its figures, in the live app's words.
6. **Overview files.** `analyticsOverviewAsync` (the live server's own function)
   builds `overview-all-h1`, `-h6`, `-h24` and `overview-<network>-h24` for every
   network, with the per-pool contributions the client re-slices locally, at the
   snapshot's own time.
7. **Quality gate.** The run is refused (exit code 1, nothing written) when the
   snapshot or any overview fails its validator, no pool has a current 24h volume,
   fewer than 500 pools carry a current 24h volume (a measured zero is a volume;
   a pool with a liquidity figure and no volume does not count), fewer than 80% of
   the planned pools were requested (a provider that stopped us, with a second
   429 or a 403, or a burst that ran out of time; the pools of a network DEX
   Screener does not index are never requested, so they count against this
   share), fewer than 80% of the pools that were requested were answered (a
   provider that fails on and off, an HTTP 503 on every other batch, never makes
   five failures in a row and so is never stopped; the answers are what is
   counted. A pool counts as answered when either provider answered for it, so a
   pool whose DEX Screener batch failed and which GeckoTerminal then answered is
   answered; an answer for a pool that was never requested does not count, so the
   count cannot exceed the pools requested. `status.json` has it as
   `counts.answeredPools`, and `counts.checkedPools` keeps the larger number the
   coverage rows are made of: every pool a provider answered for, requested or
   not), fewer than 90% of the pools that carry a measurement are current at
   the snapshot time (a stalled burst, or a provider serving old cached copies,
   would otherwise publish totals that leave much of the sample out), or fewer
   than 60% as many pools carry a current 24h volume as behind the previous
   history point, when that point is less than a day old (a sample that shrank to
   a fraction would otherwise be recorded as a fall in volume; with no previous
   point, or one more than a day old, nothing is compared, so a genuinely smaller
   sample holds the site back for a day at most). The refusal prints its reasons
   and, because a refused run writes no `status.json`, the request counts, the
   networks DEX Screener answered HTTP 400 for and the rate-limit waits.
8. **Write.** Overview files, `history.json`, `daily.json` (any old one is deleted
   first, and a new one is written only if it validated and is not empty),
   `status.json`, then `snapshot.json` last (it is the marker that the set is
   complete), then the state files.

## Commands

| Command | Meaning |
|---|---|
| `node collector/run.mjs` | A real run. Writes `public/data/` and updates `state/`. |
| `--no-publish` | Collect, validate and apply the gate; write nothing (unless `--out`). |
| `--out <dir>` | Write the data files to `<dir>` and the updated state to `<dir>/state`. `public/data` and `state/` are not touched. |
| `--state <dir>` | Read state from `<dir>` (default `state/`, or the fixture state with `--offline`). |
| `--max-discovery <n>` | Discovery looks at the first `n` networks only (`0` turns it off). |
| `--max-pools <n>` | Measure at most `n` pools. |
| `--min-current <n>` | Minimum number of pools with a current 24h volume for the gate. Values below 500 are accepted only with `--offline`. |
| `--offline` | Replay the recorded fixtures: no network call at all. Reads `collector/fixtures/state`, treats a request that was not recorded as an empty answer, and requires `--out` (or `--no-publish`): an offline run never writes into `public/data`. The gate minimum defaults to 20 because the recording is small. Its `status.json` carries `"offline": true`. |
| `--verbose` | One line per request outcome on stderr. |

Exit codes: `0` passed (and written, unless `--no-publish`), `1` the gate refused
or the run failed (publish nothing, keep the last good snapshot), `2` usage error.

Other programs:

- `node collector/export-seed.mjs` seeds `state/pools.json` and `state/census.json`
  from the live Hook Radar app (below).
- `node collector/tools/record-fixtures.mjs` records real provider responses (below).
- `node collector/tools/imports.mjs [--check]` lists the files outside `collector/`
  that the collector imports; `collector/IMPORTS.md` is that list.

Environment: `GITHUB_REPOSITORY` (`owner/repo`) names the repository in the
User-Agent (`HookRadarAutoSnapshot/1.0.0 (+https://github.com/owner/repo)`; a
local run says so instead). `COLLECTOR_DS_GAP_MS`, `COLLECTOR_GT_GAP_MS` and
`COLLECTOR_V4_GAP_MS` can raise a gap; a value below the contract gap is ignored.
`COLLECTOR_RETRY_AFTER_CAP_MS` can shorten the longest rate-limit wait (below);
a value above 90,000 is ignored and `0` turns the cooldown off.
`COLLECTOR_MAX_DISCOVERY` is the same number as `--max-discovery` (`0` turns
discovery off; the Snapshot workflow sets it to `0` for the runs that only
measure the pools already known). Like every environment setting it can only
make a run smaller: an empty or invalid value (anything but a whole number from
0 to 999,999) changes nothing, a large number is the same as no limit, and
`--max-discovery` on the command line wins. `COLLECTOR_DAILY_MAX_REQUESTS` limits
the 7D and 30D step the same way: a whole number from 0 to 999,999 that can only
lower its 20 requests, `0` switches the step off, anything else changes nothing.

## Limits and gaps (all in `collector/config.mjs`)

| Constant | Value |
|---|---|
| `DS_GAP_MS` / `GT_GAP_MS` / `V4_GAP_MS` | 400 / 12,000 / 5,000 ms between request starts |
| `DS_BATCH_SIZE` | 30 ids per DEX Screener request |
| `GT_FALLBACK_MAX_REQUESTS` / `GT_FALLBACK_BATCH_SIZE` | 6 requests of up to 30 ids |
| `FRONTIER_MAX_REQUESTS` / `FRONTIER_LATEST_START_MS` | 3 requests (coin listing, statistics, one index query); the step starts at most 240 s into the burst |
| `MAX_PRIORITY_POOLS` | 1,500: the most the priority list may hold (it holds 1,355) |
| `MAX_MEASURED_POOLS` / `MAX_DISCOVERED_MEASURED` | 8,000 seeded pools, plus up to 500 found by discovery (8,500 in all) |
| `MAX_RESOLVES_PER_RUN` | 40 exact-pool lookups |
| `MAX_REQUESTS_PER_RUN` | 399 in all (hard stop) |
| `DAILY_JOIN_RANK` / `DAILY_KEEP_RANK` / `DAILY_RANK_GRACE_MS` | 40 / 60 / 3 days: a pool joins the 7D and 30D reads at rank 40, stays to rank 60, and an unmeasured pool keeps its record three days |
| `DAILY_MAX_REQUESTS` / `DAILY_BUDGET_MS` / `DAILY_LATEST_START_MS` | 20 requests; none starts later than 240 s into the step; the step is skipped once the run is 30 minutes old |
| `DAILY_CANDLES` / `DAILY_STORED_DAYS` | 33 rows asked for (30 complete days, the day in progress, two days of slack); 35 days kept per pool |
| `DAILY_CHECKPOINT_HOURS` | 00:00 and 04:00 UTC: a pool is read once per checkpoint |
| `DAILY_READY_SHARE` / `DAILY_MAX_UNREADABLE` | 0.9 of the covered volume read after the day ended; two unreadable answers in a row take a pool out |
| `MAX_BYTES.geckoDaily` | 64 KB (a 33-day answer is about 4 KB) |
| `BURST_BUDGET_MS` / `BURST_DEADLINE_MS` | no new DEX Screener batch may start after 225 s, no request of any kind after 270 s (a wait for a gap or a `Retry-After` counts: a request that could only start later is not sent) |
| `MIN_CURRENT_POOLS` / `MIN_REQUESTED_SHARE` / `MIN_CURRENT_SHARE` | 500 / 0.8 / 0.9 (500 pools with a current 24h volume; 80% of the planned pools requested and 80% of those answered; 90% of the measured pools current) |
| `MIN_VOLUME_POOLS_OF_PREVIOUS` / `PREVIOUS_POINT_MAX_AGE_MS` | 0.6 / 24 hours: the pools with a current 24h volume against the previous history point's, compared only while that point is less than a day old |
| `DISCOVERY_BUDGET_MS` | 900,000: no discovery request starts later than 15 minutes after the run began |
| `HISTORY_MAX_POINTS` | 2,016: 84 days of hourly runs. `EDITION_HISTORY_MAX_POINTS` in `src/edition.ts` and the overview check carry the same number (`tests/edition-history-cap.test.mjs`) |
| `STATE_MAX_POOLS` | 12,000 |
| `REQUEST_TIMEOUT_MS`, `MAX_CONSECUTIVE_FAILURES` | 20 s; five failures in a row stop a provider for the run |
| `RATE_LIMIT_WAIT_CAP_MS` / `RATE_LIMIT_DEFAULT_WAIT_MS` | 90,000 / 30,000 ms: the longest the one rate-limit cooldown of a run waits, and the wait when a 429 names none (Cloudflare's error 1015 page without a `Retry-After`) |
| `MAX_RETRY_AFTER_MS` | 120,000 ms: the longest `Retry-After` honoured on any other status (a 503, say); beyond it the provider stops |
| `COOLDOWN_PROVIDERS` | DEX Screener, GeckoTerminal and the v4.xyz indexer: the providers that may have the cooldown (the registry and Frontier fetches have a saved copy to fall back on, and Goldsky is asked once: none is given one) |

The request budget is reserved before discovery spends any of it: the batches the
burst needs (8,500 pools are 284 batches, plus one per network for rounding), the
fallback (6), Frontier's step (3) and the registry fetches come first, and
discovery is trimmed to fit what is left (81 requests at full size; discovery
wants 80). The priority list adds no request of its own: it takes places inside
the plan. A full-size fake run in the tests (the seed's 8,000 pools on its 14
networks, 640 discovered pools on 20 networks, providers that answer at once)
makes 385 requests: 296 DEX Screener, 20 GeckoTerminal pages and 6 fallback
batches, 20 indexer lists and 40 lookups, 3 registry fetches (no Frontier chain
is configured in that fake, so none of Frontier's 3 is among them: a real run
adds them, 388). Its collection takes about ten minutes of provider time, of
which the burst is about three. A real run varies with the networks the new pools
fall on, never above 399; the last real run before these changes made 375
requests, so a real run is now expected to make about 381 and stays under 400. A retry after a rate-limit cooldown is one of
those 399 requests. Only three providers can have one and each has one per run, so
at most three retries are added. They are not reserved: at full size discovery is
allowed 81 requests and wants 80, so only one request is spare there. A retry is
paid for by the part of the plan's reserve that the run does not use (the burst, its
fallback and Frontier's step are each reserved at their largest, and most runs use
less), and the client's 399-request hard stop applies to it like to any request.

Provider etiquette, all of it tested: truthful User-Agent; per-provider gap;
`Retry-After` honoured (the next request waits, and a wait longer than two minutes
stops the provider); one request at a time per provider; response sizes and time
bounded; redirects refused; only the provider's own https host is ever requested.

**Rate limits: one cooldown per provider per run, never hammering.** The first
HTTP 429 that says how long to wait (a `Retry-After` in seconds or as an HTTP date,
or a Cloudflare "error code: 1015" page, for which the wait is 30 s when no header
names one; any other `Retry-After` value, such as `+5` or `1 2`, names no wait)
gives DEX Screener, GeckoTerminal and the v4.xyz indexer one cooldown: the
collector waits the stated time, sends the refused request once more (same
ids, same URL) and doubles that provider's gap for the rest of the run. It waits
only if the wait is at most 90 s, the retry could start inside the time the phase
allows (225 s for the DEX Screener batches, 270 s for the fallback) and the request
budget has room; the retry is a request like any other and counts toward the 399.
Anything else stops the provider for the run, as it did before, and the gate
decides whether what was gathered is enough: a second 429 from that provider, a
429 that names no wait, a wait over the cap or past the phase limit, and every
403. Nothing else is retried (not a 5xx, a timeout or another 4xx). The first 429
does not count toward the five failures in a row. `status.json` records the wait
in `counts.rateLimitWaits` (per provider: `times`, `waitedMs`), the retried
request is in `counts.requests`, and the source note says `Waited 23 s after a
rate-limit answer (1 time).`

**Networks DEX Screener does not index.** An HTTP 400 for a network's batch means
DEX Screener does not know that network's slug. When it is the first answer for
the network, the 400 does not count toward the five failures in a row (five of
them in a row would otherwise have stopped DEX Screener for the run), the
network's remaining batches are not sent, and the network goes
into `counts.unsupportedNetworks` of `status.json` (its slugs, sorted) and into
the DEX Screener source note: `Does not index: Ethereum.` (the names the page
shows). A 400 after the network has answered is only a failed batch; it proves
nothing about the network and counts toward the five. The network's row in
`snapshot.marketCoverage` carries `unsupported: true` (the key is absent for every
other network), so the page can say that DEX Screener does not index the network
instead of "did not respond"; `attemptedPools` and `checkedPools` are unchanged.
The flag says what DEX Screener answered, not that nothing was priced: GeckoTerminal
can still answer for pools of such a network, and the row is then `live` with
`checkedPools` above 0 and still carries `unsupported: true`. A page reads the flag
only for a row with `checkedPools` 0 (or status `unavailable`).
A refusal caused by such a network says so (`Networks DEX Screener answered HTTP
400 for: robinhood.`): the pools it leaves unrequested are what pulls the share down.

## Running it on a PC that also runs Hook Radar

The providers count requests per internet address, not per program. The full Hook
Radar app asks the same DEX Screener and GeckoTerminal endpoints, so a collector run
from a PC that also runs it shares their limits with it. On 28 October 2026 a run
from such a PC had GeckoTerminal answer HTTP 429 on its fifth request and DEX
Screener answer 429 after 190 of 284 batches (a Cloudflare error 1015 page with
`Retry-After: 23`). The collector stopped both providers, 70% of the planned pools
were requested, and the gate refused to publish (nothing was written, as it should).
A second run with `COLLECTOR_DS_GAP_MS=750` and `COLLECTOR_GT_GAP_MS=15000` passed,
with 2,506 current pools. On such a PC:

```powershell
$env:COLLECTOR_DS_GAP_MS = '750'
$env:COLLECTOR_GT_GAP_MS = '15000'
node collector/run.mjs
```

- Raise `COLLECTOR_DS_GAP_MS` and `COLLECTOR_GT_GAP_MS` (they can only be raised).
- Keep the DEX Screener burst under its 225 s start limit. 8,500 pools are 284
  batches, so the gap can be about 0.75 s at most: 284 x 0.75 s is 213 s. With
  0.8 s or more, batches that cannot start by 225 s are not sent and the 80% rule
  decides whether the run is published.
- With the six fallback requests, a GeckoTerminal gap of 12 s starts the last one
  about 60 s after the first. When DEX Screener takes the whole 225 s only the
  first four start before the 270 s limit (a request that could only start
  later is not sent), which the gate counts as unresolved pools, not as zero.
- The cooldown is a safety net, not a plan. It doubles the gap from then on, so a
  0.75 s gap becomes 1.5 s and the batches after it may not all start in time.
  As arithmetic, not a recorded run: at 0.4 s between batches the 190th batch
  starts about 76 s in, and a 23 s wait followed by the remaining 94 batches at
  0.8 s would end near 174 s.
- Environment variables are not read from a `.env` file; set them in the shell
  that runs the collector.
- A trial run of your own: use `--out <folder>` (for example `node
  collector/run.mjs --out scratch/trial`), which writes the data files and the
  updated state into that folder and touches neither `public/data/` nor
  `state/`. A plain `npm run collect` from a PC that also runs Hook Radar is
  likely to be refused at the 80% gate, as on 28 October, and when it passes it
  rewrites `state/` and `public/data/`, which then conflict with the state
  commits the scheduled job makes.

## Times

Each pool keeps the observation time of the response that measured it: the
response `Date` minus its `Age`, derived the way the live app's server derives it. It
is never replaced by the time of the run. `generatedAt` is the moment the burst
ended, and every measurement is judged against that moment with the unchanged
five-minute rule. A response served from a cache that is more than five minutes
older than the end of the burst is kept in the snapshot with its original time but
does not count toward totals, exactly as on the live page. The gate counts only
current pools.

What keeps a burst inside that window is a limit on when a request may **start**,
not on when the next one is considered: the client refuses (and does not count) a
request that would have to wait past the limit for the provider's gap or for a
`Retry-After`. So a provider that answers 503 with `Retry-After: 120` late in the
burst ends the burst there instead of stretching it past five minutes; the
requested-share gate then decides whether what was measured is enough. The last
request to start before the deadline can still take up to the 20 s request
timeout, so a burst lasts at most about 290 s. That is a bound on requests, not a
promise about every response: a cached copy older than five minutes is still kept
with its own time and left out of the totals. The gate refuses a snapshot in which
fewer than 90% of the measured pools are current, so a thin run is not published.

## Providers: what each is used for

| Provider | Used for | Not used for |
|---|---|---|
| DEX Screener (`api.dexscreener.com`) | The measurements: liquidity and 1h/6h/24h volume per exact pool id | Discovery |
| GeckoTerminal (`api.geckoterminal.com`) | One top-pools page per network (candidate ids), up to six exact-pool fallback batches, and the daily answers of the largest pools (7D and 30D volume: at most 20 requests a run, about 125 a day, at the same 12 s gap) | Anything else |
| v4.xyz indexer (`www.v4.xyz`) | Pool identity only: which hook, which two currencies. The paths are undocumented | Any amount |
| Uniswap hooklist and chain registry (GitHub raw) | Hook deployments, project grouping, chain names | |
| Frontier (`api.frontier.fun`) | `/chains`: exact hook addresses Frontier publishes, so its pools are attributed (not in the contract's list; see "Choices to know about"). `/coinsPage?limit=100` and `/coinsStats`: the market figures of the pools of its own hooks (three requests with the index query) | Curve volume, curve ETH, anything outside its isLPd markets |
| Goldsky (`api.goldsky.com`), Frontier's AMM index | One POST a run: the core reserves, the hook and the native-ETH swaps of the pools in Frontier's listing. The address comes from Frontier's configuration; no key is involved | Anything else, and any USD field of the index (it has no price feed) |

DefiLlama and CoinGecko price APIs are not used. The collector still imports the
server modules that mention them (`reserve-value.mjs` reaches them) but never calls
them.

Terms to settle before launch (the owner's decision, repeated in
`docs/PROVIDER-TERMS.md`): GeckoTerminal and CoinGecko ask for attribution (the
snapshot's GeckoTerminal source says "Data provided by GeckoTerminal" and links it, but the page's Data & sources dialog and footer credit, which showed it, are switched off at the owner's choice: see the section on credit in that file); DEX Screener sets its own terms and limits and may change or end access, so read its current terms; the v4.xyz paths are undocumented
and can change without notice. A scheduled job from one cloud IP is a different
load shape from the live app's, which is why the gaps are the contract's and may
only be raised.

## State (`state/`, committed)

| File | Content |
|---|---|
| `pools.json` | `{ schemaVersion, updatedAt, pools: [...] }`, one pool per line. A pool is `id` (lowercase bytes32), `chain`, `hookAddress`, `tokens` (two lowercase addresses; the native currency is the zero address), `name`, `createdAt`, `source`, `firstSeen`, `lastSeen`, for a pool GeckoTerminal measured last time `via: "geckoterminal"` (the fallback hint above), and optionally `dynamicFee` (below). `source` is `census` for the seed (identity verified by the live app's on-chain census) or `v4.xyz` for a pool found by discovery (identity from the indexer). `updatedAt` is the previous run's `generatedAt`. |
| `hookless.json` | `chain:id` keys of pools the indexer resolved to the zero hook. |
| `priority.json` | `{ schemaVersion, exportedAt, selection: { snapshotGeneratedAt, rule, counts }, pools: [...] }`, one pool per line: the pools that are always in the plan. A record holds seven fields and no others: `id`, `chain`, `hookAddress`, `tokens`, `name`, `createdAt` and `projectId` (the platform or project it was chosen for, a label: ownership is decided from the exact hook at every snapshot). The state refuses a file with any other field (a provider's address, a key, a figure), a web address in a name or a malformed identity. Written once by `collector/export-priority.mjs`; the collector only reads it. |
| `census.json` | `{ exportedAt, seed: {...}, inventory }`. `inventory` is the live app's pool census as published, with its original `generatedAt`, per-network `updatedAt` and `headCheckedAt`, plus the time of the export. The one thing removed is each network's `sourceUrl`, the address of the data service the app read that network from (some embed an access key; see "Choices to know about"). The page shows it as "Census as of <date>", never as current. |
| `history.json` | `{ schemaVersion, points: [{ timestamp, value, pools }] }`, newest last, at most 2,016 points. |
| `daily.json` | `{ schemaVersion, updatedAt, pools: [...] }`, one record per line, at most 60: `chain`, `id`, `lastRankedAt` (moves at most once a day), `attemptedAt` and `result` (the last definite answer: `ok`, `none`, `missing`, `unreadable`; null before the first), `fetchedAt` (when the last readable answer was true), `bad` (unreadable answers in a row), `start` (the pool's first day at GeckoTerminal, when its whole history was seen) and `days` (`[dayNumber, usd]`, complete UTC days, at most 35). About 50 KB. Written by the collector only, and only when the records changed; never committed from a worktree. A missing file means no daily data yet; one that cannot be read, is not JSON (conflict markers after a merge) or has the wrong shape is ignored with a note in `counts.daily.note` and replaced by the next published run. |
| `registry.json` | Last fetched hooklist (without the decoded flags, which are recomputed from each address), chain registry and Frontier configuration, each with its fetch time. Rewritten only when the data changed. |

`lastSeen` moves at most once a day per pool, so the committed file stays quiet.
When state grows past 12,000 pools the least recently seen are dropped. The burst
measures the seeded pools first and the most recently seen discovered pools after
them (see "Measurement burst").

### Dynamic LP fees

A pool is created with its LP fee, or with the dynamic-fee flag (`0x800000`)
when its hook sets the fee. The live app reads that fee from the PoolManager
events it indexed and tags a hook "dynamic fees" when any of its pools carries the
flag. The edition indexes nothing, so it carries that evidence in `dynamicFee` on
the state pools:

- **Seeded pools**: the live app's own answer for the pool's hook at the seed, for
  hooks that are not in the Uniswap hooklist (`true`: a dynamic-fee pool is known;
  `false`: the census checked and found none). Hooks the hooklist names are not
  copied: the hooklist's own `properties.dynamicFee` is used for them.
- **Discovered pools**: only `true`, when the indexer's pool name ends in
  `- 838.8608%` (the flag read as a percentage; the name is printed from the fee
  the pool was created with). The recorded answers show why the name and not the
  indexer's `feeTier` field: for the dynamic pool in `collector/fixtures/v4-3.json`
  the name says `838.8608%` and `feeTier` says `"0"`, the fee being charged at the
  moment. On the recorded Ethereum and Base lists all 26 pools whose name shows the
  flag belong to hooks the live app tags dynamic. A fixed-fee name proves nothing
  about a hook (of the 19 fixed-fee pools on the recorded Base list whose hook the
  live app also lists, 14 belong to hooks that run dynamic-fee pools), so it is
  not stored.

The snapshot tags a hook dynamic when any state pool of it says `true`. A hook
with no evidence either way is published with `dynamicFee: false` because the
type has no third value, and its description says so ("Whether it sets LP fees
dynamically has not been established, so it is not tagged as dynamic."). In the
seed every hook outside the hooklist that has a pool has an answer; the note
appears for newly discovered hooks, and for the two Uniswap Labs hooks that the
hooklist omits and no seeded pool uses (WETHHook on Monad, WstETHRoutingHook on
Ethereum) until a pool of either is known.

One history point is appended per successful run: the tracked 24h volume summed
over the pools that were current at the snapshot, stamped with the oldest
measurement behind it. Only the timestamp convention and the constants (points at
least five minutes apart, newest last) are the live app's; the number kept is not (2,016 here, 672 there).
The rule for which pools count is not. The live app records a point only when
every pool contributing to the total is current; this edition sums the pools that
are current at its snapshot and leaves the others out, and the quality gate
refuses a run in which fewer than 90% of the measured pools are current. A run
less than five minutes after the previous point adds none. There is no
per-project history in this edition: every project's `history` is empty.

Before the hourly schedule the cap was 672 (84 days of runs three hours apart). Going back to a collector older than that change needs `state/history.json` cut to its last 672 points first: the older collector refuses a longer file ("history.json has an unexpected shape") and publishes nothing.

## The seed

`state/pools.json` and `state/census.json` were seeded once from the live app's
public API on 27 October 2026 (`node collector/export-seed.mjs`): one `GET
/api/snapshot` with `Accept-Encoding: gzip`, of the 55,615 measured pools in that
snapshot the 8,000 hooked pools with the highest 24h volume (then liquidity)
that have two known currencies, and the census as published (22 networks,
generated 27 October 2026 21:08:49 UTC, without the per-network `sourceUrl`). The export makes at most three requests
and retries only a server error or a dropped connection. It refuses a non-local
address unless `--allow-remote` is given. `--save-raw <file>` keeps the response
so the ranking can be redone offline with `--from-file <file>` (and `--exported-at <time>`
to keep the time of the original request). The seed in this repository was made
with one request and re-derived once from the saved response.

The seed ranks by 24h volume at one moment, so it leans toward the networks that
were busiest then (4,355 of the 8,000 are on Robinhood Chain, 2,283 on Base).

The seed also carries `dynamicFee` (above): 162 pools of hooks that run dynamic
fees, 3,571 pools of hooks the census checked and found fixed, and none for the
4,267 pools of hooks the Uniswap hooklist names. It was added by running the same
export again over the saved response (`--from-file` with the original
`--exported-at`); the result equals the earlier `pools.json` byte for byte once
the new field is removed, and `census.json`, `hookless.json` and `history.json`
are identical.

## The priority list

The seed is the live app's top 8,000 pools by 24h volume on one day, so it holds
few of the pools that launchpad platforms created afterwards, and most of it stops
answering within days. `state/priority.json` is the second one-time export from
the live app, made from the same kind of response (`node
collector/export-priority.mjs --from-file <saved snapshot> --exported-at <its
time>`; without `--from-file` it reads the local app, like the seed export). It
holds 1,355 pools, chosen by a rule the file states:

- every pool of the exact hooks that the 36 reviewed launchpad platforms publish
  as their own (`platform-hook` paths of `shared/launchpad-registry.ts`) and of the
  hooks that named projects deploy (not the unnamed on-chain hook projects), that
  carried a measurement within 24 hours of that snapshot (963 are Pons's, 49
  Aegis's, 16 Hookr.fun's, 14 Minara's and 14 Uniderp's, then smaller numbers);
- for Doppler, Clanker, Zora and Flaunch, whose pools number in the millions, the
  50 with the highest 24h volume among those measured within a week (they carried
  nearly all the volume those protocols showed). A pool is listed once, under the
  first label that chose it: Flaunch is labelled on 46, because four of its top
  fifty are on the hook that ubi.fun also publishes and are listed under ubi.fun.

The snapshot it was made from is the live app's last public one before it was
stopped, 31 October 2026 18:32 UTC; of the 1,355, 623 were not in the state, and
732 were. Each record is identity only: pool id, network, hook, the two currencies,
name, creation time and the label of the platform or project it was chosen for.
The exporter reads only those fields of the snapshot (never a provider address, a
key or a figure), the state refuses a file with any other field, and
`tests/collector-priority.test.mjs` pins both. Ownership is not taken from the
label: the snapshot attributes a pool by its exact hook at every run, and a pool
on the list that no registry evidence names simply is not attributed.

The list does not make a platform's volume complete: a platform with millions of
pools stays a lower bound (the page marks its sums "≥"), and the pools of a hot
launch that has faded since are measured and found quiet. It is not refreshed by
the collector; re-run the export from a newer snapshot to change it.

A pool created after that snapshot is not on the list. Umia's pool on UmiaHookV2
on Robinhood Chain (SLOP / USDG, created 10 November 2026) is one: it is a
discovered pool, so it is measured only while it stays among the 500 most
recently seen discovered pools; if enough newer discoveries push it out, its last
reading ages until its freshness expires and its figures are no longer shown.
Putting it on the list is a new export, made deliberately (the list holds 1,355
of the 1,500 it may).

## Fixtures and offline mode

`collector/fixtures/` holds 11 real responses recorded on 27 October 2026 by
`collector/tools/record-fixtures.mjs`: the hooklist, chains and Frontier
configuration; the v4.xyz lists for Ethereum and Base and one exact-pool lookup;
one GeckoTerminal top-pools page and one fallback batch; three DEX Screener
batches. Each file is the response body; `manifest.json` keeps its URL, status,
`Date` and `Age`. They drive `run.mjs --offline` and the tests. The recorder goes
through the same paced client and the same planner as a real run, makes at most
16 requests (an answer that is not HTTP 200 aborts it and nothing is written), and
was run once, before Frontier's step existed. Three more entries cover that step
and were **not recorded**: the manifest marks them. `frontier-2.json` and
`frontier-3.json` are derived from the public answers of `/coinsPage` and
`/coinsStats` saved on 11 November 2026 (12 of the 86 coin rows, only the fields
the collector reads, every time field moved by the same number of seconds into the
recorded run so that the five-minute rule holds in the replay; the amounts are the
API's). `goldsky-1.json` is hand-built: the public index was not asked, so it has
the shape of its answer for the same ten pools with invented round numbers. A
real run of the recorder, which now includes Frontier's step, replaces all three
with recordings. Offline output is test output either way, and
`scripts/check-edition-data.mjs` refuses it.
`collector/fixtures/state/` is the state that reproduces those requests. The
hooklist fixture is 6.3 MB because it is the unedited response.

Offline output is test output. It carries the recording's own times (October 27),
so it can never be mistaken for a current snapshot, and the command refuses to
write it into `public/data`.

## Tests

`node --test tests/collector-*.test.mjs` (a few seconds, no network:
each test file starts by replacing the process's `fetch` with one that refuses, so a
test that reaches for a provider fails instead of calling it):

- `collector-http`: Date/Age observation time, gap pacing with a fake clock,
  a 429 that names no wait and a 403 stopping the provider with no retry,
  Retry-After, size and time bounds, host guard, request budgets, User-Agent, gap
  overrides that can only raise.
- `collector-resilience`: the rate-limit cooldown on a fake clock (one wait, one
  retry of the same request, the gap doubled; a second 429, a wait over the cap, a
  wait past `notAfter`, a 403, a spent budget or a provider outside the list stop
  the provider; the retry counts toward the 399; nothing else is retried; the
  first 429 is not one of the five failures; a malformed `Retry-After` names no
  wait), HTTP 400 for a network DEX Screener does not index (batches skipped,
  breaker untouched, also when the 400 answers the retry of a 429, fallback
  considers the pools), the 225 s limit with a cooldown inside the burst, the
  gate refusing after an early stop, and what `status.json` and the source notes say.
- `collector-providers`: acceptance rules for DEX Screener and GeckoTerminal rows,
  null versus measured zero, the indexer's identity checks, and (when
  the live app's market collector is present in the copy) identical results to it.
- `collector-pipeline`: a full run with fake providers, stale observations,
  unresolved pools, shared hooks counted once, GeckoTerminal never overriding DEX
  Screener, the quality gate, history cap, state validation, the seed export.
- `collector-offline`: the fixtures, parity on the real recorded responses, and an
  offline run end to end into a temporary directory, with the network disabled.
- `collector-imports`: `collector/IMPORTS.md` is exactly the computed import list, and
  the one live-app provider module the collector imports is the stateless Frontier
  producer (`server/providers.mjs`), which reaches nothing of the runtime.
- `collector-frontier`: the client's one kind of POST and its host lock; the live
  Frontier code run over the paced client (three requests, in order, one second
  apart, none per coin); its rows equal the producer's field for field and are
  priced at the statistics' ETH/USD rate; a row without the producer's proof is
  never used; the state's name, creation time, hook and currencies; the newer
  measurement winning whole; a whole run (labels per pool, sources and request
  counts, the coverage wording, the project row); and failure never failing the
  run (the index down, the listing refused with 429, 403 or 500, answers of the
  wrong shape, a step that throws, no Frontier chain).
- `collector-priority`: what a priority record and file may hold (every other
  field, a web address in a name and malformed identities refused), the committed
  `state/priority.json`, the selection rule on a real offline snapshot (age limits,
  top fifty of the shared protocols, a hook two entities publish, nothing leaked
  from the provider addresses and keys placed in the input), the export command,
  the planner (listed pools first, inside the seeded places, discovery kept), the
  fallback order and its limit, and a run that adds, measures and keeps the listed
  pools.
- `collector-contract`: the numbers of the design written out as literals (the other
  files import the constants, so only this one notices a constant changed to pass a
  test), the 399-request budget, five failures stopping a provider, `notAfter`
  refusing a request that would start late, the 225 s and 270 s burst limits with a
  stalled `Retry-After`, and the registry: live, cached with its original time, no
  copy, Frontier optional, the saved copy's round trip through `state/registry.json`.
- `collector-fullsize`: one run at the size the job really has (above), asserting the
  request count, the minimum gap per provider, the equal share of lookups, that no
  seeded pool is dropped, and the dynamic-fee tag of every deployment.
- `collector-discovery-env`: `COLLECTOR_MAX_DISCOVERY` (a whole number from 0 to
  999,999; anything else changes nothing; it can only lower discovery; the
  command line wins), a run with discovery off passing the quality gate on the small
  recording at its offline minimum of 10 pools (at the default offline minimum of 20 it is
  refused, with 18 pools that carry a current volume, so switching discovery off lowers no
  threshold), and a snapshot made without discovery saying so in its sources ("pages read: 0;
  this run did not look for new pools", no v4.xyz entry) instead of reading as "no new
  pools exist". On the real run of 11 Nov 2026 (1,378 pools with a current 24h volume, and 2
  pools newly found by its discovery) a run that only measures the known pools would have
  had about 1,376 against the minimum of 500. That is an estimate from the published status
  of that run; the first real run that only measures will confirm it.

`node --test tests/edition-gate.test.mjs` takes the script of the Snapshot
workflow's first job ("Is a new snapshot due") out of `.github/workflows/snapshot.yml`
and runs it under bash the way the runner does, with a stand-in clock, a
stand-in for `gh` (the list of earlier runs) and state files written for each
case: 44 and 45 minutes, an unreadable, null, empty, impossible or future saved
time, a state file with Windows line ends, pretty-printed, with the time last or
with a pool named updatedAt, a run started by hand with force ticked (it always
collects, and looks for new pools only when discover is ticked), a failed run 30
and 100 minutes ago, GitHub not answering, and the three-hour block rule for new
pools. A run started with force unticked and discover unticked, which is what the
external timer of `docs/EXTERNAL-TRIGGER.md` sends every 20 minutes, is run beside
a scheduled run in seven situations (10 minutes old, 50 minutes old in the same
and in the block before, a failure 30 and 100 minutes ago, GitHub not answering, an
unreadable time) and must give the same decision, summary, outputs and calls to
GitHub; with discover ticked it still looks for new pools. It needs bash and GNU
date (skipped
without them). It also pins the workflow's shape: three triggers an hour, a
gate that contacts no data provider, `collect` waiting for it and `deploy`
needing only `collect`. This was the only proof the gate had until 12 November
2026, when two scheduled runs of the repository (runs 9 and 10, started at
02:48 and 03:08 UTC) were seen on GitHub ending at the gate: "Is a new snapshot due"
green after a few seconds, "Collect and build" and "Publish to GitHub Pages" skipped.
A run started by hand with "force" unticked has not yet run on GitHub. Prove it there
with one **Run workflow** with "force" unticked right after a publication (the run
should end green with "Nothing to do" and no Pages deployment) and one with "discover"
ticked.

A run that takes more than about 15 minutes from its start to saving its state (one that
looks for new pools can) makes the next collection wait for the trigger 20 minutes later:
the rhythm is then 80 minutes, not 60.

**How runs start.** GitHub's own schedule is best effort: its documentation says a
scheduled run can be delayed or dropped when it is busy, and from 17:07 UTC on 11
November to 02:32 UTC on 12 November 2026 none was started (9 hours 25 minutes; the
only run in between, at 21:42, was started by hand). What makes the rhythm dependable is
an optional external timer (`docs/EXTERNAL-TRIGGER.md`, script
`docs/trigger-worker.js`, tested by `tests/edition-trigger.test.mjs`) that calls
the `workflow_dispatch` API of GitHub every 20 minutes with `force` and `discover`
set to `"false"`. The gate treats such a call exactly like a scheduled run, so
nearly every call ends green in seconds with "Nothing to do". With the timer the
starts of an hour (the three scheduled ones at 7, 27 and 47 past and the timer's
three at 00, 20 and 40 past, UTC) are alternately 7 and 13 minutes apart instead of
20, so after the 45 minutes a collection waits at most 13 minutes, not 20. The
timer adds no request to a data service: a new snapshot is still never taken less
than 45 minutes after the last one was saved, except by a person pressing **Run
workflow** with force ticked. The behaviour for a call with force unticked has been
shown only by the test above, not yet on GitHub.

`node --test tests/edition-collector-truth.test.mjs` (a few seconds, no network) pins what the published data may claim: the strict family rule against the
recorded hooklist (and that the live default is unchanged), the pricing rows and
their statuses, the directory's network names in the snapshot and every overview,
and no credential-looking URL in the committed seeds, in any file an offline run
writes or in any test or script the edition folder copies.

`node --test tests/edition-w3-collector.test.mjs` (no network) pins what
the final review's collector findings asked for: a row without a figure is checked
and not measured (DEX Screener and fallback paths, a measured zero kept, every
count equal to the pools published); the `unsupported` flag on a coverage row; the
gate counting pools answered (half of the batches failing on and off, 80% exactly,
the count never above the pools requested even when GeckoTerminal answers pools
that were not),
naming the unindexed networks and the stopped providers; the batches going one
network at a time in turn, and a network left after five failed batches; the floor
counting pools with a current 24h volume; the previous history point (60%, a day,
a point that is missing or malformed); a refused run printing its counts; a hollow
registry answer keeping the saved copy; discovery ending at its time limit when an
indexer answers every list with `Retry-After: 110`; sums to the cent in the
summary and the history, and the overview keeping its exact sums; the collector
started through a directory junction; and what these notes say about files, size,
the real runs and the gate.

`node --test tests/collector-daily.test.mjs tests/collector-daily-run.test.mjs tests/edition-daily-gate.test.mjs tests/edition-daily-client.test.mjs tests/edition-daily-docs.test.mjs`
(no network) pins the 7D and 30D volume: the request and the parser against the
real answers recorded from GeckoTerminal on 11 November 2026
(`collector/fixtures/daily/`: a busy Ethereum pool, a sparse one with and without
empty days, a Frontier-measured Robinhood pool, an X Layer pool, a day-old Base
pool, two HTTP 429 answers and two 404s) and against hand-built bad ones (an empty,
short, reversed, null, negative, absurd, misaligned, duplicated or gappy list);
joining, keeping and dropping pools; the checkpoints to the millisecond; the reads
on a fake clock (largest first, 12 s apart, the limit of 20, the 240 s start limit,
the cooldown and its doubled gap, a second 429, five network failures, five
unreadable answers that must not starve the rest, 404s, a cached answer dated by its
`Age`); the sums (exact, a quiet window as $0, a gap as no figure, young pools); the
end day and the 90 percent rule; `state/daily.json` missing, garbage, truncated,
with conflict markers and of the wrong shape; whole runs (the step after every other
request, the snapshot time and `state/pools.json` time identical with the step on and
off, idempotence, a failing step, a refused run that spends nothing, the heaviest
run at the cap); the data gate on folders (another run's file, a day in progress, a
7D above a 30D, a source row without a file or the reverse); the page's reading, lens,
address, sort, CSV and Networks model; and what these documents say.
`scripts/edition-daily-browser.test.mjs` shows the screens at 1440, 390 and 360 px
on test data.

## Choices to know about

- **A project is credited with a hook only on the registry's word, and a family
  name has to start a word.** The directory groups registry hooks into a project
  by a rule on the hook's name. The live rule for Flaunch is `/flaunch/i`, which
  also matches the "fLaunch" inside the unrelated third-party hook
  `ProofLaunchHook` (Robinhood, 0x83b1a8f2…c8cc), so the live rule lists it as
  a Flaunch hook, and any pool measured on it would be summed into Flaunch. The
  collector asks `createDirectory` for `strictFamilyNames`: a family that has a
  `strictMatch` in `server/model.mjs` is matched with that instead. Flaunch's is
  `/\bflaunch/i`, which every recorded Flaunch name satisfies ("Flaunch …", or
  "AnyPositionManager (Flaunch vested launch hook)"). `ProofLaunchHook` is then a
  hook of its own, like any other registry hook with an unrelated name. The
  default (no option) is the live rule, unchanged. `/frontier/i` was left as it
  is: its recorded hooks are Frontier's own published chain configuration and the
  registry's "Frontier FactoryHook". `tests/edition-collector-truth.test.mjs`
  scans the recorded hooklist and fails if the strict rule credits a project
  with a name that does not start with the family name or open a parenthesis with
  it. **The live app has the same substring defect.** It is not changed here:
  the live attribution is coupled to durable history, so that is the owner's
  decision.
- **Every hook Uniswap Labs lists is in the directory, measured or not.**
  `shared/official-hooks.ts` names 11 first-party hook deployments. The live
  directory reaches each through a pool its census saw, whereas this collector
  hands `createDirectory` only the pools it measured, and the Uniswap hooklist
  omits two of the eleven (WETHHook on Monad, WstETHRoutingHook on Ethereum), so
  they would be missing. The collector asks for `includeOfficialHooks`: every
  listed deployment not already in the directory is added with the id, name,
  category, description and source the live app gives it, whether or not a pool
  of it is known. It is a directory entry, not a measurement: with no measured
  pool its figures are unavailable (null), not zero. A hook the state holds a
  dynamic-fee pool of is tagged dynamic on that evidence even when the pool was
  not measured. The default (no option) leaves the directory exactly as it was,
  so the live app is unchanged, and `tests/edition-collector-truth.test.mjs`
  fails if a listed hook is missing from an offline run.
- **A pricing row's status is about the answer, not about the pools priced.**
  `marketCoverage` has a row for every network with hook pools: the networks the
  burst asked about, then (largest first) the networks it did not ask about
  (`attemptedPools` 0, `checkedPools` 0, status `unavailable`), so the totals are
  the census's and not those of the networks that were requested. A row is
  `live` when a provider answered for at least one of its pools (`checkedPools`
  above 0), even if that answer had no usable market data; it is `unavailable`
  only when the network got no answer at all, or was not asked about. A pool a
  provider answered for but did not price counts as checked and missing, never as
  measured, and certainly not as zero.
- **A network has one name.** The census calls Robinhood "Robinhood Chain";
  the directory (the Networks page) calls it "Robinhood". The snapshot's
  `inventory` and every overview file carry the directory's name, so the
  Analytics list, bars and tables agree with the rest of the page. Counts, block
  numbers and times of the census are untouched.
- **No key travels in a published file.** The census records, per network, the
  address of the data service it read the chain from. One of them (BNB Chain's)
  embeds the provider's access key in its path. Nothing in the edition uses
  these addresses, so `export-seed.mjs` no longer writes them into `census.json`,
  the committed seeds had the member removed (every other byte unchanged), and
  the assembler drops it again from whatever census it is given. The test scans
  every file an offline run writes for a path or query segment of 20 or more
  characters after `/v1/`, `/v2/`, `/api/`, `apikey=`, `key=` or `token=`, and for
  GitHub, Bearer and AWS key shapes (0x addresses and ids are not keys).
  The same scan runs over the test and script sources the edition folder copies,
  so a sample key written into a test would be caught: the tests put their sample
  keys together at run time from fragments, and none is a real secret.
- **Identity provenance.** Seeded pools come from the live app's on-chain census.
  A pool found by discovery has its hook and currencies from the v4.xyz indexer,
  an undocumented third party. DEX Screener's rows must still agree with the
  currencies, which is an independent check, but the hook address is the
  indexer's word. For a hook that only the indexer vouches for and that is not in
  the registry, the deployment description says so
  ("Hook address reported by the v4.xyz indexer...") instead of the usual
  PoolManager wording. Its `discovery` field stays `"onchain"` because the type
  allows no other value.
- **Frontier configuration is fetched as a third registry source.** The contract
  names the hooklist and chain registry only. Without Frontier's published hook
  addresses its pools would not be attributed to it (the live app does the same
  fetch). The fetch is optional: if it fails the project list is built without it.
- **Frontier's market figures are a fourth source, and Goldsky a fifth host.**
  The contract has no Frontier market data. Frontier's pools sit on its own hooks
  and a few of them carry nearly all of what its pools trade (FOREVER/ETH alone
  traded more than all the other pools of its hooks together), while the DEX
  Screener sample held one of them. The live app reads Frontier's own API for
  them, so the edition reads the same, with the same code, for three requests a
  run. The figure is volume and core reserves of Uniswap v4 pools only: the volume
  and liquidity Frontier's own site shows add trades on bonding curves and ETH held
  in curves, which the live app never counts as v4 and neither does this edition,
  so the two are not expected to agree (the owner's comparison of 10 November, `$281K`
  24h from the site, is the same pools' AMM volume at the current ETH price; its
  `$366K` liquidity is mostly curve ETH). The lower-bound mark stays on every
  Frontier sum: the listing holds the first 100 coins and Frontier counts more.
- **`inventory.running`** is kept as the live app published it. The census was
  exported while the live indexer was still running, so it is `true`; the client
  should not read it as "this edition is indexing".
- **`events` is empty.** The live registry-update feed needs a previous snapshot of
  the live app.
- **Size.** With the full seed the snapshot is about 10 MB (about 1 MB
  gzipped) and grows with the number of measured pools, up to about 21 MB if far
  more pools get priced; the real one of 28 October 2026 was 10,919,321 bytes,
  1,110,797 gzipped. The largest overview is about 0.4 MB (395,525 bytes in that
  run), status and history a few KB. Most of the snapshot is the directory
  (thousands of projects and deployments with their decoded permission flags).
  Serve it gzipped. Do not commit `public/data` from the scheduled job: deploy
  it as the site artifact and commit only `state/`.
- **Pools DEX Screener does not know** stay in state and are requested again each
  run. Their measured values are absent in the snapshot, never zero. A seeded pool
  that nobody prices keeps its place in the plan (seeded pools come first);
  discovered pools compete for the 500 places by recency, and the state cap of
  12,000 drops the least recently seen.
- **The measured cap is 8,500, not 8,000.** The design says "cap 8,000". The seed is
  exactly 8,000 pools, so any discovery displaced a seeded pool, in id order. The plan
  is now the seeded pools (up to 8,000, the priority list among them) and then up to
  500 discovered ones; the request budget is sized for it. The priority list's 1,355
  pools displace the seeded pools that went longest unanswered rather than
  enlarging the plan, which keeps the run's length and its requests as they were.
- **Gates beyond the design's.** Besides the 500 pools and 80% requested, 80% of
  the requested pools must be answered, 90% of the measured pools must be current
  at the snapshot time, the 500 are pools with a current 24h volume, and the
  volume pools may not fall below 60% of the previous history point's. They can
  only refuse more runs, never fewer.
- **A saved registry copy is not replaced by a hollow answer.** An answer from the
  hooklist, the chain registry or Frontier's configuration that passes its
  validator but has fewer than half the rows of the saved copy (Frontier answering
  `[]` over three saved chains, a hooklist cut to a handful of rows) is treated
  as a failed request: the saved copy is used, the source is reported as cached
  with its own time, and `state/registry.json` is not rewritten. If a source has
  really shrunk by more than half, remove its entry from `state/registry.json`
  to accept the smaller answer.
- **Recorded sums are to the cent.** `summary.volumeUsd`, `summary.liquidityUsd`
  and the history points are rounded to cents (a sum of many figures has float
  residue nobody measured: 339226102.0600004), and the point and the summary are
  always the same number. A pool's own figures are never rounded. The analytics
  overview files keep their exact sums: the overview validator re-derives its
  totals from the per-pool rows it carries and refuses a total that differs, so
  rounding them is not possible without rounding the pools.
- **What has been run.** The collector was exercised against the recorded
  fixtures, against fakes, and at full size (the real 8,000-pool seed, the
  recorded registry, synthetic provider answers, output to a scratch folder). The
  owner made two real runs against the live providers on 28 October 2026, from a
  PC (see "Running it on a PC that also runs Hook Radar"): the first was refused
  after a GeckoTerminal HTTP 429 and 190 of 284 DEX Screener batches, the second
  passed with 2,506 current pools (351 requests, collection from 00:05:40 to
  00:14:11 UTC). A later full run the same day passed with 2,210 current pools
  (370 requests, collection from 15:49:31 to 16:03:40 UTC, one GeckoTerminal
  rate-limit wait of 30 s). No run has yet been made from GitHub-hosted runner
  addresses, so what those addresses are allowed to do is not yet known.

## For the workflow and packaging

- The Snapshot workflow is started three times an hour by GitHub's schedule (best
  effort: runs can be delayed or dropped) and, if the owner has set up the optional
  external timer of `docs/EXTERNAL-TRIGGER.md`, three more times an hour by a call
  to GitHub's API; its first job ("Is a new snapshot due") lets one start an hour
  collect and ends the others with a green tick (see `tests/edition-gate.test.mjs`).
  A call with `force` unticked is treated like a scheduled run, so the timer must
  send `"force":"false"` and `"discover":"false"`: left out, `force` defaults to
  true and every call would collect.
- The job that collects runs `node collector/run.mjs` with `GITHUB_REPOSITORY` set,
  treats exit code 1 as "keep the last good snapshot" (skip the build and deploy
  of new data), and commits `state/` only after a passing run.
- The edition's `package.json` has these scripts for the collector: `collect`
  (`node collector/run.mjs`), `collect:offline` (the same with
  `--offline --no-publish`: a replay of the recorded fixtures that writes
  nothing) and `test:edition` (also run as `test`), which holds the collector
  tests. Seeding has no script: run `node collector/export-seed.mjs` yourself.
- Packaging copies `collector/`, `state/`, `tests/collector-*.test.mjs` and the files
  listed in `collector/IMPORTS.md`. The collector reads TypeScript modules directly
  (Node 24 type stripping), so the same Node version is needed to run it.
- Re-seeding replaces `state/pools.json` and `state/census.json` from a live
  Hook Radar app and discards the pools discovery added since (and their
  `dynamicFee` evidence): do it deliberately. `state/priority.json` is separate;
  the collector never writes it.
