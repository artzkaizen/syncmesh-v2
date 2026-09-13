import { defineSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";

import { createClient, mutation, query, sqlite } from "../index.js";

const products = sqliteTable("products", { id: text().primaryKey(), name: text().notNull() });

const schema = defineSchema({
  partitions: { shop: {} },
  roles: { shop: ["editor", "viewer"] },
  tables: {
    products: {
      columns: { id: t.text().primaryKey(), name: t.text() },
      partition: "shop",
      allow: ({ role }) => ({ read: role("viewer"), $default: role("editor") }),
    },
  },
});

const procedures = {
  products: {
    list: query.handler(({ db }) => db.select().from(products)),
    create: mutation
      .input(z.object({ shopId: z.string(), id: z.string(), name: z.string().min(1) }))
      .handler(async ({ input, db }) => {
        await db.insert(products).values(input);
        return input;
      }),
  },
};

const issuer = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 50 + i)).unwrap();
const device = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 90 + i)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);

const grant = (role: "editor" | "viewer") =>
  issueGrant(issuer, {
    account: "acct",
    device: device.peerId,
    role,
    // SAFETY: a test fixture instance in the documented kind:id form
    partitions: ["shop:lagos"] as never,
    validFor: Temporal.Duration.from({ hours: 1 }),
    now: T0,
  });

const open = async () =>
  createClient({
    schema,
    procedures,
    identity: device,
    trust: { issuer: issuer.peerId },
    storage: sqlite({ driver: bunSqliteDriver(":memory:") }),
    now: () => T0,
  });

describe(".can — the real check, rehearsed (book ch. 15)", () => {
  test("a viewer's rehearsal refuses with the rule's own verdict, and writes nothing", async () => {
    const client = await open();
    client.$grants.register(grant("viewer")).unwrap();

    const rehearsed = await client.products.create
      .can({ shopId: "lagos", id: "p1", name: "Desk lamp" })
      .run();
    expect(rehearsed.isErr()).toBe(true);
    const refusal = rehearsed.match({ ok: () => undefined, err: (e) => e });
    expect(refusal !== undefined && "_tag" in refusal && refusal._tag).toBe("PolicyDenied");

    // the real write agrees, because it is the same ladder — this is the no-drift claim
    const written = await client.products.create({ shopId: "lagos", id: "p1", name: "Desk lamp" })
      .committed;
    expect(written.isErr()).toBe(true);
    expect(await client.products.list().run()).toEqual([]);
    await client.$close();
  });

  test("an editor's rehearsal allows — and still leaves the table untouched", async () => {
    const client = await open();
    client.$grants.register(grant("editor")).unwrap();

    const rehearsed = await client.products.create
      .can({ shopId: "lagos", id: "p1", name: "Desk lamp" })
      .run();
    expect(rehearsed.isOk()).toBe(true);
    // the rehearsal ran the handler against the replica and rolled it back: nothing happened
    expect(await client.products.list().run()).toEqual([]);

    (
      await client.products.create({ shopId: "lagos", id: "p1", name: "Desk lamp" }).committed
    ).unwrap();
    expect(await client.products.list().run()).toEqual([{ id: "p1", name: "Desk lamp" }]);
    await client.$close();
  });

  test("the descriptor is inert and identity-keyed: building one runs nothing", async () => {
    const client = await open();
    client.$grants.register(grant("editor")).unwrap();
    const first = client.products.create.can({ shopId: "lagos", id: "p1", name: "one" });
    const same = client.products.create.can({ shopId: "lagos", id: "p1", name: "one" });
    const other = client.products.create.can({ shopId: "lagos", id: "p2", name: "two" });

    expect(first.key).toBe(same.key);
    expect(first.key).not.toBe(other.key);
    expect(first.path).toBe("products.create");
    expect(await client.products.list().run()).toEqual([]); // built three, ran none
    await client.$close();
  });
});
