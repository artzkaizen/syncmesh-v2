import { createLink } from "@syncmesh/engine";
import { ladder, partition, syncSchema, t, type ColumnsMap, type Schema } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

import { createMesh } from "../mesh.js";
import { sqlite } from "../options.js";

const notes = sqliteTable("notes", { id: text().primaryKey(), body: text().notNull() });
const org = partition("org", { roles: ladder("member") });
const schema = () =>
  syncSchema({
    tables: {
      notes: {
        columns: { id: t.text().primaryKey(), body: t.text() },
        partition: org,
        allow: ({ role }) => ({ $default: role("member") }),
      },
    },
  });

/** The build after `schema`'s: it dropped `notes` (D31), so the older build's writes to it park. */
const contracted = () =>
  syncSchema({
    schemaVersion: 3,
    dropped: ["notes"],
    tables: {
      memos: {
        columns: { id: t.text().primaryKey(), body: t.text() },
        partition: org,
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

const open = async <C extends ColumnsMap>(device: typeof deviceA, built: Schema<C>) =>
  (
    await createMesh({
      schema: built,
      identity: device,
      now: () => T0,
      storage: sqlite({ driver: bunSqliteDriver(":memory:") }),
      trust: { issuer: issuer.peerId },
    })
  ).unwrap();

describe("recovery — stuck is a stable cause, not a spinner", () => {
  test("an ungranted author parks as missing-capability; the grant plus run folds it", async () => {
    const a = await open(deviceA, schema());
    const b = await open(deviceB, schema());
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

    // the plan names the one thing that would move it, and says a retry is worth trying
    const stuck = issues[0];
    const plan = stuck === undefined ? undefined : b.recovery.explain(stuck.event);
    expect(plan?.retryWorthwhile).toBe(true);
    expect(plan?.next).toContain("grant");
    // and the author's own envelope comes back byte for byte, for the operator who must carry it
    expect(stuck === undefined ? undefined : b.recovery.export(stuck.event)).toBeInstanceOf(
      Uint8Array,
    );

    b.grants.register(grantFor(deviceA)).unwrap();
    (await b.recovery.run()).unwrap();
    expect(b.recovery.list()).toHaveLength(0);
    // nothing is stuck any more, so there is nothing to explain or hand over
    expect(stuck === undefined ? "x" : b.recovery.explain(stuck.event)).toBeUndefined();
    const hb = b.on("org:acme").unwrap();
    expect(await hb.db.select().from(notes)).toHaveLength(1);

    link.close();
    await a.stop();
    await b.stop();
  });

  test("a write to a table this build dropped names the remedy: upgrade the author (D31)", async () => {
    const a = await open(deviceA, schema());
    const b = await open(deviceB, contracted());
    for (const mesh of [a, b]) {
      mesh.grants.register(grantFor(deviceA)).unwrap();
      mesh.grants.register(grantFor(deviceB)).unwrap();
    }
    await a.on("org:acme").unwrap().db.insert(notes).values({ id: "n1", body: "old build" });
    const link = createLink(a.engine, b.engine, { now: () => T0 });
    (await link.catchUp()).unwrap();

    const [stuck] = b.recovery.list();
    expect(stuck?.verdict).toBe("TableDropped");
    expect(b.engine.quarantine().map((p) => p.reason)).toEqual(["dropped-table"]);
    const plan = stuck === undefined ? undefined : b.recovery.explain(stuck.event);
    expect(plan?.next).toContain("upgrade");
    expect(plan?.retryWorthwhile).toBe(false);
    link.close();
    await a.stop();
    await b.stop();
  });
});
