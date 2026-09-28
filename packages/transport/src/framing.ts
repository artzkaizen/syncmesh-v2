import type { Unsubscribe } from "@syncmesh/engine";

import type { FrameLink } from "./link.js";

/**
 * Frame boundaries over a medium that has none.
 *
 * TCP delivers a byte stream, and so does every peer-to-peer Wi-Fi data path: what one end wrote
 * as three frames may arrive as one read, or as seven. A four-byte big-endian length before each
 * frame is the whole protocol, and it lives here rather than in each platform module so there is
 * one place a length can be wrong.
 *
 * **The cap is not a tuning knob, it is the door.** A peer nobody has authenticated yet can
 * write four bytes saying four gigabytes follow, and a reader that believed it would allocate
 * for a stranger. Over the limit the link is closed rather than trimmed: a stream whose lengths
 * are not to be trusted has no next frame worth reading.
 */

/**
 * One open connection to one peer, in bytes: what a socket, a Wi-Fi Aware data path and an AWDL
 * link all are underneath. {@link framed} is what turns one into a {@link FrameLink}.
 *
 * `write` MUST throw when the bytes did not leave. A loud failure ends the link and the bridge
 * resyncs from its cursors; a silent one leaves two devices believing different things
 * (RFC-0005).
 *
 * **Nothing may be delivered before the first `onData`.** Accepting a connection and attaching a
 * reader cannot be one step, and the peer's hello is already on its way: a stream that dropped
 * what arrived in that gap would lose the handshake and then refuse everything that followed for
 * the life of the link. A real socket starts paused for exactly this reason; a stand-in must
 * hold what arrives until somebody is listening.
 */
export interface ByteStream {
  readonly write: (bytes: Uint8Array) => void;
  readonly onData: (cb: (bytes: Uint8Array) => void) => Unsubscribe;
  readonly onClose: (cb: () => void) => Unsubscribe;
  readonly close: () => void;
}

export const LENGTH_BYTES = 4;

/** Comfortably above a full page of events; far below what a stranger could ask a device to hold. */
export const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;

export interface FramingOptions {
  readonly maxFrameBytes?: number;
  /** A stream that broke its own protocol, for a log a person reads. The link is already closing. */
  readonly onDropped?: (why: string) => void;
}

export function framed(stream: ByteStream, options: FramingOptions = {}): FrameLink {
  const max = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const listeners = new Set<(frame: Uint8Array) => void>();
  /** What has arrived and not yet been read out as whole frames. */
  let held = new Uint8Array(0);
  let broken = false;

  const fail = (why: string): void => {
    broken = true;
    held = new Uint8Array(0);
    options.onDropped?.(why);
    stream.close();
  };

  stream.onData((bytes) => {
    if (broken) return;
    const joined = new Uint8Array(held.length + bytes.length);
    joined.set(held, 0);
    joined.set(bytes, held.length);
    held = joined;

    for (;;) {
      if (held.length < LENGTH_BYTES) return;
      const length = new DataView(held.buffer, held.byteOffset, held.byteLength).getUint32(0);
      if (length > max)
        return fail(`a peer announced a ${length}-byte frame; this link holds ${max}`);
      if (held.length < LENGTH_BYTES + length) return;
      // copied out, because the buffer it points into is about to be replaced
      const frame = held.slice(LENGTH_BYTES, LENGTH_BYTES + length);
      held = held.slice(LENGTH_BYTES + length);
      for (const cb of listeners) cb(frame);
    }
  });

  return {
    send: (frame) => {
      if (frame.length > max)
        throw new RangeError(`this frame is ${frame.length} bytes; the link holds ${max}`);
      const out = new Uint8Array(LENGTH_BYTES + frame.length);
      new DataView(out.buffer).setUint32(0, frame.length);
      out.set(frame, LENGTH_BYTES);
      stream.write(out); // throws when it did not leave, which is the rule this link inherits
    },
    onFrame: (cb) => {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    close: () => stream.close(),
  };
}
