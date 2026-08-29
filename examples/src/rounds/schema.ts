import { defineSchema, t } from "@syncmesh/schema";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** The ward this demo runs under: one practice, as `kind:id`. */
export const PRACTICE = "practice:st-mary";

/**
 * The app's own tables, in Drizzle. The mesh materialises rows into these same tables, so a
 * handler's `select` is an ordinary read of the device's database.
 */
export const patient = sqliteTable("patient", {
  id: text().primaryKey(),
  name: text().notNull(),
  bed: text().notNull(),
});

/**
 * An observation is never edited. A correction is a new row naming the one it amends, so two
 * clinicians recording the same patient while apart both survive — the shape D25 landed on
 * ("lists, tags and memberships are tables"), applied to the reading that must not be lost.
 */
export const observation = sqliteTable("observation", {
  id: text().primaryKey(),
  patientId: text().notNull(),
  code: text().notNull(),
  value: text().notNull(),
  takenAt: integer().notNull(),
  author: text().notNull(),
  amends: text(),
});

/** The manifest: what syncs, which instance it hangs under, and who may write it. */
export const roundsSchema = () =>
  defineSchema({
    partitions: { practice: {} },
    roles: { practice: ["owner", "clinician", "observer"] },
    tables: {
      patient: {
        columns: {
          id: t.text().primaryKey(),
          name: t.text(),
          bed: t.text(),
        },
        partition: "practice",
        allow: ({ role }) => ({ $default: role("clinician"), read: role("observer") }),
      },
      observation: {
        columns: {
          id: t.text().primaryKey(),
          patientId: t.text(),
          code: t.text(),
          value: t.text(),
          takenAt: t.integer(),
          author: t.text(),
          amends: t.text().nullable(),
        },
        partition: "practice",
        // an observation is appended and amended, never updated or deleted
        // append and amend, never update or delete: `$default` is the refusal, and the two
        // operations an observation actually has are the exceptions to it
        allow: ({ role, deny }) => ({
          $default: deny,
          read: role("observer"),
          insert: role("clinician"),
        }),
      },
    },
  });
