import type { PolicyNode } from "@syncmesh/policy";

import { describe, expect, test } from "bun:test";

import type { EvolutionRule } from "../evolution.js";

import { t } from "../column.js";
import { checkEvolution } from "../evolution.js";
import { syncSchema } from "../manifest.js";
import { ladder, partition, user } from "../partition.js";
import { shippedSchema } from "../shipped.js";

const id = () => t.text().primaryKey();
const none = ({ deny }: { readonly deny: PolicyNode }) => ({ $default: deny });
const org = partition("org", { roles: ladder("member") });

/** What shipped first: two tables, one of them with a nullable `owner`. */
const v1 = syncSchema({
  schemaVersion: 1,
  tables: {
    notes: {
      columns: { id: id(), body: t.text(), owner: t.text().nullable() },
      partition: user,
    },
    memos: { columns: { id: id(), body: t.text() }, partition: user },
  },
});
const shipped = shippedSchema(v1);

/** The rules a check broke, in the order it found them; empty when it passed. */
const broken = (next: Parameters<typeof checkEvolution>[1], from = shipped): EvolutionRule[] => {
  const checked = checkEvolution(from, next);
  return checked.isOk() ? [] : checked.error.issues.map((issue) => issue.rule);
};

describe("checkEvolution: the additive lint D13 asked for (D31)", () => {
  test("adding a table and a nullable column passes, and returns the next file to commit", () => {
    const v2 = syncSchema({
      schemaVersion: 2,
      tables: {
        notes: {
          columns: {
            id: id(),
            body: t.text(),
            owner: t.text().nullable(),
            pinned: t.boolean().nullable(),
          },
          partition: user,
        },
        memos: { columns: { id: id(), body: t.text() }, partition: user },
        tasks: { columns: { id: id(), done: t.boolean() }, partition: org, allow: none },
      },
    });
    const checked = checkEvolution(shipped, v2);
    expect(checked.isOk() && checked.value).toEqual(shippedSchema(v2));
  });

  test("the expand → retire → contract sequence passes one step at a time", () => {
    const retired = syncSchema({
      schemaVersion: 2,
      tables: {
        notes: {
          columns: { id: id(), body: t.text(), owner: t.text().nullable().retired() },
          partition: user,
        },
        memos: { columns: { id: id(), body: t.text() }, partition: user, retired: true },
      },
    });
    expect(broken(retired)).toEqual([]);
    const contracted = syncSchema({
      schemaVersion: 3,
      dropped: ["memos"],
      tables: { notes: { columns: { id: id(), body: t.text() }, partition: user } },
    });
    expect(broken(contracted, shippedSchema(retired))).toEqual([]);
    // and the contract never skips the retire: straight from what shipped first, both go red
    expect(broken(contracted)).toEqual(["column-removed", "table-removed"]);
  });

  test("a rename is a removal: refused unless the old column was retired first", () => {
    const renamed = syncSchema({
      schemaVersion: 2,
      tables: {
        notes: {
          columns: { id: id(), body: t.text(), assignee: t.text().nullable() },
          partition: user,
        },
        memos: { columns: { id: id(), body: t.text() }, partition: user },
      },
    });
    const checked = checkEvolution(shipped, renamed);
    expect(checked.isErr() && checked.error.issues).toEqual([
      expect.objectContaining({ rule: "column-removed", table: "notes", column: "owner" }),
    ]);
  });

  test("a re-type, a nullability change, a repurpose and a NOT NULL add are each refused", () => {
    const changed = syncSchema({
      schemaVersion: 2,
      tables: {
        notes: {
          columns: {
            id: id(),
            body: t.integer(),
            owner: t.text(),
            due: t.timestamp(),
          },
          partition: user,
        },
        memos: { columns: { id: id(), body: t.text().unique() }, partition: user },
      },
    });
    expect(broken(changed)).toEqual([
      "column-retyped",
      "nullability-changed",
      "not-null-added",
      "column-repurposed",
    ]);
  });

  test("a table moved to another kind is refused; spelling out the default merge is not a change", () => {
    const moved = syncSchema({
      schemaVersion: 2,
      tables: {
        notes: {
          columns: { id: id(), body: t.text({ merge: "lww" }), owner: t.text().nullable() },
          partition: user,
        },
        memos: { columns: { id: id(), body: t.text() }, partition: org, allow: none },
      },
    });
    expect(broken(moved)).toEqual(["table-moved"]);
  });

  test("a dropped name stays dropped and is never declared again", () => {
    const retired = syncSchema({
      schemaVersion: 2,
      tables: {
        notes: {
          columns: { id: id(), body: t.text(), owner: t.text().nullable() },
          partition: user,
        },
        memos: { columns: { id: id(), body: t.text() }, partition: user, retired: true },
      },
    });
    const contracted = shippedSchema(
      syncSchema({
        schemaVersion: 3,
        dropped: ["memos"],
        tables: {
          notes: {
            columns: { id: id(), body: t.text(), owner: t.text().nullable() },
            partition: user,
          },
        },
      }),
    );
    expect(broken(retired)).toEqual([]);
    const forgot = syncSchema({
      schemaVersion: 4,
      tables: {
        notes: {
          columns: { id: id(), body: t.text(), owner: t.text().nullable() },
          partition: user,
        },
      },
    });
    expect(broken(forgot, contracted)).toEqual(["dropped-forgotten"]);
    const reused = syncSchema({
      schemaVersion: 4,
      tables: {
        notes: {
          columns: { id: id(), body: t.text(), owner: t.text().nullable() },
          partition: user,
        },
        memos: { columns: { id: id(), title: t.text() }, partition: user },
      },
    });
    expect(broken(reused, contracted)).toEqual(["dropped-forgotten", "table-reused"]);
  });

  test("the version only goes up, and goes up whenever the shape changes", () => {
    const same = syncSchema({
      schemaVersion: 1,
      tables: {
        notes: {
          columns: {
            id: id(),
            body: t.text(),
            owner: t.text().nullable(),
            pinned: t.boolean().nullable(),
          },
          partition: user,
        },
        memos: { columns: { id: id(), body: t.text() }, partition: user },
      },
    });
    expect(broken(same)).toEqual(["version-not-raised"]);
    expect(broken(v1, { ...shipped, schemaVersion: 5 })).toEqual(["version-regressed"]);
    // reordering what is declared changes nothing, so needs no new version
    const reordered = syncSchema({
      schemaVersion: 1,
      tables: {
        memos: { columns: { body: t.text(), id: id() }, partition: user },
        notes: {
          columns: { owner: t.text().nullable(), body: t.text(), id: id() },
          partition: user,
        },
      },
    });
    expect(broken(reordered)).toEqual([]);
  });
});

describe("the manifest's D31 fields", () => {
  test("schemaVersion and dropped reach the schema; a schema that declares none has neither", () => {
    const declared = syncSchema({
      schemaVersion: 3,
      dropped: ["memos"],
      tables: { notes: { columns: { id: id() }, partition: user } },
    });
    expect(Number(declared.schemaVersion)).toBe(3);
    expect([...declared.dropped]).toEqual(["memos"]);
    const bare = syncSchema({ tables: { notes: { columns: { id: id() }, partition: user } } });
    expect(bare.schemaVersion).toBeUndefined();
    expect(bare.dropped.size).toBe(0);
    expect(shippedSchema(bare).schemaVersion).toBe(1);
  });

  test("definition mistakes throw at module load", () => {
    const notes = { columns: { id: id() }, partition: user };
    expect(() => syncSchema({ schemaVersion: 0, tables: { notes } })).toThrow(
      "not a positive integer",
    );
    expect(() => syncSchema({ dropped: ["notes"], tables: { notes } })).toThrow("never reused");
    expect(() => syncSchema({ dropped: ["Bad-Name"], tables: { notes } })).toThrow(
      "not a table name",
    );
    // a retired column is one inserts omit, and an older build refuses an insert missing a NOT NULL
    expect(() =>
      syncSchema({
        tables: { notes: { columns: { id: id(), body: t.text().retired() }, partition: user } },
      }),
    ).toThrow("must be nullable");
  });

  test("a retired table and column are marked on the entry and the column", () => {
    const schema = syncSchema({
      tables: {
        notes: {
          columns: { id: id(), owner: t.text().nullable().retired() },
          partition: user,
          retired: true,
        },
      },
    });
    expect(schema.entries[0]?.retired).toBe(true);
    expect(schema.tables.notes.columns.owner.def.retired).toBe(true);
  });
});
