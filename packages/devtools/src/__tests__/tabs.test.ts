import { describe, expect, test } from "bun:test";

import type { DevtoolsTab } from "../tabs.js";

import { createTabRegistry } from "../tabs.js";

const tab = (id: string): DevtoolsTab<number> => ({ id, label: id, render: () => null });

describe("the tab registry", () => {
  test("keeps the order it was given, because the first tab is the default", () => {
    const registry = createTabRegistry([tab("events"), tab("storage")]).unwrap();
    expect(registry.tabs.map((each) => each.id)).toEqual(["events", "storage"]);
    expect(registry.resolve(undefined)?.id).toBe("events");
  });

  test("resolves a remembered id", () => {
    const registry = createTabRegistry([tab("events"), tab("storage")]).unwrap();
    expect(registry.resolve("storage")?.id).toBe("storage");
  });

  test("falls back to the first tab when the remembered panel is no longer installed", () => {
    const registry = createTabRegistry([tab("events")]).unwrap();
    expect(registry.resolve("storage")?.id).toBe("events");
  });

  test("answers undefined when nothing is installed, rather than inventing a tab", () => {
    const registry = createTabRegistry<number>([]).unwrap();
    expect(registry.resolve("events")).toBeUndefined();
  });

  test("refuses two panels claiming one id, naming the id", () => {
    const registered = createTabRegistry([tab("events"), tab("events")]);
    if (!registered.isErr()) throw new Error("expected the shadowed tab to be refused");
    expect(registered.error._tag).toBe("DuplicateTabId");
    expect(registered.error.id).toBe("events");
  });
});
