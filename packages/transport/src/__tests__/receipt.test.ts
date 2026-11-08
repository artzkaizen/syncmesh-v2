import type { CustodyReceipt, RefusalReceipt } from "@syncmesh/wire";

import { createEngine, createMemoryEventStore } from "@syncmesh/engine";
import { createHlcClock, parseSeqNum, type PeerId } from "@syncmesh/kernel";
import { Temporal } from "@syncmesh/temporal";
import { createGrantRegistry, createIdentity, issueRefusal } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import type { BridgeError } from "../bridge.js";
import type { BridgeOptions } from "../bridge.js";
import type { FrameLink } from "../link.js";

import { bridgeFramedLink } from "../bridge.js";
import { KIND } from "../frame-parts.js";
import { refusalFrame } from "../frame.js";
import { loopbackPair } from "../link.js";
import { ACME, CREATE, ID, ISSUER, T0, key, mintFor, peer, seed, write } from "./fixtures.js";

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

/**
 * An author whose events a granted holder will park: no validator of its own, so it writes what
 * it likes, and — unless handed one — no grant to send, so the holder's ladder says `NoGrant`.
 */
const ungranted = (n: number, grant?: Uint8Array) => {
  const identity = createIdentity(seed(n)).unwrap();
  const grants = createGrantRegistry({ issuer: ISSUER.peerId, now: () => T0 });
  if (grant !== undefined) grants.register(grant).unwrap();
  let ms = 100;
  const clock = createHlcClock({ now: () => Temporal.Instant.fromEpochMilliseconds(ms++) });
  const engine = createEngine({ peerId: identity.peerId, clock, store: createMemoryEventStore() });
  return { identity, grants, engine };
};

type Side = Pick<ReturnType<typeof peer>, "engine" | "identity" | "grants">;

/** Two bridged peers, every refusal and error the author's side heard, and the rounds to settle. */
const refusing = (
  author: Side,
  holder: Side,
  wrap: (link: FrameLink) => FrameLink = (link) => link,
) => {
  const { a, b, control } = loopbackPair();
  const heard: RefusalReceipt[] = [];
  const errors: BridgeError[] = [];
  const side = (p: Side, link: FrameLink, extra: Partial<BridgeOptions> = {}) =>
    bridgeFramedLink(link, {
      engine: p.engine,
      identity: p.identity,
      grants: p.grants,
      now: () => T0,
      ...extra,
    });
  const wrote = side(author, wrap(a), { onRefusal: (r) => void heard.push(r) });
  const held = side(holder, b);
  wrote.onError((e) => void errors.push(e));
  const settle = async () => {
    for (let round = 0; round < 8; round += 1) {
      await control.flush();
      await wrote.flush();
      await held.flush();
    }
  };
  return { heard, errors, settle, wrote, held, close: () => [wrote.close(), held.close()] };
};

/** A row in a table the holder's schema has never heard of: what a newer build's table arrives as. */
const writeTask = (p: Side) =>
  p.engine.mutate(
    CREATE,
    // SAFETY: a table name in its documented form, unknown to the holder on purpose
    (tx) => tx.insert("tasks" as never, key("t1"), new Map([[ID, "t1"]])),
    { partition: ACME },
  );

describe("refusal receipts — the refusing twin of custody (D32)", () => {
  test("a direct peer that parks the author's event says so, signed, naming itself", async () => {
    const author = ungranted(41);
    const holder = peer(80, "acct_y");
    (await write(author, "n1", "one")).unwrap();

    const link = refusing(author, holder);
    await link.settle();

    expect(holder.engine.quarantine()).toHaveLength(1);
    const refusal = link.heard.at(0);
    expect(refusal?.refuser).toBe(holder.identity.peerId);
    expect(refusal?.author).toBe(author.identity.peerId);
    expect(Number(refusal?.seq)).toBe(1);
    expect(refusal?.reason).toBe("refused");
    expect(refusal?.verdict).toBe("NoGrant");
    // the same report every time it is repeated: idempotent on (refuser, author, seq, verdict)
    expect(new Set(link.heard.map((r) => `${r.refuser}/${r.seq}/${r.verdict}`)).size).toBe(1);
    expect(link.errors).toEqual([]);
    link.close();
  });

  test("still parked, it is said again on the next cursor exchange", async () => {
    const author = ungranted(41);
    const holder = peer(80, "acct_y");
    (await write(author, "n1", "one")).unwrap();
    const link = refusing(author, holder);
    await link.settle();
    const before = link.heard.length;

    link.wrote.resync(); // a cursor exchange; the parked event is not re-offered (D13 `ahead`)
    await link.settle();

    expect(link.heard.length).toBeGreaterThan(before);
    link.close();
  });

  test("a table the refuser's build does not know reports unknown-table, not refused", async () => {
    const author = ungranted(42, mintFor(createIdentity(seed(42)).unwrap(), "acct_x"));
    const holder = peer(80, "acct_y");
    (await writeTask(author)).unwrap();

    const link = refusing(author, holder);
    await link.settle();

    expect(link.heard.at(0)?.reason).toBe("unknown-table");
    expect(link.heard.at(0)?.verdict).toBe("UnknownTable");
    link.close();
  });

  test("a refusal of somebody else's write is dropped on arrival", async () => {
    const author = ungranted(41);
    const holder = peer(80, "acct_y");
    const bystander = peer(120, "acct_z");
    const { a, b, control } = loopbackPair();
    const heard: RefusalReceipt[] = [];
    const listening = bridgeFramedLink(a, {
      engine: bystander.engine,
      identity: bystander.identity,
      grants: bystander.grants,
      now: () => T0,
      onRefusal: (r) => void heard.push(r),
    });
    const about = (whose: PeerId) =>
      refusalFrame(
        issueRefusal(holder.identity, {
          author: whose,
          seq: parseSeqNum(1).unwrap(),
          reason: "refused",
          verdict: "NoGrant",
          now: T0,
        }),
      );

    b.send(about(author.identity.peerId)); // validly signed, and not the bystander's to keep
    b.send(about(bystander.identity.peerId)); // the control: one about its own write is kept
    await control.flush();
    await listening.flush();

    expect(heard.map((r) => r.author)).toEqual([bystander.identity.peerId]);
    listening.close();
  });

  test("an older build ignores kind 9: the tag is unknown to it, and nothing breaks", async () => {
    const author = ungranted(41);
    const holder = peer(80, "acct_y");
    (await write(author, "n1", "one")).unwrap();
    let rewritten = 0;
    // the author's build predates tag 9: every refusal frame arrives as a tag it has no name for
    const older = (link: FrameLink): FrameLink => ({
      ...link,
      onFrame: (cb) =>
        link.onFrame((frame) => {
          if (frame[1] !== KIND.refusal) return cb(frame);
          rewritten += 1;
          const unknown = Uint8Array.from(frame);
          unknown[1] = 23;
          cb(unknown);
        }),
    });

    const link = refusing(author, holder, older);
    await link.settle();

    expect(rewritten).toBeGreaterThan(0);
    expect(link.heard).toEqual([]);
    expect(link.errors).toEqual([]);
    link.close();
  });
});
