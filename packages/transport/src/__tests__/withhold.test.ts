import type { PartitionKey } from "@syncmesh/kernel";
import type { CustodyReceipt } from "@syncmesh/wire";

import { parseSeqNum } from "@syncmesh/kernel";
import { describe, expect, test } from "bun:test";

import type { Peer } from "./fixtures.js";

import { bridgeFramedLink } from "../bridge.js";
import { loopbackPair } from "../link.js";
import { createReadGate } from "../read-gate.js";
import { takeWithheld } from "../withhold.js";
import { ACME, GLOBEX, ISSUER, T0, bodyOf, mintFor, peer, write } from "./fixtures.js";

/** A grant for `device` minted `at` ms past T0, so it supersedes the fixture's own. */
const regrant = (device: Peer, partitions: readonly PartitionKey[], at: number) =>
  mintFor(device.identity, `acct_${device.identity.peerId.slice(0, 6)}`, {
    partitions,
    now: T0.add({ milliseconds: at }),
  });

/** Registers one grant on every device, the way grants travel a mesh. */
const everywhere = (devices: readonly Peer[], wire: Uint8Array) => {
  for (const device of devices) device.grants.register(wire).unwrap();
};

const gateOf = (device: Peer) =>
  createReadGate({ grants: device.grants, self: device.identity.peerId, issuer: ISSUER.peerId });

/**
 * An author and a reader on one loopback, each bridge judging the peer the handshake would have
 * proved, as a granted mesh builds it (D40). The reader signs custody; the author keeps receipts.
 */
const gatedLink = (author: Peer, reader: Peer) => {
  for (const wire of author.grants.allWires()) everywhere([reader], wire);
  for (const wire of reader.grants.allWires()) everywhere([author], wire);
  const { a, b, control } = loopbackPair();
  const kept: CustodyReceipt[] = [];
  const wrote = bridgeFramedLink(a, {
    engine: author.engine,
    identity: author.identity,
    grants: author.grants,
    now: () => T0,
    readGate: gateOf(author),
    peer: reader.identity.peerId,
    onReceipt: (receipt) => void kept.push(receipt),
  });
  const read = bridgeFramedLink(b, {
    engine: reader.engine,
    identity: reader.identity,
    grants: reader.grants,
    now: () => T0,
    readGate: gateOf(reader),
    peer: author.identity.peerId,
    incarnation: "store-1",
  });
  const settle = async () => {
    for (let round = 0; round < 10; round += 1) {
      await control.flush();
      await wrote.flush();
      await read.flush();
    }
  };
  return { kept, settle, close: () => [wrote.close(), read.close()] };
};

describe("withheld frames on peer links (D40)", () => {
  test("a withheld frame moves a cursor only when its sender is the author or the issuer", async () => {
    const author = peer(40, "acct_author");
    const reader = peer(43, "acct_reader");
    const stranger = peer(46, "acct_stranger");
    const gate = gateOf(reader);
    const named = new Map([[author.identity.peerId, [1, 2, 3].map((n) => parseSeqNum(n).unwrap())]]);
    const intake = (from: Peer) => ({
      engine: reader.engine,
      gate,
      from: from.identity.peerId,
      drain: () => [],
    });

    // anyone can write the scope text, and grants are broadcast; naming another author's run
    // would make this device skip events it may read, for good
    await takeWithheld(intake(stranger), gate.own(), named);
    expect(reader.engine.coverage().synced.get(author.identity.peerId)).toBeUndefined();

    await takeWithheld(intake(author), gate.own(), named);
    expect(Number(reader.engine.coverage().synced.get(author.identity.peerId))).toBe(3);
  });

  test("a cursor that stepped over a withheld event signs no receipt for it", async () => {
    const author = peer(40, "acct_author");
    const reader = peer(43, "acct_reader");
    everywhere([reader, author], regrant(reader, [ACME], 1));
    (await write(author, "a1", "acme", ACME)).unwrap();
    (await write(author, "g1", "globex", GLOBEX)).unwrap();
    (await write(author, "a2", "acme again", ACME)).unwrap();

    const link = gatedLink(author, reader);
    await link.settle();

    expect(bodyOf(reader, "a2")).toBe("acme again");
    expect(bodyOf(reader, "g1")).toBeUndefined();
    expect(Number(reader.engine.coverage().synced.get(author.identity.peerId))).toBe(3);
    // a later event folds the ordinary way, the moment a holder vouches for its run
    (await write(author, "a3", "acme live", ACME)).unwrap();
    await link.settle();
    expect(bodyOf(reader, "a3")).toBe("acme live");
    // a receipt through 2 or more would tell the author someone else holds g1, which nobody does
    expect(link.kept.filter((r) => Number(r.throughSeq) >= 2)).toEqual([]);
    link.close();
  });
});
