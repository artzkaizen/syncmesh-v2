/**
 * Whether this build runs its own instruments — the navigation timer and the SQL tracer.
 *
 * **One constant, because they cost the thread they measure.** `nav-timing` schedules a
 * `setTimeout` and a `requestAnimationFrame` after every commit, and `sql-trace` wraps every
 * statement the driver runs; both do that work on the JS thread, which is the thread whose stalls
 * they exist to catch. An instrument that competes with what it measures reports a number that
 * includes itself, so they are off unless somebody is reading them.
 *
 * A plain constant rather than `__DEV__`, which is true in exactly the build a phone runs, and
 * rather than a setting, which would put a branch on a hot path to answer a question that cannot
 * change while the app is open. Flip it here, reload, and the instruments are back.
 */
export const MEASURING = false;
