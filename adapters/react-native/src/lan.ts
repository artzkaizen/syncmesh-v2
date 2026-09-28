import type { BoundLan, RnLanManager, RnLanOptions } from "@syncmesh/transports";

import { lanFrom } from "@syncmesh/transports";
import { requireOptionalNativeModule } from "expo";

/**
 * The local network from the platform, if this build has it.
 *
 * The third seam beside `./ble.ts` and `./p2p.ts`, and the one that reaches furthest: an ordinary
 * Wi-Fi network is the only place an iPhone and an Android phone actually meet above BLE, and it
 * is the same `LanNetwork` port `adapters/lan-node` satisfies — so a handset and a relay running
 * under Node are peers on one transport rather than two implementations of a similar idea.
 *
 * It needs infrastructure the radios do not: somebody has to be running the access point. What it
 * buys for that is full Wi-Fi bandwidth and a room that is not one vendor's.
 */

/** Why there is no network, when there is none. Each sends a person somewhere different. */
export type NoLan =
  /** The native module was never compiled into this build — Expo Go, or a bare app. */
  | "not-in-this-build"
  /** This build said no, before the platform was asked anything. */
  | "switched-off-in-config"
  /** The module is here and refused the sockets — no interface up, or the group unjoinable. */
  | "unsupported";

let absent: NoLan | undefined;

/** Why there is no LAN network, for a settings screen that has to say something true. */
export const lanAbsence = (): NoLan | undefined => absent;

/**
 * Each method bound explicitly, **not spread** — an Expo module is a class instance, so a spread
 * copies its own properties, none of its prototype methods, and still type-checks. `./ble.ts`
 * learned that the hard way.
 *
 * The module serves three media behind one registration, so the LAN calls carry a `lan` prefix
 * and the port's own names are mapped onto them here rather than leaking the prefix upward.
 */
const watched = (module: RnLanNative): RnLanManager => ({
  addListener: (event, listener) => module.addListener(event, listener),
  announce: (bytes) => module.lanAnnounce(bytes),
  closePath: (path) => module.closePath(path),
  dial: (host, port) => module.lanDial(host, port),
  resume: (path) => module.resume(path),
  send: (path, bytes) => module.send(path, bytes),
  start: (group, groupPort) => module.lanStart(group, groupPort),
  stop: () => module.lanStop(),
  supports: () => module.lanSupports(),
});

/** What the native module presents for the LAN half; the radios' half lives in `./p2p.ts`. */
interface RnLanNative {
  readonly lanSupports: () => boolean;
  readonly lanStart: (group: string, groupPort: number) => Promise<number>;
  readonly lanAnnounce: (bytes: Uint8Array) => void;
  readonly lanDial: (host: string, port: number) => Promise<string>;
  readonly lanStop: () => Promise<void>;
  readonly send: (path: string, bytes: Uint8Array) => Promise<void>;
  readonly resume: (path: string) => void;
  readonly closePath: (path: string) => void;
  readonly addListener: RnLanManager["addListener"];
}

const lanModule = (): RnLanNative | null =>
  // SAFETY: `requireOptionalNativeModule` is declared over `any`, so this type argument is this
  // file's claim about the module rather than a check of it — and `RNNearbyModule.swift` is
  // written against the same names, which is the claim this boundary exists to make in one place
  requireOptionalNativeModule<RnLanNative>("RNNearby");

export interface LanBuildOptions extends RnLanOptions {
  /** Whether this build may open sockets at all. Default `true`. */
  readonly enabled?: boolean;
}

/**
 * The platform's local network, or nothing.
 *
 * Nothing rather than a throw, for the same reason as every other adapter here: an Expo Go client
 * has no native module and that is not a broken app. The mesh has one fewer source, `$status`
 * says which and why, and every read is still answered out of this device's own database.
 *
 * @example
 * const bound = nativeLan();
 * const overLan = bound === undefined ? undefined : lan({ id: "issues", network: bound.network });
 */
export const nativeLan = (options: LanBuildOptions = {}): BoundLan | undefined => {
  if (options.enabled === false) {
    absent = "switched-off-in-config";
    return undefined;
  }
  const native = lanModule();
  if (native === null) {
    absent = "not-in-this-build";
    return undefined;
  }
  const built = lanFrom(watched(native), options);
  if (built.isErr()) {
    absent = "unsupported";
    return undefined;
  }
  absent = undefined;
  return built.value;
};
