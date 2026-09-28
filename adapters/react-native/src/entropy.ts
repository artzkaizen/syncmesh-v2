import { getRandomValues, randomUUID } from "expo-crypto";

/**
 * The randomness every signature on this device rests on, installed before anything asks for it.
 *
 * React Native has no `crypto.getRandomValues` — Hermes ships no WebCrypto — and the engine needs
 * one before it can do anything at all: the device key is an Ed25519 seed, and every event this
 * phone ever writes is signed with it. Without this the first thing a person sees is "this
 * install's device key would not open", which is true but unhelpful.
 *
 * `expo-crypto` is the platform's own answer, backed by `SecRandomCopyBytes` on iOS and
 * `SecureRandom` on Android, and it is present in Expo Go as well as in a dev build — so the app
 * has real entropy in every client it can run in. Imported for its effect, first, by the root
 * layout: a module that captured `crypto` before this ran would keep the empty one.
 *
 * **Both halves are needed, and the second is easy to miss.** `getRandomValues` is what the device
 * key is made of; `randomUUID` is what an operation id and a presence session are made of, and
 * Hermes has neither. Supplying only the first gets as far as opening the database and then fails
 * inside the engine with "undefined is not a function", several layers from anything a reader
 * would connect to entropy.
 *
 * Deliberately not a silent fallback to `Math.random()`: a predictable key is worse than no key,
 * because it fails later and quietly, on somebody else's device.
 */
/**
 * Each member is checked on its own, because they arrive from different places.
 *
 * Guarding both behind one `if (getRandomValues === undefined)` is the bug this replaced:
 * importing `expo-crypto` installs `getRandomValues` as a side effect, so the guard was false by
 * the time it ran and `randomUUID` was never supplied — and the app failed several layers later,
 * inside the engine, with "undefined is not a function".
 */
/**
 * The two members the engine reaches for, named as themselves rather than as `Crypto`.
 *
 * This object is not a `Crypto` and should not claim to be: `expo-crypto`'s `getRandomValues`
 * accepts the typed arrays it can fill rather than every `BufferSource` the DOM interface admits,
 * so `satisfies Pick<Crypto, …>` is a promise this cannot keep. What it *can* promise is the pair
 * the device key and the operation ids are made of, which is what this names.
 */
interface Entropy {
  readonly getRandomValues: typeof getRandomValues;
  readonly randomUUID: typeof randomUUID;
}

// SAFETY: `globalThis.crypto` is whatever this runtime supplies and may be absent entirely —
// `Partial<Crypto>` is the claim being made about it, which is that nothing can be assumed present
const web = globalThis.crypto as Partial<Crypto> | undefined;

/**
 * Both members installed, rather than each kept if it happened to be there.
 *
 * Preferring an existing member is what the earlier version did, and on this runtime it is the
 * wrong instinct twice over. It is what let `randomUUID` go missing — `expo-crypto`'s own import
 * supplies `getRandomValues`, so a guard that checked one and assumed both left the other out. And
 * there is nothing here worth preferring: React Native ships no WebCrypto, so the only members
 * that can exist are ones a polyfill put there, and this is that polyfill.
 *
 * `web` is still spread first, so anything else a runtime does provide — a `subtle`, on some
 * future client — survives having these two written over it.
 */
const filled = { getRandomValues, randomUUID } satisfies Entropy;

Object.defineProperty(globalThis, "crypto", { configurable: true, value: { ...web, ...filled } });
