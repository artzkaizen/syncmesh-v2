import type { DocAddress, DocEntryRef, DocTail, TailUpdate } from "@syncmesh/engine";
import type { PeerId } from "@syncmesh/kernel";
import type { Temporal } from "@syncmesh/temporal";

import { Result } from "@syncmesh/result";
import { bytesEqual } from "@syncmesh/wire";

import type { DocumentAdapter } from "./adapter.js";
import type { Derive, DocsEngine } from "./materialise.js";

import { behindHeld, refuseCheckpoint, resolveCheckpoint } from "./checkpoint.js";
import { entryRef } from "./materialise.js";

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
  return adapter.pending(doc)
    ? undefined
    : { covered: covered.map(entryRef), failed: failed.map(entryRef) };
}

/**
 * Imports into `doc` the tail updates above a checkpoint's floor this device holds, update by
 * update, and returns the ones it took. A refused one is skipped, as {@link load} skips it.
 */
function aboveFloor<D>(
  adapter: DocumentAdapter<D>,
  doc: D,
  tail: DocTail,
  below: readonly TailUpdate[],
): DocEntryRef[] {
  const under = new Set(below);
  const taken: DocEntryRef[] = [];
  for (const u of tail.updates)
    if (!under.has(u) && u.bytes !== undefined && adapter.apply(doc, [u.bytes]).isOk())
      taken.push(entryRef(u));
  return taken;
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
    // computed here, never taken from key 8: every replica that can read the document derives it,
    // from the snapshot and the tail above its floor, which stays tail
    const above = derive === undefined ? [] : aboveFloor(adapter, doc, tail, below);
    const derived = derive?.(doc);
    yield* Result.await(
      engine.coverDoc(address, {
        ...(derived !== undefined && { derived, derivedIncludes: above }),
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
