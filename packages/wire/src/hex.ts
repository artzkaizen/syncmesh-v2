import { Result, TaggedError } from "@syncmesh/result";

export class InvalidHex extends TaggedError("InvalidHex")<{ input: string; message: string }> {}

const HEX = /^(?:[0-9a-f]{2})*$/;

export function hexToBytes(hex: string): Result<Uint8Array, InvalidHex> {
  if (!HEX.test(hex)) {
    return Result.err(
      new InvalidHex({ input: hex, message: "expected an even count of lowercase hex characters" }),
    );
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return Result.ok(out);
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
