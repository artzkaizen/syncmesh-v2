import { Temporal } from "@syncmesh/temporal";

/**
 * The one place a time crosses between Drizzle and the rest of the app.
 *
 * syncmesh carries a `timestamp` column as epoch milliseconds and hands it back as a
 * `Temporal.Instant`; Drizzle's `timestamp_ms` mode hands back a `Date`. Both are right about
 * their own layer and neither knows about the other, so `fromDrizzle` warns and this module is
 * the answer to the warning: two named functions at the seam, rather than a `new Date(...)`
 * scattered through twenty handlers where the next reader has to work out which side they are on.
 */

/** An instant, as a statement writes it. */
export const at = (when: Temporal.Instant): Date => new Date(when.epochMilliseconds);

/** An instant, or nothing — the shape every nullable time column here takes. */
export const atOrNull = (when: Temporal.Instant | null): Date | null =>
  when === null ? null : at(when);

/** A row's time column, as the app reads it. */
export const instantOf = (when: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(when.getTime());

/**
 * An ISO-8601 instant as a procedure takes one over the wire. Times arrive from a UI, an HTTP
 * body or a seed script as text, and parsing them here means a bad one is refused at the door
 * rather than stored as an `Invalid Date` that only fails much later, on someone else's device.
 */
export const parseInstant = (iso: string): Temporal.Instant => Temporal.Instant.from(iso);
