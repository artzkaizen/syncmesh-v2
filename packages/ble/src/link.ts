import type { FrameLink } from "@syncmesh/transport";

import { TaggedError } from "@syncmesh/result";
import { randomBytes } from "@syncmesh/wire";

import type { BleRadio } from "./radio.js";

import { base64ToBytes, bytesToBase64 } from "./base64.js";
import { fragment, reassembler, type ReassemblyOptions } from "./fragment.js";

/**
 * One peer's link, as whole frames.
 *
 * Which primitive carries a frame is decided by which end dialled, not by anything the caller
 * says: the dialler holds a connection and writes to the other's characteristic, and the dialled
 * end has no connection to write to, so it answers by setting its own characteristic's value and
 * letting the notification travel. That asymmetry is the whole of the difference between the two
 * halves of a BLE link, and it is why the send limit is read per direction rather than shared.
 *
 * **A notification is not addressed, so every packet carries the link it belongs to.** A
 * peripheral notifies every central subscribed to its characteristic at once — CoreBluetooth's
 * `updateValue(…, onSubscribedCentrals: nil)`, and the only primitive {@link BleRadio} offers —
 * so a device dialled by two neighbours puts each one's frames in front of both. Filed under the
 * one link a central holds to that peripheral, its hello to the other neighbour read as the peer
 * re-keying, the live session was replaced by one nobody held the secret for, and the pair never
 * read each other again (the chaos soak's seeds 4 and 18, `link.test.ts`). The dialler picks a
 * random tag per connection and puts it ahead of every packet it writes; the dialled end answers
 * under the newest tag it heard; a dialler drops a notification under any tag but its own.
 */

export class SendFailed extends TaggedError("SendFailed")<{
  peer: string;
  message: string;
  cause: unknown;
}> {}

export interface LinkOptions extends ReassemblyOptions {
  /** Only the three a link uses: what it writes with, what it notifies with, and how it hangs up. */
  readonly radio: Pick<BleRadio, "write" | "setCharacteristicValue" | "disconnect">;
  readonly serviceUuid: string;
  readonly characteristicUuid: string;
  /** The peer this link is to, for error messages a person has to read. */
  readonly peer: string;
  /**
   * The dialler's connection, absent on the dialled side. Its presence *is* the role: a link
   * with one writes, a link without one notifies.
   */
  readonly connectionId?: string | undefined;
  /** What this direction may put in a packet; re-read on every send, since it can be renegotiated. */
  readonly limit: () => number;
  /**
   * The dialler's tag for this connection, a `u32`; random when absent. The dialled end ignores
   * it and answers under whatever tag its peer writes with.
   */
  readonly tag?: number | undefined;
  /** Reported rather than thrown: a frame that never completes is a gap anti-entropy closes. */
  readonly onDropped?: (why: string) => void;
  /**
   * A write did not leave. The link is finished — the transport tears it down and re-dials, and
   * the bridge resyncs from its cursors, which is the recovery every other loud failure uses.
   */
  readonly onFailed?: (cause: unknown) => void;
}

/**
 * `FrameLink` over one BLE peer.
 *
 * **`send` throws when the frame did not leave**, which is the contract the bridge is built on:
 * a loud failure is recoverable by resync, a silent one is divergence. There is no
 * acknowledgement above the radio's own — a frame whose fragments do not all arrive is never
 * delivered, so nothing folds it, the receiver's cursor does not move, and the ordinary
 * anti-entropy exchange asks for the events again.
 *
 * **`sendLatest` is what keeps a 60 Hz cursor from becoming a backlog.** A radio that falls behind
 * holds one frame per slot — the newest — and puts every ordinary frame on the air ahead of it,
 * so an ephemeral value is what yields on a busy link and an event never waits behind a queue of
 * dead ones (D16). Memory is bounded by the slots in use, however fast values are set.
 */
/** `[u32 link tag]` ahead of every fragment, big-endian. */
export const LINK_TAG_BYTES = 4;

/** A fresh tag for a dialled connection. */
const randomTag = (): number =>
  new DataView(randomBytes(LINK_TAG_BYTES).buffer).getUint32(0, false);

/** `packet` behind `tag`: what goes on the air. */
const tagged = (tag: number, packet: Uint8Array): Uint8Array => {
  const out = new Uint8Array(LINK_TAG_BYTES + packet.length);
  new DataView(out.buffer).setUint32(0, tag, false);
  out.set(packet, LINK_TAG_BYTES);
  return out;
};

/** The tag a packet off the air was sent under, or `undefined` when it is too short to carry one. */
const tagOf = (packet: Uint8Array): number | undefined =>
  packet.length < LINK_TAG_BYTES
    ? undefined
    : new DataView(packet.buffer, packet.byteOffset, LINK_TAG_BYTES).getUint32(0, false);

export function bleLink(options: LinkOptions): FrameLink & {
  readonly accept: (valueBase64: string) => void;
} {
  const { radio, serviceUuid, characteristicUuid, peer, connectionId } = options;
  const listeners = new Set<(frame: Uint8Array) => void>();
  const bounds: ReassemblyOptions = {
    onAbandoned: (id, held, why) => options.onDropped?.(`message ${id} (${held} bytes) ${why}`),
  };
  if (options.maxMessageBytes !== undefined)
    Object.assign(bounds, { maxMessageBytes: options.maxMessageBytes });
  if (options.maxAssemblies !== undefined)
    Object.assign(bounds, { maxAssemblies: options.maxAssemblies });
  const rx = reassembler(bounds);
  let message = 0;
  /** Frames not yet on the air: every ordinary one in order, and the newest per slot. */
  const ordinary: (readonly Uint8Array[])[] = [];
  const latest = new Map<string, readonly Uint8Array[]>();
  let pumping = false;
  let failure: unknown;
  /**
   * The tag this link's packets travel under: chosen here by the dialler, learned from the first
   * write by the dialled end, which holds what it has to send until then — a notification under
   * no tag is one no central would take.
   */
  let tag = connectionId === undefined ? undefined : (options.tag ?? randomTag());

  /** One packet out, by whichever primitive this end owns. */
  const put = async (packet: Uint8Array, under: number): Promise<void> => {
    const value = bytesToBase64(tagged(under, packet));
    if (connectionId !== undefined) {
      // with response: the promise settling is the only evidence the packet left the radio, and
      // without-response would resolve on a queue rather than on the air
      await radio.write(connectionId, serviceUuid, characteristicUuid, value, "withResponse");
      return;
    }
    await radio.setCharacteristicValue(serviceUuid, characteristicUuid, value, true);
  };

  /** The next frame to put on the air: ordinary ones first, then the oldest slot still held. */
  const next = (): readonly Uint8Array[] | undefined => {
    const first = ordinary.shift();
    if (first !== undefined) return first;
    for (const [slot, packets] of latest) {
      latest.delete(slot);
      return packets;
    }
    return undefined;
  };

  // serialised per link: a radio is one pipe, and letting two frames race their packets onto it
  // only invites the stack to reorder them under load
  // `pumping` is cleared in the same synchronous step that finds the queues empty, so a frame
  // enqueued at any later moment either sees the flag down and starts a pump, or is found by this one
  const pump = async (under: number): Promise<void> => {
    try {
      for (let packets = next(); packets !== undefined; packets = next())
        for (const packet of packets) await put(packet, tag ?? under);
    } catch (cause) {
      fail(cause);
    } finally {
      pumping = false;
    }
  };

  const fail = (cause: unknown): void => {
    if (failure !== undefined) return;
    failure = cause;
    ordinary.length = 0;
    latest.clear();
    options.onFailed?.(cause);
  };

  /** Fragments one frame and hands it to `hold`, then makes sure the pump is running. */
  const enqueue = (frame: Uint8Array, hold: (packets: readonly Uint8Array[]) => void): void => {
    // a write that already failed makes every later one a lie: the link is down until it is
    // rebuilt, and saying so here is what stops the bridge queueing onto a dead radio
    if (failure !== undefined)
      throw new SendFailed({ peer, message: `the link to ${peer} is down`, cause: failure });
    const packets = fragment(
      frame,
      options.limit() - LINK_TAG_BYTES,
      (message = (message + 1) >>> 0),
    );
    if (packets.isErr())
      throw new SendFailed({ peer, message: packets.error.message, cause: packets.error });
    hold(packets.value);
    start();
  };

  /** Runs the pump, unless it is running or this end has no tag to send under yet. */
  const start = (): void => {
    if (pumping || tag === undefined) return;
    pumping = true;
    void pump(tag);
  };

  return {
    send: (frame) => enqueue(frame, (packets) => void ordinary.push(packets)),
    // a newer value for a slot takes the older one's place in line, so a slot is held at most once
    sendLatest: (slot, frame) => enqueue(frame, (packets) => void latest.set(slot, packets)),
    onFrame: (cb) => {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    close: () => {
      listeners.clear();
      if (connectionId !== undefined) void radio.disconnect(connectionId).catch(() => undefined);
    },
    /** A packet in from the radio, whichever way it arrived. */
    accept: (valueBase64) => {
      const decoded = base64ToBytes(valueBase64);
      if (decoded.isErr()) {
        options.onDropped?.(`a packet from ${peer} was not base64`);
        return;
      }
      const under = tagOf(decoded.value);
      if (under === undefined) {
        options.onDropped?.(`a packet from ${peer} was too short to name its link`);
        return;
      }
      if (connectionId === undefined) {
        // the dialled end answers under the newest tag its peer wrote with: a central that
        // reconnected is on a new connection, and the old tag's notifications would go unread
        const first = tag === undefined;
        tag = under;
        if (first) start();
      }
      // another central's notification from the same peripheral: addressed to it, not lost here
      else if (under !== tag) return;
      const frame = rx.accept(decoded.value.subarray(LINK_TAG_BYTES));
      if (frame === undefined) return;
      for (const listener of listeners) listener(frame);
    },
  };
}
