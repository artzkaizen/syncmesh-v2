import type { PartitionKey } from "@syncmesh/kernel";

import { parsePartitionKey, readRow } from "@syncmesh/kernel";
import { describe, expect, test } from "bun:test";

import { openEngine } from "../boot.js";
import { createMemoryStateStore } from "../state-store.js";
import {
  CREATE,
  column,
  N1,
  NOTES,
  PEER_A,
  PEER_B,
  fakeClock,
  key,
  row,
  setup,
} from "./fixtures.js";

const ACME = parsePartitionKey("org:acme").unwrap();
const PAYROLL = parsePartitionKey("org:payroll").unwrap();
const N2 = key("n2");
const N3 = key("n3");
const N4 = key("n4");
const TITLE = column("title");
const BODY = column("body");
const NOTE = column("note");

const lost = (partition: PartitionKey) => ({
  events: (event: { readonly partition?: PartitionKey }) => event.partition === partition,
  rows: (record: { readonly partition?: PartitionKey }) => record.partition === partition,
});

/** B writes one acme row and one payroll row; A holds both, and has written into the payroll one. */
const held = async (stateStore = createMemoryStateStore()) => {
  const a = setup(PEER_A, 500, { stateStore });
  const b = setup(PEER_B, 100);
  (
    await b.engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ title: "acme" })), {
      partition: ACME,
    })
  ).unwrap();
  (
    await b.engine.mutate(
      CREATE,
      (tx) => tx.insert(NOTES, N2, row({ title: "salaries", body: "secret" })),
      { partition: PAYROLL },
    )
  ).unwrap();
  (
    await b.engine.mutate(CREATE, (tx) => tx.insert(NOTES, N4, row({ title: "bonus" })), {
      partition: PAYROLL,
    })
  ).unwrap();
  (await a.engine.receiveBatch((await b.store.all()).unwrap())).unwrap();
  // A's own edit to the payroll row, and a payroll row of A's own
  (
    await a.engine.mutate(CREATE, (tx) => tx.update(NOTES, N2, row({ note: "mine" })), {
      partition: PAYROLL,
    })
  ).unwrap();
  (
    await a.engine.mutate(CREATE, (tx) => tx.insert(NOTES, N3, row({ title: "my payslip" })), {
      partition: PAYROLL,
    })
  ).unwrap();
  return { a, b, stateStore };
};

/** A memory state store whose `remove` waits to be released, holding a purge open mid-commit. */
const stalled = () => {
  const inner = createMemoryStateStore();
  const { promise: entered, resolve: enter } = Promise.withResolvers<void>();
  const { promise: released, resolve: release } = Promise.withResolvers<void>();
  const store = {
    ...inner,
    remove: async (keys: Parameters<typeof inner.remove>[0]) => {
      enter();
      await released;
      return inner.remove(keys);
    },
  } satisfies typeof inner;
  return { store, entered, release: () => release() };
};

describe("engine.purge (D45)", () => {
  test("other devices' events in the lost scope leave the log, and their rows go with them", async () => {
    const { a } = await held();
    const purged = (await a.engine.purge(lost(PAYROLL))).unwrap();
    expect(purged.events).toBe(2);
    const log = (await a.store.all()).unwrap();
    expect(
      log.filter(({ event }) => event.peerId === PEER_B).map(({ event }) => event.partition),
    ).toEqual([ACME]);
    const state = a.engine.state();
    expect(readRow(state, NOTES, N1)?.get(TITLE)).toBe("acme");
    // the row B wrote is rebuilt from what A still holds for it: A's own edit, and nothing of B's
    const salaries = readRow(state, NOTES, N2);
    expect(salaries?.get(BODY)).toBeUndefined();
    expect(salaries?.get(TITLE)).toBeUndefined();
    expect(salaries?.get(NOTE)).toBe("mine");
    // A's own row is A's own words: kept
    expect(readRow(state, NOTES, N3)?.get(TITLE)).toBe("my payslip");
  });

  test("a restart refolding the log does not bring a purged row back", async () => {
    const { a } = await held();
    (await a.engine.purge(lost(PAYROLL))).unwrap();
    // no state store: the boot refolds the whole log, which is where a left-behind event would hide
    const again = (
      await openEngine({ peerId: PEER_A, clock: fakeClock(900), store: a.store })
    ).unwrap();
    expect(readRow(again.state(), NOTES, N2)?.get(BODY)).toBeUndefined();
    expect(readRow(again.state(), NOTES, N2)?.get(NOTE)).toBe("mine");
    expect(readRow(again.state(), NOTES, N1)?.get(TITLE)).toBe("acme");
  });

  test("the state store loses the rows too, so a boot that opens it does not see them", async () => {
    const { a, stateStore } = await held();
    (await a.engine.purge(lost(PAYROLL))).unwrap();
    const loaded = (await stateStore.loadAll()).unwrap();
    expect(readRow(loaded, NOTES, N2)?.get(BODY)).toBeUndefined();
    // a row only B wrote is not rebuilt into anything: it is gone from the cache
    expect(loaded.get(NOTES)?.has(N4)).toBe(false);
    expect(readRow(loaded, NOTES, N1)?.get(TITLE)).toBe("acme");
  });

  test("a purge writes no event and lowers no cursor", async () => {
    const { a } = await held();
    const before = a.engine.coverage().synced;
    let outbound = 0;
    a.engine.onOutbound(() => (outbound += 1));
    (await a.engine.purge(lost(PAYROLL))).unwrap();
    expect(outbound).toBe(0);
    expect(a.engine.coverage().synced).toEqual(before);
  });

  test("the events delivered again after a widening fold again, so the rows come back", async () => {
    const { a, b } = await held();
    (await a.engine.purge(lost(PAYROLL))).unwrap();
    const report = (await a.engine.receiveBatch((await b.store.all()).unwrap())).unwrap();
    expect(report.folded).toBe(2);
    expect(readRow(a.engine.state(), NOTES, N2)?.get(BODY)).toBe("secret");
    expect(readRow(a.engine.state(), NOTES, N2)?.get(NOTE)).toBe("mine");
  });

  test("listeners hear one purge fold naming the rows it touched", async () => {
    const { a } = await held();
    const sources: string[] = [];
    let keys: readonly string[] = [];
    a.engine.onFoldBatch((batch) => {
      sources.push(batch.source);
      keys = [...(batch.writeKeys.get(NOTES) ?? [])].sort();
    });
    (await a.engine.purge(lost(PAYROLL))).unwrap();
    expect(sources).toEqual(["purge"]);
    expect(keys).toEqual([N2, N3, N4].sort());
  });

  test("a scope matching nothing held changes nothing", async () => {
    const { a } = await held();
    const sources: string[] = [];
    a.engine.onFoldBatch((batch) => sources.push(batch.source));
    const purged = (await a.engine.purge(lost(parsePartitionKey("org:none").unwrap()))).unwrap();
    expect(purged.events).toBe(0);
    expect(sources).toEqual([]);
  });

  test("a write made while a purge is in flight stays, in memory and on disk", async () => {
    const stall = stalled();
    const { a } = await held(stall.store);
    const N9 = key("n9");
    const purging = a.engine.purge(lost(PAYROLL));
    await stall.entered;
    const writing = a.engine.mutate(CREATE, (tx) => tx.insert(NOTES, N9, row({ title: "kept" })), {
      partition: ACME,
    });
    await new Promise((settled) => setImmediate(settled));
    stall.release();
    (await purging).unwrap();
    (await writing).unwrap();
    expect(readRow(a.engine.state(), NOTES, N9)?.get(TITLE)).toBe("kept");
    expect(readRow((await stall.store.loadAll()).unwrap(), NOTES, N9)?.get(TITLE)).toBe("kept");
    expect(readRow(a.engine.state(), NOTES, N2)?.get(BODY)).toBeUndefined();
  });

  test("a write to a row the purge rebuilds, made while it is in flight, is not rebuilt away", async () => {
    const stall = stalled();
    const { a } = await held(stall.store);
    const purging = a.engine.purge(lost(PAYROLL));
    await stall.entered;
    const writing = a.engine.mutate(
      CREATE,
      (tx) => tx.update(NOTES, N2, row({ title: "mine now" })),
      {
        partition: PAYROLL,
      },
    );
    await new Promise((settled) => setImmediate(settled));
    stall.release();
    (await purging).unwrap();
    (await writing).unwrap();
    expect(readRow(a.engine.state(), NOTES, N2)?.get(TITLE)).toBe("mine now");
    expect(readRow((await stall.store.loadAll()).unwrap(), NOTES, N2)?.get(TITLE)).toBe("mine now");
    expect(readRow(a.engine.state(), NOTES, N2)?.get(BODY)).toBeUndefined();
  });

  test("a remote fold landing while a purge is in flight stays", async () => {
    const stall = stalled();
    const { a, b } = await held(stall.store);
    const N8 = key("n8");
    (
      await b.engine.mutate(CREATE, (tx) => tx.insert(NOTES, N8, row({ title: "late" })), {
        partition: ACME,
      })
    ).unwrap();
    const fresh = (await b.store.all())
      .unwrap()
      .filter(({ event }) => event.changes.some((change) => change.key === N8));
    const purging = a.engine.purge(lost(PAYROLL));
    await stall.entered;
    const receiving = a.engine.receiveBatch(fresh);
    // the receive runs as far as it is let before the purge resumes: to its end, if nothing holds it
    await new Promise((settled) => setImmediate(settled));
    stall.release();
    (await purging).unwrap();
    (await receiving).unwrap();
    expect(readRow(a.engine.state(), NOTES, N8)?.get(TITLE)).toBe("late");
    expect(readRow((await stall.store.loadAll()).unwrap(), NOTES, N8)?.get(TITLE)).toBe("late");
  });
});
