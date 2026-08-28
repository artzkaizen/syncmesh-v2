import type { Change, SyncEvent } from "@syncmesh/kernel";

import { parsePartitionKey, readRow } from "@syncmesh/kernel";
import { defineSchema, t } from "@syncmesh/schema";
import { decodeEventCore, encodeEventCore } from "@syncmesh/wire";
import { grownCore } from "@syncmesh/wire/wire-tests";
import { describe, expect, test } from "bun:test";

import type { Engine, EngineOptions } from "../engine.js";
import type { EngineError } from "../errors.js";
import type { ProbeEvent, Validator } from "../validate.js";

import { createValidator } from "../validate.js";
import { CREATE, N1, PEER_A, PEER_B, column, key, row, setup } from "./fixtures.js";

const USER = parsePartitionKey("user:acct_a").unwrap();

/** The build that shipped first: one table, two columns. */
const oldSchema = defineSchema({
  partitions: {},
  roles: {},
  tables: {
    notes: { columns: { id: t.text().primaryKey(), body: t.text() }, partition: "user" },
  },
});

/** The build that shipped next: a nullable column added, and a table added beside it. */
const newSchema = defineSchema({
  partitions: {},
  roles: {},
  tables: {
    notes: {
      columns: { id: t.text().primaryKey(), body: t.text(), pinned: t.boolean().nullable() },
      partition: "user",
    },
    memos: { columns: { id: t.text().primaryKey(), body: t.text() }, partition: "user" },
  },
});

const NOTES = oldSchema.tables.notes.name;
const MEMOS = newSchema.tables.memos.name;

const validatorFor = (schema: typeof oldSchema | typeof newSchema): Validator =>
  createValidator({ schema, grantFor: null });

/** A validator whose schema can be swapped, which is what "the app updated" looks like here. */
const upgradable = (start: Validator) => {
  let current = start;
  return {
    validator: { validate: (event, before) => current.validate(event, before) } satisfies Validator,
    upgrade: (next: Validator) => void (current = next),
  };
};

const peer = (peerId = PEER_A, extra: Partial<EngineOptions> = {}) =>
  setup(peerId, 100, extra).engine;

const entriesOf = (events: readonly SyncEvent[]) => events.map((event) => ({ event }));

const digestOf = (engine: Engine) => [...engine.digest()].map(([t2, d]) => [String(t2), d]);

const cursorOf = (engine: Engine, author = PEER_B) =>
  Number(engine.coverage().synced.get(author) ?? 0);

const aheadOf = (engine: Engine, author = PEER_B) => (engine.ahead().get(author) ?? []).map(Number);

/** Folded past a gap *and* parked below one — what the receive path walks the run with. */
const holdingOf = (engine: Engine, author = PEER_B) =>
  (engine.holding().get(author) ?? []).map(Number);

/** Three notes from one author, as an old build could have written them. */
const threeNotes = async (author: Engine): Promise<readonly SyncEvent[]> => {
  const events: SyncEvent[] = [];
  for (const n of [1, 2, 3]) {
    const written = await author.mutate(
      CREATE,
      (tx) => tx.insert(NOTES, key(`n${n}`), row({ id: `n${n}`, body: `body-${n}` })),
      { partition: USER },
    );
    events.push(written.unwrap());
  }
  return events;
};

describe("contiguous cursors (D13)", () => {
  test("a gap holds the cursor below it, and what landed past it is `ahead`", async () => {
    const author = peer(PEER_B);
    const [e1, e2, e3] = await threeNotes(author);
    const device = peer(PEER_A);

    (await device.receiveBatch(entriesOf([e1!, e3!]))).unwrap();
    expect(cursorOf(device)).toBe(1);
    expect(aheadOf(device)).toEqual([3]);

    (await device.receiveBatch(entriesOf([e2!]))).unwrap();
    expect(cursorOf(device)).toBe(3);
    expect(aheadOf(device)).toEqual([]);
  });

  test("`ahead` never names a position the cursor is already past, parked or folded", async () => {
    const author = peer(PEER_B, { validate: validatorFor(newSchema) });
    const e1 = (
      await author.mutate(
        CREATE,
        (tx) => tx.insert(NOTES, key("n1"), row({ id: "n1", body: "body-1" })),
        { partition: USER },
      )
    ).unwrap();
    const memo = (
      await author.mutate(
        CREATE,
        (tx) => tx.insert(MEMOS, key("m1"), row({ id: "m1", body: "later" })),
        { partition: USER },
      )
    ).unwrap();

    const device = peer(PEER_A, { validate: validatorFor(oldSchema) });
    (await device.receiveBatch(entriesOf([e1, memo]))).unwrap();
    expect(device.quarantine()).toHaveLength(1);
    expect(aheadOf(device)).toEqual([]); // nothing folded above the cursor
    expect(holdingOf(device)).toEqual([2]); // the parked event, which the device does hold

    // a snapshot carries the rows that event stood for, so its coverage moves the cursor past
    // something still sitting in the quarantine — which is then not "above" anything any more
    await device.installSnapshot(author.snapshot());
    expect(cursorOf(device)).toBe(2);
    expect(device.quarantine()).toHaveLength(1);
    expect(holdingOf(device)).toEqual([]);
  });

  test("a snapshot's coverage raises the cursor and takes the strays with it", async () => {
    const author = peer(PEER_B);
    const events = await threeNotes(author);
    const device = peer(PEER_A);

    (await device.receiveBatch(entriesOf([events[2]!]))).unwrap();
    expect(cursorOf(device)).toBe(0);
    expect(aheadOf(device)).toEqual([3]);

    await device.installSnapshot(author.snapshot());
    expect(cursorOf(device)).toBe(3);
    expect(aheadOf(device)).toEqual([]);
  });

  test("opposite orders, one with a gap: digests agree once the gap fills", async () => {
    const author = peer(PEER_B);
    const [e1, e2, e3] = await threeNotes(author);
    const forwards = peer(PEER_A);
    const backwards = peer(PEER_A);
    const gapped = peer(PEER_A);

    (await forwards.receiveBatch(entriesOf([e1!, e2!, e3!]))).unwrap();
    (await backwards.receiveBatch(entriesOf([e3!, e2!, e1!]))).unwrap();
    (await gapped.receiveBatch(entriesOf([e1!, e3!]))).unwrap();

    // order never mattered to the fold; it must not start mattering to the cursor either
    expect(digestOf(backwards)).toEqual(digestOf(forwards));
    expect(cursorOf(backwards)).toBe(cursorOf(forwards));

    // the hole is visible in the digest, which is the point of not jumping it
    expect(digestOf(gapped)).not.toEqual(digestOf(forwards));

    (await gapped.receiveBatch(entriesOf([e2!]))).unwrap();
    expect(digestOf(gapped)).toEqual(digestOf(forwards));
    expect(cursorOf(gapped)).toBe(cursorOf(forwards));
  });
});

describe("an event this build cannot read is parked, never dropped", () => {
  test("a newer build's table parks, holds the cursor, and folds after the update", async () => {
    const author = peer(PEER_B, { validate: validatorFor(newSchema) });
    // exactly the three this test sends, so the seqs are 1, 2, 3 and the hole is the middle one
    const e1 = (
      await author.mutate(
        CREATE,
        (tx) => tx.insert(NOTES, key("n1"), row({ id: "n1", body: "body-1" })),
        { partition: USER },
      )
    ).unwrap();
    const memo = (
      await author.mutate(
        CREATE,
        (tx) => tx.insert(MEMOS, key("m1"), row({ id: "m1", body: "later" })),
        { partition: USER },
      )
    ).unwrap();
    const e3 = (
      await author.mutate(
        CREATE,
        (tx) => tx.insert(NOTES, key("n3"), row({ id: "n3", body: "body-3" })),
        { partition: USER },
      )
    ).unwrap();

    const build = upgradable(validatorFor(oldSchema));
    const device = peer(PEER_A, { validate: build.validator });
    const parked: string[] = [];
    device.onQuarantine(({ reason }) => void parked.push(reason._tag));

    const report = (await device.receiveBatch(entriesOf([e1, memo, e3]))).unwrap();
    expect(report).toEqual({ folded: 2, skipped: 0, quarantined: 1 });
    expect(parked).toEqual(["UnknownTable"]);
    // the parked event is the hole: the cursor stops below it, and says what it holds past it
    expect(cursorOf(device)).toBe(1);
    expect(aheadOf(device)).toEqual([3]); // folded past the hole, and offered to peers as held
    expect(holdingOf(device)).toEqual([2, 3]); // and the hole itself is bytes this device has
    expect(device.quarantine().map((p) => p.reason)).toEqual(["unknown-table"]);

    // an update that still cannot read it changes nothing but leaves it parked
    (await device.retryQuarantined()).unwrap();
    expect(cursorOf(device)).toBe(1);
    expect(device.quarantine()).toHaveLength(1);

    build.upgrade(validatorFor(newSchema));
    const after = (await device.retryQuarantined()).unwrap();
    expect(after.folded).toBe(1);
    expect(device.quarantine()).toEqual([]);
    expect(cursorOf(device)).toBe(3);
    expect(aheadOf(device)).toEqual([]);
    expect(digestOf(device)).toEqual(digestOf(author));
  });

  test("a kind this build has never heard of survives the codec and reaches the ladder", async () => {
    const author = peer(PEER_B);
    const [e1, e2, e3] = await threeNotes(author);
    // tag 3 is `increment`, reserved for a cell kind no encoder here emits — a newer build's
    // change arriving at an older one, written the way it will really be written
    const opaque: Change = {
      kind: "unknown",
      tag: 3,
      table: NOTES,
      key: N1,
      data: new Map<string, number>([["count", 7]]),
    };
    const forged: SyncEvent = { ...e2!, changes: [opaque] };

    // through the wire and back: refusing here is what used to make it a wire error that both
    // transports dropped, so nothing downstream could park what it never received
    const core = encodeEventCore(forged);
    const read = decodeEventCore(core).unwrap();
    expect(read.changes[0]).toEqual(opaque);
    // and back out byte-for-byte, so a device that parked one can still serve the run it sits in
    expect(encodeEventCore(read)).toEqual(core);

    const device = peer(PEER_A);
    const report = (await device.receiveBatch(entriesOf([e1!, read, e3!]))).unwrap();
    expect(report.quarantined).toBe(1);
    expect(device.quarantine().map((p) => p.reason)).toEqual(["unknown-kind"]);
    // it gates the cursor and not delivery: the run stops at the hole, e3 still lands
    expect(cursorOf(device)).toBe(1);
    expect(aheadOf(device)).toEqual([3]);
    expect(holdingOf(device)).toEqual([2, 3]);

    // a build that still cannot read it changes nothing, and says nothing new
    (await device.retryQuarantined()).unwrap();
    expect(device.quarantine()).toHaveLength(1);
    expect(cursorOf(device)).toBe(1);
  });

  test("two devices given the same events park the same set and hold the same rows", async () => {
    const author = peer(PEER_B);
    const [e1, e2, e3] = await threeNotes(author);
    const opaque: Change = { kind: "unknown", tag: 4, table: NOTES, key: N1, data: null };
    const read = decodeEventCore(encodeEventCore({ ...e2!, changes: [opaque] })).unwrap();

    // one folds the run in order, the other back to front: nothing here may depend on which
    const first = peer(PEER_A);
    const second = peer(PEER_A);
    (await first.receiveBatch(entriesOf([e1!, read, e3!]))).unwrap();
    (await second.receiveBatch(entriesOf([e3!, read, e1!]))).unwrap();

    expect(digestOf(second)).toEqual(digestOf(first));
    expect(second.quarantine().map((p) => p.reason)).toEqual(
      first.quarantine().map((p) => p.reason),
    );
    expect(cursorOf(second)).toBe(cursorOf(first));
    expect(holdingOf(second)).toEqual(holdingOf(first));
  });

  test("nothing here can author one: the probe refuses it before a write is numbered", async () => {
    // the transaction API cannot express one at all — `insert`, `update` and `delete` are the
    // whole of it — so this is the rung below that, and it is defence in depth on purpose: a
    // device that wrote one would be inventing an event no build can read, and the row it
    // touched would differ from every peer's forever
    const opaque: Change = { kind: "unknown", tag: 5, table: NOTES, key: N1, data: null };
    const probe: ProbeEvent = { peerId: PEER_A, partition: USER, changes: [opaque] };
    const verdict = validatorFor(oldSchema).validate(probe, {
      row: () => undefined,
      partition: () => undefined,
    });
    expect(verdict.isErr()).toBe(true);
    expect(verdict.isErr() && verdict.error._tag).toBe("UnknownChangeKind");
  });

  test("a change kind with no fold here is parked rather than crashing the batch", async () => {
    const author = peer(PEER_B);
    const [e1, e2, e3] = await threeNotes(author);
    // SAFETY: a kind outside the kernel's union is exactly what a newer build sends an older one;
    // the type system cannot express it here because this build is the older one
    const conjure: Change = Object.assign({ table: NOTES, key: N1 }, { kind: "conjure" }) as Change;
    const forged: SyncEvent = { ...e2!, changes: [conjure] };

    const device = peer(PEER_A);
    const report = (await device.receiveBatch(entriesOf([e1!, forged, e3!]))).unwrap();
    expect(report.quarantined).toBe(1);
    expect(device.quarantine().map((p) => p.reason)).toEqual(["unknown-kind"]);
    expect(cursorOf(device)).toBe(1);

    // the honest event under that sequence number still closes the gap
    (await device.receiveBatch(entriesOf([e2!]))).unwrap();
    expect(cursorOf(device)).toBe(3);
  });
});

describe("unknownHandling is per mesh, and moves only the telling", () => {
  const parkOne = async (handling: "warn" | "ignore" | "fail") => {
    const author = peer(PEER_B, { validate: validatorFor(newSchema) });
    const memo = (
      await author.mutate(
        CREATE,
        (tx) => tx.insert(MEMOS, key("m1"), row({ id: "m1", body: "later" })),
        { partition: USER },
      )
    ).unwrap();
    const device = peer(PEER_A, {
      validate: validatorFor(oldSchema),
      unknownHandling: handling,
    });
    const warned: string[] = [];
    const raised: EngineError[] = [];
    device.onQuarantine(({ reason }) => void warned.push(reason._tag));
    device.onError((e) => void raised.push(e));
    (await device.receive({ event: memo })).unwrap();
    return { device, warned, raised };
  };

  test("warn reports it, ignore stays quiet, fail raises — and all three park it", async () => {
    const w = await parkOne("warn");
    const i = await parkOne("ignore");
    const f = await parkOne("fail");

    expect(w.warned).toEqual(["UnknownTable"]);
    expect(w.raised).toEqual([]);
    expect(i.warned).toEqual([]);
    expect(i.raised).toEqual([]);
    expect(f.warned).toEqual(["UnknownTable"]);
    expect(f.raised.map((e) => e._tag)).toEqual(["UnreadableEvent"]);

    // the setting cannot move a row: three differently configured peers hold the same state
    for (const other of [i, f]) {
      expect(digestOf(other.device)).toEqual(digestOf(w.device));
      expect(other.device.quarantine()).toHaveLength(1);
      expect(cursorOf(other.device)).toBe(cursorOf(w.device));
    }
  });

  test("a refusal that no update reverses is reported whatever the setting says", async () => {
    const author = peer(PEER_B);
    const [e1] = await threeNotes(author);
    // a column this build knows, holding a kind it does not allow: understood perfectly, and
    // refused for a reason no later release reverses — unlike an unknown table, which is only
    // unreadable until the update lands
    const violating: SyncEvent = {
      ...e1!,
      changes: [{ kind: "insert", table: NOTES, key: key("n9"), row: row({ id: "n9", body: 7 }) }],
    };

    for (const unknownHandling of ["warn", "ignore", "fail"] as const) {
      const device = peer(PEER_A, { validate: validatorFor(oldSchema), unknownHandling });
      const warned: string[] = [];
      const raised: string[] = [];
      device.onQuarantine(({ reason }) => void warned.push(reason._tag));
      device.onError((error) => void raised.push(error._tag));
      (await device.receive({ event: violating })).unwrap();
      // "ignore" silences the unknown, never the refusal: one is a build that will catch up, the
      // other is a write that will never be admissible however long the device waits
      expect(warned).toEqual(["SchemaViolation"]);
      // and "fail" is the unknown's setting too: a refusal is not the test failure it names
      expect(raised).toEqual([]);
    }
  });
});

describe("the quarantine is bounded, and says so when it drops something", () => {
  test("the oldest parked event of a reason goes first, on onError", async () => {
    const author = peer(PEER_B, { validate: validatorFor(newSchema) });
    const memos: SyncEvent[] = [];
    for (const n of [1, 2, 3]) {
      memos.push(
        (
          await author.mutate(
            CREATE,
            (tx) => tx.insert(MEMOS, key(`m${n}`), row({ id: `m${n}`, body: `m-${n}` })),
            { partition: USER },
          )
        ).unwrap(),
      );
    }
    const device = peer(PEER_A, { validate: validatorFor(oldSchema), quarantineLimit: 2 });
    const raised: EngineError[] = [];
    device.onError((e) => void raised.push(e));

    (await device.receiveBatch(entriesOf(memos))).unwrap();
    expect(device.quarantine().map((p) => Number(p.entry.event.seqNum))).toEqual([2, 3]);
    expect(raised.map((e) => e._tag)).toEqual(["QuarantineEvicted"]);
    // the dropped one is offered again, because the cursor never claimed it
    expect(cursorOf(device)).toBe(0);
    expect(aheadOf(device)).toEqual([]);
    expect(holdingOf(device)).toEqual([2, 3]);
  });
});

describe("what the quarantine holds is the author's own bytes (D13)", () => {
  test("a parked event keeps the core it arrived as, never a re-encode of what this build read", async () => {
    const author = peer(PEER_B, { validate: validatorFor(newSchema) });
    const memo = (
      await author.mutate(
        CREATE,
        (tx) => tx.insert(MEMOS, key("m1"), row({ id: "m1", body: "later" })),
        { partition: USER },
      )
    ).unwrap();

    // what a newer build would have sent: a core with one key this decoder drops, and the
    // author's signature over it. The wire verified both before `receive`; nothing re-checks here.
    const core = grownCore(encodeEventCore(memo));
    const sig = Uint8Array.from({ length: 64 }, (_, i) => i); // nothing re-checks it here

    const device = peer(PEER_A, { validate: validatorFor(oldSchema) });
    (await device.receive({ event: memo, core, sig })).unwrap();

    const [parked] = device.quarantine();
    expect(parked?.reason).toBe("unknown-table");
    // identity, not equality: a re-derived core would compare equal to nothing the author signed
    expect(parked?.entry.core).toBe(core);
    expect(parked?.entry.sig).toBe(sig);
    expect(encodeEventCore(parked?.entry.event ?? memo)).not.toEqual(core);
  });

  test("and the retry reads those bytes, not the decode the build that parked it made", async () => {
    const author = peer(PEER_B, { validate: validatorFor(newSchema) });
    const real = (
      await author.mutate(
        CREATE,
        (tx) => tx.insert(MEMOS, key("m1"), row({ id: "m1", body: "what the author wrote" })),
        { partition: USER },
      )
    ).unwrap();

    // the two halves deliberately disagree, which is what a decode that dropped something looks
    // like from the outside: `event` is the poorer reading, `core` is what the author signed
    const poorer: SyncEvent = {
      ...real,
      changes: [{ kind: "insert", table: MEMOS, key: key("m1"), row: row({ id: "m1", body: "" }) }],
    };
    const core = encodeEventCore(real);

    const build = upgradable(validatorFor(oldSchema));
    const device = peer(PEER_A, { validate: build.validator });
    (await device.receive({ event: poorer, core, sig: new Uint8Array(64) })).unwrap();
    expect(device.quarantine().map((p) => p.reason)).toEqual(["unknown-table"]);

    // upgraded, the retry folds what the core says rather than what this build could read then
    build.upgrade(validatorFor(newSchema));
    expect((await device.retryQuarantined()).unwrap().folded).toBe(1);
    const body = readRow(device.state(), MEMOS, key("m1"))?.get(column("body"));
    expect(body).toBe("what the author wrote");
  });
});

describe("the additive rule (D13)", () => {
  test("a column this build does not name is folded, not refused, so both builds digest alike", async () => {
    const author = peer(PEER_B, { validate: validatorFor(newSchema) });
    const pinned = (
      await author.mutate(
        CREATE,
        (tx) => tx.insert(NOTES, key("n1"), row({ id: "n1", body: "one", pinned: true })),
        { partition: USER },
      )
    ).unwrap();

    const older = peer(PEER_A, { validate: validatorFor(oldSchema) });
    const newer = peer(PEER_A, { validate: validatorFor(newSchema) });
    expect((await older.receive({ event: pinned })).unwrap().quarantined).toBe(0);
    (await newer.receive({ event: pinned })).unwrap();

    // the cell it cannot read is kept: dropping it is what would divide the two builds forever
    expect(digestOf(older)).toEqual(digestOf(newer));
    expect(older.quarantine()).toEqual([]);
  });
});
