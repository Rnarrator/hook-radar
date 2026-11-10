# Hook Radar chart kit (`src/charts/`)

Accessible, data-honest chart primitives in the Observatory design system.
Built for Analytics; written so Chains, Activity and others can reuse them.
Import from `src/charts` (`index.ts`); each component pulls in `charts.css`.

The kit draws what it is given. It never fetches, aggregates, interpolates,
renormalises or fills missing values: shape numbers in a data module
(`src/analytics*.ts`, `src/history-chart.ts` …), test them there, and pass the
results in. `null` means unavailable and is drawn as unavailable; `0` is a
measured zero and is drawn as zero.

## Rules every consumer keeps

- **Real observations only.** Lines break at unknown intervals (pass `gaps`);
  every vertex is a stored observation; markers are exact positions.
- **Stated denominators.** Bar length and percentages are fractions of a
  denominator you name in the caption ("of tracked 24H volume"), never of the
  largest visible bar. Top-N is never market share.
- **Plate captions** say what is measured · scope · window · freshness.
  Totals of tracked volume carry "Partial coverage · Not total Uniswap volume".
- **Colour.** Use cases → `useCaseColor()` (`--cat-*` tokens). Single-series
  charts use one neutral colour (`SERIES_COLOR`); colour follows the entity,
  never its rank. Selection is `--signal`; unselected marks dim to ~40 %.
  Text never wears a data colour.
- **Inspection.** Pointer hover previews (mouse only), click/tap pins, the plot
  is a focusable `role="slider"` (Arrow keys, PageUp/PageDown, Home/End,
  Escape clears). Touch devices get no floating tooltip: the pinned selection
  is shown in a panel you render next to the chart.
- **Every chart has a table twin** (`ChartFrame` → `table`), rendered only
  while open.

## Formatters (`format.ts`) — pure, `en-US`, UTC

| Function | Output |
| --- | --- |
| `formatMoneyCompact(v)` | `$1.2M`, `$0`, `<$0.01`, `—` (identical to `money()` in `model.ts`) |
| `formatMoneyExact(v)` | `$1,234,567.89`, tiny values with significant digits, `Not available` |
| `formatMoneyFull(v)` | every recorded digit (`$1,234,567.891234567`) |
| `formatMoneyAxis(v)` | tick labels; distinct sub-cent labels, never `<$0.01` |
| `formatCount(v)` / `formatCountCompact(v)` | `41,256` / `41.3K`, `—` for null |
| `formatPercent(share)` | `40%`, `<0.1%`, `—` (input is a fraction) |
| `formatUtc(ms)` | `Oct 23, 2026 · 10:04:27 UTC` (milliseconds only when recorded) |
| `formatUtcClock(ms)` / `formatUtcTick(ms, spanMs)` | `10:04:27 UTC` / axis label pair |
| `formatAge(ms)` | `42s`, `4m 58s`, `3h 12m`, `2d 4h` |
| `parseClock(iso)` | epoch ms or `null` |

## Scales (`scales.ts`)

- `numericAxis(values, "log" | "linear")` → `{ kind, position(v) → 0…1 | null, ticks }`.
  Data-fitted; log axes span whole decades, linear axes start at 0. Tick
  values are real decimals at the exact transformed position.
- `thinTicks(ticks, pixelSpan, minGap = 70)` keeps endpoints, drops colliding labels.
- `zeroBasedScale(values)` → `{ maximum, ticks }` (nice maximum, quarter ticks).
- `timeTicks(start, end, maxTicks)` → UTC-aligned tick times (axis only).
- `nearestIndex(sortedTimes, t)` — binary search, first duplicate wins.
- `gapSegments(times, gapMs)` → `{ segments, gaps }` for `LineChart`.

## Components

### `ChartFrame`
The plate. Renders a `<section>` named by its title (a landmark region).

```tsx
<ChartFrame
  title="Volume by network"            // h3 (headingLevel={2} for step titles)
  kicker="Who contributed"              // optional mono caps line
  caption={<>Tracked 24H hook-pool volume · 5 measured networks</>}
  freshness={{ label: "oldest 4m 58s old", tone: "current", dateTime, title }}
  badge="Partial coverage · Not total Uniswap volume"
  controls={<SegmentedControl />}       // header right
  legend={<Legend />}
  state="ready" | "loading" | "empty" | "partial" | "error" | "stale"
  message={{ title, description, action }}  // shown for empty/error/stale
  table={{ summary: "View as table", count, render: () => <table/> }}
  actions={<button className="control">CSV</button>}  // export slot
  footnote={<p>Method notes…</p>}
  plate                                   // default true; false = bare section
  {...htmlAttributes}                     // id, data-*, className…
>
  {chart}
</ChartFrame>
```

`loading` with no children shows a skeleton in the same frame; with children
it holds the previous render (no skeleton flash). `ChartAnnouncer({ message })`
is a polite live region for announcements made outside a focused slider (for
example Previous/Next buttons).

### `LineChart`
Time series of stored observations.

Props: `times` (ms, ascending), `values`, `keys` (stable identities),
`segments`/`gaps` (from `gapSegments` or `historyChartSegments`), `yScale`
(`zeroBasedScale`), `selected`, `onSelect(i)`, `onHover(i | null)`,
`onClear()`, `formatAxisValue`, `formatValue`, `ariaLabel` (chart group name),
`sliderLabel`, `valueText(i)` (slider `aria-valuetext`), `describedBy`,
`seriesLabel`, `scopeLabel`, `gapTitle(from, to)`, `gapLabel`, `maxMarkers`
(default 80; above it only isolated observations get dots), `disabled`.

Classes for tests: `.chart-line`, `.chart-gap` (one per unknown interval),
`.chart-observations` (one path, one zero-length round-capped subpath per
marker), `.chart-slider` (the focusable `role="slider"`).

### `BarList` / `BarTrack`
Ranked horizontal bars; each row is a toggle `<button aria-pressed>`.

```tsx
<BarList
  label="Volume by network values"       // list name
  rows={[{ id, label, sublabel, valueLabel, exactLabel, shareLabel,
           share,            // 0–1 of the stated denominator; null = unmeasured
           overlay,          // 0–1 focused portion (cross-filter), optional
           overlayColor, color, swatch, leading, ariaLabel, dimmed }]}
  selectedId={id | null}
  onSelect={(id | null) => …}            // Escape on a row clears
  limit={8} expandLabel={(n) => `Show all ${n} networks`}
  ranked                                  // 01, 02 … numbering
  empty={<EmptyState/>}
/>
```

A measured zero draws a zero tick (`data-zero`), an unmeasured value a hatched
track (`data-unmeasured`) — never a zero-length bar that looks like zero.
`BarTrack` is the same track for custom rows (tables, ranked projects).

Bars grow from the baseline once, in order, when a list first appears (the
fill's `style.width` is never animated from zero, so its measured value stays
exact; the grow is a `scaleX` animation behind `prefers-reduced-motion:
no-preference`, staggered by `--row-index`). Hover or selection lights a signal
rail on the row.

### `Ribbon`
One horizontal composition bar: segment length is the share of a stated total,
2px of surface between neighbours, 4px rounded outer ends. Segments are toggle
buttons that select the same focus as the ranked bars; a legend repeats names
and shares for sighted readers and is `aria-hidden` (the segments carry the
names). A grouped tail ("5 other networks") or an unassigned remainder is drawn
and listed but is not selectable (`inert`; the remainder is hatched).

```tsx
<Ribbon
  label="Volume by network, composition"
  segments={[{ id, label, value, color, valueLabel, shareLabel, ariaLabel, inert?, hatched? }]}
  selectedId={id | null}
  onSelect={(id | null) => …}
/>
```

Shape the parts with `src/analytics-composition.ts` (`compositionParts`): it
drops unmeasured and zero parts, groups the tail, and returns any part of the
total no row accounts for as an explicit remainder instead of stretching the
others. Network parts use one periwinkle stepped by rank (every step is at
least 3:1 against the plate); use-case parts use the fixed use-case colours.

### `RatioMeter`
A 4px meter for one measured ratio already printed in words beside it; hidden
from assistive technology; `null` draws nothing (unknown is not zero).

### `Scatter`
Relationship of two positive measurements on `numericAxis` axes. Nearest-point
picking (28 px radius), hover tooltip (`tooltip(i)`), focusable slider,
`hollow` points (e.g. unattributed), `dimmed` points (focus). Label log axes
in `xLabel`/`yLabel` ("USD (log)").

### `StackedBar`
One 100 % bar for partitions such as evidence quality. `segments` must sum to
`total` (the component never renormalises; withhold the chart when counts do
not reconcile). Non-zero segments keep ≥ 2 px; the legend carries exact counts
and "% of <denominator>". `hatched` marks absent states.

### `FreshnessWindow`
Where contributing measurements sit inside a qualification window (e.g. five
minutes): `now`, `maxAgeMs`, `oldest`, `newest` (original source clocks),
`count`, `label`. Draws only real clocks.

### Hooks
`useElementWidth(fallback)` (ResizeObserver), `useCoarsePointer()`,
`inspectionKeyHandler({ count, index, onSelect, onClear })`.

## Not included

- **Treemap** — not built: no current Analytics data needs exact-area
  composition beyond ranked bars. Add it only when real data supports it.
- **Per-network hues** — single-series network bars use one neutral colour:
  all eight accent tokens are use-case colours, so a second categorical system
  would collide. If a view must colour networks, add a slug-keyed (never
  rank-keyed) palette here and validate it for colour-vision deficiency.
- **Donuts / 3D** — never.

## Known palette limitation

The use-case tokens fail an adjacent-pair colour-vision check (orders / MEV /
oracles are close under deuteranopia). Every use-case mark therefore also has a
text label (bars) or a labelled, filterable legend plus tooltip and table
(scatter). Do not rely on use-case colour alone.
