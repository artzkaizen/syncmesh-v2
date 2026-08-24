# @syncmesh/temporal

The one place syncmesh imports `Temporal` from.

It is always the polyfill's own implementation (`temporal-polyfill/implementation`), even on
runtimes that ship Temporal natively (Bun does; Node 24 does not). Devices in a mesh must
compute instants and durations identically, and one implementation is the only way to
promise that. When every target runtime ships Temporal, this package switches to
`globalThis.Temporal` and nothing else changes.

Use `Temporal.Instant` for a point in time and `Temporal.Duration` for a length of time. A
bare `number` of milliseconds is a wire or storage encoding, never an API type.
