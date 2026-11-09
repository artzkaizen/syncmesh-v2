import type { EventStore } from "@syncmesh/engine";
import type { Table } from "@syncmesh/schema";

import { StoreFailure, refoldable } from "@syncmesh/engine";
import { Result } from "@syncmesh/result";

import type { SqlDriver } from "./driver.js";
import type { StrictCapture } from "./guard.js";

import { captureStatements, installCapture } from "./capture.js";
import { driverDialect } from "./dialect.js";
import { guardStatements, installGuard } from "./guard.js";
import { rowSyncDdlFor } from "./row-sync.js";
import { attempt } from "./sql.js";

/**
 * The app's tables and their capture, installed **only when this database has not got them.**
 *
 * Every statement here is `IF NOT EXISTS`, so running them all on every launch was correct and
 * quietly wasteful: forty-odd statements to parse, per open, to discover there was nothing to do.
 * What replaces that is one read of one row. The row holds the exact DDL last installed, so
 * "unchanged" is string equality rather than a version somebody has to remember to bump — add a
 * column, add a table, change a dialect, and the text differs and everything is reinstalled.
 *
 * The one thing it cannot see is a change made *around* it: drop a trigger by hand and this will
 * still say the schema is installed. A whole state file deleted is the exception it does see: the
 * record is the log's, so it also asks the state half whether an install is there (gaps U39). That is the same bargain every migration table makes, and
 * the repair is the same — clear the row, or the file.
 *
 * **A changed schema is only free while the log can still produce the rows.** The row it compares
 * lives in the log, which is shared; the file it is comparing against is the derived half, which
 * `schemaName` gives a different name to for every shape. So changing a column normally opens
 * an empty file and refolds into it, and the previous shape's file is an orphan nobody reads.
 * Once the log has been compacted, or has taken rows from a snapshot install (gaps U33), that
 * stops being true — the old file holds rows no fold can produce again — and the open refuses
 * rather than silently presenting an empty database.
 */
export const installSchema = (
  driver: SqlDriver,
  tables: readonly Table[],
  events: EventStore,
  strict: StrictCapture | undefined,
): Promise<Result<void, StoreFailure>> =>
  Result.gen(async function* () {
    const { schema, name: dialect } = driverDialect(driver);
    const rowSyncDdl = rowSyncDdlFor(dialect);
    const wanted = [...captureStatements(driver, tables), ...rowSyncDdl].join(";\n");
    // the strict guard has its own row: it is no part of the tables' shape, so turning it on or
    // off neither renames the state file nor counts as a shape change a compacted log refuses
    const guard = guardStatements(driver, tables, strict).join(";\n");
    const [held, guarded, present] = yield* Result.await(
      attempt("could not read the installed schema", async () => {
        await driver.run(schema.ddl);
        const [row] = await driver.all(schema.read);
        const [guardRow] = await driver.all(schema.readGuard);
        const installed = await driver.all(schema.installed);
        return [row?.[0], guardRow?.[0], installed.length > 0] as const;
      }),
    );
    // the record is the log's, and a state file deleted on its own leaves it behind: the same
    // shape over a file with none of its tables is installed again and refolded into, not skipped
    if (held === wanted && present) {
      if (guarded === guard) return Result.ok(undefined);
      yield* Result.await(installGuard(driver, tables, strict));
      yield* Result.await(
        attempt("could not record the strict-capture guard", () =>
          driver.run(schema.writeGuard, [guard]),
        ),
      );
      return Result.ok(undefined);
    }
    if (held !== undefined && !(yield* Result.await(refoldable(events)))) {
      return Result.err(
        new StoreFailure({
          message:
            "the app's tables changed shape and this log cannot rebuild every row — it has been compacted, or rows came from a snapshot install with no events behind them, and those exist only in the state file the previous shape wrote, so there is nothing left to refold them from. Keep the previous schema, or rejoin from a peer.",
        }),
      );
    }
    yield* Result.await(
      attempt("the app schema failed to install", async () => {
        await installCapture(driver, tables, { strict: strict ?? true }).then((done) =>
          done.unwrap(),
        );
        for (const statement of rowSyncDdl) await driver.run(statement);
        await driver.run(schema.write, [wanted]);
        await driver.run(schema.writeGuard, [guard]);
      }),
    );
    return Result.ok(undefined);
  });
