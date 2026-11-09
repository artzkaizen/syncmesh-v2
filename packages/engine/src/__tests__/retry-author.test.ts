import type { PeerId } from "@syncmesh/kernel";
import type { Grant } from "@syncmesh/wire";

import { parsePartitionKey, readRow } from "@syncmesh/kernel";
import { ladder, partition, syncSchema, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant, verifyGrant } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { createEngine } from "../engine.js";
import { createMemoryEventStore } from "../store.js";
import { createValidator } from "../validate.js";
import { CREATE, NOTES, PEER_A, PEER_B, fakeClock, key, row } from "./fixtures.js";

/**
 * An event that arrives before its author's grant (gaps U42). Over two relay instances, or a relay
 * and a radio, grants and events travel separately and either can land first; a grant registering
 * is new state that no fold announces, so `retryAuthor` is what offers the parked event again.
 */

const ACME = parsePartitionKey("org:acme").unwrap();
const org = partition("org", { roles: ladder("member") });
const schema = syncSchema({
  tables: {
    notes: {
      columns: { id: t.text().primaryKey(), title: t.text() },
      partition: org,
      allow: ({ role }) => ({ $default: role("member") }),
    },
  },
});

const ISSUER = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 50 + i)).unwrap();
const NOW = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);

const grant = (device: PeerId): Grant =>
  verifyGrant(
    issueGrant(ISSUER, {
      account: "acct_a",
      device,
      role: "member",
      partitions: [ACME],
      validFor: Temporal.Duration.from({ hours: 1 }),
      now: NOW,
    }),
    ISSUER.peerId,
    NOW,
  ).unwrap();

/** A peer that knows only the grants in `held`, as a device does before they reach it. */
const peer = (peerId: PeerId, held: Map<PeerId, Grant>) =>
  createEngine({
    peerId,
    clock: fakeClock(NOW.epochMilliseconds),
    store: createMemoryEventStore(),
    merge: schema.merge,
    validate: createValidator({ schema, grantFor: (device) => held.get(device) }),
  });

const note =
  (id: string) => (tx: Parameters<Parameters<ReturnType<typeof peer>["mutate"]>[1]>[0]) =>
    tx.insert(NOTES, key(id), row({ id, title: id }));

describe("an event that arrives before its author's grant", () => {
  test("is parked NoGrant, and folds once the grant registers and the author is retried", async () => {
    const theirs = new Map([[PEER_B, grant(PEER_B)]]);
    const author = peer(PEER_B, theirs);
    const written = (await author.mutate(CREATE, note("n1"), { partition: ACME })).unwrap();

    const held = new Map<PeerId, Grant>();
    const reader = peer(PEER_A, held);
    expect((await reader.receiveBatch([{ event: written }])).unwrap()).toEqual({
      folded: 0,
      skipped: 0,
      quarantined: 1,
    });
    expect(reader.quarantine().map((p) => p.verdict._tag)).toEqual(["NoGrant"]);

    // the grant lands second, on its own: nothing folds, so nothing else would look again
    held.set(PEER_B, grant(PEER_B));
    const retried = (await reader.retryAuthor(PEER_B)).unwrap();
    expect(retried.folded).toBe(1);
    expect(reader.quarantine()).toEqual([]);
    expect(readRow(reader.state(), NOTES, key("n1"))).toBeDefined();
  });

  test("re-offers that author's events, and leaves another author's parked for its own grant", async () => {
    const PEER_C = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 90 + i)).unwrap()
      .peerId;
    const authors = new Map([
      [PEER_B, grant(PEER_B)],
      [PEER_C, grant(PEER_C)],
    ]);
    const fromB = (
      await peer(PEER_B, authors).mutate(CREATE, note("b1"), { partition: ACME })
    ).unwrap();
    const fromC = (
      await peer(PEER_C, authors).mutate(CREATE, note("c1"), { partition: ACME })
    ).unwrap();

    const held = new Map<PeerId, Grant>();
    const reader = peer(PEER_A, held);
    await reader.receiveBatch([{ event: fromB }, { event: fromC }]);
    expect(reader.quarantine()).toHaveLength(2);

    // B's grant lands; C's has not, and its event waits for it
    held.set(PEER_B, grant(PEER_B));
    expect((await reader.retryAuthor(PEER_B)).unwrap().folded).toBe(1);
    expect(reader.quarantine().map((p) => [p.entry.event.peerId, p.verdict._tag])).toEqual([
      [PEER_C, "NoGrant"],
    ]);
    expect(readRow(reader.state(), NOTES, key("c1"))).toBeUndefined();
  });
});
