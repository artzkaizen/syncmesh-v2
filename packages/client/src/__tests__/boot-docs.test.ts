import type { Change, DocChange, RowKey } from "@syncmesh/kernel";
import type { DocumentAdapter } from "@syncmesh/schema";

import { createMemoryEventStore } from "@syncmesh/engine";
import { parseAdapterId } from "@syncmesh/kernel";
import { global, syncSchema, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { openMeshEngine } from "../boot.js";

const loro: DocumentAdapter = { id: "loro@1" };
const schema = syncSchema({
  tables: {
    notes: {
      columns: {
        id: t.text().primaryKey(),
        title: t.text(),
        content: t.blob({ merge: loro }).nullable(),
      },
      partition: global,
    },
  },
});

const device = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 90 + i)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const NONE = { row: () => undefined, partition: () => undefined };

const notes = schema.tables.notes;
const NOTES = notes.name;
// SAFETY: a row key is opaque text
const N1 = "n1" as RowKey;
const { id, title, content } = notes.columnNames;
const doc: DocChange = {
  kind: "doc",
  table: NOTES,
  key: N1,
  column: content,
  adapter: parseAdapterId("loro@1").unwrap(),
  update: { bytes: Uint8Array.of(1) },
};

describe("boot hands the schema's document columns to the validator (RFC-0023 §4.1)", () => {
  test("a doc change on a declared doc column is admitted, a row write to one is refused", async () => {
    const booted = (
      await openMeshEngine({
        schema,
        identity: device,
        // a global table is the authority's to write: this process is it
        authority: device.peerId,
        store: createMemoryEventStore(),
        dataDir: "",
        now: () => T0,
        grantFor: () => undefined,
      })
    ).unwrap();
    const verdict = (changes: readonly Change[]) => {
      const r = booted.validate.validate({ peerId: device.peerId, changes }, NONE);
      return r.isOk() ? "ok" : r.error._tag;
    };
    const insert: Change = {
      kind: "insert",
      table: NOTES,
      key: N1,
      row: new Map([
        [id, "n1"],
        [title, "t"],
      ]),
    };
    expect(verdict([insert, doc])).toBe("ok");
    const update: Change = {
      kind: "update",
      table: NOTES,
      key: N1,
      patch: new Map([[content, Uint8Array.of(1)]]),
    };
    expect(verdict([update])).toBe("DocColumnWrite");
    await booted.close();
  });
});
