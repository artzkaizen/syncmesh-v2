import type { SuiteCase } from "@syncmesh/engine";
import type { Result } from "@syncmesh/result";

import { check, equal, openEngine } from "@syncmesh/engine";
import { createHlcClock } from "@syncmesh/kernel";
import { Temporal } from "@syncmesh/temporal";

import type { SqlDriver } from "../driver.js";
import type { OpenDriver } from "./index.js";

import { sqlEventStore } from "../event-store.js";
import { openStores } from "../open-stores.js";
import { A, B, at, entry, seq, sqlOf, sqlText } from "./fixtures.js";

/**
 * D39: a log is read whole or refused, never read around — and a log written with holes on
 * purpose still reads.
 *
 * A device's log holds holes nobody damaged: a scoped catch-up filters events out (D23), a
 * withheld run is stepped over (D40), a snapshot join starts an author's run high, an event is
 * parked or simply not here yet. Each of those is a hole at the moment the later event lands, and
 * the store records it then. A damaged page takes events the log held, which nothing recorded.
 * These cases make the second kind by deleting rows under the store, the way a torn page does.
 */

/** Deletes one event under the store, as a torn page would: no gap is recorded for it. */
const tear = (driver: SqlDriver, peer: string, n: number) => {
  const { p } = sqlText(driver);
  return driver.run(`DELETE FROM ${sqlOf(driver).events} WHERE peer = ${p(1)} AND seq = ${p(2)}`, [
    peer,
    n,
  ]);
};

const refused = (read: Result<unknown, { readonly message: string }>, what: string) => {
  check(read.isErr(), `${what} answered rather than refusing the hole`);
  if (read.isErr())
    check(read.error.message.startsWith("log has a hole"), `${what}: ${read.error.message}`);
};

/**
 * What a scoped device's log looks like: author A's run filtered to 1, 2, 5, 6, 9; author B joined
 * by snapshot at 10, so its run starts at 11; A's 4 arriving late, after 5 and 6; and this
 * device's own local writes, which are never filtered.
 */
const scopedLog = async (driver: SqlDriver) => {
  const store = (await sqlEventStore(driver)).unwrap();
  (
    await store.appendBatch([
      entry(A, 1, 10),
      entry(A, 2, 20),
      entry(A, 5, 50),
      entry(A, 6, 60),
      entry(B, 11, 110),
      entry(B, 12, 120),
    ])
  ).unwrap();
  (await store.append(entry(A, 9, 90))).unwrap();
  (await store.append(entry(A, 4, 40))).unwrap();
  (
    await store.appendBatch([entry(A, 1, 15, { local: true }), entry(A, 2, 25, { local: true })])
  ).unwrap();
  return store;
};

export const holeCases = (openDriver: OpenDriver): readonly SuiteCase[] => [
  {
    name: "holes: a log written with holes — filtered, joined high, filled late — reads back whole",
    run: async () => {
      const store = await scopedLog(await openDriver("holes-written"));
      equal((await store.allSince(new Map())).unwrap().length, 8, "allSince from nothing");
      equal((await store.allSince(new Map([[A, seq(2)]]))).unwrap().length, 6, "allSince above 2");
      equal((await store.allSince(new Map([[A, seq(3)]]))).unwrap().length, 6, "above 3, in a gap");
      equal((await store.allSince(new Map(), "local")).unwrap().length, 2, "local scope");
      equal((await store.all()).unwrap().length, 10, "all");
    },
  },
  {
    name: "holes: an event a damaged page took is refused as a value by every read",
    run: async () => {
      const driver = await openDriver("holes-torn");
      const store = await scopedLog(driver);
      await tear(driver, A, 5);
      refused(await store.allSince(new Map()), "allSince");
      refused(await store.allSince(new Map([[A, seq(2)]])), "allSince above the cursor");
      refused(await store.all(), "all");
      // above the hole there is nothing missing: a cursor past it reads what is there
      equal((await store.allSince(new Map([[A, seq(5)]]))).unwrap().length, 4, "above the tear");
    },
  },
  {
    name: "holes: an event that filled its gap late is damage once it is gone",
    run: async () => {
      const driver = await openDriver("holes-filled");
      const store = await scopedLog(driver);
      await tear(driver, A, 4);
      refused(await store.allSince(new Map()), "allSince");
    },
  },
  {
    name: "holes: the first run of an author, and its compaction floor, are accounted for",
    run: async () => {
      const driver = await openDriver("holes-floor");
      const store = await scopedLog(driver);
      equal(
        (await store.compactBelow(new Map([[B, seq(11)]]), "synced", at(1_000))).unwrap(),
        1,
        "compacted B's first event",
      );
      equal((await store.allSince(new Map())).unwrap().length, 7, "below the floor is no hole");
      await tear(driver, B, 12);
      // B's newest event gone leaves no later event to show it; `lastSeq` is what answers there
      equal((await store.allSince(new Map())).unwrap().length, 6, "a torn tail is not a hole");
    },
  },
  {
    /**
     * A read takes the entries, then the floors and the gaps. A late event that lands between
     * them fills its gap and deletes the row, so the entries miss it and the gaps no longer say
     * why: the log is sound, and the read must say so.
     */
    name: "holes: a late event that fills its gap mid-read leaves the read whole",
    run: async () => {
      const driver = await openDriver("holes-fill-mid-read");
      const store = (await sqlEventStore(driver)).unwrap();
      (await store.appendBatch([entry(A, 1, 10), entry(A, 2, 20), entry(A, 4, 40)])).unwrap();
      let armed = false;
      const racing: SqlDriver = {
        ...driver,
        all: async (sql, values) => {
          const rows = await driver.all(sql, values);
          if (armed) {
            armed = false;
            (await store.append(entry(A, 3, 30))).unwrap();
          }
          return rows;
        },
      };
      const reader = (await sqlEventStore(racing)).unwrap();
      armed = true;
      equal((await reader.allSince(new Map())).unwrap().length, 4, "allSince with a fill mid-read");
    },
  },
  {
    /**
     * The whole path a scoped device takes (D23, D40): events with holes folded through the
     * engine, a coverage adopted past what was filtered, anti-entropy answering a peer, and the
     * state rebuilt from the log alone — every one of them reads, until a page goes.
     */
    name: "holes: a scoped device folds, answers peers and refolds, and a torn log refuses all three",
    run: async () => {
      const driver = await openDriver("holes-scoped-engine");
      const stores = (await openStores(driver)).unwrap();
      const clock = () => createHlcClock({ now: () => Temporal.Now.instant() });
      const options = {
        peerId: B,
        clock: clock(),
        store: stores.events,
        stateStore: stores.state,
        atomic: stores.atomic,
      };
      const engine = (await openEngine(options)).unwrap();
      (await engine.receiveBatch([entry(A, 1, 10), entry(A, 2, 20), entry(A, 5, 50)])).unwrap();
      engine.adoptCoverage({ synced: new Map([[A, seq(6)]]), local: new Map(), scope: "p" });
      (await engine.receiveBatch([entry(A, 7, 70), entry(A, 9, 90)])).unwrap();
      equal(engine.coverage().synced.get(A), seq(7), "the cursor stepped over the filtered run");
      equal((await engine.eventsSince(new Map(), undefined)).unwrap().length, 5, "eventsSince");
      (await stores.state.clear()).unwrap();
      const refolded = (await openEngine({ ...options, clock: clock() })).unwrap();
      equal((await refolded.eventsSince(new Map(), undefined)).unwrap().length, 5, "refolded");

      await tear(driver, A, 7);
      refused(await refolded.eventsSince(new Map(), undefined), "eventsSince");
      (await stores.state.clear()).unwrap();
      refused(await openEngine({ ...options, clock: clock() }), "a refold");
    },
  },
];
