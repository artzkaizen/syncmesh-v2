import { decodeAndVerify, signEvent } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import type { GatedPeer } from "../test-fixtures/index.js";

import { bridgeFramedLink } from "../bridge.js";
import { loopbackPair } from "../link.js";
import {
  AUTHORITY,
  CATALOG,
  CONSULTS,
  gatedPeer,
  holds,
  idsIn,
  writeCatalog,
  writeConsult,
} from "../test-fixtures/index.js";

/** Two gated peers over one loopback, each bridge handed the context's own withholding. */
const linked = (x: GatedPeer, y: GatedPeer) => {
  const { a, b, control } = loopbackPair();
  const bridgeFor = (p: GatedPeer, link: Parameters<typeof bridgeFramedLink>[0]) => {
    const { withheld } = p.context;
    if (withheld === undefined) throw new Error("a gated peer's context withholds");
    return bridgeFramedLink(link, {
      engine: p.engine,
      identity: p.identity,
      grants: p.grants,
      withheld,
    });
  };
  const bx = bridgeFor(x, a);
  const by = bridgeFor(y, b);
  const settle = async () => {
    for (let i = 0; i < 6; i += 1) {
      await control.flush();
      await bx.flush();
      await by.flush();
    }
  };
  return { bx, by, settle };
};

describe("authority-visibility rows never travel peer to peer (D24)", () => {
  test("a direct link carries the authority's global rows written before a gated one, and none of the gated ones", async () => {
    const authority = gatedPeer(7);
    await writeCatalog(authority, "c1", "aspirin");
    (await writeConsult(authority, "x", "a")).unwrap();
    const phone = gatedPeer(41);
    const { bx, by, settle } = linked(authority, phone);
    await settle();
    expect(holds(phone, CATALOG, "c1")).toBe(true);
    expect(holds(phone, CONSULTS, "x")).toBe(false);

    // live as well: the gate is the authority's relay, never whichever link happens to be up
    (await writeConsult(authority, "y", "a")).unwrap();
    await settle();
    expect(idsIn(phone, CONSULTS)).toEqual([]);
    bx.close();
    by.close();
  });

  test("a global row written after a gated one waits behind it, peer to peer (use-cases §4)", async () => {
    // the stated cost: the authority's run has a hole only its relay can account for, so over a
    // direct link alone what follows the hole stays in the phone's holdback
    const authority = gatedPeer(7);
    await writeCatalog(authority, "c1", "aspirin");
    const beforeHole = authority.engine.coverage().synced.get(AUTHORITY.peerId);
    (await writeConsult(authority, "x", "a")).unwrap();
    await writeCatalog(authority, "c2", "ibuprofen");
    const phone = gatedPeer(41);
    const { bx, by, settle } = linked(authority, phone);
    await settle();
    expect(holds(phone, CATALOG, "c1")).toBe(true);
    expect(holds(phone, CATALOG, "c2")).toBe(false);
    expect(phone.engine.coverage().synced.get(AUTHORITY.peerId)).toBe(beforeHole);

    // live as well
    await writeCatalog(authority, "c3", "paracetamol");
    await settle();
    expect(holds(phone, CATALOG, "c3")).toBe(false);
    bx.close();
    by.close();
  });

  test("a device that holds a gated row does not hand it to a phone it met", async () => {
    // `holder` was admitted to x through the relay; `stranger` was not, and they meet on a train
    const authority = gatedPeer(7);
    const x = (await writeConsult(authority, "x", "a")).unwrap();
    const holder = gatedPeer(41);
    // as the relay delivers it: the authority's signature kept, so the holder *could* forward it
    const delivered = decodeAndVerify(signEvent(x, authority.identity).wire).unwrap();
    expect((await holder.engine.receiveBatch([delivered])).isOk()).toBe(true);
    expect(holds(holder, CONSULTS, "x")).toBe(true);

    const stranger = gatedPeer(42);
    const { bx, by, settle } = linked(holder, stranger);
    await settle();
    expect(holds(stranger, CONSULTS, "x")).toBe(false);
    bx.close();
    by.close();
  });

  test("a snapshot served over a direct link has no gated rows and claims none of the authority's run", async () => {
    const authority = gatedPeer(7);
    await writeCatalog(authority, "c1", "aspirin");
    (await writeConsult(authority, "x", "a")).unwrap();
    const phone = gatedPeer(41);
    const { bx, by, settle } = linked(authority, phone);
    by.requestSnapshot();
    await settle();
    expect(holds(phone, CONSULTS, "x")).toBe(false);
    // a cursor past x would make every later catch-up — the relay's included — skip it for good,
    // even once this phone is admitted to it; history re-offers the run instead
    const seen = phone.engine.coverage().synced.get(AUTHORITY.peerId) ?? 0;
    expect(Number(seen)).toBeLessThan(2);
    bx.close();
    by.close();
  });
});
