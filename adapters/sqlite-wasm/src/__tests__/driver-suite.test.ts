import { driverTests } from "@syncmesh/storage/driver-tests";
import { describe, test } from "bun:test";

import { wasmSqliteDriver } from "../index.js";

/**
 * The contract, against the `memdb` VFS.
 *
 * **What this proves and what it does not.** Everything above the VFS — the bindings, the row
 * shapes, `BEGIN IMMEDIATE`, the DDL, capture, read filters, and a name that reopens the same
 * database after a close — is the same SQLite and the same driver code on all three VFSes, and
 * that is what runs here. What it cannot reach is the OPFS layer itself: `bun test` has no origin
 * private file system, no access handles and no cross-origin isolation, so the pool's install,
 * its pause on the last close, and the second tab that then gets in are untested by anything in
 * this repository. They need a browser runner.
 */
describe("sqlite-wasm passes the driver contract", () => {
  for (const c of driverTests(async (name) =>
    (await wasmSqliteDriver({ name, storage: "memory" })).unwrap(),
  ))
    test(c.name, c.run);
});
