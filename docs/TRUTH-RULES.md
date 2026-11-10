# Truth rules

Hook Radar is only useful if its numbers can be trusted. These rules come from the Hook Radar project and apply to this edition in full. If you change the collector, the page or the workflow, you must keep them.

## 1. Nothing is made up

The published site contains only data the collector got from the real providers. No invented statistics, no fake "live" activity, no placeholder charts, no sample data. Tests may use fixtures; fixtures never end up in `public/data/` or on the site. The page's `data` files are written only by the collector.

This is enforced, not just promised. A replay of recorded fixtures (`--offline`) marks its `status.json` with `"offline": true`. Before anything is published, `scripts/check-edition-data.mjs` refuses data that has that mark, has no `status.json`, or whose `status.json` and `snapshot.json` name different `generatedAt` times (files from two runs). The workflows run it on the files they are about to upload, `npm run build:static -- --require-data` runs it before building, and the folder assembler runs it on `public/data` and again on the finished folder. A first snapshot is required as well: the assembler stops when there is none, unless you pass `--allow-no-snapshot`.

## 2. Unknown is not zero

If a provider does not know a pool, the pool is **unresolved**, not "0 volume". A missing value stays missing (`null`) all the way to the screen and shows as unavailable. A measured zero is a real number and is kept as zero. Never turn one into the other to make a table look tidy.

## 3. Every figure keeps its own time and its source

Each measurement keeps the time it was taken and the provider it came from. Nothing is re-stamped with the current time. One pool's figures are never added to or averaged with another provider's figures for the same pool.

## 4. The five-minute rule is applied honestly

A measurement counts as current only if it was taken less than five minutes before the snapshot's time. Older ones are left out of totals. The five-minute limit is a constant of the project and is not loosened here. See [HOW-IT-WORKS.md](HOW-IT-WORKS.md) for how this edition applies it at collection time rather than at viewing time, and why the page shows absolute UTC times instead of "2 minutes ago".

## 5. Tracked is not total

The figures describe **tracked hook pools**. They are not total Uniswap volume and not a market share. The scope label stays on every figure it belongs to ("Partial coverage · Not total Uniswap volume"). Method notes belong in the collapsed Data notes and in these documents, not in banners.

## 6. Ownership needs evidence

A project is credited with a hook contract only when the registry names that exact contract. A name, a website, a platform integration or the fact that a project launches tokens on a platform proves nothing about who owns a contract. A pool shared by several projects is counted once, not once per project.

## 7. Real logos only

The site shows verified original protocol logos. Where there is none, it shows neutral artwork and never suggests that artwork is official.

## 8. Be a good guest

Respect the providers' limits: keep the gaps between requests, honour `Retry-After` and never hammer. After the first 429 that says how long to wait (a `Retry-After` in seconds or as a date, or Cloudflare's rate-limit page, taken as 30 seconds), DEX Screener, GeckoTerminal and the v4.xyz indexer each get one cooldown per run: the stated wait (at most 90 seconds), then the refused request once more. A second 429, a 429 that names no wait and every 403 stop that provider for the run. Never weaken a validator or the quality gate to look better. See [PROVIDER-TERMS.md](PROVIDER-TERMS.md).

## 9. Fail closed, stay dated

If a refresh cannot meet the quality gate, it publishes nothing. The site keeps its last good snapshot with its date. A stale-but-dated page is acceptable; an undated or half-built one is not.

## 10. Keep the identity

The page keeps the Hook Radar design: the night-sky observatory look from `DESIGN.md`, one rose signal colour, the design tokens in `src/design/`. Do not add per-view colours or fonts, and do not make it look like the site of any single project. No prototype-sounding notices in the page ("demo", "not exhaustive"); scope labels that belong to a figure stay.

Frontier is shown first in the Launchpads list whenever it is in the list being shown, under a visible "Pinned" label. That is a labelled editorial placement, not a ranking: the other launchpads keep the order of the sort the visitor chose, no figure or metric is changed for it, and no other list pins a project. The Spotlight on Discover is a separate selection that rotates: within each use case it puts projects with more website and docs links first, then orders them by a hash of the UTC date and the project id. It never uses a dollar figure, reserves no slot for any project, and is labelled "rotating, not a ranking".

## Before you change anything

Ask of each change: could a visitor read a number as more current, more complete or more certain than the data supports? If yes, change it so they cannot.
