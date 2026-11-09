/**
 * The file worker: a database's log as bytes in the access-handle pool, copied, measured or torn
 * while no driver holds the pool. Started for one order and terminated after it; it takes the
 * pool's lease as a driver does, and gives the handles back before it answers.
 */
import type { SAHPoolUtil, Sqlite3Static } from "@sqlite.org/sqlite-wasm";

import { Result } from "@syncmesh/result";

import type { FileAnswer, FileOrder } from "./messages.js";

import { loadSqlite } from "../../module.js";
import { reaped } from "../../pool.js";
import { SLOTS, told } from "./messages.js";

/** The pool's file for a store's log, as `databases.ts` names it. */
const logFile = (name: string) => `/${encodeURIComponent(name)}.db`;

/** Answers the order's size in bytes; the published types make each call a promise, so each is awaited. */
const carry = async (util: SAHPoolUtil, order: FileOrder): Promise<number> => {
  if (order.op === "size") return (await util.exportFile(logFile(order.name))).byteLength;
  if (order.op === "copy") {
    const bytes = await util.exportFile(logFile(order.from));
    // a pool file written over keeps its old length past the new bytes
    util.unlink(logFile(order.to));
    await util.importDb(logFile(order.to), bytes);
    return bytes.byteLength;
  }
  const bytes = await util.exportFile(logFile(order.name));
  bytes.fill(0, order.offset, order.offset + order.length);
  await util.importDb(logFile(order.name), bytes);
  return bytes.byteLength;
};

/**
 * The pool, once the lease is ours and the handles are too: a worker the suite killed gives its
 * lease back at once and its access handles when the browser reaps it, so the install waits until
 * no slot is held, as a driver's open does. Asked before the install, because sqlite-wasm keeps
 * the handles a refused install took and remembers the refusal under the pool's name.
 */
const installed = async (
  sqlite3: Sqlite3Static,
  directory: string,
): Promise<Result<SAHPoolUtil, unknown>> => {
  const free = await reaped(directory, "wait");
  if (free.isErr()) return free;
  return Result.tryPromise(() =>
    sqlite3.installOpfsSAHPoolVfs({ directory, initialCapacity: SLOTS }),
  );
};

self.addEventListener(
  "message",
  ({ data }: MessageEvent<FileOrder>) =>
    void navigator.locks.request(`syncmesh-opfs:${data.directory}/pool`, async () => {
      const answer = await Result.gen(async function* () {
        const sqlite3 = yield* Result.await(loadSqlite());
        const util = yield* Result.await(installed(sqlite3, `${data.directory}/pool`));
        const size = yield* Result.await(Result.tryPromise(() => carry(util, data)));
        util.pauseVfs();
        return Result.ok(size);
      }).then((done) =>
        done.match<FileAnswer>({
          ok: (size) => ({ size }),
          err: (error) => ({ failed: told(error) }),
        }),
      );
      postMessage(answer);
    }),
  { once: true },
);
