import type { AppPhase, Knock } from "@syncmesh/client";

import { describe, expect, mock, test } from "bun:test";

/** The listener `AppState.addEventListener("change", …)` would hand a state to. */
type Listener = (state: string) => void;

/** The half of `../foreground.js` this test calls. */
interface ForegroundExports {
  readonly foreground: () => Knock;
}

/**
 * `react-native` stubbed with an `AppState` the test drives: the real one does not parse outside
 * Metro, and what is under test is which states become which phases.
 */
const withAppState = async () => {
  let listener: Listener | undefined;
  let removed = false;
  void mock.module("react-native", () => ({
    AppState: {
      addEventListener: (_event: string, on: Listener) => {
        listener = on;
        return { remove: () => void (removed = true) };
      },
    },
  }));
  // SAFETY: the query string is ignored by the loader and the module resolved is
  // `../foreground.js`, so the shape is that module's own
  const { foreground } = (await import(
    `../foreground.js?case=${String(Math.random())}`
  )) as ForegroundExports;
  return {
    foreground,
    say: (state: string) => listener?.(state),
    removed: () => removed,
  };
};

describe("foreground() (D39)", () => {
  test("`inactive` says nothing, `background` says the background, `active` the foreground", async () => {
    const app = await withAppState();
    const heard: (AppPhase | undefined)[] = [];
    const release = app.foreground()((phase) => void heard.push(phase));

    app.say("inactive");
    expect(heard).toEqual([]);
    app.say("background");
    app.say("active");
    expect(heard).toEqual(["background", "foreground"]);

    release();
    expect(app.removed()).toBe(true);
  });
});
