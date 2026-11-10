import type { RadarProject } from "../shared/types";
import { STATIC_EDITION } from "./edition.ts";

export const WATCH_CHANGES_KEY = "hook-radar-watch-changes-v1";
export const MAX_WATCH_CHANGES = 120;
/** The live page looks again this often; the static edition never does (see
 * watchRecheckDelay). */
export const WATCH_RECHECK_MS = 30000;
export interface WatchBaseline {
  id: string;
  name: string;
  hooks: string;
  properties: string;
  metadata: string;
  hookCount: number;
  poolCount: number | null;
  poolComplete: boolean;
  sourceAt: string;
  startedAt: string;
  checkedAt: string;
}
export interface WatchChange {
  id: string;
  projectId: string;
  name: string;
  kind: "hooks" | "properties" | "metadata" | "pools";
  title: string;
  detail: string;
  observedAt: string;
  previousAt: string;
  /** Static edition only: the time of the snapshot that showed the change and of
   * the one it was compared with. observedAt is the visit, which is not a time
   * the data was taken. Entries stored without them are still read. */
  sourceAt?: string;
  previousSourceAt?: string;
}
export interface WatchChangesState {
  version: 1;
  baselines: WatchBaseline[];
  changes: WatchChange[];
  readAt: string | null;
}
export const emptyWatchChanges = (): WatchChangesState => ({
  version: 1,
  baselines: [],
  changes: [],
  readAt: null,
});
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const date = (v: unknown): v is string =>
  typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v));
const id = (v: unknown): v is string =>
  typeof v === "string" && /^[a-z0-9-]{1,100}$/.test(v);
const text = (v: unknown, limit = 800): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= limit;
const hash = (v: unknown): v is string =>
  typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const count = (v: unknown): v is number =>
  Number.isSafeInteger(v) && Number(v) >= 0;

/** Browser storage is presentation history, never authority for chain or market data. */
export function decodeWatchChanges(raw: string | null): WatchChangesState {
  if (raw === null || raw.length > 2_000_000) return emptyWatchChanges();
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !object(value) ||
      value.version !== 1 ||
      !Array.isArray(value.baselines) ||
      value.baselines.length > 2000 ||
      !Array.isArray(value.changes) ||
      value.changes.length > MAX_WATCH_CHANGES ||
      !(value.readAt === null || date(value.readAt))
    )
      return emptyWatchChanges();
    const baselines = value.baselines.filter(
      (b): b is WatchBaseline =>
        object(b) &&
        id(b.id) &&
        text(b.name, 400) &&
        hash(b.hooks) &&
        hash(b.properties) &&
        hash(b.metadata) &&
        count(b.hookCount) &&
        (b.poolCount === null || count(b.poolCount)) &&
        typeof b.poolComplete === "boolean" &&
        date(b.sourceAt) &&
        date(b.startedAt) &&
        date(b.checkedAt),
    );
    const changes = value.changes.filter(
      (c): c is WatchChange =>
        object(c) &&
        hash(c.id) &&
        id(c.projectId) &&
        text(c.name, 400) &&
        ["hooks", "properties", "metadata", "pools"].includes(String(c.kind)) &&
        text(c.title, 400) &&
        text(c.detail) &&
        date(c.observedAt) &&
        date(c.previousAt) &&
        (c.sourceAt === undefined || date(c.sourceAt)) &&
        (c.previousSourceAt === undefined || date(c.previousSourceAt)),
    );
    return {
      version: 1,
      baselines: [...new Map(baselines.map((b) => [b.id, b])).values()],
      changes: [...new Map(changes.map((c) => [c.id, c])).values()],
      readAt: value.readAt as string | null,
    };
  } catch {
    return emptyWatchChanges();
  }
}
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

/** SHA-256 in plain JavaScript, as 64 lowercase hex characters. The browser
 * offers crypto.subtle only on a secure origin (https or localhost); a static
 * site served over plain http, as a shared host can before its certificate is
 * set up, has none, and the stored comparison would never work there. */
export function sha256Hex(message: Uint8Array): string {
  const length = message.length;
  const padded = new Uint8Array(Math.ceil((length + 9) / 64) * 64);
  padded.set(message);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  // The message length in bits, as the 64-bit big-endian number that closes it.
  view.setUint32(padded.length - 8, Math.floor(length / 0x20000000));
  view.setUint32(padded.length - 4, (length * 8) >>> 0);
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15];
      const b = w[i - 2];
      w[i] =
        w[i - 16] +
        (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) +
        w[i - 7] +
        (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10));
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let i = 0; i < 64; i++) {
      const t1 =
        h +
        (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) +
        ((e & f) ^ (~e & g)) +
        SHA256_K[i] +
        w[i];
      const t2 =
        (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) +
        ((a & b) ^ (a & c) ^ (b & c));
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    state[0] += a;
    state[1] += b;
    state[2] += c;
    state[3] += d;
    state[4] += e;
    state[5] += f;
    state[6] += g;
    state[7] += h;
  }
  return Array.from(state, (word) => word.toString(16).padStart(8, "0")).join(
    "",
  );
}

/** SHA-256 of a text as 64 hex characters. The live page always asks the
 * browser (crypto.subtle). The static edition does too when it can, and falls
 * back to sha256Hex when the page was not served from a secure origin. */
async function sha256(
  text: string,
  edition: boolean = STATIC_EDITION,
): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  if (edition && !globalThis.crypto?.subtle) return sha256Hex(bytes);
  const hashed = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hashed), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
async function digest(value: unknown, edition: boolean = STATIC_EDITION) {
  const canonical = (input: unknown): unknown =>
    Array.isArray(input)
      ? input.map(canonical)
      : object(input)
        ? Object.fromEntries(
            Object.keys(input)
              .sort()
              .map((key) => [key, canonical(input[key])]),
          )
        : input;
  return sha256(JSON.stringify(canonical(value)), edition);
}
export async function watchBaseline(
  project: RadarProject,
  sourceAt: string,
  now: string,
  edition: boolean = STATIC_EDITION,
): Promise<WatchBaseline> {
  const hooks = [...project.deployments].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  return {
    id: project.id,
    name: project.name,
    hooks: await digest(
      hooks.map((d) => [d.id, d.chain, d.address.toLowerCase()]),
      edition,
    ),
    properties: await digest(
      hooks.map((d) => [
        d.id,
        d.verifiedSource,
        d.auditUrl,
        d.properties,
        d.flags,
      ]),
      edition,
    ),
    metadata: await digest(
      [
        project.name,
        project.description,
        project.category,
        project.website,
        project.docs,
        hooks.map((d) => [d.id, d.name, d.description, d.sourceUrl]),
      ],
      edition,
    ),
    hookCount: hooks.length,
    poolCount: project.poolInventory?.poolCount ?? null,
    poolComplete: project.poolInventory?.complete === true,
    sourceAt,
    startedAt: now,
    checkedAt: now,
  };
}

/** When the page looks for changes again by itself, or null when it does not.
 * The live page asks again every 30 seconds. The static edition compares the
 * saved projects with one published file: that file changes only when the page
 * loads a newer one, which starts a new comparison, so a timer would only
 * rewrite the check time with the visitor's clock. */
export function watchRecheckDelay(edition = STATIC_EDITION): number | null {
  return edition ? null : WATCH_RECHECK_MS;
}

/** The saved projects counted as tracked. The live page checks every saved id,
 * so each baseline counts. In the static edition only a project the current
 * snapshot carries is compared: a baseline kept for one that has left the
 * registry is not counted. `carried` is the snapshot's project ids, or null
 * when every saved id counts. */
export function trackedBaselines(
  baselines: WatchBaseline[],
  watched: ReadonlySet<string>,
  carried: ReadonlySet<string> | null = null,
): WatchBaseline[] {
  return baselines.filter(
    (baseline) =>
      watched.has(baseline.id) &&
      (carried === null || carried.has(baseline.id)),
  );
}

/** The time to store when the visitor marks the updates read. An update is
 * unread while it was observed after this time. In the static edition a visit
 * behind its snapshot is stamped with the snapshot's time (see
 * observeWatchChanges), so reading must not fall earlier than that. */
export function readMark(
  changes: WatchChange[],
  now = Date.now(),
  edition = STATIC_EDITION,
): string {
  const observed = edition
    ? changes.map((change) => Date.parse(change.observedAt))
    : [];
  return new Date(Math.max(now, ...observed)).toISOString();
}

/** First observation establishes a baseline; only later source snapshots establish changes.
 *
 * In the static edition the snapshot is a published file, not a reading of this
 * browser's clock: a visitor whose clock is behind the snapshot still records
 * it, with the visit stamped no earlier than the snapshot, and each change
 * carries the two snapshot times it was seen between. */
export async function observeWatchChanges(
  previous: WatchChangesState,
  projects: RadarProject[],
  watched: string[],
  sourceAt: string,
  now = new Date().toISOString(),
  edition = STATIC_EDITION,
): Promise<WatchChangesState> {
  if (!date(sourceAt) || !date(now)) return previous;
  if (edition && Date.parse(sourceAt) > Date.parse(now)) now = sourceAt;
  if (Date.parse(sourceAt) > Date.parse(now) + 60000) return previous;
  const ids = new Set(watched);
  const baselines = new Map(
    previous.baselines.filter((b) => ids.has(b.id)).map((b) => [b.id, b]),
  );
  const changes = previous.changes.filter((c) => ids.has(c.projectId));
  for (const project of projects) {
    if (!ids.has(project.id)) continue;
    const prior = baselines.get(project.id);
    if (prior && Date.parse(sourceAt) < Date.parse(prior.sourceAt)) continue;
    if (prior && Date.parse(sourceAt) === Date.parse(prior.sourceAt)) {
      if (Date.parse(now) > Date.parse(prior.checkedAt))
        baselines.set(project.id, { ...prior, checkedAt: now });
      continue;
    }
    const next = await watchBaseline(project, sourceAt, now, edition);
    if (prior) {
      next.startedAt = prior.startedAt;
      const add = async (
        kind: WatchChange["kind"],
        title: string,
        detail: string,
        signature: unknown,
      ) => {
        changes.push({
          id: await digest(
            [project.id, kind, prior.sourceAt, sourceAt, signature],
            edition,
          ),
          projectId: project.id,
          name: project.name,
          kind,
          title,
          detail,
          observedAt: now,
          previousAt: prior.checkedAt,
          ...(edition ? { sourceAt, previousSourceAt: prior.sourceAt } : {}),
        });
      };
      if (next.hooks !== prior.hooks)
        await add(
          "hooks",
          "Hook list changed",
          `${prior.hookCount.toLocaleString("en-US")} → ${next.hookCount.toLocaleString("en-US")} indexed contracts. Open the project to inspect the current addresses; this observation does not establish deployment time.`,
          next.hooks,
        );
      if (next.properties !== prior.properties && next.hooks === prior.hooks)
        await add(
          "properties",
          "Registry declarations changed",
          "Published hook properties, callback flags, source-verification metadata or audit references changed. Inspect the source before relying on them.",
          next.properties,
        );
      if (next.metadata !== prior.metadata && next.hooks === prior.hooks)
        await add(
          "metadata",
          "Project information updated",
          "The published name, description, category or reference links changed.",
          next.metadata,
        );
      if (
        next.poolComplete &&
        prior.poolComplete &&
        next.poolCount !== null &&
        prior.poolCount !== null &&
        next.poolCount !== prior.poolCount
      ) {
        const delta = next.poolCount - prior.poolCount;
        await add(
          "pools",
          delta > 0
            ? `${delta.toLocaleString("en-US")} more ${delta === 1 ? "pool" : "pools"} indexed`
            : "Pool inventory revised",
          `${prior.poolCount.toLocaleString("en-US")} → ${next.poolCount.toLocaleString("en-US")} indexed pools. This measures discovery, not swaps, adoption or pool creation time.`,
          next.poolCount,
        );
      }
    }
    baselines.set(project.id, next);
  }
  return {
    version: 1,
    baselines: [...baselines.values()],
    changes: [...new Map(changes.map((c) => [c.id, c])).values()]
      .sort(
        (a, b) =>
          Date.parse(b.observedAt) - Date.parse(a.observedAt) ||
          a.id.localeCompare(b.id),
      )
      .slice(0, MAX_WATCH_CHANGES),
    readAt: previous.readAt,
  };
}

export function mergeWatchChanges(
  a: WatchChangesState,
  b: WatchChangesState,
): WatchChangesState {
  const baselines = new Map<string, WatchBaseline>();
  for (const baseline of [...a.baselines, ...b.baselines]) {
    const old = baselines.get(baseline.id);
    if (!old || Date.parse(baseline.sourceAt) > Date.parse(old.sourceAt))
      baselines.set(baseline.id, baseline);
    else if (
      Date.parse(baseline.sourceAt) === Date.parse(old.sourceAt) &&
      Date.parse(baseline.checkedAt) > Date.parse(old.checkedAt)
    )
      baselines.set(baseline.id, { ...old, checkedAt: baseline.checkedAt });
  }
  return {
    version: 1,
    baselines: [...baselines.values()].slice(0, 2000),
    changes: [
      ...new Map([...a.changes, ...b.changes].map((c) => [c.id, c])).values(),
    ]
      .sort(
        (x, y) =>
          Date.parse(y.observedAt) - Date.parse(x.observedAt) ||
          x.id.localeCompare(y.id),
      )
      .slice(0, MAX_WATCH_CHANGES),
    readAt:
      [a.readAt, b.readAt]
        .filter((v): v is string => v !== null)
        .sort((x, y) => Date.parse(y) - Date.parse(x))[0] || null,
  };
}
