import "./dom.js";
import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import type { DevtoolsStorage } from "../persist.js";
import type { DevtoolsTab } from "../tabs.js";

import { SyncmeshDevtools } from "../react/devtools.js";

/**
 * The failure this file exists for was reproducible: crash one panel and the whole devtool went,
 * bubble and all, taking the app's tree with it because React unmounts from the nearest boundary
 * and there was none. So the assertions are about what is *still there* after a panel throws —
 * the shell, the tab bar, and every other panel — rather than about the red box, which is the
 * easy half.
 */

const KEY = "syncmesh.devtools.boundary";

const memory = (seed?: string): DevtoolsStorage => {
  const held = new Map<string, string>(seed === undefined ? [] : [[KEY, seed]]);
  return {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => void held.set(key, value),
  };
};

const shadow = () => document.querySelector("[data-syncmesh-devtools]")?.shadowRoot ?? undefined;

const tabs = [
  {
    id: "broken",
    label: "Broken",
    render: () => {
      throw new Error("the panel read a field the mesh stopped returning");
    },
  },
  { id: "fine", label: "Fine", render: () => createElement("p", null, "still here") },
] satisfies DevtoolsTab<number>[];

const open = () => {
  const thrown: unknown[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(SyncmeshDevtools<number>, {
        storage: memory(`{"open":true,"dock":"bottom","size":380,"corner":"bottom-right"}`),
        storageKey: KEY,
        source: () => 1,
        tabs,
        onPanelError: (cause) => void thrown.push(cause),
      }),
    );
  });
  return {
    thrown,
    click: (label: string) =>
      act(() => {
        shadow()?.querySelector<HTMLElement>(`[aria-label="${label}"]`)?.click();
      }),
    select: (label: string) =>
      act(() => {
        const found = [...(shadow()?.querySelectorAll<HTMLElement>("[role=tab]") ?? [])];
        found.find((tab) => tab.textContent?.includes(label))?.click();
      }),
    stop: () =>
      act(() => {
        root.unmount();
        container.remove();
      }),
  };
};

describe("a panel that throws", () => {
  test("loses its own body and nothing else", () => {
    const panel = open();
    // the shell, the tab bar and the close control are all still rendered
    expect(shadow()?.querySelector('[aria-label="Syncmesh inspector"]')).not.toBeNull();
    expect(shadow()?.querySelectorAll("[role=tab]").length).toBe(2);
    expect(shadow()?.querySelector('[aria-label="Close the inspector"]')).not.toBeNull();
    panel.stop();
  });

  test("says what it threw, because the reader came here for the stack", () => {
    const panel = open();
    const alert = shadow()?.querySelector("[role=alert]");
    expect(alert?.textContent).toContain("The Broken panel stopped");
    expect(alert?.textContent).toContain("the mesh stopped returning");
    panel.stop();
  });

  test("hands the cause to the host as well as drawing it", () => {
    const panel = open();
    expect(panel.thrown).toHaveLength(1);
    expect(panel.thrown[0]).toBeInstanceOf(Error);
    panel.stop();
  });

  test("leaves every other tab working, which is the whole point", () => {
    const panel = open();
    panel.select("Fine");
    expect(shadow()?.querySelector("[role=alert]")).toBeNull();
    expect(shadow()?.textContent).toContain("still here");
    panel.stop();
  });

  test("tries again on the way back, rather than staying broken forever", () => {
    const panel = open();
    panel.select("Fine");
    panel.select("Broken");
    // it threw a second time, which is the honest outcome: the boundary reset and the panel failed
    expect(panel.thrown).toHaveLength(2);
    expect(shadow()?.querySelector("[role=alert]")).not.toBeNull();
    panel.stop();
  });

  test("the devtool can still be closed, so the app is never held hostage", () => {
    const panel = open();
    panel.click("Close the inspector");
    expect(shadow()?.querySelector('[aria-label="Syncmesh inspector"]')).toBeNull();
    panel.stop();
  });
});
