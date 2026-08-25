import type { Change, SyncEvent } from "@syncmesh/kernel";

import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";

import { decodeEventCore, encodeEventCore } from "../event-codec.js";
import { bytesEqual, bytesToHex, hexToBytes } from "../hex.js";
import { event, key, row, table } from "./fixtures.js";

const NOTES = table("notes");
const K = key("k1");

const sorted = (m: ReadonlyMap<string, unknown>) =>
  [...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
const plain = (e: SyncEvent) => ({
  ...e,
  hlc: [e.hlc[0].epochMilliseconds, e.hlc[1]],
  changes: e.changes.map((c) =>
    c.kind === "insert"
      ? { ...c, row: sorted(c.row) }
      : c.kind === "update"
        ? { ...c, patch: sorted(c.patch) }
        : c,
  ),
});

describe("encodeEventCore / decodeEventCore", () => {
  test("round-trips insert, update and delete; re-encoding is byte-identical", () => {
    const e = event([
      {
        kind: "insert",
        table: NOTES,
        key: K,
        row: row({ title: "héllo ✨", pinned: false, n: 3, body: "", nothing: null }),
      },
      { kind: "update", table: NOTES, key: K, patch: row({ title: "x" }) },
      { kind: "delete", table: NOTES, key: K },
    ]);
    const core = encodeEventCore(e);
    const decoded = decodeEventCore(core).unwrap();
    expect(plain(decoded)).toEqual(plain(e));
    expect(bytesEqual(encodeEventCore(decoded), core)).toBe(true);
  });

  test("partition is key 6 when present and absent bytes otherwise", () => {
    const without = encodeEventCore(event([]));
    const withP = encodeEventCore(event([], { partition: "org:acme" }));
    expect(bytesToHex(without)).toStartWith("a6");
    expect(bytesToHex(withP)).toStartWith("a7");
    expect(bytesToHex(withP)).toContain(
      "06" + "68" + bytesToHex(new TextEncoder().encode("org:acme")),
    );
    expect(decodeEventCore(without).unwrap().partition).toBeUndefined();
    expect(String(decodeEventCore(withP).unwrap().partition)).toBe("org:acme");
  });

  test("refuses v ≠ 1, wrong shapes and non-scalar cells as values; ignores unknown keys", () => {
    const good = encodeEventCore(
      event([{ kind: "insert", table: NOTES, key: K, row: row({ a: 1 }) }]),
    );
    const hex = bytesToHex(good);
    expect(decodeEventCore(hexToBytes(hex.replace(/^a60001/, "a60002")).unwrap()).isErr()).toBe(
      true,
    );
    for (const bad of ["a0", "80", "a600ff", "a6000101"])
      expect(decodeEventCore(hexToBytes(bad).unwrap()).isErr()).toBe(true);
    const withExtra = hexToBytes(hex.replace(/^a6/, "a7") + "18ff01").unwrap();
    expect(decodeEventCore(withExtra).isOk()).toBe(true);
  });

  const arbCell = fc.oneof(
    fc.string({ maxLength: 12 }),
    fc.integer(),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.boolean(),
    fc.constant(null),
  );
  const arbRow = fc
    .dictionary(fc.string({ minLength: 1, maxLength: 6 }), arbCell, { maxKeys: 4 })
    .map(row);
  const arbChange: fc.Arbitrary<Change> = fc.oneof(
    arbRow.map((r): Change => ({ kind: "insert", table: NOTES, key: K, row: r })),
    arbRow.map((r): Change => ({ kind: "update", table: NOTES, key: K, patch: r })),
    fc.constant<Change>({ kind: "delete", table: NOTES, key: K }),
  );
  const arbEvent = fc
    .tuple(
      fc.array(arbChange, { maxLength: 4 }),
      fc.integer({ min: 1, max: 1_000_000 }),
      fc.nat({ max: 2_000_000_000_000 }),
      fc.option(fc.stringMatching(/^[a-z]+:[a-z0-9]+$/), { nil: undefined }),
    )
    .map(([changes, seq, ms, partition]) =>
      event(changes, partition === undefined ? { seq, ms } : { seq, ms, partition }),
    );

  test("property: decode ∘ encode ≡ id with byte-identical re-encode", () => {
    fc.assert(
      fc.property(arbEvent, (e) => {
        const core = encodeEventCore(e);
        const decoded = decodeEventCore(core).unwrap();
        expect(plain(decoded)).toEqual(plain(e));
        expect(bytesEqual(encodeEventCore(decoded), core)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});
