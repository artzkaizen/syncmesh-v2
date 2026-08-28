import type { StoredEvent, StoreFailure } from "@syncmesh/engine";
import type { BlobHash } from "@syncmesh/storage";

import { timed } from "@syncmesh/engine";
import { Result } from "@syncmesh/result";
import { decodeAndVerify } from "@syncmesh/wire";

import type { RelayFrame } from "./frames.js";
import type { Conversation, RoomState } from "./state.js";

import { ackFrame, blobFrame, blobMissingFrame, relayedFrame } from "./frames.js";

/** The append and its fan-out as one step, answering how many sockets took the frame. */
const append = async (
  room: RoomState,
  entry: StoredEvent,
  wire: Uint8Array,
): Promise<Result<number, StoreFailure>> => {
  const stored = await room.store.append(entry);
  if (stored.isErr()) return Result.err(stored.error);
  room.appended(entry);
  const relayed = relayedFrame(wire, room.offset());
  const receivers = room.toInterested(relayed, entry.event, entry.event.peerId);
  room.publish(relayed);
  return Result.ok(receivers);
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
  const { room, sender, refuse } = conversation;
  room.enqueue(async () => {
    const verified = decodeAndVerify(wire);
    if (verified.isErr()) {
      refuse("bad-event", verified.error.message);
      return;
    }
    // locality never reaches the wire: the envelope has no field for it, so a local event
    // cannot arrive here — the device-side writer and codec enforce that (D20)
    const { event } = verified.value;
    const held = await room.store.has(event.id);
    if (held.isErr()) {
      refuse("store", held.error.message);
      return;
    }
    if (!held.value) {
      const [outcome, duration] = await timed(() => append(room, verified.value, wire));
      if (outcome.isErr()) {
        refuse("store", outcome.error.message);
        return;
      }
      room.report({
        type: "relay.event",
        sizes: { bytes: wire.byteLength, receivers: outcome.value },
        duration,
      });
    }
    sender.send(ackFrame(String(event.id), room.offset()));
  });
}

/**
 * Bytes by name (D18). A put is verified before it is stored, so junk cannot squat a hash; a
 * get answers with the bytes or `blob-missing`, which is a value the fetcher can act on —
 * anyone still holding them can put them back under the same name.
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
      const [stored, duration] = await timed(async () => room.blobs?.putAt(hash, frame.bytes));
      if (stored?.isErr() === true) refuse("blob-corrupt", stored.error.message);
      // a room with no blob store, or a put it refused, stored nothing and reports nothing
      else if (stored?.isOk() === true)
        room.report({ type: "relay.blob.put", sizes: { bytes: frame.bytes.byteLength }, duration });
      return;
    }
    const [found, duration] = await timed(async () => room.blobs?.get(hash));
    const bytes = found === undefined || found.isErr() ? undefined : found.value;
    if (bytes === undefined) sender.send(blobMissingFrame(frame.hash));
    else sender.send(blobFrame(frame.hash, bytes));
    room.report({ type: "relay.blob.get", sizes: { bytes: bytes?.byteLength ?? 0 }, duration });
  });
}
