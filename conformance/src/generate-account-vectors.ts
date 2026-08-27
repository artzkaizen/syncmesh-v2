/**
 * Regenerates conformance/account-vectors.json from fixed seeds. Run only when the link wire
 * deliberately changes (README rule 3): `bun conformance/src/generate-account-vectors.ts`.
 */
import { parseAccountId, parsePartitionKey } from "@syncmesh/kernel";
import { Temporal } from "@syncmesh/temporal";
import { bytesToHex, createIdentity, signLink, type AccountCore } from "@syncmesh/wire";

const ACCOUNT_SEED = Uint8Array.from({ length: 32 }, (_, i) => 11 + i);
const DEVICE_SEED = Uint8Array.from({ length: 32 }, (_, i) => 101 + i);
const NOW = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);

export function accountVectors() {
  const account = createIdentity(ACCOUNT_SEED).unwrap();
  const device = createIdentity(DEVICE_SEED).unwrap();
  const base = {
    v: 1,
    account: parseAccountId(String(account.peerId)).unwrap(),
    device: device.peerId,
    at: NOW,
  } as const;
  const cases = [
    {
      description: "link, one org",
      core: { ...base, op: "link", partition: parsePartitionKey("org:acme").unwrap() },
    },
    {
      description: "link, a second instance of the same pair — the partition is inside the core",
      core: { ...base, op: "link", partition: parsePartitionKey("shelf:s1").unwrap() },
    },
    {
      description: "unlink, the only verb that ends a link",
      core: {
        ...base,
        op: "unlink",
        partition: parsePartitionKey("org:acme").unwrap(),
        at: NOW.add(Temporal.Duration.from({ hours: 1 })),
      },
    },
  ] satisfies readonly { description: string; core: AccountCore }[];
  return {
    accountId: account.peerId,
    deviceId: device.peerId,
    vectors: cases.map(({ description, core }) => ({
      description,
      wireHex: bytesToHex(signLink(account, core)),
    })),
  };
}

if (import.meta.main) {
  const out = new URL("../account-vectors.json", import.meta.url);
  await Bun.write(out, `${JSON.stringify(accountVectors(), null, 2)}\n`);
}
