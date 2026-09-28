import "./dom.js";
import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import type { DevtoolsStorage } from "../persist.js";
import type { DevtoolsTab } from "../tabs.js";

import { SyncmeshDevtools } from "../react/devtools.js";

const KEY = "syncmesh.devtools.test";

interface Spies {
  readonly built: () => number;
  readonly drawn: () => number;
  readonly tabs: readonly DevtoolsTab<number>[];
  readonly source: () => number;
}

const spies = (): Spies => {
  let built = 0;
  let drawn = 0;
  return {
    built: () => built,
    drawn: () => drawn,
    source: () => {
      built += 1;
      return built;
    },
    tabs: [
      {
        id: "events",
        label: "Events",
        render: () => {
          drawn += 1;
          return null;
        },
      },
    ],
  };
};

const memory = (seed?: string): DevtoolsStorage => {
  const held = new Map<string, string>(seed === undefined ? [] : [[KEY, seed]]);
  return {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => void held.set(key, value),
  };
};

const shadow = () => document.querySelector("[data-syncmesh-devtools]")?.shadowRoot ?? undefined;

const render = (storage: DevtoolsStorage, spy: Spies) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(SyncmeshDevtools<number>, {
        storage,
        storageKey: KEY,
        source: spy.source,
        tabs: spy.tabs,
      }),
    );
  });
  return {
    stop: () =>
      act(() => {
        root.unmount();
        container.remove();
      }),
  };
};

describe("the devtools while they are closed", () => {
  test("never build the source and never draw a panel", () => {
    const spy = spies();
    const mounted = render(memory(), spy);
    expect(shadow()?.querySelectorAll("button").length).toBe(1);
    expect(spy.built()).toBe(0);
    expect(spy.drawn()).toBe(0);
    mounted.stop();
  });

  test("build the source exactly once, on the click that opens the panel", () => {
    const spy = spies();
    const mounted = render(memory(), spy);
    act(() => {
      shadow()?.querySelector("button")?.click();
    });
    expect(spy.built()).toBe(1);
    expect(spy.drawn()).toBeGreaterThan(0);
    mounted.stop();
  });

  test("throw the source away again when the panel closes", () => {
    const spy = spies();
    const mounted = render(memory(), spy);
    const click = (label: string) => {
      act(() => {
        shadow()?.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)?.click();
      });
    };
    act(() => {
      shadow()?.querySelector("button")?.click();
    });
    click("Close the inspector");
    expect(spy.built()).toBe(1);
    click("Open the Syncmesh inspector (Ctrl+Shift+D)");
    expect(spy.built()).toBe(2);
    mounted.stop();
  });
});

describe("what the panel remembers between mounts", () => {
  test("an open panel reopens open, and builds its source straight away", () => {
    const storage = memory(`{"open":true,"dock":"right","size":400,"corner":"top-left"}`);
    const spy = spies();
    const mounted = render(storage, spy);
    expect(spy.built()).toBe(1);
    expect(shadow()?.querySelector('[aria-label="Syncmesh inspector"]')).not.toBeNull();
    mounted.stop();
  });

  test("writes the open state back, so the next page load agrees", () => {
    const storage = memory();
    const spy = spies();
    const mounted = render(storage, spy);
    act(() => {
      shadow()?.querySelector("button")?.click();
    });
    expect(storage.getItem(KEY)).toContain(`"open":true`);
    mounted.stop();
  });
});

/**
 * A source that lives in another thread, and the two things that broke when one first did.
 *
 * The panel has to draw *something* while the first reading crosses the port, and a host that
 * spells `dispose` as an inline arrow — which is how every example spells it — must not have its
 * source torn down every time anything above it re-renders. The second of those took a panel down
 * with a `TypeError` in a real app before it was found here.
 */
describe("the devtools over a source that has to be awaited", () => {
  const later = <T>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 0));

  test("say they are reaching the mesh, then draw the panel when it lands", async () => {
    const spy = spies();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        createElement(SyncmeshDevtools<number>, {
          source: () => later(spy.source()),
          storage: memory(),
          storageKey: KEY,
          tabs: spy.tabs,
        }),
      );
    });
    act(() => {
      shadow()?.querySelector("button")?.click();
    });
    expect(shadow()?.textContent).toContain("Reaching the mesh");
    expect(spy.drawn()).toBe(0);

    await act(() => later(undefined));
    expect(spy.drawn()).toBeGreaterThan(0);
    act(() => {
      root.unmount();
      container.remove();
    });
  });

  test("keep the source across a re-render, however the host spelled `dispose`", async () => {
    const spy = spies();
    let released = 0;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const draw = () =>
      act(() => {
        root.render(
          createElement(SyncmeshDevtools<number>, {
            // a new function every render, which is what an inline arrow is
            dispose: () => void (released += 1),
            source: () => later(spy.source()),
            storage: memory(),
            storageKey: KEY,
            tabs: spy.tabs,
          }),
        );
      });
    draw();
    act(() => {
      shadow()?.querySelector("button")?.click();
    });
    await act(() => later(undefined));
    expect(spy.built()).toBe(1);

    draw();
    draw();
    expect(released).toBe(0);
    expect(spy.built()).toBe(1);

    act(() => {
      root.unmount();
      container.remove();
    });
    expect(released).toBe(1);
  });
});
