import { describe, expect, test } from "bun:test";

import type { DevtoolsChannel } from "../contract.js";

import { createMeshSource } from "../source/mesh-source.js";
import { AT, NEAR, THREE, harness, tick } from "./readable-mesh.js";

describe("the mesh source", () => {
  test("takes three engine subscriptions for the whole devtool, plus telemetry and links", () => {
    const held = harness();
    const source = createMeshSource(held.mesh);
    expect(held.folds.live()).toBe(1);
    expect(held.acks.live()).toBe(1);
    expect(held.parked.live()).toBe(1);
    expect(held.telemetry.live()).toBe(1);
    expect(held.linkEvents.live()).toBe(1);
    source.close();
  });

  test("close lets go of every one of them", () => {
    const held = harness();
    createMeshSource(held.mesh).close();
    for (const hub of [held.folds, held.acks, held.parked, held.telemetry, held.linkEvents])
      expect(hub.live()).toBe(0);
    for (const hub of [held.routes, held.registered, held.forgotten, held.auth])
      expect(hub.live()).toBe(0);
  });

  test("each hub moves its own channel, coalesced into one notification", async () => {
    const held = harness();
    const source = createMeshSource(held.mesh);
    const seen: ReadonlySet<DevtoolsChannel>[] = [];
    source.onChange((moved) => void seen.push(moved));
    held.folds.emit({
      source: "local",
      eventCount: 1,
      writeTables: new Set(),
      writeKeys: new Map(),
    });
    held.acks.emit(NEAR);
    held.routes.emit();
    await tick();
    expect(seen).toEqual([new Set(["fold", "ack", "route"])]);
    source.close();
  });

  test("a link ending is kept, because it is the one fact that is not a snapshot", async () => {
    const held = harness();
    const source = createMeshSource(held.mesh);
    source.onChange(() => undefined);
    held.linkEvents.emit({
      kind: "refused",
      transport: "lan",
      peer: NEAR,
      why: "the door",
      at: AT,
    });
    await tick();
    const { recent, tally } = source.links();
    expect(recent).toHaveLength(1);
    expect(recent[0]?.why).toBe("the door");
    expect(tally).toEqual([{ transport: "lan", kind: "refused", count: 1 }]);
    source.close();
  });

  test("a medium carries what only its own hub can say, and its declared cap and priority", () => {
    const held = harness();
    const source = createMeshSource(held.mesh);
    const [lan] = source.overview().mediums;
    expect(lan?.name).toBe("lan");
    expect(lan?.maxLinks).toBe(8);
    expect(lan?.priority).toBe(2);
    // never spoken yet: "cannot say", which is not the same fact as "down"
    expect(lan?.online).toBeUndefined();
    expect(held.watching()).toBe(1);
    source.close();
  });

  test("a mesh over a bare event store says so by leaving the SQL surfaces absent", () => {
    const held = harness();
    const source = createMeshSource(held.mesh);
    expect(source.storage).toBeUndefined();
    expect(source.writes).toBeUndefined();
    expect(source.sql).toBeUndefined();
    source.close();
  });

  test("the acknowledgement keeps its stamp, which `acks()` throws away", () => {
    const held = harness();
    const source = createMeshSource(held.mesh);
    const [ack] = source.sync().acks;
    expect(ack?.peer).toBe(NEAR);
    expect(ack?.at).toBe(AT);
    expect(ack?.ours).toBe(THREE);
    source.close();
  });
});
