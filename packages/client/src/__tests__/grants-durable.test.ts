import { parsePartitionKey } from "@syncmesh/kernel";
import { seed } from "@syncmesh/kernel/test-fixtures";
import { syncSchema, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMesh } from "../mesh.js";

const schema = () =>
  syncSchema({
    partitions: { org: {} },
    roles: { org: ["member"] },
    tables: {
      notes: {
        columns: { id: t.text().primaryKey(), body: t.text() },
        partition: "org",
        allow: ({ role }) => ({ $default: role("member") }),
      },
    },
  });

const ISSUER = createIdentity(seed(1)).unwrap();
const DEVICE = createIdentity(seed(90)).unwrap();
const PEER = createIdentity(seed(160)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const ACME = parsePartitionKey("org:acme").unwrap();

const mint = (device: typeof PEER, validFor: Temporal.Duration, now = T0) =>
  issueGrant(ISSUER, {
    account: "acct_a",
    device: device.peerId,
    role: "member",
    partitions: [ACME],
    validFor,
    now,
  });

const open = (dataDir: string, now = T0) =>
  createMesh({
    schema: schema(),
    identity: DEVICE,
    issuer: ISSUER.peerId,
    dataDir,
    now: () => now,
  });

const HOUR = Temporal.Duration.from({ hours: 1 });

describe("grants survive a restart", () => {
  test("a peer met before a reboot is still known after it", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "syncmesh-grants-"));
    try {
      const first = (await open(dataDir)).unwrap();
      first.grants.register(mint(PEER, HOUR)).unwrap();
      expect(first.grants.grantFor(PEER.peerId)?.account).toBe("acct_a");
      await first.stop();

      // a fresh process over the same file: without this the peer is an unknown author and
      // everything it wrote quarantines on NoGrant until it happens to reconnect and re-send
      const second = (await open(dataDir)).unwrap();
      expect(second.grants.grantFor(PEER.peerId)?.account).toBe("acct_a");
      expect(second.grants.allWires()).toHaveLength(1);
      await second.stop();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("a re-issued grant replaces the stored one rather than joining it", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "syncmesh-grants-"));
    try {
      const first = (await open(dataDir)).unwrap();
      first.grants.register(mint(PEER, HOUR)).unwrap();
      first.grants.register(mint(PEER, HOUR, T0.add({ minutes: 5 }))).unwrap();
      await first.stop();

      const second = (await open(dataDir)).unwrap();
      expect(second.grants.allWires()).toHaveLength(1);
      expect(second.grants.grantFor(PEER.peerId)?.issuedAt).toEqual(T0.add({ minutes: 5 }));
      await second.stop();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("the store cannot launder an expired grant back in, and stops holding it", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "syncmesh-grants-"));
    try {
      const first = (await open(dataDir)).unwrap();
      first.grants.register(mint(PEER, Temporal.Duration.from({ minutes: 10 }))).unwrap();
      await first.stop();

      // an hour later the grant has lapsed: it goes back through `register` like anything off
      // the wire, so it does not return — and it is dropped rather than re-read every boot
      const later = T0.add({ hours: 1 });
      const second = (await open(dataDir, later)).unwrap();
      expect(second.grants.grantFor(PEER.peerId)).toBeUndefined();
      expect(second.grants.allWires()).toEqual([]);
      await second.stop();

      const third = (await open(dataDir, later)).unwrap();
      expect(third.grants.allWires()).toEqual([]);
      await third.stop();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("a locally revoked grant does not come back on the next boot", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "syncmesh-grants-"));
    try {
      const first = (await open(dataDir)).unwrap();
      first.grants.register(mint(PEER, HOUR)).unwrap();
      first.grants.revoke(PEER.peerId);
      await first.stop();

      const second = (await open(dataDir)).unwrap();
      expect(second.grants.grantFor(PEER.peerId)).toBeUndefined();
      await second.stop();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
