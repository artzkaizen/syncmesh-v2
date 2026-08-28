import { defineSchema, t } from "@syncmesh/schema";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/** The room a relay serves these examples under; it is the path a device dials, `ws://host/acme`. */
export const ROOM = "acme";

/** The partition instance every note is written under — one tenant, as `kind:id`. */
export const INSTANCE = "org:acme";

/** What a device shows its owner to be let in; a real deployment mints one per invitation. */
export const INVITE = "join-acme";

/**
 * The app's own table, defined once in Drizzle and synced through the mesh. The server peer
 * materialises rows into this same table, so `db.select().from(notes)` is an ordinary read of
 * your database — no mesh API in the query path.
 */
export const notes = sqliteTable("notes", {
  id: text().primaryKey(),
  body: text().notNull(),
  author: text().notNull(),
});

/**
 * The manifest: the columns that sync, the instance they hang under, and who may write them.
 * A fresh one per mesh, because a schema is bound to the engine that folds through it.
 */
export const notesSchema = () =>
  defineSchema({
    partitions: { org: {} },
    roles: { org: ["owner", "member"] },
    tables: {
      notes: {
        columns: { id: t.text().primaryKey(), body: t.text(), author: t.text() },
        partition: "org",
        allow: ({ role }) => ({ $default: role("member") }),
      },
    },
  });
