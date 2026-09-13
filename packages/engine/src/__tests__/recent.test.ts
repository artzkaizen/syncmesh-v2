import type { EventId } from "@syncmesh/kernel";

import { compareHlc } from "@syncmesh/kernel";
import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";

import { CREATE, NOTES, PEER_B, key, row, setup } from "./fixtures.js";

/**
 * Reading the log as a log (gap 1).
 *
 * The claims worth holding are the three `eventsSince` cannot make: newest first, bounded and
 * pageable, and local writes included. The fourth is the type — a header carries the shape of an
 * event and none of its contents — and it is asserted here rather than trusted, because the whole
 * protection is that a core cannot reach a screen by accident.
 */

/** Five writes a millisecond apart, the middle one local, so the order is knowable by hand. */
const written = async () => {
  const { engine, clock } = setup();
  const ids: EventId[] = [];
  for (let n = 0; n < 5; n += 1) {
    clock.set(100 + n);
    const made = await engine.mutate(
      CREATE,
      (tx) => tx.insert(NOTES, key(`n${String(n)}`), row({ body: `note ${String(n)}` })),
      n === 2 ? { local: true } : {},
    );
    ids.push(made.unwrap().id);
  }
  return { engine, ids };
};

describe("recentEvents — the log's tail, as headers", () => {
  test("newest first, and the local write is in it", async () => {
    const { engine, ids } = await written();
    const page = (await engine.recentEvents()).unwrap();

    expect(page.map((header) => header.id)).toEqual([...ids].reverse());
    // the write that never left is here, and its own sequence namespace shows on the header
    expect(page.filter((header) => header.local).map((header) => header.id)).toEqual([ids[2]!]);
  });

  test("which is exactly what eventsSince cannot answer", async () => {
    const { engine, ids } = await written();
    const synced = (await engine.eventsSince(new Map())).unwrap();

    // anti-entropy's read: no local event, and ordered by author and sequence rather than by time
    expect(synced.map((entry) => entry.event.id)).toEqual(ids.filter((_, n) => n !== 2));
  });

  test("a header names the event and carries none of it", async () => {
    const { engine } = await written();
    const [newest] = (await engine.recentEvents({ limit: 1 })).unwrap();

    expect(newest?.tables).toEqual([NOTES]);
    expect(newest?.bytes).toBeGreaterThan(0);
    expect(newest?.partition).toBeUndefined();
    // the point of the type: there is nothing here to decode back into somebody's row
    expect(Object.keys(newest ?? {}).sort()).toEqual([
      "bytes",
      "hlc",
      "id",
      "local",
      "partition",
      "peer",
      "seq",
      "tables",
    ]);
  });

  test("a limit bounds it and `before` walks it, without repeating or skipping", async () => {
    const { engine, ids } = await written();
    const first = (await engine.recentEvents({ limit: 2 })).unwrap();
    const last = first.at(-1);
    const second = (await engine.recentEvents({ limit: 2, before: last!.hlc })).unwrap();

    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    // strictly below the cursor, so the two pages meet without an overlap
    expect(compareHlc(second[0]!.hlc, last!.hlc)).toBe(-1);
    expect([...first, ...second].map((header) => header.id)).toEqual(
      [...ids].reverse().slice(0, 4),
    );
  });

  test("paging off the end of the log stops rather than wrapping", async () => {
    const { engine } = await written();
    const all = (await engine.recentEvents({ limit: 100 })).unwrap();
    const past = (await engine.recentEvents({ before: all.at(-1)!.hlc })).unwrap();

    expect(all).toHaveLength(5);
    expect(past).toEqual([]);
  });

  test("a fresh log has a tail, and it is empty", async () => {
    const { engine } = setup();
    expect((await engine.recentEvents()).unwrap()).toEqual([]);
  });
});

describe("acksAt — the freshness acks() drops", () => {
  test("carries the time the peer said it, which `acks` does not", async () => {
    const { engine } = await written();
    const at = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);

    engine.acknowledge(PEER_B, new Map(), at);

    expect(engine.acksAt().get(PEER_B)?.at.equals(at)).toBe(true);
    expect(engine.acksAt().get(PEER_B)?.cursors).toEqual(new Map());
    // the same answer without the stamp, for the sweeps that never wanted it
    expect(engine.acks().get(PEER_B)).toEqual(new Map());
  });
});
