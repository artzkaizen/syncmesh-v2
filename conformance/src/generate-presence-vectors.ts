/**
 * Regenerates conformance/presence-vectors.json from a fixed seed. Run only when the presence
 * core deliberately changes (README rule 3): `bun conformance/src/generate-presence-vectors.ts`.
 *
 * The ephemeral tier (D16): a cursor, a typing flag, who-is-here. Signed like an event — the
 * core is `{0: v, 1: peerId bytes, 2: topic, 3: partition, 4: session, 5: count, 6: value row
 * or null, 7: expires}` in the `[core, sig]` envelope — and unlike an event in every other way.
 */
import type { ColumnName } from "@syncmesh/kernel";

import { parsePartitionKey } from "@syncmesh/kernel";
import {
  bytesToHex,
  createIdentity,
  encodePresenceCore,
  signPresence,
  type Presence,
} from "@syncmesh/wire";

const DEVICE_SEED = Uint8Array.from({ length: 32 }, (_, i) => 200 + i);
const ACME = parsePartitionKey("org:acme").unwrap();
const EXPIRES = 1_700_000_060_000;

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixtures: documented literals for branded names */
const X = "x" as ColumnName;
const Y = "y" as ColumnName;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

export function presenceVectors() {
  const device = createIdentity(DEVICE_SEED).unwrap();
  const base = {
    v: 1 as const,
    peerId: device.peerId,
    topic: "cursor",
    partition: ACME,
    session: "s-1",
    expires: EXPIRES,
  };
  const cases: readonly { description: string; presence: Presence }[] = [
    {
      description: "a cursor: a row value, count 3",
      presence: {
        ...base,
        count: 3,
        value: new Map([
          [X, 12],
          [Y, 34],
        ]),
      },
    },
    {
      description: "a departure: null, one count later",
      presence: { ...base, count: 4, value: null },
    },
  ];
  return {
    peerId: device.peerId,
    vectors: cases.map(({ description, presence }) => ({
      description,
      topic: presence.topic,
      partition: String(presence.partition),
      session: presence.session,
      count: presence.count,
      expires: presence.expires,
      coreHex: bytesToHex(encodePresenceCore(presence)),
      wireHex: bytesToHex(signPresence(presence, device).wire),
    })),
  };
}

if (import.meta.main) {
  const out = new URL("../presence-vectors.json", import.meta.url);
  await Bun.write(out, `${JSON.stringify(presenceVectors(), null, 2)}\n`);
}
