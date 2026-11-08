import type { Transport } from "@syncmesh/transport";

import { createMemoryEventStore } from "@syncmesh/engine";
import { relayTransport, startRelay, webSocketDial } from "@syncmesh/relay";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { AUTHORITY, gatedSchema, writeConsult } from "@syncmesh/transport/test-fixtures";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMesh } from "../mesh.js";
import { sqlite } from "../options.js";

const meshOver = async (transports: readonly Transport[]) =>
  (
    await createMesh({
      schema: gatedSchema,
      identity: AUTHORITY,
      transports: [...transports],
      storage: sqlite({ driver: bunSqliteDriver(":memory:") }),
      trust: { authority: AUTHORITY.peerId },
    })
  ).unwrap();

/** Whether the promise has settled within `ms`. */
const settlesWithin = async (promise: Promise<unknown>, ms: number): Promise<boolean> => {
  let done = false;
  void promise.then(() => (done = true));
  const end = Date.now() + ms;
  while (Date.now() < end && !done) await new Promise((resolve) => setTimeout(resolve, 15));
  return done;
};

describe("mesh.synced (D42)", () => {
  test("a mesh with no transport declaring durable answers NoSuchCapability, never a wait", async () => {
    const mesh = await meshOver([]);
    const event = (await writeConsult(mesh, "x", "a")).unwrap();
    const answer = await mesh.synced({ event: event.id });
    expect(answer.isErr() && answer.error._tag).toBe("NoSuchCapability");
    expect(answer.isErr() && answer.error.capability).toBe("durable");
    await mesh.stop();
  });

  test("through startRelay's durable default: settles on the room's ack, and the relay is no peer", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "syncmesh-synced-"));
    const relay = await startRelay(0, { keepaliveMs: 60_000, blobs: false, dataDir });
    const mesh = await meshOver([relayTransport({ dial: webSocketDial(relay.url) })]);
    await mesh.settled();

    const event = (await writeConsult(mesh, "x", "a")).unwrap();
    const answer = mesh.synced({ event: event.id });
    expect(await settlesWithin(answer, 5000)).toBe(true);
    expect((await answer).isOk()).toBe(true);
    // the acknowledgement map never learned of the relay: nothing in `peers` or the sync column moves
    expect([...mesh.engine.acks().keys()]).toEqual([]);

    await mesh.stop();
    await relay.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("a relay over a caller's memory store acks, and synced still waits: a restart would lose it", async () => {
    const relay = await startRelay(0, {
      keepaliveMs: 60_000,
      blobs: false,
      store: createMemoryEventStore(),
    });
    const mesh = await meshOver([relayTransport({ dial: webSocketDial(relay.url) })]);
    await mesh.settled();

    const event = (await writeConsult(mesh, "x", "a")).unwrap();
    // the room took it — its token moved — and that is still not durability
    expect(
      await settlesWithin(
        (async () => {
          while ((mesh.visibility.token().unwrapOr(undefined)?.offset ?? 0) < 1)
            await new Promise((resolve) => setTimeout(resolve, 15));
        })(),
        5000,
      ),
    ).toBe(true);
    expect(await settlesWithin(mesh.synced({ event: event.id }), 300)).toBe(false);

    await mesh.stop();
    await relay.stop();
  });
});
