/**
 * The practice this demo runs under, as the id a call names it by (`practiceId`).
 *
 * A module of its own so a browser can name the ward without importing the manifest.
 */
export const PRACTICE_ID = "st-mary";

/** The same practice as a partition key, in the `kind:id` form a grant names. */
export const PRACTICE = `practice:${PRACTICE_ID}`;
