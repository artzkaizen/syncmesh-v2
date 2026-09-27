import {
  parseActionId,
  parseAdapterId,
  parseLineageId,
  parseSeqNum,
  type DocChange,
  type SyncEvent,
} from "@syncmesh/kernel";
import { describe, expect, test } from "bun:test";

import type { CborKey, CborValue } from "../cbor.js";

import { decodeCbor } from "../cbor-decode.js";
import { encodeCbor } from "../cbor.js";
import { deriveLineage, docChangeId, DOC } from "../doc-codec.js";
import { decodeEventCore, encodeEventCore } from "../event-codec.js";
import { bytesEqual, bytesToHex } from "../hex.js";
import { IDENTITY_A, IDENTITY_B, column, event, key, table } from "./fixtures.js";

const NOTES = table("notes");
const K = key("k1");
const LORO = parseAdapterId("loro@1").unwrap();
const LINEAGE = parseLineageId("0f".repeat(16)).unwrap();
const ACTION = parseActionId("a1".repeat(16)).unwrap();
const UNDONE = parseActionId("b2".repeat(16)).unwrap();

const doc = (extra: Partial<DocChange> = {}): DocChange => ({
  kind: "doc",
  table: NOTES,
  key: K,
  column: column("content"),
  adapter: LORO,
  update: { bytes: Uint8Array.of(0xde, 0xad) },
  ...extra,
});

/** The CBOR value as a map, or a failed test: narrowed, never asserted. */
const asMap = (value: CborValue | undefined): Map<CborKey, CborValue> => {
  if (!(value instanceof Map)) throw new Error("expected a CBOR map");
  return new Map(value);
};

/** The CBOR value as an array, or a failed test. */
const asArray = (value: CborValue | undefined): readonly CborValue[] => {
  if (!Array.isArray(value)) throw new Error("expected a CBOR array");
  return value;
};

const roundTrip = (e: SyncEvent) => {
  const core = encodeEventCore(e);
  const decoded = decodeEventCore(core).unwrap();
  expect(bytesEqual(encodeEventCore(decoded), core)).toBe(true);
  return decoded;
};

/** The first change's `data` map with `edit` applied, re-encoded into an otherwise valid core. */
const withData = (edit: (data: Map<CborKey, CborValue>) => void) => {
  const core = asMap(decodeCbor(encodeEventCore(event([doc()]))).unwrap());
  const first = asMap(asArray(core.get(7))[0]);
  const data = asMap(first.get(3));
  edit(data);
  return encodeCbor(core.set(7, [first.set(3, data)]));
};

describe("a doc change on the wire (tag 6)", () => {
  test("inline, blob-carried and genesis changes round-trip byte for byte", () => {
    const changes = [
      doc(),
      doc({ lineage: LINEAGE }),
      doc({ update: { blob: { hash: "ab".repeat(32), size: 70_000 } } }),
      doc({ lineage: LINEAGE, genesis: true, update: { bytes: new Uint8Array(0) } }),
    ];
    const decoded = roundTrip(event(changes));
    expect(decoded.changes).toEqual(changes);
  });

  test("the change map keeps its frozen keys and tag 6", () => {
    const core = asMap(decodeCbor(encodeEventCore(event([doc({ lineage: LINEAGE })]))).unwrap());
    const change = asMap(asArray(core.get(7))[0]);
    expect(change.get(0)).toBe(6);
    expect([...asMap(change.get(3)).keys()].sort((a, b) => Number(a) - Number(b))).toEqual([
      DOC.column,
      DOC.adapter,
      DOC.lineage,
      DOC.bytes,
    ]);
  });

  test("unknown data keys are skipped, not refused (RFC-0002 invariant 4)", () => {
    const core = withData((data) => data.set(99, "from a newer build"));
    expect(decodeEventCore(core).unwrap().changes).toEqual([doc()]);
  });

  const refused: readonly [string, (data: Map<CborKey, CborValue>) => void][] = [
    ["no column", (d) => d.delete(DOC.column)],
    ["an empty column", (d) => d.set(DOC.column, "")],
    ["an adapter with no major", (d) => d.set(DOC.adapter, "loro")],
    ["both bytes and blob", (d) => d.set(DOC.blob, [new Uint8Array(32), 1])],
    ["neither bytes nor blob", (d) => d.delete(DOC.bytes)],
    [
      "a blob hash that is not 32 bytes",
      (d) => {
        d.delete(DOC.bytes);
        d.set(DOC.blob, [new Uint8Array(31), 1]);
      },
    ],
    ["a lineage that is not 16 bytes", (d) => d.set(DOC.lineage, new Uint8Array(15))],
    ["a genesis that is not true", (d) => d.set(DOC.genesis, false)],
    ["bytes that are text", (d) => d.set(DOC.bytes, "text")],
  ];
  for (const [what, edit] of refused)
    test(`refuses ${what}, as a value`, () => {
      expect(decodeEventCore(withData(edit)).isErr()).toBe(true);
    });

  test("tags 3, 4 and 5 are never reused: they still decode as unknown changes", () => {
    for (const tag of [3, 4, 5]) {
      const core = asMap(decodeCbor(encodeEventCore(event([doc()]))).unwrap());
      const change = asMap(asArray(core.get(7))[0]).set(0, tag);
      const reencoded = encodeCbor(core.set(7, [change]));
      const [decoded] = decodeEventCore(reencoded).unwrap().changes;
      expect(decoded?.kind).toBe("unknown");
      expect(bytesEqual(encodeEventCore(decodeEventCore(reencoded).unwrap()), reencoded)).toBe(
        true,
      );
    }
  });
});

describe("event keys 10 (action) and 11 (undoOf)", () => {
  test("round-trip, and are absent when the event has neither", () => {
    const decoded = roundTrip({ ...event([doc()]), action: ACTION, undoOf: UNDONE });
    expect(decoded.action).toBe(ACTION);
    expect(decoded.undoOf).toBe(UNDONE);
    const plain = roundTrip(event([doc()]));
    expect("action" in plain || "undoOf" in plain).toBe(false);
  });

  test("a value that is not 16 bytes is skipped, as an old build skips the key altogether", () => {
    const core = asMap(decodeCbor(encodeEventCore(event([doc()]))).unwrap());
    const odd = encodeCbor(core.set(10, new Uint8Array(15)).set(11, "not bytes"));
    const decoded = decodeEventCore(odd).unwrap();
    expect(decoded.action).toBeUndefined();
    expect(decoded.undoOf).toBeUndefined();
    expect(decoded.changes).toEqual([doc()]);
  });

  test("key 9 stays free: nothing here writes it", () => {
    const core = asMap(
      decodeCbor(encodeEventCore({ ...event([doc()]), action: ACTION, undoOf: UNDONE })).unwrap(),
    );
    expect([...core.keys()]).toEqual([0, 1, 2, 3, 5, 7, 10, 11]);
  });
});

describe("the lineage derivation (RFC-0023 §5.3)", () => {
  const seq = (n: number) => parseSeqNum(n).unwrap();

  test("a doc change id is the peer, a u64 sequence and a u32 index, big-endian", () => {
    const id = docChangeId(IDENTITY_A.peerId, seq(0x0102), 0x0304);
    expect(id).toHaveLength(44);
    expect(bytesToHex(id.subarray(32))).toBe("0000000000000102" + "00000304");
    expect(bytesToHex(id.subarray(0, 32))).toBe(IDENTITY_A.peerId);
  });

  test("is deterministic, and moves with the author, the sequence and the index", () => {
    const base = deriveLineage(IDENTITY_A.peerId, seq(7), 0);
    expect(base).toMatch(/^[0-9a-f]{32}$/);
    expect(deriveLineage(IDENTITY_A.peerId, seq(7), 0)).toBe(base);
    const others = [
      deriveLineage(IDENTITY_B.peerId, seq(7), 0),
      deriveLineage(IDENTITY_A.peerId, seq(8), 0),
      deriveLineage(IDENTITY_A.peerId, seq(7), 1),
    ];
    expect(new Set([base, ...others]).size).toBe(4);
  });
});
