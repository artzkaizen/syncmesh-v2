import type { ColumnName, Procedure, RowKey, TableName } from "@syncmesh/kernel";
import type { Peer } from "@syncmesh/transport/test-fixtures";

import { readRow } from "@syncmesh/kernel";
import { ACME, peer } from "@syncmesh/transport/test-fixtures";
import { describe, expect, test } from "bun:test";

import { lan } from "../lan/transport.js";
import { virtualLan } from "../lan/virtual-lan.js";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- the fixtures' own brands */
const NOTES = "notes" as TableName;
const ID = "id" as ColumnName;
const BODY = "body" as ColumnName;
const CREATE = "notes.create" as Procedure;
const rowKey = (k: string) => k as RowKey;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

const SIZE = 30;
const ROOM = "the-depot";

const write = (author: Peer, id: string, body: string) =>
  author.engine.mutate(
    CREATE,
    (tx) =>
      tx.insert(
        NOTES,
        rowKey(id),
        new Map([
          [ID, id],
          [BODY, body],
        ]),
      ),
    { partition: ACME },
  );

const bodyOf = (device: Peer, id: string): string | undefined => {
  const value = readRow(device.engine.state(), NOTES, rowKey(id))?.get(BODY);
  // SAFETY: this suite is the only writer of this table, and it writes body as text
  return value as string | undefined;
};

/**
 * Thirty devices in one room, wired as a **ring** (book ch. 27, phase 4's gate).
 *
 * A ring rather than a crowd, deliberately. Thirty devices that can all see each other form a
 * full mesh, and a full mesh has no islands the way a single room has no corridors — it proves
 * nothing about the thing that actually fails. In a ring each device hears only its two
 * neighbours, so a write from one of them reaches the far side only by being carried fifteen
 * times, by fifteen devices that have no interest of their own in it.
 *
 * Everything here is real: thirty `lan()` transports, thirty engines, a handshake and a grant
 * exchange per link. What is virtual is the network underneath, which delivers in order and
 * loses nothing unless a test says otherwise.
 */
const openRing = async (size: number) => {
  const air = virtualLan();
  const peers = Array.from({ length: size }, (_, i) => peer(40 + i * 3, `acct_${String(i)}`));
  // every device already holds every grant: what is under test is the topology, not flow A
  for (const device of peers)
    for (const other of peers)
      if (other !== device)
        for (const wire of other.grants.allWires()) device.grants.register(wire).unwrap();

  const names = peers.map((_p, i) => `device-${String(i)}`);
  const transports = peers.map((_p, i) => {
    const left = names[(i + size - 1) % size];
    const right = names[(i + 1) % size];
    const hears = [left, right].filter((n): n is string => n !== undefined);
    return lan({
      id: ROOM,
      network: air.networkFor(names[i] ?? String(i), hears),
      name: `lan:${String(i)}`,
    });
  });
  await Promise.all(transports.map((transport, i) => transport.start(peers[i]!.context)));

  /**
   * Drains until it stops changing, up to a cap — a fixed round count on a ring is either a
   * number that is too small on the day someone adds a hop, or one that is mostly waiting.
   */
  const settle = async (settled: () => boolean = () => false, cap = 40) => {
    for (let round = 0; round < cap; round += 1) {
      await air.settle();
      for (const transport of transports) await transport.flush?.();
      if (settled()) return;
    }
  };
  const stop = async () => {
    await Promise.all(transports.map((transport) => transport.stop()));
  };
  return { air, peers, transports, settle, stop };
};

describe(`a room of ${String(SIZE)} devices, in a ring`, () => {
  test("every device ends up holding every device's write, with nobody islanded", async () => {
    const room = await openRing(SIZE);
    await room.settle(() => room.transports.every((t) => t.reaches?.().size === 2));

    // the ring is closed: every device reaches exactly its two neighbours, and no more
    for (const transport of room.transports) expect(transport.reaches?.().size).toBe(2);

    // three writers, spread around the ring, so no reader is near all of them
    const writers = [0, 10, 20];
    for (const at of writers) {
      const author = room.peers[at];
      if (author !== undefined)
        (await write(author, `n${String(at)}`, `from-${String(at)}`)).unwrap();
    }
    await room.settle(() =>
      room.peers.every((device) =>
        writers.every((at) => bodyOf(device, `n${String(at)}`) !== undefined),
      ),
    );

    for (const device of room.peers)
      for (const at of writers) expect(bodyOf(device, `n${String(at)}`)).toBe(`from-${String(at)}`);
    // and nothing was refused anywhere on the way round
    for (const device of room.peers) expect(device.engine.quarantine()).toHaveLength(0);
    expect(room.peers).toHaveLength(SIZE);

    await room.stop();
  }, 60_000);

  test("a transfer survives the ring being cut: the long way round still arrives", async () => {
    const room = await openRing(SIZE);
    await room.settle(() => room.transports.every((t) => t.reaches?.().size === 2));

    // cut the ring into a line by stopping one device entirely — its neighbours lose their link
    await room.transports[15]?.stop();
    await room.settle();

    const author = room.peers[0];
    if (author !== undefined) (await write(author, "after", "cut")).unwrap();
    await room.settle(() =>
      room.peers.every((device, i) => i === 15 || bodyOf(device, "after") !== undefined),
    );

    // a ring cut in one place is a line, and a line still reaches both ends — it just takes
    // longer. Everyone but the device that left holds it
    for (const [i, device] of room.peers.entries()) {
      if (i === 15) continue;
      expect(bodyOf(device, "after")).toBe("cut");
    }

    await room.stop();
  }, 60_000);
});
