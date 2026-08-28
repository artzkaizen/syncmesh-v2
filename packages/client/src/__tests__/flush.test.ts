import type { Transport } from "@syncmesh/transport";

import { defineSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { settleAll } from "../flush.js";
import { createMesh } from "../mesh.js";

const schema = () =>
  defineSchema({
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

const DEVICE = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 90 + i)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);

/** A transport whose queue we hold open, so "still saving" is a state a test can be in. */
const held = (name: string) => {
  const log: string[] = [];
  let release = (): void => undefined;
  const outstanding = new Promise<void>((resolve) => (release = resolve));
  const transport: Transport = {
    name,
    start: () => Promise.resolve(),
    whenReady: () => Promise.resolve(),
    flush: async () => {
      log.push(`${name}:flush`);
      await outstanding;
      log.push(`${name}:saved`);
    },
    stop: () => {
      log.push(`${name}:stop`);
      return Promise.resolve();
    },
  };
  return { transport, log, release: () => release() };
};

const open = async (transports: readonly Transport[]) =>
  (
    await createMesh({
      driver: bunSqliteDriver(":memory:"),
      schema: schema(),
      identity: DEVICE,
      now: () => T0,
      transports,
    })
  ).unwrap();

describe("settleAll — capped, and never abandoning the queue", () => {
  test("a job that rejects costs its own turn and nobody else's", async () => {
    const ran: string[] = [];
    await settleAll(
      [
        () => {
          ran.push("a");
          return Promise.reject(new Error("the store is full"));
        },
        () => {
          ran.push("b");
          return Promise.resolve();
        },
      ],
      4,
    );
    expect(ran).toEqual(["a", "b"]);
  });

  test("never more than the cap in flight, and every job still runs", async () => {
    let live = 0;
    let peak = 0;
    const jobs = Array.from({ length: 12 }, () => async () => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((resolve) => setTimeout(resolve, 1));
      live -= 1;
    });
    let done = 0;
    await settleAll(
      jobs.map((job) => async () => {
        await job();
        done += 1;
      }),
      3,
    );
    expect(peak).toBeLessThanOrEqual(3);
    expect(done).toBe(12);
  });

  test("no jobs is not a stall", async () => {
    await settleAll([], 20);
  });
});

describe("mesh.flush", () => {
  test("awaits every transport's outstanding work, and settles when one of them fails", async () => {
    const one = held("one");
    const failing: Transport = {
      name: "failing",
      start: () => Promise.resolve(),
      whenReady: () => Promise.resolve(),
      flush: () => Promise.reject(new Error("the state store rejected the commit")),
      stop: () => Promise.resolve(),
    };
    const mesh = await open([one.transport, failing]);

    let settled = false;
    const flushing = mesh.flush().then(() => void (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false); // one transport is still saving
    one.release();
    await flushing;
    expect(settled).toBe(true); // and the other's failure did not take the flush down with it
    expect(one.log).toEqual(["one:flush", "one:saved"]);
    await mesh.stop();
  });

  test("a transport that keeps no queue is not asked, and never wedges the flush", async () => {
    const bare: Transport = {
      name: "radio",
      start: () => Promise.resolve(),
      whenReady: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    };
    const mesh = await open([bare]);
    await mesh.flush();
    await mesh.stop();
  });

  test("stop flushes before it closes the medium the work arrived on", async () => {
    const one = held("one");
    const mesh = await open([one.transport]);
    const stopping = mesh.stop();
    await Promise.resolve();
    expect(one.log).toEqual(["one:flush"]); // the socket is still open while the fold lands
    one.release();
    await stopping;
    expect(one.log).toEqual(["one:flush", "one:saved", "one:stop"]);
  });
});
