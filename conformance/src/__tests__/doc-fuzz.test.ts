import type { CborKey, CborValue } from "@syncmesh/wire";

import { createEngine, createMemoryEventStore } from "@syncmesh/engine";
import {
  createHlcClock,
  parsePeerId,
  readRow,
  type Change,
  type RowKey,
  type SyncEvent,
  type TableName,
} from "@syncmesh/kernel";
import { Temporal } from "@syncmesh/temporal";
import {
  bytesEqual,
  createIdentity,
  decodeAndVerify,
  decodeCbor,
  decodeEventCore,
  encodeCbor,
  hexToBytes,
  relayEnvelope,
} from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";

import raw from "../../doc-vectors.json" with { type: "json" };

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- the vector's own names */
const NOTES = "notes" as TableName;
const N1 = "n1" as RowKey;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

const RECEIVER = parsePeerId("b".repeat(64)).unwrap();
const AUTHOR_SEED = Uint8Array.from({ length: 32 }, (_, i) => 0x40 + i);
const author = createIdentity(AUTHOR_SEED).unwrap();

/** The frozen "insert and a genesis in one event", as the author sent it. */
const vector = raw.events[2];
if (vector === undefined) throw new Error("the frozen file has an insert+genesis event");
const pristineCore = hexToBytes(vector.coreHex).unwrap();
const pristineSig = hexToBytes(vector.sigHex).unwrap();
const pristine = encodeCbor([pristineCore, pristineSig]);

const receiver = () => {
  const store = createMemoryEventStore();
  const engine = createEngine({
    peerId: RECEIVER,
    clock: createHlcClock({ now: () => Temporal.Instant.fromEpochMilliseconds(100) }),
    store,
  });
  return { engine, store };
};

const asMap = (value: CborValue | undefined): Map<CborKey, CborValue> => {
  if (!(value instanceof Map)) throw new Error("expected a CBOR map");
  return new Map(value);
};

describe("fuzz with doc changes — the wire cannot throw, and garbage never reaches state", () => {
  test("500 garbage `data` maps under tag 6, validly signed: decoding is a value every time", async () => {
    const { engine, store } = receiver();
    const cell: fc.Arbitrary<CborValue> = fc.oneof(
      fc.string(),
      fc.integer(),
      fc.boolean(),
      fc.constant(null),
      fc.uint8Array({ maxLength: 40 }),
    );
    const data = fc.oneof(
      cell,
      fc
        .array(fc.tuple(fc.nat({ max: 8 }), cell), { maxLength: 7 })
        .map((entries) => new Map<CborKey, CborValue>(entries)),
    );
    const frames: Uint8Array[] = [];
    fc.assert(
      fc.property(data, fc.nat({ max: 1000 }), (garbage, seq) => {
        const base = asMap(decodeCbor(pristineCore).unwrap());
        const change = new Map<CborKey, CborValue>([
          [0, 6],
          [1, "notes"],
          [2, "n1"],
          [3, garbage],
        ]);
        const core = encodeCbor(base.set(2, seq + 1).set(7, [change]));
        const decoded = decodeEventCore(core);
        // a decode is a value either way; one that succeeds re-encodes to what it read
        if (decoded.isOk()) expect(decoded.value.changes[0]?.kind).toBe("doc");
        frames.push(encodeCbor([core, author.sign(core)]));
      }),
      { numRuns: 500, seed: 11 },
    );
    for (const frame of frames) {
      const r = decodeAndVerify(frame);
      if (r.isOk()) (await engine.receive({ event: r.value.event, sig: r.value.sig })).unwrap();
    }
    expect(readRow(engine.state(), NOTES, N1)).toBeUndefined();
    const held = (await store.all()).unwrap();
    for (const entry of held) expect(entry.event.changes.every((c) => c.kind === "doc")).toBe(true);
  });

  test("300 bit-flips and truncations of a doc frame: rejected unless byte-identical; the pristine frame still folds", async () => {
    const { engine, store } = receiver();
    const frames: Uint8Array[] = [];
    fc.assert(
      fc.property(
        fc.nat({ max: 10_000 }),
        fc.option(fc.nat({ max: pristine.length }), { nil: undefined }),
        (flip, truncateAt) => {
          const copy = Uint8Array.from(
            truncateAt === undefined ? pristine : pristine.subarray(0, truncateAt),
          );
          if (copy.length > 0) {
            const i = flip % copy.length;
            copy[i] = (copy[i] ?? 0) ^ (1 << (flip % 8));
          }
          frames.push(copy);
          const r = decodeAndVerify(copy);
          if (r.isOk()) expect(bytesEqual(r.value.wire, pristine)).toBe(true);
        },
      ),
      { numRuns: 300, seed: 13 },
    );
    for (const frame of frames) expect(decodeAndVerify(frame).isErr()).toBe(true);
    expect((await store.all()).unwrap()).toHaveLength(0);
    const ok = decodeAndVerify(pristine).unwrap();
    expect((await engine.receive({ event: ok.event, sig: ok.sig })).unwrap().folded).toBe(1);
    expect(readRow(engine.state(), NOTES, N1)).toBeDefined();
  });
});

/**
 * What a build from before RFC-0023 makes of an event: every change its decoder has no kind for
 * comes out as `unknown`, carrying the tag and the `data` value exactly as CBOR read them — the
 * base decoder's D22-A branch, reproduced over the same bytes.
 */
const decodeAsOldBuild = (core: Uint8Array): SyncEvent => {
  const event = decodeEventCore(core).unwrap();
  const rawChanges = asMap(decodeCbor(core).unwrap()).get(7);
  const changes: Change[] = event.changes.map((change, i) => {
    if (change.kind !== "doc") return change;
    const data = Array.isArray(rawChanges) ? asMap(rawChanges[i]).get(3) : undefined;
    return { kind: "unknown", tag: 6, table: change.table, key: change.key, data };
  });
  return { ...event, changes };
};

describe("an old build parks tag 6 (D22-A), and an upgrade replays it", () => {
  test("the whole event parks as unknown-kind, its insert included; the bytes relay unchanged", async () => {
    const { engine, store } = receiver();
    const old = decodeAsOldBuild(pristineCore);
    expect(old.changes.map((c) => c.kind)).toEqual(["insert", "unknown"]);
    const report = (
      await engine.receive({ event: old, core: pristineCore, sig: pristineSig })
    ).unwrap();
    expect(report).toEqual({ folded: 0, skipped: 0, quarantined: 1 });
    // retained whole, never half-applied: the insert beside the doc change did not fold either
    expect(readRow(engine.state(), NOTES, N1)).toBeUndefined();
    expect((await store.all()).unwrap()).toHaveLength(0);
    const [parked] = engine.quarantine();
    expect(parked?.reason).toBe("unknown-kind");
    expect(parked?.verdict.message).toContain("unknown(6)");
    // the cursor stops below it, and what it relays is what the author signed
    expect(engine.coverage().synced.get(author.peerId)).toBeUndefined();
    expect(parked === undefined ? undefined : relayEnvelope(parked.entry)).toEqual(pristine);

    // an upgrade: the same bytes, read by a build that knows tag 6
    const upgraded = decodeAndVerify(pristine).unwrap();
    const replay = (
      await engine.receive({ event: upgraded.event, core: upgraded.core, sig: upgraded.sig })
    ).unwrap();
    expect(replay.folded).toBe(1);
    expect(readRow(engine.state(), NOTES, N1)).toBeDefined();
  });
});
