import { describe, expect, test } from "bun:test";

import type { DevtoolsStorage } from "../persist.js";

import { readPanelState, writePanelState } from "../persist.js";
import { DEFAULT_PANEL_STATE, MIN_SIZE } from "../state.js";

const KEY = "syncmesh.devtools";

const fake = (seed?: string): DevtoolsStorage => {
  const held = new Map<string, string>(seed === undefined ? [] : [[KEY, seed]]);
  return {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => void held.set(key, value),
  };
};

const refusing = (): DevtoolsStorage => ({
  getItem: () => {
    throw new Error("access denied");
  },
  setItem: () => {
    throw new Error("quota exceeded");
  },
});

describe("what the panel remembers", () => {
  test("a first run is undefined, not the defaults — the caller must tell them apart", () => {
    expect(readPanelState(fake(), KEY).unwrap()).toBeUndefined();
  });

  test("round-trips everything the user can change", () => {
    const storage = fake();
    const state = {
      open: true,
      dock: "right",
      size: 520,
      corner: "top-left",
      tab: "events",
    } as const;
    expect(writePanelState(storage, KEY, state).isOk()).toBe(true);
    expect(readPanelState(storage, KEY).unwrap()).toEqual(state);
  });

  test("a key from another build loses only the fields this one does not recognise", () => {
    const stored = readPanelState(
      fake(`{"open":true,"dock":"diagonal","corner":"middle","size":"tall","tab":7}`),
      KEY,
    ).unwrap();
    expect(stored?.open).toBe(true);
    expect(stored?.dock).toBe(DEFAULT_PANEL_STATE.dock);
    expect(stored?.corner).toBe(DEFAULT_PANEL_STATE.corner);
    expect(stored?.size).toBe(DEFAULT_PANEL_STATE.size);
  });

  test("a size below the floor comes back at the floor", () => {
    expect(readPanelState(fake(`{"size":12}`), KEY).unwrap()?.size).toBe(MIN_SIZE);
  });

  test("text that is not JSON is an error value, not a thrown one", () => {
    const read = readPanelState(fake("{not json"), KEY);
    if (!read.isErr()) throw new Error("expected the unparseable key to be refused");
    expect(read.error._tag).toBe("PanelStateFailure");
    expect(read.error.key).toBe(KEY);
    expect(read.error.message).toBe("not JSON");
  });

  test("a storage that refuses is an error value at both ends", () => {
    const read = readPanelState(refusing(), KEY);
    const wrote = writePanelState(refusing(), KEY, DEFAULT_PANEL_STATE);
    if (!read.isErr() || !wrote.isErr()) throw new Error("expected both halves to be refused");
    expect(read.error.message).toBe("read refused");
    expect(wrote.error.message).toBe("write refused");
  });
});
