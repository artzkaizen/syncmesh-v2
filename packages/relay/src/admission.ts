import type { PeerId, SyncEvent } from "@syncmesh/kernel";

import { Result, TaggedError } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";

/**
 * What one device is admitted to read of the authority-visibility tables (D24): computed by the
 * authority, from a database no device holds, once per join.
 *
 * `scope` names it. Two devices with the same entitlement must be admitted the same set, and a
 * cursor earned under one carries its name — so a device whose entitlement changes is re-paged
 * rather than left holding a cursor that skips what it was not allowed to see before (D23).
 */
export interface Entitlement {
  /**
   * The entitlement's name: equal names admit equal sets. Opaque to the relay and to the device;
   * a change of name is all either of them reads, and any change re-pages the device once.
   */
  readonly scope: string;
  /**
   * Whether one event writing a gated table reaches this device. Read from the event and from
   * what was loaded at join, never from a clock or from the order rows reached the relay — that is
   * the divergence class this repo has shipped seven times, and here it would be invisible.
   */
  readonly admits: (event: SyncEvent) => boolean;
}

/** Who is asking, and in which room: everything the authority's answer may depend on. */
export interface EntitlementAsk {
  readonly peer: PeerId;
  readonly room: string;
}

/**
 * The relay half of `visibility: "authority"` (D24-A): which tables are gated, and how a device's
 * entitlement is found. A room given one filters catch-up **and** live fan-out through it — the
 * fan-out from another instance included — so there is no path into a device's log around it.
 */
export interface RelayAdmission {
  /** The authority-visibility tables, as the manifest names them (`authorityTables(schema)`). */
  readonly tables: readonly string[];
  /**
   * One device's entitlement, asked once per join before its catch-up is scanned. Asked off the
   * room's queue, so a slow answer delays this device alone; one that takes longer than
   * {@link ENTITLE_DEADLINE} refuses the join as {@link EntitlementFailed}.
   */
  readonly entitle: (ask: EntitlementAsk) => Promise<Entitlement> | Entitlement;
}

/** The authority could not say what a device may read; the join is refused rather than guessed. */
export class EntitlementFailed extends TaggedError("EntitlementFailed")<{
  message: string;
  cause: unknown;
}> {}

/** One room's gate: the gated tables as a set, and the authority's answer for one device. */
export interface Gate {
  /** Whether an event writes any gated table — the only events the gate has an opinion about. */
  readonly gates: (event: SyncEvent) => boolean;
  readonly entitle: (peer: PeerId) => Promise<Result<Entitlement, EntitlementFailed>>;
}

/**
 * How long the authority has to answer one join. Past it the join is refused rather than left
 * waiting: a device with no answer has no catch-up, and nothing else would ever tell it so.
 */
export const ENTITLE_DEADLINE = Temporal.Duration.from({ seconds: 10 });

/** `work`, or a rejection once `deadline` has passed without it. */
const within = <T>(work: Promise<T>, deadline: Temporal.Duration): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`no answer within ${deadline.toString()}`)),
      deadline.total("milliseconds"),
    );
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
};

export function createGate(
  admission: RelayAdmission,
  room: string,
  deadline = ENTITLE_DEADLINE,
): Gate {
  const tables = new Set(admission.tables);
  return {
    // a sealed event reads as no changes at all, so it is not gated: the authority writes gated
    // rows in the clear, since they belong to no partition a key could be issued for
    gates: (event) => event.changes.some((change) => tables.has(change.table)),
    entitle: (peer) =>
      Result.tryPromise({
        try: () =>
          within(
            Promise.resolve().then(() => admission.entitle({ peer, room })),
            deadline,
          ),
        catch: (cause) =>
          new EntitlementFailed({
            message: `the authority could not say what this device may read: ${String(cause)}`,
            cause,
          }),
      }),
  };
}

/**
 * Whether the device holding `entitlement` receives `event`: an ungated event always, a gated one
 * only once the authority has spoken and said yes. Before it has spoken the answer is no — the
 * catch-up that follows the answer pages what was withheld while it was being asked.
 */
export const admitted = (
  gate: Gate | undefined,
  entitlement: Entitlement | undefined,
  event: SyncEvent,
): boolean => gate === undefined || !gate.gates(event) || (entitlement?.admits(event) ?? false);
