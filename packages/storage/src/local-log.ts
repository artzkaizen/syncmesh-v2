import type { Coverage, Cursors, SeqRun, StoredEvent } from "@syncmesh/engine";
import type { Hlc, PeerId, SeqNum } from "@syncmesh/kernel";
import type { CborValue } from "@syncmesh/wire";

import { EMPTY_COVERAGE } from "@syncmesh/engine";
import { parsePeerId } from "@syncmesh/kernel";
import { Result, TaggedError } from "@syncmesh/result";
import {
  bytesToHex,
  decodeCbor,
  encodeCbor,
  encodeEventCore,
  hexToBytes,
  isNumber,
  isSafeNonNegative,
  isString,
} from "@syncmesh/wire";

import type { SqlRow } from "./driver.js";

import { decodeStoredEvent } from "./event-store.js";
import { parseCoverage, hlcRow } from "./sql.js";

/**
 * What a `localStorage` log persists, in two strings: the entries, and the head — the marks a boot
 * reads before anything is numbered.
 *
 * CBOR under hex rather than JSON, because the entries are already bytes: an event core survives
 * as a byte string instead of being re-encoded per field, and `MalformedCbor` and `InvalidHex` are
 * the typed damage reports this file turns into `LogCorrupt`.
 */

/**
 * The persisted log did not decode. The store still opens — empty — and hands this back beside it:
 * starting empty in silence is data loss the app cannot see, and refusing to open is a browser that
 * will not boot. The app's move is to re-sync from a peer.
 */
export class LogCorrupt extends TaggedError("LogCorrupt")<{ message: string }> {}

const corrupt = (message: string) => new LogCorrupt({ message });
const asCorrupt = (error: { readonly message: string }) => corrupt(error.message);

const VERSION = 1;

/** Each key holds one hex-encoded CBOR array led by the format version; an absent key reads as no items. */
function frame(text: string | null, items: number): Result<readonly CborValue[], LogCorrupt> {
  if (text === null) return Result.ok([]);
  return Result.gen(function* () {
    const bytes = yield* hexToBytes(text).mapError(asCorrupt);
    const value = yield* decodeCbor(bytes).mapError(asCorrupt);
    if (!Array.isArray(value) || value.length !== items || value[0] !== VERSION)
      return Result.err(corrupt(`not a version-${VERSION} record of ${items} items`));
    return Result.ok(value);
  });
}

/** `(peer, local, seq)` triples — the same rows the SQL store keeps its floors in, so one decoder folds both. */
const cursorRows = (coverage: Coverage): CborValue => [
  ...[...coverage.synced].map(([peer, seq]) => [peer, 0, seq]),
  ...[...coverage.local].map(([peer, seq]) => [peer, 1, seq]),
];

function parseCursors(value: CborValue | undefined): Result<Coverage, LogCorrupt> {
  if (!Array.isArray(value)) return Result.err(corrupt("cursors are not an array"));
  const rows: SqlRow[] = [];
  for (const row of value) {
    if (!Array.isArray(row)) return Result.err(corrupt("a cursor is not a row"));
    const [peer, local, seq] = row;
    if (!isString(peer) || !isSafeNonNegative(local) || !isSafeNonNegative(seq))
      return Result.err(corrupt("a cursor is not (peer, local, seq)"));
    rows.push([peer, local, seq]);
  }
  return parseCoverage(rows).mapError(asCorrupt);
}

/**
 * The marks that must never go backwards. They are held apart from the entries because they must
 * outlive them: an event compacted away, or one whose bytes a full quota refused, still moves the
 * mark it set — otherwise a restart re-issues its sequence number and two different events answer
 * to one id (RFC-0004, and the boot invariant D05 names).
 */
export interface PersistedHead {
  /** The highest stamp ever appended, whatever became of the event that carried it. */
  readonly hlc: Hlc | undefined;
  /** The highest sequence ever appended, per author and scope. */
  readonly seqs: Coverage;
  /** What compaction has removed: `compactedBelow`. */
  readonly floors: Coverage;
}

export const EMPTY_HEAD: PersistedHead = {
  hlc: undefined,
  seqs: EMPTY_COVERAGE,
  floors: EMPTY_COVERAGE,
};

export const encodeHead = ({ hlc, seqs, floors }: PersistedHead): string =>
  bytesToHex(
    encodeCbor([
      VERSION,
      hlc === undefined ? null : [hlc[0].epochMilliseconds, hlc[1]],
      cursorRows(seqs),
      cursorRows(floors),
    ]),
  );

const parseStamp = (value: CborValue): Result<Hlc | undefined, LogCorrupt> => {
  if (value === null) return Result.ok(undefined);
  if (!Array.isArray(value)) return Result.err(corrupt("the stamp is not a pair"));
  const [ms, logical] = value;
  if (!isNumber(ms) || !isNumber(logical))
    return Result.err(corrupt("the stamp is not a pair of numbers"));
  return hlcRow([ms, logical]).mapError(asCorrupt);
};

export function decodeHead(text: string | null): Result<PersistedHead, LogCorrupt> {
  return Result.gen(function* () {
    const [, stamp, seqs, floors] = yield* frame(text, 4);
    if (stamp === undefined) return Result.ok(EMPTY_HEAD); // no key yet: a first boot, not damage
    return Result.ok({
      hlc: yield* parseStamp(stamp),
      seqs: yield* parseCursors(seqs),
      floors: yield* parseCursors(floors),
    });
  });
}

/**
 * What lies under the floors, in a third key beside the head: the runs below the compaction floor
 * the log never held (`MemoryEventStore.holes`, the SQL log's gap table), and the floor a snapshot
 * install left (`EventStore.installedBelow`). Absent from a log written before either was kept,
 * which reads as none.
 */
export interface PersistedBelow {
  readonly holes: readonly SeqRun[];
  readonly installed: Cursors;
}

export const EMPTY_BELOW: PersistedBelow = { holes: [], installed: new Map() };

export const encodeBelow = ({ holes, installed }: PersistedBelow): string =>
  bytesToHex(
    encodeCbor([
      VERSION,
      holes.map(({ peer, local, from, to }) => [peer, local ? 1 : 0, from, to]),
      cursorRows({ synced: installed, local: new Map() }),
    ]),
  );

const parseRun = (value: CborValue): Result<SeqRun, LogCorrupt> => {
  if (!Array.isArray(value)) return Result.err(corrupt("a hole is not a row"));
  const [peer, local, from, to] = value;
  if (
    !isString(peer) ||
    !isSafeNonNegative(local) ||
    !isSafeNonNegative(from) ||
    !isSafeNonNegative(to)
  )
    return Result.err(corrupt("a hole is not (peer, local, from, to)"));
  // SAFETY: both ends were checked as safe non-negative integers above, which is what a sequence is
  const run = (author: PeerId) => ({
    peer: author,
    local: local === 1,
    from: from as SeqNum,
    to: to as SeqNum,
  });
  return parsePeerId(peer).map(run).mapError(asCorrupt);
};

export function decodeBelow(text: string | null): Result<PersistedBelow, LogCorrupt> {
  return Result.gen(function* () {
    const [, holes, installed] = yield* frame(text, 3);
    if (holes === undefined) return Result.ok(EMPTY_BELOW); // no key: a log from before it
    if (!Array.isArray(holes)) return Result.err(corrupt("the holes are not an array"));
    const runs: SeqRun[] = [];
    for (const row of holes) runs.push(yield* parseRun(row));
    return Result.ok({ holes: runs, installed: (yield* parseCursors(installed)).synced });
  });
}

/** The same `(core, local, sig)` row the SQL log stores: the bytes the signature covers, never a re-encode of them. */
const logRow = ({ event, core, sig }: StoredEvent): CborValue => [
  core ?? encodeEventCore(event),
  event.local === true ? 1 : 0,
  sig ?? null,
];

export const encodeLog = (entries: readonly StoredEvent[]): string =>
  bytesToHex(encodeCbor([VERSION, entries.map(logRow)]));

export function decodeLog(text: string | null): Result<readonly StoredEvent[], LogCorrupt> {
  return Result.gen(function* () {
    const [, list] = yield* frame(text, 2);
    if (list === undefined) return Result.ok([]); // no key yet: a first boot, not damage
    if (!Array.isArray(list)) return Result.err(corrupt("the log is not an array"));
    const entries: StoredEvent[] = [];
    for (const row of list) {
      if (!Array.isArray(row)) return Result.err(corrupt("an entry is not a row"));
      const [core, local, sig] = row;
      if (!(core instanceof Uint8Array) || !isSafeNonNegative(local))
        return Result.err(corrupt("an entry is not (core, local, sig)"));
      if (sig !== null && !(sig instanceof Uint8Array))
        return Result.err(corrupt("a signature is not bytes"));
      entries.push(yield* decodeStoredEvent([core, local, sig]).mapError(asCorrupt));
    }
    return Result.ok(entries);
  });
}
