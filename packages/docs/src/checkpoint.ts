import type { DocAddress, DocTail } from "@syncmesh/engine";
import type { AdapterId, PeerId, Row } from "@syncmesh/kernel";
import type { DocDeriver } from "@syncmesh/schema";
import type { Temporal } from "@syncmesh/temporal";
import type { DocCheckpoint } from "@syncmesh/wire";

import { sha256 } from "@noble/hashes/sha2.js";
import { docKey } from "@syncmesh/engine";
import { docLineage, getRecord } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";
import { bytesToHex, decodeCheckpoint } from "@syncmesh/wire";

import type { DocsEngine } from "./materialise.js";

import { CheckpointRefused } from "./errors.js";
import { isSealedSnapshot } from "./sealed-snapshot.js";

/** The hex sha-256 a checkpoint names its snapshot bytes by (RFC-0023 §5.5, D18). */
export const snapshotHash = (bytes: Uint8Array) => bytesToHex(sha256(bytes));

export const refuseCheckpoint = (message: string, cause?: unknown) =>
  Result.err(new CheckpointRefused({ message, ...(cause !== undefined && { cause }) }));

/**
 * What any host checks a checkpoint against, with or without the adapter: the producer's
 * signature, the column's adapter, the snapshot bytes it names, the document it is of, and the
 * lineage that wins here.
 */
export function resolveCheckpoint(
  engine: Pick<DocsEngine, "state">,
  adapter: AdapterId,
  address: DocAddress,
  wire: Uint8Array,
  producer: PeerId,
  snapshot: Uint8Array,
): Result<DocCheckpoint, CheckpointRefused> {
  const decoded = decodeCheckpoint(wire, producer);
  if (decoded.isErr())
    return refuseCheckpoint("not a checkpoint signed by that producer", decoded.error);
  const { checkpoint } = decoded.value;
  if (checkpoint.adapter !== adapter) return refuseCheckpoint(`merged by ${checkpoint.adapter}`);
  if (
    checkpoint.snapshot.size !== snapshot.length ||
    checkpoint.snapshot.hash !== snapshotHash(snapshot)
  )
    return refuseCheckpoint("the snapshot bytes are not the ones the checkpoint names");
  if (docKey(checkpoint) !== docKey(address))
    return refuseCheckpoint("the checkpoint is of another document");
  const winner = docLineage(getRecord(engine.state(), address.table, address.key), address.column);
  if (winner !== checkpoint.lineage)
    return refuseCheckpoint("the checkpoint is of a lineage that does not win here");
  return Result.ok(checkpoint);
}

/**
 * Whether a checkpoint is behind the snapshot this replica already holds. That snapshot may hold
 * what the checkpoint does not, and the entries behind it may be compacted away: installing over
 * it would lose them.
 */
export function behindHeld(tail: DocTail, checkpoint: DocCheckpoint): boolean {
  const held = tail.snapshot === undefined ? [] : [...(tail.head?.covers ?? [])];
  return held.some(([author, seq]) => (checkpoint.covers.get(author) ?? 0) < seq);
}

/** What an opaque host checks a checkpoint against besides the log: the column's declaration. */
export interface ProvisionalChecks {
  /** The adapter the column declares; the host holds none, so it cannot open the snapshot. */
  readonly adapter: AdapterId;
  /** The column's derive list, which key 8's values must stay inside; absent when it derives nothing. */
  readonly deriver?: DocDeriver;
  /**
   * The row's partition is sealed: key 8 must be empty and its derived columns stay unset, and the
   * snapshot must be sealed to the partition key — the host keeps that ciphertext (§11, U24).
   */
  readonly sealed: boolean;
}

/** Key 8's values as the host may write them; none for an empty map, refused outside the declaration. */
function provisionalDerived(
  checkpoint: DocCheckpoint,
  checks: ProvisionalChecks,
): Result<Row | undefined, CheckpointRefused> {
  if (checkpoint.derived.size === 0) return Result.ok(undefined);
  if (checks.sealed)
    return refuseCheckpoint("a sealed partition's checkpoint carries no derived values");
  if (checks.deriver === undefined) return refuseCheckpoint("the column derives nothing");
  return checks.deriver
    .check(checkpoint.derived)
    .mapError((cause) => new CheckpointRefused({ message: cause.message, cause }));
}

/**
 * Installs a device's checkpoint on an opaque host — one without the adapter, or one for a sealed
 * partition (RFC-0023 §7.2) — **provisionally** (§7.3, §16.6): its signature, address, adapter,
 * winning lineage and snapshot hash are checked, its producer must be the authority or a peer the
 * row's `update` rule lets edit it here (§11, `engine.mayEditDoc`), and its floor must not claim
 * a change this host has not folded, but its version cannot be re-derived without the adapter. The snapshot lands in
 * the doc store with the head in `checkpoint` mode, and the derived values key 8 carries land in
 * the row in the same commit. No log entry moves: a provisional snapshot never makes an event
 * compactable, so the host keeps the long log a later audit replays.
 *
 * A sealed partition's checkpoint carrying any derived value is refused: it would be plaintext
 * read out of sealed content. Its derived columns stay unset on the host. So is one whose snapshot
 * is not sealed ({@link isSealedSnapshot}); a sealed one is kept as the ciphertext it is.
 */
export async function installProvisional(
  engine: DocsEngine,
  address: DocAddress,
  wire: Uint8Array,
  producer: PeerId,
  snapshot: Uint8Array,
  at: Temporal.Instant,
  checks: ProvisionalChecks,
) {
  return Result.gen(async function* () {
    const checkpoint = yield* resolveCheckpoint(
      engine,
      checks.adapter,
      address,
      wire,
      producer,
      snapshot,
    );
    // key 8 writes the row's derived columns: only a peer that may edit the row may set them
    const producerMay = engine.mayEditDoc(producer, address);
    if (producerMay.isErr())
      return refuseCheckpoint("its producer may not update this row", producerMay.error);
    const derived = yield* provisionalDerived(checkpoint, checks);
    // the host holds no key, so the seal is all it can check: a sealed partition's snapshot that
    // is not sealed is plaintext of sealed content, and is not kept here (§11, gaps U24)
    if (checks.sealed && !isSealedSnapshot(snapshot))
      return refuseCheckpoint("a sealed partition's checkpoint carries an unsealed snapshot");
    const cursors = yield* Result.await(engine.cursors());
    const ahead = [...checkpoint.covers].some(([author, seq]) => (cursors.get(author) ?? 0) < seq);
    if (ahead) return refuseCheckpoint("the checkpoint claims changes this host has not folded");
    const tail = yield* Result.await(engine.docTail(address));
    if (behindHeld(tail, checkpoint))
      return refuseCheckpoint("the checkpoint is behind the snapshot this host holds");
    yield* Result.await(
      engine.coverDoc(address, {
        adapter: checks.adapter,
        covers: checkpoint.covers,
        version: checkpoint.version,
        snapshot,
        mode: "checkpoint",
        ...(tail.head?.version !== undefined && { base: tail.head.version }),
        at,
        covered: [],
        ...(derived !== undefined && { derived }),
        ...(checkpoint.lineage !== undefined && { lineage: checkpoint.lineage }),
      }),
    );
    return Result.ok(checkpoint);
  });
}
