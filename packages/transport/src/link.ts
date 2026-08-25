import type { Unsubscribe } from "@syncmesh/engine";

/**
 * One connection to one peer (D12): whole frames in, whole frames out. A medium that streams
 * bytes reassembles them; a medium with an MTU fragments below this line. `send` MUST throw
 * when the frame did not leave — a loud failure is recoverable by resync, a silent one is
 * divergence. See RFC-0005.
 */
export interface FrameLink {
  readonly send: (frame: Uint8Array) => void;
  readonly onFrame: (cb: (frame: Uint8Array) => void) => Unsubscribe;
  readonly close?: () => void;
}

export interface LoopbackControl {
  /** Offline: `send` throws on both ends until set back. */
  readonly setOnline: (online: boolean) => void;
  /** The next `count` frames vanish in transit — sent successfully, never delivered. A radio. */
  readonly dropNext: (count?: number) => void;
  /** Frames still in flight settle. */
  readonly flush: () => Promise<void>;
}

export interface LoopbackPair {
  readonly a: FrameLink;
  readonly b: FrameLink;
  readonly control: LoopbackControl;
}

/** Two ends of an in-process radio: async delivery, an offline switch, injectable loss. */
export function loopbackPair(): LoopbackPair {
  let online = true;
  let dropping = 0;
  let inFlight: Promise<void> = Promise.resolve();
  const listeners = {
    a: new Set<(f: Uint8Array) => void>(),
    b: new Set<(f: Uint8Array) => void>(),
  };

  const end = (mine: "a" | "b", theirs: "a" | "b"): FrameLink => ({
    send: (frame) => {
      if (!online) throw new Error(`loopback ${mine}: offline — the frame did not leave`);
      if (dropping > 0) {
        dropping -= 1;
        return;
      }
      const bytes = Uint8Array.from(frame);
      inFlight = inFlight.then(() => {
        for (const cb of listeners[theirs]) cb(bytes);
      });
    },
    onFrame: (cb) => {
      listeners[mine].add(cb);
      return () => void listeners[mine].delete(cb);
    },
    close: () => void (online = false),
  });

  return {
    a: end("a", "b"),
    b: end("b", "a"),
    control: {
      setOnline: (next) => void (online = next),
      dropNext: (count = 1) => void (dropping = count),
      flush: async () => {
        await inFlight;
      },
    },
  };
}
