import { createLink } from "@syncmesh/engine";
import { defineSchema, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { createMesh } from "../mesh.js";

const schema = () =>
  defineSchema({
    partitions: { org: {} },
    roles: { org: ["member"] },
    tables: {
      todos: {
        columns: { id: t.text().primaryKey(), title: t.text() },
        partition: "org",
        allow: ({ role }) => ({ $default: role("member") }),
      },
      drafts: { columns: { id: t.text().primaryKey(), body: t.text() }, partition: "local" },
    },
  });

const issuer = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 50 + i)).unwrap();
const deviceA = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 90 + i)).unwrap();
const deviceB = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 140 + i)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);

const granted = (device: typeof deviceA) => {
  const mesh = createMesh({
    schema: schema(),
    identity: device,
    issuer: issuer.peerId,
    now: () => T0,
  });
  for (const [d, account] of [
    [deviceA, "acct_a"],
    [deviceB, "acct_b"],
  ] as const) {
    mesh.grants
      .register(
        issueGrant(issuer, {
          account,
          device: d.peerId,
          role: "member",
          // SAFETY: test fixture instances in the documented kind:id form
          partitions: ["org:acme"] as never,
          validFor: Temporal.Duration.from({ hours: 1 }),
          now: T0,
        }),
      )
      .unwrap();
  }
  mesh.activate("org:acme").unwrap();
  return mesh;
};

describe("delivered — a peer is known to hold the write", () => {
  test("resolves after a cursor exchange covers the write; nothing written resolves at once", async () => {
    const a = granted(deviceA);
    const b = granted(deviceB);
    await a.delivered(); // nothing synced yet — nothing to wait for

    (await a.todos.create({ id: "t1", title: "x" })).unwrap();
    const pending = a.delivered({ to: deviceB.peerId });
    let settled = false;
    void pending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false); // no exchange yet

    const link = createLink(a.engine, b.engine, { now: () => T0 });
    (await link.catchUp()).unwrap();
    await pending;
    expect(b.todos.get("t1")?.title).toBe("x");
    // already covered: a fresh call resolves immediately, with or without a named peer
    await a.delivered();
    await a.delivered({ to: deviceB.peerId });
    link.close();
  });

  test("a tx receipt names its event; delivered({ event }) waits for exactly that write", async () => {
    const a = granted(deviceA);
    const b = granted(deviceB);
    const receipt = (
      await a.tx((c) => c.todos.create({ id: "t1", title: "from tx" }).map(() => undefined))
    ).unwrap();
    const pending = a.delivered({ event: receipt.eventId, to: deviceB.peerId });
    const link = createLink(a.engine, b.engine, { now: () => T0 });
    (await link.catchUp()).unwrap();
    await pending;
    expect(b.todos.get("t1")?.title).toBe("from tx");
    link.close();
  });

  test("a local event never leaves this device: delivered({ event }) refuses it", async () => {
    const a = granted(deviceA);
    const receipt = (
      await a.tx((c) => c.drafts.create({ id: "d1", body: "wip" }).map(() => undefined))
    ).unwrap();
    expect(() => a.delivered({ event: receipt.eventId })).toThrow("never leaves this device");
  });
});
