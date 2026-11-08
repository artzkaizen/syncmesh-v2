import type { Narrowed } from "@syncmesh/engine";
import type { SqlDriver } from "@syncmesh/storage";

import { parsePartitionKey } from "@syncmesh/kernel";
import { seed } from "@syncmesh/kernel/test-fixtures";
import { relayTransport, startRelay, webSocketDial } from "@syncmesh/relay";
import { ladder, partition, syncSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { hashOf, sqlBlobStore } from "@syncmesh/storage";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, type Identity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMesh } from "../mesh.js";

/**
 * D45 and D44 end to end, at the app surface: real meshes on a grant-gated relay over WebSocket.
 * What is checked is the device's own database — its table, its log and its blob cache.
 */

const notes = sqliteTable("notes", { id: text().primaryKey(), body: text() });
const project = partition("project", { roles: ladder("owner", "member") });
const schema = () =>
  syncSchema({
    tables: {
      notes: {
        columns: { id: t.text().primaryKey(), body: t.text() },
        partition: project,
        allow: ({ role }) => ({ $default: role("member") }),
      },
    },
  });

const CHECKOUT = "project:checkout";
const PAYROLL = "project:payroll";
const day = Temporal.Duration.from({ days: 1 });
const photo = Uint8Array.from({ length: 2048 }, (_, i) => (i * 7) % 251);
const payslip = Uint8Array.from({ length: 1024 }, (_, i) => (i * 13) % 241);

const until = async (check: () => Promise<boolean> | boolean, ms = 5000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return check();
};
/** Grants are newest-issued-wins at a millisecond grain: two minted in one would tie. */
const nextMillisecond = () => new Promise((resolve) => setTimeout(resolve, 5));

/** How many events of a partition a device's own log holds. */
const held = async (driver: SqlDriver, partitionKey: string) =>
  Number(
    (await driver.all(`SELECT COUNT(*) FROM events WHERE partition = ?`, [partitionKey]))[0]?.[0],
  );

/** A gated relay on its own directory, its authority, and a way to mint grants from it. */
const gatedWorld = async (dataDir: string) => {
  const authorityId = createIdentity(seed(7)).unwrap();
  const relay = await startRelay(0, {
    dataDir,
    keepaliveMs: 60_000,
    posture: { trust: { issuers: [authorityId.peerId] } },
  });
  const authority = (
    await createMesh({
      driver: bunSqliteDriver(":memory:"),
      schema: schema(),
      identity: authorityId,
      issuer: authorityId.peerId,
      issuerKey: authorityId,
      transports: [relayTransport({ dial: webSocketDial(relay.url), reconnectMs: 20 })],
    })
  ).unwrap();
  const mint = (device: Identity, partitions: readonly string[]) =>
    authority.grants
      .issue({
        account: `acct_${device.peerId.slice(0, 6)}`,
        device: device.peerId,
        role: "member",
        partitions,
        validFor: day,
      })
      .unwrap();
  mint(authorityId, [CHECKOUT, PAYROLL]);
  return { relay, authority, authorityId, mint };
};

/** One device on the gated relay, holding the grant the authority minted for it. */
const member = async (
  url: string,
  identity: Identity,
  issuer: Identity,
  grant: Uint8Array,
  onNarrowed?: (narrowed: Narrowed) => Promise<void> | void,
  cache: "sql" | "default" = "sql",
) => {
  const driver = bunSqliteDriver(":memory:");
  const blobStore = (await sqlBlobStore(driver)).unwrap();
  const mesh = (
    await createMesh({
      driver,
      schema: schema(),
      identity,
      issuer: issuer.peerId,
      ...(cache === "sql" && { blobStore }),
      onNarrowed: onNarrowed ?? (() => undefined),
      transports: [relayTransport({ dial: webSocketDial(url), reconnectMs: 20 })],
    })
  ).unwrap();
  mesh.grants.register(grant).unwrap();
  return { mesh, driver, blobStore };
};

const bodies = async (mesh: Awaited<ReturnType<typeof member>>["mesh"]) =>
  (await mesh.on(CHECKOUT).unwrap().db.select().from(notes)).map((r) => r.body ?? "").sort();

describe("a narrowed entitlement purges what the device may no longer read (D45)", () => {
  test("the app hears first; rows, log and cached blobs go; its own writes stay; a widening restores", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "syncmesh-narrowing-"));
    const { relay, authority, authorityId, mint } = await gatedWorld(dataDir);
    try {
      const payrollKey = parsePartitionKey(PAYROLL).unwrap();
      const hp = authority.on(PAYROLL).unwrap();
      await authority.ready();
      const blob = (await authority.blobs.put(payslip, { partition: payrollKey })).unwrap();
      await hp.db.insert(notes).values({ id: "p1", body: blob });
      await authority.on(CHECKOUT).unwrap().db.insert(notes).values({ id: "c1", body: "spec" });

      const told: { narrowed: Narrowed; seen: readonly string[] }[] = [];
      const aliceId = createIdentity(seed(60)).unwrap();
      const alice = await member(
        relay.url,
        aliceId,
        authorityId,
        mint(aliceId, [CHECKOUT, PAYROLL]),
        async (narrowed) => {
          told.push({ narrowed, seen: await bodies(alice.mesh) });
        },
      );
      expect(await until(async () => (await bodies(alice.mesh)).length === 2)).toBe(true);
      // bytes she put into payroll, which the authority's row then names (the oRPC shape)
      const upload = (await alice.mesh.blobs.put(photo, { partition: payrollKey })).unwrap();
      await hp.db.insert(notes).values({ id: "p2", body: upload });
      expect(await until(async () => (await bodies(alice.mesh)).includes(upload))).toBe(true);
      // her own payroll note, and the payslip fetched into her cache
      await alice.mesh.on(PAYROLL).unwrap().db.insert(notes).values({ id: "a1", body: "mine" });
      expect((await alice.mesh.blobs.fetch(blob, { timeoutMs: 3000 })).unwrap()).toEqual(payslip);
      expect(await alice.blobStore.has(blob)).toBe(true);

      await nextMillisecond();
      alice.mesh.grants.register(mint(aliceId, [CHECKOUT])).unwrap();
      expect(await until(async () => (await held(alice.driver, PAYROLL)) === 1)).toBe(true);
      // told once, before anything went
      expect(told.map((t) => t.narrowed)).toEqual([{ partitions: [payrollKey], tables: [] }]);
      expect(told[0]?.seen).toContain(blob);
      // the authority's payroll row and the cached payslip are gone; her own note is her own
      expect(await bodies(alice.mesh)).toEqual(["mine", "spec"]);
      expect(await alice.blobStore.has(blob)).toBe(false);
      // the bytes she made are kept, though only a purged row named them
      expect(await alice.blobStore.has(upload)).toBe(true);

      // the widening re-pages her, and the events fold again
      await nextMillisecond();
      alice.mesh.grants.register(mint(aliceId, [CHECKOUT, PAYROLL])).unwrap();
      expect(await until(async () => (await bodies(alice.mesh)).includes(blob))).toBe(true);
      expect(await held(alice.driver, PAYROLL)).toBe(3);

      await Promise.all([authority.stop(), alice.mesh.stop()]);
    } finally {
      await relay.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("a narrowed device on the default blob cache (D45)", () => {
  test("a payslip fetched before the narrowing is not served from the cache after it", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "syncmesh-narrowing-memory-"));
    const { relay, authority, authorityId, mint } = await gatedWorld(dataDir);
    try {
      const payrollKey = parsePartitionKey(PAYROLL).unwrap();
      await authority.ready();
      const blob = (await authority.blobs.put(payslip, { partition: payrollKey })).unwrap();
      await authority.on(PAYROLL).unwrap().db.insert(notes).values({ id: "p1", body: blob });

      const carolId = createIdentity(seed(61)).unwrap();
      const carol = await member(
        relay.url,
        carolId,
        authorityId,
        mint(carolId, [CHECKOUT, PAYROLL]),
        undefined,
        "default",
      );
      expect(await until(async () => (await bodies(carol.mesh)).includes(blob))).toBe(true);
      const upload = (await carol.mesh.blobs.put(photo, { partition: payrollKey })).unwrap();
      await authority.on(PAYROLL).unwrap().db.insert(notes).values({ id: "p2", body: upload });
      expect(await until(async () => (await bodies(carol.mesh)).includes(upload))).toBe(true);
      expect((await carol.mesh.blobs.fetch(blob, { timeoutMs: 3000 })).unwrap()).toEqual(payslip);

      await nextMillisecond();
      carol.mesh.grants.register(mint(carolId, [CHECKOUT])).unwrap();
      expect(await until(async () => !(await carol.mesh.blobs.has(blob)))).toBe(true);
      expect(await bodies(carol.mesh)).toEqual([]);
      // and the gated room will not serve it to her again, once her session carries the new grant
      const refused = async () => {
        const asked = await carol.mesh.blobs.fetch(blob, { timeoutMs: 500 });
        return asked.isErr() && asked.error._tag === "BlobNotFound";
      };
      expect(await until(refused)).toBe(true);
      // what she made is still in her cache
      expect(await carol.mesh.blobs.has(upload)).toBe(true);

      await Promise.all([authority.stop(), carol.mesh.stop()]);
    } finally {
      await relay.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("blobs in a grant-gated room, at the app surface (D44)", () => {
  test("a put into an ungranted partition is BlobNotGranted; a fetch outside the grant is BlobNotFound", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "syncmesh-gated-blobs-"));
    const { relay, authority, authorityId, mint } = await gatedWorld(dataDir);
    try {
      await authority.ready();
      const payroll = parsePartitionKey(PAYROLL).unwrap();
      const checkout = parsePartitionKey(CHECKOUT).unwrap();
      const secret = (await authority.blobs.put(payslip, { partition: payroll })).unwrap();

      const bobId = createIdentity(seed(160)).unwrap();
      const bob = await member(relay.url, bobId, authorityId, mint(bobId, [CHECKOUT]));
      await bob.mesh.ready();
      const refused = await bob.mesh.blobs.put(photo, { partition: payroll });
      expect(refused.isErr() && refused.error).toMatchObject({
        _tag: "BlobNotGranted",
        partition: payroll,
      });
      expect((await bob.mesh.blobs.put(photo, { partition: checkout })).isOk()).toBe(true);
      // the hash is known to bob — it leaked — and the room answers as if it held nothing
      const asked = await bob.mesh.blobs.fetch(secret, { timeoutMs: 2000 });
      expect(asked.isErr() && asked.error._tag).toBe("BlobNotFound");
      expect(hashOf(payslip)).toBe(secret);

      await Promise.all([authority.stop(), bob.mesh.stop()]);
    } finally {
      await relay.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});
