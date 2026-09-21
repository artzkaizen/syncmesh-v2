import type { Signer } from "@syncmesh/wire";

import { useSigner } from "@syncmesh/wire";
import { createPrivateKey, createPublicKey, sign, verify } from "react-native-quick-crypto";

/**
 * Ed25519 through OpenSSL instead of through Hermes.
 *
 * The bundled implementation is big-integer arithmetic in JavaScript, and Hermes has no fast
 * bignums: one verification measures ~7ms here, and a device joining a workspace pays one per
 * event. `react-native-quick-crypto` hands the same curve to OpenSSL over JSI, where it costs
 * tens of microseconds — which is the difference between a cold join of ten seconds and one of a
 * tenth of a second.
 *
 * **The synchronous API is the reason this is possible at all.** `crypto.sign`/`crypto.verify` are
 * Node's blocking pair, and they match what the mesh needs: `verify` is called from inside the
 * fold, which is synchronous all the way down. The WebCrypto equivalent is `subtle.verify`, which
 * is async, and adopting it would mean making the fold async — a change to the shape of the whole
 * engine in exchange for the same arithmetic.
 */

/**
 * The fixed bytes that turn a bare Ed25519 key into the DER a `KeyObject` is built from.
 *
 * Ed25519 keys are 32 bytes and nothing else, but Node's key API speaks DER, and for this one
 * algorithm the wrapper is a constant: the algorithm identifier is the only thing the prefix
 * carries and it never varies. So these are not a parser, they are a header — concatenation is
 * the whole encoding.
 */
const PKCS8 = Uint8Array.of(
  0x30,
  0x2e,
  0x02,
  0x01,
  0x00,
  0x30,
  0x05,
  0x06,
  0x03,
  0x2b,
  0x65,
  0x70,
  0x04,
  0x22,
  0x04,
  0x20,
);

const SPKI = Uint8Array.of(0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00);

const wrap = (prefix: Uint8Array, key: Uint8Array): Uint8Array => {
  const der = new Uint8Array(prefix.length + key.length);
  der.set(prefix);
  der.set(key, prefix.length);
  return der;
};

/**
 * Key objects, built once per distinct key.
 *
 * Parsing DER is the cheap half; what it also does is decompress the public point, which costs a
 * modular square root — per call, for the same handful of devices, if nothing remembers. A mesh
 * has a device set rather than a stream of strangers, so this stays small on its own.
 */
/** Either half, since one map holds both and the bytes they are built from tell them apart. */
type KeyObject = ReturnType<typeof createPrivateKey> | ReturnType<typeof createPublicKey>;

const objects = new Map<string, KeyObject>();

const keyed = <T extends KeyObject>(key: Uint8Array, make: () => T): T => {
  // latin-1 rather than hex: it is only ever compared, and it is one pass instead of 32
  const id = String.fromCharCode(...key);
  const known = objects.get(id);
  if (known !== undefined) {
    // SAFETY: the map is keyed by the bytes the object was built from, and this device's seed is
    // not any peer's public key — so an entry under this id is what this call's own `make` produced
    return known as T;
  }
  const made = make();
  objects.set(id, made);
  return made;
};

const native: Signer = {
  sign: (message, seed) => {
    const key = keyed(seed, () =>
      createPrivateKey({ key: wrap(PKCS8, seed), format: "der", type: "pkcs8" }),
    );
    return Uint8Array.from(sign(null, message, key));
  },
  verify: (message, signature, publicKey) => {
    const key = keyed(publicKey, () =>
      createPublicKey({ key: wrap(SPKI, publicKey), format: "der", type: "spki" }),
    );
    return verify(null, message, key, signature);
  },
};

/**
 * Installs the native signer, or leaves the bundled one in place.
 *
 * A build without the native module is a slower mesh rather than a broken one — the same posture
 * every other optional medium takes here — so a failure to reach OpenSSL is reported and swallowed
 * rather than thrown.
 */
export function useNativeCrypto(): void {
  try {
    // proves the module answers before anything depends on it: a signer installed and then found
    // to be absent would fail inside the fold, where there is nothing useful to do about it
    native.verify(Uint8Array.of(1), new Uint8Array(64), new Uint8Array(32));
    useSigner(native);
  } catch (cause) {
    // eslint-disable-next-line no-console -- a silent fallback to 7ms/signature is worth a line
    console.warn("[crypto] native Ed25519 unavailable, using the bundled implementation", cause);
  }
}
