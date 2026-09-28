import { requireOptionalNativeModule } from "expo";

/**
 * The native module, typed as the port it was written against.
 *
 * `@syncmesh/transports` declares `RnP2pManager` — exactly what the mesh touches — and the Swift
 * in `../ios` implements that and nothing else. This file exists so the two can be checked against
 * each other in one place rather than at every call site, and so an app never reaches for a native
 * registration name by hand.
 *
 * It answers `null` rather than throwing when the module was not compiled in: a simulator has no
 * peer-to-peer Wi-Fi and an Expo Go client has no native module, and neither is a broken app.
 */

/** One peer's radio. The two never interoperate, which is why they are two. */
export type P2pRadio = "awdl" | "wifi-aware";

/** What `remove()` comes back on; an Expo subscription, not a bare function. */
export interface P2pSubscription {
  readonly remove: () => void;
}

/**
 * The surface `RNNearbyModule.swift` publishes.
 *
 * Structurally identical to `@syncmesh/transports`' `RnP2pManager` on purpose — that package is
 * runtime-neutral and cannot import this one, so the two are held together by this declaration
 * and by the adapter that passes one to the other.
 */
export interface NearbyModule {
  readonly supports: (radio: string) => boolean;
  readonly publish: (radio: string, service: string, announces: Uint8Array) => Promise<void>;
  readonly connect: (radio: string, peer: string) => Promise<string>;
  readonly send: (path: string, bytes: Uint8Array) => Promise<void>;
  readonly resume: (path: string) => void;
  readonly closePath: (path: string) => void;
  readonly stop: (radio: string) => Promise<void>;
  readonly addListener: (event: string, cb: (payload: never) => void) => P2pSubscription;
}

/**
 * The module, or nothing.
 *
 * `requireOptionalNativeModule` rather than `requireNativeModule`: the latter *reports and throws*
 * for a module that was never compiled in, and the report lands before the throw — so a red screen
 * survives even a `try`. The string is the native registration, not the npm name.
 */
export const nearbyModule = (): NearbyModule | null =>
  // SAFETY: `requireOptionalNativeModule` is declared over `any`, so this type argument is a claim
  // about the module rather than a check of it — and `RNNearbyModule.swift` is written against
  // the same port, which is the claim this one line exists to make
  requireOptionalNativeModule<NearbyModule>("RNNearby");
