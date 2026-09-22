import { TaggedError, panic } from "@syncmesh/result";

/**
 * The one thing that has to work before any key exists.
 *
 * Device keys, content keys and handshake nonces are all drawn from here, and all three are drawn
 * at moments when there is nothing yet to fall back on — a first run has no identity to reuse and
 * no peer to ask. So the source is resolved once, loudly, and never guessed: the value an app
 * passed, else the platform's own `crypto.getRandomValues`, else a failure that names the fix.
 *
 * **A weak source is worse than no source.** `Math.random` is not a candidate and never appears
 * here: a device key drawn from it is forgeable, and the forgery is undetectable afterwards
 * because the key is the identity. React Native is the platform this exists for — it ships no
 * global `crypto`, and `expo-crypto`'s `getRandomValues` is the one line that fixes it.
 */

/** Fills a buffer with cryptographically strong bytes and hands it back — `getRandomValues`. */
export type Entropy = <T extends ArrayBufferView>(into: T) => T;

/**
 * No source of secure randomness on this platform, raised where a key would have been made.
 *
 * Named rather than thrown as a bare `Error` because the fix is specific and belongs in the
 * message: on React Native, pass `expo-crypto`'s `getRandomValues` as `entropy`.
 */
export class NoSecureRandomness extends TaggedError("NoSecureRandomness")<{ message: string }> {}

let supplied: Entropy | undefined;

/**
 * The app's own source, from `createClient({ entropy })`.
 *
 * Process-wide rather than threaded through every call site, because the alternative is an
 * argument on every key, nonce and content key in the system — and one place that forgot it would
 * be one place drawing from a different source than the rest, which is the bug this prevents.
 */
export const supplyEntropy = (fill: Entropy): void => {
  supplied = fill;
};

/** The platform's own, where there is one. Read per call: a polyfill may install itself late. */
const platform = (): Entropy | undefined => {
  // SAFETY: `crypto` is absent on some runtimes and typed as present on others; this states the
  // only shape either case can have, and the call below is guarded on the method existing
  const host = (globalThis as { crypto?: { getRandomValues?: Entropy } }).crypto;
  return host?.getRandomValues === undefined ? undefined : host.getRandomValues.bind(host);
};

/**
 * `n` cryptographically strong bytes.
 *
 * Panics rather than returning a `Result`, and that is the one place in this codebase where that
 * is the right call: every caller is minting a secret, and there is no weaker secret to carry on
 * with. A `Result` here would invite exactly the fallback that makes the key worthless.
 */
export const randomBytes = (n: number): Uint8Array => {
  const fill = supplied ?? platform();
  if (fill === undefined)
    panic(
      new NoSecureRandomness({
        message:
          "no secure randomness on this platform: pass `entropy` to createClient — expo-crypto's getRandomValues on React Native",
      }).message,
    );
  return fill(new Uint8Array(n));
};
