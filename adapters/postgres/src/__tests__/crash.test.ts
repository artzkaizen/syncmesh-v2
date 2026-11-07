import { PGlite } from "@electric-sql/pglite";
import { crashTests } from "@syncmesh/storage/driver-tests";
import { afterAll, describe, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pgliteDriver } from "../index.js";

const dir = mkdtempSync(join(tmpdir(), "syncmesh-crash-pglite-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Each line of a child's stdout, as it arrives. */
async function* linesOf(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    yield* lines;
  }
}

/**
 * PGlite on disk: a whole Postgres cluster in a directory, killed with the process that holds
 * it. Its WAL is the only thing between a commit that returned and the next open.
 */
describe("@syncmesh/postgres over on-disk PGlite survives kill -9", () => {
  const open = new Map<string, PGlite>();
  afterAll(async () => {
    for (const db of open.values()) await db.close();
  });
  const cases = crashTests({
    start: (name, mode) => {
      const child = Bun.spawn(["bun", join(import.meta.dir, "crash-child.ts"), dir, name, mode], {
        stdout: "pipe",
        stderr: "inherit",
      });
      return {
        lines: linesOf(child.stdout),
        kill: async () => {
          child.kill("SIGKILL");
          await child.exited;
        },
      };
    },
    openDriver: async (name) => {
      const db = await PGlite.create(join(dir, name));
      open.set(name, db);
      return { ...pgliteDriver(db), close: () => Promise.resolve() };
    },
  });
  for (const c of cases) test(c.name, c.run, 120_000);
});
