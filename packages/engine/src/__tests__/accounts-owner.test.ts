import type { PeerId } from "@syncmesh/kernel";

import { parseAccountId, parsePartitionKey, parsePeerId, readRow } from "@syncmesh/kernel";
import { partition, syncSchema, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { linkDevice, links, unlinkDevice } from "../accounts.js";
import { createEngine } from "../engine.js";
import { createMemoryEventStore } from "../store.js";
import { createValidator } from "../validate.js";
import { NOTES, PEER_A, PEER_B, column, fakeClock, key, procedure, row } from "./fixtures.js";

/**
 * `owner()` in a mesh with no issuer — the hole D21 exists to fill. There is no grant here at
 * all, so without a link `checkPolicy` is never reached and every rule is moot; with one, the
 * two devices an account has vouched for are the same person to `owner("ownerId")`.
 */

const PEER_C = parsePeerId("c".repeat(64)).unwrap();
const ACME = parsePartitionKey("org:acme").unwrap();
const WRITE = procedure("notes.create");

/** Alice, whose phone and laptop are both hers, and Bob, who is somebody else. */
const ALICE = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 10 + i)).unwrap();
const BOB = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 90 + i)).unwrap();
const ALICE_ID = String(parseAccountId(String(ALICE.peerId)).unwrap());
const BOB_ID = String(parseAccountId(String(BOB.peerId)).unwrap());

const NOW = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const LATER = NOW.add({ minutes: 1 });

const org = partition("org");
const schema = syncSchema({
  tables: {
    notes: {
      columns: { id: t.text().primaryKey(), title: t.text(), ownerId: t.text() },
      partition: org,
      allow: ({ owner }) => ({ $default: owner("ownerId") }),
    },
  },
});

const peer = (peerId: PeerId, accounts = true) => {
  const engine = createEngine({
    peerId,
    clock: fakeClock(NOW.epochMilliseconds),
    store: createMemoryEventStore(),
    merge: schema.merge,
    validate: createValidator({ schema, grantFor: null, accounts }),
  });
  return { engine };
};

type Side = ReturnType<typeof peer>;

const sync = async (from: Side, to: Side) =>
  (await to.engine.receiveBatch((await from.engine.eventsSince(new Map())).unwrap())).unwrap();

const note = (side: Side, id: string, ownerId: string) =>
  side.engine.mutate(WRITE, (tx) => tx.insert(NOTES, key(id), row({ id, title: id, ownerId })), {
    partition: ACME,
  });

const tag = (r: { isErr: () => boolean; error?: { _tag: string } }) =>
  r.isErr() ? (r.error?._tag ?? "?") : "ok";

/** Alice's phone and laptop, each claiming itself, with every peer holding both claims. */
const meshOfTwo = async () => {
  const phone = peer(PEER_A);
  const laptop = peer(PEER_B);
  (
    await linkDevice(phone.engine, { account: ALICE, device: PEER_A, partition: ACME, at: NOW })
  ).unwrap();
  (
    await linkDevice(laptop.engine, { account: ALICE, device: PEER_B, partition: ACME, at: NOW })
  ).unwrap();
  await sync(phone, laptop);
  await sync(laptop, phone);
  return { phone, laptop };
};

describe("owner() where nobody holds a grant", () => {
  test("two linked devices of one account are the same person to owner()", async () => {
    const { phone, laptop } = await meshOfTwo();

    expect(tag(await note(phone, "n1", ALICE_ID))).toBe("ok");
    await sync(phone, laptop); // the laptop admits it: it holds the phone's link
    expect(readRow(laptop.engine.state(), NOTES, key("n1"))).toBeDefined();

    // the other device writes the same account's row, and every peer agrees
    const patch = await laptop.engine.mutate(
      WRITE,
      (tx) => tx.update(NOTES, key("n1"), row({ title: "from the laptop" })),
      { partition: ACME },
    );
    expect(tag(patch)).toBe("ok");
    // and it is Alice the laptop is, not merely somebody: Bob's rows are still not its business
    expect(tag(await note(laptop, "n9", BOB_ID))).toBe("PolicyDenied");
    await sync(laptop, phone);
    expect(readRow(phone.engine.state(), NOTES, key("n1"))?.get(column("title"))).toBe(
      "from the laptop",
    );
  });

  test("a linked device may not write another account's row", async () => {
    const { phone } = await meshOfTwo();
    expect(tag(await note(phone, "n2", BOB_ID))).toBe("PolicyDenied");
  });

  test("an unlinked device gets no principal and behaves exactly as it does today", async () => {
    const { phone } = await meshOfTwo();
    const stranger = peer(PEER_C);
    await sync(phone, stranger);

    // no link, so no principal, so policy is never reached — the verdict a device with no grant
    // has always had. Nothing here invents an account for a device that never claimed one
    expect(tag(await note(stranger, "n3", BOB_ID))).toBe("ok");
    expect(links(stranger.engine).some((l) => l.device === String(PEER_C))).toBe(false);
  });

  test("with accounts unset the same write is admitted: switching them on only ever admits less", async () => {
    const { phone } = await meshOfTwo();
    const unaware = peer(PEER_A, false);
    await sync(phone, unaware);
    expect(tag(await note(unaware, "n2", BOB_ID))).toBe("ok");
  });

  test("after an unlink no peer that folded it answers owner() for that device, and what it wrote stands", async () => {
    const { phone, laptop } = await meshOfTwo();
    (await note(laptop, "n1", ALICE_ID)).unwrap();
    await sync(laptop, phone);
    expect(tag(await note(laptop, "n2", BOB_ID))).toBe("PolicyDenied");

    // anyone may carry an unlink; here the phone does, and both peers fold the same row
    (
      await unlinkDevice(phone.engine, {
        account: ALICE,
        device: PEER_B,
        partition: ACME,
        at: LATER,
      })
    ).unwrap();
    await sync(phone, laptop);
    for (const side of [phone, laptop]) {
      expect(
        links(side.engine)
          .filter((l) => l.linked)
          .map((l) => l.device),
      ).toEqual([String(PEER_A)]);
      // written while it was Alice's, and an unlink rewrites no history
      expect(readRow(side.engine.state(), NOTES, key("n1"))).toBeDefined();
    }

    // and the honest half: the laptop is nobody again, which in a mesh with no grants means
    // unpoliced rather than refused. A link can only ever *add* a principal — taking powers
    // away from a device that never held a grant is what an authority's revocation is for
    expect(tag(await note(laptop, "n2", BOB_ID))).toBe("ok");
  });
});
