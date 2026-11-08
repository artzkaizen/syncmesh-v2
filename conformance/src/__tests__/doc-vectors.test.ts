import { parsePeerId, parseSeqNum } from "@syncmesh/kernel";
import {
  bytesToHex,
  decodeCheckpoint,
  decodeEventCore,
  deriveLineage,
  docChangeId,
  encodeCbor,
  encodeCheckpointCore,
  encodeEventCore,
  hexToBytes,
  verify,
} from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import raw from "../../doc-vectors.json" with { type: "json" };
import { docVectors } from "../generate-doc-vectors.js";
import { wireVectors } from "../vectors.js";

const bytes = (hex: string) => hexToBytes(hex).unwrap();
const author = bytes(raw.authorId);

describe("doc vectors — frozen (RFC-0023 §13)", () => {
  test("the generator still produces the frozen file byte-for-byte (change the wire, change the vectors — deliberately)", () => {
    expect(JSON.parse(JSON.stringify(docVectors()))).toEqual(raw);
  });

  for (const v of raw.events) {
    test(v.description, () => {
      const core = bytes(v.coreHex);
      expect(verify(core, bytes(v.sigHex), author)).toBe(true);
      const event = decodeEventCore(core).unwrap();
      expect(bytesToHex(encodeEventCore(event))).toBe(v.coreHex);
      expect(event.changes.some((c) => c.kind === "doc")).toBe(true);
      for (const [index, change] of event.changes.entries())
        if (change.kind === "doc" && change.genesis === true)
          expect(change.lineage).toBe(deriveLineage(event.peerId, event.seqNum, index));
    });
  }

  for (const l of raw.lineages) {
    test(`the lineage of ${l.peerId.slice(0, 8)}… seq ${l.seq} change ${l.index}`, () => {
      const peer = parsePeerId(l.peerId).unwrap();
      const seq = parseSeqNum(l.seq).unwrap();
      expect(bytesToHex(docChangeId(peer, seq, l.index))).toBe(l.changeIdHex);
      expect(String(deriveLineage(peer, seq, l.index))).toBe(l.lineageHex);
    });
  }

  test(raw.checkpoint.description, () => {
    const wire = encodeCbor([bytes(raw.checkpoint.coreHex), bytes(raw.checkpoint.sigHex)]);
    const { checkpoint } = decodeCheckpoint(wire, parsePeerId(raw.producerId).unwrap()).unwrap();
    expect(bytesToHex(encodeCheckpointCore(checkpoint))).toBe(raw.checkpoint.coreHex);
  });
});

describe("a frozen v=1 vector, re-verified: the new keys disturbed nothing", () => {
  test(raw.v1.description, () => {
    const frozen = wireVectors.vectors[0];
    expect(raw.v1.coreHex).toBe(frozen?.coreHex ?? "");
    const core = bytes(raw.v1.coreHex);
    expect(verify(core, bytes(frozen?.sigHex ?? ""), bytes(wireVectors.peerId))).toBe(true);
    const event = decodeEventCore(core).unwrap();
    expect(bytesToHex(encodeEventCore(event))).toBe(raw.v1.coreHex);
    expect(event.action).toBeUndefined();
    expect(event.undoOf).toBeUndefined();
    expect(event.changes.map((c) => c.kind)).toEqual(["insert"]);
  });
});
