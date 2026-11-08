import type { StoredEvent, SuiteCase } from "@syncmesh/engine";
import type { ColumnName, Logical, PeerId, Procedure, RowKey, TableName } from "@syncmesh/kernel";

import { check, equal, openEngine } from "@syncmesh/engine";
import { createHlcClock, eventId, parsePeerId, parseSeqNum } from "@syncmesh/kernel";
import { t, table } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";

import type { SqlDriver } from "../driver.js";
import type { OpenDriver } from "./index.js";

import { openStores, schemaNameFor } from "../open-stores.js";

/**
 * What a `kill -9` may not cost on any `SqlDriver`: the durability half of the driver contract.
 *
 * Two children, each killed with SIGKILL while it writes. `append` puts batches straight into
 * the log; `fold` takes a foreign author's batches through the engine's receive path, so the log
 * append and the state commit run inside `atomic` together. What the child printed before the
 * kill is the floor of what the reopened store must hold, and every check below is about the
 * store agreeing with itself afterwards: no hole in the log, no batch half-applied, the folded
 * rows and the cursors saying the same number, and a refold from the log alone landing on the
 * same digest as the persisted state.
 *
 * Runner-neutral like the rest of the suite: the adapter supplies how a child is started and
 * killed ({@link CrashHarness}), and the child's body is {@link crashChild}.
 */

/** Which write path the child is killed in. */
export type CrashMode = "append" | "fold";

/** One child, started against the database called `name`. */
export interface CrashChild {
  /** Each line the child prints: the highest sequence it has committed so far. */
  readonly lines: AsyncIterable<string>;
  /** SIGKILL, then wait for the process to be gone. */
  readonly kill: () => Promise<void>;
}

/** What an adapter hands the suite: how to start its child, and how to open the database again. */
export interface CrashHarness {
  readonly start: (name: string, mode: CrashMode) => CrashChild;
  /** Opens `name` with the {@link CRASH_TABLES} shape, after the child is dead. */
  readonly openDriver: OpenDriver;
}

/**
 * Each line of a child's output, as it arrives: what a harness builds {@link CrashChild.lines} from.
 *
 * @example
 * lines: linesOf(Bun.spawn(command, { stdout: "pipe" }).stdout)
 */
export async function* linesOf(stream: AsyncIterable<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    yield* lines;
  }
}

/** Events per batch: a batch is one transaction, so a count that is not a multiple of it is a torn batch. */
export const CRASH_BATCH = 20;

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- suite fixtures; naming rules are not under test */
const NOTES = "notes" as TableName;
const ID = "id" as ColumnName;
const BODY = "body" as ColumnName;
const PROCEDURE = "crash.write" as Procedure;
const ZERO = 0 as Logical;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

/** The shape child and parent both open with, so the derived half is the same file for both. */
export const CRASH_TABLES = [table("notes", { id: t.text().primaryKey(), body: t.text() })];

/** The name the derived half is opened under: pass it to the driver both sides construct. */
export const CRASH_SCHEMA = schemaNameFor(CRASH_TABLES);

/** The foreign author of every event the child writes: whose run a reopened store is asked about. */
export const CRASH_AUTHOR = parsePeerId("c".repeat(64)).unwrap();
/** The device the `fold` child receives them as. */
const DEVICE = parsePeerId("d".repeat(64)).unwrap();

/** Event `n` inserts row `r<n>`: one new row per event, so the row count is the event count. */
const crashEvent = (n: number): StoredEvent => {
  const seqNum = parseSeqNum(n).unwrap();
  return {
    event: {
      v: 1,
      id: eventId(CRASH_AUTHOR, seqNum),
      peerId: CRASH_AUTHOR,
      seqNum,
      hlc: [Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000 + n), ZERO],
      procedure: PROCEDURE,
      changes: [
        {
          kind: "insert",
          table: NOTES,
          // SAFETY: `r<n>` from a counter this function owns
          key: `r${n}` as RowKey,
          row: new Map([
            [ID, `r${n}`],
            [BODY, `row ${n} ${"x".repeat(64)}`],
          ]),
        },
      ],
    },
  };
};

const batchFrom = (first: number): readonly StoredEvent[] =>
  Array.from({ length: CRASH_BATCH }, (_, i) => crashEvent(first + i));

const clock = () => createHlcClock({ now: () => Temporal.Now.instant() });

const engineOver = async (driver: SqlDriver, withState: boolean) => {
  const stores = (await openStores(driver, { tables: CRASH_TABLES })).unwrap();
  const base = { peerId: DEVICE, clock: clock(), store: stores.events };
  const options = withState ? { ...base, stateStore: stores.state, atomic: stores.atomic } : base;
  const engine = (await openEngine(options)).unwrap();
  return { stores, engine };
};

/**
 * The child's whole life: write batch after batch until killed, calling `committed` with the
 * highest sequence each time a batch's transaction has returned. Never resolves.
 */
export async function crashChild(
  driver: SqlDriver,
  mode: CrashMode,
  committed: (seq: number) => void,
): Promise<never> {
  if (mode === "append") {
    const stores = (await openStores(driver, { tables: CRASH_TABLES })).unwrap();
    // a child started over a killed one's store carries on from what that one left
    const resume = Number((await stores.events.lastSeq(CRASH_AUTHOR, "synced")).unwrap() ?? 0);
    for (let first = resume + 1; ; first += CRASH_BATCH) {
      (await stores.events.appendBatch(batchFrom(first))).unwrap();
      committed(first + CRASH_BATCH - 1);
    }
  }
  const { engine } = await engineOver(driver, true);
  const resume = Number((await engine.cursors()).unwrap().get(CRASH_AUTHOR) ?? 0);
  for (let first = resume + 1; ; first += CRASH_BATCH) {
    (await engine.receiveBatch(batchFrom(first))).unwrap();
    committed(first + CRASH_BATCH - 1);
  }
}

/** Kills per case: the later rounds start over a store the earlier ones left mid-write. */
const ROUNDS = 3;

/** Starts the child, reads until it has committed `atLeast`, kills it, and returns what it said it committed. */
const writeThenKill = async (child: CrashChild, atLeast: number): Promise<number> => {
  let committed = 0;
  try {
    for await (const line of child.lines) {
      const seq = Number(line.trim());
      if (!Number.isNaN(seq)) committed = Math.max(committed, seq);
      if (committed >= atLeast) break;
    }
  } finally {
    await child.kill();
  }
  return committed;
};

/** {@link ROUNDS} children over one store, each killed once it has committed 200 more. */
const killRounds = async (harness: CrashHarness, name: string, mode: CrashMode) => {
  let committed = 0;
  for (let round = 1; round <= ROUNDS; round += 1) {
    const atLeast = committed + 200;
    committed = await writeThenKill(harness.start(name, mode), atLeast);
    check(committed >= atLeast, `round ${round} committed ${committed}, short of ${atLeast}`);
  }
  return committed;
};

const countRows = async (driver: SqlDriver) =>
  Number((await driver.all(`SELECT COUNT(*) FROM notes`, []))[0]?.[0] ?? 0);

/** How far the log holds `CRASH_AUTHOR`, and whether it holds every number below that. */
const logExtent = async (driver: SqlDriver) => {
  const stores = (await openStores(driver, { tables: CRASH_TABLES })).unwrap();
  const last = Number((await stores.events.lastSeq(CRASH_AUTHOR, "synced")).unwrap() ?? 0);
  const held = (await stores.events.allSince(new Map<PeerId, never>(), "synced")).unwrap();
  return { last, count: held.length };
};

/**
 * The cases, for any runner.
 *
 * @example
 * for (const c of crashTests(harness)) test(c.name, c.run, 60_000);
 */
export function crashTests(harness: CrashHarness): readonly SuiteCase[] {
  return [
    {
      name: "crash: kill -9 mid-append leaves whole batches, no hole, every committed batch back",
      run: async () => {
        const committed = await killRounds(harness, "crash-append", "append");
        const driver = await harness.openDriver("crash-append");
        const { last, count } = await logExtent(driver);
        check(last >= committed, `the log holds ${last} of ${committed} acknowledged`);
        equal(count, last, "events held against the highest sequence (a hole if they differ)");
        equal(last % CRASH_BATCH, 0, "a batch is one transaction, so the log ends on a boundary");
        // and the log takes the next batch where it left off
        const stores = (await openStores(driver, { tables: CRASH_TABLES })).unwrap();
        (await stores.events.appendBatch(batchFrom(last + 1))).unwrap();
        equal((await logExtent(driver)).last, last + CRASH_BATCH, "the next batch follows on");
        await driver.close?.();
      },
    },
    {
      name: "crash: kill -9 mid-fold reopens with log, cursor, table and refold all agreeing",
      run: async () => {
        const committed = await killRounds(harness, "crash-fold", "fold");
        const driver = await harness.openDriver("crash-fold");
        const { last, count } = await logExtent(driver);
        check(last >= committed, `the log holds ${last} of ${committed} acknowledged`);
        equal(count, last, "events held against the highest sequence");

        // boot repairs whatever the state half was behind by: after it, everything agrees
        const { engine } = await engineOver(driver, true);
        const cursor = Number((await engine.cursors()).unwrap().get(CRASH_AUTHOR) ?? 0);
        equal(cursor, last, "the cursor after boot is the log's extent");
        equal(await countRows(driver), last, "rows in the app's table against the log's extent");
        const persisted = engine.digest().get(NOTES);

        // a refold from the log alone is the oracle for the persisted state
        const { engine: refolded } = await engineOver(driver, false);
        equal(
          `${refolded.digest().get(NOTES)}`,
          `${persisted}`,
          "the persisted state digests as a refold of the log",
        );

        (await engine.receiveBatch(batchFrom(last + 1))).unwrap();
        equal(await countRows(driver), last + CRASH_BATCH, "the next batch folds on top");
        await driver.close?.();
      },
    },
  ];
}
