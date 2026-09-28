import { createValidator, openEngine } from "@syncmesh/engine";
import { createHlcClock, parsePartitionKey } from "@syncmesh/kernel";
import { ladder, partition, syncSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { type SqlDriver, openStores } from "@syncmesh/storage";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { asc, count, desc, eq, sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import type { LiveSnapshot } from "../live.js";
import type { LiveChange } from "../patch.js";

import { meshDrizzle } from "../index.js";
import { compareText } from "../order.js";
import { windowOf } from "../window.js";

const jobs = sqliteTable("jobs", {
  id: text().primaryKey(),
  title: text().notNull(),
  status: text().notNull(),
  rank: integer().notNull(),
});

const org = partition("org", { roles: ladder("owner", "dispatcher") });
const schema = syncSchema({
  tables: {
    jobs: {
      columns: {
        id: t.text().primaryKey(),
        title: t.text(),
        status: t.text(),
        rank: t.integer(),
      },
      partition: org,
      allow: ({ role }) => ({ $default: role("dispatcher") }),
    },
  },
});

const device = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 90 + i)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const ACME = parsePartitionKey("org:acme").unwrap();

/**
 * A mesh over one in-memory SQLite file, with every statement counted.
 *
 * The count is the measurement the whole thing is about: a maintained query must read the keys
 * the fold named and nothing else, and the only honest way to say "and nothing else" is to watch
 * the connection.
 */
const open = async () => {
  const raw = bunSqliteDriver(":memory:");
  const seen: string[] = [];
  const driver = {
    ...raw,
    all: (...asked: Parameters<SqlDriver["all"]>) => {
      seen.push(asked[0]);
      return raw.all(...asked);
    },
  } satisfies SqlDriver;
  const stores = (await openStores(driver, { tables: [schema.tables.jobs] })).unwrap();
  const engine = (
    await openEngine({
      peerId: device.peerId,
      clock: createHlcClock({ now: () => T0 }),
      store: stores.events,
      stateStore: stores.state,
      validate: createValidator({ schema, grantFor: null }),
    })
  ).unwrap();
  const mesh = meshDrizzle({
    engine,
    validate: createValidator({ schema, grantFor: null }),
    driver,
    schema,
    partition: ACME,
  });
  return { ...mesh, reads: seen, clear: () => void (seen.length = 0) };
};

/** One delivery, as a listener sees it. */
interface Told<T> {
  readonly rows: readonly T[];
  readonly changes: readonly LiveChange<T>[] | undefined;
}

const listening = <T>(live: {
  subscribe: (l: (r: readonly T[], c?: readonly LiveChange<T>[]) => void) => () => void;
}) => {
  const told: Told<T>[] = [];
  const off = live.subscribe((rows, changes) => void told.push({ rows, changes }));
  return { told, off };
};

/** Folds land after the write's transaction, so a listener has had its turn by the next tick. */
const settle = () => new Promise((done) => setTimeout(done, 5));

type Job = typeof jobs.$inferSelect;

describe("a live query is maintained from the keys a fold named", () => {
  test("one changed row costs one small statement, and the delivery names what moved", async () => {
    const mesh = await open();
    for (const [at, id] of ["a", "b", "c", "d"].entries())
      await mesh.db.insert(jobs).values({ id, title: id, status: "open", rank: at });

    const live = mesh.live<Job>(() =>
      mesh.db
        .select()
        .from(jobs)
        .where(eq(jobs.status, "open"))
        .orderBy(asc(jobs.rank), asc(jobs.id)),
    );
    const before = await live.ready;
    const { told } = listening(live);
    mesh.clear();

    await mesh.db.update(jobs).set({ title: "B!" }).where(eq(jobs.id, "b"));
    await settle();

    // the probe, and nothing else that read the table: one statement carrying one key. The
    // capture's own reads (the change log, the sequence high-water mark) are the write's, and
    // were there before any of this
    const selects = mesh.reads.filter((statement) => statement.includes('from "jobs"'));
    expect(selects).toHaveLength(1);
    expect(selects[0]).toContain('"id" in (?)');

    const [delivery] = told;
    expect(delivery?.changes).toEqual([
      { kind: "update", key: "b", row: { id: "b", title: "B!", status: "open", rank: 1 } },
    ]);
    expect(delivery?.rows.map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
    // every row the fold did not name is the object it already was: a memoised list item that
    // re-renders because a sibling changed is the bug this buys off
    expect(delivery?.rows[0]).toBe(before[0]!);
    expect(delivery?.rows[2]).toBe(before[2]!);
    live.release();
  });

  test("a row that moved in the order moves in the list", async () => {
    const mesh = await open();
    for (const [at, id] of ["a", "b", "c"].entries())
      await mesh.db.insert(jobs).values({ id, title: id, status: "open", rank: at });
    const live = mesh.live<Job>(() =>
      mesh.db.select().from(jobs).orderBy(asc(jobs.rank), asc(jobs.id)),
    );
    await live.ready;
    const { told } = listening(live);

    await mesh.db.update(jobs).set({ rank: 99 }).where(eq(jobs.id, "a"));
    await settle();
    expect(told.at(-1)?.rows.map((r) => r.id)).toEqual(["b", "c", "a"]);
    live.release();
  });

  test("a row that stopped matching the filter leaves, and is reported as a delete", async () => {
    const mesh = await open();
    for (const [at, id] of ["a", "b", "c"].entries())
      await mesh.db.insert(jobs).values({ id, title: id, status: "open", rank: at });
    const live = mesh.live<Job>(() =>
      mesh.db
        .select()
        .from(jobs)
        .where(eq(jobs.status, "open"))
        .orderBy(asc(jobs.rank), asc(jobs.id)),
    );
    await live.ready;
    const { told } = listening(live);

    await mesh.db.update(jobs).set({ status: "done" }).where(eq(jobs.id, "b"));
    await settle();
    expect(told.at(-1)?.rows.map((r) => r.id)).toEqual(["a", "c"]);
    expect(told.at(-1)?.changes?.map((c) => `${c.kind}:${c.key}`)).toEqual(["delete:b"]);
    live.release();
  });

  test("a new row sorts into a full window and pushes the last one out of it", async () => {
    const mesh = await open();
    for (const [at, id] of ["a", "b", "c"].entries())
      await mesh.db.insert(jobs).values({ id, title: id, status: "open", rank: at * 10 });
    const live = mesh.live<Job>(() =>
      mesh.db.select().from(jobs).orderBy(asc(jobs.rank), asc(jobs.id)).limit(3),
    );
    await live.ready;
    const { told } = listening(live);

    await mesh.db.insert(jobs).values({ id: "m", title: "m", status: "open", rank: 5 });
    await settle();
    expect(told.at(-1)?.rows.map((r) => r.id)).toEqual(["a", "m", "b"]);
    expect(told.at(-1)?.changes?.map((c) => `${c.kind}:${c.key}`)).toEqual([
      "insert:m",
      "delete:c",
    ]);
    live.release();
  });

  test("a delete from a full window re-reads, because the row that fills it was never seen", async () => {
    const mesh = await open();
    for (const [at, id] of ["a", "b", "c", "d"].entries())
      await mesh.db.insert(jobs).values({ id, title: id, status: "open", rank: at });
    const live = mesh.live<Job>(() =>
      mesh.db.select().from(jobs).orderBy(asc(jobs.rank), asc(jobs.id)).limit(3),
    );
    expect((await live.ready).map((r) => r.id)).toEqual(["a", "b", "c"]);
    const { told } = listening(live);

    await mesh.db.delete(jobs).where(eq(jobs.id, "a"));
    await settle();
    // `d` was below the limit and had never been read; a patch that trusted itself here would
    // have drawn a two-row list over a table holding three
    expect(told.at(-1)?.rows.map((r) => r.id)).toEqual(["b", "c", "d"]);
    expect(told.at(-1)?.changes).toBeUndefined();
    live.release();
  });

  test("a write that changed nothing this query selects wakes nobody", async () => {
    const mesh = await open();
    await mesh.db.insert(jobs).values({ id: "a", title: "a", status: "open", rank: 1 });
    const live = mesh.live(() =>
      mesh.db.select({ id: jobs.id, status: jobs.status }).from(jobs).orderBy(asc(jobs.id)),
    );
    await live.ready;
    const { told } = listening(live);

    await mesh.db.update(jobs).set({ title: "renamed" }).where(eq(jobs.id, "a"));
    await settle();
    expect(told).toEqual([]);
    live.release();
  });

  test("a fold that touched no table this query reads is still ignored", async () => {
    const mesh = await open();
    await mesh.db.insert(jobs).values({ id: "a", title: "a", status: "open", rank: 1 });
    const live = mesh.live<Job>(() => mesh.db.select().from(jobs).orderBy(asc(jobs.id)));
    await live.ready;
    const { told } = listening(live);
    await settle();
    expect(told).toEqual([]);
    live.release();
  });
});

/** The snapshot once the store has spoken — the arm `state` and `diff` live on. */
const answered = <T>(live: { readonly snapshot: () => LiveSnapshot<T> }) => {
  const snap = live.snapshot();
  if (!snap.answered) throw new Error("the store has not answered");
  return snap;
};

/**
 * The book's fourth live invariant (ch. 9): unchanged rows keep object identity across
 * deliveries, and each delivery exposes a keyed diff — computed here, not by a consumer
 * re-keying the list. A re-run is the case that matters: the listener's delta is honestly
 * `undefined` there, and the diff is present regardless.
 */
describe("every delivery carries a keyed diff, and unchanged rows keep their identity", () => {
  test("a re-run names exactly the keys that changed and keeps the rest", async () => {
    const mesh = await open();
    for (const [at, id] of ["a", "b", "c"].entries())
      await mesh.db.insert(jobs).values({ id, title: id, status: "open", rank: at });
    // a built query rather than a factory: nothing maintains it, so every fold is a re-run
    const live = mesh.live<Job>(mesh.db.select().from(jobs).orderBy(asc(jobs.rank), asc(jobs.id)));
    const before = await live.ready;
    const first = answered(live);
    expect([...first.diff.added.keys()]).toEqual(["a", "b", "c"]);
    expect(first.state.get("b")).toBe(before[1]!);
    const { told } = listening(live);

    await mesh.db.update(jobs).set({ title: "B!" }).where(eq(jobs.id, "b"));
    await settle();
    // the listener's delta is honestly absent on a re-run; the snapshot's diff is not
    expect(told[0]?.changes).toBeUndefined();
    const snap = answered(live);
    expect([...snap.diff.changed.keys()]).toEqual(["b"]);
    expect(snap.diff.added.size).toBe(0);
    expect(snap.diff.removed.size).toBe(0);
    expect(snap.diff.changed.get("b")).toBe(snap.data[1]!);
    expect(snap.data[0]).toBe(before[0]!);
    expect(snap.data[2]).toBe(before[2]!);
    expect(snap.state.get("a")).toBe(before[0]!);

    // an insert above every row shifts every position, and no row changes identity for it —
    // which a positional merge got wrong, because it compared each row with its new neighbour
    await mesh.db.insert(jobs).values({ id: "0", title: "0", status: "open", rank: -1 });
    await settle();
    const shifted = answered(live);
    expect(shifted.data.map((r) => r.id)).toEqual(["0", "a", "b", "c"]);
    expect([...shifted.diff.added.keys()]).toEqual(["0"]);
    expect(shifted.diff.changed.size).toBe(0);
    expect(shifted.data[1]).toBe(snap.data[0]!);
    expect(shifted.data[3]).toBe(snap.data[2]!);

    await mesh.db.delete(jobs).where(eq(jobs.id, "a"));
    await settle();
    const gone = answered(live);
    expect([...gone.diff.removed.keys()]).toEqual(["a"]);
    // removed holds the row as it last was
    expect(gone.diff.removed.get("a")).toBe(shifted.data[1]!);
    expect(gone.state.has("a")).toBe(false);
    live.release();
  });

  test("a query that projects no primary key is keyed by position, and still diffs", async () => {
    const mesh = await open();
    for (const [at, [id, status]] of [
      ["a", "open"],
      ["b", "open"],
      ["c", "done"],
    ].entries())
      await mesh.db
        .insert(jobs)
        .values({ id: id ?? "", title: id ?? "", status: status ?? "", rank: at });
    const live = mesh.live(
      mesh.db
        .select({ status: jobs.status, total: count() })
        .from(jobs)
        .groupBy(jobs.status)
        .orderBy(asc(jobs.status)),
    );
    await live.ready;
    expect([...answered(live).state.keys()]).toEqual(["0", "1"]);

    await mesh.db.update(jobs).set({ status: "done" }).where(eq(jobs.id, "a"));
    await settle();
    const snap = answered(live);
    expect(snap.data).toEqual([
      { status: "done", total: 2 },
      { status: "open", total: 1 },
    ]);
    // both groups' counts moved, so both positions read as changed
    expect([...snap.diff.changed.keys()]).toEqual(["0", "1"]);
    live.release();
  });

  test("a maintained delivery's diff agrees with its delta", async () => {
    const mesh = await open();
    for (const [at, id] of ["a", "b", "c"].entries())
      await mesh.db.insert(jobs).values({ id, title: id, status: "open", rank: at });
    const live = mesh.live<Job>(() =>
      mesh.db
        .select()
        .from(jobs)
        .where(eq(jobs.status, "open"))
        .orderBy(asc(jobs.rank), asc(jobs.id)),
    );
    const before = await live.ready;
    const { told } = listening(live);

    await mesh.db.update(jobs).set({ title: "B!" }).where(eq(jobs.id, "b"));
    await settle();
    expect(told[0]?.changes?.map((c) => `${c.kind}:${c.key}`)).toEqual(["update:b"]);
    const snap = answered(live);
    expect([...snap.diff.changed.keys()]).toEqual(["b"]);
    expect(snap.diff.added.size + snap.diff.removed.size).toBe(0);
    expect(snap.state.get("a")).toBe(before[0]!);
    live.release();
  });
});

describe("what cannot be maintained re-runs instead", () => {
  const again = <T>(make: () => T) => make;

  test("an aggregate, a `GROUP BY`, an `OFFSET` and a computed column are all read afresh", async () => {
    const mesh = await open();
    const grouped = again(() =>
      mesh.db
        .select({ status: jobs.status, total: count() })
        .from(jobs)
        .groupBy(jobs.status)
        .orderBy(asc(jobs.status)),
    );
    const offset = again(() =>
      mesh.db.select().from(jobs).orderBy(asc(jobs.id)).limit(5).offset(5),
    );
    const computed = again(() => {
      const ranked = mesh.db
        .select({
          id: jobs.id,
          within: sql<number>`row_number() over (order by ${jobs.rank})`.as("within"),
        })
        .from(jobs)
        .as("ranked");
      return mesh.db.select({ id: ranked.id }).from(ranked).orderBy(asc(ranked.id));
    });
    expect(windowOf(grouped(), grouped)).toBeUndefined();
    expect(windowOf(offset(), offset)).toBeUndefined();
    expect(windowOf(computed(), computed)).toBeUndefined();
  });

  test("an `ORDER BY` over an expression is read afresh: nothing on the row says what it evaluates to", async () => {
    const mesh = await open();
    const build = () =>
      mesh.db
        .select()
        .from(jobs)
        .orderBy(sql`${jobs.rank} = 3 desc`, asc(jobs.id));
    expect(windowOf(build(), build)).toBeUndefined();
  });

  test("a plain filtered list is maintained, and says which table and limit it is about", async () => {
    const mesh = await open();
    const build = () =>
      mesh.db
        .select()
        .from(jobs)
        .where(eq(jobs.status, "open"))
        .orderBy(desc(jobs.rank), asc(jobs.id))
        .limit(20);
    const plan = windowOf(build(), build);
    expect(plan?.table).toBe("jobs");
    expect(plan?.limit).toBe(20);
    const job = (id: string, rank: number): Job => ({ id, rank, title: id, status: "open" });
    expect(plan?.keyOf(job("j1", 0))).toBe("j1");
    // `desc(rank)` first, `asc(id)` as the tiebreak — the order the list is drawn in
    expect(plan?.order(job("a", 2), job("a", 9))).toBeGreaterThan(0);
    expect(plan?.order(job("a", 2), job("b", 2))).toBeLessThan(0);
  });

  test("a truncated window over a non-unique order is read afresh", async () => {
    const mesh = await open();
    // no tiebreak: the row below the limit can sort level with the last one drawn, and nothing
    // in hand says which of the two belongs in the window
    const build = () => mesh.db.select().from(jobs).orderBy(asc(jobs.rank)).limit(10);
    expect(windowOf(build(), build)).toBeUndefined();
    const total = () => mesh.db.select().from(jobs).orderBy(asc(jobs.rank));
    expect(windowOf(total(), total)?.limit).toBeUndefined();
  });
});

describe("text sorts the way SQLite sorts it", () => {
  test("a character above U+FFFF sorts above one below it, which JavaScript's `<` gets backwards", () => {
    const emoji = "\u{1F600}"; // U+1F600, a surrogate pair starting at U+D83D
    const glyph = ""; // a private-use character, below the surrogates in UTF-16
    expect(emoji < glyph).toBe(true); // what `<` says …
    expect(compareText(emoji, glyph)).toBeGreaterThan(0); // … and what UTF-8 bytes say
  });

  test("a prefix sorts before the string that extends it", () => {
    expect(compareText("rank", "ranked")).toBeLessThan(0);
    expect(compareText("ranked", "ranked")).toBe(0);
  });
});
