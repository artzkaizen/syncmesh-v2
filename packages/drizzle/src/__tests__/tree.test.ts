import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { alias, pgSchema, pgTable, text } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";

import { tableIdentity, tablesOf } from "../tree.js";

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
    expect([...tablesOf(query)]).toEqual(["mail"]);
  });

  test("outside public a table is schema.table, as the Postgres change feed names its commits", () => {
    expect(tableIdentity(mail)).toBe("mail");
    expect(tableIdentity(crmMail)).toBe("crm.mail");
    expect([...tablesOf(db.select().from(crmMail))]).toEqual(["crm.mail"]);
  });
});
