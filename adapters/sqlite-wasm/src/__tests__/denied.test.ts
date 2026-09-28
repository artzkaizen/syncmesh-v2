import type { Sqlite3Static } from "@sqlite.org/sqlite-wasm";

import { afterEach, describe, expect, test } from "bun:test";

import type { VfsOptions } from "../vfs.js";

import { loadSqlite } from "../module.js";
import { openDatabase } from "../vfs.js";

/**
 * A browser that refuses the origin a file system, which is not a shape bun has.
 *
 * Two fictions, and only two. The thread must look like a dedicated worker, or `"auto"` resolves
 * to memory long before the pool is reached and the test would pass without exercising anything;
 * and the pool's installer must reject the way Firefox does. Everything between them — the
 * classification, the decision, the memory database that comes back — is the real code.
 */
const SYNC_HANDLES = { prototype: { createSyncAccessHandle: () => undefined } };

// SAFETY: the two properties this module's probes read off the global, standing in for a
// dedicated worker in a browser that has them. `globalThis` is typed without either.
const global = globalThis as { FileSystemFileHandle?: unknown };

const denying = (sqlite3: Sqlite3Static, name: string): Sqlite3Static => ({
  ...sqlite3,
  installOpfsSAHPoolVfs: () => {
    // what `navigator.storage.getDirectory()` throws in a Firefox private window, raised from
    // where sqlite-wasm calls it — unwrapped, which is how it actually arrives
    const refusal = new Error("Security error when calling GetDirectory");
    refusal.name = name;
    return Promise.reject(refusal);
  },
});

const where: VfsOptions = {
  name: "denied",
  schema: "test",
  directory: "/syncmesh-denied",
  capacity: 4,
};

afterEach(() => {
  delete global.FileSystemFileHandle;
});

describe("a browser that will not give this origin a file system", () => {
  test("is an answer for `auto` — memory, and the driver says memory", async () => {
    const sqlite3 = (await loadSqlite()).unwrap();
    global.FileSystemFileHandle = SYNC_HANDLES;

    const opened = (await openDatabase(denying(sqlite3, "SecurityError"), "auto", where)).unwrap();
    // the whole of the promise: the app runs, and nothing anywhere claims a write was kept
    expect(opened.storage).toBe("memory");
    opened.release();
  });

  test("is still a refusal when a durable VFS was asked for by name", async () => {
    const sqlite3 = (await loadSqlite()).unwrap();
    global.FileSystemFileHandle = SYNC_HANDLES;

    const refused = await openDatabase(denying(sqlite3, "SecurityError"), "opfs-sahpool", where);
    const error = refused.match({ ok: () => undefined, err: (e) => e });
    // a caller who named a VFS was not asking what was available, so it is told
    expect(error?._tag).toBe("OpfsDenied");
    expect(String(error?.message)).toMatch(/private window/);
  });

  test("is not confused with another tab holding the pool, which waiting does fix", async () => {
    const sqlite3 = (await loadSqlite()).unwrap();
    global.FileSystemFileHandle = SYNC_HANDLES;

    const held = await openDatabase(
      denying(sqlite3, "NoModificationAllowedError"),
      "opfs-sahpool",
      { ...where, directory: "/syncmesh-held" },
    );
    // the tags are the remedies: this one clears when the other context lets go, and `auto` must
    // never quietly answer it with a memory database
    expect(held.match({ ok: () => undefined, err: (e) => e._tag })).toBe("OpfsPoolHeld");

    const auto = await openDatabase(denying(sqlite3, "NoModificationAllowedError"), "auto", {
      ...where,
      directory: "/syncmesh-held-auto",
    });
    expect(auto.match({ ok: () => "opened", err: (e) => e._tag })).toBe("OpfsPoolHeld");
  });
});
