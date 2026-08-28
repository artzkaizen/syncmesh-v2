import type { TelemetryEvent } from "@syncmesh/engine";

/**
 * The relay's slice of the one union D17 decided on, selected by its `type` prefix rather than
 * redeclared here: a variant added in `@syncmesh/engine` is a variant this relay can emit and a
 * consumer's `switch` must handle, with no second definition to keep in step.
 *
 * Nothing in this slice names a peer, a room or a byte of payload. D17 left "may relay telemetry
 * carry peer identity" open as a privacy question, and the safe side of an open question is the
 * one that can still be changed: an identity never emitted can be added later, an identity that
 * reached a metrics pipeline cannot be taken back out of it.
 */
export type RelayTelemetry = Extract<TelemetryEvent, { readonly type: `relay.${string}` }>;
