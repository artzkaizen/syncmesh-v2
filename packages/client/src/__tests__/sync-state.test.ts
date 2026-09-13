import { createMesh } from "@syncmesh/client";
import { parsePeerId, type RowKey, type SeqNum, type TableName } from "@syncmesh/kernel";
import { syncSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

const book = sqliteTable("book", { id: text().primaryKey(), title: text().notNull() });

const schema = syncSchema({
  partitions: { org: {} },
  roles: { org: ["owner", "member"] },
  tables: {
    book: {
      columns: { id: t.text().primaryKey(), title: t.text() },
      partition: "org",
      allow: ({ role }) => ({ $default: role("member") }),
    },
  },
});

const issuer = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 11 + i)).unwrap();
const device = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 60 + i)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const ACME = "org:acme";
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test fixtures: the brands are the table and key this file's own schema declares */
const BOOK = "book" as TableName;
const rowKey = (key: string) => key as RowKey;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

const open = async () => {
  const mesh = (
    await createMesh({
      schema,
      identity: device,
      issuer: issuer.peerId,
      driver: bunSqliteDriver(":memory:"),
      now: () => T0,
    })
  ).unwrap();
  mesh.grants
    .register(
      issueGrant(issuer, {
        account: "acct_me",
        device: device.peerId,
        role: "member",
        // SAFETY: a test fixture instance in the documented kind:id form
        partitions: [ACME] as never,
        validFor: Temporal.Duration.from({ hours: 1 }),
        now: T0,
      }),
    )
    .unwrap();
  return mesh;
};

describe("mesh.syncOf", () => {
  test("a row this device wrote is local until a peer's cursors cover its event", async () => {
    const mesh = await open();
    const handle = mesh.on(ACME).unwrap();
    await handle.db.insert(book).values({ id: "b1", title: "Dune" });

    expect(mesh.syncOf(BOOK, rowKey("b1"))).toBe("local");

    // a peer says it holds everything this device has authored
    const peer = parsePeerId("a".repeat(64)).unwrap();
    // SAFETY: a sequence number this device has reached; zero is the floor before any write
    const none = 0 as SeqNum;
    const mine = mesh.engine.coverage().synced.get(device.peerId) ?? none;
    mesh.engine.acknowledge(peer, new Map([[device.peerId, mine]]), T0);

    expect(mesh.syncOf(BOOK, rowKey("b1"))).toBe("delivered");
    await mesh.stop();
  });

  test("a row another peer wrote is remote — delivery is not this device's question", async () => {
    const mine = await open();
    const theirs = (
      await createMesh({
        schema,
        identity: issuer, // a second device, with its own key
        issuer: issuer.peerId,
        driver: bunSqliteDriver(":memory:"),
        now: () => T0,
      })
    ).unwrap();
    const grant = issueGrant(issuer, {
      account: "acct_them",
      device: issuer.peerId,
      role: "member",
      // SAFETY: a test fixture instance in the documented kind:id form
      partitions: [ACME] as never,
      validFor: Temporal.Duration.from({ hours: 1 }),
      now: T0,
    });
    theirs.grants.register(grant).unwrap();
    // the receiver admits an author it can vouch for: the grant travels ahead of the events
    mine.grants.register(grant).unwrap();
    await theirs.on(ACME).unwrap().db.insert(book).values({ id: "b9", title: "Ubik" });

    // hand their events over the way a transport would
    const events = (await theirs.engine.eventsSince(new Map())).unwrap();
    for (const entry of events) (await mine.engine.receive(entry)).unwrap();

    expect(mine.syncOf(BOOK, rowKey("b9"))).toBe("remote");
    await theirs.stop();
    await mine.stop();
  });

  test("a row nobody wrote has no answer", async () => {
    const mesh = await open();
    expect(mesh.syncOf(BOOK, rowKey("missing"))).toBeUndefined();
    await mesh.stop();
  });
});
