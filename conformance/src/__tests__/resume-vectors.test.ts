import { decodeResume, encodeResume } from "@syncmesh/cloudflare-do";
import { bytesToHex, hexToBytes } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import raw from "../../resume-vectors.json" with { type: "json" };
import { resumeVectors } from "../generate-resume-vectors.js";

const hex = (s: string) => hexToBytes(s).unwrap();

describe("Durable Object resume script vectors — frozen (D33, D36)", () => {
  test("the generator still produces the frozen file byte-for-byte (change the wire, change the vectors — deliberately)", () => {
    expect(JSON.parse(JSON.stringify(resumeVectors()))).toEqual(raw);
  });

  for (const v of raw.vectors) {
    test(v.description, () => {
      const kept = decodeResume(hex(v.attachmentHex));
      expect(kept.nonce && bytesToHex(kept.nonce)).toBe(v.nonceHex);
      expect(
        kept.offer && {
          secretHex: bytesToHex(kept.offer.secret),
          helloHex: bytesToHex(kept.offer.hello),
        },
      ).toEqual(v.offer);
      expect(
        kept.session && {
          peer: String(kept.session.peer),
          sealHex: bytesToHex(kept.session.keys.seal),
          openHex: bytesToHex(kept.session.keys.open),
        },
      ).toEqual(v.session);
      const frames = [...(v.joinHex === undefined ? [] : [v.joinHex]), ...v.grantsHex];
      expect(kept.frames.map(bytesToHex)).toEqual(frames);
      // and writing what was read lands on the same bytes
      const again = encodeResume({
        ...(kept.nonce !== undefined && { nonce: kept.nonce }),
        ...(kept.offer !== undefined && { offer: kept.offer }),
        ...(kept.session !== undefined && { session: kept.session }),
        ...(v.joinHex !== undefined && { join: hex(v.joinHex) }),
        grants: v.grantsHex.map(hex),
      });
      expect(again && bytesToHex(again)).toBe(v.attachmentHex);
    });
  }

  test("a script from before the head existed still reads as its frames", () => {
    const kept = decodeResume(hex(raw.legacy.attachmentHex));
    expect(kept.nonce).toBeUndefined();
    expect(kept.offer).toBeUndefined();
    expect(kept.session).toBeUndefined();
    expect(kept.frames).toHaveLength(raw.legacy.frames);
  });

  test("an empty attachment is an empty script", () => {
    expect(decodeResume(null)).toEqual({
      nonce: undefined,
      offer: undefined,
      session: undefined,
      frames: [],
    });
  });
});
