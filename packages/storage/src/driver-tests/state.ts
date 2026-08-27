import type { Coverage, StateStore } from "@syncmesh/engine";
import type { SuiteCase } from "@syncmesh/engine";

import { equal } from "@syncmesh/engine";
import { encodeRecord } from "@syncmesh/wire";

import type { SqlDriver } from "../driver.js";
import type { OpenDriver } from "./index.js";

import { sqlEventStore } from "../event-store.js";
import { sqlStateStore } from "../state-store.js";
import { A, B, BODY, N1, NOTES, record, seq, sqlOf } from "./fixtures.js";

const coverage: Coverage = {
  synced: new Map([
    [A, seq(3)],
    [B, seq(1)],
  ]),
  local: new Map([[A, seq(2)]]),
};
const open = async (driver: SqlDriver) => (await sqlStateStore(driver)).unwrap();
const bodyOf = async (store: StateStore) => {
  const value = (await store.loadAll()).unwrap().get(NOTES)?.get(N1)?.cells.get(BODY)?.value;
  return value instanceof Uint8Array ? undefined : JSON.stringify(value);
};
const write = (store: StateStore, body: string, ms: number, cov = coverage) =>
  store.commit([{ table: NOTES, key: N1, record: record(body, ms) }], cov);
const cursorsOf = async (store: StateStore) => {
  const c = (await store.loadCursors()).unwrap();
  return [c.synced.get(A), c.synced.get(B), c.local.get(A)];
};

export const stateCases = (openDriver: OpenDriver): readonly SuiteCase[] => [
  {
    name: "state: commit lands rows and coverage together; loadAll and loadCursors read them back",
    run: async () => {
      const store = await open(await openDriver("state-roundtrip"));
      equal((await store.isEmpty()).unwrap(), true, "empty before commit");
      (await write(store, "a", 1)).unwrap();
      equal((await store.isEmpty()).unwrap(), false, "empty after commit");
      const loaded = (await store.loadAll()).unwrap().get(NOTES)?.get(N1);
      equal(loaded && encodeRecord(loaded), encodeRecord(record("a", 1)), "record bytes");
      equal(await cursorsOf(store), [seq(3), seq(1), seq(2)], "coverage");
    },
  },
  {
    name: "state: a later commit replaces the row and raises the cursors",
    run: async () => {
      const store = await open(await openDriver("state-replace"));
      (await write(store, "a", 1)).unwrap();
      (await write(store, "b", 2, { synced: new Map([[A, seq(4)]]), local: new Map() })).unwrap();
      equal(await bodyOf(store), '"b"', "replaced body");
      equal((await store.loadAll()).unwrap().get(NOTES)?.size, 1, "one row");
      equal(await cursorsOf(store), [seq(4), seq(1), seq(2)], "cursors raised, others kept");
    },
  },
  {
    name: "state: durable — write, close, reopen the same name, read",
    run: async () => {
      const first = await openDriver("state-durable");
      (await write(await open(first), "a", 1)).unwrap();
      await first.close?.();
      equal(await bodyOf(await open(await openDriver("state-durable"))), '"a"', "after reopen");
    },
  },
  {
    name: "state: a damaged row makes loadAll StateCorrupt; clear empties the cache",
    run: async () => {
      const driver = await openDriver("state-corrupt");
      const store = await open(driver);
      (await write(store, "a", 1)).unwrap();
      const names = sqlOf(driver);
      await driver.run(`UPDATE ${names.rows} SET record = ${names.junk}`);
      const loaded = await store.loadAll();
      equal(loaded.isErr() ? loaded.error._tag : "ok", "StateCorrupt", "damaged row");
      (await store.clear()).unwrap();
      equal((await store.isEmpty()).unwrap(), true, "after clear");
    },
  },
  {
    name: "state: a commit that fails halfway leaves nothing behind",
    run: async () => {
      const inner = await openDriver("state-atomic");
      const failing: SqlDriver = {
        ...inner,
        run: (sql, params) =>
          sql.includes("cursors") && sql.startsWith("INSERT")
            ? Promise.reject(new Error("disk full"))
            : inner.run(sql, params),
      };
      const store = await open(failing);
      const committed = await write(store, "a", 1);
      equal(committed.isErr() ? committed.error._tag : "ok", "StoreFailure", "failed commit");
      equal((await store.isEmpty()).unwrap(), true, "still empty");
      equal((await store.loadAll()).unwrap().size, 0, "no rows");
    },
  },
  {
    name: "state: shares one database with the event store",
    run: async () => {
      const driver = await openDriver("state-shared");
      const events = (await sqlEventStore(driver)).unwrap();
      const state = await open(driver);
      equal((await events.maxHlc()).unwrap()?.[0].epochMilliseconds, undefined, "events side");
      equal((await state.isEmpty()).unwrap(), true, "state side");
    },
  },
];
