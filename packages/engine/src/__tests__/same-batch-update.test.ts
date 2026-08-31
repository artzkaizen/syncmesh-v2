import type { PeerId } from "@syncmesh/kernel";

import { parseAccountId, parsePartitionKey, readRow } from "@syncmesh/kernel";
import { defineSchema, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { linkDevice } from "../accounts.js";
import { createEngine } from "../engine.js";
import { createMemoryEventStore } from "../store.js";
import { createValidator } from "../validate.js";
import { NOTES, PEER_A, PEER_B, column, fakeClock, key, procedure, row } from "./fixtures.js";

/**
 * A row's update, delivered in the same batch as its insert.
 *
 * `owner()` reads the row the change lands on, so an update carries no copy of the column that
 * owns it — a patch holds what changed, and what owns a row is exactly what does not. The row it
 * needs is the one the insert makes, and when both arrive together the verdict must not depend on
 * whether they were handed over one at a time or in one page: a peer catching up in bulk sees
 * every write of its absence at once, which is the case, not the exception.
 */

const ACME = parsePartitionKey("org:acme").unwrap();
const WRITE = procedure("notes.create");
const ALICE = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 10 + i)).unwrap();
const ALICE_ID = String(parseAccountId(String(ALICE.peerId)).unwrap());
const NOW = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);

const schema = defineSchema({
  partitions: { org: {} },
  tables: {
    notes: {
      columns: { id: t.text().primaryKey(), title: t.text(), ownerId: t.text() },
      partition: "org",
      allow: ({ owner }) => ({ $default: owner("ownerId") }),
    },
  },
});

const peer = (peerId: PeerId) =>
  createEngine({
    peerId,
    clock: fakeClock(NOW.epochMilliseconds),
    store: createMemoryEventStore(),
    merge: schema.merge,
    validate: createValidator({ schema, grantFor: null, accounts: true }),
  });

describe("an update delivered in the same batch as its insert", () => {
  test("is admitted, exactly as it would be if the two arrived separately", async () => {
    const author = peer(PEER_A);
    const receiver = peer(PEER_B);
    // each device claims itself, and both claims reach both peers — a device may not claim another
    (
      await linkDevice(author, { account: ALICE, device: PEER_A, partition: ACME, at: NOW })
    ).unwrap();
    (
      await linkDevice(receiver, { account: ALICE, device: PEER_B, partition: ACME, at: NOW })
    ).unwrap();
    (await receiver.receiveBatch((await author.eventsSince(new Map())).unwrap())).unwrap();
    (await author.receiveBatch((await receiver.eventsSince(new Map())).unwrap())).unwrap();

    (
      await author.mutate(
        WRITE,
        (tx) => tx.insert(NOTES, key("n1"), row({ id: "n1", title: "first", ownerId: ALICE_ID })),
        { partition: ACME },
      )
    ).unwrap();
    (
      await author.mutate(WRITE, (tx) => tx.update(NOTES, key("n1"), row({ title: "second" })), {
        partition: ACME,
      })
    ).unwrap();

    // both events at once: the receiver has never seen this row before
    const batch = (await author.eventsSince(new Map())).unwrap();
    const taken = (await receiver.receiveBatch(batch)).unwrap();

    expect(taken.quarantined).toBe(0);
    expect(readRow(receiver.state(), NOTES, key("n1"))?.get(column("title"))).toBe("second");
  });

  test("is admitted later, when its row arrives in a batch after it", async () => {
    const author = peer(PEER_A);
    const receiver = peer(PEER_B);
    (
      await linkDevice(author, { account: ALICE, device: PEER_A, partition: ACME, at: NOW })
    ).unwrap();
    (
      await linkDevice(receiver, { account: ALICE, device: PEER_B, partition: ACME, at: NOW })
    ).unwrap();
    (await receiver.receiveBatch((await author.eventsSince(new Map())).unwrap())).unwrap();
    (await author.receiveBatch((await receiver.eventsSince(new Map())).unwrap())).unwrap();

    const cursor = (await author.cursors()).unwrap();
    (
      await author.mutate(
        WRITE,
        (tx) => tx.insert(NOTES, key("n2"), row({ id: "n2", title: "first", ownerId: ALICE_ID })),
        { partition: ACME },
      )
    ).unwrap();
    (
      await author.mutate(WRITE, (tx) => tx.update(NOTES, key("n2"), row({ title: "second" })), {
        partition: ACME,
      })
    ).unwrap();
    const [insert, update] = (await author.eventsSince(cursor)).unwrap();

    // the update alone: nothing on this device has ever written the row it patches
    const first = (await receiver.receiveBatch([update!])).unwrap();
    expect(first.quarantined).toBe(1);
    expect(readRow(receiver.state(), NOTES, key("n2"))).toBeUndefined();

    // the insert lands, and the parked update is looked at again rather than left refused
    (await receiver.receiveBatch([insert!])).unwrap();
    expect(readRow(receiver.state(), NOTES, key("n2"))?.get(column("title"))).toBe("second");
    expect(receiver.quarantine()).toHaveLength(0);
  });
});
