import type { Interest } from "@syncmesh/engine";
import type { PeerId } from "@syncmesh/kernel";
import type { RelayDial } from "@syncmesh/relay";
import type { Transport } from "@syncmesh/transport";

import { relayTransport, webSocketDial } from "@syncmesh/relay";
import { TaggedError } from "@syncmesh/result";

/**
 * WebSockets, both directions, as one adapter (book ch. 16, ch. 30).
 *
 * **One export and not two.** Dialling out and accepting are the two ends of one protocol, and
 * splitting them into `webSocket()` and `webSocketListener()` would be the only place in this
 * system where a medium's two roles are two imports — `ble()` runs both at once and decides
 * which carries a link from `shouldDial`, not from which function the app reached for. libp2p
 * makes the same call: `@libp2p/websockets` has `dial` and `createListener` on one transport,
 * and the runtime that cannot do a half throws from that half.
 *
 * `bootstrap` is what decides the role: addresses to dial, or none and this process is the one
 * being dialled. A server is the second case and reaches it through `createServer`, which is why
 * there is nothing here for it to construct.
 */

/** This runtime cannot accept connections, so a transport with no `bootstrap` has no role here. */
export class CannotListen extends TaggedError("CannotListen")<{
  adapter: string;
  message: string;
}> {}

export interface WebSocketOptions {
  /** The room this device is joining; a relay serves one per path. */
  readonly id: string;
  /**
   * Where to dial. Absent means **accept**: this process is the one being connected to, which is
   * a server, and a server builds its side with `createServer` rather than here.
   */
  readonly bootstrap?: readonly string[];
  readonly name?: string;
  /** First reconnect delay; doubles per failure up to `maxReconnectMs`. Default 500. */
  readonly reconnectMs?: number;
  readonly maxReconnectMs?: number;
  /** What this device wants from the room. It narrows: a relay applies it after the read policy. */
  readonly interest?: Interest;
  /** How near this source is (RFC-0019); a relay sits between local storage and a radio. Default 1. */
  readonly priority?: number;
  /** The relay's own key, when this device should accept a hello from no other (D36). */
  readonly relayKey?: PeerId;
}

/**
 * Dials the first address that answers, then the next on every reconnect.
 *
 * A list rather than one address because a room usually has more than one way in, and a client
 * that pinned the first would ride one relay's outage all the way down. Rotating on reconnect
 * costs nothing — the session resumes from cursors wherever it lands.
 */
const dialing = (bootstrap: readonly string[]): (() => Promise<RelayDial> | RelayDial) => {
  let at = 0;
  return () => {
    const url = bootstrap[at % bootstrap.length] ?? bootstrap[0];
    at += 1;
    if (url === undefined) throw new RangeError("webSocket: bootstrap is empty");
    return webSocketDial(url)();
  };
};

export function webSocket(options: WebSocketOptions): Transport {
  const bootstrap = options.bootstrap ?? [];
  // outside anything async: a device with nowhere to dial and no way to listen is a wiring
  // mistake, and saying so here beats a source that is quietly never online
  if (bootstrap.length === 0)
    throw new CannotListen({
      adapter: "webSocket",
      message:
        "webSocket() with no `bootstrap` is the accepting side, which a server builds with createServer()",
    });

  return relayTransport({
    name: options.name ?? `ws:${options.id}`,
    dial: dialing(bootstrap),
    ...(options.reconnectMs !== undefined && { reconnectMs: options.reconnectMs }),
    ...(options.maxReconnectMs !== undefined && { maxReconnectMs: options.maxReconnectMs }),
    ...(options.interest !== undefined && { interest: options.interest }),
    ...(options.priority !== undefined && { priority: options.priority }),
    ...(options.relayKey !== undefined && { relayKey: options.relayKey }),
  });
}
