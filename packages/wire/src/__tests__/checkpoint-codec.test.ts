import {
  hlcOf,
  parseAdapterId,
  parseLineageId,
  parsePeerId,
  parseSeqNum,
  type PeerId,
  type SeqNum,
} from "@syncmesh/kernel";
import { describe, expect, test } from "bun:test";

import type { CborKey, CborValue } from "../cbor.js";

import { decodeCbor } from "../cbor-decode.js";
import { encodeCbor } from "../cbor.js";
import {
  decodeCheckpoint,
  decodeCheckpointCore,
  encodeCheckpointCore,
  signCheckpoint,
  type DocCheckpoint,
} from "../checkpoint-codec.js";
import { bytesEqual, hexToBytes } from "../hex.js";
import { IDENTITY_A, IDENTITY_B, column, key, row, table } from "./fixtures.js";

const covers = (...pairs: readonly (readonly [string, number])[]): ReadonlyMap<PeerId, SeqNum> =>
  new Map(pairs.map(([p, s]) => [parsePeerId(p).unwrap(), parseSeqNum(s).unwrap()]));

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

const coreOf = (checkpoint: DocCheckpoint) =>
  asMap(decodeCbor(encodeCheckpointCore(checkpoint)).unwrap());

const CHECKPOINT: DocCheckpoint = {
  table: table("notes"),
  key: key("n1"),
  column: column("content"),
  adapter: parseAdapterId("loro@1").unwrap(),
  lineage: parseLineageId("0f".repeat(16)).unwrap(),
  covers: covers([IDENTITY_B.peerId, 9], [IDENTITY_A.peerId, 41]),
  version: Uint8Array.of(1, 2, 3),
  snapshot: { hash: "cd".repeat(32), size: 12_345 },
  derived: row({ title: "Q3", wordCount: 812 }),
  at: hlcOf(1_700_000_000_000, 2),
};

describe("DocCheckpoint (RFC-0023 §5.5)", () => {
  test("signs and decodes back to itself; the core re-encodes byte for byte", () => {
    const signed = signCheckpoint(CHECKPOINT, IDENTITY_A);
    const back = decodeCheckpoint(signed.wire, IDENTITY_A.peerId).unwrap();
    expect(back.checkpoint).toEqual(CHECKPOINT);
    expect(bytesEqual(encodeCheckpointCore(back.checkpoint), signed.core)).toBe(true);
  });

  test("the root lineage is an absent key, not an empty one", () => {
    const { lineage: _dropped, ...root } = CHECKPOINT;
    expect(coreOf(root).has(4)).toBe(false);
    expect(decodeCheckpointCore(encodeCheckpointCore(root)).unwrap()).toEqual(root);
  });

  test("covers travel as [peer, seq] pairs in ascending peer order, whatever order they were built in", () => {
    const peers = asArray(coreOf(CHECKPOINT).get(5)).map((pair) => asArray(pair)[0]);
    expect(peers.map((p) => (p instanceof Uint8Array ? [...p].join() : ""))).toEqual(
      [IDENTITY_A.peerId, IDENTITY_B.peerId].sort().map((p) => [...hexToBytes(p).unwrap()].join()),
    );
  });

  test("another producer's key, or one flipped byte, is refused", () => {
    const signed = signCheckpoint(CHECKPOINT, IDENTITY_A);
    expect(decodeCheckpoint(signed.wire, IDENTITY_B.peerId).isErr()).toBe(true);
    const flipped = Uint8Array.from(signed.core);
    flipped[flipped.length - 1] = (flipped.at(-1) ?? 0) ^ 1;
    const forged = encodeCbor([flipped, signed.sig]);
    expect(decodeCheckpoint(forged, IDENTITY_A.peerId).isErr()).toBe(true);
  });

  test("covers out of order or repeated are malformed — one covers, one encoding", () => {
    const core = coreOf(CHECKPOINT);
    const pairs = asArray(core.get(5));
    const [first, second] = pairs;
    if (first === undefined || second === undefined) throw new Error("two covers");
    for (const bad of [
      [second, first],
      [first, first],
    ]) {
      const edited = encodeCbor(new Map(core).set(5, bad));
      expect(decodeCheckpointCore(edited).isErr()).toBe(true);
    }
  });

  test("a snapshot is always a blob ref, never inline bytes", () => {
    const inline = encodeCbor(coreOf(CHECKPOINT).set(7, Uint8Array.of(1)));
    expect(decodeCheckpointCore(inline).isErr()).toBe(true);
  });
});
