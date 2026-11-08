import { CRASH_SCHEMA, crashTests, linesOf } from "@syncmesh/storage/driver-tests";
import { afterAll, describe, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bunSqliteDriver } from "../index.js";

const dir = mkdtempSync(join(tmpdir(), "syncmesh-crash-bun-"));
// tens of megabytes of copies: under load the removal outlasts the default five seconds
afterAll(() => rmSync(dir, { recursive: true, force: true }), 60_000);

describe("@syncmesh/sqlite-bun survives kill -9", () => {
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
    openDriver: (name) => Promise.resolve(bunSqliteDriver(join(dir, `${name}.db`), CRASH_SCHEMA)),
  });
  for (const c of cases) test(c.name, c.run, 60_000);
});
