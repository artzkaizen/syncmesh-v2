import type { SuiteCase } from "@syncmesh/engine";

import { equal } from "@syncmesh/engine";

import type { SqlDriver } from "../driver.js";
import type { OpenDriver } from "./index.js";

import { sqlEventStore } from "../event-store.js";
import { A, B, at, entry, event, ids2 as ids, seq } from "./fixtures.js";

const filled = async (driver: SqlDriver) => {
  const store = (await sqlEventStore(driver)).unwrap();
  (
    await store.appendBatch([
      entry(A, 1, 10),
      entry(A, 2, 20),
      entry(A, 3, 30),
      entry(B, 1, 10),
      entry(A, 1, 10, { local: true }),
    ])
  ).unwrap();
  return store;
};
const floors = async (store: Awaited<ReturnType<typeof filled>>) => {
  const f = (await store.compactedBelow()).unwrap();
  return [f.synced.get(A), f.synced.get(B), f.local.get(A)];
};

export const compactionCases = (openDriver: OpenDriver): readonly SuiteCase[] => [
  {
    name: "compaction: compactBelow removes per author, in scope, older than the cut; records the highest removed",
    run: async () => {
      const store = await filled(await openDriver("compaction-below"));
      const floor = new Map([[A, seq(3)]]);
      equal(
        (await store.compactBelow(floor, "synced", at(25))).unwrap(),
        2,
        "removed at first cut",
      );
      equal(
        ids((await store.all()).unwrap()),
        [event(A, 1, 10, { local: true }).id, event(B, 1, 10).id, event(A, 3, 30).id],
        "left",
      );
      equal(await floors(store), [seq(2), undefined, undefined], "floors after first cut");
      equal(
        (await store.compactBelow(floor, "synced", at(100))).unwrap(),
        1,
        "removed at later cut",
      );
      equal(
        (await store.compactBelow(new Map([[A, seq(1)]]), "local", at(100))).unwrap(),
        1,
        "local",
      );
      equal(await floors(store), [seq(3), undefined, seq(1)], "floors after both");
    },
  },
  {
    name: "compaction: lastSeq and maxHlc never regress, even with every event gone",
    run: async () => {
      const store = await filled(await openDriver("compaction-regress"));
      (
        await store.compactBelow(
          new Map([
            [A, seq(3)],
            [B, seq(1)],
          ]),
          "synced",
          at(100),
        )
      ).unwrap();
      (await store.compactBelow(new Map([[A, seq(1)]]), "local", at(100))).unwrap();
      equal((await store.all()).unwrap().length, 0, "log empty");
      equal((await store.lastSeq(A, "synced")).unwrap(), seq(3), "lastSeq A synced");
      equal((await store.lastSeq(A, "local")).unwrap(), seq(1), "lastSeq A local");
      equal((await store.lastSeq(B, "synced")).unwrap(), seq(1), "lastSeq B");
      equal((await store.maxHlc()).unwrap()?.[0].epochMilliseconds, 30, "maxHlc");
    },
  },
  {
    name: "compaction: the recorded floor survives a reopen and never lowers",
    run: async () => {
      const first = await openDriver("compaction-durable");
      const store = await filled(first);
      (await store.compactBelow(new Map([[A, seq(2)]]), "synced", at(100))).unwrap();
      await first.close?.();
      const reopened = (await sqlEventStore(await openDriver("compaction-durable"))).unwrap();
      equal((await reopened.compactedBelow()).unwrap().synced.get(A), seq(2), "floor after reopen");
      equal(
        (await reopened.compactBelow(new Map([[A, seq(1)]]), "synced", at(100))).unwrap(),
        0,
        "nothing below",
      );
      equal((await reopened.compactedBelow()).unwrap().synced.get(A), seq(2), "floor unchanged");
    },
  },
  {
    name: "compaction: an event compaction removed reads as compacted, and one the log never held below the floor does not (gaps U1)",
    run: async () => {
      const store = (await sqlEventStore(await openDriver("compaction-compacted"))).unwrap();
      // A:3 never reached this log (withheld, or scoped out): the gap table records it
      const held = [entry(A, 1, 10), entry(A, 2, 20), entry(A, 4, 40), entry(B, 1, 10)];
      (await store.appendBatch(held)).unwrap();
      (await store.compactBelow(new Map([[A, seq(4)]]), "synced", at(100))).unwrap();
      const asked = async (n: number) => (await store.compacted(event(A, n, n * 10))).unwrap();
      equal([await asked(1), await asked(2), await asked(4)], [true, true, true], "removed");
      equal(await asked(3), false, "the run compaction passed without holding");
      equal(await asked(5), false, "above the floor");
      equal((await store.compacted(event(B, 1, 10))).unwrap(), false, "held, not removed");
      // the late event fills its gap and is held from then on: still not one compaction took
      (await store.append(entry(A, 3, 30))).unwrap();
      equal(await asked(3), false, "held after it arrived");
      equal(ids((await store.all()).unwrap()), [event(B, 1, 10).id, event(A, 3, 30).id], "log");
    },
  },
  {
    name: "compaction: the floor a snapshot install left is kept in the log and only rises (gaps U33)",
    run: async () => {
      const driver = await openDriver("compaction-installed");
      const store = (await sqlEventStore(driver)).unwrap();
      equal((await store.installedBelow()).unwrap().size, 0, "none before an install");
      (await store.recordInstalled(new Map([[A, seq(5)]]))).unwrap();
      (
        await store.recordInstalled(
          new Map([
            [A, seq(3)],
            [B, seq(2)],
          ]),
        )
      ).unwrap();
      const reopened = (await sqlEventStore(driver)).unwrap();
      const installed = (await reopened.installedBelow()).unwrap();
      equal([installed.get(A), installed.get(B)], [seq(5), seq(2)], "raised, never lowered");
    },
  },
  {
    name: "compaction: two installs at once both raise the installed floor (gaps U33)",
    run: async () => {
      const driver = await openDriver("compaction-installed-race");
      const store = (await sqlEventStore(driver)).unwrap();
      const raised = await Promise.all([
        store.recordInstalled(new Map([[A, seq(5)]])),
        store.recordInstalled(new Map([[B, seq(4)]])),
      ]);
      for (const outcome of raised) outcome.unwrap();
      const installed = (await store.installedBelow()).unwrap();
      equal([installed.get(A), installed.get(B)], [seq(5), seq(4)], "neither raise lost");
    },
  },
];
