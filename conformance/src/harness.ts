import { bytesToHex, hexToBytes } from "@syncmesh/wire";

import { wireVectors, type WireVector } from "./vectors.js";

/** What a wire implementation exposes to be checked: this repo fills it in, a port reimplements it. */
export interface WireCodec<Event> {
  readonly decodeCore: (core: Uint8Array) => Event;
  readonly encodeCore: (event: Event) => Uint8Array;
  readonly verify: (core: Uint8Array, sig: Uint8Array, peerId: Uint8Array) => boolean;
}

export type Verdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Decode → re-encode must reproduce `coreHex` exactly, and the signature must verify. */
export function checkVector<Event>(codec: WireCodec<Event>, v: WireVector): Verdict {
  const core = hexToBytes(v.coreHex).unwrap();
  const sig = hexToBytes(v.sigHex).unwrap();
  const peer = hexToBytes(wireVectors.peerId).unwrap();
  const reencoded = bytesToHex(codec.encodeCore(codec.decodeCore(core)));
  if (reencoded !== v.coreHex)
    return { ok: false, reason: `re-encoded core differs: ${reencoded.slice(0, 32)}…` };
  if (!codec.verify(core, sig, peer)) return { ok: false, reason: "signature does not verify" };
  return { ok: true };
}
