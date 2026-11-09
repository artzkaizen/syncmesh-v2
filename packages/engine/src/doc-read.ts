import type { DocChange, LineageId, SeqNum } from "@syncmesh/kernel";

import { compareHlc, docLineage, getRecord, readLineageCell } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";

import type { DocAddress, DocLogEntry, DocStore } from "./doc-log.js";
import type { DocBindings, DocTail, LineageLog, TailUpdate } from "./doc-path.js";
import type { EventStore, StoreFailure } from "./store.js";

import { docKey, inTail } from "./doc-log.js";

/**
 * Reading a document's updates back from the log its events are kept in (RFC-0023 §6.2): the doc
 * log indexes them by reference, so the bytes come from the events themselves.
 *
 * @module
 */

/** One document's snapshot and the winning lineage's tail, read back from the events. */
export function readTail(
  events: EventStore,
  docStore: DocStore,
  bindings: DocBindings,
  doc: DocAddress,
): Promise<Result<DocTail, StoreFailure>> {
  return Result.gen(async function* () {
    const lineage = docLineage(getRecord(bindings.getState(), doc.table, doc.key), doc.column);
    const entries = yield* Result.await(docStore.entriesOf(doc));
    const heads = yield* Result.await(docStore.heads());
    const head = heads.find((h) => docKey(h) === docKey(doc));
    const held = yield* Result.await(docStore.snapshotOf(doc));
    // `adapter-missing` too: an entry folded before this engine had the adapter keeps that label
    const live = entries.filter((e) => e.lineage === lineage && inTail(e.state));
    const updates = yield* Result.await(readUpdates(events, bindings, live));
    return Result.ok({
      updates,
      ...(lineage !== undefined && { lineage }),
      ...(head !== undefined && { head }),
      ...(held !== undefined && held.lineage === lineage && { snapshot: held }),
    });
  });
}

/** Each of `entries` with the doc change its event carries, in the entries' order; one whose event is gone is left out. */
function readChanges(
  events: EventStore,
  { coverage }: DocBindings,
  entries: readonly DocLogEntry[],
): Promise<Result<readonly (readonly [DocLogEntry, DocChange])[], StoreFailure>> {
  return Result.gen(async function* () {
    if (entries.length === 0) return Result.ok([]);
    // one read of the log: every author the entries name from just below their first one, and
    // every other author from where this engine already holds them, so nothing else comes back
    const floor = new Map(coverage().synced);
    for (const e of entries) {
      // SAFETY: one below a positive sequence; 0 reads the author's whole log
      const below = (e.seq - 1) as SeqNum;
      const at = floor.get(e.author);
      if (at === undefined || below < at) floor.set(e.author, below);
    }
    const found = yield* Result.await(events.allSince(floor));
    const byId = new Map(found.map((s) => [`${s.event.peerId}\u0000${String(s.event.seqNum)}`, s]));
    return Result.ok(
      entries.flatMap((entry): (readonly [DocLogEntry, DocChange])[] => {
        const change = byId.get(`${entry.author}\u0000${String(entry.seq)}`)?.event.changes[
          entry.index
        ];
        return change?.kind === "doc" ? [[entry, change]] : [];
      }),
    );
  });
}

/** What one read change carries: its bytes inline, or the blob that holds them. */
const tailUpdate = ([entry, { update }]: readonly [DocLogEntry, DocChange]): TailUpdate =>
  update.bytes !== undefined ? { entry, bytes: update.bytes } : { entry, blob: update.blob };

/** The updates `entries` index, read back from the events that carry them, in the entries' order. */
export function readUpdates(
  events: EventStore,
  bindings: DocBindings,
  entries: readonly DocLogEntry[],
): Promise<Result<readonly TailUpdate[], StoreFailure>> {
  return Result.gen(async function* () {
    const read = yield* Result.await(readChanges(events, bindings, entries));
    return Result.ok(read.map(tailUpdate));
  });
}

/**
 * One lineage of a document as this device can rebuild it (RFC-0023 §5.3): the snapshot held of
 * it, when the one held is of this lineage, and every update of it that snapshot does not hold.
 * What it cannot rebuild is counted in `lost` — an update whose event compaction took with no
 * snapshot of its lineage left, a genesis the log never received, or a root whose history before
 * an installed snapshot never reached this device — so no reader takes a part for the whole.
 */
export function readLineageLog(
  events: EventStore,
  docStore: DocStore,
  bindings: DocBindings,
  doc: DocAddress,
  lineage: LineageId | undefined,
): Promise<Result<LineageLog, StoreFailure>> {
  return Result.gen(async function* () {
    const entries = (yield* Result.await(docStore.entriesOf(doc))).filter(
      (e) => e.lineage === lineage,
    );
    const held = yield* Result.await(docStore.snapshotOf(doc));
    const snapshot = held !== undefined && held.lineage === lineage ? held : undefined;
    if (snapshot !== undefined) {
      const heads = yield* Result.await(docStore.heads());
      const covers = heads.find((h) => docKey(h) === docKey(doc))?.covers ?? new Map();
      // what the snapshot holds is not read again: compaction may have taken those events
      const rest = entries.filter((e) => e.seq > (covers.get(e.author) ?? 0));
      const updates = yield* Result.await(readUpdates(events, bindings, rest));
      return Result.ok({ snapshot, updates, lost: rest.length - updates.length });
    }
    const read = yield* Result.await(readChanges(events, bindings, entries));
    const updates = read.map(tailUpdate);
    const gone = entries.length - updates.length;
    if (lineage === undefined) {
      // an installed snapshot adopted history with no events behind it: the root's may be in it
      const adopted = [...(bindings.coverage().floor?.values() ?? [])].some((seq) => seq > 0);
      return Result.ok({ updates, lost: gone + (adopted ? 1 : 0) });
    }
    const genesis = readLineageCell(
      getRecord(bindings.getState(), doc.table, doc.key)?.cells.get(doc.column)?.value,
    ).geneses.find((g) => g.lineage === lineage);
    // a genesis an anchor passed has left the cell, so its event is the only proof it arrived
    const started =
      genesis === undefined
        ? read.some(([, change]) => change.genesis === true)
        : entries.some(
            (e) => e.author === genesis.stamp.peer && compareHlc(e.hlc, genesis.stamp.hlc) === 0,
          );
    return Result.ok({ updates, lost: gone + (started ? 0 : 1) });
  });
}
