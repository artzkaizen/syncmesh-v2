import Constants from "expo-constants";
// eslint-disable-next-line import-x/no-unresolved -- React Native ships no types for this path; `./react-native-internals.d.ts` states the shape
import getDevServer from "react-native/Libraries/Core/Devtools/getDevServer";

import { hostOf } from "./host.js";

/**
 * The machine that served this bundle, which on a development build is the machine running the
 * relay — or `undefined` when this build did not come from one.
 *
 * **`localhost` is the one answer that is always wrong on a phone**, because there it means the
 * phone. On a simulator it happens to work, since the simulator shares the Mac's loopback, which
 * is exactly why a `?? "localhost"` fallback can survive months of development and then fail the
 * first time a real device runs the app — and fail *silently*, as an empty workspace rather than
 * as an unreachable relay.
 *
 * `getDevServer` is React Native's own answer and the only one that was actually populated on the
 * New Architecture: `Constants.expoConfig?.hostUri`, `experienceUrl`, `linkingUri` and
 * `NativeModules.SourceCode.scriptURL` were **all undefined** in a dev client — measured on a
 * device, not assumed — which left every lookup falling through. `hostUri` is kept behind it
 * because it is Expo's own and is set when the manifest came from a dev server, which is a
 * different situation from the JS having come over HTTP, and the two are absent in different ones.
 *
 * Neither exists in a release build, and there the answer is not guessable at all: a shipped app
 * has to be *told* where its relay is. That is why this returns nothing rather than a default —
 * what to do with "there is no dev server" is the app's decision, and a library that answered
 * `localhost` for it would be putting the bug back.
 *
 * Its own entry point, because it is the one thing in this package that reaches for `expo-constants`
 * and a bare React Native app that only wants {@link foreground} should not have to install Expo's
 * config module to get it.
 */
export const devServerHost = (): string | undefined =>
  hostOf(getDevServer().url) ?? hostOf(Constants.expoConfig?.hostUri);
