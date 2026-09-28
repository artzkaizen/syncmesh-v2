import type { CustodyReceipt } from "@syncmesh/wire";

import { describe, expect, test } from "bun:test";

import type { BridgeOptions } from "../bridge.js";

import { bridgeFramedLink } from "../bridge.js";
import { loopbackPair } from "../link.js";
import { T0, peer, write } from "./fixtures.js";

/**
 * Two bridged peers where the holder signs what it stores. The author keeps every receipt that
 * arrives about its own log — which is the whole point: a cursor says "I have your events" and
 * proves none of it, and a count taken off cursors is a count of claims.
 */
const connect = (
  author: ReturnType<typeof peer>,
  holder: ReturnType<typeof peer>,
  incarnation: string,
) => {
  const { a, b, control } = loopbackPair();
  const kept: CustodyReceipt[] = [];
  const side = (p: typeof author, link: typeof a, extra: Partial<BridgeOptions> = {}) =>
    bridgeFramedLink(link, {
      engine: p.engine,
      identity: p.identity,
      grants: p.grants,
      now: () => T0,
      ...extra,
    });
  const wrote = side(author, a, { onReceipt: (receipt) => void kept.push(receipt) });
  const held = side(holder, b, { incarnation });
  const settle = async () => {
    for (let round = 0; round < 8; round += 1) {
      await control.flush();
      await wrote.flush();
      await held.flush();
    }
  };
  return { kept, settle, close: () => [wrote.close(), held.close()] };
};

describe("custody receipts — the claim, signed (book ch. 10)", () => {
  test("the holder signs what it stored, and the author keeps it", async () => {
    const author = peer(40, "acct_x");
    const holder = peer(80, "acct_y");
    (await write(author, "n1", "one")).unwrap();
    (await write(author, "n2", "two")).unwrap();

    const link = connect(author, holder, "store-1");
    await link.settle();

    // one per durable batch, never per frame: custody is vouched when the commit lands
    expect(link.kept.length).toBeGreaterThan(0);
    const covered = link.kept.map((r) => Number(r.throughSeq));
    expect(covered).toEqual([...covered].sort((x, y) => x - y)); // custody only grows
    const receipt = link.kept.at(-1);
    expect(receipt?.holder).toBe(holder.identity.peerId);
    expect(receipt?.author).toBe(author.identity.peerId);
    expect(Number(receipt?.throughSeq)).toBe(2); // everything stored, not merely the last frame
    // the lineage is what lets an author tell "still holding" from "holding again, having lost it"
    expect(receipt?.incarnation).toBe("store-1");
    link.close();
  });

  test("a holder that cannot name its storage lineage signs nothing", async () => {
    const author = peer(40, "acct_x");
    const holder = peer(80, "acct_y");
    (await write(author, "n1", "one")).unwrap();

    const { a, b, control } = loopbackPair();
    const kept: CustodyReceipt[] = [];
    const side = (p: typeof author, link: typeof a, extra: Partial<BridgeOptions> = {}) =>
      bridgeFramedLink(link, {
        engine: p.engine,
        identity: p.identity,
        grants: p.grants,
        now: () => T0,
        ...extra,
      });
    const wrote = side(author, a, { onReceipt: (r) => void kept.push(r) });
    const held = side(holder, b); // no incarnation: vouching without saying which store proves less than nothing
    for (let round = 0; round < 8; round += 1) {
      await control.flush();
      await wrote.flush();
      await held.flush();
    }
    expect(kept).toEqual([]);
    wrote.close();
    held.close();
  });
});
