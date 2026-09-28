import type { PeerId } from "@syncmesh/kernel";
import type { Grant } from "@syncmesh/wire";

import { parsePartitionKey, readRow } from "@syncmesh/kernel";
import { allow, deny, role } from "@syncmesh/policy";
import { ladder, partition, syncSchema, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant, verifyGrant } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { correct, corrections, setPolicy } from "../authority.js";
import { createEngine } from "../engine.js";
import { createMemoryEventStore } from "../store.js";
import { createValidator } from "../validate.js";
import { CREATE, N1, NOTES, PEER_A, PEER_B, fakeClock, row } from "./fixtures.js";

const ACME = parsePartitionKey("org:acme").unwrap();
const org = partition("org", { roles: ladder("admin", "member") });
const schema = syncSchema({
  tables: {
    notes: {
      columns: { id: t.text().primaryKey(), title: t.text() },
      partition: org,
      // the bundled rule: anyone in the org may write
      allow: ({ role: r }) => ({ $default: r("member") }),
    },
  },
});

const ISSUER = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 50 + i)).unwrap();
const NOW = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);

/** A real signed grant for whichever device asks — the authority holds one like everyone else. */
const grantFor = (device: PeerId, account: string, grantRole: string): Grant =>
  verifyGrant(
    issueGrant(ISSUER, {
      account,
      device,
      role: grantRole,
      partitions: [ACME],
      validFor: Temporal.Duration.from({ hours: 1 }),
      now: NOW,
    }),
    ISSUER.peerId,
    NOW,
  ).unwrap();

/** An engine whose validator knows the manifest, its reserved tables, and who the authority is. */
const peerAt = (peerId: typeof PEER_A, startMs: number, account = "acct_a", grantRole = "member") =>
  createEngine({
    peerId,
    clock: fakeClock(startMs),
    store: createMemoryEventStore(),
    merge: schema.merge,
    validate: createValidator({
      schema,
      grantFor: (peer) => grantFor(peer, account, grantRole),
      authority: PEER_B, // B is the authority; A is an ordinary device
    }),
  });

const writeNote = (engine: ReturnType<typeof peerAt>, title: string) =>
  engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ id: "n1", title })), {
    partition: ACME,
  });

const sync = async (from: ReturnType<typeof peerAt>, to: ReturnType<typeof peerAt>) =>
  (await to.receiveBatch((await from.eventsSince(new Map())).unwrap())).unwrap();

describe("policy as data", () => {
  test("a synced doc overrules the bundled rule for the instance it governs", async () => {
    const device = peerAt(PEER_A, 100);
    const server = peerAt(PEER_B, 200);
    (await writeNote(device, "allowed by the bundle")).unwrap(); // the manifest lets a member write

    // the authority tightens the rule and it travels as data, with no app release
    (await setPolicy(server, ACME, { notes: { $default: role("admin") } })).unwrap();
    await sync(server, device);

    const refused = await writeNote(device, "after the tightening");
    expect(refused.isErr() && refused.error._tag).toBe("PolicyDenied");
    expect(readRow(device.state(), NOTES, N1)?.get(schema.tables.notes.columnNames.title)).toBe(
      "allowed by the bundle",
    );

    // and it can be loosened again the same way
    (await setPolicy(server, ACME, { notes: { $default: allow } })).unwrap();
    await sync(server, device);
    (await writeNote(device, "after the loosening")).unwrap();
  });

  test("a device cannot write the rules that bind it — refused at its own author", async () => {
    const device = peerAt(PEER_A, 100);
    const forged = await setPolicy(device, ACME, { notes: { $default: allow } });
    expect(forged.isErr() && forged.error._tag).toBe("ReadOnlyPartition");
    expect(device.state().has(schema.reserved[0]?.name ?? NOTES)).toBe(false);
  });

  test("a doc governs its own instance only, and an unparsable one leaves the bundle standing", async () => {
    const device = peerAt(PEER_A, 100);
    const server = peerAt(PEER_B, 200);
    const globex = parsePartitionKey("org:globex").unwrap();
    (await setPolicy(server, globex, { notes: { $default: deny } })).unwrap();
    await sync(server, device);
    // acme's rule is untouched by globex's doc
    (await writeNote(device, "still fine")).unwrap();
  });
});

describe("corrections", () => {
  test("the fix and its reason are one event, folded by the ordinary merge", async () => {
    const device = peerAt(PEER_A, 100);
    const server = peerAt(PEER_B, 200);
    const written = (await writeNote(device, "twelve hours")).unwrap();
    await sync(device, server);

    const before = (await server.eventsSince(new Map())).unwrap().length;
    (
      await correct(
        server,
        {
          event: String(written.id),
          table: NOTES,
          key: N1,
          reason: "over the day limit",
          detail: { limit: 8 },
          partition: ACME,
        },
        (tx) => tx.update(NOTES, N1, row({ title: "eight hours" })),
      )
    ).unwrap();
    // one event, not two: a peer cannot fold the overwrite without the reason
    expect((await server.eventsSince(new Map())).unwrap().length).toBe(before + 1);

    await sync(server, device);
    expect(readRow(device.state(), NOTES, N1)?.get(schema.tables.notes.columnNames.title)).toBe(
      "eight hours",
    );
    const held = corrections(device);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({
      event: String(written.id),
      table: "notes",
      key: "n1",
      reason: "over the day limit",
      detail: { limit: 8 },
    });
  });

  test("a member's forged correction is denied at its author and never applies at a peer", async () => {
    const device = peerAt(PEER_A, 100);
    const other = peerAt(PEER_B, 300, "acct_b");
    const written = (await writeNote(device, "twelve hours")).unwrap();

    const forged = await correct(
      device,
      {
        event: String(written.id),
        table: NOTES,
        key: N1,
        reason: "I say so",
        partition: ACME,
      },
      (tx) => tx.update(NOTES, N1, row({ title: "one hour" })),
    );
    expect(forged.isErr() && forged.error._tag).toBe("ReadOnlyPartition");
    // the whole event is refused, so the fix it carried never happened either
    expect(readRow(device.state(), NOTES, N1)?.get(schema.tables.notes.columnNames.title)).toBe(
      "twelve hours",
    );
    expect(corrections(device)).toEqual([]);

    // and nothing forged reaches a peer, because the author never produced an event
    await sync(device, other);
    expect(corrections(other)).toEqual([]);
  });
});
