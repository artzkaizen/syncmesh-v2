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

/** How long to wait between tries: `first` after the first failure, doubling, never past `most`. */
export interface RetryPolicy {
  readonly first: Temporal.Duration;
  readonly most: Temporal.Duration;
}

/**
 * The wait after `failures` failures in a row: `first`, doubled once per failure since, capped
 * at `most`.
 *
 * @example
 * const policy = { first: Temporal.Duration.from({ seconds: 1 }), most: Temporal.Duration.from({ seconds: 30 }) };
 * backoff(policy, 1); // PT1S
 * backoff(policy, 3); // PT4S
 * backoff(policy, 9); // PT30S
 */
export function backoff({ first, most }: RetryPolicy, failures: number): Temporal.Duration {
  let wait = first;
  for (let n = 1; n < failures && Temporal.Duration.compare(wait, most) < 0; n++)
    wait = wait.add(wait);
  return Temporal.Duration.compare(wait, most) > 0 ? most : wait;
}
