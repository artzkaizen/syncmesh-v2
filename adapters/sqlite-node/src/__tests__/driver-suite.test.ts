import { driverTests } from "@syncmesh/storage/driver-tests";
import { describe, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { nodeSqliteDriver } from "../index.js";

const dir = mkdtempSync(join(tmpdir(), "syncmesh-driver-suite-"));

describe("node:sqlite passes the driver contract", () => {
  for (const c of driverTests((name) => Promise.resolve(nodeSqliteDriver(join(dir, `${name}.db`)))))
    test(c.name, c.run);
});
