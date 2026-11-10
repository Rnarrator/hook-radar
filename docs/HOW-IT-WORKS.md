# How the Auto Snapshot edition works

## The time rule, in plain words

The always-on Hook Radar server counts a price or volume figure only while it is **less than five minutes old at the moment you look**. A site made of plain files cannot do that: by the time you open it, the data is hours old.

So this edition moves the five-minute rule from the moment of viewing to the moment of collecting:

1. The collector first gathers **identity and discovery** slowly and politely: the hook registry, which pools exist, which hook a new pool uses.
2. Then it takes **all measurements in one burst**, a few minutes at most. Almost all measurements in a snapshot (at least 90% of those priced) are therefore within five minutes of the snapshot's time.
3. The snapshot's time (`generatedAt`) is the moment the burst ended. Each pool keeps its **own** measurement time, worked out from the data service's reply headers exactly as the live server does it. Nothing is re-stamped with the current time.
4. The page treats "now" as the snapshot's time when it decides what counts. A measurement less than five minutes before the snapshot counts as current as of the snapshot. An older one is left out of totals, as live Hook Radar would leave it out. The five-minute limit itself is not changed.
5. Wherever the live page would say "2m ago", this edition shows an absolute time ("measured 14:03 UTC"). One line at the top states when the snapshot was taken and how old it is. That age is the only thing worked out from your own clock, and it is for display only.

This is a deliberate, labelled difference from the live application. It is not "the same freshness, cheaper".

## What is sampled

The edition does not index every hook pool on every network. It follows a **sample**:

- `state/pools.json` holds the hooked pools the edition knows. It was started from the live application's public data and grows a little each run through discovery.
- Discovery looks at one page of each network's top pools by 24-hour volume on GeckoTerminal per run, rotating through the pages. A pool that is new to the edition is checked once against the v4.xyz indexer to learn which hook it uses. A pool with no hook is remembered in `state/hookless.json` and never looked up again.
- Measurement asks DEX Screener for the known pools in batches, and keeps only rows that agree with the pool asked for: the same pool address, Uniswap, version 4, matching tokens. A pool the service does not return is shown as **unresolved**, never as zero. A small fallback request to GeckoTerminal can cover some of them.
- Projects come from the Uniswap hook registry. A project is credited with a pool only when registry evidence names that exact hook contract. A name, a website or a platform integration never earns ownership.

So the figures describe **the tracked hook pools**. They are not total Uniswap volume and not a market share.

## Quality gate

A snapshot is published only if it passes. The collector refuses, exits with an error and publishes nothing when:

- fewer than 500 hooked pools carry a current 24-hour volume (a volume of zero counts, a pool with only a liquidity figure does not),
- a provider rate-limited it, or the burst ran out of time, so that fewer than 80% of the known pools were requested,
- fewer than 80% of the pools that were requested were answered, so a provider that fails on and off cannot pass because its failures were not in a row,
- fewer than 90% of the pools that carry a measurement are current at the snapshot's time,
- fewer than 60% as many pools carry a current 24-hour volume as behind the previous snapshot's point, when that point is less than a day old (a sample that shrank to a fraction is not recorded as a fall in volume), or
- the data does not pass the same checks the page uses to read it.

When a run is refused the site simply keeps the previous snapshot. A green run can still have had one provider stop: a provider stopping fails a run only when it leaves too few pools behind (fewer than 80% of the planned pools requested, or fewer than 80% of the requested pools answered, as above), so a run can pass with a few GeckoTerminal pages missing. The Data & sources dialog and `data/status.json` say which providers answered and which did not.

## Being polite to data services

The collector introduces itself with a truthful User-Agent naming the project and its repository. It keeps a fixed gap between requests to each provider (at least 12 seconds for GeckoTerminal, 5 for the v4.xyz indexer, 0.4 for DEX Screener), honours `Retry-After`, and never hammers: after the first 429 that says how long to wait (a `Retry-After` in seconds or as a date, or Cloudflare's rate-limit page, taken as 30 seconds), a price or pool provider is waited for once (at most 90 seconds), asked once more and given a doubled gap, and **a second 429, a 429 that names no wait or any 403 stops the provider for the rest of the run**. A run makes fewer than 400 requests in total. The gaps can be raised by environment variables but never lowered. [PROVIDER-TERMS.md](PROVIDER-TERMS.md) says what each provider asks of you.

## What the site reads

Everything is a static file under `data/`:

| File                                                                      | What it is                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data/snapshot.json`                                                      | The snapshot: measured pools, projects, coverage, which providers were used and how many requests each took                                                                                                                           |
| `data/overview-all-h1.json`, `-h6`, `-h24`, `overview-<network>-h24.json` | The Analytics overview for each time window and network, computed by the project's own analytics code from the same snapshot                                                                                                          |
| `data/history.json`                                                       | One point per successful run: total tracked 24-hour volume and the number of pools behind it. At most 672 points, newest last (about twelve weeks at eight runs a day, if no run is skipped; GitHub may delay or drop scheduled runs) |
| `data/status.json`                                                        | When the run started, when the measurement burst started and ended, counts, sources and the collector version                                                                                                                         |

The page never asks a server anything. Anything that needs one is switched off.

## What differs from live Hook Radar

| Live                                                                                                       | Auto Snapshot                                                                          |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Figures expire five minutes after measurement, at your clock                                               | Figures are judged at the snapshot's time and shown with absolute UTC times            |
| Refreshes continuously                                                                                     | Refreshes about every three hours                                                      |
| Indexes every hooked pool it can find                                                                      | Follows a sample of known pools; pools it does not know are not shown                  |
| Activity view and Refresh button                                                                           | Switched off, leaving no dead controls                                                 |
| Per-project history recorded by the server; a network-wide point only when every pool behind it is current | One network-wide point per successful run, and no per-project history                  |
| A link to Activity opens the Activity view                                                                 | A link to Activity lands on Discover, because Activity is switched off                 |
| Frontier's extension explorer, with extension selections in links                                          | Switched off; an extension selection in a link is ignored                              |
| Inventory counts from its own index                                                                        | Counts from a census export, shown as "Census as of" its own date and never as current |
| Needs a server and a database                                                                              | Needs only a place to put files                                                        |

## History and what is kept

`state/history.json` gains one point per successful run and is cut to the last 672. A run that fails adds nothing. The history is real measurements only: a gap in the chart is a gap in the data, not something filled in.

## Where things happen

1. The Snapshot workflow starts (every three hours, or by hand).
2. `node collector/run.mjs` collects, assembles, checks and writes `public/data/` and `state/`. If it exits with an error the workflow stops here.
3. `npm run build:static` builds the page into `dist/`, with the data files beside it.
4. `state/` is committed back to the repository.
5. GitHub Pages publishes `dist/`.

To look at it on your own computer: `npm ci`, `npm run build:static`, `npm run preview`. The folder as delivered has its first snapshot in `public/data`, kept out of Git by the folder's `.gitignore`, so a copy cloned from GitHub has none until a Snapshot run has produced one; it then needs the published address, or a collect (see the developer notes in [COLLECTOR-NOTES.md](COLLECTOR-NOTES.md)).
