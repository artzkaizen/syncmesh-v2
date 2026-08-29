import type { Engine, Principal, ValidatorSchema } from "@syncmesh/engine";
import type { PartitionKey } from "@syncmesh/kernel";
import type { SqlDriver, TxReceipt, Write } from "@syncmesh/storage";
import type { PgDialect } from "drizzle-orm/pg-core";

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
