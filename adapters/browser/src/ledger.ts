/* oxlint-disable anti-slop/no-unknown-parameters -- the host's half takes its arguments off a `postMessage`, where every one of them is `unknown` until the path says what it was */

import type { OperationsView } from "@syncmesh/client";
import type { StoreFailure } from "@syncmesh/engine";
import type { PeerId, SeqNum } from "@syncmesh/kernel";
import type { Result as ResultType } from "@syncmesh/result";
import type { OperationRow, ReceiptRow } from "@syncmesh/storage";

import { Result } from "@syncmesh/result";

import type { LedgerAnswer, LedgerPath } from "./protocol.js";
import type { MeshWire } from "./wire.js";

import { MeshCallFailed, MeshHostGone, NoWriteLedger } from "./protocol.js";

/**
 * The durable record of a write (book ch. 10), read from a window that holds no engine.
 *
 * The four reads are the ones `OperationsView` already declares and they mean exactly what they
 * mean on the leader, because they *are* the leader's: one origin, one ledger, one row per write
 * whichever tab made it. What differs is the failure set — a port can die and a mesh can have no
 * ledger at all — so the error arm is wider here and nothing else moves.
 *
 * `onChange` keeps the property it was given on the leader: it fires on a **local commit** as
 * well as on a receipt landing, because the engine announces this device's own commits with the
 * fold that makes them real. A tab that wrote is therefore told about its own row, which is what
 * makes a write's record appear under a view that was waiting for it.
 */
export type LedgerFailure = StoreFailure | NoWriteLedger | MeshHostGone | MeshCallFailed;

export interface RemoteOperations {
  readonly get: (id: string) => Promise<ResultType<OperationRow | undefined, LedgerFailure>>;
  readonly byEvent: (
    peer: PeerId,
    seq: SeqNum,
  ) => Promise<ResultType<OperationRow | undefined, LedgerFailure>>;
  readonly unsettled: () => Promise<ResultType<readonly OperationRow[], LedgerFailure>>;
  readonly receiptsOf: (
    peer: PeerId,
    seq: SeqNum,
  ) => Promise<ResultType<readonly ReceiptRow[], LedgerFailure>>;
  /** Fires after the origin's ledger changed, in every tab that is watching it. */
  readonly onChange: (listener: () => void) => () => void;
}

const NO_LEDGER =
  "this origin's mesh was built over a bare event store, so no write ledger was ever opened";

/**
 * The host's half: the ledger's own `Result` becomes a value or a throw, and the throw is tagged.
 *
 * Unwrapped here rather than carried whole because a `Result` is a class and a class does not
 * survive a structured clone. `serveMesh` already turns a thrown tagged error back into one on
 * the far side, so the shape a caller sees is the shape it would have seen on the leader.
 */
export const answerLedger = async (
  view: OperationsView | undefined,
  path: LedgerPath,
  args: readonly unknown[],
): Promise<LedgerAnswer> => {
  if (view === undefined) throw new NoWriteLedger({ message: NO_LEDGER });
  // SAFETY: each argument is what the tab's own typed method took before it was posted
  const [first, second] = args as [string, number];
  const read =
    path === "get"
      ? view.get(first)
      : path === "unsettled"
        ? view.unsettled()
        : // SAFETY: `byEvent` and `receiptsOf` both take the author and sequence a caller read off
          // an event id; the tab's own typed method is the only thing that posts them
          path === "byEvent"
          ? view.byEvent(first as PeerId, second as SeqNum)
          : view.receiptsOf(first as PeerId, second as SeqNum);
  const outcome = await read;
  if (outcome.isErr()) throw outcome.error;
  return outcome.value;
};

/** Anything the port raised that was not already one of the ledger's own failures. */
const asFailure = (cause: unknown): LedgerFailure => {
  if (cause instanceof MeshHostGone || cause instanceof NoWriteLedger) return cause;
  // the wire revives the host's own tagged failure as the class that declared it
  if (cause instanceof Error && "_tag" in cause)
    // SAFETY: the only tagged failure the ledger's four reads raise is `StoreFailure`
    return cause as StoreFailure;
  return new MeshCallFailed({
    path: "ledger",
    message: "the write ledger refused without saying why",
  });
};

const askLedger = <T>(wire: MeshWire, path: LedgerPath, args: readonly unknown[]) =>
  Result.tryPromise({ try: () => wire.ask<T>({ kind: "ledger", path, args }), catch: asFailure });

export const remoteLedger = (wire: MeshWire): RemoteOperations => ({
  get: (id) => askLedger<OperationRow | undefined>(wire, "get", [id]),
  byEvent: (peer, seq) => askLedger<OperationRow | undefined>(wire, "byEvent", [peer, seq]),
  unsettled: () => askLedger<readonly OperationRow[]>(wire, "unsettled", []),
  receiptsOf: (peer, seq) => askLedger<readonly ReceiptRow[]>(wire, "receiptsOf", [peer, seq]),
  onChange: (listener) => wire.listen("writes", () => listener()),
});
