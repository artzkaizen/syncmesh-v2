/** A nominal type: `T` that cannot be confused with another `T` carrying a different tag. */
export type Brand<T, Tag extends string> = T & { readonly __brand: Tag };

/** Result of a comparator: less, equal, greater. */
export type Ordering = -1 | 0 | 1;
