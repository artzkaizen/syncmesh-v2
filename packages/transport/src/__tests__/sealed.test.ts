import type { ColumnName, Procedure, RowKey, TableName } from "@syncmesh/kernel";

import { readRow } from "@syncmesh/kernel";
import { Temporal } from "@syncmesh/temporal";
import { FIRST_EPOCH, createKeyRing, issueGrant, newContentKey, wrapKey } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { bridgeFramedLink } from "../bridge.js";
import { loopbackPair } from "../link.js";
import { ACME, ISSUER, T0, peer, type Peer } from "../test-fixtures/index.js";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- the suite's own brands, as everywhere in these fixtures */
const NOTES = "notes" as TableName;
const ID = "id" as ColumnName;
const BODY = "body" as ColumnName;
const CREATE = "notes.create" as Procedure;
const rowKey = (k: string) => k as RowKey;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

/** The ward's content key, minted by the issuer and handed to the two devices it admits. */
const WARD_KEY = newContentKey();

/**
 * A grant that carries the ward's key, which is the only way a device ever gets one.
 *
 * Minted a second after the fixture's own grant so that it supersedes it: a registry keeps the
 * newer grant per device, and a key that arrived under an older one would be a key nobody could
 * take back by re-issuing.
 */
const LATER = T0.add({ seconds: 1 });
const keyedGrant = (device: Peer) =>
  issueGrant(ISSUER, {
    account: "acct",
    device: device.identity.peerId,
    role: "member",
    partitions: [ACME],
    keys: [
      { partition: ACME, epoch: FIRST_EPOCH, wrapped: wrapKey(device.identity.peerId, WARD_KEY) },
    ],
    validFor: Temporal.Duration.from({ days: 1 }),
    now: LATER,
  });

/** What a device hands its bridges: its own key ring's answer, or nothing at all. */
const cryptoFor = (device: Peer, keyed: boolean) => {
  const ring = createKeyRing(device.identity);
  if (keyed) ring.learn(device.grants.register(keyedGrant(device)).unwrap());
  return ring.crypto();
};

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
 * A—B—C, where A and C hold the ward's key and B does not (book ch. 14).
 *
 * B is the custody role: the clinic's own relay, or a phone that happens to be between two
 * others. It must carry everything and read nothing, and both halves of that matter — a carrier
 * that could not carry would strand the ward, and one that could read would make sealing a
 * decoration.
 */
describe("sealing: custody without judgment", () => {
  test("the middle carries what it cannot read, and the far end reads it", async () => {
    const a = peer(40, "acct_a");
    const b = peer(80, "acct_b");
    const c = peer(120, "acct_c");
    for (const device of [a, b, c]) {
      for (const other of [a, b, c])
        if (other !== device) device.grants.register(keyedGrant(other)).unwrap();
    }

    const side = (device: Peer, link: Parameters<typeof bridgeFramedLink>[0], keyed: boolean) =>
      bridgeFramedLink(link, {
        engine: device.engine,
        identity: device.identity,
        grants: device.grants,
        now: () => T0,
        crypto: cryptoFor(device, keyed),
      });

    const ab = loopbackPair();
    const bc = loopbackPair();
    const bridges = [
      side(a, ab.a, true),
      side(b, ab.b, false), // the carrier: no key, and it was never offered one
      side(b, bc.a, false),
      side(c, bc.b, true),
    ];

    (await write(a, "n1", "patient is stable")).unwrap();
    for (let round = 0; round < 10; round += 1) {
      await ab.control.flush();
      await bc.control.flush();
      for (const bridge of bridges) await bridge.flush();
    }

    // C read it, two hops away, through a device that could not
    expect(bodyOf(c, "n1")).toBe("patient is stable");
    // B folded nothing: not a wrong value, not an empty string — no row at all
    expect(bodyOf(b, "n1")).toBeUndefined();

    // and it carried it: B holds the author's event, signature and all, which is what let it
    // reach C at all. Custody is exactly this — the bytes, without the judgment
    const held = (await b.engine.eventsSince(new Map())).unwrap();
    const carried = held.find((entry) => entry.event.peerId === a.identity.peerId);
    expect(carried).toBeDefined();
    expect(carried?.event.sealed).toBe(true);
    expect(carried?.event.changes).toEqual([]);
    expect(carried?.sig).toBeDefined();
    // nothing was refused, either: a carrier that quarantined what it cannot read would stop
    expect(b.engine.quarantine()).toHaveLength(0);

    for (const bridge of bridges) bridge.close();
  });
});
