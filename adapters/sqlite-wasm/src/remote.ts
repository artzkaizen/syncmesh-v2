/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- a serialized tagged error is a field bag with no shape until `failures.revive` gives it one, which is the whole contract of `serializeTagged` */

import type { AsyncSqliteBinding, SqlRow } from "@syncmesh/storage";

import { Result } from "@syncmesh/result";
import { asyncSqliteDriver } from "@syncmesh/storage";

import type { WasmSqliteDriver } from "./driver.js";
import type { SqliteWasmUnavailable } from "./module.js";
import type { Answer, Call, OpenCall, Opened, Reply, WirePort } from "./protocol.js";
import type { PoolFailure } from "./vfs.js";

import { SqliteWasmUnavailable as WasmMissing } from "./module.js";
import { OpfsPoolHeld, OpfsUnavailable } from "./pool.js";
import { failures } from "./protocol.js";

/** A host on the other end of a port, and the databases it will open on this page's behalf. */
export interface RemoteSqlite {
  readonly open: (
    call: Omit<OpenCall, "kind">,
  ) => Promise<Result<WasmSqliteDriver, SqliteWasmUnavailable | PoolFailure>>;
}

/**
 * An `open` can only have failed the two ways the host's own `open` can fail, so the union stays
 * what it was before a thread came between them. Anything else is a protocol the page does not
 * recognise, which is the one thing "SQLite never arrived" honestly covers.
 */
const openFailure = (wire: Record<string, unknown>): SqliteWasmUnavailable | PoolFailure => {
  const revived = failures.revive(wire);
  return revived instanceof OpfsUnavailable ||
    revived instanceof OpfsPoolHeld ||
    revived instanceof WasmMissing
    ? revived
    : new WasmMissing({ cause: revived });
};

/**
 * The page's end of {@link serveSqlite}: a driver whose database is on another thread.
 *
 * Nothing above it can tell. `SqlDriver`'s calls have always returned promises — the port was
 * written that way for a binding whose database is not in reach, and this is that binding — so the
 * engine, the stores and every query run unchanged over a database in a worker.
 *
 * **What it costs is one message round trip per statement**, and that is the whole reason to
 * prefer it to nothing rather than to prefer it generally: a `MessagePort` hop is a task, so a
 * thousand statements is a thousand tasks. It is paid where it is worth paying — a browser, which
 * has no other way to be durable at all.
 *
 * @example
 * const host = connectSqlite(new Worker(url, { type: "module" }));
 * const driver = (await host.open({ name: "issues", storage: "auto", directory, capacity })).unwrap();
 */
export function connectSqlite(port: WirePort): RemoteSqlite {
  const pending = new Map<number, (reply: Reply) => void>();
  let next = 0;

  port.onmessage = (event) => {
    // SAFETY: the only sender is `serveSqlite`, whose every post is a `Reply` to an id this map
    // is still holding; an id it is not holding is a reply that already settled
    const reply = event.data as Reply;
    const settle = pending.get(reply.id);
    pending.delete(reply.id);
    settle?.(reply);
  };

  const post = (body: Call) =>
    new Promise<Reply>((resolve) => {
      const id = (next += 1);
      pending.set(id, resolve);
      port.postMessage({ id, ...body });
    });

  /** Throws rather than returning a `Result`: this is the binding, and a binding is what throws. */
  const send = async (body: Call): Promise<Answer> => {
    const reply = await post(body);
    if (reply.ok) return reply.value;
    throw failures.revive(reply.error) ?? new Error(JSON.stringify(reply.error));
  };

  const bindingOver = (db: number): AsyncSqliteBinding => ({
    exec: (sql) => send({ kind: "exec", db, sql, params: [] }).then(() => undefined),
    run: (sql, params) => send({ kind: "run", db, sql, params }).then(() => undefined),
    // SAFETY: the host answers `"all"` with the rows its binding returned and nothing else
    all: (sql, params) =>
      send({ kind: "all", db, sql, params }).then((a) => a as readonly SqlRow[]),
    close: () => send({ kind: "close", db }).then(() => undefined),
  });

  return {
    open: async (call) => {
      const reply = await post({ kind: "open", ...call });
      if (!reply.ok) return Result.err(openFailure(reply.error));
      // SAFETY: the host answers an `"open"` with `Opened`, which is the only reply carrying a handle
      const opened = reply.value as Opened;
      return Result.ok({ ...asyncSqliteDriver(bindingOver(opened.db)), storage: opened.storage });
    },
  };
}
