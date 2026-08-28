import { seed } from "@syncmesh/kernel/test-fixtures";
import { relayTransport, startRelay, webSocketDial } from "@syncmesh/relay";
import { defineSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, type Identity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMesh } from "../mesh.js";

const notes = sqliteTable("notes", { id: text().primaryKey(), body: text().notNull() });
const schema = () =>
  defineSchema({
    partitions: { org: {} },
    roles: { org: ["owner", "member"] },
    tables: {
      notes: {
        columns: { id: t.text().primaryKey(), body: t.text() },
        partition: "org",
        allow: ({ role }) => ({ $default: role("member") }),
      },
    },
  });

const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const until = async (check: () => Promise<boolean>, ms = 3000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return check();
};

/** The owner's phone is the issuer: it mints for itself and answers invites over the relay. */
const owner = async (url: string, identity: Identity, invite: string) => {
  const mesh = (
    await createMesh({
      driver: bunSqliteDriver(":memory:"),
      schema: schema(),
      identity,
      issuer: identity.peerId,
      issuerKey: identity,
      now: () => T0,
      transports: [relayTransport({ dial: webSocketDial(url), reconnectMs: 20 })],
      onGrantRequest: ({ peerId, invite: offered }) => {
        if (offered !== invite) return;
        mesh.grants
          .issue({
            account: "acct_staff",
            device: peerId,
            role: "member",
            partitions: ["org:acme"],
            validFor: Temporal.Duration.from({ days: 1 }),
          })
          .unwrap();
      },
    })
  ).unwrap();
  mesh.grants
    .issue({
      account: "acct_owner",
      device: identity.peerId,
      role: "owner",
      partitions: ["org:acme"],
      validFor: Temporal.Duration.from({ days: 1 }),
    })
    .unwrap();
  return mesh;
};

const staff = async (url: string, identity: Identity, issuer: Identity) =>
  (
    await createMesh({
      driver: bunSqliteDriver(":memory:"),
      schema: schema(),
      identity,
      issuer: issuer.peerId,
      now: () => T0,
      transports: [relayTransport({ dial: webSocketDial(url), reconnectMs: 20 })],
    })
  ).unwrap();

describe("createMesh over a relay — E12's done-when at the app surface", () => {
  test("onboard through the relay, converge both ways, delivered settles, and a relay restart resumes without re-sent history", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "syncmesh-mesh-relay-"));
    const ownerId = createIdentity(seed(7)).unwrap();
    const staffId = createIdentity(seed(160)).unwrap();
    try {
      let relay = await startRelay(0, { dataDir, keepaliveMs: 60_000 });
      const o = await owner(relay.url, ownerId, "inv-42");
      const s = await staff(relay.url, staffId, ownerId);
      await Promise.all([o.ready(), s.ready()]);

      // flow A over a real relay: the request travels to the owner, the signed grant back
      expect(s.can("notes.insert")).toBe(false);
      s.requestGrant("inv-42");
      expect(await until(() => Promise.resolve(s.can("notes.insert")))).toBe(true);

      const ho = o.on("org:acme").unwrap();
      const hs = s.on("org:acme").unwrap();
      const rows = (db: typeof ho.db) =>
        db
          .select()
          .from(notes)
          .then((r) => r.length);
      await ho.db.insert(notes).values({ id: "n1", body: "from owner" });
      await hs.db.insert(notes).values({ id: "n2", body: "from staff" });
      expect(await until(async () => (await rows(ho.db)) === 2 && (await rows(hs.db)) === 2)).toBe(
        true,
      );
      // delivery is the peer's own word, relayed: staff said it holds n1, the owner heard it
      await o.delivered({ to: staffId.peerId });
      await s.delivered({ to: ownerId.peerId });

      // kill the relay: the meshes lose each other but keep working locally
      await relay.stop();
      await hs.db.insert(notes).values({ id: "n3", body: "while down" });
      expect(await rows(ho.db)).toBe(2);

      // the same log, a fresh process on the same port: the transports reconnect on their own
      // and only the offline write crosses — three events on each side, none duplicated
      relay = await startRelay(relay.port, { dataDir, keepaliveMs: 60_000 });
      expect(await until(async () => (await rows(ho.db)) === 3)).toBe(true);
      expect((await o.engine.eventsSince(new Map())).unwrap()).toHaveLength(3);
      expect((await s.engine.eventsSince(new Map())).unwrap()).toHaveLength(3);

      await o.stop();
      await s.stop();
      await relay.stop();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 20_000);
});
