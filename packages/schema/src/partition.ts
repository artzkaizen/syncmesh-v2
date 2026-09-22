import type { RoleSet } from "@syncmesh/policy";

import { NO_ROLES } from "@syncmesh/policy";
import { panic } from "@syncmesh/result";

import { parseTableName } from "./names.js";

/** The three kinds every manifest has without declaring them; a kind may not take one of these names. */
export const RESERVED = new Set<string>(["global", "user", "local"]);

/**
 * One partition kind, as the value that declares it (§2.1).
 *
 * A kind has a name, its roles, and whether it is sealed — and nothing else, because nothing
 * else about a kind is true. The tree form this replaces made a kind's *position* mean something:
 * D07 decided a nested kind would live in its parent's store, so where you wrote it decided which
 * file its rows went in. That was never implemented — `storeNameFor` builds a filename from
 * `kind:id` with no parent lookup — so nesting silently degraded into "inherit the parent's role
 * ladder" and the place named after a kind was `{}`.
 *
 * Sharing a ladder is a value reference now, which is what the tree was faking:
 *
 * ```ts
 * const workspace = partition("workspace", { roles: ladder("owner", "admin", "member") });
 * const embargo   = partition("embargo",   { sealed: true, roles: workspace.roles });
 * ```
 *
 * The schema describes the data model. Where files go is storage's business, and a device that
 * holds too many of them is answered by `scopedStores`' cache, never by the app drawing a tree.
 */
export interface Partition<N extends string = string, R extends string = string> {
  /** The discriminant that tells a declared kind from the bare string the tree form used. */
  readonly declared: true;
  readonly name: N;
  /**
   * End-to-end encrypted content (book ch. 14): every carrier holds ciphertext, including the
   * server's custody role. Buys operator-proof custody, costs **all** server-side judgment for
   * this kind — no Postgres fold, no watchdogs, no corrections, because a judge has to read.
   */
  readonly sealed: boolean;
  /** The roles its rules may name, as {@link ladder} or {@link flat} built them; {@link NO_ROLES} for a kind whose rules never name one. */
  readonly roles: RoleSet<R>;
}

/** The role names a table in this kind may write in `role(...)`. */
export type RolesOf<P> = P extends Partition<string, infer R> ? R : never;

/**
 * Declares a partition kind.
 *
 * ```ts
 * const ward = partition("ward", { roles: ladder("consultant", "nurse", "student") });
 * const notes = partition("notes", { sealed: true, roles: ward.roles });
 * ```
 */
export function partition<const N extends string, const R extends string = never>(
  name: N,
  options: {
    readonly sealed?: boolean;
    readonly roles?: RoleSet<R>;
  } = {},
): Partition<N, R> {
  if (RESERVED.has(name)) panic(`partition kind "${name}" is reserved`);
  if (parseTableName(name).isErr())
    panic(`partition kind "${name}": a kind name follows the table grammar`);
  return {
    declared: true,
    name,
    sealed: options.sealed ?? false,
    roles: options.roles ?? NO_ROLES,
  };
}

/** One {@link RoleSet}; a name declared twice would make its position ambiguous, so it throws. */
const roleSet = <const N extends readonly string[]>(
  names: N,
  ordered: boolean,
): RoleSet<N[number]> => {
  if (new Set<string>(names).size !== names.length)
    panic(`roles: a role is named twice in ${names.join(", ")}`);
  return { names, ordered };
};

/**
 * The roles of a partition kind in seniority order, **most senior first**.
 *
 * `ladder("owner", "admin", "member")` means `role("member")` admits a member *and everyone
 * above them* — owners and admins — because `roleAtLeast` passes when the holder's index is at
 * or before the wanted one (`@syncmesh/policy`'s `roleAtLeast`, which documents the same
 * direction).
 *
 * A function rather than a bare array because the order **is** the rule: a manifest that listed
 * them the other way round would compile and quietly invert every permission in the app —
 * `role("owner")` would start admitting guests. Naming the shape is what makes the direction
 * reviewable at the call site, and what tells the evaluator this set is ordered where
 * {@link flat}'s is not.
 */
export const ladder = <const N extends readonly string[]>(...names: N): RoleSet<N[number]> =>
  roleSet(names, true);

/**
 * The roles of a partition kind with no order between them.
 *
 * `flat("auditor", "billing")` means `role("auditor")` admits an auditor and nobody else: the
 * position of a name in the list is spelling, not seniority, and the evaluator never compares
 * two of them. Where one role should stand in for another, that is a {@link ladder}.
 */
export const flat = <const N extends readonly string[]>(...names: N): RoleSet<N[number]> =>
  roleSet(names, false);

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion -- this IS the boundary: a manifest entry's `partition` is whatever the app wrote there, and telling a declared kind from the tree form's bare name is the parse. There is no earlier place to do it. */

/** Whether a table entry's `partition` is a declared value rather than the tree form's string. */
export const isPartition = (value: unknown): value is Partition =>
  typeof value === "object" && value !== null && (value as Partition).declared === true;

/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion */

/**
 * The three kinds every app has, as values — so `partition: global` needs no string and no
 * memory of which names are spelled which way.
 *
 * `global` is server-written and read by everyone (reference data); `user` follows one account
 * across its devices; `local` never leaves this device and is refused on the wire. None of them
 * takes an `allow` block: what they are *is* their rule.
 */
export const global: Partition<"global", never> = {
  declared: true,
  name: "global",
  sealed: false,
  roles: NO_ROLES,
};
export const user: Partition<"user", never> = {
  declared: true,
  name: "user",
  sealed: false,
  roles: NO_ROLES,
};
export const local: Partition<"local", never> = {
  declared: true,
  name: "local",
  sealed: false,
  roles: NO_ROLES,
};

/** One of the three kinds every app has, as the value that names it; a table in one takes no `allow`. */
export type ReservedPartition = typeof global | typeof user | typeof local;
