/** Lossless, versioned JSON transport. Layouts replace repeated property names;
 * repeated strings/clocks are dictionary entries; equal-layout record arrays
 * (including histories) are packed rows. No observation or field is omitted.
 * Only primitive values are shared: decoding always creates distinct objects.
 */
export const SNAPSHOT_TRANSPORT_TYPE =
  "application/vnd.hook-radar.snapshot+json";
export const SNAPSHOT_TRANSPORT_ACCEPT = `${SNAPSHOT_TRANSPORT_TYPE};version=1, application/json;q=0.9`;

const FORMAT = "hook-radar-snapshot";
const LIMITS = {
  depth: 32,
  nodes: 6_000_000,
  text: 128 * 1024 * 1024,
  string: 1024 * 1024,
  dictionary: 1_000_000,
  shapes: 4096,
  fields: 256,
};
type Kind = 0 | 1 | 2 | 3; // primitive, string, object, array
type Encoded = null | boolean | number | string | Encoded[];
type Shape = [string, Kind][];
export interface SnapshotTransport {
  format: typeof FORMAT;
  version: 1;
  strings: string[];
  numbers: number[];
  shapes: Shape[];
  data: Encoded;
}
const fail = (): never => {
  throw new Error("The compact snapshot is invalid or exceeds its limits.");
};
const safeKey = (key: string) =>
  key !== "__proto__" && key !== "constructor" && key !== "prototype";
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const kindOf = (value: unknown): Kind =>
  typeof value === "string"
    ? 1
    : Array.isArray(value)
      ? 3
      : object(value)
        ? 2
        : 0;
const index = (value: unknown, length: number): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) < length;

/** Yield bounded traversal work so a large payload cannot monopolize HTTP. */
export function* encodeSnapshotTransportSteps(
  snapshot: unknown,
): Generator<void, SnapshotTransport> {
  if (!object(snapshot)) fail();
  const stringCounts = new Map<string, number>(),
    numberCounts = new Map<number, number>(),
    stringIds = new Map<string, number>(),
    numberIds = new Map<number, number>(),
    shapeIds = new Map<string, number>();
  const strings: string[] = [],
    numbers: number[] = [],
    shapes: Shape[] = [];
  let operations = 0,
    nodes = 0,
    text = 0;
  const textBudget = (value: string) => {
    text += value.length;
    if (value.length > LIMITS.string || text > LIMITS.text) fail();
  };
  const pending = [{ value: snapshot, depth: 0 }];
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (depth > LIMITS.depth || ++nodes > LIMITS.nodes) fail();
    if (++operations % 512 === 0) yield;
    if (typeof value === "string") {
      textBudget(value);
      stringCounts.set(value, (stringCounts.get(value) || 0) + 1);
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) fail();
      if (String(value).length > 7)
        numberCounts.set(value, (numberCounts.get(value) || 0) + 1);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (nodes + pending.length >= LIMITS.nodes) fail();
        pending.push({ value: item ?? null, depth: depth + 1 });
        if (++operations % 512 === 0) yield;
      }
    } else if (object(value)) {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        fail();
      const entries = Object.entries(value).filter(([, v]) => v !== undefined);
      if (entries.length > LIMITS.fields) fail();
      for (const [key, item] of entries) {
        if (!safeKey(key)) fail();
        textBudget(key);
        if (nodes + pending.length >= LIMITS.nodes) fail();
        pending.push({ value: item, depth: depth + 1 });
      }
    } else if (value !== null && typeof value !== "boolean") fail();
  }

  function primitive(value: unknown, kind: Kind): Encoded {
    if (kind === 0) {
      if (typeof value === "number" && (numberCounts.get(value) || 0) > 1) {
        let id = numberIds.get(value);
        if (id === undefined) {
          id = numbers.length;
          if (id >= LIMITS.dictionary) fail();
          numberIds.set(value, id);
          numbers.push(value);
        }
        return [id];
      }
      return value as null | boolean | number;
    }
    const literal = value as string;
    if (stringCounts.get(literal) === 1) return literal;
    let id = stringIds.get(literal);
    if (id === undefined) {
      id = strings.length;
      if (id >= LIMITS.dictionary) fail();
      stringIds.set(literal, id);
      strings.push(literal);
    }
    return id;
  }
  interface Frame {
    value: unknown;
    kind: Kind;
    next: number;
    items?: unknown[];
    output?: Encoded[];
    types?: Kind[];
    homogeneous?: boolean;
    sharedShape?: number;
    pack?: boolean;
  }
  const frames: Frame[] = [{ value: snapshot, kind: 2, next: 0 }];
  let data: Encoded = null;
  while (frames.length) {
    if (++operations % 512 === 0) yield;
    const frame = frames.at(-1)!;
    let result: Encoded;
    if (frame.kind < 2) result = primitive(frame.value, frame.kind);
    else {
      if (!frame.items) {
        if (frame.kind === 2) {
          const entries = Object.entries(
            frame.value as Record<string, unknown>,
          ).filter(([, item]) => item !== undefined);
          // Adjacent history/pool rows usually share a layout. Reuse that
          // checked layout without rebuilding and serializing its signature.
          const parent = frames[frames.length - 2];
          const previous =
            parent?.kind === 3 && parent.sharedShape !== undefined
              ? parent.sharedShape
              : undefined;
          const matches =
            previous !== undefined &&
            shapes[previous].length === entries.length &&
            entries.every(
              ([key, item], i) =>
                key === shapes[previous][i][0] &&
                kindOf(item) === shapes[previous][i][1],
            );
          const shape: Shape = matches
            ? shapes[previous!]
            : entries.map(([key, item]) => [key, kindOf(item)]);
          const key = matches ? null : JSON.stringify(shape);
          let id = matches ? previous : shapeIds.get(key!);
          if (id === undefined) {
            id = shapes.length;
            if (id >= LIMITS.shapes) fail();
            shapes.push(shape);
            shapeIds.set(key!, id);
          }
          frame.items = entries.map(([, item]) => item);
          frame.types = shape.map(([, kind]) => kind);
          frame.output = [id];
        } else {
          const items = frame.value as unknown[];
          frame.items = items;
          const first = kindOf(items[0] ?? null);
          frame.homogeneous = true;
          for (const item of items) {
            if (kindOf(item ?? null) !== first) frame.homogeneous = false;
            if (++operations % 512 === 0) yield;
          }
          frame.output = items.length ? [frame.homogeneous ? first : 4] : [];
          frame.pack = Boolean(
            items.length && frame.homogeneous && first === 2,
          );
        }
      }
      if (frame.next < frame.items.length) {
        const item = frame.items[frame.next] ?? null;
        const kind = frame.types?.[frame.next] ?? kindOf(item);
        frame.next++;
        frames.push({ value: item, kind, next: 0 });
        continue;
      }
      result = frame.output!;
      if (frame.pack && shapes[frame.sharedShape!].length) {
        const packed: Encoded[] = [5, frame.sharedShape!, frame.items.length];
        for (let i = 1; i < frame.output!.length; i++) {
          const row = frame.output![i] as Encoded[];
          for (let j = 1; j < row.length; j++) packed.push(row[j]);
          if (++operations % 512 === 0) yield;
        }
        result = packed;
      }
    }
    frames.pop();
    const parent = frames.at(-1);
    if (!parent) data = result;
    else {
      parent.output!.push(
        parent.kind === 3 && !parent.homogeneous
          ? [frame.kind, result]
          : result,
      );
      if (parent.pack) {
        const id = (result as Encoded[])[0] as number;
        if (parent.sharedShape === undefined) parent.sharedShape = id;
        else if (parent.sharedShape !== id) parent.pack = false;
      }
    }
  }
  return { format: FORMAT, version: 1, strings, numbers, shapes, data };
}

export function encodeSnapshotTransport(snapshot: unknown): SnapshotTransport {
  const steps = encodeSnapshotTransportSteps(snapshot);
  let step;
  do {
    step = steps.next();
  } while (!step.done);
  return step.value;
}

/** Decode before the ordinary domain validator. Unknown versions fail closed;
 * an old server's ordinary JSON response is passed through unchanged. */
export function decodeSnapshotResponse(value: unknown): unknown {
  if (!object(value) || value.format === undefined) return value;
  return decodeSnapshotTransport(value);
}

export function decodeSnapshotTransport(value: unknown): unknown {
  if (
    !object(value) ||
    value.format !== FORMAT ||
    value.version !== 1 ||
    Object.keys(value).sort().join(",") !==
      "data,format,numbers,shapes,strings,version" ||
    !Array.isArray(value.strings) ||
    value.strings.length > LIMITS.dictionary ||
    !Array.isArray(value.numbers) ||
    value.numbers.length > LIMITS.dictionary ||
    !Array.isArray(value.shapes) ||
    value.shapes.length > LIMITS.shapes
  )
    fail();
  const { strings, numbers, shapes } = value as unknown as SnapshotTransport;
  let nodes = 0,
    text = 0,
    tableText = 0;
  const consumeText = (literal: string) => {
    text += literal.length;
    if (literal.length > LIMITS.string || text > LIMITS.text) fail();
    return literal;
  };
  for (const literal of strings) {
    if (typeof literal !== "string" || literal.length > LIMITS.string) fail();
    tableText += literal.length;
    if (tableText > LIMITS.text) fail();
  }
  for (const number of numbers)
    if (typeof number !== "number" || !Number.isFinite(number)) fail();
  for (const shape of shapes) {
    if (!Array.isArray(shape) || shape.length > LIMITS.fields) fail();
    const keys = new Set<string>();
    for (const field of shape) {
      if (
        !Array.isArray(field) ||
        field.length !== 2 ||
        typeof field[0] !== "string" ||
        !safeKey(field[0]) ||
        field[0].length > LIMITS.string ||
        keys.has(field[0]) ||
        !Number.isInteger(field[1]) ||
        field[1] < 0 ||
        field[1] > 3
      )
        fail();
      keys.add(field[0]);
      tableText += field[0].length;
      if (tableText > LIMITS.text) fail();
    }
  }
  const checkNode = (depth: number) => {
    if (depth > LIMITS.depth || ++nodes > LIMITS.nodes) fail();
  };
  function record(
    shape: Shape,
    row: unknown[],
    offset: number,
    depth: number,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (let i = 0; i < shape.length; i++) {
      const [key, kind] = shape[i];
      consumeText(key);
      result[key] = decode(row[offset + i], kind, depth + 1);
    }
    return result;
  }
  function decode(token: unknown, kind: Kind, depth: number): unknown {
    checkNode(depth);
    if (kind === 0) {
      if (Array.isArray(token)) {
        if (token.length !== 1 || !index(token[0], numbers.length)) fail();
        return numbers[token[0]];
      }
      if (
        token !== null &&
        typeof token !== "boolean" &&
        !(typeof token === "number" && Number.isFinite(token))
      )
        fail();
      return token;
    }
    if (kind === 1) {
      if (typeof token === "string") return consumeText(token);
      if (!index(token, strings.length)) fail();
      return consumeText(strings[token as number]);
    }
    if (!Array.isArray(token) || token.length > LIMITS.nodes) fail();
    const row = token as unknown[];
    if (kind === 2) {
      if (!index(row[0], shapes.length)) fail();
      const shape = shapes[row[0] as number];
      if (row.length !== shape.length + 1) fail();
      return record(shape, row, 1, depth);
    }
    if (!row.length) return [];
    const tag = row[0];
    if (tag === 5) {
      if (
        !index(row[1], shapes.length) ||
        !Number.isSafeInteger(row[2]) ||
        Number(row[2]) < 1 ||
        Number(row[2]) > LIMITS.nodes - nodes
      )
        fail();
      const shape = shapes[row[1] as number],
        count = row[2] as number;
      if (!shape.length) fail();
      if (row.length !== 3 + shape.length * count) fail();
      const result = [];
      for (let i = 0; i < count; i++) {
        checkNode(depth + 1);
        result.push(record(shape, row, 3 + i * shape.length, depth + 1));
      }
      return result;
    }
    if (!Number.isInteger(tag) || Number(tag) < 0 || Number(tag) > 4) fail();
    const result = [];
    for (let i = 1; i < row.length; i++) {
      if (tag === 4) {
        const pair = row[i];
        if (
          !Array.isArray(pair) ||
          pair.length !== 2 ||
          !Number.isInteger(pair[0]) ||
          pair[0] < 0 ||
          pair[0] > 3
        )
          fail();
        const typedPair = pair as [Kind, unknown];
        result.push(decode(typedPair[1], typedPair[0], depth + 1));
      } else result.push(decode(row[i], tag as Kind, depth + 1));
    }
    return result;
  }
  return decode((value as unknown as SnapshotTransport).data, 2, 0);
}

/** Exact media-type opt-in; ordinary API consumers retain the public schema. */
export function wantsSnapshotTransport(accept: string | undefined): boolean {
  if (!accept || accept.length > 8192) return false;
  let compactQuality = -1,
    jsonQuality = -1;
  for (const entry of accept.split(",")) {
    const [media, ...parameters] = entry.trim().toLowerCase().split(";");
    const type = media.trim();
    if (type !== SNAPSHOT_TRANSPORT_TYPE && type !== "application/json")
      continue;
    let version = "",
      quality = 1;
    const seen = new Set<string>();
    let valid = true;
    for (const parameter of parameters) {
      const pair = parameter.trim().split("=");
      if (pair.length !== 2) {
        valid = false;
        continue;
      }
      const [name, raw] = pair.map((part) => part.trim());
      if (seen.has(name) || !["version", "q"].includes(name) || !raw)
        valid = false;
      seen.add(name);
      if (name === "version") version = raw === "1" || raw === '"1"' ? "1" : "";
      if (name === "q") {
        if (!/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(raw || ""))
          valid = false;
        quality = Number(raw);
      }
    }
    if (!valid) continue;
    if (type === "application/json")
      jsonQuality = Math.max(jsonQuality, quality);
    else if (version === "1")
      compactQuality = Math.max(compactQuality, quality);
  }
  return compactQuality > 0 && compactQuality >= jsonQuality;
}
