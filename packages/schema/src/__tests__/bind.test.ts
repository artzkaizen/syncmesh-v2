import { evaluate } from "@syncmesh/policy";
import { describe, expect, test } from "bun:test";

import { t } from "../column.js";
import { syncSchema } from "../manifest.js";
import { ladder, partition } from "../partition.js";

const org = partition("org", { roles: ladder("owner", "admin", "member") });
const shelf = partition("shelf", { roles: org.roles });
const schema = syncSchema({
  tables: {
    books: {
      columns: {
        id: t.uuid().primaryKey(),
        title: t.text(),
        rating: t.float(),
        createdBy: t.text(),
        entityId: t.text(),
      },
      partition: shelf,
      allow: ({ role, owner, claim, can, rowIs, patchOnly, any, all, not }) => ({
        $default: role("member"),
        update: any(owner("createdBy"), role("admin")),
        delete: all(role("admin"), not(rowIs({ rating: 5 })), patchOnly([])),
        read: claim("entities").has("entityId"),
        approve: can("books", "approve"),
      }),
    },
  },
});

describe("bound combinators", () => {
  test("produce the AST, as data, on the schema entry", () => {
    const books = schema.entries[0]?.allow;
    expect(books?.$default).toEqual({ kind: "role", role: "member" });
    expect(books?.update).toEqual({
      kind: "any",
      of: [
        { kind: "owner", column: "createdBy" },
        { kind: "role", role: "admin" },
      ],
    });
    expect(books?.read).toEqual({ kind: "claimHas", claim: "entities", column: "entityId" });
    expect(books?.approve).toEqual({
      kind: "claimIncludes",
      claim: "permissions.books",
      value: "approve",
    });
    expect(JSON.parse(JSON.stringify(books))).toEqual(books);
  });

  test("the AST evaluates with the kind's inherited ladder", () => {
    const update = schema.entries[0]?.allow?.update;
    if (update === undefined) throw new Error("fixture");
    const grant = { account: "acct_a", role: "member", claims: {} };
    const row = new Map([[schema.tables.books.columnNames.createdBy, "acct_a"]]);
    expect(evaluate(update, { grant, roles: schema.rolesFor("shelf"), row })).toBe(true);
    expect(
      evaluate(update, {
        grant: { ...grant, account: "acct_b" },
        roles: schema.rolesFor("shelf"),
        row,
      }),
    ).toBe(false);
  });

  test("a typo in a column or role is a compile error", () => {
    const rejected = () =>
      syncSchema({
        tables: {
          a: {
            columns: { id: t.uuid().primaryKey(), createdBy: t.text() },
            partition: org,
            allow: ({ owner, rowIs, patchOnly }) => ({
              // @ts-expect-error not a column of this table
              $default: owner("createdby"),
              // @ts-expect-error not a column
              delete: rowIs({ ratng: 5 }),
              // @ts-expect-error not a column
              approve: patchOnly(["nope"]),
            }),
          },
        },
      });
    expect(rejected).toBeInstanceOf(Function);
  });
});
