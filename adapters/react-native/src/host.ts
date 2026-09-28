import { Result } from "@syncmesh/result";

/**
 * A host out of whatever the platform handed over, or nothing at all.
 *
 * The two places a React Native app can learn where its dev server is spell the same fact
 * differently: React Native's own `getDevServer` answers a whole URL (`http://10.1.72.5:8081/`)
 * and Expo's `hostUri` answers `host:port`. The host is what they agree on, and the host is all
 * anybody wants — a relay and an authority live on the same machine as the bundler but on ports
 * of their own.
 *
 * **An absent answer stays absent rather than becoming a string.** `String(undefined)` is
 * `"undefined"`, which is a perfectly dialable nonsense URL, and a device that spends its launch
 * failing to reach `ws://undefined:5241` looks exactly like a device with nothing to sync.
 *
 * The parse is a `Result` rather than a bare `new URL` because this runs on whatever `URL` the
 * runtime supplies — Hermes' is a polyfill, not the browser's — and a constructor that threw here
 * would take down module evaluation on a launch path, several frames from anything that could
 * explain it. A URL this cannot read is one more source that has no answer.
 */
export const hostOf = (url: string | undefined): string | undefined => {
  if (url === undefined || url === "") return undefined;
  const host = url.includes("://")
    ? Result.try({ try: () => new URL(url).hostname, catch: (cause) => cause }).unwrapOr(undefined)
    : url.split(":")[0];
  return host === undefined || host === "" ? undefined : host;
};
