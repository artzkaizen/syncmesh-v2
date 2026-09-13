import type { PeerId, RowKey, TableName } from "@syncmesh/kernel";

import { parseAccountId, parsePartitionKey, parsePeerId, readRow } from "@syncmesh/kernel";
import { syncSchema, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import {
  splitEnvelope,
  createIdentity,
  encodeAccountCore,
  encodeCbor,
  issueGrant,
  signLink,
  verifyGrant,
} from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import type { Engine } from "../engine.js";

import { disputes, linkDevice, linkKey, linkedAuthor, links, unlinkDevice } from "../accounts.js";
import { createEngine } from "../engine.js";
import { LinkRefused } from "../errors.js";
import { createMemoryEventStore } from "../store.js";
import { createValidator } from "../validate.js";
import {
  NOTES,
  PEER_A,
  PEER_B,
  column,
  fakeClock,
  key,
  procedure,
  row,
  table,
} from "./fixtures.js";

const PEER_C = parsePeerId("c".repeat(64)).unwrap();

const ACME = parsePartitionKey("org:acme").unwrap();
const GLOBEX = parsePartitionKey("org:globex").unwrap();

const LINKS = table("_links");
const WRITE = procedure("notes.create");

/** The account that vouches, and a second key that will try to speak for it. */
const ACCOUNT = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 10 + i)).unwrap();
const IMPOSTOR = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 90 + i)).unwrap();
const ACCOUNT_ID = parseAccountId(String(ACCOUNT.peerId)).unwrap();
const IMPOSTOR_ID = parseAccountId(String(IMPOSTOR.peerId)).unwrap();
const ISSUER = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 50 + i)).unwrap();

const NOW = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const LATER = NOW.add({ minutes: 1 });

const schema = syncSchema({
  partitions: { org: {} },
  tables: {
    notes: {
      columns: { id: t.text().primaryKey(), title: t.text() },
      partition: "org",
      // nothing here is about policy: these tests are the rungs a `_links` row answers to
      allow: (c) => ({ $default: c.allow }),
    },
  },
});

/** A peer with the ordinary ungranted validator; `forger` gets none, so it can author anything. */
const peer = (peerId: PeerId, forger = false) => {
  const base = {
    peerId,
    clock: fakeClock(NOW.epochMilliseconds),
    store: createMemoryEventStore(),
    merge: schema.merge,
  };
  const validate = createValidator({ schema, grantFor: null, accounts: true });
  return { engine: forger ? createEngine(base) : createEngine({ ...base, validate }) };
};

type Side = ReturnType<typeof peer>;

const sync = async (from: Side, to: Side) =>
  (await to.engine.receiveBatch((await from.engine.eventsSince(new Map())).unwrap())).unwrap();

/** The verdict as a test reads it: the rung a link failed, or the tag of anything else. */
const verdict = (result: { isErr: () => boolean; error?: { _tag: string } }) => {
  if (!result.isErr()) return "ok";
  const error = result.error;
  return error instanceof LinkRefused ? error.rung : (error?._tag ?? "?");
};

/** A `_links` row as the columns hold it, so a test can file bytes the writer never would. */
/** The key a row carries is its own core's digest, so a fixture states the bytes and derives it. */
const rowKeyFor = (device: PeerId, partition: string, wire: Uint8Array) =>
  linkKey(parsePartitionKey(partition).unwrap(), device, splitEnvelope(wire).unwrap().core);

const linkRow = (device: PeerId, partition: string, at: Temporal.Instant, wire: Uint8Array) =>
  row({
    id: String(rowKeyFor(device, partition, wire)),
    account: String(ACCOUNT_ID),
    kind: 0,
    at: at.epochMilliseconds,
    wire,
  });

const signedFor = (device: PeerId, partition = ACME, at = NOW) =>
  signLink(ACCOUNT, { v: 1, op: "link", account: ACCOUNT_ID, device, partition, at });

/** The state a validator would be handed for these rows — `records` is what resolves a link. */
const lookupOf = (engine: Engine) => ({
  row: (table: TableName, key: RowKey) => readRow(engine.state(), table, key),
  partition: () => undefined,
  // read live, not captured: a test that installs a second snapshot must see it
  records: (table: TableName) => engine.state().get(table),
});

describe("the rungs a link answers to", () => {
  test("a device may claim only itself: a link naming another device is refused at its own engine", async () => {
    const device = peer(PEER_A);
    const forged = await linkDevice(device.engine, {
      account: ACCOUNT,
      device: PEER_B,
      partition: ACME,
      at: NOW,
    });
    expect(verdict(forged)).toBe("author");
  });

  test("and again at every peer that receives it: the forger's own engine is not the check", async () => {
    const forger = peer(PEER_A, true);
    (
      await linkDevice(forger.engine, {
        account: ACCOUNT,
        device: PEER_B,
        partition: ACME,
        at: NOW,
      })
    ).unwrap();

    const receiver = peer(PEER_C);
    const quarantined: string[] = [];
    receiver.engine.onQuarantine(({ reason }) => void quarantined.push(reason._tag));
    await receiver.engine.receiveBatch((await forger.engine.eventsSince(new Map())).unwrap());

    expect(quarantined).toEqual(["LinkRefused"]);
    expect(links(receiver.engine)).toEqual([]);
  });

  test("a device claiming itself is admitted, and reads back as a live link", async () => {
    const device = peer(PEER_A);
    (
      await linkDevice(device.engine, {
        account: ACCOUNT,
        device: PEER_A,
        partition: ACME,
        at: NOW,
      })
    ).unwrap();
    expect(links(device.engine)).toEqual([
      {
        account: String(ACCOUNT_ID),
        device: String(PEER_A),
        partition: "org:acme",
        at: NOW,
        linked: true,
      },
    ]);
  });

  test("an unlink relayed by an unrelated courier is admitted: a stolen device will not unlink itself", async () => {
    const device = peer(PEER_A);
    (
      await linkDevice(device.engine, {
        account: ACCOUNT,
        device: PEER_A,
        partition: ACME,
        at: NOW,
      })
    ).unwrap();
    const courier = peer(PEER_C);
    await sync(device, courier);

    // the courier is nobody: not the account's device, not an authority, not the subject
    (
      await unlinkDevice(courier.engine, {
        account: ACCOUNT,
        device: PEER_A,
        partition: ACME,
        at: LATER,
      })
    ).unwrap();
    expect(links(courier.engine).map((l) => l.linked)).toEqual([false]);

    // and the device itself folds it, because it is an ordinary row and nothing more
    await sync(courier, device);
    expect(links(device.engine).map((l) => l.linked)).toEqual([false]);
  });

  test("a link bundled with an ordinary change is refused: alone, or it takes that write down", async () => {
    const device = peer(PEER_A);
    const bundled = await device.engine.mutate(
      WRITE,
      (tx) => {
        tx.insert(NOTES, key("n1"), row({ id: "n1", title: "n1" }));
        const wire = signedFor(PEER_A);
        tx.insert(
          LINKS,
          rowKeyFor(PEER_A, "org:acme", wire),
          linkRow(PEER_A, "org:acme", NOW, wire),
        );
      },
      { partition: ACME },
    );
    // an un-upgraded peer would quarantine the whole event as UnknownTable, note included
    expect(verdict(bundled)).toBe("isolation");
  });

  test("every fact is admitted, and the latest one stands: an older link changes nothing", async () => {
    const device = peer(PEER_A);
    const first = { account: ACCOUNT, device: PEER_A, partition: ACME, at: LATER };
    (await linkDevice(device.engine, first)).unwrap();

    // an older link is not refused — it is filed under its own digest and simply loses. Refusing
    // it would make admission depend on what this peer had folded, which is where two peers
    // start disagreeing and never stop
    expect(verdict(await linkDevice(device.engine, { ...first, at: NOW }))).toBe("ok");
    expect(links(device.engine).map((l) => l.at)).toEqual([LATER]);

    // and the same core twice writes the same row twice, which is no write at all
    (await linkDevice(device.engine, first)).unwrap();
    expect(device.engine.state().get(LINKS)?.size).toBe(2);
  });

  test("a link signed for one instance is refused when replayed into another", async () => {
    const device = peer(PEER_A);
    const replay = await device.engine.mutate(
      WRITE,
      (tx) =>
        // the very bytes the account signed for org:acme, filed and written in org:globex
        tx.insert(
          LINKS,
          rowKeyFor(PEER_A, "org:globex", signedFor(PEER_A, ACME)),
          linkRow(PEER_A, "org:globex", NOW, signedFor(PEER_A, ACME)),
        ),
      { partition: GLOBEX },
    );
    expect(verdict(replay)).toBe("columns");
  });

  test("a row filed under an instance the event is not writing to is refused on shape", async () => {
    const device = peer(PEER_A);
    const misfiled = await device.engine.mutate(
      WRITE,
      (tx) =>
        tx.insert(
          LINKS,
          key(`org:acme:${String(PEER_A)}`),
          linkRow(PEER_A, "org:acme", NOW, signedFor(PEER_A)),
        ),
      { partition: GLOBEX },
    );
    expect(verdict(misfiled)).toBe("key");
  });

  test("a well-formed core carrying another key's signature is refused", async () => {
    const device = peer(PEER_A);
    const core = encodeAccountCore({
      v: 1,
      op: "link",
      account: ACCOUNT_ID,
      device: PEER_A,
      partition: ACME,
      at: NOW,
    });
    // every column says exactly what the core says; only the signature is somebody else's
    const wire = encodeCbor([core, IMPOSTOR.sign(core)]);
    const forged = await device.engine.mutate(
      WRITE,
      (tx) =>
        tx.insert(
          LINKS,
          rowKeyFor(PEER_A, "org:acme", wire),
          linkRow(PEER_A, "org:acme", NOW, wire),
        ),
      { partition: ACME },
    );
    expect(verdict(forged)).toBe("signature");
  });

  test("a link ends with an unlink, never with a delete: nothing would say who ended it", async () => {
    const device = peer(PEER_A);
    (
      await linkDevice(device.engine, {
        account: ACCOUNT,
        device: PEER_A,
        partition: ACME,
        at: NOW,
      })
    ).unwrap();
    const removed = await device.engine.mutate(
      WRITE,
      (tx) => tx.delete(LINKS, rowKeyFor(PEER_A, "org:acme", signedFor(PEER_A))),
      { partition: ACME },
    );
    expect(verdict(removed)).toBe("columns");
    expect(links(device.engine).map((l) => l.linked)).toEqual([true]);
  });

  test("a snapshot cannot launder a binding in: the row's own bytes are checked before it names anybody", async () => {
    const forger = peer(PEER_A, true);
    const core = encodeAccountCore({
      v: 1,
      op: "link",
      account: ACCOUNT_ID,
      device: PEER_A,
      partition: ACME,
      at: NOW,
    });
    (
      await forger.engine.mutate(
        WRITE,
        (tx) =>
          tx.insert(
            LINKS,
            rowKeyFor(PEER_A, "org:acme", encodeCbor([core, IMPOSTOR.sign(core)])),
            linkRow(PEER_A, "org:acme", NOW, encodeCbor([core, IMPOSTOR.sign(core)])),
          ),
        { partition: ACME },
      )
    ).unwrap();

    // a snapshot install merges rows; no validator ever judges them, which is why the resolver
    // may not take a `_links` row at its word however it arrived
    const receiver = peer(PEER_C);
    await receiver.engine.installSnapshot(forger.engine.snapshot());
    // it is in state — a snapshot merges rows and asks nobody — and it is not a link, because
    // the reader resolves the same way the validator does rather than reading the columns
    expect(receiver.engine.state().get(LINKS)?.size).toBe(1);
    expect(links(receiver.engine)).toEqual([]);

    const held = lookupOf(receiver.engine);
    const probe = { peerId: PEER_A, partition: ACME, changes: [] };
    expect(linkedAuthor(probe, held)).toBeUndefined();

    // the same install with the account's own signature does name it
    const honest = peer(PEER_B);
    (
      await linkDevice(honest.engine, {
        account: ACCOUNT,
        device: PEER_B,
        partition: ACME,
        at: NOW,
      })
    ).unwrap();
    await receiver.engine.installSnapshot(honest.engine.snapshot());
    expect(linkedAuthor({ peerId: PEER_B, partition: ACME, changes: [] }, held)?.account).toBe(
      String(ACCOUNT_ID),
    );
  });

  test("the verify memo answers for bytes, never for a row: the same blob at a second key is judged again", async () => {
    const device = peer(PEER_A);
    (
      await linkDevice(device.engine, {
        account: ACCOUNT,
        device: PEER_A,
        partition: ACME,
        at: NOW,
      })
    ).unwrap();
    const held = lookupOf(device.engine);
    // the row is filed under its own core's digest now, so it is found by the device it names
    const rows = [...(held.records(LINKS) ?? [])].filter(([k]) =>
      String(k).includes(String(PEER_A)),
    );
    const wire = rows[0]?.[1].cells.get(column("wire"))?.value;
    if (!(wire instanceof Uint8Array)) throw new Error("the link row must carry its own bytes");

    // the very same `Uint8Array` object, filed under another device and saying `unlink`. The
    // signature over it is real, so a memo keyed on the blob alone would hand back the first
    // row's verdict without ever comparing these columns to that core
    // filed under the digest of those very bytes, so the key rung has nothing to object to and
    // the columns are the only thing left standing between this row and a principal
    const stolenKey = rowKeyFor(PEER_B, "org:acme", wire);
    const stolen = await device.engine.mutate(
      WRITE,
      (tx) =>
        tx.insert(
          LINKS,
          stolenKey,
          row({
            id: String(stolenKey),
            account: String(ACCOUNT_ID),
            kind: 1,
            at: NOW.epochMilliseconds,
            wire,
          }),
        ),
      { partition: ACME },
    );
    expect(verdict(stolen)).toBe("columns");
    expect(linkedAuthor({ peerId: PEER_B, partition: ACME, changes: [] }, held)).toBeUndefined();
  });

  test("a link a grant contradicts is reported, never resolved", async () => {
    const device = peer(PEER_A);
    (
      await linkDevice(device.engine, {
        account: ACCOUNT,
        device: PEER_A,
        partition: ACME,
        at: NOW,
      })
    ).unwrap();
    const granting = (account: string) => (held: PeerId) =>
      held === PEER_A
        ? verifyGrant(
            issueGrant(ISSUER, {
              account,
              device: PEER_A,
              partitions: [ACME],
              validFor: Temporal.Duration.from({ hours: 1 }),
              now: NOW,
            }),
            ISSUER.peerId,
            NOW,
          ).unwrap()
        : undefined;

    // an `acct_a` grant is not in the 64-hex namespace a link claims, so the two are not making
    // the same claim at all — which is why no mesh running today can produce a dispute
    expect(disputes(device.engine, granting("acct_a"))).toEqual([]);
    expect(disputes(device.engine, granting(String(ACCOUNT_ID)))).toEqual([]);
    expect(disputes(device.engine, granting(String(IMPOSTOR_ID)))).toEqual([
      {
        device: String(PEER_A),
        partition: "org:acme",
        linked: String(ACCOUNT_ID),
        granted: String(IMPOSTOR_ID),
      },
    ]);
  });

  test("a link travels as one ordinary signed event in the instance it holds in", async () => {
    const device = peer(PEER_A);
    const event = (
      await linkDevice(device.engine, {
        account: ACCOUNT,
        device: PEER_A,
        partition: ACME,
        at: NOW,
      })
    ).unwrap();
    expect(String(event.partition)).toBe("org:acme");
    expect(event.changes).toHaveLength(1);
    expect(event.local).toBeUndefined();
  });
});

describe("two peers, two facts, one answer", () => {
  /**
   * The bug this table's shape exists to make impossible. A link and a backdated unlink are two
   * facts about one pair, and clock skew between two of one person's own devices is enough to
   * produce them: the unlink is signed for an earlier instant than the link it ends.
   *
   * Filed under one key they would settle by HLC stamp while admission was ordered by the signed
   * `at` — two independent orderings, so the peer that folded the link first would stay linked
   * and the peer that folded the unlink first would not, for good. Filed under their own digests
   * they are two rows, both admitted, and the answer is a fold over the set rather than a race.
   */
  const facts = async (order: "link-first" | "unlink-first") => {
    const author = peer(PEER_A);
    (
      await linkDevice(author.engine, {
        account: ACCOUNT,
        device: PEER_A,
        partition: ACME,
        at: LATER,
      })
    ).unwrap();
    const courier = peer(PEER_C);
    (
      await unlinkDevice(courier.engine, {
        account: ACCOUNT,
        device: PEER_A,
        partition: ACME,
        at: NOW, // backdated: signed for an instant before the link it ends
      })
    ).unwrap();

    const receiver = peer(PEER_B);
    const from = order === "link-first" ? [author, courier] : [courier, author];
    for (const side of from) await sync(side, receiver);
    return receiver;
  };

  test("the fold order does not decide it: both orders reach the same verdict", async () => {
    const first = await facts("link-first");
    const second = await facts("unlink-first");

    // both hold both facts, and both resolve to the later one — the link
    expect(first.engine.state().get(LINKS)?.size).toBe(2);
    expect(second.engine.state().get(LINKS)?.size).toBe(2);
    expect(links(first.engine).map((l) => l.linked)).toEqual([true]);
    expect(links(second.engine).map((l) => l.linked)).toEqual([true]);
    const probe = { peerId: PEER_A, partition: ACME, changes: [] };
    expect(linkedAuthor(probe, lookupOf(first.engine))?.account).toBe(
      linkedAuthor(probe, lookupOf(second.engine))?.account,
    );
  });

  test("an unlink that really is later ends the link, whichever order it arrives in", async () => {
    for (const order of ["link-first", "unlink-first"] as const) {
      const author = peer(PEER_A);
      const link = { account: ACCOUNT, device: PEER_A, partition: ACME, at: NOW };
      (await linkDevice(author.engine, link)).unwrap();
      const courier = peer(PEER_C);
      (await unlinkDevice(courier.engine, { ...link, at: LATER })).unwrap();

      const receiver = peer(PEER_B);
      const from = order === "link-first" ? [author, courier] : [courier, author];
      for (const side of from) await sync(side, receiver);
      expect(links(receiver.engine).map((l) => l.linked)).toEqual([false]);
      expect(
        linkedAuthor({ peerId: PEER_A, partition: ACME, changes: [] }, lookupOf(receiver.engine)),
      ).toBeUndefined();
    }
  });
});
