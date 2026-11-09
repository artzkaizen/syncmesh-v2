import type { SuiteCase } from "@syncmesh/engine";

import { check, equal } from "@syncmesh/engine";
import { parsePartitionKey } from "@syncmesh/kernel";

import type { SqlDriver } from "../driver.js";
import type { OpenDriver } from "./index.js";

import { sqlEventStore } from "../event-store.js";
import { A, ACME, B, entry, ids2 as ids, seq, sqlOf } from "./fixtures.js";

const open = async (driver: SqlDriver) => (await sqlEventStore(driver)).unwrap();

/** What admit asks of the log once per batch, and what a batch appends as multi-row statements. */
export const batchCases = (openDriver: OpenDriver): readonly SuiteCase[] => [
  {
    name: "events: holding answers which of a list the log holds, in either scope, and has agrees",
    run: async () => {
      const store = await open(await openDriver("events-holding"));
      const held = [
        entry(A, 1, 10),
        entry(A, 2, 20),
        entry(B, 1, 30),
        entry(A, 1, 40, { local: true }),
      ];
      (await store.appendBatch(held)).unwrap();
      const absent = [entry(A, 3, 50), entry(B, 1, 30, { local: true })];
      const asked = [...held, ...absent].map((x) => x.event.id);
      const answer = (await store.holding?.(asked))?.unwrap();
      equal([...(answer ?? [])].sort(), held.map((x) => x.event.id).sort(), "held");
      const [, , , local, absentOne] = asked;
      if (local === undefined || absentOne === undefined) throw new Error("the list is fixed");
      equal((await store.has(absentOne)).unwrap(), false, "has, absent");
      equal((await store.has(local)).unwrap(), true, "has, local");
    },
  },
  {
    name: "events: allSince in partitions keeps those and the partitionless, and still refuses a hole in a run it left out",
    run: async () => {
      const driver = await openDriver("events-since-in");
      const store = await open(driver);
      const other = parsePartitionKey("org:other").unwrap();
      const kept = [entry(A, 1, 10, { partition: ACME }), entry(A, 3, 30)];
      const dropped = [
        entry(A, 2, 20, { partition: other }),
        entry(A, 4, 40, { partition: other }),
      ];
      (await store.appendBatch([...kept, ...dropped])).unwrap();
      const read = (await store.allSince(new Map(), "synced", [ACME])).unwrap();
      equal(ids(read), ids(kept), "kept");
      // a page lost under an event the read decodes nothing of is still a hole in A's run
      const [lost] = dropped;
      await driver.run(`DELETE FROM ${sqlOf(driver).events} WHERE seq = 2`);
      const torn = await store.allSince(new Map(), "synced", [ACME]);
      check(torn.isErr() && /log has a hole/.test(torn.error.message), "the hole is refused");
      check(lost !== undefined, "the case deleted an event it wrote");
    },
  },
  {
    name: "events: a batch of hundreds lands whole, and lastSeq reads each scope's head",
    run: async () => {
      const store = await open(await openDriver("events-many"));
      const batch = Array.from({ length: 700 }, (_, i) => entry(A, i + 1, 100 + i));
      (await store.appendBatch([...batch, entry(A, 1, 90, { local: true })])).unwrap();
      equal((await store.all()).unwrap().length, 701, "every event");
      equal((await store.lastSeq(A, "synced")).unwrap(), seq(700), "synced head");
      equal((await store.lastSeq(A, "local")).unwrap(), seq(1), "local head");
      equal((await store.lastSeq(B, "synced")).unwrap(), undefined, "no head");
    },
  },
];
