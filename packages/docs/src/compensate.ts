import type { DocCompensation, DocCompensator, DocWrite } from "@syncmesh/engine";
import type { AdapterId, DocChange, DocColumns, EventId } from "@syncmesh/kernel";

import { CannotRevert, docKey } from "@syncmesh/engine";
import { docLineage, getRecord } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";

import type { AnyAdapter } from "./adapter.js";
import type { DocBlobs } from "./blobs.js";
import type { DocsEngine } from "./materialise.js";

import { columnAdapter } from "./adapter.js";
import { carry, fetchUpdate } from "./blobs.js";
import { readLineage } from "./lineages.js";
import { load } from "./materialise.js";

/**
 * Undo for documents (RFC-0023 §9, E30 P6): what a document runtime hands `engine.revert` so a
 * write's document updates are taken back like its rows, in the same compensating event.
 *
 * @module
 */

export interface CompensateDeps {
  readonly engine: DocsEngine;
  readonly docs: DocColumns;
  readonly adapters: ReadonlyMap<AdapterId, AnyAdapter>;
  readonly blobs: DocBlobs | undefined;
  readonly fresh: () => bigint;
}

/** One reverted write's changes to one document. */
type Touched = readonly DocChange[];

const refuse = (eventId: EventId, message: string) =>
  Result.err(new CannotRevert({ eventId, message }));

/**
 * The compensator a runtime reverts with. Per document the write touched, on the lineage that wins
 * now:
 *
 * - **edits** are taken back by the adapter's `compensate`, made against the document as it is
 *   committed here (its snapshot and tail, never an open handle's unflushed edits), so what anyone
 *   wrote since stands;
 * - **a `replace()`** is taken back by a new genesis carrying the lineage it replaced, rebuilt
 *   here: a forward write, as `restore` makes, never history surgery.
 *
 * A document whose winning lineage is no longer the one the write was on, or where nothing of the
 * write still shows, gets no write and is reported `superseded`. A document this runtime cannot
 * compensate — no adapter, an update whose blob no carrier serves, a replaced lineage it holds
 * only part of — refuses the whole revert, which leaves the write revertable.
 */
export function createCompensator(deps: CompensateDeps): DocCompensator {
  return async (changes, eventId) => {
    const byDoc = new Map<string, DocChange[]>();
    for (const change of changes)
      byDoc.set(docKey(change), [...(byDoc.get(docKey(change)) ?? []), change]);
    const out: DocCompensation[] = [];
    for (const touched of byDoc.values()) {
      const made = await compensateDoc(deps, touched, eventId);
      if (made.isErr()) return made;
      out.push(made.value);
    }
    return Result.ok(out);
  };
}

async function compensateDoc(
  deps: CompensateDeps,
  touched: Touched,
  eventId: EventId,
): Promise<Result<DocCompensation, CannotRevert>> {
  const [first] = touched;
  if (first === undefined) return refuse(eventId, "no document change to compensate");
  const { table, key, column } = first;
  const address = { table, key, column };
  const none = { table, key, column, writes: [] };
  const adapter = columnAdapter(deps.docs, deps.adapters, address);
  if (adapter.isErr()) return refuse(eventId, adapter.error.message);
  const record = getRecord(deps.engine.state(), table, key);
  const winner = docLineage(record, column);
  // the write's updates sit on a lineage another replace has ended: theirs stands
  if (first.lineage !== winner) return Result.ok(none);
  const partition = record?.partition;
  const writes =
    first.genesis === true
      ? await restoreParent(deps, adapter.value, first, eventId)
      : await compensateEdits(deps, adapter.value, touched, eventId);
  if (writes.isErr()) return writes;
  const made = writes.value;
  if (made === undefined) return Result.ok(none);
  const carried = await carry(adapter.value, [made.bytes], deps.blobs, partition);
  if (carried.isErr()) return refuse(eventId, carried.error.message);
  return Result.ok({
    table,
    key,
    column,
    writes: carried.value.map((update): DocWrite => ({
      column,
      adapter: adapter.value.id,
      update,
      ...(made.genesis ? { genesis: true } : winner !== undefined && { lineage: winner }),
    })),
  });
}

/** What one document's compensation writes: an update on the winner, or a genesis's snapshot. */
interface Made {
  readonly bytes: Uint8Array;
  readonly genesis: boolean;
}

/** The update that takes back a write's edits to the document as it is committed here. */
async function compensateEdits(
  deps: CompensateDeps,
  adapter: AnyAdapter,
  edits: Touched,
  eventId: EventId,
): Promise<Result<Made | undefined, CannotRevert>> {
  const updates: Uint8Array[] = [];
  for (const { update } of edits) {
    const bytes = update.bytes ?? (await fetchUpdate(deps.blobs, update.blob));
    if (bytes === undefined)
      return refuse(eventId, "a document update's blob is not held here, and no carrier served it");
    updates.push(bytes);
  }
  const [first] = edits;
  if (first === undefined) return Result.ok(undefined);
  const tail = await deps.engine.docTail(first);
  if (tail.isErr()) return refuse(eventId, tail.error.message);
  const loaded = load(adapter, tail.value, deps.fresh());
  if (loaded.isErr()) return refuse(eventId, loaded.error.message);
  const made = adapter.compensate(loaded.value.doc, updates, deps.fresh());
  if (made.isErr()) return refuse(eventId, made.error.message);
  return Result.ok(made.value === undefined ? undefined : { bytes: made.value, genesis: false });
}

/** A genesis bringing back the lineage a `replace()` ended, rebuilt whole or not at all. */
async function restoreParent(
  deps: CompensateDeps,
  adapter: AnyAdapter,
  genesis: DocChange,
  eventId: EventId,
): Promise<Result<Made, CannotRevert>> {
  const version = await readLineage(
    deps.engine,
    adapter,
    genesis,
    genesis.parent,
    deps.fresh(),
    deps.blobs,
  );
  if (version.isErr()) return refuse(eventId, version.error.message);
  if (version.value.lost + version.value.missing > 0)
    return refuse(eventId, "this device holds only part of the version the replace ended");
  return Result.ok({ bytes: adapter.snapshot(version.value.value), genesis: true });
}
