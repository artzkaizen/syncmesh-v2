import { driverTests } from "@syncmesh/storage/driver-tests";
import { describe, expect, test } from "bun:test";

import { connectSqlite, serveSqlite, wasmSqliteDriver } from "../index.js";

/**
 * The contract again, with a thread boundary in the middle of it.
 *
 * `serveSqlite` is written against a port rather than against `Worker`, so the wire it speaks can
 * be certified without a browser: a `MessageChannel` has the same ordering guarantee a worker's
 * port does, and the host cannot tell which it is answering. What this proves is the part the
 * browser cannot be relied on to tell us in time — that every statement, every row shape, every
 * `BEGIN IMMEDIATE`, and a transaction whose body throws all survive being cut in half and
 * reassembled by `id`. What it still cannot reach is OPFS itself, which no test runner has.
 */
const channel = new MessageChannel();
serveSqlite(channel.port2);
const host = connectSqlite(channel.port1);

/**
 * `memdb` is one namespace per WASM heap and `loadSqlite` deliberately shares the heap, so two
 * suites in one `bun test` process would be one database under two names. The prefix is what keeps
 * them apart — and is the same reason a real app names its stores per scope (D07).
 */
const scoped = (name: string) => `port-${name}`;

describe("sqlite-wasm passes the driver contract across a port", () => {
  for (const c of driverTests(async (name) =>
    (
      await host.open({
        name: scoped(name),
        storage: "memory",
        directory: "/syncmesh",
        capacity: 8,
      })
    ).unwrap(),
  ))
    test(c.name, c.run);
});

describe("what the page is told when it cannot have a durable database", () => {
  test("a window's refusal names the rule, not just the symptom", async () => {
    const refused = await wasmSqliteDriver({ name: "demanded", storage: "opfs-sahpool" });
    const error = refused.match({ ok: () => undefined, err: (e) => e });
    expect(error?.message).toContain("createSyncAccessHandle");
    expect(error?.message).toContain("dedicated worker");
  });

  test("two databases on one host are two databases, and a closed one says so", async () => {
    const first = (
      await host.open({ name: "port-one", storage: "memory", directory: "/syncmesh", capacity: 8 })
    ).unwrap();
    const second = (
      await host.open({ name: "port-two", storage: "memory", directory: "/syncmesh", capacity: 8 })
    ).unwrap();
    await first.run("CREATE TABLE only_in_first (a TEXT)");
    expect(await second.all("SELECT name FROM sqlite_master")).toEqual([]);

    await first.close?.();
    // caught by hand rather than with `rejects.toThrow`: a `TaggedError` is yieldable, and its
    // `[Symbol.iterator]` is a generator that never returns — a matcher that iterates it hangs
    const refused = await first.run("SELECT 1").then(
      () => undefined,
      (cause: unknown) => cause,
    );
    // SAFETY: whatever the driver rejected with, only its tag is read, and a value without one
    // reads as `undefined` and fails the assertion rather than passing it
    expect((refused as { _tag?: string } | undefined)?._tag).toBe("NoSuchDatabase");
    await second.close?.();
  });
});
