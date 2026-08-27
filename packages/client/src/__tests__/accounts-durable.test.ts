import type {
  CellValue,
  ColumnName,
  PeerId,
  Procedure,
  Row,
  RowKey,
  TableName,
} from "@syncmesh/kernel";

import { taggedCause } from "@syncmesh/drizzle";
import { createEngine, createMemoryEventStore, linkDevice, links } from "@syncmesh/engine";
import { createHlcClock, parseAccountId, parsePartitionKey } from "@syncmesh/kernel";
import { defineSchema, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import {
  createIdentity,
  encodeAccountCore,
  encodeCbor,
  issueGrant,
  verifyGrant,
} from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openAccounts } from "../accounts.js";
import { createMesh } from "../mesh.js";

/**
 * The account layer at the client door, on a real file (D21). Two properties this level is the
 * only one that can show: a link needs no store built for it, because it is a row and rows are
 * what the log already keeps; and `can` answers what the write does, in the mesh — no issuer,
 * accounts on — that links exist for.
 */

const notes = sqliteTable("notes", {
  id: text().primaryKey(),
  title: text().notNull(),
  ownerId: text().notNull(),
});

const schema = () =>
  defineSchema({
    partitions: { org: {} },
    tables: {
      notes: {
        columns: { id: t.text().primaryKey(), title: t.text(), ownerId: t.text() },
        partition: "org",
        allow: ({ owner }) => ({ $default: owner("ownerId") }),
      },
    },
  });

const seed = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => n + i);
const DEVICE = createIdentity(seed(90)).unwrap();
/** Alice, who holds the account key, and Bob, who is somebody else with one of his own. */
const ALICE = createIdentity(seed(10)).unwrap();
const BOB = createIdentity(seed(160)).unwrap();
const ISSUER = createIdentity(seed(50)).unwrap();
/* oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- the reserved table's own name */
const LINKS = "_links" as TableName;
const ALICE_ID = parseAccountId(String(ALICE.peerId)).unwrap();
const BOB_ID = parseAccountId(String(BOB.peerId)).unwrap();

const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const ACME = parsePartitionKey("org:acme").unwrap();
const GLOBEX = parsePartitionKey("org:globex").unwrap();

/** An ungranted mesh with accounts on: the rung `owner()` never reached before D21. */
const open = (dataDir: string, now = T0) =>
  createMesh({
    schema: schema(),
    identity: DEVICE,
    accounts: true,
    accountKey: ALICE,
    dataDir,
    now: () => now,
  });

/** One temp directory per test, since a mesh is one SQLite file per identity. */
const inTempDir = async (run: (dataDir: string) => Promise<void>) => {
  const dataDir = mkdtempSync(join(tmpdir(), "syncmesh-accounts-"));
  try {
    await run(dataDir);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
};

/** The mesh's tag inside a rejected Drizzle write, or how the write actually ended. */
const outcome = (write: Promise<unknown>) =>
  write.then(
    () => "ok",
    (cause: unknown) =>
      cause instanceof Error ? (taggedCause(cause)?._tag ?? String(cause)) : String(cause),
  );

const column = (name: string): ColumnName => {
  // SAFETY: test fixture; column naming rules belong to the schema
  return name as ColumnName;
};
const cells = (values: Readonly<Record<string, CellValue>>): Row =>
  new Map(Object.entries(values).map(([name, value]) => [column(name), value]));

const note = (id: string, ownerId: string) => ({ id, title: id, ownerId: String(ownerId) });

/**
 * A `_links` row the account never signed, in an engine with no validator to refuse it — the
 * only way to produce one, which is itself the point: it takes a snapshot to get this into
 * state, and a snapshot is what no validator judges.
 */
const forgedSnapshot = async (at: Temporal.Instant) => {
  const core = encodeAccountCore({
    v: 1,
    op: "link",
    account: ALICE_ID,
    device: DEVICE.peerId,
    partition: ACME,
    at,
  });
  const forger = createEngine({
    peerId: DEVICE.peerId,
    clock: createHlcClock({ now: () => at }),
    store: createMemoryEventStore(),
    merge: schema().merge,
  });
  // SAFETY: test fixture; `_links` is the reserved table's own name and `_links.link` its verb
  const table = "_links" as TableName;
  // SAFETY: test fixture; procedures are opaque strings in the kernel
  const procedure = "_links.link" as Procedure;
  // SAFETY: test fixture; keys are opaque strings in the kernel
  const key = `org:acme:${String(DEVICE.peerId)}` as RowKey;
  (
    await forger.mutate(
      procedure,
      (tx) =>
        tx.insert(
          table,
          key,
          cells({
            id: String(key),
            account: String(ALICE_ID),
            kind: 0,
            at: at.epochMilliseconds,
            wire: encodeCbor([core, BOB.sign(core)]),
          }),
        ),
      { partition: ACME },
    )
  ).unwrap();
  return forger.snapshot();
};

describe("links at the client door", () => {
  test("a link survives a restart with no store built for it: it is a row, and rows persist", async () => {
    await inTempDir(async (dataDir) => {
      const first = (await open(dataDir)).unwrap();
      (await first.accounts.link("org:acme")).unwrap();
      expect(links(first.engine).map((l) => [l.account, l.linked])).toEqual([
        [String(ALICE_ID), true],
      ]);
      await first.stop();

      // no `LinkStore` anywhere: the grant registry needed one built for it because a grant
      // rides the handshake, and a link rides the log every other write already rides
      const second = (await open(dataDir)).unwrap();
      expect(links(second.engine).map((l) => [l.device, l.account, l.linked])).toEqual([
        [String(DEVICE.peerId), String(ALICE_ID), true],
      ]);
      // and it still names a principal after the reboot, which is what surviving is for
      expect(second.can("notes.insert", cells(note("n1", ALICE_ID)), "org:acme")).toBe(true);
      await second.stop();
    });
  });

  test("can() and the write agree in both directions once a device is linked", async () => {
    await inTempDir(async (dataDir) => {
      const mesh = (await open(dataDir)).unwrap();
      (await mesh.accounts.link("org:acme")).unwrap();
      const { db } = mesh.on("org:acme").unwrap();

      // the row this device owns: the button lights up and the write lands
      expect(mesh.can("notes.insert", cells(note("n1", ALICE_ID)), "org:acme")).toBe(true);
      expect(await outcome(db.insert(notes).values(note("n1", ALICE_ID)))).toBe("ok");

      // and somebody else's: refused by the same rule, read from the same place
      expect(mesh.can("notes.insert", cells(note("n2", BOB_ID)), "org:acme")).toBe(false);
      expect(await outcome(db.insert(notes).values(note("n2", BOB_ID)))).toBe("PolicyDenied");
      await mesh.stop();
    });
  });

  test("a link that arrived by snapshot is re-verified before it names anybody", async () => {
    await inTempDir(async (dataDir) => {
      const mesh = (await open(dataDir)).unwrap();
      await mesh.engine.installSnapshot(await forgedSnapshot(T0.subtract({ minutes: 1 })));
      // the row is in state — no validator ever saw it — and it still binds nothing
      // in state, and not a link: `links` resolves the same way the validator does, so a row
      // no validator judged is reported as nothing rather than as a binding
      expect(mesh.engine.state().get(LINKS)?.size).toBe(1);
      expect(links(mesh.engine)).toEqual([]);
      expect(mesh.can("notes.insert", cells(note("n1", ALICE_ID)), "org:acme")).toBe(false);

      const { db } = mesh.on("org:acme").unwrap();
      await db.insert(notes).values(note("n1", ALICE_ID));
      const before = (await mesh.history("notes", "n1", { partition: "org:acme" })).unwrap();
      expect(before.map((r) => r.by)).toEqual([undefined]);

      // the same claim with the account's own signature, newer than the forgery, does bind
      (await mesh.accounts.link("org:acme")).unwrap();
      expect(mesh.can("notes.insert", cells(note("n2", ALICE_ID)), "org:acme")).toBe(true);
      const after = (await mesh.history("notes", "n1", { partition: "org:acme" })).unwrap();
      expect(after.map((r) => r.by)).toEqual([String(ALICE_ID)]);
      await mesh.stop();
    });
  });

  test("a device nothing has said anything about is nobody, not its own hex", async () => {
    await inTempDir(async (dataDir) => {
      const mesh = (await open(dataDir)).unwrap();
      const { db } = mesh.on("org:acme").unwrap();
      await db.insert(notes).values(note("n1", ALICE_ID));

      const revisions = (await mesh.history("notes", "n1", { partition: "org:acme" })).unwrap();
      expect(revisions[0]?.by).toBeUndefined();
      // the honest answer, not the convenient one: a device hex rendered as an account id is
      // indistinguishable from a real account in the same 64-hex space
      expect(revisions[0]?.by).not.toBe(String(DEVICE.peerId));
      await mesh.stop();
    });
  });

  test("attribution declines to answer when two instances name two accounts", async () => {
    await inTempDir(async (dataDir) => {
      const mesh = (await open(dataDir)).unwrap();
      const { accountOf } = openAccounts(
        { identity: DEVICE, accounts: true },
        { engine: mesh.engine, grants: mesh.grants, now: () => T0 },
      );
      const device: PeerId = DEVICE.peerId;
      expect(accountOf(device)).toBeUndefined();

      (await mesh.accounts.link("org:acme")).unwrap();
      expect(accountOf(device)).toBe(String(ALICE_ID));

      // the same device claiming Bob one instance over: it is one person here and another
      // there, and picking either would be a coin toss rendered as a fact
      (await linkDevice(mesh.engine, { account: BOB, device, partition: GLOBEX, at: T0 })).unwrap();
      expect(accountOf(device)).toBeUndefined();
      // the instance-scoped question still has its answer: `can` never asks the loose one
      expect(mesh.can("notes.insert", cells(note("n1", ALICE_ID)), "org:acme")).toBe(true);
      await mesh.stop();
    });
  });

  test("with an issuer configured the resolver reads the grant, and never the link", async () => {
    await inTempDir(async (dataDir) => {
      const mesh = (await open(dataDir)).unwrap();
      // the leaked account key binds this very device to Alice, in the instance it writes to
      (await mesh.accounts.link("org:acme")).unwrap();

      const grant = verifyGrant(
        issueGrant(ISSUER, {
          device: DEVICE.peerId,
          account: String(BOB_ID),
          claims: {},
          partitions: [ACME],
          validFor: Temporal.Duration.from({ hours: 24 }),
          now: T0,
        }),
        ISSUER.peerId,
        T0,
      ).unwrap();
      const grants = { all: () => [grant], grantFor: () => grant };
      const deps = {
        engine: mesh.engine,
        // SAFETY: only `all` and `grantFor` are read by the resolver under test
        grants: grants as never,
        now: () => T0,
      };

      // D21's property in its second home: `can` and `mesh.as` derive the principal here, and
      // wiring the link into the granted arm would make them answer from a key nobody vetted
      // while the validator still answered from the grant
      expect(openAccounts({ identity: DEVICE, accounts: true }, deps).author(ACME)?.account).toBe(
        String(ALICE_ID),
      );
      const granted = openAccounts(
        { identity: DEVICE, accounts: true, issuer: ISSUER.peerId },
        deps,
      );
      expect(granted.author(ACME)?.account).toBe(String(BOB_ID));
      expect(granted.author()?.account).toBe(String(BOB_ID));
    });
  });
});
