import type { Identity } from "@syncmesh/wire";

import { createIdentity } from "@syncmesh/wire";

/**
 * A demo keypair derived from a name, so a restarted process is the same peer and the grants it
 * was issued still name it.
 *
 * Never do this. A device generates its seed once, on first run, and keeps it in the platform's
 * keystore; a server's issuer seed comes from a secret manager. A seed anyone can recompute from
 * a string is a signing key everyone holds.
 */
export const identityNamed = (name: string): Identity =>
  createIdentity(new Bun.CryptoHasher("sha256").update(name).digest()).unwrap();

/** The backend's own identity: the room's issuer, and the peer whose database holds the rows. */
export const serverIdentity = (): Identity => identityNamed("syncmesh-example-server");
