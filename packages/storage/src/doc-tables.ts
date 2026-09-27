/**
 * The doc log and the doc heads (RFC-0023 §6.2), declared once as Drizzle 1.0 tables per dialect:
 * the shape a query layer types its statements against, and the shape each dialect's migration
 * must create — `driver-tests/docs.ts` compares the two, so neither can drift from the other.
 *
 * Names follow the rest of the mesh's own tables: `_syncmesh_*` in the app's Postgres, bare on a
 * device's SQLite, snake_case columns in both. Byte columns are `bytea` on Postgres and
 * `blob({ mode: "buffer" })` on SQLite — in Drizzle 1.0 a `blob()` without a mode stores JSON.
 *
 * @module
 */
import {
  bigint,
  bytea,
  index as pgIndex,
  integer as pgInteger,
  pgTable,
  primaryKey as pgPrimaryKey,
  text as pgText,
} from "drizzle-orm/pg-core";
import {
  blob,
  index as sqliteIndex,
  integer as sqliteInteger,
  primaryKey as sqlitePrimaryKey,
  sqliteTable,
  text as sqliteText,
} from "drizzle-orm/sqlite-core";

/** The doc log in the app's Postgres: one row per doc change, the update itself by reference. */
export const pgDocLog = pgTable(
  "_syncmesh_doc_log",
  {
    author: pgText("author").notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    idx: pgInteger("idx").notNull(),
    tbl: pgText("tbl").notNull(),
    key: pgText("key").notNull(),
    col: pgText("col").notNull(),
    /** NULL is the root lineage. */
    lineage: bytea("lineage"),
    hlcMs: bigint("hlc_ms", { mode: "number" }).notNull(),
    hlcLogical: pgInteger("hlc_logical").notNull(),
    action: bytea("action"),
    undoOf: bytea("undo_of"),
    /** The SHA-256 hex of a blob-carried update; NULL when it rides inline. */
    blob: pgText("blob"),
    size: pgInteger("size").notNull(),
    /** `tail` | `covered` | `bytes-missing` | `orphaned` | `failed` | `adapter-missing` */
    state: pgText("state").notNull(),
  },
  (t) => [
    pgPrimaryKey({ columns: [t.author, t.seq, t.idx] }),
    pgIndex("_syncmesh_doc_log_doc").on(t.tbl, t.key, t.col, t.state),
  ],
);

/** The doc heads in the app's Postgres: where each document's column snapshot stands. */
export const pgDocHeads = pgTable(
  "_syncmesh_doc_heads",
  {
    tbl: pgText("tbl").notNull(),
    key: pgText("key").notNull(),
    col: pgText("col").notNull(),
    adapter: pgText("adapter").notNull(),
    lineage: bytea("lineage"),
    /** The snapshot's floor, as a cursor map's JSON. */
    covers: pgText("covers").notNull(),
    version: bytea("version"),
    tailCount: pgInteger("tail_count").notNull(),
    tailBytes: bigint("tail_bytes", { mode: "number" }).notNull(),
    /** `materialised` | `checkpoint` | `none` */
    mode: pgText("mode").notNull(),
    materialisedAt: bigint("materialised_at", { mode: "number" }),
  },
  (t) => [pgPrimaryKey({ columns: [t.tbl, t.key, t.col] })],
);

/** The doc log on a device: the same shape as {@link pgDocLog}, in SQLite's types. */
export const sqliteDocLog = sqliteTable(
  "doc_log",
  {
    author: sqliteText("author").notNull(),
    seq: sqliteInteger("seq", { mode: "number" }).notNull(),
    idx: sqliteInteger("idx", { mode: "number" }).notNull(),
    tbl: sqliteText("tbl").notNull(),
    key: sqliteText("key").notNull(),
    col: sqliteText("col").notNull(),
    lineage: blob("lineage", { mode: "buffer" }),
    hlcMs: sqliteInteger("hlc_ms", { mode: "number" }).notNull(),
    hlcLogical: sqliteInteger("hlc_logical", { mode: "number" }).notNull(),
    action: blob("action", { mode: "buffer" }),
    undoOf: blob("undo_of", { mode: "buffer" }),
    blob: sqliteText("blob"),
    size: sqliteInteger("size", { mode: "number" }).notNull(),
    state: sqliteText("state").notNull(),
  },
  (t) => [
    sqlitePrimaryKey({ columns: [t.author, t.seq, t.idx] }),
    sqliteIndex("doc_log_doc").on(t.tbl, t.key, t.col, t.state),
  ],
);

/** The doc heads on a device: the same shape as {@link pgDocHeads}, in SQLite's types. */
export const sqliteDocHeads = sqliteTable(
  "doc_heads",
  {
    tbl: sqliteText("tbl").notNull(),
    key: sqliteText("key").notNull(),
    col: sqliteText("col").notNull(),
    adapter: sqliteText("adapter").notNull(),
    lineage: blob("lineage", { mode: "buffer" }),
    covers: sqliteText("covers").notNull(),
    version: blob("version", { mode: "buffer" }),
    tailCount: sqliteInteger("tail_count", { mode: "number" }).notNull(),
    tailBytes: sqliteInteger("tail_bytes", { mode: "number" }).notNull(),
    mode: sqliteText("mode").notNull(),
    materialisedAt: sqliteInteger("materialised_at", { mode: "number" }),
  },
  (t) => [sqlitePrimaryKey({ columns: [t.tbl, t.key, t.col] })],
);
