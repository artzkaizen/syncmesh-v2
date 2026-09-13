import "./dom.js";
import type { ForcedMedium } from "@syncmesh/client";
import type { TransportCondition } from "@syncmesh/transport";
import type { ReactNode } from "react";

import { NoSuchTransport } from "@syncmesh/client";
import { Result } from "@syncmesh/result";
import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

import type { DevtoolsSource } from "../contract.js";
import type { DevtoolsControls } from "../controls.js";
import type { ControlsMesh } from "../source/mesh-controls.js";

import { FORCEABLE } from "../controls.js";
import { mockMesh } from "../mock/index.js";
import { Transports } from "../panels/transports.js";
import { Bubble } from "../react/bubble.js";
import { ShellHeader } from "../react/shell-header.js";
import { createMeshControls } from "../source/mesh-controls.js";

const render = (node: ReactNode) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return {
    text: () => container.textContent ?? "",
    options: () =>
      [...container.querySelectorAll("option")].map((node) => node.getAttribute("value") ?? ""),
    /** The one picker for a named medium, found the way a person finds it: by its label. */
    pickerFor: (name: string) =>
      [...container.querySelectorAll("select")].find(
        (candidate) => candidate.getAttribute("aria-label") === `Hold ${name} in a condition`,
      ),
    /** The device toggle, found by its role rather than by whatever it currently says. */
    toggle: () => container.querySelector('[role="checkbox"]') ?? undefined,
    marked: () => container.querySelectorAll("button[data-forced]").length,
    close: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
};

/**
 * Drives the picker the way a person does, then lets the action settle.
 *
 * `act` with an async callback rather than a sync one, because every control here returns a
 * `Promise<Result>`: the state the assertion is about lands a microtask after the click.
 */
const choose = async (select: HTMLSelectElement | undefined, value: string) => {
  if (select === undefined) throw new Error("no picker was drawn");
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
};

const press = async (button: Element | undefined) => {
  if (!(button instanceof HTMLButtonElement)) throw new Error("no button was drawn");
  await act(async () => button.click());
};

describe("the forceable vocabulary is what a medium could honestly say", () => {
  test("no kind may be held in `ok`, because releasing it is a different verb", () => {
    for (const conditions of Object.values(FORCEABLE))
      expect(conditions).not.toContain("ok" satisfies TransportCondition);
  });

  test("a websocket is never offered a Bluetooth permission it could not be refused by", () => {
    expect(FORCEABLE.websocket).not.toContain("no-permission-central");
    expect(FORCEABLE.websocket).not.toContain("radio-off");
    expect(FORCEABLE.ble).toContain("no-permission-central");
  });

  test("every kind can be held offline, which is what the device-level control uses", () => {
    for (const conditions of Object.values(FORCEABLE))
      expect(conditions).toContain("temporarily-unavailable" satisfies TransportCondition);
  });
});

describe("createMeshControls is the operator half, and holds nothing itself", () => {
  const meshWith = (
    forced: ForcedMedium[],
    outcome: () => Result<void, NoSuchTransport> = () => Result.ok(undefined),
  ) =>
    ({
      transports: {
        forced: () => forced,
        force: () => Promise.resolve(outcome()),
        release: () => Promise.resolve(outcome()),
      },
    }) satisfies ControlsMesh;

  test("`forced` reads the mesh each time, so an app that forces directly is still reported", () => {
    const held: ForcedMedium[] = [];
    const controls = createMeshControls(meshWith(held));
    expect(controls.forced()).toEqual([]);
    held.push({ name: "ble", as: "radio-off" });
    expect(controls.forced()).toEqual([{ name: "ble", as: "radio-off" }]);
  });

  test("a refusal arrives as one value a panel can render, and does not move the feed", async () => {
    let woken = 0;
    const controls = createMeshControls(
      meshWith([], () =>
        Result.err(
          new NoSuchTransport({
            transport: "nowhere",
            message: "no medium named nowhere is running",
          }),
        ),
      ),
    );
    controls.onChange(() => (woken += 1));

    const refused = await controls.force("nowhere", "radio-off");
    expect(refused.isErr() && refused.error._tag).toBe("ControlRefused");
    expect(refused.isErr() && refused.error.message).toBe("no medium named nowhere is running");
    expect(refused.isErr() && refused.error.action).toBe("force");
    expect(woken).toBe(0); // nothing changed, so nothing repaints
  });

  test("a success wakes the feed once, which is what a badge is watching", async () => {
    let woken = 0;
    const controls = createMeshControls(meshWith([]));
    controls.onChange(() => (woken += 1));
    (await controls.force("ble", "radio-off")).unwrap();
    (await controls.release("ble")).unwrap();
    expect(woken).toBe(2);
  });
});

describe("the transports panel can act only when a host passed controls", () => {
  test("without controls it says so in a sentence and draws no picker at all", () => {
    const { source } = mockMesh();
    const panel = render(<Transports openTab={() => undefined} source={source} />);
    expect(panel.text()).toContain("read-only");
    expect(panel.pickerFor("ble")).toBeUndefined();
    panel.close();
  });

  test("with controls each medium gets the conditions its own kind can be held in", () => {
    const { source, controls } = mockMesh();
    const panel = render(
      <Transports controls={controls} openTab={() => undefined} source={source} />,
    );
    const ble = panel.pickerFor("ble");
    const relay = panel.pickerFor("relay");
    expect([...(ble?.options ?? [])].map((option) => option.value)).toEqual(["", ...FORCEABLE.ble]);
    expect([...(relay?.options ?? [])].map((option) => option.value)).toEqual([
      "",
      ...FORCEABLE.websocket,
    ]);
    panel.close();
  });

  test("holding a medium changes the row the fixture draws, not just the switch", async () => {
    const { source, controls } = mockMesh();
    const panel = render(
      <Transports controls={controls} openTab={() => undefined} source={source} />,
    );
    expect(panel.text()).not.toContain("held here");

    await choose(panel.pickerFor("lan"), "discovery-failed");

    // the condition, the mark that says a person made it so, and the peers it stopped carrying
    expect(panel.text()).toContain("discovery-failed");
    expect(panel.text()).toContain("held here");
    expect(controls.forced()).toEqual([{ name: "lan", as: "discovery-failed" }]);
    panel.close();
  });

  test("choosing `carrying` releases, and the row goes back to what the medium says", async () => {
    const { source, controls } = mockMesh();
    const panel = render(
      <Transports controls={controls} openTab={() => undefined} source={source} />,
    );
    await choose(panel.pickerFor("lan"), "listen-failed");
    expect(controls.forced()).toHaveLength(1);

    await choose(panel.pickerFor("lan"), "");
    expect(controls.forced()).toEqual([]);
    panel.close();
  });

  test("the device toggle holds every medium by name, so no row hides behind a global flag", async () => {
    const { source, controls } = mockMesh();
    const panel = render(
      <Transports controls={controls} openTab={() => undefined} source={source} />,
    );
    await press(panel.toggle());

    expect(
      controls
        .forced()
        .map((one) => one.name)
        .sort(),
    ).toEqual(["ble", "lan", "relay"]);
    expect(controls.forced().every((one) => one.as === "temporarily-unavailable")).toBe(true);
    panel.close();
  });
});

describe("the device toggle is the indicator, and it has three states rather than two", () => {
  const panelOver = (controls: DevtoolsControls, source: DevtoolsSource) =>
    render(<Transports controls={controls} openTab={() => undefined} source={source} />);

  test("nothing held reads as carrying, and says so rather than showing an off switch", () => {
    const { source, controls } = mockMesh();
    const panel = panelOver(controls, source);
    expect(panel.toggle()?.getAttribute("aria-checked")).toBe("false");
    expect(panel.toggle()?.textContent).toBe("carrying");
    panel.close();
  });

  test("one medium of three held is `mixed` and counts them — never `off`", async () => {
    const { source, controls } = mockMesh();
    const panel = panelOver(controls, source);
    await choose(panel.pickerFor("ble"), "radio-off");

    // the same distinction the rest of this panel makes between "cannot say" and "zero"
    expect(panel.toggle()?.getAttribute("aria-checked")).toBe("mixed");
    expect(panel.toggle()?.textContent).toBe("1 of 3 held");
    panel.close();
  });

  test("clicking from the half state holds the rest, and leaves the one already held alone", async () => {
    const { source, controls } = mockMesh();
    const panel = panelOver(controls, source);
    await choose(panel.pickerFor("ble"), "radio-off");
    await press(panel.toggle());

    expect(panel.toggle()?.getAttribute("aria-checked")).toBe("true");
    expect(panel.toggle()?.textContent).toBe("offline");
    // the condition somebody chose deliberately survives the aggregate gesture
    expect(controls.forced().find((one) => one.name === "ble")?.as).toBe("radio-off");
    panel.close();
  });

  test("clicking from offline gives every medium back, and the toggle says carrying again", async () => {
    const { source, controls } = mockMesh();
    const panel = panelOver(controls, source);
    await press(panel.toggle());
    await press(panel.toggle());

    expect(controls.forced()).toEqual([]);
    expect(panel.toggle()?.getAttribute("aria-checked")).toBe("false");
    expect(panel.toggle()?.textContent).toBe("carrying");
    panel.close();
  });

  test("a device running no medium at all has nothing to hold, so the toggle is dead", () => {
    const { source, controls } = mockMesh({
      overview: () => ({
        health: "offline",
        mediums: [],
        handles: { observers: 0, subscriptions: 0, operations: 0, fetches: 0, links: 0 },
        running: true,
        settled: true,
        peers: 0,
        grants: 0,
        parked: 0,
      }),
    });
    const panel = panelOver(controls, source);
    expect(panel.toggle()?.hasAttribute("disabled")).toBe(true);
    panel.close();
  });
});

describe("a forced state is visible without being on the Transports tab", () => {
  const header = (controls: DevtoolsControls) =>
    render(
      <ShellHeader
        active="peers"
        body="body"
        controls={controls}
        dock="bottom"
        onClose={() => undefined}
        onDock={() => undefined}
        onSelect={() => undefined}
        tabs={[{ id: "peers", label: "Peers", render: () => null }]}
        title="Syncmesh inspector"
      />,
    );

  test("the strip says nothing about holding while nothing is held", () => {
    const { controls } = mockMesh();
    const panel = header(controls);
    // the frames meter keeps its seat whatever the controls are doing; the forced mark does not
    expect(panel.text()).not.toContain("forced");
    expect(panel.text()).not.toContain("mediums");
    panel.close();
  });

  test("a held medium is named in the strip, so another tab is not a hiding place", async () => {
    const { controls } = mockMesh();
    (await controls.force("ble", "radio-off")).unwrap();
    const panel = header(controls);
    expect(panel.text()).toContain("ble forced radio-off");
    panel.close();
  });
});

describe("a forced state is visible with the panel shut", () => {
  const bubble = (forced: number) =>
    render(
      <Bubble
        corner="bottom-right"
        forced={forced}
        hint="Open the Syncmesh inspector"
        onMove={() => undefined}
        onOpen={() => undefined}
      />,
    );

  test("the bubble is mute where nothing is held, which is every production build", () => {
    const panel = bubble(0);
    expect(panel.marked()).toBe(0);
    panel.close();
  });

  test("a held medium puts a mark on the bubble, because the panel it was set in is closed", () => {
    const panel = bubble(2);
    expect(panel.marked()).toBe(1);
    panel.close();
  });
});
