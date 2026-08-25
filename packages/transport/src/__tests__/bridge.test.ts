import type { Quarantined } from "@syncmesh/engine";

import {
  readRow,
  type RowKey,
  type TableName,
  type ColumnName,
  type Procedure,
} from "@syncmesh/kernel";
import { describe, expect, test } from "bun:test";

import type { BridgeError } from "../bridge.js";

import { bridgeFramedLink } from "../bridge.js";
import { loopbackPair } from "../link.js";
import { ACME, ISSUER, T0, mintFor, peer } from "./fixtures.js";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test fixtures */
const NOTES = "notes" as TableName;
const ID = "id" as ColumnName;
const BODY = "body" as ColumnName;
const CREATE = "notes.create" as Procedure;
const key = (k: string) => k as RowKey;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

type Peer = ReturnType<typeof peer>;

const write = (p: Peer, id: string, body: string) =>
  p.engine.mutate(
    CREATE,
    (tx) =>
      tx.insert(
        NOTES,
        key(id),
        new Map([
          [ID, id],
          [BODY, body],
        ]),
      ),
    { partition: ACME },
  );
const bodyOf = (p: Peer, id: string) => readRow(p.engine.state(), NOTES, key(id))?.get(BODY);

const connect = (x: Peer, y: Peer) => {
  const { a, b, control } = loopbackPair();
  const bx = bridgeFramedLink(a, {
    engine: x.engine,
    identity: x.identity,
    grants: x.grants,
    now: () => T0,
  });
  const by = bridgeFramedLink(b, {
    engine: y.engine,
    identity: y.identity,
    grants: y.grants,
    now: () => T0,
  });
  const settle = async () => {
    for (let i = 0; i < 6; i += 1) {
      await control.flush();
      await bx.flush();
      await by.flush();
    }
  };
  return { bx, by, control, settle };
};

describe("the bridge over a loopback", () => {
  test("grants travel first: two granted strangers converge with zero quarantines", async () => {
    const alice = peer(40, "acct_a");
    const bob = peer(80, "acct_b", 500);
    (await write(alice, "n1", "from-alice")).unwrap();
    const quarantined: Quarantined[] = [];
    bob.engine.onQuarantine((q) => void quarantined.push(q));

    const { settle } = connect(alice, bob);
    await settle();
    expect(quarantined).toEqual([]);
    expect(bodyOf(bob, "n1")).toBe("from-alice");

    (await write(bob, "n2", "from-bob")).unwrap();
    await settle();
    expect(bodyOf(alice, "n2")).toBe("from-bob");
  });

  test("gap rule: a dropped middle frame is held out, never jumped; resync recovers it", async () => {
    const alice = peer(40, "acct_a");
    const bob = peer(80, "acct_b", 500);
    const { control, by, settle } = connect(alice, bob);
    await settle();

    (await write(alice, "n1", "one")).unwrap();
    await settle();
    control.dropNext(1); // n2's live frame leaves alice and dies in the air
    (await write(alice, "n2", "two")).unwrap();
    (await write(alice, "n3", "three")).unwrap();
    await settle();
    expect(bodyOf(bob, "n1")).toBe("one");
    expect(bodyOf(bob, "n2")).toBeUndefined(); // held out — a max cursor would have jumped it
    expect(bodyOf(bob, "n3")).toBeUndefined();
    expect((await bob.engine.cursors()).unwrap().get(alice.identity.peerId)).toBe(
      (await alice.engine.eventsSince(new Map())).unwrap()[0]?.event.seqNum,
    );

    by.resync();
    await settle();
    expect(bodyOf(bob, "n2")).toBe("two");
    expect(bodyOf(bob, "n3")).toBe("three");
  });

  test("three peers: A's events and grant reach C through B, with A's original signature", async () => {
    const alice = peer(40, "acct_a");
    const bob = peer(80, "acct_b", 500);
    const carol = peer(120, "acct_c", 900);
    (await write(alice, "n1", "hello-carol")).unwrap();

    const ab = connect(alice, bob);
    await ab.settle();
    expect(bodyOf(bob, "n1")).toBe("hello-carol");

    // B↔C only — A is out of range. B relays A's grant (registered during A↔B) and A's event.
    const bc = connect(bob, carol);
    await bc.settle();
    expect(bodyOf(carol, "n1")).toBe("hello-carol");
    expect(carol.grants.grantFor(alice.identity.peerId)).toBeDefined();
  });

  test("grant-request: an ungranted newcomer asks, the far side answers, writes light up", async () => {
    const member = peer(40, "acct_m");
    const newcomerId = peer(160, "acct_n"); // helper builds a registry; make an ungranted one
    const newcomer = {
      ...newcomerId,
      grants: (await import("@syncmesh/wire")).createGrantRegistry({
        issuer: ISSUER.peerId,
        now: () => T0,
      }),
    };

    const { a, b, control } = loopbackPair();
    const requests: { peerId: string; invite?: string }[] = [];
    bridgeFramedLink(a, {
      engine: member.engine,
      identity: member.identity,
      grants: member.grants,
      now: () => T0,
      onGrantRequest: (r) => {
        const seen = { peerId: String(r.peerId) };
        if (r.invite !== undefined) Object.assign(seen, { invite: r.invite });
        requests.push(seen);
        // "M forwards to the issuer and carries the answer back" — registering emits the grant frame
        member.grants.register(mintFor(newcomer.identity, "acct_n")).unwrap();
      },
    });
    const bn = bridgeFramedLink(b, {
      engine: newcomer.engine,
      identity: newcomer.identity,
      grants: newcomer.grants,
      now: () => T0,
    });

    bn.requestGrant("inv-42");
    await control.flush();
    await control.flush();
    expect(requests).toEqual([{ peerId: String(newcomer.identity.peerId), invite: "inv-42" }]);
    expect(newcomer.grants.grantFor(newcomer.identity.peerId)?.account).toBe("acct_n");
  });

  test("send on a dead link is a loud error value, not silence", async () => {
    const alice = peer(40, "acct_a");
    const bob = peer(80, "acct_b", 500);
    const { control, bx, by, settle } = connect(alice, bob);
    await settle();
    const errors: BridgeError[] = [];
    bx.onError((e) => void errors.push(e));
    control.setOnline(false);
    (await write(alice, "n1", "lost")).unwrap();
    expect(errors.map((e) => e._tag)).toEqual(["SendFailed"]);

    control.setOnline(true);
    by.resync(); // the receiver re-requests — it is the side missing data
    await settle();
    expect(bodyOf(bob, "n1")).toBe("lost");
  });
});
