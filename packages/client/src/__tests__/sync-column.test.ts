import { operationOf, syncOf } from "@syncmesh/drizzle";
import { createLink } from "@syncmesh/engine";
import { syncSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

import type { MeshGrants } from "../grants.js";

import { createMesh } from "../mesh.js";

const notes = sqliteTable("notes", { id: text().primaryKey(), body: text().notNull() });
const schema = () =>
  syncSchema({
    partitions: { org: {} },
    roles: { org: ["member"] },
    tables: {
      notes: {
        columns: { id: t.text().primaryKey(), body: t.text() },
        partition: "org",
        allow: ({ role }) => ({ $default: role("member") }),
      },
    },
  });

const issuer = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 50 + i)).unwrap();
const deviceA = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 90 + i)).unwrap();
const deviceB = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 140 + i)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);

const registerAll = (mesh: { readonly grants: Pick<MeshGrants, "register"> }) => {
  for (const [device, account] of [
    [deviceA, "acct_a"],
    [deviceB, "acct_b"],
  ] as const) {
    mesh.grants
      .register(
        issueGrant(issuer, {
          account,
          device: device.peerId,
          role: "member",
          // SAFETY: test fixture instances in the documented kind:id form
          partitions: ["org:acme"] as never,
          validFor: Temporal.Duration.from({ hours: 1 }),
          now: T0,
        }),
      )
      .unwrap();
  }
};

const open = async (device: typeof deviceA) => {
  const mesh = (
    await createMesh({
      driver: bunSqliteDriver(":memory:"),
      schema: schema(),
      identity: device,
      issuer: issuer.peerId,
      now: () => T0,
    })
  ).unwrap();
  registerAll(mesh);
  return mesh;
};

describe("syncOf — row state is a column, not a lookup (book ch. 10)", () => {
  test("a fresh write reads local, a peer's read remote, and an ack turns local into delivered", async () => {
    const a = await open(deviceA);
    const b = await open(deviceB);
    const ha = a.on("org:acme").unwrap();
    const hb = b.on("org:acme").unwrap();

    const listOn = (handle: typeof ha, self: typeof deviceA) =>
      handle.db.select({ id: notes.id, sync: syncOf(self.peerId, notes) }).from(notes);

    await ha.db.insert(notes).values({ id: "n1", body: "hello" });
    expect(await listOn(ha, deviceA)).toEqual([{ id: "n1", sync: "local" }]);

    const link = createLink(a.engine, b.engine, { now: () => T0 });
    (await link.catchUp()).unwrap();
    await a.delivered();

    // on b the row is somebody else's write: delivery is not b's question to answer
    expect(await listOn(hb, deviceB)).toEqual([{ id: "n1", sync: "remote" }]);
    // and on a the acknowledgement moved the watermark past it
    expect(await listOn(ha, deviceA)).toEqual([{ id: "n1", sync: "delivered" }]);

    link.close();
    await a.stop();
    await b.stop();
  });

  /**
   * **What a discarded state cache costs `$sync`, and in which direction.**
   *
   * `acked` is one row on the derived side — the highest stamp of this device's own writes any
   * peer has acknowledged — and RFC-0022 proposes throwing that side away whenever the schema
   * changes. It is the one table there that is *not* rebuilt by replaying the log: an
   * acknowledgement touches no row and leaves no event, so nothing in the log remembers it.
   *
   * So it is lost, and the answer to "is that acceptable" is that the loss only ever runs one
   * way. `syncOf` reads `delivered` from the existence of a watermark above the row's stamp; with
   * no watermark the `EXISTS` is false and the row reads `local`. A write that *had* been
   * confirmed reports as not-yet-confirmed — an understatement of progress, never an
   * overstatement, and never a claim that an undelivered write arrived.
   *
   * It heals, but not the way the obvious guess says. A bare cursor exchange does nothing: the
   * ledger pruned this write when it was first acknowledged, so there is no longer anything to
   * re-derive a watermark from. What restores it is the **next acknowledged write** — the
   * watermark is a single high mark, so one later stamp covers every earlier row behind it.
   *
   * On a device that is writing, that is the next few seconds. On one that only reads, its own
   * writes are all old and all correctly reported as delivered-unknown until it writes again.
   * That is the argument for accepting the loss rather than making acknowledgement evidence
   * durable so it can be rebuilt — and it is an argument, not an oversight, which is why it is
   * written down here instead of discovered later.
   */
  test("a discarded watermark reads delivered back as local, and never the other way", async () => {
    const a = await open(deviceA);
    const b = await open(deviceB);
    const ha = a.on("org:acme").unwrap();
    const listOn = () =>
      ha.db.select({ id: notes.id, sync: syncOf(deviceA.peerId, notes) }).from(notes);

    await ha.db.insert(notes).values({ id: "n1", body: "hello" });
    const link = createLink(a.engine, b.engine, { now: () => T0 });
    (await link.catchUp()).unwrap();
    await a.delivered();
    expect(await listOn()).toEqual([{ id: "n1", sync: "delivered" }]);

    // the derived side is thrown away, which is what a changed schema does to it
    await ha.db.run(sql`DELETE FROM syncmesh_acked`);
    expect(await listOn()).toEqual([{ id: "n1", sync: "local" }]);

    // a bare cursor exchange does *not* put it back: the ledger pruned this write when it was
    // first acknowledged, so there is nothing left to re-derive a watermark from
    (await link.catchUp()).unwrap();
    await a.delivered();
    expect(await listOn()).toEqual([{ id: "n1", sync: "local" }]);

    // the next acknowledged write does, and for the reason the watermark is one row: it is a high
    // mark, so a later stamp covers every earlier one behind it
    await ha.db.insert(notes).values({ id: "n2", body: "again" });
    (await link.catchUp()).unwrap();
    await a.delivered();
    expect(await listOn()).toEqual([
      { id: "n1", sync: "delivered" },
      { id: "n2", sync: "delivered" },
    ]);

    link.close();
    await a.stop();
    await b.stop();
  });

  test("operationOf is the join key into the ledger: the row names its own record", async () => {
    const a = await open(deviceA);
    const ha = a.on("org:acme").unwrap();
    await ha.db.insert(notes).values({ id: "n1", body: "hello" });

    const [row] = await ha.db.select({ id: notes.id, op: operationOf(notes) }).from(notes);
    const ledger = a.operations ?? undefined;
    const pending = (await (ledger ?? panicNoLedger()).unsettled()).unwrap();
    expect(row?.op).toBe(pending[0]?.id ?? "");
    // and it opens: the id the row carries reads back the record itself
    expect((await (ledger ?? panicNoLedger()).get(row?.op ?? "")).unwrap()?.label).toBe(
      "notes.insert",
    );
    await a.stop();
  });

  test("a query that selects no syncOf carries no sync column at all", async () => {
    const a = await open(deviceA);
    const ha = a.on("org:acme").unwrap();
    await ha.db.insert(notes).values({ id: "n1", body: "hello" });
    const rows = await ha.db.select().from(notes);
    expect(rows).toEqual([{ id: "n1", body: "hello" }]);
    expect("sync" in (rows[0] ?? {})).toBe(false);
    await a.stop();
  });
});

const panicNoLedger = () => {
  throw new Error("a durable mesh carries the ledger");
};
