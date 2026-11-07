import type { StoredEvent } from "@syncmesh/engine";
import type { SuiteCase } from "@syncmesh/engine";

import { check, equal } from "@syncmesh/engine";
import { parsePartitionKey } from "@syncmesh/kernel";
import { bytesEqual as equalBytes, encodeEventCore } from "@syncmesh/wire";

import type { SqlDriver } from "../driver.js";
import type { OpenDriver } from "./index.js";

import { sqlEventStore } from "../event-store.js";
import { A, B, at, entry, event, grownEntry, hlc, ids2 as ids, seq, sqlOf } from "./fixtures.js";

const ACME = parsePartitionKey("org:acme").unwrap();
const cores = (entries: readonly StoredEvent[]) => entries.map((x) => encodeEventCore(x.event));
const open = async (driver: SqlDriver) => (await sqlEventStore(driver)).unwrap();

/**
 * What the `core` column has to preserve, apart from what the store has to do with an event: the
 * bytes an author signed come back as they arrived, and an own write's column is its own encoding.
 * Its own seam because the two questions fail for different reasons and read as different suites.
 */
const coreCases = (openDriver: OpenDriver): readonly SuiteCase[] => [
  {
    name: "events: the core the author signed comes back verbatim, unknown keys and all",
    run: async () => {
      const store = await open(await openDriver("events-core-verbatim"));
      const newer = grownEntry(A, 1, 100);
      (await store.append(newer)).unwrap();
      const [held] = (await store.all()).unwrap();
      // the column is the bytes the signature covers, not a re-encode of what this build could read
      equal(held?.core, newer.core, "stored core");
      equal(held?.sig, newer.sig, "stored signature");
      equal(held?.event.id, newer.event.id, "the decoded event is still this one");
      check(
        !equalBytes(newer.core, encodeEventCore(newer.event)),
        "this case is only a test while the decoder really drops the added key",
      );

      // the other direction: an event this device authored has no arrival bytes to keep, so the
      // NOT NULL column is filled from the event itself and comes back as exactly that encoding
      const own = entry(A, 2, 200);
      (await store.append(own)).unwrap();
      const mine = (await store.all()).unwrap().find((x) => x.event.id === own.event.id);
      equal(mine?.core, encodeEventCore(own.event), "an own write's column is its own encoding");
      equal(mine?.event.id, own.event.id, "and it decodes back to the event it was written from");
    },
  },
];

export const eventCases = (openDriver: OpenDriver): readonly SuiteCase[] => [
  ...coreCases(openDriver),
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
    /**
     * The audit `openEngine` runs at every boot. An unsigned entry is this device's own write
     * until the day the device takes a new key — after which the same row is a write nobody can
     * sign and nobody will ever receive, and the only thing standing between that and silence is
     * this statement returning it.
     */
    name: "events: stranded() finds the unsigned writes of an author this device is no longer",
    run: async () => {
      const store = await open(await openDriver("events-stranded"));
      const signed = entry(A, 1, 100);
      const retired = { event: event(A, 2, 101) }; // authored here, before the key changed
      const mine = { event: event(B, 1, 102) }; // authored here, under the key in hand now
      const localOnly = { event: event(A, 1, 103, { local: true }) }; // never going anywhere
      (await store.appendBatch([signed, retired, mine, localOnly])).unwrap();

      // asked as B: A's unsigned write is the one nobody here can sign. The signed entry is
      // relayable whoever asks, and the local one was never leaving.
      equal(cores((await store.stranded(B)).unwrap()), cores([retired]), "stranded(B)");
      // and the predicate really is "unsigned, and not mine", not "unsigned, by A"
      equal(cores((await store.stranded(A)).unwrap()), cores([mine]), "stranded(A)");
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
      // everything but the transaction, rather than an allow-list of what to keep: naming the
      // parts to carry meant the next property added to the port was dropped here in silence,
      // and `log` was — the store then named `syncmesh.events` at a connection that has one
      // database, which is a different failure wearing this test's name
      const { transaction: _withoutIt, ...bare } = full;
      const store = await open(bare);
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
      const names = sqlOf(driver);
      await driver.run(`UPDATE ${names.events} SET core = ${names.junk}`);
      const all = await store.all();
      equal(all.isErr() ? all.error._tag : "ok", "StoreFailure", "corrupt core");
      await driver.run(`DROP TABLE ${names.events}`);
      const last = await store.lastSeq(A, "synced");
      equal(last.isErr() ? last.error._tag : "ok", "StoreFailure", "missing table");
      const refused = {
        run: () => Promise.reject(new Error("no disk")),
        all: () => Promise.reject(new Error("no disk")),
      };
      equal((await sqlEventStore(refused)).isErr(), true, "open over a refusing driver");
      check(at(0).epochMilliseconds === 0, "fixture sanity");
    },
  },
];
