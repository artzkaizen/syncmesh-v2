import { Result, TaggedError } from "@syncmesh/result";

/**
 * The one boundary this package encodes at.
 *
 * `@syncmesh/rn-ble` presents every byte as base64, because that is what crosses a React Native
 * bridge cheaply, so a frame is base64 on its way to the radio and back. Hand-rolled rather than
 * taken from a runtime: `atob` is not in React Native and `Buffer` is not there either, which is
 * the same reason the previous implementation carried its own.
 *
 * Nothing else in syncmesh is base64. If the module ever hands over an `ArrayBuffer` directly —
 * the New Architecture allows it — this file is what disappears, and nothing above it changes.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Reverse of {@link ALPHABET}; `-1` is "not a base64 digit", which is how junk is caught. */
const VALUES = /* @__PURE__ */ (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i += 1) table[ALPHABET.charCodeAt(i)] = i;
  return table;
})();

export class NotBase64 extends TaggedError("NotBase64")<{ message: string }> {}

export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const left = bytes.length - i;
    out += ALPHABET[a >> 2];
    out += ALPHABET[((a & 3) << 4) | (b >> 4)];
    out += left > 1 ? ALPHABET[((b & 15) << 2) | (c >> 6)] : "=";
    out += left > 2 ? ALPHABET[c & 63] : "=";
  }
  return out;
}

/**
 * Bytes back, or a value saying they were not base64 — never a throw and never a silent
 * half-decode, because what arrives here came off a radio and is not this device's to trust.
 */
export function base64ToBytes(text: string): Result<Uint8Array, NotBase64> {
  const body = text.endsWith("==")
    ? text.slice(0, -2)
    : text.endsWith("=")
      ? text.slice(0, -1)
      : text;
  if (body.length % 4 === 1)
    return Result.err(
      new NotBase64({ message: `${text.length} characters is not a base64 length` }),
    );
  const out = new Uint8Array((body.length * 3) >> 2);
  let at = 0;
  let bits = 0;
  let held = 0;
  for (let i = 0; i < body.length; i += 1) {
    const code = body.charCodeAt(i);
    const value = code < 128 ? (VALUES[code] ?? -1) : -1;
    if (value < 0)
      return Result.err(new NotBase64({ message: `"${body[i]}" is not a base64 digit` }));
    held = (held << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (held >> bits) & 0xff;
    }
  }
  return Result.ok(out.subarray(0, at));
}
