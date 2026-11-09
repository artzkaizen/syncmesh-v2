import {
  getRecord,
  docLineage,
  hlcOf,
  parseLineageCells,
  parseLineageId,
  parsePeerId,
  parseSeqNum,
} from "@syncmesh/kernel";
import {
  bytesToHex,
  decodeCheckpoint,
  decodeEventCore,
  deriveLineage,
  docChangeId,
  encodeCbor,
  encodeCheckpointCore,
  encodeEventCore,
  decodeRecord,
  encodeRecord,
  hexToBytes,
  verify,
} from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import raw from "../../doc-vectors.json" with { type: "json" };
import { CONTENT, DOCS, N1, NOTES } from "../doc-names.js";
import { docVectors } from "../generate-doc-vectors.js";
import { foldGeneses } from "../lineage-trees.js";
import { wireVectors } from "../vectors.js";

const bytes = (hex: string) => hexToBytes(hex).unwrap();
const author = bytes(raw.authorId);
const lineageOrRoot = (hex: string | null) =>
  hex === null ? undefined : parseLineageId(hex).unwrap();

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
        else if (change.kind === "doc") expect(change.parent).toBeUndefined();
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

  /** Every order of a short list: each lineage tree is folded in all of them. */
  const permutations = <T>(xs: readonly T[]): T[][] =>
    xs.length <= 1
      ? [[...xs]]
      : xs.flatMap((x, i) =>
          permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]),
        );

  for (const tree of raw.lineageTrees) {
    test(`lineage tree: ${tree.description} — in every order, one record and one winner`, () => {
      const geneses = tree.geneses.map((g) => ({
        lineage: parseLineageId(g.lineage).unwrap(),
        parent: g.parent === null ? undefined : parseLineageId(g.parent).unwrap(),
        ms: g.ms,
        logical: g.logical,
        peer: parsePeerId(g.peer).unwrap(),
        settles:
          g.settles === null
            ? undefined
            : {
                lineage: parseLineageId(g.settles.lineage).unwrap(),
                stamp: {
                  hlc: hlcOf(g.settles.ms, g.settles.logical),
                  peer: parsePeerId(g.settles.peer).unwrap(),
                },
              },
      }));
      const winner = lineageOrRoot(tree.winner);
      for (const order of permutations(geneses)) {
        const record = getRecord(foldGeneses(order), NOTES, N1);
        expect(record === undefined ? "" : bytesToHex(encodeRecord(record))).toBe(tree.recordHex);
        expect(docLineage(record, CONTENT)).toBe(winner);
      }
    });
  }

  for (const cell of raw.lineageCells) {
    test(`lineage cell: ${cell.description}`, () => {
      const record = decodeRecord(bytes(cell.recordHex)).unwrap();
      expect(bytesToHex(encodeRecord(record))).toBe(cell.recordHex);
      const parsed = parseLineageCells([{ table: NOTES, key: N1, record }], DOCS);
      expect(parsed.isErr()).toBe(cell.refused);
      if (parsed.isErr()) expect(parsed.error.version).toBe(cell.version);
      else expect(docLineage(record, CONTENT)).toBe(lineageOrRoot(cell.winner));
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
