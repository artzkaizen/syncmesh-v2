import type { Knock } from "@syncmesh/client";

import { requireOptionalNativeModule } from "expo";

/** What the native module hands back, and the two members this knock touches. */
interface NetworkModule {
  addListener(
    event: "onNetworkStateChanged",
    listener: (state: { readonly isInternetReachable?: boolean }) => void,
  ): { remove(): void };
}

/**
 * The native module directly, rather than `expo-network`'s JavaScript wrapper.
 *
 * **Not a style choice — the wrapper cannot be imported safely.** Its first line is
 * `export default requireNativeModule('ExpoNetwork')`, which *throws* on a build without the
 * native module, at module scope. A plain `import` therefore fails while this file is being
 * evaluated and takes down everything that imported it: adding this knock to the app's mesh is
 * what stopped phones on the previous binary from opening a mesh at all — no relay and no radio,
 * from a *recovery* signal that could not resolve.
 *
 * Guarding it with `require` inside a `try` is worse than it looks: a bundler rewrites that to a
 * call through a shim, Metro's static analysis stops seeing the specifier, and the module is never
 * bundled — so the knock degrades to permanently dead on the phones that *do* have it, which is a
 * silent version of the same failure.
 *
 * `requireOptionalNativeModule` is the question asked properly: it answers `null` for a module that
 * was never compiled in, it comes from `expo` itself (always present), and it is the same door
 * `nativeRadio` already goes through. What is lost is `addNetworkStateListener`, which is a
 * one-line passthrough to `addListener` — reproduced below rather than depended on.
 */
const network = requireOptionalNativeModule<NetworkModule>("ExpoNetwork");

/**
 * The network itself coming back, as a {@link Knock} — the half `foreground` cannot see.
 *
 * A network that drops and returns while the app stays in front never touches `AppState`: a train
 * through a tunnel, a lift, an access point that hands out a lease and no route. The socket
 * underneath is abandoned rather than closed, so nothing fires, and the relay sits on a dead link
 * until its keepalive deadline expires ~37 seconds later. This is the platform telling us directly,
 * and it is the difference between "it catches up in half a minute" and "it catches up".
 *
 * **`isInternetReachable`, not `isConnected`.** A phone joined to an access point with no route
 * anywhere is *connected* and useless — a hotel portal, a printer's own network, a router whose
 * uplink is down — and waking on that would hang up a working socket to redial into the same
 * nothing.
 *
 * **Only a transition into reachability.** The listener fires on every change, including the ones
 * that say the network is still there, and redialling a link that was never down costs a socket, a
 * handshake and a fresh catch-up for nothing. The first reading is taken as reachable for the same
 * reason: an app that has just launched has either connected already or is about to be told it
 * cannot, and a wake before any transport has finished starting wakes nothing.
 *
 * Separate from the package's root entry because `expo-network` is a native module, and a library
 * that made every consumer install one to get a signer would be charging for a thing it is not
 * selling. An app that has it names this knock; an app that does not simply has one fewer.
 *
 * @example
 * import { foreground } from "@syncmesh/react-native";
 * import { reachability } from "@syncmesh/react-native/network";
 *
 * const app = createClient({ schema, procedures, knocks: [foreground(), reachability()] });
 */
export const reachability = (): Knock => (wake) => {
  // no `expo-network` in this build is one fewer signal, never a failure to open: the transports
  // still have their own deadlines, and `foreground()` still covers the case this one does not
  if (network === null) return () => undefined;
  let reachable = true;
  const subscription = network.addListener("onNetworkStateChanged", ({ isInternetReachable }) => {
    const now = isInternetReachable ?? false;
    if (now && !reachable) wake();
    reachable = now;
  });
  return () => subscription.remove();
};
