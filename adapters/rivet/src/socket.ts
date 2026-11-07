import type { RelaySocket, SendOutcome } from "@syncmesh/relay";

/** `WebSocket.OPEN`; named here so nothing in this package imports the platform. */
const OPEN = 1;

/** A close reason travels in the frame's 123-byte tail, and an over-long one throws instead of closing. */
const REASON_LIMIT = 120;

/** What a message event carries with `binaryType = "arraybuffer"`: bytes, or text. */
export type RivetMessageData = string | ArrayBuffer | Uint8Array;

/**
 * The half of the raw WebSocket Rivet hands `onWebSocket` that a room touches — the standard
 * `WebSocket` shape, structural for the reason the database handle is.
 */
export interface RivetWebSocket {
  readonly readyState: number;
  binaryType?: string;
  readonly send: (data: Uint8Array) => void;
  readonly close: (code?: number, reason?: string) => void;
  readonly addEventListener: (
    type: "message" | "close",
    listener: (event: { readonly data?: RivetMessageData }) => void,
  ) => void;
}

/**
 * The actor's WebSocket as the room's send port. Never `buffered`: the actor runtime owns the
 * outgoing queue, so there is no drain to flush against; `dropped` is a socket already gone.
 */
export function rivetRelaySocket(ws: RivetWebSocket): RelaySocket {
  return {
    send: (frame): SendOutcome => {
      if (ws.readyState !== OPEN) return "dropped";
      ws.send(frame);
      return "sent";
    },
    close: (reason) => ws.close(1000, reason?.slice(0, REASON_LIMIT)),
  };
}

/** One message's bytes, or `undefined` for a text frame — the protocol is binary, and text is noise. */
export const bytesIn = (data: RivetMessageData | undefined): Uint8Array | undefined => {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return undefined;
};
