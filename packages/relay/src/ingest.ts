import type { StoreFailure } from "@syncmesh/engine";
import type { EventId } from "@syncmesh/kernel";
import type { BlobHash } from "@syncmesh/storage";
import type { WireError } from "@syncmesh/wire";

import { timed } from "@syncmesh/engine";
import { Result } from "@syncmesh/result";
import { Temporal, durationMs } from "@syncmesh/temporal";
import { decodeAndVerify } from "@syncmesh/wire";

import type { RelayFrame } from "./frames.js";
import type { Seat } from "./seat.js";
import type { Conversation, RoomState } from "./state.js";

import {
  ackFrame,
  blobFrame,
  blobMissingFrame,
  blobRefusedFrame,
  blobStoredFrame,
  relayedFrame,
} from "./frames.js";
import { UNGRANTED } from "./trust.js";

/** What one event cost the room: nothing at all when it already held it. */
export interface Absorbed {
  /** The id it verified as, which is what an ack names — sent for a duplicate as much as a first. */
  readonly id: EventId;
  /** The frame this room sent its own clients, or absent when the event was a duplicate. */
  readonly relayed?: Uint8Array;
  readonly receivers: number;
  /** Every frame it put on a socket: the sends, and the pass-overs they caused. */
  readonly frames: number;
}

/**
 * One event into this room: verified, deduped by id, appended, and handed to every client whose
 * interest wants it. Shared by the two ways an event arrives — a client's socket, which is owed
 * an ack and a typed refusal, and another instance's fan-out, which is owed neither.
 *
 * Publishing is the caller's, deliberately. The frame that came in from a fan-out has already
 * reached every other instance from the one that first sent it, and re-publishing it would
 * multiply one write by the size of the fleet.
 */
export const absorbEvent = async (
  room: RoomState,
  wire: Uint8Array,
): Promise<Result<Absorbed, WireError | StoreFailure>> => {
  const verified = decodeAndVerify(wire);
  if (verified.isErr()) return Result.err(verified.error);
  // locality never reaches the wire: the envelope has no field for it, so a local event
  // cannot arrive here — the device-side writer and codec enforce that (D20)
  const entry = verified.value;
  const id = entry.event.id;
  const held = await room.store.has(id);
  if (held.isErr()) return Result.err(held.error);
  if (held.value) return Result.ok({ id, receivers: 0, frames: 0 });
  const stored = await room.store.append(entry);
  if (stored.isErr()) return Result.err(stored.error);
  room.appended(entry);
  const relayed = relayedFrame(wire, room.offset());
  return Result.ok({ id, relayed, ...room.toInterested(relayed, entry.event, entry.event.peerId) });
};

/** How long events held for the room's fan-out debt wait before the room is asked again. */
export const ROOM_DEBT_RETRY = Temporal.Duration.from({ milliseconds: 50 });

/**
 * Where a socket's events enter the room: straight to {@link ingestEvent} while the room can
 * afford their fan-out, and held in arrival order while it owes (`RelayLimits.roomFanout`).
 *
 * The room's debt is every socket's doing, so it is never a hang-up: refusing whoever sent next
 * would let a few sockets keep a room in debt and disconnect every honest writer in it, again on
 * each reconnect. Holding is backpressure instead — the crowd that ran the debt up waits with
 * everyone else, so the room's sends stay at its rate. Dropping the event without a hang-up is
 * not an option either: the socket's next event would land after it and leave a hole in the log.
 *
 * What one socket may have held is its sender's ceiling, `maxBacklog` frames and
 * `limits.maxBacklogBytes`; past it the socket is refused with `rate` and hung up, which loses
 * nothing, because its reconnect re-sends from the relay's cursors.
 *
 * Only events are held. The same socket's other frames — blob puts, presence, grants, cursors —
 * go straight through, so one sent after an event can be handled before that event lands.
 *
 * @param closed - Whether the conversation has ended; held events are then dropped, unsent.
 */
export function eventIntake(
  conversation: Conversation,
  closed: () => boolean,
): (wire: Uint8Array) => void {
  const { room, refuse } = conversation;
  const held: Uint8Array[] = [];
  let heldBytes = 0;
  let waiting: ReturnType<typeof setTimeout> | undefined;

  // in the room's queue, so each event's charge has landed before the next is let out: one
  // token of credit releases one event's fan-out, not every event held behind it
  const drain = async (): Promise<void> => {
    for (let next = held[0]; next !== undefined && !closed(); next = held[0]) {
      if (room.budget.owes("fanout")) break;
      held.shift();
      heldBytes -= next.byteLength;
      await absorbAndAck(conversation, next);
    }
    if (closed()) {
      held.length = 0;
      heldBytes = 0;
    }
    waiting = held.length > 0 ? setTimeout(release, durationMs(ROOM_DEBT_RETRY)) : undefined;
  };
  const release = (): void => room.enqueue(drain);

  return (wire) => {
    if (held.length === 0 && !room.budget.owes("fanout")) {
      ingestEvent(conversation, wire);
      return;
    }
    if (
      held.length >= room.maxBacklog ||
      heldBytes + wire.byteLength > room.limits.maxBacklogBytes
    ) {
      clearTimeout(waiting);
      waiting = undefined;
      held.length = 0;
      heldBytes = 0;
      refuse(
        "rate",
        "this socket sent more than it may hold while the room is over its fanout rate",
        true,
      );
      return;
    }
    held.push(wire);
    heldBytes += wire.byteLength;
    waiting ??= setTimeout(release, durationMs(ROOM_DEBT_RETRY));
  };
}

/**
 * One event: verify, dedup by id, append, fan out to whoever asked for it, ack. The ack is sent
 * for a duplicate too — it is the durability answer a write handle's `synced()` counts, and a
 * client that retried because its first ack was lost must not wait forever for a second.
 *
 * `relay.event` is emitted only for an event that was actually appended: a duplicate cost the
 * room a `has` and nothing else, and reporting it as an append would make every retry look like
 * traffic the room absorbed.
 */
export function ingestEvent(conversation: Conversation, wire: Uint8Array): void {
  conversation.room.enqueue(() => absorbAndAck(conversation, wire));
}

/** {@link ingestEvent}'s work, run from inside the room's queue. */
async function absorbAndAck(conversation: Conversation, wire: Uint8Array): Promise<void> {
  const { room, refuse } = conversation;
  const [outcome, duration] = await timed(() => absorbEvent(room, wire));
  if (outcome.isErr()) {
    refuse(outcome.error._tag === "StoreFailure" ? "store" : "bad-event", outcome.error.message);
    return;
  }
  const { id, relayed, receivers, frames } = outcome.value;
  if (relayed !== undefined) {
    room.publish(relayed);
    // the sender pays for the sends it caused (gap audit №7). After the fact, because how many
    // clients an event reaches is not known until it has reached them — what the charge buys
    // is the *next* frame from this socket being unaffordable. Frames, not receivers: a pass-over
    // this write caused costs a socket a send just as the event does
    conversation.budget.charge("fanout", frames);
    // and the room pays too, whoever sent it: a crowd of sockets each under its own budget is
    // still one room's sends
    room.budget.charge("fanout", frames);
    room.report({
      type: "relay.event",
      sizes: { bytes: wire.byteLength, receivers },
      duration,
    });
  }
  conversation.sender.send(ackFrame(id, room.offset()));
}

/** A frame that puts or asks for bytes by name (D18). */
export const isBlobFrame = (
  frame: RelayFrame,
): frame is Extract<RelayFrame, { kind: "blob-put" | "blob-get" }> =>
  frame.kind === "blob-put" || frame.kind === "blob-get";

/**
 * Bytes by name (D18). A put is verified before it is stored, so junk cannot squat a hash, and
 * answered — `blob-stored`, or `blob-refused` when its partition's quota would pass, which is how
 * the putter learns it as a value rather than as silence. A get answers with the bytes or
 * `blob-missing`, which is a value the fetcher can act on — anyone still holding them can put
 * them back under the same name.
 *
 * In a grant-gated room both are checked against the socket's grant (D44). A put billed to a
 * partition the grant does not name is refused `ungranted` and nothing is stored. A get is served
 * only when a put billed the bytes to a partition the grant names, or to none — the homes the
 * keeper recorded — and is otherwise answered `blob-missing`, exactly as for bytes the room never
 * held, so a refusal does not tell the asker the hash exists. A row naming the hash authorises
 * nothing: any socket can write a hash it has seen into a row of its own.
 *
 * @param seat - The socket's seat, read as the frame arrives: what its grant names, or `undefined`
 *   in an open room, which checks neither half.
 */
export function serveBlob(
  conversation: Conversation,
  frame: Extract<RelayFrame, { kind: "blob-put" | "blob-get" }>,
  seat: Pick<Seat, "blobPartitions">,
): void {
  const { room, sender, refuse } = conversation;
  const partitions = seat.blobPartitions();
  room.enqueue(async () => {
    // SAFETY: a hash off the wire is opaque here; the store verifies it against the bytes
    const hash = frame.hash as BlobHash;
    if (frame.kind === "blob-put") {
      // a room with no blob store keeps nothing, and says so at once: an upload waits for an
      // answer, and silence would cost every put the whole wait. `no-store` is a code no client
      // reads as a quota, so the putter stays the holder and its put succeeds, as it always has
      const { keeper } = room;
      if (keeper === undefined) {
        sender.send(blobRefusedFrame(frame.hash, "no-store", 0, 0));
        return;
      }
      const billed = frame.partition;
      if (partitions !== undefined && billed !== undefined && !partitions.includes(billed)) {
        sender.send(blobRefusedFrame(frame.hash, UNGRANTED, 0, 0, billed));
        return;
      }
      const [stored, duration] = await timed(() => keeper.put(hash, frame.bytes, billed));
      if (stored.isOk()) {
        sender.send(blobStoredFrame(frame.hash));
        room.report({ type: "relay.blob.put", sizes: { bytes: frame.bytes.byteLength }, duration });
        return;
      }
      const failure = stored.error;
      if (failure._tag === "BlobQuotaExceeded")
        sender.send(
          blobRefusedFrame(frame.hash, "quota", failure.limit, failure.used, failure.partition),
        );
      else if (failure._tag === "StoreFailure") refuse("store", failure.message);
      else refuse("blob-corrupt", failure.message);
      return;
    }
    const [found, duration] = await timed(async () => {
      if (partitions !== undefined) {
        const readable = await room.keeper?.readable(hash, partitions);
        // no keeper, a store failure, or no home this grant names: the same answer as absent
        if (readable === undefined || !readable.isOk() || !readable.value) return undefined;
      }
      return room.blobs?.get(hash);
    });
    const bytes = found === undefined || found.isErr() ? undefined : found.value;
    if (bytes === undefined) sender.send(blobMissingFrame(frame.hash));
    else sender.send(blobFrame(frame.hash, bytes));
    room.report({ type: "relay.blob.get", sizes: { bytes: bytes?.byteLength ?? 0 }, duration });
  });
}
