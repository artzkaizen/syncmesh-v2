import type { Coverage } from "@syncmesh/engine";
import type { SeqNum } from "@syncmesh/kernel";

import { LogTorn, StoreFailure } from "@syncmesh/engine";
import { Result } from "@syncmesh/result";

import type { GapSql } from "./dialect.js";
import type { SqlDriver } from "./driver.js";
import type { Hole, Positioned } from "./holes.js";

import { readHoles, unaccounted } from "./holes.js";
import { attempt, inTransaction } from "./sql.js";

/** What a read of the log needs to tell a hole the log was written with from a torn one. */
export interface LogReader {
  readonly driver: SqlDriver;
  /** The store runs inside its caller's transaction (`SqlEventStoreOptions.nested`). */
  readonly nested: boolean;
  readonly gaps: GapSql;
  readonly floors: () => Promise<Result<Coverage, StoreFailure>>;
}

type Start = Parameters<typeof readHoles>[1];

/**
 * The holes in `entries` that neither compaction nor the gap table accounts for: the floors
 * and the gaps are read only when the entries themselves show a hole.
 */
const torn = (
  reader: LogReader,
  entries: readonly Positioned[],
  start: Start,
): Promise<Result<readonly Hole[], StoreFailure>> =>
  Result.gen(async function* () {
    const holes = readHoles(entries, start);
    if (holes.length === 0) return Result.ok([]);
    const floors = yield* Result.await(reader.floors());
    const gaps = yield* Result.await(
      attempt("reading the log's gaps failed", () => reader.driver.all(reader.gaps.selectAll)),
    );
    return Result.ok(unaccounted(holes, floors, gaps));
  });

/**
 * Runs `fn` where every statement sees the log at one instant: in one transaction, in the
 * driver's turn, under the dialect's `GapSql.snapshot`. A nested store reads in its caller's
 * transaction as it stands.
 */
const atOnce = <T>(reader: LogReader, fn: () => Promise<Result<T, StoreFailure>>) => {
  const { driver, gaps } = reader;
  if (reader.nested) return fn();
  return attempt("reading the log at one instant failed", () =>
    inTransaction(driver, async () => {
      if (gaps.snapshot !== undefined) await driver.run(gaps.snapshot);
      return fn();
    }),
  ).then((read) => read.andThen((result) => result));
};

/**
 * What `select` reads, or `StoreFailure("log has a hole")` when a run is missing below a later
 * event of the same author that neither compaction nor the gap table accounts for.
 *
 * The first read takes the entries, the floors and the gaps as three statements, and an append
 * between them can show a sound log as torn: a late event that fills a gap deletes its row after
 * the entries were read without it. So a hole is refused only when a second read, of all three
 * at one instant ({@link atOnce}), still finds it. A healthy log pays nothing for that, and a
 * log whose holes are all recorded pays only the floors and the gaps.
 */
export const readWhole = <E extends Positioned>(
  reader: LogReader,
  select: () => Promise<Result<readonly E[], StoreFailure>>,
  start: Start,
): Promise<Result<readonly E[], StoreFailure>> =>
  Result.gen(async function* () {
    const entries = yield* Result.await(select());
    const seen = yield* Result.await(torn(reader, entries, start));
    if (seen.length === 0) return Result.ok(entries);
    const [again, missing] = yield* Result.await(
      atOnce(reader, () =>
        Result.gen(async function* () {
          const read = yield* Result.await(select());
          return Result.ok([read, yield* Result.await(torn(reader, read, start))] as const);
        }),
      ),
    );
    const [first] = missing;
    if (first === undefined) return Result.ok(again);
    const scope = first.local ? "local" : "synced";
    const message = `log has a hole: ${missing.length} run(s) of events it held are gone, first ${first.peer} ${scope} ${first.from}..${first.to} — the disk lost committed pages; rejoin from a peer`;
    // the runs ride as the cause, so a mesh can name them as a recovery issue and ask for them
    // SAFETY: a hole lies between two sequence numbers the log held, so both ends are positive
    const runs = missing.map((hole) => ({
      ...hole,
      from: hole.from as SeqNum,
      to: hole.to as SeqNum,
    }));
    return Result.err(new StoreFailure({ message, cause: new LogTorn({ runs, message }) }));
  });
