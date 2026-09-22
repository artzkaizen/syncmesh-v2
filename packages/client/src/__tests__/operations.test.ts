import type { OperationRow } from "@syncmesh/storage";

import { correct, createLink } from "@syncmesh/engine";
import {
  parsePartitionKey,
  type ColumnName,
  type PeerId,
  type RowKey,
  type SeqNum,
  type TableName,
} from "@syncmesh/kernel";
import { syncSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver, defaultStore } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { linkTransport, loopbackPair, type LoopbackControl } from "@syncmesh/transport";
import { createIdentity, issueGrant } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
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

/** One registered device on an in-memory store; `authority` is for the tests that play the office. */
const soloMesh = async (extra: { readonly authority?: PeerId } = {}) => {
  const mesh = (
    await createMesh({
      driver: bunSqliteDriver(":memory:"),
      schema: schema(),
      identity: deviceA,
      issuer: issuer.peerId,
      now: () => T0,
      ...extra,
    })
  ).unwrap();
  registerAll(mesh);
  return mesh;
};

/** Ends a wait that should not have needed waiting: a notification that never comes is the bug. */
const timeout = (ms: number) =>
  new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms));

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

  test("an in-process link acknowledges and signs nothing: settled, still sole custody", async () => {
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
    await a.on("org:acme").unwrap().db.insert(notes).values({ id: "n1", body: "hello" });

    const link = createLink(a.engine, b.engine, { now: () => T0 });
    (await link.catchUp()).unwrap();
    await a.delivered();

    const ledger = a.operations ?? panicNoLedger();
    // the weaker tier is satisfied by a cursor, and an in-process link is cursors and nothing else
    expect((await ledger.unsettled()).unwrap()).toHaveLength(0);
    // the stronger one is not, and must not be: nobody signed, so nothing here licenses a wipe
    expect((await ledger.soleCustody()).unwrap()).toHaveLength(1);
    link.close();
    await a.stop();
    await b.stop();
  });

  test("over a real link the holder signs, and the write leaves sole custody", async () => {
    const { a: sideA, b: sideB, control } = loopbackPair();
    const open = async (device: typeof deviceA, name: string, link: typeof sideA) => {
      const mesh = (
        await createMesh({
          driver: bunSqliteDriver(":memory:"),
          schema: schema(),
          identity: device,
          issuer: issuer.peerId,
          now: () => T0,
          transports: [linkTransport(name, () => link)],
        })
      ).unwrap();
      registerAll(mesh);
      return mesh;
    };
    const a = await open(deviceA, "loopback:a", sideA);
    const b = await open(deviceB, "loopback:b", sideB);
    await a.on("org:acme").unwrap().db.insert(notes).values({ id: "n1", body: "hello" });

    const settle = async (control: LoopbackControl) => {
      for (let round = 0; round < 12; round += 1) {
        await control.flush();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    };
    await settle(control);

    const ledger = a.operations ?? panicNoLedger();
    // SAFETY: this device's first write, so its event is sequence 1 — a branded integer
    const record = (await ledger.byEvent(deviceA.peerId, 1 as SeqNum)).unwrap();
    expect(record).toBeDefined();
    expect((await ledger.soleCustody()).unwrap()).toHaveLength(0);

    const vouches =
      record === undefined ? [] : (await ledger.vouchesOf(record.peer, record.seq)).unwrap();
    expect(vouches.map((v) => v.holder)).toEqual([deviceB.peerId]);
    // the lineage is the store's own, minted on its first boot: present, and B's rather than ours
    expect(vouches[0]?.incarnation).toMatch(/^[0-9a-f]{64}$/);
    await a.stop();
    await b.stop();
  });

  test("a local commit notifies the ledger, once per write", async () => {
    const mesh = await soloMesh();
    const handle = mesh.on("org:acme").unwrap();
    const ledger = mesh.operations ?? panicNoLedger();
    let notified = 0;
    const off = ledger.onChange(() => {
      notified += 1;
    });

    await handle.db.insert(notes).values({ id: "n1", body: "hello" });
    expect(notified).toBe(1);
    await handle.db.insert(notes).values({ id: "n2", body: "again" });
    expect(notified).toBe(2);

    // an update is a write like any other: one record, one notification
    await handle.db.update(notes).set({ body: "hello again" }).where(eq(notes.id, "n1"));
    expect(notified).toBe(3);

    off();
    await handle.db.insert(notes).values({ id: "n3", body: "unheard" });
    expect(notified).toBe(3);
    await mesh.stop();
  });

  test("a listener waiting on an id sees the record the write is about to create", async () => {
    const mesh = await soloMesh();
    const handle = mesh.on("org:acme").unwrap();
    const ledger = mesh.operations ?? panicNoLedger();

    // the id is in hand before the commit, which is the whole reason a UI can watch for it
    const id = crypto.randomUUID();
    expect((await ledger.get(id)).unwrap()).toBeUndefined();
    let resolve: (row: OperationRow | undefined) => void = () => undefined;
    const appeared = new Promise<OperationRow | undefined>((settle) => {
      resolve = settle;
    });
    const off = ledger.onChange(() => {
      void ledger.get(id).then((row) => resolve(row.unwrapOr(undefined)));
    });

    await handle.under({ id }, async () => {
      await handle.db.insert(notes).values({ id: "n1", body: "in flight" });
    });

    const record = await Promise.race([appeared, timeout(1000)]);
    expect(record?.id).toBe(id);
    expect(record?.label).toBe("notes.insert");
    expect(record?.status).toBe("applied");
    off();
    await mesh.stop();
  });

  test("a correction marks the displaced record superseded, reason attached", async () => {
    // this device plays the office, so its own correction folds
    const mesh = await soloMesh({ authority: deviceA.peerId });
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
