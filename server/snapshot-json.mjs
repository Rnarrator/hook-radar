import { cooperativeTurn } from "./cooperative-turn.mjs";

const arrayCaches = new WeakMap();

/** Opt-in cache for published snapshot arrays. maxRecords additionally opts
 * into reusing deeply immutable records across replacement arrays. Mutable
 * records must keep maxRecords disabled; mutable arrays remain uncached.
 * Keys never retain arrays/records; the LRU retains serialized buffers. */
export function createSnapshotArrayCache({
  maxBytes = 64 * 1024 * 1024,
  maxArrays = 16,
  maxPending = 2,
  maxRecords = 0,
} = {}) {
  for (const [name, value] of Object.entries({
    maxBytes,
    maxArrays,
    maxPending,
    maxRecords,
  }))
    if (!Number.isSafeInteger(value) || value < 0)
      throw new TypeError(`${name} must be a nonnegative safe integer.`);
  let arrays = new WeakMap(),
    records = new WeakMap(),
    bytes = 0,
    pending = 0,
    generation = 0;
  const retained = new Map();
  const retainedRecords = new Map();
  function discardRecord(record) {
    const key = record.reference?.deref();
    if (key && records.get(key) === record) records.delete(key);
    record.owner?.records?.delete(record);
    retainedRecords.delete(record);
    record.owner = undefined;
    record.reference = undefined;
  }
  async function discardArray(entry, options, selectedGeneration) {
    bytes -= entry.buffer.length;
    entry.buffer = undefined;
    retained.delete(entry);
    let deadline = performance.now() + options.budgetMs;
    for (const record of entry.records || []) {
      discardRecord(record);
      if (performance.now() >= deadline) {
        await cooperativeTurn({ priority: options.priority });
        if (selectedGeneration !== generation) return;
        deadline = performance.now() + options.budgetMs;
      }
    }
    entry.records?.clear();
  }
  function readRecord(value) {
    if (!value || typeof value !== "object") return null;
    const record = records.get(value);
    if (!record?.owner?.buffer) return null;
    retainedRecords.delete(record);
    retainedRecords.set(record, true);
    // Do not promote the old array here: its replacement is being encoded.
    // Keeping normal array LRU order preserves other arrays until their turn
    // even when two generations cannot both fit the retained-byte budget.
    return record.owner.buffer.subarray(record.start, record.end);
  }
  async function retainRecords(entry, positions, options, selectedGeneration) {
    entry.records = new Set();
    let deadline = performance.now() + options.budgetMs;
    for (const [value, start, end] of positions) {
      if (selectedGeneration !== generation || !entry.buffer) return;
      const previous = records.get(value);
      if (previous) discardRecord(previous);
      while (retainedRecords.size >= maxRecords)
        discardRecord(retainedRecords.keys().next().value);
      const record = {
        owner: entry,
        reference: new WeakRef(value),
        start,
        end,
      };
      records.set(value, record);
      retainedRecords.set(record, true);
      entry.records.add(record);
      if (performance.now() >= deadline) {
        await cooperativeTurn({ priority: options.priority });
        deadline = performance.now() + options.budgetMs;
      }
    }
  }
  const cache = Object.freeze({
    get stats() {
      return Object.freeze({ bytes, arrays: retained.size, pending });
    },
    get recordCount() {
      return retainedRecords.size;
    },
    clear() {
      generation++;
      arrays = new WeakMap();
      for (const entry of retained.keys()) {
        entry.buffer = undefined;
        entry.records?.clear();
      }
      retained.clear();
      records = new WeakMap();
      retainedRecords.clear();
      bytes = 0;
    },
  });
  arrayCaches.set(cache, {
    read(array, options) {
      let entry = arrays.get(array);
      if (entry?.buffer) {
        retained.delete(entry);
        retained.set(entry, true);
        return Promise.resolve(entry.buffer);
      }
      if (entry?.promise) return entry.promise;
      if (!maxBytes || !maxArrays || pending >= maxPending) return null;
      entry = {};
      arrays.set(array, entry);
      const selectedGeneration = generation;
      pending++;
      // The shared work has no request signal: cancelling one reader must not
      // cancel another reader or poison the next exact-array reuse.
      const promise = (
        maxRecords
          ? snapshotArrayBytes(array, options, readRecord, maxRecords)
          : snapshotJsonBytes(array, options).then((buffer) => ({
              buffer,
              positions: [],
            }))
      )
        .then(async ({ buffer, positions }) => {
          if (selectedGeneration === generation && buffer.length <= maxBytes) {
            while (
              retained.size >= maxArrays ||
              bytes + buffer.length > maxBytes
            ) {
              const oldest = retained.keys().next().value;
              await discardArray(oldest, options, selectedGeneration);
              if (selectedGeneration !== generation) return buffer;
            }
            entry.buffer = buffer;
            retained.set(entry, true);
            bytes += buffer.length;
            // Record ranges share this already-budgeted buffer. No second
            // record-byte ledger can silently double the cache's memory cap.
            if (maxRecords)
              await retainRecords(
                entry,
                positions,
                options,
                selectedGeneration,
              );
          }
          return buffer;
        })
        .finally(() => {
          pending--;
          // A resolved promise would otherwise retain an evicted large buffer.
          entry.promise = undefined;
        });
      entry.promise = promise;
      // A reader can disconnect between requesting and awaiting this shared
      // result. Its later failure must still have a rejection observer.
      promise.catch(() => {});
      return promise;
    },
  });
  return cache;
}

const ARRAY_OPEN = Buffer.from("["),
  ARRAY_COMMA = Buffer.from(","),
  ARRAY_CLOSE = Buffer.from("]");

async function snapshotArrayBytes(
  array,
  { budgetMs = 8, priority = "normal" },
  readRecord,
  limit,
) {
  const chunks = [ARRAY_OPEN],
    positions = [];
  let bytes = 1,
    deadline = performance.now() + budgetMs;
  for (let index = 0; index < array.length; index++) {
    if (index) {
      chunks.push(ARRAY_COMMA);
      bytes++;
    }
    const value = array[index];
    const encoded =
      readRecord(value) ?? Buffer.from(JSON.stringify(value) ?? "null");
    if (value && typeof value === "object" && positions.length < limit)
      positions.push([value, bytes, bytes + encoded.length]);
    chunks.push(encoded);
    bytes += encoded.length;
    if (performance.now() >= deadline) {
      await cooperativeTurn({ priority });
      deadline = performance.now() + budgetMs;
    }
  }
  chunks.push(ARRAY_CLOSE);
  return { buffer: Buffer.concat(chunks, bytes + 1), positions };
}

function waitForArray(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", aborted));
  });
}

/** Snapshot/source records are validated JSON values. Keep native per-record
 * encoding, key order and numeric/string semantics, without one giant stringify
 * or UTF-16 string for the complete observation array. */
function* recordPieces(value, arrayCache, options) {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.toJSON === "function"
  ) {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError("A JSON value is required.");
    yield encoded;
    return;
  }
  if (Array.isArray(value)) {
    const cached = arrayCache?.read(value, options);
    if (cached) {
      yield cached;
      return;
    }
    yield "[";
    for (let index = 0; index < value.length; index++)
      yield `${index ? "," : ""}${JSON.stringify(value[index]) ?? "null"}`;
    yield "]";
    return;
  }
  yield "{";
  let first = true;
  for (const [key, content] of Object.entries(value)) {
    if (Array.isArray(content)) {
      yield `${first ? "" : ","}${JSON.stringify(key)}:`;
      yield* recordPieces(content, arrayCache, options);
    } else {
      const encoded = JSON.stringify(content);
      if (encoded === undefined) continue;
      yield `${first ? "" : ","}${JSON.stringify(key)}:${encoded}`;
    }
    first = false;
  }
  yield "}";
}

async function* encodedChunks(
  value,
  {
    budgetMs = 8,
    chunkChars = 64 * 1024,
    signal,
    immutableArrayCache,
    priority = "normal",
  } = {},
  privateBuffers = false,
) {
  const arrayCache =
    immutableArrayCache && arrayCaches.get(immutableArrayCache);
  if (immutableArrayCache && !arrayCache)
    throw new TypeError("An explicit snapshot array cache is required.");
  signal?.throwIfAborted();
  let pieces = [],
    characters = 0,
    deadline = performance.now() + budgetMs;
  for (const piece of recordPieces(value, arrayCache, {
    budgetMs,
    chunkChars,
    priority,
  })) {
    signal?.throwIfAborted();
    if (typeof piece !== "string") {
      if (pieces.length) yield Buffer.from(pieces.join(""));
      pieces = [];
      characters = 0;
      const buffer = await waitForArray(piece, signal);
      signal?.throwIfAborted();
      // Chunks are public mutable Buffers. Keep callers from corrupting a
      // cached array by modifying a chunk after it has been yielded.
      yield privateBuffers ? buffer : Buffer.from(buffer);
      deadline = performance.now() + budgetMs;
      continue;
    }
    pieces.push(piece);
    characters += piece.length;
    if (characters >= chunkChars) {
      yield Buffer.from(pieces.join(""));
      pieces = [];
      characters = 0;
    }
    if (performance.now() >= deadline) {
      await cooperativeTurn({ signal, priority });
      deadline = performance.now() + budgetMs;
    }
  }
  signal?.throwIfAborted();
  if (pieces.length) yield Buffer.from(pieces.join(""));
}

export async function* snapshotJsonChunks(value, options) {
  yield* encodedChunks(value, options);
}

export async function snapshotJsonBytes(value, options) {
  const chunks = [];
  let bytes = 0;
  // Buffer.concat below returns a private copy; copying cached pieces again
  // here would add a full extra payload allocation for every response.
  for await (const chunk of encodedChunks(value, options, true)) {
    chunks.push(chunk);
    bytes += chunk.length;
  }
  return Buffer.concat(chunks, bytes);
}
