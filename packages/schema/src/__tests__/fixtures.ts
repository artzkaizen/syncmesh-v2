/** True when `A` and `B` are the same type, not merely mutually assignable. */
export type Equal<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;

/** Compiles only when the argument type is `true`; the assertion is the type check itself. */
export const assertType = <_T extends true>() => undefined;
