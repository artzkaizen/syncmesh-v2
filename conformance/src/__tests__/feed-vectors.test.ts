import { parsePeerId, parseSeqNum } from "@syncmesh/kernel";
import {
  GENESIS,
  advanceFeed,
  bytesToHex,
  certificateHolds,
  chunkFrom,
  createIdentity,
  decodeEventCore,
  feedCertificateCore,
  hexToBytes,
  verifyChunk,
  type FeedHead,
} from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import raw from "../../feed-vectors.json" with { type: "json" };
import { feedVectors } from "../generate-feed-vectors.js";

const peer = parsePeerId(raw.peerId).unwrap();
const cores = raw.events.map((e) => hexToBytes(e.coreHex).unwrap());
const headAt = (i: number): FeedHead => ({
  // SAFETY: a head's seq is the count of events under it; the vectors' first head is seq 1
  seq: parseSeqNum(i + 1).unwrap(),
  hash: hexToBytes(raw.events[i]?.headHex ?? "").unwrap(),
});
const certificate = {
  peerId: peer,
  head: headAt(raw.events.length - 1),
  sig: hexToBytes(raw.certificate.sigHex).unwrap(),
};

describe("feed vectors — frozen (RFC-0019)", () => {
  test("the generator still produces the frozen file byte-for-byte (change the wire, change the vectors — deliberately)", () => {
    expect(JSON.parse(JSON.stringify(feedVectors()))).toEqual(raw);
  });

  test("the chain walks from a zero genesis through every core to the frozen heads", () => {
    expect(raw.genesisHashHex).toBe(bytesToHex(GENESIS.hash));
    let head = GENESIS;
    raw.events.forEach((e, i) => {
      head = advanceFeed(head, cores[i] ?? new Uint8Array());
      expect(Number(head.seq)).toBe(e.seq);
      expect(bytesToHex(head.hash)).toBe(e.headHex);
    });
  });

  test("the cores are ordinary event cores by the named author, in sequence", () => {
    cores.forEach((core, i) => {
      const event = decodeEventCore(core).unwrap();
      expect(String(event.peerId)).toBe(raw.peerId);
      expect(Number(event.seqNum)).toBe(i + 1);
    });
  });

  test("the certificate core is the frozen bytes, and the author's signature covers it", () => {
    expect(bytesToHex(feedCertificateCore(peer, certificate.head))).toBe(raw.certificate.coreHex);
    expect(certificateHolds(certificate)).toBe(true);
    const forged = {
      ...certificate,
      sig: Uint8Array.from(certificate.sig, (b, i) => (i === 0 ? b ^ 1 : b)),
    };
    expect(certificateHolds(forged)).toBe(false);
  });

  test("one certificate verifies the whole run from genesis, and the tail from seq 1", () => {
    const whole = { peerId: peer, from: GENESIS.seq, cores, certificate };
    expect(bytesToHex(verifyChunk(whole, GENESIS).unwrap().hash)).toBe(
      raw.certificate.coreHex.slice(-64),
    );
    const tail = { peerId: peer, from: headAt(0).seq, cores: cores.slice(1), certificate };
    expect(verifyChunk(tail, headAt(0)).isOk()).toBe(true);
    // a run that starts elsewhere, or a core changed anywhere in it, is refused as a value
    expect(verifyChunk(tail, GENESIS).isErr()).toBe(true);
    const tampered = cores.map((c, i) =>
      i === 1 ? Uint8Array.from(c, (b, j) => (j === 0 ? b : b ^ 1)) : c,
    );
    expect(verifyChunk({ ...whole, cores: tampered }, GENESIS).isErr()).toBe(true);
  });

  test("only the author can build a chunk that verifies: another key's certificate names another feed", () => {
    const other = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 121 + i)).unwrap();
    const forged = chunkFrom(other, GENESIS, cores);
    expect(verifyChunk({ ...forged, peerId: peer }, GENESIS).isErr()).toBe(true);
  });
});
