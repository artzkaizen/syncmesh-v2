import type { StoredEvent } from "@syncmesh/engine";
import type {
  CellValue,
  ColumnName,
  Hlc,
  Logical,
  PartitionKey,
  PeerId,
  Procedure,
  Row,
  RowKey,
  RowRecord,
  Stamp,
  SyncEvent,
  TableName,
} from "@syncmesh/kernel";

import { eventId, parsePeerId, parseSeqNum } from "@syncmesh/kernel";
import { t, table } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { encodeEventCore } from "@syncmesh/wire";
import { grownCore } from "@syncmesh/wire/wire-tests";

import type { SqlDriver, SqlValue } from "../driver.js";

import { logTable, placementOf } from "../namespace.js";

export const A = parsePeerId("a".repeat(64)).unwrap();
export const B = parsePeerId("b".repeat(64)).unwrap();

export const seq = (n: number) => parseSeqNum(n).unwrap();
export const at = (ms: number) => Temporal.Instant.fromEpochMilliseconds(ms);

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- suite fixtures; naming rules are not under test */
export const NOTES = "notes" as TableName;
export const N1 = "n1" as RowKey;
export const BODY = "body" as ColumnName;
const PROCEDURE = "notes.create" as Procedure;
const ZERO = 0 as Logical;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

export const hlc = (ms: number, logical = ZERO): Hlc => [at(ms), logical];

const row = (body: CellValue): Row => new Map([[BODY, body]]);

export interface EventOptions {
  readonly partition?: PartitionKey;
  readonly local?: true;
}

export const event = (
  peerId: PeerId,
  n: number,
  ms: number,
  options: EventOptions = {},
): SyncEvent => {
  const seqNum = seq(n);
  return {
    v: 1,
    id: eventId(peerId, seqNum, options.local === true),
    peerId,
    seqNum,
    hlc: hlc(ms),
    procedure: PROCEDURE,
    changes: [{ kind: "insert", table: NOTES, key: N1, row: row(`${n}`) }],
    ...options,
  };
};

export const stamp = (ms: number): Stamp => ({ hlc: hlc(ms), peer: A });

export const record = (body: string, ms: number): RowRecord => ({
  cells: new Map([[BODY, { value: body, stamp: stamp(ms) }]]),
  writeStamp: stamp(ms),
});

export const ids = (events: readonly SyncEvent[]) => events.map((e) => e.id);

/** The stored form; `sig` deterministic from the id so round-trips are checkable. */
export const entry = (
  peerId: PeerId,
  n: number,
  ms: number,
  options: EventOptions = {},
): StoredEvent => {
  const e = event(peerId, n, ms, options);
  return { event: e, sig: Uint8Array.from({ length: 8 }, (_, i) => (n + i) % 256) };
};

export const ids2 = (entries: readonly StoredEvent[]) => entries.map((x) => x.event.id);

/**
 * The stored form as a build newer than this one would have sent it: a core carrying a map key
 * this decoder has no name for. What a store must hand back unchanged — re-encoding it drops the
 * key, and the signature a real author put on those bytes would then cover nothing that leaves.
 *
 * The `sig` is `entry`'s filler, not a signature over this core: nothing here holds a key, and a
 * store round-trip is what this fixture is for. A test that needs a signature that actually
 * verifies wants `fromALaterBuild` from the same module.
 */
export const grownEntry = (peerId: PeerId, n: number, ms: number, options: EventOptions = {}) => {
  const base = entry(peerId, n, ms, options);
  return { ...base, core: grownCore(encodeEventCore(base.event)) };
};

/** A synced table with every column kind once, so each SQL encoding is exercised (capture and projection suites). */
export const JOBS = table("jobs", {
  id: t.text().primaryKey(),
  title: t.text(),
  hours: t.float().nullable(),
  rank: t.integer(),
  done: t.boolean(),
  dueAt: t.timestamp().nullable(),
  meta: t.json().nullable(),
  photo: t.blob().nullable(),
});
export const COUNTERS = table("counters", { id: t.integer().primaryKey(), n: t.integer() });

/**
 * The mesh's own table names and a one-byte blob literal, as this driver spells them — for the
 * cases that damage the store on purpose and therefore have to name a table directly.
 *
 * Three spellings, not two (RFC-0022). The durable half is `syncmesh.events` wherever the
 * namespace is real — a schema on Postgres, an attached database on a device — and
 * `syncmesh_events` on a connection that has only one database to put it in. Read off the driver
 * rather than written per adapter, because a suite that names the tables itself would be the one
 * place the naming rule is stated twice.
 */
export const sqlOf = (driver: Pick<SqlDriver, "dialect" | "log">) => {
  const log = (name: string) => logTable(name, placementOf(driver));
  return driver.dialect === "postgres"
    ? {
        events: log("events"),
        changes: "syncmesh.changes",
        rows: "syncmesh.state_rows",
        compaction: log("compaction"),
        junk: "'\\x00'::bytea",
      }
    : {
        events: log("events"),
        changes: "syncmesh_changes",
        rows: "syncmesh_state_rows",
        compaction: log("compaction"),
        junk: "X'00'",
      };
};

/**
 * The SQL an app would write in the driver's dialect: boolean and timestamp literals and binds,
 * bind markers, and how a read-back cell prints — so one suite says the same thing to both.
 */
export const sqlText = (driver: { readonly dialect?: "sqlite" | "postgres" }) =>
  driver.dialect === "postgres"
    ? {
        T: "true",
        F: "false",
        bool: (b: boolean): SqlValue => b,
        ts: (ms: number): SqlValue => new Date(ms),
        tsLiteral: (ms: number) => `to_timestamp(${ms} / 1000.0)`,
        p: (i: number) => `$${i}`,
        boolText: (b: boolean) => (b ? "true" : "false"),
        tsText: (ms: number) => String(new Date(ms)),
        jsonText: (v: SqlValue) => JSON.stringify(v),
        guard: `SELECT COALESCE(NULLIF(current_setting('syncmesh.armed', true), ''), '0')::int`,
      }
    : {
        T: "1",
        F: "0",
        bool: (b: boolean): SqlValue => (b ? 1 : 0),
        ts: (ms: number): SqlValue => ms,
        tsLiteral: (ms: number) => String(ms),
        p: () => "?",
        boolText: (b: boolean) => (b ? "1" : "0"),
        tsText: (ms: number) => String(ms),
        jsonText: (v: SqlValue) => String(v),
        guard: `SELECT armed FROM syncmesh_capture`,
      };
