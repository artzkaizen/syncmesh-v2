import { PGlite } from "@electric-sql/pglite";
import { captureTests, storeTests } from "@syncmesh/storage/driver-tests";
import { describe, test } from "bun:test";

import { pgliteDriver, postgresDriver } from "../index.js";

describe("@syncmesh/postgres over PGlite passes the store contract", () => {
  // one in-process Postgres per database name: closing a driver keeps the data, so a suite case
  // that reopens by name after `close` finds what it wrote, as it would on a server
  const databases = new Map<string, PGlite>();
  const openDriver = (name: string) => {
    const db = databases.get(name) ?? new PGlite();
    databases.set(name, db);
    const driver = pgliteDriver(db);
    return Promise.resolve({ ...driver, close: () => Promise.resolve() });
  };
  for (const c of [...storeTests(openDriver), ...captureTests(openDriver)]) test(c.name, c.run);
});

const url = process.env.SYNCMESH_PG_URL ?? "";
describe.if(url !== "")("@syncmesh/postgres over a real server passes the store contract", () => {
  // every database name is its own schema: cases never see each other's tables, and a reopen by
  // name lands on the same schema through a fresh single-connection client
  const openDriver = async (name: string) => {
    const { default: postgres } = await import("postgres");
    const schema = `syncmesh_test_${name.replaceAll(/[^a-z0-9]/g, "_")}`;
    const root = postgres(url, { max: 1 });
    await root.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await root.end();
    const sql = postgres(url, { max: 1, connection: { search_path: schema } });
    return postgresDriver(sql);
  };
  for (const c of [...storeTests(openDriver), ...captureTests(openDriver)]) test(c.name, c.run);
});
