import type { Interest, Unsubscribe } from "@syncmesh/engine";
import type { PeerId } from "@syncmesh/kernel";
import type { Transport } from "@syncmesh/transport";

import { RelayLink } from "./relay-link.js";

/**
 * One dialed connection to a relay: whole frames both ways, a close signal, and a `send`
 * that MUST throw when the frame did not leave (RFC-0005's rule; reconnect recovers).
 */
export interface RelayDial {
  readonly send: (frame: Uint8Array) => void;
  readonly onFrame: (cb: (frame: Uint8Array) => void) => Unsubscribe;
  readonly onClose: (cb: () => void) => Unsubscribe;
  readonly close: () => void;
}

export interface RelayTransportOptions {
  /**
   * The link's name, `"relay"` by default. `$recovery` raises a relay's `retention` issue under it
   * (gaps U30), so two relay transports on one mesh need different names: under the same one, the
   * room that serves one link clears the issue the other link's room raised.
   */
  readonly name?: string;
  readonly dial: () => Promise<RelayDial> | RelayDial;
  readonly versions?: readonly number[];
  /** First reconnect delay; doubles per failure up to `maxReconnectMs`. Default 500. */
  readonly reconnectMs?: number;
  readonly maxReconnectMs?: number;
  /** Milliseconds before `whenReady` force-resolves so a dead relay never wedges the mesh. Default 1000. */
  readonly forceReadyAfter?: number;
  /**
   * What this device wants from the room. It narrows: a relay applies it after the read
   * policy, so an interest can make a device see less and never more. A device holding a grant
   * joins with this cut to the grant's partitions (D40), which is what a gated room serves it.
   */
  readonly interest?: Interest;
  /** How near this source is (RFC-0019); a relay sits between local storage and a radio. Default 1. */
  readonly priority?: number;
  /**
   * The room's own key (D36): the one peer id this device accepts a link hello from. A hello
   * signed by any other key is a permanent refusal, like a version the relay will not speak —
   * a relay that changed keys is a relay somebody has to look at, not one to keep redialling.
   * Absent, any well-signed hello opens the link and `wss://` is what stands between this device
   * and a machine in the middle; `RunningRelay.peerId` is what a host hands out to be pinned.
   */
  readonly relayKey?: PeerId;
}

/**
 * The client half of the relay protocol: join with our contiguous cursors, apply pages in order,
 * push what the relay lacks only after the last page, hold a liveness deadline of 2.5× the
 * relay's keepalive re-armed on every frame (a hello-less relay arms nothing), and reconnect
 * with backoff. A version refusal is permanent — no reconnect loop against a relay that
 * already said no. Declares `blobs`, `visibility` and `durable` (D42): the last settles only on a
 * room whose hello says its log outlives the process.
 */
export function relayTransport(options: RelayTransportOptions): Transport {
  const link = new RelayLink(options);
  return {
    name: link.name,
    kind: "websocket",
    delivers: () => link.delivers(),
    wake: () => link.wake(),
    condition: link.report.condition,
    onLinkEvent: link.report.onLinkEvent,
    priority: options.priority ?? 1,
    sendPresence: (wire) => link.sendPresence(wire),
    blobs: link.blobChannel.capability,
    visibility: link.visibility.capability,
    durable: link.durability.durable,
    start: (context) => link.start(context),
    whenReady: () => link.whenReady(),
    caughtUp: () => link.caughtUp(),
    resync: () => link.join(),
    requestGrant: (invite) => link.requestGrant(invite),
    onStatus: link.status.subscribe,
    stop: () => link.stop(),
  };
}
