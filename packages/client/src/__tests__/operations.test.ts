import { correct, createLink } from "@syncmesh/engine";
import { parsePartitionKey, type ColumnName, type RowKey, type TableName } from "@syncmesh/kernel";
import { defineSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver, defaultStore } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MeshGrants } from "../grants.js";

import { createMesh } from "../mesh.js";

const notes = sqliteTable("notes", { id: text().primaryKey(), body: text().notNull() });
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test fixtures in their documented forms */
const NOTES = "notes" as TableName;
const N1 = "n1" as RowKey;
const BODY = "body" as ColumnName;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */
const schema = () =>
  defineSchema({
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

describe("the write ledger", () => {
  test("a write records an operation; a peer's acknowledgement becomes a durable receipt", async () => {
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
    const a = await open(deviceA);
    const b = await open(deviceB);

    const handle = a.on("org:acme").unwrap();
    await handle.db.insert(notes).values({ id: "n1", body: "hello" });

    const ledger = a.operations ?? panicNoLedger();
    const pending = (await ledger.unsettled()).unwrap();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.label).toBe("notes.insert");
    expect(pending[0]?.status).toBe("applied");

    const link = createLink(a.engine, b.engine, { now: () => T0 });
    (await link.catchUp()).unwrap();
    await a.delivered();

    expect((await ledger.unsettled()).unwrap()).toHaveLength(0);
    const op = pending[0];
    const receipts = op === undefined ? [] : (await ledger.receiptsOf(op.peer, op.seq)).unwrap();
    expect(receipts.map((r) => r.holder)).toEqual([deviceB.peerId]);
    link.close();
    await a.stop();
    await b.stop();
  });

  test("a correction marks the displaced record superseded, reason attached", async () => {
    const mesh = (
      await createMesh({
        driver: bunSqliteDriver(":memory:"),
        schema: schema(),
        identity: deviceA,
        issuer: issuer.peerId,
        authority: deviceA.peerId, // this device plays the office, so its own correction folds
        now: () => T0,
      })
    ).unwrap();
    registerAll(mesh);
    const handle = mesh.on("org:acme").unwrap();
    await handle.db.insert(notes).values({ id: "n1", body: "priced wrong" });
    const ledger = mesh.operations ?? panicNoLedger();
    const op = (await ledger.unsettled()).unwrap()[0] ?? panicNoLedger();

    (
      await correct(
        mesh.engine,
        {
          event: `${String(op.peer)}-${String(op.seq)}`,
          table: NOTES,
          key: N1,
          reason: "below the floor",
          partition: parsePartitionKey("org:acme").unwrap(),
        },
        (tx) => tx.update(NOTES, N1, new Map([[BODY, "corrected"]])),
      )
    ).unwrap();

    const marked = (await ledger.get(op.id)).unwrap();
    expect(marked?.status).toBe("superseded");
    expect(marked?.correction?.reason).toBe("below the floor");
    await mesh.stop();
  });

  test("the record survives a restart: written in the commit, read back from disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "syncmesh-ops-"));
    const open = async () => {
      const tables = schema().entries.map((entry) => entry.table);
      const stores = (await defaultStore({ name: "ops", dir, tables })).unwrap();
      const mesh = (
        await createMesh({
          stores,
          schema: schema(),
          identity: deviceA,
          issuer: issuer.peerId,
          now: () => T0,
        })
      ).unwrap();
      registerAll(mesh);
      // `stores` stays the caller's: stop() leaves it open, so the lock is ours to release
      return { mesh, close: () => stores.close() };
    };

    const opened = await open();
    const handle = opened.mesh.on("org:acme").unwrap();
    await handle.db.insert(notes).values({ id: "n1", body: "durable" });
    const before = (await (opened.mesh.operations ?? panicNoLedger()).unsettled()).unwrap();
    expect(before).toHaveLength(1);
    await opened.mesh.stop();
    await opened.close();

    const reopened = await open();
    const after = (await (reopened.mesh.operations ?? panicNoLedger()).unsettled()).unwrap();
    expect(after.map((op) => op.label)).toEqual(["notes.insert"]);
    expect(after[0]?.id).toBe(before[0]?.id ?? "");
    await reopened.mesh.stop();
    await reopened.close();
  });
});

const panicNoLedger = () => {
  throw new Error("a durable mesh carries the ledger");
};
