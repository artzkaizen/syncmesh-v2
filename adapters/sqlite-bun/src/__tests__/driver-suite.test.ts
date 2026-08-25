import { driverTests } from "@syncmesh/storage/driver-tests";
import { describe, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bunSqliteDriver } from "../index.js";

const dir = mkdtempSync(join(tmpdir(), "syncmesh-driver-suite-"));

describe("bun:sqlite passes the driver contract", () => {
  for (const c of driverTests((name) => Promise.resolve(bunSqliteDriver(join(dir, `${name}.db`)))))
    test(c.name, c.run);
});
