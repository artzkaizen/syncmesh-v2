import type { RelaySocket, SendOutcome } from "@syncmesh/relay";

/** `WebSocket.OPEN`; the constant is named here so nothing in this package imports the platform. */
const OPEN = 1;

/** A close reason travels in the frame's 123-byte tail, and an over-long one throws instead of closing. */
const REASON_LIMIT = 120;

/**
 * The half of a hibernatable WebSocket a room touches. Structural for the reason the SQL handle
 * is: a package that imports the platform's types cannot be run anywhere the platform is not.
 *
 * The attachment is typed as the bytes this package actually stores in it — the socket's resume
 * script, which is what an evicted object needs to put the connection back (see `trackResume`).
 */
export interface DurableWebSocket {
  readonly readyState: number;
  readonly send: (data: ArrayBuffer | ArrayBufferView | string) => void;
  readonly close: (code?: number, reason?: string) => void;
  readonly serializeAttachment: (value: Uint8Array) => void;
  readonly deserializeAttachment: () => Uint8Array | null;
}

/**
 * A Durable Object's WebSocket as the room's send port.
 *
 * Never `buffered`: workerd owns the outgoing queue and closes a socket whose client cannot keep
 * up, which is D09's rule enforced one layer down — so there is no drain event to flush against
 * and the room's own backlog never fills. `dropped` is reserved for a socket that has already
 * gone, where the queued frames die with the connection at `leave`.
 */
export function durableRelaySocket(ws: DurableWebSocket): RelaySocket {
  return {
    send: (frame): SendOutcome => {
      if (ws.readyState !== OPEN) return "dropped";
      ws.send(frame);
      return "sent";
    },
    close: (reason) => ws.close(1000, reason?.slice(0, REASON_LIMIT)),
  };
}
