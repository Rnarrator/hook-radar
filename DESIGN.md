# Hook Radar · Observatory design system

Hook Radar reads the Uniswap v4 hook ecosystem the way an observatory reads the sky: patiently, precisely, with calibrated instruments and honest error bars. This document is the contract for every screen. The tokens live in `src/design/`; this file explains how to use them.

## Visual thesis

**Midnight-ink ground, hairline instrument linework, one signal.** Type carries the hierarchy: the pixel face (Press Start 2P) for titles, the wordmark and key figures, Geist for interface text and anything read as a sentence, Geist Mono for addresses and labels. Surfaces are separated by rules and whitespace first, boxes second. Pink is the *sweep*: it marks selection, live state and the primary action, and almost nothing else. Brass marks measurement and provenance. Lagoon marks current and healthy. Depth is restrained: one key light from the upper left, a hairline top highlight, three elevations. The signature artifacts are the dial-and-hook mark, the radar sweep (active-nav tick, loading scan, masthead instrument), plate captions that always state *what is measured, over what scope, how fresh*, and the evidence dial.

Not allowed: endless identical cards, decorative gradients or glowing borders (the one soft pointer light on instrument plates is a hover affordance, not a decoration at rest), glassmorphism, marketing heroes above useful information, meaningless badges or decorative statistics, text under 12px, low-contrast text, generic crypto imagery.

## Files

| File | Role |
| --- | --- |
| `src/design/fonts.css` | Self-hosted Geist and Geist Mono (Latin + Latin-ext woff2) and the bundled Press Start 2P TTF, scaled with `size-adjust: 56%` |
| `src/design/tokens.css` | Colour, type, space, shape, depth, motion, focus, z-index |
| `src/design/base.css` | Document, headings, links, focus, scrollbars, `.sr-only`, `.kicker`, `.num`, `.mono`, `.address` |
| `src/design/components.css` | `.control`, `.primary-button`, `.icon-button`, segmented controls, fields, chips/tags, `.notice`, `.empty-state`, `.modal`/`.drawer`, `.toast`, `.skeleton`, `.panel`, `.plate`, `.readout` |
| `src/design/shell.css` | Horizon bar, nav, page header (`.titlebar`), coverage strip, compare tray, footer, loading screen |
| `src/design/discover.css`, `masthead.css`, `dialogs.css` | Discover table/guide/filters, the masthead and radar instrument, dialog content and workspace states |
| `src/design/polish.css` | Small details, loaded before compact.css: the pointer key light on plates, the stepped scan-in of key figures, the travelling navigation indicator, the logo sweep, the empty-state instrument, the scroll lift of the horizon bar and the `data-fit` rules. All motion is behind `prefers-reduced-motion: no-preference` |
| `src/design/compact.css` | Loaded last. Short-viewport (max-height 62rem) and tablet-width compaction of the masthead and spotlight so the first project row is visible without scrolling; the 44px clear-search rule; the pinned status-strip height |

All design CSS is plain, unlayered CSS using only these tokens. The pre-Observatory stylesheets and their aliases (`--pink`, `--muted`, `--panel`, …) were removed once every view was rewritten.

## Tokens in use

* **Ground & surfaces:** `--ground`, `--surface-1…4`. Page = ground; plates = surface-1; hover/raised = surface-2/3; selected = surface-4.
* **Rules:** `--rule` (hairline), `--rule-strong`, `--rule-focus`.
* **Ink:** `--ink`, `--ink-soft` (body secondary), `--ink-muted` (captions; the floor for meaningful text), `--ink-faint` (quietest step; still AA on ground, surface-1 and surface-2).
* **Signal:** `--signal`, `--signal-hover`, `--signal-wash`, `--signal-line`, `--on-signal` (text on a signal fill).
* **Instrument accents:** `--brass` (measurement/provenance/warning), `--lagoon` (current/healthy), `--iris`, `--sky`, `--violet`, `--ember`, `--mist`, `--danger`.
* **Use-case colours** (chips, legends, every chart): `--cat-launches|liquidity|fees|mev|orders|oracles|access|other`. Use `categoryColor(name)` semantics: the same use case is the same colour on every screen.
* **Type:** `--font-display`, `--font-ui`, `--font-data`; sizes `--fs-micro` 12px, `--fs-small` 13px, `--fs-body` 15px, `--fs-lead` 17px, `--fs-h3` 18px, `--fs-h2` fluid 24–30px, `--fs-h1` fluid 36–60px, `--fs-stat` fluid 32–52px.
* **Space:** `--s-1…8` (4px grid), `--gutter`, `--content-max` 1440px.
* **Shape/depth/motion:** `--r-1/2/3/pill`; `--elev-1/2/3`, `--key-light`, `--edge-light`; `--ease-out`, `--dur-1/2/3` (collapse to ~0 under reduced motion); `--focus-ring`.

## Typography

| Use | Face | Spec |
| --- | --- | --- |
| Wordmark, page title (`h1`), plate/section titles that use `--font-display` | Press Start 2P (pixel) | `--fs-h1` / `--fs-h2`; the face is scaled by `size-adjust`, so a 3.75rem title renders near 33px and a 2rem figure near 18px |
| Key figure (`.readout-value`) | Press Start 2P | `--fs-stat` |
| Section/plate title (`h2`,`h3`) | Geist 600 | `--fs-h3` / body |
| Body / controls | Geist | 15px / 13px for dense controls |
| Table figures, addresses, hashes, chain IDs | Geist Mono, tabular | 13px, `.num` / `.address` |
| Captions & kickers | Geist Mono uppercase, `--tracking-caps` | 12px, `--ink-muted` |

The pixel face is for short display text only (about 60 characters at most): never for sentences, table cells, captions or anything under about 11px rendered. Reading passages (for example the Learn lead) stay in Geist. It has one weight and no italic, so never bold or italicise it. Numbers always use tabular figures. Align numeric columns right. Long addresses wrap with `overflow-wrap:anywhere` or use a middle-truncated form with the full value in a `title`/copy action. **No text below 12px.**

## Layout

* `main` is `--content-max` wide with `--gutter` padding. Page header is `.titlebar` (title left, controls right, hairline below). Sections are separated by `.panel` rules (`border-top`), not boxes. Use **`.plate`** (framed, key-lit surface) only for instruments: charts, key readouts, the spotlight. Do not nest plates.
* Prefer a clear editorial asymmetry (a primary column and a narrower contextual column) over uniform grids of equal cards. Rows of repeated items are tables or lists, not card walls.
* Every chart or measured readout sits under a **plate caption**: *title · metric · scope · window · freshness* (e.g. “Tracked 24H hook-pool volume · All networks · 5,624 measured pools · updated 4m ago”).
* Mobile: single column, 16px gutters, 44px touch targets for primary controls (40px minimum elsewhere), horizontal scroll only inside tables/charts that declare it, no page-level horizontal scroll at 320px. Below 60rem the nav is a bottom dock; leave `5.5rem` of bottom clearance. **Discover shows the first project row above the fold** at 1280×800, 1280×720, 1024×768 and 768×1024; the full masthead plate appears only on viewports taller than 62rem, the compact one otherwise. The ecosystem-stats band is collapsed by default at every width, behind the Stats toggle. The status strip's actions and the footer links are 40px tall below 60rem, and the strip's loading message has the same height, so the buttons that replace it move nothing; on phones the actions always take the strip's second row. The light and the full layouts say the same thing about data coverage (`src/coverage-summary.ts`: "N of M networks up to date", with a short form for phones) and use the same status dot. Page-level loading states (`WorkspaceBoundary page`) are 85vh tall, so the footer is already below the screen when the page arrives. The footer's **Shortcuts** link and the `?` key open a list of the keys the page already answers to (`ShortcutsDialog`); the link is hidden on touch screens (`(hover: hover) and (pointer: fine)`). A reviewed finding (a platform's availability) is shown as its first sentence, then the remaining sentences as a short list, never as one paragraph (`src/evidence-note.ts`; the words are not changed); the review date has its own line and one date format (`src/review-date.ts`). A panel that could only say there is nothing to show is left off the page, with its jump link, and the sections after it keep their numbering (the all-network history panel when no series is recorded; a network's page keeps its pointer to that series only when it is known to exist). The reason lives in the methodology list of Data & sources and in the README, not in a card. **Data-saver mode** (`src/data-saver.ts`): when the browser sends Save-Data or prefers reduced data, Discover and the map do not download the full snapshot unasked; the strip offers **Load analytics** instead, and a saved watchlist still loads it.

## Components (class contracts)

Use existing class names so behaviour and tests keep working; add modifiers rather than renaming.

* Buttons: `.control` (secondary), `.control.selected`/`[aria-pressed=true]`, `.primary-button` (one per surface), `.icon-button` (needs `aria-label`), `.detail-text-action` (quiet).
* Segmented: `.segmented` (+ `button[aria-pressed]`), `.window-switch`, `.index-scope-switch`.
* Fields: `.search-box`, `.select-control` (label + `select` + chevron), `.field`.
* Chips: `.category-tag` (+ `data-category="Launches"` for the colour dot), `.tag`, `.chip`.
* Feedback: `.notice` (`.error-notice`), `.empty-state` (via `Empty` in `components/Primitives.tsx`), `.toast`, `.skeleton`, `.spin`, `.status-led` (`.green` = current, `.amber` = attention; only `.green` pings).
* Overlays: `Modal` in `components/Primitives.tsx` (dialog or drawer). Do not build another dialog implementation.
* Utility icons: Lucide via `components/Icons.tsx`; for a glyph that is not exported there, import it from `lucide-react` directly and render it with `aria-hidden="true" focusable="false"`. **Protocol artwork** comes only from `protocol-logos.ts` / `ProtocolLogo`; never invent or recolour a protocol logo.

## Data visualisation rules

1. **Truth first.** Only real observations. Never interpolate across unknown intervals (break the line), never fabricate points, candles, trends or comparisons. Do not sum overlapping rolling-volume observations as additive period volume. Measured zero ≠ unavailable: show `0` or `—` accordingly, with an explicit “not measured” state.
2. **Denominators in plain sight.** Every share/percentage states its denominator (e.g. “of tracked 24H hook-pool volume”). Top-N shares must say “of tracked volume”, never market share. The label is **Tracked hook-pool volume**, accompanied wherever totals appear by “Partial coverage · Not total Uniswap volume”.
3. **Conventional charts stay 2D.** Bars, lines, scatter, stacked bars, treemaps. No donuts or 3D bars. Choose the form that suits the data (comparison → ranked bars; change over time → line with gaps; relationship → scatter with log axes; composition with exact area → treemap; evidence quality → stacked bar/dial).
4. **Axes and units.** Labelled axes with units and compact numbers (`$1.2M`, `4.5K`), exact values on inspection (`$1,234,567.89`), log axes labelled “log”. Time axes show the zone (UTC unless noted) and the original measurement time on inspection.
5. **Inspection.** Pointer hover shows a crosshair/tooltip with exact value, series, scope and measurement time. Keyboard: the plot is focusable (`tabindex=0`, role `application` or a labelled `group`), arrow keys step through points, Home/End jump, Escape clears, a visually hidden live region announces the inspected value, and a “View as table” disclosure exposes the same data as a real `<table>`. Selected state persists and is shared with linked tables/charts.
6. **Colour.** Categorical = `--cat-*` tokens (use-case). Networks use a stable per-network hue derived once (not by rank). Sequential = single hue ramp from `--surface-4` to `--signal`. Never use colour alone: pair with labels, patterns or position. Selected = full-opacity series + `--ink` outline; unselected = 35–45% opacity.
7. **States.** Every chart has designed loading (skeleton with the same frame), empty (“No measurements in this scope” + why), partial (visible coverage badge), error (message + retry) and stale (brass freshness label) states. Mobile: charts reflow or become scrollable with a visible hint; tooltips become tap-to-pin panels.
8. **Exports** where supported keep the same scope and clocks as the screen (CSV with original timestamps).

## Motion

State changes get 120–320ms ease-out settles. Nothing loops unless it communicates live state (status ping, loading scan). The masthead radar sweep is the only decorative loop; it pauses offscreen/hidden and is static under `prefers-reduced-motion`. Single, short, interaction-driven details are allowed: the navigation indicator travelling to the current page, a key figure's one stepped scan-in when it appears, the logo's one sweep on hover, the soft pointer light on plates (fine pointer only) and the horizon bar lifting once content scrolls beneath it. Animate `transform`, `clip-path` or box-shadow, never the opacity of text, so contrast checks and screenshots stay true. Under reduced motion the durations collapse (tokens) and **every element gets a 0.01ms transition** (base.css), so computed styles lag one frame: code that measures right after changing styles must set `transition-property: none` first (see `src/fit-figures.ts`).

## Details and instruments

* **Jump palette** (`CommandPalette.tsx`): the `Modal` primitive's `palette` variant, a combobox over a listbox. Ctrl/⌘ + K toggles it everywhere except over another dialog (two dialogs would fight over the page's `inert` state). Every command reuses a control or navigation that already exists (Refresh is offered only while the page's own Refresh control would work, and a directory search starts from default filters); it adds no data and no state of its own except a browser-local list of recent choices. The header button appears only where the bar has room (icon from 1340px, icon with the key hint from 1440px, the label as well from 1600px, icon in the phone layout down to 336px, hidden elsewhere); the footer's **Jump to** link opens it at every width, and the shortcut is Ctrl+K, or ⌘K on Apple devices. A pasted address is decoded with the same caveats as Learn: permissions only, never a statement about what a hook does.
* **Permission fingerprint** (`PermissionGlyph.tsx`, `src/hook-permissions.ts`): fourteen cells, before over after for the five pool operations, then round cells for the four returns-delta flags (the two liquidity deltas exist only as after flags, so they sit in the after row of their own columns, labelled Δ add and Δ rem., with nothing in the before row). Filled = enabled, empty = off, **dashed = not reported**: a missing flag key is unknown, never off. It has an accessible name listing the enabled callbacks, or is `decorative` when the same facts are written beside it. The address decoder in Learn uses the same module; the unit test checks it against every audited registry hook.
* **Loading frame** (`LoadingPlates.tsx`): under the loading message, the page's own proportions drawn with the shared shimmer (figure row and plate for Analytics and Chains, rows for lists). It is `aria-hidden`, holds no text or numbers, and never stands in for a chart.
* **Copy confirmation** (`copy-feedback.ts`): after a successful copy the button that was used turns the healthy accent for 1.4 s (plus a small scale under motion). The toast still carries the message.
* **Callback signature** (`CallbackSignature.tsx`, `callbackSignature` in `src/comparison.ts`): the same grid summarising a project's classified hooks, in the project drawer's "Trading & contract controls" disclosure (a small decorative copy sits in its summary row from tablet width up; the labelled grid is in the opened panel, so the first screen keeps the pools) and as a row in Compare with a key for the four cell states. A cell is filled when every hook that reports the callback enables it, filled to a level (not shaded) when only some do, empty when none do, and dashed when no hook reports it. The drawn level of a partly filled cell is clamped to 25–75% so it never reads as empty or full; the true share ("under 1%", "over 99%" at the ends) is in the cell's title. The one-line reading ("5 on every hook · 3 on some") and the accessible name use the same counts as the callback table.
* **Fingerprint cells** name themselves on hover (callback, state, and what an enabled callback does).
* **Launchpads list**: each reviewed platform's tracked volume and reserves are the measured pools (younger than five minutes) of the hooks its own sources publish, matched by exact network and address; a note under the figures says how many of those hooks have a priced pool, or why there is no figure (shared hooks are counted under their protocol, Doppler for example; no hook published; no current price). A measured zero stays $0, an unavailable figure stays a dash. **Frontier is pinned first** in this list whatever the sort, at the owner's request, with a visible "Pinned" label and a hover note; every other row keeps the chosen order, and no figure is changed for it. The Discover table stays ordered by volume with no pin.
* **Plain words first** (written for someone who has never used DeFi): the first screen of every page says in one sentence what it is for, using everyday words. Discover opens with a sentence on what a hook is and a link to Learn; its four figures are Projects, Hooks, Pools and Networks, each with a short note and a longer plain hover explanation. The pages are named for what they show: **Discover, Analytics, Projects, Networks, By use case, Compare, Watchlist, Learn** (in that order in this edition, which has no Activity page, adds the Projects page and lists the guide last; the live service has Activity, has no Projects page and lists Learn second: explain first, then numbers). Method detail (coverage, clocks, evidence) stays available but is never the headline: the data status line says "20 of 22 networks up to date", the longer explanations sit in Data notes. Use one word per idea across pages, and keep the truth rules (partial coverage, not total Uniswap volume) in plain sentences rather than removing them.
* **Header status pill** (the live service's; this edition's page has none unless `EDITION_SOURCES_DIALOG` in `src/edition.ts` is set to `true`) shortens its longer messages on narrow phones (30rem and below; in the tight bar at 961–1056px the full wording is kept and ends in an ellipsis): "History current", "Unavailable", "Checking data", "Finding pools", "Connected". The title and the Data & sources dialog keep the full wording; the pill is never cut off mid-word.
* **Tablet widths (833–1152px)**: the masthead controls drop under the four figures (1024px and below), the directory toolbar takes its own row (up to 1088px), and the directory table keeps its Compare and Open actions pinned to the right edge while it scrolls sideways.
* **Expired totals**: when a row's figure has expired but its pools still hold current measurements, the caption says "Refreshing · 3m ago" ("Refreshing total · measured 3m ago" in the roomier readouts; phone cards: "Totals are refreshing") rather than repeating a pool count under a dash. A figure is never shown stale.
* **Fallback mark** (`fallback-mark.ts`, drawn by `ProtocolLogo`): where a project has no verified logo (or its artwork fails to load) the plate shows a small symmetric 5×5 pixel pattern generated from the project id, with one or two cells in the signal colour. It is abstract on purpose (never a logo, never text), the same id always draws the same mark, it encodes nothing about the project, and the plate's title still says "no verified protocol logo". It replaced a dash. Forced-colors uses system colours.
* **Light plate** (`data-plate="light"`, `ProtocolArtwork.plate`): an original that is dark on transparent, or that colours itself by the visitor's colour scheme, sits unaltered on a light plate (a layer under the image with `color-scheme: light`) instead of being recoloured. Only Noice and Hooke use it; the manifest records why.
* **Figures stay on one line** (`fit-figures.ts`): the pixel face is wide. A figure that would overflow its box steps its font size down to at most 60% (past that it wraps as before). It sets `data-fit`, `--fit` and an inline font-size; the text is never changed. New places that show a number in the pixel face are added to its selector list.

## 3D policy

Used for exactly two things: the masthead **Radar instrument** (lazy-loaded WebGL, static SVG fallback) and a dimensional treatment of the spotlight (CSS 3D tilt/turntable). Both are decorative or editorial and must never encode financial data: the instrument carries no text, numbers or captions and is aria-hidden. Heavy scenes lazy-load, pause when hidden/offscreen, respect reduced motion, and have a polished no-WebGL fallback. Core content never depends on them.

## Truth and tone (non-negotiable)

No fabricated statistics, activity, prices, timestamps, deployments, coverage or verification results. `null` ⇒ unavailable (`—`); a measured zero is `0`. Preserve original measurement clocks and freshness expiry. A platform listing never implies hook ownership; shared infrastructure is never double-counted. Frontier is one relevant project among others: its place first in the Launchpads list is a labelled editorial pin, not a ranking, and no figure is changed for it; no Frontier branding in the shell, spotlight rotation never implies performance or sponsorship.
