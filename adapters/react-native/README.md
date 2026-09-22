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
