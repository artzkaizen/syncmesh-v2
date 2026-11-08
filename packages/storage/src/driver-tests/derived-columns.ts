import type { RowWrite, SuiteCase } from "@syncmesh/engine";
import type { CellValue, ColumnName, RowKey, RowRecord } from "@syncmesh/kernel";

import { EMPTY_COVERAGE as NONE, equal } from "@syncmesh/engine";
import { panic } from "@syncmesh/result";

import type { OpenDriver } from "./index.js";

import { captureChanges } from "../capture.js";
import { openStores } from "../open-stores.js";
import { ACME, DERIVED_NOTES, N1, sqlText, stamp } from "./fixtures.js";

/*
 * A column derived from a document (RFC-0023 §4.1, §16.4): each replica computes its value and
 * writes it into its own row, through the state store's `derive`. The fold never writes it, capture
 * never carries it, and the app's statement that sets one is refused, like one that sets the
 * document itself.
 */

export const derivedColumnCases = (openDriver: OpenDriver): readonly SuiteCase[] => [
  {
    name: "tables: a derived column is the replica's — derive sets it, a fold keeps it, a missing row stays missing",
    run: async () => {
      const driver = await openDriver("tables-derived");
      const { state } = (await openStores(driver, { tables: [DERIVED_NOTES] })).unwrap();
      const { id, body, title, words } = DERIVED_NOTES.columnNames;
      const note = (text: string, ms: number): RowRecord => ({
        cells: new Map([
          [id, { value: N1, stamp: stamp(ms) }],
          [body, { value: text, stamp: stamp(ms) }],
        ]),
        writeStamp: stamp(ms),
        partition: ACME,
      });
      const write = (record: RowRecord): RowWrite => ({
        table: DERIVED_NOTES.name,
        key: N1,
        record,
      });
      const read = async () =>
        (await driver.all(`SELECT body, title, words FROM derived_notes`)).map((row) =>
          row.map((cell) => (cell === null ? null : String(cell))),
        );
      (await state.commit([write(note("one", 1))], NONE)).unwrap();
      equal(await read(), [["one", null, null]], "the fold writes no derived column");
      const derive = state.derive ?? panic("a store with tables writes derived columns");
      (
        await derive([
          {
            table: DERIVED_NOTES.name,
            key: N1,
            // `body` is no derived column: a value for it is not written
            values: new Map<ColumnName, CellValue>([
              [title, "Q3 plan"],
              [words, 2],
              [body, "forged"],
            ]),
          },
          // SAFETY: suite fixture; keys are opaque strings
          { table: DERIVED_NOTES.name, key: "n9" as RowKey, values: new Map([[title, "ghost"]]) },
        ])
      ).unwrap();
      equal(await read(), [["one", "Q3 plan", "2"]], "derived values land in the row");
      (await state.commit([write(note("two", 2))], NONE)).unwrap();
      equal(await read(), [["two", "Q3 plan", "2"]], "a later fold keeps them");
    },
  },
  {
    name: "capture: a derived column never travels, and the app's write to one is refused",
    run: async () => {
      const driver = await openDriver("capture-derived");
      const L = sqlText(driver);
      const { state } = (await openStores(driver, { tables: [DERIVED_NOTES] })).unwrap();
      const insert = (
        await captureChanges(driver, [DERIVED_NOTES], () =>
          driver.run(`INSERT INTO derived_notes (id, body) VALUES (${L.p(1)}, ${L.p(2)})`, [
            "n1",
            "b",
          ]),
        )
      ).unwrap();
      equal(
        insert.map((change) => (change.kind === "insert" ? [...change.row.keys()].join(",") : "")),
        ["id,body"],
        "an insert carries neither the derived nor the document columns",
      );
      const { title } = DERIVED_NOTES.columnNames;
      const derive = state.derive ?? panic("a store with tables writes derived columns");
      (
        await derive([{ table: DERIVED_NOTES.name, key: N1, values: new Map([[title, "T"]]) }])
      ).unwrap();
      const edit = (
        await captureChanges(driver, [DERIVED_NOTES], () =>
          driver.run(`UPDATE derived_notes SET body = ${L.p(1)}`, ["c"]),
        )
      ).unwrap();
      equal(
        edit.map((change) => (change.kind === "update" ? [...change.patch.keys()].join(",") : "")),
        ["body"],
        "an edit of a row whose title was derived carries only what the app wrote",
      );
      const forged = await captureChanges(driver, [DERIVED_NOTES], () =>
        driver.run(`UPDATE derived_notes SET title = ${L.p(1)}`, ["mine"]),
      );
      equal(forged.isErr() ? forged.error._tag : "ok", "DocColumnWrite", "a write of a title");
      const named = await captureChanges(driver, [DERIVED_NOTES], () =>
        driver.run(
          `INSERT INTO derived_notes (id, body, words) VALUES (${L.p(1)}, ${L.p(2)}, ${L.p(3)})`,
          ["n2", "x", 7],
        ),
      );
      equal(named.isErr() ? named.error._tag : "ok", "DocColumnWrite", "an insert naming one");
      const [row] = await driver.all(`SELECT title FROM derived_notes WHERE id = ${L.p(1)}`, [
        "n1",
      ]);
      equal(String(row?.[0]), "T", "the refused write rolled back");
    },
  },
  {
    name: "capture: an insert that leaves a defaulted derived column out is no write to it",
    run: async () => {
      const driver = await openDriver("capture-derived-default");
      const L = sqlText(driver);
      const blob = driver.dialect === "postgres" ? "BYTEA" : "BLOB";
      // the app's own migration made the table first, with RFC-0023 §4.1's `default("")`
      await driver.run(
        `CREATE TABLE derived_notes (id TEXT PRIMARY KEY, body TEXT, title TEXT NOT NULL DEFAULT '', words INTEGER DEFAULT 0, content ${blob}, "_partition" TEXT)`,
      );
      (await openStores(driver, { tables: [DERIVED_NOTES] })).unwrap();
      const insert = await captureChanges(driver, [DERIVED_NOTES], () =>
        driver.run(`INSERT INTO derived_notes (id, body) VALUES (${L.p(1)}, ${L.p(2)})`, [
          "n1",
          "b",
        ]),
      );
      equal(
        insert.isOk() ? insert.value.map((change) => change.kind) : insert.error._tag,
        ["insert"],
        "the defaults are the table's, not the app's write",
      );
      const named = await captureChanges(driver, [DERIVED_NOTES], () =>
        driver.run(`INSERT INTO derived_notes (id, title) VALUES (${L.p(1)}, ${L.p(2)})`, [
          "n2",
          "mine",
        ]),
      );
      equal(named.isErr() ? named.error._tag : "ok", "DocColumnWrite", "an insert naming one");
    },
  },
];
