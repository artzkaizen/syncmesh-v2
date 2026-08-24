export type Brand<T, Tag extends string> = T & { readonly __brand: Tag };

export type Ordering = -1 | 0 | 1;
