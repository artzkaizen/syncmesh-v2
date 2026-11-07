/**
 * The process the crash suite kills: opens a PGlite cluster in `<dir>/<name>` and writes in
 * `mode` until SIGKILL, printing each committed sequence on its own line.
 */
import type { CrashMode } from "@syncmesh/storage/driver-tests";

import { PGlite } from "@electric-sql/pglite";
import { crashChild } from "@syncmesh/storage/driver-tests";
import { join } from "node:path";

import { pgliteDriver } from "../index.js";

const [dir, name, mode] = process.argv.slice(2);
if (dir === undefined || name === undefined || (mode !== "append" && mode !== "fold"))
  throw new Error("usage: crash-child <dir> <name> <append|fold>");
const chosen: CrashMode = mode;

await crashChild(pgliteDriver(await PGlite.create(join(dir, name))), chosen, (seq) =>
  console.log(`${seq}`),
);
