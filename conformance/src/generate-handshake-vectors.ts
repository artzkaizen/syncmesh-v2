/**
 * Regenerates conformance/handshake-vectors.json from fixed seeds and fixed ephemeral secrets.
 * Run only when the link handshake deliberately changes (README rule 3):
 * `bun conformance/src/generate-handshake-vectors.ts`.
 *
 * The secrets are printed on purpose: a vector is a worked example, and a port needs the inputs
 * to reproduce the outputs. Nothing here is a key anything real ever used.
 */
import { seal, sessionKeys, writeHello } from "@syncmesh/transport";
import { bytesToHex, createIdentity } from "@syncmesh/wire";

const A_SEED = Uint8Array.from({ length: 32 }, (_, i) => 200 + i);
const B_SEED = Uint8Array.from({ length: 32 }, (_, i) => 121 + i);
const A_SECRET = Uint8Array.from({ length: 32 }, (_, i) => 0x40 + i);
const B_SECRET = Uint8Array.from({ length: 32 }, (_, i) => 0x80 + i);
const NONCE = Uint8Array.from({ length: 24 }, (_, i) => 0x10 + i);
const PLAINTEXT = new TextEncoder().encode("hello, room");

export function handshakeVectors() {
  const a = createIdentity(A_SEED).unwrap();
  const b = createIdentity(B_SEED).unwrap();
  const helloA = writeHello(a, A_SECRET);
  const helloB = writeHello(b, B_SECRET);
  const keysA = sessionKeys(A_SECRET, helloA, helloB).unwrap();
  const keysB = sessionKeys(B_SECRET, helloB, helloA).unwrap();
  if (bytesToHex(keysA.seal) !== bytesToHex(keysB.open)) throw new Error("the two ends disagree");
  return {
    context: { hello: "syncmesh/link/hello/v1", session: "syncmesh/link/session/v1" },
    aId: a.peerId,
    bId: b.peerId,
    aSecretHex: bytesToHex(A_SECRET),
    bSecretHex: bytesToHex(B_SECRET),
    helloAHex: bytesToHex(helloA.frame),
    helloBHex: bytesToHex(helloB.frame),
    /** What A seals with, which is what B opens with; and the reverse. */
    aSealKeyHex: bytesToHex(keysA.seal),
    bSealKeyHex: bytesToHex(keysB.seal),
    nonceHex: bytesToHex(NONCE),
    plaintextHex: bytesToHex(PLAINTEXT),
    sealedByAHex: bytesToHex(seal(keysA.seal, PLAINTEXT, NONCE)),
  };
}

if (import.meta.main) {
  const out = new URL("../handshake-vectors.json", import.meta.url);
  await Bun.write(out, `${JSON.stringify(handshakeVectors(), null, 2)}\n`);
}
