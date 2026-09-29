import { syncSchema, t } from "@syncmesh/schema";
import { createIdentity } from "@syncmesh/wire";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/** What the crash writer and the crash tests share: the table, the shape, and the one key both open with. */
export const notes = sqliteTable("notes", { id: text().primaryKey(), body: text().notNull() });
export const notesSchema = () =>
  syncSchema({ tables: { notes: { columns: { id: t.text().primaryKey(), body: t.text() } } } });
export const writer = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 77 + i)).unwrap();
