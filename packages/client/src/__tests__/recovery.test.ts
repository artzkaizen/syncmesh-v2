import { createLink } from "@syncmesh/engine";
import { defineSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

import { createMesh } from "../mesh.js";

const notes = sqliteTable("notes", { id: text().primaryKey(), body: text().notNull() });
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

const grantFor = (device: typeof deviceA) =>
  issueGrant(issuer, {
    account: "acct",
    device: device.peerId,
    role: "member",
    // SAFETY: test fixture instances in the documented kind:id form
    partitions: ["org:acme"] as never,
    validFor: Temporal.Duration.from({ hours: 1 }),
    now: T0,
  });

const open = async (device: typeof deviceA) =>
  (
    await createMesh({
      driver: bunSqliteDriver(":memory:"),
      schema: schema(),
      identity: device,
      issuer: issuer.peerId,
      now: () => T0,
    })
  ).unwrap();

describe("recovery — stuck is a stable cause, not a spinner", () => {
  test("an ungranted author parks as missing-capability; the grant plus run folds it", async () => {
    const a = await open(deviceA);
    const b = await open(deviceB);
    a.grants.register(grantFor(deviceA)).unwrap();
    b.grants.register(grantFor(deviceB)).unwrap();
    // b deliberately never learns a's grant, so a's event cannot be admitted there

    const handle = a.on("org:acme").unwrap();
    await handle.db.insert(notes).values({ id: "n1", body: "hello" });
    const link = createLink(a.engine, b.engine, { now: () => T0 });
    (await link.catchUp()).unwrap();

    const issues = b.recovery.list();
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe("missing-capability");
    expect(issues[0]?.verdict).toBe("NoGrant");
    expect(issues[0]?.author).toBe(deviceA.peerId);

    b.grants.register(grantFor(deviceA)).unwrap();
    (await b.recovery.run()).unwrap();
    expect(b.recovery.list()).toHaveLength(0);
    const hb = b.on("org:acme").unwrap();
    expect(await hb.db.select().from(notes)).toHaveLength(1);

    link.close();
    await a.stop();
    await b.stop();
  });
});
