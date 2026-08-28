import { correct, revokeDevice, setPolicy } from "@syncmesh/engine";
import {
  parsePartitionKey,
  type ColumnName,
  type EventId,
  type RowKey,
  type TableName,
} from "@syncmesh/kernel";
import { allow, role } from "@syncmesh/policy";
import { defineSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { createMesh } from "../mesh.js";

const schema = () =>
  defineSchema({
    partitions: { org: {} },
    roles: { org: ["member"] },
    tables: {
      notes: {
        columns: { id: t.text().primaryKey(), body: t.text() },
        partition: "org",
        allow: ({ role: r }) => ({ $default: r("member") }),
      },
    },
  });

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- the manifest's own names, in a test fixture */
const NOTES = "notes" as TableName;
const N1 = "n1" as RowKey;
const column = (name: string) => name as ColumnName;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

const seed = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => n + i);
const ISSUER = createIdentity(seed(1)).unwrap();
const PHONE = createIdentity(seed(90)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
// SAFETY: an event id is opaque text; this one names a write no peer here ever made
const EVENT = "evt-1" as EventId;
const ACME = parsePartitionKey("org:acme").unwrap();

/** The authority, holding the ordinary grant it needs to write the reserved tables at all. */
const governing = async () => {
  const mesh = (
    await createMesh({
      driver: bunSqliteDriver(":memory:"),
      schema: schema(),
      identity: ISSUER,
      issuer: ISSUER.peerId,
      issuerKey: ISSUER,
      authority: ISSUER.peerId,
      now: () => T0,
    })
  ).unwrap();
  mesh.grants
    .issue({
      account: "acct_a",
      device: ISSUER.peerId,
      role: "member",
      partitions: ["org:acme"],
      validFor: Temporal.Duration.from({ hours: 1 }),
    })
    .unwrap();
  return mesh;
};

describe("mesh.internal — the machinery, kept out of your namespace", () => {
  test("the reserved tables are named here and nowhere in what `on()` hands you", async () => {
    const mesh = await governing();
    expect([...mesh.internal.tables].sort()).toEqual([
      "_cdc",
      "_corrections",
      "_links",
      "_policy",
      "_revocations",
    ]);
    // the namespace test this surface exists for: three separate features leaked a reserved
    // table into the app's own before it had a door of its own. Nothing here is a convention —
    // a manifest cannot name one of these at all, so the two namespaces cannot meet
    const mine = schema().entries.map((e) => String(e.table.name));
    for (const reserved of mesh.internal.tables) {
      expect(mine).not.toContain(reserved);
      expect(() =>
        defineSchema({
          partitions: { org: {} },
          roles: { org: ["member"] },
          tables: { [reserved]: { columns: { id: t.text().primaryKey() } } },
        }),
      ).toThrow(/reserved/);
    }
    await mesh.stop();
  });

  test("a table that is not reserved is a mistake at the door, not an empty answer", async () => {
    const mesh = await governing();
    expect(() => mesh.internal.rows("notes")).toThrow(/not a reserved table/);
    await mesh.stop();
  });

  test("`_policy` reads back the rules this instance is actually running", async () => {
    const mesh = await governing();
    expect(mesh.internal.policy("org:acme")).toBeUndefined();
    const doc = { notes: { $default: role("member"), read: allow } };
    (await setPolicy(mesh.engine, ACME, doc)).unwrap();
    const row = mesh.internal.policy("org:acme");
    expect(row?.get(column("id"))).toBe("org:acme");
    // through JSON, because that is what a json column's cell is: the doc as data, not an AST
    expect(JSON.parse(JSON.stringify(row?.get(column("rules"))))).toEqual(
      JSON.parse(JSON.stringify(doc)),
    );
    // and the raw door reaches the same row, which is what makes `_cdc` readable with no reader
    expect(mesh.internal.rows("_policy").size).toBe(1);
    await mesh.stop();
  });

  test("corrections, revocations and links are the engine's own readers, gathered", async () => {
    const mesh = await governing();
    const handle = mesh.on("org:acme").unwrap();
    await handle.db.run("insert into notes (id, body, _partition) values ('n1','one','org:acme')");
    const wrote = (
      await correct(
        mesh.engine,
        { event: "evt-1", table: NOTES, key: N1, reason: "OVER_CAP", partition: ACME },
        (tx) => tx.update(NOTES, N1, new Map([[column("body"), "fixed"]])),
      )
    ).unwrap();
    expect(wrote.changes.length).toBe(2);

    expect(mesh.internal.corrections.all().map((c) => c.reason)).toEqual(["OVER_CAP"]);
    // one object, not two readers: the shortcut and the door must never answer differently
    expect(mesh.corrections).toBe(mesh.internal.corrections);
    expect(mesh.internal.corrections.forEvent(EVENT).length).toBe(1);
    expect(mesh.internal.corrections.mine().length).toBe(0); // "evt-1" is nobody's id here

    (
      await revokeDevice(mesh.engine, { device: PHONE.peerId, partition: ACME, reason: "stolen" })
    ).unwrap();
    expect(mesh.internal.revocations().map((r) => r.reason)).toEqual(["stolen"]);
    expect(mesh.internal.rows("_revocations").size).toBe(1);
    expect(mesh.internal.links()).toEqual([]); // no account has vouched for anything here
    await mesh.stop();
  });
});
