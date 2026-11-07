import type { StoreFailure } from "@syncmesh/engine";
import type { EventId } from "@syncmesh/kernel";
import type { BlobHash } from "@syncmesh/storage";
import type { WireError } from "@syncmesh/wire";

import { timed } from "@syncmesh/engine";
import { Result } from "@syncmesh/result";
import { decodeAndVerify } from "@syncmesh/wire";

import type { RelayFrame } from "./frames.js";
import type { Conversation, RoomState } from "./state.js";

import {
  ackFrame,
  blobFrame,
  blobMissingFrame,
  blobRefusedFrame,
  blobStoredFrame,
  relayedFrame,
} from "./frames.js";

/** What one event cost the room: nothing at all when it already held it. */
export interface Absorbed {
  /** The id it verified as, which is what an ack names — sent for a duplicate as much as a first. */
  readonly id: EventId;
  /** The frame this room sent its own clients, or absent when the event was a duplicate. */
  readonly relayed?: Uint8Array;
  readonly receivers: number;
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
  if (held.value) return Result.ok({ id, receivers: 0 });
  const stored = await room.store.append(entry);
  if (stored.isErr()) return Result.err(stored.error);
  room.appended(entry);
  const relayed = relayedFrame(wire, room.offset());
  return Result.ok({
    id,
    relayed,
    receivers: room.toInterested(relayed, entry.event, entry.event.peerId),
  });
};

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
  const { room, refuse } = conversation;
  // the room's own meter, charged by every socket on it: a socket that has caused nothing is
  // still refused while a crowd it belongs to owes. Only an event can add to that debt, so only
  // an event is refused for it — a join or a grant from an honest device costs the room no sends
  if (room.budget.owes("fanout")) {
    refuse("rate", "this room is over its fanout rate", true);
    return;
  }
  room.enqueue(async () => {
    const [outcome, duration] = await timed(() => absorbEvent(room, wire));
    if (outcome.isErr()) {
      refuse(outcome.error._tag === "StoreFailure" ? "store" : "bad-event", outcome.error.message);
      return;
    }
    const { id, relayed, receivers } = outcome.value;
    if (relayed !== undefined) {
      room.publish(relayed);
      // the sender pays for the sends it caused (gap audit №7). After the fact, because how many
      // clients an event reaches is not known until it has reached them — what the charge buys
      // is the *next* frame from this socket being unaffordable
      conversation.budget.charge("fanout", receivers);
      // and the room pays too, whoever sent it: a crowd of sockets each under its own budget is
      // still one room's sends
      room.budget.charge("fanout", receivers);
      room.report({
        type: "relay.event",
        sizes: { bytes: wire.byteLength, receivers },
        duration,
      });
    }
    conversation.sender.send(ackFrame(String(id), room.offset()));
  });
}

/**
 * Bytes by name (D18). A put is verified before it is stored, so junk cannot squat a hash, and
 * answered — `blob-stored`, or `blob-refused` when its partition's quota would pass, which is how
 * the putter learns it as a value rather than as silence. A get answers with the bytes or
 * `blob-missing`, which is a value the fetcher can act on — anyone still holding them can put
 * them back under the same name.
 */
export function serveBlob(
  conversation: Conversation,
  frame: Extract<RelayFrame, { kind: "blob-put" | "blob-get" }>,
): void {
  const { room, sender, refuse } = conversation;
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
      const [stored, duration] = await timed(() => keeper.put(hash, frame.bytes, frame.partition));
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
      else refuse("blob-corrupt", failure.message);
      return;
    }
    const [found, duration] = await timed(async () => room.blobs?.get(hash));
    const bytes = found === undefined || found.isErr() ? undefined : found.value;
    if (bytes === undefined) sender.send(blobMissingFrame(frame.hash));
    else sender.send(blobFrame(frame.hash, bytes));
    room.report({ type: "relay.blob.get", sizes: { bytes: bytes?.byteLength ?? 0 }, duration });
  });
}
