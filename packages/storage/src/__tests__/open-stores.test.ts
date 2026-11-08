import type { StoreFailure } from "@syncmesh/engine";

import { EMPTY_COVERAGE } from "@syncmesh/engine";
import { Result } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";

import type { Stores } from "../open-stores.js";

import { A, entry } from "../driver-tests/fixtures.js";
import { openStores } from "../open-stores.js";
import { openPair } from "./pair.js";

/** Every method of the opened stores that writes the database, each called with as little as it takes. */
const writes = {
  "events.append": (stores) => stores.events.append(entry(A, 1, 1_000)),
  "events.appendBatch": (stores) => stores.events.appendBatch([]),
  "events.compactBelow": (stores) =>
    stores.events.compactBelow(new Map(), "synced", Temporal.Now.instant()),
  "events.evict": (stores) => stores.events.evict([]),
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
