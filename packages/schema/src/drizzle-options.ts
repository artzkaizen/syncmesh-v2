import type { AllowFn } from "./bind.js";
import type { ColumnsFromDrizzle, DrizzleTableLike, FromDrizzleOptions } from "./from-drizzle.js";
import type { Partition, ReservedPartition } from "./partition.js";

/**
 * A table in a declared kind: the {@link Partition} its rows live in, and rules that may name
 * only that kind's roles.
 *
 * `R` is the kind's own ladder, read off the `partition` value, so `role()` takes exactly those
 * names — a role from another kind does not compile, and a kind declared without roles leaves
 * `role()` with no name it can be called with.
 */
export interface DrizzleTableInKind<
  D extends DrizzleTableLike,
  N extends string,
  R extends string,
> extends FromDrizzleOptions<D> {
  readonly partition: Partition<N, R>;
  readonly allow: AllowFn<ColumnsFromDrizzle<D>, R>;
}

/** A table in `global`, `user` or `local`: what the kind is *is* its rule, so it takes no `allow`. */
export interface DrizzleTableReserved<D extends DrizzleTableLike> extends FromDrizzleOptions<D> {
  readonly partition: ReservedPartition;
  readonly allow?: undefined;
}

/** Every option `drizzleTable` reads, as the implementation sees them; the overloads narrow this per form. */
export interface DrizzleTableOptions<D extends DrizzleTableLike> extends FromDrizzleOptions<D> {
  readonly partition?: Partition;
  readonly allow?: AllowFn<ColumnsFromDrizzle<D>, string> | undefined;
}

/** The derived half every form of `drizzleTable` returns. */
export interface DrizzleEntry<D extends DrizzleTableLike> {
  readonly columns: ColumnsFromDrizzle<D>;
}
