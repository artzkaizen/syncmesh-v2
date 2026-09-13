import type { Engine, Principal, ValidatorSchema } from "@syncmesh/engine";
import type { PartitionKey } from "@syncmesh/kernel";
import type { SqlDriver, TxReceipt, Write } from "@syncmesh/storage";
import type { PgDialect } from "drizzle-orm/pg-core";

import type { ProxySink } from "./proxy.js";

/** What both faces build on: the mesh's writer over the capturing connection, and the read scope. */
export interface FaceDeps {
  readonly engine: Engine;
  readonly schema: ValidatorSchema;
  readonly driver: SqlDriver;
  readonly writer: Write;
  readonly partition?: PartitionKey;
  readonly actor?: Principal;
  /** Drizzle's Postgres dialect, constructed by the caller so the SQLite face never loads pg-core. */
  readonly pgDialect: () => PgDialect;
}

/**
 * The surface one write scope runs on: a statement sink of its own, and the Drizzle over it.
 *
 * A scope's statements are the only ones its transaction admits, so a body that reaches past this
 * for the handle's shared `db` is a task running beside its own transaction — it waits for the
 * connection, and the connection is waiting for it. Write through `db` here; `sql` is for a
 * transport feeding the scope statements it was handed (`adapters/browser`).
 */
export interface Span<Db> {
  readonly db: Db;
  readonly sql: ProxySink;
}

/** What a handle offers over its writes' receipts: the event each one became (D26). */
export interface CommitHub {
  readonly emit: (receipt: TxReceipt) => void;
  /**
   * The event id of every write this handle commits, until the returned function is called.
   *
   * Scoped subscription rather than a `lastReceipt` field because the proxy serialises
   * transactions per handle — a listener added around one call cannot see another's — where a
   * field read after the fact races anything the app started meanwhile.
   */
  readonly onCommit: (listener: (receipt: TxReceipt) => void) => () => void;
}

export function commitHub(): CommitHub {
  const listeners = new Set<(receipt: TxReceipt) => void>();
  return {
    emit: (receipt) => {
      for (const listener of listeners) listener(receipt);
    },
    onCommit: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
