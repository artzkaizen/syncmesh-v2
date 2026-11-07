import type {
  DocAddress,
  DocCoverStale,
  DocEntryRef,
  DocTail,
  Engine,
  StoreFailure,
  TailUpdate,
} from "@syncmesh/engine";
import type { Hlc, PeerId, SeqNum } from "@syncmesh/kernel";

import { sha256 } from "@noble/hashes/sha2.js";
import { docKey } from "@syncmesh/engine";
import { getRecord, lineageOf } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";
import {
  bytesEqual,
  bytesToHex,
  decodeCheckpoint,
  signCheckpoint,
  type Identity,
  type SignedCheckpoint,
} from "@syncmesh/wire";

import type { DocumentAdapter, UpdateRejected } from "./adapter.js";

import { CheckpointRefused, DocPending, DocTooLarge } from "./errors.js";

/** What the runtime asks of an engine: the write path, the fold feed and the doc log. */
export type DocsEngine = Pick<
  Engine,
  "peerId" | "mutate" | "onFoldBatch" | "docTail" | "coverDoc" | "docHeads" | "state"
>;

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
function floorOf(tail: DocTail, settled: readonly TailUpdate[]): Map<PeerId, SeqNum> {
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
  at: number,
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
    yield* Result.await(
      engine.coverDoc(address, {
        adapter: adapter.id,
        covers: floorOf(tail, settled),
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

const hashOf = (bytes: Uint8Array) => bytesToHex(sha256(bytes));

/** A signed checkpoint and the snapshot bytes it names by hash (RFC-0023 §5.5). */
export interface ProducedCheckpoint {
  readonly signed: SignedCheckpoint;
  readonly snapshot: Uint8Array;
}

/** Materialises, then signs what the snapshot is: the record a joiner below the floor installs. */
export async function produceCheckpoint<D>(
  engine: DocsEngine,
  adapter: DocumentAdapter<D>,
  address: DocAddress,
  producer: Identity,
  replica: bigint,
  at: Hlc,
) {
  return Result.gen(async function* () {
    yield* Result.await(materialise(engine, adapter, address, replica, at[0].epochMilliseconds));
    const tail = yield* Result.await(engine.docTail(address));
    const snapshot = tail.snapshot?.bytes ?? adapter.snapshot(adapter.create(replica));
    const signed = signCheckpoint(
      {
        ...address,
        adapter: adapter.id,
        covers: tail.head?.covers ?? new Map(),
        version: tail.head?.version ?? adapter.version(adapter.create(replica)),
        snapshot: { hash: hashOf(snapshot), size: snapshot.length },
        derived: new Map(),
        at,
        ...(tail.lineage !== undefined && { lineage: tail.lineage }),
      },
      producer,
    );
    return Result.ok<ProducedCheckpoint>({ signed, snapshot });
  });
}

const refuse = (message: string, cause?: unknown) =>
  Result.err(new CheckpointRefused({ message, ...(cause !== undefined && { cause }) }));

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
  const decoded = decodeCheckpoint(wire, producer);
  if (decoded.isErr()) return refuse("not a checkpoint signed by that producer", decoded.error);
  const { checkpoint } = decoded.value;
  if (checkpoint.adapter !== adapter.id) return refuse(`merged by ${checkpoint.adapter}`);
  if (checkpoint.snapshot.size !== snapshot.length || checkpoint.snapshot.hash !== hashOf(snapshot))
    return refuse("the snapshot bytes are not the ones the checkpoint names");
  if (docKey(checkpoint) !== docKey(address))
    return refuse("the checkpoint is of another document");
  const winner = lineageOf(getRecord(engine.state(), address.table, address.key), address.column);
  if (winner !== checkpoint.lineage)
    return refuse("the checkpoint is of a lineage that does not win here");
  const doc = adapter.create(replica);
  const parsed = adapter.apply(doc, [snapshot]);
  if (parsed.isErr()) return refuse("the adapter cannot read the snapshot", parsed.error);
  if (!bytesEqual(adapter.version(doc), checkpoint.version))
    return refuse("the snapshot does not reproduce the version the checkpoint claims");
  return Result.ok({ checkpoint, doc });
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
  at: number,
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
    // a snapshot this device already holds may hold what the checkpoint does not, and the
    // entries behind it may be compacted away: installing over it would lose them
    const held = tail.snapshot === undefined ? new Map<PeerId, SeqNum>() : tail.head?.covers;
    const behind = [...(held ?? [])].some(
      ([author, seq]) => (checkpoint.covers.get(author) ?? 0) < seq,
    );
    if (behind) return refuse("the checkpoint is behind the snapshot this device holds");
    const below = tail.updates.filter(
      ({ entry }) => entry.seq <= (checkpoint.covers.get(entry.author) ?? 0),
    );
    // what the floor claims, the snapshot must hold: re-importing it may not move the document
    const claimed = below.flatMap((u) => (u.bytes === undefined ? [] : [u.bytes]));
    if (adapter.apply(doc, claimed).unwrapOr(false) || adapter.pending(doc))
      return refuse("the snapshot lacks updates the checkpoint's floor claims");
    yield* Result.await(
      engine.coverDoc(address, {
        adapter: adapter.id,
        covers: checkpoint.covers,
        version: checkpoint.version,
        snapshot,
        mode: "checkpoint",
        ...(tail.head?.version !== undefined && { base: tail.head.version }),
        at,
        covered: below.map(ref),
        ...(checkpoint.lineage !== undefined && { lineage: checkpoint.lineage }),
      }),
    );
    return Result.ok(checkpoint);
  });
}
