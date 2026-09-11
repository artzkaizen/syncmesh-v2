import type { PeerId, SeqNum } from "@syncmesh/kernel";

import { parsePartitionKey } from "@syncmesh/kernel";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SqlRow } from "../driver.js";
import type { StoreScope } from "../open-stores.js";

import { sweepBudget } from "../budget.js";
import { detachScope } from "../detach.js";
import { scopedStores, storeNameFor } from "../open-stores.js";
import { operationStore } from "../operation-store.js";
import { sqliteDriver } from "../sqlite-driver.js";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test fixtures */
const A = "a".repeat(64) as PeerId;
const B = "b".repeat(64) as PeerId;
const seq = (n: number) => n as SeqNum;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

const ORG = parsePartitionKey("org:acme").unwrap();

const fileDriver = (path: string) => {
  const db = new Database(path, { create: true, strict: true });
  return sqliteDriver({
    exec: (sql) => db.run(sql),
    run: (sql, params) => void db.run(sql, [...params]),
    // SAFETY: SQLite hands back exactly SqlValue shapes
    all: (sql, params) => db.query(sql).values(...params) as readonly SqlRow[],
    close: () => db.close(),
  });
};

describe("detach — a partition leaves whole, or not at all", () => {
  test("unsent intent refuses; a receipt clears it; the file is gone after", async () => {
    const dir = mkdtempSync(join(tmpdir(), "syncmesh-detach-"));
    const pathOf = (name: string) => join(dir, `${name}.db`);
    const set = scopedStores({ driverFor: (_scope, name) => fileDriver(pathOf(name)) });
    try {
      const stores = (await set.storeFor(ORG)).unwrap();
      const ledger = (await operationStore(stores.driver)).unwrap();
      (await ledger.record({ id: "op-1", peer: A, seq: seq(1), label: "l", atMs: 1 })).unwrap();

      const refused = await detachScope(set, ORG);
      const error = refused.match({ ok: () => undefined, err: (e) => e });
      expect(error?._tag).toBe("DetachRefused");
      expect(error?._tag === "DetachRefused" && error.unsent).toEqual(["op-1"]);

      (await ledger.acknowledge(B, A, seq(1), 5)).unwrap();
      const file = pathOf(storeNameFor(ORG));
      expect(existsSync(file)).toBe(true);
      (
        await detachScope(set, ORG, {
          remove: () => Promise.resolve(rmSync(file, { force: true })),
        })
      ).unwrap();
      expect(existsSync(file)).toBe(false);
      expect(set.opened()).toHaveLength(0);
    } finally {
      await set.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the storage budget — pressure sheds whole idle partitions", () => {
  test("lru-idle sheds the oldest idle scope, keeps the guarded one, and suggest touches nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "syncmesh-budget-"));
    const pathOf = (name: string) => join(dir, `${name}.db`);
    const set = scopedStores({ driverFor: (_scope, name) => fileDriver(pathOf(name)) });
    const WARD = parsePartitionKey("org:ward").unwrap();
    try {
      const acme = (await set.storeFor(ORG)).unwrap();
      (await set.storeFor(WARD)).unwrap();
      // acme holds unsent intent, so the guard must keep it whatever the pressure
      const ledger = (await operationStore(acme.driver)).unwrap();
      (await ledger.record({ id: "op-1", peer: A, seq: seq(1), label: "l", atMs: 1 })).unwrap();

      const platform = {
        sizeOf: () => Promise.resolve(1000),
        isIdle: () => true,
        remove: (scope: StoreScope) =>
          Promise.resolve(rmSync(pathOf(storeNameFor(scope)), { force: true })),
      };

      const suggested = (
        await sweepBudget(set, { maxBytes: 500, detach: "suggest" }, platform)
      ).unwrap();
      expect(suggested.over).toBe(true);
      expect(set.opened()).toHaveLength(2); // suggest changed nothing

      const swept = (
        await sweepBudget(set, { maxBytes: 1000, detach: "lru-idle" }, platform)
      ).unwrap();
      expect(swept.shed).toEqual([WARD]); // acme was guarded; ward, though younger, was free
      expect(swept.kept).toEqual([ORG]);
      expect(set.opened()).toEqual([ORG]);
      expect(existsSync(pathOf(storeNameFor(WARD)))).toBe(false);
    } finally {
      await set.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
