import { Temporal } from "@syncmesh/temporal";

/** What the engine reports about itself; the top object (E09) re-emits it. Shape only — D17 decides the sink. */
export type TelemetryEvent =
  | {
      readonly type: "engine.mutate";
      readonly sizes: { readonly changes: number };
      readonly duration: Temporal.Duration;
    }
  | {
      readonly type: "engine.fold";
      readonly sizes: { readonly events: number; readonly keys: number };
      readonly duration: Temporal.Duration;
    };

export type TelemetryListener = (event: TelemetryEvent) => void;

/** Runs `block` and reports how long it took, in milliseconds as a `Duration`. */
export function timed<T>(block: () => T): readonly [T, Temporal.Duration] {
  const start = Temporal.Now.instant();
  const value = block();
  return [value, start.until(Temporal.Now.instant())];
}
