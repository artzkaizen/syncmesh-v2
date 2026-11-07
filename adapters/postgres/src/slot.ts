import type { SourceRow } from "@syncmesh/cdc";
import type { CellValue } from "@syncmesh/kernel";

import { Result } from "@syncmesh/result";

import type { PostgresQuerier } from "./index.js";
import type { Lsn } from "./lsn.js";
import type { Relation } from "./pgoutput.js";
import type { PostgresSourceError } from "./replication-errors.js";

import { parseLsn } from "./lsn.js";
import {
  PublicationMissing,
  ReplicationFailed,
  SlotBusy,
  SlotLost,
  SlotMismatch,
} from "./replication-errors.js";
import { cellValue } from "./values.js";

export interface SlotStatus {
  readonly slot: string;
  /** A walsender is reading it now. */
  readonly active: boolean;
  /** The last position acked: where the slot resumes, and everything before it is released. */
  readonly confirmed: Lsn | null;
  /** WAL the server holds for this slot past `confirmed`, in bytes. */
  readonly lag: number;
  /** `pg_replication_slots.wal_status`: `reserved`, `extended`, `unreserved` or `lost`. */
  readonly wal: string;
}

type TextRows = readonly (readonly (string | null)[])[];

const OBJECT_IN_USE = "55006";
const BACKFILL_PAGE = 500;

/** The SQLSTATE a postgres.js error carries; `55006` is `object_in_use`. */
export const sqlState = (cause: unknown) =>
  cause instanceof Error && "code" in cause ? cause.code : undefined;

export const isObjectInUse = (cause: unknown) => sqlState(cause) === OBJECT_IN_USE;

/** A database table's name as the mappings key it: bare in `public`, qualified elsewhere. */
export const tableName = (relation: Relation) =>
  relation.schema === "public" ? relation.table : `${relation.schema}.${relation.table}`;

const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** `tasks` → `"public"."tasks"`, `crm.tasks` → `"crm"."tasks"`: the inverse of {@link tableName}. */
const quoteTable = (table: string) => {
  const dot = table.indexOf(".");
  return dot < 0
    ? `${quoteIdent("public")}.${quoteIdent(table)}`
    : `${quoteIdent(table.slice(0, dot))}.${quoteIdent(table.slice(dot + 1))}`;
};

/**
 * The ordinary-connection half of a Postgres source: the slot, the publication and the backfill
 * read, every one a value. Every query here selects `::text` columns only, so each row is text
 * or NULL and is parsed where it is read.
 */
export function createSlot(sql: PostgresQuerier, slot: string, publication: string) {
  const query = (text: string, params: unknown[] = []) =>
    Result.tryPromise({
      // SAFETY: every query in this module casts each selected column to text
      try: async () => (await sql.unsafe(text, params).values()) as TextRows,
      catch: (cause) =>
        isObjectInUse(cause)
          ? new SlotBusy({ slot, message: `${slot} is being read`, cause })
          : new ReplicationFailed({ slot, message: `${slot}: ${text}`, cause }),
    });

  const position = (text: string | null | undefined): Result<Lsn, ReplicationFailed> =>
    parseLsn(text ?? "").mapError(
      (cause) => new ReplicationFailed({ slot, message: `${slot}: unreadable position`, cause }),
    );

  const published = async () =>
    (await query(`SELECT pubname::text FROM pg_publication WHERE pubname = $1`, [publication])).map(
      (rows) => rows.length > 0,
    );

  return {
    status: async (): Promise<Result<SlotStatus | null, PostgresSourceError>> =>
      (
        await query(
          `SELECT active::text, coalesce(wal_status, '')::text, confirmed_flush_lsn::text,
                  coalesce(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn), 0)::text
             FROM pg_replication_slots WHERE slot_name = $1`,
          [slot],
        )
      ).map((rows) => {
        const row = rows[0];
        if (row === undefined) return null;
        const [active, wal, confirmed, lag] = row;
        return {
          slot,
          active: active === "true",
          wal: wal ?? "",
          confirmed: confirmed === null ? null : position(confirmed).unwrapOr(null),
          lag: Number(lag),
        };
      }),

    /** The slot, made if absent; where it stands is where a stream from it begins. */
    ensure: async (): Promise<Result<Lsn, PostgresSourceError>> => {
      const found = await query(
        `SELECT plugin::text, (database = current_database())::text,
                coalesce(wal_status, '')::text, confirmed_flush_lsn::text
           FROM pg_replication_slots WHERE slot_name = $1`,
        [slot],
      );
      if (found.isErr()) return Result.err(found.error);
      const row = found.value[0];
      if (row === undefined) {
        const made = await query(
          `SELECT lsn::text FROM pg_create_logical_replication_slot($1, 'pgoutput')`,
          [slot],
        );
        return made.andThen((rows) => position(rows[0]?.[0]));
      }
      const [plugin, here, wal, confirmed] = row;
      if (plugin !== "pgoutput" || here !== "true") {
        return Result.err(
          new SlotMismatch({ slot, message: `${slot} belongs to another plugin or database` }),
        );
      }
      if (wal === "lost") {
        return Result.err(new SlotLost({ slot, message: `${slot}: the server removed its WAL` }));
      }
      return position(confirmed);
    },

    requirePublication: async (): Promise<Result<void, PostgresSourceError>> => {
      const found = await published();
      if (found.isErr()) return Result.err(found.error);
      return found.value
        ? Result.ok(undefined)
        : Result.err(
            new PublicationMissing({
              publication,
              message: `publication ${publication} is absent`,
            }),
          );
    },

    /** The primary key of a relation, for a `REPLICA IDENTITY FULL` table that flags every column. */
    primaryKey: async (oid: number) =>
      (
        await query(
          `SELECT a.attname::text FROM pg_index i
             JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
            WHERE i.indrelid = $1::oid AND i.indisprimary`,
          [oid],
        )
      ).map((rows) =>
        rows.flatMap(([name]) => (name === null || name === undefined ? [] : [name])),
      ),

    publish: async (tables: readonly string[]): Promise<Result<void, PostgresSourceError>> => {
      const found = await published();
      if (found.isErr()) return Result.err(found.error);
      const list = tables.map(quoteTable).join(", ");
      const ddl = found.value
        ? `ALTER PUBLICATION ${quoteIdent(publication)} SET TABLE ${list}`
        : `CREATE PUBLICATION ${quoteIdent(publication)} FOR TABLE ${list}`;
      return (await query(ddl)).map(() => undefined);
    },

    drop: async (): Promise<Result<boolean, PostgresSourceError>> =>
      (
        await query(
          `SELECT slot_name::text FROM pg_replication_slots, pg_drop_replication_slot(slot_name)
            WHERE slot_name = $1`,
          [slot],
        )
      ).map((rows) => rows.length > 0),

    rows: (table: string) => backfillRows(query, table),
  };
}

/** One table, page by page in `ctid` order, every value through the same text conversion. */
async function* backfillRows(
  query: (text: string, params?: unknown[]) => Promise<Result<TextRows, PostgresSourceError>>,
  table: string,
): AsyncGenerator<SourceRow> {
  const qualified = quoteTable(table);
  // a generator's failure channel is its throw; the bridge turns it into `SourceFailed`
  const described = await query(
    `SELECT attname::text, atttypid::int::text FROM pg_attribute
      WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum`,
    [qualified],
  );
  if (described.isErr()) throw described.error;
  const columns = described.value;
  const select = columns.map(([name]) => `${quoteIdent(name ?? "")}::text`).join(", ");
  // a row changed after the watermark is in the stream whichever page it moved to, and a row
  // left alone keeps its ctid, so paging by ctid outside one snapshot loses nothing
  let cursor = "(0,0)";
  for (;;) {
    const read = await query(
      `SELECT ctid::text, ${select} FROM ${qualified}
        WHERE ctid > $1::tid ORDER BY ctid LIMIT ${BACKFILL_PAGE}`,
      [cursor],
    );
    if (read.isErr()) throw read.error;
    const page = read.value;
    for (const [ctid, ...values] of page) {
      cursor = ctid ?? cursor;
      const row: Record<string, CellValue> = {};
      columns.forEach(([name, type], i) => {
        const value = values[i];
        row[name ?? ""] =
          value === null || value === undefined ? null : cellValue(Number(type), value);
      });
      yield row;
    }
    if (page.length < BACKFILL_PAGE) return;
  }
}
