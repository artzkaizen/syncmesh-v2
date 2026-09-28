import type { PeerId } from "@syncmesh/kernel";
import type { Grant } from "@syncmesh/wire";

import { parsePartitionKey, readRow } from "@syncmesh/kernel";
import { allow, deny, role } from "@syncmesh/policy";
import { ladder, partition, syncSchema, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant, verifyGrant } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { setPolicy } from "../authority.js";
import { can } from "../can.js";
import { createEngine } from "../engine.js";
import { createMemoryEventStore } from "../store.js";
import { createValidator } from "../validate.js";
import { CREATE, N1, NOTES, PEER_A, PEER_B, fakeClock, procedure, row } from "./fixtures.js";

const ACME = parsePartitionKey("org:acme").unwrap();
const UPDATE = procedure("notes.update");
const DELETE = procedure("notes.delete");

const org = partition("org", { roles: ladder("admin", "member") });
const schema = syncSchema({
  tables: {
    notes: {
      columns: { id: t.text().primaryKey(), title: t.text() },
      partition: org,
      // the bundle: a member writes and edits, and only an admin deletes
      allow: ({ role: r }) => ({ $default: r("member"), delete: r("admin") }),
    },
  },
});

const ISSUER = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 50 + i)).unwrap();
const NOW = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);

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

const MEMBER = grantFor(PEER_A, "acct_a", "member");

/** What the device would ask on a screen: its own grant, its own rows, the instance in hand. */
const asks = (device: ReturnType<typeof peerAt>, what: `${string}.${string}`) =>
  can(schema, MEMBER, what, undefined, undefined, {
    partition: ACME,
    rows: (table, key) => readRow(device.state(), table, key),
  });

const sync = async (from: ReturnType<typeof peerAt>, to: ReturnType<typeof peerAt>) =>
  (await to.receiveBatch((await from.eventsSince(new Map())).unwrap())).unwrap();

describe("can, against a synced policy doc", () => {
  test("the button and the write agree in both directions once a doc lands", async () => {
    const device = peerAt(PEER_A, 100);
    const server = peerAt(PEER_B, 200);
    (
      await device.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ id: "n1", title: "first" })), {
        partition: ACME,
      })
    ).unwrap();

    // the bundle: a member edits, a member does not delete — and the writes say the same
    expect(asks(device, "notes.update")).toBe(true);
    expect(asks(device, "notes.delete")).toBe(false);
    (
      await device.mutate(UPDATE, (tx) => tx.update(NOTES, N1, row({ title: "edited" })), {
        partition: ACME,
      })
    ).unwrap();
    const refused = await device.mutate(DELETE, (tx) => tx.delete(NOTES, N1), { partition: ACME });
    expect(refused.isErr() && refused.error._tag).toBe("PolicyDenied");

    // the authority publishes the opposite rule, and it travels as data
    (await setPolicy(server, ACME, { notes: { $default: deny, delete: allow } })).unwrap();
    await sync(server, device);

    // newly denied: the answer flips before the write does, not after it fails
    expect(asks(device, "notes.update")).toBe(false);
    const denied = await device.mutate(
      UPDATE,
      (tx) => tx.update(NOTES, N1, row({ title: "after the doc" })),
      { partition: ACME },
    );
    expect(denied.isErr() && denied.error._tag).toBe("PolicyDenied");
    expect(readRow(device.state(), NOTES, N1)?.get(schema.tables.notes.columnNames.title)).toBe(
      "edited",
    );

    // newly permitted: the button lights up, and the write it offers lands
    expect(asks(device, "notes.delete")).toBe(true);
    (await device.mutate(DELETE, (tx) => tx.delete(NOTES, N1), { partition: ACME })).unwrap();
    expect(readRow(device.state(), NOTES, N1)).toBeUndefined();
  });

  test("a doc for another instance leaves this one's answers alone", async () => {
    const device = peerAt(PEER_A, 100);
    const server = peerAt(PEER_B, 200);
    const globex = parsePartitionKey("org:globex").unwrap();
    (await setPolicy(server, globex, { notes: { $default: deny } })).unwrap();
    await sync(server, device);
    expect(asks(device, "notes.update")).toBe(true);
  });

  test("asked with no instance, it answers from the bundle — the doc it cannot look up", async () => {
    const device = peerAt(PEER_A, 100);
    const server = peerAt(PEER_B, 200);
    (await setPolicy(server, ACME, { notes: { $default: role("admin") } })).unwrap();
    await sync(server, device);
    expect(asks(device, "notes.update")).toBe(false);
    // no partition, no `_policy` row to prefer: the manifest stands, as documented
    expect(can(schema, MEMBER, "notes.update")).toBe(true);
  });
});
