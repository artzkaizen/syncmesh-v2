import type {
  ActionId,
  AdapterId,
  ColumnName,
  DocChange,
  DocUpdate,
  Hlc,
  LineageId,
  PeerId,
  RowKey,
  SeqNum,
  SyncEvent,
  TableName,
} from "@syncmesh/kernel";

import { sha256 } from "@noble/hashes/sha2.js";
import { Result, TaggedError } from "@syncmesh/result";
import { docChangeId } from "@syncmesh/wire";

import type { StoreFailure } from "./store.js";
import type { Cursors } from "./sync.js";

/**
 * Where one doc change stands on this device (RFC-0023 §6.2). Local bookkeeping, never part of
 * what folds or what a digest covers: two peers holding the same events hold the same entries,
 * and may label them differently according to which adapters and blobs each has.
 *
 * - `tail` — the adapter is here and the update is not yet in the column's snapshot.
 * - `covered` — a persisted snapshot includes it; compaction may take its event (§8.3).
 * - `bytes-missing` — blob-carried, and the blob has not landed.
 * - `orphaned` — it names a lineage that is not the winning one (§5.3); kept, never applied.
 * - `failed` — the adapter could not import it (§10); the doc stays at its last good version.
 * - `adapter-missing` — this build has no adapter for the column's id; it folds and forwards (§10).
 */
export type DocEntryState =
  | "tail"
  | "covered"
  | "bytes-missing"
  | "orphaned"
  | "failed"
  | "adapter-missing";

/** Which document: a row's key and one of its doc columns. */
export interface DocAddress {
  readonly table: TableName;
  readonly key: RowKey;
  readonly column: ColumnName;
}

/**
 * One `doc_log` row: a doc change indexed **by reference**. The update's bytes stay in the signed
 * event core (RFC-0004) — this says which event, which change, and what state it is in.
 */
export interface DocLogEntry extends DocAddress {
  readonly author: PeerId;
  readonly seq: SeqNum;
  /** The change's position in its event. */
  readonly index: number;
  /** Absent is the root lineage. */
  readonly lineage?: LineageId;
  readonly hlc: Hlc;
  readonly action?: ActionId;
  readonly undoOf?: ActionId;
  /** The blob's hash when the update is blob-carried. */
  readonly blob?: string;
  /** The update's length in bytes, inline or blob. */
  readonly size: number;
  readonly state: DocEntryState;
}

/** How the column's snapshot is kept: by this device's adapter, from a checkpoint, or not at all. */
export type DocHeadMode = "materialised" | "checkpoint" | "none";

/** One `doc_heads` row: where a document's column snapshot stands against its log. */
export interface DocHead extends DocAddress {
  readonly adapter: AdapterId;
  /** The winning lineage; absent is the root. */
  readonly lineage?: LineageId;
  /** The snapshot's floor: every doc change of this document at or below these is in it. */
  readonly covers: Cursors;
  /** The adapter's version of the snapshot; absent until one is written. */
  readonly version?: Uint8Array;
  /** Entries on the winning lineage the snapshot does not hold. */
  readonly tailCount: number;
  readonly tailBytes: number;
  readonly mode: DocHeadMode;
  readonly materialisedAt?: number;
}

/** What a fold appends for one doc change: the entry, the adapter its change named, and its bytes. */
export interface DocAppend {
  readonly entry: DocLogEntry;
  readonly adapter: AdapterId;
  /** The update as the event carried it; never stored twice (the event core holds it). */
  readonly update: DocUpdate;
}

/** One doc-log entry by its place: author, sequence and the change's index in the event. */
export type DocEntryRef = Pick<DocLogEntry, "author" | "seq" | "index">;

/** A document's last persisted snapshot, of the lineage it was taken on. */
export interface DocSnapshot {
  readonly lineage?: LineageId;
  readonly bytes: Uint8Array;
}

/**
 * What a materialisation or a checkpoint install commits in one step (RFC-0023 §6.3): the
 * snapshot, the head's floor and version, and the entries the snapshot now holds.
 */
export interface DocCover {
  readonly adapter: AdapterId;
  readonly lineage?: LineageId;
  readonly covers: Cursors;
  readonly version: Uint8Array;
  readonly snapshot: Uint8Array;
  readonly mode: Exclude<DocHeadMode, "none">;
  /**
   * The head's `version` the snapshot was built on, as the tail read returned it; absent when it
   * was built on none. A head that has moved since refuses the cover ({@link DocCoverStale}).
   */
  readonly base?: Uint8Array;
  /** Epoch milliseconds, as `DocHead.materialisedAt` reads it back. */
  readonly at: number;
  /** Entries the snapshot includes; they become `covered`, and compaction may take them. */
  readonly covered: readonly DocEntryRef[];
  /** Entries the adapter refused; they become `failed`, and the document stays at its last good version. */
  readonly failed?: readonly DocEntryRef[];
}

/**
 * A cover built on a head that has moved since it was read: another snapshot was committed, or
 * another lineage won. Committing it would put an older snapshot over a newer one whose entries
 * are already `covered`, and lose them.
 */
export class DocCoverStale extends TaggedError("DocCoverStale")<{
  table: string;
  key: string;
  column: string;
  message: string;
}> {}

/**
 * The state a live entry takes on this device — the one decision `adapter-missing` rests on. A
 * blob-carried update is `bytes-missing` until its blob lands, which only a device that can
 * materialise it cares about; without the adapter, the entry is `adapter-missing` either way.
 */
export interface LiveStates {
  readonly inline: DocEntryState;
  readonly blob: DocEntryState;
}

export const liveStates = (hasAdapter: boolean): LiveStates =>
  hasAdapter
    ? { inline: "tail", blob: "bytes-missing" }
    : { inline: "adapter-missing", blob: "adapter-missing" };

/** The states a lineage change moves between: live on the winner, `orphaned` off it. */
export const LIVE_STATES: ReadonlySet<DocEntryState> = new Set([
  "tail",
  "covered",
  "bytes-missing",
  "adapter-missing",
]);

/**
 * The doc log and the heads beside it (RFC-0023 §6.2). The log is the LOG half — appended with
 * the event it indexes — and the heads the STATE half; both commit inside the write's
 * transaction when the engine has one.
 */
export interface DocStore {
  /** Idempotent by `(author, seq, index)`: a re-fold appends nothing twice. */
  readonly append: (entries: readonly DocLogEntry[]) => Promise<Result<void, StoreFailure>>;
  /** Every entry, by author, sequence and index. */
  readonly entries: () => Promise<Result<readonly DocLogEntry[], StoreFailure>>;
  /**
   * Re-labels one document's entries against the lineage that now wins: live ones on another
   * lineage become `orphaned`, `orphaned` ones on the winner come back as `live` says.
   */
  readonly relineage: (
    doc: DocAddress,
    winner: LineageId | undefined,
    live: LiveStates,
  ) => Promise<Result<void, StoreFailure>>;
  /**
   * Upserts the head's adapter and lineage and recounts its tail from the log. A snapshot the
   * head already records (`covers`, `version`, `mode`) is left as it is.
   */
  readonly refreshHead: (
    doc: DocAddress,
    adapter: AdapterId,
    lineage: LineageId | undefined,
  ) => Promise<Result<void, StoreFailure>>;
  readonly heads: () => Promise<Result<readonly DocHead[], StoreFailure>>;
  /** One document's entries, by author, sequence and index. */
  readonly entriesOf: (doc: DocAddress) => Promise<Result<readonly DocLogEntry[], StoreFailure>>;
  /** Commits a {@link DocCover}: snapshot, head and entry states together. */
  readonly cover: (doc: DocAddress, cover: DocCover) => Promise<Result<void, StoreFailure>>;
  readonly snapshotOf: (doc: DocAddress) => Promise<Result<DocSnapshot | undefined, StoreFailure>>;
  /**
   * Per author, the highest sequence below every entry of theirs that is not `covered` — the
   * floor compaction may not pass (§8.3). An author with no such entry is absent: nothing here
   * holds them back.
   */
  readonly uncoveredFloor: () => Promise<Result<Cursors, StoreFailure>>;
}

/** Every doc change in the events, as the entries a fold appends, in event and change order. */
export function docAppends(
  events: readonly SyncEvent[],
  hasAdapter: (adapter: AdapterId) => boolean,
): readonly DocAppend[] {
  const appends: DocAppend[] = [];
  for (const event of events) {
    // a local event is refused a doc change by the ladder; its sequence is a different namespace
    // and could never be an entry's without colliding with the author's synced one
    if (event.local === true) continue;
    event.changes.forEach((change, index) => {
      if (change.kind !== "doc") return;
      appends.push({
        entry: entryOf(event, change, index, hasAdapter),
        adapter: change.adapter,
        update: change.update,
      });
    });
  }
  return appends;
}

function entryOf(
  event: SyncEvent,
  change: DocChange,
  index: number,
  hasAdapter: (adapter: AdapterId) => boolean,
): DocLogEntry {
  const live = liveStates(hasAdapter(change.adapter));
  const { update } = change;
  const entry: DocLogEntry = {
    table: change.table,
    key: change.key,
    column: change.column,
    author: event.peerId,
    seq: event.seqNum,
    index,
    hlc: event.hlc,
    size: update.bytes === undefined ? update.blob.size : update.bytes.length,
    state: update.bytes === undefined ? live.blob : live.inline,
  };
  return {
    ...entry,
    ...(change.lineage !== undefined && { lineage: change.lineage }),
    ...(event.action !== undefined && { action: event.action }),
    ...(event.undoOf !== undefined && { undoOf: event.undoOf }),
    ...(update.blob !== undefined && { blob: update.blob.hash }),
  };
}

/** A document's address as one string, for maps: the three names joined by NUL. */
export const docKey = ({ table, key, column }: DocAddress): string =>
  `${String(table)}\u0000${String(key)}\u0000${String(column)}`;

const MOD = 1n << 64n;

/** One doc change's contribution: the first 8 bytes of `sha256(docChangeId)`, big-endian. */
export function docChangeDigest(entry: Pick<DocLogEntry, "author" | "seq" | "index">): bigint {
  const hash = sha256(docChangeId(entry.author, entry.seq, entry.index));
  let value = 0n;
  for (let i = 0; i < 8; i += 1) value = (value << 8n) | BigInt(hash[i] ?? 0);
  return value;
}

/**
 * Per document, the sum mod 2^64 of its doc changes' digests (RFC-0023 §6.4). Over ids only, so
 * it is adapter-independent: a peer with the adapter and one without agree whenever they hold the
 * same events, however each labels them. A sum and never an XOR, for `tableDigests`' reason.
 */
export function docDigests(entries: Iterable<DocLogEntry>): ReadonlyMap<string, bigint> {
  const digests = new Map<string, bigint>();
  for (const entry of entries) {
    const key = docKey(entry);
    digests.set(key, ((digests.get(key) ?? 0n) + docChangeDigest(entry)) % MOD);
  }
  return digests;
}

/** The state an entry moves to when `winner` is the lineage that wins. */
export function nextState(
  entry: DocLogEntry,
  winner: LineageId | undefined,
  live: LiveStates,
): DocEntryState {
  const onWinner = entry.lineage === winner;
  if (!onWinner && LIVE_STATES.has(entry.state)) return "orphaned";
  if (onWinner && entry.state === "orphaned")
    return entry.blob === undefined ? live.inline : live.blob;
  return entry.state;
}

/** Whether an entry is part of the tail a head counts: live, and not yet in the snapshot. */
export const inTail = (state: DocEntryState): boolean =>
  state === "tail" || state === "bytes-missing" || state === "adapter-missing";

/**
 * Appends a fold's doc entries and brings each touched document's labels and head up to date —
 * the doc log's half of a fold's persist step, and the one place it is written from. Re-running
 * it is harmless: the append is idempotent and the rest is recomputed from what is held.
 */
export function recordDocs(
  store: DocStore,
  appends: readonly DocAppend[],
  winnerOf: (doc: DocAddress) => LineageId | undefined,
  hasAdapter: (adapter: AdapterId) => boolean,
): Promise<Result<void, StoreFailure>> {
  return Result.gen(async function* () {
    if (appends.length === 0) return Result.ok(undefined);
    yield* Result.await(store.append(appends.map((a) => a.entry)));
    const touched = new Map<string, DocAppend>();
    for (const append of appends) touched.set(docKey(append.entry), append);
    for (const { entry, adapter } of touched.values()) {
      const doc = { table: entry.table, key: entry.key, column: entry.column };
      const winner = winnerOf(doc);
      yield* Result.await(store.relineage(doc, winner, liveStates(hasAdapter(adapter))));
      yield* Result.await(store.refreshHead(doc, adapter, winner));
    }
    return Result.ok(undefined);
  });
}
