import type { PeerId, SeqNum } from "@syncmesh/kernel";

import { Result } from "@syncmesh/result";

import type { DocAddress, DocHead, DocLogEntry, DocSnapshot, DocStore } from "./doc-log.js";

import { docEntryId, docKey, inTail, nextState } from "./doc-log.js";

const byPosition = (a: DocLogEntry, b: DocLogEntry): number =>
  a.author < b.author ? -1 : a.author > b.author ? 1 : a.seq - b.seq || a.index - b.index;

/** The doc log in memory: what an engine with no database keeps, and what the SQL stores are held to. */
export function createMemoryDocStore(): DocStore {
  const log = new Map<string, DocLogEntry>();
  const heads = new Map<string, DocHead>();
  const snapshots = new Map<string, DocSnapshot>();
  const ok = <T>(value: T) => Promise.resolve(Result.ok(value));
  const ofDoc = (doc: DocAddress) => [...log.values()].filter((e) => docKey(e) === docKey(doc));

  return {
    append: (entries) => {
      for (const entry of entries)
        if (!log.has(docEntryId(entry))) log.set(docEntryId(entry), entry);
      return ok(undefined);
    },
    entries: () => ok([...log.values()].sort(byPosition)),
    relineage: (doc, winner, live) => {
      for (const entry of ofDoc(doc)) {
        const next = nextState(entry, winner, live);
        if (next !== entry.state) log.set(docEntryId(entry), { ...entry, state: next });
      }
      return ok(undefined);
    },
    refreshHead: (doc, adapter, lineage) => {
      const held = heads.get(docKey(doc));
      const tail = ofDoc(doc).filter((e) => e.lineage === lineage && inTail(e.state));
      const head: DocHead = {
        ...doc,
        adapter,
        covers: held?.covers ?? new Map(),
        tailCount: tail.length,
        tailBytes: tail.reduce((n, e) => n + e.size, 0),
        mode: held?.mode ?? "none",
        ...(lineage !== undefined && { lineage }),
        ...(held?.version !== undefined && { version: held.version }),
        ...(held?.materialisedAt !== undefined && { materialisedAt: held.materialisedAt }),
      };
      heads.set(docKey(doc), head);
      return ok(undefined);
    },
    heads: () => ok([...heads.values()]),
    entriesOf: (doc) => ok(ofDoc(doc).sort(byPosition)),
    cover: (doc, cover) => {
      for (const [refs, state] of [
        [cover.covered, "covered"],
        [cover.failed ?? [], "failed"],
      ] as const)
        for (const ref of refs) {
          const held = log.get(docEntryId(ref));
          if (held !== undefined) log.set(docEntryId(ref), { ...held, state });
        }
      const tail = ofDoc(doc).filter((e) => e.lineage === cover.lineage && inTail(e.state));
      heads.set(docKey(doc), {
        ...doc,
        adapter: cover.adapter,
        covers: cover.covers,
        version: cover.version,
        tailCount: tail.length,
        tailBytes: tail.reduce((n, e) => n + e.size, 0),
        mode: cover.mode,
        materialisedAt: cover.at,
        ...(cover.lineage !== undefined && { lineage: cover.lineage }),
      });
      snapshots.set(docKey(doc), {
        bytes: cover.snapshot,
        ...(cover.lineage !== undefined && { lineage: cover.lineage }),
      });
      return ok(undefined);
    },
    snapshotOf: (doc) => ok(snapshots.get(docKey(doc))),
    uncoveredFloor: () => {
      const floor = new Map<PeerId, SeqNum>();
      for (const entry of log.values()) {
        if (entry.state === "covered") continue;
        // SAFETY: one below a positive sequence; 0 is the floor that holds the author back entirely
        const below = (entry.seq - 1) as SeqNum;
        const held = floor.get(entry.author);
        if (held === undefined || below < held) floor.set(entry.author, below);
      }
      return ok(floor);
    },
  };
}
