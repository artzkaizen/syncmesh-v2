import type { Knock } from "@syncmesh/client";

import { describe, expect, mock, test } from "bun:test";

/**
 * What this package does on a build where an optional native module is not there.
 *
 * Every entry here declares its platform dependency `optional` in `package.json`, and that is a
 * promise about *loading*, not about calling. An Expo module resolves itself at module scope, so
 * an unguarded `import` throws while the importing module is being evaluated and takes down
 * everything above it. That is not hypothetical: `reachability()` hard-imported `expo-network`,
 * and phones still running the previous binary lost the whole mesh — relay and radio together —
 * because a *recovery* signal could not resolve.
 *
 * `expo` is stubbed rather than loaded, because reaching it for real drags in `react-native`,
 * which does not parse outside Metro. What is under test is this package's own behaviour on each
 * of the two answers `requireOptionalNativeModule` can give.
 */

/** The listener the native module would hand a reading to. */
type Listener = (state: { readonly isInternetReachable?: boolean }) => void;

/** What `requireOptionalNativeModule("ExpoNetwork")` can answer: the module, or nothing. */
type Answer = { addListener(event: string, on: Listener): { remove(): void } } | null;

/** The half of `../network.js` these tests call. */
interface NetworkExports {
  readonly reachability: () => Knock;
}

const withModule = async (answer: Answer): Promise<NetworkExports> => {
  void mock.module("expo", () => ({ requireOptionalNativeModule: () => answer }));
  // a fresh specifier each time, so the module-scope `const` is evaluated against this answer
  // SAFETY: the query string is ignored by the loader and the module resolved is `../network.js`,
  // so the shape is that module's own — the cast restores what the dynamic specifier erased
  return (await import(`../network.js?case=${String(Math.random())}`)) as NetworkExports;
};

describe("reachability on a build without the native module", () => {
  test("loads, and is a knock that subscribes to nothing", async () => {
    const { reachability } = await withModule(null);
    let woken = 0;
    const release = reachability()(() => void (woken += 1));
    expect(woken).toBe(0);
    expect(() => release()).not.toThrow();
  });
});

describe("reachability on a build that has it", () => {
  test("wakes on a transition into reachability, and only on that", async () => {
    let listener: Listener | undefined;
    let removed = false;
    const { reachability } = await withModule({
      addListener: (_event, on) => {
        listener = on;
        return { remove: () => void (removed = true) };
      },
    });

    let woken = 0;
    const release = reachability()(() => void (woken += 1));
    expect(listener).toBeDefined();

    // still reachable: nothing moved, and redialling a working link costs a handshake for nothing
    listener?.({ isInternetReachable: true });
    expect(woken).toBe(0);

    // gone, then back — the transition that is the whole reason this knock exists
    listener?.({ isInternetReachable: false });
    listener?.({ isInternetReachable: true });
    expect(woken).toBe(1);

    release();
    expect(removed).toBe(true);
  });
});
