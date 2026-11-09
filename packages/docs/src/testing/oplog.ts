/**
 * `oplog@1`: the smallest real CRDT the document SPI can carry — a grow-only log of operations,
 * each numbered per replica and naming the version it was made at. Two replicas that hold the
 * same operations read the same list, in any order of delivery; an operation whose dependencies
 * are missing waits until they land. The reference adapter: what `@syncmesh/docs` tests its
 * runtime and its conformance suite with, and what a layer above it (a client, a hook) can test
 * documents with, with no CRDT library in the loop. Not for app data: it never compacts.
 *
 * An operation may retract others (`x`): its value is empty and it hides the ones it names, while
 * it is not itself retracted. That is what `compensate` writes, so an undo, and a redo that
 * retracts the undo, are operations like any other.
 *
 * @module
 */
import { isJsonArray, jsonObject, parseAdapterId, type JsonValue } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";

import {
  DEFAULT_LIMITS,
  UpdateRejected,
  type DocLimits,
  type DocumentAdapter,
} from "../adapter.js";

export const OPLOG_ID = parseAdapterId("oplog@1").unwrap();

/**
 * One operation: replica, its number on that replica (from 1), the version it was made at, and its
 * value; or, with `x`, the operations it retracts.
 */
interface Op {
  readonly r: string;
  readonly n: number;
  readonly deps: Readonly<Record<string, number>>;
  readonly v: string;
  readonly x?: readonly string[];
}

/** The document an app edits: what it has applied, what waits on dependencies, and its listeners. */
export interface OpLog {
  readonly replica: string;
  readonly applied: Map<string, Op>;
  readonly waiting: Map<string, Op>;
  readonly listeners: Set<() => void>;
}

const opKey = (op: Op) => `${op.r}:${String(op.n)}`;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const reject = (message: string) => new UpdateRejected({ adapter: OPLOG_ID, message });

/** Per replica, the highest operation number held without a gap. */
function clock(doc: OpLog): Map<string, number> {
  const held = new Map<string, number>();
  for (const op of [...doc.applied.values()].sort((a, b) => a.n - b.n))
    if ((held.get(op.r) ?? 0) === op.n - 1) held.set(op.r, op.n);
  return held;
}

const covered = (at: ReadonlyMap<string, number>, op: Op) => (at.get(op.r) ?? 0) >= op.n;

const ready = (at: ReadonlyMap<string, number>, op: Op) =>
  (at.get(op.r) ?? 0) === op.n - 1 &&
  Object.entries(op.deps).every(([r, n]) => (at.get(r) ?? 0) >= n);

/** The version as canonical bytes: replicas in ascending order, each with its count. */
const encodeClock = (at: ReadonlyMap<string, number>) =>
  encoder.encode(JSON.stringify([...at].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));

const isCount = (n: JsonValue | undefined, from: number): n is number =>
  Number.isSafeInteger(n) && Number(n) >= from;

/* oxlint-disable anti-slop/no-runtime-typeof -- foreign bytes are read at their runtime shape */
/** One operation back from its JSON, or `undefined` for anything this adapter never writes. */
function opOf(value: JsonValue): Op | undefined {
  const held = jsonObject(value);
  const deps = jsonObject(held?.["deps"]);
  const { r, n, v, x } = held ?? {};
  if (typeof r !== "string" || typeof v !== "string" || !isCount(n, 1) || deps === undefined)
    return undefined;
  const at: Record<string, number> = {};
  for (const [replica, count] of Object.entries(deps)) {
    if (!isCount(count, 0)) return undefined;
    at[replica] = count;
  }
  if (x === undefined) return { r, n, deps: at, v };
  if (!isJsonArray(x) || !x.every((key) => typeof key === "string")) return undefined;
  return { r, n, deps: at, v, x: x.filter((key) => typeof key === "string") };
}

/** A version back from its JSON: `[replica, count]` pairs, or `undefined`. */
function clockOf(value: JsonValue): Map<string, number> | undefined {
  if (!isJsonArray(value)) return undefined;
  const at = new Map<string, number>();
  for (const pair of value) {
    if (!isJsonArray(pair) || pair.length !== 2) return undefined;
    const [replica, count] = pair;
    if (typeof replica !== "string" || !isCount(count, 0)) return undefined;
    at.set(replica, count);
  }
  return at;
}
/* oxlint-enable anti-slop/no-runtime-typeof */

/** The bytes as JSON, or a refusal: what every foreign update and version is read through. */
const parseJson = (bytes: Uint8Array, what: string): Result<JsonValue, UpdateRejected> =>
  Result.try({
    // SAFETY: JSON.parse yields only JSON values
    try: () => JSON.parse(decoder.decode(bytes)) as JsonValue,
    catch: () => reject(`not an oplog@1 ${what}`),
  });

const parseOps = (bytes: Uint8Array): Result<readonly Op[], UpdateRejected> =>
  parseJson(bytes, "update").andThen((value) => {
    const ops = isJsonArray(value) ? value.map(opOf) : [undefined];
    return ops.every((op) => op !== undefined)
      ? Result.ok(ops)
      : Result.err(reject("not an oplog@1 update"));
  });

const parseClock = (bytes: Uint8Array): Result<Map<string, number>, UpdateRejected> =>
  parseJson(bytes, "version").andThen((value) => {
    const at = clockOf(value);
    return at === undefined ? Result.err(reject("not an oplog@1 version")) : Result.ok(at);
  });

const exportOps = (ops: Iterable<Op>) =>
  encoder.encode(JSON.stringify([...ops].sort((a, b) => (opKey(a) < opKey(b) ? -1 : 1))));

/** Appends `value` on `doc`'s replica at its current version, and commits it. */
export function append(doc: OpLog, value: string) {
  const at = clock(doc);
  const op = {
    r: doc.replica,
    n: (at.get(doc.replica) ?? 0) + 1,
    deps: Object.fromEntries(at),
    v: value,
  };
  doc.applied.set(opKey(op), op);
  for (const listener of doc.listeners) listener();
}

/**
 * Whether each applied operation shows: one is hidden while an operation that shows retracts it.
 * A retraction comes after what it names, so following them never loops.
 */
function showing(doc: OpLog): (op: Op) => boolean {
  const by = new Map<string, Op[]>();
  for (const op of doc.applied.values())
    for (const key of op.x ?? []) by.set(key, [...(by.get(key) ?? []), op]);
  const seen = new Map<string, boolean>();
  const shows = (op: Op): boolean => {
    const key = opKey(op);
    const held = seen.get(key);
    if (held !== undefined) return held;
    const answer = !(by.get(key) ?? []).some(shows);
    seen.set(key, answer);
    return answer;
  };
  return shows;
}

/** What an app reads: every value that shows, by replica and then number. */
export const values = (doc: OpLog): readonly string[] => {
  const shows = showing(doc);
  return [...doc.applied.values()]
    .filter((op) => op.x === undefined && shows(op))
    .sort((a, b) => (a.r === b.r ? a.n - b.n : a.r < b.r ? -1 : 1))
    .map((op) => op.v);
};

/** The `oplog@1` adapter. */
export function oplog(limits: Partial<DocLimits> = {}): DocumentAdapter<OpLog> {
  return {
    id: OPLOG_ID,
    limits: { ...DEFAULT_LIMITS, ...limits },
    create: (replica) => ({
      replica: replica.toString(),
      applied: new Map(),
      waiting: new Map(),
      listeners: new Set(),
    }),
    apply: (doc, updates) =>
      Result.gen(function* () {
        const ops: Op[] = [];
        for (const update of updates) ops.push(...(yield* parseOps(update)));
        const before = doc.applied.size;
        for (const op of ops) if (!doc.applied.has(opKey(op))) doc.waiting.set(opKey(op), op);
        for (let released = true; released;) {
          released = false;
          const at = clock(doc);
          for (const [key, op] of doc.waiting)
            if (ready(at, op)) {
              doc.waiting.delete(key);
              doc.applied.set(key, op);
              released = true;
            }
        }
        return Result.ok(doc.applied.size !== before);
      }),
    pending: (doc) => doc.waiting.size > 0,
    snapshot: (doc) => exportOps(doc.applied.values()),
    version: (doc) => encodeClock(clock(doc)),
    since: (doc, version) =>
      parseClock(version).map((from) =>
        exportOps([...doc.applied.values()].filter((op) => !covered(from, op))),
      ),
    watchLocal: (doc, listener) => {
      doc.listeners.add(listener);
      return () => void doc.listeners.delete(listener);
    },
    compensate: (doc, updates, replica) =>
      Result.gen(function* () {
        const ops: Op[] = [];
        for (const update of updates) ops.push(...(yield* parseOps(update)));
        const shows = showing(doc);
        // what still shows of the write: an undo hides it, a redo hides the undo
        const standing = ops.filter((op) => {
          const held = doc.applied.get(opKey(op));
          return held !== undefined && shows(held);
        });
        if (standing.length === 0) return Result.ok(undefined);
        const at = clock(doc);
        const r = replica.toString();
        const op = {
          r,
          n: (at.get(r) ?? 0) + 1,
          deps: Object.fromEntries(at),
          v: "",
          x: standing.map(opKey).sort(),
        };
        return Result.ok(exportOps([op]));
      }),
  };
}
