import type { FrameLink } from "@syncmesh/transport";

import { TaggedError } from "@syncmesh/result";

import type { BleRadio } from "./radio.js";

import { base64ToBytes, bytesToBase64 } from "./base64.js";
import { fragment, reassembler, type ReassemblyOptions } from "./fragment.js";
import { payloadLimit } from "./radio.js";

/**
 * One peer's link, as whole frames.
 *
 * Which primitive carries a frame is decided by which end dialled, not by anything the caller
 * says: the dialler holds a connection and writes to the other's characteristic, and the dialled
 * end has no connection to write to, so it answers by setting its own characteristic's value and
 * letting the notification travel. That asymmetry is the whole of the difference between the two
 * halves of a BLE link, and it is why the send limit is read per direction rather than shared.
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
 */
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
  let queue: Promise<unknown> = Promise.resolve();
  let failure: unknown;

  /** One packet out, by whichever primitive this end owns. */
  const put = async (packet: Uint8Array): Promise<void> => {
    const value = bytesToBase64(packet);
    if (connectionId !== undefined) {
      // with response: the promise settling is the only evidence the packet left the radio, and
      // without-response would resolve on a queue rather than on the air
      await radio.write(connectionId, serviceUuid, characteristicUuid, value, "withResponse");
      return;
    }
    await radio.setCharacteristicValue(serviceUuid, characteristicUuid, value, true);
  };

  return {
    send: (frame) => {
      // a write that already failed makes every later one a lie: the link is down until it is
      // rebuilt, and saying so here is what stops the bridge queueing onto a dead radio
      if (failure !== undefined)
        throw new SendFailed({ peer, message: `the link to ${peer} is down`, cause: failure });
      const packets = fragment(frame, options.limit(), (message = (message + 1) >>> 0));
      if (packets.isErr())
        throw new SendFailed({ peer, message: packets.error.message, cause: packets.error });
      // serialised per link: a radio is one pipe, and letting two frames race their packets onto
      // it only invites the stack to reorder them under load
      queue = queue.then(async () => {
        for (const packet of packets.value) await put(packet);
      });
      void queue.then(undefined, (cause: unknown) => {
        if (failure !== undefined) return;
        failure = cause;
        options.onFailed?.(cause);
      });
    },
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
      const frame = rx.accept(decoded.value);
      if (frame === undefined) return;
      for (const listener of listeners) listener(frame);
    },
  };
}

export { payloadLimit };
