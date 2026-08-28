import type { Change, SyncEvent } from "@syncmesh/kernel";

import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";

import { decodeEventCore, encodeEventCore } from "../event-codec.js";
import { bytesEqual, bytesToHex, hexToBytes } from "../hex.js";
import { column, event, key, row, table } from "./fixtures.js";

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

  test("json and blob cells round-trip: nested objects, arrays, bytes", () => {
    const e = event([
      {
        kind: "insert",
        table: NOTES,
        key: K,
        row: row({
          meta: { tags: ["a", "b"], pinned: true, n: { deep: null } },
          list: [1, "x", [false]],
          cover: Uint8Array.of(1, 2, 3),
        }),
      },
    ]);
    const core = encodeEventCore(e);
    const decoded = decodeEventCore(core).unwrap();
    expect(plain(decoded)).toEqual(plain(e));
    expect(bytesEqual(encodeEventCore(decoded), core)).toBe(true);
    const nestedBytes = hexToBytes(
      bytesToHex(core).replace(
        "636f766572" + "430102 03".replace(" ", ""),
        "636f766572" + "8143010203",
      ),
    ).unwrap();
    expect(decodeEventCore(nestedBytes).isErr()).toBe(true);
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
    // `-0` is deliberately not round-tripped as itself — see the canonicalisation test below
    fc.double({ noNaN: true, noDefaultInfinity: true }).map((n) => (Object.is(n, -0) ? 0 : n)),
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

  test("negative zero canonicalises to zero, because a canonical encoding has one of them", () => {
    // the two zeroes are the same number, so an encoding that kept them apart would give one
    // value two byte sequences — the one thing canonical CBOR exists to rule out
    const negative = event([{ kind: "insert", table: NOTES, key: K, row: row({ n: -0 }) }]);
    const positive = event([{ kind: "insert", table: NOTES, key: K, row: row({ n: 0 }) }]);
    expect(bytesEqual(encodeEventCore(negative), encodeEventCore(positive))).toBe(true);

    // it comes back as `0`, and re-encodes to the same bytes: the value moves once, never again
    const core = encodeEventCore(negative);
    const decoded = decodeEventCore(core).unwrap();
    expect(bytesEqual(encodeEventCore(decoded), core)).toBe(true);
    const change = decoded.changes[0];
    const back = change?.kind === "insert" ? change.row.get(column("n")) : undefined;
    expect(Object.is(back, 0)).toBe(true); // `0`, not `-0`: the value moves once, never again
  });

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
