import { PGlite } from "@electric-sql/pglite";
import { captureTests, storeTests } from "@syncmesh/storage/driver-tests";
import { Temporal } from "@syncmesh/temporal";
import { afterAll, describe, test } from "bun:test";

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
/** How long dropping every database the real-server cases made may take. */
const CLEANUP = Temporal.Duration.from({ minutes: 2 });
describe.if(url !== "")("@syncmesh/postgres over a real server passes the store contract", () => {
  // every database name is a database of its own: the log lives in a fixed `syncmesh` schema, so
  // a schema per case would have every case share one log. A reopen by name lands on the same
  // database through a fresh client, as a restarted server would
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const made = new Set<string>();
  const databaseFor = (name: string) =>
    `syncmesh_store_${run}_${name.replaceAll(/[^a-z0-9]/g, "_")}`.slice(0, 63);
  const urlFor = (database: string) => {
    const at = new URL(url);
    at.pathname = `/${database}`;
    return at.toString();
  };
  const openDriver = async (name: string) => {
    const { default: postgres } = await import("postgres");
    const database = databaseFor(name);
    if (!made.has(database)) {
      const root = postgres(url, { max: 1 });
      await root.unsafe(`CREATE DATABASE "${database}"`);
      await root.end();
      made.add(database);
    }
    return postgresDriver(postgres(urlFor(database), { max: 1 }));
  };
  // a database a case made is dropped at the end; there are dozens, and each drop checkpoints
  afterAll(async () => {
    const { default: postgres } = await import("postgres");
    const root = postgres(url, { max: 4 });
    await Promise.all(
      [...made].map((database) =>
        root.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`),
      ),
    );
    await root.end();
  }, CLEANUP.total("milliseconds"));
  for (const c of [...storeTests(openDriver), ...captureTests(openDriver)]) test(c.name, c.run);
});
