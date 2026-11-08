import type { Principal } from "@syncmesh/engine";

import { PGlite } from "@electric-sql/pglite";
import { createValidator, openEngine } from "@syncmesh/engine";
import { createHlcClock, parsePartitionKey } from "@syncmesh/kernel";
import { pgliteDriver } from "@syncmesh/postgres";
import { ladder, partition, syncSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { openStores, type SqlDriver } from "@syncmesh/storage";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import * as pg from "drizzle-orm/pg-core";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { meshDrizzle, scopeReads } from "../index.js";

// an HR record as Company OS keeps one: everyone in the workspace sees the person, only HR and
// the person themselves see the salary
const people = sqliteTable("people", {
  id: text().primaryKey(),
  name: text().notNull(),
  account: text().notNull(),
  salary: integer(),
});
const peoplePg = pg.pgTable("people", {
  id: pg.text().primaryKey(),
  name: pg.text().notNull(),
  account: pg.text().notNull(),
  salary: pg.integer(),
});

const workspace = partition("ws", { roles: ladder("admin", "hr", "member") });
const schema = syncSchema({
  tables: {
    people: {
      columns: {
        id: t.text().primaryKey(),
        name: t.text(),
        account: t.text(),
        salary: t.integer().nullable(),
      },
      partition: workspace,
      allow: ({ role }) => ({ $default: role("hr"), read: role("member") }),
      fields: ({ role, owner, any }) => ({ salary: any(role("hr"), owner("account")) }),
    },
  },
});

const device = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 90 + i)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const ACME = parsePartitionKey("ws:acme").unwrap();

const hr: Principal = { account: "acct_hr", role: "hr", claims: {} };
const mara: Principal = { account: "acct_mara", role: "member", claims: {} };
const theo: Principal = { account: "acct_theo", role: "member", claims: {} };

/** What an authority's caller sees: each row's id and salary, and what a `where` on salary finds. */
type Seen = (
  as: Principal,
  salary?: number,
) => Promise<readonly (readonly [string, number | null])[]>;

const SEED = [
  { id: "p1", name: "Mara", account: "acct_mara", salary: 81_000 },
  { id: "p2", name: "Theo", account: "acct_theo", salary: 64_000 },
];

/** The authority's process over one connection: an engine on the rows, ungranted (schema only). */
const authority = async <D extends SqlDriver>(driver: D) => {
  const stores = (await openStores(driver, { tables: [schema.tables.people] })).unwrap();
  const validate = createValidator({ schema, grantFor: null });
  const engine = (
    await openEngine({
      peerId: device.peerId,
      clock: createHlcClock({ now: () => T0 }),
      store: stores.events,
      stateStore: stores.state,
      validate,
    })
  ).unwrap();
  return { engine, validate, driver, schema, partition: ACME };
};

/** Both databases an authority runs on; the rule is compiled per dialect, and must agree. */
const DIALECTS: { readonly name: string; readonly open: () => Promise<Seen> }[] = [
  {
    name: "sqlite",
    open: async () => {
      const base = await authority(bunSqliteDriver(":memory:"));
      await meshDrizzle(base).db.insert(people).values(SEED);
      return async (as, salary) => {
        const face = meshDrizzle({ ...base, as });
        const db = scopeReads(face.db, face.read);
        const where = salary === undefined ? undefined : eq(people.salary, salary);
        const rows = await db.select().from(people).where(where).orderBy(people.id);
        return rows.map((r) => [r.id, r.salary] as const);
      };
    },
  },
  {
    name: "postgres",
    open: async () => {
      const base = await authority(pgliteDriver(new PGlite()));
      await meshDrizzle(base).db.insert(peoplePg).values(SEED);
      return async (as, salary) => {
        const face = meshDrizzle({ ...base, as });
        const db = scopeReads(face.db, face.read);
        const where = salary === undefined ? undefined : eq(peoplePg.salary, salary);
        const rows = await db.select().from(peoplePg).where(where).orderBy(peoplePg.id);
        return rows.map((r) => [r.id, r.salary] as const);
      };
    },
  },
];

describe.each(DIALECTS)(
  "fields on $name: a column's own read rule, where an authority serves rows (E06, D40)",
  (dialect) => {
    test("a caller the rule refuses reads null in that column, and every other column as it is", async () => {
      const asCaller = await dialect.open();
      expect(await asCaller(hr)).toEqual([
        ["p1", 81_000],
        ["p2", 64_000],
      ]);
      // a member reads their own salary and nobody else's
      expect(await asCaller(mara)).toEqual([
        ["p1", 81_000],
        ["p2", null],
      ]);
      expect(await asCaller(theo)).toEqual([
        ["p1", null],
        ["p2", 64_000],
      ]);
    });

    test("a where on the ruled column sees the caller's view of it, not the stored value", async () => {
      const asCaller = await dialect.open();
      // filtering on the hidden value would leak it one comparison at a time
      expect(await asCaller(mara, 64_000)).toEqual([]);
      expect(await asCaller(theo, 64_000)).toEqual([["p2", 64_000]]);
    });
  },
);

describe("fields: definition mistakes throw at the manifest (E06)", () => {
  test("a rule on the primary key is refused: every reader must see a row's identity", () => {
    expect(() =>
      syncSchema({
        tables: {
          people: {
            columns: { id: t.text().primaryKey(), name: t.text() },
            partition: workspace,
            allow: ({ role }) => ({ $default: role("member") }),
            fields: ({ role }) => ({ id: role("hr") }),
          },
        },
      }),
    ).toThrow("primary key");
  });

  test("a rule for a column the table does not have does not compile, and throws if forced", () => {
    expect(() =>
      syncSchema({
        tables: {
          people: {
            columns: { id: t.text().primaryKey(), name: t.text() },
            partition: workspace,
            allow: ({ role }) => ({ $default: role("member") }),
            // @ts-expect-error — `salary` is not a column of this table
            fields: ({ role }) => ({ salary: role("hr") }),
          },
        },
      }),
    ).toThrow('there is no column "salary"');
  });
});
