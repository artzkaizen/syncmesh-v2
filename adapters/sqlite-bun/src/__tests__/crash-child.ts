/**
 * The process the crash suite kills: opens `<dir>/<name>.db` with `bun:sqlite` and writes in
 * `mode` until SIGKILL, printing each committed sequence on its own line.
 */
import type { CrashMode } from "@syncmesh/storage/driver-tests";

import { CRASH_SCHEMA, crashChild } from "@syncmesh/storage/driver-tests";
import { join } from "node:path";

import { bunSqliteDriver } from "../index.js";

const [dir, name, mode] = process.argv.slice(2);
if (dir === undefined || name === undefined || (mode !== "append" && mode !== "fold"))
  throw new Error("usage: crash-child <dir> <name> <append|fold>");
const chosen: CrashMode = mode;

await crashChild(bunSqliteDriver(join(dir, `${name}.db`), CRASH_SCHEMA), chosen, (seq) =>
  console.log(`${seq}`),
);
