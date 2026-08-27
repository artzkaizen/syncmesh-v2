import type { Result } from "@syncmesh/result";

import { describe, expect, test } from "bun:test";

import type { BrokenFeed, FeedHead } from "../feed.js";

import { GENESIS, advanceFeed, certifyFeed, chunkFrom, verifyChunk } from "../feed.js";
import { createIdentity } from "../identity.js";

const author = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 40 + i)).unwrap();
const impostor = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 90 + i)).unwrap();
const core = (n: number) => Uint8Array.from({ length: 16 }, (_, i) => (n * 7 + i) % 251);
const run = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => core(from + i));

/** The refusal a broken run gave, or `"ok"` when it verified. */
const tag = (r: Result<FeedHead, BrokenFeed>) => (r.isErr() ? r.error.message : "ok");

describe("the feed chain", () => {
  test("one signature carries a whole run, however long", () => {
    const chunk = chunkFrom(author, GENESIS, run(1, 200));
    const verified = verifyChunk(chunk, GENESIS);
    expect(verified.isOk()).toBe(true);
    expect(Number(verified.unwrap().seq)).toBe(200);
    // two hundred events, one certificate: that is the whole point over a slow radio
    expect(chunk.certificate.sig).toHaveLength(64);
  });

  test("a receiver continues from where it is, and the heads agree", () => {
    const first = chunkFrom(author, GENESIS, run(1, 5));
    const at = verifyChunk(first, GENESIS).unwrap();
    const second = chunkFrom(author, at, run(6, 9));
    const end = verifyChunk(second, at).unwrap();
    expect(Number(end.seq)).toBe(9);

    // and the same events in one run land on the same head: the chain is the events, not the runs
    const whole = chunkFrom(author, GENESIS, run(1, 9));
    expect(whole.certificate.head.hash).toEqual(end.hash);
  });

  test("changing any event anywhere in the run breaks it", () => {
    const chunk = chunkFrom(author, GENESIS, run(1, 10));
    for (const at of [0, 4, 9]) {
      const tampered = { ...chunk, cores: chunk.cores.map((c, i) => (i === at ? core(99) : c)) };
      expect(tag(verifyChunk(tampered, GENESIS))).toContain("does not lead to the certified head");
    }
  });

  test("dropping or reordering events breaks it too", () => {
    const chunk = chunkFrom(author, GENESIS, run(1, 10));
    const dropped = { ...chunk, cores: chunk.cores.filter((_, i) => i !== 3) };
    expect(tag(verifyChunk(dropped, GENESIS))).toContain("different position");
    const swapped = [...chunk.cores];
    // SAFETY: the run has ten cores, so both positions exist
    [swapped[2], swapped[3]] = [swapped[3] as Uint8Array, swapped[2] as Uint8Array];
    expect(tag(verifyChunk({ ...chunk, cores: swapped }, GENESIS))).toContain(
      "does not lead to the certified head",
    );
  });

  test("a certificate from another key does not carry this author's run", () => {
    const chunk = chunkFrom(author, GENESIS, run(1, 4));
    // the impostor certifies the very same head — and it is still not this feed
    const forged = { ...chunk, certificate: certifyFeed(impostor, chunk.certificate.head) };
    expect(tag(verifyChunk(forged, GENESIS))).toContain("names another author");

    // and a certificate whose signature was not made for its contents fails on its own
    const wrongHead = advanceFeed(chunk.certificate.head, core(1));
    const mismatched = { ...chunk, certificate: { ...chunk.certificate, head: wrongHead } };
    expect(tag(verifyChunk(mismatched, GENESIS))).toContain("different position");
  });

  test("a run that does not start where the receiver is, is refused rather than guessed at", () => {
    const first = chunkFrom(author, GENESIS, run(1, 5));
    const at = verifyChunk(first, GENESIS).unwrap();
    const skipped = chunkFrom(author, advanceFeed(at, core(6)), run(7, 8));
    expect(tag(verifyChunk(skipped, at))).toContain("this feed is at");
  });
});
