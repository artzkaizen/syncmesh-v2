/**
 * Regenerates conformance/grant-vectors.json from fixed seeds. Run only when the grant wire
 * deliberately changes (README rule 3): `bun conformance/src/generate-grant-vectors.ts`.
 */
import { parsePartitionKey } from "@syncmesh/kernel";
import { Temporal } from "@syncmesh/temporal";
import { bytesToHex, createIdentity, issueGrant } from "@syncmesh/wire";

const ISSUER_SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const DEVICE_SEED = Uint8Array.from({ length: 32 }, (_, i) => 101 + i);
const NOW = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);

export function grantVectors() {
  const issuer = createIdentity(ISSUER_SEED).unwrap();
  const device = createIdentity(DEVICE_SEED).unwrap();
  const base = { device: device.peerId, now: NOW };
  const cases = [
    {
      description: "member of one org, one hour",
      request: {
        ...base,
        account: "acct_a",
        role: "member",
        partitions: [parsePartitionKey("org:acme").unwrap()],
        validFor: Temporal.Duration.from({ hours: 1 }),
      },
    },
    {
      description: "no role, claims with a permission matrix and entity ids",
      request: {
        ...base,
        account: "u_42",
        partitions: [
          parsePartitionKey("org:acme").unwrap(),
          parsePartitionKey("shelf:s1").unwrap(),
        ],
        claims: {
          member: "m_9001",
          permissions: { controls: ["read", "update"] },
          entities: ["e_root", "e_berlin"],
        },
        validFor: Temporal.Duration.from({ hours: 4 }),
      },
    },
    {
      description: "personal: no partitions, thirty days",
      request: {
        ...base,
        account: "acct_a",
        partitions: [],
        validFor: Temporal.Duration.from({ days: 30 }),
      },
    },
  ];
  return {
    issuerId: issuer.peerId,
    deviceId: device.peerId,
    vectors: cases.map(({ description, request }) => ({
      description,
      wireHex: bytesToHex(issueGrant(issuer, request)),
    })),
  };
}

if (import.meta.main) {
  const out = new URL("../grant-vectors.json", import.meta.url);
  await Bun.write(out, `${JSON.stringify(grantVectors(), null, 2)}\n`);
}
