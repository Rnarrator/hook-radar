import { CENSUS_MAX_POOLS } from "./census-limits.mjs";

const BYTES = 32;
const ROWS = 16384;
const HEX = /^0x[0-9a-f]{64}$/;

/** Fixed-size exact keys. Hashes locate candidates; all32 bytes establish identity. */
export class BinaryKeyIndex {
  constructor({ prefix = "", rowsPerSegment = ROWS, hash = null } = {}) {
    if (
      typeof prefix !== "string" ||
      !Number.isInteger(rowsPerSegment) ||
      rowsPerSegment < 1 ||
      rowsPerSegment > 65536 ||
      (hash !== null && typeof hash !== "function")
    )
      throw new TypeError("Invalid binary key index options");
    this.prefix = prefix;
    this.rowsPerSegment = rowsPerSegment;
    this.hash = hash;
    this.keys = [];
    this.values = [];
    this.table = new Uint32Array(1024);
    this.size = 0;
  }
  decode(key) {
    if (typeof key !== "string" || !key.startsWith(this.prefix)) return null;
    const suffix = key.slice(this.prefix.length);
    return HEX.test(suffix) ? Buffer.from(suffix.slice(2), "hex") : null;
  }
  hashKey(bytes) {
    if (this.hash) return this.hash(bytes) >>> 0;
    let value = 0x9e3779b9;
    for (let index = 0; index < BYTES; index += 4)
      value = Math.imul(value ^ bytes.readUInt32LE(index), 0x85ebca6b);
    value ^= value >>> 16;
    value = Math.imul(value, 0xc2b2ae35);
    return (value ^ (value >>> 16)) >>> 0;
  }
  #rawBytesAt(position) {
    if (
      !Number.isSafeInteger(position) ||
      position < 0 ||
      position >= this.size
    )
      return undefined;
    const start = (position % this.rowsPerSegment) * BYTES;
    return this.keys[Math.floor(position / this.rowsPerSegment)].subarray(
      start,
      start + BYTES,
    );
  }
  bytesAt(position) {
    const bytes = this.#rawBytesAt(position);
    return bytes ? Buffer.from(bytes) : undefined;
  }
  keyAt(position) {
    const bytes = this.#rawBytesAt(position);
    return bytes ? this.prefix + "0x" + bytes.toString("hex") : undefined;
  }
  valueAt(position) {
    if (
      !Number.isSafeInteger(position) ||
      position < 0 ||
      position >= this.size
    )
      return undefined;
    return this.values[Math.floor(position / this.rowsPerSegment)][
      position % this.rowsPerSegment
    ];
  }
  locate(bytes, table = this.table) {
    const mask = table.length - 1;
    let slot = this.hashKey(bytes) & mask;
    while (table[slot]) {
      const position = table[slot] - 1;
      if (bytes.equals(this.#rawBytesAt(position))) return { slot, position };
      slot = (slot + 1) & mask;
    }
    return { slot, position: -1 };
  }
  position(key) {
    const bytes = this.decode(key);
    return bytes ? this.locate(bytes).position : -1;
  }
  has(key) {
    return this.position(key) >= 0;
  }
  get(key) {
    return this.valueAt(this.position(key));
  }
  set(key, value) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff)
      throw new TypeError("Invalid binary key value");
    const bytes = this.decode(key);
    if (!bytes) throw new TypeError("Invalid exact binary key");
    let located = this.locate(bytes);
    if (located.position >= 0) throw new Error("Binary keys are immutable");
    if (this.size >= CENSUS_MAX_POOLS)
      throw new RangeError(
        "Binary key index exceeded its bounded record capacity",
      );
    if ((this.size + 1) * 4 > this.table.length * 3) {
      const table = new Uint32Array(this.table.length * 2);
      for (let position = 0; position < this.size; position++) {
        const located = this.locate(this.#rawBytesAt(position), table);
        table[located.slot] = position + 1;
      }
      this.table = table;
      located = this.locate(bytes);
    }
    const position = this.size,
      segment = Math.floor(position / this.rowsPerSegment),
      row = position % this.rowsPerSegment;
    this.keys[segment] ??= Buffer.alloc(this.rowsPerSegment * BYTES);
    this.values[segment] ??= new Uint32Array(this.rowsPerSegment);
    bytes.copy(this.keys[segment], row * BYTES);
    this.values[segment][row] = value;
    this.table[located.slot] = position + 1;
    this.size++;
    return this;
  }
  get allocatedBytes() {
    return (
      this.table.byteLength +
      this.keys.reduce((sum, value) => sum + value.byteLength, 0) +
      this.values.reduce((sum, value) => sum + value.byteLength, 0)
    );
  }
  *[Symbol.iterator]() {
    for (let position = 0; position < this.size; position++)
      yield [this.keyAt(position), this.valueAt(position)];
  }
}

/** Small JS object graph even when its sequence contains millions of ordinals. */
export class Uint32Sequence {
  constructor(rowsPerSegment = ROWS) {
    if (
      !Number.isSafeInteger(rowsPerSegment) ||
      rowsPerSegment < 1 ||
      rowsPerSegment > 65536
    )
      throw new TypeError("Invalid packed sequence segment size");
    this.rowsPerSegment = rowsPerSegment;
    this.segments = [];
    this.length = 0;
  }
  push(value) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff)
      throw new TypeError("Invalid packed ordinal");
    const segment = Math.floor(this.length / this.rowsPerSegment);
    this.segments[segment] ??= new Uint32Array(this.rowsPerSegment);
    this.segments[segment][this.length++ % this.rowsPerSegment] = value;
    return this.length;
  }
  at(position) {
    return Number.isSafeInteger(position) &&
      position >= 0 &&
      position < this.length
      ? this.segments[Math.floor(position / this.rowsPerSegment)][
          position % this.rowsPerSegment
        ]
      : undefined;
  }
  get allocatedBytes() {
    return this.segments.length * this.rowsPerSegment * 4;
  }
}

/** Durable progress owns exact keys even while their inventory is withdrawn. */
export class BinaryKeySet {
  constructor(options = {}) {
    this.index = new BinaryKeyIndex(options);
  }
  get size() {
    return this.index.size;
  }
  has(key) {
    return this.index.has(key);
  }
  add(key) {
    if (!this.has(key)) this.index.set(key, this.index.size);
    return this;
  }
  ordinal(key) {
    return this.index.get(key);
  }
  at(position) {
    return this.index.keyAt(position);
  }
  *values() {
    for (let position = 0; position < this.size; position++)
      yield this.at(position);
  }
  keys() {
    return this.values();
  }
  [Symbol.iterator]() {
    return this.values();
  }
  get allocatedBytes() {
    return this.index.allocatedBytes;
  }
}

/** Bounded progress shards refer to the single durable exact-key collection. */
export class BinaryKeyReferences {
  constructor(keys) {
    if (!(keys instanceof BinaryKeySet))
      throw new TypeError("Exact references require binary keys");
    this.keys = keys;
    this.positions = new Uint32Sequence(1024);
  }
  get length() {
    return this.positions.length;
  }
  push(key) {
    const ordinal = this.keys.ordinal(key);
    if (ordinal === undefined)
      throw new TypeError("Exact reference has no durable key");
    return this.positions.push(ordinal);
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
    const result = [];
    for (let position = start; position < end; position++)
      result.push(this.keys.at(this.positions.at(position)));
    return result;
  }
  [Symbol.iterator]() {
    return this.slice()[Symbol.iterator]();
  }
}
