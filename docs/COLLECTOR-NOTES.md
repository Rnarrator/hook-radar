# Collector notes

The collector is what makes the Auto Snapshot edition refresh by itself. It is a
Node 24 program (`collector/`, ES modules, no new dependencies) that a scheduled
job runs every few hours. It reads public data services, builds the data files
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
2. **Discovery (slow and polite).** For each of the 20 networks with a verified
   v4 PoolManager and a GeckoTerminal v4 DEX:
   - one GeckoTerminal top-pools page (`sort=h24_volume_usd_desc`), at least
     12 s after the previous GeckoTerminal request. The page number rotates each
     run (1 to 5, from the three-hour slot of the run) so repeated runs walk down
     the ranking;
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
   at least 400 ms between request starts. Which pools: the seeded pools first (at
   most 8,000, most recently seen first), then the pools discovery found, in what
   is left of 8,500 and at most 500. A newly discovered pool therefore never
   pushes a seeded pool out of the burst (all seeded pools share one `lastSeen`
   at first, so a single cut by recency would drop them in id order). Rows are accepted only under the live collector's
   rules (the pair address is a requested id, `dexId` is `uniswap`, labels, if
   any, include `v4`, the two currencies agree with the identity we hold). Ids
   not returned are unresolved, never zero. Right after, at most three
   GeckoTerminal `/pools/multi/` requests (up to 30 ids each, 90 in all) try the
   unresolved pools, at least 12 s apart, under the same rules. Pools GeckoTerminal
   measured last time come first (the live app's GeckoTerminal-measured pools carry
   that hint from the seed), then the largest network's unresolved pools in id order.
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
4. **Assemble.** The directory is built with the project's own `createDirectory`,
   asked for `strictFamilyNames` and `includeOfficialHooks` (see "Choices to know
   about"). Pools are attributed
   with the project's own `attributePools`
   (exact registry evidence only), `applyMetrics` aggregates per project, and the
   snapshot is built (`summary`, `coverage`, `sources`, `chains`, `inventory`,
   `marketCoverage`). The snapshot holds the registry-named projects, the
   published platforms and any project with at least one measured pool, and no
   `directory` field, so the client filters locally. Its `generatedAt` is the
   moment the burst ended and freshness is evaluated at that moment.
5. **Overview files.** `analyticsOverviewAsync` (the live server's own function)
   builds `overview-all-h1`, `-h6`, `-h24` and `overview-<network>-h24` for every
   network, with the per-pool contributions the client re-slices locally, at the
   snapshot's own time.
6. **Quality gate.** The run is refused (exit code 1, nothing written) when the
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
7. **Write.** Overview files, `history.json`, `status.json`, then `snapshot.json`
   last (it is the marker that the set is complete), then the state files.

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

## Limits and gaps (all in `collector/config.mjs`)

| Constant | Value |
|---|---|
| `DS_GAP_MS` / `GT_GAP_MS` / `V4_GAP_MS` | 400 / 12,000 / 5,000 ms between request starts |
| `DS_BATCH_SIZE` | 30 ids per DEX Screener request |
| `GT_FALLBACK_MAX_REQUESTS` / `GT_FALLBACK_BATCH_SIZE` | 3 requests of up to 30 ids |
| `MAX_MEASURED_POOLS` / `MAX_DISCOVERED_MEASURED` | 8,000 seeded pools, plus up to 500 found by discovery (8,500 in all) |
| `MAX_RESOLVES_PER_RUN` | 40 exact-pool lookups |
| `MAX_REQUESTS_PER_RUN` | 399 in all (hard stop) |
| `BURST_BUDGET_MS` / `BURST_DEADLINE_MS` | no new DEX Screener batch may start after 225 s, no request of any kind after 270 s (a wait for a gap or a `Retry-After` counts: a request that could only start later is not sent) |
| `MIN_CURRENT_POOLS` / `MIN_REQUESTED_SHARE` / `MIN_CURRENT_SHARE` | 500 / 0.8 / 0.9 (500 pools with a current 24h volume; 80% of the planned pools requested and 80% of those answered; 90% of the measured pools current) |
| `MIN_VOLUME_POOLS_OF_PREVIOUS` / `PREVIOUS_POINT_MAX_AGE_MS` | 0.6 / 24 hours: the pools with a current 24h volume against the previous history point's, compared only while that point is less than a day old |
| `DISCOVERY_BUDGET_MS` | 900,000: no discovery request starts later than 15 minutes after the run began |
| `HISTORY_MAX_POINTS` | 672 |
| `STATE_MAX_POOLS` | 12,000 |
| `REQUEST_TIMEOUT_MS`, `MAX_CONSECUTIVE_FAILURES` | 20 s; five failures in a row stop a provider for the run |
| `RATE_LIMIT_WAIT_CAP_MS` / `RATE_LIMIT_DEFAULT_WAIT_MS` | 90,000 / 30,000 ms: the longest the one rate-limit cooldown of a run waits, and the wait when a 429 names none (Cloudflare's error 1015 page without a `Retry-After`) |
| `MAX_RETRY_AFTER_MS` | 120,000 ms: the longest `Retry-After` honoured on any other status (a 503, say); beyond it the provider stops |
| `COOLDOWN_PROVIDERS` | DEX Screener, GeckoTerminal and the v4.xyz indexer: the providers that may have the cooldown (the registry and Frontier fetches have a saved copy to fall back on and are not given one) |

The request budget is reserved before discovery spends any of it: the batches the
burst needs (8,500 pools are 284 batches, plus one per network for rounding), the
fallback and the registry fetches come first, and discovery is trimmed to fit what
is left (87 requests at full size; discovery wants 80). A full-size fake run in
the tests (the seed's 8,000 pools on its 14 networks, 640 discovered pools on 20
networks, providers that answer at once) makes 382 requests: 296 DEX Screener, 20
GeckoTerminal pages and 3 fallback batches, 20 indexer lists and 40 lookups, 3
registry fetches. Its collection takes about nine minutes of provider time, of
which the burst is about two and a half. A real run varies with the networks the
new pools fall on, never above 399. A retry after a rate-limit cooldown is one of
those 399 requests. Only three providers can have one and each has one per run, so
at most three retries are added; at full size discovery is allowed 87 requests and
wants 80, which leaves room for them.

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
- A GeckoTerminal gap of 15 s keeps the three fallback requests inside the 270 s
  limit even when DEX Screener takes the whole 225 s (225 + 2 x 15 = 255 s).
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
| GeckoTerminal (`api.geckoterminal.com`) | One top-pools page per network (candidate ids), and up to three exact-pool fallback batches | Anything else |
| v4.xyz indexer (`www.v4.xyz`) | Pool identity only: which hook, which two currencies. The paths are undocumented | Any amount |
| Uniswap hooklist and chain registry (GitHub raw) | Hook deployments, project grouping, chain names | |
| Frontier deployment configuration (`api.frontier.fun/chains`) | Exact hook addresses Frontier publishes, so its pools are attributed. It is not in the contract's list; see "Choices to know about" | |

DefiLlama and CoinGecko price APIs are not used. The collector still imports the
server modules that mention them (`reserve-value.mjs` reaches them) but never calls
them.

Terms to settle before launch (the owner's decision, repeated in
`docs/PROVIDER-TERMS.md`): GeckoTerminal and CoinGecko ask for attribution (the
snapshot's GeckoTerminal source says "Data provided by GeckoTerminal" and links it); DEX Screener sets its own terms and limits and may change or end access, so read its current terms; the v4.xyz paths are undocumented
and can change without notice. A scheduled job from one cloud IP is a different
load shape from the live app's, which is why the gaps are the contract's and may
only be raised.

## State (`state/`, committed)

| File | Content |
|---|---|
| `pools.json` | `{ schemaVersion, updatedAt, pools: [...] }`, one pool per line. A pool is `id` (lowercase bytes32), `chain`, `hookAddress`, `tokens` (two lowercase addresses; the native currency is the zero address), `name`, `createdAt`, `source`, `firstSeen`, `lastSeen`, for a pool GeckoTerminal measured last time `via: "geckoterminal"` (the fallback hint above), and optionally `dynamicFee` (below). `source` is `census` for the seed (identity verified by the live app's on-chain census) or `v4.xyz` for a pool found by discovery (identity from the indexer). `updatedAt` is the previous run's `generatedAt`. |
| `hookless.json` | `chain:id` keys of pools the indexer resolved to the zero hook. |
| `census.json` | `{ exportedAt, seed: {...}, inventory }`. `inventory` is the live app's pool census as published, with its original `generatedAt`, per-network `updatedAt` and `headCheckedAt`, plus the time of the export. The one thing removed is each network's `sourceUrl`, the address of the data service the app read that network from (some embed an access key; see "Choices to know about"). The page shows it as "Census as of <date>", never as current. |
| `history.json` | `{ schemaVersion, points: [{ timestamp, value, pools }] }`, newest last, at most 672 points. |
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
least five minutes apart, the newest 672 kept, newest last) are the live app's.
The rule for which pools count is not. The live app records a point only when
every pool contributing to the total is current; this edition sums the pools that
are current at its snapshot and leaves the others out, and the quality gate
refuses a run in which fewer than 90% of the measured pools are current. A run
less than five minutes after the previous point adds none. There is no
per-project history in this edition: every project's `history` is empty.

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

## Fixtures and offline mode

`collector/fixtures/` holds 11 real responses recorded on 27 October 2026 by
`collector/tools/record-fixtures.mjs`: the hooklist, chains and Frontier
configuration; the v4.xyz lists for Ethereum and Base and one exact-pool lookup;
one GeckoTerminal top-pools page and one fallback batch; three DEX Screener
batches. Each file is the response body; `manifest.json` keeps its URL, status,
`Date` and `Age`. They drive `run.mjs --offline` and the tests. The recorder goes
through the same paced client and the same planner as a real run, makes at most
13 requests (an answer that is not HTTP 200 aborts it and nothing is written), and
was run once.
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
- `collector-imports`: `collector/IMPORTS.md` is exactly the computed import list.
- `collector-contract`: the numbers of the design written out as literals (the other
  files import the constants, so only this one notices a constant changed to pass a
  test), the 399-request budget, five failures stopping a provider, `notAfter`
  refusing a request that would start late, the 225 s and 270 s burst limits with a
  stalled `Retry-After`, and the registry: live, cached with its original time, no
  copy, Frontier optional, the saved copy's round trip through `state/registry.json`.
- `collector-fullsize`: one run at the size the job really has (above), asserting the
  request count, the minimum gap per provider, the equal share of lookups, that no
  seeded pool is dropped, and the dynamic-fee tag of every deployment.

`node --test tests/edition-collector-truth.test.mjs` (a few seconds, no
network) pins what the published data may claim: the strict family rule against the
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
  is now the seeded pools (up to 8,000) and then up to 500 discovered ones; the
  request budget is sized for it.
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

- The scheduled job runs `node collector/run.mjs` with `GITHUB_REPOSITORY` set,
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
  `dynamicFee` evidence): do it deliberately.
