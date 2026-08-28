import type { PeerId, SeqNum } from "@syncmesh/kernel";

import { parsePartitionKey } from "@syncmesh/kernel";
import { bytesToHex, decodeCbor, encodeCbor, hexToBytes } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import {
  RELAY_PROTOCOL_VERSIONS,
  ackFrame,
  blobFrame,
  blobGetFrame,
  blobMissingFrame,
  blobPutFrame,
  decodeRelayFrame,
  errorFrame,
  helloFrame,
  joinFrame,
  kaFrame,
  pageFrame,
  relayedFrame,
  selectVersion,
} from "../frames.js";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test fixtures */
const PEER = bytesToHex(Uint8Array.from({ length: 32 }, (_, i) => i)) as PeerId;
const CURSORS = new Map([[PEER, 7 as SeqNum]]);
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */
const ACME = parsePartitionKey("org:acme").unwrap();
const GRANT = Uint8Array.of(0xa1, 0xb2, 0xc3);
const EVENT = Uint8Array.of(0x01, 0x02, 0x03, 0x04);
const BYTES = Uint8Array.of(0xde, 0xad, 0xbe, 0xef);
const HASH = "b3:0102";

/**
 * D14's vector, byte-frozen. These are the v1 relay control frames as this build emits them, and
 * an other-language port must produce these exact bytes. The vector is **additive**: a v2 may
 * only add tags above the ones pinned here, because the session frames and every peer already
 * speaking v1 are decoding by tag, and renumbering one is a silent mis-decode rather than an
 * error anybody sees.
 *
 * These belong in `conformance/` alongside the wire, grant and account vectors; they are here
 * because that directory was outside this change's reach.
 */
const VECTORS = [
  {
    description: "join, one version, one cursor, no interest",
    tag: 8,
    wire: () => joinFrame([1], PEER, CURSORS),
    wireHex:
      "850881015820000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f81825820000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f0760",
  },
  {
    description: "join, two versions offered, an interest in one partition",
    tag: 8,
    wire: () => joinFrame([1, 2], PEER, CURSORS, { partitions: [ACME] }),
    wireHex:
      "85088201025820000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f81825820000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f07781b7b22706172746974696f6e73223a5b226f72673a61636d65225d7d",
  },
  {
    description: "hello, the selected version",
    tag: 9,
    wire: () => helloFrame(1, 15_000, "epoch-1", CURSORS),
    wireHex:
      "850901193a986765706f63682d3181825820000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f07",
  },
  {
    description: "error, the typed version refusal",
    tag: 10,
    wire: () => errorFrame("version", "this relay speaks 1"),
    wireHex: "830a6776657273696f6e73746869732072656c617920737065616b732031",
  },
  { description: "ka", tag: 11, wire: () => kaFrame(), wireHex: "810b" },
  { description: "ack", tag: 12, wire: () => ackFrame("evt-1", 3), wireHex: "830c656576742d3103" },
  {
    description: "page, grants on the first, more to come",
    tag: 13,
    wire: () => pageFrame([GRANT], [EVENT], true, 9),
    wireHex: "850d8143a1b2c38144010203040109",
  },
  {
    description: "page, the last one",
    tag: 13,
    wire: () => pageFrame([], [EVENT], false, 9),
    wireHex: "850d808144010203040009",
  },
  {
    description: "relayed",
    tag: 14,
    wire: () => relayedFrame(EVENT, 4),
    wireHex: "830e440102030404",
  },
  {
    description: "blob-put",
    tag: 15,
    wire: () => blobPutFrame(HASH, BYTES),
    wireHex: "830f6762333a3031303244deadbeef",
  },
  {
    description: "blob-get",
    tag: 16,
    wire: () => blobGetFrame(HASH),
    wireHex: "82106762333a30313032",
  },
  {
    description: "blob",
    tag: 17,
    wire: () => blobFrame(HASH, BYTES),
    wireHex: "83116762333a3031303244deadbeef",
  },
  {
    description: "blob-missing",
    tag: 18,
    wire: () => blobMissingFrame(HASH),
    wireHex: "82126762333a30313032",
  },
] as const;

describe("the relay's v1 control frames (D14)", () => {
  for (const vector of VECTORS) {
    test(`${vector.description} is byte-frozen`, () => {
      expect(bytesToHex(vector.wire())).toBe(vector.wireHex);
    });
  }

  test("every frozen frame round-trips from its own bytes", () => {
    for (const vector of VECTORS) {
      const decoded = decodeRelayFrame(hexToBytes(vector.wireHex).unwrap());
      expect(decoded.isOk()).toBe(true);
      expect(decoded.unwrap().kind).not.toBe("unknown");
    }
  });

  test("the tag space is the one the vector pins, with no gaps below 19", () => {
    const tags = new Map<number, string>();
    for (const vector of VECTORS) {
      const parts = decodeCbor(hexToBytes(vector.wireHex).unwrap()).unwrap();
      expect(Array.isArray(parts) && parts[0]).toBe(vector.tag);
      tags.set(vector.tag, vector.description);
    }
    expect([...tags.keys()].sort((a, b) => a - b)).toEqual([
      8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
    ]);
  });
});

describe("the vector is additive", () => {
  test("a tag this build does not know decodes as `unknown`, never as an error", () => {
    for (const tag of [19, 20, 99, 4096]) {
      const decoded = decodeRelayFrame(encodeCbor([tag, "whatever a v2 puts here", 7]));
      expect(decoded.unwrap().kind).toBe("unknown");
    }
  });

  test("an unknown tag in the stream leaves every v1 frame decoding exactly as before", () => {
    const before = VECTORS.map(
      (v) => decodeRelayFrame(hexToBytes(v.wireHex).unwrap()).unwrap().kind,
    );
    decodeRelayFrame(encodeCbor([19, 1, 2, 3]));
    const after = VECTORS.map(
      (v) => decodeRelayFrame(hexToBytes(v.wireHex).unwrap()).unwrap().kind,
    );
    expect(after).toEqual(before);
  });
});

describe("selectVersion", () => {
  test("the highest both sides speak", () => {
    expect(selectVersion([1, 2, 3], [2, 3, 4])).toBe(3);
    expect(selectVersion([1], [1])).toBe(1);
  });

  test("no overlap is `undefined` — a refusal to explain, never a version to guess at", () => {
    expect(selectVersion([2], [3])).toBeUndefined();
    expect(selectVersion([], [1])).toBeUndefined();
    expect(selectVersion([1], [])).toBeUndefined();
  });

  test("this build speaks 1, and offers it by default", () => {
    expect([...RELAY_PROTOCOL_VERSIONS]).toEqual([1]);
    expect(selectVersion([1])).toBe(1);
  });
});
