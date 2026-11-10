/** Chart kit scales. Positions are fractions (0 = start of the plot, 1 = end);
 * components map fractions to pixels. Tick values are real decimal landmarks
 * whose positions use exactly the same transform as the data, so rounding a
 * label can never move an observation. */

export type AxisKind = "linear" | "log";

export interface AxisTick {
  value: number;
  fraction: number;
}

export interface NumericAxis {
  kind: AxisKind;
  /** Fraction for a value, or null when the value cannot be placed (≤ 0 on a
   * log axis, non-finite, negative). */
  position: (value: number) => number | null;
  ticks: AxisTick[];
}

/** A data-fitted axis for positive measurements (scatter plots). Linear axes
 * start at zero; log axes span whole decades around the data. Returns null
 * when no positive finite value exists. */
export function numericAxis(
  values: readonly number[],
  kind: AxisKind,
): NumericAxis | null {
  const positive = values.filter(
    (value) => Number.isFinite(value) && value > 0,
  );
  if (!positive.length) return null;
  let low = Infinity;
  let high = -Infinity;
  for (const value of positive) {
    if (value < low) low = value;
    if (value > high) high = value;
  }
  const minimumLog = Math.log10(Number.MIN_VALUE);
  const maximumLog = Math.log10(Number.MAX_VALUE);
  let minimum =
    kind === "log" ? Math.max(minimumLog, Math.floor(Math.log10(low))) : 0;
  let maximum =
    kind === "log" ? Math.min(maximumLog, Math.ceil(Math.log10(high))) : high;
  if (minimum === maximum) {
    minimum = Math.max(minimumLog, minimum - 0.5);
    maximum = Math.min(maximumLog, maximum + 0.5);
  }
  const position = (value: number) => {
    if (!Number.isFinite(value) || value <= 0) return null;
    const result =
      kind === "log"
        ? (Math.log10(value) - minimum) / (maximum - minimum)
        : value / maximum;
    return Math.min(1, Math.max(0, result));
  };
  const candidates: number[] = [];
  if (kind === "log") {
    const span = maximum - minimum;
    if (span <= 2) {
      for (
        let exponent = Math.floor(minimum);
        exponent <= Math.ceil(maximum);
        exponent++
      ) {
        for (const multiplier of [1, 2, 5])
          candidates.push(Number(`${multiplier}e${exponent}`));
      }
    } else {
      const step = Math.ceil(span / 4);
      const first = Math.ceil(minimum / step) * step;
      for (let index = 0; index <= 4; index++) {
        const exponent = first + index * step;
        if (exponent <= maximum) candidates.push(10 ** exponent);
      }
    }
  } else {
    const rawStep = maximum / 4 || Number.MIN_VALUE;
    const exponent = Math.floor(Math.log10(rawStep));
    const decimalMagnitude = 10 ** exponent;
    const magnitude = decimalMagnitude || Number.MIN_VALUE;
    const normalized = rawStep / magnitude;
    const multiplier =
      [1, 2, 2.5, 5, 10].find((value) => value >= normalized) || 10;
    const step = multiplier * magnitude;
    candidates.push(0);
    // At most five positive ticks, including subnormal IEEE-754 inputs.
    for (let index = 1; index <= 5; index++) {
      const value = decimalMagnitude
        ? Number(`${multiplier * index}e${exponent}`)
        : step * index;
      if (value <= maximum) candidates.push(value);
    }
  }
  const ticks = [...new Set(candidates)]
    .filter((value) => {
      if (!Number.isFinite(value) || value < 0) return false;
      if (kind === "linear") return value <= maximum;
      if (value === 0) return false;
      const transformed = Math.log10(value);
      return transformed >= minimum && transformed <= maximum;
    })
    .sort((a, b) => a - b)
    .map((value) => ({ value, fraction: value === 0 ? 0 : position(value)! }));
  return { kind, position, ticks };
}

/** Keep endpoint labels and drop only labels that would collide. The axis
 * domain and tick positions are unchanged. */
export function thinTicks<T extends { fraction: number }>(
  ticks: readonly T[],
  pixelSpan: number,
  minimumGap = 70,
): T[] {
  if (ticks.length < 2) return [...ticks];
  const first = ticks[0];
  const last = ticks.at(-1)!;
  if (!Number.isFinite(pixelSpan) || pixelSpan <= 0) return [first];
  if ((last.fraction - first.fraction) * pixelSpan < minimumGap) return [first];
  const labels = [first];
  for (const tick of ticks.slice(1, -1)) {
    if (
      (tick.fraction - labels.at(-1)!.fraction) * pixelSpan >= minimumGap &&
      (last.fraction - tick.fraction) * pixelSpan >= minimumGap
    )
      labels.push(tick);
  }
  return [...labels, last];
}

/** A zero-based value scale with a "nice" rounded maximum and quarter ticks.
 * If the rounded bound is not representable, the measured maximum is used. */
export function zeroBasedScale(values: Iterable<number>): {
  maximum: number;
  ticks: number[];
} {
  let observed = 0;
  for (const value of values)
    if (Number.isFinite(value) && value > observed) observed = value;
  if (observed === 0) return { maximum: 1, ticks: [0, 0.25, 0.5, 0.75, 1] };
  const magnitude = 10 ** Math.floor(Math.log10(observed));
  const multiple = [1, 2, 2.5, 5, 10].find(
    (candidate) => candidate >= observed / magnitude,
  );
  const rounded = magnitude * (multiple ?? 1);
  const maximum =
    Number.isFinite(rounded) && rounded >= observed ? rounded : observed;
  const ticks = [...new Set([0, 0.25, 0.5, 0.75, 1].map((r) => maximum * r))];
  return { maximum, ticks };
}

const MINUTE = 60000;
const HOUR = 3600000;
const DAY = 86400000;
const TIME_STEPS = [
  MINUTE,
  5 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  2 * DAY,
  7 * DAY,
  14 * DAY,
  30 * DAY,
  90 * DAY,
];

/** UTC-aligned tick times inside [start, end] (epoch is UTC midnight, so
 * multiples of a step are aligned clock boundaries). A zero-length domain
 * has one tick. Ticks describe the axis only; they are never observations. */
export function timeTicks(start: number, end: number, maxTicks = 6): number[] {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    return [];
  if (end === start) return [start];
  const span = end - start;
  const target = Math.max(2, maxTicks);
  const step =
    TIME_STEPS.find((candidate) => span / candidate <= target) ??
    Math.ceil(span / target / DAY) * DAY;
  const ticks: number[] = [];
  for (
    let tick = Math.ceil(start / step) * step;
    tick <= end && ticks.length <= target + 1;
    tick += step
  )
    ticks.push(tick);
  // A very short span can fall between aligned boundaries; label its ends.
  return ticks.length >= 2 ? ticks : [start, end];
}

/** Index of the nearest value in an ascending array, preferring the first of
 * equal values and the earlier side of an exact midpoint. Binary search. */
export function nearestIndex(sorted: readonly number[], target: number): number {
  if (!sorted.length || !Number.isFinite(target)) return -1;
  const lowerBound = (value: number) => {
    let low = 0;
    let high = sorted.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (sorted[middle] < value) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const next = lowerBound(target);
  if (next === 0) return 0;
  const previous = sorted[next - 1];
  if (next === sorted.length || target - previous <= sorted[next] - target)
    return lowerBound(previous);
  return next;
}

/** Split ascending times into contiguous runs. An interval longer than
 * `gapMs` is a gap: lines never bridge it and nothing is interpolated. */
export function gapSegments(
  times: readonly number[],
  gapMs: number,
): { segments: number[][]; gaps: { from: number; to: number }[] } {
  const segments: number[][] = [];
  const gaps: { from: number; to: number }[] = [];
  for (let index = 0; index < times.length; index++) {
    if (index === 0 || times[index] - times[index - 1] > gapMs) {
      if (index > 0) gaps.push({ from: index - 1, to: index });
      segments.push([index]);
    } else segments[segments.length - 1].push(index);
  }
  return { segments, gaps };
}
