import type { SeqNum } from "@syncmesh/kernel";

import { relayTransport, startRelay, webSocketDial } from "@syncmesh/relay";
import { ladder, partition, syncSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant, type Identity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMesh } from "../mesh.js";
import { sqlite } from "../options.js";

const notes = sqliteTable("notes", { id: text().primaryKey(), body: text().notNull() });
const org = partition("org", { roles: ladder("member") });
const schema = () =>
  syncSchema({
    tables: {
      notes: {
        columns: { id: t.text().primaryKey(), body: t.text() },
        partition: org,
        allow: ({ role }) => ({ $default: role("member") }),
      },
    },
  });

const issuer = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 50 + i)).unwrap();
const deviceA = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 90 + i)).unwrap();
const deviceB = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 140 + i)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
// B's clock is two hours on: A's one-hour grant is fresh where A checks it and too old for B's
// registry to take, so B's ladder finds no grant for A and parks A's write
const LATER = T0.add({ hours: 2 });

const grantFor = (device: Identity, account: string, now: Temporal.Instant) =>
  issueGrant(issuer, {
    account,
    device: device.peerId,
    role: "member",
    // SAFETY: test fixture instances in the documented kind:id form
    partitions: ["org:acme"] as never,
    validFor: Temporal.Duration.from({ hours: 1 }),
    now,
  });

const until = async (check: () => Promise<boolean>, ms = 5000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return check();
};

const open = async (url: string, device: Identity, now: Temporal.Instant) =>
  (
    await createMesh({
      schema: schema(),
      identity: device,
      now: () => now,
      transports: [relayTransport({ dial: webSocketDial(url), reconnectMs: 20 })],
      storage: sqlite({ driver: bunSqliteDriver(":memory:") }),
      trust: { issuer: issuer.peerId },
    })
  ).unwrap();

describe("the author's ledger over a relay (D32, U17)", () => {
  test("a peer behind the relay that parks the write is named in the ledger, and its custody later retires it", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "syncmesh-relay-custody-"));
    const relay = await startRelay(0, { dataDir, keepaliveMs: 60_000 });
    try {
      const a = await open(relay.url, deviceA, T0);
      const b = await open(relay.url, deviceB, LATER);
      a.grants.register(grantFor(deviceA, "acct_a", T0)).unwrap();
      a.grants.register(grantFor(deviceB, "acct_b", LATER)).unwrap();
      b.grants.register(grantFor(deviceB, "acct_b", LATER)).unwrap();
      await Promise.all([a.ready(), b.ready()]);

      await a.on("org:acme").unwrap().db.insert(notes).values({ id: "n1", body: "hello" });
      const ledger = a.operations ?? panicNoLedger();
      // SAFETY: this device's first write, so its event is sequence 1 — a branded integer
      const first = 1 as SeqNum;
      const refusedBy = async () =>
        (await ledger.refusals(deviceA.peerId, first)).unwrap().map((r) => r.refuser);
      expect(await until(async () => (await refusedBy()).length > 0)).toBe(true);
      expect(b.recovery.list().map((issue) => issue.verdict)).toEqual(["NoGrant"]);
      expect((await ledger.byEvent(deviceA.peerId, first)).unwrap()?.refusals).toEqual([
        { by: deviceB.peerId, reason: "refused", verdict: "NoGrant" },
      ]);

      // the grant renewed where B can see it: the parked write folds, and B's vouch, carried
      // through the relay like the refusal was, retires the refusal
      b.grants.register(grantFor(deviceA, "acct_a", LATER)).unwrap();
      (await b.recovery.run()).unwrap();
      expect(await until(async () => (await refusedBy()).length === 0)).toBe(true);
      const vouched = (await ledger.vouchesOf(deviceA.peerId, first)).unwrap();
      expect(vouched.map((v) => v.holder)).toEqual([deviceB.peerId]);

      await a.stop();
      await b.stop();
    } finally {
      await relay.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

const panicNoLedger = () => {
  throw new Error("a mesh over SQLite keeps a write ledger");
};
