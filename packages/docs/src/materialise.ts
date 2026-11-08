import type {
  DocAddress,
  DocCoverStale,
  DocEntryRef,
  DocTail,
  Engine,
  StoreFailure,
  TailUpdate,
} from "@syncmesh/engine";
import type { Hlc, PeerId, Row, SeqNum } from "@syncmesh/kernel";
import type { Temporal } from "@syncmesh/temporal";

import { Result } from "@syncmesh/result";
import { bytesEqual, signCheckpoint, type Identity, type SignedCheckpoint } from "@syncmesh/wire";

import type { DocumentAdapter, UpdateRejected } from "./adapter.js";

import { behindHeld, refuseCheckpoint, resolveCheckpoint, snapshotHash } from "./checkpoint.js";
import { DocPending, DocTooLarge } from "./errors.js";

/** What the runtime asks of an engine: the write path, the fold feed and the doc log. */
export type DocsEngine = Pick<
  Engine,
  "peerId" | "mutate" | "onFoldBatch" | "docTail" | "coverDoc" | "docHeads" | "state" | "cursors"
>;

/**
 * A row's derived columns computed from the adapter's document (RFC-0023 §16.4); `undefined` when
 * the column derives nothing or the computation failed, which the runtime has already reported.
 */
export type Derive<D> = (doc: D) => Row | undefined;

/** A document rebuilt from its snapshot and tail, and which tail updates it could import. */
export interface Loaded<D> {
  readonly doc: D;
  readonly applied: readonly TailUpdate[];
  /** Updates the adapter refused (RFC-0023 §10): the document stays at its last good version. */
  readonly failed: readonly TailUpdate[];
  /** Blob-carried updates whose bytes this runtime does not hold yet. */
  readonly missing: readonly TailUpdate[];
  /** Whether imported operations wait on ones the tail lacks (see {@link DocumentAdapter.pending}). */
  readonly pending: boolean;
}

/**
 * Rebuilds a document on a fresh replica: the snapshot, then the tail in one batch, then — only
 * if the batch was refused — update by update, so one bad update costs only itself.
 */
export function load<D>(
  adapter: DocumentAdapter<D>,
  tail: DocTail,
  replica: bigint,
): Result<Loaded<D>, UpdateRejected> {
  const doc = adapter.create(replica);
  if (tail.snapshot !== undefined) {
    const base = adapter.apply(doc, [tail.snapshot.bytes]);
    if (base.isErr()) return Result.err(base.error);
  }
  const inline = tail.updates.filter((u) => u.bytes !== undefined);
  const missing = tail.updates.filter((u) => u.bytes === undefined);
  const bytes = inline.map((u) => u.bytes ?? new Uint8Array());
  if (adapter.apply(doc, bytes).isOk())
    return Result.ok({ doc, applied: inline, failed: [], missing, pending: adapter.pending(doc) });
  const applied: TailUpdate[] = [];
  const failed: TailUpdate[] = [];
  for (const u of inline)
    (adapter.apply(doc, [u.bytes ?? new Uint8Array()]).isOk() ? applied : failed).push(u);
  return Result.ok({ doc, applied, failed, missing, pending: adapter.pending(doc) });
}

const ref = ({ entry }: TailUpdate): DocEntryRef => ({
  author: entry.author,
  seq: entry.seq,
  index: entry.index,
});

/**
 * The floor a snapshot can claim: per author, the highest sequence below which every one of their
 * updates to this document is in it — never past an update whose bytes are still missing.
 */
function snapshotFloor(tail: DocTail, settled: readonly TailUpdate[]): Map<PeerId, SeqNum> {
  const floor = new Map(tail.head?.covers ?? []);
  const done = new Set(settled.map((u) => u.entry));
  const stopped = new Set<PeerId>();
  // by change, not by event: one unsettled change holds its whole event, and its author, back
  for (const { entry } of tail.updates) {
    if (stopped.has(entry.author)) continue;
    if (!done.has(entry)) {
      stopped.add(entry.author);
      continue;
    }
    if ((floor.get(entry.author) ?? 0) < entry.seq) floor.set(entry.author, entry.seq);
  }
  return floor;
}

/** What a materialisation took into the snapshot. */
export interface Materialised {
  readonly covered: number;
  readonly failed: number;
  readonly snapshotBytes: number;
}

/**
 * Writes a document's snapshot and marks the tail it holds `covered` (RFC-0023 §6.3, §8.2), so
 * compaction may take those events. Always from a fresh replica — never from an open handle,
 * whose unflushed edits must not reach a snapshot the log never carried. A document whose
 * operations wait on ones not held yet is refused ({@link DocPending}), and so is one whose head
 * another materialisation moved meanwhile (`DocCoverStale`).
 */
export async function materialise<D>(
  engine: DocsEngine,
  adapter: DocumentAdapter<D>,
  address: DocAddress,
  replica: bigint,
  at: Temporal.Instant,
  derive?: Derive<D>,
): Promise<
  Result<Materialised, UpdateRejected | DocTooLarge | DocPending | StoreFailure | DocCoverStale>
> {
  return Result.gen(async function* () {
    const tail = yield* Result.await(engine.docTail(address));
    const loaded = yield* load(adapter, tail, replica);
    // the snapshot would leave those operations out, and covering their updates would lose them
    if (loaded.pending)
      return Result.err(
        new DocPending({ message: "operations in the tail wait on ones this device lacks" }),
      );
    const snapshot = adapter.snapshot(loaded.doc);
    const limit = adapter.limits.maxSnapshotBytes;
    if (snapshot.length > limit)
      return Result.err(
        new DocTooLarge({
          size: snapshot.length,
          limit,
          message: `the document's snapshot is ${String(snapshot.length)} bytes`,
        }),
      );
    const settled = [...loaded.applied, ...loaded.failed];
    const derived = derive?.(loaded.doc);
    yield* Result.await(
      engine.coverDoc(address, {
        ...(derived !== undefined && { derived }),
        adapter: adapter.id,
        covers: snapshotFloor(tail, settled),
        version: adapter.version(loaded.doc),
        snapshot,
        mode: "materialised",
        ...(tail.head?.version !== undefined && { base: tail.head.version }),
        at,
        covered: loaded.applied.map(ref),
        failed: loaded.failed.map(ref),
        ...(tail.lineage !== undefined && { lineage: tail.lineage }),
      }),
    );
    return Result.ok({
      covered: loaded.applied.length,
      failed: loaded.failed.length,
      snapshotBytes: snapshot.length,
    });
  });
}

/** A signed checkpoint and the snapshot bytes it names by hash (RFC-0023 §5.5). */
export interface ProducedCheckpoint {
  readonly signed: SignedCheckpoint;
  readonly snapshot: Uint8Array;
}

/**
 * Materialises, then signs what the snapshot is: the record a joiner below the floor installs, and
 * the one an opaque host takes the derived values from (key 8, RFC-0023 §7.2). A `sealed`
 * partition's derived values are plaintext read out of sealed content, so they never leave the
 * devices that hold its key (§11): key 8 is then empty, while this device's own row still gets them.
 */
export async function produceCheckpoint<D>(
  engine: DocsEngine,
  adapter: DocumentAdapter<D>,
  address: DocAddress,
  producer: Identity,
  replica: bigint,
  at: Hlc,
  derive?: Derive<D>,
  sealed = false,
) {
  return Result.gen(async function* () {
    yield* Result.await(materialise(engine, adapter, address, replica, at[0], derive));
    const tail = yield* Result.await(engine.docTail(address));
    const snapshot = tail.snapshot?.bytes ?? adapter.snapshot(adapter.create(replica));
    const held = adapter.create(replica);
    const withheld = sealed || derive === undefined || adapter.apply(held, [snapshot]).isErr();
    const derived = withheld ? undefined : derive(held);
    const signed = signCheckpoint(
      {
        ...address,
        adapter: adapter.id,
        covers: tail.head?.covers ?? new Map(),
        version: tail.head?.version ?? adapter.version(adapter.create(replica)),
        snapshot: { hash: snapshotHash(snapshot), size: snapshot.length },
        derived: derived ?? new Map(),
        at,
        ...(tail.lineage !== undefined && { lineage: tail.lineage }),
      },
      producer,
    );
    return Result.ok<ProducedCheckpoint>({ signed, snapshot });
  });
}

/** What a checkpoint is checked against before the log is: its signature, bytes and version. */
function verified<D>(
  engine: DocsEngine,
  adapter: DocumentAdapter<D>,
  address: DocAddress,
  wire: Uint8Array,
  producer: PeerId,
  snapshot: Uint8Array,
  replica: bigint,
) {
  return resolveCheckpoint(engine, adapter.id, address, wire, producer, snapshot).andThen(
    (checkpoint) => {
      const doc = adapter.create(replica);
      const parsed = adapter.apply(doc, [snapshot]);
      if (parsed.isErr())
        return refuseCheckpoint("the adapter cannot read the snapshot", parsed.error);
      if (!bytesEqual(adapter.version(doc), checkpoint.version))
        return refuseCheckpoint(
          "the snapshot does not reproduce the version the checkpoint claims",
        );
      return Result.ok({ checkpoint, doc });
    },
  );
}

/**
 * The updates under a checkpoint's floor its snapshot holds, re-imported one by one; `undefined`
 * if one moves the document, leaves it pending, or is readable on its own yet refused by the
 * snapshot. One unreadable on its own is `failed`; a missing one, neither. Costs one import per
 * update under the floor, and two for each the snapshot refuses.
 */
function heldBy<D>(adapter: DocumentAdapter<D>, doc: D, below: TailUpdate[], replica: bigint) {
  const covered: TailUpdate[] = [];
  const failed: TailUpdate[] = [];
  for (const u of below) {
    if (u.bytes === undefined) continue;
    const moved = adapter.apply(doc, [u.bytes]);
    // held if it moves nothing; if refused, unreadable only when a fresh replica refuses it too
    if (moved.isOk() ? moved.value : adapter.apply(adapter.create(replica), [u.bytes]).isOk())
      return undefined;
    (moved.isOk() ? covered : failed).push(u);
  }
  return adapter.pending(doc) ? undefined : { covered: covered.map(ref), failed: failed.map(ref) };
}

/**
 * Installs a checkpoint in place of history this device never held (RFC-0023 §8.4): verified
 * against the producer's key, the snapshot's hash, the column's adapter and winning lineage, and
 * by re-deriving the version from the bytes — a snapshot that does not reproduce the version it
 * claims is refused, whoever signed it. A checkpoint of another document than `address`, one
 * behind the snapshot this device already holds, or one whose floor claims tail updates the
 * snapshot does not hold, is refused too. Trust in the producer is the caller's question (§7.3).
 */
export async function installCheckpoint<D>(
  engine: DocsEngine,
  adapter: DocumentAdapter<D>,
  address: DocAddress,
  wire: Uint8Array,
  producer: PeerId,
  snapshot: Uint8Array,
  replica: bigint,
  at: Temporal.Instant,
  derive?: Derive<D>,
) {
  return Result.gen(async function* () {
    const { checkpoint, doc } = yield* verified(
      engine,
      adapter,
      address,
      wire,
      producer,
      snapshot,
      replica,
    );
    const tail = yield* Result.await(engine.docTail(address));
    if (behindHeld(tail, checkpoint))
      return refuseCheckpoint("the checkpoint is behind the snapshot this device holds");
    const below = tail.updates.filter(
      ({ entry }) => entry.seq <= (checkpoint.covers.get(entry.author) ?? 0),
    );
    const holds = heldBy(adapter, doc, below, replica);
    if (holds === undefined)
      return refuseCheckpoint("the snapshot lacks updates the checkpoint's floor claims");
    // computed here, never taken from key 8: every replica that can read the document derives it
    const derived = derive?.(doc);
    yield* Result.await(
      engine.coverDoc(address, {
        ...(derived !== undefined && { derived }),
        adapter: adapter.id,
        covers: checkpoint.covers,
        version: checkpoint.version,
        snapshot,
        mode: "checkpoint",
        ...(tail.head?.version !== undefined && { base: tail.head.version }),
        at,
        ...holds,
        ...(checkpoint.lineage !== undefined && { lineage: checkpoint.lineage }),
      }),
    );
    return Result.ok(checkpoint);
  });
}
