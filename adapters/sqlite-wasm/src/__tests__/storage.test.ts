import { describe, expect, test } from "bun:test";

import { wasmSqliteDriver } from "../index.js";

describe("which VFS a driver landed on", () => {
  test("a thread with no OPFS falls back to memory and says so, rather than pretending", async () => {
    const driver = (await wasmSqliteDriver({ name: "fallback" })).unwrap();
    expect(driver.storage).toBe("memory");
    await driver.close?.();
  });

  test("asking for OPFS where there is none is an error, not a silent memory database", async () => {
    for (const storage of ["opfs", "opfs-sahpool"] as const) {
      const refused = await wasmSqliteDriver({ name: "demanded", storage });
      const error = refused.match({ ok: () => undefined, err: (e) => e });
      expect(error?._tag).toBe("OpfsUnavailable");
      expect(error?._tag === "OpfsUnavailable" && error.requested).toBe(storage);
    }
  });

  test("memory survives a close and a reopen of the same name, and two names are two databases", async () => {
    const first = (await wasmSqliteDriver({ name: "twice", storage: "memory" })).unwrap();
    await first.run("CREATE TABLE t (a TEXT)");
    await first.run("INSERT INTO t VALUES (?)", ["kept"]);
    await first.close?.();

    const reopened = (await wasmSqliteDriver({ name: "twice", storage: "memory" })).unwrap();
    expect(await reopened.all("SELECT a FROM t")).toEqual([["kept"]]);

    const other = (await wasmSqliteDriver({ name: "elsewhere", storage: "memory" })).unwrap();
    expect(await other.all("SELECT name FROM sqlite_master")).toEqual([]);
    await reopened.close?.();
    await other.close?.();
  });
});
