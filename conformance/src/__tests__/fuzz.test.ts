import type {
  CellValue,
  Change,
  ColumnName,
  Row,
  RowKey,
  SyncEvent,
  TableName,
} from "@syncmesh/kernel";

import { createEngine, createMemoryEventStore } from "@syncmesh/engine";
import {
  createHlcClock,
  eventId,
  parsePeerId,
  parseSeqNum,
  readRow,
  type Procedure,
} from "@syncmesh/kernel";
import { Temporal } from "@syncmesh/temporal";
import { bytesEqual, createIdentity, decodeAndVerify, signEvent } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test fixtures for brands whose rules live in later epics */
const NOTES = "notes" as TableName;
const K1 = "k1" as RowKey;
const column = (s: string) => s as ColumnName;
const PROCEDURE = "notes.create" as Procedure;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

const author = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 7 * i + 1)).unwrap();
const RECEIVER = parsePeerId("b".repeat(64)).unwrap();
const at = (ms: number) => Temporal.Instant.fromEpochMilliseconds(ms);
const row = (values: Readonly<Record<string, CellValue>>): Row =>
  new Map(Object.entries(values).map(([name, value]) => [column(name), value]));

const authored = (seq: number, changes: readonly Change[]): SyncEvent => {
  const seqNum = parseSeqNum(seq).unwrap();
  return {
    v: 1,
    id: eventId(author.peerId, seqNum),
    peerId: author.peerId,
    seqNum,
    hlc: createHlcClock({ now: () => at(1_700_000_000_000 + seq) }).tick(),
    procedure: PROCEDURE,
    changes,
  };
};

const pristine = signEvent(
  authored(1, [{ kind: "insert", table: NOTES, key: K1, row: row({ title: "t", n: 1 }) }]),
  author,
);

const receiver = () => {
  const store = createMemoryEventStore();
  const engine = createEngine({
    peerId: RECEIVER,
    clock: createHlcClock({ now: () => at(100) }),
    store,
  });
  return { engine, store };
};

/** Feeds every frame through the real path: decode → verify → receive. Returns how many reached the engine. */
const feed = async (
  engine: ReturnType<typeof receiver>["engine"],
  frames: readonly Uint8Array[],
) => {
  let accepted = 0;
  for (const frame of frames) {
    const r = decodeAndVerify(frame);
    if (r.isOk()) {
      accepted++;
      (await engine.receive(r.value.event)).unwrap();
    }
  }
  return accepted;
};

describe("fuzz — the wire cannot throw, poison dedup, or touch state", () => {
  test("500 garbage frames: decodeAndVerify is a value every time and nothing reaches state", async () => {
    const { engine, store } = receiver();
    const frames: Uint8Array[] = [];
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 256 }), (bytes) => {
        frames.push(bytes);
        expect(decodeAndVerify(bytes).isErr()).toBe(true);
      }),
      { numRuns: 500, seed: 3 },
    );
    expect(await feed(engine, frames)).toBe(0);
    expect((await store.all()).unwrap()).toHaveLength(0);
    expect(readRow(engine.state(), NOTES, K1)).toBeUndefined();
  });

  test("300 bit-flips and truncations of a valid frame: rejected unless byte-identical; pristine bytes still apply afterwards", async () => {
    const { engine, store } = receiver();
    const frames: Uint8Array[] = [];
    const mutate = (flip: number, truncateAt: number | undefined) => {
      const copy = Uint8Array.from(
        truncateAt === undefined ? pristine.wire : pristine.wire.subarray(0, truncateAt),
      );
      if (copy.length > 0) {
        const i = flip % copy.length;
        copy[i] = (copy[i] ?? 0) ^ (1 << (flip % 8));
      }
      return copy;
    };
    fc.assert(
      fc.property(
        fc.nat({ max: 10_000 }),
        fc.option(fc.nat({ max: pristine.wire.length }), { nil: undefined }),
        (flip, truncateAt) => {
          const frame = mutate(flip, truncateAt);
          frames.push(frame);
          const r = decodeAndVerify(frame);
          if (r.isOk()) expect(bytesEqual(r.value.wire, pristine.wire)).toBe(true);
        },
      ),
      { numRuns: 300, seed: 7 },
    );
    const accepted = await feed(engine, frames);
    expect(accepted).toBe(0);
    expect((await store.all()).unwrap()).toHaveLength(0);

    const ok = decodeAndVerify(pristine.wire).unwrap();
    expect((await engine.receive(ok.event)).unwrap()).toEqual({ folded: 1, skipped: 0 });
    expect(readRow(engine.state(), NOTES, K1)).toEqual(row({ title: "t", n: 1 }));
  });

  test("a garbage frame carrying a valid-looking id cannot pre-empt the real event", async () => {
    const { engine } = receiver();
    const forged = signEvent(
      authored(1, [{ kind: "delete", table: NOTES, key: K1 }]),
      createIdentity(new Uint8Array(32).fill(9)).unwrap(),
    );
    const spliced = Uint8Array.from(forged.wire);
    spliced.set(pristine.core.subarray(0, 8), 2);
    expect(decodeAndVerify(spliced).isErr()).toBe(true);
    expect(
      (await engine.receive(decodeAndVerify(pristine.wire).unwrap().event)).unwrap().folded,
    ).toBe(1);
  });
});
