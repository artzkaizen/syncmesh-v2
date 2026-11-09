/**
 * The file worker: a database's log as bytes in the access-handle pool, copied, measured or torn
 * while no driver holds the pool. Started for one order and terminated after it; it takes the
 * pool's lease as a driver does, and gives the handles back before it answers.
 */
import type { SAHPoolUtil } from "@sqlite.org/sqlite-wasm";

import { Result } from "@syncmesh/result";

import type { FileAnswer, FileOrder } from "./messages.js";

import { loadSqlite } from "../../module.js";
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

/** Long enough to be past a reap; the browser lets go of a killed worker's handles on its own time. */
const REAP_PAUSE = 100;

/**
 * The pool, once the lease is ours and the handles are too: a worker the suite killed gives its
 * lease back at once and its access handles when the browser reaps it, so the install is asked
 * again until they are free.
 */
const installed = async (
  install: () => Promise<SAHPoolUtil>,
  tries = 100,
): Promise<Result<SAHPoolUtil, unknown>> => {
  const util = await Result.tryPromise(install);
  if (util.isOk() || tries === 0) return util;
  await new Promise((wake) => setTimeout(wake, REAP_PAUSE));
  return installed(install, tries - 1);
};

self.addEventListener(
  "message",
  ({ data }: MessageEvent<FileOrder>) =>
    void navigator.locks.request(`syncmesh-opfs:${data.directory}/pool`, async () => {
      const answer = await Result.gen(async function* () {
        const sqlite3 = yield* Result.await(loadSqlite());
        const util = yield* Result.await(
          installed(() =>
            sqlite3.installOpfsSAHPoolVfs({
              directory: `${data.directory}/pool`,
              initialCapacity: SLOTS,
            }),
          ),
        );
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
