import type { HlcClock, MergeSpec, PeerId } from "@syncmesh/kernel";

import type { Boot } from "./boot.js";
import type { DocStore } from "./doc-log.js";
import type { DocEngineOptions } from "./doc-path.js";
import type { EngineError } from "./errors.js";
import type { UnknownHandling } from "./quarantine.js";
import type { StateStore } from "./state-store.js";
import type { EventStore } from "./store.js";
import type { Validator } from "./validate.js";

/**
 * What an engine is configured with, kept beside the engine rather than inside it.
 *
 * Every one of these is a choice an app makes once at boot and never again — where the log
 * lives, how loud an unreadable event is, how deep an undo goes — while `Engine` is the surface
 * it then talks to for the life of the process. Two different lifetimes in one file is how a
 * file that is only ever added to gets there.
 */

export interface EngineOptions extends DocEngineOptions {
  readonly peerId: PeerId;
  readonly clock: HlcClock;
  readonly store: EventStore;
  readonly merge?: MergeSpec;
  /** How many of this engine's own writes stay revertable. Default 0. */
  readonly undoDepth?: number;
  /** Runs on a probe before a local write gets a sequence number, and on every received event before it is stored. */
  readonly validate?: Validator;
  /**
   * How loudly this mesh is told about an event no build here can read (D13). Per mesh, never
   * per event: all three settings park it and none of them folds it, so a mesh whose devices were
   * configured by two different people still converges. Default `"warn"`.
   */
  readonly unknownHandling?: UnknownHandling;
  /** Parked events kept per reason before the oldest is dropped — loudly, on `onError`. */
  readonly quarantineLimit?: number;
  /**
   * An error listener from before the engine exists, subscribed to the same hub `Engine.onError`
   * hands out.
   *
   * `onError` on the engine subscribes just as well for everything after boot, but `openEngine`
   * audits the log for {@link StrandedWrites} *while* it is opening — the one moment a device
   * that rotated its key over a kept log can be told so — and a caller can only subscribe once
   * that call has already returned. The same shape as `RelayRoomOptions.onTelemetry`, for the
   * same reason: a report nobody could have been listening for is a report nobody gets.
   */
  readonly onError?: (error: EngineError) => void;
  /** Where folded rows are kept between runs; absent, every boot refolds the log. */
  readonly stateStore?: StateStore;
  /** What to start from; `openEngine` builds it. Absent, the engine starts empty. */
  readonly boot?: Boot;
  /**
   * Runs a write's store calls in one transaction: the event appended to the log and its rows
   * committed to the state store land together or not at all.
   *
   * **Optional, and the absent case is a protocol rather than a degradation.** Without it each
   * store commits on its own, in an order the write path guarantees: the durable half first — the
   * event, and the operation record that names it — then the derived half, whose commit carries
   * the rows *and* the coverage cursor that says how far they go. A crash between the two leaves
   * the log ahead of the cursor, which is precisely what `openEngine` repairs by replaying
   * `allSince(coverage)`. Nothing is lost; a boot does the work the crash interrupted.
   *
   * That is what makes two files possible (RFC-0022), where one transaction cannot span them:
   * SQLite commits atomically across attached databases only in rollback-journal mode, and every
   * device here runs WAL. It is also why the order above is a contract and not an accident — the
   * half that cannot be recomputed commits first.
   */
  readonly atomic?: <T>(fn: (scoped: AtomicStores) => Promise<T>) => Promise<T>;
}

/** What a write touches inside `atomic`: the log, the state store and the doc log, where each exists. */
export interface AtomicStores {
  readonly events: EventStore;
  readonly state?: StateStore;
  readonly docs?: DocStore;
}
