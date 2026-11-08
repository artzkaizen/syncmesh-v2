import type { SqlDriver } from "@syncmesh/storage";

import { createMemoryEventStore } from "@syncmesh/engine";
import { seed } from "@syncmesh/kernel/test-fixtures";
import { relayTransport, startRelay, webSocketDial } from "@syncmesh/relay";
import { ladder, partition, syncSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, type Identity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

import { createMesh } from "../mesh.js";
import { sqlite } from "../options.js";

/**
 * D40 end to end, at the app surface: real meshes, a real relay over WebSocket, the relay gated
 * on the authority's key. What is checked is the device's own database — not a row, and not an
 * event in its log, of a partition it was never granted.
 */

const notes = sqliteTable("notes", { id: text().primaryKey(), body: text().notNull() });
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

const until = async (check: () => Promise<boolean>, ms = 4000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return check();
};

/** How many events of a partition a device's own log holds: the strongest "never received". */
const held = async (driver: SqlDriver, partitionKey: string) =>
  Number(
    (await driver.all(`SELECT COUNT(*) FROM events WHERE partition = ?`, [partitionKey]))[0]?.[0],
  );

/** One device on the gated relay, holding the grant the authority minted for it. */
const member = async (url: string, identity: Identity, issuer: Identity, grant: Uint8Array) => {
  const driver = bunSqliteDriver(":memory:");
  const mesh = (
    await createMesh({
      schema: schema(),
      identity,
      transports: [relayTransport({ dial: webSocketDial(url), reconnectMs: 20 })],
      storage: sqlite({ driver }),
      trust: { issuer: issuer.peerId },
    })
  ).unwrap();
  // out of band, the way RFC-0024 hands a device its grant: a gated room seats nobody without one
  mesh.grants.register(grant).unwrap();
  return { mesh, driver };
};

/** Every note a device's own table holds, whatever partition it came from. */
const bodies = async (mesh: Awaited<ReturnType<typeof member>>["mesh"]) =>
  (await mesh.on(CHECKOUT).unwrap().db.select().from(notes)).map((r) => r.body).sort();

describe("who may read what, over a gated relay (D40)", () => {
  test("a member is never sent a partition it lacks — catch-up, live, and after revocation", async () => {
    const authorityId = createIdentity(seed(7)).unwrap();
    const relay = await startRelay(0, {
      keepaliveMs: 60_000,
      store: createMemoryEventStore(),
      epoch: "epoch-1",
      posture: { trust: { issuers: [authorityId.peerId] } },
    });
    try {
      const authority = (
        await createMesh({
          schema: schema(),
          identity: authorityId,
          transports: [relayTransport({ dial: webSocketDial(relay.url), reconnectMs: 20 })],
          storage: sqlite({ driver: bunSqliteDriver(":memory:") }),
          trust: { issuer: authorityId.peerId, issuerKey: authorityId },
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
      authority.grants
        .issue({
          account: "acct_authority",
          device: authorityId.peerId,
          role: "owner",
          partitions: [CHECKOUT, PAYROLL],
          validFor: day,
        })
        .unwrap();

      // history first: what a joiner is paged
      const ha = authority.on(CHECKOUT).unwrap();
      const hp = authority.on(PAYROLL).unwrap();
      await ha.db.insert(notes).values({ id: "c1", body: "checkout spec" });
      await hp.db.insert(notes).values({ id: "p1", body: "payroll run" });

      const aliceId = createIdentity(seed(60)).unwrap();
      const bobId = createIdentity(seed(160)).unwrap();
      const alice = await member(
        relay.url,
        aliceId,
        authorityId,
        mint(aliceId, [CHECKOUT, PAYROLL]),
      );
      const bob = await member(relay.url, bobId, authorityId, mint(bobId, [CHECKOUT]));

      // catch-up: both get checkout; only alice gets payroll
      expect(await until(async () => (await bodies(alice.mesh)).length === 2)).toBe(true);
      expect(await until(async () => (await bodies(bob.mesh)).length === 1)).toBe(true);
      expect(await bodies(alice.mesh)).toEqual(["checkout spec", "payroll run"]);
      expect(await bodies(bob.mesh)).toEqual(["checkout spec"]);
      expect(await held(bob.driver, PAYROLL)).toBe(0);

      // live: the same, for writes made while everyone is connected
      await hp.db.insert(notes).values({ id: "p2", body: "bonus pool" });
      await ha.db.insert(notes).values({ id: "c2", body: "checkout copy" });
      expect(await until(async () => (await bodies(alice.mesh)).length === 4)).toBe(true);
      expect(await until(async () => (await bodies(bob.mesh)).length === 2)).toBe(true);
      expect(await bodies(bob.mesh)).toEqual(["checkout copy", "checkout spec"]);
      expect(await held(bob.driver, PAYROLL)).toBe(0);

      // revocation: alice leaves payroll. The narrower grant leaves the authority on the same
      // socket as, and ahead of, its next write — so the room has hung up on her and re-seated
      // her narrower before that write is fanned out, with no wait in between
      alice.mesh.grants.register(mint(aliceId, [CHECKOUT])).unwrap();
      await hp.db.insert(notes).values({ id: "p3", body: "after alice left" });
      await ha.db.insert(notes).values({ id: "c3", body: "still hers" });
      expect(await until(async () => (await bodies(alice.mesh)).includes("still hers"))).toBe(true);
      expect(await until(async () => (await bodies(bob.mesh)).includes("still hers"))).toBe(true);
      // nothing of payroll after the cut ever reached her, and what she read before it is purged
      // from her table and her log (D45)
      expect(await bodies(alice.mesh)).not.toContain("after alice left");
      expect(await until(async () => (await held(alice.driver, PAYROLL)) === 0)).toBe(true);
      expect(await bodies(alice.mesh)).toEqual(["checkout copy", "checkout spec", "still hers"]);
      expect(await held(bob.driver, PAYROLL)).toBe(0);

      await Promise.all([authority.stop(), alice.mesh.stop(), bob.mesh.stop()]);
    } finally {
      await relay.stop();
    }
  });
});
