import type { EngineError, FoldBatch } from "@syncmesh/engine";
import type { SeqNum } from "@syncmesh/kernel";

import { LogTorn, StoreFailure, createHub } from "@syncmesh/engine";
import { PEER_A, seed } from "@syncmesh/kernel/test-fixtures";
import { Result } from "@syncmesh/result";
import { syncSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { linkTransport, loopbackPair } from "@syncmesh/transport";
import { createIdentity, signEvent } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

import { createMesh } from "../mesh.js";
import { sqlite } from "../options.js";
import { type TornDeps, watchTorn } from "../torn.js";

const notes = sqliteTable("notes", { id: text().primaryKey(), body: text() });
const schema = () =>
  syncSchema({
    tables: { notes: { columns: { id: t.text().primaryKey(), body: t.text() } } },
  });

const until = async (check: () => Promise<boolean> | boolean, ms = 3000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return check();
};

const AUTHOR = createIdentity(seed(120)).unwrap();
// SAFETY: test fixture sequence numbers
const at = (n: number) => n as SeqNum;

/** A mesh on its own database; the author writes the global table, which only it may. */
const meshOver = async (n: number, link?: () => ReturnType<typeof loopbackPair>["a"]) => {
  const driver = bunSqliteDriver(":memory:");
  const mesh = (
    await createMesh({
      schema: schema(),
      identity: n === 120 ? AUTHOR : createIdentity(seed(n)).unwrap(),
      storage: sqlite({ driver }),
      transports: link === undefined ? [] : [linkTransport("loopback", link)],
      trust: { authority: AUTHOR.peerId },
      // started together by the test: a loopback frame sent before the far end listens is lost
      start: false,
    })
  ).unwrap();
  return { mesh, driver };
};

/** How many of the author's events a device's own log holds. */
const heldIn = async (device: Awaited<ReturnType<typeof meshOver>>) =>
  Number(
    (
      await device.driver.all(`SELECT COUNT(*) FROM syncmesh.events WHERE peer = ?`, [
        AUTHOR.peerId,
      ])
    )[0]?.[0],
  );

describe("a torn log, on a running mesh (D39)", () => {
  test("is a $recovery issue that blocks the status, and the mesh rejoins from the peer that holds it", async () => {
    const { a, b } = loopbackPair();
    const author = await meshOver(120, () => a);
    const device = await meshOver(160, () => b);
    author.mesh.start().unwrap();
    device.mesh.start().unwrap();
    const writer = author.mesh.on().unwrap();
    for (const id of ["n1", "n2", "n3", "n4", "n5"])
      await writer.db.insert(notes).values({ id, body: id });
    const held = () => heldIn(device);
    expect(await until(async () => (await held()) === 5)).toBe(true);
    expect(await until(() => device.mesh.engine.acks().has(AUTHOR.peerId))).toBe(true);

    // the disk loses two of the author's events under the log
    await device.driver.run(`DELETE FROM syncmesh.events WHERE peer = ? AND seq IN (2, 3)`, [
      AUTHOR.peerId,
    ]);
    // a peer asking for history from nothing is refused, and the refusal is an issue
    const read = await device.mesh.engine.eventsSince(new Map());
    expect(read.isErr() && read.error.message.startsWith("log has a hole")).toBe(true);
    expect(device.mesh.recovery.torn().map(({ run }) => [run.from, run.to])).toEqual([
      [at(2), at(3)],
    ]);
    expect(device.mesh.status.get().health).toBe("blocked-recovery");

    // the author holds the run and is linked: the mesh asks for it again, and the log is whole
    expect(await until(() => device.mesh.recovery.torn().length === 0)).toBe(true);
    expect(await held()).toBe(5);
    const whole = await device.mesh.engine.eventsSince(new Map());
    expect(whole.isOk() && whole.value.length).toBe(5);
    expect(device.mesh.status.get().health).not.toBe("blocked-recovery");

    await Promise.all([author.mesh.stop(), device.mesh.stop()]);
  });

  test("with no peer to ask it waits; accepting the run lets the log read again", async () => {
    const author = await meshOver(120);
    for (const id of ["n1", "n2", "n3"])
      await author.mesh.on().unwrap().db.insert(notes).values({ id, body: id });
    const written = (await author.mesh.engine.eventsSince(new Map())).unwrap();
    const device = await meshOver(162);
    (
      await device.mesh.engine.receiveBatch(written.map(({ event }) => signEvent(event, AUTHOR)))
    ).unwrap();
    await device.driver.run(`DELETE FROM syncmesh.events WHERE peer = ? AND seq = 2`, [
      AUTHOR.peerId,
    ]);
    expect((await device.mesh.engine.eventsSince(new Map())).isErr()).toBe(true);
    const [issue] = device.mesh.recovery.torn();
    expect(issue?.state).toBe("waiting");
    if (issue === undefined) throw new Error("the tear is an issue");

    expect(await device.mesh.recovery.acceptTorn(issue.run)).toBe(true);
    // given up on: the issue is gone and the status no longer blocks on it
    expect(device.mesh.recovery.torn()).toEqual([]);
    expect(device.mesh.status.get().health).not.toBe("blocked-recovery");
    const read = await device.mesh.engine.eventsSince(new Map());
    expect(read.isOk() && read.value.length).toBe(2);
    // still asked for as a hole: the cursor stands below it until something sends it
    expect(device.mesh.engine.coverage().synced.get(AUTHOR.peerId)).toBe(at(1));
    await Promise.all([author.mesh.stop(), device.mesh.stop()]);
  });
});

describe("a torn run being rejoined (D39)", () => {
  test("is not cleared by a fold that lands before its reopen does", async () => {
    // the engine's synced cursor still claims the run until reopen lowers it
    const synced = new Map([[PEER_A, at(5)]]);
    const errors = createHub<EngineError>();
    const folds = createHub<FoldBatch>();
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const engine = {
      acks: () => new Map([[PEER_A, new Map([[PEER_A, at(5)]])]]),
      coverage: () => ({ synced, local: new Map() }),
      reopen: async () => {
        await gate;
        synced.set(PEER_A, at(1));
        return Result.ok(undefined);
      },
      onError: errors.subscribe,
      onAcknowledge: () => () => {},
      onFoldBatch: folds.subscribe,
      onAdopt: () => () => {},
    } satisfies TornDeps["engine"];
    // a medium that names no peers carries to any
    const medium = { resync: () => {} };
    // SAFETY: settle reads nothing off the batch, only that one folded
    const batch = {} as FoldBatch;
    const watch = watchTorn({ engine, transports: () => [medium] });

    const run = { peer: PEER_A, local: false, from: at(2), to: at(3) };
    errors.emit(
      new StoreFailure({
        message: "log has a hole",
        cause: new LogTorn({ runs: [run], message: "log has a hole" }),
      }),
    );
    expect(watch.list().map(({ state }) => state)).toEqual(["rejoining"]);

    // an unrelated batch folds while the reopen is still under way
    folds.emit(batch);
    expect(watch.list().map(({ state }) => state)).toEqual(["rejoining"]);

    release();
    expect(await until(() => synced.get(PEER_A) === at(1))).toBe(true);
    await Promise.resolve();
    // reopened: the cursor stands below the run, and a fold does not clear it until it is back
    folds.emit(batch);
    expect(watch.list()).toHaveLength(1);
    synced.set(PEER_A, at(5));
    folds.emit(batch);
    expect(watch.list()).toEqual([]);
    await watch.stop();
  });
});
