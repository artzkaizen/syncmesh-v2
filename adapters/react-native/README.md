# @syncmesh/react-native

What a mesh on a phone needs from the platform, so that no app has to write it twice.

Everything here is a _binding_: one side is React Native's, the other is a port syncmesh already
declares. Nothing in this package knows what your app is, which tables it has, or who it syncs with.

Each binding is its own entry point, because each one costs a native module and a library has no
business making an app install one it will never call.

## The knocks

```ts
import { foreground } from "@syncmesh/react-native";
import { reachability } from "@syncmesh/react-native/network";

const app = createClient({ schema, procedures, knocks: [foreground(), reachability()] });
```

A `Knock` is a platform signal that the world may have moved, and the mesh answers it by telling
every medium to look at its link again. It exists because **a socket does not always learn that its
network went away**: switch Wi-Fi off and the connection underneath is abandoned rather than closed,
so the relay believed it had a live link for the ~37 seconds its keepalive took to expire, with
writes queued on disk and going nowhere. Bluetooth has the same shape — an adapter switching off is
not a link ending.

`foreground()` needs nothing but React Native and covers the ordinary case, because nearly
everything a person does to fix their connection ends with them coming back to the app.
`reachability()` needs `expo-network` and covers the case the first one cannot see: a network that
drops and returns while the app stays in front. It keys on `isInternetReachable`, not `isConnected`,
because a phone on an access point with no route is connected and useless.

`foreground()` also says when the app goes to the `background`, which wakes nothing: the mesh marks
its log's session clean there and open again on `active` (D39), so an app the system ends in the
background is not taken for one that crashed, and the next launch skips the page-by-page log check.
On iOS, swiping an app away from the app switcher often ends it from `inactive` with no
`background` change first. That session was never marked clean, so the next launch runs the check:
slower, never wrong. `inactive` is not taken as background because it also passes for a
notification shade or an incoming call.

## The signer — `@syncmesh/react-native/crypto`

```ts
import { installNativeCrypto } from "@syncmesh/react-native/crypto";

installNativeCrypto();
```

Ed25519 through OpenSSL instead of through Hermes, over `react-native-quick-crypto`. The bundled
implementation is big-integer arithmetic in JavaScript and Hermes has no fast bignums: one
verification costs ~7ms, and a device joining a workspace pays one per event. Installing this took a
cold join from **9,835ms to 2,309ms**. A build without the native module gets a slower mesh, not a
broken one.

## The entropy — `@syncmesh/react-native/entropy`

```ts
import "@syncmesh/react-native/entropy";
```

React Native ships no WebCrypto, and the engine needs `getRandomValues` before it can do anything at
all — the device key is an Ed25519 seed. `randomUUID` is the half that is easy to miss, and leaving
it out fails several layers later inside the engine. Import it first, for its effect.

## The keystore — `@syncmesh/react-native/keystore`

```ts
import { createSecureStoreVault } from "@syncmesh/react-native/keystore";

const app = createClient({ schema, storage: sqlite({ driver }), vault: createSecureStoreVault() });
```

The device's signing seed, sealed under a key the iOS Keychain or Android Keystore holds, through
`expo-secure-store` (an optional peer: install it and rebuild the binary). React Native has no
keystore the mesh can find by itself, so `createClient` without a `vault` is refused there rather
than storing the seed in plaintext. The key is `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` by default: a
mesh woken in the background on a locked phone still opens, and a backup restored onto another
phone carries the sealed seed but not the key, so it is refused instead of becoming a second copy
of this device.

Each seal gets its own keychain item, `syncmesh.device-seed-key.<32 hex>` (`name` sets the
prefix). With `requireAuthentication` a boot reads the key once, so that is one prompt per boot.
Items outlive the app on iOS: a reinstall seals under a new item and the old one stays behind,
unread.

## The dev server — `@syncmesh/react-native/dev-server`

```ts
import { devServerHost } from "@syncmesh/react-native/dev-server";

const relay = `ws://${devServerHost() ?? "localhost"}:5241/app`;
```

`Constants.expoConfig?.hostUri`, `experienceUrl`, `linkingUri` and `NativeModules.SourceCode
.scriptURL` are all undefined in a dev client on the New Architecture; only React Native's own
`getDevServer` is populated. It answers `undefined` rather than `localhost`, because on a phone
`localhost` means _the phone_ — and a device pointed at itself reads as an empty workspace rather
than as an unreachable relay.

## The radio — `@syncmesh/react-native/ble`

```ts
const radio = nativeRadio({ enabled: Constants.expoConfig?.extra?.bluetooth !== false });
const overTheAir =
  radio === undefined ? undefined : bleTransport({ name: "app", radio, serviceUuid, ... });
```

Finds the native module without the red screen a static import leaves behind on Expo Go, tracks what
the adapter says about itself, and reports _why_ there is no radio when there is none. Your service
uuid, characteristic and group stay yours: they say who your app talks to, which is not a library's
decision.
