import { describe, expect, test } from "bun:test";

import { HEADER_BYTES, fragment, reassembler } from "../fragment.js";

const bytes = (n: number, seed = 1) =>
  Uint8Array.from({ length: n }, (_, i) => (i * seed + 7) % 251);
const cut = (frame: Uint8Array, limit: number, id = 1) => fragment(frame, limit, id).unwrap();

/** A frame through the wire and back, with the packets handed over however a test likes. */
const carry = (
  packets: readonly Uint8Array[],
  order: (p: readonly Uint8Array[]) => Uint8Array[],
) => {
  const rx = reassembler();
  let out: Uint8Array | undefined;
  for (const packet of order(packets)) out = rx.accept(packet) ?? out;
  return { out, pending: rx.pending() };
};

describe("fragmenting a frame", () => {
  test("a frame that fits still carries a header, so nothing has to be sniffed", () => {
    const packets = cut(bytes(10), 185);
    expect(packets).toHaveLength(1);
    expect(packets[0]?.length).toBe(HEADER_BYTES + 10);
  });

  test("every packet fits the limit the direction gave, and the last one is short", () => {
    const packets = cut(bytes(500), 185);
    expect(packets).toHaveLength(3); // 177 bytes of room each
    for (const p of packets) expect(p.length).toBeLessThanOrEqual(185);
    expect(packets.at(-1)?.length).toBeLessThan(185);
  });

  test("a limit with no room for a header is refused rather than sent as nothing", () => {
    expect(fragment(bytes(10), HEADER_BYTES, 1).isErr()).toBe(true);
    expect(fragment(bytes(10), 4, 1).isErr()).toBe(true);
  });

  test("an empty frame is one packet, not none — a frame was sent and one must arrive", () => {
    const packets = cut(new Uint8Array(0), 185);
    expect(packets).toHaveLength(1);
    expect(carry(packets, (p) => [...p]).out).toEqual(new Uint8Array(0));
  });
});

describe("reassembling", () => {
  test("in order, and out of order, give the same frame", () => {
    const frame = bytes(1000, 3);
    const packets = cut(frame, 185);
    expect(carry(packets, (p) => [...p]).out).toEqual(frame);
    expect(carry(packets, (p) => [...p].reverse()).out).toEqual(frame);
    expect(carry(packets, (p) => [p[2]!, p[0]!, p[5]!, p[1]!, p[4]!, p[3]!]).out).toEqual(frame);
  });

  test("a duplicate fragment changes nothing — a radio that repeats itself is ordinary", () => {
    const frame = bytes(400, 5);
    const packets = cut(frame, 185);
    const doubled = [packets[0]!, packets[0]!, packets[1]!, packets[2]!, packets[2]!];
    expect(carry(doubled, (p) => [...p]).out).toEqual(frame);
  });

  test("a missing fragment yields no frame at all, and never half of one", () => {
    const packets = cut(bytes(1000, 7), 185);
    const { out, pending } = carry(packets.slice(0, -1), (p) => [...p]);
    // the frame never arrives, so nothing folds it, the cursor does not move, and anti-entropy
    // asks again — a gap that heals, as against half a frame, which two peers could disagree on
    expect(out).toBeUndefined();
    expect(pending).toBe(1);
  });

  test("two frames interleaved on one link stay apart", () => {
    const a = bytes(600, 11);
    const b = bytes(600, 13);
    const pa = cut(a, 185, 1);
    const pb = cut(b, 185, 2);
    const rx = reassembler();
    const done: Uint8Array[] = [];
    for (const packet of [pa[0]!, pb[0]!, pa[1]!, pb[1]!, pb[2]!, pa[2]!, pa[3]!, pb[3]!]) {
      const frame = rx.accept(packet);
      if (frame !== undefined) done.push(frame);
    }
    expect(done).toHaveLength(2);
    expect(done).toContainEqual(a);
    expect(done).toContainEqual(b);
  });

  test("a truncated packet is ignored, not read as a header", () => {
    const rx = reassembler();
    expect(rx.accept(new Uint8Array(3))).toBeUndefined();
    expect(rx.pending()).toBe(0);
  });

  test("the assembly table is bounded, and says which message it gave up on", () => {
    const abandoned: { message: number; why: string }[] = [];
    const rx = reassembler({
      maxAssemblies: 2,
      onAbandoned: (m, _b, why) => void abandoned.push({ message: m, why }),
    });
    // three messages, each one fragment short of complete
    for (const id of [1, 2, 3]) rx.accept(cut(bytes(400), 185, id)[0]!);
    expect(abandoned).toEqual([{ message: 1, why: "evicted" }]);
    expect(rx.pending()).toBe(2);
  });

  test("a message past the size cap is dropped loudly rather than held forever", () => {
    const abandoned: string[] = [];
    const rx = reassembler({
      maxMessageBytes: 300,
      onAbandoned: (_m, _b, why) => void abandoned.push(why),
    });
    for (const packet of cut(bytes(1000), 185)) rx.accept(packet);
    expect(abandoned).toEqual(["too-large"]);
    expect(rx.pending()).toBe(0);
  });

  test("a sender whose counter wrapped onto a partial does not corrupt the newer message", () => {
    const rx = reassembler();
    rx.accept(cut(bytes(1000), 185, 42)[0]!); // a partial under id 42
    const fresh = bytes(300, 17);
    // the same id again, a different message: the newer one is the live one and completes
    for (const packet of cut(fresh, 185, 42)) {
      const out = rx.accept(packet);
      if (out !== undefined) expect(out).toEqual(fresh);
    }
    expect(rx.pending()).toBe(0);
  });
});
