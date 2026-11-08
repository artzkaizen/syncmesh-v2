import { syncSchema, t } from "@syncmesh/schema";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * The one table the two-tab page writes, declared once for the worker and for every tab.
 *
 * Global rather than partitioned, so the device writes as its own authority and the page needs no
 * grant: what is under test is where the database is, not who may write to it.
 */
export const notes = sqliteTable("notes", { id: text().primaryKey(), body: text() });

export const schema = syncSchema({
  tables: { notes: { columns: { id: t.text().primaryKey(), body: t.text() } } },
});
