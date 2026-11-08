import type { Transport } from "@syncmesh/transport";

import { createMemoryEventStore } from "@syncmesh/engine";
import { CATALOG, gatedPeer, holds, writeCatalog } from "@syncmesh/transport/test-fixtures";
import { afterEach, describe, expect, test } from "bun:test";

import type { RelayRoom } from "../room.js";

import { relayTransport } from "../transport.js";
import { dialTo, openRoom, until } from "./fixtures.js";

const running: Transport[] = [];
afterEach(async () => {
  for (const t of running.splice(0)) await t.stop();
});

/** A dial that follows whichever room is current — a relay restarted under the same URL. */
const following = (initial: RelayRoom) => {
  let current = dialTo(initial);
  return {
    dial: () => current.dial(),
    move: (room: RelayRoom) => void (current = dialTo(room)),
  };
};

const attach = async (
  p: ReturnType<typeof gatedPeer>,
  dial: Parameters<typeof relayTransport>[0]["dial"],
) => {
  const transport = relayTransport({ dial, reconnectMs: 10, maxReconnectMs: 20 });
  running.push(transport);
  await transport.start(p.context);
  await transport.caughtUp?.();
  return transport;
};

/** The capability every relay transport declares; a test that finds none has found a bug. */
const visibilityOf = (t: Transport) => {
  if (t.visibility === undefined) throw new Error("a relay transport declares visibility");
  return t.visibility;
};

describe("visibility over a relay (RFC-0020 §3.2)", () => {
  test("the relay transport declares both out-of-band capabilities", () => {
    const transport = relayTransport({ dial: () => Promise.reject(new Error("never dialled")) });
    expect(transport.visibility).toBeDefined();
    expect(transport.blobs).toBeDefined();
  });

  test("a writer's token is reached by a reader once the write is folded there", async () => {
    const room = await openRoom();
    const writer = gatedPeer(7);
    const reader = gatedPeer(41);
    const w = await attach(writer, dialTo(room).dial);
    const r = await attach(reader, dialTo(room).dial);

    await writeCatalog(writer, "c1", "aspirin");
    // the ack names where the room put it; that position is what the writer hands over
    expect(await until(() => (visibilityOf(w).token()?.offset ?? 0) >= 1)).toBe(true);
    const token = visibilityOf(w).token();
    if (token === undefined) throw new Error("no token after an ack");
    expect(token.epoch).toBe(room.epoch);

    const reached = await visibilityOf(r).visibleAt(token);
    expect(reached.isOk()).toBe(true);
    // settled is readable: the wait ended behind the fold, not beside it
    expect(holds(reader, CATALOG, "c1")).toBe(true);
    room.close();
  });

  test("a catch-up over several pages settles a wait only once its last page is folded", async () => {
    const room = await openRoom({ pageSize: 2 });
    const writer = gatedPeer(7);
    await attach(writer, dialTo(room).dial);
    for (let i = 0; i < 9; i += 1) await writeCatalog(writer, `c${i}`, "row");
    expect(await until(() => room.offset() === 9)).toBe(true);

    // every page carries the room's tail, so a wait that settled on the first would claim rows
    // the later pages have not delivered yet
    const reader = gatedPeer(41);
    const transport = relayTransport({ dial: dialTo(room).dial, reconnectMs: 10 });
    running.push(transport);
    const waited = visibilityOf(transport).visibleAt({ epoch: room.epoch, offset: 9 });
    await transport.start(reader.context);
    expect((await waited).isOk()).toBe(true);
    expect(holds(reader, CATALOG, "c8")).toBe(true);
    room.close();
  });

  test("a lineage change while a waiter is pending settles it Lost, naming both logs", async () => {
    const first = await openRoom({ epoch: "epoch-1" });
    const reader = gatedPeer(41);
    const route = following(first);
    const r = await attach(reader, route.dial);

    // a position the first log never reaches: the waiter is still waiting when the log goes away
    const pending = visibilityOf(r).visibleAt(
      { epoch: "epoch-1", offset: 999 },
      { timeoutMs: 5000 },
    );
    const second = await openRoom({ epoch: "epoch-2", store: createMemoryEventStore() });
    route.move(second);
    first.close();

    const outcome = await pending;
    expect(outcome.isErr()).toBe(true);
    if (outcome.isOk()) return;
    expect(outcome.error._tag).toBe("VisibilityLost");
    if (outcome.error._tag !== "VisibilityLost") return;
    expect(outcome.error.expected).toBe("epoch-1");
    expect(outcome.error.actual).toBe("epoch-2");
    // and a token minted against the old log is Lost at once from now on, not a ten-second wait
    const late = await visibilityOf(r).visibleAt({ epoch: "epoch-1", offset: 1 });
    expect(late.isErr() && late.error._tag).toBe("VisibilityLost");
    second.close();
  });

  test("a deadline that passes first is a timeout, and the write is untouched", async () => {
    const room = await openRoom();
    const reader = gatedPeer(41);
    const r = await attach(reader, dialTo(room).dial);
    const outcome = await visibilityOf(r).visibleAt(
      { epoch: room.epoch, offset: 50 },
      { timeoutMs: 30 },
    );
    expect(outcome.isErr() && outcome.error._tag).toBe("VisibilityTimeout");
    room.close();
  });
});
