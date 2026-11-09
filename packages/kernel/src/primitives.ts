export type Brand<T, Tag extends string> = T & { readonly __brand: Tag };

export type Ordering = -1 | 0 | 1;

/** Whether a UTF-16 code unit is half of a surrogate pair: part of a code point above U+FFFF. */
const isSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdfff;

/**
 * Orders two strings by code point, which is the order of their UTF-8 bytes and of Rust's `str`.
 * JavaScript's `<` compares UTF-16 code units instead, which puts a character above U+FFFF before
 * one in U+E000–U+FFFF; the two orders agree everywhere else.
 *
 * @example
 * ["＀", "\u{1F600}"].sort(codePointOrder); // ["＀", "\u{1F600}"]
 */
export function codePointOrder(a: string, b: string): Ordering {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const left = a.charCodeAt(i);
    const right = b.charCodeAt(i);
    if (left === right) continue;
    // a surrogate starts a code point above every unit outside the surrogate range
    if (isSurrogate(left) !== isSurrogate(right)) return isSurrogate(left) ? 1 : -1;
    return left < right ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}
