import type { TelemetryEvent } from "@syncmesh/engine";

/**
 * The relay's slice of the one union D17 decided on, selected by its `type` prefix rather than
 * redeclared here: a variant added in `@syncmesh/engine` is a variant this relay can emit and a
 * consumer's `switch` must handle, with no second definition to keep in step.
 *
 * Nothing in this slice names a peer, a room, an event or a byte of payload (D48, decided A). A
 * relay sees many people's traffic: it reports how big and how long, and per-peer diagnosis
 * happens on the device. A variant that needs a `string` field needs a decision of its own first —
 * `telemetry.test.ts` reads every emitted value for the identities it must not hold.
 */
export type RelayTelemetry = Extract<TelemetryEvent, { readonly type: `relay.${string}` }>;
