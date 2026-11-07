import type { Result as ResultType } from "@syncmesh/result";
import type { Unsubscribe } from "@syncmesh/transport";

import { Result } from "@syncmesh/result";

import type { P2pFabric, P2pProtocol } from "./fabric.js";

import { createNativePaths } from "../native-paths.js";
import { P2pUnsupported } from "./fabric.js";

/**
 * A React Native peer-to-peer Wi-Fi module, as a {@link P2pFabric}.
 *
 * The native module is **never imported here**. What this file holds is a structural description
 * of the surface it must present — exactly as `@syncmesh/ble`'s `rn-ble.ts` does — which is what
 * keeps `packages/*` runtime-neutral (D01-B) and lets every line below be tested with no device,
 * no simulator and no permissions dialog. `adapters/react-native` is the one place that reaches
 * for the real thing.
 *
 * **One module, two radios.** AWDL and Wi-Fi Aware are different radios with the same shape, and
 * a device may have either, both or neither — so every call names its protocol and **every event
 * carries the protocol it came from**, without exception. An event that did not would be routed
 * by handle alone, and two fabrics over one module would each see the other's traffic: the one
 * that did not own the handle would buffer every byte of it for as long as the process lived.
 */

/** What a subscription looks like coming back from an Expo module; `remove`, not a function. */
export interface RnP2pSubscription {
  readonly remove: () => void;
}

/** Every event names its radio. See the note above for why there is no exception. */
interface OnRadio {
  readonly protocol: string;
}

/** A peer the platform is reporting, before it is anything this package believes. */
export interface RnP2pFound extends OnRadio {
  readonly id: string;
  readonly announces: Uint8Array;
}

export interface RnP2pLost extends OnRadio {
  readonly id: string;
}

/**
 * A peer opened a path to us. `path` is the handle every later call about it names.
 *
 * **`from` must be the same id `onPeerFound` reported**, not a second identifier for the same
 * device. The transport keys a link by it and closes that link when the peer is lost, so an
 * inbound path named differently from the peer it belongs to is one that survives its own peer
 * going out of range — held open, counted against the radio's link budget, reaching nobody.
 *
 * That correlation is the module's to make and it is not free: a Bonjour listener is handed a
 * connection from a link-local address with no back-reference to the instance that advertised
 * it, so the module has to carry an identity in-band to answer this.
 */
export interface RnP2pPath extends OnRadio {
  readonly path: string;
  readonly from: string;
}

export interface RnP2pData extends OnRadio {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface RnP2pClosed extends OnRadio {
  readonly path: string;
}

/**
 * Exactly what this adapter touches, and nothing else.
 *
 * Bytes cross as `Uint8Array` rather than base64. `@syncmesh/ble` pays for base64 in both
 * directions because its native module presents `Data` that way, and says in its own words that
 * the file doing it "is what disappears" the day a module hands over bytes directly. This is that
 * day: a new module has no legacy to keep, and a data path moves two orders of magnitude more
 * than a BLE link. The cost is that a chunk may be a view into a buffer the module reuses, which
 * is why `rn-path.ts` copies on arrival rather than trusting the reference.
 */
export interface RnP2pManager {
  /** Whether this device can speak a protocol at all — hardware, OS version and entitlement. */
  readonly supports: (protocol: string) => boolean;
  readonly publish: (protocol: string, service: string, announces: Uint8Array) => Promise<void>;
  /** Resolves the handle of the path that opened, and rejects when the platform would not open one. */
  readonly connect: (protocol: string, peer: string) => Promise<string>;
  /** Resolves once the bytes left the radio. A rejection is what makes a write loud. */
  readonly send: (path: string, bytes: Uint8Array) => Promise<void>;
  /** Lets a path's held bytes through; see `PathIo.resume` in `./rn-path.ts` for why it is explicit. */
  readonly resume: (path: string) => void;
  readonly closePath: (path: string) => void;
  /**
   * Presents the platform's own pairing UI, where the platform has one.
   *
   * Wi-Fi Aware on iOS only connects to **paired** devices, and pairing is a two-sided,
   * user-driven ceremony the app cannot perform on anyone's behalf — so `onPeerFound` there means
   * *a device you already paired with is in range*, where on AWDL it means *a stranger is nearby*.
   * The two words are the same and the facts are not, which is why this exists separately from
   * `publish` and why a caller must put it behind a deliberate affordance.
   */
  readonly pair?: (protocol: string) => Promise<void>;
  readonly stop: (protocol: string) => Promise<void>;
  readonly addListener: (event: string, cb: (payload: never) => void) => RnP2pSubscription;
}

export interface FabricOptions {
  /**
   * An event this fabric could not place, for a log a person reads on a device.
   *
   * The failure it exists for is the quietest one here: a module that forgets `protocol` on one
   * event has every fabric discard it, the transport reports `ok`, and the mesh is a room where
   * nobody finds anybody. Noise is evidence — an event naming a radio this build has never heard
   * of is a bug in the module, and it should say so rather than vanish.
   */
  readonly onDropped?: (why: string) => void;
}

/** A fabric, plus the one ending `P2pFabric` has no room for: letting go of the module. */
export interface BoundFabric {
  readonly fabric: P2pFabric;
  /**
   * Detaches from the module for good — **not** what `stop()` does.
   *
   * `Transport.close()` calls `stop()`, and a restart runs the transport's `open` again over the
   * same fabric, so `stop` must leave the routing attached or a restarted transport would publish
   * a service, open paths, and never hear a byte. This is the other ending: the fabric is done,
   * and without it the routing closures — each holding a map — stay pinned to the module for the
   * life of the process, once per fabric anybody ever built.
   */
  readonly dispose: () => void;
}

/* oxlint-disable anti-slop/no-unknown-parameters -- an event payload arrives from a native module as whatever it sent; naming the event is the parse, and the shapes above are the contract the module is written against */
const listen = <T>(manager: RnP2pManager, event: string, cb: (payload: T) => void): Unsubscribe => {
  // SAFETY: the listener is invoked with this event's payload, which the shapes above name per
  // event; the module is written against them and the adapter binds the two together
  const held = manager.addListener(event, cb as (payload: never) => void);
  return () => held.remove();
};
/* oxlint-enable anti-slop/no-unknown-parameters */

export function fabricFrom(
  manager: RnP2pManager,
  protocol: P2pProtocol,
  options: FabricOptions = {},
): ResultType<BoundFabric, P2pUnsupported> {
  if (!manager.supports(protocol))
    return Result.err(
      new P2pUnsupported({ adapter: protocol, message: `this device cannot speak ${protocol}` }),
    );

  const drop = (why: string): void => options.onDropped?.(why);
  /**
   * Every open path, early bytes included — see `native-paths.ts` for the gap this
   * covers: `connect` learns a handle when its promise settles, while the platform
   * starts reporting that path the moment it opens.
   */
  const paths = createNativePaths(manager);

  const mine = (event: string, from: string): boolean => {
    if (from === protocol) return true;
    if (from !== "awdl" && from !== "wifi-aware")
      drop(`${event} named a radio this build does not know: ${from === "" ? "nothing" : from}`);
    return false;
  };

  /**
   * Data and path-closed are subscribed **once for the fabric**, not once per path.
   *
   * A module that emits per-path events onto one channel and a subscriber per path is a
   * subscriber count that grows with the mesh and a dispatch quadratic in it. `paths` is the
   * router, and it costs one lookup.
   */
  const offData = listen<RnP2pData>(manager, "onPathData", (event) => {
    if (!mine("onPathData", event.protocol)) return;
    const held = paths.get(event.path);
    if (held !== undefined) return held.accept(event.bytes);
    const waiting = paths.early(event.path);
    if (waiting === undefined) return drop(`bytes for a path nobody opened: ${event.path}`);
    waiting.chunks.push(Uint8Array.from(event.bytes));
  });
  const offClosed = listen<RnP2pClosed>(manager, "onPathClosed", (event) => {
    if (!mine("onPathClosed", event.protocol)) return;
    if (paths.has(event.path)) return paths.forget(event.path);
    const waiting = paths.early(event.path);
    if (waiting !== undefined) waiting.closed = true;
  });

  const fabric: P2pFabric = {
    protocol,
    publish: (service, announces) => manager.publish(protocol, service, announces),
    onPeerFound: (cb) =>
      listen<RnP2pFound>(manager, "onPeerFound", (found) => {
        if (mine("onPeerFound", found.protocol)) cb({ announces: found.announces, id: found.id });
      }),
    onPeerLost: (cb) =>
      listen<RnP2pLost>(manager, "onPeerLost", (lost) => {
        if (mine("onPeerLost", lost.protocol)) cb(lost.id);
      }),
    connect: async (id) => {
      paths.beginDial();
      try {
        return paths.open(await manager.connect(protocol, id)).stream;
      } finally {
        paths.endDial();
      }
    },
    onPath: (cb) =>
      listen<RnP2pPath>(manager, "onPath", (arrived) => {
        if (!mine("onPath", arrived.protocol)) return;
        cb(paths.open(arrived.path).stream, arrived.from);
      }),
    /**
     * Stops the radio and ends every path **at the platform**, without deafening the fabric — see
     * {@link BoundFabric.dispose} for the other ending, and why they are two.
     */
    stop: async () => {
      paths.reset();
      await manager.stop(protocol);
    },
  };

  return Result.ok({
    dispose: () => {
      offData();
      offClosed();
      paths.reset();
    },
    fabric,
  });
}
