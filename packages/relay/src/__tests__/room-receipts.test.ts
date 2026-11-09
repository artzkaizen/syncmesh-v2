import type { Transport, TransportContext } from "@syncmesh/transport";
import type { CustodyReceipt } from "@syncmesh/wire";

import { createMemoryEventStore } from "@syncmesh/engine";
import { parseSeqNum } from "@syncmesh/kernel";
import { Temporal, durationMs } from "@syncmesh/temporal";
import { createIdentity } from "@syncmesh/wire";
import { afterEach, describe, expect, spyOn, test } from "bun:test";

import type { RelayDial } from "../transport.js";

import { createRelayHost } from "../host.js";
import { relayTransport } from "../transport.js";
import { dialTo, openRoom, peer, seed, tick, until, write } from "./fixtures.js";

const running: Transport[] = [];
afterEach(async () => {
  for (const transport of running.splice(0)) await transport.stop();
});

const attach = async (context: TransportContext, dial: () => RelayDial) => {
  const transport = relayTransport({ dial, reconnectMs: 10, maxReconnectMs: 20 });
  running.push(transport);
  await transport.start(context);
  await transport.caughtUp?.();
  return transport;
};

const ROOM_KEY = createIdentity(seed(7)).unwrap();
const ONE = parseSeqNum(1).unwrap();
const FIVE = parseSeqNum(5).unwrap();
const EVERY = Temporal.Duration.from({ milliseconds: 150 });
/** Long enough for two of the room's windows to close. */
const WINDOWS = durationMs(EVERY) * 2;

/** A room that signs its own custody: a configured key, a durable log, nothing trimmed. */
const signingRoom = () =>
  openRoom({ identity: ROOM_KEY, durable: true, custody: { every: EVERY } });

/** What an author kept, and of it what the room itself signed. */
const keeping = () => {
  const kept: CustodyReceipt[] = [];
  return {
    kept,
    onReceipt: (receipt: CustodyReceipt) => void kept.push(receipt),
    fromRoom: () => kept.filter((receipt) => receipt.holder === ROOM_KEY.peerId),
  };
};

describe("the relay room signs its own custody (D28, U38)", () => {
  test("a write's author hears the room vouch for it, under the room's key with its epoch", async () => {
    const room = await signingRoom();
    const author = peer(40, "acct_a");
    const ledger = keeping();
    const { dial } = dialTo(room);
    await attach({ ...author.context, onReceipt: ledger.onReceipt }, dial);

    await write(author, "n1", "one");
    expect(await until(() => ledger.fromRoom().length > 0)).toBe(true);
    const [receipt] = ledger.fromRoom();
    expect(receipt?.holder).toBe(room.peerId);
    expect(receipt?.author).toBe(author.identity.peerId);
    expect(receipt?.throughSeq).toBe(ONE);
    expect(receipt?.incarnation).toBe(room.epoch);
    room.close();
  });

  test("a burst of writes is one signature: the room signs the run it holds, not each event", async () => {
    const room = await signingRoom();
    const author = peer(40, "acct_a");
    const ledger = keeping();
    const { dial } = dialTo(room);
    await attach({ ...author.context, onReceipt: ledger.onReceipt }, dial);

    for (const n of [1, 2, 3, 4, 5]) await write(author, `n${n}`, "burst");
    expect(await until(() => ledger.fromRoom().some((r) => r.throughSeq === 5))).toBe(true);
    await tick(WINDOWS);
    expect(ledger.fromRoom().map((r) => r.throughSeq)).toEqual([FIVE]);
    room.close();
  });

  test("an author away when its write landed is signed to when it sits down again, once", async () => {
    const room = await signingRoom();
    const author = peer(40, "acct_a");
    const first = keeping();
    const { dial } = dialTo(room);
    const away = await attach({ ...author.context, onReceipt: first.onReceipt }, dial);
    await write(author, "n1", "one");
    // gone before the room's window closes: its receipt reaches nobody
    await tick(20);
    await away.stop();
    await tick(WINDOWS);
    expect(first.fromRoom()).toHaveLength(0);

    const back = keeping();
    await attach({ ...author.context, onReceipt: back.onReceipt }, dial);
    expect(await until(() => back.fromRoom().length > 0)).toBe(true);
    expect(back.fromRoom()[0]?.throughSeq).toBe(ONE);
    // nothing moved since the seating's receipt: no more
    await tick(WINDOWS);
    expect(back.fromRoom()).toHaveLength(1);
    room.close();
  });

  test("a room not asked to sign signs nothing", async () => {
    const room = await openRoom({ identity: ROOM_KEY, durable: true });
    const author = peer(40, "acct_a");
    const ledger = keeping();
    const { dial } = dialTo(room);
    await attach({ ...author.context, onReceipt: ledger.onReceipt }, dial);
    await write(author, "n1", "one");
    await tick(WINDOWS);
    expect(ledger.fromRoom()).toHaveLength(0);
    room.close();
  });

  test("a room that could not sign truthfully refuses to open: no key of its own, no durable log, or a trimmed one", async () => {
    const custody = { every: EVERY };
    const refused = (options: Parameters<typeof openRoom>[0]) =>
      openRoom(options).then(
        () => "opened",
        (cause: unknown) => (cause instanceof Error ? cause.message : "refused"),
      );
    expect(await refused({ durable: true, custody })).toContain("no configured key");
    expect(await refused({ identity: ROOM_KEY, custody })).toContain("not durable");
    const trimmed = { keepEventsFor: Temporal.Duration.from({ days: 1 }) };
    expect(
      await refused({ identity: ROOM_KEY, durable: true, custody, retention: trimmed }),
    ).toContain("trims its log");
  });

  test("a log trimmed before this open signs nothing for the author it trimmed, and still signs for the rest", async () => {
    const store = createMemoryEventStore();
    const trimmedAuthor = peer(40, "acct_a");
    const whole = peer(41, "acct_a");
    // an earlier run, without custody, holds n1..n3 of one author and is then compacted through 2;
    // the other author was there too, so it is not refused below the floor when it comes back
    const before = await openRoom({ store });
    const earlier = [
      await attach(trimmedAuthor.context, dialTo(before).dial),
      await attach(whole.context, dialTo(before).dial),
    ];
    for (const n of [1, 2, 3]) await write(trimmedAuthor, `n${n}`, "before");
    const trimmedId = trimmedAuthor.identity.peerId;
    expect(await until(() => whole.engine.coverage().synced.get(trimmedId) === 3)).toBe(true);
    const logged = async (count: number) => {
      for (let tries = 0; tries < 300; tries += 1) {
        if ((await store.all()).unwrap().length === count) return true;
        await tick(15);
      }
      return false;
    };
    expect(await logged(3)).toBe(true);
    for (const transport of earlier) await transport.stop();
    before.close();
    const floor = new Map([[trimmedId, parseSeqNum(2).unwrap()]]);
    const later = Temporal.Now.instant().add({ hours: 1 });
    expect((await store.compactBelow(floor, "synced", later)).unwrap()).toBe(2);

    const room = await openRoom({
      store,
      identity: ROOM_KEY,
      durable: true,
      custody: { every: EVERY },
    });
    const trimmedLedger = keeping();
    const wholeLedger = keeping();
    const { dial } = dialTo(room);
    await attach({ ...trimmedAuthor.context, onReceipt: trimmedLedger.onReceipt }, dial);
    await attach({ ...whole.context, onReceipt: wholeLedger.onReceipt }, dial);
    await write(trimmedAuthor, "n4", "after");
    await write(whole, "w1", "after");
    expect(await until(() => wholeLedger.fromRoom().length > 0)).toBe(true);
    expect(await logged(3)).toBe(true);
    await tick(WINDOWS);
    // the room holds n3..n4 of the trimmed author, not n1..n2: a receipt through 4 would license
    // deleting the only copy of what it trimmed
    expect(trimmedLedger.fromRoom()).toHaveLength(0);
    expect(wholeLedger.fromRoom()[0]?.throughSeq).toBe(ONE);
    room.close();
  });

  test("a host asked to sign needs a key of its own; a room whose store brings its key signs nothing", async () => {
    const custody = { every: EVERY };
    let opened = 0;
    const openRoomStore = () => {
      opened += 1;
      return Promise.resolve({
        store: createMemoryEventStore(),
        epoch: "epoch-1",
        durable: true,
        identity: createIdentity(seed(9)).unwrap(),
        release: () => undefined,
      });
    };
    expect(() => createRelayHost({ openRoomStore, custody })).toThrow("no configured key");
    const idleAfter = Temporal.Duration.from({ milliseconds: 20 });
    const host = createRelayHost({ openRoomStore, custody, identity: ROOM_KEY, idleAfter });
    const author = peer(40, "acct_a");
    const ledger = keeping();
    const warned = spyOn(console, "warn").mockImplementation(() => undefined);
    const held = await host.acquire("main");
    // said where an operator reads it, not dropped: the room was asked to sign and will not
    expect(warned.mock.calls.flat().join(" ")).toContain("signs no custody");
    const { dial } = dialTo(held.room);
    await attach({ ...author.context, onReceipt: ledger.onReceipt }, dial);
    await write(author, "n1", "one");
    await tick(WINDOWS);
    expect(ledger.kept).toHaveLength(0);
    held.release();
    // gone idle and opened again: said once, not at every open
    await tick(durationMs(idleAfter) * 4);
    (await host.acquire("main")).release();
    expect(opened).toBe(2);
    expect(warned.mock.calls.filter((call) => String(call[0]).includes("main"))).toHaveLength(1);
    warned.mockRestore();
    await host.close();
  });
});
