import { parsePartitionKey } from "@syncmesh/kernel";
import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";

import { encodeGrantCore, issueGrant, verifyGrant, type GrantRequest } from "../grant.js";
import { bytesEqual, bytesToHex, hexToBytes } from "../hex.js";
import { decodeCbor, encodeCbor, type CborKey, type CborValue } from "../index.js";
import { IDENTITY_A, IDENTITY_B } from "./fixtures.js";

const at = (ms: number) => Temporal.Instant.fromEpochMilliseconds(ms);
const NOW = at(1_700_000_000_000);
const HOUR = Temporal.Duration.from({ hours: 1 });
const ORG = parsePartitionKey("org:acme").unwrap();

const request = (overrides: Partial<GrantRequest> = {}): GrantRequest => ({
  account: "acct_a",
  device: IDENTITY_B.peerId,
  role: "member",
  partitions: [ORG],
  claims: { member: "m_1", permissions: { controls: ["read", "update"] }, entities: ["e_root"] },
  validFor: HOUR,
  now: NOW,
  ...overrides,
});

describe("issueGrant / verifyGrant", () => {
  test("round-trips every field; claims survive as JSON; validity is now + validFor", () => {
    const wire = issueGrant(IDENTITY_A, request());
    const grant = verifyGrant(wire, IDENTITY_A.peerId, NOW).unwrap();
    expect(grant.account).toBe("acct_a");
    expect(grant.device).toBe(IDENTITY_B.peerId);
    expect(grant.role).toBe("member");
    expect(grant.partitions).toEqual([ORG]);
    expect(grant.claims).toEqual({
      member: "m_1",
      permissions: { controls: ["read", "update"] },
      entities: ["e_root"],
    });
    expect(grant.issuedAt.epochMilliseconds).toBe(NOW.epochMilliseconds);
    expect(grant.expiresAt.epochMilliseconds).toBe(NOW.add(HOUR).epochMilliseconds);
    expect(bytesEqual(encodeGrantCore(grant), decodeCore(wire))).toBe(true);
  });

  test("role is absent bytes when omitted; claims default to an empty map", () => {
    const { role: _role, claims: _claims, ...bare } = request();
    const wire = issueGrant(IDENTITY_A, bare);
    const grant = verifyGrant(wire, IDENTITY_A.peerId, NOW).unwrap();
    expect(grant.role).toBeUndefined();
    expect(grant.claims).toEqual({});
    expect(bytesToHex(decodeCore(wire))).toStartWith("a7");
  });

  test("a wrong issuer or a flipped byte is BadGrantSignature; never a throw", () => {
    const wire = issueGrant(IDENTITY_A, request());
    expect(verifyGrant(wire, IDENTITY_B.peerId, NOW).isErr()).toBe(true);
    const tampered = Uint8Array.from(wire);
    tampered[8] = (tampered[8] ?? 0) ^ 1;
    const r = verifyGrant(tampered, IDENTITY_A.peerId, NOW);
    expect(r.isErr() && r.error._tag).toBe("BadGrantSignature");
    for (const bad of ["", "80", "82", "824041"])
      expect(verifyGrant(hexToBytes(bad).unwrap(), IDENTITY_A.peerId, NOW).isErr()).toBe(true);
  });

  test("validFor in days is thirty UTC days, which an Instant alone cannot add", () => {
    const wire = issueGrant(
      IDENTITY_A,
      request({ validFor: Temporal.Duration.from({ days: 30 }) }),
    );
    const grant = verifyGrant(wire, IDENTITY_A.peerId, NOW).unwrap();
    expect(grant.expiresAt.epochMilliseconds - NOW.epochMilliseconds).toBe(30 * 86_400_000);
  });

  test("expiry is judged against the caller's clock", () => {
    const wire = issueGrant(IDENTITY_A, request());
    expect(verifyGrant(wire, IDENTITY_A.peerId, NOW.add(HOUR)).isOk()).toBe(true);
    const late = verifyGrant(
      wire,
      IDENTITY_A.peerId,
      NOW.add(HOUR).add(Temporal.Duration.from({ milliseconds: 1 })),
    );
    expect(late.isErr() && late.error._tag).toBe("GrantExpired");
  });

  test("a well-signed core with the wrong shape is MalformedGrant", () => {
    const badPartition = encodeCbor(
      new Map<CborKey, CborValue>([
        [0, 1],
        [1, "acct"],
        [2, hexToBytes(IDENTITY_B.peerId).unwrap()],
        [4, ["acme"]],
        [5, 1],
        [6, 2],
        [7, new Map()],
      ]),
    );
    const wire = encodeCbor([badPartition, IDENTITY_A.sign(badPartition)]);
    const r = verifyGrant(wire, IDENTITY_A.peerId, NOW);
    expect(r.isErr() && r.error._tag === "MalformedGrant" && r.error.message).toContain("kind:id");
  });
});

const decodeCore = (wire: Uint8Array): Uint8Array => {
  const outer = decodeCbor(wire).unwrap();
  if (!Array.isArray(outer) || !(outer[0] instanceof Uint8Array)) throw new Error("fixture");
  return outer[0];
};
