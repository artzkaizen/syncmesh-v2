/**
 * @syncmesh/temporal — the one place syncmesh gets `Temporal` from.
 *
 * Always the polyfill (`temporal-polyfill/implementation`, never the native-preferring entry), even
 * where the runtime has Temporal natively (Bun does, Node 24 does
 * not): a sync engine needs every device to compute instants and durations identically, and
 * one implementation is the only way to promise that. When every target runtime ships
 * Temporal, this file becomes `export const Temporal = globalThis.Temporal` and nothing
 * else changes.
 *
 * Use `Temporal.Instant` for a point in time, `Temporal.Duration` for a length of time.
 * A bare `number` of milliseconds is a wire/storage encoding, never an API type.
 */
export { Temporal } from "temporal-polyfill/implementation";
export type { Temporal as TemporalNamespace } from "temporal-polyfill/implementation";
