/**
 * How long a cold join actually takes, and over how much.
 *
 * A replica that already holds the workspace opens in milliseconds; one that holds nothing has to
 * receive every event, check every signature and fold the lot before it can draw a list. Those are
 * different questions and the second is the one that decides whether this system is usable at
 * scale — so it is measured rather than estimated, against the size it was measured over.
 */

/** What the numbers below were measured over, so a duration can be read per unit of work. */
export interface Scale {
  /** Events in this device's log. */
  readonly events: number;
  /** Materialized rows in the state cache. */
  readonly rows: number;
  /** Bytes of signed event core held — the log's own weight, not the file's. */
  readonly bytes: number;
}

export interface Timeline {
  /** Bundle evaluation to this device answering out of its own store — possibly with nothing. */
  readonly toAnswered: number | undefined;
  /** Bundle evaluation to a row actually being on screen. */
  readonly toFirstRows: number | undefined;
  /** Bundle evaluation to every source reporting it has nothing further to send. */
  readonly toSettled: number | undefined;
  readonly scale: Scale | undefined;
}

const started = Date.now();

let answered: number | undefined;
let firstRows: number | undefined;
let settled: number | undefined;
let scale: Scale | undefined;

/**
 * The local read came back — recorded once, and **not** the same as having something to show.
 *
 * A query over an empty store answers immediately, so on a device that holds nothing this lands
 * almost at once and means only "the database replied". Reading it as "the app is up" is what
 * makes a cold start look *faster* than a warm one: the cold store has nothing to load, nothing
 * to verify and nothing to draw, and answers `[]` before a warm one has finished its grants.
 */
export const sawAnswered = (): void => void (answered ??= Date.now() - started);

/** A row is actually on screen — the number a person would call "it loaded". */
export const sawFirstRows = (): void => void (firstRows ??= Date.now() - started);

/**
 * Every source has answered — recorded once.
 *
 * Distinct from {@link sawFirstRows} on purpose: a query over an empty store answers instantly
 * while the relay has said nothing, so "rows are on screen" and "this device is caught up" are
 * different instants, and the gap between them is the cold join.
 */
export const sawSettled = (): void => void (settled ??= Date.now() - started);

export const sawScale = (next: Scale): void => void (scale = next);

export const timeline = (): Timeline => ({
  toAnswered: answered,
  toFirstRows: firstRows,
  toSettled: settled,
  scale,
});

/** The timeline as one line, for a log or a banner. */
export function summary(): string {
  const { toAnswered, toFirstRows, toSettled, scale: over } = timeline();
  const at = (ms: number | undefined) => (ms === undefined ? "…" : `${String(ms)}ms`);
  const head = `answered ${at(toAnswered)} · rows ${at(toFirstRows)} · caught up ${at(toSettled)}`;
  if (over === undefined) return head;
  const kb = Math.round(over.bytes / 1024);
  return `${head} · ${String(over.events)} events / ${String(over.rows)} rows / ${String(kb)}KB`;
}
