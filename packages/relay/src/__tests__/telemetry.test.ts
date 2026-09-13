import type { TelemetryEvent } from "@syncmesh/engine";
import type { PeerId } from "@syncmesh/kernel";

import { createMemoryEventStore } from "@syncmesh/engine";
import { hashOf, memoryBlobStore } from "@syncmesh/storage";
import { eventFrame } from "@syncmesh/transport";
import { describe, expect, test } from "bun:test";

import type { RelayTelemetry } from "../telemetry.js";

import { blobGetFrame, blobPutFrame, joinFrame } from "../frames.js";
import { entryOf, fakeSocket, openRoom, peer, tick, write } from "./fixtures.js";

const join = (peerId: PeerId) => joinFrame([1], peerId, new Map());

/** The seam is typed over the whole union; a relay only ever emits its own prefix. */
const isRelay = (event: TelemetryEvent): event is RelayTelemetry => event.type.startsWith("relay.");

/** A room that keeps everything it reported, in order. */
const watched = async (overrides: Partial<Parameters<typeof openRoom>[0]> = {}) => {
  const seen: RelayTelemetry[] = [];
  const room = await openRoom(overrides);
  room.onTelemetry((event) => void (isRelay(event) && seen.push(event)));
  return { room, seen, of: (type: string) => seen.filter((e) => e.type === type) };
};

describe("what the relay reports (D17)", () => {
  test("join and catch-up, with the sizes that say how much work the handshake was", async () => {
    const a = peer(40, "acct_a");
    const { room, seen, of } = await watched();
    const sa = fakeSocket();
    const ca = room.connect(sa.socket);
    ca.receive(join(a.identity.peerId));
    await tick();
    ca.receive(eventFrame(await write(a, "n1", "one")));
    ca.receive(eventFrame(await write(a, "n2", "two")));
    await tick();

    const [joined] = of("relay.join");
    expect(joined?.sizes).toEqual({ cursors: 0, presence: 0 });
    const [caught] = of("relay.catchup");
    expect(caught?.sizes).toEqual({ found: 0, admitted: 0, unsendable: 0, pages: 1 }); // one page always
    expect(of("relay.event")).toHaveLength(2);
    expect(seen.every((e) => e.duration.sign >= 0)).toBe(true);
    room.close();
  });

  /**
   * **A relay serving history handed a joiner a run with a hole in it and reported nothing.**
   *
   * `paged` cannot build an envelope for an entry the log holds without a signature — nobody but
   * its author can sign it — so it leaves. Nothing downstream could tell: `found` is counted
   * before interest, `admitted` before the envelopes, `pages` counts frames, and the joiner sees
   * a page that is simply shorter than it would otherwise have been. The room's own cursors are
   * honest about it (see cursors.test.ts), which stops the joiner *stalling* but does not stop
   * the events being gone, and tells nobody.
   *
   * What the log ends up in that state is a device that rotated its key and kept its database.
   * The count is the operator-visible end of it; `Engine.stranded` is the device-visible end.
   */
  test("an entry with no envelope is counted, not quietly left out of the pages", async () => {
    const a = peer(40, "acct_a");
    const wires = [await write(a, "n1", "one"), await write(a, "n2", "two")];
    // SAFETY: the two writes above
    const [w1, w2] = wires as [Uint8Array, Uint8Array];
    const store = createMemoryEventStore();
    await store.append(entryOf(w1));
    // the shape a rotation leaves: the event, and no signature anybody here can replace
    await store.append({ event: entryOf(w2).event });

    const { room, of } = await watched({ store });
    const s = fakeSocket();
    room.connect(s.socket).receive(join(peer(41, "acct_b").identity.peerId));
    await tick();

    const [caught] = of("relay.catchup");
    expect(caught?.sizes).toEqual({ found: 2, admitted: 2, unsendable: 1, pages: 1 });
    expect(s.events()).toBe(1); // and the joiner really is one short
    room.close();
  });

  test("relay.event counts the sockets that took it, and never names them", async () => {
    const a = peer(40, "acct_a");
    const b = peer(80, "acct_b");
    const { room, of } = await watched();
    const ca = room.connect(fakeSocket().socket);
    ca.receive(join(a.identity.peerId));
    room.connect(fakeSocket().socket).receive(join(b.identity.peerId));
    await tick();

    const wire = await write(a, "n1", "one");
    ca.receive(eventFrame(wire));
    await tick();
    const [event] = of("relay.event");
    expect(event?.sizes).toEqual({ bytes: wire.byteLength, receivers: 1 }); // b, not a
    room.close();
  });

  test("a duplicate is not reported as an append", async () => {
    const a = peer(40, "acct_a");
    const { room, of } = await watched();
    const ca = room.connect(fakeSocket().socket);
    ca.receive(join(a.identity.peerId));
    await tick();
    const wire = await write(a, "n1", "one");
    ca.receive(eventFrame(wire));
    await tick();
    ca.receive(eventFrame(wire)); // the same bytes again
    await tick();

    expect(of("relay.event")).toHaveLength(1);
    expect(room.offset()).toBe(1);
    room.close();
  });

  test("blob put and get, with `bytes: 0` for the answer nobody could give", async () => {
    const a = peer(40, "acct_a");
    const bytes = Uint8Array.of(1, 2, 3, 4, 5);
    const { room, of } = await watched({ blobs: memoryBlobStore() });
    const ca = room.connect(fakeSocket().socket);
    ca.receive(join(a.identity.peerId));
    await tick();

    ca.receive(blobPutFrame(String(hashOf(bytes)), bytes));
    await tick();
    ca.receive(blobGetFrame(String(hashOf(bytes))));
    ca.receive(blobGetFrame("b3:not-a-hash-anyone-holds"));
    await tick();

    expect(of("relay.blob.put").map((e) => e.sizes)).toEqual([{ bytes: 5 }]);
    expect(of("relay.blob.get").map((e) => e.sizes)).toEqual([{ bytes: 5 }, { bytes: 0 }]);
    room.close();
  });
});

/**
 * D17 left "may relay telemetry carry peer identity" open. It does not, and this is the test that
 * keeps it that way: an identity never emitted can still be added, an identity that has reached a
 * metrics pipeline cannot be taken back out of it.
 */
describe("no relay variant carries identity", () => {
  test("every event is exactly type, sizes and duration, and holds no peer, room or payload", async () => {
    const a = peer(40, "acct_a");
    const { room, seen } = await watched({ name: "acme-payroll" });
    const ca = room.connect(fakeSocket().socket);
    ca.receive(join(a.identity.peerId));
    await tick();
    const wire = await write(a, "n1", "the body of the note");
    ca.receive(eventFrame(wire));
    await tick();

    expect(seen.length).toBeGreaterThan(0);
    for (const event of seen)
      expect(Object.keys(event).sort()).toEqual(["duration", "sizes", "type"]);
    const rendered = JSON.stringify(seen);
    expect(rendered).not.toContain(String(a.identity.peerId));
    expect(rendered).not.toContain("acme-payroll");
    expect(rendered).not.toContain("the body of the note");
    room.close();
  });
});

describe("a listener never affects correctness", () => {
  test("one that throws is dropped, and the room forwards exactly as it would have", async () => {
    const a = peer(40, "acct_a");
    const b = peer(80, "acct_b");
    const room = await openRoom({
      onTelemetry: () => {
        throw new Error("an observer misbehaving");
      },
    });
    const sa = fakeSocket();
    const sb = fakeSocket();
    const ca = room.connect(sa.socket);
    ca.receive(join(a.identity.peerId));
    room.connect(sb.socket).receive(join(b.identity.peerId));
    await tick();

    ca.receive(eventFrame(await write(a, "n1", "one")));
    await tick();
    expect(sb.ofKind("relayed")).toHaveLength(1);
    expect(sa.ofKind("ack")).toHaveLength(1);
    expect(room.offset()).toBe(1);
    room.close();
  });
});
