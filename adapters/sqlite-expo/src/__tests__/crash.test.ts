import { CRASH_SCHEMA, crashTests, streamLines, tornTests } from "@syncmesh/storage/driver-tests";
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

import { expoFileDriver } from "./fake-expo.js";

/**
 * O16 for `expo-sqlite`, as far as a test runner reaches: the crash and torn suites run through
 * `expoSqliteDriverOver` — the adapter's binding conversion, its prepared reads, WAL and
 * `synchronous = NORMAL` as `expoSqliteDriver` sets them, the log attached as on a phone — over
 * `bun:sqlite` files in a child killed with SIGKILL.
 *
 * What it does not reach is the phone: `expo-sqlite`'s native module and the SQLite build it
 * ships run only in an Expo app on a device or simulator, which no runner here drives. The
 * process being killed is Bun, the file layer is the host's, and the page size and build options
 * are `bun:sqlite`'s. What holds here is the adapter's contract; the native module's own crash
 * behaviour is SQLite's journal, the same one the Bun and Node suites kill.
 */
const dir = mkdtempSync(join(tmpdir(), "syncmesh-crash-expo-"));
// tens of megabytes of copies: under load the removal outlasts the default five seconds
afterAll(() => rmSync(dir, { recursive: true, force: true }), 60_000);

const file = (name: string) => join(dir, `${name}.db`);

const harness = {
  start: (name: string, mode: "append" | "fold") => {
    const child = Bun.spawn(["bun", join(import.meta.dir, "crash-child.ts"), dir, name, mode], {
      stdout: "pipe",
      stderr: "inherit",
    });
    return {
      lines: streamLines(child.stdout),
      kill: async () => {
        child.kill("SIGKILL");
        await child.exited;
      },
    };
  },
  openDriver: (name: string) => expoFileDriver(file(name), CRASH_SCHEMA),
  copy: (from: string, to: string) => copyFileSync(file(from), file(to)),
  size: (name: string) => statSync(file(name)).size,
  zero: (name: string, offset: number, length: number) => {
    const fd = openSync(file(name), "r+");
    writeSync(fd, Buffer.alloc(length, 0), 0, length, offset);
    closeSync(fd);
  },
};

describe("@syncmesh/sqlite-expo survives kill -9", () => {
  for (const c of crashTests(harness)) test(c.name, c.run, 60_000);
});

describe("@syncmesh/sqlite-expo refuses a torn log rather than reading around it (D39)", () => {
  for (const c of tornTests(harness)) test(c.name, c.run, 60_000);
});
