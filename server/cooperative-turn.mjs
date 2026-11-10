// Share the event-loop turns used by CPU-bound projections. Foreground and
// bulk interactive work together take at most three turns before a queued
// normal task takes one. Within that allowance, a queued bulk operation gets
// a turn after at most two foreground turns. Every task keeps its own budget.
// No permit is held while the caller awaits I/O or another promise.
const waiting = new Map();
let scheduled = false;
let interactiveTurns = 0;
let foregroundTurns = 0;

function priorityClass(priority) {
  // A private getter permits a shared normal freshness build to be promoted
  // when an interactive reader joins it. Unknown values keep normal priority.
  try {
    const value = typeof priority === "function" ? priority() : priority;
    return value === "interactive" || value === "bulk" ? value : "normal";
  } catch {
    return "normal";
  }
}

function schedule() {
  if (scheduled || !waiting.size) return;
  scheduled = true;
  setImmediate(() => {
    scheduled = false;
    let firstInteractive, firstBulk, firstNormal;
    for (const entry of waiting.values()) {
      const kind = priorityClass(entry.priority);
      if (kind === "interactive") firstInteractive ??= entry;
      else if (kind === "bulk") firstBulk ??= entry;
      else firstNormal ??= entry;
      if (firstInteractive && firstBulk && firstNormal) break;
    }
    if (!firstInteractive || !firstBulk) foregroundTurns = 0;
    const preferred =
      firstInteractive && (!firstBulk || foregroundTurns < 2)
        ? firstInteractive
        : firstBulk;
    const chosen =
      preferred && (!firstNormal || interactiveTurns < 3)
        ? preferred
        : firstNormal;
    if (chosen) {
      waiting.delete(chosen);
      chosen.signal?.removeEventListener("abort", chosen.aborted);
      interactiveTurns =
        chosen !== firstNormal ? Math.min(3, interactiveTurns + 1) : 0;
      if (chosen === firstBulk) foregroundTurns = 0;
      else if (chosen === firstInteractive && firstBulk)
        foregroundTurns = Math.min(2, foregroundTurns + 1);
      chosen.resolve();
    }
    if (!waiting.size) {
      interactiveTurns = 0;
      foregroundTurns = 0;
    }
    schedule();
  });
}

/** Yield a bounded CPU slice, preserving independent caller cancellation. */
export function cooperativeTurn({ signal, priority = "normal" } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject, signal, priority, aborted: null };
    entry.aborted = () => {
      waiting.delete(entry);
      if (!waiting.size) {
        interactiveTurns = 0;
        foregroundTurns = 0;
      }
      signal.removeEventListener("abort", entry.aborted);
      reject(signal.reason);
    };
    signal?.addEventListener("abort", entry.aborted, { once: true });
    waiting.set(entry, entry);
    schedule();
  });
}
