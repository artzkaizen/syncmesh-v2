import type { Ack } from "@syncmesh/engine";
import type { PeerId } from "@syncmesh/kernel";
import type { Transport } from "@syncmesh/transport";

import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";

import { createStaleWatch } from "../stale.js";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- brands the fixture builds whole */
const peer = (n: number): PeerId => String(n).padStart(64, "0") as PeerId;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const after = (ms: number) => T0.add({ milliseconds: ms });

/** A medium that names its links and can close one — the only kind a stale watch applies to. */
const medium = (name: string, links: number) => {
  const reached = new Set<PeerId>(Array.from({ length: links }, (_, i) => peer(i + 1)));
  const dropped: PeerId[] = [];
  const transport = {
    name,
    start: () => Promise.resolve(),
    whenReady: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    reaches: () => reached,
    drop: (target: PeerId) => {
      reached.delete(target);
      dropped.push(target);
    },
  } satisfies Transport;
  return { transport, reached, dropped };
};

describe("stale links — a quiet session told apart from a working one (E28)", () => {
  test("a peer heard within the window stays; one silent past it is dropped, once, with its name said", () => {
    const radio = medium("ble", 3);
    let now = T0;
    const acks = new Map<PeerId, Ack>();
    const said: string[] = [];
    const watch = createStaleWatch(
      () => [radio.transport],
      () => ({ acksAt: () => acks, now: () => now }),
      {
        after: Temporal.Duration.from({ seconds: 30 }),
        everyMs: 60_000,
        onStale: (p, t) => said.push(`${t}:${p.slice(-1)}`),
      },
    );
    // first sight dates every link; nothing is stale on the round that first sees it
    expect(watch.now()).toEqual([]);

    now = after(20_000);
    acks.set(peer(1), { cursors: new Map(), at: after(20_000) }); // 1 spoke
    expect(watch.now()).toEqual([]); // 20s: inside the window for everyone

    now = after(35_000);
    // 1 was heard at 20s (15s ago), 2 and 3 never since first sight (35s ago)
    expect(watch.now()).toEqual([peer(2), peer(3)]);
    expect(radio.dropped).toEqual([peer(2), peer(3)]);
    expect(said).toEqual(["ble:2", "ble:3"]);
    // dropped links are gone from the medium; nothing is dropped twice
    expect(watch.now()).toEqual([]);

    now = after(60_000);
    expect(watch.now()).toEqual([peer(1)]); // 40s since 1 last spoke
    watch.stop();
  });

  test("a peer that leaves and comes back is given a fresh window", () => {
    const radio = medium("ble", 1);
    let now = T0;
    const watch = createStaleWatch(
      () => [radio.transport],
      () => ({ acksAt: () => new Map(), now: () => now }),
      { after: Temporal.Duration.from({ seconds: 10 }), everyMs: 60_000 },
    );
    watch.now();
    now = after(5_000);
    radio.reached.delete(peer(1)); // walked out of range: the medium closed it
    watch.now();
    now = after(8_000);
    radio.reached.add(peer(1)); // back: first sight again at 8s
    expect(watch.now()).toEqual([]);
    now = after(17_000);
    expect(watch.now()).toEqual([]); // 9s since the return
    now = after(19_000);
    expect(watch.now()).toEqual([peer(1)]);
    watch.stop();
  });

  test("a medium that cannot name its links or close one is left alone", () => {
    const transport = {
      name: "relay",
      start: () => Promise.resolve(),
      whenReady: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    } satisfies Transport;
    let now = T0;
    const watch = createStaleWatch(
      () => [transport],
      () => ({ acksAt: () => new Map(), now: () => now }),
      { after: Temporal.Duration.from({ seconds: 1 }), everyMs: 60_000 },
    );
    now = after(60_000);
    expect(watch.now()).toEqual([]);
    watch.stop();
  });
});
