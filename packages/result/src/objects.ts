/**
 * Drops undefined-valued keys. For option plumbing: every `...(x !== undefined && { x })`
 * in this codebase is this function, spelled out because nothing shared it — now it does.
 *
 * The type follows the values: keys that cannot be undefined stay required, keys that
 * may be become optional without `undefined` in their type (which is what
 * `exactOptionalPropertyTypes` demands of an omitted key), and keys that can only be
 * `undefined` vanish. Values are kept by reference, never cloned.
 */
export type Defined<T extends object> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as T[K] extends undefined
    ? never
    : undefined extends T[K]
      ? K
      : never]?: Exclude<T[K], undefined>;
};

export function omitUndefined<T extends object>(value: T): Defined<T> {
  const kept = Object.entries(value).filter((entry) => entry[1] !== undefined);
  // SAFETY: kept holds exactly the defined entries of value, same values by reference,
  // which is what Defined<T> describes.
  return Object.fromEntries(kept) as Defined<T>;
}
