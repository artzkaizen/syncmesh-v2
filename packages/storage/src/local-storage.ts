import type { Coverage, Cursors, EventStore, StoredEvent } from "@syncmesh/engine";
import type { EventId } from "@syncmesh/kernel";

import { StoreFailure, createMemoryEventStore } from "@syncmesh/engine";
import { compareHlc } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";

import type { LogCorrupt, PersistedHead } from "./local-log.js";

import { EMPTY_HEAD, decodeHead, decodeLog, encodeHead, encodeLog } from "./local-log.js";
import { failure } from "./sql.js";

/** The `Storage` calls this store makes — a browser's `localStorage`, or anything of that shape. */
export interface LocalStorageLike {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
}

export interface LocalStorageEventStoreOptions {
  /** Namespaces the two keys (`<name>.head`, `<name>.log`) so one origin can hold more than one log. Default `syncmesh`. */
  readonly name?: string;
  /** Defaults to the ambient `localStorage`; pass one to run in a worker, a test, or over a quota-aware wrapper. */
  readonly storage?: LocalStorageLike;
}

/** A working store, and what was lost opening it. */
export interface OpenedLocalLog {
  readonly store: EventStore;
  /**
   * Present when what was persisted did not decode: it has been cleared and the store opened empty,
   * so the app boots and re-syncs — and can say so. Both halves matter. Starting empty in silence
   * is data loss nothing observes; refusing to open is a browser that will not boot.
   */
  readonly corrupt?: LogCorrupt;
  /**
   * Nothing survived that says how far this device had numbered, so it would resume at one and
   * re-issue ids its peers already hold — and `has()` drops those events everywhere, silently.
   *
   * The device can still read and still receive; the way out is to sync, because a peer holding
   * this device\'s own past is the only thing that can put a floor back under the numbering. An
   * app that knows there is nothing to lose — a fresh install, storage it just cleared — can
   * write anyway.
   */
  readonly numberingLost?: boolean;
}

/** This package cannot name the DOM's `Storage` (D01-B leaves the runtime out of the types); every call goes through `LocalStorageLike`. */
const ambient = (): LocalStorageLike | undefined =>
  // SAFETY: a property read off globalThis, used only through LocalStorageLike; anywhere but a browser it is absent and the caller takes the undefined branch
  (globalThis as { localStorage?: LocalStorageLike }).localStorage;

const higher = (held: Cursors, seen: Cursors): Cursors => {
  const merged = new Map(held);
  for (const [peer, seq] of seen) {
    const mark = merged.get(peer);
    if (mark === undefined || mark < seq) merged.set(peer, seq);
  }
  return merged;
};

const mergeCoverage = (held: Coverage, seen: Coverage): Coverage => ({
  synced: higher(held.synced, seen.synced),
  local: higher(held.local, seen.local),
});

/** The head after `entries` are appended. Every mark only rises — that is the whole job of this function. */
function advance(head: PersistedHead, entries: readonly StoredEvent[]): PersistedHead {
  const seqs = { synced: new Map(head.seqs.synced), local: new Map(head.seqs.local) };
  let hlc = head.hlc;
  for (const { event } of entries) {
    const scope = event.local === true ? seqs.local : seqs.synced;
    const mark = scope.get(event.peerId);
    if (mark === undefined || mark < event.seqNum) scope.set(event.peerId, event.seqNum);
    if (hlc === undefined || compareHlc(event.hlc, hlc) > 0) hlc = event.hlc;
  }
  return { ...head, hlc, seqs };
}

/** The two keys, and the head as this process last knew it. */
function localLog(storage: LocalStorageLike, name: string) {
  const keys = { head: `${name}.head`, log: `${name}.log` };
  let head = EMPTY_HEAD;
  const write = (key: string, text: string) =>
    Result.try({ try: () => storage.setItem(key, text), catch: failure(`writing ${key} failed`) });

  return {
    read: (key: "head" | "log") =>
      Result.try({
        try: () => storage.getItem(keys[key]),
        catch: failure(`reading ${keys[key]} failed`),
      }),
    head: () => head,
    /** Takes the head as loaded, without writing it back. */
    adopt: (decoded: PersistedHead) => {
      head = decoded;
    },
    saveHead: (next: PersistedHead) =>
      write(keys.head, encodeHead(next)).map(() => {
        head = next;
      }),
    saveLog: (entries: readonly StoredEvent[]) => write(keys.log, encodeLog(entries)),
  };
}

type LocalLog = ReturnType<typeof localLog>;

/**
 * The marks are written before the entries are. A quota-refused batch has still raised the sequence and
 * the stamp it claimed, so a restart numbers above events it never managed to keep instead of
 * re-issuing their ids to different writes.
 */
function appendAll(memory: EventStore, disk: LocalLog, batch: readonly StoredEvent[]) {
  return Result.gen(async function* () {
    const fresh: StoredEvent[] = [];
    const seen = new Set<EventId>();
    for (const entry of batch) {
      const id = entry.event.id;
      if (seen.has(id) || (yield* Result.await(memory.has(id)))) continue;
      seen.add(id);
      fresh.push(entry);
    }
    if (fresh.length === 0) return Result.ok(undefined);
    const held = yield* Result.await(memory.all());
    yield* disk.saveHead(advance(disk.head(), fresh));
    yield* disk.saveLog([...held, ...fresh]);
    yield* Result.await(memory.appendBatch(fresh));
    return Result.ok(undefined);
  });
}

/**
 * Queries run over the events in memory; the boot invariants come off the head. The split is the
 * point: the log answers what it holds, the head answers what it has ever held, and only the second
 * one may never regress — `lastSeq` and `maxHlc` survive both compaction and a failed write.
 */
function storeOver(memory: EventStore, disk: LocalLog): EventStore {
  const ok = <T>(value: T) => Promise.resolve(Result.ok(value));
  return {
    append: (entry) => appendAll(memory, disk, [entry]),
    appendBatch: (entries) => appendAll(memory, disk, entries),
    has: (id) => memory.has(id),
    all: () => memory.all(),
    stranded: (mine) => memory.stranded(mine),
    allSince: (cursors, scope) => memory.allSince(cursors, scope),
    lastSeq: (peer, scope) => ok(disk.head().seqs[scope].get(peer)),
    maxHlc: () => ok(disk.head().hlc),
    compactedBelow: () => ok(disk.head().floors),
    compactBelow: (floor, scope, olderThan) =>
      Result.gen(async function* () {
        const removed = yield* Result.await(memory.compactBelow(floor, scope, olderThan));
        if (removed === 0) return Result.ok(0);
        const head = disk.head();
        const marks = yield* Result.await(memory.compactedBelow());
        yield* disk.saveHead({ ...head, floors: mergeCoverage(head.floors, marks) });
        const kept = yield* Result.await(memory.all());
        yield* disk.saveLog(kept);
        return Result.ok(removed);
      }),
  };
}

interface Recovered {
  readonly head: PersistedHead;
  readonly entries: readonly StoredEvent[];
  readonly corrupt?: LogCorrupt;
  /** Both keys were damaged: no mark survived, so where this device had numbered to is unknown. */
  readonly numberingLost?: boolean;
}

/**
 * Damage to the head takes the entries with it **as contents**, because an unreadable head leaves
 * no record of what compaction removed, and a surviving log under no floor is a partial log
 * nothing can tell is partial. Damage to the entries leaves the head standing, so the clock does
 * not go back with them.
 *
 * But the entries are still the only surviving evidence of *how far this device had numbered*,
 * and that mark is the one thing that must never regress. Numbering from zero re-issues sequence
 * numbers peers already hold under different ids, and `has()` then drops every new event on every
 * peer, in silence, for the life of the device — the worst shape a bug can take here.
 *
 * So a damaged head keeps the log's marks and discards only its contents. That is sound rather
 * than optimistic: `persist` runs before `outbound.emit` in the write path, so a sequence the log
 * never recorded was never sent to anyone either, and resuming above the log cannot collide with
 * an id a peer is holding.
 *
 * When both keys are damaged there is nothing left to resume from, and nothing on this device can
 * know where it had got to — only a peer holding its past can say. {@link Recovered.numberingLost}
 * carries that up rather than letting the device quietly start again at one.
 */
function recover(rawHead: string | null, rawLog: string | null): Recovered {
  const head = decodeHead(rawHead);
  const entries = decodeLog(rawLog);
  if (head.isErr()) {
    const survived = entries.isOk() ? entries.value : [];
    const recovered = { head: advance(EMPTY_HEAD, survived), entries: [], corrupt: head.error };
    return survived.length > 0 ? recovered : { ...recovered, numberingLost: true };
  }
  if (entries.isErr()) return { head: head.value, entries: [], corrupt: entries.error };
  return { head: head.value, entries: entries.value };
}

/**
 * Opens the event log `localStorage` holds under `name` — the store for a browser with no SQLite.
 *
 * Damage is reported, never thrown and never swallowed: a log that does not decode is cleared, the
 * store opens empty, and `corrupt` on the result says what was lost so the app can re-sync and tell
 * someone. The whole log lives in one key, so recovery is all-or-nothing by construction.
 *
 * `Result.err` means something else entirely — there is no `localStorage` here, or it refused a
 * read — and the caller should open a different store.
 *
 * An append rewrites the whole key, so the log must stay small: this is the store that most needs
 * the size-based compaction trigger, not the one that can afford to grow.
 *
 * @example
 * const { store, corrupt } = (await localStorageEventStore({ name: "notes" })).unwrap();
 * if (corrupt !== undefined) warn(`local history was lost (${corrupt.message}); re-syncing`);
 */
export function localStorageEventStore(
  options: LocalStorageEventStoreOptions = {},
): Promise<Result<OpenedLocalLog, StoreFailure>> {
  const storage = options.storage ?? ambient();
  if (storage === undefined) {
    return Promise.resolve(
      Result.err(new StoreFailure({ message: "this runtime has no localStorage" })),
    );
  }
  const disk = localLog(storage, options.name ?? "syncmesh");
  return Result.gen(async function* () {
    const rawHead = yield* disk.read("head");
    const rawLog = yield* disk.read("log");
    const { head, entries, corrupt, numberingLost } = recover(rawHead, rawLog);
    const marks = advance(head, entries); // an entry outliving the mark it set raises it back
    disk.adopt(marks);
    if (corrupt !== undefined) {
      yield* disk.saveHead(marks); // the damaged bytes go now, not on the next write
      yield* disk.saveLog(entries);
    }
    const memory = createMemoryEventStore();
    yield* Result.await(memory.appendBatch(entries));
    const store = storeOver(memory, disk);
    if (corrupt === undefined) return Result.ok({ store });
    return Result.ok(
      numberingLost === true ? { store, corrupt, numberingLost } : { store, corrupt },
    );
  });
}
