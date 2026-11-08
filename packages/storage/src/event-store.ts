import type { Coverage, EventStore, StoredEvent } from "@syncmesh/engine";
import type { Hlc } from "@syncmesh/kernel";

import { DEFAULT_RECENT, StoreFailure } from "@syncmesh/engine";
import { eventId, parseEventId } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";
import { decodeEventCore, encodeEventCore } from "@syncmesh/wire";

import type { GapSql } from "./dialect.js";
import type { SqlDriver, SqlRow, SqlValue } from "./driver.js";
import type { Hole } from "./holes.js";

import { driverDialect } from "./dialect.js";
import { readHoles, unaccounted } from "./holes.js";
import { attempt, coverageOf, failure, headerRow, hlcRow, inTransaction, seqOf } from "./sql.js";

/**
 * The `core` column holds the bytes the author's signature covers, not a re-encode of what this
 * build could read: `decodeEventCore` ignores map keys it has no name for, and re-encoding a
 * newer peer's event on the way back out would send bytes its signature does not cover.
 *
 * An event this device authored arrives here with no core — nothing has signed it yet — and is
 * encoded to fill the NOT NULL column. Those bytes are never forwarded: `envelopeOf` re-signs an
 * own event through `signEvent`, which encodes and signs in the same step.
 */
const params = ({ event, core, sig }: StoredEvent): readonly SqlValue[] => [
  event.peerId,
  event.seqNum,
  event.local === true ? 1 : 0,
  event.hlc[0].epochMilliseconds,
  event.hlc[1],
  event.partition ?? null,
  core ?? encodeEventCore(event),
  sig ?? null,
];

/**
 * One `(core, local, sig)` row back to the entry that was stored; the local flag rebuilds the id
 * the core does not carry. Shared with the `localStorage` log, so the two stores can never
 * disagree about what a stored event is.
 *
 * The core comes back as the entry's `core`, which is what a relay forwards. Rows written before
 * the log kept arrival bytes hold a re-encode under that column, so such a row relays exactly as
 * it did before this change — including refusal at the far side for an event that arrived with a
 * field this build's decoder dropped.
 *
 * Nothing repairs such a row in place, and it would be wrong to claim otherwise: the insert is
 * idempotent by `(peer, seq, local)` and a re-arrival is dropped by `admit`'s `store.has` before
 * the store ever sees it, so the column keeps what it has for the life of the database. The event
 * itself stays reachable — a peer can still get it from its author — but not through this row and
 * not through this device. Only compaction removes it.
 */
export function decodeStoredEvent(row: SqlRow): Result<StoredEvent, StoreFailure> {
  const [core, local, sig] = row;
  if (!(core instanceof Uint8Array)) {
    return Result.err(new StoreFailure({ message: "event core is not a blob" }));
  }
  return decodeEventCore(core)
    .mapError(failure("stored event does not decode"))
    .map((decoded) => {
      const event =
        local === 1
          ? { ...decoded, id: eventId(decoded.peerId, decoded.seqNum, true), local: true as const }
          : decoded;
      return { event, core, sig: sig instanceof Uint8Array ? sig : undefined };
    });
}

const decodeRows = (rows: readonly SqlRow[]) => Result.all(rows.map(decodeStoredEvent));

/**
 * The stamp a page starts below, as the statement binds it.
 *
 * No cursor is a cursor above every stored stamp rather than a second statement without the
 * predicate: the log stores milliseconds since the epoch, nothing in it is at the end of safe
 * integers, and one statement that always binds three values is one statement to keep right.
 */
const stampBound = (before: Hlc | undefined): readonly SqlValue[] =>
  before === undefined ? [Number.MAX_SAFE_INTEGER, 0] : [before[0].epochMilliseconds, before[1]];

/**
 * Takes the dialect's per-author lock (`GapSql.lock`) for every author in `entries`, in one order,
 * before any head is read: two batches naming the same authors queue rather than deadlock.
 */
const hold = async (
  driver: SqlDriver,
  lock: string | undefined,
  entries: readonly StoredEvent[],
) => {
  if (lock === undefined) return;
  const authors = new Map<string, readonly [string, number]>();
  for (const { event } of entries) {
    const local = event.local === true ? 1 : 0;
    authors.set(`${local}:${event.peerId}`, [event.peerId, local]);
  }
  for (const key of [...authors.keys()].sort()) {
    const author = authors.get(key);
    if (author !== undefined) await driver.run(lock, author);
  }
};

/** What a read of the log needs to tell a hole the log was written with from a torn one. */
interface LogReader {
  readonly driver: SqlDriver;
  /** The store runs inside its caller's transaction (`SqlEventStoreOptions.nested`). */
  readonly nested: boolean;
  readonly gaps: GapSql;
  readonly floors: () => Promise<Result<Coverage, StoreFailure>>;
}

type Select = () => Promise<Result<readonly StoredEvent[], StoreFailure>>;
type Start = Parameters<typeof readHoles>[1];

/**
 * The holes in `entries` that neither compaction nor the gap table accounts for: the floors
 * and the gaps are read only when the entries themselves show a hole.
 */
const torn = (
  reader: LogReader,
  entries: readonly StoredEvent[],
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
const readWhole = (
  reader: LogReader,
  select: Select,
  start: Start,
): Promise<Result<readonly StoredEvent[], StoreFailure>> =>
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
    return Result.err(
      new StoreFailure({
        message: `log has a hole: ${missing.length} run(s) of events it held are gone, first ${first.peer} ${scope} ${first.from}..${first.to} — the disk lost committed pages; rejoin from a peer`,
      }),
    );
  });

/**
 * Opens the event log in the database behind `driver`, creating or migrating its tables in the
 * driver's dialect — `events` on a device's SQLite, `_syncmesh_events` in an app's Postgres.
 *
 * @example
 * const store = (await sqlEventStore(bunSqlDriver("app.db"))).unwrap();
 */
export interface SqlEventStoreOptions {
  /**
   * The caller holds the transaction: the store runs its statements as they come and never opens
   * one of its own. What `openStores(...).atomic` builds, so the log and the state commit together.
   */
  readonly nested?: boolean;
}

export function sqlEventStore(
  driver: SqlDriver,
  options: SqlEventStoreOptions = {},
): Promise<Result<EventStore, StoreFailure>> {
  const { events: SQL, gaps: GAPS, migrate } = driverDialect(driver);
  const transaction = <T>(fn: () => Promise<T>): Promise<T> =>
    options.nested === true ? fn() : inTransaction(driver, fn);
  const query = (message: string, sql: string, values: readonly SqlValue[] = []) =>
    attempt(message, () => driver.all(sql, values));

  /**
   * Takes `seq` out of the recorded gap that holds it: an event that arrives late fills its hole,
   * and a later tear of that event is then damage like any other.
   */
  const fill = async (peer: string, local: number, seq: number) => {
    const [gap] = await driver.all(GAPS.selectAt, [peer, local, seq]);
    if (gap === undefined) return;
    const [from, to] = [Number(gap[0]), Number(gap[1])];
    if (to < seq) return;
    await driver.run(GAPS.delete, [peer, local, from]);
    if (from < seq) await driver.run(GAPS.insert, [peer, local, from, seq - 1]);
    if (seq < to) await driver.run(GAPS.insert, [peer, local, seq + 1, to]);
  };

  /**
   * Inserts one entry and keeps the gap table true (D39): an event landing above its author's
   * highest held sequence plus one records the run between as a gap the log was written with, and
   * one landing below it fills whatever gap held it. `heads` carries each author's highest
   * sequence through a batch, so a run appended in order asks the database once per author.
   */
  const insert = async (entry: StoredEvent, heads: Map<string, number>) => {
    const { peerId, seqNum } = entry.event;
    const local = entry.event.local === true ? 1 : 0;
    const key = `${local}:${peerId}`;
    const head =
      heads.get(key) ?? Number((await driver.all(SQL.selectLastSeq, [peerId, local]))[0]?.[0] ?? 0);
    await driver.run(SQL.insert, params(entry));
    if (seqNum > head + 1) await driver.run(GAPS.insert, [peerId, local, head + 1, seqNum - 1]);
    else if (seqNum < head) await fill(peerId, local, seqNum);
    heads.set(key, Math.max(head, seqNum));
  };

  const reader = {
    driver,
    nested: options.nested === true,
    gaps: GAPS,
    floors: () => store.compactedBelow(),
  } satisfies LogReader;
  const whole = (select: Select, start: Start) => readWhole(reader, select, start);

  const appendAll = async (entries: readonly StoredEvent[]) => {
    await hold(driver, GAPS.lock, entries);
    const heads = new Map<string, number>();
    for (const entry of entries) await insert(entry, heads);
  };

  const store: EventStore = {
    append: (entry) => attempt("append failed", () => transaction(() => appendAll([entry]))),
    appendBatch: (entries) =>
      attempt("appendBatch failed", () => transaction(() => appendAll(entries))),
    has: (id) =>
      Result.gen(async function* () {
        const { peerId, seqNum, local } = yield* parseEventId(id).mapError(
          failure("malformed event id"),
        );
        const rows = yield* Result.await(
          query("has failed", SQL.selectHas, [peerId, seqNum, local ? 1 : 0]),
        );
        return Result.ok(rows.length > 0);
      }),
    all: () =>
      whole(
        () => query("all failed", SQL.selectAll).then((rows) => rows.andThen(decodeRows)),
        () => 0,
      ),
    recent: (options) =>
      Result.gen(async function* () {
        const bind = [...stampBound(options.before), options.limit ?? DEFAULT_RECENT];
        const rows = yield* Result.await(query("recent failed", SQL.selectRecent, bind));
        return Result.all(rows.map(headerRow));
      }),
    stranded: (mine) =>
      Result.gen(async function* () {
        const rows = yield* Result.await(query("stranded failed", SQL.selectStranded, [mine]));
        return decodeRows(rows);
      }),
    allSince: (cursors, scope = "synced") => {
      const bind = [scope === "local" ? 1 : 0, JSON.stringify(Object.fromEntries(cursors))];
      return whole(
        () =>
          query("allSince failed", SQL.selectSince, bind).then((rows) => rows.andThen(decodeRows)),
        (peer) => cursors.get(peer) ?? 0,
      );
    },
    lastSeq: (peer, scope) =>
      Result.gen(async function* () {
        const local = scope === "local" ? 1 : 0;
        const rows = yield* Result.await(query("lastSeq failed", SQL.selectLastSeq, [peer, local]));
        return seqOf(rows[0]?.[0]);
      }),
    compactBelow: (floor, scope, olderThan) =>
      attempt("compactBelow failed", () =>
        transaction(async () => {
          const local = scope === "local" ? 1 : 0;
          const bind = [
            local,
            olderThan.epochMilliseconds,
            JSON.stringify(Object.fromEntries(floor)),
          ];
          const groups = await driver.all(SQL.selectCompactable, bind);
          let removed = 0;
          for (const [peer, max, count] of groups) {
            const [stamp] = await driver.all(SQL.selectCompactableStamp, [...bind, peer ?? null]);
            const [ms, logical] = stamp ?? [null, null];
            await driver.run(SQL.upsertFloor, [
              peer ?? null,
              local,
              max ?? null,
              ms ?? null,
              logical ?? null,
            ]);
            await driver.run(GAPS.deleteBelow, [peer ?? null, local, max ?? null]);
            removed += Number(count);
          }
          if (removed > 0) await driver.run(SQL.deleteCompactable, bind);
          return removed;
        }),
      ),
    compactedBelow: () =>
      query("compactedBelow failed", SQL.selectFloors).then((rows) =>
        rows
          .andThen(coverageOf)
          .mapError((e) =>
            e._tag === "StateCorrupt" ? new StoreFailure({ message: e.message }) : e,
          ),
      ),
    maxHlc: () =>
      query("maxHlc failed", SQL.selectMaxHlc).then((rows) => rows.andThen((r) => hlcRow(r[0]))),
  };

  if (options.nested === true) return Promise.resolve(Result.ok(store)); // the owner migrated
  return attempt("open failed", () => migrate(driver)).then((opened) => opened.map(() => store));
}

/** `sqlEventStore` under its SQLite-era name; the store speaks whatever dialect the driver has. */
export const sqliteEventStore = sqlEventStore;
