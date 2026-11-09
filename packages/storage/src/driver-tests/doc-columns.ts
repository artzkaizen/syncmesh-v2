import type { RowWrite, SuiteCase } from "@syncmesh/engine";
import type { RowRecord } from "@syncmesh/kernel";

import { EMPTY_COVERAGE as NONE, equal } from "@syncmesh/engine";

import type { OpenDriver } from "./index.js";

import { captureChanges, installCapture } from "../capture.js";
import { openStores } from "../open-stores.js";
import { ACME, DOC_NOTES, N1, asFold, sqlText, stamp } from "./fixtures.js";

/*
 * A document column in the app's table (RFC-0023 §6.1): the kernel's cell holds the lineage, the
 * SQL column the snapshot only the materialiser writes. Neither direction of the D20 write path —
 * the fold into the table, the app's statements back out — may touch it.
 */

export const docColumnCases = (openDriver: OpenDriver): readonly SuiteCase[] => [
  {
    name: "tables: a document column is the materialiser's — the fold never writes its lineage cell there",
    run: async () => {
      const driver = await openDriver("tables-doc");
      const L = sqlText(driver);
      const { state } = (await openStores(driver, { tables: [DOC_NOTES] })).unwrap();
      const note = (title: string, ms: number): RowRecord => ({
        cells: new Map([
          [DOC_NOTES.columnNames.id, { value: N1, stamp: stamp(ms) }],
          [DOC_NOTES.columnNames.title, { value: title, stamp: stamp(ms) }],
          // what a genesis leaves in the kernel: the lineage id, as hex text
          [DOC_NOTES.columnNames.content, { value: "ab".repeat(16), stamp: stamp(ms) }],
        ]),
        writeStamp: stamp(ms),
        partition: ACME,
      });
      const write = (record: RowRecord): RowWrite => ({ table: DOC_NOTES.name, key: N1, record });
      (await state.commit([write(note("one", 1))], NONE)).unwrap();
      const read = async () => (await driver.all(`SELECT title, content FROM doc_notes`))[0];
      const fresh = (await read())?.[1] ?? null;
      equal(fresh === null ? null : String(fresh), null, "a new row's snapshot starts empty");
      const snapshot = Uint8Array.of(7, 8, 9);
      // the materialiser's write, which passes the strict guard as the fold's does
      await asFold(driver, () =>
        driver.run(`UPDATE doc_notes SET content = ${L.p(1)}`, [snapshot]),
      );
      (await state.commit([write(note("two", 2))], NONE)).unwrap();
      const [title, content] = (await read()) ?? [];
      equal(String(title), "two", "the row's values still land");
      equal(content instanceof Uint8Array ? content : undefined, snapshot, "the snapshot is kept");
    },
  },
  {
    name: "capture: a document column is never a row change, and the app's write to one is refused",
    run: async () => {
      const driver = await openDriver("capture-doc");
      const L = sqlText(driver);
      (await installCapture(driver, [DOC_NOTES])).unwrap();
      const changes = (
        await captureChanges(driver, [DOC_NOTES], () =>
          driver.run(`INSERT INTO doc_notes (id, title) VALUES (${L.p(1)}, ${L.p(2)})`, [
            "n1",
            "t",
          ]),
        )
      ).unwrap();
      equal(
        changes.map((change) => (change.kind === "insert" ? [...change.row.keys()].join(",") : "")),
        ["id,title"],
        "values only",
      );
      const inserted = await captureChanges(driver, [DOC_NOTES], () =>
        driver.run(
          `INSERT INTO doc_notes (id, title, content) VALUES (${L.p(1)}, ${L.p(2)}, ${L.p(3)})`,
          ["n2", "u", Uint8Array.of(1)],
        ),
      );
      equal(inserted.isErr() ? inserted.error._tag : "ok", "DocColumnWrite", "an insert naming it");
      const touched = await captureChanges(driver, [DOC_NOTES], () =>
        driver.run(`UPDATE doc_notes SET content = ${L.p(1)}`, [Uint8Array.of(2)]),
      );
      equal(touched.isErr() ? touched.error._tag : "ok", "DocColumnWrite", "an update of it");
      const rows = await driver.all(`SELECT id, content FROM doc_notes`);
      equal(
        rows.map(([id, content]) => [String(id), content === null ? null : "bytes"]),
        [["n1", null]],
        "both refusals rolled back",
      );
    },
  },
];
