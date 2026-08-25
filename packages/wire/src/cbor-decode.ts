import { Result, TaggedError } from "@syncmesh/result";

import type { CborKey, CborValue } from "./cbor.js";

export class MalformedCbor extends TaggedError("MalformedCbor")<{
  offset: number;
  message: string;
}> {}

const utf8 = new TextDecoder("utf-8", { fatal: true });

class Reader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  done(): boolean {
    return this.offset >= this.bytes.length;
  }

  fail(message: string): MalformedCbor {
    return new MalformedCbor({ offset: this.offset, message });
  }

  value(): Result<CborValue, MalformedCbor> {
    const first = this.bytes[this.offset];
    if (first === undefined) return Result.err(this.fail("unexpected end"));
    this.offset++;
    const major = first >> 5;
    const info = first & 0x1f;
    if (major === 7) return this.simple(info);
    const length = this.length(info);
    if (length.isErr()) return length;
    const n = length.value;
    switch (major) {
      case 0:
        return Result.ok(n);
      case 1:
        return Result.ok(-1 - n);
      case 2:
        return this.take(n);
      case 3:
        return this.take(n).andThen((b) => this.text(b));
      case 4:
        return this.array(n);
      case 5:
        return this.map(n);
      default:
        return Result.err(this.fail(`tags are not part of the wire (major ${major})`));
    }
  }

  private length(info: number): Result<number, MalformedCbor> {
    if (info < 24) return Result.ok(info);
    const width = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
    if (width === 0)
      return Result.err(this.fail(`indefinite lengths are not part of the wire (info ${info})`));
    let n = 0;
    for (let i = 0; i < width; i++) {
      const b = this.bytes[this.offset + i];
      if (b === undefined) return Result.err(this.fail("unexpected end in length"));
      n = n * 256 + b;
    }
    this.offset += width;
    if (!Number.isSafeInteger(n)) return Result.err(this.fail("length beyond safe integer"));
    return Result.ok(n);
  }

  private simple(info: number): Result<CborValue, MalformedCbor> {
    if (info === 20) return Result.ok(false);
    if (info === 21) return Result.ok(true);
    if (info === 22) return Result.ok(null);
    if (info === 27) {
      return this.take(8).map((b) => new DataView(b.buffer, b.byteOffset, 8).getFloat64(0));
    }
    return Result.err(this.fail(`simple value ${info} is not part of the wire`));
  }

  private take(n: number): Result<Uint8Array, MalformedCbor> {
    if (this.offset + n > this.bytes.length)
      return Result.err(this.fail("unexpected end in payload"));
    const out = this.bytes.slice(this.offset, this.offset + n);
    this.offset += n;
    return Result.ok(out);
  }

  private text(b: Uint8Array): Result<string, MalformedCbor> {
    return Result.try({ try: () => utf8.decode(b), catch: () => this.fail("invalid utf-8") });
  }

  private array(n: number): Result<CborValue, MalformedCbor> {
    const items: CborValue[] = [];
    for (let i = 0; i < n; i++) {
      const item = this.value();
      if (item.isErr()) return item;
      items.push(item.value);
    }
    return Result.ok(items);
  }

  private map(n: number): Result<CborValue, MalformedCbor> {
    const m = new Map<CborKey, CborValue>();
    for (let i = 0; i < n; i++) {
      const k = this.value();
      if (k.isErr()) return k;
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- decoding is the I/O boundary; a key's runtime type is the fact being checked
      if (typeof k.value !== "number" && typeof k.value !== "string") {
        return Result.err(this.fail("map keys are integers or strings"));
      }
      const v = this.value();
      if (v.isErr()) return v;
      m.set(k.value, v.value);
    }
    return Result.ok(m);
  }
}

/** Reads one CBOR item; anything malformed, truncated, or trailing is a value, never a throw. */
export function decodeCbor(bytes: Uint8Array): Result<CborValue, MalformedCbor> {
  const r = new Reader(bytes);
  return r.value().andThen((v) => (r.done() ? Result.ok(v) : Result.err(r.fail("trailing bytes"))));
}
