import type { BoundFabric, P2pProtocol, RnP2pManager } from "@syncmesh/transports";

import { fabricFrom } from "@syncmesh/transports";
import { requireOptionalNativeModule } from "expo";

/**
 * Peer-to-peer Wi-Fi from the platform, if this build has it.
 *
 * The sibling of `./ble.ts`, and the same seam: `@syncmesh/transports` states exactly what the
 * mesh touches and knows nothing about React Native; this file is the one place that reaches for
 * a native module. What is different is that there are **two radios behind one module** — AWDL
 * and Wi-Fi Aware — and a device may have either, both or neither, so the protocol is asked for
 * rather than assumed.
 *
 * Nothing app-specific lives here. A room name is the app's, exactly as a service uuid is in
 * `./ble.ts`: a library that shipped one would be deciding which strangers' phones talk to which.
 */

/** Why there is no fabric, when there is none. Each sends a person somewhere different. */
export type NoFabric =
  /** The native module was never compiled into this build — Expo Go, or a bare app. */
  | "not-in-this-build"
  /** This build said no, before the platform was asked anything. */
  | "switched-off-in-config"
  /**
   * The module is here and this radio is not: no hardware, an OS below the floor, or an
   * entitlement this build does not carry. Wi-Fi Aware needs iPhone 12 and iOS 26; AWDL does not.
   */
  | "unsupported-protocol";

const absent = new Map<P2pProtocol, NoFabric>();

/** Why a protocol has no fabric, for a settings screen that has to say something true. */
export const fabricAbsence = (protocol: P2pProtocol): NoFabric | undefined => absent.get(protocol);

/**
 * Each method bound explicitly, **not spread**.
 *
 * An Expo module is a class instance, so `{ ...module }` copies its own properties and none of
 * its prototype methods — and it still type-checks, because the type says the methods are there.
 * `./ble.ts` learned this the hard way; the shape is copied deliberately.
 */
const watched = (module: RnP2pManager): RnP2pManager => ({
  addListener: (event, listener) => module.addListener(event, listener),
  closePath: (path) => module.closePath(path),
  connect: (protocol, peer) => module.connect(protocol, peer),
  publish: (protocol, service, announces) => module.publish(protocol, service, announces),
  resume: (path) => module.resume(path),
  send: (path, bytes) => module.send(path, bytes),
  stop: (protocol) => module.stop(protocol),
  supports: (protocol) => module.supports(protocol),
});

/**
 * Is there a module at all — asked without throwing to find out.
 *
 * `requireOptionalNativeModule` answers `null` for a module that was never compiled in, where
 * `requireNativeModule` *reports and throws* and leaves a red screen behind even inside a `try`,
 * because the report happens before the throw. The name is the native registration.
 */
const p2pModule = (): RnP2pManager | null =>
  // SAFETY: `requireOptionalNativeModule` is declared over `any`, so the type argument is this
  // file's claim about the native module rather than a check of it. `RnP2pManager` is
  // `@syncmesh/transports`' own statement of exactly what the mesh touches, and `RNNearby`
  // implements every member — which is the claim this boundary exists to make in one place.
  requireOptionalNativeModule<RnP2pManager>("RNNearby");

export interface FabricOptions {
  /**
   * Whether this build may reach for the radio at all. Default `true`.
   *
   * Reported as `switched-off-in-config` rather than as "no radio", because the two send a person
   * to check completely different things.
   */
  readonly enabled?: boolean;
}

/**
 * The platform's peer-to-peer Wi-Fi for one protocol, or nothing.
 *
 * Returns nothing rather than throwing, because a simulator has no radio, an Expo Go client has
 * no native module, and a phone older than iPhone 12 has no Wi-Fi Aware — none of which is a
 * broken app. The mesh has one fewer source, which `$status` already knows how to say, and every
 * read is still answered out of this device's own database.
 *
 * The **bound** fabric, not the bare one: `dispose()` is the only way to let go of the native
 * module's listeners, and a caller that builds one per screen rather than one per process needs
 * it. `stop()` is not that — see `BoundFabric.dispose`.
 *
 * @example
 * const bound = nativeFabric("awdl");
 * const overTheAir = bound === undefined ? undefined : awdl({ id: "issues", fabric: bound.fabric });
 */
export const nativeFabric = (
  protocol: P2pProtocol,
  options: FabricOptions = {},
): BoundFabric | undefined => {
  if (options.enabled === false) {
    absent.set(protocol, "switched-off-in-config");
    return undefined;
  }
  const native = p2pModule();
  if (native === null) {
    absent.set(protocol, "not-in-this-build");
    return undefined;
  }
  const built = fabricFrom(watched(native), protocol);
  if (built.isErr()) {
    absent.set(protocol, "unsupported-protocol");
    return undefined;
  }
  absent.delete(protocol);
  return built.value;
};
