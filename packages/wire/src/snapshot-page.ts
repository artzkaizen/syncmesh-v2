import type { KeyedRecord, PeerId } from "@syncmesh/kernel";

import { Result, TaggedError } from "@syncmesh/result";

import type { CborValue } from "./cbor.js";

import { isSafeNonNegative } from "./cbor-guards.js";

/*
 * What a snapshot page is beside its rows (RFC-0019, RFC-0023 §5.5): the checkpoints of their
 * documents a version 2 page carries, and the refusal every page reader answers with.
 */

export class MalformedSnapshot extends TaggedError("MalformedSnapshot")<{ message: string }> {}

export const malformed = (message: string) => Result.err(new MalformedSnapshot({ message }));

/**
 * A document's checkpoint as a snapshot page carries it (RFC-0023 §5.5, §8.4): the signed
 * `DocCheckpoint` envelope, whose producer signed it, and the snapshot bytes its key 7 names, so a
 * joiner installs the document with the rows it is a column of.
 */
export interface PageCheckpoint {
  readonly producer: PeerId;
  /** The signed envelope, `[core, sig]`, as `signCheckpoint` wrote it. */
  readonly checkpoint: Uint8Array;
  /** The bytes key 7 hashes: for a sealed partition, sealed to its key. */
  readonly snapshot: Uint8Array;
}

/**
 * The document checkpoints one page carries (E30 P5). `complete` is the sender's word that every
 * document of the page's rows it holds anything of has a checkpoint here: what lets a joiner below
 * its floor adopt the coverage those documents' compacted updates sat under.
 */
export interface PageDocs {
  readonly checkpoints: readonly PageCheckpoint[];
  readonly complete: boolean;
}

/** One page: its rows, and its documents when the sender put them in (version 2). */
export interface SnapshotPage {
  readonly rows: readonly KeyedRecord[];
  /** Absent on a page of rows alone (version 1). */
  readonly docs?: PageDocs;
}

/** A page of rows alone. */
export const ROWS_VERSION = 1;
/** A page of rows and the checkpoints that stand for their documents (RFC-0023 §5.5). */
export const DOCS_VERSION = 2;

/** A page's outer array, checked for a version this build reads and that version's length. */
export function parsePageVersion(
  value: CborValue,
): Result<readonly CborValue[], MalformedSnapshot> {
  if (!Array.isArray(value)) return malformed("snapshot is not an array");
  const [version] = value;
  if (version === ROWS_VERSION)
    return value.length === 5 ? Result.ok(value) : malformed("snapshot is not a quintuple");
  if (version === DOCS_VERSION)
    return value.length === 7
      ? Result.ok(value)
      : malformed("snapshot with documents is not a septuple");
  return malformed(`snapshot version ${String(version)} is not ${ROWS_VERSION} or ${DOCS_VERSION}`);
}

/** A version 2 page's last two entries, `[checkpoints, complete]`; none for version 1. */
export const pageDocsCbor = (
  docs: PageDocs | undefined,
  peerIndex: (peer: PeerId) => number,
): CborValue[] =>
  docs === undefined
    ? []
    : [
        docs.checkpoints.map(({ producer, checkpoint, snapshot }): CborValue => [
          peerIndex(producer),
          checkpoint,
          snapshot,
        ]),
        docs.complete,
      ];

/** Reads `[checkpoints, complete]` against the page's peers. */
export function readPageDocs(
  tail: readonly CborValue[],
  peers: readonly PeerId[],
): Result<PageDocs, MalformedSnapshot> {
  const [entries, complete] = tail;
  if (complete !== true && complete !== false) return malformed("completeness is not a boolean");
  return readCheckpoints(entries, peers).map((checkpoints) => ({ checkpoints, complete }));
}

function readCheckpoints(
  value: CborValue | undefined,
  peers: readonly PeerId[],
): Result<readonly PageCheckpoint[], MalformedSnapshot> {
  if (!Array.isArray(value)) return malformed("checkpoints are not an array");
  const out: PageCheckpoint[] = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 3) return malformed("checkpoint is not a triple");
    const [index, checkpoint, snapshot] = entry;
    if (!isSafeNonNegative(index)) return malformed("checkpoint producer is not an index");
    const producer = peers[index];
    if (producer === undefined) return malformed("checkpoint producer index is out of range");
    if (!(checkpoint instanceof Uint8Array)) return malformed("checkpoint is not bytes");
    if (!(snapshot instanceof Uint8Array)) return malformed("checkpoint snapshot is not bytes");
    out.push({ producer, checkpoint, snapshot });
  }
  return Result.ok(out);
}
