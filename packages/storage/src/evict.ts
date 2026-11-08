import type { StoreFailure } from "@syncmesh/engine";
import type { EventId, ParsedEventId } from "@syncmesh/kernel";

import { parseEventId } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";

import type { EventSql, GapSql } from "./dialect.js";
import type { SqlDriver } from "./driver.js";

import { attempt, failure } from "./sql.js";

/** One author's evicted sequence numbers in one scope. */
interface Run {
  readonly peer: string;
  readonly local: number;
  readonly seqs: number[];
}

const byAuthor = (ids: readonly ParsedEventId[]): readonly Run[] => {
  const runs = new Map<string, Run>();
  for (const { peerId, seqNum, local } of ids) {
    const flag = local ? 1 : 0;
    const key = `${flag}:${peerId}`;
    const run = runs.get(key) ?? { peer: peerId, local: flag, seqs: [] };
    run.seqs.push(seqNum);
    runs.set(key, run);
  }
  return [...runs.keys()].sort().flatMap((key) => runs.get(key) ?? []);
};

/**
 * Deletes the named events and records the hole each one leaves as a gap (D45, D39), so a read of
 * the log does not take an eviction for a torn page. Only a hole below the author's remaining
 * head is recorded: above it a read sees no hole, and the next event to land records the run
 * between as it always does. A later delivery of an evicted event fills its gap again.
 *
 * Resolves to how many events were named; no compaction floor is recorded.
 */
export async function evictEvents(
  driver: SqlDriver,
  sql: { readonly events: EventSql; readonly gaps: GapSql },
  transaction: <T>(fn: () => Promise<T>) => Promise<T>,
  ids: readonly EventId[],
): Promise<Result<number, StoreFailure>> {
  const parsed = Result.all(ids.map(parseEventId)).mapError(failure("malformed event id"));
  if (parsed.isErr()) return parsed;
  return attempt("evict failed", () =>
    transaction(async () => {
      for (const { peer, local, seqs } of byAuthor(parsed.value)) {
        if (sql.gaps.lock !== undefined) await driver.run(sql.gaps.lock, [peer, local]);
        for (const seq of seqs) await driver.run(sql.events.deleteEvent, [peer, seq, local]);
        const [head] = await driver.all(sql.events.selectLastSeq, [peer, local]);
        const remaining = Number(head?.[0] ?? 0);
        for (const seq of seqs)
          if (seq < remaining) await driver.run(sql.gaps.insert, [peer, local, seq, seq]);
      }
      return parsed.value.length;
    }),
  );
}
