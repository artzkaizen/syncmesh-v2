import { Result, TaggedError } from "@syncmesh/result";

import type { Change } from "./change.js";
import type { Hlc } from "./hlc.js";
import type { PartitionKey } from "./partition.js";
import type { Brand } from "./primitives.js";
import type { Stamp } from "./stamp.js";

import { PEER_ID_HEX, parsePeerId, type PeerId } from "./peer-id.js";

export type ProtocolVersion = 1;

export type SeqNum = Brand<number, "SeqNum">;

export type EventId = Brand<string, "EventId">;

export type Procedure = Brand<string, "Procedure">;

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

export const stampOf = (event: SyncEvent): Stamp => ({ hlc: event.hlc, peer: event.peerId });
