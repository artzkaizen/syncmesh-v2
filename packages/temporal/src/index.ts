import { Temporal } from "temporal-polyfill/implementation";

/** The Temporal API, always from `temporal-polyfill/implementation`. */
export { Temporal } from "temporal-polyfill/implementation";
export type { Temporal as TemporalNamespace } from "temporal-polyfill/implementation";

/**
 * `instant + duration`, reading days and weeks as UTC calendar days — an Instant alone refuses them.
 *
 * @example
 * addToInstant(now, Temporal.Duration.from({ days: 7 }));
 * addToInstant(now, keepAtLeast.negated()); // now − keepAtLeast
 */
export function addToInstant(
  instant: Temporal.Instant,
  duration: Temporal.Duration,
): Temporal.Instant {
  const relativeTo = instant.toZonedDateTimeISO("UTC");
  return Temporal.Instant.fromEpochMilliseconds(
    instant.epochMilliseconds + duration.total({ unit: "milliseconds", relativeTo }),
  );
}
