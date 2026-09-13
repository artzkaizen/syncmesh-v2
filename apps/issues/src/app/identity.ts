import { createIdentity } from "@syncmesh/wire";

/**
 * Who this install is, and who vouched for it.
 *
 * One file rather than a constant in each thread, because the worker signs every event with the
 * key below and every tab names the account below on every write it asks for. A second copy of
 * either would be a second device wearing this one's face, and the log is the place that would
 * say so.
 *
 * **The device key is generated once per install and then read back from the database.** It used
 * to come from a fixed seed, which was the honest answer while `transports: []` meant no second
 * device existed to lie to. A relay makes one exist, and a bundled key makes every install of
 * this app the *same author*: two browsers publishing two divergent `(author, seq)` streams into
 * one log, where the loser's writes are not rejected but silently dropped as already-seen. So the
 * key is per install. What a fixed seed was protecting against — a new author on every reload,
 * which turns one person's log into a crowd of strangers — is answered by persisting it rather
 * than by sharing it.
 */

/** Demo keys, derived from fixed seeds rather than generated. */
const bytes = (n: number) => Uint8Array.from({ length: 32 }, (_, index) => (n + index) % 256);

/**
 * **The issuer's private half is in this bundle, and that is not production-safe.**
 *
 * Said plainly because the rest of this app is careful, and a reader who sees a device key
 * generated per install and persisted might reasonably assume the grant beside it is too. It is
 * not: every install of this build mints its own grant locally from the key below, which means
 * every install can mint a grant for anybody. In a real deployment step ② of flow A is a **round
 * trip** — the device asks, an authority that holds this key alone decides, and what comes back is
 * bytes the device could not have produced. `mesh.requestGrant()` is the ask, and the relay
 * carries it: nothing else in `mesh-worker.ts` would change.
 *
 * It is kept rather than handed to the relay because a relay that issued grants would be a *worse*
 * lie — it would look like the round trip without being one. A relay holds no issuer key and
 * verifies nothing (see `createGrantCache`); it forwards grants it cannot read. Minting here, in
 * the open, at least puts the shortcut where somebody reading the demo will find it.
 *
 * The two installs sharing one issuer is what makes them recognise each other's grants, which is
 * exactly what one authority does for two of its devices.
 */
export const issuer = createIdentity(bytes(1)).unwrap();

/**
 * The peer whose writes this build accepts on `number`, shipped in config like the issuer.
 *
 * A device does not trust the authority because it *answered* — it trusts the events, and it
 * checks them against this id before folding one. So the round trip and the trust are two
 * separate things: the URL is how a device asks, and this is how it decides whether to believe
 * what comes back. See `server/authority.ts`, which holds the private half.
 */
export const AUTHORITY_PEER = createIdentity(bytes(200)).unwrap().peerId;

/** Ada, who is an admin — the seed attributes its comments to her, and only an admin may seed. */
export const ACTOR = "acct_ada";
