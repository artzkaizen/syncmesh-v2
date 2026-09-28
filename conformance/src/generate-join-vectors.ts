/**
 * Regenerates conformance/join-vectors.json from fixed seeds. Run only when the relay's join
 * proof deliberately changes (README rule 3): `bun conformance/src/generate-join-vectors.ts`.
 *
 * What a v2 join proves (D33): the named key, over the room's challenge and the join's own core.
 * A port that reproduces `coreHex` from the same four elements, and whose signature over
 * `"syncmesh/relay/join/v2" ‖ nonce ‖ core` verifies against `deviceId`, speaks the same join.
 */
import type { PeerId, SeqNum } from "@syncmesh/kernel";

import { challengeFrame, joinCore, joinFrame, proveJoin } from "@syncmesh/relay";
import { bytesToHex, createIdentity } from "@syncmesh/wire";

const DEVICE_SEED = Uint8Array.from({ length: 32 }, (_, i) => 200 + i);
const NONCE = Uint8Array.from({ length: 32 }, (_, i) => i);

export function joinVectors() {
  const device = createIdentity(DEVICE_SEED).unwrap();
  /* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- a sequence is a branded integer; documented literals */
  const cases = [
    {
      description: "a first join: no cursors, no interest",
      versions: [2],
      cursors: new Map<PeerId, SeqNum>(),
    },
    {
      description: "a re-join holding seven of its own",
      versions: [2],
      cursors: new Map<PeerId, SeqNum>([[device.peerId, 7 as SeqNum]]),
    },
  ];
  /* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */
  return {
    deviceId: device.peerId,
    nonceHex: bytesToHex(NONCE),
    challengeHex: bytesToHex(challengeFrame(NONCE)),
    vectors: cases.map(({ description, versions, cursors }) => {
      const core = joinCore(versions, device.peerId, cursors);
      const proof = proveJoin(device, NONCE, core);
      return {
        description,
        coreHex: bytesToHex(core),
        proofHex: bytesToHex(proof),
        joinHex: bytesToHex(joinFrame(versions, device.peerId, cursors, undefined, proof)),
      };
    }),
  };
}

if (import.meta.main) {
  const out = new URL("../join-vectors.json", import.meta.url);
  await Bun.write(out, `${JSON.stringify(joinVectors(), null, 2)}\n`);
}
