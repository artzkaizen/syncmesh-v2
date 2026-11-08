import type { Transport, TransportContext } from "@syncmesh/transport";
import type { CustodyReceipt, RefusalReceipt } from "@syncmesh/wire";

import { createEngine, createMemoryEventStore } from "@syncmesh/engine";
import { createHlcClock, parseSeqNum } from "@syncmesh/kernel";
import { Temporal } from "@syncmesh/temporal";
import { cursorsFrame, receiptFrame } from "@syncmesh/transport";
import { createGrantRegistry, createIdentity, issueReceipt, issueRefusal } from "@syncmesh/wire";
import { afterEach, describe, expect, test } from "bun:test";

import type { RelayDial } from "../transport.js";

import { memoryFanout } from "../fanout.js";
import { joinFrame, roomRefusalFrame } from "../frames.js";
import { relayTransport } from "../transport.js";
import {
  ACME,
  GLOBEX,
  ISSUER,
  T0,
  dialTo,
  fakeSocket,
  gatedRoom,
  openRoom,
  peer,
  mintFor,
  scriptedRoom,
  seed,
  tick,
  until,
  write,
} from "./fixtures.js";

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

/** An author no peer has granted, with no validator of its own: its writes land here, and park there. */
const ungranted = (n: number) => {
  const identity = createIdentity(seed(n)).unwrap();
  const grants = createGrantRegistry({ issuer: ISSUER.peerId, now: () => T0 });
  let ms = 100;
  const clock = createHlcClock({ now: () => Temporal.Instant.fromEpochMilliseconds(ms++) });
  const engine = createEngine({ peerId: identity.peerId, clock, store: createMemoryEventStore() });
  return { identity, grants, engine, context: { engine, identity, grants, now: () => T0 } };
};

const ONE = parseSeqNum(1).unwrap();

describe("custody over a relay (D32, U17)", () => {
  test("a holder in the room signs for the author's write, and the author keeps the receipt", async () => {
    const room = await openRoom();
    const author = peer(40, "acct_a");
    const holder = peer(80, "acct_b");
    const kept: CustodyReceipt[] = [];
    const { dial } = dialTo(room);
    await attach({ ...author.context, onReceipt: (r) => void kept.push(r) }, dial);
    await attach({ ...holder.context, incarnation: "holder-store-1" }, dial);

    await write(author, "n1", "one");
    expect(await until(() => kept.length > 0)).toBe(true);
    const [receipt] = kept;
    expect(receipt?.holder).toBe(holder.identity.peerId);
    expect(receipt?.author).toBe(author.identity.peerId);
    expect(receipt?.throughSeq).toBe(ONE);
    expect(receipt?.incarnation).toBe("holder-store-1");
    room.close();
  });

  test("an author away while a holder caught up hears the receipt once it is back", async () => {
    const room = await openRoom();
    const author = peer(40, "acct_a");
    const { dial } = dialTo(room);
    const away = await attach(author.context, dial);
    await write(author, "n1", "one");
    await tick(30);
    await away.stop();

    const holder = peer(80, "acct_b");
    await attach({ ...holder.context, incarnation: "holder-store-1" }, dial);
    expect(holder.engine.coverage().synced.get(author.identity.peerId)).toBe(ONE);
    const kept: CustodyReceipt[] = [];
    await attach({ ...author.context, onReceipt: (r) => void kept.push(r) }, dial);
    expect(await until(() => kept.length > 0)).toBe(true);
    expect(kept[0]?.holder).toBe(holder.identity.peerId);
    expect(kept[0]?.throughSeq).toBe(ONE);
    room.close();
  });

  test("a write a holder parked, then folded on a recovery run, is signed for with no write after it", async () => {
    const room = await openRoom();
    const author = ungranted(41);
    const holder = peer(80, "acct_b");
    const kept: CustodyReceipt[] = [];
    const heard: RefusalReceipt[] = [];
    const { dial } = dialTo(room);
    await attach(
      {
        ...author.context,
        onReceipt: (r) => void kept.push(r),
        onRefusal: (r) => void heard.push(r),
      },
      dial,
    );
    await attach({ ...holder.context, incarnation: "holder-store-1" }, dial);
    await write(author, "n1", "one");
    expect(await until(() => heard.length > 0)).toBe(true);
    expect(kept).toHaveLength(0);

    holder.grants.register(mintFor(author.identity, "acct_a")).unwrap();
    (await holder.engine.retryQuarantined()).unwrap();
    expect(await until(() => kept.length > 0)).toBe(true);
    expect(kept[0]?.holder).toBe(holder.identity.peerId);
    expect(kept[0]?.throughSeq).toBe(ONE);
    room.close();
  });

  test("a holder in a grant-gated room signs for the run it was sent, though its cursor is scoped", async () => {
    const room = await gatedRoom();
    const author = peer(40, "acct_a");
    const holder = peer(80, "acct_b");
    const kept: CustodyReceipt[] = [];
    const { dial } = dialTo(room);
    await attach({ ...author.context, onReceipt: (r) => void kept.push(r) }, dial);
    await attach({ ...holder.context, incarnation: "holder-store-1" }, dial);
    expect(holder.engine.coverage().scope).toBeDefined();

    await write(author, "n1", "one");
    expect(await until(() => kept.length > 0)).toBe(true);
    expect(kept[0]?.holder).toBe(holder.identity.peerId);
    expect(kept[0]?.throughSeq).toBe(ONE);
    room.close();
  });

  test("a holder entitled to less signs below the first write it was never sent, never past it", async () => {
    const room = await gatedRoom();
    const author = peer(40, "acct_a");
    const holder = peer(80, "acct_b", 100, { partitions: [ACME] });
    const kept: CustodyReceipt[] = [];
    const { dial } = dialTo(room);
    await attach({ ...author.context, onReceipt: (r) => void kept.push(r) }, dial);
    await attach({ ...holder.context, incarnation: "holder-store-1" }, dial);

    await write(author, "a1", "acme one", ACME);
    await write(author, "g2", "globex", GLOBEX);
    await write(author, "a3", "acme three", ACME);
    expect(await until(() => kept.length > 0)).toBe(true);
    // a write after the hole: the holder folds it, and its cursor steps over seq 2 to reach it
    await write(author, "a4", "acme four", ACME);
    const four = parseSeqNum(4).unwrap();
    expect(
      await until(() => holder.engine.coverage().synced.get(author.identity.peerId) === four),
    ).toBe(true);
    await tick(60);
    // seq 2 never reached the holder, so 1 is all it can sign, however far its cursor stands
    expect(holder.engine.coverage().held?.get(author.identity.peerId)).toBe(ONE);
    expect(kept.map((r) => r.throughSeq)).toEqual(kept.map(() => ONE));
    room.close();
  });

  test("a scoped holder that purges a narrowed partition signs below it, never its old run", async () => {
    const room = await gatedRoom();
    const author = peer(40, "acct_a");
    const holder = peer(80, "acct_b", 100, { partitions: [ACME, GLOBEX] });
    const kept: CustodyReceipt[] = [];
    const { dial } = dialTo(room);
    await attach({ ...author.context, onReceipt: (r) => void kept.push(r) }, dial);
    await attach({ ...holder.context, incarnation: "holder-store-1" }, dial);
    const [three, four] = [3, 4].map((n) => parseSeqNum(n).unwrap());

    await write(author, "a1", "acme one", ACME);
    await write(author, "g2", "globex", GLOBEX);
    await write(author, "a3", "acme three", ACME);
    expect(await until(() => kept.some((r) => r.throughSeq === three))).toBe(true);
    expect(holder.engine.coverage().scope).toBeDefined();

    // the narrowing's purge (D45): the globex write leaves the holder's log, its cursor stays
    const purged = (
      await holder.engine.purge({ events: (event) => event.partition === GLOBEX })
    ).unwrap();
    expect(purged.events).toBe(1);
    const before = kept.length;
    await write(author, "a4", "acme four", ACME);
    expect(
      await until(() => holder.engine.coverage().synced.get(author.identity.peerId) === four),
    ).toBe(true);
    expect(await until(() => kept.length > before)).toBe(true);
    await tick(60);
    // seq 2 is gone from the holder, so 1 is all it can sign again, though it folded 4
    const after = kept.slice(before).map((r) => r.throughSeq);
    expect(after).toEqual(after.map(() => ONE));
    room.close();
  });

  test("a peer in the room that parks the author's write says so, and the author hears it", async () => {
    const room = await openRoom();
    const author = ungranted(41);
    const refuser = peer(80, "acct_b");
    const heard: RefusalReceipt[] = [];
    const { dial } = dialTo(room);
    await attach({ ...author.context, onRefusal: (r) => void heard.push(r) }, dial);
    await attach(refuser.context, dial);

    await write(author, "n1", "one");
    expect(await until(() => heard.length > 0)).toBe(true);
    expect(refuser.engine.quarantine()).toHaveLength(1);
    const [refusal] = heard;
    expect(refusal?.refuser).toBe(refuser.identity.peerId);
    expect(refusal?.author).toBe(author.identity.peerId);
    expect(refusal?.seq).toBe(ONE);
    expect(refusal?.reason).toBe("refused");
    expect(refusal?.verdict).toBe("NoGrant");
    room.close();
  });

  test("a refuser that joins after the write still says so, from the catch-up it parked", async () => {
    const room = await openRoom();
    const author = ungranted(41);
    const heard: RefusalReceipt[] = [];
    const { dial } = dialTo(room);
    await attach({ ...author.context, onRefusal: (r) => void heard.push(r) }, dial);
    await write(author, "n1", "one");
    await tick(30);

    const refuser = peer(80, "acct_b");
    await attach(refuser.context, dial);
    expect(await until(() => heard.length > 0)).toBe(true);
    expect(heard[0]?.verdict).toBe("NoGrant");
    room.close();
  });
});

describe("the room hands a custody frame to its author and nobody else", () => {
  /** A socket seated in the room as `p`, and the connection that frames from it go in through. */
  const seat = (room: Awaited<ReturnType<typeof scriptedRoom>>, p: ReturnType<typeof peer>) => {
    const socket = fakeSocket();
    const conn = room.connect(socket.socket);
    conn.receive(joinFrame([1], p.identity.peerId, new Map()));
    return Object.assign(socket, { conn });
  };
  const custodyFrames = (socket: ReturnType<typeof fakeSocket>) =>
    socket
      .frames()
      .filter((f) => f.kind === "refusal" || (f.kind === "session" && f.frame.kind === "receipt"));

  test("a receipt and a refusal reach the author's socket, byte-identical, and no bystander's", async () => {
    const room = await scriptedRoom();
    const author = peer(40, "acct_a");
    const holder = peer(80, "acct_b");
    const bystander = peer(90, "acct_c");
    const sa = seat(room, author);
    const sh = seat(room, holder);
    const sc = seat(room, bystander);
    await tick();
    const of = { author: author.identity.peerId, now: T0 };
    const receipt = receiptFrame(
      issueReceipt(holder.identity, { ...of, throughSeq: ONE, incarnation: "i" }),
    );
    const refusal = roomRefusalFrame(
      issueRefusal(holder.identity, { ...of, seq: ONE, reason: "refused", verdict: "NoGrant" }),
    );
    const before = sa.sent.length;
    sh.conn.receive(receipt);
    sh.conn.receive(refusal);
    await tick();

    expect(custodyFrames(sa)).toHaveLength(2);
    expect(sa.sent.slice(before)).toContainEqual(receipt);
    expect(sa.sent.slice(before)).toContainEqual(refusal);
    expect(custodyFrames(sc)).toHaveLength(0);
    expect(custodyFrames(sh)).toHaveLength(0);
    room.close();
  });

  test("a socket that passes on somebody else's receipt is not forwarded", async () => {
    const room = await scriptedRoom();
    const author = peer(40, "acct_a");
    const holder = peer(80, "acct_b");
    const relayer = peer(90, "acct_c");
    const sa = seat(room, author);
    const { conn } = seat(room, relayer);
    await tick();
    const signed = issueReceipt(holder.identity, {
      author: author.identity.peerId,
      throughSeq: ONE,
      incarnation: "i",
      now: T0,
    });
    conn.receive(receiptFrame(signed));
    // and bytes that do not verify, under the right tag, go nowhere either
    conn.receive(receiptFrame(Uint8Array.of(1, 2, 3)));
    await tick();

    expect(custodyFrames(sa)).toHaveLength(0);
    room.close();
  });

  test("a cursors frame naming somebody other than the key that joined is dropped", async () => {
    const room = await scriptedRoom();
    const author = peer(40, "acct_a");
    const spoofer = peer(90, "acct_c");
    const holder = seat(room, peer(80, "acct_b"));
    const { conn } = seat(room, spoofer);
    await tick();
    const cursorsFrom = (p: ReturnType<typeof peer>) =>
      holder
        .frames()
        .filter(
          (f) =>
            f.kind === "session" &&
            f.frame.kind === "cursors" &&
            f.frame.from === p.identity.peerId,
        );
    // the join's own cursors frame names the spoofer, so it is counted from here
    const before = cursorsFrom(spoofer).length;
    conn.receive(cursorsFrame(author.identity.peerId, new Map()));
    conn.receive(cursorsFrame(spoofer.identity.peerId, new Map()));
    await tick();

    expect(cursorsFrom(author)).toHaveLength(0);
    expect(cursorsFrom(spoofer)).toHaveLength(before + 1);
    room.close();
  });

  test("across the fleet: an author seated on another instance of the room still hears it", async () => {
    const fanout = memoryFanout();
    const east = await scriptedRoom({ fanout });
    const west = await scriptedRoom({ fanout });
    const author = peer(40, "acct_a");
    const holder = peer(80, "acct_b");
    const bystander = peer(90, "acct_c");
    const sa = seat(west, author);
    const sc = seat(west, bystander);
    const { conn } = seat(east, holder);
    await tick();
    conn.receive(
      roomRefusalFrame(
        issueRefusal(holder.identity, {
          author: author.identity.peerId,
          seq: ONE,
          reason: "refused",
          verdict: "NoGrant",
          now: T0,
        }),
      ),
    );
    await tick();

    expect(custodyFrames(sa)).toHaveLength(1);
    expect(custodyFrames(sc)).toHaveLength(0);
    east.close();
    west.close();
  });
});
