import type { MeshInspector, RemoteInspect } from "@syncmesh/browser";

import { StrandedWrites } from "@syncmesh/engine";
import { Result } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";

import { createInspectorHost } from "../source/inspector-host.js";
import { createRemoteControls } from "../source/remote-controls.js";
import { createRemoteSource } from "../source/remote-source.js";
import {
  AT,
  NEAR,
  SELF,
  SEVEN,
  THREE,
  forcing,
  harness,
  tick,
  withControls,
  withRecovery,
} from "./readable-mesh.js";

/**
 * The port, as a port: **everything that crosses here goes through `structuredClone`.**
 *
 * That is the whole claim being tested. `DevtoolsSource`'s snapshots are plain data by contract,
 * so they survive the clone; the one thing that does not is `Temporal.Instant`, which is a class
 * instance and is tagged on the way out and rebuilt on the way in. A test that handed the object
 * straight over would pass while the real thing threw `DataCloneError` in a browser, so the clone
 * is not a detail of the fixture — it is the assertion.
 */
const wired = (inspector: MeshInspector): RemoteInspect => ({
  read: async (name, args = []) => {
    const answer = await inspector.read(name, structuredClone(args));
    return structuredClone(answer);
  },
  watch: (listener) => inspector.watch((moved) => listener(structuredClone(moved))),
  onForced: (listener) => inspector.onForced((held) => listener(structuredClone(held))),
});

const remote = async (inspector: MeshInspector) =>
  createRemoteSource({ inspect: wired(inspector), syncOf: () => "local" });

describe("the inspector over a port", () => {
  test("opens no source until a window watches, and closes it when the last one goes", async () => {
    const held = harness();
    const inspector = createInspectorHost(held.mesh);
    expect(held.folds.live()).toBe(0);

    const source = await remote(inspector);
    expect(held.folds.live()).toBe(1);
    expect(held.telemetry.live()).toBe(1);

    source.close();
    expect(held.folds.live()).toBe(0);
    expect(held.telemetry.live()).toBe(0);
  });

  test("four windows are one source for the origin, and one telemetry listener", async () => {
    const held = harness();
    const inspector = createInspectorHost(held.mesh);
    const windows = await Promise.all([1, 2, 3, 4].map(() => remote(inspector)));
    expect(held.folds.live()).toBe(1);
    expect(held.telemetry.live()).toBe(1);
    for (const window of windows.slice(1)) window.close();
    expect(held.telemetry.live()).toBe(1);
    windows[0]?.close();
    expect(held.telemetry.live()).toBe(0);
  });

  test("a read with no window watching is refused rather than quietly opening one", async () => {
    const held = harness();
    const inspector = createInspectorHost(held.mesh);
    const refused = await inspector.read("open", []).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    // SAFETY: the read throws its own tagged refusal; this is that refusal read as one
    expect((refused as { readonly _tag?: string })._tag).toBe("InspectRefused");
    expect(held.folds.live()).toBe(0);
  });

  test("the snapshots arrive as themselves, instants included", async () => {
    const held = harness();
    const source = await remote(createInspectorHost(held.mesh));
    expect(source.identity().peer).toBe(SELF);
    expect(source.overview().mediums.map((one) => one.name)).toEqual(["lan"]);
    const [ack] = source.sync().acks;
    expect(ack?.peer).toBe(NEAR);
    expect(ack?.at).toBeInstanceOf(Temporal.Instant);
    expect(ack?.at.epochMilliseconds).toBe(AT.epochMilliseconds);
    source.close();
  });

  test("a fold re-reads only what a panel has drawn, and announces it once it has landed", async () => {
    const held = harness();
    const inspector = createInspectorHost(held.mesh);
    const asked: string[][] = [];
    const door = wired(inspector);
    const watched: RemoteInspect = {
      ...door,
      read: (name, args = []) => {
        if (name === "snapshot")
          // SAFETY: a `snapshot` read's one argument is the list of names the window wants
          asked.push(args[0] as string[]);
        return door.read(name, args);
      },
    };
    const source = await createRemoteSource({ inspect: watched, syncOf: () => undefined });
    source.links(); // one panel drew links; nothing drew grants or timings
    const moved: string[][] = [];
    source.onChange((channels) => moved.push([...channels].sort()));

    // SAFETY: the source's fold handler reads nothing off the batch; it sets a bit in a set
    held.folds.emit({ writeTables: new Set(), writeKeys: new Map() } as never);
    await tick();
    await tick();
    await tick();

    expect(asked).toEqual([["links"]]);
    expect(moved).toEqual([["fold"]]);
    source.close();
  });

  test("a window with no controls open still learns what another window held", async () => {
    const held = harness();
    const over = forcing();
    const inspector = createInspectorHost(withControls(held.mesh, over));
    const first = createRemoteControls({ inspect: wired(inspector) });
    const second = createRemoteControls({ inspect: wired(inspector) });
    await tick();

    const seen: number[] = [];
    second.onChange(() => seen.push(second.forced().length));
    const done = await first.force("lan", "radio-off");
    await tick();

    expect(done.isOk()).toBe(true);
    expect(second.forced()).toEqual([{ name: "lan", as: "radio-off" }]);
    expect(seen).toEqual([1]);
    expect(over.list()).toEqual([{ name: "lan", as: "radio-off" }]);
  });

  test("a closed window answers what it last knew rather than taking the panel down", async () => {
    const held = harness();
    const source = await remote(createInspectorHost(held.mesh));
    const before = source.links().self;
    source.close();
    // one more frame can render after the shell lets go; a reader that answered `undefined`
    // there would throw inside a panel body instead of drawing a reading a second old
    expect(source.links().self).toBe(before);
  });

  test("the stranded audit crosses the port, and an empty one is an answer not a silence", async () => {
    const held = harness();
    const source = await remote(createInspectorHost(held.mesh));
    // required on the contract, so the window never has to guess whether the host can answer:
    // a source allowed to be absent here would read exactly like a device with nothing stranded
    const clean = await source.stranded();
    expect(clean.isOk() ? clean.value : "refused").toEqual([]);
    source.close();
  });

  test("a run this device can never sign for arrives as rows, not as a class", async () => {
    const held = harness();
    const fields = {
      author: NEAR,
      count: 86,
      from: THREE,
      to: SEVEN,
      message: "86 event(s) can never be sent",
    };
    const inspector = createInspectorHost(
      withRecovery(held.mesh, () => Promise.resolve(Result.ok([new StrandedWrites(fields)]))),
    );
    const source = await remote(inspector);
    const audited = await source.stranded();
    // the engine answers with `StrandedWrites`, which is a `TaggedError` and therefore a class,
    // and a class does not survive `structuredClone`. The contract carries fields for exactly
    // that reason; a source that passed the error along would arrive here as an empty husk
    expect(audited.isOk() ? audited.value : []).toEqual([fields]);
    source.close();
  });

  test("a refusal keeps its tag across the port", async () => {
    const held = harness();
    const inspector = createInspectorHost(withControls(held.mesh, forcing()));
    const controls = createRemoteControls({ inspect: wired(inspector) });
    const refused = await controls.release("nowhere");
    expect(refused.isErr()).toBe(true);
    expect(refused.isErr() ? refused.error._tag : "").toBe("ControlRefused");
    expect(refused.isErr() ? refused.error.transport : "").toBe("nowhere");
  });
});
