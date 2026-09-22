import { ladder, partition, syncSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";

import { createClient, mutation, query, sqlite } from "../index.js";

const notes = sqliteTable("notes", { id: text().primaryKey(), body: text().notNull() });

const org = partition("org", { roles: ladder("member") });
const schema = syncSchema({
  tables: {
    notes: {
      columns: { id: t.text().primaryKey(), body: t.text() },
      partition: org,
      allow: ({ role }) => ({ $default: role("member") }),
    },
  },
});

const procedures = {
  notes: {
    list: query.handler(({ db }) => db.select().from(notes)),
    add: mutation
      .input(z.object({ orgId: z.string(), id: z.string(), body: z.string().min(1) }))
      .handler(async ({ input, db }) => {
        await db.insert(notes).values(input);
        return input;
      }),
  },
};

const issuer = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 50 + i)).unwrap();
const device = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 90 + i)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);

const panicNoLedger = () => {
  throw new Error("a durable client carries the ledger");
};

const open = async () => {
  const client = createClient({
    schema,
    procedures,
    identity: device,
    trust: { issuer: issuer.peerId },
    storage: sqlite({ driver: bunSqliteDriver(":memory:") }),
    now: () => T0,
  });
  await client.$ready;
  client.$grants
    .register(
      issueGrant(issuer, {
        account: "acct",
        device: device.peerId,
        role: "member",
        // SAFETY: a test fixture instance in the documented kind:id form
        partitions: ["org:acme"] as never,
        validFor: Temporal.Duration.from({ hours: 1 }),
        now: T0,
      }),
    )
    .unwrap();
  return client;
};

describe("a write is a statement (book ch. 10)", () => {
  test("the id is in hand before the commit, and it opens the record afterwards", async () => {
    const client = await open();
    const write = client.notes.add({ orgId: "acme", id: "n1", body: "hello" });

    // synchronously, before anything committed: what an interrupted caller looks up
    expect(write.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(write.status()).toBeUndefined();

    (await write.committed).unwrap();
    const record = (await (client.$operations ?? panicNoLedger()).get(write.id)).unwrap();
    expect(record?.id).toBe(write.id);
    // the procedure, not the SQL it turned into. The proxy that captures the write is handed a
    // statement and nothing about who asked for it, so left to itself it would record
    // `notes.insert` — the name of a table and a verb, for something a person called `notes.add`.
    // The path is oRPC's to know and it says so on the way down.
    expect(record?.label).toBe("notes.add");
    await client.$close();
  });

  test("the bare statement is the blessed form: it is not thenable", async () => {
    const client = await open();
    const write = client.notes.add({ orgId: "acme", id: "n1", body: "hello" });
    // awaiting the handle itself yields the handle — which is why `committed` has to be named
    expect(await write).toBe(write);
    expect("then" in write).toBe(false);

    (await write.committed).unwrap();
    expect(await client.notes.list().run()).toEqual([{ id: "n1", body: "hello" }]);
    await client.$close();
  });

  test("a write the input schema refuses commits nothing, and opens no record", async () => {
    const client = await open();
    const refused = client.notes.add({ orgId: "acme", id: "n2", body: "" });

    const settled = await refused.committed;
    expect(settled.isErr()).toBe(true);
    // no commit, no operation row: there is no journey to ask about
    expect(refused.status()).toBeUndefined();
    expect(
      (await (client.$operations ?? panicNoLedger()).get(refused.id)).unwrap(),
    ).toBeUndefined();
    await client.$close();
  });

  test("custody is read from the ledger, never asked for at the call site (D27)", async () => {
    const client = await open();
    const write = client.notes.add({ orgId: "acme", id: "n1", body: "hello" });
    const { eventId } = (await write.committed).unwrap();

    // the handle offers nothing to await past the commit: no milestone, no copy count
    expect("waitFor" in write).toBe(false);

    const ledger = client.$operations ?? panicNoLedger();
    const [peer, seq] = eventId.split("-");
    // SAFETY: an event id is `<author>-<seq>`, both halves written by this device's own commit
    const receipts = (await ledger.receiptsOf(peer as never, Number(seq) as never)).unwrap();
    expect(receipts).toHaveLength(0);

    // and the reading that replaces the count: nobody has told this device they hold it
    const unsettled = (await ledger.unsettled()).unwrap();
    expect(unsettled.map((op) => op.id)).toEqual([write.id]);
    await client.$close();
  });
});
