import { seed } from "@syncmesh/kernel/test-fixtures";
import { omitUndefined } from "@syncmesh/result";
import { ladder, partition, syncSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

import { createMesh } from "../mesh.js";

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

const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const HOUR = Temporal.Duration.from({ hours: 1 });

/** One ungranted device with its own idea of the time; `clockDrift` only when a test says so. */
const open = async (n: number, now: Temporal.Instant, clockDrift?: Temporal.Duration) =>
  (
    await createMesh({
      driver: bunSqliteDriver(":memory:"),
      schema: schema(),
      identity: createIdentity(seed(n)).unwrap(),
      now: () => now,
      ...omitUndefined({ clockDrift }),
    })
  ).unwrap();

describe("createMesh bounds clock drift by default (D34)", () => {
  test("a write stamped an hour ahead is parked by a default mesh, and folded by one that allows it", async () => {
    // a device whose clock runs an hour fast writes an ordinary row
    const early = await open(7, T0.add(HOUR));
    await early.on("org:acme").unwrap().db.insert(notes).values({ id: "n1", body: "future" });
    const entries = (await early.engine.eventsSince(new Map())).unwrap();
    expect(entries).toHaveLength(1);

    const strict = await open(160, T0);
    const refused = (await strict.engine.receiveBatch(entries)).unwrap();
    expect(refused.quarantined).toBe(1);
    expect(strict.engine.quarantine()[0]?.verdict._tag).toBe("ClockAhead");

    const lenient = await open(161, T0, Temporal.Duration.from({ hours: 2 }));
    const folded = (await lenient.engine.receiveBatch(entries)).unwrap();
    expect(folded.folded).toBe(1);

    await Promise.all([early.stop(), strict.stop(), lenient.stop()]);
  });
});
