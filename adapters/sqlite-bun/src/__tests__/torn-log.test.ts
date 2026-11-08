import { CRASH_SCHEMA, linesOf, tornTests } from "@syncmesh/storage/driver-tests";
import { afterAll, describe, test } from "bun:test";
import {
  closeSync,
  copyFileSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bunSqliteDriver } from "../index.js";

const dir = mkdtempSync(join(tmpdir(), "syncmesh-torn-log-"));
// tens of megabytes of copies: under load the removal outlasts the default five seconds
afterAll(() => rmSync(dir, { recursive: true, force: true }), 60_000);

const file = (name: string) => join(dir, `${name}.db`);

describe("@syncmesh/sqlite-bun refuses a torn log rather than reading around it (D39)", () => {
  const cases = tornTests({
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
    openDriver: (name) => Promise.resolve(bunSqliteDriver(file(name), CRASH_SCHEMA)),
    copy: (from, to) => copyFileSync(file(from), file(to)),
    size: (name) => statSync(file(name)).size,
    zero: (name, offset, length) => {
      const fd = openSync(file(name), "r+");
      writeSync(fd, Buffer.alloc(length, 0), 0, length, offset);
      closeSync(fd);
    },
  });
  for (const c of cases) test(c.name, c.run, 60_000);
});
