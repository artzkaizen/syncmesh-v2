/**
 * Ed25519 as the platform can do it, rather than as this package must.
 *
 * The bundled implementation is pure JavaScript and correct everywhere, which is why it is the
 * default — but it is arithmetic on big integers, and an engine without fast bignums charges
 * accordingly. On React Native's Hermes a single verification measures ~7ms, and a device joining
 * a workspace verifies one per event: a log of 1,271 events costs ~9.8s of nothing but signature
 * checking, which is essentially the whole of a cold join.
 *
 * A platform with a native implementation does the same work in tens of microseconds. This is
 * where it says so.
 */

/** What a host may supply in place of the bundled implementation. Both calls are synchronous. */
export interface Signer {
  /** The detached signature over `message` for the identity this `seed` belongs to. */
  readonly sign: (message: Uint8Array, seed: Uint8Array) => Uint8Array;
  /** Whether `signature` covers `message` under `publicKey`. Must never throw. */
  readonly verify: (message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array) => boolean;
}

let supplied: Signer | undefined;

/**
 * The host's own Ed25519, from `createClient({ signer })` or the app's own boot.
 *
 * Process-wide rather than threaded through every call site, for the same reason entropy is: the
 * alternative is an argument on every event, grant, receipt and certificate in the system, and one
 * place that forgot it would verify under different rules than the rest.
 *
 * **It replaces an implementation, never a decision.** What counts as a valid signature is fixed
 * by Ed25519 and by the bytes each core encodes; a signer that disagreed with the bundled one
 * about any message would be a broken signer, not a configurable policy.
 */
export const useSigner = (signer: Signer): void => {
  supplied = signer;
};

/** The supplied signer, or nothing — read per call, because a host may install one late. */
export const hostSigner = (): Signer | undefined => supplied;
