import type { SuiteCase } from "@syncmesh/engine";
import type { RowKey } from "@syncmesh/kernel";

import { equal } from "@syncmesh/engine";

import type { OpenDriver } from "./index.js";

import { journaled } from "../journal.js";
import { openStores } from "../open-stores.js";
import { inTransaction } from "../sql.js";
import { A, JOBS, event, seq, stamp } from "./fixtures.js";

// SAFETY: a suite fixture; keys are opaque strings
const J1 = "j1" as RowKey;
const col = JOBS.columnNames;

/**
 * A transaction over both files of a device's SQLite whose log half never landed (RFC-0022):
 * SQLite commits `main` first, and a process killed between the two leaves the log as it was
 * before the transaction. The next open must put the log half back. A driver whose log shares one
 * database with the state commits both at once and has nothing to replay.
 */
export const journalCases = (openDriver: OpenDriver): readonly SuiteCase[] => [
  {
    name: "journal: a log half that never landed is replayed into the log at the next open",
    run: async () => {
      const driver = await openDriver("journal-replay");
      const stores = (await openStores(driver, { tables: [JOBS] })).unwrap();
      if (!journaled(driver)) return;
      const mark = `SELECT value FROM syncmesh.meta WHERE key = 'journal'`;
      const before = (await driver.all(mark))[0]?.[0] ?? null;
      const record = {
        cells: new Map([
          [col.id, { value: J1, stamp: stamp(1) }],
          [col.title, { value: "both", stamp: stamp(1) }],
        ]),
        writeStamp: stamp(1),
      };
      await stores.atomic(async ({ events, state }) => {
        (await events.append({ event: event(A, 1, 100) })).unwrap();
        const coverage = { synced: new Map([[A, seq(1)]]), local: new Map() };
        (await state.commit([{ table: JOBS.name, key: J1, record }], coverage)).unwrap();
      });
      // the log as SQLite leaves it when `main` committed first and the process died: as it was
      // before the transaction, undone on the bare connection so nothing journals the undoing
      await inTransaction(driver, async () => {
        await driver.run(`DELETE FROM syncmesh.events`);
        if (before === null) await driver.run(`DELETE FROM syncmesh.meta WHERE key = 'journal'`);
        else await driver.run(`UPDATE syncmesh.meta SET value = ? WHERE key = 'journal'`, [before]);
      });
      equal((await stores.events.all()).unwrap().length, 0, "the log lost the event");

      const reopened = (await openStores(driver, { tables: [JOBS] })).unwrap();
      equal(
        (await reopened.events.all()).unwrap().map((entry) => entry.event.id),
        [event(A, 1, 100).id],
        "the open replayed the event into the log",
      );
      equal(String((await driver.all(`SELECT title FROM jobs`))[0]?.[0]), "both", "row kept");
    },
  },
];
