import type { StoreFailure } from "@syncmesh/engine";

import { EMPTY_COVERAGE } from "@syncmesh/engine";
import { parseSeqNum } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";

import type { Stores } from "../open-stores.js";
import type { OperationStore } from "../operation-store.js";

import { A, entry } from "../driver-tests/fixtures.js";
import { openStores } from "../open-stores.js";
import { operationStore } from "../operation-store.js";
import { openPair } from "./pair.js";

/** Every method of the opened stores that writes the database, each called with as little as it takes. */
const writes = {
  "events.append": (stores) => stores.events.append(entry(A, 1, 1_000)),
  "events.appendBatch": (stores) => stores.events.appendBatch([]),
  "events.compactBelow": (stores) =>
    stores.events.compactBelow(new Map(), "synced", Temporal.Now.instant()),
  "events.evict": (stores) => stores.events.evict([]),
  "events.recordInstalled": (stores) => stores.events.recordInstalled(new Map([[A, ONE]])),
  "state.commit": (stores) => stores.state.commit([], EMPTY_COVERAGE),
  "state.clear": (stores) => stores.state.clear(),
  "state.remove": (stores) => stores.state.remove(new Map()),
  "docs.append": (stores) => stores.docs.append([]),
  "docs.forget": (stores) => stores.docs.forget(new Map()),
  atomic: (stores) => stores.atomic(() => Promise.resolve(Result.ok(undefined))),
} satisfies Record<string, (stores: Stores) => Promise<Result<void | number, StoreFailure>>>;

describe("a write through the opened stores marks a clean session open before it lands (D39)", () => {
  for (const [name, write] of Object.entries(writes)) {
    test(name, async () => {
      const driver = await openPair();
      const stores = (await openStores(driver)).unwrap();
      const session = async () =>
        (await driver.all(`SELECT value FROM syncmesh.meta WHERE key = 'session'`))[0]?.[0];

      await stores.markClean();
      expect(await session()).toBe("closed");
      expect((await write(stores)).isOk()).toBe(true);
      expect(await session()).toBe("open");
      await stores.close();
    });
  }
});

const ONE = parseSeqNum(1).unwrap();

/** Every write of the ledger, each called with as little as it takes. */
const ledgerWrites = {
  record: (ledger) => ledger.record({ id: "op1", peer: A, seq: ONE, label: "note", atMs: 1_000 }),
  acknowledge: (ledger) => ledger.acknowledge(A, A, ONE, 1_000),
  vouch: (ledger) => ledger.vouch(A, A, ONE, "lineage", 1_000),
  refuse: (ledger) =>
    ledger.refuse(A, A, ONE, { reason: "refused", verdict: "PolicyDenied" }, 1_000),
  correct: (ledger) => ledger.correct(A, ONE, "op2", "r"),
} satisfies Record<string, (ledger: OperationStore) => Promise<Result<void, StoreFailure>>>;

describe("a write to the ledger over the opened stores marks a clean session open first (D39)", () => {
  for (const [name, write] of Object.entries(ledgerWrites)) {
    test(name, async () => {
      const driver = await openPair();
      const stores = (await openStores(driver)).unwrap();
      const ledger = (
        await operationStore(stores.driver, { beforeWrite: stores.beforeWrite })
      ).unwrap();
      const session = async () =>
        (await driver.all(`SELECT value FROM syncmesh.meta WHERE key = 'session'`))[0]?.[0];

      await stores.markClean();
      expect(await session()).toBe("closed");
      expect((await write(ledger)).isOk()).toBe(true);
      expect(await session()).toBe("open");
      await stores.close();
    });
  }
});
