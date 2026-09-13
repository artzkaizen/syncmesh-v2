import { defineSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";

import { createClient, mutation, query, sqlite } from "../index.js";

const notes = sqliteTable("notes", { id: text().primaryKey(), body: text().notNull() });

const schema = defineSchema({
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
  const client = await createClient({
    schema,
    procedures,
    identity: device,
    trust: { issuer: issuer.peerId },
    storage: sqlite({ driver: bunSqliteDriver(":memory:") }),
    now: () => T0,
  });
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

  test("waitFor(committed) settles once the record exists; a refused write cannot be waited on", async () => {
    const client = await open();
    const good = client.notes.add({ orgId: "acme", id: "n1", body: "hello" });
    const settled = await good.waitFor({ milestone: "committed" });
    expect(settled.unwrap().id).toBe(good.id);

    const refused = client.notes.add({ orgId: "acme", id: "n2", body: "" }); // the input schema refuses
    const waited = await refused.waitFor({ milestone: "committed" });
    const error = waited.match({ ok: () => undefined, err: (e) => e });
    expect(error?._tag).toBe("WaitUnreachable");
    await client.$close();
  });

  test("waiting for copies nobody signed expires, and says so without touching the write", async () => {
    const client = await open();
    const write = client.notes.add({ orgId: "acme", id: "n1", body: "hello" });
    (await write.committed).unwrap();

    const waited = await write.waitFor({
      milestone: "replicated",
      remoteCopies: 1,
      within: Temporal.Duration.from({ milliseconds: 30 }),
    });
    const error = waited.match({ ok: () => undefined, err: (e) => e });
    expect(error?._tag).toBe("WaitExpired");
    // the wait ended, not the write: the row is there and the record still reads applied
    expect(await client.notes.list().run()).toHaveLength(1);
    expect(write.status()?.status).toBe("applied");
    await client.$close();
  });
});
