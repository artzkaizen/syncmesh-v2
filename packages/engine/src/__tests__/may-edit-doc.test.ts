import type { PeerId } from "@syncmesh/kernel";
import type { Grant } from "@syncmesh/wire";

import { parseAdapterId, parsePartitionKey, parsePeerId } from "@syncmesh/kernel";
import { ladder, partition, syncSchema, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant, verifyGrant } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { createEngine } from "../engine.js";
import { createMemoryEventStore } from "../store.js";
import { createValidator } from "../validate.js";
import { CREATE, N1, NOTES, PEER_A, PEER_B, PEER_C, column, fakeClock, row } from "./fixtures.js";

/*
 * `engine.mayEditDoc` (RFC-0023 §11, gaps U26): who may set what a document's row derives, asked
 * the way the fold asks it of a doc change — the row's `update` rule, the author's grant and its
 * partitions — with the authority always allowed.
 */

const PEER_D = parsePeerId("d".repeat(64)).unwrap();
const W1 = parsePartitionKey("workspace:w1").unwrap();
const CONTENT = column("content");
const LORO = parseAdapterId("loro@1").unwrap();
const DOCS = new Map([[NOTES, new Map([[CONTENT, LORO]])]]);
const DOC = { table: NOTES, key: N1, column: CONTENT };

const schema = syncSchema({
  tables: {
    notes: {
      columns: {
        id: t.text().primaryKey(),
        title: t.text(),
        content: t.blob({ merge: { id: "loro@1" } }).nullable(),
      },
      partition: partition("workspace", { roles: ladder("editor", "viewer") }),
      allow: ({ role }) => ({ $default: role("viewer"), update: role("editor") }),
    },
  },
});

const ISSUER = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 50 + i)).unwrap();
const NOW = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const roles = new Map<PeerId, string>([
  [PEER_A, "editor"],
  [PEER_B, "viewer"],
]);
const grantFor = (device: PeerId): Grant | undefined => {
  const role = roles.get(device);
  if (role === undefined) return undefined;
  return verifyGrant(
    issueGrant(ISSUER, {
      account: `acct_${role}`,
      device,
      role,
      partitions: [W1],
      validFor: Temporal.Duration.from({ hours: 1 }),
      now: NOW,
    }),
    ISSUER.peerId,
    NOW,
  ).unwrap();
};

const peer = (peerId: PeerId) =>
  createEngine({
    peerId,
    clock: fakeClock(NOW.epochMilliseconds),
    store: createMemoryEventStore(),
    validate: createValidator({ schema, grantFor, authority: PEER_C, docs: DOCS }),
    docs: DOCS,
  });

describe("engine.mayEditDoc", () => {
  test("answers as the fold judges a doc change: the update rule, the grant, the authority", async () => {
    const editor = peer(PEER_A);
    const host = peer(PEER_D);
    const insert = await editor.mutate(
      CREATE,
      (tx) => tx.insert(NOTES, N1, row({ id: "n1", title: "t" })),
      {
        partition: W1,
      },
    );
    (await host.receive({ event: insert.unwrap() })).unwrap();

    expect(host.mayEditDoc(PEER_A, DOC).isOk()).toBe(true);
    // a viewer reads the row and could sign a checkpoint of it, but may not edit it
    const viewer = host.mayEditDoc(PEER_B, DOC);
    expect(viewer.isErr() && viewer.error._tag).toBe("PolicyDenied");
    // the authority needs no grant here
    expect(host.mayEditDoc(PEER_C, DOC).isOk()).toBe(true);
    const stranger = host.mayEditDoc(PEER_D, DOC);
    expect(stranger.isErr() && stranger.error._tag).toBe("NoGrant");
    const notADoc = host.mayEditDoc(PEER_A, { ...DOC, column: column("title") });
    expect(notADoc.isErr() && notADoc.error._tag).toBe("DocChangeRefused");
  });

  test("a row this device does not hold has no partition to judge an edit in", () => {
    const host = peer(PEER_D);
    const unheld = host.mayEditDoc(PEER_A, DOC);
    expect(unheld.isErr() && unheld.error._tag).toBe("WrongPartition");
  });

  test("an engine that validates nothing folds anyone's doc change, so anyone may", () => {
    const open = createEngine({
      peerId: PEER_D,
      clock: fakeClock(NOW.epochMilliseconds),
      store: createMemoryEventStore(),
      docs: DOCS,
    });
    expect(open.mayEditDoc(PEER_B, DOC).isOk()).toBe(true);
  });
});
