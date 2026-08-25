import type { StoredEvent } from "@syncmesh/engine";
import type { SuiteCase } from "@syncmesh/engine";

import { check, equal } from "@syncmesh/engine";
import { parsePartitionKey } from "@syncmesh/kernel";
import { encodeEventCore } from "@syncmesh/wire";

import type { SqliteDriver } from "../driver.js";
import type { OpenDriver } from "./index.js";

import { sqliteEventStore } from "../sqlite-event-store.js";
import { A, B, at, entry, event, hlc, ids2 as ids, seq } from "./fixtures.js";

const ACME = parsePartitionKey("org:acme").unwrap();
const cores = (entries: readonly StoredEvent[]) => entries.map((x) => encodeEventCore(x.event));
const open = async (driver: SqliteDriver) => (await sqliteEventStore(driver)).unwrap();

export const eventCases = (openDriver: OpenDriver): readonly SuiteCase[] => [
  {
    name: "events: core bytes survive, an absent partition stays absent, local survives",
    run: async () => {
      const store = await open(await openDriver("events-roundtrip"));
      const e1 = entry(A, 1, 100, { partition: ACME });
      const e2 = { event: event(A, 2, 101) };
      const e3 = entry(A, 1, 102, { local: true });
      (await store.appendBatch([e1, e2, e3])).unwrap();
      const all = (await store.all()).unwrap();
      equal(cores(all), cores([e1, e2, e3]), "all()");
      equal(all[0]?.event.partition, ACME, "partition");
      check(!("partition" in (all[1]?.event ?? {})), "absent partition must stay absent");
      equal(all[2]?.event.local, true, "local flag");
      check(!("local" in (all[0]?.event ?? {})), "synced event must carry no local flag");
      equal(all[0]?.sig, e1.sig, "a stored signature survives byte-identical");
      check(all[1]?.sig === undefined, "an event stored without a signature stays without one");
    },
  },
  {
    name: "events: append is idempotent; has() answers per scope",
    run: async () => {
      const store = await open(await openDriver("events-idempotent"));
      const e1 = entry(A, 1, 100);
      (await store.append(e1)).unwrap();
      (await store.append(e1)).unwrap();
      (await store.append(entry(A, 1, 100, { local: true }))).unwrap();
      equal((await store.all()).unwrap().length, 2, "stored count");
      equal((await store.has(e1.event.id)).unwrap(), true, "has(synced)");
      equal((await store.has(event(A, 1, 100, { local: true }).id)).unwrap(), true, "has(local)");
      equal((await store.has(event(B, 1, 100).id)).unwrap(), false, "has(unknown)");
    },
  },
  {
    name: "events: allSince runs the per-author floor in the store, per scope, author then sequence",
    run: async () => {
      const store = await open(await openDriver("events-since"));
      const [b2, a3, a1, b1, a2, aLocal] = [
        entry(B, 2, 5),
        entry(A, 3, 4),
        entry(A, 1, 3),
        entry(B, 1, 2),
        entry(A, 2, 1),
        entry(A, 1, 9, { local: true }),
      ];
      (await store.appendBatch([b2, a3, a1, b1, a2, aLocal])).unwrap();
      equal(
        ids((await store.allSince(new Map([[A, a2.event.seqNum]]))).unwrap()),
        ids([a3, b1, b2]),
        "above A:2",
      );
      equal(
        ids((await store.allSince(new Map())).unwrap()),
        ids([a1, a2, a3, b1, b2]),
        "everything synced",
      );
      equal(ids((await store.allSince(new Map(), "local")).unwrap()), ids([aLocal]), "local scope");
    },
  },
  {
    name: "events: lastSeq is per scope; maxHlc is the highest stamp, not the last written",
    run: async () => {
      const store = await open(await openDriver("events-last"));
      (
        await store.appendBatch([
          entry(A, 1, 300),
          entry(A, 2, 200),
          entry(A, 1, 250, { local: true }),
        ])
      ).unwrap();
      equal((await store.lastSeq(A, "synced")).unwrap(), seq(2), "lastSeq synced");
      equal((await store.lastSeq(A, "local")).unwrap(), seq(1), "lastSeq local");
      equal((await store.lastSeq(B, "synced")).unwrap(), undefined, "lastSeq unknown author");
      const max = (await store.maxHlc()).unwrap();
      equal(max?.[0].epochMilliseconds, hlc(300)[0].epochMilliseconds, "maxHlc");
      const empty = await open(await openDriver("events-empty"));
      equal(
        (await empty.maxHlc()).unwrap()?.[0].epochMilliseconds,
        undefined,
        "maxHlc of an empty log",
      );
    },
  },
  {
    name: "events: a driver without transactions is still correct",
    run: async () => {
      const full = await openDriver("events-no-tx");
      const store = await open({ run: full.run, all: full.all });
      (await store.appendBatch([entry(A, 1, 1), entry(A, 2, 2)])).unwrap();
      equal((await store.lastSeq(A, "synced")).unwrap(), seq(2), "lastSeq");
    },
  },
  {
    name: "events: durable — write, close, reopen the same name, read",
    run: async () => {
      const first = await openDriver("events-durable");
      const store = await open(first);
      (await store.appendBatch([entry(A, 1, 1), entry(A, 2, 2)])).unwrap();
      await first.close?.();
      const reopened = await open(await openDriver("events-durable"));
      equal(
        ids((await reopened.all()).unwrap()),
        [event(A, 1, 1).id, event(A, 2, 2).id],
        "after reopen",
      );
    },
  },
  {
    name: "events: corruption and driver failures are StoreFailure values, never throws",
    run: async () => {
      const driver = await openDriver("events-corrupt");
      const store = await open(driver);
      (await store.append(entry(A, 1, 1))).unwrap();
      await driver.run("UPDATE events SET core = X'00'");
      const all = await store.all();
      equal(all.isErr() ? all.error._tag : "ok", "StoreFailure", "corrupt core");
      await driver.run("DROP TABLE events");
      const last = await store.lastSeq(A, "synced");
      equal(last.isErr() ? last.error._tag : "ok", "StoreFailure", "missing table");
      const refused = {
        run: () => Promise.reject(new Error("no disk")),
        all: () => Promise.reject(new Error("no disk")),
      };
      equal((await sqliteEventStore(refused)).isErr(), true, "open over a refusing driver");
      check(at(0).epochMilliseconds === 0, "fixture sanity");
    },
  },
];
