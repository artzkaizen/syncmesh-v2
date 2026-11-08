/** Why a socket this file hung up hung up, said once here and read by the close that follows. */
export const MUTE = "the relay stopped answering: no frame within 2.5 times its keepalive";
export const REFUSED = "the relay speaks none of the protocol versions this build offers";
export const UNSENT = "the frame did not leave the relay socket";
export const UNSECURED = "the link is not sealed yet, and nothing but a hello travels before it is";
export const UNDIALLED = "the relay could not be dialled";
export const RETAINED =
  "the relay has trimmed its history below this device's cursors, so it waits for state from a peer before dialling that room again";
export const REENTITLED =
  "the relay admits this device under a different entitlement, so it re-pages from nothing";

/** A thrown cause in words, or the sentence that stands in when it brought none. */
export const causeText = (cause: unknown, fallback: string): string =>
  cause instanceof Error ? cause.message : fallback;
