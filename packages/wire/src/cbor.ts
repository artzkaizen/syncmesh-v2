export type CborKey = number | string;

export type CborValue =
  | number
  | string
  | boolean
  | null
  | Uint8Array
  | readonly CborValue[]
  | ReadonlyMap<CborKey, CborValue>;

const MAJOR = { uint: 0, nint: 1, bytes: 2, text: 3, array: 4, map: 5, simple: 7 } as const;
const SIMPLE = { false: 0xf4, true: 0xf5, null: 0xf6, f64: 0xfb } as const;

const utf8 = new TextEncoder();

/* oxlint-disable anti-slop/no-runtime-typeof -- a serializer is the I/O boundary: it dispatches on the runtime type of the value it encodes */
/** Orders map keys the way the frozen vectors do: integers ascending, then strings by their UTF-8 bytes. */
export function compareKeys(a: CborKey, b: CborKey): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "number") return -1;
  if (typeof b === "number") return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Bytes a fresh writer reserves; most events fit, and growth doubles from here. */
const INITIAL_CAPACITY = 256;

/**
 * Writes into one preallocated `Uint8Array`, doubling it when full, so encoding is a single pass
 * over the payload with amortised O(1) per byte. Byte strings and text are copied with `set`, never
 * spread, which is also what keeps a large blob from overflowing the call stack.
 */
class Writer {
  private buffer = new Uint8Array(INITIAL_CAPACITY);
  private view = new DataView(this.buffer.buffer);
  private length = 0;

  bytes(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }

  private reserve(count: number): number {
    const at = this.length;
    const needed = at + count;
    if (needed > this.buffer.length) {
      let capacity = this.buffer.length * 2;
      while (capacity < needed) capacity *= 2;
      const grown = new Uint8Array(capacity);
      grown.set(this.buffer.subarray(0, at));
      this.buffer = grown;
      this.view = new DataView(grown.buffer);
    }
    this.length = needed;
    return at;
  }

  private byte(b: number): void {
    const at = this.reserve(1);
    this.buffer[at] = b;
  }

  private raw(chunk: Uint8Array): void {
    const at = this.reserve(chunk.length);
    this.buffer.set(chunk, at);
  }

  head(major: number, length: number): void {
    const type = major << 5;
    if (length < 24) this.byte(type | length);
    else if (length < 0x100) {
      const at = this.reserve(2);
      this.buffer[at] = type | 24;
      this.buffer[at + 1] = length;
    } else if (length < 0x10000) {
      const at = this.reserve(3);
      this.buffer[at] = type | 25;
      this.view.setUint16(at + 1, length);
    } else if (length < 0x100000000) {
      const at = this.reserve(5);
      this.buffer[at] = type | 26;
      this.view.setUint32(at + 1, length);
    } else {
      const at = this.reserve(9);
      this.buffer[at] = type | 27;
      // a safe integer has at most 53 bits, so the high word is exact as a float division
      this.view.setUint32(at + 1, Math.floor(length / 0x100000000));
      this.view.setUint32(at + 5, length % 0x100000000);
    }
  }

  value(v: CborValue): void {
    if (v === null) this.byte(SIMPLE.null);
    else if (v === true) this.byte(SIMPLE.true);
    else if (v === false) this.byte(SIMPLE.false);
    else if (typeof v === "number") this.number(v);
    else if (typeof v === "string") this.text(v);
    else if (v instanceof Uint8Array) {
      this.head(MAJOR.bytes, v.length);
      this.raw(v);
    } else if (Array.isArray(v)) {
      this.head(MAJOR.array, v.length);
      for (const item of v) this.value(item);
    } else {
      // SAFETY: every other CborValue member was handled above; only the map remains
      this.map(v as ReadonlyMap<CborKey, CborValue>);
    }
  }

  private number(n: number): void {
    if (Number.isSafeInteger(n)) {
      if (n >= 0) this.head(MAJOR.uint, n);
      else this.head(MAJOR.nint, -1 - n);
      return;
    }
    const at = this.reserve(9);
    this.buffer[at] = SIMPLE.f64;
    this.view.setFloat64(at + 1, n);
  }

  private text(s: string): void {
    const encoded = utf8.encode(s);
    this.head(MAJOR.text, encoded.length);
    this.raw(encoded);
  }

  private map(m: ReadonlyMap<CborKey, CborValue>): void {
    const keys = [...m.keys()].sort(compareKeys);
    this.head(MAJOR.map, keys.length);
    for (const k of keys) {
      const v = m.get(k);
      if (v === undefined) continue;
      this.value(k);
      this.value(v);
    }
  }
}

/* oxlint-enable anti-slop/no-runtime-typeof */

/** Canonical CBOR: shortest heads, sorted keys, safe integers as integers, everything else f64. Absent optionals are simply not in the map. */
export function encodeCbor(value: CborValue): Uint8Array {
  const w = new Writer();
  w.value(value);
  return w.bytes();
}
