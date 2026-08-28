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

/** A day is exactly 86_400_000 milliseconds here, and no offset ever moves under a duration. */
const EPOCH_UTC = Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO("UTC");

/**
 * A duration in milliseconds, days and weeks included — `Duration.total` refuses those on its
 * own, because a calendar unit is not a number of milliseconds until something says when it
 * starts. Measured against the epoch in UTC, where a day is exactly 86_400_000 and no offset
 * ever moves.
 *
 * @example
 * durationMs(Temporal.Duration.from({ days: 7 })); // 604800000
 */
export function durationMs(duration: Temporal.Duration): number {
  return duration.total({ unit: "milliseconds", relativeTo: EPOCH_UTC });
}
