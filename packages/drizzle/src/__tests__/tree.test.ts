import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { alias, pgSchema, pgTable, text } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";

import { readFrom, tableIdentity, queryTables } from "../tree.js";
import { keyOfRows } from "../window.js";

const mail = pgTable("mail", { id: text().primaryKey(), owner: text() });
const crmMail = pgSchema("crm").table("mail", { id: text().primaryKey() });
const db = drizzle.mock();

describe("tableIdentity — the table a source is, as the manifest and the change feed name it", () => {
  test("an alias is the table it aliases, so its rule and its commits are that table's", () => {
    expect(tableIdentity(alias(mail, "other"))).toBe("mail");
    const query = db
      .select({ id: mail.id })
      .from(mail)
      .innerJoin(alias(mail, "m2"), eq(mail.id, mail.id));
    expect([...queryTables(query)]).toEqual(["mail"]);
  });

  test("outside public a table is schema.table, as the Postgres change feed names its commits", () => {
    expect(tableIdentity(mail)).toBe("mail");
    expect(tableIdentity(crmMail)).toBe("crm.mail");
    expect([...queryTables(db.select().from(crmMail))]).toEqual(["crm.mail"]);
  });
});

describe("readFrom — a table read from another relation under its own name", () => {
  const view = { schema: "syncmesh_served", name: "read:mail" };
  const page = () => {
    const source = db.select().from(readFrom(mail, view)).as("mail");
    return db.select().from(source).orderBy(mail.id).limit(10);
  };

  test("the FROM names the relation and calls it by the table's name", () => {
    expect(page().toSQL().sql).toBe(
      'select "id", "owner" from (select "id", "owner" from "syncmesh_served"."read:mail" "mail") "mail" order by "mail"."id" limit $1',
    );
  });

  test("its rows are still the table's: keyed by its primary key, and its commits re-read it", () => {
    expect(keyOfRows(page())?.({ id: "m1", owner: "alice" })).toBe("m1");
    // no column of the outer query names it: the subquery's own columns do
    expect([
      ...queryTables(db.select().from(db.select().from(readFrom(mail, view)).as("mail"))),
    ]).toEqual(["mail"]);
  });
});
