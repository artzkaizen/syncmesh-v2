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

import { getRecord } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";
import { signCheckpoint, type Identity, type SignedCheckpoint } from "@syncmesh/wire";

import type { DocumentAdapter, UpdateRejected } from "./adapter.js";

import { snapshotHash } from "./checkpoint.js";
import { DocPending, DocTooLarge, SnapshotUnsealable } from "./errors.js";
import { sealSnapshot, type SealingKeys } from "./sealed-snapshot.js";

/** What the runtime asks of an engine: the write path, the fold feed and the doc log. */
export type DocsEngine = Pick<
  Engine,
  | "peerId"
  | "mutate"
  | "onFoldBatch"
  | "docTail"
  | "docLogOf"
  | "docLineageLog"
  | "coverDoc"
  | "docHeads"
  | "state"
  | "cursors"
  | "mayEditDoc"
  | "writeDerived"
  | "revert"
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

/** The doc log entry a tail update was read from. */
export const entryRef = ({ entry }: TailUpdate): DocEntryRef => ({
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
  /** The derived values written with the cover (RFC-0023 §16.4); absent when the column derives nothing or the derive failed. */
  readonly derived?: Row;
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
        covered: loaded.applied.map(entryRef),
        failed: loaded.failed.map(entryRef),
        ...(tail.lineage !== undefined && { lineage: tail.lineage }),
      }),
    );
    return Result.ok({
      covered: loaded.applied.length,
      failed: loaded.failed.length,
      snapshotBytes: snapshot.length,
      ...(derived !== undefined && { derived }),
    });
  });
}

/** A signed checkpoint and the snapshot bytes it names by hash (RFC-0023 §5.5). */
export interface ProducedCheckpoint {
  readonly signed: SignedCheckpoint;
  /** What the checkpoint's key 7 hashes: for a sealed partition, the snapshot sealed to its key. */
  readonly snapshot: Uint8Array;
}

/**
 * Materialises, then signs what the snapshot is: the record a joiner below the floor installs, and
 * the one an opaque host takes the derived values from (key 8, RFC-0023 §7.2).
 *
 * A `sealed` partition's checkpoint gives the host neither plaintext (§11, gaps U24): key 8 is
 * empty, because derived values are read out of sealed content, while this device's own row still
 * gets them; and the snapshot is sealed to the partition's newest content key from `keys`, so the
 * bytes key 7 names, and the host keeps, are ciphertext. Without a key for the partition the
 * checkpoint is refused (`SnapshotUnsealable`), never produced in the clear.
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
  keys?: SealingKeys,
) {
  return Result.gen(async function* () {
    const made = yield* Result.await(materialise(engine, adapter, address, replica, at[0], derive));
    const tail = yield* Result.await(engine.docTail(address));
    const plain = tail.snapshot?.bytes ?? adapter.snapshot(adapter.create(replica));
    const partition = getRecord(engine.state(), address.table, address.key)?.partition;
    if (sealed && partition === undefined)
      return Result.err(
        new SnapshotUnsealable({
          partition: "",
          message: "a sealed document's row names no partition to seal its snapshot to",
        }),
      );
    const snapshot =
      sealed && partition !== undefined
        ? yield* sealSnapshot(keys, partition, address, tail.lineage, plain)
        : plain;
    // the values the cover just wrote are the snapshot's: it was taken from the same document
    const derived = sealed ? undefined : made.derived;
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
