import { createLink } from "@syncmesh/engine";
import { ladder, partition, syncSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import type { MeshGrants } from "../grants.js";

import { createMesh } from "../mesh.js";

const products = sqliteTable("products", {
  id: text().primaryKey(),
  stock: integer().notNull(),
});

const shop = partition("shop", { roles: ladder("member") });
const schema = () =>
  syncSchema({
    tables: {
      products: {
        columns: { id: t.text().primaryKey(), stock: t.integer({ merge: "counter" }) },
        partition: shop,
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
          partitions: ["shop:lagos-01"] as never,
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

describe("counter through the whole stack — the book's Tuesday (ch. 4)", () => {
  test("plain SQL sales on two devices apart fold to 21 on both", async () => {
    const a = await open(deviceA);
    const b = await open(deviceB);
    const ha = a.on("shop:lagos-01").unwrap();
    const hb = b.on("shop:lagos-01").unwrap();

    // Amara stocks the shelf; Bola learns of it before the radios drop
    await ha.db.insert(products).values({ id: "biro", stock: 24 });
    const first = createLink(a.engine, b.engine, { now: () => T0 });
    (await first.catchUp()).unwrap();
    first.close();
    expect((await hb.db.select().from(products))[0]?.stock).toBe(24);

    // apart: two sales, ordinary SQL — no increment API, the delta is OLD vs NEW
    await ha.db
      .update(products)
      .set({ stock: sql`${products.stock} - 2` })
      .where(eq(products.id, "biro"));
    await hb.db
      .update(products)
      .set({ stock: sql`${products.stock} - 1` })
      .where(eq(products.id, "biro"));

    // back in range: both directions, one exchange
    const second = createLink(a.engine, b.engine, { now: () => T0 });
    (await second.catchUp()).unwrap();
    second.close();

    // lww would have eaten a sale (22 or 23); the counter sums to 21 everywhere
    expect((await ha.db.select().from(products))[0]?.stock).toBe(21);
    expect((await hb.db.select().from(products))[0]?.stock).toBe(21);

    await a.stop();
    await b.stop();
  });
});
