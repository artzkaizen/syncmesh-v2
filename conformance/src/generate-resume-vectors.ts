/**
 * Regenerates conformance/resume-vectors.json. Run only when the Durable Object's resume script
 * deliberately changes (README rule 3): `bun conformance/src/generate-resume-vectors.ts`.
 *
 * What a hibernating host writes into a socket's attachment so a woken object can carry the
 * conversation on (D33, D36): `[head, join?, ...grants]`, where `head` is
 * `[nonce, secret, hello, seal, open, peer]` with `null` for a position that is empty and trailing
 * nulls left off. A script written before there was a head starts with a frame, and still reads.
 */
import type { PeerId, SeqNum } from "@syncmesh/kernel";

import { encodeResume } from "@syncmesh/cloudflare-do";
import { joinFrame } from "@syncmesh/relay";
import { bytesToHex, encodeCbor, hexToBytes, type CborValue } from "@syncmesh/wire";

import { frameVectors } from "./generate-frame-vectors.js";
import { handshakeVectors } from "./generate-handshake-vectors.js";
import { joinVectors } from "./generate-join-vectors.js";

const NONCE = Uint8Array.from({ length: 32 }, (_, i) => i);
const SECRET = Uint8Array.from({ length: 32 }, (_, i) => 0x40 + i);

export function resumeVectors() {
  const shake = handshakeVectors();
  const joins = joinVectors();
  const hex = (s: string) => hexToBytes(s).unwrap();
  const grant = hex(frameVectors().vectors[0]?.wireHex ?? "");
  const v2Join = hex(joins.vectors[0]?.joinHex ?? "");
  // SAFETY: the join vectors' device id is a validated peer id; a sequence is a branded integer
  const device = joins.deviceId as PeerId;
  const v3Join = joinFrame([3], device, new Map([[device, 7 as SeqNum]]));
  const session = {
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
    head: "[nonce, secret, hello, seal, open, peer], null where empty, trailing nulls omitted; then join, then grants oldest first",
    vectors: cases.map(({ description, resume }) => ({
      description,
      ...(resume.nonce !== undefined && { nonceHex: bytesToHex(resume.nonce) }),
      ...(resume.offer !== undefined && {
        offer: {
          secretHex: bytesToHex(resume.offer.secret),
          helloHex: bytesToHex(resume.offer.hello),
        },
      }),
      ...(resume.session !== undefined && {
        session: {
          peer: String(resume.session.peer),
          sealHex: bytesToHex(resume.session.keys.seal),
          openHex: bytesToHex(resume.session.keys.open),
        },
      }),
      ...(resume.join !== undefined && { joinHex: bytesToHex(resume.join) }),
      grantsHex: resume.grants.map((g) => bytesToHex(g)),
      attachmentHex: bytesToHex(encodeResume(resume) ?? new Uint8Array()),
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
