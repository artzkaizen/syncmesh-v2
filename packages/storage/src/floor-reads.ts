import type { Coverage, Cursors, EventStore } from "@syncmesh/engine";

import { StoreFailure, higherFloor } from "@syncmesh/engine";
import { Result } from "@syncmesh/result";
import { isSafeNonNegative, isString } from "@syncmesh/wire";

import type { EventSql, GapSql } from "./dialect.js";
import type { SqlDriver, SqlRow, SqlValue } from "./driver.js";

import { attempt, failure, parseCoverage } from "./sql.js";

/** The `installed` value in `meta`: a JSON list of `[peer, seq]` pairs, or no row at all. */
const parseInstalled = (value: SqlValue | undefined): Result<Cursors, StoreFailure> =>
  Result.gen(function* () {
    if (value === undefined || value === null) return Result.ok(new Map());
    const parsed = yield* Result.try({
      // SAFETY: JSON.parse returns JSON; the checks below are what make it pairs
      try: () => JSON.parse(String(value)) as unknown,
      catch: failure("the installed floor is not JSON"),
    });
    if (!Array.isArray(parsed))
      return Result.err(new StoreFailure({ message: "the installed floor is not a list" }));
    const rows: SqlRow[] = [];
    for (const pair of parsed) {
      const [peer, seq] = Array.isArray(pair) ? pair : [];
      if (!isString(peer) || !isSafeNonNegative(seq))
        return Result.err(
          new StoreFailure({ message: "an installed floor entry is not (peer, seq)" }),
        );
      rows.push([peer, 0, seq]);
    }
    return parseCoverage(rows)
      .map(({ synced }) => synced)
      .mapError((e) => (e._tag === "StateCorrupt" ? new StoreFailure({ message: e.message }) : e));
  });

/**
 * The SQL log's answers about what lies under its floors: which events compaction removed (gaps
 * U1), and the floor a snapshot install left (gaps U33).
 *
 * "Removed" is read off what the log already keeps. The gap table records every run the log was
 * written without, and compaction leaves those rows in place, so an event at or below its
 * author's floor that the log does not hold and no gap covers is one compaction took.
 */
export function createFloorReads(
  sql: { readonly driver: SqlDriver; readonly events: EventSql; readonly gaps: GapSql },
  floors: () => Promise<Result<Coverage, StoreFailure>>,
): Pick<EventStore, "compacted" | "installedBelow" | "recordInstalled"> {
  const { driver, events, gaps } = sql;
  const query = (message: string, statement: string, values: readonly SqlValue[] = []) =>
    attempt(message, () => driver.all(statement, values));
  const installedBelow = () =>
    Result.gen(async function* () {
      const rows = yield* Result.await(query("installedBelow failed", gaps.selectInstalled));
      return parseInstalled(rows[0]?.[0]);
    });
  return {
    compacted: (event) =>
      Result.gen(async function* () {
        const local = event.local === true ? 1 : 0;
        const held = yield* Result.await(floors());
        const floor = (local === 1 ? held.local : held.synced).get(event.peerId) ?? 0;
        if (event.seqNum > floor) return Result.ok(false);
        const at = [event.peerId, event.seqNum, local];
        if ((yield* Result.await(query("compacted failed", events.selectHas, at))).length > 0)
          return Result.ok(false);
        const [gap] = yield* Result.await(
          query("compacted failed", gaps.selectAt, [event.peerId, local, event.seqNum]),
        );
        return Result.ok(gap === undefined || Number(gap[1]) < event.seqNum);
      }),
    installedBelow,
    recordInstalled: (floor) =>
      Result.gen(async function* () {
        const held = yield* Result.await(installedBelow());
        const raised = higherFloor(held, floor);
        if (raised.size === held.size && [...raised].every(([peer, seq]) => held.get(peer) === seq))
          return Result.ok(undefined);
        const json = JSON.stringify([...raised]);
        yield* Result.await(
          attempt("recordInstalled failed", () => driver.run(gaps.upsertInstalled, [json])),
        );
        return Result.ok(undefined);
      }),
  };
}
