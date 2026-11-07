/**
 * The process the crash suite kills, under real Node: opens `<dir>/<name>.db` with `node:sqlite`
 * and writes in `mode` until SIGKILL, printing each committed sequence on its own line.
 *
 * Imports the built packages by name rather than `../index.js`, so Node runs it with nothing but
 * type stripping — the same `dist/` a Node consumer gets.
 */
import type { CrashMode } from "@syncmesh/storage/driver-tests";

import { nodeSqliteDriver } from "@syncmesh/sqlite-node";
import { CRASH_SCHEMA, crashChild } from "@syncmesh/storage/driver-tests";
import { join } from "node:path";

const [dir, name, mode] = process.argv.slice(2);
if (dir === undefined || name === undefined || (mode !== "append" && mode !== "fold"))
  throw new Error("usage: crash-child <dir> <name> <append|fold>");
const chosen: CrashMode = mode;

await crashChild(nodeSqliteDriver(join(dir, `${name}.db`), CRASH_SCHEMA), chosen, (seq) =>
  console.log(`${seq}`),
);
