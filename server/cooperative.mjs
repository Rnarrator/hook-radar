import { cooperativeTurn } from "./cooperative-turn.mjs";

/** Execute a shared generator synchronously for small fixtures and pure callers. */
export function runSynchronously(iterator) {
  let step;
  do {
    step = iterator.next();
    if (step.value && typeof step.value.then === "function")
      throw new TypeError(
        "An asynchronous projection requires runCooperatively.",
      );
  } while (!step.done);
  return step.value;
}

/** Keep large projections cooperative without publishing intermediate state.
 * Optional timings separate active wall time (including GC/preemption) from
 * explicit scheduler and promise waits; omitted timings add no measurement clocks. */
export async function runCooperatively(
  iterator,
  { budgetMs = 8, signal, timings, priority = "normal" } = {},
) {
  let deadline = performance.now() + budgetMs;
  let result;
  try {
    while (true) {
      signal?.throwIfAborted();
      let step;
      if (timings) {
        const began = performance.now();
        try {
          step = iterator.next(result);
        } finally {
          addDiagnostic(timings, "activeMs", performance.now() - began);
          addDiagnostic(timings, "steps", 1, Number.MAX_SAFE_INTEGER);
        }
      } else step = iterator.next(result);
      result = undefined;
      if (step.done) return step.value;
      if (step.value && typeof step.value.then === "function") {
        if (timings) {
          const began = performance.now();
          try {
            result = await step.value;
          } finally {
            addDiagnostic(timings, "promiseMs", performance.now() - began);
          }
        } else result = await step.value;
        deadline = performance.now() + budgetMs;
      }
      if (performance.now() >= deadline) {
        if (timings) {
          const began = performance.now();
          try {
            await cooperativeTurn({ signal, priority });
          } finally {
            addDiagnostic(timings, "queueMs", performance.now() - began);
            addDiagnostic(timings, "yields", 1, Number.MAX_SAFE_INTEGER);
          }
        } else await cooperativeTurn({ signal, priority });
        deadline = performance.now() + budgetMs;
      }
    }
  } finally {
    iterator.return?.();
  }
}

// Optional diagnostics never control scheduling. Clamp bad initial inputs and
// long-lived measurements so reporting cannot emit unbounded/nonfinite values.
function addDiagnostic(timings, key, amount, maximum = 3600000) {
  const previous = Number.isFinite(timings[key])
    ? Math.max(0, timings[key])
    : 0;
  const increment = Number.isFinite(amount) ? Math.max(0, amount) : 0;
  timings[key] = Math.min(maximum, previous + increment);
}

/** Stable bounded-work sort; the returned array is private to its projection. */
export function* cooperativeSortSteps(values, compare) {
  if (values.length < 2) return values;
  let operations = 0;
  let boundaries = [0];
  const descendingRuns = [];
  // Directory and inventory generations often retain long ordered sections.
  // Merge those existing runs instead of rebuilding singleton runs each time.
  for (let begin = 0; begin < values.length;) {
    let end = begin + 1;
    let descending = false;
    if (end < values.length) {
      descending = compare(values[begin], values[end]) > 0;
      end++;
      if (++operations % 1024 === 0) yield;
      while (end < values.length) {
        const difference = compare(values[end - 1], values[end]);
        if (++operations % 1024 === 0) yield;
        // Strict descending runs can be reversed without moving equal items.
        if (descending ? !(difference > 0) : difference > 0) break;
        end++;
      }
    }
    descendingRuns.push(descending);
    boundaries.push(end);
    begin = end;
  }
  if (boundaries.length === 2 && !descendingRuns[0]) return values;
  // Normalize into private storage. Cancellation never reorders the caller's
  // input, even when a later merge pass would otherwise reuse that array.
  let source = new Array(values.length);
  for (let run = 0; run < descendingRuns.length; run++) {
    const begin = boundaries[run];
    const end = boundaries[run + 1];
    for (let position = begin; position < end; position++) {
      source[position] = descendingRuns[run]
        ? values[end - 1 - (position - begin)]
        : values[position];
      if (++operations % 1024 === 0) yield;
    }
  }
  descendingRuns.length = 0;
  if (boundaries.length === 2) return source;
  let target = new Array(values.length);
  while (boundaries.length > 2) {
    const merged = [0];
    for (let run = 0; run < boundaries.length - 1; run += 2) {
      const begin = boundaries[run];
      const middle = boundaries[run + 1];
      const end = boundaries[run + 2] ?? middle;
      let left = begin,
        right = middle;
      for (let position = begin; position < end; position++) {
        target[position] =
          left < middle &&
          (right >= end || !(compare(source[left], source[right]) > 0))
            ? source[left++]
            : source[right++];
        if (++operations % 1024 === 0) yield;
      }
      merged.push(end);
    }
    [source, target] = [target, source];
    boundaries = merged;
  }
  return source;
}
