import type { HlcClock, MergeSpec, PeerId, State } from "@syncmesh/kernel";

import { applyChange, emptyState } from "@syncmesh/kernel";
import { Result, TaggedError } from "@syncmesh/result";

import type { EventStore, StoreFailure } from "./store.js";

import {
  eventId,
  stampOf,
  type PartitionKey,
  type Procedure,
  type SeqNum,
  type SyncEvent,
} from "./event.js";
import { record, type Tx } from "./tx.js";

export class EmptyMutation extends TaggedError("EmptyMutation")<{
  procedure: Procedure;
  message: string;
}> {}

export interface MutateOptions {
  readonly partition?: PartitionKey;
  readonly local?: boolean;
}

export type MutateError = EmptyMutation | StoreFailure;

export interface Engine {
  readonly peerId: PeerId;
  /** Records, stamps, numbers, appends, folds — in that order; a write is real once appended. */
  readonly mutate: (
    procedure: Procedure,
    fn: (tx: Tx) => void,
    options?: MutateOptions,
  ) => Promise<Result<SyncEvent, MutateError>>;
  readonly state: () => State;
}

export interface EngineOptions {
  readonly peerId: PeerId;
  readonly clock: HlcClock;
  readonly store: EventStore;
  readonly merge?: MergeSpec;
}

export function createEngine(options: EngineOptions): Engine {
  const { peerId, clock, store, merge } = options;
  let state = emptyState();

  const mutate: Engine["mutate"] = (procedure, fn, mutateOptions = {}) =>
    Result.gen(async function* () {
      const changes = record(fn);
      if (changes.length === 0) {
        return Result.err(
          new EmptyMutation({ procedure, message: `${procedure} changed nothing` }),
        );
      }
      const hlc = clock.tick();
      const scope = mutateOptions.local === true ? "local" : "synced";
      const last = yield* Result.await(store.lastSeq(peerId, scope));
      const seqNum = nextSeq(last);
      const event = build(procedure, hlc, seqNum, changes, mutateOptions);
      yield* Result.await(store.append(event));
      state = fold(state, event, merge);
      return Result.ok(event);
    });

  const build = (
    procedure: Procedure,
    hlc: SyncEvent["hlc"],
    seqNum: SeqNum,
    changes: SyncEvent["changes"],
    { partition, local }: MutateOptions,
  ): SyncEvent => {
    const base = {
      v: 1 as const,
      id: eventId(peerId, seqNum),
      peerId,
      seqNum,
      hlc,
      procedure,
      changes,
    };
    if (partition !== undefined && local === true) return { ...base, partition, local };
    if (partition !== undefined) return { ...base, partition };
    if (local === true) return { ...base, local };
    return base;
  };

  return { peerId, mutate, state: () => state };
}

const nextSeq = (last: SeqNum | undefined): SeqNum => {
  // SAFETY: last is a SeqNum (positive safe integer) or absent; +1 from 0 or from it stays one
  return ((last ?? 0) + 1) as SeqNum;
};

const fold = (state: State, event: SyncEvent, merge: MergeSpec | undefined): State =>
  event.changes.reduce((s, change) => applyChange(s, change, stampOf(event), merge), state);
