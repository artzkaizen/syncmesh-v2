import { t, table } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { A, entry, seq } from "../driver-tests/fixtures.js";
import { openStores, schemaName, statePath, storeFiles } from "../open-stores.js";
import { openPair } from "./pair.js";

const dir = mkdtempSync(join(tmpdir(), "syncmesh-schema-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ONE_COLUMN = [table("notes", { id: t.text().primaryKey(), body: t.text() })];
const TWO_COLUMNS = [
  table("notes", { id: t.text().primaryKey(), body: t.text(), title: t.text().nullable() }),
];

describe("the state file is named after the app's schema", () => {
  test("a changed column names a different file, and both hang off one log", () => {
    const before = schemaName(ONE_COLUMN);
    const after = schemaName(TWO_COLUMNS);
    expect(before).not.toBe(after);
    expect(before).toMatch(/^[0-9a-f]{12}$/);
    // twice over the same shape is the same name, or reopening would refold every launch
    expect(schemaName(ONE_COLUMN)).toBe(before);
    // the log is the base: it is what the other files are named after, and it never moves
    const log = join(dir, "notes.db");
    expect(storeFiles(log, before)).toEqual([log, statePath(log, before)]);
    expect(statePath(log, before).startsWith(log)).toBe(true);
  });

  test("changing the schema opens an empty file beside the log, and refolds into it", async () => {
    const log = join(dir, "refold.db");
    const first = await openPair(log, schemaName(ONE_COLUMN));
    const opened = (await openStores(first, { tables: ONE_COLUMN })).unwrap();
    (await opened.events.append(entry(A, 1, 100))).unwrap();
    await opened.close();

    const second = await openPair(log, schemaName(TWO_COLUMNS));
    const reopened = (await openStores(second, { tables: TWO_COLUMNS })).unwrap();
    // the log is the same file, so the events are all still there…
    expect((await reopened.events.all()).unwrap()).toHaveLength(1);
    // …and the new shape's rows are in a new file, leaving the old one untouched
    expect(existsSync(statePath(log, schemaName(ONE_COLUMN)))).toBe(true);
    expect(existsSync(statePath(log, schemaName(TWO_COLUMNS)))).toBe(true);
    expect((await reopened.state.isEmpty()).unwrap()).toBe(true);
    await reopened.close();
  });

  test("a compacted log refuses the new shape rather than opening an empty database", async () => {
    const log = join(dir, "compacted.db");
    const first = await openPair(log, schemaName(ONE_COLUMN));
    const opened = (await openStores(first, { tables: ONE_COLUMN })).unwrap();
    (await opened.events.append(entry(A, 1, 100))).unwrap();
    // below the floor the folded state is the only copy — the log can no longer produce it
    (
      await opened.events.compactBelow(
        new Map([[A, seq(2)]]),
        "synced",
        Temporal.Instant.fromEpochMilliseconds(1_000),
      )
    ).unwrap();
    await opened.close();

    const second = await openPair(log, schemaName(TWO_COLUMNS));
    const refused = await openStores(second, { tables: TWO_COLUMNS });
    expect(refused.isErr()).toBe(true);
    expect(refused.match({ ok: () => "", err: (e) => e.message })).toContain("compacted");
    await second.close?.();

    // and the shape it was compacted under still opens, because that file was never replaced
    const again = await openPair(log, schemaName(ONE_COLUMN));
    const reopened = (await openStores(again, { tables: ONE_COLUMN })).unwrap();
    await reopened.close();
  });

  test("a log that took rows from a snapshot install refuses the new shape too (gaps U33)", async () => {
    const log = join(dir, "installed.db");
    const first = await openPair(log, schemaName(ONE_COLUMN));
    const opened = (await openStores(first, { tables: ONE_COLUMN })).unwrap();
    // an install's rows have no events behind them: only the state file holds them
    (await opened.events.recordInstalled(new Map([[A, seq(5)]]))).unwrap();
    await opened.close();

    const second = await openPair(log, schemaName(TWO_COLUMNS));
    const refused = await openStores(second, { tables: TWO_COLUMNS });
    expect(refused.match({ ok: () => "", err: (e) => e.message })).toContain("snapshot install");
    await second.close?.();
  });
});
