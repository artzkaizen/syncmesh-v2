import type { SAHPoolUtil } from "@sqlite.org/sqlite-wasm";

import { describe, expect, spyOn, test } from "bun:test";

import type { OptionalVfs } from "../vfs.js";

import { holdPool, releaseWhenIdle } from "../pool.js";

/**
 * A pool whose every call is counted, standing in for sqlite-wasm's: bun has no OPFS, no Web Locks
 * and no `navigator.storage`, so the lease is a no-op and no slot reads as held, and what is left
 * is this module's own bookkeeping around the calls.
 */
const fakePool = (reserve: () => Promise<void>, wake: () => Promise<void> = async () => {}) => {
  const calls = { pause: 0 };
  let paused = false;
  const util = {
    isPaused: () => paused,
    unpauseVfs: async () => {
      await wake();
      paused = false;
    },
    pauseVfs: () => {
      calls.pause += 1;
      paused = true;
    },
    reserveMinimumCapacity: reserve,
  };
  const install = (async () =>
    // SAFETY: the four calls `holdPool` makes on a pool; the rest of `SAHPoolUtil` is never reached
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- a stand-in has no more of the type to keep
    util as unknown as SAHPoolUtil) satisfies NonNullable<OptionalVfs["installOpfsSAHPoolVfs"]>;
  return { calls, install };
};

const options = { name: "log", schema: "s", capacity: 6 } as const;

let directories = 0;
const fresh = () => `/pool-test-${(directories += 1)}`;

describe("holdPool", () => {
  test("an open whose slots will not reserve gives the pool's handles back with the lease", async () => {
    const quota = Object.assign(new Error("the origin is out of quota"), {
      name: "QuotaExceededError",
    });
    const { calls, install } = fakePool(() => Promise.reject(quota));
    const directory = fresh();
    const held = await holdPool(install, directory, { ...options, directory });
    expect(held.isErr()).toBe(true);
    // the install took every slot's handle; left awake, another context finds them all held
    expect(calls.pause).toBe(1);
  });

  test("an open whose pool will not wake gives back the handles the wake kept", async () => {
    let refuse = false;
    const held = Object.assign(new Error("a slot is held by another context"), {
      name: "NoModificationAllowedError",
    });
    const { calls, install } = fakePool(
      async () => {},
      async () => {
        if (refuse) throw held;
      },
    );
    const directory = fresh();
    const first = (await holdPool(install, directory, { ...options, directory })).unwrap();
    // the store closes as `databases.ts` closes one: its reference goes, and the pool is paused
    first.open -= 1;
    first.util.pauseVfs();
    calls.pause = 0;
    refuse = true;
    const woken = await holdPool(install, directory, { ...options, directory });
    expect(woken.isErr()).toBe(true);
    // the wake failed part-way; left as it is, the late handles stay held by this thread
    expect(calls.pause).toBe(1);
  });

  test("a give-back deferred behind an open that throws is said, and the next open still runs", async () => {
    const warned = spyOn(console, "warn").mockImplementation(() => {});
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { install } = fakePool(() => gate);
    const directory = fresh();
    const first = holdPool(install, directory, { ...options, directory });
    // lands while the open is under way, so it waits its turn behind it
    releaseWhenIdle(directory, () => {
      throw new Error("pauseVfs: a database is still open");
    });
    open();
    expect((await first).isOk()).toBe(true);
    expect((await holdPool(install, directory, { ...options, directory })).isOk()).toBe(true);
    const said = warned.mock.calls.map(([line]) => line);
    warned.mockRestore();
    expect(said).toEqual([`[syncmesh] the OPFS pool in ${directory} was not given back`]);
  });
});
