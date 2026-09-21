import type { AnyTaggedError } from "@syncmesh/result";
import type { SqliteBinding } from "@syncmesh/storage";

import { Result, serializeTagged } from "@syncmesh/result";

import type { Answer, OpenCall, Reply, Request, StatementCall, WirePort } from "./protocol.js";
import type { WasmStorage } from "./vfs.js";

import { bindingFor } from "./binding.js";
import { loadSqlite } from "./module.js";
import { NoSuchDatabase, SqliteStatementFailed } from "./protocol.js";
import { openDatabase } from "./vfs.js";

/** One open database on the host's thread, and the VFS its `open` reported. */
interface Held {
  readonly binding: SqliteBinding;
  readonly storage: WasmStorage;
}

const failed = (sql: string) => (cause: unknown) =>
  new SqliteStatementFailed({
    sql,
    message: cause instanceof Error ? cause.message : `SQLite refused the statement: ${sql}`,
  });

const statement = (held: Map<number, Held>, call: StatementCall) => {
  const open = held.get(call.db);
  if (open === undefined)
    return Result.err(
      new NoSuchDatabase({ db: call.db, message: "this database was already closed" }),
    );
  const { binding } = open;
  return Result.try({
    try: (): Answer =>
      call.kind === "all"
        ? binding.all(call.sql, call.params)
        : call.kind === "run"
          ? (binding.run(call.sql, call.params), null)
          : (binding.exec(call.sql), null),
    catch: failed(call.sql),
  });
};

/**
 * One `Worker` may hold several databases (D07), so the pool's exclusivity is settled inside it
 * rather than between it and another thread. `next` is a handle, not a name: two `open` calls for
 * the same name are two connections to one file, exactly as they would be in process.
 */
const opening = (held: Map<number, Held>, handle: () => number, call: OpenCall) =>
  Result.gen(async function* () {
    const sqlite3 = yield* Result.await(loadSqlite());
    const opened = yield* Result.await(
      openDatabase(sqlite3, call.storage, {
        name: call.name,
        schema: call.schema,
        directory: call.directory,
        capacity: call.capacity,
        ...(call.whenHeld !== undefined && { whenHeld: call.whenHeld }),
      }),
    );
    const db = handle();
    held.set(db, { binding: bindingFor(opened), storage: opened.storage });
    return Result.ok({ db, storage: opened.storage });
  });

/** Closing twice is not an error anywhere else in the port, and must not become one here. */
const closing = (held: Map<number, Held>, db: number) => {
  const open = held.get(db);
  held.delete(db);
  return open === undefined
    ? Result.ok(null)
    : Result.try({ try: (): Answer => (open.binding.close(), null), catch: failed("close") });
};

const answer = (
  held: Map<number, Held>,
  handle: () => number,
  call: Request,
): Promise<Result<Answer, AnyTaggedError>> => {
  if (call.kind === "open") return opening(held, handle, call);
  if (call.kind === "close") return Promise.resolve(closing(held, call.db));
  return Promise.resolve(statement(held, call));
};

const replyTo = (id: number, result: Result<Answer, AnyTaggedError>): Reply =>
  result.isErr()
    ? { id, ok: false, error: serializeTagged(result.error) }
    : { id, ok: true, value: result.value };

/**
 * Serves databases on **this** thread to whatever is on the other end of `port`.
 *
 * Call it from a dedicated worker's entry module and the databases it opens are durable, because
 * that is the one place `FileSystemFileHandle.createSyncAccessHandle` exists. Call it anywhere
 * else and it serves the same protocol over `memdb`, which is what makes the wire itself testable
 * off a `MessageChannel` in a runner with no DOM at all.
 *
 * **Order is the transaction.** `transaction` runs `BEGIN IMMEDIATE` here, the caller's body then
 * issues its statements from the other thread, and `COMMIT` follows — so the port must deliver in
 * the order it was posted and must not be shared with a second writer. A `MessagePort` delivers in
 * order by specification; one writer per driver is what every store above already assumes.
 *
 * @example
 * // worker.ts
 * serveSqlite(self);
 */
export function serveSqlite(port: WirePort): void {
  const held = new Map<number, Held>();
  let next = 0;
  const handle = () => (next += 1);
  port.onmessage = (event) => {
    // SAFETY: the only sender is `connectSqlite`, whose every post is a `Request`; a message from
    // anywhere else would be a page shouting into a worker it does not own
    const request = event.data as Request;
    void answer(held, handle, request).then((result) =>
      port.postMessage(replyTo(request.id, result)),
    );
  };
}
