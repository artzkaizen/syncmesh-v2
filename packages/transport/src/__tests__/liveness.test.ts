import { describe, expect, test } from "bun:test";

import type { ByteStream } from "../framing.js";

import { createLiveness } from "../liveness.js";

/** A stream a test drives by hand: what it was handed, and what it hands up. */
const stream = () => {
  const written: Uint8Array[] = [];
  const readers = new Set<(bytes: Uint8Array) => void>();
  const raw: ByteStream = {
    write: (bytes) => void written.push(bytes),
    onData: (cb) => {
      readers.add(cb);
      return () => void readers.delete(cb);
    },
    onClose: () => () => undefined,
    close: () => undefined,
  };
  return { raw, written, arrive: (bytes: Uint8Array) => readers.forEach((cb) => cb(bytes)) };
};

/**
 * A keepalive of 20ms, so a case can wait a deadline out.
 *
 * On a real clock rather than an injected one, deliberately: the unit's whole job is done by a
 * timer, and a test that moved a number instead would pass with the timer never armed.
 */
const EVERY_MS = 20;
/** Past `EVERY_MS * SILENCE_FACTOR`, with room for a slow runner. */
const PAST_THE_DEADLINE_MS = 120;

const after = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const watching = () => {
  const probed: string[] = [];
  const dead: string[] = [];
  const liveness = createLiveness<string>({
    everyMs: EVERY_MS,
    probe: () => void probed.push("prod"),
    dead: (link) => void dead.push(link),
  });
  return { liveness, probed, dead };
};

describe("a link on a medium that does not report its endings", () => {
  test("goes quiet, is prodded, and is given up on when the prod brings nothing back", async () => {
    const watched = watching();
    watched.liveness.watch("one", stream().raw);

    await after(PAST_THE_DEADLINE_MS);
    expect(watched.probed.length).toBeGreaterThan(0);
    expect(watched.dead).toEqual(["one"]);
    watched.liveness.stop();
  });

  test("a frame arriving is the answer: the deadline starts again and nothing is given up on", async () => {
    const wire = stream();
    const watched = watching();
    const seen: Uint8Array[] = [];
    watched.liveness.watch("one", wire.raw).onData((bytes) => void seen.push(bytes));

    for (let round = 0; round < 8; round += 1) {
      await after(EVERY_MS);
      wire.arrive(Uint8Array.of(round));
    }
    expect(watched.dead).toEqual([]);
    // and the bytes still reach the reader: watching a link must not be a way to swallow one
    expect(seen).toHaveLength(8);
    watched.liveness.stop();
  });

  test("what it wraps is still the stream underneath, writes and all", () => {
    const wire = stream();
    const watched = watching();
    watched.liveness.watch("one", wire.raw).write(Uint8Array.of(7));
    expect(wire.written).toEqual([Uint8Array.of(7)]);
    watched.liveness.stop();
  });

  test("a link that ended is not one to hang up on later", async () => {
    const watched = watching();
    watched.liveness.watch("one", stream().raw);
    watched.liveness.forget("one");

    await after(PAST_THE_DEADLINE_MS);
    expect(watched.dead).toEqual([]);
    expect(watched.probed).toEqual([]);
  });
});
