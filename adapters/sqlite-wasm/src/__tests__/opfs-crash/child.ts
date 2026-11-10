/**
 * The writer the suite kills: opens the database in this dedicated worker on the access-handle
 * pool, as `wasmSqliteDriver` does from a worker, and writes batch after batch until the worker is
 * terminated or the page that started it is closed.
 */
import { CRASH_SCHEMA, crashChild } from "@syncmesh/storage/driver-tests";

import type { ChildOrder } from "./messages.js";

import { wasmSqliteDriver } from "../../index.js";
import { SLOTS, told } from "./messages.js";

const write = async (order: ChildOrder, channel: BroadcastChannel) => {
  const driver = (
    await wasmSqliteDriver({
      name: order.name,
      schema: CRASH_SCHEMA,
      storage: "opfs-sahpool",
      directory: order.directory,
      // the worker killed before this one may not have been reaped yet
      whenHeld: "wait",
      capacity: SLOTS,
    })
  ).unwrap();
  await crashChild(driver, order.mode, (seq) => channel.postMessage(`${seq}`));
};

self.addEventListener(
  "message",
  ({ data }: MessageEvent<ChildOrder>) => {
    const channel = new BroadcastChannel(data.channel);
    // a writer that fails says how, rather than leaving the suite waiting on a line
    write(data, channel).catch((cause: unknown) => channel.postMessage(`failed: ${told(cause)}`));
  },
  { once: true },
);
