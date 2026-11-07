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

/**
 * Bytes appended into one buffer that doubles when full. A `number[]` grown by spreading every
 * byte in managed about 3 MB/s, which stalls any frame the size of a screen of rows or a blob.
 */
class Writer {
  private buffer = new Uint8Array(256);
  private length = 0;

  bytes(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }

  private reserve(n: number): void {
    if (this.length + n <= this.buffer.length) return;
    let size = this.buffer.length * 2;
    while (size < this.length + n) size *= 2;
    const grown = new Uint8Array(size);
    grown.set(this.buffer.subarray(0, this.length));
    this.buffer = grown;
  }

  private push(...bytes: number[]): void {
    this.reserve(bytes.length);
    for (const b of bytes) this.buffer[this.length++] = b;
  }

  private append(bytes: Uint8Array): void {
    this.reserve(bytes.length);
    this.buffer.set(bytes, this.length);
    this.length += bytes.length;
  }

  head(major: number, length: number): void {
    const type = major << 5;
    if (length < 24) this.push(type | length);
    else if (length < 0x100) this.push(type | 24, length);
    else if (length < 0x10000) this.push(type | 25, length >>> 8, length & 0xff);
    else if (length < 0x100000000) this.push(type | 26, ...be(length, 4));
    else this.push(type | 27, ...be(length, 8));
  }

  value(v: CborValue): void {
    if (v === null) this.push(SIMPLE.null);
    else if (v === true) this.push(SIMPLE.true);
    else if (v === false) this.push(SIMPLE.false);
    else if (typeof v === "number") this.number(v);
    else if (typeof v === "string") this.text(v);
    else if (v instanceof Uint8Array) {
      this.head(MAJOR.bytes, v.length);
      this.append(v);
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
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, n);
    this.push(SIMPLE.f64);
    this.append(new Uint8Array(view.buffer));
  }

  private text(s: string): void {
    const encoded = utf8.encode(s);
    this.head(MAJOR.text, encoded.length);
    this.append(encoded);
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

const be = (n: number, width: number): number[] => {
  const out: number[] = [];
  let rest = n;
  for (let i = 0; i < width; i++) {
    out.unshift(rest % 256);
    rest = Math.floor(rest / 256);
  }
  return out;
};

/** Canonical CBOR: shortest heads, sorted keys, safe integers as integers, everything else f64. Absent optionals are simply not in the map. */
export function encodeCbor(value: CborValue): Uint8Array {
  const w = new Writer();
  w.value(value);
  return w.bytes();
}
