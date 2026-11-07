import type { Result as ResultType } from "@syncmesh/result";
import type { Unsubscribe } from "@syncmesh/transport";

import { Result } from "@syncmesh/result";

import type { LanAddress, LanNetwork } from "./network.js";

import { createNativePaths } from "../native-paths.js";
import { DEFAULT_GROUP, LanUnsupported } from "./network.js";

/**
 * A React Native networking module, as a {@link LanNetwork}.
 *
 * The sibling of `adapters/lan-node`, and the same port — which is the point: a phone and a
 * laptop on one Wi-Fi network are peers on the *same* transport, so the relay running under Node
 * and the app running on a handset find each other with no relay in the middle and no change
 * above this line.
 *
 * **This is the cross-platform fast path, and the only one there is.** AWDL is Apple-to-Apple;
 * Wi-Fi Aware has never been shown to move a byte between an iPhone and an Android phone. An
 * ordinary Wi-Fi network is the one place where a mixed room actually meets — which is also why
 * it is worth having despite needing infrastructure the other two do not.
 *
 * The native module is never imported here. `adapters/react-native` is the one place that is
 * allowed to reach for it, and this file states exactly what it must present (D01-B).
 */

/** What `remove()` comes back on; an Expo subscription rather than a bare function. */
export interface RnLanSubscription {
  readonly remove: () => void;
}

/** An announcement off the multicast group, with where it came from. */
export interface RnLanAnnouncement {
  readonly bytes: Uint8Array;
  readonly host: string;
  readonly port: number;
}

/** A peer dialled us. `path` is the handle every later call about the socket names. */
export interface RnLanConnection {
  readonly path: string;
  readonly host: string;
  readonly port: number;
}

export interface RnLanData {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface RnLanClosed {
  readonly path: string;
}

/**
 * Exactly what this adapter touches.
 *
 * Two halves, because a LAN has two: a datagram socket joined to a multicast group for
 * announcements, which are cheap and lossy and repeat; and a TCP listener plus dialler for
 * frames, which must be ordered and lossless or a dropped frame becomes divergence rather than a
 * resync.
 */
export interface RnLanManager {
  /** Whether this build has the sockets at all. */
  readonly supports: () => boolean;
  /**
   * Joins the group and starts listening for streams. Resolves the port the listener actually got
   * — asked for zero, because a fixed port is a second app on this phone failing to start.
   */
  readonly start: (group: string, groupPort: number) => Promise<number>;
  readonly announce: (bytes: Uint8Array) => void;
  readonly dial: (host: string, port: number) => Promise<string>;
  readonly send: (path: string, bytes: Uint8Array) => Promise<void>;
  readonly resume: (path: string) => void;
  readonly closePath: (path: string) => void;
  readonly stop: () => Promise<void>;
  readonly addListener: (event: string, cb: (payload: never) => void) => RnLanSubscription;
}

export interface RnLanOptions {
  /** The multicast group announcements go to. Defaults to the transport's own. */
  readonly group?: LanAddress;
  /** An announcement or a socket that went nowhere, for a log a person reads on a device. */
  readonly onDropped?: (why: string) => void;
}

/** A network, plus the ending `LanNetwork` has no room for: letting go of the module. */
export interface BoundLan {
  readonly network: LanNetwork;
  /** Detaches from the module for good. `close()` stops the sockets; this stops listening to it. */
  readonly dispose: () => void;
}

/* oxlint-disable anti-slop/no-unknown-parameters -- an event payload arrives from a native module as whatever it sent; naming the event is the parse, and the shapes above are the contract the module is written against */
const listen = <T>(manager: RnLanManager, event: string, cb: (payload: T) => void): Unsubscribe => {
  // SAFETY: the listener is invoked with this event's payload, which the shapes above name per
  // event; the module is written against them and the adapter binds the two together
  const held = manager.addListener(event, cb as (payload: never) => void);
  return () => held.remove();
};
/* oxlint-enable anti-slop/no-unknown-parameters */

/**
 * The network, or the reason this build has none.
 *
 * Refused here rather than discovered later: a phone with no datagram socket announces nothing,
 * hears nobody, and reports itself perfectly healthy — the same quiet failure every other medium
 * in this package is written to refuse up front.
 */
export function lanFrom(
  manager: RnLanManager,
  options: RnLanOptions = {},
): ResultType<BoundLan, LanUnsupported> {
  if (!manager.supports())
    return Result.err(
      new LanUnsupported({ adapter: "lan", message: "this build has no networking module" }),
    );

  const group = options.group ?? DEFAULT_GROUP;
  const drop = (why: string): void => options.onDropped?.(why);
  const paths = createNativePaths(manager);
  let listening = 0;

  listen<RnLanData>(manager, "onLanData", (event) => {
    const held = paths.get(event.path);
    if (held !== undefined) return held.accept(event.bytes);
    const waiting = paths.early(event.path);
    if (waiting === undefined) return drop(`bytes for a socket nobody opened: ${event.path}`);
    waiting.chunks.push(Uint8Array.from(event.bytes));
  });
  const offClosed = listen<RnLanClosed>(manager, "onLanClosed", (event) => {
    if (paths.has(event.path)) return paths.forget(event.path);
    const waiting = paths.early(event.path);
    if (waiting !== undefined) waiting.closed = true;
  });

  const network: LanNetwork = {
    /**
     * Silent until the listener has a port.
     *
     * The transport builds each announcement from `address().port`, and an announcement carrying
     * zero tells every peer in the room to dial nowhere — worse than saying nothing, because a
     * sighting is recorded and a dial is spent against it. Announcements repeat, so one skipped
     * beat costs a beat; the next one carries the real port.
     */
    announce: (bytes) => {
      if (listening === 0) return drop("an announcement was held back: no port yet");
      manager.announce(bytes);
    },
    onAnnouncement: (cb) =>
      listen<RnLanAnnouncement>(manager, "onAnnouncement", (heard) =>
        cb(heard.bytes, { host: heard.host, port: heard.port }),
      ),
    /**
     * Where peers should dial this device.
     *
     * The host is deliberately empty: a phone's address on the network is the network's business,
     * and a device with two interfaces up would have to pick one wrongly. What an announcement
     * needs is the **port** — the receiver already knows which address the datagram came from,
     * which is the one that can actually be dialled back.
     */
    address: () => ({ host: "", port: listening }),
    dial: async (to) => {
      paths.beginDial();
      try {
        return paths.open(await manager.dial(to.host, to.port)).stream;
      } finally {
        paths.endDial();
      }
    },
    onConnection: (cb) =>
      listen<RnLanConnection>(manager, "onLanConnection", (arrived) => {
        cb(paths.open(arrived.path).stream);
      }),
    close: async () => {
      paths.reset();
      listening = 0;
      await manager.stop();
    },
  };

  /**
   * Started eagerly, because `LanNetwork` has no `open` — the transport calls `address()` and
   * expects a port. The promise is held so the first `announce` or `dial` after it settles finds
   * a socket that is actually up.
   */
  const started = manager
    .start(group.host, group.port)
    .then((port) => void (listening = port))
    .catch((cause: unknown) => drop(`the lan sockets would not start: ${String(cause)}`));

  return Result.ok({
    dispose: () => {
      offClosed();
      paths.reset();
      void started;
    },
    network,
  });
}
