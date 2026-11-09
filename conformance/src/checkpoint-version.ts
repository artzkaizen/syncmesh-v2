/** A certificate re-signed in another format, for the vectors that pin its refusal (gaps U34). */
import { decodeCbor, encodeCbor, splitEnvelope, type Identity } from "@syncmesh/wire";

/** `wire` re-signed by `issuer` with its core's version (key 0) set to `version`. */
export function resignedAsVersion(issuer: Identity, wire: Uint8Array, version: number): Uint8Array {
  const core = decodeCbor(splitEnvelope(wire).unwrap().core).unwrap();
  if (!(core instanceof Map)) throw new Error("a certificate core is a map");
  const older = encodeCbor(new Map([...core, [0, version]]));
  return encodeCbor([older, issuer.sign(older)]);
}
