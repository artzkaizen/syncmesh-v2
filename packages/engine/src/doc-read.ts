import type { SeqNum } from "@syncmesh/kernel";

import { docLineage, getRecord } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";

import type { DocAddress, DocLogEntry, DocStore } from "./doc-log.js";
import type { DocBindings, DocTail, TailUpdate } from "./doc-path.js";
import type { EventStore, StoreFailure } from "./store.js";

import { docKey } from "./doc-log.js";

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
    const live = entries.filter(
      (e) => e.lineage === lineage && (e.state === "tail" || e.state === "bytes-missing"),
    );
    const updates = yield* Result.await(readUpdates(events, bindings, live));
    return Result.ok({
      updates,
      ...(lineage !== undefined && { lineage }),
      ...(head !== undefined && { head }),
      ...(held !== undefined && held.lineage === lineage && { snapshot: held }),
    });
  });
}

/** The updates `entries` index, read back from the events that carry them, in the entries' order. */
export function readUpdates(
  events: EventStore,
  { synced }: DocBindings,
  entries: readonly DocLogEntry[],
): Promise<Result<readonly TailUpdate[], StoreFailure>> {
  return Result.gen(async function* () {
    if (entries.length === 0) return Result.ok([]);
    // one read of the log: every author the entries name from just below their first one, and
    // every other author from where this engine already holds them, so nothing else comes back
    const floor = new Map(synced());
    for (const e of entries) {
      // SAFETY: one below a positive sequence; 0 reads the author's whole log
      const below = (e.seq - 1) as SeqNum;
      const at = floor.get(e.author);
      if (at === undefined || below < at) floor.set(e.author, below);
    }
    const found = yield* Result.await(events.allSince(floor));
    const byId = new Map(found.map((s) => [`${s.event.peerId}\u0000${String(s.event.seqNum)}`, s]));
    return Result.ok(
      entries.flatMap((entry): TailUpdate[] => {
        const change = byId.get(`${entry.author}\u0000${String(entry.seq)}`)?.event.changes[
          entry.index
        ];
        if (change?.kind !== "doc") return [];
        const { update } = change;
        return update.bytes !== undefined
          ? [{ entry, bytes: update.bytes }]
          : [{ entry, blob: update.blob }];
      }),
    );
  });
}
