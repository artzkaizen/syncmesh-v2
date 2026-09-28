import type { PolicyNode } from "@syncmesh/policy";

import { NO_ROLES } from "@syncmesh/policy";
import { describe, expect, test } from "bun:test";

import { t } from "../column.js";
import { syncSchema } from "../manifest.js";
import { flat, global, isPartition, ladder, local, partition, user } from "../partition.js";

const id = () => t.uuid().primaryKey();
const none = ({ deny }: { readonly deny: PolicyNode }) => ({ $default: deny });
const compare = (a: string, b: string) => a.localeCompare(b);

const org = partition("org", { roles: ladder("owner", "admin", "member") });
const shelf = partition("shelf", { roles: org.roles });

const schema = syncSchema({
  tables: {
    catalog: { columns: { id: id(), code: t.text() } },
    books: {
      columns: { id: id(), title: t.text(), rating: t.float({ merge: "max" }) },
      partition: shelf,
      allow: none,
    },
    members: { columns: { id: id(), name: t.text() }, partition: org, allow: none },
    notes: { columns: { id: id(), body: t.text() }, partition: user },
    drafts: { columns: { id: id(), body: t.text() }, partition: local },
    patient: { columns: { id: id(), name: t.text() }, visibility: "authority" },
  },
});

describe("syncSchema", () => {
  test("builds one table per entry, named by its key, in declaration order", () => {
    expect(Object.keys(schema.tables)).toEqual([
      "catalog",
      "books",
      "members",
      "notes",
      "drafts",
      "patient",
    ]);
    expect(String(schema.tables.books.name)).toBe("books");
    expect(schema.tables.books.primaryKey).toBe("id");
  });

  test("entries carry the partition — global by omission — and the visibility tier", () => {
    expect(schema.entries.map((e) => [String(e.table.name), e.partition, e.visibility])).toEqual([
      ["catalog", "global", "partition"],
      ["books", "shelf", "partition"],
      ["members", "org", "partition"],
      ["notes", "user", "partition"],
      ["drafts", "local", "partition"],
      ["patient", "global", "authority"],
    ]);
  });

  test("kinds are the referenced ones, in the order the tables first reference them", () => {
    expect(schema.kinds).toEqual(["shelf", "org"]);
    expect(schema.rolesFor("shelf")).toEqual({
      names: ["owner", "admin", "member"],
      ordered: true,
    });
    expect(schema.rolesFor("user")).toEqual(NO_ROLES);
  });

  test("merge spec is assembled from column rules; lww omitted", () => {
    const books = schema.merge.get(schema.tables.books.name);
    expect(books && [...books]).toEqual([[schema.tables.books.columnNames.rating, "max"]]);
    expect(schema.merge.has(schema.tables.notes.name)).toBe(false);
  });

  test("reserved tables are installed outside the app namespace; reserved kinds declare nothing", () => {
    expect(schema.reserved.map((r) => String(r.name))).toEqual([
      "_policy",
      "_corrections",
      "_revocations",
      "_links",
      "_cdc",
    ]);
    const minimal = syncSchema({
      tables: { notes: { columns: { id: id() }, partition: user } },
    });
    expect(minimal.kinds).toEqual([]);
  });

  test("a manifest built past the types still meets the guard at module load", () => {
    // SAFETY: deliberately a partition the type refuses, to exercise the runtime guard for generated manifests
    const stray = { columns: { id: id() }, partition: "nope", allow: none } as never;
    expect(() => syncSchema({ tables: { b: stray } })).toThrow("unknown partition kind");
    // SAFETY: as above, for a presence topic
    const topic = { partition: "nope", of: { x: t.integer() } } as never;
    expect(() => syncSchema({ tables: {}, presence: { cursor: topic } })).toThrow(
      "unknown partition kind",
    );
  });

  test("a declared kind requires allow; a kind is a value; an authority table has no partition", () => {
    const cols = { id: id() };
    // compile-time only: the runtime guards would panic on the first one, which is their own test above
    const rejected = () => {
      syncSchema({
        tables: {
          // @ts-expect-error allow is required for a declared kind
          a: { columns: cols, partition: org },
          // @ts-expect-error a kind is a value, never its name
          b: { columns: cols, partition: "org", allow: none },
          // @ts-expect-error an authority table has no partition
          c: { columns: cols, visibility: "authority", partition: user },
        },
      });
    };
    expect(rejected).toBeInstanceOf(Function);
  });
});

/**
 * A kind is a value, not a position in a tree (§2.1). The set of kinds is derived from what
 * references them, because a kind nothing stores in and nothing announces on holds nothing.
 */
describe("partition() — kinds declared as values", () => {
  const workspace = partition("workspace", { roles: ladder("owner", "admin", "member") });
  const embargo = partition("embargo", { sealed: true, roles: workspace.roles });

  const built = syncSchema({
    tables: {
      issue: { columns: { id: id() }, partition: workspace, allow: none },
      disclosure: { columns: { id: id() }, partition: embargo, allow: none },
      rates: { columns: { id: id() }, partition: global },
      settings: { columns: { id: id() }, partition: user },
      scratch: { columns: { id: id() }, partition: local },
    },
  });

  test("the kinds are the ones the tables reference — nothing declares them twice", () => {
    expect([...built.kinds].slice().sort(compare)).toEqual(["embargo", "workspace"]);
    expect(
      built.entries
        .map((e) => String(e.partition))
        .slice()
        .sort(compare),
    ).toEqual(["embargo", "global", "local", "user", "workspace"]);
  });

  test("sealing rides the kind, not a list beside it", () => {
    expect(built.sealedKinds.has("embargo")).toBe(true);
    expect(built.sealedKinds.has("workspace")).toBe(false);
  });

  test("a shared ladder is a value reference, which is what nesting was faking", () => {
    expect(built.rolesFor("workspace")).toEqual(ladder("owner", "admin", "member"));
    expect(built.rolesFor("embargo")).toBe(workspace.roles);
    expect(built.rolesFor("global")).toEqual(NO_ROLES);
  });

  test("ladder() is ordered and flat() is not; both keep the names as written", () => {
    expect(ladder("owner", "admin", "member")).toEqual({
      names: ["owner", "admin", "member"],
      ordered: true,
    });
    expect(flat("auditor", "billing")).toEqual({ names: ["auditor", "billing"], ordered: false });
    expect(() => ladder("owner", "owner")).toThrow(/named twice/);
    expect(() => flat("auditor", "auditor")).toThrow(/named twice/);
  });

  test("rolesFor carries the ordering through, including a flat set shared by reference", () => {
    const org = partition("org", { roles: flat("auditor", "billing") });
    const ledger = partition("ledger", { sealed: true, roles: org.roles });
    const shop = partition("shop", { roles: ladder("owner", "editor") });
    const withFlat = syncSchema({
      tables: {
        audits: { columns: { id: id() }, partition: org, allow: none },
        entries: { columns: { id: id() }, partition: ledger, allow: none },
        products: { columns: { id: id() }, partition: shop, allow: none },
      },
    });
    expect(withFlat.rolesFor("org").ordered).toBe(false);
    expect(withFlat.rolesFor("ledger")).toEqual({ names: ["auditor", "billing"], ordered: false });
    expect(withFlat.rolesFor("shop")).toEqual({ names: ["owner", "editor"], ordered: true });
  });

  test("a reserved name cannot be declared, and a kind name follows the table grammar", () => {
    expect(() => partition("global")).toThrow();
    expect(() => partition("Not A Kind")).toThrow();
  });

  test("two distinct values with one name is the failure object keys made impossible", () => {
    const one = partition("ward", { roles: ladder("nurse") });
    const two = partition("ward", { roles: ladder("nurse") });
    expect(() =>
      syncSchema({
        tables: {
          a: { columns: { id: id() }, partition: one, allow: none },
          b: { columns: { id: id() }, partition: two, allow: none },
        },
      }),
    ).toThrow(/declared twice/);
    // the same value twice is the ordinary case and says nothing
    expect(
      syncSchema({
        tables: {
          a: { columns: { id: id() }, partition: one, allow: none },
          b: { columns: { id: id() }, partition: one, allow: none },
        },
      }).kinds,
    ).toEqual(["ward"]);
  });

  test("a table in a declared kind still needs a rule; a reserved one still refuses to have any", () => {
    // SAFETY: deliberately missing allow, which the type requires, to exercise the runtime guard
    const noAllow = { columns: { id: id() }, partition: workspace } as never;
    expect(() => syncSchema({ tables: { a: noAllow } })).toThrow(/needs an allow rule/);
    expect(() =>
      syncSchema({ tables: { a: { columns: { id: id() }, partition: global, allow: none } } }),
    ).toThrow(/takes no allow rule/);
  });

  test("isPartition tells a declared kind from a bare name", () => {
    expect(isPartition(workspace)).toBe(true);
    expect(isPartition("workspace")).toBe(false);
  });
});
