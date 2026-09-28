import type { PartitionKey } from "@syncmesh/kernel";
import type { StoreScope } from "@syncmesh/storage";

import { parsePartitionKey } from "@syncmesh/kernel";
import { syncSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { detachScope, scopedStores } from "@syncmesh/storage";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMesh } from "../mesh.js";
import { openRecovery } from "../recovery.js";
import { createSweep } from "../sweep.js";

const notes = sqliteTable("notes", { id: text().primaryKey(), body: text().notNull() });
const schema = () =>
  syncSchema({
    tables: { notes: { columns: { id: t.text().primaryKey(), body: t.text() } } },
  });

const device = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 40 + i)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const ACME = parsePartitionKey("org:acme").unwrap();
const GLOBEX = parsePartitionKey("org:globex").unwrap();
const LOCAL = parsePartitionKey("local:device").unwrap();

/** The device is its own root of trust here, which is what `createMesh` assumes without `issuer`. */
const grantOver = (partitions: readonly PartitionKey[], validFor = { hours: 1 }) =>
  issueGrant(device, {
    account: "acct",
    device: device.peerId,
    partitions,
    validFor: Temporal.Duration.from(validFor),
    now: T0,
  });

/** One file per scope under `dir`, a mesh over one of them, and the sweep over the set. */
const fixture = async (dir: string) => {
  const files = new Map<StoreScope, string>();
  const set = scopedStores({
    tables: schema().entries.map((e) => e.table),
    driverFor: (scope, name) => {
      const path = join(dir, `${name}.db`);
      files.set(scope, path);
      return bunSqliteDriver(path);
    },
  });
  let clock = T0;
  const meshOver = async (scope: StoreScope) =>
    (
      await createMesh({
        schema: schema(),
        identity: device,
        authority: device.peerId,
        stores: (await set.storeFor(scope)).unwrap(),
        dataDir: dir,
        now: () => clock,
      })
    ).unwrap();
  const mesh = await meshOver(ACME);
  const requested: StoreScope[] = [];
  const sweep = createSweep({
    self: device.peerId,
    grants: mesh.grants,
    scopes: set.opened,
    requested: () => requested,
    detach: (scope) =>
      detachScope(set, scope, {
        remove: () => Promise.resolve(rmSync(files.get(scope) ?? "", { force: true })),
      }),
  });
  return {
    set,
    mesh,
    meshOver,
    sweep,
    requested,
    fileFor: (scope: StoreScope) => files.get(scope) ?? "",
    advance: (by: Temporal.Duration) => void (clock = clock.add(by)),
  };
};

const inDir = async (run: (dir: string) => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), "syncmesh-sweep-"));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe("the store sweep — a store no live grant covers is one this device should not hold", () => {
  test("a scope under a live grant is not a candidate; one the grant does not name is", () =>
    inDir(async (dir) => {
      const { set, mesh, sweep } = await fixture(dir);
      (await set.storeFor(GLOBEX)).unwrap();
      mesh.grants.register(grantOver([ACME])).unwrap();
      expect(sweep.candidates()).toEqual([{ scope: GLOBEX, reason: "not-granted" }]);
      await mesh.stop();
      await set.close();
    }));

  test("a revoked grant makes its scopes candidates, and so does an expired one", () =>
    inDir(async (dir) => {
      const { set, mesh, sweep, advance } = await fixture(dir);
      mesh.grants.register(grantOver([ACME])).unwrap();
      expect(sweep.candidates()).toEqual([]);
      mesh.grants.revoke(device.peerId);
      expect(sweep.candidates()).toEqual([{ scope: ACME, reason: "no-grant" }]);

      mesh.grants.register(grantOver([ACME])).unwrap();
      advance(Temporal.Duration.from({ hours: 2 }));
      expect(sweep.candidates()).toEqual([{ scope: ACME, reason: "grant-lapsed" }]);
      await mesh.stop();
      await set.close();
    }));

  test("a reserved-kind store is never a candidate, granted or not", () =>
    inDir(async (dir) => {
      const { set, mesh, sweep } = await fixture(dir);
      (await set.storeFor("user")).unwrap();
      (await set.storeFor(LOCAL)).unwrap();
      // no grant held at all: everything grantable is a candidate, and the reserved ones are not
      expect(sweep.candidates()).toEqual([{ scope: ACME, reason: "no-grant" }]);
      await mesh.stop();
      await set.close();
    }));

  test("a scope with a grant request in flight is not a candidate until the request is answered", () =>
    inDir(async (dir) => {
      const { set, mesh, sweep, requested } = await fixture(dir);
      requested.push(ACME);
      expect(sweep.candidates()).toEqual([]);
      requested.length = 0;
      expect(sweep.candidates()).toEqual([{ scope: ACME, reason: "no-grant" }]);
      await mesh.stop();
      await set.close();
    }));

  test("unsent intent is reported refused and its file survives; a clean candidate is detached and gone", () =>
    inDir(async (dir) => {
      const { set, mesh, meshOver, sweep, fileFor } = await fixture(dir);
      const globex = await meshOver(GLOBEX);
      await globex.on().unwrap().db.insert(notes).values({ id: "n1", body: "nobody holds this" });
      await globex.flush();
      await globex.stop();
      await mesh.stop();
      // stopping leaves both stores open in the set, as borrowed stores are
      expect(set.opened()).toEqual([ACME, GLOBEX]);

      const report = (await sweep.sweep()).unwrap();
      expect(report.detached).toEqual([{ scope: ACME, reason: "no-grant" }]);
      expect(report.refused).toHaveLength(1);
      expect(report.refused[0]?.scope).toBe(GLOBEX);
      expect(report.refused[0]?.reason).toBe("no-grant");
      expect(report.refused[0]?.unsent).toHaveLength(1);

      expect(existsSync(fileFor(ACME))).toBe(false);
      expect(existsSync(fileFor(GLOBEX))).toBe(true);
      expect(set.opened()).toEqual([GLOBEX]);
      await set.close();
    }));

  test("subscribe fires when a grant lands and when it is withdrawn, and not after unsubscribing", () =>
    inDir(async (dir) => {
      const { set, mesh, sweep } = await fixture(dir);
      let fired = 0;
      const off = sweep.subscribe(() => void (fired += 1));
      mesh.grants.register(grantOver([ACME])).unwrap();
      expect(fired).toBe(1);
      mesh.grants.revoke(device.peerId);
      expect(fired).toBe(2);
      off();
      mesh.grants.register(grantOver([ACME])).unwrap();
      expect(fired).toBe(2);
      await mesh.stop();
      await set.close();
    }));

  test("recovery carries the sweep when given one, and leaves the slot absent otherwise", () =>
    inDir(async (dir) => {
      const { set, mesh, sweep } = await fixture(dir);
      expect(mesh.recovery.stores).toBeUndefined();
      const recovery = openRecovery(mesh.engine, {
        sources: () => [],
        onSnapshot: () => () => undefined,
        pending: () => 0,
        stores: sweep,
      });
      expect(recovery.stores?.candidates()).toEqual([{ scope: ACME, reason: "no-grant" }]);
      await mesh.stop();
      await set.close();
    }));
});

describe("a mesh given its set sweeps through recovery.stores", () => {
  test("a bare requestGrant() shields every open store until a grant for this device lands", async () => {
    await inDir(async (dir) => {
      const f = await fixture(dir);
      // a second mesh over the same set, this time told what set it came from
      const mesh = (
        await createMesh({
          schema: schema(),
          identity: device,
          authority: device.peerId,
          stores: (await f.set.storeFor(GLOBEX)).unwrap(),
          dataDir: dir,
          now: () => T0,
          sweep: {
            set: f.set,
            remove: (scope) => Promise.resolve(rmSync(f.fileFor(scope), { force: true })),
          },
        })
      ).unwrap();
      const stores = mesh.recovery.stores;
      expect(stores).toBeDefined();
      if (stores === undefined) return;

      // no grant held at all: every open store is a candidate, for that reason
      expect(
        stores
          .candidates()
          .map((c) => `${c.scope}:${c.reason}`)
          .sort(),
      ).toEqual(["org:acme:no-grant", "org:globex:no-grant"]);

      // asking for a grant names no scope, so it covers all of them — onboarding must not be swept
      mesh.requestGrant();
      expect(stores.candidates()).toEqual([]);

      // the answer lands: acme is granted; globex is held under a grant that does not name it
      mesh.grants.register(grantOver([ACME])).unwrap();
      expect(stores.candidates().map((c) => `${c.scope}:${c.reason}`)).toEqual([
        "org:globex:not-granted",
      ]);

      await mesh.stop();
      await f.mesh.stop();
    });
  });

  test("a mesh over one driver has no sweep: nothing to shed but itself", async () => {
    await inDir(async (dir) => {
      const f = await fixture(dir);
      expect(f.mesh.recovery.stores).toBeUndefined();
      await f.mesh.stop();
    });
  });
});
