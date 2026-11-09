/**
 * The document SPI's conformance suite (RFC-0023 §13): what every {@link DocumentAdapter} must
 * hold, checked against the adapter itself, with no engine, store or runtime in the loop. An
 * adapter package runs {@link checkAdapter} from its own tests; `@syncmesh/docs` runs it over the
 * reference adapter its runtime tests use.
 *
 * @module
 */
import { Result, TaggedError } from "@syncmesh/result";
import { bytesEqual } from "@syncmesh/wire";

import type { DocumentAdapter } from "../adapter.js";

export type { OpLog } from "./oplog.js";
export { OPLOG_ID, append, oplog, values } from "./oplog.js";

/** One property an adapter broke, and how. */
export interface AdapterFailure {
  /** Which property: `converges`, `idempotent`, `pending`, `snapshot`, `since`, `total`, `watchLocal`, `empty`. */
  readonly check: string;
  readonly message: string;
}

/** The adapter broke at least one of the SPI's properties; every one it broke is listed. */
export class AdapterNonConformant extends TaggedError("AdapterNonConformant")<{
  adapter: string;
  failures: readonly AdapterFailure[];
  message: string;
}> {}

/**
 * How the suite edits and reads the adapter's own document, which it cannot do through the SPI:
 * the SPI carries documents and never edits them (RFC-0023 §4.3).
 */
export interface AdapterScript<D> {
  /** Makes the `n`th edit on `doc` and commits it, so `watchLocal` hears it. Each `n` is used once. */
  readonly edit: (doc: D, n: number) => void;
  /** The document's content as an app reads it, as text: two converged documents read alike. */
  readonly read: (doc: D) => string;
}

/** Bytes a hostile or broken peer could send: none, a few, and noise. */
const NOISE = [
  new Uint8Array(),
  Uint8Array.of(0),
  Uint8Array.of(0xff, 0xff, 0xff, 0xff),
  Uint8Array.from({ length: 64 }, (_, i) => (i * 37 + 11) % 256),
];

/** Truncations and single-bit flips of `bytes`, at a handful of fixed places. */
const mangled = (bytes: Uint8Array): readonly Uint8Array[] => {
  const places = [0, 1, Math.floor(bytes.length / 2), bytes.length - 1].filter(
    (at, i, all) => at >= 0 && at < bytes.length && all.indexOf(at) === i,
  );
  return places.flatMap((at) => {
    const flipped = Uint8Array.from(bytes);
    flipped[at] = (flipped[at] ?? 0) ^ 0x10;
    return [bytes.subarray(0, at), flipped];
  });
};

/** Every rotation of `xs`, and `xs` backwards: a few delivery orders, deterministic. */
const orders = <T>(xs: readonly T[]): readonly (readonly T[])[] => [
  ...xs.map((_, i) => [...xs.slice(i), ...xs.slice(0, i)]),
  [...xs].reverse(),
];

/** What every check shares: the adapter, the script, and where a broken property is written down. */
interface Suite<D> {
  readonly adapter: DocumentAdapter<D>;
  readonly script: AdapterScript<D>;
  readonly fail: (check: string, message: string) => void;
  /** Runs one member call; a throw is a failure of `check` and comes back as `undefined`. */
  readonly guarded: <T>(check: string, what: string, fn: () => Awaited<T>) => T | undefined;
  /** An empty document on a replica no other document of the run shares. */
  readonly fresh: () => D;
  /** Makes one edit and exports it the way a flush does: everything past the version before it. */
  readonly edit: (doc: D) => Uint8Array | undefined;
  /** The next edit number, used once. */
  readonly next: () => number;
}

/**
 * Updates from three replicas: a1 a2 from one, b1 from another after importing a1, c1 alone, a3
 * after b1 — so some depend on others, and some are concurrent.
 */
function history<D>(suite: Suite<D>) {
  const { adapter, fresh, edit } = suite;
  const [a, b, c] = [fresh(), fresh(), fresh()];
  const a1 = edit(a);
  const a2 = edit(a);
  if (a1 !== undefined) adapter.apply(b, [a1]);
  const b1 = edit(b);
  const c1 = edit(c);
  if (b1 !== undefined) adapter.apply(a, [b1]);
  const a3 = edit(a);
  if (a1 === undefined || a2 === undefined || b1 === undefined) return undefined;
  if (c1 === undefined || a3 === undefined) return undefined;
  return { updates: [a1, a2, b1, c1, a3], a1, b1 };
}

/** Every delivery order, batched or one at a time, reaches one version and one content. */
function converges<D>(suite: Suite<D>, updates: readonly Uint8Array[]) {
  const { adapter, fail, guarded, fresh, script } = suite;
  const full = fresh();
  if (guarded("converges", "apply", () => adapter.apply(full, updates))?.isOk() !== true)
    fail("converges", "a batch of valid updates was refused");
  const version = adapter.version(full);
  const content = script.read(full);
  for (const order of orders(updates)) {
    const batched = fresh();
    guarded("converges", "apply", () => adapter.apply(batched, order));
    const oneByOne = fresh();
    for (const update of order)
      guarded("converges", "apply", () => adapter.apply(oneByOne, [update]));
    for (const [doc, how] of [
      [batched, "in one batch"],
      [oneByOne, "one at a time"],
    ] as const) {
      if (!bytesEqual(adapter.version(doc), version))
        fail("converges", `an order applied ${how} reached another version`);
      if (script.read(doc) !== content)
        fail("converges", `an order applied ${how} reads differently`);
      if (adapter.pending(doc)) fail("converges", `every update held, ${how}, yet still pending`);
    }
  }
  return { full, version, content };
}

/** Importing what a document already holds changes nothing, and says so. */
function idempotent<D>(suite: Suite<D>, full: D, updates: readonly Uint8Array[]) {
  const { adapter, fail, guarded } = suite;
  const version = adapter.version(full);
  const again = guarded("idempotent", "apply", () => adapter.apply(full, updates));
  if (again?.isOk() === true && again.value) fail("idempotent", "re-importing reported a change");
  if (!bytesEqual(adapter.version(full), version))
    fail("idempotent", "re-importing moved the version");
}

/** An update whose dependency is missing waits, and stops waiting once it lands. */
function pending<D>(suite: Suite<D>, dependent: Uint8Array, dependency: Uint8Array) {
  const { adapter, fail, guarded, fresh } = suite;
  const waiting = fresh();
  guarded("pending", "apply", () => adapter.apply(waiting, [dependent]));
  if (!adapter.pending(waiting))
    fail("pending", "an update whose dependency is missing is not pending");
  guarded("pending", "apply", () => adapter.apply(waiting, [dependency]));
  if (adapter.pending(waiting)) fail("pending", "still pending once its dependency landed");
}

/** A snapshot and the updates after it are the whole document. */
function snapshots<D>(suite: Suite<D>, updates: readonly Uint8Array[], whole: D) {
  const { adapter, fail, guarded, fresh, script } = suite;
  const half = fresh();
  adapter.apply(half, updates.slice(0, 2));
  const snapshot = guarded("snapshot", "snapshot", () => adapter.snapshot(half));
  if (snapshot === undefined) return;
  const restored = fresh();
  if (guarded("snapshot", "apply", () => adapter.apply(restored, [snapshot]))?.isOk() !== true)
    fail("snapshot", "a snapshot it wrote was refused");
  adapter.apply(restored, updates.slice(2));
  const same = bytesEqual(adapter.version(restored), adapter.version(whole));
  if (!same || script.read(restored) !== script.read(whole))
    fail("snapshot", "a snapshot and the tail after it are not the whole document");
}

/** What `since` exports past a version brings a document there to the source, and nothing more. */
function since<D>(suite: Suite<D>, updates: readonly Uint8Array[], whole: D) {
  const { adapter, fail, guarded, fresh } = suite;
  const version = adapter.version(whole);
  const behind = fresh();
  adapter.apply(behind, updates.slice(0, 2));
  const past = guarded("since", "since", () => adapter.since(whole, adapter.version(behind)));
  if (past?.isOk() !== true) return fail("since", "since refused a version the adapter wrote");
  adapter.apply(behind, [past.value]);
  if (!bytesEqual(adapter.version(behind), version))
    fail("since", "what since exported did not bring the document to the source's version");
  const nothing = guarded("since", "since", () => adapter.since(whole, version));
  if (nothing?.isOk() !== true) return undefined;
  const copy = fresh();
  adapter.apply(copy, updates);
  const moved = adapter.apply(copy, [nothing.value]);
  if ((moved.isOk() && moved.value) || !bytesEqual(adapter.version(copy), version))
    fail("since", "since past the current version exported something new");
  return undefined;
}

/** No bytes, noise, truncation or flipped bit makes an import throw. */
function total<D>(suite: Suite<D>, updates: readonly Uint8Array[]) {
  const target = suite.fresh();
  for (const bytes of [...NOISE, ...updates.flatMap(mangled)])
    suite.guarded("total", "apply of foreign bytes", () => suite.adapter.apply(target, [bytes]));
}

/** A local commit calls the listener; a stopped one is never called again. */
function watchLocal<D>(suite: Suite<D>) {
  const { adapter, fail, guarded, fresh, script, next } = suite;
  const watched = fresh();
  let heard = 0;
  const stop = guarded("watchLocal", "watchLocal", () =>
    adapter.watchLocal(watched, () => (heard += 1)),
  );
  script.edit(watched, next());
  if (heard === 0) fail("watchLocal", "a local commit did not call the listener");
  stop?.();
  const before = heard;
  script.edit(watched, next());
  if (heard !== before) fail("watchLocal", "a stopped listener was called again");
}

/**
 * Checks `adapter` against the SPI's properties, with `script` to edit and read its documents:
 *
 * - **converges** — three replicas edit concurrently, two of them after importing another's
 *   update; every delivery order, in one batch or one update at a time, reaches one version
 *   byte for byte and one content.
 * - **idempotent** — importing what a document already holds changes nothing and says so.
 * - **pending** — an update whose dependencies are missing leaves the document `pending` until
 *   they land.
 * - **snapshot** — a snapshot plus the updates after it is the same document as all the updates.
 * - **since** — what `since` exports past a version brings a document at that version to the
 *   source's version, and nothing past its own version.
 * - **total** — no bytes, noise, truncations or flipped bits make an import throw.
 * - **watchLocal** — a local commit calls the listener, and a stopped one is never called again.
 * - **empty** — two empty documents of different replicas have one version.
 *
 * Every member call is checked for a throw, which is a failure of its own: the SPI is total.
 *
 * @example
 * const checked = checkAdapter(loro(), {
 *   edit: (doc, n) => { doc.getText("t").insert(0, String(n)); doc.commit(); },
 *   read: (doc) => doc.getText("t").toString(),
 * });
 * expect(checked.isOk()).toBe(true);
 */
export function checkAdapter<D>(
  adapter: DocumentAdapter<D>,
  script: AdapterScript<D>,
): Result<void, AdapterNonConformant> {
  const failures: AdapterFailure[] = [];
  const fail = (check: string, message: string) => void failures.push({ check, message });
  let replica = 0n;
  let edits = 0;
  const suite: Suite<D> = {
    adapter,
    script,
    fail,
    guarded: <T>(check: string, what: string, fn: () => Awaited<T>) => {
      const ran = Result.try({ try: fn, catch: (cause) => String(cause) });
      if (ran.isErr()) fail(check, `${what} threw: ${ran.error}`);
      return ran.isOk() ? ran.value : undefined;
    },
    fresh: () => adapter.create((replica += 1n)),
    next: () => (edits += 1),
    edit: (doc) => {
      const before = adapter.version(doc);
      script.edit(doc, (edits += 1));
      const update = suite.guarded("converges", "since", () => adapter.since(doc, before));
      if (update?.isErr() === true) fail("converges", "since refused a version it wrote");
      return update?.isOk() === true ? update.value : undefined;
    },
  };
  const made = history(suite);
  if (made === undefined) return refused(adapter, failures);
  const { full } = converges(suite, made.updates);
  idempotent(suite, full, made.updates);
  pending(suite, made.b1, made.a1);
  snapshots(suite, made.updates, full);
  since(suite, made.updates, full);
  total(suite, made.updates);
  watchLocal(suite);
  if (!bytesEqual(adapter.version(suite.fresh()), adapter.version(suite.fresh())))
    fail("empty", "two empty documents have different versions");
  return failures.length === 0 ? Result.ok(undefined) : refused(adapter, failures);
}

const refused = <D>(adapter: DocumentAdapter<D>, failures: readonly AdapterFailure[]) =>
  Result.err(
    new AdapterNonConformant({
      adapter: adapter.id,
      failures,
      message: failures.map((f) => `${f.check}: ${f.message}`).join("; ") || "no updates exported",
    }),
  );
