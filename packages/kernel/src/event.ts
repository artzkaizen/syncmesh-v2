import type { Brand, Change, Hlc, PeerId, Stamp } from "@syncmesh/kernel";

import { PEER_ID_HEX, parsePeerId } from "@syncmesh/kernel";
import { Result, TaggedError } from "@syncmesh/result";

export type ProtocolVersion = 1;

export type SeqNum = Brand<number, "SeqNum">;

export type EventId = Brand<string, "EventId">;

export type Procedure = Brand<string, "Procedure">;

export type PartitionKey = Brand<string, "PartitionKey">;

export class InvalidPartitionKey extends TaggedError("InvalidPartitionKey")<{
  input: string;
  message: string;
}> {}

/** `kind:id` — the one form a partition instance takes, on events and in grants alike (D07). */
export const PARTITION_KEY = /^[a-z][a-z0-9_]{0,63}:[^\s:]{1,255}$/;

export function parsePartitionKey(input: string): Result<PartitionKey, InvalidPartitionKey> {
  if (!PARTITION_KEY.test(input)) {
    return Result.err(new InvalidPartitionKey({ input, message: "expected kind:id" }));
  }
  // SAFETY: matched PARTITION_KEY
  return Result.ok(input as PartitionKey);
}

/** One local write as every peer will see it. Unsigned: the wire envelope (E03) carries the signature. See RFC-0002. */
export interface SyncEvent {
  readonly v: ProtocolVersion;
  readonly id: EventId;
  readonly peerId: PeerId;
  readonly seqNum: SeqNum;
  readonly hlc: Hlc;
  readonly procedure: Procedure;
  readonly partition?: PartitionKey;
  readonly changes: readonly Change[];
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

/** `${peerId}-${seqNum}` — the key every engine dedups on. */
export function eventId(peerId: PeerId, seqNum: SeqNum): EventId {
  // SAFETY: built from two already-validated brands in the documented format
  return `${peerId}-${seqNum}` as EventId;
}

const EVENT_ID = new RegExp(`^(${PEER_ID_HEX.source.slice(1, -1)})-([1-9][0-9]*)$`);

export function parseEventId(
  input: string,
): Result<{ readonly peerId: PeerId; readonly seqNum: SeqNum }, InvalidEventId> {
  const match = EVENT_ID.exec(input);
  const peerHex = match?.[1];
  const seqText = match?.[2];
  if (peerHex === undefined || seqText === undefined) {
    return Result.err(new InvalidEventId({ input, message: "expected <peerId>-<seqNum>" }));
  }
  return Result.gen(function* () {
    const peerId = yield* parsePeerId(peerHex);
    const seqNum = yield* parseSeqNum(Number(seqText));
    return Result.ok({ peerId, seqNum });
  }).mapError(() => new InvalidEventId({ input, message: "expected <peerId>-<seqNum>" }));
}

export const stampOf = (event: SyncEvent): Stamp => ({ hlc: event.hlc, peer: event.peerId });
