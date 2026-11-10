import { BinaryKeyIndex, Uint32Sequence } from "./binary-key-index.mjs";

// Canonical journals stay ordinary exact JSON. This derived runtime layout
// moves fixed-width fields into segmented buffers and materializes only the
// records currently being consumed. Hash buckets always compare all32 bytes;
// no fingerprint or hash can substitute for exact identity membership.
const STRIDE = 120;
const ROWS_PER_SEGMENT = 16384;
const CACHE_ROWS = 1024;
const HEX_ADDRESS = /^0x[\da-f]{40}$/;
const HEX_HASH = /^0x[\da-f]{64}$/;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const inventoryStores = new WeakMap();

export class PackedCensusStore {
  constructor(chain, { rowsPerSegment = ROWS_PER_SEGMENT } = {}) {
    if (
      !chain ||
      typeof chain.chain !== "string" ||
      !Number.isSafeInteger(chain.chainId) ||
      chain.chainId <= 0 ||
      !Number.isSafeInteger(rowsPerSegment) ||
      rowsPerSegment < 1 ||
      rowsPerSegment > 65536
    )
      throw new TypeError(
        "Packed census requires a valid chain and segment size",
      );
    this.chain = Object.freeze({ chain: chain.chain, chainId: chain.chainId });
    this.rowsPerSegment = rowsPerSegment;
    this.keys = new BinaryKeyIndex({
      prefix: `${chain.chain}:`,
      rowsPerSegment,
    });
    this.positions = new Uint32Sequence(rowsPerSegment);
    this.fingerprints = [];
    this.fingerprintBirths = [];
    this.fingerprintCount = 0;
    const store = this;
    this.index = {
      get size() {
        return store.keys.size;
      },
      has: (id) => store.keys.has(id),
      get: (id) => {
        const value = store.keys.get(id);
        return value === undefined
          ? undefined
          : value >= 0x80000000
            ? store.fingerprintAt(value - 0x80000000)
            : value;
      },
    };
    this.segments = [];
    this.sources = [];
    this.sourceIndex = new Map();
    this.exceptionalTimes = new Map();
    this.cache = new Map();
  }
  get size() {
    return this.index.size;
  }
  get recordCount() {
    return this.positions.length;
  }
  get allocatedRecordBytes() {
    return this.segments.length * this.rowsPerSegment * STRIDE;
  }
  get allocatedIdentityBytes() {
    return (
      this.keys.allocatedBytes +
      this.positions.allocatedBytes +
      this.fingerprints.length * this.rowsPerSegment * 32 +
      this.fingerprintBirths.length * this.rowsPerSegment * 8
    );
  }
  fingerprintAt(position) {
    if (
      !Number.isSafeInteger(position) ||
      position < 0 ||
      position >= this.fingerprintCount
    )
      return undefined;
    const buffer =
      this.fingerprints[Math.floor(position / this.rowsPerSegment)];
    return buffer?.toString(
      "base64",
      (position % this.rowsPerSegment) * 32,
      ((position % this.rowsPerSegment) + 1) * 32,
    );
  }
  poolIdAt(position) {
    const ordinal = this.positions.at(position);
    return ordinal === undefined
      ? undefined
      : this.keys.keyAt(ordinal).slice(this.chain.chain.length + 1);
  }
  recordPosition(id) {
    const position = this.keys.get(id);
    return position !== undefined && position < 0x80000000
      ? position
      : undefined;
  }
  has(id) {
    return this.index.has(id);
  }
  get(id) {
    const position = this.index.get(id);
    if (position === undefined || typeof position === "string") return position;
    let record = this.cache.get(position);
    if (!record) {
      record = this.at(position);
      this.cache.set(position, record);
      if (this.cache.size > CACHE_ROWS)
        this.cache.delete(this.cache.keys().next().value);
    }
    return record;
  }
  /** Append an already validated canonical row or a zero-hook fingerprint. */
  set(id, pool, creationBlock) {
    if (
      typeof id !== "string" ||
      !id.startsWith(`${this.chain.chain}:`) ||
      !HEX_HASH.test(id.slice(this.chain.chain.length + 1))
    )
      throw new TypeError("Invalid packed census identity");
    if (typeof pool === "string") {
      if (
        !/^[A-Za-z\d+/]{43}=$/.test(pool) ||
        Buffer.from(pool, "base64").toString("base64") !== pool
      )
        throw new TypeError("Invalid compact zero-hook fingerprint");
      if (
        creationBlock !== undefined &&
        (!Number.isSafeInteger(creationBlock) || creationBlock < 0)
      )
        throw new TypeError("Invalid compact zero-hook creation block");
      const ordinal = this.fingerprintCount;
      const segment = Math.floor(ordinal / this.rowsPerSegment);
      const fingerprints =
        this.fingerprints[segment] || Buffer.alloc(this.rowsPerSegment * 32);
      const births =
        this.fingerprintBirths[segment] ||
        new Float64Array(this.rowsPerSegment).fill(NaN);
      births[ordinal % this.rowsPerSegment] = creationBlock ?? NaN;
      Buffer.from(pool, "base64").copy(
        fingerprints,
        (ordinal % this.rowsPerSegment) * 32,
      );
      this.keys.set(id, 0x80000000 + ordinal);
      this.fingerprints[segment] = fingerprints;
      this.fingerprintBirths[segment] = births;
      this.fingerprintCount++;
      return this;
    }
    if (
      !pool ||
      pool.id !== id ||
      pool.chain !== this.chain.chain ||
      pool.chainId !== this.chain.chainId ||
      pool.poolId !== pool.address ||
      pool.address !== id.slice(this.chain.chain.length + 1) ||
      !HEX_ADDRESS.test(pool.hookAddress) ||
      !Array.isArray(pool.tokens) ||
      pool.tokens.length !== 2 ||
      !pool.tokens.every((value) => HEX_ADDRESS.test(value)) ||
      !Number.isSafeInteger(pool.fee) ||
      pool.fee < 0 ||
      pool.fee > 0xffffff ||
      !Number.isSafeInteger(pool.tickSpacing) ||
      pool.tickSpacing < 1 ||
      pool.tickSpacing > 0xffff ||
      !Number.isSafeInteger(pool.creationBlock) ||
      pool.creationBlock < 0 ||
      (pool.creationBlockHash !== null &&
        !HEX_HASH.test(pool.creationBlockHash)) ||
      (pool.createdAt !== null &&
        (typeof pool.createdAt !== "string" ||
          !Number.isFinite(Date.parse(pool.createdAt)))) ||
      typeof pool.sourceUrl !== "string"
    )
      throw new TypeError("Invalid canonical packed census record");
    const position = this.positions.length;
    const segment = Math.floor(position / this.rowsPerSegment);
    const offset = (position % this.rowsPerSegment) * STRIDE;
    const buffer =
      this.segments[segment] || Buffer.alloc(this.rowsPerSegment * STRIDE);
    const source = this.sourceIndex.get(pool.sourceUrl) ?? this.sources.length;
    buffer.write(pool.hookAddress.slice(2), offset, 20, "hex");
    buffer.write(pool.tokens[0].slice(2), offset + 20, 20, "hex");
    buffer.write(pool.tokens[1].slice(2), offset + 40, 20, "hex");
    buffer.writeUInt32LE(pool.fee, offset + 60);
    buffer.writeUInt16LE(pool.tickSpacing, offset + 64);
    buffer.writeDoubleLE(pool.creationBlock, offset + 66);
    const time = pool.createdAt === null ? NaN : Date.parse(pool.createdAt);
    buffer.writeDoubleLE(time, offset + 74);
    if (pool.creationBlockHash !== null)
      buffer.write(pool.creationBlockHash.slice(2), offset + 82, 32, "hex");
    buffer.writeUInt32LE(source, offset + 114);
    buffer[offset + 118] = pool.creationBlockHash === null ? 0 : 1;
    const exceptionalTime =
      pool.createdAt !== null && new Date(time).toISOString() !== pool.createdAt
        ? pool.createdAt
        : null;
    // The exact index rejects duplicates before any row becomes published.
    // Prepared bytes occupy only the unused tail slot; an allocation/validation
    // failure cannot expose a new identity or alter an existing record.
    const ordinal = this.keys.size;
    this.keys.set(id, position);
    if (exceptionalTime !== null)
      this.exceptionalTimes.set(position, exceptionalTime);
    if (source === this.sources.length) {
      this.sources.push(pool.sourceUrl);
      this.sourceIndex.set(pool.sourceUrl, source);
    }
    this.segments[segment] = buffer;
    this.positions.push(ordinal);
    return this;
  }
  /** Exact inclusive journal order, including compact zero-hook records. */
  creationBlockAtOrdinal(ordinal) {
    const position = this.keys.valueAt(ordinal);
    if (position === undefined) return undefined;
    if (position >= 0x80000000) {
      const zero = position - 0x80000000;
      return this.fingerprintBirths[Math.floor(zero / this.rowsPerSegment)]?.[
        zero % this.rowsPerSegment
      ];
    }
    return this.segments[
      Math.floor(position / this.rowsPerSegment)
    ].readDoubleLE((position % this.rowsPerSegment) * STRIDE + 66);
  }
  /** Match all canonical key/evidence bytes, never just a hashed identity. */
  canonicalProofPosition(proof, offset, count) {
    if (
      !Buffer.isBuffer(proof) ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset + 148 > proof.length ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      count > this.recordCount
    )
      return -1;
    const located = this.keys.locate(
      proof.subarray(offset + 1, offset + 33),
    ).position;
    const position = this.keys.valueAt(located);
    if (position === undefined || position >= count || position >= 0x80000000)
      return -1;
    const source = this.segments[Math.floor(position / this.rowsPerSegment)],
      start = (position % this.rowsPerSegment) * STRIDE;
    return proof
      .subarray(offset + 33, offset + 147)
      .equals(source.subarray(start, start + 114)) &&
      proof[offset + 147] === source[start + 118]
      ? position
      : -1;
  }
  at(position) {
    if (
      !Number.isSafeInteger(position) ||
      position < 0 ||
      position >= this.positions.length
    )
      return undefined;
    const id = `${this.chain.chain}:${this.poolIdAt(position)}`;
    const buffer = this.segments[Math.floor(position / this.rowsPerSegment)];
    const offset = (position % this.rowsPerSegment) * STRIDE;
    const hex = (start, bytes) =>
      "0x" + buffer.toString("hex", offset + start, offset + start + bytes);
    const address = id.slice(this.chain.chain.length + 1);
    const time = buffer.readDoubleLE(offset + 74);
    return Object.freeze({
      id,
      ...this.chain,
      address,
      poolId: address,
      hookAddress: hex(0, 20),
      tokens: Object.freeze([hex(20, 20), hex(40, 20)]),
      fee: buffer.readUInt32LE(offset + 60),
      tickSpacing: buffer.readUInt16LE(offset + 64),
      createdAt: Number.isNaN(time)
        ? null
        : (this.exceptionalTimes.get(position) ?? new Date(time).toISOString()),
      creationBlock: buffer.readDoubleLE(offset + 66),
      creationBlockHash: buffer[offset + 118] ? hex(82, 32) : null,
      sourceUrl: this.sources[buffer.readUInt32LE(offset + 114)],
    });
  }
  identityAt(position) {
    if (
      !Number.isSafeInteger(position) ||
      position < 0 ||
      position >= this.positions.length
    )
      return undefined;
    const id = `${this.chain.chain}:${this.poolIdAt(position)}`;
    const buffer = this.segments[Math.floor(position / this.rowsPerSegment)];
    const offset = (position % this.rowsPerSegment) * STRIDE;
    return Object.freeze({
      id,
      ...this.chain,
      address: id.slice(this.chain.chain.length + 1),
      hookAddress: "0x" + buffer.toString("hex", offset, offset + 20),
    });
  }
  /** Fields needed to group validated rows without decoding full pool keys. */
  hookFeeAt(position) {
    if (
      !Number.isSafeInteger(position) ||
      position < 0 ||
      position >= this.positions.length
    )
      return undefined;
    const buffer = this.segments[Math.floor(position / this.rowsPerSegment)];
    const offset = (position % this.rowsPerSegment) * STRIDE;
    return Object.freeze({
      hookAddress: "0x" + buffer.toString("hex", offset, offset + 20),
      fee: buffer.readUInt32LE(offset + 60),
    });
  }
  *values() {
    for (let index = 0; index < this.keys.size; index++) {
      const position = this.keys.valueAt(index);
      yield position >= 0x80000000
        ? this.fingerprintAt(position - 0x80000000)
        : this.at(position);
    }
  }
}

/**
 * An immutable snapshot of append-only segment bounds, with native Array
 * iteration/slice semantics and bounded record materialization. The backing
 * stores may grow; a published view can never expose their later appends.
 */
export function packedCensusInventoryView(segments) {
  let length = 0;
  const stores = new Map();
  const ranges = segments.map(({ store, count }) => {
    if (
      !(store instanceof PackedCensusStore) ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      count > store.recordCount
    )
      throw new TypeError("Packed inventory requires committed record bounds");
    if (stores.has(store.chain.chain))
      throw new TypeError("Packed inventory has a repeated chain namespace");
    stores.set(
      store.chain.chain,
      Object.freeze({ store, count, start: length }),
    );
    const result = Object.freeze({ store, start: length, end: length + count });
    length += count;
    return result;
  });
  if (length > 0xffffffff)
    throw new RangeError("Packed inventory exceeds the native Array bound");
  const select = (index) => {
    // There are currently22 canonical chains; a tiny range lookup avoids a
    // second per-pool index or retained expanded object graph.
    const range = ranges.find(
      (candidate) => index >= candidate.start && index < candidate.end,
    );
    return range?.store.at(index - range.start);
  };
  const view = immutableArrayView(length, select);
  inventoryStores.set(view, stores);
  return view;
}

function immutableArrayView(length, select) {
  // Start in sparse dictionary mode: growing an ordinary empty Array to a
  // medium prefix allocates one heap slot per hole on V8. No virtual index
  // belongs to this target, so those slots would be pure duplication.
  const target = new Array(0xffffffff);
  target.length = length;
  Object.freeze(target);
  const position = (key) => {
    if (typeof key !== "string") return -1;
    const value = Number(key);
    return Number.isSafeInteger(value) &&
      value >= 0 &&
      value < length &&
      String(value) === key
      ? value
      : -1;
  };
  const view = new Proxy(target, {
    get(array, key, receiver) {
      const index = position(key);
      return index >= 0 ? select(index) : Reflect.get(array, key, receiver);
    },
    has(array, key) {
      return position(key) >= 0 || Reflect.has(array, key);
    },
    // A frozen sparse target has no numeric own properties. Exposing virtual
    // own descriptors would violate Proxy invariants, so enumeration is
    // deliberately limited to native Array consumers (iteration and slice).
    set() {
      return false;
    },
    defineProperty(array, key, descriptor) {
      // Re-freezing an already frozen view must remain harmless. The frozen
      // target itself rejects every attempted change or new numeric property.
      return Reflect.defineProperty(array, key, descriptor);
    },
    deleteProperty(array, key) {
      return position(key) < 0 && !own(array, key);
    },
  });
  return view;
}

/** Fixed committed identity prefix; appended records cannot leak into a queue. */
export function packedCensusPoolIds({ store, count }) {
  if (
    !(store instanceof PackedCensusStore) ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    count > store.recordCount
  )
    throw new TypeError(
      "Packed identity view requires a committed record bound",
    );
  return immutableArrayView(count, (index) => store.poolIdAt(index));
}

export class PackedPoolIdIndex {
  constructor({ store, count }) {
    if (
      !(store instanceof PackedCensusStore) ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      count > store.recordCount
    )
      throw new TypeError(
        "Packed identity index requires a committed record bound",
      );
    this.store = store;
    this.size = count;
    Object.freeze(this);
  }
  get(id) {
    if (typeof id !== "string" || !HEX_HASH.test(id)) return undefined;
    const position = this.store.recordPosition(
      `${this.store.chain.chain}:${id}`,
    );
    return position !== undefined && position < this.size
      ? position
      : undefined;
  }
  has(id) {
    return this.get(id) !== undefined;
  }
  set() {
    throw new Error("Packed queue identity membership is immutable");
  }
  delete() {
    throw new Error("Packed queue identity membership is immutable");
  }
}

/** Session flags share canonical keys and retain just one bit per ordinal. */
export class PackedPoolIdSet {
  constructor(index, previous = []) {
    if (!(index instanceof PackedPoolIdIndex))
      throw new TypeError("Packed flags require exact canonical membership");
    this.index = index;
    this.segments = [];
    this.size = 0;
    for (const id of previous) if (index.has(id)) this.add(id);
  }
  static rebind(index, previous) {
    if (
      previous instanceof PackedPoolIdSet &&
      previous.index.store === index.store &&
      previous.index.size <= index.size
    ) {
      previous.index = index;
      return previous;
    }
    return new PackedPoolIdSet(index, previous);
  }
  static full(index) {
    const result = new PackedPoolIdSet(index);
    for (let segment = 0; segment < Math.ceil(index.size / 32768); segment++) {
      const values = new Uint32Array(1024);
      const count = Math.min(32768, index.size - segment * 32768);
      values.fill(0xffffffff, 0, Math.floor(count / 32));
      if (count % 32)
        values[Math.floor(count / 32)] = 0xffffffff >>> (32 - (count % 32));
      result.segments.push(values);
    }
    result.size = index.size;
    return result;
  }
  hasPosition(position) {
    return (
      Number.isSafeInteger(position) &&
      position >= 0 &&
      position < this.index.size &&
      Boolean(
        this.segments[Math.floor(position / 32768)]?.[(position >>> 5) & 1023] &
        (1 << (position & 31)),
      )
    );
  }
  addPosition(position) {
    if (
      !Number.isSafeInteger(position) ||
      position < 0 ||
      position >= this.index.size
    )
      throw new TypeError("Packed flag cannot retain an unpublished ordinal");
    const segment = Math.floor(position / 32768),
      word = (position >>> 5) & 1023,
      bit = 1 << (position & 31);
    const values = (this.segments[segment] ??= new Uint32Array(1024));
    if (!(values[word] & bit)) {
      values[word] |= bit;
      this.size++;
    }
    return this;
  }
  add(id) {
    const position = this.index.get(id);
    if (position === undefined)
      throw new TypeError("Packed flag cannot retain an unpublished identity");
    return this.addPosition(position);
  }
  has(id) {
    const position = this.index.get(id);
    return (
      position !== undefined &&
      Boolean(
        this.segments[Math.floor(position / 32768)]?.[(position >>> 5) & 1023] &
        (1 << (position & 31)),
      )
    );
  }
  delete(id) {
    const position = this.index.get(id);
    if (position === undefined) return false;
    const values = this.segments[Math.floor(position / 32768)],
      word = (position >>> 5) & 1023,
      bit = 1 << (position & 31);
    if (!values || !(values[word] & bit)) return false;
    values[word] &= ~bit;
    this.size--;
    return true;
  }
  clear() {
    this.segments = [];
    this.size = 0;
  }
  get allocatedBytes() {
    return this.segments.reduce((sum, value) => sum + value.byteLength, 0);
  }
  *values() {
    for (let segment = 0; segment < this.segments.length; segment++) {
      const values = this.segments[segment];
      if (!values) continue;
      for (let word = 0; word < values.length; word++) {
        let remaining = values[word];
        while (remaining) {
          const bit = 31 - Math.clz32(remaining & -remaining);
          yield this.index.store.poolIdAt(segment * 32768 + word * 32 + bit);
          remaining = remaining & (remaining - 1);
        }
      }
    }
  }
  keys() {
    return this.values();
  }
  [Symbol.iterator]() {
    return this.values();
  }
}

/** Secondary scan queues retain4-byte ordinals, including very large networks. */
export class PackedPoolIdQueue {
  constructor(index, values = [], sequence = null, start = 0, end = null) {
    if (!(index instanceof PackedPoolIdIndex))
      throw new TypeError("Packed queue requires exact canonical membership");
    this.index = index;
    this.positions = sequence || new Uint32Sequence(1024);
    this.start = start;
    this.end = end ?? this.positions.length;
    for (const id of values) if (index.has(id)) this.push(id);
    return new Proxy(this, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^(0|[1-9]\d*)$/.test(key))
          return target.at(Number(key));
        return Reflect.get(target, key, receiver);
      },
    });
  }
  get length() {
    return this.end - this.start;
  }
  get allocatedBytes() {
    return this.positions.allocatedBytes;
  }
  static complete(index) {
    return new PackedPoolIdQueue(
      index,
      [],
      new CanonicalOrdinalRange(index.size),
    );
  }
  updateIndex(index) {
    if (
      !(index instanceof PackedPoolIdIndex) ||
      index.store !== this.index.store ||
      index.size < this.index.size
    )
      throw new Error("Packed queue can only extend the same immutable store");
    this.index = index;
  }
  at(position) {
    if (position < 0) position += this.length;
    if (
      !Number.isSafeInteger(position) ||
      position < 0 ||
      position >= this.length
    )
      return undefined;
    return this.index.store.poolIdAt(this.positions.at(this.start + position));
  }
  push(id) {
    const position = this.index.get(id);
    if (position === undefined)
      throw new TypeError("Packed queue cannot retain an unpublished identity");
    return this.pushPosition(position);
  }
  pushPosition(position) {
    if (
      !Number.isSafeInteger(position) ||
      position < 0 ||
      position >= this.index.size
    )
      throw new TypeError("Packed queue cannot retain an unpublished ordinal");
    if (this.end !== this.positions.length)
      throw new Error("Cannot append to a fixed packed queue slice");
    this.positions.push(position);
    this.end++;
    return this.length;
  }
  slice(start = 0, end = this.length) {
    start = Math.max(
      0,
      Math.min(this.length, start < 0 ? this.length + start : start),
    );
    end = Math.max(
      start,
      Math.min(this.length, end < 0 ? this.length + end : end),
    );
    if (
      end === this.length &&
      this.start + start >= 16384 &&
      this.start + start >= this.end / 2
    ) {
      const positions = new Uint32Sequence(1024);
      for (let position = this.start + start; position < this.end; position++)
        positions.push(this.positions.at(position));
      return new PackedPoolIdQueue(this.index, [], positions);
    }
    return new PackedPoolIdQueue(
      this.index,
      [],
      this.positions,
      this.start + start,
      this.start + end,
    );
  }
  filter(predicate) {
    const result = new PackedPoolIdQueue(this.index);
    let position = 0;
    for (const id of this) if (predicate(id, position++, this)) result.push(id);
    return result;
  }
  *[Symbol.iterator]() {
    for (let position = 0; position < this.length; position++)
      yield this.at(position);
  }
}

class CanonicalOrdinalRange {
  constructor(count) {
    this.count = count;
    this.tail = new Uint32Sequence(1024);
  }
  get length() {
    return this.count + this.tail.length;
  }
  get allocatedBytes() {
    return this.tail.allocatedBytes;
  }
  at(position) {
    return position < this.count
      ? position
      : this.tail.at(position - this.count);
  }
  push(position) {
    this.tail.push(position);
    return this.length;
  }
}

/** Negative-observation deadlines share exact IDs instead of duplicating them. */
export class PackedPoolIdClock {
  constructor(index, previous = []) {
    if (!(index instanceof PackedPoolIdIndex))
      throw new TypeError(
        "Packed deadlines require exact canonical membership",
      );
    this.index = index;
    this.segments = [];
    this.size = 0;
    for (const [id, value] of previous) if (index.has(id)) this.set(id, value);
  }
  static rebind(index, previous) {
    if (
      previous instanceof PackedPoolIdClock &&
      previous.index.store === index.store &&
      previous.index.size <= index.size
    ) {
      previous.index = index;
      return previous;
    }
    return new PackedPoolIdClock(index, previous);
  }
  get(id) {
    const position = this.index.get(id);
    if (position === undefined) return undefined;
    const value = this.segments[Math.floor(position / 1024)]?.[position % 1024];
    return value === undefined || Number.isNaN(value) ? undefined : value;
  }
  has(id) {
    return this.get(id) !== undefined;
  }
  set(id, value) {
    const position = this.index.get(id);
    if (position === undefined || !Number.isFinite(value))
      throw new TypeError("Invalid packed observation deadline");
    const segment = Math.floor(position / 1024);
    const values = (this.segments[segment] ??= new Float64Array(1024).fill(
      NaN,
    ));
    if (Number.isNaN(values[position % 1024])) this.size++;
    values[position % 1024] = value;
    return this;
  }
  delete(id) {
    const position = this.index.get(id);
    if (position === undefined || this.get(id) === undefined) return false;
    this.segments[Math.floor(position / 1024)][position % 1024] = NaN;
    this.size--;
    return true;
  }
  clear() {
    this.segments = [];
    this.size = 0;
  }
  get allocatedBytes() {
    return this.segments.reduce((sum, value) => sum + value.byteLength, 0);
  }
  *entries() {
    for (let segment = 0; segment < this.segments.length; segment++) {
      const values = this.segments[segment];
      if (!values) continue;
      for (let row = 0; row < values.length; row++)
        if (!Number.isNaN(values[row]))
          yield [this.index.store.poolIdAt(segment * 1024 + row), values[row]];
    }
  }
  *keys() {
    for (const [id] of this.entries()) yield id;
  }
  [Symbol.iterator]() {
    return this.entries();
  }
}

/** Private factory provenance; arbitrary arrays cannot opt into lazy lookup. */
export function packedCensusInventoryStore(view, chain) {
  return inventoryStores.get(view)?.get(chain) || null;
}

/** Queues need identity; full keys are resolved only for real observations. */
export function packedCensusMarketEntries(view, spans = null) {
  const stores = inventoryStores.get(view);
  if (!stores) return null;
  const ranges = spans || [{ start: 0, end: view.length }];
  return (function* () {
    for (const span of ranges) {
      for (const { store, count, start } of stores.values()) {
        const from = Math.max(span.start, start);
        const to = Math.min(span.end, start + count);
        for (let position = from; position < to; position++)
          yield store.identityAt(position - start);
      }
    }
  })();
}

/**
 * Market queues retain IDs and observation state, while immutable canonical
 * structure stays in the packed store. The published count is an exact upper
 * bound even while the census is validating or persisting a later source page.
 */
export class PackedCanonicalLookup {
  constructor({ store, count }, contains) {
    if (!(store instanceof PackedCensusStore) || typeof contains !== "function")
      throw new TypeError(
        "Canonical lookup requires a packed store and membership check",
      );
    this.store = store;
    this.contains = contains;
    this.updateBound(count);
  }
  updateBound(count) {
    if (
      !Number.isSafeInteger(count) ||
      count < 0 ||
      count > this.store.recordCount
    )
      throw new TypeError("Canonical lookup requires a committed record bound");
    this.count = count;
  }
  has(id) {
    if (!this.contains(id)) return false;
    const position = this.store.index.get(`${this.store.chain.chain}:${id}`);
    return typeof position === "number" && position < this.count;
  }
  get(id) {
    return this.has(id)
      ? this.store.get(`${this.store.chain.chain}:${id}`)
      : undefined;
  }
  set(id, pool) {
    if (
      !this.has(id) ||
      pool?.address !== id ||
      pool.chain !== this.store.chain.chain ||
      pool.chainId !== this.store.chain.chainId
    )
      throw new Error(
        "Canonical market lookup cannot retain foreign or unpublished pool structure",
      );
    return this;
  }
  delete(id) {
    // The queue owner removes membership during its synchronous generation
    // transition. The canonical append-only evidence itself is never deleted.
    return this.has(id);
  }
}
