import type { PeerId } from "@syncmesh/kernel";
import type { Grant } from "@syncmesh/wire";

import { parsePartitionKey, parsePeerId, readRow } from "@syncmesh/kernel";
import { defineSchema, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant, verifyGrant } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { createEngine } from "../engine.js";
import { createMemoryEventStore } from "../store.js";
import { createValidator } from "../validate.js";
import { CREATE, column, fakeClock, key, row, table } from "./fixtures.js";

/**
 * Convergence with the rules switched on, and with the batch boundary chosen at random.
 *
 * `convergence.test.ts` runs every peer with no `allow` block and no validator, so it measures the
 * merge and nothing else. Every write there is admissible by construction, which is exactly the
 * assumption a policy breaks: a rule reads the row a change lands on, so whether a write is
 * admitted can depend on what else the same delivery carried — and the delivery is the far side's
 * choice, not the author's.
 *
 * The property is that it must not be. The same legitimate writes, cut into pages at random and
 * handed over in any order, have to end at the same state as one page in order, with nothing left
 * refused. A device that pages differently is not a different device.
 */

const ACME = parsePartitionKey("org:acme").unwrap();
const ISSUER = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 50 + i)).unwrap();
const NOW = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const NOTE = table("note");

/** A row belongs to the account that made it, and only that account may write it again. */
const schema = defineSchema({
  partitions: { org: {} },
  roles: { org: ["admin", "member"] },
  tables: {
    note: {
      columns: {
        id: t.text().primaryKey(),
        title: t.text(),
        body: t.text(),
        ownerId: t.text(),
      },
      partition: "org",
      allow: ({ owner, role, any }) => ({
        $default: any(owner("ownerId"), role("admin")),
        read: role("member"),
      }),
    },
  },
});

const accountOf = (index: number) => `acct_${String.fromCharCode(97 + index)}`;
const peerOf = (index: number): PeerId =>
  parsePeerId(String.fromCharCode(97 + index).repeat(64)).unwrap();

const grantFor = (device: PeerId): Grant | undefined => {
  const index = String(device).charCodeAt(0) - 97;
  if (index < 0 || index > 25) return undefined;
  return verifyGrant(
    issueGrant(ISSUER, {
      account: accountOf(index),
      device,
      role: "member",
      partitions: [ACME],
      validFor: Temporal.Duration.from({ hours: 1 }),
      now: NOW,
    }),
    ISSUER.peerId,
    NOW,
  ).unwrap();
};

const peer = (index: number) => {
  const clock = fakeClock(100);
  return {
    index,
    peerId: peerOf(index),
    account: accountOf(index),
    clock,
    engine: createEngine({
      peerId: peerOf(index),
      clock,
      store: createMemoryEventStore(),
      merge: schema.merge,
      validate: createValidator({ schema, grantFor }),
    }),
  };
};

type Peer = ReturnType<typeof peer>;

/**
 * Everything `to` has not seen, handed over in pages of `size` — the far side's paging, which the
 * author never chose and cannot see.
 */
const deliver = async (from: Peer, to: Peer, size: number) => {
  const cursors = (await to.engine.cursors()).unwrap();
  const owed = (await from.engine.eventsSince(cursors)).unwrap();
  for (let at = 0; at < owed.length; at += size)
    (await to.engine.receiveBatch(owed.slice(at, at + size))).unwrap();
};

/** Every peer talks to every other until nothing moves, so no result depends on who spoke first. */
const settle = async (peers: readonly Peer[], size: number) => {
  for (let round = 0; round < peers.length + 2; round += 1)
    for (const from of peers)
      for (const to of peers) if (from !== to) await deliver(from, to, size);
};

interface Op {
  readonly by: number;
  readonly at: number;
  readonly row: number;
  readonly title: string;
  readonly remove: boolean;
}

describe("convergence with policies on, and the pages cut at random", () => {
  test(
    "the same legitimate writes converge whatever the page size, with nothing refused",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 5 }),
          fc.integer({ min: 1, max: 6 }),
          fc.array(
            fc.record({
              by: fc.nat({ max: 4 }),
              at: fc.integer({ min: 100, max: 900 }),
              row: fc.nat({ max: 4 }),
              title: fc.constantFrom("one", "two", "three"),
              remove: fc.boolean(),
            }),
            { minLength: 1, maxLength: 30 },
          ),
          async (size, page, ops: readonly Op[]) => {
            const peers = Array.from({ length: size }, (_, i) => peer(i));
            // each row has one owner for the whole run, fixed by its number rather than by who got
            // there first: two peers taking turns at one row is a real refusal, not a lost write,
            // and mixing that in would test the schedule rather than the engine
            const owner = new Map<string, number>();
            const ownerOf = (rowId: number) => rowId % size;

            for (const op of ops) {
              const who = peers[ownerOf(op.row)];
              if (who === undefined) continue;
              const id = `n${String(op.row)}`;
              const held = owner.get(id);
              who.clock.set(op.at);
              if (held === undefined) {
                owner.set(id, who.index);
                (
                  await who.engine.mutate(
                    CREATE,
                    (tx) =>
                      tx.insert(
                        NOTE,
                        key(id),
                        row({ id, title: op.title, body: "b", ownerId: who.account }),
                      ),
                    { partition: ACME },
                  )
                ).unwrap();
              } else if (op.remove) {
                owner.delete(id);
                (
                  await who.engine.mutate(CREATE, (tx) => tx.delete(NOTE, key(id)), {
                    partition: ACME,
                  })
                ).unwrap();
              } else {
                (
                  await who.engine.mutate(
                    CREATE,
                    (tx) => tx.update(NOTE, key(id), row({ title: op.title })),
                    { partition: ACME },
                  )
                ).unwrap();
              }
            }

            await settle(peers, page);

            // nothing a peer was entitled to write may be sitting refused on another
            for (const p of peers) expect(p.engine.quarantine()).toEqual([]);

            // and every peer holds the same thing, cell for cell
            const first = peers[0];
            if (first === undefined) return;
            for (const id of ["n0", "n1", "n2", "n3", "n4"]) {
              const expected = readRow(first.engine.state(), NOTE, key(id));
              for (const p of peers) {
                const held = readRow(p.engine.state(), NOTE, key(id));
                expect(held?.get(column("title"))).toEqual(expected?.get(column("title")));
                expect(held?.get(column("ownerId"))).toEqual(expected?.get(column("ownerId")));
              }
            }
          },
        ),
        { numRuns: 400 },
      );
    },
    { timeout: 120_000 },
  );
});
