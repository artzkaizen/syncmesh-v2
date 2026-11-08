import type { ColumnName, PartitionKey, Procedure, RowKey, TableName } from "@syncmesh/kernel";
import type { Peer } from "@syncmesh/transport/test-fixtures";

import { readRow } from "@syncmesh/kernel";
import { createReadGate } from "@syncmesh/transport";
import { ACME, GLOBEX, ISSUER, T0, mintFor, peer } from "@syncmesh/transport/test-fixtures";
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

const ROOM = "read-gate";

/** A grant from the fixtures' issuer, minted `at` ms past T0 so a later one supersedes it. */
const grantFor = (device: Peer, partitions: readonly PartitionKey[], at = 0) =>
  mintFor(device.identity, `acct_${device.identity.peerId.slice(0, 6)}`, {
    partitions,
    now: T0.add({ milliseconds: at }),
  });

const write = (author: Peer, id: string, body: string, partition: PartitionKey) =>
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
    { partition },
  );

const bodyOf = (device: Peer, id: string): string | undefined => {
  const value = readRow(device.engine.state(), NOTES, rowKey(id))?.get(BODY);
  // SAFETY: this suite is the only writer of this table, and it writes body as text
  return value as string | undefined;
};

/** Whether a device's log holds any event of a partition — not a row, not a parked event, nothing. */
const holds = async (device: Peer, partition: PartitionKey) =>
  (await device.engine.eventsSince(new Map()))
    .unwrap()
    .some((entry) => entry.event.partition === partition);

/**
 * Devices on one virtual network, each holding the grants of all the others, each reading
 * through the gate a granted mesh builds (D40). `grants[i]` is device i's own partitions.
 * `hears` wires the topology: absent, everyone hears everyone.
 */
const openRoom = async (
  grants: readonly (readonly PartitionKey[])[],
  hears?: (names: readonly string[], i: number) => readonly string[],
) => {
  const air = virtualLan();
  const peers = grants.map((_g, i) => peer(60 + i * 3, `acct_${String(i)}`));
  // each device's own grant is the narrower one; the fixture minted both partitions at T0
  peers.forEach((device, i) =>
    device.grants.register(grantFor(device, grants[i] ?? [], 1)).unwrap(),
  );
  for (const device of peers)
    for (const other of peers)
      if (other !== device)
        for (const wire of other.grants.allWires()) device.grants.register(wire).unwrap();
  const names = peers.map((_p, i) => `device-${String(i)}`);
  const transports = peers.map((_p, i) =>
    lan({
      id: ROOM,
      network: air.networkFor(
        names[i] ?? String(i),
        hears?.(names, i) ?? names.filter((_n, j) => j !== i),
      ),
      name: `lan:${String(i)}`,
    }),
  );
  const contexts = peers.map((device) => ({
    ...device.context,
    readGate: createReadGate({
      grants: device.grants,
      self: device.identity.peerId,
      issuer: ISSUER.peerId,
    }),
  }));
  await Promise.all(transports.map((transport, i) => transport.start(contexts[i]!)));
  const settle = async (settled: () => boolean = () => false, cap = 40) => {
    for (let round = 0; round < cap; round += 1) {
      await air.settle();
      for (const transport of transports) await transport.flush?.();
      if (settled()) return;
    }
  };
  const stop = () => Promise.all(transports.map((transport) => transport.stop()));
  return { peers, settle, stop };
};

describe("the read gate on peer links (D40)", () => {
  test("live: a peer is never sent an event of a partition its grant does not name, and the rest still folds", async () => {
    const room = await openRoom([[ACME, GLOBEX], [ACME]]);
    const [author, reader] = room.peers;
    if (author === undefined || reader === undefined) throw new Error("two peers");
    await room.settle();
    (await write(author, "a1", "acme one", ACME)).unwrap();
    (await write(author, "g1", "globex secret", GLOBEX)).unwrap();
    (await write(author, "a2", "acme two", ACME)).unwrap();
    await room.settle(() => bodyOf(reader, "a2") !== undefined);

    expect(bodyOf(reader, "a1")).toBe("acme one");
    expect(bodyOf(reader, "a2")).toBe("acme two");
    expect(bodyOf(reader, "g1")).toBeUndefined();
    expect(await holds(reader, GLOBEX)).toBe(false);
    // the hole the gate left is accounted for: the reader's cursor stands past it
    expect(Number(reader.engine.coverage().synced.get(author.identity.peerId))).toBe(3);
    await room.stop();
  });

  test("catch-up: a peer joining after the writes is sent the diff without the partition it lacks", async () => {
    const air = await openRoom([[ACME, GLOBEX], [ACME]]);
    const [author, reader] = air.peers;
    if (author === undefined || reader === undefined) throw new Error("two peers");
    await air.stop();
    // written while the link is down: what crosses next is the cursors exchange's diff
    (await write(author, "a1", "acme one", ACME)).unwrap();
    (await write(author, "g1", "globex secret", GLOBEX)).unwrap();
    (await write(author, "a2", "acme two", ACME)).unwrap();

    const again = virtualLan();
    const transports = [author, reader].map((_device, i) =>
      lan({
        id: ROOM,
        network: again.networkFor(`d${String(i)}`, [`d${String(1 - i)}`]),
        name: `lan:again:${String(i)}`,
      }),
    );
    await Promise.all(
      transports.map((transport, i) => {
        const device = i === 0 ? author : reader;
        return transport.start({
          ...device.context,
          readGate: createReadGate({
            grants: device.grants,
            self: device.identity.peerId,
            issuer: ISSUER.peerId,
          }),
        });
      }),
    );
    for (let round = 0; round < 40 && bodyOf(reader, "a2") === undefined; round += 1) {
      await again.settle();
      for (const transport of transports) await transport.flush?.();
    }
    expect(bodyOf(reader, "a2")).toBe("acme two");
    expect(bodyOf(reader, "g1")).toBeUndefined();
    expect(await holds(reader, GLOBEX)).toBe(false);
    await Promise.all(transports.map((transport) => transport.stop()));
  });

  test("a device that may not read a partition does not carry it either: unsealed content stops at it", async () => {
    // a chain, 0 — 1 — 2: the ends can only reach each other through the middle
    const chain = (names: readonly string[], i: number) =>
      [names[i - 1], names[i + 1]].filter((n): n is string => n !== undefined);
    const room = await openRoom([[ACME, GLOBEX], [ACME], [ACME, GLOBEX]], chain);
    const [left, middle, right] = room.peers;
    if (left === undefined || middle === undefined || right === undefined)
      throw new Error("three peers");
    await room.settle();
    (await write(left, "a1", "acme", ACME)).unwrap();
    (await write(left, "g1", "globex", GLOBEX)).unwrap();
    await room.settle(() => bodyOf(right, "a1") !== undefined);

    expect(bodyOf(right, "a1")).toBe("acme");
    expect(await holds(middle, GLOBEX)).toBe(false);
    // the price of the rule, stated rather than hidden: the far end gets globex from someone
    // who may read it, or not at all — a sealed partition is how content crosses a stranger
    expect(bodyOf(right, "g1")).toBeUndefined();
    await room.stop();
  });

  test("after revocation: once a narrower grant is registered, the next write of the dropped partition is withheld", async () => {
    const room = await openRoom([
      [ACME, GLOBEX],
      [ACME, GLOBEX],
    ]);
    const [author, reader] = room.peers;
    if (author === undefined || reader === undefined) throw new Error("two peers");
    await room.settle();
    (await write(author, "g1", "globex before", GLOBEX)).unwrap();
    await room.settle(() => bodyOf(reader, "g1") !== undefined);
    expect(bodyOf(reader, "g1")).toBe("globex before");

    // the authority re-issues the reader's grant without globex; the author learns it
    author.grants.register(grantFor(reader, [ACME], 1000)).unwrap();
    reader.grants.register(grantFor(reader, [ACME], 1000)).unwrap();
    (await write(author, "g2", "globex after", GLOBEX)).unwrap();
    (await write(author, "a1", "acme after", ACME)).unwrap();
    await room.settle(() => bodyOf(reader, "a1") !== undefined);

    expect(bodyOf(reader, "a1")).toBe("acme after");
    expect(bodyOf(reader, "g2")).toBeUndefined();
    // what it read before the cut it keeps: no scheme undoes a read
    expect(bodyOf(reader, "g1")).toBe("globex before");
    await room.stop();
  });
});
