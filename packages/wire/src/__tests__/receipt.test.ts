import { parseSeqNum } from "@syncmesh/kernel";
import { isPanic } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";

import { decodeCbor } from "../cbor-decode.js";
import { encodeCbor } from "../cbor.js";
import { encodeRefusal, issueRefusal, verifyRefusal } from "../receipt.js";
import { IDENTITY_A, IDENTITY_B } from "./fixtures.js";

const NOW = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const REQUEST = {
  author: IDENTITY_B.peerId,
  seq: parseSeqNum(3).unwrap(),
  reason: "refused",
  verdict: "GrantStale",
  now: NOW,
} as const;

const refusedAs = (wire: Uint8Array) => {
  const verified = verifyRefusal(wire);
  return verified.isErr() && verified.error._tag;
};

/** The `[core, sig]` halves of a wire refusal. */
const halves = (wire: Uint8Array) => {
  const outer = decodeCbor(wire).unwrap();
  if (
    !Array.isArray(outer) ||
    !(outer[0] instanceof Uint8Array) ||
    !(outer[1] instanceof Uint8Array)
  )
    throw new Error("fixture: not an envelope");
  return { core: outer[0], sig: outer[1] };
};

describe("refusal receipts — the refusing twin of custody (D32)", () => {
  test("round-trips: what was signed is what verifies, and the core re-encodes byte for byte", () => {
    const wire = issueRefusal(IDENTITY_A, REQUEST);
    const refusal = verifyRefusal(wire).unwrap();
    expect(refusal).toEqual({
      v: 1,
      refuser: IDENTITY_A.peerId,
      author: IDENTITY_B.peerId,
      seq: REQUEST.seq,
      reason: "refused",
      verdict: "GrantStale",
      issuedAt: NOW,
    });
    expect(encodeRefusal(refusal)).toEqual(halves(wire).core);
  });

  test("a refusal signed by another key than the refuser it names does not verify", () => {
    const { core } = halves(issueRefusal(IDENTITY_A, REQUEST));
    const forged = encodeCbor([core, IDENTITY_B.sign(core)]);
    expect(refusedAs(forged)).toBe("BadReceiptSignature");
  });

  test("a refusal naming another refuser under the signer's key does not verify", () => {
    const refusal = verifyRefusal(issueRefusal(IDENTITY_A, REQUEST)).unwrap();
    const renamed = encodeRefusal({ ...refusal, refuser: IDENTITY_B.peerId });
    const misnamed = encodeCbor([renamed, IDENTITY_A.sign(renamed)]);
    expect(refusedAs(misnamed)).toBe("BadReceiptSignature");
  });

  test("the older-build buckets travel as themselves", () => {
    for (const reason of ["unknown-table", "unknown-kind"] as const) {
      const wire = issueRefusal(IDENTITY_A, { ...REQUEST, reason, verdict: "UnknownTable" });
      expect(verifyRefusal(wire).unwrap().reason).toBe(reason);
    }
  });

  test("a verdict is a tag, never a sentence: issuing one panics, and receiving one is malformed", () => {
    let thrown: unknown;
    try {
      issueRefusal(IDENTITY_A, { ...REQUEST, verdict: "your grant expired, renew it here" });
    } catch (cause) {
      thrown = cause;
    }
    expect(isPanic(thrown)).toBe(true);

    const refusal = verifyRefusal(issueRefusal(IDENTITY_A, REQUEST)).unwrap();
    const prose = encodeRefusal({ ...refusal, verdict: "click here" });
    const signed = encodeCbor([prose, IDENTITY_A.sign(prose)]);
    expect(refusedAs(signed)).toBe("MalformedReceipt");
  });

  test("a reason outside the three buckets is malformed, never coerced", () => {
    const refusal = verifyRefusal(issueRefusal(IDENTITY_A, REQUEST)).unwrap();
    // SAFETY: deliberately outside the union, to test the decoder's refusal of it
    const odd = encodeRefusal({ ...refusal, reason: "vetoed" as "refused" });
    const signed = encodeCbor([odd, IDENTITY_A.sign(odd)]);
    expect(refusedAs(signed)).toBe("MalformedReceipt");
  });

  test("garbage is a value, never a throw", () => {
    expect(verifyRefusal(Uint8Array.of(1, 2, 3)).isErr()).toBe(true);
  });
});
