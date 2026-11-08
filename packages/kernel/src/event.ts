import { Result, TaggedError } from "@syncmesh/result";

import type { Change } from "./change.js";
import type { ActionId } from "./doc.js";
import type { Hlc } from "./hlc.js";
import type { PartitionKey } from "./partition.js";
import type { Brand } from "./primitives.js";
import type { Stamp } from "./stamp.js";

import { PEER_ID_HEX, parsePeerId, type PeerId } from "./peer-id.js";

export type ProtocolVersion = 1;

export type SeqNum = Brand<number, "SeqNum">;

export type EventId = Brand<string, "EventId">;

export type Procedure = Brand<string, "Procedure">;

/**
 * Which app schema an event was written against (D31): a positive integer the manifest declares
 * and raises with each change to its shape. A reading, never a gate — no build refuses an event
 * for it. An event without one came from a build that declared none, and reads as `1`.
 */
export type SchemaVersion = Brand<number, "SchemaVersion">;

/** One local write as every peer will see it. Unsigned: the wire envelope carries the signature. See RFC-0002. */
export interface SyncEvent {
  readonly v: ProtocolVersion;
  readonly id: EventId;
  readonly peerId: PeerId;
  readonly seqNum: SeqNum;
  readonly hlc: Hlc;
  readonly procedure: Procedure;
  readonly partition?: PartitionKey;
  readonly changes: readonly Change[];
  /**
   * The action this event belongs to (event key 10); absent, the event is its own action. Drives
   * history and undo only — an old build that skips it folds the event identically (RFC-0023 §5.2).
   */
  readonly action?: ActionId;
  /** The action this event compensates (event key 11): an undo, and a redo is the undo of an undo. */
  readonly undoOf?: ActionId;
  /**
   * The app schema the author's build declared (event key 9, D31); absent from a build that
   * declared none. What `oldestSchema()` reads; nothing refuses an event for it.
   */
  readonly schemaVersion?: SchemaVersion;
  /**
   * This event's content is sealed and this device holds no key for it (book ch. 14), so
   * `changes` is empty because there is nothing readable — not because nothing was written.
   *
   * A carrier stores it, relays it, counts it towards coverage and folds nothing, which is the
   * whole of custody without judgment. Nothing else in the system needs to look at this: an
   * empty change list already folds to nothing. It is here so a device can *say* why.
   */
  readonly sealed?: true;
  /** Never leaves this device; numbered in its own sequence namespace. */
  readonly local?: true;
}

export class InvalidSeqNum extends TaggedError("InvalidSeqNum")<{
  input: number;
  message: string;
}> {}

export class InvalidSchemaVersion extends TaggedError("InvalidSchemaVersion")<{
  input: number;
  message: string;
}> {}

export class InvalidEventId extends TaggedError("InvalidEventId")<{
  input: string;
  message: string;
}> {}

export function parseSeqNum(input: number): Result<SeqNum, InvalidSeqNum> {
  if (!Number.isSafeInteger(input) || input < 1) {
    return Result.err(new InvalidSeqNum({ input, message: "expected a positive safe integer" }));
  }
  // SAFETY: checked positive safe integer, which is the SeqNum invariant
  return Result.ok(input as SeqNum);
}

/** The version a schema declares: a positive safe integer, so "older" is a comparison. */
export function parseSchemaVersion(input: number): Result<SchemaVersion, InvalidSchemaVersion> {
  if (!Number.isSafeInteger(input) || input < 1)
    return Result.err(
      new InvalidSchemaVersion({ input, message: "expected a positive safe integer" }),
    );
  // SAFETY: checked positive safe integer, which is the SchemaVersion invariant
  return Result.ok(input as SchemaVersion);
}

/** What an event's author declared, `1` for an author that declared nothing (D31). */
export const eventSchemaVersion = (event: Pick<SyncEvent, "schemaVersion">): SchemaVersion =>
  // SAFETY: 1 is a positive safe integer, the SchemaVersion invariant
  event.schemaVersion ?? (1 as SchemaVersion);

/** `${peerId}-${seqNum}`, or `${peerId}-L${seqNum}` for a local write — the two sequences never share an id. */
export function eventId(peerId: PeerId, seqNum: SeqNum, local = false): EventId {
  // SAFETY: built from two already-validated brands in the documented format
  return `${peerId}-${local ? "L" : ""}${seqNum}` as EventId;
}

const EVENT_ID = new RegExp(`^(${PEER_ID_HEX.source.slice(1, -1)})-(L?)([1-9][0-9]*)$`);

export interface ParsedEventId {
  readonly peerId: PeerId;
  readonly seqNum: SeqNum;
  readonly local: boolean;
}

export function parseEventId(input: string): Result<ParsedEventId, InvalidEventId> {
  const match = EVENT_ID.exec(input);
  const peerHex = match?.[1];
  const seqText = match?.[3];
  if (peerHex === undefined || seqText === undefined) {
    return Result.err(new InvalidEventId({ input, message: "expected <peerId>-[L]<seqNum>" }));
  }
  return Result.gen(function* () {
    const peerId = yield* parsePeerId(peerHex);
    const seqNum = yield* parseSeqNum(Number(seqText));
    return Result.ok({ peerId, seqNum, local: match?.[2] === "L" });
  }).mapError(() => new InvalidEventId({ input, message: "expected <peerId>-[L]<seqNum>" }));
}

export const eventStamp = (event: SyncEvent): Stamp => ({ hlc: event.hlc, peer: event.peerId });
