import type { AppPhase } from "@syncmesh/client";
import type { Transport } from "@syncmesh/transport";

import { afterEach, describe, expect, test } from "bun:test";

import type { TabPhases } from "../phases.js";
import type { ClientMessage, WirePort } from "../protocol.js";

import { createTabPhases } from "../phases.js";
import { meshOrigin, settled } from "./origin-mesh.js";
import { openTab, origin, settle } from "./origin.js";

/** What the host told the mesh, in order, and nothing passed on. */
const recorded = () => {
  const told: AppPhase[] = [];
  const phases: TabPhases = { knock: () => () => undefined, tell: (phase) => told.push(phase) };
  return { phases, told };
};

/** A window saying where its page is, as `tabs.ts` does over the link. */
const say = (port: WirePort, phase: AppPhase) =>
  port.postMessage({ kind: "phase", phase } satisfies ClientMessage);

/** A medium that counts how often it was told to look at its link again. */
const counted = () => {
  let woken = 0;
  const transport: Transport = {
    name: "counted",
    start: () => Promise.resolve(),
    whenReady: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    wake: () => void (woken += 1),
  };
  return { transport, woken: () => woken };
};

const until = async (check: () => Promise<boolean>, turns = 400): Promise<boolean> => {
  for (let turn = 0; turn < turns; turn += 1) {
    if (await check()) return true;
    await new Promise((next) => setTimeout(next, 5));
  }
  return check();
};

describe("the origin's phase is every window's (U32)", () => {
  test("the background once every window is hidden, the foreground with the first one back", async () => {
    const { phases, told } = recorded();
    const { tab, stop } = await meshOrigin({ phases });
    const a = tab("leader");
    const b = tab();

    say(a.link.port, "background");
    await settled();
    // b has said nothing, and a window that has not said counts as shown
    expect(told).toEqual([]);

    say(b.link.port, "background");
    await settled();
    expect(told).toEqual(["background"]);

    say(b.link.port, "background");
    await settled();
    expect(told).toEqual(["background"]);

    say(a.link.port, "foreground");
    await settled();
    expect(told).toEqual(["background", "foreground"]);
    await stop();
  });

  test("a window that leaves stops counting, and one that arrives counts as shown", async () => {
    const { phases, told } = recorded();
    const { tab, stop } = await meshOrigin({ phases });
    const a = tab("leader");
    const b = tab();
    say(b.link.port, "background");
    await settled();
    expect(told).toEqual([]);

    // the one shown window closes: nobody left is looking
    a.close();
    await settled();
    expect(told).toEqual(["background"]);

    tab();
    await settled();
    expect(told).toEqual(["background", "foreground"]);
    await stop();
  });

  test("the last window leaving puts the origin in the background; stopping the host does not", async () => {
    const left = recorded();
    const first = await meshOrigin({ phases: left.phases });
    first.tab().close();
    await settled();
    expect(left.told).toEqual(["background"]);
    await first.stop();

    const stopped = recorded();
    const second = await meshOrigin({ phases: stopped.phases });
    second.tab();
    await settled();
    await second.stop();
    expect(stopped.told).toEqual([]);
  });
});

describe("the mesh in the worker hears it (D39, U32)", () => {
  test("every window hidden marks the log's session clean; one back opens it and wakes the media", async () => {
    const phases = createTabPhases();
    const medium = counted();
    const { mesh, tab, stop } = await meshOrigin(
      { phases },
      { knocks: [phases.knock], transports: [medium.transport] },
    );
    const session = async () =>
      (await mesh.query?.(`SELECT value FROM syncmesh.meta WHERE key = 'session'`))?.[0]?.[0];
    const a = tab("leader");
    const b = tab();
    await mesh.ready();
    expect(await session()).toBe("open");

    say(a.link.port, "background");
    say(b.link.port, "background");
    expect(await until(async () => (await session()) === "closed")).toBe(true);
    // the background is no time to redial
    expect(medium.woken()).toBe(0);

    say(b.link.port, "foreground");
    expect(await until(async () => (await session()) === "open")).toBe(true);
    expect(medium.woken()).toBe(1);
    await stop();
  });

  test("a mesh that starts listening after the origin went to the background still hears it", () => {
    const phases = createTabPhases();
    phases.tell("background");
    const heard: (AppPhase | undefined)[] = [];
    const off = phases.knock((phase) => heard.push(phase));
    phases.tell("foreground");
    off();
    phases.tell("background");
    expect(heard).toEqual(["background", "foreground"]);
  });
});

/** A page's `document` as far as `phases.ts` reads one: a visibility, and its change event. */
const fakeDocument = () => {
  const page = new EventTarget();
  let visibility: DocumentVisibilityState = "visible";
  Object.defineProperty(page, "visibilityState", { get: () => visibility });
  Object.defineProperty(globalThis, "document", { value: page, configurable: true });
  return (next: DocumentVisibilityState) => {
    visibility = next;
    page.dispatchEvent(new Event("visibilitychange"));
  };
};

describe("a tab tells the host its page's phase (U32)", () => {
  afterEach(() => {
    // SAFETY: `fakeDocument` defined it configurable, and bun has no `document` of its own
    delete (globalThis as { document?: unknown }).document;
  });

  test("at once on every link it opens, and again whenever its visibility changes", async () => {
    const show = fakeDocument();
    const heard: ClientMessage[] = [];
    const record = (port: WirePort) => {
      port.onmessage = (event) => heard.push(event.data);
    };
    const where = origin();
    const tab = await openTab(where, "one", true, record);
    const link = tab.mesh.open().unwrap();
    await settle();
    expect(heard).toEqual([{ kind: "phase", phase: "foreground" }]);

    show("hidden");
    await settle();
    show("visible");
    await settle();
    expect(heard.slice(1)).toEqual([
      { kind: "phase", phase: "background" },
      { kind: "phase", phase: "foreground" },
    ]);

    // a closed link stops telling
    link.close();
    show("hidden");
    await settle();
    expect(heard).toHaveLength(3);
    tab.close();
  });
});
