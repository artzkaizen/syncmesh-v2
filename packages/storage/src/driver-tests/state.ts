import type { Coverage, StateStore } from "@syncmesh/engine";
import type { SuiteCase } from "@syncmesh/engine";

import { equal, spreadable } from "@syncmesh/engine";
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

/**
 * The held run beside a scoped cursor, or below a purged one (D32): stored with the cursors and
 * replaced whole.
 */
const heldCase = (openDriver: OpenDriver): SuiteCase => ({
  name: "state: a scoped device's held run is stored with the cursors, replaced whole, and survives a reopen (D32)",
  run: async () => {
    const first = await openDriver("state-held");
    const store = await open(first);
    const scoped = { ...coverage, scope: "org:acme" };
    (
      await write(store, "a", 1, {
        ...scoped,
        held: new Map([
          [A, seq(1)],
          [B, seq(1)],
        ]),
      })
    ).unwrap();
    // a torn log took B's run back: the row that said it was held must not load back
    (await write(store, "b", 2, { ...scoped, held: new Map([[A, seq(2)]]) })).unwrap();
    await first.close?.();
    const again = await open(await openDriver("state-held"));
    const reopened = (await again.loadCursors()).unwrap();
    equal([reopened.held?.get(A), reopened.held?.has(B)], [seq(2), false], "held read back");
    equal(
      [reopened.synced.get(A), reopened.synced.get(B), reopened.local.get(A)],
      [seq(3), seq(1), seq(2)],
      "cursors untouched",
    );
    (await write(again, "c", 3)).unwrap();
    equal((await again.loadCursors()).unwrap().held === undefined, true, "gone with the scope");
    // a purge (D45) lowered it with no scope: it is the only claim below the cursors, so it stays
    (await write(again, "d", 4, { ...coverage, held: new Map([[A, seq(1)]]) })).unwrap();
    const purged = (await again.loadCursors()).unwrap();
    equal([purged.scope, purged.held?.get(A)], [undefined, seq(1)], "kept with no scope");
  },
});

/** Rows a commit writes as several multi-row statements, and a load reads back in pages. */
const manyCase = (openDriver: OpenDriver): SuiteCase => ({
  name: "state: a commit of many rows lands as chunks, a key written twice keeps its last, and a paged load reads them all",
  run: async () => {
    const driver = await openDriver("state-many");
    const store = await open(driver);
    const keys = Array.from({ length: 1_300 }, (_, i) => `k${i}`);
    const rows = keys.map((key, i) => ({
      table: NOTES,
      // SAFETY: suite keys, brands over the strings they name
      key: key as typeof N1,
      record: record(`body ${i}`, 1 + i),
    }));
    const [first] = rows;
    if (first === undefined) throw new Error("the rows are fixed");
    (await store.commit([...rows, { ...first, record: record("last", 5_000) }], coverage)).unwrap();
    const paged = (await sqlStateStore(driver, { loadPage: 100 })).unwrap();
    const loaded = (await paged.loadAll()).unwrap().get(NOTES);
    equal(loaded?.size, 1_300, "every row");
    equal(loaded?.has(N1), false, "no stray row");
    const text = (key: string) =>
      // SAFETY: as above
      JSON.stringify(loaded?.get(key as typeof N1)?.cells.get(BODY)?.value ?? null);
    equal([text("k0"), text("k1299")], ['"last"', '"body 1299"'], "values");
  },
});

export const stateCases = (openDriver: OpenDriver): readonly SuiteCase[] => [
  manyCase(openDriver),
  {
    name: "state: remove drops a row and keeps the cursors (D45)",
    run: async () => {
      const store = await open(await openDriver("state-remove"));
      (await write(store, "a", 1)).unwrap();
      (await store.remove(new Map([[NOTES, new Set([N1])]]))).unwrap();
      equal(
        (await store.loadAll()).unwrap().get(NOTES)?.has(N1) === true,
        false,
        "the row is gone",
      );
      equal(await cursorsOf(store), [seq(3), seq(1), seq(2)], "cursors untouched");
    },
  },
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
    name: "state: the interest a cursor is true for is stored with it, and survives a reopen (D23)",
    run: async () => {
      const scope = '{"partitions":["org:acme"]}';
      const first = await openDriver("state-scope");
      const store = await open(first);
      equal((await store.loadCursors()).unwrap().scope, undefined, "unscoped until told");

      (await write(store, "a", 1, { ...coverage, scope })).unwrap();
      equal((await store.loadCursors()).unwrap().scope, scope, "scope read back");

      // it has to outlive the process, or a device that widens between runs cannot tell that its
      // numbers describe a slice it no longer asks for
      await first.close?.();
      const reopened = await open(await openDriver("state-scope"));
      equal((await reopened.loadCursors()).unwrap().scope, scope, "scope survives a reopen");

      // and widening back to everything drops it, rather than leaving a stale claim behind
      (await write(reopened, "b", 2)).unwrap();
      equal((await reopened.loadCursors()).unwrap().scope, undefined, "cleared with the coverage");

      (await write(reopened, "c", 3, { ...coverage, scope })).unwrap();
      (await reopened.clear()).unwrap();
      equal((await reopened.loadCursors()).unwrap().scope, undefined, "clear empties it too");
    },
  },
  {
    name: "state: the floor a snapshot left is stored with the cursors, and survives a reopen (D46)",
    run: async () => {
      const first = await openDriver("state-floor");
      const store = await open(first);
      equal((await store.loadCursors()).unwrap().floor === undefined, true, "no floor until told");
      (await write(store, "a", 1, { ...coverage, floor: new Map([[A, seq(2)]]) })).unwrap();
      await first.close?.();
      const reopened = (await (await open(await openDriver("state-floor"))).loadCursors()).unwrap();
      equal(reopened.floor?.get(A), seq(2), "floor read back");
      // a floor row is not a cursor: the numbers it qualifies are what they were
      equal(
        [reopened.synced.get(A), reopened.synced.get(B), reopened.local.get(A)],
        [seq(3), seq(1), seq(2)],
        "cursors untouched",
      );
    },
  },
  heldCase(openDriver),
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
    name: "driver: every member is an own property, so a wrapper that spreads it keeps them all",
    run: async () => {
      spreadable(await openDriver("driver-shape"), "driver");
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
