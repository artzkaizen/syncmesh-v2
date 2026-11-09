/**
 * Regenerates conformance/resume-vectors.json. Run only when the Durable Object's resume script
 * deliberately changes (README rule 3): `bun conformance/src/generate-resume-vectors.ts`.
 *
 * What a hibernating host writes into a socket's attachment so a woken object can carry the
 * conversation on (D33, D36): `[head, join?, ...grants]`, where `head` is
 * `[nonce, secret, hello, seal, open, peer]` with `null` for a position that is empty and trailing
 * nulls left off. A script written before there was a head starts with a frame, and still reads.
 * The secret and the two session keys are boxed `[sealed]`: XChaCha20-Poly1305 under the object's
 * attachment key, AAD `syncmesh/do-link-secret/v1` (N26). The vectors seal under `sealKeyHex`
 * with the nonce `sealNonceHex`, so their bytes are the same every run; a bare byte string in one
 * of those positions is a script from before N26, still read.
 */
import type { PeerId, SeqNum } from "@syncmesh/kernel";

import { encodeResume, linkSealer } from "@syncmesh/cloudflare-do";
import { joinFrame } from "@syncmesh/relay";
import { omitUndefined } from "@syncmesh/result";
import { bytesToHex, encodeCbor, hexToBytes, type CborValue } from "@syncmesh/wire";

import { frameVectors } from "./generate-frame-vectors.js";
import { handshakeVectors } from "./generate-handshake-vectors.js";
import { joinVectors } from "./generate-join-vectors.js";

const NONCE = Uint8Array.from({ length: 32 }, (_, i) => i);
const SECRET = Uint8Array.from({ length: 32 }, (_, i) => 0x40 + i);
/** The attachment key and the one nonce the vectors seal under (never one nonce twice outside a vector). */
export const SEAL_KEY = Uint8Array.from({ length: 32 }, (_, i) => 0x80 + i);
export const SEAL_NONCE = Uint8Array.from({ length: 24 }, (_, i) => 0xc0 + i);
/** The sealer the vectors are written and read with. */
export const vectorSealer = () => linkSealer(SEAL_KEY, () => SEAL_NONCE);

export function resumeVectors() {
  const shake = handshakeVectors();
  const joins = joinVectors();
  const hex = (s: string) => hexToBytes(s).unwrap();
  const grant = hex(frameVectors().vectors[0]?.wireHex ?? "");
  const v2Join = hex(joins.vectors[0]?.joinHex ?? "");
  // SAFETY: the join vectors' device id is a validated peer id
  const device = joins.deviceId as PeerId;
  // SAFETY: 7 is a non-negative integer, which is all a sequence number is
  const v3Join = joinFrame([3], device, new Map([[device, 7 as SeqNum]]));
  const session = {
    // SAFETY: the handshake vectors' b-side id is a validated peer id
    peer: shake.bId as PeerId,
    keys: { seal: hex(shake.aSealKeyHex), open: hex(shake.bSealKeyHex) },
  };
  const cases = [
    {
      description: "a v2 room: the challenge, the signed join, one grant",
      resume: { nonce: NONCE, join: v2Join, grants: [grant] },
    },
    {
      description:
        "a v3 room between its hello and the device's answer: the offer, nothing else yet",
      resume: { offer: { secret: SECRET, hello: hex(shake.helloAHex) }, grants: [] },
    },
    {
      description:
        "a v3 room after the handshake: the session, the join as the room read it, one grant",
      resume: { session, join: v3Join, grants: [grant] },
    },
    {
      description: "a socket challenged and never joined: the head alone",
      resume: { nonce: NONCE, grants: [] },
    },
  ];
  const legacy: CborValue[] = [v2Join, grant];
  return {
    attachmentLimit: 16_000,
    head: "[nonce, secret, hello, seal, open, peer], null where empty, trailing nulls omitted; secret, seal and open boxed as [sealed]; then join, then grants oldest first",
    sealKeyHex: bytesToHex(SEAL_KEY),
    sealNonceHex: bytesToHex(SEAL_NONCE),
    vectors: cases.map(({ description, resume }) => ({
      description,
      ...omitUndefined({
        nonceHex: resume.nonce === undefined ? undefined : bytesToHex(resume.nonce),
        offer:
          resume.offer === undefined
            ? undefined
            : {
                secretHex: bytesToHex(resume.offer.secret),
                helloHex: bytesToHex(resume.offer.hello),
              },
        session:
          resume.session === undefined
            ? undefined
            : {
                peer: String(resume.session.peer),
                sealHex: bytesToHex(resume.session.keys.seal),
                openHex: bytesToHex(resume.session.keys.open),
              },
        joinHex: resume.join === undefined ? undefined : bytesToHex(resume.join),
      }),
      grantsHex: resume.grants.map((g) => bytesToHex(g)),
      attachmentHex: bytesToHex(encodeResume(resume, vectorSealer()) ?? new Uint8Array()),
    })),
    /** A script from before the head existed: frames first, still read as frames. */
    legacy: {
      description: "join then grant, no head",
      attachmentHex: bytesToHex(encodeCbor(legacy)),
      frames: legacy.length,
    },
  };
}

if (import.meta.main) {
  const out = new URL("../resume-vectors.json", import.meta.url);
  await Bun.write(out, `${JSON.stringify(resumeVectors(), null, 2)}\n`);
}
