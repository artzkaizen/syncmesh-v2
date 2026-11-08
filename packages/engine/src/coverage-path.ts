import type { SeqNum } from "@syncmesh/kernel";

import { eventId } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";

import type { CoverageTracker } from "./coverage.js";
import type { Interest } from "./interest.js";
import type { EventStore, StoreFailure, StoredEvent, TornRun } from "./store.js";
import type { Coverage, Cursors } from "./sync.js";

import { ListenerFailure, type EngineError } from "./errors.js";
import { eventsWanted } from "./interest.js";
import { createHub, type Hub, type Unsubscribe } from "./listeners.js";
import { sayTears } from "./store.js";

/** The engine's coverage, as taken on from outside the fold, taken back, and read by peers. */
export interface CoverageApi {
  /**
   * Takes on a coverage that events already folded stand for (D23) — what a filtered catch-up
   * hands over at its end. Raises each author's cursor, never lowers one, and takes on the
   * `scope` that makes the numbers true.
   *
   * Separate from `installSnapshot` because there are no rows to install: the events themselves
   * arrived and were folded, and what is being adopted is the claim about the ones that were
   * filtered out — the only thing that can move a cursor past a hole nobody is going to fill.
   */
  readonly adoptCoverage: (coverage: Coverage) => void;
  /**
   * Fires after coverage is taken on rather than folded — {@link CoverageApi.adoptCoverage}, or a
   * snapshot install, rows or none — with the coverage as it stands after. What a reader of the
   * scope listens to: an empty snapshot is no fold, and still moves the scope (D45).
   */
  readonly onAdopt: (listener: (coverage: Coverage) => void) => Unsubscribe;
  /**
   * Takes back what a torn log no longer holds (D39): each run is recorded as a gap the log admits
   * to, so its reads are whole again, and this device's cursors drop below it, so a peer that holds
   * the run sends it again. Writes no event and deletes nothing. A `local` run is recorded and is
   * gone for good: nothing else ever held it.
   *
   * A read the log refuses as torn is also said on `Engine.onError`, once per tear, as the
   * `StoreFailure` whose cause names the runs (`tornRuns`).
   */
  readonly reopen: (runs: readonly TornRun[]) => Promise<Result<void, StoreFailure>>;
  /**
   * Synced events the holder of `theirs` lacks, narrowed to what they asked for. The
   * filter runs **here**, at the sender, so an uninterested event never becomes bytes — and it
   * only ever narrows: what the reader may see at all is the read policy's to decide.
   */
  readonly eventsSince: (
    theirs: Cursors,
    interest?: Interest,
  ) => Promise<Result<readonly StoredEvent[], StoreFailure>>;
}

export interface CoveragePathDeps {
  readonly coverage: CoverageTracker;
  readonly store: EventStore;
  /** A shared turn on the stores, as a snapshot's writes take (`gatedTransactions`). */
  readonly turn: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Where a torn read is said, once per tear (D39), and an `onAdopt` listener that throws. */
  readonly errors: Hub<EngineError>;
}

/** Every sequence of a run, as the ids the log would hold them under. */
const idsIn = ({ peer, local, from, to }: TornRun) =>
  // SAFETY: every sequence between two positive ones is positive
  Array.from({ length: to - from + 1 }, (_, i) => eventId(peer, (from + i) as SeqNum, local));

/**
 * The engine's coverage taken on, taken back, and read from (D23, D39, D45): what is adopted from
 * outside the fold and said on `onAdopt`, a torn log's runs reopened, and the history a peer asks
 * for, with a refusal of a torn log said once.
 */
export function createCoveragePath(
  deps: CoveragePathDeps,
  /** Writes the coverage as it stands to the state store, where there is one; whether it committed. */
  persistCoverage: () => Promise<boolean>,
) {
  const { coverage, store, errors } = deps;
  const adopted = createHub<Coverage>((cause) =>
    errors.emit(new ListenerFailure({ hook: "onAdopt", message: "onAdopt listener threw", cause })),
  );
  const tears = sayTears(errors.emit);
  const said = () => adopted.emit(coverage.current());
  /** `adopt`, then the coverage it left said: folding an event says nothing here. */
  const announced =
    (adopt: (taken: Coverage) => void) =>
    (taken: Coverage): void => {
      adopt(taken);
      said();
    };

  const reopen = async (runs: readonly TornRun[]): Promise<Result<void, StoreFailure>> => {
    const reopened = await deps.turn(async () => {
      // nothing is deleted — the events are gone — but each hole is recorded as one the log
      // admits to, so its reads are whole again; a later delivery fills it
      const evicted = await store.evict(runs.flatMap(idsIn));
      if (evicted.isErr()) return evicted;
      for (const run of runs) coverage.reopen(run);
      await persistCoverage();
      return Result.ok(undefined);
    });
    if (reopened.isOk()) said();
    return reopened;
  };

  const eventsSince = async (
    theirs: Cursors,
    interest?: Interest,
  ): Promise<Result<readonly StoredEvent[], StoreFailure>> => {
    const read = await eventsWanted(store, theirs, interest);
    if (read.isErr()) tears.seen(read.error);
    return read;
  };

  const api = {
    adoptCoverage: announced(coverage.adopt),
    onAdopt: adopted.subscribe,
    reopen,
    eventsSince,
  } satisfies CoverageApi;
  /** `adoptUnheld` for a snapshot install: what it adopts is said like any other adoption. */
  return { adoptUnheld: announced(coverage.adoptUnheld), api };
}

/**
 * A snapshot install's coverage committed: the state's cursors first, then its floor into the log,
 * so a state that is lost or never read later still says it held rows the log cannot rebuild
 * (gaps U33). In that order a crash between the two leaves cursors the next readable boot copies
 * into the log; the other way round it left a floor over a state that reads as empty, which no
 * boot could ever open again.
 *
 * The floor goes into the log only when the state committed the cursors. A commit that failed
 * (disk full, quota) or a log with no state store leaves no state holding the rows, so the log
 * keeps no floor either, and the next boot folds the log again and asks for the snapshot again.
 */
export async function persistInstall(
  store: EventStore,
  coverage: CoverageTracker,
  errors: Hub<EngineError>,
  persistCoverage: () => Promise<boolean>,
): Promise<void> {
  if (!(await persistCoverage())) return;
  const recorded = await store.recordInstalled(coverage.current().floor ?? new Map());
  if (recorded.isErr()) errors.emit(recorded.error);
}
