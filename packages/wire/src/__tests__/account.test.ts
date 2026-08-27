import { parseAccountId, parsePartitionKey } from "@syncmesh/kernel";
import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";

import { encodeAccountCore, signLink, verifyLink, type AccountCore } from "../account.js";
import { encodeCbor, type CborKey, type CborValue } from "../cbor.js";
import { splitEnvelope } from "../envelope.js";
import { bytesEqual, bytesToHex, hexToBytes } from "../hex.js";
import { createIdentity } from "../identity.js";
import { IDENTITY_A, IDENTITY_B } from "./fixtures.js";

const at = (ms: number) => Temporal.Instant.fromEpochMilliseconds(ms);
const NOW = at(1_700_000_000_000);
const ORG = parsePartitionKey("org:acme").unwrap();

/** The account is an ordinary identity; its peer id and its account id are the same 64 hex (D21). */
const OTHER = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 40 + i)).unwrap();
const accountId = (hex: string) => parseAccountId(hex).unwrap();
const ACCOUNT = accountId(String(IDENTITY_A.peerId));

const core = (overrides: Partial<AccountCore> = {}): AccountCore => ({
  v: 1,
  op: "link",
  account: ACCOUNT,
  device: IDENTITY_B.peerId,
  partition: ORG,
  at: NOW,
  ...overrides,
});

const split = (wire: Uint8Array) => splitEnvelope(wire).unwrap();

describe("signLink / verifyLink", () => {
  test("round-trips every field, and re-encoding the decoded core is byte-identical", () => {
    const wire = signLink(IDENTITY_A, core());
    const link = verifyLink(wire).unwrap();
    expect(link.v).toBe(1);
    expect(link.op).toBe("link");
    expect(link.account).toBe(ACCOUNT);
    expect(link.device).toBe(IDENTITY_B.peerId);
    expect(link.partition).toBe(ORG);
    expect(link.at.epochMilliseconds).toBe(NOW.epochMilliseconds);
    expect(bytesEqual(encodeAccountCore(link), split(wire).core)).toBe(true);
  });

  test("every link is the same six pairs — no optional keys to make one core two shapes", () => {
    expect(bytesToHex(split(signLink(IDENTITY_A, core())).core)).toStartWith("a6");
  });

  test("unlink round-trips as its own verb, on bytes a link's are not", () => {
    const linked = signLink(IDENTITY_A, core());
    const unlinked = signLink(IDENTITY_A, core({ op: "unlink" }));
    expect(verifyLink(unlinked).unwrap().op).toBe("unlink");
    expect(bytesEqual(split(linked).core, split(unlinked).core)).toBe(false);
  });

  test("a link does not lapse: an `at` a century out still verifies, with no clock to ask", () => {
    const wire = signLink(IDENTITY_A, core({ at: at(4_800_000_000_000) }));
    expect(verifyLink(wire).isOk()).toBe(true);
  });

  test("a tampered core is BadLinkSignature — the signature covers the bytes as received", () => {
    const wire = signLink(IDENTITY_A, core());
    const forged = encodeCbor([encodeAccountCore(core({ at: at(1) })), split(wire).sig]);
    const r = verifyLink(forged);
    expect(r.isErr() && r.error._tag).toBe("BadLinkSignature");
  });

  test("a tampered signature is BadLinkSignature, and no flipped byte anywhere is a throw", () => {
    const wire = signLink(IDENTITY_A, core());
    const sig = Uint8Array.from(split(wire).sig);
    sig[0] = (sig[0] ?? 0) ^ 1;
    const r = verifyLink(encodeCbor([split(wire).core, sig]));
    expect(r.isErr() && r.error._tag).toBe("BadLinkSignature");
    for (let i = 0; i < wire.length; i++) {
      const flipped = Uint8Array.from(wire);
      flipped[i] = (flipped[i] ?? 0) ^ 1;
      expect(verifyLink(flipped).isErr()).toBe(true);
    }
    for (const bad of ["", "80", "82", "824041"])
      expect(verifyLink(hexToBytes(bad).unwrap()).isErr()).toBe(true);
  });

  test("a different account's signature is refused both ways round — the core names its verifier", () => {
    const impostor = verifyLink(signLink(OTHER, core()));
    expect(impostor.isErr() && impostor.error._tag).toBe("BadLinkSignature");
    const misnamed = verifyLink(
      signLink(IDENTITY_A, core({ account: accountId(String(OTHER.peerId)) })),
    );
    expect(misnamed.isErr() && misnamed.error._tag).toBe("BadLinkSignature");
  });

  test("an account that is not 32 bytes of key is MalformedLink, never a bad-hex throw", () => {
    const stub = encodeCbor(
      new Map<CborKey, CborValue>([
        [0, 1],
        [1, hexToBytes(String(IDENTITY_A.peerId)).unwrap().slice(0, 31)],
        [2, hexToBytes(String(IDENTITY_B.peerId)).unwrap()],
        [3, 0],
        [4, "org:acme"],
        [5, NOW.epochMilliseconds],
      ]),
    );
    const r = verifyLink(encodeCbor([stub, IDENTITY_A.sign(stub)]));
    expect(r.isErr() && r.error._tag).toBe("MalformedLink");
  });

  test("a well-signed core with the wrong shape is MalformedLink, one message per rung", () => {
    const cases = [
      { core: new Map<CborKey, CborValue>([[0, 2]]), says: "unsupported version" },
      {
        core: new Map<CborKey, CborValue>([
          [0, 1],
          [1, hexToBytes(String(IDENTITY_A.peerId)).unwrap()],
          [2, hexToBytes(String(IDENTITY_B.peerId)).unwrap()],
          [3, 7],
          [4, "org:acme"],
          [5, 0],
        ]),
        says: "op is not link or unlink",
      },
      {
        core: new Map<CborKey, CborValue>([
          [0, 1],
          [1, hexToBytes(String(IDENTITY_A.peerId)).unwrap()],
          [2, hexToBytes(String(IDENTITY_B.peerId)).unwrap()],
          [3, 1],
          [4, "acme"],
          [5, 0],
        ]),
        says: "kind:id",
      },
    ];
    for (const { core: written, says } of cases) {
      const bytes = encodeCbor(written);
      const r = verifyLink(encodeCbor([bytes, IDENTITY_A.sign(bytes)]));
      expect(r.isErr() && r.error._tag === "MalformedLink" && r.error.message).toContain(says);
    }
  });
});

/**
 * `splitGrant` and `decodeAndVerify` now share `splitEnvelope`; the grant and envelope suites
 * passing unchanged beside this one is the evidence that the extraction moved no behaviour.
 */
describe("splitEnvelope, shared with grants", () => {
  test("splits the same [core, sig] a link is signed as", () => {
    const wire = signLink(IDENTITY_A, core());
    expect(bytesEqual(encodeCbor([split(wire).core, split(wire).sig]), wire)).toBe(true);
  });
});
